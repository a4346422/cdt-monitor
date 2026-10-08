/**
 * CDT-Monitor v2
 *
 * 多阿里云账号轮换调度：同一时刻只有一个账号"当班"，其余保持节省停机，
 * 域名（Cloudflare DDNS）跟随当班实例的公网 IP。
 *
 * 换班触发：
 *   - 当班账号额度耗尽（流量 ≥ 阈值，或账单 ≥ 阈值）
 *   - 定时轮换到期
 * 全部账号耗尽 → 停掉当班实例并进入本月熔断。
 *
 * 设计要点：
 *   - CDT 流量按 BusinessRegionId 分类累加（中国内地 20GB / 非中国内地 200GB
 *     是两个独立额度池，不能相加）
 *   - 查询失败一律 fail-closed，绝不当成 0
 *   - 停机必须二次确认 Stopped + StopCharging
 *   - 保活只对当班账号生效，且阈值熔断优先于保活
 */

// ============================================================================
// 常量与默认配置
// ============================================================================

const TZ = 'Asia/Shanghai';
const REQUEST_TIMEOUT_MS = 10000;
const RETRY_ATTEMPTS = 3;

// CDT 免费额度按地域类别分成两个独立池
const QUOTA_CHINA_GB = 20;
const QUOTA_INTL_GB = 200;

const REGIONS = [
  ['ap-southeast-1', '新加坡'], ['ap-southeast-2', '悉尼'], ['ap-southeast-3', '雅加达'],
  ['ap-southeast-5', '吉隆坡'], ['ap-southeast-6', '马尼拉'], ['ap-southeast-7', '曼谷'],
  ['ap-northeast-1', '东京'], ['ap-northeast-2', '首尔'], ['ap-south-1', '孟买'],
  ['cn-hongkong', '中国香港'],
  ['us-west-1', '硅谷'], ['us-east-1', '弗吉尼亚'],
  ['eu-central-1', '法兰克福'], ['eu-west-1', '伦敦'], ['me-east-1', '迪拜'],
  ['cn-hangzhou', '杭州'], ['cn-shanghai', '上海'], ['cn-beijing', '北京'],
  ['cn-shenzhen', '深圳'], ['cn-guangzhou', '广州'], ['cn-qingdao', '青岛'],
  ['cn-zhangjiakou', '张家口'], ['cn-chengdu', '成都'], ['cn-wulanchabu', '乌兰察布'],
];

const REGION_LABEL = new Map(REGIONS);

function defaultConfig() {
  return {
    adminPass: '',
    system: {
      // 流量阈值按地域类别取默认值，单账号可覆盖
      trafficThresholdChina: Math.round(QUOTA_CHINA_GB * 0.9),
      trafficThresholdIntl: Math.round(QUOTA_INTL_GB * 0.94),
      billThreshold: 0,              // 0 = 关闭按账单轮换
      rotationIntervalMinutes: 0,    // 0 = 关闭定时轮换
      keepAlive: true,               // 保活全局默认，单账号可覆盖
      dnsDrainSeconds: 60,
      transitionTimeoutMinutes: 10,
      startRetrySeconds: 180,
      billCheckMinutes: 30,
      dailyReport: false,
      dailyReportTime: '23:58',
    },
    accounts: [],                    // 默认没有任何实例，用户手动添加
    cf: { apiToken: '', zoneId: '', recordId: '', domainName: '' },
    notify: { tg: { enabled: false, botToken: '', chatId: '' } },
  };
}

function defaultState() {
  return {
    month: '',
    dutyAccountId: null,
    dutySince: 0,
    rotationIndex: 0,
    accounts: {},          // id -> { trafficGb, trafficClass, billAmount, billOk, exhausted, reason, ... }
    transition: null,
    startAttempt: null,
    keepAliveAt: null,
    fusedMonth: null,
    lastBillCheck: 0,
    lastTrafficCheck: null,
    fault: null,
    dailyReportDate: null,
  };
}

// ============================================================================
// 工具
// ============================================================================

function bjNow() {
  const d = new Date();
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d).map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    month: `${parts.year}-${parts.month}`,
    hhmm: `${parts.hour}:${parts.minute}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    iso: d.toISOString(),
  };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function mask(secret) {
  const s = String(secret || '');
  if (s.length <= 8) return s ? '****' : '';
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
}

// 阿里云 RPC 的百分号编码：QueryEscape 之后还要处理 + * ~
function percentEncode(str) {
  return encodeURIComponent(String(str))
    .replace(/!/g, '%21').replace(/'/g, '%27')
    .replace(/\(/g, '%28').replace(/\)/g, '%29')
    .replace(/\*/g, '%2A').replace(/%7E/g, '~');
}

async function hmacSha1Base64(key, message) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

function aliyunTimestamp() {
  // 不带毫秒的 ISO8601，阿里云对带毫秒的格式会报 Timestamp 错误
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ============================================================================
// 阿里云客户端
// ============================================================================

class AliyunError extends Error {
  constructor(message, { code, status, retryable } = {}) {
    super(message);
    this.name = 'AliyunError';
    this.code = code || '';
    this.status = status || 0;
    this.retryable = !!retryable;
  }
}

function isRetryableError(code, message, status) {
  if (status >= 500 || status === 429) return true;
  const text = `${code || ''} ${message || ''}`.toLowerCase().replace(/\s+/g, '');
  if (text.includes('throttl')) return true;
  if (text.includes('timestamp') && (text.includes('expired') || text.includes('notsupplied') || text.includes('missing'))) return true;
  return false;
}

function isSuccessCode(code) {
  const c = String(code || '').trim().toLowerCase();
  return c === '' || c === 'ok' || c === '200' || c === 'success';
}

async function callAliyunOnce(host, region, params, ak, sk) {
  if (!ak || !sk) throw new AliyunError('AccessKey 未配置');
  const all = {
    Format: 'JSON',
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: crypto.randomUUID(),
    SignatureVersion: '1.0',
    Timestamp: aliyunTimestamp(),
    AccessKeyId: ak,
    RegionId: region,
    ...params,
  };
  const canonical = Object.keys(all).sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(all[k])}`).join('&');
  const stringToSign = `POST&${percentEncode('/')}&${percentEncode(canonical)}`;
  const signature = await hmacSha1Base64(`${sk}&`, stringToSign);

  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(all)) form.set(k, v);
  form.set('Signature', signature);

  let res;
  try {
    res = await fetch(`https://${host}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    throw new AliyunError(`网络错误: ${e.message}`, { retryable: true });
  }

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new AliyunError(`非 JSON 响应 HTTP ${res.status}`, { status: res.status, retryable: res.status >= 500 }); }

  const code = data.Code || '';
  const message = data.Message || '';

  if (res.status >= 400) {
    throw new AliyunError(`HTTP ${res.status} ${code} ${message}`.trim(), {
      code, status: res.status, retryable: isRetryableError(code, message, res.status),
    });
  }
  if (!isSuccessCode(code)) {
    throw new AliyunError(`${code}: ${message || 'Aliyun API error'}`, {
      code, status: res.status, retryable: isRetryableError(code, message, res.status),
    });
  }
  return data;
}

async function callAliyun(host, region, params, ak, sk) {
  let last;
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    try {
      return await callAliyunOnce(host, region, params, ak, sk);
    } catch (e) {
      last = e;
      if (!(e instanceof AliyunError) || !e.retryable || attempt === RETRY_ATTEMPTS - 1) throw e;
      await sleep(300 * (2 ** attempt) + attempt * 100);
    }
  }
  throw last;
}

// ---------------------------------------------------------------- 地域分类

// 中国内地（cn-* 但不含 cn-hongkong）与非中国内地是两个独立的免费额度池。
function trafficClass(regionId) {
  const r = String(regionId || '');
  return r.startsWith('cn-') && r !== 'cn-hongkong' ? 'china' : 'international';
}

function quotaForClass(cls) {
  return cls === 'china' ? QUOTA_CHINA_GB : QUOTA_INTL_GB;
}

// ---------------------------------------------------------------- CDT 流量

async function getCdtTraffic(acc) {
  try {
    const res = await callAliyun('cdt.aliyuncs.com', 'cn-hongkong', {
      Action: 'ListCdtInternetTraffic',
      Version: '2021-08-13',
    }, acc.ak, acc.sk);

    const rows = res.TrafficDetails;
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error('CDT 返回缺少 TrafficDetails');
    }

    const cls = trafficClass(acc.regionId);
    let bytes = 0;
    const breakdown = [];
    for (const row of rows) {
      const region = String(row?.BusinessRegionId || '');
      const n = Number(row?.Traffic ?? 0);
      if (!Number.isFinite(n) || n < 0) throw new Error('CDT Traffic 字段无效');
      breakdown.push({ region, gb: Number((n / 1024 ** 3).toFixed(2)) });
      // 只累加与实例所在地域同类的流量
      if (trafficClass(region) === cls) bytes += n;
    }
    return { ok: true, gb: Number((bytes / 1024 ** 3).toFixed(2)), trafficClass: cls, breakdown };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---------------------------------------------------------------- ECS

async function describeEcs(acc) {
  try {
    const res = await callAliyun(`ecs.${acc.regionId}.aliyuncs.com`, acc.regionId, {
      Action: 'DescribeInstances',
      Version: '2014-05-26',
      InstanceIds: JSON.stringify([acc.instanceId]),
    }, acc.ak, acc.sk);

    const item = res.Instances?.Instance?.[0];
    if (!item) return { ok: false, status: 'NotFound', error: '实例不存在或无权限' };
    return {
      ok: true,
      status: item.Status || 'Unknown',
      stoppedMode: item.StoppedMode || 'Not-applicable',
      eip: extractEip(item),
      instanceId: item.InstanceId,
    };
  } catch (e) {
    return { ok: false, status: 'Error', error: e.message };
  }
}

function extractEip(item) {
  const pub = item.PublicIpAddress?.IpAddress?.[0];
  const eip = typeof item.EipAddress === 'string' ? item.EipAddress : item.EipAddress?.IpAddress;
  return eip || pub || '';
}

function isStopChargingConfirmed(desc) {
  return !!desc?.ok && desc.status === 'Stopped' && desc.stoppedMode === 'StopCharging';
}

async function startEcs(acc) {
  try {
    await callAliyun(`ecs.${acc.regionId}.aliyuncs.com`, acc.regionId, {
      Action: 'StartInstance',
      Version: '2014-05-26',
      InstanceId: acc.instanceId,
    }, acc.ak, acc.sk);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message, code: e.code };
  }
}

// 后端强制 StopCharging，网页无法改成 KeepCharging
async function stopEcs(acc) {
  try {
    await callAliyun(`ecs.${acc.regionId}.aliyuncs.com`, acc.regionId, {
      Action: 'StopInstance',
      Version: '2014-05-26',
      InstanceId: acc.instanceId,
      StoppedMode: 'StopCharging',
    }, acc.ak, acc.sk);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message, code: e.code };
  }
}

// ---------------------------------------------------------------- BSS

function bssEndpoint(siteType) {
  return siteType === 'international'
    ? { region: 'ap-southeast-1', host: 'business.ap-southeast-1.aliyuncs.com' }
    : { region: 'cn-hangzhou', host: 'business.aliyuncs.com' };
}

function prevMonth(cycle) {
  const [y, m] = String(cycle).split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// DescribeInstanceBill 没有 PageSize，只有 MaxResults（默认 20，上限 300），
// 翻页靠 NextToken。不处理分页会静默少算。
async function queryBill(acc, { cycle, instanceId, hideZero, maxPages = 5 } = {}) {
  const bss = bssEndpoint(acc.siteType);
  let token = '';
  let amount = 0;
  let gross = 0;
  let currency = '';
  let itemCount = 0;
  let totalCount = null;
  let pages = 0;
  const sample = [];
  const byProduct = new Map();

  do {
    const params = {
      Action: 'DescribeInstanceBill',
      Version: '2017-12-14',
      BillingCycle: cycle,
      Granularity: 'MONTHLY',
      MaxResults: 300,
    };
    if (instanceId) params.InstanceID = instanceId;
    if (hideZero) params.IsHideZeroCharge = true;
    if (token) params.NextToken = token;

    const res = await callAliyun(bss.host, bss.region, params, acc.ak, acc.sk);
    const data = res.Data || {};
    let rows = data.Items?.Item || data.Items || [];
    if (!Array.isArray(rows)) rows = [rows];

    for (const it of rows) {
      amount += num(it?.PretaxAmount);
      gross += num(it?.PretaxGrossAmount);
      if (!currency && it?.Currency) currency = it.Currency;

      // 按产品分组，否则看不出钱到底花在哪（ECS 计算费？EIP？还是超量流量？）
      const key = it?.ProductCode || 'unknown';
      if (!byProduct.has(key)) byProduct.set(key, { count: 0, amount: 0, gross: 0, instances: new Set() });
      const g = byProduct.get(key);
      g.count++;
      g.amount += num(it?.PretaxAmount);
      g.gross += num(it?.PretaxGrossAmount);
      if (it?.InstanceID) g.instances.add(it.InstanceID);

      if (sample.length < 8) {
        sample.push({
          InstanceID: it?.InstanceID, ProductCode: it?.ProductCode, ProductName: it?.ProductName,
          Item: it?.Item, PretaxAmount: it?.PretaxAmount, PretaxGrossAmount: it?.PretaxGrossAmount,
          Currency: it?.Currency, Region: it?.Region, NickName: it?.NickName,
        });
      }
    }
    itemCount += rows.length;
    if (data.TotalCount != null) totalCount = data.TotalCount;
    token = data.NextToken || '';
    pages++;
  } while (token && pages < maxPages);

  return {
    ok: true, cycle, amount: Number(amount.toFixed(4)), gross: Number(gross.toFixed(4)),
    currency: currency || 'USD', itemCount, totalCount, truncated: !!token,
    byProduct: [...byProduct.entries()].map(([code, g]) => ({
      productCode: code, count: g.count,
      amount: Number(g.amount.toFixed(4)), gross: Number(g.gross.toFixed(4)),
      instances: [...g.instances],
    })),
    sample,
  };
}

async function queryBillSafe(acc, opts) {
  try { return await queryBill(acc, opts); }
  catch (e) { return { ok: false, error: e.message, code: e.code }; }
}

async function getAccountBalance(acc) {
  try {
    const bss = bssEndpoint(acc.siteType);
    const res = await callAliyun(bss.host, bss.region, {
      Action: 'QueryAccountBalance',
      Version: '2017-12-14',
    }, acc.ak, acc.sk);
    const data = res.Data || {};
    if (data.AvailableAmount == null) throw new Error('余额响应缺少 AvailableAmount');
    return {
      ok: true,
      balance: num(String(data.AvailableAmount).replace(/,/g, '')).toFixed(2),
      currency: data.Currency || (acc.siteType === 'international' ? 'USD' : 'CNY'),
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// EIP 列表：绑定状态、计费方式、绑到哪个实例。闲置（Available）的 EIP 会按小时计保有费。
async function listEips(acc) {
  try {
    const eips = [];
    let token = '';
    let pages = 0;
    do {
      const params = { Action: 'DescribeEips', Version: '2014-05-26', MaxResults: 100 };
      if (token) params.NextToken = token;
      const res = await callAliyun(`ecs.${acc.regionId}.aliyuncs.com`, acc.regionId, params, acc.ak, acc.sk);
      let rows = res.Eips?.Eip || res.Eips || [];
      if (!Array.isArray(rows)) rows = [rows];
      for (const e of rows) {
        eips.push({
          allocationId: e?.AllocationId || null,
          ip: e?.IpAddress || null,
          status: e?.Status || 'Unknown',
          boundTo: e?.InstanceId || null,
          chargeType: e?.InternetChargeType || null,
          bandwidth: e?.Bandwidth ?? null,
          isp: e?.ISP || null,
          name: e?.Name || '',
        });
      }
      token = res.NextToken || '';
      pages++;
    } while (token && pages < 5);
    return { ok: true, count: eips.length, idle: eips.filter((e) => e.status === 'Available').length, eips };
  } catch (e) {
    return { ok: false, error: e.message, code: e.code || null };
  }
}

// 只读诊断：确认某个账号能用哪些 BSS 接口 / 端点，以及账单里到底有什么
async function probeBilling(env) {
  const cfg = await getConfig(env);
  const now = bjNow();
  const cycle = now.month;
  const prev = prevMonth(cycle);
  const out = [];

  for (const acc of cfg.accounts) {
    const bss = bssEndpoint(acc.siteType);
    const row = {
      account: acc.name, id: acc.id, siteType: acc.siteType, regionId: acc.regionId,
      trafficClass: trafficClass(acc.regionId), endpoint: bss.host, region: bss.region,
    };
    if (!isConfigured(acc)) { row.skipped = '未配置完整'; out.push(row); continue; }

    const bal = await getAccountBalance(acc);
    row.balance = bal.ok ? { amount: bal.balance, currency: bal.currency } : { error: bal.error };
    row.eips = await listEips(acc);

    // 实例当前状态与实际公网 IP：换班时 DNS 指向的就是这个值
    const desc = await describeEcs(acc);
    row.instance = desc.ok
      ? {
        instanceId: acc.instanceId, status: desc.status, stoppedMode: desc.stoppedMode,
        liveEip: desc.eip || null, configuredEip: acc.eip || null,
        eipMatch: !acc.eip || acc.eip === desc.eip,
      }
      : { instanceId: acc.instanceId, error: desc.error, status: desc.status };

    row.bills = [];
    const queries = [
      ['本月 · 该实例', { cycle, instanceId: acc.instanceId }],
      ['本月 · 整账号', { cycle }],
      ['本月 · 整账号 · 仅非零', { cycle, hideZero: true }],
      ['上月 · 整账号', { cycle: prev }],
    ];
    for (const [label, opts] of queries) {
      try { row.bills.push({ label, ...(await queryBill(acc, opts)) }); }
      catch (e) { row.bills.push({ label, ok: false, error: e.message, code: e.code || null }); }
    }
    out.push(row);
  }

  return {
    ok: true,
    billingCycle: cycle,
    previousCycle: prev,
    note: '免费额度内的用量以单价 0 记账，所以 PretaxAmount 在额度用尽前恒为 0，账单只能做事后兜底。BSS 数据延迟约 24 小时，当月数据仅供参考。EIP 状态为 Available 表示闲置，会按小时计保有费。',
    results: out,
  };
}

// ============================================================================
// Cloudflare DDNS
// ============================================================================

async function getDnsRecord(cfg) {
  const { apiToken, zoneId, recordId } = cfg.cf || {};
  if (!apiToken || !zoneId || !recordId) return { ok: false, message: 'Cloudflare 参数缺失' };
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${recordId}`, {
      headers: { Authorization: `Bearer ${apiToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const data = await res.json();
    if (!data.success) return { ok: false, message: (data.errors || []).map((e) => e.message).join('; ') || '查询失败' };
    return { ok: true, content: data.result?.content || '' };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

async function putDnsRecord(cfg, ip) {
  const { apiToken, zoneId, recordId, domainName } = cfg.cf || {};
  if (!apiToken || !zoneId || !recordId || !domainName || !ip) return { ok: false, message: 'Cloudflare 参数或 IP 缺失' };
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${recordId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'A', name: domainName, content: ip, ttl: 60, proxied: false }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const data = await res.json();
    if (!data.success) return { ok: false, message: (data.errors || []).map((e) => e.message).join('; ') || '更新失败' };
    return { ok: true, content: data.result?.content || ip };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

// 先查后写，写完再查一次确认
async function ensureDns(cfg, ip) {
  const before = await getDnsRecord(cfg);
  if (!before.ok) return { ok: false, message: `DNS 查询失败: ${before.message}` };
  if (before.content === ip) return { ok: true, message: `已指向 ${ip}`, changed: false };

  const put = await putDnsRecord(cfg, ip);
  if (!put.ok) return { ok: false, message: `DNS 更新失败: ${put.message}` };

  const after = await getDnsRecord(cfg);
  if (!after.ok) return { ok: false, message: `DNS 二次校验失败: ${after.message}` };
  if (after.content !== ip) return { ok: false, message: `DNS 二次校验不一致: ${after.content} != ${ip}` };
  return { ok: true, message: `已更新为 ${ip}`, changed: true };
}

// ============================================================================
// Telegram
// ============================================================================

function formatTg(title, items, summary) {
  const lines = [`*${title}*`, ''];
  for (const [k, v] of items) lines.push(`• ${k}: ${v}`);
  if (summary) { lines.push(''); lines.push(`_${summary}_`); }
  return lines.join('\n');
}

async function sendTelegram(env, cfg, title, items, summary) {
  const tg = cfg.notify?.tg || {};
  if (!tg.enabled || !tg.botToken || !tg.chatId) return { ok: false, skipped: true };
  try {
    const res = await fetch(`https://api.telegram.org/bot${tg.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: tg.chatId, text: formatTg(title, items, summary), parse_mode: 'Markdown' }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.description || `HTTP ${res.status}`);
    return { ok: true };
  } catch (e) {
    // 通知失败不能影响主流程，但要真正落盘，否则线上根本看不到
    try { await appendLog(env, 'ERROR', 'Telegram 发送失败', `${title}: ${e.message}`); } catch { /* ignore */ }
    return { ok: false, error: e.message };
  }
}

// ============================================================================
// KV：配置与日志
// ============================================================================

async function getConfig(env) {
  const raw = await env.STATE_KV.get('app_config', { type: 'json' });
  const base = defaultConfig();
  if (!raw) return base;
  return {
    ...base,
    ...raw,
    system: { ...base.system, ...(raw.system || {}) },
    cf: { ...base.cf, ...(raw.cf || {}) },
    notify: { tg: { ...base.notify.tg, ...(raw.notify?.tg || {}) } },
    accounts: Array.isArray(raw.accounts) ? raw.accounts.map(normalizeAccount) : [],
  };
}

function normalizeAccount(a) {
  return {
    id: a.id || crypto.randomUUID(),
    name: a.name || '未命名',
    ak: a.ak || '',
    sk: a.sk || '',
    regionId: a.regionId || 'ap-southeast-1',
    instanceId: a.instanceId || '',
    eip: a.eip || '',
    siteType: a.siteType || (trafficClass(a.regionId) === 'china' ? 'china' : 'international'),
    trafficThresholdGb: a.trafficThresholdGb ?? null,
    billThreshold: a.billThreshold ?? null,
    keepAlive: a.keepAlive ?? null,
    scheduleEnabled: !!a.scheduleEnabled,
    startTime: a.startTime || '00:00',
    stopTime: a.stopTime || '23:59',
    remark: a.remark || '',
  };
}

async function saveConfig(env, cfg) {
  await env.STATE_KV.put('app_config', JSON.stringify(cfg));
}

function isConfigured(acc) {
  return !!(acc?.ak && acc?.sk && acc?.regionId && acc?.instanceId);
}

async function readLogs(env) {
  const raw = await env.STATE_KV.get('app_logs', { type: 'json' });
  return Array.isArray(raw) ? raw : [];
}

async function appendLog(env, level, title, detail) {
  const logs = await readLogs(env);
  logs.unshift({ at: new Date().toISOString(), level, title, detail: detail || '' });
  await env.STATE_KV.put('app_logs', JSON.stringify(logs.slice(0, 300)));
}

// 日志写入失败不能反过来打断主流程
async function appendLogSafe(env, level, title, detail) {
  try { await appendLog(env, level, title, detail); } catch { /* ignore */ }
}

// ============================================================================
// 策略纯函数
// ============================================================================

function resolveTrafficThreshold(acc, cfg) {
  const own = acc?.trafficThresholdGb;
  if (own !== null && own !== undefined && own !== '') return num(own, 0);
  const cls = trafficClass(acc?.regionId);
  return cls === 'china'
    ? num(cfg.system.trafficThresholdChina, 0)
    : num(cfg.system.trafficThresholdIntl, 0);
}

function resolveBillThreshold(acc, cfg) {
  const own = acc?.billThreshold;
  if (own !== null && own !== undefined && own !== '') return num(own, 0);
  return num(cfg.system.billThreshold, 0);
}

function resolveKeepAlive(acc, cfg) {
  if (acc?.keepAlive === true || acc?.keepAlive === false) return acc.keepAlive;
  return !!cfg.system.keepAlive;
}

function inTimeRange(hhmm, start, stop) {
  if (!start || !stop) return true;
  if (start === stop) return true;
  return start < stop
    ? (hhmm >= start && hhmm < stop)
    : (hhmm >= start || hhmm < stop);   // 跨午夜
}

// 额度耗尽 = 流量到阈值 或 账单到阈值（阈值为 0 表示该条件关闭）
function evaluateExhausted(acc, accState, cfg) {
  const reasons = [];
  const t = resolveTrafficThreshold(acc, cfg);
  if (t > 0 && num(accState.trafficGb) >= t) {
    reasons.push(`流量 ${accState.trafficGb} / ${t} GB`);
  }
  const b = resolveBillThreshold(acc, cfg);
  if (b > 0 && accState.billOk && num(accState.billAmount) >= b) {
    reasons.push(`账单 ${accState.billAmount} / ${b}`);
  }
  return { exhausted: reasons.length > 0, reason: reasons.join(' 或 ') };
}

// ============================================================================
// 引擎
// ============================================================================

function validateConfig(cfg) {
  const sys = cfg.system;
  const seen = new Set();
  for (const acc of cfg.accounts) {
    if (!acc.name) throw new Error('实例名称不能为空');
    if (seen.has(acc.id)) throw new Error(`实例 ID 重复: ${acc.id}`);
    seen.add(acc.id);
  }
  const check = (value, min, max, label) => {
    const n = num(value, NaN);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${label} 必须在 ${min}~${max}`);
  };
  check(sys.trafficThresholdChina, 1, 20, '中国内地流量阈值');
  check(sys.trafficThresholdIntl, 1, 200, '非中国内地流量阈值');
  check(sys.billThreshold, 0, 1e6, '账单阈值');
  check(sys.rotationIntervalMinutes, 0, 525600, '定时轮换间隔');
  check(sys.dnsDrainSeconds, 0, 600, 'DNS 缓冲');
  check(sys.transitionTimeoutMinutes, 1, 60, '换班超时');
  check(sys.startRetrySeconds, 0, 3600, '启动重试窗口');
  check(sys.billCheckMinutes, 5, 1440, '账单检查间隔');
  if (!/^\d{2}:\d{2}$/.test(sys.dailyReportTime)) throw new Error('日报时间格式必须是 HH:mm');
}

async function setFault(env, engine, state, code, message, report, ctx = {}) {
  state.fault = { code, at: new Date().toISOString(), message, accountId: ctx.accountId || null };
  state.transition = null;
  state.startAttempt = null;
  await engine.saveState(state);
  await appendLogSafe(env, 'ERROR', `🚨 ${code}`, message);
  const cfg = await getConfig(env);
  if (report) await sendTelegram(env, cfg, report.title, report.items, report.summary);
  else await sendTelegram(env, cfg, '🚨 【调度进入保护状态】', [['错误码', code], ['详情', message]], '自动危险操作已暂停。');
  return { halted: true, fault: state.fault };
}

function findAccount(cfg, id) {
  return cfg.accounts.find((a) => a.id === id) || null;
}

// 按 round-robin 顺序取下一个候选
function pickNextDuty(cfg, state, excludeId) {
  const n = cfg.accounts.length;
  for (let i = 1; i <= n; i++) {
    const idx = (state.rotationIndex + i) % n;
    const acc = cfg.accounts[idx];
    if (acc.id === excludeId) continue;
    if (state.accounts[acc.id]?.exhausted) continue;
    return { acc, idx };
  }
  return null;
}

async function stopAndConfirm(acc) {
  const stopped = await stopEcs(acc);
  const after = await describeEcs(acc);
  return {
    ok: stopped.ok && isStopChargingConfirmed(after),
    stopError: stopped.ok ? null : stopped.error,
    desc: after,
    detail: after.ok ? `${after.status}/${after.stoppedMode}` : (after.error || '状态未知'),
  };
}

// ---------------------------------------------------------------- 主循环

async function runEngineCron(env, engine) {
  const cfg = await getConfig(env);
  const state = await engine.loadState();
  const now = bjNow();

  // ---- 跨月：所有账号额度恢复
  if (state.month !== now.month) {
    const prev = state.month;
    state.month = now.month;
    state.accounts = {};
    state.fusedMonth = null;
    state.dutySince = 0;
    state.lastBillCheck = 0;
    if (prev) await appendLogSafe(env, 'AUDIT', '新计费月开始', `${prev} -> ${now.month}，额度与耗尽状态已重置`);
    await engine.saveState(state);
  }

  // 故障时先看触发条件是否已经不成立（比如实例被释放后用户已把它从配置里删掉）
  if (state.fault) await tryAutoClearFault(env, cfg, state, engine);

  // 没有任何实例是正常状态（用户还没添加），不是故障
  if (!Array.isArray(cfg.accounts) || cfg.accounts.length === 0) {
    await engine.saveState(state);
    return { skipped: true, reason: 'no_accounts' };
  }

  if (state.fault) return { halted: true, fault: state.fault };

  try { validateConfig(cfg); }
  catch (e) { return setFault(env, engine, state, 'CONFIG_INVALID', e.message); }

  // ---- 采集所有实例状态：面板展示用，也是保活的判断依据
  const descs = await Promise.all(cfg.accounts.map((acc) => (
    isConfigured(acc) ? describeEcs(acc) : Promise.resolve({ ok: false, status: 'Unconfigured', error: '未配置完整' })
  )));
  cfg.accounts.forEach((acc, i) => {
    const d = descs[i];
    state.accounts[acc.id] = {
      ...(state.accounts[acc.id] || {}),
      ecsStatus: d.ok ? d.status : (d.status || 'Error'),
      // 停机模式决定是否真的在省钱（KeepCharging 就是还在计费）；
      // 公网 IP 用于核对 DDNS 实际指向哪里
      ecsStoppedMode: d.ok ? d.stoppedMode : null,
      ecsEip: d.ok ? d.eip : null,
      ecsError: d.ok ? null : (d.error || null),
    };
  });

  // ---- 有换班在推进时，先把它推完
  if (state.transition) return advanceTransition(env, cfg, state, engine, now);

  // ---- 采集所有账号的流量
  const traffic = await Promise.all(cfg.accounts.map((acc) => getCdtTraffic(acc)));
  const failed = [];
  cfg.accounts.forEach((acc, i) => { if (!traffic[i].ok) failed.push(`${acc.name}: ${traffic[i].error}`); });
  if (failed.length) {
    return setFault(env, engine, state, 'CDT_QUERY_FAILED', failed.join('; '));
  }

  // ---- 账单与余额（按间隔节流）
  // 账单阈值按账号级判定：额度和费用都是账号维度，而且能抓到未纳入监控的其他资源。
  const billDue = Date.now() - num(state.lastBillCheck, 0) >= num(cfg.system.billCheckMinutes, 30) * 60000;
  const bills = {};
  if (billDue && cfg.accounts.length) {
    const results = await Promise.all(cfg.accounts.map(async (acc) => {
      const [account, instance, balance] = await Promise.all([
        queryBillSafe(acc, { cycle: now.month }),
        queryBillSafe(acc, { cycle: now.month, instanceId: acc.instanceId }),
        getAccountBalance(acc),
      ]);
      return { account, instance, balance };
    }));
    cfg.accounts.forEach((acc, i) => { bills[acc.id] = results[i]; });
    state.lastBillCheck = Date.now();
  }

  // ---- 汇总每账号状态
  for (let i = 0; i < cfg.accounts.length; i++) {
    const acc = cfg.accounts[i];
    const prev = state.accounts[acc.id] || {};
    const b = bills[acc.id];
    const acctBill = b?.account;
    const instBill = b?.instance;
    const next = {
      ...prev,
      trafficGb: traffic[i].gb,
      trafficClass: traffic[i].trafficClass,
      breakdown: traffic[i].breakdown,
      // 账号级应付金额：账单阈值用它
      billAmount: acctBill ? (acctBill.ok ? acctBill.amount : prev.billAmount ?? null) : (prev.billAmount ?? null),
      // 该实例应付金额：仅用于展示
      billInstanceAmount: instBill ? (instBill.ok ? instBill.amount : prev.billInstanceAmount ?? null) : (prev.billInstanceAmount ?? null),
      billCurrency: acctBill?.ok ? acctBill.currency : (instBill?.ok ? instBill.currency : (prev.billCurrency ?? null)),
      billOk: acctBill ? acctBill.ok : (prev.billOk ?? false),
      billError: acctBill && !acctBill.ok ? acctBill.error : null,
      balance: b?.balance ? (b.balance.ok ? b.balance.balance : (prev.balance ?? null)) : (prev.balance ?? null),
      balanceCurrency: b?.balance?.ok ? b.balance.currency : (prev.balanceCurrency ?? null),
      balanceOk: b?.balance ? b.balance.ok : (prev.balanceOk ?? false),
    };
    const verdict = evaluateExhausted(acc, next, cfg);
    next.exhausted = verdict.exhausted;
    next.reason = verdict.reason;
    state.accounts[acc.id] = next;
  }

  // 启用了账单阈值但账号级账单查不出来的账号，fail-closed
  const billFailures = cfg.accounts
    .filter((a) => resolveBillThreshold(a, cfg) > 0)
    .filter((a) => state.accounts[a.id]?.billOk === false)
    .map((a) => `${a.name}: ${state.accounts[a.id].billError || '账单不可用'}`);
  if (billFailures.length) {
    return setFault(env, engine, state, 'BILL_QUERY_FAILED', billFailures.join('; '));
  }

  state.lastTrafficCheck = { at: now.iso };

  // ---- 确定当班账号
  let duty = findAccount(cfg, state.dutyAccountId);
  if (!duty) {
    const first = cfg.accounts.find((a) => !state.accounts[a.id]?.exhausted);
    if (!first) {
      if (state.fusedMonth !== state.month) {
        state.fusedMonth = state.month;
        await engine.saveState(state);
        await appendLogSafe(env, 'AUDIT', '🔴 全部账号额度耗尽', `本月不再自动开机（${state.month}）`);
        await sendTelegram(env, cfg, '🔴 【全部额度耗尽】', [
          ['计费月', state.month],
          ['账号数', String(cfg.accounts.length)],
          ['状态', '所有账号本月额度已用完'],
        ], '调度已停止，新计费月自动恢复。');
      }
      await engine.saveState(state);
      return { fused: true, reason: 'all_accounts_exhausted', month: state.month };
    }
    duty = first;
    state.dutyAccountId = first.id;
    state.dutySince = Date.now();
    state.rotationIndex = cfg.accounts.findIndex((a) => a.id === first.id);
    await engine.saveState(state);
    await appendLogSafe(env, 'AUDIT', '设定当班账号', first.name);
  }

  const dutyState = state.accounts[duty.id];

  // ---- 是否需要换班
  const rotationMs = num(cfg.system.rotationIntervalMinutes, 0) * 60000;
  const rotationDue = rotationMs > 0 && num(state.dutySince, 0) > 0 && (Date.now() - state.dutySince) >= rotationMs;
  const needRotation = dutyState?.exhausted || rotationDue;

  if (needRotation) {
    const reason = dutyState?.exhausted ? `额度耗尽（${dutyState.reason}）` : '定时轮换到期';
    const next = pickNextDuty(cfg, state, duty.id);
    if (!next) {
      return fuseAndStopDuty(env, cfg, state, engine, duty, reason);
    }
    return beginTransition(env, cfg, state, engine, next.acc, duty, 'SHIFT', reason);
  }

  // ---- 保活：只对当班账号，且阈值熔断优先
  return keepAliveDuty(env, cfg, state, engine, duty, dutyState, now);
}

// ---------------------------------------------------------------- 保活

async function keepAliveDuty(env, cfg, state, engine, duty, dutyState, now) {
  if (!isConfigured(duty)) {
    return setFault(env, engine, state, 'ACCOUNT_NOT_CONFIGURED', `${duty.name} 缺少 AK/SK/地域/实例 ID`);
  }

  const desc = await describeEcs(duty);
  if (!desc.ok) {
    // 实例被抢占释放时是启不回来的，直接报明确故障而不是反复重试
    if (desc.status === 'NotFound') {
      return setFault(env, engine, state, 'INSTANCE_NOT_FOUND', `${duty.name}: 实例 ${duty.instanceId} 不存在或已被释放`, null, { accountId: duty.id });
    }
    return setFault(env, engine, state, 'ECS_DESCRIBE_FAILED', `${duty.name}: ${desc.error}`);
  }

  if (desc.status === 'Running') {
    state.startAttempt = null;
    state.keepAliveAt = now.iso;
    await engine.saveState(state);
    return { ok: true, duty: duty.id, status: 'Running', trafficGb: dutyState.trafficGb };
  }

  // 保活开关 + 允许运行时段
  if (!resolveKeepAlive(duty, cfg)) {
    await engine.saveState(state);
    return { ok: true, duty: duty.id, status: desc.status, keepAlive: false };
  }
  if (duty.scheduleEnabled && !inTimeRange(now.hhmm, duty.startTime, duty.stopTime)) {
    await engine.saveState(state);
    return { ok: true, duty: duty.id, status: desc.status, outsideWindow: true };
  }

  // 启动，带重试窗口
  if (!state.startAttempt || state.startAttempt.targetId !== duty.id) {
    state.startAttempt = { targetId: duty.id, since: Date.now(), attempts: 0, overLimitStopped: false };
  }
  const attempt = state.startAttempt;
  attempt.attempts += 1;

  const started = await startEcs(duty);
  if (started.ok) {
    state.startAttempt = null;
    state.keepAliveAt = now.iso;
    await engine.saveState(state);
    await appendLogSafe(env, 'AUDIT', '保活启动', `${duty.name}（原状态 ${desc.status}）`);
    await sendTelegram(env, cfg, '🔄 【实例保活启动】', [
      ['账号', duty.name],
      ['实例', duty.instanceId],
      ['原状态', desc.status],
      ['流量', `${dutyState.trafficGb} GB`],
    ], '检测到当班实例意外停止，已发送启动指令。');
    return { ok: true, duty: duty.id, keepAliveStarted: true };
  }

  await appendLogSafe(env, 'ERROR', `保活启动失败 [${duty.name}]`, `第 ${attempt.attempts} 次: ${started.error}`);
  const waited = Date.now() - attempt.since;
  if (waited >= num(cfg.system.startRetrySeconds, 180) * 1000) {
    return setFault(env, engine, state, 'START_FAILED',
      `${duty.name} 连续 ${attempt.attempts} 次启动失败，已等待 ${Math.floor(waited / 1000)} 秒: ${started.error}`);
  }
  await engine.saveState(state);
  return { waiting: true, retrying: true, duty: duty.id, attempts: attempt.attempts, error: started.error };
}

// ---------------------------------------------------------------- 熔断

async function fuseAndStopDuty(env, cfg, state, engine, duty, reason) {
  const desc = await describeEcs(duty);
  let detail = desc.ok ? `${desc.status}/${desc.stoppedMode}` : (desc.error || '状态未知');
  let confirmed = isStopChargingConfirmed(desc);

  if (!confirmed && desc.ok && desc.status !== 'Stopped') {
    const res = await stopAndConfirm(duty);
    confirmed = res.ok;
    detail = res.detail;
  }

  state.dutyAccountId = null;
  state.dutySince = 0;
  state.fusedMonth = state.month;
  state.transition = null;
  state.startAttempt = null;
  await engine.saveState(state);

  await appendLogSafe(env, confirmed ? 'AUDIT' : 'ERROR', '🔴 全部账号额度耗尽', `${duty.name} 停机: ${detail}；触发原因: ${reason}`);
  await sendTelegram(env, cfg, '🔴 【全部额度耗尽 · 已停机】', [
    ['计费月', state.month],
    ['当班账号', duty.name],
    ['触发原因', reason],
    ['停机确认', confirmed ? detail : `未确认（${detail}）`],
    ['账号数', String(cfg.accounts.length)],
  ], confirmed
    ? '所有账号本月额度均已耗尽，当班实例已进入节省停机，新计费月自动恢复。'
    : '所有账号额度耗尽，但当班实例停机未确认，请人工检查。');

  if (!confirmed) {
    return setFault(env, engine, state, 'FUSE_STOP_CHARGING_NOT_CONFIRMED', `${duty.name}: ${detail}`);
  }
  return { fused: true, reason: 'all_accounts_exhausted', stopped: duty.id, month: state.month };
}

// ---------------------------------------------------------------- 换班

async function beginTransition(env, cfg, state, engine, target, off, type, reason) {
  const targetState = await describeEcs(target);
  if (!targetState.ok) {
    if (targetState.status === 'NotFound') {
      return setFault(env, engine, state, 'INSTANCE_NOT_FOUND', `${target.name}: 实例 ${target.instanceId} 不存在或已被释放`, null, { accountId: target.id });
    }
    return setFault(env, engine, state, 'ECS_DESCRIBE_FAILED', `${target.name}: ${targetState.error}`);
  }

  if (targetState.status === 'Running') {
    state.transition = {
      targetId: target.id, offId: off.id, type, reason,
      startTime: Date.now(), step: 'WAIT_DNS_DRAIN',
      dnsOk: false, dnsMsg: '待同步', dnsVerified: false, drainUntil: null,
    };
    await engine.saveState(state);
    return advanceTransition(env, cfg, state, engine, bjNow());
  }

  if (!state.startAttempt || state.startAttempt.targetId !== target.id) {
    state.startAttempt = { targetId: target.id, since: Date.now(), attempts: 0 };
  }
  const attempt = state.startAttempt;
  attempt.attempts += 1;

  const started = await startEcs(target);
  if (!started.ok) {
    const waited = Date.now() - attempt.since;
    await appendLogSafe(env, 'ERROR', `实例启动失败 [${target.name}]`, `第 ${attempt.attempts} 次，已等待 ${Math.floor(waited / 1000)} 秒: ${started.error}`);

    // 当班账号已超限且备机起不来时，必须先把超限实例切下来，否则会继续跑出账单
    const offSt = state.accounts[off.id];
    const offThreshold = resolveTrafficThreshold(off, cfg);
    if (offSt?.exhausted && offSt.trafficGb >= offThreshold && waited >= num(cfg.system.startRetrySeconds, 180) * 1000) {
      const res = await stopAndConfirm(off);
      state.startAttempt = null;
      state.dutyAccountId = null;
      state.dutySince = 0;
      state.fusedMonth = state.month;
      await engine.saveState(state);
      await appendLogSafe(env, res.ok ? 'AUDIT' : 'ERROR', '🔴 超限停机执行', `${off.name}: ${res.detail}`);
      await sendTelegram(env, cfg, '🔴 【超限停机报告】', [
        ['超限实例', off.name],
        ['已用流量', `${offSt.trafficGb} GB / ${offThreshold} GB`],
        ['停机确认', res.ok ? res.detail : `未确认（${res.detail}）`],
        ['备用实例', `${target.name} 启动失败`],
        ['后续动作', '每分钟继续尝试拉起备用实例'],
      ], '当班账号超限且无法完成接力，已切断当班实例以避免产生账单。');
      return { waiting: true, overLimitStopped: true, retrying: true };
    }

    if (waited >= num(cfg.system.startRetrySeconds, 180) * 1000) {
      return setFault(env, engine, state, 'START_FAILED',
        `${target.name} 连续 ${attempt.attempts} 次启动失败，已等待 ${Math.floor(waited / 1000)} 秒: ${started.error}`);
    }
    await engine.saveState(state);
    return { waiting: true, retrying: true, attempts: attempt.attempts, error: started.error };
  }

  state.startAttempt = null;
  state.transition = {
    targetId: target.id, offId: off.id, type, reason,
    startTime: Date.now(), step: 'WAIT_START',
    dnsOk: false, dnsMsg: '待同步', dnsVerified: false, drainUntil: null,
  };
  await engine.saveState(state);
  await appendLogSafe(env, 'AUDIT', '开始换班', `${off.name} -> ${target.name}（${reason}）`);
  return { transition: state.transition };
}

function transitionTimeoutMs(cfg) {
  return num(cfg.system.transitionTimeoutMinutes, 10) * 60000;
}

function dnsDrainMs(cfg) {
  return num(cfg.system.dnsDrainSeconds, 60) * 1000;
}

async function advanceTransition(env, cfg, state, engine, now) {
  const tr = state.transition;
  const target = findAccount(cfg, tr.targetId);
  const off = findAccount(cfg, tr.offId);
  if (!target || !off) {
    return setFault(env, engine, state, 'TRANSITION_CONFIG_INVALID', `换班引用的实例已不存在: ${tr.targetId} / ${tr.offId}`);
  }

  const elapsed = Date.now() - tr.startTime;
  if (elapsed > transitionTimeoutMs(cfg)) {
    const [a, b] = await Promise.all([describeEcs(target), describeEcs(off)]);
    return setFault(env, engine, state, 'TRANSITION_TIMEOUT',
      `${target.name}: ${a.status || a.error}; ${off.name}: ${b.status || b.error}`,
      {
        title: '⚠️ 【换班异常报告】',
        items: [
          ['当班实例', `${target.name} (当前: ${a.status || a.error})`],
          ['离班实例', `${off.name} (当前: ${b.status || b.error}/${b.stoppedMode || '-'})`],
          ['换班类型', tr.type || 'SHIFT'],
          ['超时时长', `${Math.floor(elapsed / 60000)} 分钟`],
          ['错误码', 'TRANSITION_TIMEOUT'],
        ],
        summary: '换班未能收敛，调度已进入保护状态。',
      });
  }

  // ---- WAIT_START：等新实例 Running
  if (tr.step === 'WAIT_START') {
    const desc = await describeEcs(target);
    if (!desc.ok) {
      if (desc.status === 'NotFound') {
        return setFault(env, engine, state, 'INSTANCE_NOT_FOUND', `${target.name}: 实例不存在或已被释放`, null, { accountId: target.id });
      }
      return setFault(env, engine, state, 'ECS_DESCRIBE_FAILED', `${target.name}: ${desc.error}`);
    }
    if (desc.status !== 'Running') {
      await engine.saveState(state);
      return { waiting: true, step: 'WAIT_START', status: desc.status };
    }
    tr.step = 'WAIT_DNS_DRAIN';
    await engine.saveState(state);
    return advanceTransition(env, cfg, state, engine, now);
  }

  // ---- WAIT_DNS_DRAIN：同步 DNS 并等待缓冲期
  if (tr.step === 'WAIT_DNS_DRAIN') {
    const desc = await describeEcs(target);
    if (!desc.ok || desc.status !== 'Running') {
      if (desc.ok) {
        await engine.saveState(state);
        return { waiting: true, step: 'WAIT_DNS_DRAIN', status: desc.status };
      }
      return setFault(env, engine, state, 'ECS_DESCRIBE_FAILED', `${target.name}: ${desc.error}`);
    }
    const ip = desc.eip || target.eip;
    if (!ip) return setFault(env, engine, state, 'DNS_UPDATE_FAILED', `${target.name}: 实例没有公网 IP`);

    const dns = await ensureDns(cfg, ip);
    if (!dns.ok) {
      return setFault(env, engine, state, 'DNS_UPDATE_FAILED', `${target.name}: ${dns.message}`);
    }
    tr.dnsOk = true;
    tr.dnsMsg = dns.message;
    tr.dnsVerified = true;
    if (dns.changed && !tr.drainUntil) {
      tr.drainUntil = Date.now() + dnsDrainMs(cfg);
      await engine.saveState(state);
      return { waiting: true, step: 'WAIT_DNS_DRAIN', drainUntil: tr.drainUntil, dns: dns.message };
    }
    if (tr.drainUntil && Date.now() < tr.drainUntil) {
      await engine.saveState(state);
      return { waiting: true, step: 'WAIT_DNS_DRAIN', drainUntil: tr.drainUntil };
    }

    // 缓冲结束，确认新实例仍在跑
    const recheck = await describeEcs(target);
    if (!recheck.ok || recheck.status !== 'Running') {
      return setFault(env, engine, state, 'TARGET_NOT_RUNNING_AFTER_DNS', `${target.name}: ${recheck.status || recheck.error}`);
    }
    tr.step = 'WAIT_STOP';
    await engine.saveState(state);
    return advanceTransition(env, cfg, state, engine, now);
  }

  // ---- WAIT_STOP：停掉旧实例
  if (tr.step === 'WAIT_STOP') {
    const offState = await describeEcs(off);
    if (!offState.ok) {
      if (offState.status === 'NotFound') {
        // 实例已被释放，等同于已停机
        return finishTransition(env, cfg, state, engine, target, off, tr);
      }
      return setFault(env, engine, state, 'ECS_DESCRIBE_FAILED', `${off.name}: ${offState.error}`);
    }

    if (isStopChargingConfirmed(offState)) {
      return finishTransition(env, cfg, state, engine, target, off, tr);
    }
    if (offState.status === 'Stopped') {
      return setFault(env, engine, state, 'STOP_CHARGING_NOT_CONFIRMED', `${off.name} = Stopped/${offState.stoppedMode}`);
    }
    if (offState.status === 'Stopping') {
      await engine.saveState(state);
      return { waiting: true, step: 'WAIT_STOP', status: 'Stopping' };
    }

    const stopped = await stopEcs(off);
    if (!stopped.ok) return setFault(env, engine, state, 'STOP_FAILED', `${off.name}: ${stopped.error}`);
    await engine.saveState(state);
    return { waiting: true, step: 'WAIT_STOP', status: offState.status };
  }

  return setFault(env, engine, state, 'UNKNOWN_TRANSITION_STEP', `未知换班步骤: ${tr.step}`);
}

async function finishTransition(env, cfg, state, engine, target, off, tr) {
  state.dutyAccountId = target.id;
  state.dutySince = Date.now();
  state.rotationIndex = cfg.accounts.findIndex((a) => a.id === target.id);
  state.transition = null;
  state.startAttempt = null;
  await engine.saveState(state);

  const t = state.accounts[target.id] || {};
  const o = state.accounts[off.id] || {};
  await appendLogSafe(env, 'AUDIT', '换班完成', `${off.name} -> ${target.name}`);

  const titles = { SHIFT: '✅ 【换班完成报告】', TEMPORARY: '✅ 【临时换班完成报告】', RECOVERY: '✅ 【当班恢复报告】' };
  await sendTelegram(env, cfg, titles[tr.type] || titles.SHIFT, [
    ['当班实例', `${target.name} (${target.regionId})`],
    ['离班实例', `${off.name} 已节省停机`],
    ['换班原因', tr.reason || '定时轮换'],
    ['当班流量', `${t.trafficGb ?? '-'} GB`],
    ['离班流量', `${o.trafficGb ?? '-'} GB`],
    ['DNS', tr.dnsMsg || '-'],
  ], '域名已指向新的当班实例。');

  return { ok: true, duty: target.id, transition: 'done' };
}

// ---------------------------------------------------------------- 日报

async function maybeDailyReport(env, cfg, state, engine) {
  if (!cfg.system.dailyReport) return;
  if (!cfg.accounts.length) return;
  const now = bjNow();
  if (now.hhmm < cfg.system.dailyReportTime) return;
  if (state.dailyReportDate === now.date) return;
  state.dailyReportDate = now.date;
  await engine.saveState(state);

  const items = [];
  for (const acc of cfg.accounts) {
    const st = state.accounts[acc.id] || {};
    const cls = trafficClass(acc.regionId);
    const threshold = resolveTrafficThreshold(acc, cfg);
    const duty = state.dutyAccountId === acc.id ? ' ← 当班' : '';
    const bill = st.billOk && st.billAmount != null ? `，账单 ${st.billAmount}` : '';
    items.push([acc.name + duty, `${st.trafficGb ?? '-'} / ${threshold} GB（${cls === 'china' ? '中国内地' : '非中国内地'}）${bill}`]);
  }
  if (state.fault) items.push(['当前状态', `保护中: ${state.fault.code}`]);
  else if (state.fusedMonth === state.month) items.push(['当前状态', '全部账号额度耗尽']);

  await sendTelegram(env, cfg, '📊 【每日流量日报】', items, `${now.date} 汇总`);
}

// ============================================================================
// 状态管理（KV）
// ============================================================================

function getEngine(env) {
  return {
    async loadState() {
      const stored = await env.STATE_KV.get('state_v2', { type: 'json' });
      if (stored) return { ...defaultState(), ...stored };
      return defaultState();
    },
    async saveState(state) {
      await env.STATE_KV.put('state_v2', JSON.stringify(state));
    },
    async resetState() {
      await env.STATE_KV.delete('state_v2');
      return defaultState();
    },
  };
}

async function executeCron(env) {
  try {
    const engine = getEngine(env);
    const result = await runEngineCron(env, engine);
    const cfg = await getConfig(env);
    const state = await engine.loadState();
    await maybeDailyReport(env, cfg, state, engine);
    return result ?? { ok: true };
  } catch (e) {
    await appendLogSafe(env, 'ERROR', 'Cron执行异常', e.message);
    return { error: e.message };
  }
}

// 故障的触发条件可能已经不成立（比如实例被释放后用户已把它从配置里删掉）。
// 只对能安全自愈的故障码做自动解除，其余必须人工确认。
async function tryAutoClearFault(env, cfg, state, engine) {
  const fault = state.fault;
  if (!fault) return false;
  if (fault.code !== 'INSTANCE_NOT_FOUND') return false;
  // 触发故障的那个实例还在配置里 → 不能自愈
  if (fault.accountId && cfg.accounts.some((a) => a.id === fault.accountId)) return false;

  state.fault = null;
  await engine.saveState(state);
  await appendLogSafe(env, 'AUDIT', '自动解除保护', '触发故障的实例已从配置中移除');
  return true;
}

// 清故障：先按真实状态对账，再清
async function reconcileAndClearFault(env, cfg, state, engine) {
  const notes = [];
  const code = state.fault?.code;

  // 熔断其实已经完成（所有账号都耗尽且当班已停机）
  const allExhausted = cfg.accounts.length > 0 && cfg.accounts.every((a) => state.accounts[a.id]?.exhausted);
  if (allExhausted) {
    state.fusedMonth = state.month;
    state.dutyAccountId = null;
    state.transition = null;
    state.startAttempt = null;
    notes.push('所有账号额度均已耗尽，已确认熔断状态');
  } else if (state.transition) {
    // 换班其实已经完成
    const tr = state.transition;
    const target = findAccount(cfg, tr.targetId);
    const off = findAccount(cfg, tr.offId);
    if (target && off) {
      const [a, b] = await Promise.all([describeEcs(target), describeEcs(off)]);
      if (a.ok && a.status === 'Running' && (isStopChargingConfirmed(b) || b.status === 'NotFound')) {
        state.dutyAccountId = target.id;
        state.dutySince = Date.now();
        state.rotationIndex = cfg.accounts.findIndex((x) => x.id === target.id);
        state.transition = null;
        state.startAttempt = null;
        notes.push(`换班实际已完成，已确认 ${target.name} 为当班账号`);
      } else {
        notes.push('换班未完成，保留进度，下一次巡检将从真实状态继续');
      }
    } else {
      state.transition = null;
      notes.push('换班引用的实例已不存在，已清除换班进度');
    }
  }

  // 实例缺失是唯一需要重新核实的硬条件：只要配置里已经没有不存在的实例，就可以解除
  const missing = [];
  for (const acc of cfg.accounts) {
    if (!isConfigured(acc)) continue;
    const d = await describeEcs(acc);
    if (!d.ok && d.status === 'NotFound') missing.push(`${acc.name}(${acc.instanceId})`);
  }
  if (missing.length) {
    await engine.saveState(state);
    notes.push(`以下实例仍不存在，请先在「设置」里删除或改成正确的实例 ID：${missing.join('、')}`);
    return { ok: false, cleared: false, notes, fault: state.fault };
  }
  if (code === 'INSTANCE_NOT_FOUND') notes.push('实例缺失问题已解决');

  state.fault = null;
  await engine.saveState(state);
  await appendLogSafe(env, 'AUDIT', '清除故障', notes.join('；') || '人工清除');
  return { ok: true, cleared: true, notes, previousFault: code || null };
}

// ============================================================================
// HTTP 入口
// ============================================================================

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

function parseCookies(request) {
  const out = {};
  for (const part of (request.headers.get('Cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function getSession(env, request) {
  const token = parseCookies(request).cdt_session;
  if (!token) return null;
  const raw = await env.STATE_KV.get(`session:${token}`, { type: 'json' });
  if (!raw || Date.now() > num(raw.expiresAt, 0)) return null;
  return { token, ...raw };
}

function adminPassword(env, cfg) {
  return env.ADMIN_PASS || cfg.adminPass || '';
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cfg = await getConfig(env);

    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(renderHtml(), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    if (url.pathname === '/api/login' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const expected = adminPassword(env, cfg);
      if (!expected) return json({ error: '未设置管理员密码：请配置 ADMIN_PASS secret 或在面板中设置' }, 503);
      if (String(body.password || '') !== expected) {
        await appendLogSafe(env, 'ERROR', '登录失败', request.headers.get('CF-Connecting-IP') || 'unknown');
        return json({ error: '密码错误' }, 401);
      }
      const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
      await env.STATE_KV.put(`session:${token}`, JSON.stringify({ expiresAt: Date.now() + SESSION_TTL_MS, at: new Date().toISOString() }), { expirationTtl: 43200 });
      await appendLogSafe(env, 'AUDIT', '登录成功', request.headers.get('CF-Connecting-IP') || 'unknown');
      return json({ ok: true }, 200, { 'Set-Cookie': `cdt_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200` });
    }

    if (url.pathname === '/api/logout') {
      const session = await getSession(env, request);
      if (session) await env.STATE_KV.delete(`session:${session.token}`);
      return json({ ok: true }, 200, { 'Set-Cookie': 'cdt_session=; Path=/; Max-Age=0' });
    }

    if (url.pathname === '/api/auth') {
      return json({ authenticated: !!(await getSession(env, request)) });
    }

    // ---- 以下接口都需要登录
    if (!(await getSession(env, request))) return json({ error: 'Unauthorized' }, 401);

    if (url.pathname === '/api/state') {
      const engine = getEngine(env);
      const state = await engine.loadState();
      const logs = await readLogs(env);
      const accounts = cfg.accounts.map((a) => {
        const st = state.accounts?.[a.id] || {};
        return {
          id: a.id, name: a.name, regionId: a.regionId, instanceId: a.instanceId,
          siteType: a.siteType, remark: a.remark, eip: a.eip || '',
          trafficClass: trafficClass(a.regionId),
          threshold: resolveTrafficThreshold(a, cfg),
          quota: quotaForClass(trafficClass(a.regionId)),
          billThreshold: resolveBillThreshold(a, cfg),
          keepAlive: resolveKeepAlive(a, cfg),
          duty: state.dutyAccountId === a.id,
          exhausted: !!st.exhausted, reason: st.reason || '',
          trafficGb: st.trafficGb ?? null, breakdown: st.breakdown || [],
          billAccountAmount: st.billAmount ?? null,
          billInstanceAmount: st.billInstanceAmount ?? null,
          billCurrency: st.billCurrency || null,
          billOk: !!st.billOk, billError: st.billError || null,
          ecsStatus: st.ecsStatus || null, ecsError: st.ecsError || null,
          ecsStoppedMode: st.ecsStoppedMode || null, ecsEip: st.ecsEip || null,
          balance: st.balance ?? null, balanceCurrency: st.balanceCurrency || null, balanceOk: !!st.balanceOk,
          configured: isConfigured(a),
        };
      });
      return json({
        ok: true,
        month: state.month,
        dutyAccountId: state.dutyAccountId,
        dutySince: state.dutySince,
        fused: state.fusedMonth === state.month,
        transition: state.transition,
        fault: state.fault,
        lastTrafficCheck: state.lastTrafficCheck,
        accounts,
        logs: logs.slice(0, 60),
        config: withLiveIps(publicConfig(cfg, env), state),
      });
    }

    if (url.pathname === '/api/config' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const next = sanitizeConfig(body, cfg, env);
      // 打码的密钥只有能按 id 匹配到旧值时才能还原；否则说明匹配失败，
      // 此时宁可直接报错，也不能把真实密钥静默覆写成 ****
      const unresolved = next.accounts.filter((a) => isMasked(a.ak) || isMasked(a.sk)).map((a) => a.name);
      if (unresolved.length) {
        return json({ error: `密钥无法还原，请重新填写：${unresolved.join('、')}` }, 400);
      }
      try { validateConfig(next); }
      catch (e) { return json({ error: e.message }, 400); }
      await saveConfig(env, next);
      await appendLogSafe(env, 'AUDIT', '保存配置', `账号数 ${next.accounts.length}`);
      return json({ ok: true, config: publicConfig(next, env) });
    }

    if (url.pathname === '/api/action' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const engine = getEngine(env);
      switch (body.action) {
        case 'trigger_cron': return json(await executeCron(env));
        case 'test_tg': {
          const cfg = await getConfig(env);
          const r = await sendTelegram(env, cfg, '🔔 【测试消息】', [
            ['来源', 'CDT-Monitor'],
            ['时间', bjNow().iso],
          ], '如果你看到这条消息，说明 Telegram 通知配置正确。');
          return json(r);
        }
        case 'probe_bill': return json(await probeBilling(env));
        case 'clear_fault': {
          const cfg = await getConfig(env);
          const state = await engine.loadState();
          const result = await reconcileAndClearFault(env, cfg, state, engine);
          return json(result);
        }
        case 'reset_state': {
          const state = await engine.resetState();
          return json({ ok: true, state });
        }
        case 'clear_logs':
          await env.STATE_KV.put('app_logs', '[]');
          return json({ ok: true });
        default: return json({ error: '未知操作' }, 400);
      }
    }

    return new Response('Not found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(executeCron(env));
  },
};

// 对外返回配置时把密钥打码，但不回传明文以外的字段
function publicConfig(cfg, env) {
  return {
    ...cfg,
    adminPass: adminPassword(env, cfg) ? '******' : '',
    hasAdminPass: !!adminPassword(env, cfg),
    adminPassFromSecret: !!env.ADMIN_PASS,
    accounts: cfg.accounts.map((a) => ({ ...a, ak: mask(a.ak), sk: mask(a.sk) })),
    cf: { ...cfg.cf, apiToken: mask(cfg.cf.apiToken) },
    notify: { tg: { ...cfg.notify.tg, botToken: mask(cfg.notify.tg.botToken) } },
  };
}

// 设置面板需要看到实例当前真实公网 IP（停机时 DescribeInstances 可能不返回），
// 只用于展示，不写回配置。
function withLiveIps(pub, state) {
  return {
    ...pub,
    accounts: (pub.accounts || []).map((a) => ({
      ...a,
      liveEip: state?.accounts?.[a.id]?.ecsEip || null,
    })),
  };
}

// 面板提交的是打码后的密钥时保留原值
function keepIfMasked(next, prev) {
  return (!next || isMasked(next)) ? prev : next;
}

function isMasked(v) {
  const s = String(v ?? '');
  return /^\*+/.test(s) || s.includes('****');
}

function sanitizeConfig(body, prev, env) {
  const base = defaultConfig();
  // 面板不会回传所有字段，缺失的必须沿用已有配置，
  // 否则会被默认值默默覆盖（余额开关就是这么丢的）。
  const sys = { ...base.system, ...(prev.system || {}), ...(body.system || {}) };
  const accounts = Array.isArray(body.accounts) ? body.accounts.map((raw) => {
    const existing = prev.accounts.find((a) => a.id === raw.id);
    return normalizeAccount({
      ...raw,
      id: raw.id || crypto.randomUUID(),
      ak: keepIfMasked(raw.ak, existing?.ak || ''),
      sk: keepIfMasked(raw.sk, existing?.sk || ''),
    });
  }) : (prev.accounts || []);
  return {
    adminPass: env.ADMIN_PASS ? '' : (body.adminPass && !String(body.adminPass).includes('****') ? body.adminPass : prev.adminPass),
    system: {
      ...sys,
      trafficThresholdChina: num(sys.trafficThresholdChina, base.system.trafficThresholdChina),
      trafficThresholdIntl: num(sys.trafficThresholdIntl, base.system.trafficThresholdIntl),
      billThreshold: num(sys.billThreshold, 0),
      rotationIntervalMinutes: num(sys.rotationIntervalMinutes, 0),
      dnsDrainSeconds: num(sys.dnsDrainSeconds, 60),
      transitionTimeoutMinutes: num(sys.transitionTimeoutMinutes, 10),
      startRetrySeconds: num(sys.startRetrySeconds, 180),
      billCheckMinutes: num(sys.billCheckMinutes, 30),
      keepAlive: !!sys.keepAlive,
      dailyReport: !!sys.dailyReport,
    },
    accounts,
    cf: {
      apiToken: keepIfMasked(body.cf?.apiToken, prev.cf.apiToken),
      zoneId: body.cf?.zoneId ?? prev.cf.zoneId,
      recordId: body.cf?.recordId ?? prev.cf.recordId,
      domainName: body.cf?.domainName ?? prev.cf.domainName,
    },
    notify: {
      tg: {
        enabled: body.notify?.tg ? !!body.notify.tg.enabled : !!prev.notify.tg.enabled,
        botToken: keepIfMasked(body.notify?.tg?.botToken, prev.notify.tg.botToken),
        chatId: body.notify?.tg?.chatId ?? prev.notify.tg.chatId,
      },
    },
  };
}

// ============================================================================
// UI
// ============================================================================

function renderHtml() {
  const regionOptions = REGIONS.map(([code, name]) => `<option value="${code}">${code} · ${name}</option>`).join('');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CDT MONITOR</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>
  body { background:#f1f3f5; color:#18181b; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  .card { background:#fff; border:1px solid rgba(226,232,240,.9); box-shadow:0 1px 3px rgba(0,0,0,.03); }
  .hidden { display:none !important; }
</style>
</head>
<body class="p-4 md:p-8 min-h-screen">
<datalist id="regionList">${regionOptions}</datalist>

<div id="loginView" class="hidden max-w-sm mx-auto mt-24">
  <div class="card rounded-3xl p-8 space-y-4">
    <h1 class="text-sm font-bold tracking-widest uppercase text-zinc-900">CDT MONITOR</h1>
    <p class="text-xs text-zinc-500">请输入管理员密码</p>
    <input id="loginPass" type="password" placeholder="管理员密码" class="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-3 py-2 text-sm" onkeydown="if(event.key==='Enter')doLogin()">
    <button onclick="doLogin()" class="w-full py-2 rounded-xl bg-zinc-900 text-white text-xs font-bold">登录</button>
    <p id="loginErr" class="text-[11px] text-rose-600 hidden"></p>
  </div>
</div>

<div id="appView" class="hidden max-w-6xl mx-auto space-y-6">
  <header class="flex justify-between items-center flex-wrap gap-3">
    <div>
      <h1 class="text-sm font-bold tracking-widest uppercase text-zinc-900">CDT MONITOR</h1>
      <p id="dutyLine" class="text-[11px] text-zinc-500 mt-0.5">加载中…</p>
    </div>
    <div class="flex items-center gap-2">
      <button onclick="act('trigger_cron')" class="px-3 py-1.5 rounded-xl bg-zinc-900 text-white text-xs font-bold">立即巡检</button>
      <button onclick="openSettings()" class="px-3 py-1.5 rounded-xl bg-white border border-zinc-200 text-zinc-700 text-xs font-bold">设置</button>
      <button onclick="doLogout()" class="px-3 py-1.5 rounded-xl bg-white border border-zinc-200 text-zinc-700 text-xs font-bold">退出</button>
    </div>
  </header>

  <div id="faultBanner" class="hidden rounded-2xl bg-rose-50 border border-rose-200 p-4">
    <p class="text-xs font-bold text-rose-800" id="faultTitle"></p>
    <p class="text-[11px] text-rose-700 mt-1" id="faultMsg"></p>
    <p class="text-[11px] text-rose-600 mt-2 font-bold" id="faultHint"></p>
    <button onclick="act('clear_fault')" class="mt-3 px-3 py-1.5 rounded-xl bg-rose-600 text-white text-[11px] font-bold">状态对账并清除故障</button>
  </div>

  <div id="fuseBanner" class="hidden rounded-2xl bg-amber-50 border border-amber-200 p-4">
    <p class="text-xs font-bold text-amber-800">本月全部账号额度已耗尽</p>
    <p class="text-[11px] text-amber-700 mt-1">调度已停止，新计费月自动恢复。</p>
  </div>

  <section>
    <div class="flex justify-between items-center mb-3">
      <h2 class="text-xs font-bold uppercase tracking-wider text-zinc-500">实例</h2>
      <button onclick="addAccount()" class="px-3 py-1.5 rounded-xl bg-white border border-zinc-200 text-zinc-700 text-[11px] font-bold">+ 添加实例</button>
    </div>
    <div id="accountGrid" class="grid md:grid-cols-2 gap-4"></div>
    <p id="emptyHint" class="hidden text-xs text-zinc-400 text-center py-10">还没有实例。点「+ 添加实例」开始。</p>
  </section>

  <section class="card rounded-2xl p-4">
    <h2 class="text-xs font-bold uppercase tracking-wider text-zinc-500 mb-3">日志</h2>
    <div id="logList" class="space-y-1 max-h-80 overflow-auto text-[11px]"></div>
  </section>
</div>

<div id="settingsModal" class="hidden fixed inset-0 bg-black/40 p-4 overflow-auto z-50">
  <div class="card rounded-3xl max-w-3xl mx-auto my-8 p-6 space-y-5">
    <div class="flex justify-between items-center">
      <h2 class="text-sm font-bold text-zinc-900">设置</h2>
      <button onclick="closeSettings()" class="text-zinc-400 text-lg leading-none">&times;</button>
    </div>

    <div class="space-y-4">
      <h3 class="text-[11px] font-bold uppercase tracking-wider text-zinc-400">额度与轮换</h3>
      <div class="grid md:grid-cols-3 gap-3">
        <label class="block"><span class="text-[11px] font-bold text-zinc-600">中国内地流量阈值 (GB)</span>
          <input id="s_trafficChina" type="number" class="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-3 py-2 text-xs mt-1"></label>
        <label class="block"><span class="text-[11px] font-bold text-zinc-600">非中国内地流量阈值 (GB)</span>
          <input id="s_trafficIntl" type="number" class="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-3 py-2 text-xs mt-1"></label>
        <label class="block"><span class="text-[11px] font-bold text-zinc-600">账单阈值 (0=关闭)</span>
          <input id="s_billThreshold" type="number" class="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-3 py-2 text-xs mt-1"></label>
        <label class="block"><span class="text-[11px] font-bold text-zinc-600">定时轮换 (分钟, 0=关闭)</span>
          <input id="s_rotation" type="number" class="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-3 py-2 text-xs mt-1"></label>
        <label class="block"><span class="text-[11px] font-bold text-zinc-600">账单检查间隔 (分钟)</span>
          <input id="s_billCheck" type="number" class="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-3 py-2 text-xs mt-1"></label>
        <label class="flex items-center gap-2 mt-5"><input id="s_keepAlive" type="checkbox" class="w-4 h-4"><span class="text-[11px] font-bold text-zinc-600">默认开启保活</span></label>
      </div>
      <p class="text-[10px] text-zinc-400 leading-relaxed">CDT 免费额度按地域分成两个独立池：中国内地 20 GB/月、非中国内地 200 GB/月。阈值按实例地域自动选用对应的一项，单个实例可单独覆盖。</p>

      <h3 class="text-[11px] font-bold uppercase tracking-wider text-zinc-400 pt-2">时序</h3>
      <div class="grid md:grid-cols-3 gap-3">
        <label class="block"><span class="text-[11px] font-bold text-zinc-600">DNS 缓冲 (秒)</span>
          <input id="s_drain" type="number" class="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-3 py-2 text-xs mt-1"></label>
        <label class="block"><span class="text-[11px] font-bold text-zinc-600">换班超时 (分钟)</span>
          <input id="s_timeout" type="number" class="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-3 py-2 text-xs mt-1"></label>
        <label class="block"><span class="text-[11px] font-bold text-zinc-600">启动重试窗口 (秒)</span>
          <input id="s_startRetry" type="number" class="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-3 py-2 text-xs mt-1"></label>
        <label class="flex items-center gap-2"><input id="s_dailyReport" type="checkbox" class="w-4 h-4"><span class="text-[11px] font-bold text-zinc-600">每日日报</span></label>
        <label class="block"><span class="text-[11px] font-bold text-zinc-600">日报时间 (HH:mm)</span>
          <input id="s_dailyTime" type="text" class="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-3 py-2 text-xs mt-1"></label>
      </div>

      <h3 class="text-[11px] font-bold uppercase tracking-wider text-zinc-400 pt-2">实例</h3>
      <div id="acctEditor" class="space-y-3"></div>
      <button onclick="addAccount()" class="px-3 py-1.5 rounded-xl bg-zinc-100 border border-zinc-200 text-zinc-700 text-[11px] font-bold">+ 添加实例</button>

      <h3 class="text-[11px] font-bold uppercase tracking-wider text-zinc-400 pt-2">Cloudflare DDNS</h3>
      <div class="grid md:grid-cols-2 gap-3">
        <label class="block"><span class="text-[11px] font-bold text-zinc-600">API Token</span>
          <input id="s_cfToken" type="text" class="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-3 py-2 text-xs mt-1"></label>
        <label class="block"><span class="text-[11px] font-bold text-zinc-600">Zone ID</span>
          <input id="s_cfZone" type="text" class="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-3 py-2 text-xs mt-1"></label>
        <label class="block"><span class="text-[11px] font-bold text-zinc-600">Record ID</span>
          <input id="s_cfRecord" type="text" class="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-3 py-2 text-xs mt-1"></label>
        <label class="block"><span class="text-[11px] font-bold text-zinc-600">域名</span>
          <input id="s_cfDomain" type="text" class="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-3 py-2 text-xs mt-1"></label>
      </div>

      <h3 class="text-[11px] font-bold uppercase tracking-wider text-zinc-400 pt-2">通知</h3>
      <div class="grid md:grid-cols-3 gap-3">
        <label class="flex items-center gap-2 mt-5"><input id="s_tgEnabled" type="checkbox" class="w-4 h-4"><span class="text-[11px] font-bold text-zinc-600">Telegram</span></label>
        <label class="block"><span class="text-[11px] font-bold text-zinc-600">Bot Token</span>
          <input id="s_tgToken" type="text" class="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-3 py-2 text-xs mt-1"></label>
        <label class="block"><span class="text-[11px] font-bold text-zinc-600">Chat ID</span>
          <input id="s_tgChat" type="text" class="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-3 py-2 text-xs mt-1"></label>
      </div>

      <h3 class="text-[11px] font-bold uppercase tracking-wider text-zinc-400 pt-2">安全</h3>
      <label class="block"><span class="text-[11px] font-bold text-zinc-600">管理员密码</span>
        <input id="s_adminPass" type="password" class="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-3 py-2 text-xs mt-1"></label>
      <p id="adminPassHint" class="text-[10px] text-zinc-400"></p>

      <h3 class="text-[11px] font-bold uppercase tracking-wider text-zinc-400 pt-2">诊断</h3>
      <div class="flex gap-2 flex-wrap">
        <button onclick="act('test_tg')" class="px-3 py-1.5 rounded-xl bg-zinc-100 border border-zinc-200 text-zinc-700 text-[11px] font-bold">发送测试消息</button>
        <button onclick="probeBill()" class="px-3 py-1.5 rounded-xl bg-zinc-100 border border-zinc-200 text-zinc-700 text-[11px] font-bold">账单接口诊断</button>
        <button onclick="act('clear_logs')" class="px-3 py-1.5 rounded-xl bg-zinc-100 border border-zinc-200 text-zinc-700 text-[11px] font-bold">清空日志</button>
      </div>
      <pre id="probeOut" class="hidden max-h-72 overflow-auto text-[10px] bg-zinc-50 border border-zinc-200 rounded-xl p-3 whitespace-pre-wrap break-all"></pre>
    </div>

    <div class="flex justify-end gap-2 pt-2">
      <button onclick="closeSettings()" class="px-4 py-2 rounded-xl bg-zinc-100 text-zinc-700 text-xs font-bold">取消</button>
      <button onclick="saveSettings()" class="px-4 py-2 rounded-xl bg-zinc-900 text-white text-xs font-bold">保存</button>
    </div>
  </div>
</div>

<script>
let CFG = null;
let STATE = null;

// 每个故障码对应的“怎么解”提示，避免用户卡在保护状态里无路可走
const FAULT_HINTS = {
  INSTANCE_NOT_FOUND: '实例已被释放或实例 ID 不正确。请到「设置」删除该实例或改成正确的实例 ID，然后点下面的按钮。',
  ACCOUNT_NOT_CONFIGURED: '实例缺少 AK/SK/地域/实例 ID。请到「设置」补全后重试。',
  CONFIG_INVALID: '配置参数不合法。请到「设置」修正后重试。',
  CDT_QUERY_FAILED: '流量查询失败。检查 AccessKey 是否有 cdt:ListCdtInternetTraffic 权限。',
  BILL_QUERY_FAILED: '账单查询失败。检查 bss:DescribeInstanceBill 权限，或把账单阈值设为 0 关掉这项判定。',
  ECS_DESCRIBE_FAILED: '查询实例状态失败。检查 ecs:DescribeInstances 权限。',
  START_FAILED: '实例反复启动失败（常见于库存不足）。确认实例可用后重试。',
  STOP_FAILED: '停机指令失败。检查 ecs:StopInstance 权限。',
  STOP_CHARGING_NOT_CONFIRMED: '停机未进入节省停机模式。请到阿里云控制台确认实例状态。',
  FUSE_STOP_CHARGING_NOT_CONFIRMED: '额度耗尽后的停机未确认。请到阿里云控制台确认。',
  DNS_UPDATE_FAILED: 'Cloudflare DNS 更新失败。检查 API Token / Zone ID / Record ID 与域名。',
  TRANSITION_TIMEOUT: '换班超时未收敛。确认两台实例状态后重试。',
  TARGET_NOT_RUNNING_AFTER_DNS: 'DNS 切换后目标实例又停了。请检查该实例。',
};

// 实例编辑器是从 CFG.accounts 渲染的，但用户输入只存在 DOM 里。
// 任何重新渲染（添加 / 删除）之前必须先把 DOM 收回 CFG，否则刚填的内容会丢。
function syncAccountsFromDom(){
  const rows = document.querySelectorAll('#acctEditor [data-idx]');
  if (!rows.length) return;
  CFG.accounts = collectAccounts();
}

function esc(s){ return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

async function api(path, opts){
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') { showLogin(); throw new Error('未登录'); }
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

function showLogin(){ document.getElementById('loginView').classList.remove('hidden'); document.getElementById('appView').classList.add('hidden'); }
function showApp(){ document.getElementById('loginView').classList.add('hidden'); document.getElementById('appView').classList.remove('hidden'); }

async function doLogin(){
  const password = document.getElementById('loginPass').value;
  const err = document.getElementById('loginErr');
  err.classList.add('hidden');
  try {
    await api('/api/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ password }) });
    showApp(); await refresh();
  } catch(e){ err.textContent = e.message; err.classList.remove('hidden'); }
}

async function doLogout(){ await api('/api/logout', { method:'POST' }); showLogin(); }

async function act(action){
  try {
    const r = await api('/api/action', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action }) });
    if (action === 'test_tg') {
      if (r && r.ok) alert('测试消息已发送');
      else if (r && r.skipped) alert('未发送：Telegram 未启用或缺少 Bot Token / Chat ID');
      else if (r && r.error) alert('发送失败：' + r.error);
      else alert('发送结果未知');
    } else if (r && r.cleared === false) alert('未能清除：' + (r.notes || []).join('；'));
    else if (r && r.cleared === true) alert('已清除保护状态。' + (r.notes || []).join('；'));
    else if (r && r.halted) alert('已进入保护状态：' + (r.fault?.code || ''));
    else if (r && r.error) alert(r.error);
    await refresh();
  } catch(e){ alert(e.message); }
}

async function probeBill(){
  const out = document.getElementById('probeOut');
  out.classList.remove('hidden');
  out.textContent = '诊断中…';
  try {
    const r = await api('/api/action', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'probe_bill' }) });
    out.textContent = JSON.stringify(r, null, 2);
  } catch(e){ out.textContent = '失败: ' + e.message; }
}

function money(v, cur){
  if (v == null || v === '') return '-';
  const n = Number(v);
  if (!isFinite(n)) return '-';
  return (cur ? cur + ' ' : '') + ((n === 0 || Math.abs(n) >= 1) ? n.toFixed(2) : n.toFixed(4));
}

function barPct(used, total){
  if (!total || total <= 0 || used == null) return 0;
  return Math.min(100, Math.round(used / total * 100));
}

function barColor(p){
  return p >= 100 ? 'bg-rose-500' : p >= 80 ? 'bg-amber-500' : 'bg-emerald-500';
}

function statusStyle(s){
  if (s === 'Running') return 'bg-emerald-100 text-emerald-700';
  if (s === 'Stopped') return 'bg-zinc-100 text-zinc-600';
  if (s === 'Stopping' || s === 'Starting') return 'bg-amber-100 text-amber-700';
  return 'bg-rose-100 text-rose-700';
}

function renderAccounts(){
  const grid = document.getElementById('accountGrid');
  const list = STATE.accounts || [];
  document.getElementById('emptyHint').classList.toggle('hidden', list.length > 0);
  grid.innerHTML = list.map(function(a){
    // 进度条以免费限额（如非中国内地 200GB）为分母，阈值（如 188GB）单独显示并在条上打标记
    const qp = barPct(a.trafficGb, a.quota);
    const thresholdMark = (a.threshold > 0 && a.quota > 0 && a.threshold < a.quota)
      ? barPct(a.threshold, a.quota) : null;
    const bp = barPct(a.billAccountAmount, a.billThreshold);
    const cls = a.trafficClass === 'china' ? '中国内地' : '非中国内地';
    const cur = a.billCurrency || '';
    const status = a.ecsStatus || '未知';
    const brk = (a.breakdown || []).map(function(b){ return esc(b.region) + ' ' + b.gb + 'GB'; }).join(' · ');

    const row = function(label, value){
      return '<div class="flex justify-between text-[11px]"><span class="text-zinc-500">' + label + '</span>'
        + '<span class="font-bold text-zinc-800">' + value + '</span></div>';
    };

    return '<div class="card rounded-2xl p-4 space-y-2.5">'
      + '<div class="flex justify-between items-start gap-2">'
      +   '<div><p class="text-sm font-bold text-zinc-900">' + esc(a.name) + '</p>'
      +   '<p class="text-[10px] text-zinc-400">' + esc(a.regionId) + ' · ' + cls + ' · 额度 ' + a.quota + 'GB</p></div>'
      +   '<div class="flex gap-1 flex-wrap justify-end">'
      +     (a.duty ? '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-700">当班</span>' : '')
      +     (a.exhausted ? '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-100 text-rose-700">耗尽</span>' : '')
      +     '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold ' + statusStyle(status) + '">' + esc(status) + '</span>'
      +   '</div>'
      + '</div>'
      + (!a.configured ? '<p class="text-[10px] text-amber-600 font-bold">未配置完整（缺 AK/SK/地域/实例 ID）</p>' : '')
      + (a.ecsError ? '<p class="text-[10px] text-rose-600">' + esc(a.ecsError) + '</p>' : '')
      + '<div>'
      +   '<div class="flex justify-between text-[11px] mb-1"><span class="text-zinc-500">流量</span><span class="font-bold text-zinc-800">' + (a.trafficGb ?? '-') + ' / ' + a.quota + ' GB（限额）</span></div>'
      +   '<div class="relative h-1.5 rounded-full bg-zinc-100 overflow-hidden"><div class="h-full ' + barColor(qp) + '" style="width:' + qp + '%"></div>'
      +     (thresholdMark != null ? '<div class="absolute top-0 h-full w-0.5 bg-zinc-700/60" style="left:' + thresholdMark + '%"></div>' : '')
      +   '</div>'
      +   '<div class="flex justify-between text-[10px] mt-1"><span class="text-zinc-400">阈值</span><span class="' + (a.exhausted ? 'text-rose-600 font-bold' : 'text-zinc-500') + '">' + a.threshold + ' GB</span></div>'
      + '</div>'
      + (a.billThreshold > 0
          ? '<div>'
            + '<div class="flex justify-between text-[11px] mb-1"><span class="text-zinc-500">账单（账号级）</span><span class="font-bold text-zinc-800">' + money(a.billAccountAmount, cur) + ' / ' + money(a.billThreshold, cur) + '</span></div>'
            + '<div class="h-1.5 rounded-full bg-zinc-100 overflow-hidden"><div class="h-full ' + barColor(bp) + '" style="width:' + bp + '%"></div></div>'
            + '</div>'
          : row('账单（账号级）', money(a.billAccountAmount, cur)))
      + row('该实例费用', money(a.billInstanceAmount, cur))
      + row('账户余额', a.balanceOk ? money(a.balance, a.balanceCurrency || cur) : (a.configured ? '查询失败' : '-'))
      + row('公网 IP', a.ecsEip
          ? esc(a.ecsEip)
          : (a.eip ? esc(a.eip) + ' <span class="text-[10px] text-zinc-400 font-normal">（配置）</span>' : '-'))
      + (a.eip && a.ecsEip && a.eip !== a.ecsEip
          ? '<p class="text-[10px] text-rose-600">⚠️ 与配置的 EIP 不一致：' + esc(a.eip) + '</p>'
          : '')
      + (a.ecsStatus === 'Stopped'
          ? row('停机模式', a.ecsStoppedMode === 'StopCharging'
              ? '<span class="text-emerald-700">节省停机</span>'
              : '<span class="text-rose-600">' + esc(a.ecsStoppedMode || '未知') + '，仍在计费</span>')
          : '')
      + row('保活', a.keepAlive ? '开启' : '关闭')
      + (a.reason ? '<p class="text-[10px] text-rose-600">' + esc(a.reason) + '</p>' : '')
      + (brk ? '<p class="text-[10px] text-zinc-400">' + brk + '</p>' : '')
      + '</div>';
  }).join('');
}

function renderLogs(){
  const el = document.getElementById('logList');
  el.innerHTML = (STATE.logs || []).map(l => {
    const color = l.level === 'ERROR' ? 'text-rose-600' : l.level === 'AUDIT' ? 'text-emerald-700' : 'text-zinc-500';
    return '<div class="flex gap-2"><span class="text-zinc-400 shrink-0">' + esc((l.at||'').slice(5,16).replace('T',' ')) + '</span>'
      + '<span class="' + color + ' font-bold shrink-0">' + esc(l.level) + '</span>'
      + '<span class="text-zinc-700">' + esc(l.title) + (l.detail ? ' — ' + esc(l.detail) : '') + '</span></div>';
  }).join('');
}

function renderStatus(){
  const duty = (STATE.accounts || []).find(a => a.duty);
  const line = document.getElementById('dutyLine');
  if (STATE.fused) line.textContent = '本月全部账号额度耗尽';
  else if (duty) line.textContent = '当班：' + duty.name + ' · ' + (STATE.lastTrafficCheck ? STATE.lastTrafficCheck.at.slice(0,16).replace('T',' ') : '');
  else line.textContent = '等待首次巡检';

  const fb = document.getElementById('faultBanner');
  if (STATE.fault) {
    fb.classList.remove('hidden');
    document.getElementById('faultTitle').textContent = '保护状态：' + STATE.fault.code;
    document.getElementById('faultMsg').textContent = STATE.fault.message;
    document.getElementById('faultHint').textContent = '👉 ' + (FAULT_HINTS[STATE.fault.code] || '请检查配置后点下面的按钮重试。');
  } else fb.classList.add('hidden');

  document.getElementById('fuseBanner').classList.toggle('hidden', !STATE.fused);
}

async function refresh(){
  const data = await api('/api/state');
  STATE = data; CFG = data.config;
  renderStatus(); renderAccounts(); renderLogs();
}

function openSettings(){ fillSettings(); document.getElementById('settingsModal').classList.remove('hidden'); }
function closeSettings(){ document.getElementById('settingsModal').classList.add('hidden'); }

function fillSettings(){
  const s = CFG.system;
  document.getElementById('s_trafficChina').value = s.trafficThresholdChina;
  document.getElementById('s_trafficIntl').value = s.trafficThresholdIntl;
  document.getElementById('s_billThreshold').value = s.billThreshold;
  document.getElementById('s_rotation').value = s.rotationIntervalMinutes;
  document.getElementById('s_billCheck').value = s.billCheckMinutes;
  document.getElementById('s_keepAlive').checked = s.keepAlive;
  document.getElementById('s_drain').value = s.dnsDrainSeconds;
  document.getElementById('s_timeout').value = s.transitionTimeoutMinutes;
  document.getElementById('s_startRetry').value = s.startRetrySeconds;
  document.getElementById('s_dailyReport').checked = s.dailyReport;
  document.getElementById('s_dailyTime').value = s.dailyReportTime;
  document.getElementById('s_cfToken').value = CFG.cf.apiToken;
  document.getElementById('s_cfZone').value = CFG.cf.zoneId;
  document.getElementById('s_cfRecord').value = CFG.cf.recordId;
  document.getElementById('s_cfDomain').value = CFG.cf.domainName;
  document.getElementById('s_tgEnabled').checked = CFG.notify.tg.enabled;
  document.getElementById('s_tgToken').value = CFG.notify.tg.botToken;
  document.getElementById('s_tgChat').value = CFG.notify.tg.chatId;
  document.getElementById('s_adminPass').value = CFG.adminPass;
  document.getElementById('adminPassHint').textContent = CFG.adminPassFromSecret
    ? '已通过 ADMIN_PASS secret 设置，此处留空即可。'
    : '未使用 Secret，密码保存在 KV 中。建议改用 ADMIN_PASS secret。';
  renderAccountEditor();
}

function accountRow(a, i){
  const regions = ${JSON.stringify(REGIONS)}.map(function(r){
    return '<option value="' + r[0] + '"' + (a.regionId === r[0] ? ' selected' : '') + '>' + r[0] + ' · ' + r[1] + '</option>';
  }).join('');
  const sel = function(v){ return v === true ? ' selected' : ''; };
  return '<div class="rounded-2xl border border-zinc-200 p-3 space-y-2" data-idx="' + i + '">'
    + '<div class="flex justify-between items-center">'
    +   '<span class="text-[11px] font-bold text-zinc-700">实例 #' + (i+1) + '</span>'
    +   '<button onclick="removeAccount(' + i + ')" class="text-[10px] text-rose-600 font-bold">删除</button>'
    + '</div>'
    + '<div class="grid md:grid-cols-2 gap-2">'
    +   '<input data-f="name" value="' + esc(a.name) + '" placeholder="名称" class="bg-zinc-50 border border-zinc-200 rounded-lg px-2 py-1.5 text-[11px]">'
    +   '<input data-f="instanceId" value="' + esc(a.instanceId) + '" placeholder="ECS 实例 ID" class="bg-zinc-50 border border-zinc-200 rounded-lg px-2 py-1.5 text-[11px]">'
    +   '<input data-f="ak" value="' + esc(a.ak) + '" placeholder="AccessKey ID" class="bg-zinc-50 border border-zinc-200 rounded-lg px-2 py-1.5 text-[11px]">'
    +   '<input data-f="sk" value="' + esc(a.sk) + '" placeholder="AccessKey Secret" class="bg-zinc-50 border border-zinc-200 rounded-lg px-2 py-1.5 text-[11px]">'
    +   '<select data-f="regionId" class="bg-zinc-50 border border-zinc-200 rounded-lg px-2 py-1.5 text-[11px]">' + regions + '</select>'
    +   '<select data-f="siteType" class="bg-zinc-50 border border-zinc-200 rounded-lg px-2 py-1.5 text-[11px]">'
    +     '<option value="international"' + sel(a.siteType === 'international') + '>国际站 (business.ap-southeast-1)</option>'
    +     '<option value="china"' + sel(a.siteType === 'china') + '>中国站 (business.cn-hangzhou)</option>'
    +   '</select>'
    +   '<input data-f="eip" value="' + esc(a.eip) + '" placeholder="备用 EIP（可留空）" class="bg-zinc-50 border border-zinc-200 rounded-lg px-2 py-1.5 text-[11px]">'
    +   (a.liveEip ? '<p class="text-[10px] text-zinc-400 md:col-span-2">当前实例公网 IP：' + esc(a.liveEip) + '</p>' : '')
    +   '<input data-f="remark" value="' + esc(a.remark) + '" placeholder="备注" class="bg-zinc-50 border border-zinc-200 rounded-lg px-2 py-1.5 text-[11px]">'
    +   '<input data-f="trafficThresholdGb" value="' + esc(a.trafficThresholdGb ?? '') + '" placeholder="流量阈值覆盖（留空=跟随全局）" class="bg-zinc-50 border border-zinc-200 rounded-lg px-2 py-1.5 text-[11px]">'
    +   '<input data-f="billThreshold" value="' + esc(a.billThreshold ?? '') + '" placeholder="账单阈值覆盖（留空=跟随全局）" class="bg-zinc-50 border border-zinc-200 rounded-lg px-2 py-1.5 text-[11px]">'
    +   '<select data-f="keepAlive" class="bg-zinc-50 border border-zinc-200 rounded-lg px-2 py-1.5 text-[11px]">'
    +     '<option value=""' + (a.keepAlive == null ? ' selected' : '') + '>保活：跟随全局</option>'
    +     '<option value="true"' + sel(a.keepAlive === true) + '>保活：强制开启</option>'
    +     '<option value="false"' + sel(a.keepAlive === false) + '>保活：强制关闭</option>'
    +   '</select>'
    +   '<div class="flex items-center gap-2">'
    +     '<label class="flex items-center gap-1"><input type="checkbox" data-f="scheduleEnabled"' + (a.scheduleEnabled ? ' checked' : '') + ' class="w-3.5 h-3.5"><span class="text-[10px] text-zinc-600">限定运行时段</span></label>'
    +     '<input data-f="startTime" value="' + esc(a.startTime) + '" class="w-16 bg-zinc-50 border border-zinc-200 rounded-lg px-2 py-1.5 text-[11px]">'
    +     '<input data-f="stopTime" value="' + esc(a.stopTime) + '" class="w-16 bg-zinc-50 border border-zinc-200 rounded-lg px-2 py-1.5 text-[11px]">'
    +   '</div>'
    + '</div>'
    + '<input type="hidden" data-f="id" value="' + esc(a.id || '') + '">'
    + '</div>';
}

function renderAccountEditor(){
  document.getElementById('acctEditor').innerHTML = (CFG.accounts || []).map(accountRow).join('');
}

function addAccount(){
  syncAccountsFromDom();
  CFG.accounts.push({
    id: '', name: '实例 ' + ((CFG.accounts.length||0)+1), ak:'', sk:'', regionId:'ap-southeast-1',
    instanceId:'', eip:'', siteType:'international', trafficThresholdGb:null, billThreshold:null,
    keepAlive:null, scheduleEnabled:false, startTime:'00:00', stopTime:'23:59', remark:''
  });
  if (document.getElementById('settingsModal').classList.contains('hidden')) openSettings();
  renderAccountEditor();
}

function removeAccount(i){
  syncAccountsFromDom();
  CFG.accounts.splice(i, 1);
  renderAccountEditor();
}

function collectAccounts(){
  const rows = document.querySelectorAll('#acctEditor [data-idx]');
  const out = [];
  rows.forEach(function(row){
    const acc = {};
    row.querySelectorAll('[data-f]').forEach(function(el){
      const f = el.getAttribute('data-f');
      if (el.type === 'checkbox') acc[f] = el.checked;
      else acc[f] = el.value;
    });
    acc.trafficThresholdGb = acc.trafficThresholdGb === '' ? null : Number(acc.trafficThresholdGb);
    acc.billThreshold = acc.billThreshold === '' ? null : Number(acc.billThreshold);
    acc.keepAlive = acc.keepAlive === '' ? null : acc.keepAlive === 'true';
    acc.scheduleEnabled = !!acc.scheduleEnabled;
    out.push(acc);
  });
  return out;
}

async function saveSettings(){
  const v = function(id){ return document.getElementById(id).value; };
  const c = function(id){ return document.getElementById(id).checked; };
  const payload = {
    system: {
      trafficThresholdChina: Number(v('s_trafficChina')),
      trafficThresholdIntl: Number(v('s_trafficIntl')),
      billThreshold: Number(v('s_billThreshold')),
      rotationIntervalMinutes: Number(v('s_rotation')),
      billCheckMinutes: Number(v('s_billCheck')),
      keepAlive: c('s_keepAlive'),
      dnsDrainSeconds: Number(v('s_drain')),
      transitionTimeoutMinutes: Number(v('s_timeout')),
      startRetrySeconds: Number(v('s_startRetry')),
      dailyReport: c('s_dailyReport'),
      dailyReportTime: v('s_dailyTime'),
    },
    accounts: collectAccounts(),
    cf: { apiToken: v('s_cfToken'), zoneId: v('s_cfZone'), recordId: v('s_cfRecord'), domainName: v('s_cfDomain') },
    notify: { tg: { enabled: c('s_tgEnabled'), botToken: v('s_tgToken'), chatId: v('s_tgChat') } },
    adminPass: v('s_adminPass'),
  };
  try {
    await api('/api/config', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    closeSettings(); await refresh();
  } catch(e){ alert('保存失败: ' + e.message); }
}

(async function init(){
  try {
    const a = await api('/api/auth');
    if (a.authenticated) { showApp(); await refresh(); setInterval(refresh, 30000); }
    else showLogin();
  } catch(e){ showLogin(); }
})();
</script>
</body>
</html>`;
}

  export {
  getEngine, executeCron,
  runEngineCron, defaultState, defaultConfig, trafficClass, quotaForClass,
  resolveTrafficThreshold, resolveBillThreshold, resolveKeepAlive, inTimeRange,
  evaluateExhausted, validateConfig, bssEndpoint, maybeDailyReport,
  probeBilling, listEips, sanitizeConfig, reconcileAndClearFault, renderHtml,
};

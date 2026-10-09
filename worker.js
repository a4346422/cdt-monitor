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

function defaultGroup() {
  return {
    id: 'group-default',
    name: '默认分组',
    rotationIntervalMinutes: 0,
    primaryAccountId: '',
    cf: { enabled: false, apiToken: '', zoneId: '', recordId: '', domainName: '' },
  };
}

function normalizeGroup(g) {
  return {
    id: g?.id || 'group-default',
    name: g?.name || '默认分组',
    rotationIntervalMinutes: num(g?.rotationIntervalMinutes, 0),
    primaryAccountId: g?.primaryAccountId || '',
    cf: {
      enabled: !!g?.cf?.enabled,
      apiToken: g?.cf?.apiToken || '',
      zoneId: g?.cf?.zoneId || '',
      recordId: g?.cf?.recordId || '',
      domainName: g?.cf?.domainName || '',
    },
  };
}

function defaultConfig() {
  return {
    adminPass: '',
    system: {
      // 流量阈值按地域类别取默认值，单账号可覆盖
      trafficThresholdChina: Math.round(QUOTA_CHINA_GB * 0.9),
      trafficThresholdIntl: Math.round(QUOTA_INTL_GB * 0.94),
      billThreshold: 0,              // 0 = 关闭按账单轮换
      rotationIntervalMinutes: 0,    // 0 = 关闭定时轮换（保留为全局缺省）
      keepAlive: true,               // 保活全局默认，单账号可覆盖
      dnsDrainSeconds: 60,
      transitionTimeoutMinutes: 10,
      startRetrySeconds: 180,
      billCheckMinutes: 30,
      dailyReport: false,
      dailyReportTime: '23:58',
    },
    groups: [defaultGroup()],
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
    groups: {},            // groupId -> { dutyAccountId, dutySince, rotationIndex, transition, startAttempt, fusedMonth }
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

function normalizeHHMM(v, def = '00:00') {
  if (!v || typeof v !== 'string') return def;
  const parts = v.trim().split(':');
  const h = String(parts[0] != null && parts[0] !== '' ? parts[0] : '0').padStart(2, '0');
  const m = String(parts[1] != null && parts[1] !== '' ? parts[1] : '0').padStart(2, '0');
  return `${h}:${m}`;
}

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

async function getDnsRecord(cfCfg) {
  const cf = cfCfg?.cf || cfCfg || {};
  const { apiToken, zoneId, recordId } = cf;
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

async function putDnsRecord(cfCfg, ip) {
  const cf = cfCfg?.cf || cfCfg || {};
  const { apiToken, zoneId, recordId, domainName } = cf;
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
async function ensureDns(cfCfg, ip) {
  const before = await getDnsRecord(cfCfg);
  if (!before.ok) return { ok: false, message: `DNS 查询失败: ${before.message}` };
  if (before.content === ip) return { ok: true, message: `已指向 ${ip}`, changed: false };

  const put = await putDnsRecord(cfCfg, ip);
  if (!put.ok) return { ok: false, message: `DNS 更新失败: ${put.message}` };

  const after = await getDnsRecord(cfCfg);
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

  let groups = Array.isArray(raw.groups) ? raw.groups.map(normalizeGroup) : null;
  if (!groups || groups.length === 0) {
    const legacyCf = raw.cf || base.cf;
    const hasLegacyCf = !!(legacyCf?.apiToken || legacyCf?.zoneId || legacyCf?.domainName);
    const rotationInterval = num(raw.system?.rotationIntervalMinutes, 0);
    groups = [{
      id: 'group-default',
      name: '默认分组',
      rotationIntervalMinutes: rotationInterval,
      primaryAccountId: '',
      cf: {
        enabled: hasLegacyCf || rotationInterval > 0,
        apiToken: legacyCf?.apiToken || '',
        zoneId: legacyCf?.zoneId || '',
        recordId: legacyCf?.recordId || '',
        domainName: legacyCf?.domainName || '',
      },
    }];
  }

  const defaultGid = groups[0].id;
  const validGids = new Set(groups.map((g) => g.id));
  const accounts = Array.isArray(raw.accounts)
    ? raw.accounts.map((a) => normalizeAccount(a, defaultGid, validGids))
    : [];

  return {
    ...base,
    ...raw,
    system: { ...base.system, ...(raw.system || {}) },
    groups,
    cf: { ...base.cf, ...(raw.cf || {}) },
    notify: { tg: { ...base.notify.tg, ...(raw.notify?.tg || {}) } },
    accounts,
  };
}

function normalizeAccount(a, defaultGid = 'group-default', validGids = null) {
  const rawGid = a.groupId || defaultGid;
  const groupId = (validGids && !validGids.has(rawGid)) ? defaultGid : rawGid;
  return {
    id: a.id || crypto.randomUUID(),
    groupId,
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
    startTime: normalizeHHMM(a.startTime, '00:00'),
    stopTime: normalizeHHMM(a.stopTime, '23:59'),
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
  const s = normalizeHHMM(start, '00:00');
  const e = normalizeHHMM(stop, '23:59');
  if (s === e) return true;
  const cur = normalizeHHMM(hhmm, '00:00');
  return s < e
    ? (cur >= s && cur < e)
    : (cur >= s || cur < e);   // 跨午夜
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

function findGroup(cfg, groupId) {
  return (cfg.groups || []).find((g) => g.id === groupId) || null;
}

function isGroupDdnsOrRotation(group) {
  if (!group) return false;
  const hasDdns = !!(group.cf && group.cf.enabled && group.cf.domainName && group.cf.apiToken);
  const rotationMinutes = num(group.rotationIntervalMinutes, 0);
  return hasDdns || rotationMinutes > 0;
}

// 统一检查并刷新/过期 manualOverride 标记（若跨越时段分界点或超24小时则自动清空）
function refreshManualOverride(st, acc, now) {
  if (!st || !st.manualOverride) return null;
  const mo = st.manualOverride;
  const isInside = inTimeRange(now.hhmm, acc.startTime, acc.stopTime);
  const sameWindowPhase = (mo.inWindow === isInside);
  const expired24h = mo.at && (Date.now() - mo.at > 24 * 3600 * 1000);
  if (sameWindowPhase && !expired24h) {
    return mo;
  }
  delete st.manualOverride;
  return null;
}

// 获取或初始化某个分组在 state 中的独立调度状态
function getGroupSchedule(state, groupId) {
  if (!state.groups) state.groups = {};
  if (!state.groups[groupId]) {
    state.groups[groupId] = {
      dutyAccountId: null,
      dutySince: 0,
      rotationIndex: 0,
      transition: null,
      startAttempt: null,
      fusedMonth: null,
    };
  }
  return state.groups[groupId];
}

// 兼容单组/旧版逻辑，同步全局状态视图（以默认组或首个配置组为准）
function syncLegacyStateView(state, cfg) {
  const primaryGid = cfg.groups?.[0]?.id || 'group-default';
  const gSched = getGroupSchedule(state, primaryGid);
  state.dutyAccountId = gSched.dutyAccountId;
  state.dutySince = gSched.dutySince;
  state.rotationIndex = gSched.rotationIndex;
  // 保持全局 transition 与任意正在换班的组同步，避免被无换班的主组清空
  const anyTr = Object.values(state.groups || {}).find((g) => g?.transition)?.transition || gSched.transition || null;
  state.transition = anyTr;
  state.startAttempt = gSched.startAttempt;
  state.fusedMonth = gSched.fusedMonth;
}

// 按 round-robin 顺序取下一个候选（支持组内或全局）
function pickNextDuty(cfg, state, excludeId, targetAccounts = null, rotationIndex = 0, now = bjNow()) {
  const pool = targetAccounts || cfg.accounts;
  const n = pool.length;
  if (n <= 1) return null;
  for (let i = 1; i <= n; i++) {
    const idx = (rotationIndex + i) % n;
    const acc = pool[idx];
    if (acc.id === excludeId) continue;
    const st = state.accounts[acc.id] || {};
    if (st.exhausted) continue;
    const mo = refreshManualOverride(st, acc, now);
    if (mo?.action === 'stop') continue;
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

async function syncScheduledInstance(env, cfg, state, engine, acc, now) {
  const st = state.accounts[acc.id] || {};
  const isInside = inTimeRange(now.hhmm, acc.startTime, acc.stopTime);

  // 检查 manualOverride 边缘触发判定
  const mo = refreshManualOverride(st, acc, now);
  if (mo) {
    // 仍处于当时手动操作的相同时段区间内，保持人工操作状态，不逆转
    return;
  }

  if (!isInside) {
    if (st.ecsStatus === 'Running') {
      const stopRes = await stopAndConfirm(acc);
      st.ecsStatus = stopRes.ok ? 'Stopped' : st.ecsStatus;
      st.ecsStoppedMode = stopRes.ok ? 'StopCharging' : st.ecsStoppedMode;
      await engine.saveState(state);
      await appendLogSafe(env, 'AUDIT', '定时休眠停机', `${acc.name}（不在运行时段 ${acc.startTime}~${acc.stopTime}）: ${stopRes.detail}`);
      await sendTelegram(env, cfg, '🌙 【实例定时休眠停机】', [
        ['账号', acc.name],
        ['实例', acc.instanceId],
        ['设定时段', `${acc.startTime} ~ ${acc.stopTime}`],
        ['停机状态', stopRes.detail],
      ], '当前时间不在设定运行时段内，已执行节省停机。');
    }
    return;
  }

  // 处于运行时段内：若处于关机且未耗尽，自动恢复开机
  if (st.ecsStatus === 'Stopped') {
    if (st.exhausted) return;
    const started = await startEcs(acc);
    if (started.ok) {
      st.ecsStatus = 'Running';
      await engine.saveState(state);
      await appendLogSafe(env, 'AUDIT', '定时恢复开机', `${acc.name}（已进入运行时段 ${acc.startTime}~${acc.stopTime}）`);
      await sendTelegram(env, cfg, '☀️ 【实例定时恢复开机】', [
        ['账号', acc.name],
        ['实例', acc.instanceId],
        ['设定时段', `${acc.startTime} ~ ${acc.stopTime}`],
      ], '已进入设定运行时段，已自动启动实例。');
    } else {
      await appendLogSafe(env, 'ERROR', `定时恢复开机失败 [${acc.name}]`, started.error || '未知错误');
    }
  }
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
  let activeTr = state.transition;
  if (!activeTr && state.groups) {
    for (const gid of Object.keys(state.groups)) {
      if (state.groups[gid]?.transition) {
        activeTr = state.groups[gid].transition;
        state.transition = activeTr;
        break;
      }
    }
  }
  if (activeTr) return advanceTransition(env, cfg, state, engine, now);

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

  // ---- 按分组独立调度：未配置 DDNS / 轮换的分组（如默认组）实例保持不变，已配置的组组内轮换
  const groups = (cfg.groups && cfg.groups.length > 0) ? cfg.groups : [defaultGroup()];
  let cronResult = { ok: true };

  for (const group of groups) {
    const groupAccounts = cfg.accounts.filter((a) => (a.groupId || 'group-default') === group.id);
    if (!groupAccounts.length) continue;

    const gSched = getGroupSchedule(state, group.id);
    const hasDdns = !!(group.cf && group.cf.enabled && group.cf.domainName && group.cf.apiToken);
    const rotationMinutes = num(group.rotationIntervalMinutes, 0);

    // 默认组或未配置 DDNS & 轮换的分组：组内实例保持自身开关状态，不选当班，不操作 DNS
    if (!hasDdns && rotationMinutes <= 0) {
      gSched.dutyAccountId = null;
      gSched.dutySince = 0;
      gSched.transition = null;
      gSched.startAttempt = null;
      for (const acc of groupAccounts) {
        if (!acc.scheduleEnabled || !isConfigured(acc)) continue;
        await syncScheduledInstance(env, cfg, state, engine, acc, now);
      }
      continue;
    }

    // 若本组已在换班中，优先推进换班
    if (gSched.transition) {
      state.transition = gSched.transition;
      return advanceTransition(env, cfg, state, engine, now);
    }

    // 若未开启定时轮换，优先检查是否应由用户指定的主实例（未耗尽）当班
    if (rotationMinutes <= 0 && group.primaryAccountId) {
      const preferred = groupAccounts.find((a) => {
        if (a.id !== group.primaryAccountId) return false;
        const st = state.accounts[a.id] || {};
        if (st.exhausted) return false;
        const mo = refreshManualOverride(st, a, now);
        return mo?.action !== 'stop';
      });
      // 如果当前当班机处于用户手动启动接管状态，且主实例未被显式启动，则不强行抢占当班
      const curDutySt = gSched.dutyAccountId ? (state.accounts[gSched.dutyAccountId] || {}) : null;
      const curDutyAcc = groupAccounts.find((x) => x.id === gSched.dutyAccountId);
      const curDutyMo = (curDutySt && curDutyAcc) ? refreshManualOverride(curDutySt, curDutyAcc, now) : null;
      const curDutyIsManualStart = curDutyMo?.action === 'start';

      if (preferred && gSched.dutyAccountId !== preferred.id && !curDutyIsManualStart) {
        gSched.dutyAccountId = preferred.id;
        gSched.dutySince = Date.now();
        gSched.rotationIndex = groupAccounts.findIndex((a) => a.id === preferred.id);
        if (group.id === groups[0].id) {
          state.dutyAccountId = preferred.id;
          state.dutySince = gSched.dutySince;
          state.rotationIndex = gSched.rotationIndex;
        }
        await appendLogSafe(env, 'AUDIT', `[${group.name}] 切换主解析实例`, preferred.name);
      }
    } else {
      // 若外部或测试直接修改了全局 state.dutyAccountId / state.dutySince，同步进主分组
      if (group.id === groups[0].id && state.dutyAccountId && state.dutyAccountId !== gSched.dutyAccountId) {
        gSched.dutyAccountId = state.dutyAccountId;
        gSched.dutySince = state.dutySince || gSched.dutySince;
        gSched.rotationIndex = (state.rotationIndex !== undefined) ? state.rotationIndex : gSched.rotationIndex;
      } else if (group.id === groups[0].id && state.dutySince && state.dutySince !== gSched.dutySince) {
        gSched.dutySince = state.dutySince;
      }
    }

    let duty = groupAccounts.find((a) => a.id === gSched.dutyAccountId);
    if (!duty) {
      // 优先看是否配置了主实例（且未耗尽且未被手动关机），否则取第 1 个符合条件的实例
      const isEligible = (a) => {
        const st = state.accounts[a.id] || {};
        if (st.exhausted) return false;
        const mo = refreshManualOverride(st, a, now);
        return mo?.action !== 'stop';
      };
      const preferred = group.primaryAccountId
        ? groupAccounts.find((a) => a.id === group.primaryAccountId && isEligible(a))
        : null;
      const first = preferred || groupAccounts.find(isEligible);
      if (!first) {
        const allExhausted = groupAccounts.every((a) => state.accounts[a.id]?.exhausted);
        if (allExhausted && gSched.fusedMonth !== state.month) {
          gSched.fusedMonth = state.month;
          await engine.saveState(state);
          await appendLogSafe(env, 'AUDIT', `🔴 [${group.name}] 全部实例额度耗尽`, `本月组内不再自动开机（${state.month}）`);
          await sendTelegram(env, cfg, `🔴 【${group.name} 全部额度耗尽】`, [
            ['计费月', state.month],
            ['分组', group.name],
            ['实例数', String(groupAccounts.length)],
            ['状态', '组内所有实例额度已用完'],
          ], '该分组调度已停止，新计费月自动恢复。');
        }
        continue;
      }
      duty = first;
      gSched.dutyAccountId = first.id;
      gSched.dutySince = Date.now();
      gSched.rotationIndex = groupAccounts.findIndex((a) => a.id === first.id);
      await engine.saveState(state);
      await appendLogSafe(env, 'AUDIT', `[${group.name}] 设定当班实例`, first.name);
    }

    const dutyState = state.accounts[duty.id];
    const rotationMs = rotationMinutes * 60000;
    const rotationDue = rotationMs > 0 && num(gSched.dutySince, 0) > 0 && (Date.now() - gSched.dutySince) >= rotationMs;
    const needRotation = dutyState?.exhausted || rotationDue;

    if (needRotation) {
      const reason = dutyState?.exhausted ? `额度耗尽（${dutyState.reason}）` : '定时轮换到期';
      const next = pickNextDuty(cfg, state, duty.id, groupAccounts, gSched.rotationIndex, now);
      if (!next) {
        const fRes = await fuseAndStopDuty(env, cfg, state, engine, duty, reason, group);
        syncLegacyStateView(state, cfg);
        return fRes;
      }
      const tRes = await beginTransition(env, cfg, state, engine, next.acc, duty, 'SHIFT', reason, group);
      syncLegacyStateView(state, cfg);
      return tRes;
    }

    // 保活：对配置了轮换/DDNS 分组的当班实例执行保活
    const kRes = await keepAliveDuty(env, cfg, state, engine, duty, dutyState, now, group);
    if (kRes && (kRes.halted || kRes.waiting)) {
      syncLegacyStateView(state, cfg);
      return kRes;
    }

    // 若配置了 DDNS 但未开启定时轮换（rotationMinutes = 0），自动对齐一次 DNS 解析到当前当班实例
    if (hasDdns && rotationMinutes <= 0 && duty) {
      const ecsDesc = state.accounts[duty.id];
      const liveIp = ecsDesc?.ecsEip || duty.eip;
      if (liveIp && gSched.lastSyncedDnsIp !== liveIp) {
        const dnsRes = await ensureDns(group.cf, liveIp);
        if (dnsRes.ok) {
          gSched.lastSyncedDnsIp = liveIp;
          await engine.saveState(state);
          if (dnsRes.changed) {
            await appendLogSafe(env, 'AUDIT', `[${group.name}] DDNS 解析对齐`, `${group.cf.domainName} -> ${liveIp}`);
          }
        }
      }
    }
  }

  syncLegacyStateView(state, cfg);
  await engine.saveState(state);
  return cronResult;
}

// ---------------------------------------------------------------- 保活

async function keepAliveDuty(env, cfg, state, engine, duty, dutyState, now, group = null) {
  const gSched = group ? getGroupSchedule(state, group.id) : state;
  if (!isConfigured(duty)) {
    return setFault(env, engine, state, 'ACCOUNT_NOT_CONFIGURED', `${duty.name} 缺少 AK/SK/地域/实例 ID`);
  }

  const desc = await describeEcs(duty);
  if (!desc.ok) {
    if (desc.status === 'NotFound') {
      return setFault(env, engine, state, 'INSTANCE_NOT_FOUND', `${duty.name}: 实例 ${duty.instanceId} 不存在或已被释放`, null, { accountId: duty.id });
    }
    return setFault(env, engine, state, 'ECS_DESCRIBE_FAILED', `${duty.name}: ${desc.error}`);
  }

  const isInside = inTimeRange(now.hhmm, duty.startTime, duty.stopTime);
  const st = state.accounts[duty.id] || {};

  // 检查 manualOverride 边缘触发判定
  const mo = refreshManualOverride(st, duty, now);
  if (mo) {
    if (mo.action === 'stop' && desc.status === 'Stopped') {
      return { ok: true, duty: duty.id, status: 'Stopped', manualStopped: true };
    }
    if (mo.action === 'start' && desc.status === 'Running') {
      return { ok: true, duty: duty.id, status: 'Running', manualStarted: true };
    }
  }

  // 保活开关 + 允许运行时段
  if (duty.scheduleEnabled && !inTimeRange(now.hhmm, duty.startTime, duty.stopTime)) {
    if (desc.status === 'Running') {
      const stopRes = await stopAndConfirm(duty);
      gSched.startAttempt = null;
      await engine.saveState(state);
      await appendLogSafe(env, 'AUDIT', '定时休眠停机', `${duty.name}（不在运行时段 ${duty.startTime}~${duty.stopTime}）: ${stopRes.detail}`);
      await sendTelegram(env, cfg, '🌙 【实例定时休眠停机】', [
        ['账号', duty.name],
        ['实例', duty.instanceId],
        ['设定时段', `${duty.startTime} ~ ${duty.stopTime}`],
        ['停机状态', stopRes.detail],
      ], '当前时间不在设定运行时段内，已执行节省停机。');
      return { ok: true, duty: duty.id, status: 'Stopped', outsideWindow: true, stoppedForSchedule: true };
    }
    await engine.saveState(state);
    return { ok: true, duty: duty.id, status: desc.status, outsideWindow: true };
  }

  if (desc.status === 'Running') {
    gSched.startAttempt = null;
    state.keepAliveAt = now.iso;
    await engine.saveState(state);
    return { ok: true, duty: duty.id, status: 'Running', trafficGb: dutyState?.trafficGb };
  }

  if (!resolveKeepAlive(duty, cfg)) {
    await engine.saveState(state);
    return { ok: true, duty: duty.id, status: desc.status, keepAlive: false };
  }

  // 启动，带重试窗口
  if (!gSched.startAttempt || gSched.startAttempt.targetId !== duty.id) {
    gSched.startAttempt = { targetId: duty.id, since: Date.now(), attempts: 0, overLimitStopped: false };
  }
  const attempt = gSched.startAttempt;
  attempt.attempts += 1;

  const started = await startEcs(duty);
  if (started.ok) {
    gSched.startAttempt = null;
    state.keepAliveAt = now.iso;
    await engine.saveState(state);
    await appendLogSafe(env, 'AUDIT', '保活启动', `${duty.name}（原状态 ${desc.status}）`);
    await sendTelegram(env, cfg, '🔄 【实例保活启动】', [
      ['账号', duty.name],
      ['实例', duty.instanceId],
      ['原状态', desc.status],
      ['流量', `${dutyState?.trafficGb ?? '-'} GB`],
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

async function fuseAndStopDuty(env, cfg, state, engine, duty, reason, group = null) {
  const gSched = group ? getGroupSchedule(state, group.id) : state;
  const desc = await describeEcs(duty);
  let detail = desc.ok ? `${desc.status}/${desc.stoppedMode}` : (desc.error || '状态未知');
  let confirmed = isStopChargingConfirmed(desc);

  if (!confirmed && desc.ok && desc.status !== 'Stopped') {
    const res = await stopAndConfirm(duty);
    confirmed = res.ok;
    detail = res.detail;
  }

  gSched.dutyAccountId = null;
  gSched.dutySince = 0;
  gSched.fusedMonth = state.month;
  gSched.transition = null;
  gSched.startAttempt = null;
  await engine.saveState(state);

  const groupLabel = group ? `[${group.name}] ` : '';
  await appendLogSafe(env, confirmed ? 'AUDIT' : 'ERROR', `🔴 ${groupLabel}全部额度耗尽`, `${duty.name} 停机: ${detail}；触发原因: ${reason}`);
  await sendTelegram(env, cfg, `🔴 【${groupLabel}全部额度耗尽 · 已停机】`, [
    ['计费月', state.month],
    ['当班账号', duty.name],
    ['触发原因', reason],
    ['停机确认', confirmed ? detail : `未确认（${detail}）`],
    ['账号数', String(cfg.accounts.length)],
  ], confirmed
    ? '本月额度均已耗尽，当班实例已进入节省停机，新计费月自动恢复。'
    : '额度耗尽，但当班实例停机未确认，请人工检查。');

  if (!confirmed) {
    return setFault(env, engine, state, 'FUSE_STOP_CHARGING_NOT_CONFIRMED', `${duty.name}: ${detail}`);
  }
  return { fused: true, reason: 'all_accounts_exhausted', stopped: duty.id, month: state.month };
}

// ---------------------------------------------------------------- 换班

async function beginTransition(env, cfg, state, engine, target, off, type, reason, group = null) {
  const gSched = group ? getGroupSchedule(state, group.id) : state;
  const targetState = await describeEcs(target);
  if (!targetState.ok) {
    if (targetState.status === 'NotFound') {
      return setFault(env, engine, state, 'INSTANCE_NOT_FOUND', `${target.name}: 实例 ${target.instanceId} 不存在或已被释放`, null, { accountId: target.id });
    }
    return setFault(env, engine, state, 'ECS_DESCRIBE_FAILED', `${target.name}: ${targetState.error}`);
  }

  const groupId = group ? group.id : (target.groupId || 'group-default');

  if (targetState.status === 'Running') {
    const tr = {
      groupId,
      targetId: target.id, offId: off.id, type, reason,
      startTime: Date.now(), step: 'WAIT_DNS_DRAIN',
      dnsOk: false, dnsMsg: '待同步', dnsVerified: false, drainUntil: null,
    };
    gSched.transition = tr;
    state.transition = tr;
    await engine.saveState(state);
    return advanceTransition(env, cfg, state, engine, bjNow());
  }

  if (!gSched.startAttempt || gSched.startAttempt.targetId !== target.id) {
    gSched.startAttempt = { targetId: target.id, since: Date.now(), attempts: 0 };
  }
  const attempt = gSched.startAttempt;
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
      gSched.startAttempt = null;
      gSched.dutyAccountId = null;
      gSched.dutySince = 0;
      gSched.fusedMonth = state.month;
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

  gSched.startAttempt = null;
  const tr = {
    groupId,
    targetId: target.id, offId: off.id, type, reason,
    startTime: Date.now(), step: 'WAIT_START',
    dnsOk: false, dnsMsg: '待同步', dnsVerified: false, drainUntil: null,
  };
  gSched.transition = tr;
  state.transition = tr;
  await engine.saveState(state);
  await appendLogSafe(env, 'AUDIT', '开始换班', `${off.name} -> ${target.name}（${reason}）`);
  return { transition: tr };
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

    const grp = findGroup(cfg, tr.groupId || target.groupId);
    const dnsCfg = (grp && grp.cf && grp.cf.enabled) ? grp.cf : cfg.cf;

    const dns = await ensureDns(dnsCfg, ip);
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
  const grpId = tr.groupId || target.groupId || 'group-default';
  const grp = findGroup(cfg, grpId);
  const grpAccounts = cfg.accounts.filter((a) => (a.groupId || 'group-default') === grpId);

  const gSched = getGroupSchedule(state, grpId);
  gSched.dutyAccountId = target.id;
  gSched.dutySince = Date.now();
  gSched.rotationIndex = grpAccounts.findIndex((a) => a.id === target.id);
  gSched.transition = null;
  gSched.startAttempt = null;
  state.transition = null;

  syncLegacyStateView(state, cfg);
  await engine.saveState(state);

  const t = state.accounts[target.id] || {};
  const o = state.accounts[off.id] || {};
  const groupLabel = grp ? `[${grp.name}] ` : '';
  await appendLogSafe(env, 'AUDIT', `${groupLabel}换班完成`, `${off.name} -> ${target.name}`);

  const titles = { SHIFT: '✅ 【换班完成报告】', TEMPORARY: '✅ 【临时换班完成报告】', RECOVERY: '✅ 【当班恢复报告】' };
  await sendTelegram(env, cfg, (groupLabel ? `✅ 【${grp.name} 换班完成】` : (titles[tr.type] || titles.SHIFT)), [
    ['所属分组', grp ? grp.name : '默认分组'],
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
    async mutate(fn) {
      const state = await this.loadState();
      const next = (await fn(state)) || state;
      await this.saveState(next);
      return next;
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

        const grpId = tr.groupId || target.groupId || 'group-default';
        const grpAccounts = cfg.accounts.filter((a) => (a.groupId || 'group-default') === grpId);
        const gSched = getGroupSchedule(state, grpId);
        gSched.dutyAccountId = target.id;
        gSched.dutySince = Date.now();
        gSched.rotationIndex = grpAccounts.findIndex((x) => x.id === target.id);
        gSched.transition = null;
        gSched.startAttempt = null;

        notes.push(`换班实际已完成，已确认 ${target.name} 为当班账号`);
      } else {
        notes.push('换班未完成，保留进度，下一次巡检将从真实状态继续');
      }
    } else {
      state.transition = null;
      if (tr.groupId && state.groups?.[tr.groupId]) {
        state.groups[tr.groupId].transition = null;
      }
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
        const gSched = getGroupSchedule(state, a.groupId || 'group-default');
        const isDuty = gSched.dutyAccountId === a.id || state.dutyAccountId === a.id;
        return {
          id: a.id,
          groupId: a.groupId || 'group-default',
          name: a.name, regionId: a.regionId, instanceId: a.instanceId,
          siteType: a.siteType, remark: a.remark, eip: a.eip || '',
          trafficClass: trafficClass(a.regionId),
          threshold: resolveTrafficThreshold(a, cfg),
          quota: quotaForClass(trafficClass(a.regionId)),
          billThreshold: resolveBillThreshold(a, cfg),
          keepAlive: resolveKeepAlive(a, cfg),
          duty: isDuty,
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
          scheduleEnabled: !!a.scheduleEnabled,
          startTime: normalizeHHMM(a.startTime, '00:00'),
          stopTime: normalizeHHMM(a.stopTime, '23:59'),
          manualOverride: st.manualOverride || null,
        };
      });
      return json({
        ok: true,
        month: state.month,
        dutyAccountId: state.dutyAccountId,
        dutySince: state.dutySince,
        groups: state.groups || {},
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
        case 'start_instance': {
          const cfg = await getConfig(env);
          const acc = cfg.accounts.find((a) => a.id === body.accountId);
          if (!acc) return json({ error: '实例不存在' }, 404);
          if (!isConfigured(acc)) return json({ error: '实例配置不完整（缺 AK/SK/地域/实例 ID）' }, 400);

          const group = findGroup(cfg, acc.groupId || 'group-default');
          const isDdnsGroup = isGroupDdnsOrRotation(group);
          const state = await engine.loadState();
          const now = bjNow();
          const inWindow = inTimeRange(now.hhmm, acc.startTime, acc.stopTime);

          if (isDdnsGroup && group) {
            const gSched = getGroupSchedule(state, group.id);
            const currentDutyId = gSched.dutyAccountId;
            if (currentDutyId && currentDutyId !== acc.id) {
              const off = findAccount(cfg, currentDutyId);
              if (off) {
                await appendLogSafe(env, 'AUDIT', `[${group.name}] 手动启动切班`, `${acc.name} 接替 ${off.name}`);
                state.accounts = state.accounts || {};
                state.accounts[acc.id] = {
                  ...(state.accounts[acc.id] || {}),
                  manualOverride: { action: 'start', inWindow, at: Date.now(), date: now.ymd },
                };
                const tRes = await beginTransition(env, cfg, state, engine, acc, off, 'SHIFT', '用户手动启动切换当班', group);
                syncLegacyStateView(state, cfg);
                return json({ ok: true, transition: true, message: `已触发换班切机（${acc.name} 接替 ${off.name}）`, detail: tRes });
              }
            }
          }

          const started = await startEcs(acc);
          if (!started.ok) return json({ error: started.error || '启动失败' }, 500);
          await appendLogSafe(env, 'AUDIT', '手动启动实例', `${acc.name} (${acc.instanceId})`);

          // 尝试同步一次 ECS 状态
          const desc = await describeEcs(acc);
          await engine.mutate((st) => {
            st.accounts = st.accounts || {};
            const a = st.accounts[acc.id] || {};
            st.accounts[acc.id] = {
              ...a,
              ecsStatus: desc.ok ? desc.status : a.ecsStatus,
              ecsStoppedMode: desc.ok ? desc.stoppedMode : a.ecsStoppedMode,
              ecsEip: (desc.ok && desc.eip) ? desc.eip : a.ecsEip,
              ecsError: null,
              manualOverride: { action: 'start', inWindow, at: Date.now(), date: now.ymd },
            };
            if (isDdnsGroup && group) {
              const gSched = getGroupSchedule(st, group.id);
              if (!gSched.dutyAccountId) {
                gSched.dutyAccountId = acc.id;
                gSched.dutySince = Date.now();
                const grpAccs = cfg.accounts.filter((x) => (x.groupId || 'group-default') === group.id);
                gSched.rotationIndex = grpAccs.findIndex((x) => x.id === acc.id);
              }
            }
            return st;
          });
          return json({ ok: true, message: `已成功启动实例【${acc.name}】` });
        }
        case 'stop_instance': {
          const cfg = await getConfig(env);
          const acc = cfg.accounts.find((a) => a.id === body.accountId);
          if (!acc) return json({ error: '实例不存在' }, 404);
          if (!isConfigured(acc)) return json({ error: '实例配置不完整（缺 AK/SK/地域/实例 ID）' }, 400);

          const group = findGroup(cfg, acc.groupId || 'group-default');
          const isDdnsGroup = isGroupDdnsOrRotation(group);
          const state = await engine.loadState();
          const now = bjNow();
          const inWindow = inTimeRange(now.hhmm, acc.startTime, acc.stopTime);

          if (isDdnsGroup && group) {
            const gSched = getGroupSchedule(state, group.id);
            if (gSched.dutyAccountId === acc.id) {
              const groupAccounts = cfg.accounts.filter((a) => (a.groupId || 'group-default') === group.id);
              const next = pickNextDuty(cfg, state, acc.id, groupAccounts, gSched.rotationIndex, now);
              if (next) {
                await appendLogSafe(env, 'AUDIT', `[${group.name}] 手动停机切班`, `${acc.name} -> ${next.acc.name}`);
                state.accounts = state.accounts || {};
                state.accounts[acc.id] = {
                  ...(state.accounts[acc.id] || {}),
                  manualOverride: { action: 'stop', inWindow, at: Date.now(), date: now.ymd },
                };
                const tRes = await beginTransition(env, cfg, state, engine, next.acc, acc, 'SHIFT', '用户手动停机切班', group);
                syncLegacyStateView(state, cfg);
                return json({ ok: true, transition: true, message: `已触发换班切机（${next.acc.name} 接替 ${acc.name}）`, detail: tRes });
              }

              // 无备用机可用：直接停机，清空当班标记，避免保活重新拉起
              const stopped = await stopEcs(acc);
              if (!stopped.ok) return json({ error: stopped.error || '停机失败' }, 500);
              await appendLogSafe(env, 'AUDIT', `[${group.name}] 手动停机（无可用备机）`, `${acc.name} (${acc.instanceId})`);
              const desc = await describeEcs(acc);
              const gSchedSt = getGroupSchedule(state, group.id);
              gSchedSt.dutyAccountId = null;
              gSchedSt.dutySince = 0;
              state.accounts = state.accounts || {};
              const a = state.accounts[acc.id] || {};
              state.accounts[acc.id] = {
                ...a,
                ecsStatus: desc.ok ? desc.status : 'Stopped',
                ecsStoppedMode: desc.ok ? desc.stoppedMode : a.ecsStoppedMode,
                ecsEip: (desc.ok && desc.eip) ? desc.eip : a.ecsEip,
                ecsError: null,
                manualOverride: { action: 'stop', inWindow, at: Date.now(), date: now.ymd },
              };
              syncLegacyStateView(state, cfg);
              await engine.saveState(state);
              return json({ ok: true, message: `已停机【${acc.name}】，组内无可用备机已下线` });
            }
          }

          const stopped = await stopEcs(acc);
          if (!stopped.ok) return json({ error: stopped.error || '停机失败' }, 500);
          await appendLogSafe(env, 'AUDIT', '手动节省停机', `${acc.name} (${acc.instanceId})`);
          // 尝试同步一次 ECS 状态
          const desc = await describeEcs(acc);
          await engine.mutate((st) => {
            st.accounts = st.accounts || {};
            const a = st.accounts[acc.id] || {};
            st.accounts[acc.id] = {
              ...a,
              ecsStatus: desc.ok ? desc.status : a.ecsStatus,
              ecsStoppedMode: desc.ok ? desc.stoppedMode : a.ecsStoppedMode,
              ecsEip: (desc.ok && desc.eip) ? desc.eip : a.ecsEip,
              ecsError: null,
              manualOverride: { action: 'stop', inWindow, at: Date.now(), date: now.ymd },
            };
            return st;
          });
          return json({ ok: true, message: `已成功停机【${acc.name}】` });
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
  const groups = (cfg.groups || []).map((g) => ({
    ...g,
    cf: { ...g.cf, apiToken: mask(g.cf?.apiToken) },
  }));
  return {
    ...cfg,
    adminPass: adminPassword(env, cfg) ? '******' : '',
    hasAdminPass: !!adminPassword(env, cfg),
    adminPassFromSecret: !!env.ADMIN_PASS,
    groups,
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
  // 面板不会回传所有字段，缺失的必须沿用已有配置
  const sys = { ...base.system, ...(prev.system || {}), ...(body.system || {}) };

  // 分组处理
  let groups = prev.groups || [defaultGroup()];
  if (Array.isArray(body.groups) && body.groups.length > 0) {
    groups = body.groups.map((bg) => {
      const existing = (prev.groups || []).find((g) => g.id === bg.id);
      return {
        id: bg.id || crypto.randomUUID(),
        name: bg.name || '未命名分组',
        rotationIntervalMinutes: num(bg.rotationIntervalMinutes, 0),
        primaryAccountId: bg.primaryAccountId ?? existing?.primaryAccountId ?? '',
        cf: {
          enabled: !!bg.cf?.enabled,
          apiToken: keepIfMasked(bg.cf?.apiToken, existing?.cf?.apiToken || ''),
          zoneId: bg.cf?.zoneId ?? existing?.cf?.zoneId ?? '',
          recordId: bg.cf?.recordId ?? existing?.cf?.recordId ?? '',
          domainName: bg.cf?.domainName ?? existing?.cf?.domainName ?? '',
        },
      };
    });
  }

  const defaultGid = groups[0]?.id || 'group-default';
  const validGids = new Set(groups.map((g) => g.id));

  const prevAccounts = Array.isArray(prev?.accounts) ? prev.accounts : [];
  const accounts = Array.isArray(body.accounts) ? body.accounts.map((raw) => {
    const existing = prevAccounts.find((a) => a.id === raw.id);
    return normalizeAccount({
      ...raw,
      id: raw.id || crypto.randomUUID(),
      groupId: raw.groupId || existing?.groupId || defaultGid,
      ak: keepIfMasked(raw.ak, existing?.ak || ''),
      sk: keepIfMasked(raw.sk, existing?.sk || ''),
    }, defaultGid, validGids);
  }) : prevAccounts;

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
    groups,
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
  body { background:#e5e7eb; color:#18181b; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  .inst-card {
    background: #ffffff;
    border: 1.5px solid #cbd5e1;
    box-shadow: 0 1px 3px rgba(0,0,0,0.06);
    cursor: default;
    transition: background-color 0.12s ease, border-color 0.12s ease, box-shadow 0.12s ease;
  }
  .inst-card:hover {
    background: #f8fafc !important;
    border-color: #64748b !important;
    box-shadow: 0 6px 16px -2px rgba(15, 23, 42, 0.12), 0 2px 4px -1px rgba(15, 23, 42, 0.06) !important;
  }
  .card-static {
    background: #ffffff;
    border: 1px solid #cbd5e1;
    box-shadow: 0 1px 3px rgba(0,0,0,0.04);
  }
  .drag-handle { cursor: grab; }
  .drag-handle:active { cursor: grabbing; }
  .hidden { display:none !important; }
  .drag-over {
    border-color: #4f46e5 !important;
    background-color: #e0e7ff !important;
    box-shadow: inset 0 0 0 2px #4f46e5 !important;
  }
  .dragging {
    opacity: 0.65;
    border-color: #4f46e5 !important;
    background: #eef2ff !important;
  }
</style>
</head>
<body class="p-4 md:p-8 min-h-screen">
<datalist id="regionList">${regionOptions}</datalist>

<div id="loginView" class="hidden max-w-sm mx-auto mt-24">
  <div class="card-static rounded-3xl p-8 space-y-4">
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
      <button onclick="addAccount()" class="px-3 py-1.5 rounded-xl bg-white hover:bg-zinc-100 border border-zinc-300 text-zinc-700 text-xs font-bold transition-colors shadow-sm">+ 添加实例</button>
      <button onclick="openGroupSettings()" class="px-3 py-1.5 rounded-xl bg-white hover:bg-zinc-100 border border-zinc-300 text-zinc-700 text-xs font-bold transition-colors shadow-sm">📁 分组与 DDNS</button>
      <button onclick="openGlobalSettings()" class="px-3 py-1.5 rounded-xl bg-white hover:bg-zinc-100 border border-zinc-300 text-zinc-700 text-xs font-bold transition-colors shadow-sm">⚙️ 全局设置</button>
      <button onclick="act('trigger_cron')" class="px-3 py-1.5 rounded-xl bg-zinc-900 text-white text-xs font-bold shadow-sm">立即巡检</button>
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

  <!-- 分组与实例看板 (支持跨组拖拽) -->
  <section class="space-y-6" id="groupSections"></section>
  <p id="emptyHint" class="hidden text-xs text-zinc-400 text-center py-10">还没有实例。点「+ 添加实例」开始。</p>

  <section class="card-static rounded-2xl p-4">
    <h2 class="text-xs font-bold uppercase tracking-wider text-zinc-500 mb-3">日志</h2>
    <div id="logList" class="space-y-1 max-h-80 overflow-auto text-[11px]"></div>
  </section>
</div>

<!-- ============================================================================ -->
<!-- 弹窗 1: 全局系统设置 -->
<!-- ============================================================================ -->
<div id="settingsModal" class="hidden fixed inset-0 bg-black/40 backdrop-blur-sm p-4 overflow-auto z-50 flex items-start justify-center">
  <div class="card-static rounded-3xl w-full max-w-3xl my-8 p-6 space-y-5 shadow-2xl">
    <div class="flex justify-between items-center border-b border-zinc-100 pb-3">
      <h2 class="text-sm font-bold text-zinc-900">全局系统设置</h2>
      <button onclick="closeGlobalSettings()" class="text-zinc-400 hover:text-zinc-600 text-2xl leading-none">&times;</button>
    </div>

    <div class="space-y-4">
      <h3 class="text-[11px] font-bold uppercase tracking-wider text-zinc-400">默认额度与全局保活</h3>
      <div class="grid md:grid-cols-3 gap-3">
        <label class="block"><span class="text-[11px] font-bold text-zinc-600">中国内地流量阈值 (GB)</span>
          <input id="s_trafficChina" type="number" class="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-3 py-2 text-xs mt-1"></label>
        <label class="block"><span class="text-[11px] font-bold text-zinc-600">非中国内地流量阈值 (GB)</span>
          <input id="s_trafficIntl" type="number" class="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-3 py-2 text-xs mt-1"></label>
        <label class="block"><span class="text-[11px] font-bold text-zinc-600">账单阈值 (0=关闭)</span>
          <input id="s_billThreshold" type="number" class="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-3 py-2 text-xs mt-1"></label>
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
        <label class="block"><span class="text-[11px] font-bold text-zinc-600">日报时间</span>
          <div class="grid grid-cols-2 gap-1 mt-1">
            <select id="s_dailyTime_h" class="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-2 py-2 text-xs font-bold"></select>
            <select id="s_dailyTime_m" class="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-2 py-2 text-xs font-bold"></select>
          </div>
        </label>
      </div>

      <h3 class="text-[11px] font-bold uppercase tracking-wider text-zinc-400 pt-2">通知</h3>
      <div class="grid md:grid-cols-3 gap-3">
        <label class="flex items-center gap-2 mt-5"><input id="s_tgEnabled" type="checkbox" class="w-4 h-4"><span class="text-[11px] font-bold text-zinc-600">Telegram 告警</span></label>
        <label class="block"><span class="text-[11px] font-bold text-zinc-600">Bot Token</span>
          <input id="s_tgToken" type="text" class="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-3 py-2 text-xs mt-1 font-mono"></label>
        <label class="block"><span class="text-[11px] font-bold text-zinc-600">Chat ID</span>
          <input id="s_tgChat" type="text" class="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-3 py-2 text-xs mt-1 font-mono"></label>
      </div>

      <h3 class="text-[11px] font-bold uppercase tracking-wider text-zinc-400 pt-2">安全</h3>
      <label class="block"><span class="text-[11px] font-bold text-zinc-600">管理员密码</span>
        <input id="s_adminPass" type="password" placeholder="未修改则留空" class="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-3 py-2 text-xs mt-1"></label>
      <p id="adminPassHint" class="text-[10px] text-zinc-400"></p>

      <h3 class="text-[11px] font-bold uppercase tracking-wider text-zinc-400 pt-2">诊断</h3>
      <div class="flex gap-2 flex-wrap">
        <button onclick="act('test_tg')" class="px-3 py-1.5 rounded-xl bg-zinc-100 hover:bg-zinc-200 border border-zinc-200 text-zinc-700 text-[11px] font-bold">发送测试消息</button>
        <button onclick="probeBill()" class="px-3 py-1.5 rounded-xl bg-zinc-100 hover:bg-zinc-200 border border-zinc-200 text-zinc-700 text-[11px] font-bold">账单接口诊断</button>
        <button onclick="act('clear_logs')" class="px-3 py-1.5 rounded-xl bg-zinc-100 hover:bg-zinc-200 border border-zinc-200 text-zinc-700 text-[11px] font-bold">清空日志</button>
      </div>
      <pre id="probeOut" class="hidden max-h-72 overflow-auto text-[10px] bg-zinc-50 border border-zinc-200 rounded-xl p-3 whitespace-pre-wrap break-all"></pre>
    </div>

    <div class="flex justify-end gap-2 pt-2 border-t border-zinc-100">
      <button onclick="closeGlobalSettings()" class="px-4 py-2 rounded-xl bg-zinc-100 text-zinc-700 text-xs font-bold">取消</button>
      <button onclick="saveGlobalSettings()" class="px-4 py-2 rounded-xl bg-zinc-900 text-white text-xs font-bold">保存全局设置</button>
    </div>
  </div>
</div>

<!-- ============================================================================ -->
<!-- 弹窗 2: 分组管理与各组 DDNS 设置 -->
<!-- ============================================================================ -->
<div id="groupModal" class="hidden fixed inset-0 bg-black/40 backdrop-blur-sm p-4 overflow-auto z-50 flex items-start justify-center">
  <div class="card-static rounded-3xl w-full max-w-3xl my-8 p-6 space-y-5 shadow-2xl">
    <div class="flex justify-between items-center border-b border-zinc-100 pb-3">
      <div>
        <h2 class="text-sm font-bold text-zinc-900">分组管理与 Cloudflare DDNS</h2>
        <p class="text-[11px] text-zinc-400">配置分组名称、独立 DDNS 域名及轮换周期 (0=不轮换)</p>
      </div>
      <button onclick="closeGroupModal()" class="text-zinc-400 hover:text-zinc-600 text-2xl leading-none">&times;</button>
    </div>

    <div class="flex justify-between items-center">
      <span class="text-xs font-bold text-zinc-700">分组列表</span>
      <button onclick="addNewGroup()" class="px-3 py-1.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-white text-[11px] font-bold transition-colors">
        + 新增分组
      </button>
    </div>

    <div id="groupEditList" class="space-y-4"></div>

    <div class="flex justify-end gap-2 pt-3 border-t border-zinc-100">
      <button onclick="closeGroupModal()" class="px-4 py-2 rounded-xl bg-white border border-zinc-200 text-zinc-700 text-xs font-bold">关闭</button>
      <button onclick="saveGroups()" class="px-4 py-2 rounded-xl bg-zinc-900 text-white text-xs font-bold">保存分组设置</button>
    </div>
  </div>
</div>

<!-- ============================================================================ -->
<!-- 弹窗 3: 单个实例独立设置弹窗 -->
<!-- ============================================================================ -->
<div id="instanceModal" class="hidden fixed inset-0 bg-black/40 backdrop-blur-sm p-4 overflow-auto z-50 flex items-start justify-center">
  <div class="card-static rounded-3xl w-full max-w-xl my-8 p-6 space-y-4 shadow-2xl">
    <div class="flex justify-between items-center border-b border-zinc-100 pb-3">
      <h2 id="instModalTitle" class="text-sm font-bold text-zinc-900">实例设置</h2>
      <button onclick="closeInstanceSettings()" class="text-zinc-400 hover:text-zinc-600 text-2xl leading-none">&times;</button>
    </div>
    <div id="instModalBody" class="space-y-3"></div>
    <div class="flex justify-between items-center pt-2 border-t border-zinc-100">
      <button id="btnDeleteInst" onclick="deleteCurrentInstance()" class="text-rose-600 hover:text-rose-700 text-xs font-bold">删除此实例</button>
      <div class="flex gap-2">
        <button onclick="closeInstanceSettings()" class="px-4 py-2 rounded-xl bg-zinc-100 text-zinc-700 text-xs font-bold">取消</button>
        <button onclick="saveInstanceSettings()" class="px-4 py-2 rounded-xl bg-zinc-900 text-white text-xs font-bold">保存实例配置</button>
      </div>
    </div>
  </div>
</div>

<script>
let CFG = null;
let STATE = null;
let CURRENT_EDIT_ACC_ID = null;
let draggedInstId = null;

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
  if (s === 'Running') return 'bg-emerald-100 text-emerald-800 border border-emerald-300';
  if (s === 'Stopped') return 'bg-zinc-100 text-zinc-700 border border-zinc-300';
  return 'bg-amber-100 text-amber-800 border border-amber-300';
}

function renderAccounts(){
  const container = document.getElementById('groupSections') || document.getElementById('accountGrid');
  const list = STATE.accounts || [];
  document.getElementById('emptyHint').classList.toggle('hidden', list.length > 0);

  const groups = (CFG && CFG.groups && CFG.groups.length > 0) ? CFG.groups : [{ id:'group-default', name:'默认分组', rotationIntervalMinutes:0, cf:{ enabled:false } }];
  
  container.innerHTML = groups.map(function(group){
    const groupInsts = list.filter(function(a){ return (a.groupId || 'group-default') === group.id; });
    const hasDdns = group.cf && group.cf.enabled && group.cf.domainName;
    const hasRotation = group.rotationIntervalMinutes > 0;
    
    let badge = '';
    let hint = '';
    if (!hasDdns && !hasRotation) {
      badge = '<span class="px-2.5 py-1 rounded-full text-[11px] font-bold bg-zinc-100 text-zinc-700 border border-zinc-300">未配置 DDNS · 实例保持不变</span>';
      hint = '未配置 Cloudflare DDNS 与定时轮换。组内实例各自保持状态，不执行自动换班。';
    } else {
      badge = '<span class="px-2.5 py-1 rounded-full text-[11px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300 flex items-center gap-1.5">'
        + '<span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>'
        + '定时轮换: ' + group.rotationIntervalMinutes + ' 分钟'
        + ' · DDNS: ' + esc(group.cf.domainName || '未填域名')
        + '</span>';
      hint = '组内实例按设定定时轮换，换班后自动更新专属 DDNS 解析。';
    }

    return '<div class="space-y-3">'
      + '<div class="card-static rounded-2xl p-4 bg-white border border-zinc-300 shadow-sm">'
      +   '<div class="flex flex-wrap items-center justify-between gap-3">'
      +     '<div class="flex items-center gap-3">'
      +       '<span class="text-xl">📁</span>'
      +       '<div>'
      +         '<div class="flex items-center gap-2">'
      +           '<h2 class="text-sm font-bold text-zinc-900">' + esc(group.name) + '</h2>'
      +           '<span class="text-[10px] text-zinc-400 font-mono">(' + esc(group.id) + ')</span>'
      +         '</div>'
      +         '<p class="text-[11px] text-zinc-500 mt-0.5">' + hint + '</p>'
      +       '</div>'
      +     '</div>'
      +     '<div class="flex items-center gap-2">'
      +       badge
      +       '<button onclick="openGroupSettings()" class="px-2.5 py-1 rounded-lg bg-zinc-50 hover:bg-zinc-100 border border-zinc-300 text-zinc-700 text-[10px] font-bold transition-colors">配置该组 DDNS</button>'
      +     '</div>'
      +   '</div>'
      + '</div>'
      + '<div id="dropzone_' + esc(group.id) + '" data-group-id="' + esc(group.id) + '" ondragover="onDragOver(event)" ondragleave="onDragLeave(event)" ondrop="onDrop(event, this.dataset.groupId)" class="grid md:grid-cols-2 gap-4 p-2 rounded-2xl border-2 border-dashed border-zinc-300 bg-zinc-200/50 transition-colors min-h-[140px]">'
      +   (groupInsts.length > 0 ? groupInsts.map(renderCardHtml).join('') : (
          '<div class="md:col-span-2 py-8 text-center text-xs text-zinc-500 pointer-events-none flex flex-col items-center justify-center gap-1.5 bg-white/60 rounded-xl border border-zinc-200">'
          + '<span class="text-base">📥 空分组</span>'
          + '<span class="text-[11px] text-zinc-500">按住上方其他实例卡片的 [⋮⋮ 拖拽] 手柄，拖到此区域即可迁入</span>'
          + '</div>'
      ))
      + '</div>'
      + '</div>';
  }).join('');
  const ag = document.getElementById('accountGrid');
  if (ag && ag !== container) ag.innerHTML = container.innerHTML;
}

function renderCardHtml(a){
  const qp = barPct(a.trafficGb, a.quota);
  const thresholdMark = (a.threshold > 0 && a.quota > 0 && a.threshold < a.quota) ? barPct(a.threshold, a.quota) : null;
  const bp = barPct(a.billAccountAmount, a.billThreshold);
  const cls = a.trafficClass === 'china' ? '中国内地' : '非中国内地';
  const cur = a.billCurrency || '';
  const status = a.ecsStatus || '未知';
  const brk = (a.breakdown || []).map(function(b){ return esc(b.region) + ' ' + b.gb + 'GB'; }).join(' · ');

  const row = function(label, value){
    return '<div class="flex justify-between text-[11px]"><span class="text-zinc-500">' + label + '</span>'
      + '<span class="font-bold text-zinc-800">' + value + '</span></div>';
  };

  const isRunning = status === 'Running';
  const isStopped = status === 'Stopped';
  const isBusy = status === 'Starting' || status === 'Stopping';

  const actionButtons = '<div class="flex items-center gap-1.5 pt-1 border-t border-zinc-200">'
    + (isStopped
        ? '<button onclick="controlInstance(&#39;start_instance&#39;,&#39;' + esc(a.id) + '&#39;,&#39;' + esc(a.name) + '&#39;)" class="flex-1 py-1 rounded-lg bg-emerald-50 hover:bg-emerald-100 border border-emerald-300 text-emerald-800 text-[11px] font-bold transition-colors">▶ 启动</button>'
        : (isRunning
            ? '<button onclick="controlInstance(&#39;stop_instance&#39;,&#39;' + esc(a.id) + '&#39;,&#39;' + esc(a.name) + '&#39;)" class="flex-1 py-1 rounded-lg bg-rose-50 hover:bg-rose-100 border border-rose-300 text-rose-800 text-[11px] font-bold transition-colors">⏹ 节省停机</button>'
            : '<button disabled class="flex-1 py-1 rounded-lg bg-zinc-100 border border-zinc-200 text-zinc-400 text-[11px] font-bold cursor-not-allowed">' + (isBusy ? '处理中…' : '无法控制') + '</button>'
          ))
    + '<button onclick="openAccountSettings(&#39;' + esc(a.id) + '&#39;)" class="px-2.5 py-1 rounded-lg bg-white hover:bg-zinc-100 border border-zinc-300 text-zinc-700 text-[11px] font-bold transition-colors shadow-sm">⚙️ 设置</button>'
    + '</div>';

  return '<div id="card_' + esc(a.id) + '" class="inst-card rounded-2xl p-4 space-y-2.5">'
    + '<div class="flex justify-between items-start gap-2">'
    +   '<div class="flex items-center gap-2">'
    +     '<div draggable="true" data-inst-id="' + esc(a.id) + '" ondragstart="onDragStart(event, this.dataset.instId)" ondragend="onDragEnd(event)" class="drag-handle px-1.5 py-0.5 rounded bg-zinc-100 hover:bg-indigo-100 hover:text-indigo-700 text-zinc-500 border border-zinc-300 text-[10px] font-bold select-none shrink-0" title="按住鼠标拖拽此手柄可移动分组">⋮⋮ 拖拽</div>'
    +     '<div><p class="text-sm font-bold text-zinc-900">' + esc(a.name) + '</p>'
    +     '<p class="text-[10px] text-zinc-400">' + esc(a.regionId) + ' · ' + cls + ' · 额度 ' + a.quota + 'GB</p></div>'
    +   '</div>'
    +   '<div class="flex gap-1 flex-wrap justify-end">'
    +     (a.duty ? '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300">当班</span>' : '')
    +     (a.manualOverride ? '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-300" title="手动接管中，将在跨过下一个运行时段节点时恢复自动调度">手动接管</span>' : '')
    +     (a.exhausted ? '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-rose-100 text-rose-700 border border-rose-300">耗尽</span>' : '')
    +     '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold ' + statusStyle(status) + '">' + esc(status) + '</span>'
    +   '</div>'
    + '</div>'
    + (!a.configured ? '<p class="text-[10px] text-amber-600 font-bold">未配置完整（缺 AK/SK/地域/实例 ID）</p>' : '')
    + (a.ecsError ? '<p class="text-[10px] text-rose-600">' + esc(a.ecsError) + '</p>' : '')
    + '<div>'
    +   '<div class="flex justify-between text-[11px] mb-1"><span class="text-zinc-500">流量</span><span class="font-bold text-zinc-800">' + (a.trafficGb ?? '-') + ' / ' + a.quota + ' GB（限额）</span></div>'
    +   '<div class="relative h-1.5 rounded-full bg-zinc-200 overflow-hidden"><div class="h-full ' + barColor(qp) + '" style="width:' + qp + '%"></div>'
    +     (thresholdMark != null ? '<div class="absolute top-0 h-full w-0.5 bg-zinc-800" style="left:' + thresholdMark + '%"></div>' : '')
    +   '</div>'
    +   '<div class="flex justify-between text-[10px] mt-1"><span class="text-zinc-400">阈值</span><span class="' + (a.exhausted ? 'text-rose-600 font-bold' : 'text-zinc-500') + '">' + a.threshold + ' GB</span></div>'
    + '</div>'
    + (a.billThreshold > 0
        ? '<div>'
          + '<div class="flex justify-between text-[11px] mb-1"><span class="text-zinc-500">账单（账号级）</span><span class="font-bold text-zinc-800">' + money(a.billAccountAmount, cur) + ' / ' + money(a.billThreshold, cur) + '</span></div>'
          + '<div class="h-1.5 rounded-full bg-zinc-200 overflow-hidden"><div class="h-full ' + barColor(bp) + '" style="width:' + bp + '%"></div></div>'
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
    + (a.scheduleEnabled ? row('运行时段', '<span class="text-indigo-700 font-bold">⏰ ' + esc(formatScheduleWindow(a.startTime, a.stopTime)) + '</span>') : '')
    + (a.reason ? '<p class="text-[10px] text-rose-600">' + esc(a.reason) + '</p>' : '')
    + (brk ? '<p class="text-[10px] text-zinc-400">' + brk + '</p>' : '')
    + actionButtons
    + '</div>';
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

// 拖拽逻辑
function onDragStart(e, instId) {
  draggedInstId = instId;
  e.dataTransfer.setData('text/plain', instId);
  e.dataTransfer.effectAllowed = 'move';
  const card = document.getElementById('card_' + instId);
  if (card) card.classList.add('dragging');
}

function onDragEnd(e) {
  if (draggedInstId) {
    const card = document.getElementById('card_' + draggedInstId);
    if (card) card.classList.remove('dragging');
  }
  document.querySelectorAll('[id^="dropzone_"]').forEach(el => el.classList.remove('drag-over'));
  draggedInstId = null;
}

function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  e.currentTarget.classList.add('drag-over');
}

function onDragLeave(e) {
  e.currentTarget.classList.remove('drag-over');
}

async function onDrop(e, targetGroupId) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  const instId = e.dataTransfer.getData('text/plain') || draggedInstId;
  if (!instId) return;

  const inst = (CFG.accounts || []).find(i => i.id === instId);
  if (!inst || inst.groupId === targetGroupId) return;

  inst.groupId = targetGroupId;
  try {
    await api('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...CFG, accounts: CFG.accounts })
    });
    await refresh();
  } catch(err) {
    alert('移动分组失败: ' + err.message);
  }
}

// 弹窗 1: 全局设置
function openGlobalSettings(){
  const s = CFG.system;
  document.getElementById('s_trafficChina').value = s.trafficThresholdChina;
  document.getElementById('s_trafficIntl').value = s.trafficThresholdIntl;
  document.getElementById('s_billThreshold').value = s.billThreshold;
  document.getElementById('s_billCheck').value = s.billCheckMinutes;
  document.getElementById('s_keepAlive').checked = s.keepAlive;
  document.getElementById('s_drain').value = s.dnsDrainSeconds;
  document.getElementById('s_timeout').value = s.transitionTimeoutMinutes;
  document.getElementById('s_startRetry').value = s.startRetrySeconds;
  document.getElementById('s_dailyReport').checked = s.dailyReport;
  const [dh, dm] = parseHHMM(s.dailyReportTime || '23:58', '23', '58');
  const dthEl = document.getElementById('s_dailyTime_h');
  const dtmEl = document.getElementById('s_dailyTime_m');
  if (dthEl) dthEl.innerHTML = hourOptions(dh);
  if (dtmEl) dtmEl.innerHTML = minuteOptions(dm);
  document.getElementById('s_tgEnabled').checked = CFG.notify.tg.enabled;
  document.getElementById('s_tgToken').value = CFG.notify.tg.botToken;
  document.getElementById('s_tgChat').value = CFG.notify.tg.chatId;
  document.getElementById('s_adminPass').value = '';
  document.getElementById('adminPassHint').textContent = CFG.adminPassFromSecret
    ? '已通过 ADMIN_PASS secret 设置，此处留空即可。'
    : '未使用 Secret，密码保存在 KV 中。建议改用 ADMIN_PASS secret。';
  document.getElementById('settingsModal').classList.remove('hidden');
}

function closeGlobalSettings(){
  document.getElementById('settingsModal').classList.add('hidden');
}

async function saveGlobalSettings(){
  const v = function(id){ return document.getElementById(id).value; };
  const c = function(id){ return document.getElementById(id).checked; };
  const payload = {
    ...CFG,
    system: {
      ...CFG.system,
      trafficThresholdChina: Number(v('s_trafficChina')),
      trafficThresholdIntl: Number(v('s_trafficIntl')),
      billThreshold: Number(v('s_billThreshold')),
      billCheckMinutes: Number(v('s_billCheck')),
      keepAlive: c('s_keepAlive'),
      dnsDrainSeconds: Number(v('s_drain')),
      transitionTimeoutMinutes: Number(v('s_timeout')),
      startRetrySeconds: Number(v('s_startRetry')),
      dailyReport: c('s_dailyReport'),
      dailyReportTime: (v('s_dailyTime_h') || '23') + ':' + (v('s_dailyTime_m') || '58'),
    },
    notify: { tg: { enabled: c('s_tgEnabled'), botToken: v('s_tgToken'), chatId: v('s_tgChat') } },
    adminPass: v('s_adminPass'),
  };
  try {
    await api('/api/config', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    closeGlobalSettings();
    await refresh();
  } catch(e){ alert('保存失败: ' + e.message); }
}

// 弹窗 2: 分组管理
function openGroupSettings(){
  renderGroupEditList();
  document.getElementById('groupModal').classList.remove('hidden');
}

function closeGroupModal(){
  document.getElementById('groupModal').classList.add('hidden');
}

function renderGroupEditList(){
  const container = document.getElementById('groupEditList');
  const groups = CFG.groups || [];
  const accounts = CFG.accounts || [];

  container.innerHTML = groups.map(function(g, idx){
    const isDefault = g.id === 'group-default' || idx === 0;
    const groupAccounts = accounts.filter(function(a){ return (a.groupId || 'group-default') === g.id; });
    
    // 解析轮换数值与单位（换算为天/小时/分钟）
    const totalMinutes = Number(g.rotationIntervalMinutes) || 0;
    let unit = 'm';
    let val = 0;
    if (totalMinutes > 0) {
      if (totalMinutes % 1440 === 0) { unit = 'd'; val = totalMinutes / 1440; }
      else if (totalMinutes % 60 === 0) { unit = 'h'; val = totalMinutes / 60; }
      else { unit = 'm'; val = totalMinutes; }
    }

    const primaryOpts = '<option value="">未指定（自动选组内第 1 台可用实例）</option>'
      + groupAccounts.map(function(a){
          return '<option value="' + esc(a.id) + '"' + (g.primaryAccountId === a.id ? ' selected' : '') + '>' + esc(a.name) + ' (' + esc(a.regionId) + ')</option>';
        }).join('');

    return '<div class="card-static rounded-2xl p-4 border border-zinc-200 space-y-3">'
      + '<div class="flex justify-between items-center">'
      +   '<span class="text-xs font-bold text-zinc-800">分组 #' + (idx + 1) + ': ' + esc(g.name) + '</span>'
      +   (!isDefault ? '<button data-gid="' + esc(g.id) + '" onclick="deleteGroup(this.dataset.gid)" class="text-[11px] text-rose-600 font-bold">删除</button>' : '<span class="text-[10px] text-zinc-400">默认组</span>')
      + '</div>'
      + '<div class="grid grid-cols-2 gap-2">'
      +   '<label class="block"><span class="text-[10px] font-bold text-zinc-500">分组名称</span>'
      +     '<input id="g_name_' + esc(g.id) + '" value="' + esc(g.name) + '" class="w-full bg-zinc-50 border border-zinc-200 rounded-lg px-2.5 py-1.5 text-xs mt-0.5"></label>'
      +   '<label class="block"><span class="text-[10px] font-bold text-zinc-500">定时轮换 (0=不轮换)</span>'
      +     '<div class="flex gap-1.5 mt-0.5">'
      +       '<input type="number" id="g_rot_val_' + esc(g.id) + '" value="' + val + '" min="0" placeholder="0" class="w-2/3 bg-zinc-50 border border-zinc-200 rounded-lg px-2.5 py-1.5 text-xs">'
      +       '<select id="g_rot_unit_' + esc(g.id) + '" class="w-1/3 bg-zinc-50 border border-zinc-200 rounded-lg px-1.5 py-1.5 text-xs font-bold">'
      +         '<option value="m"' + (unit === 'm' ? ' selected' : '') + '>分钟</option>'
      +         '<option value="h"' + (unit === 'h' ? ' selected' : '') + '>小时</option>'
      +         '<option value="d"' + (unit === 'd' ? ' selected' : '') + '>天</option>'
      +       '</select>'
      +     '</div>'
      +   '</label>'
      + '</div>'
      + '<div class="rounded-xl bg-zinc-50 p-3 space-y-2 border border-zinc-200">'
      +   '<label class="flex items-center gap-2">'
      +     '<input type="checkbox" id="g_cf_en_' + esc(g.id) + '"' + (g.cf && g.cf.enabled ? ' checked' : '') + ' data-gid="' + esc(g.id) + '" onchange="toggleCf(this.dataset.gid)" class="w-4 h-4">'
      +     '<span class="text-xs font-bold text-zinc-700">启用 Cloudflare DDNS</span>'
      +   '</label>'
      +   '<div id="cf_box_' + esc(g.id) + '" class="space-y-2 ' + (g.cf && g.cf.enabled ? '' : 'opacity-40 pointer-events-none') + '">'
      +     '<div class="grid grid-cols-2 gap-2">'
      +       '<input id="g_cf_tok_' + esc(g.id) + '" value="' + esc(g.cf?.apiToken || '') + '" placeholder="API Token" class="bg-white border border-zinc-200 rounded-lg px-2 py-1 text-xs">'
      +       '<input id="g_cf_zone_' + esc(g.id) + '" value="' + esc(g.cf?.zoneId || '') + '" placeholder="Zone ID" class="bg-white border border-zinc-200 rounded-lg px-2 py-1 text-xs">'
      +       '<input id="g_cf_rec_' + esc(g.id) + '" value="' + esc(g.cf?.recordId || '') + '" placeholder="Record ID" class="bg-white border border-zinc-200 rounded-lg px-2 py-1 text-xs">'
      +       '<input id="g_cf_dom_' + esc(g.id) + '" value="' + esc(g.cf?.domainName || '') + '" placeholder="解析域名 (如 hk.example.com)" class="bg-white border border-zinc-200 rounded-lg px-2 py-1 text-xs">'
      +     '</div>'
      +     '<label class="block pt-1 border-t border-zinc-200/60"><span class="text-[10px] font-bold text-zinc-500">主解析实例（未开启轮换时固定解析此实例；耗尽时自动顺移备用机）</span>'
      +       '<select id="g_primary_' + esc(g.id) + '" class="w-full bg-white border border-zinc-200 rounded-lg px-2 py-1 text-xs mt-0.5">' + primaryOpts + '</select>'
      +     '</label>'
      +   '</div>'
      + '</div>'
      + '</div>';
  }).join('');
}

function toggleCf(gid){
  const en = document.getElementById('g_cf_en_' + gid).checked;
  const box = document.getElementById('cf_box_' + gid);
  if (en) box.classList.remove('opacity-40', 'pointer-events-none');
  else box.classList.add('opacity-40', 'pointer-events-none');
}

function addNewGroup(){
  const id = 'group-' + Date.now().toString().slice(-4);
  CFG.groups = CFG.groups || [];
  CFG.groups.push({
    id: id,
    name: '新建分组 ' + (CFG.groups.length + 1),
    rotationIntervalMinutes: 60,
    primaryAccountId: '',
    cf: { enabled: false, apiToken: '', zoneId: '', recordId: '', domainName: '' }
  });
  renderGroupEditList();
}

function deleteGroup(gid){
  if (!confirm('确认删除该分组？组内实例将自动归入默认分组。')) return;
  (CFG.accounts || []).forEach(function(a){ if (a.groupId === gid) a.groupId = 'group-default'; });
  CFG.groups = (CFG.groups || []).filter(function(g){ return g.id !== gid; });
  renderGroupEditList();
}

async function saveGroups(){
  (CFG.groups || []).forEach(function(g){
    const n = document.getElementById('g_name_' + g.id);
    const rVal = document.getElementById('g_rot_val_' + g.id);
    const rUnit = document.getElementById('g_rot_unit_' + g.id);
    const pAcc = document.getElementById('g_primary_' + g.id);
    const en = document.getElementById('g_cf_en_' + g.id);

    if (n) g.name = n.value;
    if (rVal && rUnit) {
      const v = Math.max(0, parseInt(rVal.value, 10) || 0);
      const mult = rUnit.value === 'd' ? 1440 : rUnit.value === 'h' ? 60 : 1;
      g.rotationIntervalMinutes = v * mult;
    }
    if (pAcc) g.primaryAccountId = pAcc.value || '';
    if (en) {
      g.cf = g.cf || {};
      g.cf.enabled = en.checked;
      g.cf.apiToken = document.getElementById('g_cf_tok_' + g.id)?.value || '';
      g.cf.zoneId = document.getElementById('g_cf_zone_' + g.id)?.value || '';
      g.cf.recordId = document.getElementById('g_cf_rec_' + g.id)?.value || '';
      g.cf.domainName = document.getElementById('g_cf_dom_' + g.id)?.value || '';
    }
  });

  try {
    await api('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...CFG, groups: CFG.groups, accounts: CFG.accounts })
    });
    closeGroupModal();
    await refresh();
  } catch(e) {
    alert('保存分组失败: ' + e.message);
  }
}

// 弹窗 3: 单个实例独立设置
function openAccountSettings(accId){
  const acc = (CFG.accounts || []).find(a => a.id === accId);
  if (!acc) return alert('未找到该实例配置');
  CURRENT_EDIT_ACC_ID = accId;
  document.getElementById('instModalTitle').textContent = '设置实例 - ' + (acc.name || '实例');
  document.getElementById('instModalBody').innerHTML = accountRow(acc);
  document.getElementById('btnDeleteInst').classList.remove('hidden');
  document.getElementById('instanceModal').classList.remove('hidden');
}

function closeInstanceSettings(){
  CURRENT_EDIT_ACC_ID = null;
  document.getElementById('instanceModal').classList.add('hidden');
}

function addAccount(){
  CURRENT_EDIT_ACC_ID = 'acc-' + Date.now().toString().slice(-4);
  const defaultGid = CFG.groups?.[0]?.id || 'group-default';
  const newInst = {
    id: CURRENT_EDIT_ACC_ID,
    groupId: defaultGid,
    name: '实例 ' + ((CFG.accounts?.length || 0) + 1),
    ak: '', sk: '', regionId: 'ap-southeast-1', instanceId: '', eip: '',
    siteType: 'international', trafficThresholdGb: null, billThreshold: null,
    keepAlive: null, scheduleEnabled: false, startTime: '00:00', stopTime: '23:59', remark: ''
  };
  CFG.accounts = CFG.accounts || [];
  CFG.accounts.push(newInst);
  document.getElementById('instModalTitle').textContent = '新建实例';
  document.getElementById('instModalBody').innerHTML = accountRow(newInst);
  document.getElementById('btnDeleteInst').classList.add('hidden');
  document.getElementById('instanceModal').classList.remove('hidden');
}

function deleteCurrentInstance(){
  if (!CURRENT_EDIT_ACC_ID) return;
  if (!confirm('确定要删除此实例吗？')) return;
  CFG.accounts = (CFG.accounts || []).filter(a => a.id !== CURRENT_EDIT_ACC_ID);
  closeInstanceSettings();
  api('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...CFG, accounts: CFG.accounts })
  }).then(refresh);
}

async function saveInstanceSettings(){
  if (!CURRENT_EDIT_ACC_ID) return closeInstanceSettings();
  const row = document.querySelector('#instModalBody [data-acc-form]');
  if (!row) return closeInstanceSettings();

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
  const startH = document.getElementById('inst_start_h')?.value || '00';
  const startM = document.getElementById('inst_start_m')?.value || '00';
  const stopH = document.getElementById('inst_stop_h')?.value || '23';
  const stopM = document.getElementById('inst_stop_m')?.value || '59';
  acc.startTime = startH + ':' + startM;
  acc.stopTime = stopH + ':' + stopM;
  acc.id = CURRENT_EDIT_ACC_ID;

  const idx = CFG.accounts.findIndex(a => a.id === CURRENT_EDIT_ACC_ID);
  if (idx !== -1) CFG.accounts[idx] = acc;

  try {
    await api('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...CFG, accounts: CFG.accounts })
    });
    closeInstanceSettings();
    await refresh();
  } catch(e) {
    alert('保存失败: ' + e.message);
  }
}

async function controlInstance(action, accountId, name){
  const isStop = action === 'stop_instance';
  const label = isStop ? '节省停机' : '启动';

  const acc = (CFG?.accounts || []).find(x => x.id === accountId);
  const stateAcc = (STATE?.accounts || []).find(x => x.id === accountId);
  const grpId = acc?.groupId || stateAcc?.groupId || 'group-default';
  const grp = (CFG?.groups || []).find(g => g.id === grpId);
  const hasDdns = !!(grp?.cf?.enabled && grp?.cf?.domainName && grp?.cf?.apiToken);
  const rotationMinutes = Number(grp?.rotationIntervalMinutes || 0);
  const isDdnsGroup = hasDdns || rotationMinutes > 0;

  let confirmMsg = '';

  if (isStop) {
    if (isDdnsGroup && stateAcc?.duty) {
      const groupAccounts = (STATE?.accounts || []).filter(x => (x.groupId || 'group-default') === grpId);
      const standbyAcc = groupAccounts.find(x => x.id !== accountId && !x.exhausted && x.configured && (!x.manualOverride || x.manualOverride.action !== 'stop'));
      if (standbyAcc) {
        confirmMsg = '【' + name + '】当前为当班解析实例。手动节省停机将自动启动备用机【' + standbyAcc.name + '】并平移域名解析，确认换班停机？';
      } else {
        confirmMsg = '【' + name + '】当前为组内唯一可用当班实例。执行节省停机后解析服务将下线且不再自动保活，确认停机？';
      }
    } else {
      confirmMsg = '确定要对实例【' + name + '】执行节省停机操作吗？';
    }
  } else {
    // start_instance
    if (isDdnsGroup) {
      const groupAccounts = (STATE?.accounts || []).filter(x => (x.groupId || 'group-default') === grpId);
      const currentDuty = groupAccounts.find(x => x.duty && x.id !== accountId);
      if (currentDuty) {
        confirmMsg = '【' + name + '】为备用实例。手动启动将触发平滑切班使其接管域名解析，原当班机【' + currentDuty.name + '】将换下停机，确认启动？';
      } else {
        confirmMsg = '确定要启动实例【' + name + '】吗？';
      }
    } else {
      confirmMsg = '确定要启动实例【' + name + '】吗？';
    }
  }

  if (!confirm(confirmMsg)) return;
  try {
    const r = await api('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: action, accountId: accountId })
    });
    if (r && r.error) alert(label + '失败: ' + r.error);
    else alert(r?.message || ('已成功发送' + label + '指令'));
    await refresh();
  } catch(e) {
    alert(label + '请求出错: ' + e.message);
  }
}

function hourOptions(selH){
  let hNum = parseInt(selH, 10);
  if (isNaN(hNum)) hNum = 0;
  const opts = [];
  for (let h = 0; h < 24; h++) {
    const s = String(h).padStart(2, '0');
    opts.push('<option value="' + s + '"' + (h === hNum ? ' selected' : '') + '>' + s + ' 时</option>');
  }
  return opts.join('');
}

function minuteOptions(selM){
  let mNum = parseInt(selM, 10);
  if (isNaN(mNum)) mNum = 0;
  // 常用分钟刻度（00, 15, 30, 45, 59）
  const mins = [0, 15, 30, 45, 59];
  if (!mins.includes(mNum)) mins.push(mNum);
  mins.sort((a,b) => a - b);
  return mins.map(function(m){
    const s = String(m).padStart(2, '0');
    return '<option value="' + s + '"' + (m === mNum ? ' selected' : '') + '>' + s + ' 分</option>';
  }).join('');
}

function parseHHMM(val, defH, defM){
  const parts = String(val || '').split(':');
  const h = parts[0] != null && parts[0] !== '' ? parts[0].padStart(2, '0') : defH;
  const m = parts[1] != null && parts[1] !== '' ? parts[1].padStart(2, '0') : defM;
  return [h, m];
}

function formatScheduleWindow(startTime, stopTime){
  if (!startTime && !stopTime) return '';
  const [sh, sm] = parseHHMM(startTime, '00', '00');
  const [eh, em] = parseHHMM(stopTime, '23', '59');
  const s = sh + ':' + sm;
  const e = eh + ':' + em;
  const isOvernight = s > e;
  return s + ' ~ ' + (isOvernight ? '次日 ' : '') + e;
}

function timeColPicker(prefix, curVal, defH, defM){
  const [h, m] = parseHHMM(curVal, defH, defM);
  return '<div class="grid grid-cols-2 gap-1 mt-0.5">'
    + '<select id="' + prefix + '_h" class="w-full bg-white border border-zinc-200 rounded-lg px-2 py-1.5 text-xs font-bold">' + hourOptions(h) + '</select>'
    + '<select id="' + prefix + '_m" class="w-full bg-white border border-zinc-200 rounded-lg px-2 py-1.5 text-xs font-bold">' + minuteOptions(m) + '</select>'
    + '</div>';
}

function accountRow(a){
  const regions = ${JSON.stringify(REGIONS)}.map(function(r){
    return '<option value="' + r[0] + '"' + (a.regionId === r[0] ? ' selected' : '') + '>' + r[0] + ' · ' + r[1] + '</option>';
  }).join('');
  const groups = (CFG?.groups || [{ id:'group-default', name:'默认分组' }]).map(function(g){
    return '<option value="' + esc(g.id) + '"' + ((a.groupId || 'group-default') === g.id ? ' selected' : '') + '>' + esc(g.name) + '</option>';
  }).join('');
  const sel = function(v){ return v === true ? ' selected' : ''; };

  return '<div data-acc-form="true" class="space-y-3">'
    + '<div class="grid md:grid-cols-2 gap-3">'
    +   '<label class="block"><span class="text-[11px] font-bold text-zinc-600">实例名称</span>'
    +     '<input data-f="name" value="' + esc(a.name) + '" placeholder="名称" class="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-3 py-2 text-xs mt-1"></label>'
    +   '<label class="block"><span class="text-[11px] font-bold text-zinc-600">归属分组</span>'
    +     '<select data-f="groupId" class="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-3 py-2 text-xs mt-1 font-bold">' + groups + '</select></label>'
    + '</div>'
    + '<div class="grid md:grid-cols-2 gap-3">'
    +   '<label class="block"><span class="text-[11px] font-bold text-zinc-600">ECS 实例 ID</span>'
    +     '<input data-f="instanceId" value="' + esc(a.instanceId) + '" placeholder="ECS 实例 ID" class="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-3 py-2 text-xs mt-1 font-mono"></label>'
    +   '<label class="block"><span class="text-[11px] font-bold text-zinc-600">地域</span>'
    +     '<select data-f="regionId" class="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-3 py-2 text-xs mt-1">' + regions + '</select></label>'
    + '</div>'
    + '<div class="grid md:grid-cols-2 gap-3">'
    +   '<label class="block"><span class="text-[11px] font-bold text-zinc-600">AccessKey ID</span>'
    +     '<input data-f="ak" value="' + esc(a.ak) + '" placeholder="AccessKey ID" class="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-3 py-2 text-xs mt-1 font-mono"></label>'
    +   '<label class="block"><span class="text-[11px] font-bold text-zinc-600">AccessKey Secret</span>'
    +     '<input data-f="sk" value="' + esc(a.sk) + '" placeholder="AccessKey Secret" class="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-3 py-2 text-xs mt-1 font-mono"></label>'
    + '</div>'
    + '<div class="grid md:grid-cols-2 gap-3">'
    +   '<label class="block"><span class="text-[11px] font-bold text-zinc-600">站别类型</span>'
    +     '<select data-f="siteType" class="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-3 py-2 text-xs mt-1">'
    +       '<option value="international"' + sel(a.siteType === 'international') + '>国际站 (business.ap-southeast-1)</option>'
    +       '<option value="china"' + sel(a.siteType === 'china') + '>中国站 (business.cn-hangzhou)</option>'
    +     '</select></label>'
    +   '<label class="block"><span class="text-[11px] font-bold text-zinc-600">备用 EIP (可留空)</span>'
    +     '<input data-f="eip" value="' + esc(a.eip) + '" placeholder="备用 EIP" class="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-3 py-2 text-xs mt-1"></label>'
    + '</div>'
    + (a.liveEip ? '<p class="text-[10px] text-zinc-400">当前实例公网 IP：' + esc(a.liveEip) + '</p>' : '')
    + '<div class="rounded-xl bg-zinc-50 border border-zinc-200 p-3 space-y-2">'
    +   '<div class="flex items-center justify-between">'
    +     '<label class="flex items-center gap-2 cursor-pointer">'
    +       '<input type="checkbox" data-f="scheduleEnabled"' + (a.scheduleEnabled ? ' checked' : '') + ' class="w-4 h-4 rounded text-zinc-900">'
    +       '<span class="text-xs font-bold text-zinc-800">限定每日运行时段</span>'
    +     '</label>'
    +     '<span class="text-[10px] text-zinc-400">不在此时段内保持关机节约成本</span>'
    +   '</div>'
    +   '<div class="grid grid-cols-2 gap-3">'
    +     '<label class="block"><span class="text-[10px] font-bold text-zinc-500">每日开机时间</span>'
    +       timeColPicker('inst_start', a.startTime, '00', '00') + '</label>'
    +     '<label class="block"><span class="text-[10px] font-bold text-zinc-500">每日关机时间</span>'
    +       timeColPicker('inst_stop', a.stopTime, '23', '59') + '</label>'
    +   '</div>'
    + '</div>'
    + '<div class="grid grid-cols-3 gap-3">'
    +   '<label class="block"><span class="text-[11px] font-bold text-zinc-600">流量阈值覆盖 (GB)</span>'
    +     '<input data-f="trafficThresholdGb" value="' + esc(a.trafficThresholdGb ?? '') + '" placeholder="默认" class="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-3 py-2 text-xs mt-1"></label>'
    +   '<label class="block"><span class="text-[11px] font-bold text-zinc-600">账单阈值覆盖</span>'
    +     '<input data-f="billThreshold" value="' + esc(a.billThreshold ?? '') + '" placeholder="默认" class="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-3 py-2 text-xs mt-1"></label>'
    +   '<label class="block"><span class="text-[11px] font-bold text-zinc-600">独立保活</span>'
    +     '<select data-f="keepAlive" class="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-3 py-2 text-xs mt-1">'
    +       '<option value=""' + (a.keepAlive == null ? ' selected' : '') + '>跟随全局</option>'
    +       '<option value="true"' + sel(a.keepAlive === true) + '>开启保活</option>'
    +       '<option value="false"' + sel(a.keepAlive === false) + '>关闭保活</option>'
    +     '</select></label>'
    + '</div>'
    + '<input type="hidden" data-f="remark" value="' + esc(a.remark) + '">'
    + '</div>';
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
  normalizeHHMM,
};

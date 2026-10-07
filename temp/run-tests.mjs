// CDT-Monitor v2 测试台
// 把 worker.js 复制成 .mjs 后直接导入（worker.js 已经导出了内部函数），
// 用桩替掉阿里云 / Cloudflare / Telegram 的 fetch，驱动 runEngineCron。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve('.');
const TESTMOD = path.join(ROOT, 'temp', 'worker-test.mjs');
fs.copyFileSync(path.join(ROOT, process.env.CDT_SRC || 'worker.js'), TESTMOD);

// ---------------------------------------------------------------- globals
globalThis.DurableObject = class DurableObject {};

let timeOffset = 0;
const realNow = Date.now;
Date.now = () => realNow() + timeOffset;

function json(o) {
  return { ok: true, status: 200, async json() { return o; }, async text() { return JSON.stringify(o); } };
}

const GB = 1024 ** 3;

const world = {
  ecs: {}, startResult: {}, startCalls: [], stopCalls: [],
  dns: { content: '1.1.1.1' }, tg: [], cdt: {}, bill: {}, failCdt: new Set(),
};

globalThis.fetch = async (url, init) => {
  const u = new URL(url);
  const form = new URLSearchParams(init?.body || '');
  const action = form.get('Action');

  if (u.hostname.endsWith('aliyuncs.com')) {
    const ak = form.get('AccessKeyId');

    if (action === 'ListCdtInternetTraffic') {
      if (world.failCdt.has(ak)) return json({ Code: 'Throttling', Message: '请求过于频繁' });
      const rows = world.cdt[ak] || [];
      return json({ TrafficDetails: rows.map((r) => ({ BusinessRegionId: r.region, Traffic: Math.round(r.gb * GB) })) });
    }
    if (action === 'DescribeInstances') {
      const id = JSON.parse(form.get('InstanceIds'))[0];
      const s = world.ecs[id];
      if (!s) return json({ Instances: { Instance: [] } });
      return json({ Instances: { Instance: [{
        InstanceId: id, Status: s.Status, StoppedMode: s.StoppedMode,
        EipAddress: { IpAddress: s.eip }, PublicIpAddress: { IpAddress: [s.eip] },
      }] } });
    }
    if (action === 'StartInstance') {
      const id = form.get('InstanceId');
      world.startCalls.push(id);
      const err = world.startResult[id];
      if (err) return json({ Code: err.code, Message: err.message });
      world.ecs[id].Status = 'Running';
      return json({ RequestId: 'r' });
    }
    if (action === 'StopInstance') {
      const id = form.get('InstanceId');
      world.stopCalls.push(id);
      world.ecs[id].Status = 'Stopped';
      world.ecs[id].StoppedMode = form.get('StoppedMode') || 'StopCharging';
      return json({ RequestId: 'r' });
    }
    if (action === 'DescribeInstanceBill') {
      const b = world.bill[ak];
      if (b === undefined) return json({ Code: 'NotApplicable', Message: 'This API is not applicable for caller.' });
      const all = typeof b === 'number'
        ? [{ PretaxAmount: String(b), PretaxGrossAmount: String(b), Currency: 'USD' }]
        : (b.items || []);
      // 带 InstanceID 的查询只返回该实例的条目；不带就是整账号
      const instanceId = form.get('InstanceID');
      let filtered = all;
      if (instanceId && all.some((it) => it.InstanceID)) {
        filtered = all.filter((it) => it.InstanceID === instanceId);
      }
      const pageSize = (typeof b === 'object' && b.pageSize) || 300;
      const start = Number(form.get('NextToken') || 0);
      const slice = filtered.slice(start, start + pageSize);
      const data = {
        BillingCycle: form.get('BillingCycle'),
        TotalCount: filtered.length,
        Items: { Item: slice },
      };
      if (start + pageSize < filtered.length) data.NextToken = String(start + pageSize);
      return json({ Data: data });
    }
    if (action === 'DescribeEips') {
      if (world.eipsError) return json({ Code: 'NoPermission', Message: 'You are not authorized to perform this operation.' });
      const list = world.eips[ak] || [];
      return json({ Eips: { Eip: list }, TotalCount: list.length });
    }
    if (action === 'QueryAccountBalance') {
      return json({ Code: '200', Data: { AvailableAmount: '12.34', Currency: 'USD' } });
    }
    return json({});
  }

  if (u.hostname === 'api.cloudflare.com') {
    if (init?.method === 'PUT') world.dns.content = JSON.parse(init.body).content;
    return json({ success: true, result: { content: world.dns.content } });
  }
  if (u.hostname === 'api.telegram.org') {
    world.tg.push(JSON.parse(init.body).text);
    return json({ ok: true });
  }
  throw new Error('unexpected fetch ' + url);
};

// ---------------------------------------------------------------- helpers
function makeEnv(cfg) {
  const store = { app_config: JSON.stringify(cfg), app_logs: '[]' };
  return {
    store,
    STATE_KV: {
      async get(k, opts) {
        const v = store[k];
        if (v === undefined) return null;
        return opts?.type === 'json' ? JSON.parse(v) : v;
      },
      async put(k, v) { store[k] = v; },
      async delete(k) { delete store[k]; },
    },
  };
}

function makeEngine(state) {
  return { state, async loadState() { return this.state; }, async saveState(s) { this.state = s; } };
}

function acc(id, over) {
  return {
    id, name: '账号 ' + id.toUpperCase(), ak: 'ak-' + id, sk: 'sk-' + id,
    regionId: 'ap-southeast-1', instanceId: 'i-' + id, eip: '', siteType: 'international',
    trafficThresholdGb: null, billThreshold: null, keepAlive: null,
    scheduleEnabled: false, startTime: '00:00', stopTime: '23:59', remark: '', ...over,
  };
}

function baseConfig(accounts) {
  return {
    adminPass: 'x',
    system: {
      trafficThresholdChina: 18, trafficThresholdIntl: 188, billThreshold: 0,
      rotationIntervalMinutes: 0, keepAlive: true, dnsDrainSeconds: 0,
      transitionTimeoutMinutes: 10, startRetrySeconds: 180, billCheckMinutes: 30,
      balanceSync: true, dailyReport: false, dailyReportTime: '23:58',
    },
    accounts,
    cf: { apiToken: 't', zoneId: 'z', recordId: 'r', domainName: 'd.example.com' },
    notify: { tg: { enabled: true, botToken: 'bt', chatId: 'ci' } },
  };
}

function resetWorld() {
  world.ecs = {};
  world.startResult = {};
  world.startCalls = [];
  world.stopCalls = [];
  world.dns = { content: '1.1.1.1' };
  world.tg = [];
  world.cdt = {};
  world.bill = {};
  world.eips = {};
  world.failCdt = new Set();
  timeOffset = 0;
}

// 每个账号一台机器，默认全部停机 + 零流量
function seed(accounts, runningId) {
  for (const a of accounts) {
    world.ecs[a.instanceId] = {
      Status: a.instanceId === runningId ? 'Running' : 'Stopped',
      StoppedMode: a.instanceId === runningId ? 'Not-applicable' : 'StopCharging',
      eip: '10.0.0.' + a.instanceId.slice(-1),
    };
    world.cdt[a.ak] = [{ region: a.regionId, gb: 0 }];
  }
}

// 当前 CST 计费月。测试里必须用真实月份，否则会触发跨月重置（dutySince 被清零）
function cstMonth() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' })
    .format(new Date()).slice(0, 7);
}

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

const M = await import(pathToFileURL(TESTMOD).href);
  const {
  runEngineCron, defaultState, trafficClass, quotaForClass,
  resolveTrafficThreshold, resolveBillThreshold, resolveKeepAlive,
  inTimeRange, evaluateExhausted, validateConfig, bssEndpoint,
  probeBilling, reconcileAndClearFault, renderHtml,
} = M;

// ============================================================================
console.log('\n[1] 纯函数');
check('cn-hongkong 属于非中国内地', trafficClass('cn-hongkong') === 'international', trafficClass('cn-hongkong'));
check('cn-hangzhou 属于中国内地', trafficClass('cn-hangzhou') === 'china');
check('ap-southeast-1 属于非中国内地', trafficClass('ap-southeast-1') === 'international');
check('额度池 20 / 200', quotaForClass('china') === 20 && quotaForClass('international') === 200);

{
  const cfg = baseConfig([]);
  check('阈值按地域选默认值（中国内地）', resolveTrafficThreshold(acc('a', { regionId: 'cn-hangzhou' }), cfg) === 18);
  check('阈值按地域选默认值（非中国内地）', resolveTrafficThreshold(acc('a'), cfg) === 188);
  check('单账号阈值覆盖生效', resolveTrafficThreshold(acc('a', { trafficThresholdGb: 50 }), cfg) === 50);
  check('保活跟随全局', resolveKeepAlive(acc('a'), cfg) === true);
  check('保活单账号覆盖', resolveKeepAlive(acc('a', { keepAlive: false }), cfg) === false);
}

check('时段 08:00-23:00 内', inTimeRange('12:00', '08:00', '23:00') === true);
check('时段 08:00-23:00 外', inTimeRange('23:30', '08:00', '23:00') === false);
check('跨午夜 22:00-06:00 内(23:00)', inTimeRange('23:00', '22:00', '06:00') === true);
check('跨午夜 22:00-06:00 内(02:00)', inTimeRange('02:00', '22:00', '06:00') === true);
check('跨午夜 22:00-06:00 外(12:00)', inTimeRange('12:00', '22:00', '06:00') === false);

{
  const cfg = baseConfig([]);
  const a = acc('a');
  check('流量到阈值即耗尽', evaluateExhausted(a, { trafficGb: 188, billOk: false }, cfg).exhausted === true);
  check('流量未到不耗尽', evaluateExhausted(a, { trafficGb: 100, billOk: false }, cfg).exhausted === false);
  const withBill = baseConfig([]);
  withBill.system.billThreshold = 5;
  check('账单到阈值即耗尽', evaluateExhausted(a, { trafficGb: 0, billOk: true, billAmount: 6 }, withBill).exhausted === true);
  check('账单查询失败时不计入耗尽', evaluateExhausted(a, { trafficGb: 0, billOk: false, billAmount: 99 }, withBill).exhausted === false);
}

check('BSS 端点 国际站', bssEndpoint('international').host === 'business.ap-southeast-1.aliyuncs.com');
check('BSS 端点 中国站', bssEndpoint('china').host === 'business.aliyuncs.com');
check('空账号列表不算配置错误', (() => { try { validateConfig(baseConfig([])); return true; } catch { return false; } })());

// ============================================================================
console.log('\n[2] CDT 流量必须按地域类别分类累加');
{
  resetWorld();
  const accounts = [acc('a'), acc('c', { regionId: 'cn-hangzhou', siteType: 'china' })];
  seed(accounts, 'i-a');
  // 两个账号的账号级响应都同时包含两地的流量明细
  world.cdt['ak-a'] = [{ region: 'ap-southeast-1', gb: 100 }, { region: 'cn-hangzhou', gb: 50 }];
  world.cdt['ak-c'] = [{ region: 'ap-southeast-1', gb: 100 }, { region: 'cn-hangzhou', gb: 50 }];

  const cfg = baseConfig(accounts);
  const env = makeEnv(cfg);
  const st = { ...defaultState(), month: cstMonth(), dutyAccountId: 'a', dutySince: Date.now() };
  const eng = makeEngine(st);
  await runEngineCron(env, eng);

  check('国际站账号只算非中国内地 (100)', st.accounts.a.trafficGb === 100, st.accounts.a);
  check('中国站账号只算中国内地 (50)', st.accounts.c.trafficGb === 50, st.accounts.c);
  check('明细保留用于展示', Array.isArray(st.accounts.a.breakdown) && st.accounts.a.breakdown.length === 2, st.accounts.a.breakdown);
}

// ============================================================================
console.log('\n[3] N 账号轮换');
{
  resetWorld();
  const accounts = [acc('a'), acc('b'), acc('c')];
  seed(accounts, 'i-a');
  const cfg = baseConfig(accounts);
  cfg.system.rotationIntervalMinutes = 60;   // 1 小时轮换一次
  const env = makeEnv(cfg);
  const st = { ...defaultState(), month: cstMonth(), dutyAccountId: 'a', dutySince: Date.now() - 61 * 60000, rotationIndex: 0 };
  const eng = makeEngine(st);

  // 第一轮：定时到期 → 开始换班
  await runEngineCron(env, eng);
  check('定时到期开始换班', !!st.transition, st.transition);
  check('目标是下一个账号 b', st.transition && st.transition.targetId === 'b', st.transition);
  check('已下发启动 i-b', world.startCalls.includes('i-b'), world.startCalls);

  // 推进换班：目标 Running → DNS → 停机
  let guard = 0;
  while (st.transition && guard++ < 12) await runEngineCron(env, eng);
  check('换班收敛', !st.transition, st.transition);
  check('当班变为 b', st.dutyAccountId === 'b', st.dutyAccountId);
  check('旧账号 a 已停机', world.stopCalls.includes('i-a'), world.stopCalls);
  check('DNS 指向 b 的 IP', world.dns.content === world.ecs['i-b'].eip, { dns: world.dns.content, b: world.ecs['i-b'].eip });

  // 再轮一次 → c
  st.dutySince = Date.now() - 61 * 60000;
  await runEngineCron(env, eng);
  guard = 0;
  while (st.transition && guard++ < 12) await runEngineCron(env, eng);
  check('第二轮轮换到 c', st.dutyAccountId === 'c', st.dutyAccountId);
  check('DNS 指向 c 的 IP', world.dns.content === world.ecs['i-c'].eip, world.dns.content);

  // 再轮一次 → 回到 a（round-robin 回到开头）
  st.dutySince = Date.now() - 61 * 60000;
  await runEngineCron(env, eng);
  guard = 0;
  while (st.transition && guard++ < 12) await runEngineCron(env, eng);
  check('第三轮回到 a', st.dutyAccountId === 'a', st.dutyAccountId);
}

// ============================================================================
console.log('\n[4] 按流量轮换 + 跳过已耗尽账号');
{
  resetWorld();
  const accounts = [acc('a'), acc('b'), acc('c')];
  seed(accounts, 'i-a');
  world.cdt['ak-a'] = [{ region: 'ap-southeast-1', gb: 190 }];   // a 超阈值 188
  world.cdt['ak-b'] = [{ region: 'ap-southeast-1', gb: 195 }];   // b 也已耗尽
  world.cdt['ak-c'] = [{ region: 'ap-southeast-1', gb: 10 }];

  const cfg = baseConfig(accounts);
  const env = makeEnv(cfg);
  const st = { ...defaultState(), month: cstMonth(), dutyAccountId: 'a', dutySince: Date.now() };
  const eng = makeEngine(st);

  await runEngineCron(env, eng);
  check('a 被标记耗尽', st.accounts.a.exhausted === true, st.accounts.a.reason);
  check('b 被标记耗尽', st.accounts.b.exhausted === true);
  check('c 未耗尽', st.accounts.c.exhausted === false);
  check('跳过 b 直接换到 c', !!st.transition && st.transition.targetId === 'c', st.transition);

  let guard = 0;
  while (st.transition && guard++ < 12) await runEngineCron(env, eng);
  check('当班变为 c', st.dutyAccountId === 'c', st.dutyAccountId);
}

// ============================================================================
console.log('\n[5] 全部耗尽 → 停当班 + 熔断');
{
  resetWorld();
  const accounts = [acc('a'), acc('b')];
  seed(accounts, 'i-a');
  world.cdt['ak-a'] = [{ region: 'ap-southeast-1', gb: 190 }];
  world.cdt['ak-b'] = [{ region: 'ap-southeast-1', gb: 190 }];

  const cfg = baseConfig(accounts);
  const env = makeEnv(cfg);
  const st = { ...defaultState(), month: cstMonth(), dutyAccountId: 'a', dutySince: Date.now() };
  const eng = makeEngine(st);

  const r = await runEngineCron(env, eng);
  check('进入熔断', r.fused === true && !st.fault, r);
  check('当班实例被停机', world.stopCalls.includes('i-a'), world.stopCalls);
  check('熔断通知已发送', world.tg.some((t) => t.includes('全部额度耗尽')), world.tg);
  check('dutyAccountId 清空', st.dutyAccountId === null, st.dutyAccountId);

  const tgCount = world.tg.length;
  await runEngineCron(env, eng);
  check('熔断不重复通知', world.tg.length === tgCount, world.tg.length - tgCount);
  check('熔断不重复停机', world.stopCalls.length === 1, world.stopCalls);
}

// ============================================================================
console.log('\n[6] 保活');
{
  resetWorld();
  const accounts = [acc('a'), acc('b')];
  seed(accounts, 'i-a');
  const cfg = baseConfig(accounts);
  const env = makeEnv(cfg);
  const st = { ...defaultState(), month: cstMonth(), dutyAccountId: 'a', dutySince: Date.now() };
  const eng = makeEngine(st);

  // 当班实例意外停止
  world.ecs['i-a'].Status = 'Stopped';
  world.ecs['i-a'].StoppedMode = 'StopCharging';
  await runEngineCron(env, eng);
  check('当班停止后自动拉起', world.startCalls.includes('i-a'), world.startCalls);
  check('保活通知已发送', world.tg.some((t) => t.includes('保活启动')), world.tg);
  check('非当班实例不会被启动', !world.startCalls.includes('i-b'), world.startCalls);

  // 关掉保活后不再拉起
  world.startCalls = [];
  world.ecs['i-a'].Status = 'Stopped';
  st.fault = null;
  const cfg2 = baseConfig([acc('a', { keepAlive: false }), acc('b')]);
  const env2 = makeEnv(cfg2);
  const st2 = { ...defaultState(), month: cstMonth(), dutyAccountId: 'a', dutySince: Date.now() };
  await runEngineCron(env2, makeEngine(st2));
  check('保活关闭后不拉起', world.startCalls.length === 0, world.startCalls);
}

// ============================================================================
console.log('\n[7] 启动失败重试窗口');
{
  resetWorld();
  const accounts = [acc('a'), acc('b')];
  seed(accounts, 'i-b');            // b 当班，a 是备机
  world.ecs['i-a'].Status = 'Stopped';
  world.startResult['i-a'] = { code: 'OperationDenied.NoStock', message: '库存不足' };

  const cfg = baseConfig(accounts);
  const env = makeEnv(cfg);
  const st = { ...defaultState(), month: cstMonth(), dutyAccountId: 'b', dutySince: Date.now() };
  const eng = makeEngine(st);
  world.cdt['ak-b'] = [{ region: 'ap-southeast-1', gb: 190 }];   // b 超限 → 需要换到 a

  let r = await runEngineCron(env, eng);
  check('窗口内不锁死', !st.fault, st.fault);
  check('窗口内不重复停机', world.stopCalls.length === 0, world.stopCalls);
  check('窗口内返回重试中', r.retrying === true, r);

  timeOffset = 200000;
  r = await runEngineCron(env, eng);
  check('超限且备机起不来 → 强制停当班', world.stopCalls.includes('i-b'), world.stopCalls);
  check('发送超限停机报告', world.tg.some((t) => t.includes('超限停机报告')), world.tg);
  check('超限停机后不锁死', !st.fault, st.fault);

  const stops = world.stopCalls.length;
  timeOffset = 400000;
  await runEngineCron(env, eng);
  check('后续轮次不重复停机', world.stopCalls.length === stops, world.stopCalls);

  // 库存恢复：当班已空置，未耗尽的 a 会被直接保活拉起
  world.startResult['i-a'] = null;
  timeOffset = 460000;
  await runEngineCron(env, eng);
  check('库存恢复后自动拉起 a', world.startCalls.includes('i-a'), world.startCalls);
  check('当班切到 a', st.dutyAccountId === 'a', st.dutyAccountId);
}

// ============================================================================
console.log('\n[8] 按账单轮换');
{
  resetWorld();
  const accounts = [acc('a'), acc('b')];
  seed(accounts, 'i-a');
  world.bill['ak-a'] = 7.5;          // 超过 5 的账单阈值
  world.bill['ak-b'] = 1.0;

  const cfg = baseConfig(accounts);
  cfg.system.billThreshold = 5;
  const env = makeEnv(cfg);
  const st = { ...defaultState(), month: cstMonth(), dutyAccountId: 'a', dutySince: Date.now() };
  const eng = makeEngine(st);

  await runEngineCron(env, eng);
  check('a 因账单被标记耗尽', st.accounts.a.exhausted === true, st.accounts.a.reason);
  check('账单金额已记录', st.accounts.a.billAmount === 7.5, st.accounts.a.billAmount);
  check('开始换班到 b', !!st.transition && st.transition.targetId === 'b', st.transition);
}

// ============================================================================
console.log('\n[9] fail-closed');
{
  resetWorld();
  const accounts = [acc('a'), acc('b')];
  seed(accounts, 'i-a');
  world.failCdt.add('ak-b');         // b 的流量查不出来

  const cfg = baseConfig(accounts);
  const env = makeEnv(cfg);
  const st = { ...defaultState(), month: cstMonth(), dutyAccountId: 'a', dutySince: Date.now() };
  const eng = makeEngine(st);

  await runEngineCron(env, eng);
  check('流量查询失败 → 故障', st.fault && st.fault.code === 'CDT_QUERY_FAILED', st.fault);
  check('失败不当成 0GB', st.accounts.b?.trafficGb === undefined || st.accounts.b.trafficGb !== 0, st.accounts.b);

  // 故障期间不再动任何实例
  const starts = world.startCalls.length;
  await runEngineCron(env, eng);
  check('故障期间不再操作实例', world.startCalls.length === starts, world.startCalls);
}

{
  resetWorld();
  const accounts = [acc('a'), acc('b')];
  seed(accounts, 'i-a');
  const cfg = baseConfig(accounts);
  cfg.system.billThreshold = 5;
  // world.bill 为空 → DescribeInstanceBill 返回 NotApplicable
  const env = makeEnv(cfg);
  const st = { ...defaultState(), month: cstMonth(), dutyAccountId: 'a', dutySince: Date.now() };
  const eng = makeEngine(st);

  await runEngineCron(env, eng);
  check('启用了账单阈值但账单不可用 → 故障', st.fault && st.fault.code === 'BILL_QUERY_FAILED', st.fault);
}

// ============================================================================
console.log('\n[10] 实例被释放');
{
  resetWorld();
  const accounts = [acc('a'), acc('b')];
  seed(accounts, 'i-a');
  delete world.ecs['i-a'];           // 当班实例被抢占释放

  const cfg = baseConfig(accounts);
  const env = makeEnv(cfg);
  const st = { ...defaultState(), month: cstMonth(), dutyAccountId: 'a', dutySince: Date.now() };
  const eng = makeEngine(st);

  await runEngineCron(env, eng);
  check('实例不存在 → INSTANCE_NOT_FOUND', st.fault && st.fault.code === 'INSTANCE_NOT_FOUND', st.fault);
  check('不会反复尝试启动已释放实例', world.startCalls.length === 0, world.startCalls);
}

// ============================================================================
console.log('\n[11] 无实例时的默认状态');
{
  resetWorld();
  const cfg = baseConfig([]);
  const env = makeEnv(cfg);
  const st = defaultState();
  const eng = makeEngine(st);
  const r = await runEngineCron(env, eng);
  check('无实例时跳过而不是故障', r.skipped === true && !st.fault, r);
  check('默认配置没有实例', M.defaultConfig().accounts.length === 0);
}

// ============================================================================
console.log('\n[12] 账单分页与原价');
{
  resetWorld();
  const accounts = [acc('a'), acc('b')];
  seed(accounts, 'i-a');
  // 3 条记录、每页只返回 1 条 → 必须靠 NextToken 翻页才不会被少算
  world.bill['ak-a'] = {
    pageSize: 1,
    items: [
      { PretaxAmount: '1.00', PretaxGrossAmount: '10.00', Currency: 'USD', InstanceID: 'i-a' },
      { PretaxAmount: '2.00', PretaxGrossAmount: '20.00', Currency: 'USD', InstanceID: 'i-a' },
      { PretaxAmount: '3.50', PretaxGrossAmount: '35.00', Currency: 'USD', InstanceID: 'i-a' },
    ],
  };

  const cfg = baseConfig(accounts);
  cfg.system.billThreshold = 5;
  const env = makeEnv(cfg);
  const st = { ...defaultState(), month: cstMonth(), dutyAccountId: 'a', dutySince: Date.now() };
  const eng = makeEngine(st);
  await runEngineCron(env, eng);

  check('分页求和 1+2+3.5 = 6.5', st.accounts.a.billAmount === 6.5, st.accounts.a.billAmount);
  check('6.5 超过阈值 5 → 耗尽', st.accounts.a.exhausted === true, st.accounts.a.reason);
  // 原价不再存进 state（无人读），但 queryBill 仍在求和 PretaxGrossAmount，
  // 由诊断接口消费 —— 所以在这里验证它，避免这段逻辑失去覆盖。
  const probe = await probeBilling(env);
  check('诊断报告原价求和 65', probe.results[0].bills[0].gross === 65, probe.results[0].bills[0].gross);
}
{
  resetWorld();
  const accounts = [acc('a'), acc('b')];
  seed(accounts, 'i-a');
  // 免费额度内：应付 0，原价非 0
  world.bill['ak-a'] = { items: [{ PretaxAmount: '0', PretaxGrossAmount: '12.34', Currency: 'USD' }] };
  const cfg = baseConfig(accounts);
  cfg.system.billThreshold = 5;
  const env = makeEnv(cfg);
  const st = { ...defaultState(), month: cstMonth(), dutyAccountId: 'a', dutySince: Date.now() };
  await runEngineCron(env, makeEngine(st));
  check('免费额度内应付为 0', st.accounts.a.billAmount === 0, st.accounts.a.billAmount);
  check('应付 0 不触发账单熔断', st.accounts.a.exhausted === false, st.accounts.a.reason);
}

// ============================================================================
console.log('\n[13] 账单按账号级判定，实例级仅展示');
{
  resetWorld();
  const accounts = [acc('a'), acc('b')];
  seed(accounts, 'i-a');
  world.bill['ak-a'] = { items: [
    { InstanceID: 'i-a', PretaxAmount: '0.10', PretaxGrossAmount: '0.10', Currency: 'USD' },
    { InstanceID: 'i-other', PretaxAmount: '0.90', PretaxGrossAmount: '0.90', Currency: 'USD' },
  ] };

  const cfg = baseConfig(accounts);
  cfg.system.billThreshold = 0.5;      // 该实例只有 0.10，但账号级是 1.00
  const env = makeEnv(cfg);
  const st = { ...defaultState(), month: cstMonth(), dutyAccountId: 'a', dutySince: Date.now() };
  await runEngineCron(env, makeEngine(st));

  check('账号级金额 0.10+0.90=1.00', st.accounts.a.billAmount === 1, st.accounts.a.billAmount);
  check('实例级金额 0.10', st.accounts.a.billInstanceAmount === 0.1, st.accounts.a.billInstanceAmount);
  check('账号级超阈值 → 耗尽', st.accounts.a.exhausted === true, st.accounts.a.reason);
}
{
  // 反过来：账号级没超，实例级超了 → 不耗尽
  resetWorld();
  const accounts = [acc('a'), acc('b')];
  seed(accounts, 'i-a');
  world.bill['ak-a'] = { items: [
    { InstanceID: 'i-a', PretaxAmount: '0.40', PretaxGrossAmount: '0.40', Currency: 'USD' },
  ] };
  const cfg = baseConfig(accounts);
  cfg.system.billThreshold = 0.5;
  const env = makeEnv(cfg);
  const st = { ...defaultState(), month: cstMonth(), dutyAccountId: 'a', dutySince: Date.now() };
  await runEngineCron(env, makeEngine(st));
  check('账号级 0.40 < 0.5 → 不耗尽', st.accounts.a.exhausted === false, st.accounts.a.reason);
}

// ============================================================================
console.log('\n[14] 面板数据：实例状态 / 费用 / 余额');
{
  resetWorld();
  const accounts = [acc('a'), acc('b')];
  seed(accounts, 'i-a');          // i-a Running，i-b Stopped
  world.bill['ak-a'] = 1.25;
  world.bill['ak-b'] = 0.5;

  const cfg = baseConfig(accounts);
  const env = makeEnv(cfg);
  const st = { ...defaultState(), month: cstMonth(), dutyAccountId: 'a', dutySince: Date.now() };
  await runEngineCron(env, makeEngine(st));

  check('当班实例状态 Running', st.accounts.a.ecsStatus === 'Running', st.accounts.a.ecsStatus);
  check('非当班实例状态也采集', st.accounts.b.ecsStatus === 'Stopped', st.accounts.b.ecsStatus);
  // 停机模式决定是否真在省钱；公网 IP 用于核对 DDNS 实际指向
  check('非当班实例记录 StopCharging', st.accounts.b.ecsStoppedMode === 'StopCharging', st.accounts.b.ecsStoppedMode);
  check('当班实例公网 IP 已采集', st.accounts.a.ecsEip === '10.0.0.a', st.accounts.a.ecsEip);
  check('账号级费用已记录', st.accounts.a.billAmount === 1.25, st.accounts.a.billAmount);
  check('账户余额已记录', st.accounts.a.balance === '12.34', st.accounts.a.balance);
  check('余额币种已记录', st.accounts.a.balanceCurrency === 'USD', st.accounts.a.balanceCurrency);
  check('余额查询成功标记', st.accounts.a.balanceOk === true, st.accounts.a.balanceOk);
}
{
  // Stopped + KeepCharging 意味着机器还在计费，必须在面板上看得见
  resetWorld();
  const accounts = [acc('a'), acc('b')];
  seed(accounts, 'i-a');
  world.ecs['i-b'].StoppedMode = 'KeepCharging';
  const env = makeEnv(baseConfig(accounts));
  const st = { ...defaultState(), month: cstMonth(), dutyAccountId: 'a', dutySince: Date.now() };
  await runEngineCron(env, makeEngine(st));
  check('KeepCharging 被采集（面板会红色警示）',
    st.accounts.b.ecsStoppedMode === 'KeepCharging', st.accounts.b.ecsStoppedMode);
}

// ============================================================================
console.log('\n[15] EIP 诊断');
{
  resetWorld();
  const accounts = [acc('a')];
  seed(accounts, 'i-a');
  world.eips['ak-a'] = [
    { AllocationId: 'eip-1', IpAddress: '1.2.3.4', Status: 'InUse', InstanceId: 'i-a', InternetChargeType: 'PayByTraffic', Bandwidth: 5 },
    { AllocationId: 'eip-2', IpAddress: '1.2.3.5', Status: 'Available', InternetChargeType: 'PayByTraffic', Bandwidth: 5 },
    { AllocationId: 'eip-3', IpAddress: '1.2.3.6', Status: 'Available', InternetChargeType: 'PayByTraffic', Bandwidth: 5 },
  ];
  world.bill['ak-a'] = 1;
  const env = makeEnv(baseConfig(accounts));
  const r = await probeBilling(env);
  const eips = r.results[0].eips;
  check('EIP 列表返回 3 个', eips.count === 3, eips.count);
  check('识别出 2 个闲置 EIP', eips.idle === 2, eips.idle);
  check('绑定关系已记录', eips.eips[0].boundTo === 'i-a', eips.eips[0]);
  check('计费方式已记录', eips.eips[0].chargeType === 'PayByTraffic', eips.eips[0].chargeType);
  check('诊断含账单与余额', r.results[0].balance.amount === '12.34' && r.results[0].bills.length === 4, r.results[0].bills.length);
}
{
  resetWorld();
  const accounts = [acc('a')];
  seed(accounts, 'i-a');
  // 没有 ecs:DescribeEips 权限时不能把诊断搞崩
  world.eipsError = true;
  const env = makeEnv(baseConfig(accounts));
  const r = await probeBilling(env);
  check('EIP 查询失败时诊断仍返回', r.ok === true && r.results[0].eips !== undefined, r.results[0].eips);
}

// ============================================================================
console.log('\n[16] 保存配置不能丢掉面板未回传的字段');
{
  const { sanitizeConfig, defaultConfig } = M;
  const prev = defaultConfig();
  prev.system.dailyReportTime = '12:34';
  prev.system.billCheckMinutes = 45;
  prev.system.keepAlive = true;
  prev.accounts = [acc('a')];
  prev.cf.domainName = 'keep.example.com';
  prev.notify.tg.enabled = true;
  prev.notify.tg.chatId = '999';

  // 面板只回传了一小部分字段
  const next = sanitizeConfig({ system: { keepAlive: false } }, prev, {});

  check('未回传的 system 字段沿用已有值',
    next.system.dailyReportTime === '12:34' && next.system.billCheckMinutes === 45, next.system);
  check('回传的字段被更新', next.system.keepAlive === false, next.system.keepAlive);
  check('未回传的 cf 字段沿用已有值', next.cf.domainName === 'keep.example.com', next.cf);
  check('未回传的账号列表沿用已有值', next.accounts.length === 1 && next.accounts[0].sk === 'sk-a', next.accounts);
  check('未回传的通知开关沿用已有值', next.notify.tg.enabled === true && next.notify.tg.chatId === '999', next.notify.tg);

  const masked = sanitizeConfig({ accounts: [{ ...prev.accounts[0], sk: '******' }] }, prev, {});
  check('打码的密钥保留原值', masked.accounts[0].sk === 'sk-a', masked.accounts[0].sk);
}

// ============================================================================
console.log('\n[17] 实例被释放后的恢复路径');
{
  resetWorld();
  const accounts = [acc('a'), acc('b')];
  seed(accounts, 'i-a');
  delete world.ecs['i-a'];            // 当班实例被释放

  const cfg = baseConfig(accounts);
  const env = makeEnv(cfg);
  const st = { ...defaultState(), month: cstMonth(), dutyAccountId: 'a', dutySince: Date.now() };
  const eng = makeEngine(st);

  await runEngineCron(env, eng);
  check('实例缺失 → 保护状态', st.fault && st.fault.code === 'INSTANCE_NOT_FOUND', st.fault);
  check('故障记录了归属账号', st.fault.accountId === 'a', st.fault.accountId);

  // 实例还在配置里 → 必须拒绝清除，并告诉用户怎么办
  const r = await reconcileAndClearFault(env, cfg, st, eng);
  check('实例仍在配置中时拒绝清除', r.cleared === false, r);
  check('提示指向设置页面', (r.notes || []).join(' ').includes('设置'), r.notes);
  check('仍处于保护状态', !!st.fault, st.fault);
}
{
  // 用户把被释放的实例从配置里删掉 → 自动解除，不再需要人工点按钮
  resetWorld();
  const a = acc('a');
  const b = acc('b');
  seed([a, b], 'i-b');
  delete world.ecs['i-a'];

  const cfg = baseConfig([a, b]);
  const env = makeEnv(cfg);
  const st = { ...defaultState(), month: cstMonth(), dutyAccountId: 'a', dutySince: Date.now() };
  const eng = makeEngine(st);
  await runEngineCron(env, eng);
  check('先进入保护状态', st.fault && st.fault.code === 'INSTANCE_NOT_FOUND', st.fault?.code);

  const cfg2 = baseConfig([b]);
  const env2 = makeEnv(cfg2);
  const eng2 = makeEngine(st);
  const r2 = await runEngineCron(env2, eng2);
  check('实例移出配置后自动解除保护', !st.fault, st.fault);
  check('解除后继续正常调度', r2.halted !== true, r2);
}
{
  // 手动对账：配置里已无缺失实例时应当允许清除
  resetWorld();
  const a = acc('a');
  const b = acc('b');
  seed([a, b], 'i-b');
  const cfg2 = baseConfig([b]);
  const env2 = makeEnv(cfg2);
  const st = {
    ...defaultState(), month: cstMonth(),
    fault: { code: 'INSTANCE_NOT_FOUND', at: new Date().toISOString(), message: '实例已释放', accountId: 'a' },
  };
  const r = await reconcileAndClearFault(env2, cfg2, st, makeEngine(st));
  check('对账后允许清除', r.cleared === true, r);
  check('故障已清空', st.fault === null, st.fault);
}

// ============================================================================
// 页面是由模板字符串生成的，客户端脚本里的任何 \n 之类转义都会被提前解释掉，
// 结果就是把 '...' 拆成两行 → 整段脚本 SyntaxError → 页面白屏。
console.log('\n[18] 生成的页面必须能跑');
{
  const html = renderHtml();
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  check('页面包含客户端脚本', blocks.length >= 1, blocks.length);

  const client = blocks[blocks.length - 1];
  let err = null;
  try { new Function(client); } catch (e) { err = e.message; }
  check('客户端脚本语法正确', !err, err);

  check('模板插值只用在 REGIONS', (html.match(/\$\{/g) || []).length === 0, html.match(/\$\{/g));
  check('地域列表已展开', html.includes('ap-southeast-1') && html.includes('新加坡'), null);
  check('故障提示已内置', html.includes('INSTANCE_NOT_FOUND') && html.includes('请到「设置」'), null);
  check('页面含公网 IP 与停机模式行', html.includes('公网 IP') && html.includes('停机模式'), null);
  check('页面含“仍在计费”警示文案', html.includes('仍在计费'), null);
}

// ============================================================================
// 把客户端脚本真的跑起来，看它产出的 HTML —— 比“源码里有这个字符串”强得多。
console.log('\n[19] 实例卡片真的把停机模式渲染出来');
{
  const html = renderHtml();
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const client = blocks[blocks.length - 1];

  const els = {};
  const savedDoc = globalThis.document;
  const savedFetch = globalThis.fetch;
  globalThis.document = {
    getElementById: (id) => (els[id] || (els[id] = {
      innerHTML: '', textContent: '', value: '', checked: false,
      classList: { add() {}, remove() {}, toggle() {} },
    })),
    querySelectorAll: () => [],
  };
  // 永不完结的 promise：既阻断 init 里的网络请求，又不会在测试后继续动 DOM
  globalThis.fetch = () => new Promise(() => {});

  const api = new Function(client + '\nreturn { renderAccounts, setState: (s) => { STATE = s; } };')();

  const base = {
    id: 'a', name: '实例1', regionId: 'cn-hongkong', instanceId: 'i-a', siteType: 'international',
    remark: '', trafficClass: 'intl', threshold: 188, quota: 200, billThreshold: 0, keepAlive: true,
    duty: true, exhausted: false, reason: '', trafficGb: 1, breakdown: [],
    billAccountAmount: 0, billInstanceAmount: 0, billCurrency: 'USD',
    balance: '0', balanceCurrency: 'USD', balanceOk: true, configured: true, ecsError: null,
  };
  const card = (over) => {
    api.setState({ accounts: [{ ...base, ...over }], fused: false, fault: null, logs: [] });
    api.renderAccounts();
    return els.accountGrid.innerHTML;
  };

  const keep = card({ ecsStatus: 'Stopped', ecsStoppedMode: 'KeepCharging', ecsEip: '1.2.3.4', eip: '1.2.3.4' });
  check('Stopped+KeepCharging 渲染出“仍在计费”', keep.includes('仍在计费'), null);

  const ok = card({ ecsStatus: 'Stopped', ecsStoppedMode: 'StopCharging', ecsEip: '1.2.3.4', eip: '1.2.3.4' });
  check('Stopped+StopCharging 渲染出“节省停机”且无警示', ok.includes('节省停机') && !ok.includes('仍在计费'), null);

  const run = card({ ecsStatus: 'Running', ecsStoppedMode: 'Not-applicable', ecsEip: '1.2.3.4', eip: '9.9.9.9' });
  check('Running 时不显示停机模式行', !run.includes('停机模式'), null);
  check('EIP 与配置不一致时告警', run.includes('与配置的 EIP 不一致'), null);

  const same = card({ ecsStatus: 'Running', ecsStoppedMode: 'Not-applicable', ecsEip: '1.2.3.4', eip: '1.2.3.4' });
  check('EIP 一致时不告警', !same.includes('与配置的 EIP 不一致'), null);

  globalThis.document = savedDoc;
  globalThis.fetch = savedFetch;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// KV 调用次数审计台：用真实 getEngine + 计数 STATE_KV，实测每轮 cron 的读写次数。
// 只读测量，不改 worker.js。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve('.');
const TESTMOD = path.join(ROOT, 'temp', 'worker-audit.mjs');
fs.copyFileSync(path.join(ROOT, process.env.CDT_SRC || 'worker.js'), TESTMOD);

globalThis.DurableObject = class DurableObject {};

function json(o) {
  return { ok: true, status: 200, async json() { return o; }, async text() { return JSON.stringify(o); } };
}
const GB = 1024 ** 3;
const world = { ecs: {}, cdt: {}, dns: { content: '1.1.1.1' }, tg: [] };

globalThis.fetch = async (url, init) => {
  const u = new URL(url);
  const form = new URLSearchParams(init?.body || '');
  const action = form.get('Action');
  if (u.hostname.endsWith('aliyuncs.com')) {
    const ak = form.get('AccessKeyId');
    if (action === 'ListCdtInternetTraffic') {
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
    if (action === 'StartInstance') { world.ecs[form.get('InstanceId')].Status = 'Running'; return json({ RequestId: 'r' }); }
    if (action === 'StopInstance') {
      const id = form.get('InstanceId');
      world.ecs[id].Status = 'Stopped';
      world.ecs[id].StoppedMode = form.get('StoppedMode') || 'StopCharging';
      return json({ RequestId: 'r' });
    }
    if (action === 'QueryAccountBalance') return json({ Code: '200', Data: { AvailableAmount: '12.34', Currency: 'USD' } });
    return json({});
  }
  if (u.hostname === 'api.cloudflare.com') {
    if (init?.method === 'PUT') world.dns.content = JSON.parse(init.body).content;
    return json({ success: true, result: { content: world.dns.content } });
  }
  if (u.hostname === 'api.telegram.org') { world.tg.push(JSON.parse(init.body).text); return json({ ok: true }); }
  throw new Error('unexpected fetch ' + url);
};

const M = await import(pathToFileURL(TESTMOD).href);
const { runEngineCron, executeCron, defaultState } = M;

function cstMonth() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' })
    .format(new Date()).slice(0, 7);
}

function acc(id, over) {
  return {
    id, name: '账号 ' + id.toUpperCase(), ak: 'ak-' + id, sk: 'sk-' + id,
    regionId: 'ap-southeast-1', instanceId: 'i-' + id, eip: '', siteType: 'international',
    trafficThresholdGb: null, billThreshold: null, keepAlive: null,
    scheduleEnabled: false, startTime: '00:00', stopTime: '23:59', remark: '', ...over,
  };
}

function baseConfig(accounts, groups) {
  const cfg = {
    adminPass: 'x',
    system: {
      trafficThresholdChina: 18, trafficThresholdIntl: 188, billThreshold: 0,
      rotationIntervalMinutes: 0, keepAlive: true, dnsDrainSeconds: 0,
      transitionTimeoutMinutes: 10, startRetrySeconds: 180, billCheckMinutes: 30,
      balanceSync: true, dailyReport: false, dailyReportTime: '23:58',
    },
    accounts,
    notify: { tg: { enabled: true, botToken: 'bt', chatId: 'ci' } },
  };
  if (groups) cfg.groups = groups;
  else cfg.cf = { apiToken: 't', zoneId: 'z', recordId: 'r', domainName: 'd.example.com' };
  return cfg;
}

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

// 计数 KV：真实的 get/put/delete 计数
function makeCountingEnv(cfg, state) {
  const store = { app_config: JSON.stringify(cfg), app_logs: '[]', state_v2: JSON.stringify(state) };
  const ops = { get: 0, put: 0, del: 0, list: 0 };
  const perKey = { get: {}, put: {} };
  const env = {
    store, ops, perKey,
    STATE_KV: {
      async get(k, opts) {
        ops.get++; perKey.get[k] = (perKey.get[k] || 0) + 1;
        const v = store[k];
        if (v === undefined) return null;
        return opts?.type === 'json' ? JSON.parse(v) : v;
      },
      async put(k, v) { ops.put++; perKey.put[k] = (perKey.put[k] || 0) + 1; store[k] = v; },
      async delete(k) { ops.del++; delete store[k]; },
      async list() { ops.list++; return { keys: [] }; },
    },
  };
  return env;
}

const lines = [];
function report(title, ops, perKey, extra) {
  lines.push(`${title}: read=${ops.get} write=${ops.put} delete=${ops.del} list=${ops.list}`);
  lines.push(`   read 明细 ${JSON.stringify(perKey.get)}  write 明细 ${JSON.stringify(perKey.put)}${extra ? '  ' + extra : ''}`);
}

// ---------------------------------------------------------------- A 默认组·冷启动
// 注意：这里只给 legacy 的 cfg.cf，getConfig 会把它迁移成一个“已启用 DDNS”的默认分组，
// 因此本轮会选当班 + 对齐解析（并写 2 次 state_v2 + 2 条日志），不是稳态。稳态请看 A2。
{
  world.ecs = {}; world.cdt = {}; world.tg = [];
  const accounts = [acc('a', { scheduleEnabled: true }), acc('b', { scheduleEnabled: true })];
  seed(accounts, 'i-a');
  const cfg = baseConfig(accounts);
  const st = { ...defaultState(), month: cstMonth(), lastBillCheck: Date.now() };
  const env = makeCountingEnv(cfg, st);
  const r = await runEngineCron(env, await import(pathToFileURL(TESTMOD).href).then((m) => m.getEngine(env)));
  report('A 默认组·冷启动（legacy cf 迁移为 DDNS：选当班 + 对齐解析）', env.ops, env.perKey, JSON.stringify(r));
}

// ---------------------------------------------------------------- B DDNS+轮换组·稳态（当班 Running）
{
  world.ecs = {}; world.cdt = {}; world.tg = [];
  const groups = [{ id: 'g1', name: 'G1', rotationIntervalMinutes: 60, primaryAccountId: null,
    cf: { enabled: true, apiToken: 't', zoneId: 'z', recordId: 'r', domainName: 'd.example.com' } }];
  const accounts = [acc('a', { groupId: 'g1' }), acc('b', { groupId: 'g1' })];
  seed(accounts, 'i-a');
  const cfg = baseConfig(accounts, groups);
  const st = { ...defaultState(), month: cstMonth(), lastBillCheck: Date.now(),
    groups: { g1: { dutyAccountId: 'a', dutySince: Date.now(), rotationIndex: 0, transition: null, startAttempt: null, fusedMonth: cstMonth() } } };
  const env = makeCountingEnv(cfg, st);
  const mod = await import(pathToFileURL(TESTMOD).href);
  const r = await runEngineCron(env, mod.getEngine(env));
  report('B DDNS+轮换组·稳态（当班 Running）', env.ops, env.perKey, JSON.stringify(r));
}

// ---------------------------------------------------------------- C 同 B，但轮换到期 → 开始换班
{
  world.ecs = {}; world.cdt = {}; world.tg = [];
  const groups = [{ id: 'g1', name: 'G1', rotationIntervalMinutes: 60, primaryAccountId: null,
    cf: { enabled: true, apiToken: 't', zoneId: 'z', recordId: 'r', domainName: 'd.example.com' } }];
  const accounts = [acc('a', { groupId: 'g1' }), acc('b', { groupId: 'g1' })];
  seed(accounts, 'i-a');
  const cfg = baseConfig(accounts, groups);
  const st = { ...defaultState(), month: cstMonth(), lastBillCheck: Date.now(),
    groups: { g1: { dutyAccountId: 'a', dutySince: Date.now() - 61 * 60000, rotationIndex: 0, transition: null, startAttempt: null, fusedMonth: cstMonth() } } };
  const env = makeCountingEnv(cfg, st);
  const mod = await import(pathToFileURL(TESTMOD).href);
  const r = await runEngineCron(env, mod.getEngine(env));
  report('C 轮换到期·发起换班（1 轮）', env.ops, env.perKey, JSON.stringify(r));
}

// ---------------------------------------------------------------- D executeCron 稳态（含日报检查）
{
  world.ecs = {}; world.cdt = {}; world.tg = [];
  const groups = [{ id: 'g1', name: 'G1', rotationIntervalMinutes: 60, primaryAccountId: null,
    cf: { enabled: true, apiToken: 't', zoneId: 'z', recordId: 'r', domainName: 'd.example.com' } }];
  const accounts = [acc('a', { groupId: 'g1' }), acc('b', { groupId: 'g1' })];
  seed(accounts, 'i-a');
  const cfg = baseConfig(accounts, groups);
  const st = { ...defaultState(), month: cstMonth(), lastBillCheck: Date.now(),
    groups: { g1: { dutyAccountId: 'a', dutySince: Date.now(), rotationIndex: 0, transition: null, startAttempt: null, fusedMonth: cstMonth() } } };
  const env = makeCountingEnv(cfg, st);
  const r = await executeCron(env);
  report('D executeCron·稳态（未到日报时间）', env.ops, env.perKey, JSON.stringify(r));
}

// ---------------------------------------------------------------- E executeCron 稳态 + 日报触发
{
  world.ecs = {}; world.cdt = {}; world.tg = [];
  const groups = [{ id: 'g1', name: 'G1', rotationIntervalMinutes: 60, primaryAccountId: null,
    cf: { enabled: true, apiToken: 't', zoneId: 'z', recordId: 'r', domainName: 'd.example.com' } }];
  const accounts = [acc('a', { groupId: 'g1' }), acc('b', { groupId: 'g1' })];
  seed(accounts, 'i-a');
  const cfg = baseConfig(accounts, groups);
  cfg.system.dailyReport = true;
  cfg.system.dailyReportTime = '00:00';
  const st = { ...defaultState(), month: cstMonth(), lastBillCheck: Date.now(),
    groups: { g1: { dutyAccountId: 'a', dutySince: Date.now(), rotationIndex: 0, transition: null, startAttempt: null, fusedMonth: cstMonth() } } };
  const env = makeCountingEnv(cfg, st);
  const r = await executeCron(env);
  report('E executeCron·稳态 + 日报触发', env.ops, env.perKey, JSON.stringify(r));
}

// ---------------------------------------------------------------- F 两分组同时稳态（放大系数验证）
{
  world.ecs = {}; world.cdt = {}; world.tg = [];
  const groups = [
    { id: 'g1', name: 'G1', rotationIntervalMinutes: 60, primaryAccountId: null, cf: { enabled: true, apiToken: 't', zoneId: 'z', recordId: 'r', domainName: 'd1.example.com' } },
    { id: 'g2', name: 'G2', rotationIntervalMinutes: 60, primaryAccountId: null, cf: { enabled: true, apiToken: 't', zoneId: 'z', recordId: 'r', domainName: 'd2.example.com' } },
  ];
  const accounts = [acc('a', { groupId: 'g1' }), acc('b', { groupId: 'g1' }), acc('c', { groupId: 'g2' }), acc('d', { groupId: 'g2' })];
  seed(accounts, 'i-a');
  world.ecs['i-c'].Status = 'Running'; world.ecs['i-c'].StoppedMode = 'Not-applicable';
  const cfg = baseConfig(accounts, groups);
  const st = { ...defaultState(), month: cstMonth(), lastBillCheck: Date.now(),
    groups: {
      g1: { dutyAccountId: 'a', dutySince: Date.now(), rotationIndex: 0, transition: null, startAttempt: null, fusedMonth: cstMonth() },
      g2: { dutyAccountId: 'c', dutySince: Date.now(), rotationIndex: 0, transition: null, startAttempt: null, fusedMonth: cstMonth() },
    } };
  const env = makeCountingEnv(cfg, st);
  const mod = await import(pathToFileURL(TESTMOD).href);
  const r = await runEngineCron(env, mod.getEngine(env));
  report('F 两个 DDNS 分组·同时稳态', env.ops, env.perKey, JSON.stringify(r));
}

// ---------------------------------------------------------------- A2 默认组（无 DDNS）·真稳态
{
  world.ecs = {}; world.cdt = {}; world.tg = [];
  const groups = [{ id: 'group-default', name: '默认分组', rotationIntervalMinutes: 0, primaryAccountId: '', cf: { enabled: false } }];
  const accounts = [acc('a', { groupId: 'group-default', scheduleEnabled: true }), acc('b', { groupId: 'group-default', scheduleEnabled: true })];
  seed(accounts, 'i-a');
  world.ecs['i-b'].Status = 'Running'; world.ecs['i-b'].StoppedMode = 'Not-applicable';
  const cfg = baseConfig(accounts, groups);
  const st = { ...defaultState(), month: cstMonth(), lastBillCheck: Date.now() };
  const env = makeCountingEnv(cfg, st);
  const mod = await import(pathToFileURL(TESTMOD).href);
  const r = await runEngineCron(env, mod.getEngine(env));
  report('A2 默认组(无DDNS)·真稳态（2 台都 Running）', env.ops, env.perKey, JSON.stringify(r));
}

// ---------------------------------------------------------------- G DDNS+轮换组·连跑两轮取第二轮
{
  world.ecs = {}; world.cdt = {}; world.tg = [];
  const groups = [{ id: 'g1', name: 'G1', rotationIntervalMinutes: 60, primaryAccountId: null,
    cf: { enabled: true, apiToken: 't', zoneId: 'z', recordId: 'r', domainName: 'd.example.com' } }];
  const accounts = [acc('a', { groupId: 'g1' }), acc('b', { groupId: 'g1' })];
  seed(accounts, 'i-a');
  const cfg = baseConfig(accounts, groups);
  const st = { ...defaultState(), month: cstMonth(), lastBillCheck: Date.now(),
    groups: { g1: { dutyAccountId: 'a', dutySince: Date.now(), rotationIndex: 0, transition: null, startAttempt: null, fusedMonth: cstMonth() } } };
  const env = makeCountingEnv(cfg, st);
  const mod = await import(pathToFileURL(TESTMOD).href);
  await runEngineCron(env, mod.getEngine(env));
  env.ops.get = 0; env.ops.put = 0; env.ops.del = 0; env.perKey.get = {}; env.perKey.put = {};
  const r = await runEngineCron(env, mod.getEngine(env));
  report('G DDNS+轮换组·第二轮（真稳态）', env.ops, env.perKey, JSON.stringify(r));
}

// ---------------------------------------------------------------- H DDNS 无轮换组·连跑两轮取第二轮
{
  world.ecs = {}; world.cdt = {}; world.tg = [];
  const groups = [{ id: 'g1', name: 'G1', rotationIntervalMinutes: 0, primaryAccountId: 'a',
    cf: { enabled: true, apiToken: 't', zoneId: 'z', recordId: 'r', domainName: 'd.example.com' } }];
  const accounts = [acc('a', { groupId: 'g1' }), acc('b', { groupId: 'g1' })];
  seed(accounts, 'i-a');
  const cfg = baseConfig(accounts, groups);
  const st = { ...defaultState(), month: cstMonth(), lastBillCheck: Date.now() };
  const env = makeCountingEnv(cfg, st);
  const mod = await import(pathToFileURL(TESTMOD).href);
  await runEngineCron(env, mod.getEngine(env));
  env.ops.get = 0; env.ops.put = 0; env.ops.del = 0; env.perKey.get = {}; env.perKey.put = {};
  const r = await runEngineCron(env, mod.getEngine(env));
  report('H DDNS无轮换组·第二轮（真稳态）', env.ops, env.perKey, JSON.stringify(r));
}

console.log('\n=== KV 调用实测（当前 worker.js；每次改动后重跑，数字应保持 2 读 1 写） ===');
for (const l of lines) console.log(l);

/** v1.1.0 新增能力：模糊匹配、媒体检测、观察期、黑名单、指令、答题、按群覆盖、双密码。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import { normalizeSettings, effectiveJoin, effectiveModeration } from '../lib/config.js';
import { matchRules, Moderation } from '../lib/moderation.js';
import { mention } from '../lib/qq-api.js';
import { handleJoinRequest, handleMemberAdd, handleQuizAnswer, tickQuizzes } from '../lib/join.js';
import { AuthStore, LoginGuard, SessionStore, checkPasswordPolicy } from '../lib/auth.js';
import { isBasicPatch } from '../lib/api.js';
import { readDeviceInfo, formatDeviceInfo } from '../lib/device.js';
import { LIMITS } from '../lib/defaults.js';

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'qqg-feat-'));
  const store = new Store(dir);
  return { store, dir, cleanup: () => { store.dispose(); rmSync(dir, { recursive: true, force: true }); } };
}

const baseMod = {
  enabled: true,
  action: 'warn',
  keywords: ['傻逼', '广告'],
  regexes: [],
  detectLinks: false,
  linkWhitelist: [],
  spam: { enabled: false, windowSec: 10, maxMessages: 5 },
  escalation: { enabled: false, violations: 3, windowHours: 24, action: 'kick' },
  fuzzy: { enabled: true, extras: [] },
  media: { detectImages: true, detectCards: true, adKeywords: ['扫码', '加微信'] },
  cooldownSec: 0,
};

test('模糊变体：拆字/空格/谐音可以命中', () => {
  const hits = matchRules('你个傻 b', baseMod);
  assert.ok(hits.some((x) => x.ruleId === 'fuzzy' && x.pattern.includes('傻逼')));
});

test('模糊变体：ASCII 短词不会命中英文单词内部', () => {
  const mod = { ...baseMod, keywords: ['sb'] };
  assert.equal(matchRules('this is a test', mod).length, 0);
  assert.equal(matchRules('你个 sb', mod).length, 1);
});

test('图片 + 广告词判定为广告；单独图片不触发', () => {
  const ad = matchRules('扫码领福利', baseMod, { hasImage: true });
  assert.ok(ad.some((x) => x.ruleId === 'media'));
  const plain = matchRules('今天天气不错', baseMod, { hasImage: true });
  assert.equal(plain.length, 0);
});

test('观察期内图片与链接按观察期动作处理', () => {
  const observation = { enabled: true, minutes: 10, action: 'mute', blockLinks: true, blockImages: true };
  const img = matchRules('随手一张图', baseMod, { hasImage: true, observed: true, observation });
  assert.ok(img.some((x) => x.ruleId === 'observe' && x.action === 'mute'));
  const link = matchRules('看这个 https://spam.example.com', baseMod, { observed: true, observation });
  assert.ok(link.some((x) => x.ruleId === 'observe'));
});

test('卡片/名片消息可被识别', () => {
  const hits = matchRules('你好', baseMod, { hasCard: true });
  assert.ok(hits.some((x) => x.ruleId === 'media'));
});

test('信任成员豁免处置', async () => {
  const { store, cleanup } = makeStore();
  store.saveSettings({ moderation: { ...baseMod, trustedUsers: [{ uid: 'u1', name: '管理员' }] } });
  let sent = 0;
  const client = { sendGroupText: async () => { sent += 1; return { ok: true }; } };
  const mod = new Moderation({ store, getClient: () => client, logger: console });
  const r = await mod.handleMessage({ gid: 'g1', uid: 'u1', text: '你个傻逼' });
  assert.equal(r.handled, false);
  assert.equal(sent, 0);
  cleanup();
});

test('累计违规达到阈值后踢出并加入黑名单', async () => {
  const { store, cleanup } = makeStore();
  store.saveSettings({
    moderation: {
      ...baseMod,
      action: 'warn',
      blacklist: { enabled: true, threshold: 2, windowDays: 7, addToGroupBlacklist: true },
    },
  });
  const kicks = [];
  const client = {
    sendGroupText: async () => ({ ok: true }),
    removeMembers: async (gid, uids, addBlack) => { kicks.push({ gid, uids, addBlack }); return { ok: true }; },
  };
  const mod = new Moderation({ store, getClient: () => client, logger: console });
  await mod.handleMessage({ gid: 'g1', uid: 'u9', name: '广告号', text: '广告' });
  await mod.handleMessage({ gid: 'g1', uid: 'u9', name: '广告号', text: '广告' });
  assert.equal(kicks.length, 1);
  assert.deepEqual(kicks[0].uids, ['u9']);
  assert.equal(kicks[0].addBlack, true);
  assert.equal(store.isBlacklisted('g1', 'u9'), true);
  cleanup();
});

test('群指令只有白名单可用', async () => {
  const { store, cleanup } = makeStore();
  store.saveSettings({
    commands: { enabled: true, prefix: '/', allowUsers: ['admin1'], ruleText: '群规' },
    moderation: { ...baseMod, keywords: [] },
  });
  const sent = [];
  const client = { sendGroupText: async (gid, text) => { sent.push(text); return { ok: true }; } };
  const mod = new Moderation({ store, getClient: () => client, logger: console });
  const ok = await mod.handleMessage({ gid: 'g1', uid: 'admin1', text: '/warn <@u2> 刷屏', mentionsBot: true });
  assert.equal(ok.handled, true);
  assert.match(sent[0], /u2/);
  const denied = await mod.handleMessage({ gid: 'g1', uid: 'u3', text: '/warn <@u2> 刷屏', mentionsBot: true });
  assert.equal(denied.handled, true);
  assert.equal(denied.action, 'guest-warn');
  // 非白名单只会收到越权警告，不会真的执行警告指令
  assert.ok(!sent[1].includes('u2'));
  // 没有 @ 机器人时，即使白名单也不执行（新建实例，排除“免 @ 续聊”窗口影响）
  const fresh = new Moderation({ store, getClient: () => client, logger: console });
  const noAt = await fresh.handleMessage({ gid: 'g1', uid: 'admin1', text: '/warn <@u2> 刷屏', mentionsBot: false });
  assert.equal(noAt.handled, false);
  cleanup();
});

test('按群覆盖：显式设为默认值也不会被当成继承', () => {
  const { value } = normalizeSettings({
    moderation: { action: 'kick' },
    groups: { g1: { moderation: { action: 'warn' }, join: { observation: { minutes: 3 } } } },
  });
  assert.equal(effectiveModeration(value, 'g1').action, 'warn');
  assert.equal(effectiveJoin(value, 'g1').observation.minutes, 3);
  assert.equal(effectiveModeration(value, 'g2').action, 'kick');
});

test('黑名单成员再次申请会自动拒绝', async () => {
  const { store, cleanup } = makeStore();
  store.addBlacklist('g1', 'u8', { reason: '测试' });
  const calls = [];
  const client = { approveJoinRequest: async (...args) => { calls.push(args); return { ok: true }; } };
  const r = await handleJoinRequest({
    group_openid: 'g1', member_openid: 'u8', join_request_id: 'j1', username: '小明', verify_info: { method: 1 },
  }, { store, getClient: () => client });
  assert.equal(r.decision, 'decline');
  assert.equal(calls.length, 1);
  cleanup();
});

test('入群答题：答对后发送欢迎并清除状态', async () => {
  const { store, cleanup } = makeStore();
  store.saveSettings({
    join: {
      quiz: { enabled: true, timeoutSec: 60, maxAttempts: 3, action: 'kick', askBeforeWelcome: true, questions: [{ q: '1+1=?', a: '2' }] },
      welcome: { enabled: true, template: '欢迎 {user}', variants: [] },
    },
  });
  const sent = [];
  const client = {
    sendGroupText: async (gid, text) => { sent.push(text); return { ok: true }; },
    removeMembers: async () => ({ ok: true }),
  };
  const deps = { store, getClient: () => client, appId: 'app1' };
  await handleMemberAdd({ group_openid: 'g1', member_openid: 'u5', username: '新人' }, deps);
  assert.ok(store.getQuiz('g1', 'u5'));
  assert.match(sent[0], /1\+1=\?/);
  assert.ok(store.isObserved('g1', 'u5'));
  const r = await handleQuizAnswer({ gid: 'g1', uid: 'u5', text: '2' }, deps);
  assert.equal(r.action, 'quiz-pass');
  assert.equal(store.getQuiz('g1', 'u5'), null);
  assert.match(sent[sent.length - 1], /欢迎/);
  cleanup();
});

test('入群答题：超时执行动作并清理', async () => {
  const { store, cleanup } = makeStore();
  store.saveSettings({
    join: { quiz: { enabled: true, timeoutSec: 30, maxAttempts: 2, action: 'kick', askBeforeWelcome: true, questions: [{ q: '问题', a: '答案' }] } },
  });
  const removed = [];
  const client = {
    sendGroupText: async () => ({ ok: true }),
    removeMembers: async (gid, uids) => { removed.push({ gid, uids }); return { ok: true }; },
  };
  const deps = { store, getClient: () => client, appId: 'app1' };
  await handleMemberAdd({ group_openid: 'g1', member_openid: 'u6' }, deps);
  const quiz = store.getQuiz('g1', 'u6');
  store.setQuiz('g1', 'u6', { ...quiz, expiresAt: Date.now() - 1 });
  await tickQuizzes(deps);
  assert.equal(removed.length, 1);
  assert.equal(store.getQuiz('g1', 'u6'), null);
  cleanup();
});

test('首次设密、密码策略、会话与登录限流', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqg-auth-'));
  const auth = new AuthStore(dir);
  assert.equal(auth.status().initialized, false);
  assert.equal(auth.verify('xujianan1029'), null);
  assert.equal(auth.verify('Linux'), null);

  // 密码策略：长度、字母、数字必须同时满足
  assert.equal(checkPasswordPolicy('short1').ok, false);
  assert.equal(checkPasswordPolicy('abcdefgh').ok, false);
  assert.equal(checkPasswordPolicy('12345678').ok, false);
  assert.equal(checkPasswordPolicy('Admin 1234').ok, false);
  assert.equal(checkPasswordPolicy('Admin1234').ok, true);

  // 首次初始化：两个角色密码不能相同，必须符合策略
  assert.equal(auth.setup({ adminPassword: 'Admin1234', operatorPassword: 'Admin1234' }).ok, false);
  assert.equal(auth.setup({ adminPassword: 'abcdefgh', operatorPassword: 'Operator123' }).ok, false);
  assert.equal(auth.setup({ adminPassword: 'Admin1234', operatorPassword: 'Operator123' }).ok, true);
  assert.equal(auth.status().initialized, true);
  assert.equal(auth.verify('Admin1234'), 'admin');
  assert.equal(auth.verify('Operator123'), 'operator');
  assert.equal(auth.setup({ adminPassword: 'Other1234', operatorPassword: 'Other5678' }).ok, false);

  // 初始化结果落盘，重启后仍可登录
  const again = new AuthStore(dir);
  assert.equal(again.status().initialized, true);
  assert.equal(again.verify('Admin1234'), 'admin');

  // 修改密码同样要求字母 + 数字，且不能与另一角色相同
  assert.equal(auth.changePassword('operator', 'newpass').ok, false);
  assert.equal(auth.changePassword('operator', 'Admin1234').ok, false);
  assert.equal(auth.changePassword('operator', 'Newpass123').ok, true);
  assert.equal(auth.verify('Newpass123', 'operator'), 'operator');
  assert.equal(auth.verify('Operator123', 'operator'), null);

  const sessions = new SessionStore({ ttlMs: 1000 });
  const s = sessions.create('admin', '127.0.0.1');
  assert.equal(sessions.get(s.token)?.role, 'admin');
  assert.equal(sessions.get('nope'), null);
  sessions.dispose();

  const guard = new LoginGuard();
  for (let i = 0; i < 5; i++) guard.fail('1.1.1.1');
  assert.equal(guard.check('1.1.1.1').ok, false);
  rmSync(dir, { recursive: true, force: true });
});

test('基础补丁判断：词与欢迎语可改，其余不可', () => {
  assert.equal(isBasicPatch({ moderation: { keywords: ['x'] } }), true);
  assert.equal(isBasicPatch({ join: { welcome: { template: 'hi' } } }), true);
  assert.equal(isBasicPatch({ groups: { g1: { moderation: { keywords: ['x'] } } } }), true);
  assert.equal(isBasicPatch({ groups: { g1: { moderation: { regexes: ['x'] } } } }), false);
  assert.equal(isBasicPatch({ moderation: { action: 'kick' } }), false);
  assert.equal(isBasicPatch({ groups: { g1: { join: { quiz: { enabled: true } } } } }), false);
});

test('通知对象必须昵称与 QQ 号同时匹配', () => {
  const { store, cleanup } = makeStore();
  store.upsertMember('g1', 'u1', { name: '群主' });
  assert.equal(store.findMemberByUidAndName('g1', 'u1', '群主')?.uid, 'u1');
  // 昵称匹配但号码不匹配
  assert.equal(store.findMemberByUidAndName('g1', 'u2', '群主'), null);
  // 号码匹配但昵称不匹配
  assert.equal(store.findMemberByUidAndName('g1', 'u1', '别人'), null);
  // 缺少任一项都不匹配
  assert.equal(store.findMemberByUidAndName('g1', '', '群主'), null);
  assert.equal(store.findMemberByUidAndName('g1', 'u1', ''), null);
  cleanup();
});

test('设备信息包含版本、CPU 与内存', () => {
  const d = readDeviceInfo();
  assert.ok(d.pluginVersion);
  assert.ok(d.webuiVersion);
  assert.ok(d.systemVersion);
  assert.ok(d.cpuModel);
  assert.ok(d.cpuCores > 0);
  assert.ok(d.memTotal > 0);
  assert.equal(typeof d.cpuUsage, 'number');
  assert.equal(typeof d.memUsage, 'number');
});

test('群聊 @ 使用官方 qqbot-at-user 标签', () => {
  assert.equal(mention('abc123'), '<qqbot-at-user id="abc123" />');
  assert.equal(mention('bad"id'), '<qqbot-at-user id="badid" />');
  assert.equal(mention(''), '');
});

test('入群拒绝理由可保存并带默认值', () => {
  const custom = normalizeSettings({ join: { rejectReason: '请完善申请资料' } });
  assert.equal(custom.value.join.rejectReason, '请完善申请资料');
  const fallback = normalizeSettings({ join: {} });
  assert.equal(fallback.value.join.rejectReason, '暂不符合入群条件');
});

test('设备信息排版包含设备、系统、CPU、内存与版本', () => {
  const text = formatDeviceInfo({
    hostName: 'DESKTOP-T',
    systemVersion: 'Windows 11 10.0.22631 x64',
    cpuModel: 'Test CPU',
    cpuCores: 8,
    cpuUsage: 23.4,
    memUsed: 8 * 1024 ** 3,
    memTotal: 16 * 1024 ** 3,
    memUsage: 50,
    pluginVersion: '1.5.5',
    nodeVersion: 'v24.9.0',
    processUptimeMs: 3 * 3600_000 + 12 * 60_000,
    systemUptimeMs: 2 * 86_400_000,
  });
  assert.ok(text.includes('DESKTOP-T'));
  assert.ok(text.includes('Windows 11'));
  assert.ok(text.includes('Test CPU'));
  assert.ok(text.includes('占用 23.4%'));
  assert.ok(text.includes('8.0 GB / 16.0 GB（50.0%）'));
  assert.ok(text.includes('v1.5.5'));
  assert.ok(text.includes('3小时12分'));
  assert.ok(text.includes('2天'));
});

test('/设备：白名单成员可查询，正文带 @ 标签也能识别', async () => {
  const { store, cleanup } = makeStore();
  store.saveSettings({ commands: { enabled: false, allowUsers: ['u1'] } });
  const sent = [];
  const client = { sendGroupText: async (_gid, text) => { sent.push(text); return { ok: true }; } };
  const mod = new Moderation({ store, getClient: () => client, logger: console });
  const r = await mod.handleMessage({
    gid: 'g1', uid: 'u1', name: '管理员',
    text: '<qqbot-at-user id="app1" /> /设备', mentionsBot: true,
  });
  assert.equal(r.action, 'command-device');
  assert.ok(sent[0].includes('【设备信息】'));
  assert.ok(sent[0].includes('插件：v'));
  assert.ok(sent[0].includes('CPU：'));
  assert.ok(sent[0].includes('内存：'));
  assert.ok(store.readAudit(10).some((x) => x.action === 'device'));
  cleanup();
});

test('/设备：非白名单成员拿不到设备信息', async () => {
  const { store, cleanup } = makeStore();
  store.saveSettings({ commands: { enabled: true, allowUsers: ['u1'] } });
  const sent = [];
  const client = { sendGroupText: async (_gid, text) => { sent.push(text); return { ok: true }; } };
  const mod = new Moderation({ store, getClient: () => client, logger: console });
  const r = await mod.handleMessage({
    gid: 'g1', uid: 'u9', name: '路人', text: '/设备', mentionsBot: true,
  });
  assert.notEqual(r.action, 'command-device');
  assert.ok(!sent.some((x) => x.includes('【设备信息】')));
  cleanup();
});

test('/设备：免 @ 续聊窗口内也能查询', async () => {
  const { store, cleanup } = makeStore();
  store.saveSettings({ commands: { enabled: true, allowUsers: ['u1'] } });
  const sent = [];
  const client = { sendGroupText: async (_gid, text) => { sent.push(text); return { ok: true }; } };
  const mod = new Moderation({ store, getClient: () => client, logger: console });
  await mod.handleMessage({ gid: 'g1', uid: 'u1', name: '管理员', text: '你好', mentionsBot: true });
  const r = await mod.handleMessage({ gid: 'g1', uid: 'u1', name: '管理员', text: '/设备', mentionsBot: false });
  assert.equal(r.action, 'command-device');
  assert.ok(sent.some((x) => x.includes('【设备信息】')));
  cleanup();
});

test('/重启：需要二次确认，确认后才执行并带上发起人信息', async () => {
  const { store, cleanup } = makeStore();
  store.saveSettings({ commands: { enabled: true, allowUsers: ['u1'] } });
  const sent = [];
  let called = 0;
  let payload = null;
  const client = { sendGroupText: async (_gid, text) => { sent.push(text); return { ok: true }; } };
  const mod = new Moderation({
    store, getClient: () => client, logger: console,
    restartService: async (info) => { called += 1; payload = info; },
  });

  // 第一次：只进入确认窗口，不重启
  const first = await mod.handleMessage({
    gid: 'g1', uid: 'u1', name: '管理员', text: '/restart', mentionsBot: true,
  });
  assert.equal(first.action, 'command-restart-confirm');
  assert.ok(sent[0].includes('确认'));
  assert.equal(called, 0);

  // 第二次：确认执行
  const second = await mod.handleMessage({
    gid: 'g1', uid: 'u1', name: '管理员', text: '/重启', mentionsBot: true,
  });
  assert.equal(second.action, 'command-restart');
  assert.ok(sent[1].includes('已确认'));
  assert.equal(called, 0);
  await new Promise((resolve) => { setTimeout(resolve, LIMITS.restartDelayMs + 300); });
  assert.equal(called, 1);
  assert.deepEqual(payload, { gid: 'g1', uid: 'u1', name: '管理员' });
  assert.ok(store.readAudit(10).some((x) => x.action === 'restart'));
  cleanup();
});

test('/确认：可用确认别名，无待确认操作时明确告知', async () => {
  const { store, cleanup } = makeStore();
  store.saveSettings({ commands: { enabled: true, allowUsers: ['u1'] } });
  const sent = [];
  let called = 0;
  const client = { sendGroupText: async (_gid, text) => { sent.push(text); return { ok: true }; } };
  const mod = new Moderation({
    store, getClient: () => client, logger: console,
    restartService: async () => { called += 1; },
  });

  const empty = await mod.handleMessage({
    gid: 'g1', uid: 'u1', name: '管理员', text: '/确认', mentionsBot: true,
  });
  assert.equal(empty.action, 'command-restart-expired');
  assert.ok(sent[0].includes('没有待确认'));

  await mod.handleMessage({ gid: 'g1', uid: 'u1', name: '管理员', text: '/重启', mentionsBot: true });
  const ok = await mod.handleMessage({ gid: 'g1', uid: 'u1', name: '管理员', text: '/确认', mentionsBot: true });
  assert.equal(ok.action, 'command-restart');
  await new Promise((resolve) => { setTimeout(resolve, LIMITS.restartDelayMs + 300); });
  assert.equal(called, 1);
  cleanup();
});

test('/重启：确认前执行其他指令会撤销待确认状态', async () => {
  const { store, cleanup } = makeStore();
  store.saveSettings({
    commands: { enabled: true, allowUsers: ['u1'], ruleText: '群规' },
  });
  let called = 0;
  const client = { sendGroupText: async () => ({ ok: true }) };
  const mod = new Moderation({
    store, getClient: () => client, logger: console,
    restartService: async () => { called += 1; },
  });
  await mod.handleMessage({ gid: 'g1', uid: 'u1', name: '管理员', text: '/重启', mentionsBot: true });
  await mod.handleMessage({ gid: 'g1', uid: 'u1', name: '管理员', text: '/rule', mentionsBot: true });
  const again = await mod.handleMessage({
    gid: 'g1', uid: 'u1', name: '管理员', text: '/重启', mentionsBot: true,
  });
  assert.equal(again.action, 'command-restart-confirm');
  await new Promise((resolve) => { setTimeout(resolve, LIMITS.restartDelayMs + 300); });
  assert.equal(called, 0);
  cleanup();
});

test('/重启：restartConfirmSec=0 时免确认直接执行', async () => {
  const { store, cleanup } = makeStore();
  store.saveSettings({
    commands: { enabled: true, allowUsers: ['u1'], restartConfirmSec: 0 },
  });
  let called = 0;
  const client = { sendGroupText: async () => ({ ok: true }) };
  const mod = new Moderation({
    store, getClient: () => client, logger: console,
    restartService: async () => { called += 1; },
  });
  const r = await mod.handleMessage({
    gid: 'g1', uid: 'u1', name: '管理员', text: '/重启', mentionsBot: true,
  });
  assert.equal(r.action, 'command-restart');
  await new Promise((resolve) => { setTimeout(resolve, LIMITS.restartDelayMs + 300); });
  assert.equal(called, 1);
  cleanup();
});

test('/重启：非白名单成员不会触发重启', async () => {
  const { store, cleanup } = makeStore();
  store.saveSettings({ commands: { enabled: true, allowUsers: ['u1'] } });
  let called = 0;
  const client = { sendGroupText: async () => ({ ok: true }) };
  const mod = new Moderation({
    store, getClient: () => client, logger: console,
    restartService: async () => { called += 1; },
  });
  const r = await mod.handleMessage({
    gid: 'g1', uid: 'u9', name: '路人', text: '/重启', mentionsBot: true,
  });
  assert.notEqual(r.action, 'command-restart');
  await new Promise((resolve) => { setTimeout(resolve, LIMITS.restartDelayMs + 300); });
  assert.equal(called, 0);
  cleanup();
});

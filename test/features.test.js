/** v1.1.0 新增能力：模糊匹配、媒体检测、观察期、黑名单、指令、答题、按群覆盖、双密码。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import { normalizeSettings, effectiveJoin, effectiveModeration } from '../lib/config.js';
import { matchRules, Moderation } from '../lib/moderation.js';
import { handleJoinRequest, handleMemberAdd, handleQuizAnswer, tickQuizzes } from '../lib/join.js';
import { AuthStore, LoginGuard, SessionStore, checkPasswordPolicy } from '../lib/auth.js';
import { isBasicPatch } from '../lib/api.js';

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
  const ok = await mod.handleMessage({ gid: 'g1', uid: 'admin1', text: '/warn <@u2> 刷屏' });
  assert.equal(ok.handled, true);
  assert.match(sent[0], /u2/);
  const denied = await mod.handleMessage({ gid: 'g1', uid: 'u3', text: '/warn <@u2> 刷屏' });
  assert.equal(denied.handled, false);
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

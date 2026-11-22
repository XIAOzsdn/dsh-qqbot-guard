import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import { Moderation, decideAction, findUnsafeLink, matchRules, sanitizeContent } from '../lib/moderation.js';

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'qqg-mod-'));
  const store = new Store(dir);
  return { store, dir, cleanup: () => { store.dispose(); rmSync(dir, { recursive: true, force: true }); } };
}

test('内容清洗去掉 @ 与表情标签', () => {
  assert.equal(sanitizeContent('<@abc123> 你  好 <emoji:1>'), '你 好');
});

test('违规词命中（大小写无关）', () => {
  const mod = { keywords: ['傻逼', 'NMSL'], regexes: [], detectLinks: false, linkWhitelist: [], spam: { enabled: false } };
  const hits = matchRules('<@u1> 你个NMSL', mod);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].ruleId, 'keyword');
});

test('正则规则命中', () => {
  const mod = { keywords: [], regexes: ['(垃圾|废物){2,}'], detectLinks: false, linkWhitelist: [], spam: { enabled: false } };
  assert.equal(matchRules('垃圾垃圾', mod).length, 1);
});

test('链接白名单', () => {
  assert.equal(findUnsafeLink('看看 https://evil.example.com/x', ['qq.com']).host, 'evil.example.com');
  assert.equal(findUnsafeLink('看看 https://a.qq.com/x', ['qq.com']), null);
});

test('刷屏计数命中', () => {
  const mod = { keywords: [], regexes: [], detectLinks: false, linkWhitelist: [], spam: { enabled: true, windowSec: 10, maxMessages: 3 } };
  assert.equal(matchRules('你好', mod, { spamCount: 3 }).some((x) => x.ruleId === 'spam'), true);
  assert.equal(matchRules('你好', mod, { spamCount: 2 }).length, 0);
});

test('升级动作在第 N 次违规时生效', () => {
  const mod = { action: 'warn', escalation: { enabled: true, violations: 3, action: 'kick' } };
  const hits = [{ ruleId: 'keyword', pattern: 'x', confidence: 0.9 }];
  assert.equal(decideAction(hits, 0, mod).action, 'warn');
  assert.equal(decideAction(hits, 2, mod).action, 'kick');
});

test('警告动作会发消息并计数', async () => {
  const { store, cleanup } = makeStore();
  const sent = [];
  const client = {
    sendGroupText: async (gid, text) => { sent.push({ gid, text }); return { ok: true }; },
  };
  const mod = new Moderation({ store, getClient: () => client, logger: console });
  const r = await mod.handleMessage({ gid: 'g1', uid: 'u1', name: '小王', text: '你个傻逼' });
  assert.equal(r.handled, true);
  assert.equal(r.action, 'warn');
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /u1/);
  assert.equal(store.state.counters.warns, 1);
  assert.ok(store.readAudit(1)[0].detail.includes('违规词'));
  cleanup();
});

test('禁言失败时降级为警告', async () => {
  const { store, cleanup } = makeStore();
  store.saveSettings({ moderation: { action: 'mute', muteSeconds: 60 } });
  const client = {
    setMemberMute: async () => ({ ok: false, err: { code: '40103004', human: '不能操作该成员' } }),
    sendGroupText: async () => ({ ok: true }),
  };
  const mod = new Moderation({ store, getClient: () => client, logger: console });
  const r = await mod.handleMessage({ gid: 'g1', uid: 'u2', text: '傻逼' });
  assert.equal(r.action, 'warn');
  assert.equal(r.error, '40103004');
  assert.equal(store.state.counters.warns, 1);
  cleanup();
});

test('冷却期内不重复处置', async () => {
  const { store, cleanup } = makeStore();
  store.saveSettings({ moderation: { action: 'warn', cooldownSec: 60 } });
  let count = 0;
  const client = { sendGroupText: async () => { count += 1; return { ok: true }; } };
  const mod = new Moderation({ store, getClient: () => client, logger: console });
  await mod.handleMessage({ gid: 'g1', uid: 'u3', text: '傻逼' });
  const second = await mod.handleMessage({ gid: 'g1', uid: 'u3', text: '傻逼' });
  assert.equal(second.action, 'cooldown');
  assert.equal(count, 1);
  cleanup();
});

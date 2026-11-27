/** 自然语言快捷关键词：学习、重排、兜底匹配与部署方提醒。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import {
  KEYWORD_LIMIT, STARTER_KEYWORDS, buildKeywordSet, currentKeywords, matchKeyword,
  maybeReviewKeywords, normalizeKeywords, reviewState,
} from '../lib/natural-keywords.js';
import { handleNaturalCommand } from '../lib/natural.js';

function makeStore(settings = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qqg-nkw-'));
  const store = new Store(dir);
  store.saveSettings(settings);
  return { store, dir, cleanup: () => { store.dispose(); rmSync(dir, { recursive: true, force: true }); } };
}

const DAY = 86_400_000;

test('关键词表：去重、非法项丢弃、最多 15 个', () => {
  const list = [
    { phrase: '禁言', action: 'mute' },
    { phrase: '禁言', action: 'mute' },
    { phrase: '  ', action: 'blank' },
  ];
  for (let i = 0; i < 40; i += 1) list.push({ phrase: `说法${i}`, action: `action-${i}` });
  const out = normalizeKeywords(list);
  assert.equal(out.length, KEYWORD_LIMIT);
  assert.equal(out.filter((k) => k.action === 'mute').length, 1);
  assert.equal(out.every((k) => k.phrase && k.action), true);
});

test('关键词表：默认给新手 8 个，且都在 15 个以内', () => {
  assert.equal(STARTER_KEYWORDS.length, 8);
  const cur = currentKeywords({ natural: { keywords: [] } });
  assert.deepEqual(
    cur.map((k) => k.action).sort(),
    ['count', 'kick', 'list-members', 'mute', 'unmute', 'warn', 'whole-ban', 'whole-unban'],
  );
  assert.ok(cur.length <= KEYWORD_LIMIT);
});

test('关键词表：按最近用量重排，不足用新手词补齐', () => {
  const now = Date.now();
  const records = [
    ...Array.from({ length: 5 }, () => ({ action: 'list-members', at: now - DAY })),
    ...Array.from({ length: 3 }, () => ({ action: 'add-keyword', at: now - 2 * DAY })),
    ...Array.from({ length: 1 }, () => ({ action: 'unmute', at: now - 3 * DAY })),
  ];
  const out = buildKeywordSet({ records, now });
  assert.equal(out[0].action, 'list-members');
  assert.equal(out[1].action, 'add-keyword');
  assert.ok(out.length <= KEYWORD_LIMIT);
  assert.ok(out.some((k) => k.action === 'mute'), '新人关键词兜底');
});

test('重排时机：最近一周用量达到阈值即提前重排', () => {
  const { store, cleanup } = makeStore();
  const now = Date.now();
  store.touchNaturalReview(now - DAY);
  for (let i = 0; i < 101; i += 1) store.noteNaturalUsage({ action: 'count', source: 'ai', at: now - 1000 });
  const st = reviewState({ settings: store.settings, store, now });
  assert.equal(st.due, true);
  assert.equal(st.reason, 'volume');
  assert.equal(st.weekCount, 101);
  assert.equal(st.weekly, 100, '默认阈值是 100 次 / 7 天');
  cleanup();
});

test('重排周期：按周配置，最多 10 周，老配置的天数自动换算', () => {
  assert.equal(reviewState({ settings: { natural: {} }, store: null }).reviewWeeks, 3, '默认 3 周');
  assert.equal(reviewState({ settings: { natural: { reviewWeeks: 10 } }, store: null }).reviewWeeks, 10);
  assert.equal(reviewState({ settings: { natural: { reviewWeeks: 99 } }, store: null }).reviewWeeks, 10, '最多 10 周');
  assert.equal(reviewState({ settings: { natural: { reviewWeeks: 0 } }, store: null }).reviewWeeks, 3, '非法值回落默认');
  assert.equal(reviewState({ settings: { natural: { reviewDays: 21 } }, store: null }).reviewWeeks, 3, '旧配置 21 天 = 3 周');
  assert.equal(reviewState({ settings: { natural: { reviewDays: 70 } }, store: null }).reviewWeeks, 10);
});

test('重排时机：周期到期才重排，首次只起算', () => {
  const { store, cleanup } = makeStore({ natural: { reviewWeeks: 3 } });
  const now = Date.now();
  const first = maybeReviewKeywords({ settings: store.settings, store, now });
  assert.equal(first.reviewed, false, '首次只起算，不立刻换词');
  assert.equal(first.started, true);
  store.noteNaturalUsage({ action: 'count', source: 'ai', at: now });

  const fresh = reviewState({ settings: store.settings, store, now });
  assert.equal(fresh.due, false);

  store.touchNaturalReview(now - 22 * DAY);
  const due = reviewState({ settings: store.settings, store, now });
  assert.equal(due.due, true);
  assert.equal(due.reason, 'period');

  const out = maybeReviewKeywords({ settings: store.settings, store, now });
  assert.equal(out.reviewed, true);
  assert.ok(Array.isArray(out.keywords) && out.keywords.length > 0);
  cleanup();
});

test('兜底匹配：取最长命中的关键词', () => {
  const kws = [
    { phrase: '禁言', action: 'mute' },
    { phrase: '解除禁言', action: 'unmute' },
    { phrase: '列出群成员', action: 'list-members' },
  ];
  assert.equal(matchKeyword('把某人解除禁言', kws).action, 'unmute');
  assert.equal(matchKeyword('给我禁言他 10 分钟', kws).action, 'mute');
  assert.equal(matchKeyword('列出群成员名单', kws).action, 'list-members');
  assert.equal(matchKeyword('今天天气不错', kws), null);
});

test('兜底匹配：全体禁言 / 解除全体禁言 不被“禁言”子串抢先', () => {
  const kws = currentKeywords({ natural: { keywords: [] } });
  assert.equal(matchKeyword('全体禁言', kws).action, 'whole-ban', '有“全体禁言”短语');
  assert.equal(matchKeyword('解除全体禁言', kws).action, 'whole-unban', '有“解除全体禁言”短语');
  assert.equal(matchKeyword('禁言小明 10 分钟', kws).action, 'mute', '普通禁言仍归 mute');
});

test('AI 失败兜底：说“全员禁言”也执行全体禁言（本地强信号接管）', async () => {
  // 关键词表对同一动作只保留一个说法（"全体禁言"），matchKeyword 子串匹配把
  // "全员禁言" 归成 mute；但本地规则把"全员"看作全体禁言的强信号，必须接管。
  const { store, cleanup } = makeStore({ ai: { enabled: true } });
  try {
    const sent = [];
    const client = { sendGroupText: async (_gid, t) => { sent.push(t); return { ok: true }; } };
    const actions = [];
    const ai = { parseIntent: async () => ({ ok: false, code: 'TIMEOUT' }) };
    const r = await handleNaturalCommand({
      gid: 'g1', uid: 'u1', name: '管理员', text: '开启全员禁言', msgId: 'm1',
      settings: store.settings, store, client, ai,
      handleOps: async (action) => { actions.push(action); return { handled: true, action, ok: true }; },
    });
    assert.equal(r.handled, true);
    assert.deepEqual(actions, ['whole-ban']);
  } finally {
    cleanup();
  }
});

test('AI 决策：命中关键词也要先过 AI（AI 可用时）', async () => {
  const { store, cleanup } = makeStore({ ai: { enabled: true } });
  const sent = [];
  const client = { sendGroupText: async (_gid, text) => { sent.push(text); return { ok: true }; } };
  let aiCalls = 0;
  const ai = {
    parseIntent: async () => { aiCalls += 1; return { ok: true, intent: { action: 'help', target: '' } }; },
  };
  const out = await handleNaturalCommand({
    gid: 'g1', uid: 'u1', name: '管理员', text: '查人数', settings: store.settings, store, client, ai,
    mentionUids: [], saveSettings: async () => ({ ok: true }),
  });
  assert.equal(aiCalls, 1, '即使命中关键词，也必须先问 AI');
  assert.equal(out.action, 'help');
  cleanup();
});

test('入群审批关键词直接给出真的列表，不拿违规词糊弄', async () => {
  const { store, cleanup } = makeStore({ ai: { enabled: true }, join: { approveKeywords: ['学生'] } });
  const sent = [];
  const client = { sendGroupText: async (_gid, text) => { sent.push(text); return { ok: true }; } };
  let aiCalls = 0;
  const ai = { parseIntent: async () => { aiCalls += 1; return { ok: true, intent: { action: 'list-keywords' } }; } };
  const out = await handleNaturalCommand({
    gid: 'g1', uid: 'u1', name: '青衫故人', text: '列出入群审批通过关键词', settings: store.settings, store, client, ai,
    mentionUids: [], saveSettings: async () => ({ ok: true }),
  });
  // 即使 AI 误判成违规词，也要按上下文纠正为“入群通过关键词”
  assert.equal(out.action, 'admin-list-join-keywords');
  assert.equal(aiCalls, 1);
  assert.ok(sent[0].includes('入群自动通过'));
  assert.ok(sent[0].includes('学生'));
  cleanup();
});

test('用量到阈值时重排关键词并 @ 部署方提醒', async () => {
  const { store, cleanup } = makeStore({ ai: { enabled: true }, natural: { notifyUid: 'u9', weeklyCommands: 100 } });
  const now = Date.now();
  store.touchNaturalReview(now - DAY);
  for (let i = 0; i < 100; i += 1) store.noteNaturalUsage({ action: 'list-members', source: 'ai', at: now - 1000 });
  const sent = [];
  const client = {
    sendGroupText: async (_gid, text) => { sent.push(text); return { ok: true }; },
    getGroupInfo: async () => ({ ok: true, data: { group_member_num: 3 } }),
  };
  const captured = [];
  const ai = { parseIntent: async () => ({ ok: false, code: 'TIMEOUT' }) };
  const out = await handleNaturalCommand({
    gid: 'g1', uid: 'u1', name: '管理员', text: '查人数', settings: store.settings, store, client, ai,
    mentionUids: [],
    saveSettings: async (patch) => {
      captured.push(patch);
      store.saveSettings({ ...store.settings, natural: { ...store.settings.natural, ...patch.natural } });
      return { ok: true };
    },
  });
  assert.equal(out.action, 'count');
  const patch = captured.find((p) => p.natural?.keywords);
  assert.ok(patch, '应把重排后的关键词写回设置');
  assert.ok(patch.natural.keywords.length <= KEYWORD_LIMIT);
  const notice = sent.find((t) => t.includes('重排快捷关键词'));
  assert.ok(notice, '应发出部署方提醒');
  assert.ok(notice.includes('u9'), '提醒应 @ 配置的部署方');
  cleanup();
});

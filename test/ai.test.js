/** AI 辅助审核：输出校验、DSH/OpenAI 两种接入、失败回退与业务接线。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import { normalizeSettings } from '../lib/config.js';
import { AiGuard, parseVerdict, parseQuizReply, parseGradeReply, solveArithmetic, JOIN_VERDICTS } from '../lib/ai.js';
import { Moderation } from '../lib/moderation.js';
import { handleJoinRequest, handleMemberAdd, handleQuizAnswer, aiJoinActive } from '../lib/join.js';

function makeStore(settings = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qqg-ai-'));
  const store = new Store(dir);
  store.saveSettings(settings);
  return { store, dir, cleanup: () => { store.dispose(); rmSync(dir, { recursive: true, force: true }); } };
}

function fakeLlm(reply) {
  return {
    stream() {
      return (async function* gen() {
        yield { type: 'text-delta', index: 0, text: reply.slice(0, 6) };
        yield { type: 'text-delta', index: 0, text: reply.slice(6) };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
}

const AI_ON = {
  ai: {
    enabled: true,
    provider: 'dsh',
    minConfidence: 0.7,
    moderation: { enabled: true, mode: 'auto', minChars: 2, maxPerMinute: 60 },
    join: { enabled: true, mode: 'auto' },
  },
};

test('模型输出校验：代码块、置信度百分比、非法 verdict', () => {
  const ok = parseVerdict('```json\n{"verdict":"AD","confidence":0.9,"reason":"广告"}\n```');
  assert.equal(ok.ok, true);
  assert.equal(ok.verdict, 'ad');
  assert.equal(ok.confidence, 0.9);

  const percent = parseVerdict('{"verdict":"abuse","confidence":85,"reason":"辱骂"}');
  assert.equal(percent.confidence, 0.85);

  assert.equal(parseVerdict('{"verdict":"fuck","confidence":0.9}').ok, false);
  assert.equal(parseVerdict('{"verdict":"ok","confidence":"高"}').ok, false);
  assert.equal(parseVerdict('没有 JSON').ok, false);
});

test('AI 配置归一化与默认值', () => {
  const { value } = normalizeSettings({ ai: { enabled: true, provider: '未知', minConfidence: 5 } });
  assert.equal(value.ai.enabled, true);
  assert.equal(value.ai.provider, 'dsh');
  assert.equal(value.ai.minConfidence, 1);
  assert.equal(value.ai.moderation.mode, 'auto');
  assert.equal(value.ai.join.mode, 'auto');
  assert.equal(value.ai.vision.enabled, true);
  assert.equal(value.ai.vision.maxImages, 3);
  assert.equal(value.ai.vision.maxBytes, 3 * 1024 * 1024);
  assert.equal(value.ai.join.schedule.mode, 'always');
  assert.equal(value.ai.quiz.mode, 'mixed');
  assert.equal(value.ai.quiz.switchAfterFails, 2);
});

test('DSH 调用参数：system 单独传、内容用 blocks、采用最低推理强度', async () => {
  const { store, cleanup } = makeStore(AI_ON);
  let seen = null;
  const ai = new AiGuard({
    store,
    logger: console,
    dsh: {
      llm: {
        resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }),
        stream: (options) => {
          seen = options;
          return (async function* gen() {
            yield { type: 'text-delta', index: 0, text: '{"verdict":"ok","confidence":0.9,"reason":"正常"}' };
            yield { type: 'finish', reason: { kind: 'stop' } };
          })();
        },
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    },
  });
  const r = await ai.judgeMessage({ gid: 'g1', uid: 'u1', text: '今天天气不错' });
  assert.equal(r.ok, true);
  assert.equal(typeof seen.system, 'string');
  assert.equal(seen.messages.length, 1);
  assert.equal(seen.messages[0].role, 'user');
  assert.ok(Array.isArray(seen.messages[0].content));
  assert.equal(seen.messages[0].content[0].type, 'text');
  assert.equal(seen.reasoningEffort, 'low');
  cleanup();
});

test('DSH 通道：适配器失败时返回错误码而不是“返回为空”', async () => {
  const { store, cleanup } = makeStore(AI_ON);
  const ai = new AiGuard({
    store,
    logger: console,
    dsh: {
      llm: {
        stream: () => (async function* gen() {
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'MISSING_CREDENTIAL', message: '未配置密钥' } } };
        })(),
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    },
  });
  const r = await ai.judgeMessage({ gid: 'g1', uid: 'u1', text: '扫码进群领福利' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'AI_ERROR');
  assert.match(String(r.error), /MISSING_CREDENTIAL/u);
  cleanup();
});

test('DSH 接入：读取默认模型、判定并缓存', async () => {
  const { store, cleanup } = makeStore(AI_ON);
  const ai = new AiGuard({
    store,
    logger: console,
    dsh: {
      llm: fakeLlm('{"verdict":"ad","confidence":0.92,"reason":"拉人广告"}'),
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) },
    },
  });
  const first = await ai.judgeMessage({ gid: 'g1', uid: 'u1', text: '扫码进群领福利' });
  assert.equal(first.ok, true);
  assert.equal(first.verdict, 'ad');
  assert.equal(first.provider, 'deepseek');
  assert.equal(first.model, 'deepseek-chat');

  const second = await ai.judgeMessage({ gid: 'g1', uid: 'u1', text: '扫码进群领福利' });
  assert.equal(second.cached, true);
  cleanup();
});

test('OpenAI 兼容接入：请求地址与鉴权头正确', async () => {
  const { store, cleanup } = makeStore({
    ai: {
      enabled: true,
      provider: 'openai',
      baseUrl: 'https://example.test/v1',
      apiKey: 'sk-test',
      model: 'test-model',
      moderation: { enabled: true, mode: 'auto', minChars: 2, maxPerMinute: 60 },
    },
  });
  const original = globalThis.fetch;
  let seenUrl = '';
  let seenAuth = '';
  globalThis.fetch = async (url, init) => {
    seenUrl = String(url);
    seenAuth = String(init?.headers?.authorization || '');
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '{"verdict":"spam","confidence":0.8,"reason":"刷屏"}' } }] }),
    };
  };
  try {
    const ai = new AiGuard({ store, logger: console });
    const r = await ai.judgeMessage({ gid: 'g1', uid: 'u1', text: '重复发同样的内容' });
    assert.equal(r.ok, true);
    assert.equal(r.verdict, 'spam');
    assert.equal(seenUrl, 'https://example.test/v1/chat/completions');
    assert.equal(seenAuth, 'Bearer sk-test');
  } finally {
    globalThis.fetch = original;
    cleanup();
  }
});

test('模型不可用时静默回退，不抛异常', async () => {
  const { store, cleanup } = makeStore({
    ai: {
      enabled: true,
      provider: 'openai',
      baseUrl: 'https://example.test/v1',
      model: 'test-model',
      moderation: { enabled: true, mode: 'auto', minChars: 2, maxPerMinute: 60 },
    },
  });
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    const ai = new AiGuard({ store, logger: console });
    const r = await ai.judgeMessage({ gid: 'g1', uid: 'u1', text: '随便说点什么' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'AI_ERROR');
  } finally {
    globalThis.fetch = original;
    cleanup();
  }
});

test('违规防护：AI 命中后按配置动作处置并写审计', async () => {
  const { store, cleanup } = makeStore({
    ...AI_ON,
    moderation: {
      enabled: true,
      action: 'warn',
      cooldownSec: 0,
      keywords: [],
      regexes: [],
      warnTemplate: '{user} 请注意群规',
      spam: { enabled: false },
      escalation: { enabled: false },
      media: { detectImages: false, detectCards: false },
      fuzzy: { enabled: false },
    },
  });
  const sent = [];
  const client = { sendGroupText: async (_gid, text) => { sent.push(text); return { ok: true }; } };
  const ai = { judgeMessage: async () => ({ ok: true, verdict: 'ad', confidence: 0.95, reason: '广告', provider: 'dsh', model: 'm' }) };
  const mod = new Moderation({ store, getClient: () => client, logger: console, ai });
  const r = await mod.handleMessage({ gid: 'g1', uid: 'u9', name: '广告号', text: '这里有福利，快来' });
  assert.equal(r.handled, true);
  assert.equal(r.ruleId, 'ai');
  assert.equal(sent.length, 1);
  assert.ok(store.readAudit(10).some((x) => x.kind === 'ai' && x.action === 'ai-detect'));
  cleanup();
});

test('入群审批：AI 自动拒绝并调用官方审批', async () => {
  const { store, cleanup } = makeStore({
    ...AI_ON,
    ai: { ...AI_ON.ai, join: { enabled: true, mode: 'auto' } },
    join: { autoApprove: false, autoDeclineRisk: false, approveKeywords: [], declineKeywords: [] },
  });
  const calls = [];
  const client = { approveJoinRequest: async (...args) => { calls.push(args); return { ok: true }; } };
  const ai = { judgeJoin: async () => ({ ok: true, verdict: 'decline', confidence: 0.93, reason: '广告号', provider: 'dsh', model: 'm' }) };
  const r = await handleJoinRequest({
    group_openid: 'g1', member_openid: 'u8', join_request_id: 'j1', username: '推广小王', verify_info: { method: 1 },
  }, { store, getClient: () => client, ai });
  assert.equal(r.decision, 'decline');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2], 'decline');
  cleanup();
});

test('图片审核：OpenAI 视觉通道携带 data URI', async () => {
  const { store, cleanup } = makeStore({
    ai: {
      enabled: true,
      provider: 'openai',
      baseUrl: 'https://example.test/v1',
      apiKey: 'k',
      model: 'vision-model',
      vision: { enabled: true, maxBytes: 1024 * 1024 },
      moderation: { enabled: true, mode: 'auto', analyzeImages: true, minChars: 4, maxPerMinute: 60 },
    },
  });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  let chatBody = null;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/chat/completions')) {
      chatBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '{"verdict":"abuse","confidence":0.9,"reason":"图片辱骂"}' } }] }),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => String(png.length) },
      arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.length),
    };
  };
  try {
    const ai = new AiGuard({ store, logger: console });
    const r = await ai.judgeMessage({
      gid: 'g1', uid: 'u1', text: '', images: [{ url: 'https://cdn.example.com/a.png' }],
    });
    assert.equal(r.ok, true);
    assert.equal(r.verdict, 'abuse');
    assert.equal(r.images, 1);
    const blocks = chatBody.messages[1].content;
    assert.ok(Array.isArray(blocks));
    assert.ok(blocks.some((b) => b.type === 'image_url' && b.image_url.url.startsWith('data:image/png;base64,')));
  } finally {
    globalThis.fetch = original;
    cleanup();
  }
});

test('算术题计算与 AI 出题校正', async () => {
  assert.equal(solveArithmetic('37+45=?'), 82);
  assert.equal(solveArithmetic('9×8'), 72);
  assert.equal(solveArithmetic('10÷3'), null);
  assert.equal(parseQuizReply('{"type":"arithmetic","question":"6*7=?","answer":"41"}').answer, '42');
  assert.equal(parseGradeReply('{"correct":"true","reason":"同义"}').correct, true);

  const { store, cleanup } = makeStore({
    ai: { ...AI_ON.ai, quiz: { enabled: true, mode: 'arithmetic', judge: true } },
  });
  const ai = new AiGuard({
    store,
    logger: console,
    dsh: {
      llm: fakeLlm('{"type":"arithmetic","question":"37+45=?","answer":"99","aliases":[]}'),
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    },
  });
  const r = await ai.generateQuiz({ gid: 'g1', uid: 'u1', seed: 'seed' });
  assert.equal(r.ok, true);
  assert.equal(r.answer, '82');
  cleanup();
});

test('AI 判卷：本地比对失败时按同义答案通过', async () => {
  const { store, cleanup } = makeStore({
    ...AI_ON,
    ai: { ...AI_ON.ai, quiz: { enabled: true, mode: 'daily', judge: true } },
  });
  store.setQuiz('g1', 'u1', {
    q: '一周有几天？', a: '7', expiresAt: Date.now() + 60_000, attempts: 0, maxAttempts: 3, action: 'kick', name: '小明',
  });
  const sent = [];
  const client = {
    sendGroupText: async (_gid, text) => { sent.push(text); return { ok: true }; },
    removeMembers: async () => ({ ok: true }),
  };
  const ai = { gradeQuiz: async () => ({ ok: true, correct: true, reason: '同义', provider: 'dsh', model: 'm' }) };
  const r = await handleQuizAnswer({ gid: 'g1', uid: 'u1', text: '七天' }, { store, getClient: () => client, ai });
  assert.equal(r.action, 'quiz-pass');
  assert.equal(store.getQuiz('g1', 'u1'), null);
  assert.ok(sent.some((x) => x.includes('欢迎')));
  cleanup();
});

test('AI 出题：入群后直接提问并保存 AI 题目', async () => {
  const { store, cleanup } = makeStore({
    ai: { ...AI_ON.ai, quiz: { enabled: true, mode: 'mixed', judge: true } },
    join: {
      quiz: {
        enabled: false, timeoutSec: 60, maxAttempts: 3, action: 'kick', askBeforeWelcome: true, questions: [],
      },
      welcome: { enabled: false },
    },
  });
  const sent = [];
  const client = { sendGroupText: async (_gid, text) => { sent.push(text); return { ok: true }; } };
  const ai = {
    generateQuiz: async () => ({
      ok: true, question: '3+4=?', answer: '7', type: 'arithmetic', provider: 'dsh', model: 'm',
    }),
  };
  const r = await handleMemberAdd({
    group_openid: 'g1', member_openid: 'u7', username: '新人',
  }, { store, getClient: () => client, appId: 'a', ai });
  assert.equal(r.handled, true);
  const quiz = store.getQuiz('g1', 'u7');
  assert.equal(quiz.q, '3+4=?');
  assert.equal(quiz.a, '7');
  assert.equal(quiz.source, 'ai');
  assert.ok(sent[0].includes('3+4=?'));
  cleanup();
});

test('AI 验证：日常题连错两次换成算术题', async () => {
  const { store, cleanup } = makeStore({
    ...AI_ON,
    ai: {
      ...AI_ON.ai,
      quiz: {
        enabled: true, mode: 'daily', judge: false, switchAfterFails: 2, allowChange: true, maxSwitches: 2,
      },
    },
  });
  store.setQuiz('g1', 'u1', {
    q: '红灯表示什么？', a: '停', qType: 'daily', attempts: 0, switches: 0,
    expiresAt: Date.now() + 60_000, maxAttempts: 5, action: 'kick', name: '小明', seed: 's',
  });
  const sent = [];
  const client = {
    sendGroupText: async (_gid, text) => { sent.push(text); return { ok: true }; },
    removeMembers: async () => ({ ok: true }),
  };
  const ai = {
    generateQuiz: async () => ({
      ok: true, question: '3+5=?', answer: '8', type: 'arithmetic', provider: 'dsh', model: 'm',
    }),
  };
  let r = await handleQuizAnswer({ gid: 'g1', uid: 'u1', text: '走' }, { store, getClient: () => client, ai });
  assert.equal(r.action, 'quiz-retry');
  r = await handleQuizAnswer({ gid: 'g1', uid: 'u1', text: '走' }, { store, getClient: () => client, ai });
  assert.equal(r.action, 'quiz-switch');
  const quiz = store.getQuiz('g1', 'u1');
  assert.equal(quiz.q, '3+5=?');
  assert.equal(quiz.qType, 'arithmetic');
  assert.equal(quiz.switches, 1);
  assert.equal(quiz.attempts, 0);
  assert.ok(sent.some((x) => x.includes('3+5=?')));
  cleanup();
});

test('AI 验证：输入“换题”会换成简单题', async () => {
  const { store, cleanup } = makeStore({
    ...AI_ON,
    ai: {
      ...AI_ON.ai,
      quiz: {
        enabled: true, mode: 'mixed', judge: false, switchAfterFails: 2, allowChange: true, maxSwitches: 2,
      },
    },
  });
  store.setQuiz('g1', 'u1', {
    q: '一年有几个月？', a: '12', qType: 'daily', attempts: 0, switches: 0,
    expiresAt: Date.now() + 60_000, maxAttempts: 5, action: 'kick', name: '小明', seed: 's',
  });
  const sent = [];
  const client = { sendGroupText: async (_gid, text) => { sent.push(text); return { ok: true }; } };
  const ai = {
    generateQuiz: async () => ({
      ok: true, question: '2+3=?', answer: '5', type: 'arithmetic', provider: 'dsh', model: 'm',
    }),
  };
  const r = await handleQuizAnswer({ gid: 'g1', uid: 'u1', text: '太难了，换题' }, { store, getClient: () => client, ai });
  assert.equal(r.action, 'quiz-switch');
  const quiz = store.getQuiz('g1', 'u1');
  assert.equal(quiz.q, '2+3=?');
  assert.ok(quiz.switches >= 1);
  assert.ok(sent.some((x) => x.includes('换题') && x.includes('2+3=?')));
  cleanup();
});

test('入群自动拒绝会使用面板设置的拒绝理由', async () => {
  const { store, cleanup } = makeStore({
    join: {
      autoApprove: false, autoDeclineRisk: false, declineKeywords: ['广告'], rejectReason: '群规不允许推广',
    },
  });
  const calls = [];
  const client = {
    approveJoinRequest: async (gid, uid, op, opts) => { calls.push({ op, opts }); return { ok: true }; },
  };
  const r = await handleJoinRequest({
    group_openid: 'g1', member_openid: 'u7', join_request_id: 'j7', username: '推广号',
    verify_info: { verify_message: '我是来发广告的' },
  }, { store, getClient: () => client });
  assert.equal(r.decision, 'decline');
  assert.equal(calls[0].opts.rejectReason, '群规不允许推广');
  cleanup();
});

test('AI 自动拒绝时用 AI 自己写的 10 字内理由', async () => {
  const { store, cleanup } = makeStore({
    ai: { ...AI_ON.ai, join: { enabled: true, mode: 'auto' } },
    join: {
      autoApprove: false, autoDeclineRisk: false, declineKeywords: [], rejectReason: '暂不符合入群条件',
    },
  });
  const calls = [];
  const client = {
    approveJoinRequest: async (gid, uid, op, opts) => { calls.push({ op, opts }); return { ok: true }; },
  };
  const ai = {
    judgeJoin: async () => ({
      ok: true, verdict: 'decline', confidence: 0.95,
      reason: '申请人昵称与验证信息疑似广告号', rejectReason: '疑似广告账号',
      provider: 'dsh', model: 'm',
    }),
  };
  const r = await handleJoinRequest({
    group_openid: 'g1', member_openid: 'u7', join_request_id: 'j7', username: '低价推广',
    verify_info: { verify_message: '加我领福利' },
  }, { store, getClient: () => client, ai });
  assert.equal(r.decision, 'decline');
  assert.equal(calls[0].opts.rejectReason, '疑似广告账号');
  assert.ok(calls[0].opts.rejectReason.length <= 10);
  cleanup();
});

test('AI 拒绝理由解析：reject_reason 最多 10 字', () => {
  const hit = parseVerdict(
    '{"verdict":"decline","confidence":0.9,"reason":"理由","reject_reason":"验证信息不完整且疑似广告账号"}',
    JOIN_VERDICTS,
  );
  assert.equal(hit.ok, true);
  assert.equal(hit.rejectReason.length, 10);
  const none = parseVerdict('{"verdict":"decline","confidence":0.9}', JOIN_VERDICTS);
  assert.equal(none.rejectReason, '');
});

test('入群审批：AI 复核/低置信度不覆盖本地通过', async () => {
  const { store, cleanup } = makeStore({
    ai: { ...AI_ON.ai, join: { enabled: true, mode: 'auto' } },
    join: {
      autoApprove: true, autoDeclineRisk: false, approveKeywords: ['答案'], declineKeywords: [],
    },
  });
  const calls = [];
  const client = { approveJoinRequest: async (...args) => { calls.push(args); return { ok: true }; } };
  const ai = {
    judgeJoin: async () => ({
      ok: true, verdict: 'review', confidence: 0.4, reason: '不确定', provider: 'dsh', model: 'm',
    }),
  };
  const r = await handleJoinRequest({
    group_openid: 'g1',
    member_openid: 'u8',
    join_request_id: 'j1',
    username: '小明',
    verify_info: { verify_message: '答案是 A' },
  }, { store, getClient: () => client, ai });
  assert.equal(r.decision, 'approve');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2], 'approve');
  cleanup();
});

test('入群事件缺少 join_request_id 也能审批', async () => {
  const { store, cleanup } = makeStore({
    join: {
      autoApprove: true, autoDeclineRisk: false, approveKeywords: [], declineKeywords: [],
    },
  });
  const calls = [];
  const client = {
    approveJoinRequest: async (gid, uid, op, opts) => {
      calls.push({ gid, uid, op, opts });
      return { ok: true };
    },
  };
  const r = await handleJoinRequest({
    group_openid: 'g1', member_openid: 'u8', username: '小明',
  }, { store, getClient: () => client });
  assert.equal(r.decision, 'approve');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.joinRequestId, undefined);
  cleanup();
});

test('AI 审批时段：白天 / 晚上 / 群活跃', () => {
  const cfg = { join: { schedule: { mode: 'day', dayStart: 8, dayEnd: 22 } } };
  const store = { state: { groups: { g1: { lastSeenAt: new Date().toISOString() } } } };
  // 02:00Z = 北京时间 10:00；14:00Z = 北京时间 22:00
  assert.equal(aiJoinActive(cfg, store, 'g1', Date.parse('2026-01-01T02:00:00Z')), true);
  assert.equal(aiJoinActive(cfg, store, 'g1', Date.parse('2026-01-01T14:00:00Z')), false);
  const night = { join: { schedule: { mode: 'night', dayStart: 8, dayEnd: 22 } } };
  assert.equal(aiJoinActive(night, store, 'g1', Date.parse('2026-01-01T14:00:00Z')), true);
  const active = { join: { schedule: { mode: 'active', idleMinutes: 30 } } };
  assert.equal(aiJoinActive(active, store, 'g1', Date.now()), true);
  const idleStore = {
    state: { groups: { g1: { lastSeenAt: new Date(Date.now() - 3600_000).toISOString() } } },
  };
  assert.equal(aiJoinActive(active, idleStore, 'g1', Date.now()), false);
});

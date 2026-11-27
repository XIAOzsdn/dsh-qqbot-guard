/** 英文自然语言：只走 AI；AI 不可用直接报错；精确指标；AI 优先回复。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import { handleNaturalCommand } from '../lib/natural.js';
import { formatDeviceInfo } from '../lib/device.js';
import { AiGuard } from '../lib/ai.js';

function makeStore(settings = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qqg-en-'));
  const store = new Store(dir);
  store.saveSettings(settings);
  return { store, dir, cleanup: () => { store.dispose(); rmSync(dir, { recursive: true, force: true }); } };
}

function makeClient(sent) {
  return {
    sendGroupText: async (_gid, text) => { sent.push(text); return { ok: true }; },
    getGroupInfo: async () => ({ ok: true, data: { group_member_num: 3 } }),
  };
}

test('英文指令：AI 可用时由 AI 解析执行（不依赖任何本地英文词表）', async () => {
  const { store, cleanup } = makeStore({ ai: { enabled: true } });
  const sent = [];
  let seen = '';
  const ai = {
    parseIntent: async (payload) => {
      seen = payload.text;
      return { ok: true, intent: { action: 'mute', target: 'John', seconds: 600 } };
    },
  };
  const r = await handleNaturalCommand({
    gid: 'g1', uid: 'u1', name: '管理员', text: 'mute John 10 minutes',
    settings: store.settings, store, client: makeClient(sent), ai, mentionUids: [],
  });
  assert.equal(r.action, 'mute');
  assert.equal(seen, 'mute John 10 minutes');
  assert.ok(sent[0].includes('John'));
  cleanup();
});

test('英文指令：AI 未启用时直接报错，不用本地规则去猜', async () => {
  const { store, cleanup } = makeStore({ ai: { enabled: false } });
  const sent = [];
  let aiCalls = 0;
  const ai = { parseIntent: async () => { aiCalls += 1; return { ok: false }; } };
  const r = await handleNaturalCommand({
    gid: 'g1', uid: 'u1', name: '管理员', text: 'kick John',
    settings: store.settings, store, client: makeClient(sent), ai, mentionUids: [],
  });
  assert.equal(r.action, 'help');
  assert.equal(r.ok, false);
  assert.equal(aiCalls, 0);
  assert.ok(sent[0].includes('英文指令只通过 AI 解析'));
  cleanup();
});

test('英文指令：AI 超时 / 失败时也直接报错', async () => {
  const { store, cleanup } = makeStore({ ai: { enabled: true } });
  const sent = [];
  const ai = { parseIntent: async () => ({ ok: false, code: 'TIMEOUT' }) };
  const r = await handleNaturalCommand({
    gid: 'g1', uid: 'u1', name: '管理员', text: 'how many members',
    settings: store.settings, store, client: makeClient(sent), ai, mentionUids: [],
  });
  assert.equal(r.action, 'help');
  assert.ok(sent[0].includes('英文指令只通过 AI 解析'));
  cleanup();
});

test('英文设备查询只带对应指标', () => {
  const info = {
    hostName: 'DESKTOP-T', systemVersion: 'Windows 11 x64', cpuModel: 'Test CPU', cpuCores: 8,
    cpuUsage: 23.4, memUsed: 8 * 1024 ** 3, memTotal: 16 * 1024 ** 3, memUsage: 50,
  };
  const cpu = formatDeviceInfo(info, { metric: 'cpu' });
  assert.ok(cpu.includes('CPU 占用率：23.4%'));
  assert.ok(!cpu.includes('内存') && !cpu.includes('DESKTOP-T'));

  const mem = formatDeviceInfo(info, { metric: 'mem' });
  assert.ok(mem.includes('内存占用率：50.0%'));
  assert.ok(!mem.includes('CPU') && !mem.includes('DESKTOP-T'));
});

test('composeReply：AI 可用时改写，AI 不可用时返回失败交给本地文本', async () => {
  const store = { settings: { ai: { enabled: true, provider: 'openai', baseUrl: 'http://127.0.0.1:1234/v1', model: 'm', maxTokens: 512 } } };
  const ai = new AiGuard({ store });
  ai.complete = async () => ({ ok: true, text: '“CPU 现在 23.4%，很轻松。”', provider: 'openai', model: 'm' });
  const ok = await ai.composeReply({ text: 'CPU 占用率：23.4%', action: 'device' });
  assert.equal(ok.ok, true);
  assert.equal(ok.text, 'CPU 现在 23.4%，很轻松。');

  const bad = new AiGuard({ store });
  bad.complete = async () => ({ ok: false, code: 'AI_ERROR', error: '超时' });
  assert.equal((await bad.composeReply({ text: 'CPU 占用率：23.4%' })).ok, false);
});

test('composeReply 拒绝过长或空结果，避免模型胡写撑爆群消息', async () => {
  const store = { settings: { ai: { enabled: true, provider: 'openai', baseUrl: 'http://127.0.0.1:1234/v1', model: 'm' } } };
  const ai = new AiGuard({ store });
  ai.complete = async () => ({ ok: true, text: 'x'.repeat(600) });
  assert.equal((await ai.composeReply({ text: '事实' })).ok, false);
  ai.complete = async () => ({ ok: true, text: '   ' });
  assert.equal((await ai.composeReply({ text: '事实' })).ok, false);
});

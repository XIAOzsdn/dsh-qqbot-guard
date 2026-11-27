/** AI 总开关：关闭后所有 AI 调用与 AI 相关指令全部失效，走本地规则。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import { normalizeSettings } from '../lib/config.js';
import { AiGuard } from '../lib/ai.js';
import { handleNaturalCommand } from '../lib/natural.js';

function makeStore(settings = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qqg-master-'));
  const store = new Store(dir);
  store.saveSettings(settings);
  return { store, cleanup: () => { store.dispose(); rmSync(dir, { recursive: true, force: true }); } };
}

test('AI 总开关默认开启，保存后归一化保留', () => {
  assert.equal(normalizeSettings({}).value.ai.master, true);
  assert.equal(normalizeSettings({ ai: { master: false } }).value.ai.master, false);
  assert.equal(normalizeSettings({ ai: { master: 'no' } }).value.ai.master, true);
});

test('总开关关闭后，AiGuard 一律不发起调用（含测试模型）', async () => {
  const store = { settings: { ai: { master: false, enabled: true, provider: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'm' } } };
  const ai = new AiGuard({ store });
  assert.equal(ai.available().ok, false);
  assert.equal(ai.available(true).ok, false);
  const r = await ai.complete('s', 'u', 64);
  assert.equal(r.ok, false);
  assert.match(r.error, /AI 总开关已关闭/);
  const intent = await ai.parseIntent({ text: '查人数' });
  assert.equal(intent.ok, false);
  assert.equal(ai.status().master, false);
});

test('总开关关闭后：英文指令直接报错，不调用模型', async () => {
  const { store, cleanup } = makeStore({ ai: { master: false, enabled: true } });
  const sent = [];
  let aiCalls = 0;
  const ai = { parseIntent: async () => { aiCalls += 1; return { ok: true, intent: { action: 'kick', target: 'John' } }; } };
  const r = await handleNaturalCommand({
    gid: 'g1', uid: 'u1', name: '管理员', text: 'kick John',
    settings: store.settings, store,
    client: { sendGroupText: async (_g, t) => { sent.push(t); return { ok: true }; } },
    ai, mentionUids: [],
  });
  assert.equal(r.action, 'help');
  assert.equal(aiCalls, 0);
  assert.ok(sent[0].includes('英文指令只通过 AI 解析'));
  cleanup();
});

test('总开关关闭后：中文指令回到本地关键词/本地规则', async () => {
  const { store, cleanup } = makeStore({ ai: { master: false, enabled: true }, commands: { enabled: false, allowUsers: [] } });
  const sent = [];
  let aiCalls = 0;
  const ai = { parseIntent: async () => { aiCalls += 1; return { ok: true, intent: { action: 'kick', target: 'x' } }; } };
  const r = await handleNaturalCommand({
    gid: 'g1', uid: 'u1', name: '管理员', text: '查人数',
    settings: store.settings, store,
    client: {
      sendGroupText: async (_g, t) => { sent.push(t); return { ok: true }; },
      getGroupInfo: async () => ({ ok: true, data: { group_member_num: 5 } }),
    },
    ai, mentionUids: [],
  });
  assert.equal(r.action, 'count');
  assert.equal(aiCalls, 0);
  assert.ok(sent[0].includes('5'));
  cleanup();
});

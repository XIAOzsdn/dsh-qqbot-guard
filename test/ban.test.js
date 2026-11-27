/** 全体禁言 / 定时禁言 / 错别字容错。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import { Scheduler } from '../lib/scheduler.js';
import { parseNaturalIntent, handleNaturalCommand } from '../lib/natural.js';

function makeStore(settings = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qqg-ban-'));
  const store = new Store(dir);
  store.saveSettings(settings);
  return { store, dir, cleanup: () => { store.dispose(); rmSync(dir, { recursive: true, force: true }); } };
}

test('全体禁言意图：开启 / 关闭，且不会误判成成员禁言', () => {
  assert.equal(parseNaturalIntent('全体禁言').action, 'whole-ban');
  assert.equal(parseNaturalIntent('开启全员禁言').action, 'whole-ban');
  assert.equal(parseNaturalIntent('全体禁言 30 分钟').seconds, 1800);
  assert.equal(parseNaturalIntent('解除全体禁言').action, 'whole-unban');
  assert.equal(parseNaturalIntent('关闭全员禁言').action, 'whole-unban');
  assert.equal(parseNaturalIntent('禁言 张三 10 分钟').action, 'mute');
});

test('错别字 / 谐音 / 拼音：只由 AI 识别，本地不猜', async () => {
  // 本地规则不认错别字，避免维护一个永远写不完的容错表
  assert.equal(parseNaturalIntent('拳体禁盐'), null);
  assert.equal(parseNaturalIntent('给张三解近'), null);

  // AI 在，就能识别成正确动作
  const { store, cleanup } = makeStore();
  try {
    const sent = [];
    const client = { sendGroupText: async (_g, t) => { sent.push(t); return { ok: true }; } };
    let ops = [];
    const ai = {
      parseIntent: async ({ text }) => ({
        ok: true,
        intent: { action: /禁盐|禁言/u.test(text) && /体|员/u.test(text) ? 'whole-ban' : 'help', target: '', seconds: 0, blacklist: false },
      }),
    };
    const r = await handleNaturalCommand({
      gid: 'g1', uid: 'u1', name: '管理员', text: '拳体禁盐', msgId: 'm1',
      settings: { ...store.settings, ai: { ...store.settings.ai, enabled: true } },
      store, client, ai,
      handleOps: async (action) => { ops.push(action); return { handled: true, action }; },
    });
    assert.equal(r.handled, true);
    assert.deepEqual(ops, ['whole-ban']);
  } finally {
    cleanup();
  }
});

test('定时：22:30 全体禁言 写入排期而不立刻执行', async () => {
  const { store, cleanup } = makeStore();
  try {
    const scheduler = new Scheduler({ store, executor: async () => ({ ok: true }) });
    const sent = [];
    const client = { sendGroupText: async (_g, t) => { sent.push(t); return { ok: true }; } };
    let ops = 0;
    const r = await handleNaturalCommand({
      gid: 'g1', uid: 'u1', name: '管理员', text: '22:30 全体禁言', msgId: 'm1',
      settings: store.settings, store, client, scheduler,
      handleOps: async () => { ops += 1; return { handled: true, action: 'whole-ban' }; },
    });
    assert.equal(r.handled, true);
    assert.equal(ops, 0, '排期时不能立刻执行');
    const list = scheduler.list('g1');
    assert.equal(list.length, 1);
    assert.equal(list[0].kind, 'whole-ban');
    assert.ok(sent[0].includes('已安排'));
  } finally {
    cleanup();
  }
});

test('定时：每天 23:00 解除全体禁言 → daily 任务', async () => {
  const { store, cleanup } = makeStore();
  try {
    const scheduler = new Scheduler({ store, executor: async () => ({ ok: true }) });
    const client = { sendGroupText: async () => ({ ok: true }) };
    await handleNaturalCommand({
      gid: 'g1', uid: 'u1', name: '管理员', text: '每天 23:00 解除全体禁言',
      settings: store.settings, store, client, scheduler,
    });
    const list = scheduler.list('g1');
    assert.equal(list.length, 1);
    assert.equal(list[0].kind, 'whole-unban');
    assert.equal(list[0].repeat, 'daily');
    assert.equal(list[0].time, '23:00');
  } finally {
    cleanup();
  }
});

test('定时：同群再次设置 = 修改（只保留一条，回复提示已替换）', async () => {
  const { store, cleanup } = makeStore();
  try {
    const scheduler = new Scheduler({ store, executor: async () => ({ ok: true }) });
    const sent = [];
    const client = { sendGroupText: async (_g, t) => { sent.push(t); return { ok: true }; } };
    const run = (text) => handleNaturalCommand({
      gid: 'g1', uid: 'u1', name: '管理员', text,
      settings: store.settings, store, client, scheduler,
    });
    await run('22:30 全体禁言');
    await run('23:00 全体禁言');
    const list = scheduler.list('g1');
    assert.equal(list.length, 1, '重复设置不会排出两条');
    assert.equal(list[0].time, '23:00', '新的时间生效');
    assert.ok(sent[1].includes('已替换'), '第二次回复说明已替换旧任务');
  } finally {
    cleanup();
  }
});

test('定时：明天 9 点禁言成员 1 小时 → mute 任务带 qq/uid', async () => {
  const { store, cleanup } = makeStore();
  try {
    store.upsertMember('g1', 'u2', { name: '小明', qq: '12345678' });
    const scheduler = new Scheduler({ store, executor: async () => ({ ok: true }) });
    const client = { sendGroupText: async () => ({ ok: true }) };
    const r = await handleNaturalCommand({
      gid: 'g1', uid: 'u1', name: '管理员', text: '明天 9 点禁言小明 1 小时',
      settings: store.settings, store, client, scheduler,
    });
    assert.equal(r.handled, true);
    const list = scheduler.list('g1');
    assert.equal(list.length, 1);
    assert.equal(list[0].kind, 'mute');
    assert.equal(list[0].uid, 'u2');
    assert.equal(list[0].qq, '12345678');
    assert.equal(list[0].seconds, 3600);
  } finally {
    cleanup();
  }
});

test('立即全体禁言：交给会执行 NapCat 的 handler', async () => {
  const { store, cleanup } = makeStore();
  try {
    const client = { sendGroupText: async () => ({ ok: true }) };
    const actions = [];
    const r = await handleNaturalCommand({
      gid: 'g1', uid: 'u1', name: '管理员', text: '全体禁言',
      settings: store.settings, store, client,
      handleOps: async (action) => { actions.push(action); return { handled: true, action, ok: true }; },
    });
    assert.equal(r.handled, true);
    assert.deepEqual(actions, ['whole-ban']);
  } finally {
    cleanup();
  }
});

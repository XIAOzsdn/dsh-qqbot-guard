import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import { applyWholeBan } from '../lib/whole-ban.js';
import { Moderation } from '../lib/moderation.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'qqg-wb-'));
  const store = new Store(dir);
  store.upsertMember('g1', 'u1', { name: '普通一', role: 'member' });
  store.upsertMember('g1', 'u2', { name: '普通二', role: 'member' });
  store.upsertMember('g1', 'u3', { name: '管理员', role: 'admin' });
  store.upsertMember('g1', 'u4', { name: '群主', role: 'owner' });
  return { store, cleanup: () => { store.dispose(); rmSync(dir, { recursive: true, force: true }); } };
}

function fakeClient({ muted = [], failGet = false } = {}) {
  const calls = [];
  const client = {
    sendGroupText: async () => ({ ok: true }),
    setMemberMute: async (_gid, ids, seconds) => { calls.push({ ids: [...ids], seconds }); return { ok: true }; },
    getGroupMuteSetting: async () => {
      if (failGet) return { ok: false, err: { code: 'X', human: '无权限' } };
      return { ok: true, data: { members: muted.map((id) => ({ member_openid: id })) } };
    },
  };
  return { client, calls };
}

test('逐人禁言兜底：只禁言普通成员，跳过群主/管理员', async () => {
  const { store, cleanup } = setup();
  try {
    const { client, calls } = fakeClient();
    const r = await applyWholeBan({ store, client, gid: 'g1', enable: true, seconds: 600 });
    assert.equal(r.ok, true);
    assert.equal(r.done, 2);
    assert.equal(r.failed, 0);
    const ids = calls.flatMap((c) => c.ids).sort();
    assert.deepEqual(ids, ['u1', 'u2'], '群主/管理员不能被禁言');
    assert.ok(calls.every((c) => c.seconds === 600));
  } finally {
    cleanup();
  }
});

test('官方解除：按官方禁言状态成员列表批量解禁', async () => {
  const { store, cleanup } = setup();
  try {
    const { client, calls } = fakeClient({ muted: ['u1', 'u2', 'u3'] });
    const r = await applyWholeBan({ store, client, gid: 'g1', enable: false });
    assert.equal(r.ok, true);
    assert.equal(r.done, 3);
    assert.equal(r.via, 'official');
    assert.equal(calls.length, 1, '20 人以内一次批量解除');
    assert.deepEqual(calls[0].ids, ['u1', 'u2', 'u3']);
    assert.equal(calls[0].seconds, null);
  } finally {
    cleanup();
  }
});

test('官方解除：读不到禁言状态时退回台账', async () => {
  const { store, cleanup } = setup();
  try {
    const { client, calls } = fakeClient({ failGet: true });
    const r = await applyWholeBan({ store, client, gid: 'g1', enable: false });
    assert.equal(r.ok, true);
    assert.equal(r.via, 'ledger');
    const ids = calls.flatMap((c) => c.ids).sort();
    assert.deepEqual(ids, ['u1', 'u2', 'u3', 'u4'], '台账全部成员都尝试解禁');
  } finally {
    cleanup();
  }
});

test('Moderation：全体禁言走逐人禁言兜底并自动排解除任务', async () => {
  const { store, cleanup } = setup();
  try {
    const { client } = fakeClient();
    const sched = [];
    const mod = new Moderation({
      store,
      getClient: () => client,
      logger: console,
      getScheduler: () => ({ add: (e) => { sched.push(e); } }),
    });
    const r = await mod.handleOpsCommand('whole-ban', { gid: 'g1', uid: 'u9', name: '管理员' }, store.settings);
    assert.equal(r.handled, true);
    assert.equal(r.ok, true);
    assert.equal(r.action, 'whole-ban');
    assert.equal(sched.length, 1, '带时长禁言应自动排解除任务');
    assert.equal(sched[0].kind, 'whole-unban');
  } finally {
    cleanup();
  }
});

test('Moderation：解除全员禁言回复解禁人数', async () => {
  const { store, cleanup } = setup();
  try {
    const sent = [];
    const { client } = fakeClient({ muted: ['u1', 'u2'] });
    client.sendGroupText = async (_g, t) => { sent.push(t); return { ok: true }; };
    const mod = new Moderation({ store, getClient: () => client, logger: console });
    const r = await mod.handleOpsCommand('whole-unban', { gid: 'g1', uid: 'u9', name: '管理员' }, store.settings);
    assert.equal(r.ok, true);
    assert.ok(sent.some((t) => t.includes('解禁 2 人')), `回复应包含解禁人数：${sent.join(' | ')}`);
  } finally {
    cleanup();
  }
});

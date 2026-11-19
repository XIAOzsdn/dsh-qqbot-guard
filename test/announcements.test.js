import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import {
  createAnnouncement, formatText, listAnnouncements, normalizeTime, pauseAnnouncement, publishAnnouncement,
  tickAnnouncements, updateAnnouncement,
} from '../lib/announcements.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'qqg-ann-'));
  const store = new Store(dir);
  return { store, cleanup: () => { store.dispose(); rmSync(dir, { recursive: true, force: true }); } };
}

test('创建公告校验内容', () => {
  const { store, cleanup } = setup();
  assert.equal(createAnnouncement({ store, input: { content: '  ' } }).ok, false);
  const r = createAnnouncement({ store, input: { title: '群规', content: '禁止广告', targets: ['g1', 'g1', 'g2'] } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.item.targets, ['g1', 'g2']);
  assert.equal(r.item.status, 'draft');
  cleanup();
});

test('定时时间归一化', () => {
  assert.equal(normalizeTime(''), '');
  assert.equal(normalizeTime('not-a-date'), '');
  assert.equal(normalizeTime('2026-11-22T10:00:00+08:00'), '2026-11-22T02:00:00.000Z');
});

test('更新与暂停', () => {
  const { store, cleanup } = setup();
  const created = createAnnouncement({ store, input: { content: 'a', targets: ['g1'], publishAt: '2026-11-23T00:00:00Z' } });
  assert.equal(created.item.status, 'scheduled');
  const updated = updateAnnouncement({ store, id: created.item.id, patch: { content: 'b', publishAt: '' } });
  assert.equal(updated.item.status, 'draft');
  assert.equal(updated.item.content, 'b');
  const scheduled = updateAnnouncement({ store, id: created.item.id, patch: { publishAt: '2026-11-23T00:00:00Z' } });
  assert.equal(scheduled.item.status, 'scheduled');
  const paused = pauseAnnouncement({ store, id: created.item.id });
  assert.equal(paused.item.status, 'draft');
  cleanup();
});

test('发布成功 / 部分失败', async () => {
  const { store, cleanup } = setup();
  const created = createAnnouncement({ store, input: { title: '公告', content: '内容', targets: ['g1', 'g2'] } });
  const okClient = { sendGroupText: async () => ({ ok: true }) };
  const okR = await publishAnnouncement({ store, client: okClient, id: created.item.id });
  assert.equal(okR.ok, true);
  assert.equal(okR.sent, 2);
  assert.equal(okR.item.status, 'done');
  assert.equal(formatText(okR.item), '【公告】\n内容');

  const created2 = createAnnouncement({ store, input: { content: 'x', targets: ['g1', 'g2'] } });
  const partial = {
    sendGroupText: async (gid) => (gid === 'g1' ? { ok: true } : { ok: false, err: { code: 'E', human: '失败' } }),
  };
  const r2 = await publishAnnouncement({ store, client: partial, id: created2.item.id });
  assert.equal(r2.item.status, 'partial_failed');
  assert.equal(r2.sent, 1);
  cleanup();
});

test('真·群公告：mode=notice 走 NapCat，失败回落普通消息', async () => {
  const { store, cleanup } = setup();
  const created = createAnnouncement({ store, input: { content: '群规更新', targets: ['g1'], mode: 'notice' } });
  assert.equal(created.item.mode, 'notice');

  // NapCat 可用：整条公告都发成真公告
  const dirOk = { sendGroupNotice: async ({ gid, content }) => ({ ok: true, via: 'napcat', qqGroupId: '558225608' }) };
  const clientOk = { sendGroupText: async () => { throw new Error('不应走普通消息'); } };
  const okR = await publishAnnouncement({ store, client: clientOk, directory: dirOk, id: created.item.id });
  assert.equal(okR.ok, true);
  assert.equal(okR.sent, 1);
  assert.equal(okR.item.results[0].mode, 'notice');

  // NapCat 报错：回落到普通消息
  const created2 = createAnnouncement({ store, input: { content: '回落测试', targets: ['g1', 'g2'], mode: 'notice' } });
  const dirFail = { sendGroupNotice: async () => ({ ok: false, error: '机器人不是管理员' }) };
  const clientText = { sendGroupText: async () => ({ ok: true }) };
  const fallR = await publishAnnouncement({ store, client: clientText, directory: dirFail, id: created2.item.id });
  assert.equal(fallR.ok, true);
  assert.equal(fallR.sent, 2);
  assert.ok(fallR.item.results.every((x) => x.mode === 'text'));
  cleanup();
});

test('调度器只发布到期的公告', async () => {
  const { store, cleanup } = setup();
  const due = createAnnouncement({ store, input: { content: 'due', targets: ['g1'], publishAt: '2026-01-01T00:00:00Z' } });
  createAnnouncement({ store, input: { content: 'later', targets: ['g1'], publishAt: '2099-01-01T00:00:00Z' } });
  const sent = [];
  const client = { sendGroupText: async (gid, text) => { sent.push(text); return { ok: true }; } };
  const r = await tickAnnouncements({ store, client });
  assert.equal(r.published, 1);
  assert.deepEqual(sent, ['due']);
  assert.equal(listAnnouncements(store).find((x) => x.id === due.item.id).status, 'done');
  cleanup();
});

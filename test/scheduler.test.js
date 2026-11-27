import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import { Scheduler, parseSchedule, nextDaily, SCHEDULE_KIND_LABEL } from '../lib/scheduler.js';

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'qqg-sched-'));
  return { store: new Store(dir), dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('时间解析：22:30 / 明天 9 点 / 3 分钟后 / 每天 23:00', () => {
  const base = new Date('2026-01-01T10:00:00');
  const now = base.getTime();
  const a = parseSchedule('22:30 全体禁言', now);
  assert.equal(a.repeat, 'once');
  assert.equal(a.time, '22:30');
  assert.equal(new Date(a.at).getHours(), 22);
  assert.equal(new Date(a.at).getMinutes(), 30);

  const b = parseSchedule('明天 9 点 禁言张三', now);
  assert.equal(new Date(b.at).getDate(), 2);
  assert.equal(new Date(b.at).getHours(), 9);

  const c = parseSchedule('3 分钟后全体禁言', now);
  assert.equal(c.at, now + 3 * 60_000);

  const d = parseSchedule('每天 23:00 全体禁言', now);
  assert.equal(d.repeat, 'daily');
  assert.equal(d.time, '23:00');
  assert.equal(new Date(d.at).getHours(), 23);

  assert.equal(parseSchedule('全体禁言', now), null);
});

test('nextDaily 跨天推到明天', () => {
  const now = new Date('2026-01-01T23:30:00').getTime();
  const at = new Date('2026-01-01T22:00:00').getTime();
  const next = nextDaily(at, now);
  assert.equal(new Date(next).getDate(), 2);
  assert.equal(new Date(next).getHours(), 22);
});

test('Scheduler：新增 / 列出 / 取消 / 到点执行', async () => {
  const env = tempStore();
  try {
    const calls = [];
    const sch = new Scheduler({
      store: env.store,
      executor: async (item) => { calls.push(item); return { ok: true }; },
    });
    const r = sch.add({ gid: 'g1', kind: 'whole-ban', at: Date.now() + 60_000, createdBy: 'u1' });
    assert.equal(r.ok, true);
    assert.equal(sch.list('g1').length, 1);
    assert.equal(sch.list('g2').length, 0);

    const bad = sch.add({ gid: 'g1', kind: 'nope', at: Date.now() + 60_000 });
    assert.equal(bad.ok, false);

    // 强制到点
    sch.store.state.schedules[0].at = Date.now() - 1000;
    const done = await sch.tick();
    assert.equal(done.length, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, 'whole-ban');
    assert.equal(sch.list('g1').length, 0, '一次性任务执行后移除');

    const daily = sch.add({ gid: 'g1', kind: 'whole-ban', at: Date.now() - 500, repeat: 'daily', time: '22:00' });
    assert.equal(daily.ok, true);
    const done2 = await sch.tick();
    assert.equal(done2.length, 1);
    assert.equal(sch.list('g1').length, 1, '每日任务保留并推到下一次');
    assert.ok(sch.list('g1')[0].at > Date.now());

    const c = sch.cancel(sch.list('g1')[0].id);
    assert.equal(c.ok, true);
    assert.equal(sch.list('g1').length, 0);
    assert.equal(SCHEDULE_KIND_LABEL['whole-ban'], '全员禁言');
  } finally {
    env.cleanup();
  }
});

test('Scheduler：同群同类定时任务重复设置 = 修改（替换旧任务）', () => {
  const env = tempStore();
  try {
    const sch = new Scheduler({ store: env.store, executor: async () => ({ ok: true }) });
    const a = sch.add({ gid: 'g1', kind: 'whole-ban', at: Date.now() + 60_000 });
    assert.equal(a.replaced, 0);
    // 再说一次 22:30 全员禁言 → 替换旧任务，而不是排两条
    const b = sch.add({ gid: 'g1', kind: 'whole-ban', at: Date.now() + 120_000 });
    assert.equal(b.replaced, 1);
    assert.equal(sch.list('g1').length, 1);
    assert.equal(sch.list('g1')[0].at, b.item.at);
    // 不同动作 / 不同重复方式 / 不同群都互不影响
    const c = sch.add({ gid: 'g1', kind: 'whole-unban', at: Date.now() + 60_000 });
    assert.equal(c.replaced, 0);
    const d = sch.add({ gid: 'g1', kind: 'whole-ban', at: Date.now() + 60_000, repeat: 'daily' });
    assert.equal(d.replaced, 0);
    const e = sch.add({ gid: 'g2', kind: 'whole-ban', at: Date.now() + 60_000 });
    assert.equal(e.replaced, 0);
    assert.equal(sch.list('g1').length, 3);
    assert.equal(sch.list('g2').length, 1);
  } finally {
    env.cleanup();
  }
});

test('Scheduler 持久化到 state.json', () => {
  const env = tempStore();
  try {
    const sch = new Scheduler({ store: env.store, executor: async () => ({ ok: true }) });
    sch.add({ gid: 'g9', kind: 'mute', uid: 'u9', seconds: 600, at: Date.now() + 120_000 });
    env.store.flush();
    const reopened = new Store(env.dir);
    assert.equal(Array.isArray(reopened.state.schedules), true);
    assert.equal(reopened.state.schedules.length, 1);
    assert.equal(reopened.state.schedules[0].kind, 'mute');
  } finally {
    env.cleanup();
  }
});

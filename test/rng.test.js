import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeeded, dayKeyUtc8, hashSeed, pickSeeded } from '../lib/rng.js';

test('种子随机可复现', () => {
  const a = createSeeded('seed-1');
  const b = createSeeded('seed-1');
  const seqA = [a.next(), a.next(), a.int(0, 100)];
  const seqB = [b.next(), b.next(), b.int(0, 100)];
  assert.deepEqual(seqA, seqB);
});

test('不同种子产生不同序列', () => {
  assert.notEqual(hashSeed('a'), hashSeed('b'));
  assert.notEqual(createSeeded('a').next(), createSeeded('b').next());
});

test('pickSeeded 对同一输入稳定', () => {
  const list = ['甲', '乙', '丙', '丁'];
  const first = pickSeeded(list, 'gid|uid|2026-11-22');
  for (let i = 0; i < 20; i++) {
    assert.equal(pickSeeded(list, 'gid|uid|2026-11-22'), first);
  }
  assert.ok(list.includes(first));
});

test('空列表返回 undefined', () => {
  assert.equal(pickSeeded([], 'x'), undefined);
});

test('dayKeyUtc8 按北京时间切天', () => {
  const t = Date.parse('2026-11-21T16:30:00.000Z');
  assert.equal(dayKeyUtc8(t), '2026-11-22');
});

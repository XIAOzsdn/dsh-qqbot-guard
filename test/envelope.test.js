import test from 'node:test';
import assert from 'node:assert/strict';
import { assertEnvelope, fail, ok } from '../lib/envelope.js';

test('成功信封结构合法', () => {
  const e = ok({ a: 1 });
  assert.equal(assertEnvelope(e), true);
  assert.equal(e.ok, true);
  assert.equal(e.meta.plugin, 'dsh-qqbot-guard');
  assert.equal(e.meta.confidence, 1);
});

test('失败信封结构合法', () => {
  const e = fail('TEST', '测试错误');
  assert.equal(assertEnvelope(e), true);
  assert.equal(e.ok, false);
  assert.equal(e.error.code, 'TEST');
});

test('缺少 meta 会被拒绝', () => {
  assert.throws(() => assertEnvelope({ ok: true, data: 1 }), /meta/);
});

test('非法时间会被拒绝', () => {
  const e = ok({});
  e.meta.generatedAt = 'oops';
  assert.throws(() => assertEnvelope(e), /generatedAt/);
});

test('成功但没有 data 会被拒绝', () => {
  assert.throws(() => assertEnvelope({ ok: true, data: undefined, meta: ok({}).meta }), /data/);
});

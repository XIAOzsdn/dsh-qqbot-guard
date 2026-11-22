import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCompat, compareVersions, probeDataDir, SUPPORT_MATRIX } from '../lib/compat.js';

test('版本比较', () => {
  assert.equal(compareVersions('24.9.0', '24.9.0'), 0);
  assert.equal(compareVersions('24.10.0', '24.9.0'), 1);
  assert.equal(compareVersions('22.0.0', '24.9.0'), -1);
  assert.equal(compareVersions('24.9.0-rc.1', '24.9.0'), -1);
});

test('数据目录可写探测', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqg-compat-'));
  assert.equal(probeDataDir(dir).ok, true);
  assert.equal(probeDataDir(join(dir, 'nested', 'deeper')).ok, true);
  rmSync(dir, { recursive: true, force: true });
});

test('兼容性报告结构完整', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqg-compat-'));
  try {
    const report = checkCompat({ dataDir: dir, webAvailable: true });
    assert.equal(typeof report.ok, 'boolean');
    assert.equal(report.node, process.versions.node);
    assert.equal(report.platform, process.platform);
    assert.equal(report.arch, process.arch);
    assert.ok(Array.isArray(report.checks) && report.checks.length >= 8);
    for (const c of report.checks) {
      assert.equal(typeof c.id, 'string');
      assert.equal(typeof c.label, 'string');
      assert.equal(typeof c.ok, 'boolean');
      assert.ok(['required', 'recommended', 'info'].includes(c.level));
    }
    const required = report.checks.filter((c) => c.level === 'required');
    assert.ok(required.length >= 3);
    assert.equal(required.every((c) => c.ok), true);
    assert.equal(report.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('支持矩阵包含 iOS 限制说明', () => {
  assert.match(SUPPORT_MATRIX.ios, /iOS/u);
  assert.match(SUPPORT_MATRIX.nativeModules, /零原生模块/u);
  assert.equal(SUPPORT_MATRIX.minNode, '24.9.0');
});

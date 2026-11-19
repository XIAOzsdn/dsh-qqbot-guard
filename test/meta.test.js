/**
 * 版本号事实源测试：对外版本必须实时读盘 package.json，
 * 与磁盘上的 version 字段保持一致（换版本无需重启宿主）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getPluginVersion } from '../lib/meta.js';
import { readDeviceInfo } from '../lib/device.js';
import { ok } from '../lib/envelope.js';

function pkgVersion() {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return String(pkg.version || '').trim();
}

test('实时版本号与 package.json.version 一致', () => {
  assert.ok(pkgVersion(), 'package.json 必须声明 version');
  assert.equal(getPluginVersion(), pkgVersion());
});

test('设备信息里的插件版本同样实时一致', () => {
  const d = readDeviceInfo();
  assert.equal(d.pluginVersion, pkgVersion());
  assert.equal(d.webuiVersion, pkgVersion());
});

test('响应信封的 meta.version 实时一致', () => {
  assert.equal(ok({}).meta.version, pkgVersion());
});
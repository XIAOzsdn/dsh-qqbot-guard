import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import { createApi } from '../lib/api.js';
import { normalizeSettings } from '../lib/config.js';

function makeRuntime(dir) {
  const store = new Store(dir);
  const runtime = {
    store,
    dataDir: dir,
    version: '1.10.0',
    logger: { warn() {}, info() {} },
    getBot: () => null,
    getCompat: () => null,
    restartBot() {},
    needsLanguage: () => !store.settings.language,
  };
  return { store, runtime, api: createApi(runtime) };
}

test('首次部署默认没有语言，normalize 只接受 zh-CN / en', () => {
  const def = normalizeSettings({}).value;
  assert.equal(def.language, '');
  assert.equal(normalizeSettings({ language: 'en' }).value.language, 'en');
  assert.equal(normalizeSettings({ language: 'zh-CN' }).value.language, 'zh-CN');
  // 不认识的语言回落到“未选择”，逼迫重新选择而不是静默变成别的语言
  assert.equal(normalizeSettings({ language: 'fr-FR' }).value.language, '');
});

test('未选语言时只放行 bootstrap / language / health', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqg-lang-'));
  try {
    const { runtime, api } = makeRuntime(dir);
    assert.equal(runtime.needsLanguage(), true);

    let r = await api.dispatch({ method: 'GET', path: '/bootstrap', auth: { role: '', via: 'panel' } });
    assert.equal(r.ok, true);
    assert.equal(r.data.needsLanguage, true);
    assert.equal(r.data.language, '');

    r = await api.dispatch({ method: 'GET', path: '/members', auth: { role: 'admin', via: 'panel' } });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'LANGUAGE_REQUIRED');

    r = await api.dispatch({ method: 'POST', path: '/settings', auth: { role: 'admin', via: 'panel' }, body: { patch: { autoConnect: false } } });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'LANGUAGE_REQUIRED');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('选择语言后解锁服务，且不能重复选择', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqg-lang-'));
  try {
    const { store, runtime, api } = makeRuntime(dir);
    const anon = { role: '', via: 'panel' };

    let r = await api.dispatch({ method: 'POST', path: '/language', auth: anon, body: { language: 'fr' } });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'BAD_LANGUAGE');

    r = await api.dispatch({ method: 'POST', path: '/language', auth: anon, body: { language: 'en' } });
    assert.equal(r.ok, true);
    assert.equal(r.data.language, 'en');
    assert.equal(store.settings.language, 'en');
    assert.equal(runtime.needsLanguage(), false);

    // 已经选过就不能在未登录状态改
    r = await api.dispatch({ method: 'POST', path: '/language', auth: anon, body: { language: 'zh-CN' } });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'LANGUAGE_LOCKED');

    // 解锁后普通接口恢复
    r = await api.dispatch({ method: 'GET', path: '/bootstrap', auth: { role: 'admin', via: 'panel' } });
    assert.equal(r.ok, true);
    assert.equal(r.data.needsLanguage, false);
    assert.equal(r.data.language, 'en');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

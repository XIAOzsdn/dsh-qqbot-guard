import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import { buildSaveSettings, mountRoutes } from '../lib/http.js';
import { assertEnvelope } from '../lib/envelope.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'qqg-http-'));
  const store = new Store(dir);
  const routes = new Map();
  const server = {
    register(route) {
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    },
  };
  const ctx = {
    get(name) { return name === 'webServer' ? server : undefined; },
    effect() { return () => {}; },
  };
  const bot = {
    client: null,
    snapshot: () => ({ configured: false, state: 'unconfigured' }),
  };
  const runtime = {
    store,
    dataDir: dir,
    version: '1.0.0',
    logger: console,
    getBot: () => bot,
    getClient: () => bot.client,
    restartBot() {},
  };
  runtime.saveSettings = buildSaveSettings(runtime);
  assert.equal(mountRoutes(ctx, runtime), true);
  return { dir, store, routes, runtime, cleanup: () => { store.dispose(); rmSync(dir, { recursive: true, force: true }); } };
}

function call(routes, path, method = 'GET', opts = {}) {
  const route = routes.get(path);
  assert.ok(route, '路由应已注册: ' + path);
  return new Promise((resolve) => {
    const req = Readable.from(opts.body === undefined ? [] : [Buffer.from(JSON.stringify(opts.body))]);
    req.method = method;
    req.url = path + (opts.query || '');
    req.headers = Object.assign({ host: '127.0.0.1:3080' }, opts.headers || {});
    req.destroy = () => {};
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      end(text) {
        resolve({ status: this.statusCode, headers: this.headers, json: JSON.parse(text) });
      },
    };
    route.handler(req, res);
  });
}

test('bootstrap 返回合法信封', async () => {
  const { routes, store, cleanup } = setup();
  store.upsertGroup('g1', { name: '测试群' });
  store.upsertMember('g1', 'u1', { name: '小王' });
  const r = await call(routes, '/api/qqbot-guard/bootstrap');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assertEnvelope(r.json);
  assert.equal(r.json.data.groups[0].gid, 'g1');
  assert.equal(r.json.data.settings.appSecret, '');
  cleanup();
});

test('写接口必须带同源头与自定义头', async () => {
  const { routes, cleanup } = setup();
  const r1 = await call(routes, '/api/qqbot-guard/settings', 'POST', {
    body: { patch: { autoConnect: true } },
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(r1.json.ok, false);
  assert.equal(r1.json.error.code, 'FORBIDDEN');

  const r2 = await call(routes, '/api/qqbot-guard/settings', 'POST', {
    body: { patch: { autoConnect: true } },
    headers: { 'content-type': 'application/json', 'x-qqbot-guard': '1' },
  });
  assert.equal(r2.json.ok, true);
  assertEnvelope(r2.json);
  cleanup();
});

test('保存设置会归一化并热更新', async () => {
  const { routes, store, cleanup } = setup();
  const r = await call(routes, '/api/qqbot-guard/settings', 'POST', {
    body: { patch: { moderation: { action: 'mute', muteSeconds: 120 } } },
    headers: { 'content-type': 'application/json', 'x-qqbot-guard': '1' },
  });
  assert.equal(r.json.ok, true);
  assert.equal(store.settings.moderation.action, 'mute');
  assert.equal(store.settings.moderation.muteSeconds, 120);
  assert.equal(r.json.data.appSecret, '');
  cleanup();
});

test('成员搜索返回台账数据', async () => {
  const { routes, store, cleanup } = setup();
  store.upsertMember('g1', 'u2', { name: '阿强' });
  const r = await call(routes, '/api/qqbot-guard/members', 'GET', { query: '?gid=g1&q=阿强' });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.data.members.length, 1);
  assert.equal(r.json.data.members[0].uid, 'u2');
  cleanup();
});

test('公告创建与发布接口', async () => {
  const { routes, store, runtime, cleanup } = setup();
  runtime.getBot().client = { sendGroupText: async () => ({ ok: true }) };
  const created = await call(routes, '/api/qqbot-guard/announcements', 'POST', {
    body: { action: 'create', input: { content: '测试公告', targets: ['g1'] } },
    headers: { 'content-type': 'application/json', 'x-qqbot-guard': '1' },
  });
  assert.equal(created.json.ok, true);
  assert.equal(created.json.data.status, 'draft');
  const published = await call(routes, '/api/qqbot-guard/announcements', 'POST', {
    body: { action: 'publish', id: created.json.data.id },
    headers: { 'content-type': 'application/json', 'x-qqbot-guard': '1' },
  });
  assert.equal(published.json.ok, true);
  assert.equal(published.json.data.sent, 1);
  cleanup();
});

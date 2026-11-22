import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import { createApi } from '../lib/api.js';
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

test('修改日志记录设置变更并支持关键字筛选', async () => {
  const { routes, cleanup } = setup();
  const saved = await call(routes, '/api/qqbot-guard/settings', 'POST', {
    body: { patch: { moderation: { action: 'mute' } } },
    headers: { 'content-type': 'application/json', 'x-qqbot-guard': '1' },
  });
  assert.equal(saved.json.ok, true);

  const all = await call(routes, '/api/qqbot-guard/changelog');
  assert.equal(all.json.ok, true);
  assert.ok(all.json.data.items.length >= 1);
  const item = all.json.data.items[0];
  assert.equal(item.action, 'update');
  assert.equal(item.userName, '宿主设置页');
  assert.match(item.detail, /违规动作/u);
  assert.match(item.detail, /禁言/u);

  const hit = await call(routes, '/api/qqbot-guard/changelog', 'GET', { query: '?keyword=禁言' });
  assert.equal(hit.json.data.items.length, 1);
  const miss = await call(routes, '/api/qqbot-guard/changelog', 'GET', { query: '?keyword=不存在的关键字' });
  assert.equal(miss.json.data.items.length, 0);
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

test('通知对象校验：昵称与 openid 必须同时匹配', async () => {
  const { routes, runtime, store, cleanup } = setup();
  store.upsertMember('g1', 'u1', { name: '群主' });
  const headers = { 'content-type': 'application/json', 'x-qqbot-guard': '1' };

  let r = await call(routes, '/api/qqbot-guard/notify/verify', 'POST', {
    body: { name: '群主', uid: 'u1' }, headers,
  });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.data.matched, true);
  assert.equal(r.json.data.source, 'ledger');

  // 昵称不匹配：确定性失败
  r = await call(routes, '/api/qqbot-guard/notify/verify', 'POST', {
    body: { name: '别人', uid: 'u1' }, headers,
  });
  assert.equal(r.json.data.matched, false);
  assert.equal(r.json.data.definite, true);

  // 台账没有记录，但官方昵称接口能佐证
  runtime.getBot().client = { getUserInfo: async () => ({ ok: true, data: { username: '群主' } }) };
  r = await call(routes, '/api/qqbot-guard/notify/verify', 'POST', {
    body: { name: '群主', uid: 'unknown-openid' }, headers,
  });
  assert.equal(r.json.data.matched, true);
  assert.equal(r.json.data.source, 'api');

  // 填成 QQ 号时应提示改用 openid
  runtime.getBot().client = null;
  r = await call(routes, '/api/qqbot-guard/notify/verify', 'POST', {
    body: { name: '群主', uid: '123456789' }, headers,
  });
  assert.equal(r.json.data.matched, false);
  assert.equal(r.json.data.definite, true);
  assert.match(r.json.data.reason, /openid/u);
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

test('三次确认仅约束普通管理员', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqg-confirm-'));
  const store = new Store(dir);
  const notified = [];
  const runtime = {
    store,
    dataDir: dir,
    version: '1.1.0',
    logger: console,
    getBot: () => ({ snapshot: () => ({ configured: false, state: 'unconfigured' }) }),
    restartBot() {},
    notifySettingsChange(info) {
      notified.push(info.role);
      return { queued: true, groups: 1 };
    },
  };
  const api = createApi(runtime);
  const operator = { role: 'operator', via: 'panel', sessionId: 'op-1' };
  const admin = { role: 'admin', via: 'panel', sessionId: 'admin-1' };

  // 普通管理员改机器人级设置：没有令牌必须被拦截
  let r = await api.dispatch({
    method: 'POST', path: '/settings', auth: operator,
    body: { patch: { moderation: { action: 'mute' } } },
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'CONFIRM_REQUIRED');

  // 只改违规词属于基础修改，不需要三次确认
  r = await api.dispatch({
    method: 'POST', path: '/settings', auth: operator,
    body: { patch: { moderation: { keywords: ['测试词'] } } },
  });
  assert.equal(r.ok, true);

  // 普通管理员完成三次挑战后可保存
  let token = '';
  for (let i = 1; i <= 3; i++) {
    const c = await api.dispatch({ method: 'POST', path: '/settings/challenge', auth: operator });
    assert.equal(c.ok, true);
    if (i === 3) token = c.data.token;
  }
  assert.ok(token);
  r = await api.dispatch({
    method: 'POST', path: '/settings', auth: operator,
    body: { patch: { moderation: { action: 'mute' } }, confirmToken: token },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(notified, ['operator']);

  // 最高管理员改机器人级设置直接生效，不三次确认，也不在群里发任何消息
  r = await api.dispatch({
    method: 'POST', path: '/settings', auth: admin,
    body: { patch: { moderation: { action: 'kick' } } },
  });
  assert.equal(r.ok, true);
  assert.equal(store.settings.moderation.action, 'kick');
  assert.equal(r.data.notify, undefined);
  assert.deepEqual(notified, ['operator']);

  store.dispose();
  rmSync(dir, { recursive: true, force: true });
});

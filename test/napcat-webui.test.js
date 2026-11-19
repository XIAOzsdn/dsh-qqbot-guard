import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NapCatWebUi, webuiHash, discoverWebui, readWebuiToken } from '../lib/napcat-webui.js';
import { qrSvg } from '../lib/qr.js';

test('WebUI 口令：sha256(token + ".napcat")', () => {
  const want = createHash('sha256').update('secret.napcat').digest('hex');
  assert.equal(webuiHash('secret'), want);
  assert.equal(webuiHash(''), createHash('sha256').update('.napcat').digest('hex'));
});

test('从启动命令推断协议端 webui.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'qqg-webui-'));
  try {
    const cfg = join(root, 'napcat', 'config');
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, 'webui.json'), JSON.stringify({ host: '::', port: 6099, token: 'tok123' }), 'utf8');
    const bin = join(root, 'napcat.bat');
    writeFileSync(bin, '@echo off', 'utf8');
    const found = discoverWebui(`"${bin}" -q 10001`);
    assert.equal(found?.token, 'tok123');
    assert.equal(found?.port, 6099);
    assert.equal(readWebuiToken(join(cfg, 'webui.json'))?.token, 'tok123');
    assert.equal(discoverWebui(''), null);
    assert.equal(discoverWebui('C:\\not-exist\\napcat.bat'), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** 造一个假的 WebUI 服务：记录请求，按脚本回包 */
function stubFetch(script) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/u, '');
    const body = init.body ? JSON.parse(String(init.body)) : {};
    calls.push({ path, headers: init.headers || {}, body });
    const data = script(path, body, calls);
    return {
      ok: data.ok !== false,
      status: data.status || 200,
      json: async () => data.json,
    };
  };
  return { calls, restore() { globalThis.fetch = original; } };
}

test('登录状态：协议端返回字段映射成面板数据', async () => {
  const stub = stubFetch((path) => {
    if (path === '/api/auth/login') return { json: { code: 0, data: { Credential: 'cred-1' } } };
    if (path === '/api/QQLogin/CheckLoginStatus') {
      return { json: { code: 0, data: { isLogin: true, isOffline: false, loginPhase: 'ready', coreReady: true, qrcodeurl: '', loginError: '' } } };
    }
    return { json: { code: 0, data: { uin: '10001', nick: '测试号', online: true } } };
  });
  try {
    const webui = new NapCatWebUi({ baseUrl: 'http://127.0.0.1:6099', token: 'tok' });
    const s = await webui.status();
    assert.equal(s.configured, true);
    assert.equal(s.reachable, true);
    assert.equal(s.isLogin, true);
    assert.equal(s.uin, '10001');
    assert.equal(s.nick, '测试号');
    assert.equal(stub.calls[0].path, '/api/auth/login');
    assert.equal(stub.calls[0].body.hash, webuiHash('tok'));
    assert.equal(stub.calls[1].headers.authorization, 'Bearer cred-1');
  } finally {
    stub.restore();
  }
});

test('未配置 / 连不上：返回结构化原因，不抛异常', async () => {
  const webui = new NapCatWebUi({ baseUrl: '', token: '' });
  const s = await webui.status();
  assert.equal(s.configured, false);
  assert.match(s.reason, /WebUI 地址/u);

  const stub = stubFetch(() => ({ ok: false, status: 500, json: { code: -1, message: 'boom' } }));
  try {
    const broken = new NapCatWebUi({ baseUrl: 'http://127.0.0.1:6099', token: 'tok' });
    const r = await broken.status();
    assert.equal(r.configured, true);
    assert.equal(r.reachable, false);
    assert.match(r.reason, /boom/u);
  } finally {
    stub.restore();
  }
});

test('已登录时取二维码：把协议端原文翻成中文提示', async () => {
  const stub = stubFetch((path) => {
    if (path === '/api/auth/login') return { json: { code: 0, data: { Credential: 'c' } } };
    return { json: { code: -1, message: 'QQ Is Logined' } };
  });
  try {
    const webui = new NapCatWebUi({ baseUrl: 'http://127.0.0.1:6099', token: 'tok' });
    await assert.rejects(() => webui.qrcode(), /已登录 QQ/u);
  } finally {
    stub.restore();
  }
});

test('令牌过期（Unauthorized）自动重新登录一次', async () => {
  let loginCount = 0;
  let statusCount = 0;
  const stub = stubFetch((path) => {
    if (path === '/api/auth/login') {
      loginCount += 1;
      return { json: { code: 0, data: { Credential: `cred-${loginCount}` } } };
    }
    statusCount += 1;
    if (statusCount === 1) return { json: { code: -1, message: 'Unauthorized' } };
    return { json: { code: 0, data: { isLogin: true, uin: '10001', nick: 'x', online: true } } };
  });
  try {
    const webui = new NapCatWebUi({ baseUrl: 'http://127.0.0.1:6099', token: 'tok' });
    const s = await webui.status();
    assert.equal(s.isLogin, true);
    assert.ok(loginCount >= 2, `应至少重新登录一次，实际 ${loginCount}`);
  } finally {
    stub.restore();
  }
});

test('快速登录：带上 QQ 号调用 SetQuickLogin，格式不对直接拒绝', async () => {
  const stub = stubFetch((path) => {
    if (path === '/api/auth/login') return { json: { code: 0, data: { Credential: 'c' } } };
    return { json: { code: 0, data: null } };
  });
  try {
    const webui = new NapCatWebUi({ baseUrl: 'http://127.0.0.1:6099', token: 'tok' });
    assert.equal(await webui.quickLogin('10001'), '10001');
    const call = stub.calls.find((x) => x.path === '/api/QQLogin/SetQuickLogin');
    assert.deepEqual(call.body, { uin: '10001' });
    await assert.rejects(() => webui.quickLogin('abc'), /QQ 号格式/u);
  } finally {
    stub.restore();
  }
});

test('二维码服务端渲染：返回内联 SVG，空文本返回空串', () => {
  const svg = qrSvg('https://qun.qq.com/qrcode?x=1');
  assert.match(svg, /^<svg/u);
  assert.match(svg, /<\/svg>$/u);
  assert.equal(qrSvg(''), '');
  assert.equal(qrSvg('同一内容'), qrSvg('同一内容'));
  assert.notEqual(qrSvg('a'), qrSvg('b'));
});

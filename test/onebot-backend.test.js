import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { probeTcp, spawnBackend, wsTarget } from '../lib/onebot-backend.js';

test('wsTarget 解析 ws/wss 地址', () => {
  assert.deepEqual(wsTarget('ws://127.0.0.1:3001'), { host: '127.0.0.1', port: 3001 });
  assert.deepEqual(wsTarget('wss://example.com/onebot'), { host: 'example.com', port: 80 });
  assert.deepEqual(wsTarget('ws://[::1]:3001'), { host: '::1', port: 3001 });
  assert.equal(wsTarget('not-a-url'), null);
  assert.equal(wsTarget(''), null);
});

test('probeTcp：监听中的端口可连，未监听返回 false', async () => {
  const server = createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    assert.equal(await probeTcp('127.0.0.1', port, 1000), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.equal(await probeTcp('127.0.0.1', port, 300), false);
});

test('spawnBackend：空命令返回错误，不抛异常', () => {
  const r = spawnBackend('');
  assert.equal(r.ok, false);
  assert.match(r.error, /启动命令/);
});

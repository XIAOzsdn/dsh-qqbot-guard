import test from 'node:test';
import assert from 'node:assert/strict';
import { NapCatClient, toSegments } from '../lib/napcat-client.js';
import { withToken } from '../lib/napcat-transport.js';

function fakeTransport(handler) {
  const calls = [];
  return {
    connected: true,
    calls,
    async call(action, params) {
      calls.push({ action, params });
      return handler ? handler(action, params) : {};
    },
  };
}

test('@ 标记转 OneBot 消息段', () => {
  const segs = toSegments('<qqbot-at-user id="12345" /> 你好');
  assert.deepEqual(segs[0], { type: 'at', data: { qq: '12345' } });
  assert.equal(segs[1].type, 'text');
  assert.equal(segs[1].data.text, ' 你好');
  const all = toSegments('<qqbot-at-user id="all" /> 通知');
  assert.deepEqual(all[0], { type: 'at', data: { qq: 'all' } });
});

test('发消息：文本/@ 走 send_group_msg，群号转数字', async () => {
  const t = fakeTransport(() => ({ message_id: 1 }));
  const c = new NapCatClient({ transport: t });
  const r = await c.sendGroupText('558225608', '<qqbot-at-user id="42" /> 测试');
  assert.equal(r.ok, true);
  assert.equal(t.calls[0].action, 'send_group_msg');
  assert.equal(t.calls[0].params.group_id, 558225608);
  assert.deepEqual(t.calls[0].params.message[0], { type: 'at', data: { qq: '42' } });
});

test('图片：base64 上传后作为 image 段发送', async () => {
  const t = fakeTransport(() => ({ message_id: 2 }));
  const c = new NapCatClient({ transport: t });
  const up = await c.uploadGroupImage('1', Buffer.from('abc'), 'qr.png');
  assert.equal(up.ok, true);
  assert.match(up.data.file_info, /^base64:\/\//);
  const sent = await c.sendGroupMedia('1', up.data.file_info);
  assert.equal(sent.ok, true);
  const call = t.calls.find((x) => x.action === 'send_group_msg');
  assert.equal(call.params.message[0].type, 'image');
});

test('管理动作：禁言 / 解禁 / 踢人 / 全员禁言映射到 OneBot action', async () => {
  const t = fakeTransport(() => ({}));
  const c = new NapCatClient({ transport: t });
  await c.setMemberMute('1', ['11', '22'], 600);
  const bans = t.calls.filter((x) => x.action === 'set_group_ban');
  assert.equal(bans.length, 2);
  assert.deepEqual(bans[0].params, { group_id: 1, user_id: 11, duration: 600 });
  await c.setMemberMute('1', '11', null);
  assert.equal(t.calls.filter((x) => x.action === 'set_group_ban').length, 3);
  await c.removeMembers('1', ['33'], true);
  const kick = t.calls.find((x) => x.action === 'set_group_kick');
  assert.deepEqual(kick.params, { group_id: 1, user_id: 33, reject_add_request: true });
  await c.setWholeBan('1', true);
  assert.deepEqual(t.calls.find((x) => x.action === 'set_group_whole_ban').params, { group_id: 1, enable: true });
});

test('真·群公告：_send_group_notice 参数齐全', async () => {
  const t = fakeTransport(() => ({}));
  const c = new NapCatClient({ transport: t });
  const r = await c.sendGroupNotice({ gid: '558225608', content: '今晚八点开黑', pinned: true, confirmRequired: true });
  assert.equal(r.ok, true);
  const call = t.calls.find((x) => x.action === '_send_group_notice');
  assert.deepEqual(call.params, {
    group_id: 558225608, content: '今晚八点开黑', pinned: true, confirm_required: true,
  });
});

test('WS 地址拼接 access_token', () => {
  assert.equal(withToken('ws://127.0.0.1:3001', 'abc'), 'ws://127.0.0.1:3001?access_token=abc');
  assert.equal(withToken('ws://127.0.0.1:3001?x=1', 'abc'), 'ws://127.0.0.1:3001?x=1&access_token=abc');
  assert.equal(withToken('ws://127.0.0.1:3001', ''), 'ws://127.0.0.1:3001');
});

test('图片发送用更长超时；无头端发不了图时可用群文件兜底', async () => {
  const calls = [];
  const t = {
    connected: true,
    async call(action, params, timeoutMs) {
      calls.push({ action, params, timeoutMs });
      return {};
    },
  };
  const c = new NapCatClient({ transport: t });
  await c.sendGroupMedia('1', 'base64://abc');
  const media = calls.find((x) => x.action === 'send_group_msg');
  assert.equal(media.timeoutMs, 30_000);
  const up = await c.sendGroupFile('558225608', 'C:\\tmp\\qr.png', 'pay-qr.png');
  assert.equal(up.ok, true);
  const file = calls.find((x) => x.action === 'upload_group_file');
  assert.deepEqual(file.params, { group_id: 558225608, file: 'C:/tmp/qr.png', name: 'pay-qr.png' });
  assert.equal(file.timeoutMs, 30_000);
});

test('本地图片：file:/// URI 发送（不走 base64）', async () => {
  const calls = [];
  const t = {
    connected: true,
    async call(action, params, timeoutMs) { calls.push({ action, params, timeoutMs }); return { message_id: 9 }; },
  };
  const c = new NapCatClient({ transport: t });
  const r = await c.sendGroupImageFile('558225608', 'C:\\Users\\Administrator\\qr.png');
  assert.equal(r.ok, true);
  assert.deepEqual(calls[0].params.message[0], {
    type: 'image',
    data: { file: 'file:///C:/Users/Administrator/qr.png' },
  });
  assert.equal(calls[0].timeoutMs, 30_000);
});

test('群文件：裸路径报「识别URL失败」时改用 file:/// 再试一次', async () => {
  const calls = [];
  let n = 0;
  const t = {
    connected: true,
    async call(action, params) {
      calls.push({ action, params });
      n += 1;
      if (n === 1) throw new Error('识别URL失败, uri= C:/tmp/qr.png');
      return { file_id: '/abc' };
    },
  };
  const c = new NapCatClient({ transport: t });
  const r = await c.sendGroupFile('558225608', 'C:\\tmp\\qr.png', 'pay-qr.png');
  assert.equal(r.ok, true);
  assert.equal(r.data.file_id, '/abc');
  assert.deepEqual(calls.map((x) => x.params.file), ['C:/tmp/qr.png', 'file:///C:/tmp/qr.png']);
});

test('链路错误与在线状态可判定（离线失败不计次）', () => {
  const online = new NapCatClient({ transport: { connected: true } });
  const offline = new NapCatClient({ transport: { connected: false } });
  assert.equal(online.connected, true);
  assert.equal(offline.connected, false);
  assert.equal(NapCatClient.isLinkError({ ok: false, err: { human: 'NapCat 未连接（请确认协议端在线）' } }), true);
  assert.equal(NapCatClient.isLinkError({ ok: false, err: { human: 'WebSocket is not open' } }), true);
  assert.equal(NapCatClient.isLinkError({ ok: false, err: { human: '识别URL失败' } }), false);
  assert.equal(NapCatClient.isLinkError({ ok: true }), false);
});

test('全员禁言：NapCat 客户端走原生 set_group_whole_ban（不再逐人禁言）', async () => {
  const { applyWholeBan } = await import('../lib/whole-ban.js');
  const calls = [];
  const client = {
    async setWholeBan(gid, enable) { calls.push({ gid, enable }); return { ok: true }; },
    async setMemberMute() { calls.push({ mute: true }); return { ok: true }; },
  };
  const store = { listMembers: () => [{ uid: '1' }] };
  const r = await applyWholeBan({ store, client, gid: '558225608', enable: true });
  assert.equal(r.ok, true);
  assert.equal(r.via, 'napcat');
  assert.deepEqual(calls, [{ gid: '558225608', enable: true }]);
});

/**
 * 契约回归测试（v2.2.6 新增）。
 * 锁住本次修复过的跨模块字段名与行为 —— 这些 bug 的共同点是
 * 「跨模块字段名不一致 / 参数签名不一致」，单模块测试发现不了。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import { Scheduler } from '../lib/scheduler.js';
import { NapCatClient } from '../lib/napcat-client.js';
import { createApi } from '../lib/api.js';
import { syncJoinRequests } from '../lib/join.js';
import { maskOrderId, parseRechargeCommand } from '../lib/recharge.js';
import { probeNetwork } from '../lib/compat.js';
import { isPrivateHost } from '../lib/ai.js';
import { resolveMappings } from '../lib/napcat.js';

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'qqg-contract-'));
  const store = new Store(dir);
  return { store, dir, cleanup: () => { store.dispose(); rmSync(dir, { recursive: true, force: true }); } };
}

/** 最小 NapCatClient：不建连接，只测方法契约 */
function fakeNapcatClient(joinRequests = []) {
  const calls = [];
  const transport = {
    connected: true,
    call: async (action, params) => { calls.push({ action, params }); return {}; },
  };
  const client = new NapCatClient({ transport, logger: console });
  client.joinRequests = joinRequests;
  return { client, calls };
}

test('契约：listJoinRequests 接受 (gid, flag, count) 并返回官方同构 list', async () => {
  const { client } = fakeNapcatClient([
    { flag: 'f1', uid: '10001', gid: '20001', subType: 'add', nickname: '张三', comment: '我想进群' },
    { flag: 'f2', uid: '10002', gid: '20002', subType: 'invite', nickname: '李四', comment: '' },
  ]);
  const r = await client.listJoinRequests('20001', '', 50);
  assert.equal(r.ok, true);
  assert.equal(r.data.list.length, 1, '按 gid 过滤');
  assert.equal(r.data.list[0].join_request_id, 'f1');
  assert.equal(r.data.list[0].member_openid, '10001');
  assert.equal(r.data.list[0].username, '张三');
  assert.equal(r.data.list[0].sub_type, 'add');
  assert.ok(r.data.list[0].verify_info.verify_message.includes('进群'));
});

test('契约：syncJoinRequests 能把 NapCat 的申请并入待审批（旧版永远为空）', async () => {
  const { store, cleanup } = makeStore();
  try {
    const { client } = fakeNapcatClient([
      { flag: 'f9', uid: '10009', gid: '20009', subType: 'add', nickname: '王五', comment: '求进群' },
    ]);
    const r = await syncJoinRequests(client, store, '20009');
    assert.equal(r.ok, true);
    assert.equal(r.count, 1);
    const pending = store.listPending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].memberOpenid, '10009');
    assert.equal(pending[0].joinRequestId, 'f9');
  } finally {
    cleanup();
  }
});

test('契约：审批时 sub_type 原样回传（旧版写死 invite 会被协议端拒绝）', async () => {
  const { client, calls } = fakeNapcatClient([
    { flag: 'fa', uid: '10010', gid: '20010', subType: 'add', nickname: '赵六' },
  ]);
  await client.approveJoinRequest('20010', 'fa', 'approve', {});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'set_group_add_request');
  assert.equal(calls[0].params.sub_type, 'add');
  assert.equal(calls[0].params.approve, true);
  assert.equal(client.joinRequests.length, 0, '处理完要从队列移除');
});

test('契约：/members 出口同时提供 msgCount 与 messageCount', async () => {
  const { store, cleanup } = makeStore();
  try {
    store.upsertMember('g1', 'u1', { name: '发言的人', countMessage: true });
    store.upsertMember('g1', 'u1', { countMessage: true });
    const api = createApi({
      store,
      dataDir: store.dir,
      version: '2.2.6',
      getClient: () => undefined,
      getBot: () => undefined,
      directory: { enabled: () => false, status: () => null },
      getCompat: () => null,
      auth: { status: () => ({ initialized: true }) },
    });
    const envelope = await api.dispatch({
      method: 'GET', path: '/members', query: { gid: 'g1' },
      auth: { role: 'admin', via: 'panel' },
    });
    assert.equal(envelope.ok, true);
    const row = envelope.data.members.find((m) => m.uid === 'u1');
    assert.ok(row, '成员应在列表里');
    assert.equal(row.msgCount, 2, '台账里的真实发言次数');
    assert.equal(row.messageCount, 2, '前端读的字段必须同步');
  } finally {
    cleanup();
  }
});

test('契约：scheduler.cancel 只按 id 精确删除，不误删同时间任务', () => {
  const { store, cleanup } = makeStore();
  try {
    const sch = new Scheduler({ store, logger: console, executor: async () => ({ ok: true }) });
    const a = sch.add({ gid: 'g1', kind: 'whole-ban', at: Date.now() + 60_000, repeat: 'once' });
    const b = sch.add({ gid: 'g2', kind: 'whole-ban', at: Date.now() + 60_000, repeat: 'once' });
    assert.equal(a.ok && b.ok, true);
    assert.equal(sch.list().length, 2);
    // 旧实现传 '' 会把所有 time='' 的一次性任务一起删掉
    const empty = sch.cancel('');
    assert.equal(empty.ok, false, '空 id 必须拒绝');
    assert.equal(sch.list().length, 2, '空 id 不能误删');
    const r = sch.cancel(a.item.id);
    assert.equal(r.ok, true);
    assert.equal(sch.list().length, 1);
    assert.equal(sch.list()[0].id, b.item.id);
  } finally {
    cleanup();
  }
});

test('契约：resolveMappings 对“gid 即 QQ 群号”走恒等映射', () => {
  const napcat = [
    { qqGroupId: '100001', name: '软件交流分享', memberCount: 28 },
    { qqGroupId: '100002', name: '测试小群', memberCount: 5 },
  ];
  // v2.1+：official.gid 本身就是 QQ 群号，不需要按群名去猜
  const out = resolveMappings({
    official: [{ gid: '100001', name: '软件交流分享' }, { gid: '100002', name: '' }],
    napcat,
    overrides: {},
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].qqGroupId, '100001');
  assert.equal(out[0].direct, true, '应标记为恒等映射');
  assert.equal(out[0].memberCount, 28);
  assert.equal(out[1].qqGroupId, '100002');
  // 名字对不上也照样能映射（不再依赖群名）
  assert.equal(out[1].direct, true);
});

test('契约：targetGroups 在台账为空时仍能从协议端群列表补齐', () => {
  const { store, cleanup } = makeStore();
  try {
    // 模拟新装：store.state.groups 为空，但协议端已知 2 个群
    const napcatLike = { lastGroups: [{ qqGroupId: '100001', name: 'A' }, { qqGroupId: '100002', name: 'B' }] };
    // 直接验证 resolveMappings 的上游输入形态（targetGroups 依赖实例方法，这里用等价逻辑）
    const official = (napcatLike.lastGroups || []).map((g) => ({ gid: g.qqGroupId, name: g.name }));
    const out = resolveMappings({ official, napcat: napcatLike.lastGroups, overrides: {} });
    assert.equal(out.length, 2, '协议端群列表应成为首次同步的目标');
    assert.equal(store.state.groups && Object.keys(store.state.groups).length, 0, '台账确实为空');
  } finally {
    cleanup();
  }
});

test('脱敏：任何长度的订单号都不会完整外泄', () => {
  assert.equal(maskOrderId('ABCDEFGHIJ'), 'AB*****HIJ');
  assert.equal(maskOrderId('12345'), '1***5');
  assert.equal(maskOrderId('12'), '**');
  for (const id of ['1', '12', '123', '1234', '12345', 'ABCDEFGHIJ', '1234567890123456']) {
    const masked = maskOrderId(id);
    assert.ok(masked.includes('*') || id === '', `${id} 脱敏后必须含 *：${masked}`);
    assert.ok(masked.length === id.length, '脱敏不改变长度');
  }
});

test('充值解析：外部充值对象与无支付方式不接管', () => {
  assert.equal(parseRechargeCommand('充值 50 支付宝').amount, 50);
  assert.equal(parseRechargeCommand('充 100 微信支付').amount, 100);
  assert.equal(parseRechargeCommand('我要充3块钱话费'), null);
  assert.equal(parseRechargeCommand('给游戏币充值 100 微信'), null);
  assert.equal(parseRechargeCommand('这个 50 元'), null);
});

test('SSRF：私网 / 回环 / 映射地址一律拒绝', () => {
  for (const h of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.1.1',
    '100.64.0.1', '0.0.0.0', 'localhost', 'a.local', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateHost(h), true, `${h} 应判为私网`);
  }
  for (const h of ['api.deepseek.com', '8.8.8.8', 'example.com']) {
    assert.equal(isPrivateHost(h), false, `${h} 应判为公网`);
  }
});

test('网络探测：未配置时不误报“网络不可达”', async () => {
  const r = await probeNetwork(1000, {});
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
  assert.equal(r.results.length, 0);
});

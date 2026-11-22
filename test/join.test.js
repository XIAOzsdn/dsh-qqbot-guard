import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import { actOnJoinRequest, handleJoinRequest, handleMemberAdd, syncJoinRequests, verifyHuman } from '../lib/join.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'qqg-join-'));
  const store = new Store(dir);
  return { store, cleanup: () => { store.dispose(); rmSync(dir, { recursive: true, force: true }); } };
}

function fakeClient() {
  const calls = [];
  return {
    calls,
    approveJoinRequest: async (...args) => { calls.push(['approve', ...args]); return { ok: true }; },
    sendGroupText: async (...args) => { calls.push(['send', ...args]); return { ok: true }; },
    listJoinRequests: async () => ({
      ok: true,
      data: {
        list: [
          { join_request_id: 'j9', member_openid: 'u9', username: '九号', apply_source: 'self_apply' },
          { join_request_id: 'j10', member_openid: 'u10', username: '十号', risk_tips: '可疑' },
        ],
      },
    }),
  };
}

test('验证信息人话化', () => {
  assert.equal(verifyHuman({ verify_message: '我是小王' }), '我是小王');
  assert.equal(verifyHuman({ method: 'qa' }), '问题验证');
  assert.equal(verifyHuman({ review_qa_list: [{ question: '口号', answer: '友善' }] }), '口号「友善」');
});

test('风险提示自动拒绝', async () => {
  const { store, cleanup } = setup();
  const client = fakeClient();
  const r = await handleJoinRequest(
    { group_openid: 'g1', member_openid: 'u1', join_request_id: 'j1', username: '小号', risk_tips: '新注册' },
    { store, getClient: () => client },
  );
  assert.equal(r.decision, 'decline');
  assert.equal(client.calls[0][0], 'approve');
  assert.equal(client.calls[0][3], 'decline');
  assert.equal(store.listPending(true).find((x) => x.joinRequestId === 'j1').status, 'done');
  cleanup();
});

test('自动通过关键词', async () => {
  const { store, cleanup } = setup();
  store.saveSettings({ join: { autoApprove: true, approveKeywords: ['朋友'] } });
  const client = fakeClient();
  const r = await handleJoinRequest(
    { group_openid: 'g1', member_openid: 'u2', join_request_id: 'j2', verify_info: { verify_message: '朋友介绍' } },
    { store, getClient: () => client },
  );
  assert.equal(r.decision, 'approve');
  cleanup();
});

test('无自动策略时进入待审批', async () => {
  const { store, cleanup } = setup();
  const client = fakeClient();
  const r = await handleJoinRequest(
    { group_openid: 'g1', member_openid: 'u3', join_request_id: 'j3', verify_info: { verify_message: '你好' } },
    { store, getClient: () => client },
  );
  assert.equal(r.decision, 'pending');
  assert.equal(store.listPending().length, 1);
  cleanup();
});

test('手动审批成功后移除待办', async () => {
  const { store, cleanup } = setup();
  const client = fakeClient();
  await handleJoinRequest(
    { group_openid: 'g1', member_openid: 'u4', join_request_id: 'j4' },
    { store, getClient: () => client },
  );
  const r = await actOnJoinRequest({ client, store, gid: 'g1', uid: 'u4', jid: 'j4', action: 'approve' });
  assert.equal(r.ok, true);
  assert.equal(store.listPending().length, 0);
  cleanup();
});

test('从官方同步待审批并合并', async () => {
  const { store, cleanup } = setup();
  const client = fakeClient();
  const r = await syncJoinRequests(client, store, 'g1');
  assert.equal(r.ok, true);
  assert.equal(r.count, 2);
  assert.equal(store.listPending().length, 2);
  cleanup();
});

test('欢迎语按种子固定且替换变量', async () => {
  const { store, cleanup } = setup();
  store.saveSettings({ join: { welcome: { enabled: true, variants: ['欢迎 {user}', '你好 {user}'] } } });
  store.upsertGroup('g1', { name: '测试群' });
  const client = fakeClient();
  const ev = { group_openid: 'g1', member_openid: 'u5', username: '五号' };
  await handleMemberAdd(ev, { store, getClient: () => client, appId: 'app' });
  await handleMemberAdd(ev, { store, getClient: () => client, appId: 'app' });
  const texts = client.calls.filter((x) => x[0] === 'send').map((x) => x[2]);
  assert.equal(texts.length, 2);
  assert.equal(texts[0], texts[1]);
  assert.match(texts[0], /<@u5>/);
  cleanup();
});

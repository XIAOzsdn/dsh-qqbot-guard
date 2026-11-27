/** 自然语言管理后台：本地关键词解析、执行器、AI 意图校验。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import {
  ADMIN_ACTION_NAMES, executeAdminIntent, parseAdminIntent,
  decodeNoticeText, formatNoticeList,
} from '../lib/natural-admin.js';
import { parseIntentReply } from '../lib/ai.js';
import { handleNaturalCommand } from '../lib/natural.js';

function makeStore(settings = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'qqg-nadmin-'));
  const store = new Store(dir);
  store.saveSettings(settings);
  return { store, dir, cleanup: () => { store.dispose(); rmSync(dir, { recursive: true, force: true }); } };
}

function fakeSaver(store, captured) {
  return async (patch, meta) => {
    captured.push({ patch, meta });
    const merged = { ...store.settings, ...patch };
    store.saveSettings(merged);
    return { ok: true, data: {}, error: null };
  };
}

test('本地关键词：查询类指令', () => {
  assert.equal(parseAdminIntent('列出所有群成员名单').action, 'list-members');
  assert.equal(parseAdminIntent('看看花名册').action, 'list-members');
  assert.equal(parseAdminIntent('列一下成员').action, 'list-members');
  assert.equal(parseAdminIntent('查看黑名单').action, 'list-blacklist');
  assert.equal(parseAdminIntent('有哪些白名单成员').action, 'list-whitelist');
  assert.equal(parseAdminIntent('看看信任成员').action, 'list-trusted');
  assert.equal(parseAdminIntent('查看违规词').action, 'list-keywords');
  assert.equal(parseAdminIntent('当前设置是什么').action, 'list-settings');
  assert.equal(parseAdminIntent('有哪些待审批').action, 'list-pending');
  assert.equal(parseAdminIntent('看看公告列表').action, 'list-announcements');
  assert.equal(parseAdminIntent('同步一下花名册').action, 'sync-directory');
});

test('入群审批关键词：查询 / 添加 / 删除不会被“违规词”抢走', async () => {
  assert.equal(parseAdminIntent('列出入群审批通过关键词').action, 'list-join-keywords');
  assert.equal(parseAdminIntent('查看入群审批拒绝关键词').action, 'list-decline-keywords');
  assert.equal(parseAdminIntent('添加入群通过关键词 学生').args.word, '学生');
  assert.equal(parseAdminIntent('删除入群通过关键词 学生').action, 'del-join-keyword');
  // 未限定种类时仍走违规词
  assert.equal(parseAdminIntent('查看关键词').action, 'list-keywords');

  const env = makeStore({ join: { autoApprove: true, approveKeywords: ['学生'], declineKeywords: [] } });
  const store = env.store;
  try {
    let r = await executeAdminIntent({ intent: { action: 'list-join-keywords' }, gid: 'g1', uid: 'u1', name: '管理员', store });
    assert.equal(r.ok, true);
    assert.match(r.message, /通过关键词 1 个/);
    assert.match(r.message, /学生/);

    const captured = [];
    const saveSettings = fakeSaver(store, captured);
    r = await executeAdminIntent({ intent: { action: 'add-join-keyword', args: { word: '同事' } }, gid: 'g1', uid: 'u1', name: '管理员', store, saveSettings });
    assert.equal(r.ok, true);
    assert.deepEqual(store.settings.join.approveKeywords, ['学生', '同事']);

    r = await executeAdminIntent({ intent: { action: 'del-join-keyword', args: { word: '学生' } }, gid: 'g1', uid: 'u1', name: '管理员', store, saveSettings });
    assert.equal(r.ok, true);
    assert.deepEqual(store.settings.join.approveKeywords, ['同事']);
    assert.ok(captured.some((p) => p.patch.join && Array.isArray(p.patch.join.approveKeywords)));
  } finally {
    env.cleanup();
  }
});

test('本地关键词：修改类指令取参数', () => {
  const add = parseAdminIntent('添加违规词 广告狗');
  assert.equal(add.action, 'add-keyword');
  assert.equal(add.args.word, '广告狗');

  const del = parseAdminIntent('删除违规词「广告狗」');
  assert.equal(del.action, 'del-keyword');
  assert.equal(del.args.word, '广告狗');

  const mute = parseAdminIntent('默认禁言时长设为 10 分钟');
  assert.equal(mute.action, 'set-mute-seconds');
  assert.equal(mute.args.seconds, 600);

  const act = parseAdminIntent('违规处置改为禁言');
  assert.equal(act.action, 'set-action');
  assert.equal(act.args.action, '禁言');

  const prefix = parseAdminIntent('指令前缀改为 !');
  assert.equal(prefix.action, 'set-prefix');
  assert.equal(prefix.args.text, '!');

  const welcome = parseAdminIntent('入群欢迎语改为 欢迎新朋友');
  assert.equal(welcome.action, 'set-welcome');
  assert.equal(welcome.args.text, '欢迎新朋友');

  const announce = parseAdminIntent('发公告 今晚八点开黑');
  assert.equal(announce.action, 'announce');
  assert.equal(announce.args.text, '今晚八点开黑');

  const off = parseAdminIntent('关闭自动审核');
  assert.equal(off.action, 'toggle');
  assert.equal(off.args.feature, 'moderation');
  assert.equal(off.args.enabled, false);

  const on = parseAdminIntent('开启自然语言指令');
  assert.equal(on.args.feature, 'natural');
  assert.equal(on.args.enabled, true);
});

test('执行器：发公告会真正发布到当前群（不是只保存）', async () => {
  const { store, cleanup } = makeStore();
  const published = [];
  try {
    const r = await executeAdminIntent({
      intent: { action: 'announce', args: { text: '今晚八点开黑' } },
      gid: 'g1', uid: 'u1', name: '管理员', store, settings: store.settings,
      sendAnnouncement: async (item) => { published.push(item); return { ok: true, sent: 1 }; },
    });
    assert.equal(r.ok, true);
    assert.equal(published.length, 1);
    assert.deepEqual(published[0].targets, ['g1']);
    assert.equal(published[0].content, '今晚八点开黑');
    assert.match(r.message, /已发布.*1 个群/);
    assert.equal(store.announcements.items[0].content, '今晚八点开黑');
  } finally {
    cleanup();
  }
});

test('执行器：NapCat 可用时发公告默认走真·群公告', async () => {
  const { store, cleanup } = makeStore();
  const published = [];
  try {
    const r = await executeAdminIntent({
      intent: { action: 'announce', args: { text: '置顶通知' } },
      gid: 'g1', uid: 'u1', name: '管理员', store, settings: store.settings,
      directory: { enabled: () => true },
      sendAnnouncement: async (item) => { published.push(item); return { ok: true, sent: 1, item: { results: [{ mode: 'notice' }] } }; },
    });
    assert.equal(r.ok, true);
    assert.equal(published[0].mode, 'notice');
    assert.match(r.message, /真·群公告/);
  } finally {
    cleanup();
  }
});

test('群公告展示：两条都显示、还原换行实体、标出置顶与图片', () => {
  const items = [
    {
      notice_id: 'a', sender_id: 1, publish_time: 1795716563, read_num: 1,
      message: { text: '远程电脑重装服务，沟通请用微信扫描二维码&#10;联系管理员', image: [{ id: 'x', width: '576', height: '570' }] },
      settings: { confirm_required: 0 },
    },
    {
      notice_id: 'b', sender_id: 1, publish_time: 1795717405, read_num: 3, pinned: true, send_to_new_member: true,
      message: { text: '群规则&#10;欢迎加入本群！&#10;1.&nbsp;禁止刷单', image: [] },
      settings: { confirm_required: 1 },
    },
  ];
  const text = formatNoticeList(items);
  assert.match(text, /共 2 条/);
  assert.match(text, /【远程电脑重装服务/);
  assert.match(text, /【群规则】/);
  assert.match(text, /〔置顶〕/);
  assert.match(text, /〔需确认〕/);
  assert.match(text, /含 1 张图片/);
  assert.ok(!text.includes('&#10;'), '不应残留 HTML 实体');
  assert.ok(!text.includes('&nbsp;'));
});

test('群公告文本解码：实体、换行、HTML 标签', () => {
  assert.equal(decodeNoticeText('a&#10;b'), 'a\nb');
  assert.equal(decodeNoticeText('a&nbsp;b'), 'a b');
  assert.equal(decodeNoticeText('<b>x</b>'), 'x');
  assert.equal(decodeNoticeText(''), '');
});

test('本地关键词：不抢成员处置类指令', () => {
  assert.equal(parseAdminIntent('把“广告小王”踢出群聊'), null);
  assert.equal(parseAdminIntent('禁言 张三 10 分钟'), null);
  assert.equal(parseAdminIntent('警告 张三'), null);
  assert.equal(parseAdminIntent('看看群里有多少人'), null);
});

test('执行器：添加 / 删除违规词会走 saveSettings 并持久化', async () => {
  const { store, cleanup } = makeStore();
  const captured = [];
  const saveSettings = fakeSaver(store, captured);

  const add = await executeAdminIntent({
    intent: parseAdminIntent('添加违规词 广告狗'), gid: 'g1', uid: 'u1', name: '管理员', store, settings: store.settings, saveSettings,
  });
  assert.equal(add.ok, true);
  assert.ok(add.message.includes('广告狗'));
  assert.equal(captured.length, 1);
  assert.ok(store.settings.moderation.keywords.includes('广告狗'));

  const dup = await executeAdminIntent({
    intent: parseAdminIntent('添加违规词 广告狗'), gid: 'g1', uid: 'u1', name: '管理员', store, settings: store.settings, saveSettings,
  });
  assert.equal(dup.ok, true);
  assert.ok(dup.message.includes('已经在列表里'));

  const del = await executeAdminIntent({
    intent: parseAdminIntent('删除违规词 广告狗'), gid: 'g1', uid: 'u1', name: '管理员', store, settings: store.settings, saveSettings,
  });
  assert.equal(del.ok, true);
  assert.equal(store.settings.moderation.keywords.includes('广告狗'), false);
});

test('执行器：设置默认禁言时长 / 处置方式 / 开关', async () => {
  const { store, cleanup } = makeStore();
  const captured = [];
  const saveSettings = fakeSaver(store, captured);

  const mute = await executeAdminIntent({
    intent: parseAdminIntent('默认禁言时长设为 10 分钟'), gid: 'g1', uid: 'u1', name: '管理员', store, settings: store.settings, saveSettings,
  });
  assert.equal(mute.ok, true);
  assert.equal(store.settings.moderation.muteSeconds, 600);

  const act = await executeAdminIntent({
    intent: parseAdminIntent('违规处置改为禁言'), gid: 'g1', uid: 'u1', name: '管理员', store, settings: store.settings, saveSettings,
  });
  assert.equal(act.ok, true);
  assert.equal(store.settings.moderation.action, 'mute');

  const off = await executeAdminIntent({
    intent: parseAdminIntent('关闭闲聊'), gid: 'g1', uid: 'u1', name: '管理员', store, settings: store.settings, saveSettings,
  });
  assert.equal(off.ok, true);
  assert.equal(store.settings.guest.enabled, false);
});

test('执行器：黑名单增删支持按昵称找回', async () => {
  const { store, cleanup } = makeStore();
  store.upsertMember('g1', 'u5', { name: '广告小王' });
  store.addBlacklist('g1', 'u5', { name: '广告小王' });
  const saveSettings = fakeSaver(store, []);

  const add = await executeAdminIntent({
    intent: { action: 'add-blacklist', target: '广告小王', args: {} }, gid: 'g1', uid: 'u1', name: '管理员', store, settings: store.settings, saveSettings,
  });
  assert.equal(add.ok, true);
  assert.equal(store.isBlacklisted('g1', 'u5'), true);

  const del = await executeAdminIntent({
    intent: { action: 'del-blacklist', target: '广告小王', args: {} }, gid: 'g1', uid: 'u1', name: '管理员', store, settings: store.settings, saveSettings,
  });
  assert.equal(del.ok, true);
  assert.equal(store.isBlacklisted('g1', 'u5'), false);
});

test('执行器：列出成员优先用花名册并带上 QQ 号', async () => {
  const { store, cleanup } = makeStore();
  store.upsertGroup('g1', { name: '测试群', memberCount: 2 });
  store.upsertMember('g1', 'u5', { name: '老成员', msgCount: 3 });
  store.setDirectory('g1', {
    at: Date.now(),
    qqGroupId: '100001',
    members: [
      { qq: '12345678', nickname: '新人', card: '新人', role: 'member' },
      { qq: '87654321', nickname: '老成员', card: '老成员', role: 'admin' },
    ],
  });
  const out = await executeAdminIntent({
    intent: parseAdminIntent('列出所有群成员名单'), gid: 'g1', uid: 'u1', name: '管理员', store, settings: store.settings, saveSettings: fakeSaver(store, []),
  });
  assert.equal(out.ok, true);
  assert.ok(out.message.includes('QQ 12345678'));
  assert.ok(out.message.includes('QQ 87654321'));
});

test('执行器：查看设置摘要包含关键项', async () => {
  const { store, cleanup } = makeStore({ moderation: { enabled: false, muteSeconds: 900 } });
  const out = await executeAdminIntent({
    intent: parseAdminIntent('查看当前设置'), gid: 'g1', uid: 'u1', name: '管理员', store, settings: store.settings, saveSettings: fakeSaver(store, []),
  });
  assert.equal(out.ok, true);
  assert.ok(out.message.includes('自动审核：关'));
  assert.ok(out.message.includes('15 分钟'));
  assert.ok(out.message.includes('NapCat'));
});

test('AI 意图：管理动作带 args，未知字段被丢弃', () => {
  const r = parseIntentReply(JSON.stringify({
    action: 'add-keyword',
    args: { word: '广告狗', evil: 'rm -rf', feature: '' },
    reply: '加词',
  }));
  assert.equal(r.ok, true);
  assert.equal(r.intent.action, 'add-keyword');
  assert.equal(r.intent.args.word, '广告狗');
  assert.equal('evil' in r.intent.args, false);

  const toggle = parseIntentReply(JSON.stringify({ action: 'toggle', args: { feature: 'guest', enabled: false } }));
  assert.equal(toggle.ok, true);
  assert.equal(toggle.intent.args.feature, 'guest');
  assert.equal(toggle.intent.args.enabled, false);

  const bad = parseIntentReply(JSON.stringify({ action: 'rm-rf' }));
  assert.equal(bad.ok, false);
});

test('AI 意图：动作目录覆盖查询与设置', () => {
  for (const name of ['list-members', 'list-blacklist', 'add-keyword', 'toggle', 'announce']) {
    assert.ok(ADMIN_ACTION_NAMES.includes(name), `${name} 应在动作目录里`);
  }
});

test('handleNaturalCommand：AI 优先，AI 返回管理动作后执行', async () => {
  const { store, cleanup } = makeStore({ ai: { enabled: true } });
  const sent = [];
  const client = { sendGroupText: async (_gid, text) => { sent.push(text); return { ok: true }; } };
  let aiCalls = 0;
  const ai = {
    parseIntent: async () => {
      aiCalls += 1;
      return { ok: true, intent: { action: 'add-keyword', target: '', args: { word: '广告狗' } } };
    },
  };
  const captured = [];
  const r = await handleNaturalCommand({
    gid: 'g1', uid: 'u1', name: '管理员', text: '把“广告狗”加进违规词', settings: store.settings, store, client, ai,
    mentionUids: [], saveSettings: fakeSaver(store, captured),
  });
  assert.equal(r.handled, true);
  assert.equal(r.action, 'admin-add-keyword');
  assert.equal(aiCalls, 1);
  assert.ok(sent[0].includes('广告狗'));

  const help = await handleNaturalCommand({
    gid: 'g1', uid: 'u1', name: '管理员', text: '管理功能', settings: store.settings, store, client, ai,
    mentionUids: [], saveSettings: fakeSaver(store, captured),
  });
  assert.equal(help.action, 'admin-help');
  cleanup();
});

test('handleNaturalCommand：AI 失败时只执行保留的关键词，其余给出关键词提示', async () => {
  const { store, cleanup } = makeStore({ ai: { enabled: true } });
  const sent = [];
  const client = {
    sendGroupText: async (_gid, text) => { sent.push(text); return { ok: true }; },
    getGroupInfo: async () => ({ ok: true, data: { group_member_num: 3 } }),
  };
  const ai = { parseIntent: async () => ({ ok: false, code: 'TIMEOUT' }) };
  const settings = store.settings;

  // 未命中保留关键词：不执行，只回关键词提示
  const missed = await handleNaturalCommand({
    gid: 'g1', uid: 'u1', name: '管理员', text: '把“广告狗”加进违规词', settings, store, client, ai,
    mentionUids: [], saveSettings: fakeSaver(store, []),
  });
  assert.equal(missed.action, 'help');
  assert.ok(sent[0].includes('AI 这次没能理解'));

  // 命中保留关键词（查人数）：AI 失败也照样执行
  const counted = await handleNaturalCommand({
    gid: 'g1', uid: 'u1', name: '管理员', text: '查人数', settings, store, client, ai,
    mentionUids: [], saveSettings: fakeSaver(store, []),
  });
  assert.equal(counted.action, 'count');
  assert.equal(counted.ok, true);
  cleanup();
});

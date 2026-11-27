import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isQQ,
  mergeMemberRows,
  napcatConfigDirs,
  normalizeName,
  normalizeNapcatGroups,
  normalizeRoster,
  parseNapcatConfig,
  planAttachments,
  resolveMappings,
  scanNapcatConfigs,
} from '../lib/napcat.js';

const OFFICIAL = [
  { gid: '0123456789ABCDEF0123456789ABCDEF', name: '软件交流分享' },
  { gid: 'FEDCBA9876543210FEDCBA9876543210', name: '计算机交流群' },
];

const NAPCAT = [
  { qqGroupId: '100001', name: '软件交流分享', memberCount: 28 },
  { qqGroupId: '100002', name: '计算机交流群', memberCount: 8 },
  { qqGroupId: '100003', name: '大肥鱼测试群', memberCount: 3 },
];

test('isQQ 只接受 5-12 位数字', () => {
  assert.equal(isQQ('12345678'), true);
  assert.equal(isQQ(' 12345678 '), true);
  assert.equal(isQQ('1234'), false);
  assert.equal(isQQ('abc12345'), false);
  assert.equal(isQQ('1234567890123'), false);
  assert.equal(isQQ(12345678), true);
  assert.equal(isQQ(null), false);
});

test('normalizeName 忽略全半角与空白差异', () => {
  assert.equal(normalizeName(' ＡＢＣ　群 '), normalizeName('abc 群'));
  assert.equal(normalizeName(''), '');
});

test('normalizeNapcatGroups 过滤非法群号并去重', () => {
  const out = normalizeNapcatGroups([
    { group_id: 100001, group_name: '软件交流分享', member_count: 28, max_member_count: 200 },
    { group_id: 100001, group_name: '重复' },
    { group_id: 'abc', group_name: '非法' },
    { group_id: 100003, group_name: '', group_remark: '备注名' },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { qqGroupId: '100001', name: '软件交流分享', memberCount: 28, maxMemberCount: 200 });
  assert.equal(out[1].name, '备注名');
});

test('normalizeRoster 保留真实 QQ 号与角色', () => {
  const out = normalizeRoster([
    { user_id: 12345678, nickname: '测试成员', card: '', role: 'owner', join_time: 1700000000, last_sent_time: 1700000100, is_robot: false },
    { user_id: '12345678', nickname: '重复' },
    { user_id: 10000000, nickname: '机器人自己', role: 'admin', is_robot: true },
    { user_id: 'bad', nickname: '非法' },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].qq, '12345678');
  assert.equal(out[0].role, 'owner');
  assert.equal(out[0].joinTime, 1700000000);
  assert.equal(out[1].role, 'admin');
  assert.equal(out[1].isRobot, true);
});

test('resolveMappings 按群名唯一自动匹配，多余群不影响', () => {
  const mappings = resolveMappings({ official: OFFICIAL, napcat: NAPCAT });
  assert.equal(mappings.length, 2);
  assert.equal(mappings[0].gid, OFFICIAL[0].gid);
  assert.equal(mappings[0].qqGroupId, '100001');
  assert.equal(mappings[0].auto, true);
  assert.equal(mappings[1].qqGroupId, '100002');
});

test('resolveMappings 同名群有歧义时不猜，手填映射优先', () => {
  const dupes = [
    { qqGroupId: '111111111', name: '同名群', memberCount: 1 },
    { qqGroupId: '222222222', name: '同名群', memberCount: 2 },
  ];
  const official = [{ gid: 'G1', name: '同名群' }];
  assert.equal(resolveMappings({ official, napcat: dupes })[0].qqGroupId, '');
  const manual = resolveMappings({ official, napcat: dupes, overrides: { G1: '222222222' } });
  assert.equal(manual[0].qqGroupId, '222222222');
  assert.equal(manual[0].auto, false);
});

test('resolveMappings 手填的群号不在协议端列表里也保留', () => {
  const mappings = resolveMappings({ official: [{ gid: 'G1', name: '无对应' }], napcat: [], overrides: { G1: '333333333' } });
  assert.equal(mappings[0].qqGroupId, '333333333');
  assert.equal(mappings[0].memberCount, 0);
});

test('planAttachments 只在昵称唯一时把 QQ 号贴回台账', () => {
  const ledger = [
    { uid: 'U1', name: '测试成员' },
    { uid: 'U2', name: '小明' },
    { uid: 'U3', name: '小明' },
    { uid: 'U4', name: '不在花名册' },
  ];
  const roster = [
    { qq: '12345678', nickname: '测试成员', card: '', role: 'owner' },
    { qq: '10001', nickname: '小明', card: '', role: 'member' },
  ];
  const out = planAttachments(ledger, roster);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { uid: 'U1', qq: '12345678', card: '', role: 'owner', name: '测试成员' });
});

test('planAttachments 不覆盖已关联的另一个 QQ 号', () => {
  const out = planAttachments(
    [{ uid: 'U1', name: '测试成员', qq: '99999999' }],
    [{ qq: '12345678', nickname: '测试成员', card: '', role: 'member' }],
  );
  assert.equal(out.length, 0);
});

test('mergeMemberRows 合并台账与花名册并标出来源', () => {
  const ledger = [{ gid: 'G1', uid: 'U1', name: '测试成员', qq: '12345678', lastSeenAt: '2026-11-24T10:00:00.000Z', msgCount: 8 }];
  const directories = [{
    gid: 'G1',
    at: '2026-11-24T12:00:00.000Z',
    members: [
      { qq: '12345678', nickname: '测试成员', card: '', role: 'owner', lastSentTime: 0 },
      { qq: '10001', nickname: '路人甲', card: '甲', role: 'member', lastSentTime: 1700000000 },
    ],
  }];
  const { rows, total } = mergeMemberRows({ ledger, directories });
  assert.equal(total, 2);
  const byQq = new Map(rows.map((r) => [r.qq, r]));
  assert.equal(byQq.get('12345678').source, 'official+napcat');
  assert.equal(byQq.get('10001').source, 'napcat');
  assert.equal(byQq.get('10001').uid, '');
  assert.equal(byQq.get('10001').name, '甲');
  assert.equal(byQq.get('10001').gid, 'G1');
});

test('mergeMemberRows 支持按 QQ 号搜索并带总数', () => {
  const directories = [{
    gid: 'G1',
    at: '2026-11-24T12:00:00.000Z',
    members: [
      { qq: '12345678', nickname: '测试成员', card: '', role: 'owner' },
      { qq: '10001', nickname: '路人甲', card: '', role: 'member' },
    ],
  }];
  const hit = mergeMemberRows({ directories, query: '12345678' });
  assert.equal(hit.total, 1);
  assert.equal(hit.rows[0].qq, '12345678');
  const miss = mergeMemberRows({ directories, query: '不存在' });
  assert.equal(miss.total, 0);
});

test('mergeMemberRows 目录条目缺 gid 时也不会把同一个人列两次', () => {
  // store.getDirectory(gid) 返回的对象没有 gid 字段，旧实现会因此漏掉去重
  const ledger = [
    { gid: 'G1', uid: 'U1', name: '测试成员', qq: '12345678' },
    { gid: 'G1', uid: 'U2', name: '路人乙', qq: '10002' },
  ];
  const directories = [{
    at: '2026-11-24T12:00:00.000Z',
    members: [
      { qq: '12345678', nickname: '测试成员', card: '', role: 'admin' },
      { qq: '10002', nickname: '路人乙', card: '', role: 'member' },
      { qq: '10001', nickname: '路人甲', card: '', role: 'member' },
    ],
  }];
  const { rows, total } = mergeMemberRows({ ledger, directories });
  assert.equal(total, 3);
  assert.deepEqual(rows.map((r) => r.qq).sort(), ['10001', '10002', '12345678']);
  assert.equal(rows.find((r) => r.qq === '12345678').source, 'official+napcat');
});

test('mergeMemberRows 台账缺 QQ 时用群内唯一昵称临时补上', () => {
  const ledger = [{ gid: 'G1', uid: 'U1', name: '测试成员', msgCount: 3 }];
  const directories = [{
    gid: 'G1',
    at: '2026-11-24T12:00:00.000Z',
    members: [{ qq: '12345678', nickname: '测试成员', card: '', role: 'member' }],
  }];
  const { rows } = mergeMemberRows({ ledger, directories });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].qq, '12345678');
  assert.equal(rows[0].qqMatched, true);
  assert.equal(ledger[0].qq, undefined, '临时匹配不写回台账对象');
});

test('mergeMemberRows 标出管理员 / 白名单 / 信任 / 机器人', () => {
  const ledger = [{ gid: 'G1', uid: 'U1', name: '测试成员', qq: '12345678' }];
  const directories = [{
    gid: 'G1',
    at: '2026-11-24T12:00:00.000Z',
    members: [
      { qq: '12345678', nickname: '测试成员', card: '', role: 'owner', isRobot: false },
      { qq: '2854196310', nickname: 'Q群管家', card: '', role: 'admin', isRobot: true },
    ],
  }];
  const { rows } = mergeMemberRows({
    ledger,
    directories,
    allowUsers: ['U1'],
    trustedUsers: [{ uid: 'U1', name: '测试成员' }],
  });
  const owner = rows.find((r) => r.qq === '12345678');
  assert.equal(owner.role, 'owner');
  assert.equal(owner.whitelisted, true);
  assert.equal(owner.trusted, true);
  assert.equal(owner.isBot, false);
  const robot = rows.find((r) => r.qq === '2854196310');
  assert.equal(robot.role, 'admin');
  assert.equal(robot.isBot, true);
});

test('mergeMemberRows 认出机器人自己的 QQ', () => {
  const directories = [{
    gid: 'G1',
    at: '2026-11-24T12:00:00.000Z',
    members: [{ qq: '10000000', nickname: '测试机器人', card: '', role: 'admin' }],
  }];
  const { rows } = mergeMemberRows({ directories, selfQQ: '10000000' });
  assert.equal(rows[0].isBot, true);
});

test('parseNapcatConfig 兼容不同版本的 WebSocket 配置布局', () => {
  assert.deepEqual(parseNapcatConfig({ websocketServers: [{ port: 3001, token: 't1' }] }), [
    { port: 3001, token: 't1' },
  ]);
  assert.deepEqual(parseNapcatConfig({ network: { websocketServers: [{ port: 6700 }] } }), [
    { port: 6700, token: '' },
  ]);
  assert.deepEqual(parseNapcatConfig({ ws: { port: 3000, token: 'x' } }), [{ port: 3000, token: 'x' }]);
  assert.deepEqual(parseNapcatConfig({ network: { ws: [{ port: 8080 }] } }), [{ port: 8080, token: '' }]);
  assert.deepEqual(parseNapcatConfig({ websocketServers: [{ port: 0 }] }), []);
  assert.deepEqual(parseNapcatConfig(null), []);
});

test('scanNapcatConfigs 从 onebot11_<QQ>.json 读出地址并按端口去重', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqg-napcat-'));
  try {
    writeFileSync(join(dir, 'onebot11_10000000.json'), JSON.stringify({
      websocketServers: [{ port: 3001, token: '' }, { port: 3001, token: 'dup' }],
    }));
    writeFileSync(join(dir, 'onebot11_10000001.json'), JSON.stringify({
      network: { websocketServers: [{ port: 3011, token: 'tok' }] },
    }));
    writeFileSync(join(dir, 'other.json'), JSON.stringify({ websocketServers: [{ port: 3999 }] }));
    writeFileSync(join(dir, 'broken.json'), '{ not json');
    const found = scanNapcatConfigs({ dirs: [dir, join(dir, 'missing')] });
    assert.deepEqual(found.map((f) => f.port), [3001, 3011]);
    assert.equal(found[1].token, 'tok');
    assert.equal(found[0].url, 'ws://127.0.0.1:3001');
    assert.match(found[0].source, /onebot11_10000000\.json$/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('napcatConfigDirs 覆盖 Windows 与 Linux 的常见位置', () => {
  const win = napcatConfigDirs({ USERPROFILE: 'C:\\Users\\me', APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'win32');
  assert.ok(win.includes('C:\\Users\\me\\napcat\\napcat\\config'));
  assert.ok(win.includes('C:\\napcat\\napcat\\config'));
  const linux = napcatConfigDirs({ HOME: '/home/me' }, 'linux');
  assert.equal(linux.length >= 4, true);
  assert.ok(linux.some((d) => d.includes('napcat') && d.includes('config')));
  assert.ok(linux.some((d) => d.includes('opt')));
  assert.ok(napcatConfigDirs({}, 'win32').length > 0);
});

test('默认设置里 NapCat 成员目录开箱即用', async () => {
  const { DEFAULT_SETTINGS } = await import('../lib/defaults.js');
  assert.equal(DEFAULT_SETTINGS.napcat.enabled, true);
  assert.equal(DEFAULT_SETTINGS.napcat.autoDetect, true);
  assert.match(DEFAULT_SETTINGS.napcat.wsUrl, /^ws:\/\//u);
  const { normalizeSettings } = await import('../lib/config.js');
  const out = normalizeSettings({});
  assert.equal(out.errors.length, 0);
  assert.equal(out.value.napcat.enabled, true);
  assert.equal(out.value.napcat.autoDetect, true);
});


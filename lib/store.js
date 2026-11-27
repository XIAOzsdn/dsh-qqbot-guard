/**
 * 本地存储：设置、运行状态、公告、审计日志。
 * 所有写入都是“临时文件 + rename”的原子替换；任何失败都降级为内存状态，绝不抛给调用方。
 */
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { LIMITS } from './defaults.js';
import { safeNormalize } from './config.js';

const FILES = Object.freeze({
  settings: 'settings.json',
  state: 'state.json',
  announcements: 'announcements.json',
  audit: 'audit.jsonl',
});

function emptyState() {
  return {
    version: 1,
    groups: {},
    members: {},
    pending: {},
    violations: {},
    blacklist: {},
    observed: {},
    quizzes: {},
    guestAbuse: {},
    /** 按群缓存的 NapCat/OneBot 成员花名册：{ [gid]: {at, qqGroupId, qqGroupName, members[]} } */
    directory: {},
    /** 自然语言使用记录：用于按习惯重排快捷关键词 { records: [{action,source,at}], lastReviewAt } */
    naturalUsage: { records: [], lastReviewAt: 0 },
    /** 定时任务：{ id, gid, kind, uid, qq, seconds, at, repeat, time, createdBy, createdAt } */
    schedules: [],
    counters: {
      date: '',
      blocked: 0,
      warns: 0,
      mutes: 0,
      kicks: 0,
      welcomes: 0,
      approvals: 0,
      declines: 0,
      announces: 0,
    },
    updatedAt: new Date().toISOString(),
  };
}

function emptyAnnouncements() {
  return { version: 1, items: [] };
}

function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback;
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' ? raw : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  const tmp = file + '.tmp';
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  renameSync(tmp, file);
}

function clip(text) {
  return String(text ?? '').slice(0, LIMITS.auditTextMax);
}

export class Store {
  /** @param {string} dir */
  constructor(dir) {
    this.dir = dir;
    this.settings = safeNormalize(readJson(join(dir, FILES.settings), {}));
    this.state = normalizeState(readJson(join(dir, FILES.state), emptyState()));
    this.announcements = normalizeAnnouncements(readJson(join(dir, FILES.announcements), emptyAnnouncements()));
    this.auditMemory = [];
    this.recentRejectedKeys = [];
    this.dirty = false;
    this.flushTimer = null;
    this.lastError = '';
    this.loadAuditTail();
  }

  pathOf(name) {
    return join(this.dir, FILES[name] || name);
  }

  /** 设置：先归一化再落盘，坏数据自动兜底 */
  saveSettings(next) {
    this.settings = safeNormalize(next);
    try {
      writeJsonAtomic(this.pathOf('settings'), this.settings);
      return true;
    } catch (error) {
      this.lastError = errorText(error);
      return false;
    }
  }

  /** 状态：内存立即生效，磁盘合并写入 */
  saveState() {
    this.state.updatedAt = new Date().toISOString();
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, LIMITS.stateFlushMs);
    if (typeof this.flushTimer.unref === 'function') this.flushTimer.unref();
  }

  flush() {
    if (!this.dirty) return true;
    try {
      writeJsonAtomic(this.pathOf('state'), this.state);
      this.dirty = false;
      return true;
    } catch (error) {
      this.lastError = errorText(error);
      return false;
    }
  }

  saveAnnouncements() {
    this.announcements.items = this.announcements.items.slice(0, LIMITS.announcementHistory);
    try {
      writeJsonAtomic(this.pathOf('announcements'), this.announcements);
      return true;
    } catch (error) {
      this.lastError = errorText(error);
      return false;
    }
  }

  /** 审计：内存最近 N 条 + 文件追加；超过上限自动轮转一次 */
  appendAudit(entry) {
    const item = {
      at: new Date().toISOString(),
      kind: clip(entry.kind || 'system'),
      action: clip(entry.action || ''),
      groupId: clip(entry.groupId || ''),
      groupName: clip(entry.groupName || ''),
      userId: clip(entry.userId || ''),
      userName: clip(entry.userName || ''),
      detail: clip(entry.detail || ''),
      ok: entry.ok !== false,
      code: clip(entry.code || ''),
      confidence: Number.isFinite(entry.confidence) ? entry.confidence : 1,
    };
    this.auditMemory.push(item);
    if (this.auditMemory.length > LIMITS.auditMemory) {
      this.auditMemory.splice(0, this.auditMemory.length - LIMITS.auditMemory);
    }
    try {
      const file = this.pathOf('audit');
      mkdirSync(dirname(file), { recursive: true });
      if (existsSync(file) && statSync(file).size > LIMITS.auditFileBytes) {
        const old = file + '.1';
        try { if (existsSync(old)) unlinkSync(old); } catch { /* ignore */ }
        try { renameSync(file, old); } catch { /* ignore */ }
      }
      appendFileSync(file, JSON.stringify(item) + '\n', 'utf8');
    } catch (error) {
      this.lastError = errorText(error);
    }
  }

  loadAuditTail() {
    try {
      const file = this.pathOf('audit');
      if (!existsSync(file)) return;
      const text = readFileSync(file, 'utf8');
      const lines = text.trim().split('\n').slice(-LIMITS.auditMemory);
      this.auditMemory = lines.flatMap((line) => {
        try {
          const item = JSON.parse(line);
          return item && typeof item === 'object' ? [item] : [];
        } catch {
          return [];
        }
      });
    } catch {
      this.auditMemory = [];
    }
  }

  readAudit(limit = 50) {
    const n = Math.max(1, Math.min(LIMITS.auditMemory, Number(limit) || 50));
    return this.auditMemory.slice(-n).reverse();
  }

  /** 处理跨天的统计清零 */
  rollCounters(now = Date.now()) {
    const day = new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
    if (this.state.counters.date !== day) {
      this.state.counters = {
        date: day, blocked: 0, warns: 0, mutes: 0, kicks: 0,
        welcomes: 0, approvals: 0, declines: 0, announces: 0,
      };
      this.saveState();
    }
    return this.state.counters;
  }

  incCounter(key, by = 1) {
    const counters = this.rollCounters();
    if (key in counters && key !== 'date') counters[key] += by;
    this.saveState();
  }

  /** 添加/更新群注册表 */
  upsertGroup(gid, patch = {}) {
    if (!gid) return;
    const cur = this.state.groups[gid] || { gid, name: '', addedAt: new Date().toISOString(), memberCount: 0 };
    this.state.groups[gid] = { ...cur, ...patch, gid, lastSeenAt: new Date().toISOString() };
    this.saveState();
  }

  removeGroup(gid) {
    if (!gid) return false;
    if (this.state.groups[gid]) {
      delete this.state.groups[gid];
      this.saveState();
      return true;
    }
    return false;
  }

  /** 成员台账（上限裁剪，按最后活跃时间淘汰最旧） */
  upsertMember(gid, uid, patch = {}) {
    if (!gid || !uid) return;
    const key = gid + '|' + uid;
    const cur = this.state.members[key] || {
      gid, uid, name: '', firstSeenAt: new Date().toISOString(), lastSeenAt: '', msgCount: 0,
    };
    const clean = {};
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) clean[k] = v;
    }
    this.state.members[key] = {
      ...cur,
      ...clean,
      gid,
      uid,
      lastSeenAt: new Date().toISOString(),
      msgCount: (cur.msgCount || 0) + (patch.countMessage ? 1 : 0),
    };
    delete this.state.members[key].countMessage;
    this.memberWrites = (this.memberWrites || 0) + 1;
    if (this.memberWrites % LIMITS.memberPruneEvery === 0) {
      const keys = Object.keys(this.state.members);
      if (keys.length > LIMITS.members) {
        keys.sort((a, b) => String(this.state.members[a].lastSeenAt).localeCompare(String(this.state.members[b].lastSeenAt)));
        for (const k of keys.slice(0, keys.length - LIMITS.members)) delete this.state.members[k];
      }
    }
    this.saveState();
  }

  searchMembers(gid, query, limit = 50) {
    const q = String(query || '').normalize('NFKC').trim().toLowerCase();
    const out = [];
    for (const m of Object.values(this.state.members)) {
      if (gid && m.gid !== gid) continue;
      if (q) {
        const name = String(m.name || '').normalize('NFKC').toLowerCase();
        const uid = String(m.uid || '').toLowerCase();
        if (!name.includes(q) && !uid.includes(q)) continue;
      }
      out.push(m);
      if (out.length >= Math.min(limit, LIMITS.memberSearchLimit)) break;
    }
    return out.sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)));
  }

  /** 某群全部台账成员（不受面板搜索上限影响，用于与 NapCat 花名册合并） */
  listMembers(gid = '') {
    const out = [];
    for (const m of Object.values(this.state.members)) {
      if (!gid || m.gid === gid) out.push(m);
    }
    return out;
  }

  /** NapCat 成员目录：整群替换；at 为本次同步时间 */
  setDirectory(gid, entry = {}) {
    if (!gid) return;
    const members = Array.isArray(entry.members)
      ? entry.members.slice(0, LIMITS.directoryMembersPerGroup)
      : [];
    this.state.directory[String(gid)] = {
      at: String(entry.at || new Date().toISOString()),
      qqGroupId: String(entry.qqGroupId || ''),
      qqGroupName: String(entry.qqGroupName || ''),
      members,
    };
    this.saveState();
  }

  getDirectory(gid) {
    return this.state.directory[String(gid || '')] || null;
  }

  listDirectories(gid = '') {
    const out = [];
    for (const [key, value] of Object.entries(this.state.directory)) {
      if (gid && key !== gid) continue;
      if (!value || !Array.isArray(value.members)) continue;
      out.push({ ...value, gid: key });
    }
    return out;
  }

  countDirectory(gid = '') {
    let n = 0;
    for (const [key, value] of Object.entries(this.state.directory)) {
      if (gid && key !== gid) continue;
      if (value && Array.isArray(value.members)) n += value.members.length;
    }
    return n;
  }

  /** 记录一次自然语言指令（按动作计数，供定期重排快捷关键词） */
  noteNaturalUsage(entry = {}) {
    const action = String(entry?.action || '').slice(0, 60);
    if (!action) return;
    if (!this.state.naturalUsage) this.state.naturalUsage = { records: [], lastReviewAt: 0 };
    const usage = this.state.naturalUsage;
    if (!Array.isArray(usage.records)) usage.records = [];
    usage.records.push({
      action,
      source: String(entry.source || '').slice(0, 20),
      at: Number(entry.at) || Date.now(),
    });
    if (usage.records.length > LIMITS.naturalUsageRecords) {
      usage.records = usage.records.slice(-LIMITS.naturalUsageRecords);
    }
    this.saveState();
  }

  naturalUsage() {
    return this.state.naturalUsage || { records: [], lastReviewAt: 0 };
  }

  touchNaturalReview(at = Date.now()) {
    if (!this.state.naturalUsage) this.state.naturalUsage = { records: [], lastReviewAt: 0 };
    this.state.naturalUsage.lastReviewAt = Number(at) || Date.now();
    this.saveState();
  }

  /** 把目录字段（QQ 号、群名片、角色）补进台账；不会刷新 lastSeenAt / msgCount */
  patchMember(gid, uid, patch = {}) {
    if (!gid || !uid) return false;
    const key = gid + '|' + uid;
    const cur = this.state.members[key];
    if (!cur) return false;
    const clean = {};
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) clean[k] = v;
    }
    this.state.members[key] = { ...cur, ...clean, gid, uid };
    this.saveState();
    return true;
  }

  /** 违规时间戳（用于升权统计） */
  noteViolation(gid, uid, now = Date.now()) {
    const key = gid + '|' + uid;
    const list = Array.isArray(this.state.violations[key]) ? this.state.violations[key] : [];
    list.push(now);
    this.state.violations[key] = list.slice(-LIMITS.violationEventsPerUser);
    if (Object.keys(this.state.violations).length > LIMITS.violationUsers) {
      const keys = Object.keys(this.state.violations).sort(
        (a, b) => (this.state.violations[a].at(-1) || 0) - (this.state.violations[b].at(-1) || 0),
      );
      for (const k of keys.slice(0, keys.length - LIMITS.violationUsers)) delete this.state.violations[k];
    }
    this.saveState();
    return this.state.violations[key];
  }

  countViolations(gid, uid, windowMs, now = Date.now()) {
    const key = gid + '|' + uid;
    const list = Array.isArray(this.state.violations[key]) ? this.state.violations[key] : [];
    return list.filter((t) => now - t <= windowMs).length;
  }

  /** 黑名单 */
  blackKey(gid, uid) {
    return String(gid) + '|' + String(uid);
  }

  isBlacklisted(gid, uid) {
    return !!this.state.blacklist[this.blackKey(gid, uid)];
  }

  addBlacklist(gid, uid, info = {}) {
    if (!gid || !uid) return false;
    const key = this.blackKey(gid, uid);
    this.state.blacklist[key] = {
      gid: String(gid),
      uid: String(uid),
      name: String(info.name || '').slice(0, 100),
      reason: String(info.reason || '').slice(0, 200),
      by: String(info.by || 'auto').slice(0, 50),
      at: new Date().toISOString(),
    };
    const keys = Object.keys(this.state.blacklist);
    if (keys.length > LIMITS.blacklistMax) {
      keys.sort((a, b) => String(this.state.blacklist[a].at).localeCompare(String(this.state.blacklist[b].at)));
      for (const k of keys.slice(0, keys.length - LIMITS.blacklistMax)) delete this.state.blacklist[k];
    }
    this.saveState();
    return true;
  }

  removeBlacklist(gid, uid) {
    const key = this.blackKey(gid, uid);
    if (!this.state.blacklist[key]) return false;
    delete this.state.blacklist[key];
    this.saveState();
    return true;
  }

  listBlacklist(gid = '') {
    return Object.values(this.state.blacklist)
      .filter((x) => !gid || x.gid === gid)
      .sort((a, b) => String(b.at).localeCompare(String(a.at)));
  }

  /** 新成员观察期 */
  setObserved(gid, uid, untilMs) {
    if (!gid || !uid) return;
    this.state.observed[this.blackKey(gid, uid)] = Number(untilMs) || 0;
    this.saveState();
  }

  observedUntil(gid, uid) {
    return Number(this.state.observed[this.blackKey(gid, uid)] || 0);
  }

  /** 普通用户通道：越权尝试次数（与违规处置分开计数，互不影响） */
  noteGuestAbuse(gid, uid, now = Date.now()) {
    const key = this.blackKey(gid, uid);
    const list = Array.isArray(this.state.guestAbuse[key]) ? this.state.guestAbuse[key] : [];
    list.push(now);
    this.state.guestAbuse[key] = list.slice(-LIMITS.violationEventsPerUser);
    const keys = Object.keys(this.state.guestAbuse);
    if (keys.length > LIMITS.violationUsers) {
      keys.sort((a, b) => (this.state.guestAbuse[a].at(-1) || 0) - (this.state.guestAbuse[b].at(-1) || 0));
      for (const k of keys.slice(0, keys.length - LIMITS.violationUsers)) delete this.state.guestAbuse[k];
    }
    this.saveState();
    return this.state.guestAbuse[key];
  }

  countGuestAbuse(gid, uid, windowMs, now = Date.now()) {
    const list = this.state.guestAbuse[this.blackKey(gid, uid)];
    if (!Array.isArray(list)) return 0;
    return list.filter((t) => now - t <= windowMs).length;
  }

  isObserved(gid, uid, now = Date.now()) {
    const until = this.observedUntil(gid, uid);
    if (until && until <= now) {
      delete this.state.observed[this.blackKey(gid, uid)];
      this.saveState();
      return false;
    }
    return until > now;
  }

  /** 入群答题状态 */
  setQuiz(gid, uid, quiz) {
    if (!gid || !uid) return;
    const key = this.blackKey(gid, uid);
    this.state.quizzes[key] = { ...quiz, gid: String(gid), uid: String(uid) };
    const keys = Object.keys(this.state.quizzes);
    if (keys.length > LIMITS.quizMax) {
      keys.sort((a, b) => Number(this.state.quizzes[a].expiresAt || 0) - Number(this.state.quizzes[b].expiresAt || 0));
      for (const k of keys.slice(0, keys.length - LIMITS.quizMax)) delete this.state.quizzes[k];
    }
    this.saveState();
  }

  getQuiz(gid, uid) {
    return this.state.quizzes[this.blackKey(gid, uid)] || null;
  }

  clearQuiz(gid, uid) {
    const key = this.blackKey(gid, uid);
    if (!this.state.quizzes[key]) return false;
    delete this.state.quizzes[key];
    this.saveState();
    return true;
  }

  listQuizzes() {
    return Object.values(this.state.quizzes);
  }

  listExpiredQuizzes(now = Date.now()) {
    return this.listQuizzes().filter((x) => Number(x.expiresAt || 0) > 0 && Number(x.expiresAt) <= now);
  }

  /** 按群 + openid 取成员台账记录 */
  getMember(gid, uid) {
    if (!gid || !uid) return null;
    return this.state.members[gid + '|' + uid] || null;
  }

  /** 同一 openid 可能出现在多个群的台账里 */
  findMembersByUid(uid) {
    const key = String(uid || '').trim();
    if (!key) return [];
    return Object.values(this.state.members).filter((m) => String(m.uid) === key);
  }

  /** 按昵称模糊查找（用于面板提示“这个昵称对应哪个 openid”） */
  searchMembersByName(name, limit = 5) {
    const q = String(name || '').normalize('NFKC').trim().toLowerCase();
    if (!q) return [];
    const out = [];
    for (const m of Object.values(this.state.members)) {
      if (!String(m.name || '').normalize('NFKC').toLowerCase().includes(q)) continue;
      out.push(m);
      if (out.length >= Math.min(limit, LIMITS.memberSearchLimit)) break;
    }
    return out;
  }

  /** 通知对象：昵称与 openid 必须同时匹配同一位成员，任一不匹配返回 null */
  findMemberByUidAndName(gid, uid, name) {
    const member = this.getMember(gid, uid);
    const expected = String(name || '').normalize('NFKC').trim().toLowerCase();
    if (!member || !expected) return null;
    return String(member.name || '').normalize('NFKC').trim().toLowerCase() === expected ? member : null;
  }

  /** 按昵称找成员（gid 为空表示所有群） */
  findMembersByName(gid, name) {
    const expected = String(name || '').normalize('NFKC').trim().toLowerCase();
    if (!expected) return [];
    return Object.values(this.state.members).filter((m) => (
      (!gid || m.gid === gid)
      && String(m.name || '').normalize('NFKC').trim().toLowerCase() === expected
    ));
  }

  /** 台账里的成员数（可按群） */
  countMembers(gid = '') {
    let n = 0;
    for (const m of Object.values(this.state.members)) {
      if (!gid || m.gid === gid) n += 1;
    }
    return n;
  }

  /** 审计查询：按类型/群/用户过滤 */
  queryAudit({ kind = '', groupId = '', userId = '', limit = 100 } = {}) {
    const n = Math.max(1, Math.min(LIMITS.auditMemory, Number(limit) || 100));
    return this.auditMemory
      .filter((x) => (!kind || x.kind === kind) && (!groupId || x.groupId === groupId) && (!userId || x.userId === userId))
      .slice(-n)
      .reverse();
  }

  /** 待审批申请：按群聚合 */
  putPending(gid, item) {
    if (!gid) return;
    const now = Date.now();
    const list = Array.isArray(this.state.pending[gid]) ? this.state.pending[gid] : [];
    const next = list.filter((x) => {
      if (x.joinRequestId === item.joinRequestId) return false;
      if (x.status === 'done') {
        const at = Date.parse(x.seenAt || '');
        return !Number.isNaN(at) && now - at <= LIMITS.pendingDoneTtlMs;
      }
      return true;
    });
    next.unshift(item);
    this.state.pending[gid] = next.slice(0, LIMITS.pendingPerGroup);
    this.saveState();
  }

  removePending(gid, joinRequestId) {
    const list = Array.isArray(this.state.pending[gid]) ? this.state.pending[gid] : [];
    const next = list.filter((x) => x.joinRequestId !== joinRequestId);
    this.state.pending[gid] = next;
    this.saveState();
  }

  listPending(includeDone = false) {
    const out = [];
    for (const [gid, list] of Object.entries(this.state.pending)) {
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (!includeDone && item.status === 'done') continue;
        out.push({ ...item, groupId: gid });
      }
    }
    return out.sort((a, b) => String(b.seenAt).localeCompare(String(a.seenAt)));
  }

  /** 设置里的成员/群组摘要 */
  snapshot() {
    const groups = Object.values(this.state.groups);
    const members = Object.values(this.state.members);
    const pending = this.listPending();
    return {
      groupCount: groups.length,
      memberCount: members.length,
      directoryCount: this.countDirectory(),
      pendingCount: pending.length,
      counters: this.rollCounters(),
      groups: groups.sort((a, b) => String(a.name || a.gid).localeCompare(String(b.name || b.gid))),
    };
  }

  dispose() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }
}

function normalizeState(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== 'object') return base;
  return {
    ...base,
    ...raw,
    groups: isPlain(raw.groups) ? raw.groups : {},
    members: isPlain(raw.members) ? raw.members : {},
    pending: isPlain(raw.pending) ? raw.pending : {},
    violations: isPlain(raw.violations) ? raw.violations : {},
    blacklist: isPlain(raw.blacklist) ? raw.blacklist : {},
    observed: isPlain(raw.observed) ? raw.observed : {},
    quizzes: isPlain(raw.quizzes) ? raw.quizzes : {},
    guestAbuse: isPlain(raw.guestAbuse) ? raw.guestAbuse : {},
    directory: isPlain(raw.directory) ? raw.directory : {},
    schedules: Array.isArray(raw.schedules)
      ? raw.schedules.filter((x) => isPlain(x) && typeof x.id === 'string' && Number.isFinite(Number(x.at))).slice(-LIMITS.schedules)
      : [],
    naturalUsage: {
      records: Array.isArray(raw.naturalUsage?.records)
        ? raw.naturalUsage.records.filter((x) => isPlain(x) && typeof x.action === 'string').slice(-LIMITS.naturalUsageRecords)
        : [],
      lastReviewAt: Number(raw.naturalUsage?.lastReviewAt) || 0,
    },
    counters: { ...base.counters, ...(isPlain(raw.counters) ? raw.counters : {}) },
  };
}

function normalizeAnnouncements(raw) {
  const base = emptyAnnouncements();
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) return base;
  return {
    version: 1,
    items: raw.items
      .filter((x) => isPlain(x) && typeof x.id === 'string')
      .slice(0, LIMITS.announcementHistory),
  };
}

function isPlain(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

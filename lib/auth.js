/**
 * 独立面板的认证：双密码、PBKDF2 哈希、会话、登录失败限流。
 *
 * 不再内置任何默认密码：首次访问面板时必须由部署方设置两个角色的密码，
 * 密码要求同时包含字母和数字。设置结果写入数据目录的 security.json。
 */
import {
  pbkdf2Sync, randomBytes, timingSafeEqual,
} from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LIMITS } from './defaults.js';

const FILE_VERSION = 2;
const ITERATIONS = 150_000;
const KEY_LEN = 32;
const DIGEST = 'sha256';

export const PASSWORD_RULE_TEXT = `至少 ${LIMITS.passwordMin} 位，且必须同时包含字母和数字`;

/** 面板密码策略：长度限制 + 字母与数字组合 */
export function checkPasswordPolicy(password) {
  const pwd = typeof password === 'string' ? password : '';
  if (pwd.length < LIMITS.passwordMin) return { ok: false, error: `密码至少 ${LIMITS.passwordMin} 位` };
  if (pwd.length > LIMITS.passwordMax) return { ok: false, error: `密码最多 ${LIMITS.passwordMax} 位` };
  if (/\s/u.test(pwd)) return { ok: false, error: '密码不能包含空格' };
  if (!/[A-Za-z]/u.test(pwd)) return { ok: false, error: '密码必须包含字母' };
  if (!/\d/u.test(pwd)) return { ok: false, error: '密码必须包含数字' };
  return { ok: true };
}

export const ROLES = Object.freeze({ admin: 'admin', operator: 'operator' });

function hashPassword(password, salt, iterations = ITERATIONS) {
  return pbkdf2Sync(String(password), String(salt), iterations, KEY_LEN, DIGEST).toString('hex');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  if (left.length !== right.length) return false;
  try {
    return timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

function writeAtomic(file, value) {
  const tmp = file + '.tmp';
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file);
}

function readJson(file) {
  try {
    if (!existsSync(file)) return null;
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

/** 未初始化状态：不允许登录，必须先在面板首页设置密码 */
function emptyState() {
  return {
    version: FILE_VERSION,
    initialized: false,
    admin: null,
    operator: null,
    updatedAt: '',
  };
}

function makeCredential(password) {
  const salt = randomBytes(16).toString('hex');
  return { hash: hashPassword(password, salt), salt, iterations: ITERATIONS };
}

/** 密码与角色管理（持久化到 dataDir/security.json） */
export class AuthStore {
  constructor(dataDir) {
    this.file = join(dataDir, 'security.json');
    this.data = this.load();
  }

  load() {
    const raw = readJson(this.file);
    if (!raw || raw.initialized !== true) return emptyState();
    const admin = normalizeCredential(raw.admin, null);
    const operator = normalizeCredential(raw.operator, null);
    if (!admin || !operator) return emptyState();
    return {
      version: FILE_VERSION,
      initialized: true,
      admin,
      operator,
      updatedAt: String(raw.updatedAt || ''),
    };
  }

  initialized() {
    return this.data.initialized === true && !!this.data.admin && !!this.data.operator;
  }

  save() {
    this.data.updatedAt = new Date().toISOString();
    try {
      writeAtomic(this.file, this.data);
      return true;
    } catch {
      return false;
    }
  }

  /** 首次访问：部署方自行设置两个角色的密码 */
  setup({ adminPassword, operatorPassword } = {}) {
    if (this.initialized()) return { ok: false, error: '面板密码已设置，请直接登录' };
    const adminCheck = checkPasswordPolicy(adminPassword);
    if (!adminCheck.ok) return { ok: false, error: `最高管理员密码：${adminCheck.error}` };
    const operatorCheck = checkPasswordPolicy(operatorPassword);
    if (!operatorCheck.ok) return { ok: false, error: `普通管理员密码：${operatorCheck.error}` };
    if (String(adminPassword) === String(operatorPassword)) {
      return { ok: false, error: '两个角色的密码不能相同' };
    }
    this.data = {
      version: FILE_VERSION,
      initialized: true,
      admin: makeCredential(adminPassword),
      operator: makeCredential(operatorPassword),
      updatedAt: '',
    };
    if (!this.save()) {
      this.data = emptyState();
      return { ok: false, error: '密码保存失败，请检查数据目录权限' };
    }
    return { ok: true };
  }

  /** 返回匹配的角色；先校验最高权限密码 */
  verify(password, role) {
    if (!this.initialized()) return null;
    if (role) return this.verifyRole(role, password) ? role : null;
    if (this.verifyRole('admin', password)) return 'admin';
    if (this.verifyRole('operator', password)) return 'operator';
    return null;
  }

  verifyRole(role, password) {
    const cur = this.data[role];
    if (!cur || typeof password !== 'string' || !password) return false;
    const attempt = hashPassword(password, cur.salt, Number(cur.iterations) || ITERATIONS);
    return safeEqual(attempt, cur.hash);
  }

  changePassword(role, password) {
    if (!ROLES[role]) return { ok: false, error: '未知角色' };
    if (!this.initialized()) return { ok: false, error: '请先完成面板初始化' };
    const check = checkPasswordPolicy(password);
    if (!check.ok) return { ok: false, error: check.error };
    const other = role === 'admin' ? 'operator' : 'admin';
    if (this.verifyRole(other, password)) return { ok: false, error: '不能与另一个角色的密码相同' };
    this.data[role] = makeCredential(password);
    const saved = this.save();
    return saved ? { ok: true } : { ok: false, error: '密码保存失败，请检查数据目录权限' };
  }

  status() {
    return {
      initialized: this.initialized(),
      passwordMin: LIMITS.passwordMin,
      passwordMax: LIMITS.passwordMax,
    };
  }
}

function normalizeCredential(raw, fallback = null) {
  if (!raw || typeof raw !== 'object') return fallback;
  const hash = String(raw.hash || '').trim();
  const salt = String(raw.salt || '').trim();
  const iterations = Number(raw.iterations);
  if (!/^[a-f0-9]{64}$/u.test(hash) || !salt) return fallback;
  return {
    hash,
    salt,
    iterations: Number.isFinite(iterations) && iterations >= 10_000 ? Math.round(iterations) : ITERATIONS,
  };
}

/** 内存会话：随机 token，带过期时间与来源 IP */
export class SessionStore {
  constructor({ ttlMs = 12 * 3600_000 } = {}) {
    this.ttlMs = ttlMs;
    this.sessions = new Map();
    this.timer = setInterval(() => this.sweep(), LIMITS.sessionSweepMs);
    if (this.timer.unref) this.timer.unref();
  }

  create(role, ip = '') {
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    this.sessions.set(token, { role, ip, createdAt: now, expiresAt: now + this.ttlMs });
    return { token, expiresAt: now + this.ttlMs };
  }

  get(token) {
    if (!token) return null;
    const hit = this.sessions.get(token);
    if (!hit) return null;
    if (Date.now() > hit.expiresAt) {
      this.sessions.delete(token);
      return null;
    }
    return hit;
  }

  touch(token) {
    const hit = this.get(token);
    if (hit) hit.expiresAt = Date.now() + this.ttlMs;
    return hit;
  }

  destroy(token) {
    if (token) this.sessions.delete(token);
  }

  sweep(now = Date.now()) {
    for (const [token, item] of this.sessions) {
      if (now > item.expiresAt) this.sessions.delete(token);
    }
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.sessions.clear();
  }
}

/** 登录失败限流：按 IP 统计，窗口内超过阈值后锁定 */
export class LoginGuard {
  constructor() {
    this.map = new Map();
  }

  key(ip) {
    return String(ip || 'unknown');
  }

  check(ip, now = Date.now()) {
    const item = this.map.get(this.key(ip));
    if (!item) return { ok: true };
    if (item.lockedUntil > now) {
      return { ok: false, retryAfterMs: item.lockedUntil - now, reason: '登录失败次数过多，请稍后再试' };
    }
    if (now - item.firstAt > LIMITS.loginWindowMs) {
      this.map.delete(this.key(ip));
      return { ok: true };
    }
    return { ok: true };
  }

  fail(ip, now = Date.now()) {
    const key = this.key(ip);
    const item = this.map.get(key);
    if (!item || now - item.firstAt > LIMITS.loginWindowMs) {
      this.map.set(key, { fails: 1, firstAt: now, lockedUntil: 0 });
      return;
    }
    item.fails += 1;
    if (item.fails >= LIMITS.loginMaxFails) {
      item.lockedUntil = now + LIMITS.loginLockMs;
      item.fails = 0;
      item.firstAt = now;
    }
  }

  success(ip) {
    this.map.delete(this.key(ip));
  }
}

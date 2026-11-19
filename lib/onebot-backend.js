/**
 * 协议端进程管理：让插件自己拉起 OneBot 后端（NapCat / 其它实现），
 * 这样不需要用户先手动打开 QQ。
 *
 * 真正“不依赖 QQ 客户端”的后端是 NapCat.Shell（无头、自带运行时）或
 * 纯协议端（Lagrange 等）；本模块只负责启动命令与可达性探测。
 */
import { spawn } from 'node:child_process';
import { connect } from 'node:net';

/** 把 ws://host:port[/path] 拆成 { host, port }；解析失败返回 null */
export function wsTarget(url) {
  const raw = String(url || '').trim();
  const m = /^wss?:\/\/(\[[^\]]+\]|[^/:]+)(?::(\d+))?/iu.exec(raw);
  if (!m) return null;
  return { host: m[1].replace(/^\[|\]$/gu, ''), port: Number(m[2]) || 80 };
}

/** 探测 TCP 端口是否可连（协议端是否已经起来） */
export function probeTcp(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      clearTimeout(timer);
      resolve(value);
    };
    const socket = connect({ host, port });
    const timer = setTimeout(() => done(false), Math.max(200, Number(timeoutMs) || 800));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

/** 后台拉起协议端（不阻塞、不继承 stdio） */
export function spawnBackend(command) {
  const cmd = String(command || '').trim();
  if (!cmd) return { ok: false, error: '未配置启动命令' };
  try {
    const child = spawn(cmd, {
      shell: true,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: process.cwd(),
    });
    child.unref();
    return { ok: true, pid: child.pid };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

/**
 * 跨平台兼容性自检。
 *
 * 事实依据：
 * - dsh 0.2.2 的 engines 要求 Node >= 24.9.0；
 * - Node 24 官方二进制支持：
 *     Windows x64 >= Windows 10 / Server 2016（arm64 为 Tier 2）
 *     macOS >= 13.5（Darwin 22.6+）
 *     GNU/Linux x64/arm64：kernel >= 4.18、glibc >= 2.28（如 Ubuntu 20.04 / Debian 10 / RHEL 8）
 *     Alpine/musl 为 Experimental（可用但不承诺）
 * - 本插件没有原生模块，不依赖 Python / VS Build Tools / VC++ 编译环境。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import os from 'node:os';
import { LIMITS } from './defaults.js';

export const SUPPORT_MATRIX = Object.freeze({
  minNode: '24.9.0',
  windows: 'Windows 10 / Server 2016 及以上（x64 Tier 1，arm64 Tier 2）',
  macos: 'macOS 13.5 及以上（Darwin 22.6+）',
  linux: 'kernel >= 4.18 且 glibc >= 2.28（Ubuntu 20.04 / Debian 10 / RHEL 8 及以上）',
  musl: 'Alpine/musl 为官方 Experimental，能启动即可用',
  ios: 'iOS 不能运行 Node/dsh 宿主，只能作为浏览器面板客户端',
  nativeModules: '本插件零原生模块，无需编译工具链',
});

/** 语义化版本比较：a>b 返回 1，相等 0，小于 -1（支持 -rc.1 预发布） */
export function compareVersions(a, b) {
  const [coreA, preA] = String(a).split('-', 2);
  const [coreB, preB] = String(b).split('-', 2);
  const pa = coreA.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = coreB.split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  if (!preA && !preB) return 0;
  if (!preA) return 1;
  if (!preB) return -1;
  return preA === preB ? 0 : (preA > preB ? 1 : -1);
}

function glibcVersion() {
  try {
    const header = process.report?.getReport?.()?.header;
    return String(header?.glibcVersionRuntime || '');
  } catch {
    return '';
  }
}

function linuxKernel() {
  const [major, minor] = String(os.release()).split('.').map((x) => Number.parseInt(x, 10) || 0);
  return { major, minor, text: `${major}.${minor}` };
}

function darwinVersion() {
  const parts = String(os.release()).split('.').map((x) => Number.parseInt(x, 10) || 0);
  return { major: parts[0] || 0, minor: parts[1] || 0, text: `${parts[0] || 0}.${parts[1] || 0}` };
}

function windowsVersion() {
  const parts = String(os.release()).split('.').map((x) => Number.parseInt(x, 10) || 0);
  return { major: parts[0] || 0, minor: parts[1] || 0, build: parts[2] || 0, text: String(os.release()) };
}

/**
 * 检查数据目录是否可写（插件在不可写时会自动降级为内存模式，但仍应在报告里提示）。
 * @param {string} dir
 */
export function probeDataDir(dir) {
  if (!dir) return { ok: false, detail: '未指定数据目录' };
  try {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `.compat-${process.pid}.tmp`);
    writeFileSync(file, 'ok', 'utf8');
    rmSync(file, { force: true });
    return { ok: true, detail: dir };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 同步兼容性检查（不访问网络，可安全用于面板与启动日志）。
 * @param {{dataDir?: string, webAvailable?: boolean}} [opts]
 */
export function checkCompat(opts = {}) {
  const checks = [];
  const add = (id, label, ok, level, detail, hint) => {
    checks.push({ id, label, ok: !!ok, level, detail: String(detail || ''), hint: hint || '' });
  };

  const node = process.versions.node;
  add(
    'node',
    'Node.js 版本',
    compareVersions(node, SUPPORT_MATRIX.minNode) >= 0,
    'required',
    `当前 ${node}，dsh 要求 >= ${SUPPORT_MATRIX.minNode}`,
    '请升级 Node.js；dsh 0.2.x 在低版本无法启动。',
  );

  const platform = process.platform;
  const arch = process.arch;
  const knownPlatform = ['win32', 'linux', 'darwin'].includes(platform);
  add(
    'platform',
    '宿主操作系统',
    knownPlatform,
    knownPlatform ? 'info' : 'recommended',
    `${platform} / ${arch}，发行版 ${os.release()}`,
    knownPlatform ? '' : '仅 Windows / Linux / macOS 为官方宿主；Android、iOS 等只能作为面板客户端。',
  );

  const knownArch = ['x64', 'arm64'].includes(arch);
  add(
    'arch',
    'CPU 架构',
    knownArch,
    knownArch ? 'info' : 'recommended',
    arch,
    knownArch ? '' : `Node 24 对 ${arch} 为实验/不支持；建议 x64 或 arm64。`,
  );

  if (platform === 'linux') {
    const glibc = glibcVersion();
    const isMusl = !glibc && (process.report?.getReport?.()?.header?.glibcVersionRuntime === undefined);
    add(
      'libc',
      'Linux C 运行库',
      !!glibc && compareVersions(glibc, '2.28') >= 0,
      'recommended',
      glibc ? `glibc ${glibc}` : (isMusl ? 'musl（Alpine 类）' : '未检测到 glibc'),
      glibc ? 'glibc 低于 2.28 时官方 Node 24 二进制不受支持。' : SUPPORT_MATRIX.musl,
    );
    const kernel = linuxKernel();
    const kernelOk = kernel.major > 4 || (kernel.major === 4 && kernel.minor >= 18);
    add(
      'kernel',
      'Linux 内核',
      kernelOk,
      'recommended',
      kernel.text,
      kernelOk ? '' : 'Node 24 官方要求内核 >= 4.18；旧内核可能仍能运行，但不在官方支持范围。',
    );
  }

  if (platform === 'win32') {
    const win = windowsVersion();
    const winOk = win.major >= 10;
    add(
      'windows',
      'Windows 版本',
      winOk,
      'recommended',
      win.text,
      winOk
        ? ''
        : 'Node 24 官方不支持 Windows 7/8/8.1；若 Node 能启动，插件本身仍可运行（纯 JS），但不在官方支持范围。',
    );
    if (arch === 'arm64') {
      add('winArm', 'Windows arm64', true, 'info', 'Node 24 对 Windows arm64 为 Tier 2', '');
    }
    const systemRoot = String(process.env.SystemRoot || 'C:\\Windows');
    const ucrt = existsSync(join(systemRoot, 'System32', 'ucrtbase.dll'));
    add(
      'ucrt',
      'Windows 通用运行库（UCRT）',
      ucrt,
      'recommended',
      ucrt ? '已安装' : '未找到 ucrtbase.dll',
      ucrt ? '' : 'Windows 精简版可能移除了 UCRT；Node 本身依赖它，缺失时需补装 VC++ 运行库。',
    );
  }

  if (platform === 'darwin') {
    const darwin = darwinVersion();
    const macOk = darwin.major > 22 || (darwin.major === 22 && darwin.minor >= 6);
    add(
      'macos',
      'macOS 版本',
      macOk,
      'recommended',
      `Darwin ${darwin.text}（对应 macOS 13 及以上）`,
      macOk ? '' : 'Node 24 官方要求 macOS 13.5+（Darwin 22.6+）。iOS 不属于宿主平台。',
    );
  }

  add(
    'fetch',
    '全局 fetch / TLS',
    typeof globalThis.fetch === 'function',
    'required',
    typeof globalThis.fetch === 'function' ? '可用' : '不可用',
    '缺少 fetch 说明 Node 版本过低或被裁剪，无法调用 QQ 接口。',
  );
  const hasAbort = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function';
  add(
    'abort',
    'AbortSignal.timeout',
    hasAbort,
    'required',
    hasAbort ? '可用' : '不可用',
    '缺少超时能力会导致请求卡死，请升级 Node。',
  );

  const dataDir = opts.dataDir || join(tmpdir(), 'dsh-qqbot-guard-compat');
  const dirProbe = probeDataDir(dataDir);
  add(
    'dataDir',
    '数据目录可写',
    dirProbe.ok,
    'recommended',
    dirProbe.detail,
    dirProbe.ok ? '' : '不可写时插件会自动降级为内存模式，重启后设置/统计会丢失。',
  );

  if (opts.webAvailable !== undefined) {
    add(
      'web',
      'dsh Web 服务',
      !!opts.webAvailable,
      'recommended',
      opts.webAvailable ? '已就绪' : '未就绪',
      opts.webAvailable ? '' : '没有 webServer 时机器人仍可运行，但无法打开可视化面板。',
    );
  }

  const requiredFailed = checks.filter((c) => c.level === 'required' && !c.ok);
  const warnings = checks.filter((c) => c.level === 'recommended' && !c.ok);
  return {
    ok: requiredFailed.length === 0,
    node,
    platform,
    arch,
    release: os.release(),
    glibc: glibcVersion(),
    requiredFailed: requiredFailed.map((c) => c.id),
    warnings: warnings.map((c) => c.id),
    checks,
    matrix: SUPPORT_MATRIX,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * 网络探测（仅在 doctor 或面板手动触发时调用，不在启动时阻塞）。
 * 能拿到任意 HTTP 状态码即视为链路可达。
 */
export async function probeNetwork(timeoutMs = LIMITS.networkProbeTimeoutMs) {
  const targets = [
    { name: 'QQ 开放平台取票', url: 'https://bots.qq.com' },
    { name: 'QQ 机器人 API', url: 'https://api.bot.qq.com' },
  ];
  const results = await Promise.all(targets.map(async (t) => {
    try {
      const res = await fetch(t.url, {
        method: 'HEAD',
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { name: t.name, url: t.url, ok: true, status: res.status };
    } catch (error) {
      return {
        name: t.name,
        url: t.url,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }));
  return { ok: results.every((r) => r.ok), results };
}

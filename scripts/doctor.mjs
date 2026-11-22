/**
 * 兼容性体检命令：npm run doctor
 * 输出宿主 OS/Node/C 库、依赖可加载性、QQ 接口连通性，以及官方支持矩阵。
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkCompat, probeNetwork, SUPPORT_MATRIX } from '../lib/compat.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = mkdtempSync(join(tmpdir(), 'qqg-doctor-'));
const failures = [];

const compat = checkCompat({ dataDir });
printHeader('QQ 群管家 · 兼容性体检');
console.log(`Node ${compat.node} · ${compat.platform}/${compat.arch} · ${compat.release}`);
if (compat.glibc) console.log(`glibc ${compat.glibc}`);
console.log('');

for (const c of compat.checks) {
  const tag = c.ok ? '通过' : (c.level === 'required' ? '失败' : '注意');
  console.log(`[${tag}] ${c.label}：${c.detail}`);
  if (!c.ok && c.hint) console.log(`       建议：${c.hint}`);
  if (!c.ok && c.level === 'required') failures.push(c.label);
}

printHeader('依赖加载');
try {
  await import(pathToFileURL(join(root, 'lib', 'qq-api.js')).href);
  console.log('[通过] 插件内部模块可加载');
} catch (error) {
  failures.push('插件内部模块');
  console.log('[失败] 插件内部模块：' + errorText(error));
}
try {
  const sdk = await import('@tencent-connect/qqbot-nodejs');
  console.log(`[通过] QQ SDK 可加载${sdk.QQBot ? '（QQBot 已导出）' : ''}`);
} catch (error) {
  failures.push('QQ SDK');
  console.log('[失败] QQ SDK：' + errorText(error) + '（请重新安装依赖）');
}
try {
  await import('@deepseek-ai/schemastery');
  console.log('[通过] 配置 Schema 库可加载');
} catch (error) {
  failures.push('schemastery');
  console.log('[失败] schemastery：' + errorText(error));
}
const native = findNativeModules(join(root, 'node_modules'), 4);
console.log(native.length
  ? `[注意] 依赖里发现原生文件：${native.slice(0, 5).join(', ')}`
  : '[通过] 插件依赖零原生模块（无需 Python / VS Build Tools / VC++ 编译环境）');

printHeader('QQ 接口连通性');
const net = await probeNetwork();
for (const r of net.results) {
  console.log(`[${r.ok ? '通过' : '失败'}] ${r.name}：${r.ok ? `HTTP ${r.status}` : r.error}`);
}
if (!net.ok) {
  console.log('        网络不可达时机器人无法连接，请检查 DNS、代理、防火墙或精简系统是否移除了网络组件。');
}

printHeader('官方支持矩阵（Node 24）');
console.log('Windows：' + SUPPORT_MATRIX.windows);
console.log('macOS  ：' + SUPPORT_MATRIX.macos);
console.log('Linux  ：' + SUPPORT_MATRIX.linux);
console.log('musl   ：' + SUPPORT_MATRIX.musl);
console.log('iOS    ：' + SUPPORT_MATRIX.ios);
console.log('原生模块：' + SUPPORT_MATRIX.nativeModules);

rmSync(dataDir, { recursive: true, force: true });

if (failures.length) {
  console.error('\n体检未通过：' + failures.join('、'));
  process.exit(1);
}
console.log('\n体检通过：宿主满足 dsh 与本插件要求。');

function printHeader(text) {
  console.log('\n== ' + text + ' ==');
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

/** 简单扫描依赖里的原生二进制（只看有限深度，避免遍历过大） */
function findNativeModules(dir, depth) {
  if (depth <= 0) return [];
  const out = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...findNativeModules(full, depth - 1));
      else if (/\.(node|dll|so|dylib)$/iu.test(entry.name)) out.push(full);
    }
  } catch {
    // 目录不存在或不可读时忽略
  }
  return out;
}

/**
 * 插件身份信息：所有对外响应都带上它（自描述元数据）。
 *
 * ⚠️ 版本号的唯一事实来源是包根目录 package.json 的 version 字段。
 *    发布新版本时请只改 package.json（正常发包流程），不要改这里的常量。
 *    getPluginVersion() 每次实时读盘，磁盘上的版本一变，无需重启插件 / 宿主即生效。
 */
import { readFileSync } from 'node:fs';

export const PLUGIN_NAME = 'dsh-qqbot-guard';
export const PLUGIN_VENDOR = 'dsh-qqbot-guard';

/** 兜底版本：仅在 package.json 读取失败时使用，正常情况下不会被读到。 */
export const PLUGIN_VERSION = '1.7.3';

const PKG_URL = new URL('../package.json', import.meta.url);

/**
 * 实时读取包版本号：每次直接读硬盘上的 package.json（不经内存映射 / 不依赖宿主）。
 * 读盘失败（文件缺失 / JSON 损坏 / 字段异常）时回退到 PLUGIN_VERSION 常量，绝不抛出。
 * @returns {string} 版本号，如 '1.13.1'
 */
export function getPluginVersion() {
  try {
    const pkg = JSON.parse(readFileSync(PKG_URL, 'utf8'));
    const v = pkg && pkg.version;
    if (typeof v === 'string' && v.trim()) return v.trim();
  } catch {
    /* 读盘失败走兜底常量 */
  }
  return PLUGIN_VERSION;
}

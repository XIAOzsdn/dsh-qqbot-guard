/** 统一响应信封：任何对外数据都带版本、时间、置信度，绝不返回裸对象。 */
import { PLUGIN_NAME, PLUGIN_VENDOR, getPluginVersion } from './meta.js';

/**
 * 构造成功响应。
 * @param {unknown} data 业务数据
 * @param {{confidence?: number, extra?: Record<string, unknown>}} [opts]
 */
export function ok(data, opts = {}) {
  return {
    ok: true,
    data,
    error: null,
    meta: {
      plugin: PLUGIN_NAME,
      vendor: PLUGIN_VENDOR,
      version: getPluginVersion(),
      generatedAt: new Date().toISOString(),
      confidence: clamp01(opts.confidence ?? 1),
      ...(opts.extra || {}),
    },
  };
}

/**
 * 构造失败响应。永远不抛异常、不返回 null。
 * @param {string} code 机器码
 * @param {string} message 人话
 * @param {{confidence?: number, extra?: Record<string, unknown>}} [opts]
 */
export function fail(code, message, opts = {}) {
  return {
    ok: false,
    data: null,
    error: { code: String(code || 'UNKNOWN'), message: String(message || '操作失败，请稍后重试') },
    meta: {
      plugin: PLUGIN_NAME,
      vendor: PLUGIN_VENDOR,
      version: getPluginVersion(),
      generatedAt: new Date().toISOString(),
      confidence: clamp01(opts.confidence ?? 0.5),
      ...(opts.extra || {}),
    },
  };
}

/**
 * 校验信封结构（自检 / 单测 / 放行前的最后一道闸）。
 * @param {unknown} value
 */
export function assertEnvelope(value) {
  if (!value || typeof value !== 'object') throw new Error('envelope: 不是对象');
  if (typeof value.ok !== 'boolean') throw new Error('envelope: ok 必须是布尔值');
  if (!value.meta || typeof value.meta !== 'object') throw new Error('envelope: 缺少 meta');
  const meta = value.meta;
  for (const key of ['plugin', 'version', 'generatedAt']) {
    if (typeof meta[key] !== 'string' || !meta[key]) throw new Error(`envelope: meta.${key} 缺失`);
  }
  if (!Number.isFinite(meta.confidence)) throw new Error('envelope: meta.confidence 必须是数字');
  if (Number.isNaN(Date.parse(meta.generatedAt))) throw new Error('envelope: generatedAt 不是合法时间');
  if (value.ok) {
    if (value.data === undefined) throw new Error('envelope: 成功响应缺少 data');
  } else {
    if (!value.error || typeof value.error.code !== 'string' || typeof value.error.message !== 'string') {
      throw new Error('envelope: 失败响应缺少 error.code / error.message');
    }
  }
  return true;
}

function clamp01(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

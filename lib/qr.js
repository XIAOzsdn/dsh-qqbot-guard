/**
 * 二维码渲染：把一段文本（QQ 登录二维码 URL）渲染成内联 SVG。
 *
 * 为什么放在服务端：插件有两套界面（DSH 设置页 client.js / 独立局域网面板
 * webpanel/app.js），服务端出 SVG 两边都能直接插，不用各自再带一份编码器。
 * 编码器是 Kazuhiko Arase 的 qrcode-generator（MIT），随插件一起分发。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let encoder = null;

function lib() {
  if (encoder) return encoder;
  encoder = require('./vendor/qrcode.cjs');
  return encoder;
}

/**
 * 生成二维码 SVG。
 * @param {string} text 要编码的内容（QQ 登录二维码通常是一个 URL）
 * @param {{cellSize?: number, margin?: number}} [options]
 * @returns {string} 内联 SVG；内容为空或编码失败时返回空串
 */
export function qrSvg(text, options = {}) {
  const value = String(text || '').trim();
  if (!value) return '';
  const cellSize = Math.max(2, Math.min(12, Math.round(Number(options.cellSize) || 4)));
  const margin = Math.max(0, Math.min(8, Math.round(Number(options.margin) || 2)));
  try {
    const qr = lib()(0, 'M');
    qr.addData(value, 'Byte');
    qr.make();
    return String(qr.createSvgTag(cellSize, margin, 'QQ 登录二维码', 'QQ 登录二维码'));
  } catch {
    return '';
  }
}

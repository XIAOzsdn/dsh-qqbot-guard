import os from 'node:os';
import process from 'node:process';
import { PLUGIN_VERSION } from './meta.js';

/* 模块加载时先采一次样，首次打开面板也能算出插件启动以来的平均占用 */
let lastCpuSample = cpuTimes();

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const [key, value] of Object.entries(cpu.times)) {
      total += value;
      if (key === 'idle') idle += value;
    }
  }
  return { idle, total };
}

function platformName(platform) {
  if (platform === 'win32') return 'Windows';
  if (platform === 'darwin') return 'macOS';
  return platform;
}

/**
 * 设备信息（首页展示用）。
 * CPU 占用按两次采样差值计算，第一次调用返回 0，之后随面板轮询更新。
 */
export function readDeviceInfo() {
  const now = cpuTimes();
  let cpuUsage = 0;
  if (lastCpuSample) {
    const totalDelta = now.total - lastCpuSample.total;
    const idleDelta = now.idle - lastCpuSample.idle;
    if (totalDelta > 0) {
      cpuUsage = Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100));
    }
  }
  lastCpuSample = now;

  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const proc = process.memoryUsage();
  const platform = os.platform();
  const arch = os.arch();
  const release = os.release();

  return {
    pluginVersion: PLUGIN_VERSION,
    webuiVersion: PLUGIN_VERSION,
    /** 本插件走 QQ 官方 Bot API，不依赖 NapCat；如部署环境显式提供则展示 */
    napcatVersion: String(process.env.NAPCAT_VERSION || '').trim(),
    nodeVersion: process.version,
    hostName: os.hostname(),
    platform,
    arch,
    release,
    systemVersion: `${platformName(platform)} ${release} ${arch}`,
    platformRaw: `${platform} ${arch} ${release}`,
    cpuModel: String(cpus[0]?.model || '未知').replace(/\s+/gu, ' ').trim(),
    cpuCores: cpus.length,
    cpuSpeedMhz: Number(cpus[0]?.speed || 0),
    cpuUsage: Number(cpuUsage.toFixed(2)),
    loadAvg: os.loadavg().map((n) => Number(n.toFixed(2))),
    memTotal: totalMem,
    memUsed: usedMem,
    memUsage: totalMem ? Number(((usedMem / totalMem) * 100).toFixed(2)) : 0,
    processRss: proc.rss,
    processHeapUsed: proc.heapUsed,
    processUptimeMs: Math.round(process.uptime() * 1000),
    systemUptimeMs: Math.round(os.uptime() * 1000),
  };
}

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const BYTES_PER_GB = 1024 ** 3;

function gbText(bytes) {
  return (Math.max(0, Number(bytes) || 0) / BYTES_PER_GB).toFixed(1);
}

/** 毫秒 → “2天3小时 / 3小时12分 / 5分钟” */
export function durationText(ms) {
  const n = Math.max(0, Number(ms) || 0);
  if (n >= MS_PER_DAY) {
    const d = Math.floor(n / MS_PER_DAY);
    const h = Math.floor((n % MS_PER_DAY) / MS_PER_HOUR);
    return h ? `${d}天${h}小时` : `${d}天`;
  }
  if (n >= MS_PER_HOUR) {
    const h = Math.floor(n / MS_PER_HOUR);
    const m = Math.floor((n % MS_PER_HOUR) / MS_PER_MINUTE);
    return m ? `${h}小时${m}分` : `${h}小时`;
  }
  return `${Math.max(1, Math.floor(n / MS_PER_MINUTE))}分钟`;
}

/**
 * 把 readDeviceInfo() 的结果排版成群消息文本（纯函数，便于单测）。
 * 只包含公开的硬件/系统信息，不包含任何成员或群标识。
 */
export function formatDeviceInfo(info = {}) {
  const cpu = [
    String(info.cpuModel || '未知 CPU'),
    info.cpuCores ? `${info.cpuCores} 核` : '',
    `占用 ${Number(info.cpuUsage || 0).toFixed(1)}%`,
  ].filter(Boolean).join(' · ');
  const mem = `${gbText(info.memUsed)} GB / ${gbText(info.memTotal)} GB（${Number(info.memUsage || 0).toFixed(1)}%）`;
  return [
    '【设备信息】',
    `设备：${String(info.hostName || '未知')}（${String(info.systemVersion || '未知系统')}）`,
    `CPU：${cpu}`,
    `内存：${mem}`,
    `插件：v${String(info.pluginVersion || '')} · Node ${String(info.nodeVersion || '')}`,
    `运行：插件 ${durationText(info.processUptimeMs)} · 系统 ${durationText(info.systemUptimeMs)}`,
  ].join('\n');
}

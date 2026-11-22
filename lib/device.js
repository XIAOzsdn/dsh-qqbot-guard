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

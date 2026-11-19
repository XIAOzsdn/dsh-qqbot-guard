/**
 * 熔断器：外部接口连续失败时快速失败，冷却后半开试探。
 * 所有 QQ API 调用都经过它；熔断打开时返回预设兜底值，绝不抛异常给上层。
 */

export class Breaker {
  /**
   * @param {{threshold?: number, cooldownMs?: number}} [opts]
   */
  constructor(opts = {}) {
    this.threshold = Number(opts.threshold ?? 5);
    this.cooldownMs = Number(opts.cooldownMs ?? 60_000);
    this.failures = 0;
    this.openUntil = 0;
    this.lastError = '';
    this.trips = 0;
  }

  get state() {
    if (this.openUntil > Date.now()) return 'open';
    if (this.failures > 0) return 'half-open';
    return 'closed';
  }

  /**
   * @template T
   * @param {() => Promise<T>} fn
   * @param {{fallback: () => T, isFailure?: (error: unknown) => boolean}} opts
   * @returns {Promise<T>}
   */
  async run(fn, opts) {
    if (this.openUntil > Date.now()) {
      return opts.fallback();
    }
    try {
      const result = await fn();
      this.failures = 0;
      this.openUntil = 0;
      return result;
    } catch (error) {
      const failure = opts.isFailure ? opts.isFailure(error) : true;
      if (!failure) return opts.fallback();
      this.failures += 1;
      this.lastError = error instanceof Error ? error.message : String(error);
      if (this.failures >= this.threshold) {
        this.openUntil = Date.now() + this.cooldownMs;
        this.failures = 0;
        this.trips += 1;
      }
      return opts.fallback();
    }
  }

  snapshot() {
    return {
      state: this.state,
      trips: this.trips,
      lastError: this.lastError,
      retryAt: this.openUntil > Date.now() ? new Date(this.openUntil).toISOString() : '',
    };
  }
}

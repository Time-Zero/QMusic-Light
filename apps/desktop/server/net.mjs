import { CookieJar } from './cookies.mjs';

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const MIN_INTERVAL = 180;

/**
 * 串行 + 最小间隔的 HTTP 客户端（文档 §3.6 风控建议）：
 * 所有请求排队，失败指数退避，cookie 自动按域回写。
 */
export class Net {
  constructor({ minInterval = MIN_INTERVAL, jar } = {}) {
    this.jar = jar ?? new CookieJar();
    this.minInterval = minInterval;
    this.queue = Promise.resolve();
    this.lastAt = 0;
  }

  async throttle() {
    const wait = Math.max(0, this.lastAt + this.minInterval - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastAt = Date.now();
  }

  /**
   * 单次请求（默认不跟随重定向，便于捕获 Location 与 Set-Cookie）
   */
  request(url, options = {}) {
    const run = async () => {
      await this.throttle();
      const { method = 'GET', headers = {}, body, timeout = 15000, redirect = 'manual' } = options;
      const cookie = this.jar.headerFor(url);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const res = await fetch(url, {
          method,
          headers: {
            'User-Agent': UA,
            Referer: 'https://y.qq.com/',
            ...(cookie ? { Cookie: cookie } : {}),
            ...headers,
          },
          body,
          redirect,
          signal: controller.signal,
        });
        const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
        this.jar.setFromSetCookie(setCookies, url);
        return res;
      } finally {
        clearTimeout(timer);
      }
    };

    const task = this.queue.then(run, run);
    this.queue = task.catch(() => undefined);
    return task;
  }

  async requestWithRetry(url, options = {}, retries = 1) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this.request(url, options);
      } catch (error) {
        lastError = error;
        if (attempt < retries) await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
      }
    }
    throw lastError;
  }

  /** 手动跟随重定向，最多 8 跳，用于 check_sig / oauth authorize */
  async follow(url, options = {}, maxHops = 8) {
    let current = url;
    let currentOptions = options;
    for (let hop = 0; hop < maxHops; hop++) {
      const res = await this.requestWithRetry(current, { ...currentOptions, redirect: 'manual' });
      const status = res.status ?? 200;
      const location = res.headers.get('location');
      if (status >= 300 && status < 400 && location) {
        current = new URL(location, current).toString();
        currentOptions = { ...options, method: 'GET', body: undefined };
        continue;
      }
      return { res, url: current };
    }
    return { res: null, url: current };
  }

  async getJson(url, options = {}) {
    const res = await this.requestWithRetry(url, options);
    const text = await res.text();
    return parseJsonLoose(text);
  }
}

export function parseJsonLoose(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/^[\w$.]+\(([\s\S]*)\);?$/);
    if (match) {
      try {
        return JSON.parse(match[1]);
      } catch {
        return {};
      }
    }
    return {};
  }
}

export function cookieHeaderFrom(credentials, guid) {
  const parts = [
    `uin=${credentials.musicid}`,
    `qqmusic_uin=${credentials.musicid}`,
    `qm_keyst=${credentials.musickey}`,
    `qqmusic_key=${credentials.musickey}`,
  ];
  if (guid) parts.push(`guid=${guid}`);
  return parts.join('; ');
}

export function deviceCookie(guid) {
  return `guid=${guid}`;
}

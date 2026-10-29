/**
 * 带域匹配的 cookie jar。
 * qrsig 在 ptlogin2.qq.com，p_skey 在 graph.qq.com，必须按域隔离（文档 §3.2 坑 1）。
 */
export class CookieJar {
  constructor() {
    /** @type {Map<string, {name:string,value:string,domain:string,path:string,expires:number|null}>} */
    this.store = new Map();
  }

  static key(name, domain, path) {
    return `${domain}|${path}|${name}`;
  }

  setFromSetCookie(headers, requestUrl) {
    const host = new URL(requestUrl).hostname;
    for (const raw of headers) {
      const parts = raw.split(';');
      const [pair, ...attrs] = parts;
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      let domain = host;
      let path = '/';
      let expires = null;
      for (const attr of attrs) {
        const [k, v = ''] = attr.split('=');
        const key = k.trim().toLowerCase();
        if (key === 'domain') domain = v.trim().replace(/^\./, '');
        else if (key === 'path') path = v.trim() || '/';
        else if (key === 'max-age') expires = Date.now() + Number(v) * 1000;
        else if (key === 'expires') {
          const t = Date.parse(v);
          if (!Number.isNaN(t)) expires = t;
        }
      }
      if (expires !== null && expires <= Date.now()) {
        this.store.delete(CookieJar.key(name, domain, path));
        continue;
      }
      this.store.set(CookieJar.key(name, domain, path), { name, value, domain, path, expires });
    }
  }

  set(name, value, domain, path = '/') {
    this.store.set(CookieJar.key(name, domain, path), { name, value, domain, path, expires: null });
  }

  cookiesFor(url) {
    const target = new URL(url);
    const host = target.hostname;
    const path = target.pathname || '/';
    const now = Date.now();
    const result = [];
    for (const cookie of this.store.values()) {
      if (cookie.expires !== null && cookie.expires <= now) continue;
      const domainOk = host === cookie.domain || host.endsWith(`.${cookie.domain}`);
      if (!domainOk) continue;
      const pathOk = path === cookie.path || path.startsWith(cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`);
      if (!pathOk) continue;
      result.push(cookie);
    }
    return result;
  }

  get(name, url) {
    return this.cookiesFor(url).find((c) => c.name === name)?.value;
  }

  headerFor(url) {
    return this.cookiesFor(url)
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  }

  toJSON() {
    return [...this.store.values()];
  }

  static fromJSON(list) {
    const jar = new CookieJar();
    for (const c of list || []) {
      if (!c || !c.name || !c.domain) continue;
      jar.store.set(CookieJar.key(c.name, c.domain, c.path || '/'), {
        name: c.name,
        value: c.value ?? '',
        domain: c.domain,
        path: c.path || '/',
        expires: c.expires ?? null,
      });
    }
    return jar;
  }
}

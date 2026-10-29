import { describe, expect, it } from 'vitest';
import { CookieJar } from './cookies.mjs';

describe('CookieJar', () => {
  it('按域隔离 qrsig 与 p_skey', () => {
    const jar = new CookieJar();
    jar.setFromSetCookie(
      ['qrsig=abc123;Path=/;Domain=ptlogin2.qq.com;Secure;'],
      'https://ssl.ptlogin2.qq.com/ptqrshow',
    );
    jar.setFromSetCookie(
      ['p_skey=xyz789;Path=/;Domain=.qq.com;'],
      'https://graph.qq.com/oauth2.0/authorize',
    );

    expect(jar.get('qrsig', 'https://ssl.ptlogin2.qq.com/')).toBe('abc123');
    expect(jar.get('qrsig', 'https://graph.qq.com/')).toBeUndefined();
    expect(jar.get('p_skey', 'https://graph.qq.com/')).toBe('xyz789');
    expect(jar.get('p_skey', 'https://ssl.ptlogin2.qq.com/')).toBe('xyz789');
  });

  it('不为无关域名发送 cookie', () => {
    const jar = new CookieJar();
    jar.set('qm_keyst', 'secret', 'qq.com');
    expect(jar.headerFor('https://u.y.qq.com/cgi-bin/musicu.fcg')).toBe('qm_keyst=secret');
    expect(jar.headerFor('https://example.com/')).toBe('');
    expect(jar.headerFor('https://notqq.com/')).toBe('');
  });

  it('max-age 过期后不再返回', () => {
    const jar = new CookieJar();
    jar.setFromSetCookie(['a=1;Max-Age=0;Domain=qq.com;'], 'https://y.qq.com/');
    expect(jar.get('a', 'https://y.qq.com/')).toBeUndefined();
  });

  it('序列化后可恢复，用于多账号切换时重建 jar', () => {
    const jar = new CookieJar();
    jar.setFromSetCookie(['a=1;Domain=qq.com;Path=/'], 'https://y.qq.com/');
    const restored = CookieJar.fromJSON(jar.toJSON());
    expect(restored.get('a', 'https://u.y.qq.com/')).toBe('1');
  });
});

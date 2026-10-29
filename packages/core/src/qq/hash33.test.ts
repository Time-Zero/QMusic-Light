import { describe, expect, it } from 'vitest';
import { hash33 } from './hash33';

/** 独立参考实现：用 BigInt 保证不依赖 JS 位运算细节 */
function reference(input: string, seed = 0): number {
  let e = BigInt(seed);
  for (let i = 0; i < input.length; i++) {
    e = (e + (e << 5n) + BigInt(input.charCodeAt(i))) & 0xffffffffn;
  }
  return Number(e & 0x7fffffffn);
}

describe('hash33', () => {
  it('与 32 位截断参考实现一致', () => {
    const samples = ['qrsig', '', 'a', 'abcdefghijklmnopqrstuvwxyz', '74e90131e01e0055caa3'];
    for (const sample of samples) {
      expect(hash33(sample)).toBe(reference(sample));
      expect(hash33(sample, 5381)).toBe(reference(sample, 5381));
    }
  });

  it('返回值始终是非负 31 位整数', () => {
    const value = hash33('p_skey_abcdefg', 5381);
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(0x7fffffff);
  });

  it('g_tk 与 ptqrtoken 使用不同 seed', () => {
    const input = 'same-cookie';
    expect(hash33(input, 0)).not.toBe(hash33(input, 5381));
  });
});

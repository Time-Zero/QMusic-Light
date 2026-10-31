import { describe, expect, it } from 'vitest';
import { formatBytes } from './format';

describe('formatBytes', () => {
  it('keeps small values in bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
  });

  it('steps up to KB / MB / GB', () => {
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 * 1024)).toBe('1 MB');
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1 GB');
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe('2.5 GB');
  });

  it('drops decimals once the number is big', () => {
    expect(formatBytes(12 * 1024 * 1024)).toBe('12 MB');
  });

  it('guards against negative or NaN input', () => {
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
  });
});

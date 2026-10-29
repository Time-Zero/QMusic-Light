import type { CSSProperties } from 'react';

const PALETTES: [string, string][] = [
  ['#2a6b52', '#0f2c22'],
  ['#6b3a5a', '#2a1222'],
  ['#2f4d7a', '#101c2e'],
  ['#7a5a2f', '#2e2010'],
  ['#3d5c6b', '#152229'],
  ['#5a3d6b', '#221527'],
  ['#3a6b5c', '#12251f'],
  ['#5c4a7a', '#1e1830'],
  ['#7a5a3a', '#2c1d10'],
  ['#3a4a7a', '#121a2e'],
  ['#6b3a3a', '#2a1212'],
  ['#3a6b3a', '#122512'],
];

export function hashString(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

export function coverPalette(seed: string | number): { c1: string; c2: string } {
  const key = String(seed ?? '');
  const [c1, c2] = PALETTES[hashString(key) % PALETTES.length];
  return { c1, c2 };
}

export const coverVars = (seed: string | number): CSSProperties => {
  const { c1, c2 } = coverPalette(seed);
  return { '--cover-a': c1, '--cover-b': c2 } as CSSProperties;
};

/** 用封面平均色驱动播放页背景（文档 §7.4）。跨域受限时回退到哈希渐变。 */
export function extractPalette(src: string, seed: string): Promise<{ c1: string; c2: string }> {
  const fallback = coverPalette(seed);
  if (!src) return Promise.resolve(fallback);
  return new Promise((resolve) => {
    const img = new Image();
    // 不设置 crossOrigin：CDN 未返回 CORS 头时 canvas 会被标记为 tainted，
    // getImageData 抛错后回退到哈希渐变，避免控制台噪音。
    img.decoding = 'async';
    const timer = window.setTimeout(() => resolve(fallback), 1500);
    img.onload = () => {
      window.clearTimeout(timer);
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 16;
        canvas.height = 16;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(fallback);
          return;
        }
        ctx.drawImage(img, 0, 0, 16, 16);
        const { data } = ctx.getImageData(0, 0, 16, 16);
        let r = 0;
        let g = 0;
        let b = 0;
        for (let i = 0; i < data.length; i += 4) {
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
        }
        const count = data.length / 4;
        resolve({
          c1: `rgb(${Math.round(r / count)}, ${Math.round(g / count)}, ${Math.round(b / count)})`,
          c2: fallback.c2,
        });
      } catch {
        resolve(fallback);
      }
    };
    img.onerror = () => {
      window.clearTimeout(timer);
      resolve(fallback);
    };
    img.src = src;
  });
}

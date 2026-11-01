import { useState } from 'react';
import { coverAtSize } from '@/shared/lib/color';

interface Props {
  src?: string;
  alt?: string;
  glyph?: string;
  className?: string;
  /**
   * CDN 允许的最小取图边长（px）。只在地址命得中 QQ 音乐的尺寸模板时生效，
   * 别的图源原样返回。传了就是「我要显示多大」，不是「图片实际多大」。
   */
  size?: number;
}

/** 封面图：懒加载 + 异步解码；加载失败回退到渐变 + 音符（文档 §7.7） */
export function CoverImage({ src, alt = '', glyph = '♫', className, size }: Props) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <span className={className ? `${className} g` : 'g'} aria-hidden="true">
        {glyph}
      </span>
    );
  }
  return (
    <img
      src={coverAtSize(src, size)}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

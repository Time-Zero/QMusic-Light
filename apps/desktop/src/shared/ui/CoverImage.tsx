import { useState } from 'react';

interface Props {
  src?: string;
  alt?: string;
  glyph?: string;
  className?: string;
}

/** 封面图：懒加载 + 异步解码；加载失败回退到渐变 + 音符（文档 §7.7） */
export function CoverImage({ src, alt = '', glyph = '♫', className }: Props) {
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
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

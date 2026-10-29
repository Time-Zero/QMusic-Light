/** 与领域层同算法，平台层独立实现（文档 §3.6） */
export function hash33(input, seed = 0) {
  let e = seed;
  for (let i = 0; i < String(input).length; i++) {
    e += (e << 5) + String(input).charCodeAt(i);
  }
  return e & 0x7fffffff;
}

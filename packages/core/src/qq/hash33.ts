/**
 * hash33：ptqrtoken / g_tk 共用（文档 §3.6）
 * 注意 32 位截断，JS 位运算天然按 int32 处理。
 */
export function hash33(input: string, seed = 0): number {
  let e = seed;
  for (let i = 0; i < input.length; i++) {
    e += (e << 5) + input.charCodeAt(i);
  }
  return e & 0x7fffffff;
}

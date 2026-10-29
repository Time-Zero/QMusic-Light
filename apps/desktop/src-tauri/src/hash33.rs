/// 与领域层同算法，平台层独立实现（文档 §3.6）。
/// 注意 JS 的 `charCodeAt` 按 UTF-16 码元计数，这里用 `encode_utf16` 保持一致。
pub fn hash33(input: &str, seed: u32) -> u32 {
    let mut e = seed;
    for unit in input.encode_utf16() {
        e = e.wrapping_add(e << 5).wrapping_add(u32::from(unit));
    }
    e & 0x7fff_ffff
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_known_value() {
        // 与 Node 平台层 / 前端 hash33 的交叉验证值
        assert_eq!(hash33("qrsig", 0), 138234694);
        assert_eq!(hash33("", 0), 0);
    }

    #[test]
    fn is_non_negative() {
        for input in ["p_skey_abcdefg", "a", "0", "中文"] {
            assert!(hash33(input, 5381) <= 0x7fff_ffff);
        }
    }

    #[test]
    fn different_seed_differs() {
        assert_ne!(hash33("same-cookie", 0), hash33("same-cookie", 5381));
    }
}

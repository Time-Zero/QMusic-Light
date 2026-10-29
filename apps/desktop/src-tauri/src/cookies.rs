use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};
use url::Url;

/// 带域匹配的 cookie jar。
/// qrsig 在 ptlogin2.qq.com，p_skey 在 graph.qq.com，必须按域隔离（文档 §3.2 坑 1）。
#[derive(Clone, Debug)]
pub struct Cookie {
    pub name: String,
    pub value: String,
    pub domain: String,
    pub path: String,
    pub expires_at: Option<i64>,
}

#[derive(Clone, Debug, Default)]
pub struct CookieJar {
    store: HashMap<String, Cookie>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn key(name: &str, domain: &str, path: &str) -> String {
    format!("{domain}|{path}|{name}")
}

impl CookieJar {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_from_set_cookie(&mut self, headers: &[String], request_url: &str) {
        let host = Url::parse(request_url)
            .ok()
            .and_then(|url| url.host_str().map(ToOwned::to_owned))
            .unwrap_or_default();
        if host.is_empty() {
            return;
        }

        for raw in headers {
            let mut parts = raw.split(';');
            let Some(pair) = parts.next() else { continue };
            let Some(eq) = pair.find('=') else { continue };

            let name = pair[..eq].trim().to_string();
            let value = pair[eq + 1..].trim().to_string();
            if name.is_empty() {
                continue;
            }

            let mut domain = host.clone();
            let mut path = "/".to_string();
            let mut expires_at: Option<i64> = None;

            for attr in parts {
                let (attr_key, attr_value) = match attr.split_once('=') {
                    Some((k, v)) => (k.trim().to_ascii_lowercase(), v.trim().to_string()),
                    None => (attr.trim().to_ascii_lowercase(), String::new()),
                };
                match attr_key.as_str() {
                    "domain" => {
                        let trimmed = attr_value.trim_start_matches('.');
                        if !trimmed.is_empty() {
                            domain = trimmed.to_string();
                        }
                    }
                    "path" => {
                        if !attr_value.is_empty() {
                            path = attr_value;
                        }
                    }
                    "max-age" => {
                        if let Ok(seconds) = attr_value.parse::<i64>() {
                            expires_at = Some(now_ms() + seconds * 1000);
                        }
                    }
                    "expires" => {
                        if let Ok(time) = httpdate::parse_http_date(&attr_value) {
                            if let Ok(duration) = time.duration_since(UNIX_EPOCH) {
                                expires_at = Some(duration.as_millis() as i64);
                            }
                        }
                    }
                    _ => {}
                }
            }

            let store_key = key(&name, &domain, &path);
            if matches!(expires_at, Some(expiry) if expiry <= now_ms()) {
                self.store.remove(&store_key);
                continue;
            }

            self.store.insert(
                store_key,
                Cookie {
                    name,
                    value,
                    domain,
                    path,
                    expires_at,
                },
            );
        }
    }

    #[allow(dead_code)]
    pub fn set(&mut self, name: &str, value: &str, domain: &str, path: &str) {
        self.store.insert(
            key(name, domain, path),
            Cookie {
                name: name.to_string(),
                value: value.to_string(),
                domain: domain.to_string(),
                path: path.to_string(),
                expires_at: None,
            },
        );
    }

    fn cookies_for(&self, url: &str) -> Vec<&Cookie> {
        let Ok(target) = Url::parse(url) else {
            return Vec::new();
        };
        let host = target.host_str().unwrap_or("");
        let path = if target.path().is_empty() {
            "/"
        } else {
            target.path()
        };
        let now = now_ms();

        self.store
            .values()
            .filter(|cookie| {
                if matches!(cookie.expires_at, Some(expiry) if expiry <= now) {
                    return false;
                }
                let domain_ok =
                    host == cookie.domain || host.ends_with(&format!(".{}", cookie.domain));
                if !domain_ok {
                    return false;
                }
                if path == cookie.path {
                    return true;
                }
                let prefix = if cookie.path.ends_with('/') {
                    cookie.path.clone()
                } else {
                    format!("{}/", cookie.path)
                };
                path.starts_with(&prefix)
            })
            .collect()
    }

    pub fn get(&self, name: &str, url: &str) -> Option<String> {
        self.cookies_for(url)
            .into_iter()
            .find(|cookie| cookie.name == name)
            .map(|cookie| cookie.value.clone())
    }

    pub fn header_for(&self, url: &str) -> String {
        self.cookies_for(url)
            .into_iter()
            .map(|cookie| format!("{}={}", cookie.name, cookie.value))
            .collect::<Vec<_>>()
            .join("; ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn isolates_by_domain() {
        let mut jar = CookieJar::new();
        jar.set_from_set_cookie(
            &["qrsig=abc123;Path=/;Domain=ptlogin2.qq.com;Secure;".to_string()],
            "https://ssl.ptlogin2.qq.com/ptqrshow",
        );
        jar.set_from_set_cookie(
            &["p_skey=xyz789;Path=/;Domain=.qq.com;".to_string()],
            "https://graph.qq.com/oauth2.0/authorize",
        );

        assert_eq!(
            jar.get("qrsig", "https://ssl.ptlogin2.qq.com/").as_deref(),
            Some("abc123")
        );
        assert_eq!(jar.get("qrsig", "https://graph.qq.com/"), None);
        assert_eq!(
            jar.get("p_skey", "https://graph.qq.com/").as_deref(),
            Some("xyz789")
        );
        assert_eq!(
            jar.get("p_skey", "https://ssl.ptlogin2.qq.com/").as_deref(),
            Some("xyz789")
        );
    }

    #[test]
    fn does_not_leak_to_unrelated_domains() {
        let mut jar = CookieJar::new();
        jar.set("qm_keyst", "secret", "qq.com", "/");
        assert_eq!(
            jar.header_for("https://u.y.qq.com/cgi-bin/musicu.fcg"),
            "qm_keyst=secret"
        );
        assert_eq!(jar.header_for("https://example.com/"), "");
        assert_eq!(jar.header_for("https://notqq.com/"), "");
    }

    #[test]
    fn expired_cookie_is_removed() {
        let mut jar = CookieJar::new();
        jar.set_from_set_cookie(
            &["a=1;Max-Age=0;Domain=qq.com;".to_string()],
            "https://y.qq.com/",
        );
        assert_eq!(jar.get("a", "https://y.qq.com/"), None);
    }

    #[test]
    fn path_matching() {
        let mut jar = CookieJar::new();
        jar.set_from_set_cookie(
            &["scoped=1;Path=/rsc;Domain=y.qq.com;".to_string()],
            "https://y.qq.com/rsc/login",
        );
        assert_eq!(
            jar.get("scoped", "https://y.qq.com/rsc/fcgi-bin/x")
                .as_deref(),
            Some("1")
        );
        assert_eq!(jar.get("scoped", "https://y.qq.com/other"), None);
    }
}

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use reqwest::header::{HeaderMap, HeaderName, HeaderValue, LOCATION, SET_COOKIE, USER_AGENT};
use reqwest::redirect::Policy;
use reqwest::Client;
use serde_json::Value;
use tokio::sync::Mutex as AsyncMutex;

use crate::cookies::CookieJar;
use crate::error::{PResult, PlatformError};
use crate::models::Credentials;

pub const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const MIN_INTERVAL: Duration = Duration::from_millis(180);

#[derive(Debug)]
pub struct HttpResponse {
    pub status: u16,
    pub location: Option<String>,
    pub body: Vec<u8>,
}

impl HttpResponse {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).to_string()
    }

    pub fn json_loose(&self) -> Value {
        parse_json_loose(&self.text())
    }
}

/// 串行 + 最小间隔的 HTTP 客户端（文档 §3.6 风控建议）：
/// 所有请求排队，失败指数退避，cookie 自动按域回写。
#[derive(Clone)]
pub struct Net {
    client: Client,
    jar: Arc<Mutex<CookieJar>>,
    gate: Arc<AsyncMutex<()>>,
    last_at: Arc<Mutex<Option<Instant>>>,
    min_interval: Duration,
}

impl Default for Net {
    fn default() -> Self {
        Self::new()
    }
}

impl Net {
    pub fn new() -> Self {
        let client = Client::builder()
            .redirect(Policy::none())
            .timeout(Duration::from_secs(15))
            .build()
            .expect("初始化 HTTP 客户端失败");
        Self {
            client,
            jar: Arc::new(Mutex::new(CookieJar::new())),
            gate: Arc::new(AsyncMutex::new(())),
            last_at: Arc::new(Mutex::new(None)),
            min_interval: MIN_INTERVAL,
        }
    }

    pub fn jar_get(&self, name: &str, url: &str) -> Option<String> {
        self.jar.lock().ok()?.get(name, url)
    }

    async fn throttle_and_mark(&self) {
        let wait = {
            let last = self.last_at.lock().ok().and_then(|guard| *guard);
            match last {
                Some(last_at) => self
                    .min_interval
                    .checked_sub(last_at.elapsed())
                    .unwrap_or_default(),
                None => Duration::ZERO,
            }
        };
        if !wait.is_zero() {
            tokio::time::sleep(wait).await;
        }
        if let Ok(mut guard) = self.last_at.lock() {
            *guard = Some(Instant::now());
        }
    }

    pub async fn request(
        &self,
        url: &str,
        method: &str,
        headers: &[(String, String)],
        body: Option<String>,
    ) -> PResult<HttpResponse> {
        // 串行队列：与 Node 平台层一致，整个请求期间持有 gate
        let _gate = self.gate.lock().await;
        self.throttle_and_mark().await;

        let cookie = self
            .jar
            .lock()
            .ok()
            .map(|jar| jar.header_for(url))
            .unwrap_or_default();

        let mut header_map = HeaderMap::new();
        header_map.insert(USER_AGENT, HeaderValue::from_static(UA));
        header_map.insert(
            reqwest::header::REFERER,
            HeaderValue::from_static("https://y.qq.com/"),
        );
        if !cookie.is_empty() {
            if let Ok(value) = HeaderValue::from_str(&cookie) {
                header_map.insert(reqwest::header::COOKIE, value);
            }
        }
        for (name, value) in headers {
            if let (Ok(name), Ok(value)) = (
                HeaderName::from_bytes(name.as_bytes()),
                HeaderValue::from_str(value),
            ) {
                header_map.insert(name, value);
            }
        }

        let mut builder = self
            .client
            .request(method.parse().unwrap_or(reqwest::Method::GET), url)
            .headers(header_map);
        if let Some(body) = body {
            builder = builder.body(body);
        }

        let response = builder
            .send()
            .await
            .map_err(|error| PlatformError::msg(format!("网络请求失败：{error}")))?;

        let status = response.status().as_u16();
        let location = response
            .headers()
            .get(LOCATION)
            .and_then(|value| value.to_str().ok())
            .map(ToOwned::to_owned);
        let set_cookie = response
            .headers()
            .get_all(SET_COOKIE)
            .iter()
            .filter_map(|value| value.to_str().ok().map(ToOwned::to_owned))
            .collect::<Vec<_>>();

        if !set_cookie.is_empty() {
            if let Ok(mut jar) = self.jar.lock() {
                jar.set_from_set_cookie(&set_cookie, url);
            }
        }

        let body = response
            .bytes()
            .await
            .map_err(|error| PlatformError::msg(format!("读取响应失败：{error}")))?
            .to_vec();

        Ok(HttpResponse {
            status,
            location,
            body,
        })
    }

    pub async fn request_with_retry(
        &self,
        url: &str,
        method: &str,
        headers: &[(String, String)],
        body: Option<String>,
    ) -> PResult<HttpResponse> {
        let mut last_error = None;
        for attempt in 0..=1 {
            match self.request(url, method, headers, body.clone()).await {
                Ok(response) => return Ok(response),
                Err(error) => {
                    last_error = Some(error);
                    if attempt == 0 {
                        tokio::time::sleep(Duration::from_millis(300)).await;
                    }
                }
            }
        }
        Err(last_error.unwrap_or_else(|| PlatformError::msg("网络请求失败")))
    }

    /// 手动跟随重定向，最多 8 跳，用于 check_sig / oauth authorize。
    pub async fn follow(
        &self,
        url: &str,
        headers: &[(String, String)],
    ) -> PResult<(Option<HttpResponse>, String)> {
        let mut current = url.to_string();
        for _ in 0..8 {
            let response = self
                .request_with_retry(&current, "GET", headers, None)
                .await?;
            let status = response.status;
            let location = response.location.clone();
            if (300..400).contains(&status) {
                if let Some(location) = location {
                    let base = url::Url::parse(&current)
                        .map_err(|error| PlatformError::msg(error.to_string()))?;
                    let next = base
                        .join(&location)
                        .map_err(|error| PlatformError::msg(error.to_string()))?;
                    current = next.to_string();
                    continue;
                }
            }
            return Ok((Some(response), current));
        }
        Ok((None, current))
    }
}

pub fn parse_json_loose(text: &str) -> Value {
    let trimmed = text.trim().trim_start_matches('\u{feff}').trim();
    if trimmed.is_empty() {
        return Value::Object(Default::default());
    }
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        return value;
    }
    // JSONP: callback({...});
    if let (Some(start), Some(end)) = (trimmed.find('('), trimmed.rfind(')')) {
        if end > start {
            if let Ok(value) = serde_json::from_str::<Value>(&trimmed[start + 1..end]) {
                return value;
            }
        }
    }
    Value::Object(Default::default())
}

pub fn cookie_header_from(credentials: &Credentials, guid: Option<&str>) -> String {
    let mut parts = vec![
        format!("uin={}", credentials.musicid),
        format!("qqmusic_uin={}", credentials.musicid),
        format!("qm_keyst={}", credentials.musickey),
        format!("qqmusic_key={}", credentials.musickey),
    ];
    if let Some(guid) = guid.filter(|value| !value.is_empty()) {
        parts.push(format!("guid={guid}"));
    }
    parts.join("; ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_json_and_jsonp() {
        assert_eq!(parse_json_loose("{\"a\":1}")["a"], 1);
        assert_eq!(parse_json_loose("callback({\"a\":2});")["a"], 2);
        assert_eq!(parse_json_loose(""), Value::Object(Default::default()));
        assert_eq!(
            parse_json_loose("not json"),
            Value::Object(Default::default())
        );
    }

    #[test]
    fn builds_cookie_header() {
        let credentials = Credentials {
            musicid: "123".into(),
            musickey: "key".into(),
            ..Default::default()
        };
        assert_eq!(
            cookie_header_from(&credentials, Some("g")),
            "uin=123; qqmusic_uin=123; qm_keyst=key; qqmusic_key=key; guid=g"
        );
    }
}

use std::sync::LazyLock;

use serde_json::{json, Map, Value};
use url::Url;

use crate::error::{PResult, PlatformError};
use crate::hash33::hash33;
use crate::models::Credentials;
use crate::net::{cookie_header_from, Net};

pub const MUSICU: &str = "https://u.y.qq.com/cgi-bin/musicu.fcg";
const LEGACY_HOSTS: [&str; 3] = ["c.y.qq.com", "c6.y.qq.com", "u.y.qq.com"];

/// 与 packages/core/src/qq/endpoints.ts 对齐的接口白名单（文档 §5.3）。
static ALLOWED: LazyLock<Vec<&'static str>> = LazyLock::new(|| {
    vec![
        "music.srfDissInfo.DissInfo/CgiGetDiss",
        "music.pf_song_detail_svr/get_song_detail",
        "music.trackInfo.UniformRuleCtrl/CgiGetTrackInfo",
        "music.musichallSong.PlayLyricInfo/GetPlayLyricInfo",
        "music.vkey.GetVkey/UrlGetVkey",
        "music.recommend.RecommendFeed/get_recommend_feed",
        "music.playlist.PlaylistSquare/GetRecommendFeed",
        "music.radioProxy.MbTrackRadioSvr/get_radio_track",
        "music.recommend.TrackRelationServer/GetRadarSong",
        "music.search.SearchCgiService/DoSearchForQQMusicDesktop",
        "music.musicasset.PlaylistBaseRead/GetPlaylistByUin",
        "music.musicasset.PlaylistFavRead/CgiGetPlaylistFavInfo",
        "music.musicasset.PlaylistDetailWrite/AddSonglist",
        "music.musicasset.PlaylistDetailWrite/DelSonglist",
        "VipLogin.VipLoginInter/vip_login_base",
        "music.login.LoginServer/Login",
    ]
});

fn session_headers(credentials: Option<&Credentials>, guid: &str) -> Vec<(String, String)> {
    let cookie = match credentials {
        Some(credentials) => cookie_header_from(credentials, Some(guid)),
        None if !guid.is_empty() => format!("guid={guid}"),
        None => String::new(),
    };
    if cookie.is_empty() {
        Vec::new()
    } else {
        vec![("Cookie".to_string(), cookie)]
    }
}

/// api.call：comm.uin / qm_keyst 由平台强制覆盖，JS 传入无效（文档 §5.3）。
pub async fn api_call(
    net: &Net,
    credentials: Option<&Credentials>,
    guid: &str,
    request: &Value,
) -> PResult<Value> {
    let module = request
        .get("module")
        .and_then(Value::as_str)
        .ok_or_else(|| PlatformError::bad_request("缺少 module"))?;
    let method = request
        .get("method")
        .and_then(Value::as_str)
        .ok_or_else(|| PlatformError::bad_request("缺少 method"))?;
    let key = format!("{module}/{method}");
    if !ALLOWED.contains(&key.as_str()) {
        return Err(PlatformError::forbidden(format!("接口不在白名单：{key}")));
    }

    let param = request.get("param").cloned().unwrap_or_else(|| json!({}));
    let mut comm = json!({
        "ct": 24,
        "cv": 4747474,
        "format": "json",
        "platform": "yqq.json",
    });
    if let Some(extra) = request.get("comm").and_then(Value::as_object) {
        if let Some(target) = comm.as_object_mut() {
            for (name, value) in extra {
                target.insert(name.clone(), value.clone());
            }
        }
    }
    comm["uin"] = json!(credentials.map(|item| item.musicid.as_str()).unwrap_or("0"));

    let payload = json!({
        "comm": comm,
        "req_0": { "module": module, "method": method, "param": param },
    });

    let headers = vec![
        ("Content-Type".to_string(), "application/json".to_string()),
        ("Referer".to_string(), "https://y.qq.com/".to_string()),
    ];
    let mut headers = headers;
    headers.extend(session_headers(credentials, guid));

    let response = net
        .request_with_retry(MUSICU, "POST", &headers, Some(payload.to_string()))
        .await?;
    Ok(response.json_loose())
}

fn stringify_query(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(boolean) => Some(boolean.to_string()),
        _ => None,
    }
}

pub fn build_legacy_url(
    host: &str,
    path: &str,
    query: &Map<String, Value>,
    credentials: Option<&Credentials>,
) -> PResult<Url> {
    if !path.starts_with('/') || path.contains("://") {
        return Err(PlatformError::bad_request("非法的 CGI 路径"));
    }
    if !LEGACY_HOSTS.contains(&host) {
        return Err(PlatformError::forbidden(format!("域名不在白名单：{host}")));
    }

    let mut url = Url::parse(&format!("https://{host}{path}"))
        .map_err(|error| PlatformError::bad_request(format!("非法 URL：{error}")))?;
    {
        let mut pairs = url.query_pairs_mut();
        for (name, value) in query {
            if let Some(text) = stringify_query(value) {
                pairs.append_pair(name, &text);
            }
        }
        for (name, value) in [
            ("format", "json"),
            ("inCharset", "utf8"),
            ("outCharset", "utf-8"),
            ("platform", "yqq.json"),
            ("needNewCode", "0"),
        ] {
            if !query.contains_key(name) {
                pairs.append_pair(name, value);
            }
        }
        if let Some(credentials) = credentials {
            pairs.append_pair("g_tk", &hash33(&credentials.musickey, 5381).to_string());
        }
    }
    Ok(url)
}

/// 老 CGI：仅允许 QQ 音乐域名，自动补 g_tk / format。
pub async fn legacy_get(
    net: &Net,
    credentials: Option<&Credentials>,
    guid: &str,
    request: &Value,
) -> PResult<Value> {
    let path = request
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| PlatformError::bad_request("缺少 path"))?;
    let host = request
        .get("host")
        .and_then(Value::as_str)
        .unwrap_or("c.y.qq.com");
    let query = request
        .get("query")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let url = build_legacy_url(host, path, &query, credentials)?;
    let mut headers = vec![("Referer".to_string(), "https://y.qq.com/".to_string())];
    headers.extend(session_headers(credentials, guid));

    let response = net
        .request_with_retry(url.as_str(), "GET", &headers, None)
        .await?;
    Ok(response.json_loose())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whitelist_contains_core_endpoints() {
        assert!(ALLOWED.contains(&"music.vkey.GetVkey/UrlGetVkey"));
        assert!(ALLOWED.contains(&"music.search.SearchCgiService/DoSearchForQQMusicDesktop"));
        assert!(!ALLOWED.contains(&"music.login.LoginServer/QQLogin"));
    }

    #[test]
    fn legacy_url_adds_defaults_and_g_tk() {
        let credentials = Credentials {
            musickey: "abc".into(),
            ..Default::default()
        };
        let mut query = Map::new();
        query.insert("userid".into(), json!("123"));
        query.insert("format".into(), json!("jsonp"));
        let url = build_legacy_url(
            "c6.y.qq.com",
            "/rsc/fcgi-bin/x.fcg",
            &query,
            Some(&credentials),
        )
        .expect("合法 URL");
        let text = url.as_str();
        assert!(text.starts_with("https://c6.y.qq.com/rsc/fcgi-bin/x.fcg?"));
        assert!(text.contains("userid=123"));
        assert!(text.contains("format=jsonp"));
        assert!(text.contains("inCharset=utf8"));
        assert!(text.contains("g_tk="));
    }

    #[test]
    fn legacy_url_rejects_unknown_host_and_scheme() {
        let query = Map::new();
        assert!(build_legacy_url("evil.com", "/x", &query, None).is_err());
        assert!(build_legacy_url("c.y.qq.com", "https://evil.com/x", &query, None).is_err());
    }
}

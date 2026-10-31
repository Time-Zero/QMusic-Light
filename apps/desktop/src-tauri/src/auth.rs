use std::sync::{Arc, LazyLock};

use base64::Engine;
use regex::Regex;
use serde_json::{json, Value};
use tokio::sync::Mutex as AsyncMutex;
use url::Url;
use uuid::Uuid;

use crate::error::{PResult, PlatformError};
use crate::hash33::hash33;
use crate::models::{
    account_from_credentials, now_ms, now_secs, should_refresh, Account, Credentials, Profile,
};
use crate::net::{cookie_header_from, Net};
use crate::qq_api::MUSICU;
use crate::state::{persist_account, AppState, QrSession};

const APP_ID: &str = "716027609";
const DAID: &str = "383";
const THIRD_AID: &str = "100497308";
const LOGIN_HOST: &str = "https://ssl.ptlogin2.qq.com";
const XLOGIN_URL: &str = "https://xui.ptlogin2.qq.com/cgi-bin/xlogin";
const XLOGIN_ORIGIN: &str = "https://xui.ptlogin2.qq.com/";
const GRAPH_HOST: &str = "https://graph.qq.com";
const REDIRECT_URI: &str =
    "https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https%3A%2F%2Fy.qq.com%2F";
const QR_TTL_MS: i64 = 120 * 1000;
const QR_KEEP_MS: i64 = 5 * 60 * 1000;

/// ptuiCB('66','0','','0','二维码未失效。', '')
/// 登录成功时实测返回 7 个参数（第 5 个是文案、第 6 个是昵称），
/// 因此只取前 3 个必填项 + 可选文案，不要求参数个数与右括号。
static PTUI: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"ptuiCB\(\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'(?:\s*,\s*'([^']*)')?(?:\s*,\s*'([^']*)')?",
    )
    .expect("ptuiCB 正则")
});

fn state_by_code(code: &str) -> Option<&'static str> {
    match code {
        "66" => Some("waiting"),
        "67" => Some("scanned"),
        "65" => Some("expired"),
        "68" => Some("cancelled"),
        "0" => Some("confirmed"),
        _ => None,
    }
}

fn get_string(value: &Value, keys: &[&str]) -> String {
    for key in keys {
        match value.get(*key) {
            Some(Value::String(text)) if !text.is_empty() => return text.clone(),
            Some(Value::Number(number)) => return number.to_string(),
            Some(Value::Bool(boolean)) => return boolean.to_string(),
            _ => {}
        }
    }
    String::new()
}

fn get_i64(value: &Value, keys: &[&str]) -> Option<i64> {
    for key in keys {
        match value.get(*key) {
            Some(Value::Number(number)) => {
                if let Some(integer) = number.as_i64() {
                    return Some(integer);
                }
            }
            Some(Value::String(text)) => {
                if let Ok(integer) = text.parse::<i64>() {
                    return Some(integer);
                }
            }
            _ => {}
        }
    }
    None
}

fn login_payload(body: Value, with_tme_login_type: bool) -> Value {
    let mut comm = json!({ "ct": 24, "cv": 4747474, "uin": "0", "format": "json" });
    if with_tme_login_type {
        comm["tmeLoginType"] = json!(2);
    }
    json!({ "comm": comm, "req_0": body })
}

/// 步骤 1：二维码生成（文档 §3.2 步骤 1）
/// 先走一次 xlogin 拿 `pt_login_sig`：ptqrlogin 要带上它，后续 graph 授权才不会当成陌生设备。
pub async fn create_qr() -> PResult<QrSession> {
    let net = Net::new();
    let mut xlogin =
        Url::parse(XLOGIN_URL).map_err(|error| PlatformError::msg(error.to_string()))?;
    {
        let mut query = xlogin.query_pairs_mut();
        query.append_pair("appid", APP_ID);
        query.append_pair("daid", DAID);
        query.append_pair("style", "33");
        query.append_pair("login_text", "授权并登录");
        query.append_pair("hide_title_bar", "1");
        query.append_pair("hide_border", "1");
        query.append_pair("target", "self");
        query.append_pair("s_url", &format!("{GRAPH_HOST}/oauth2.0/login_jump"));
        query.append_pair("pt_3rd_aid", THIRD_AID);
        query.append_pair(
            "pt_feedback_link",
            "https://support.qq.com/products/77942?customInfo=.appid100497308",
        );
    }
    let _ = net.request_with_retry(xlogin.as_str(), "GET", &[], None).await?;
    let login_sig = net.jar_get("pt_login_sig", XLOGIN_ORIGIN).unwrap_or_default();

    let mut url = Url::parse(&format!("{LOGIN_HOST}/ptqrshow"))
        .map_err(|error| PlatformError::msg(error.to_string()))?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("appid", APP_ID);
        query.append_pair("e", "2");
        query.append_pair("l", "M");
        query.append_pair("s", "3");
        query.append_pair("d", "72");
        query.append_pair("v", "4");
        query.append_pair("t", &rand::random::<f64>().to_string());
        query.append_pair("daid", DAID);
        query.append_pair("pt_3rd_aid", THIRD_AID);
    }

    let response = net
        .request_with_retry(
            url.as_str(),
            "GET",
            &[(
                "Referer".to_string(),
                "https://xui.ptlogin2.qq.com/".to_string(),
            )],
            None,
        )
        .await?;
    let qrsig = net
        .jar_get("qrsig", &format!("{LOGIN_HOST}/"))
        .unwrap_or_default();
    if qrsig.is_empty() {
        return Err(PlatformError::msg("二维码生成失败：未拿到 qrsig"));
    }

    let encoded = base64::engine::general_purpose::STANDARD.encode(&response.body);
    Ok(QrSession {
        id: Uuid::new_v4().to_string(),
        net,
        qrsig,
        login_sig,
        image_data_url: format!("data:image/png;base64,{encoded}"),
        created_at: now_ms(),
        expires_at: now_ms() + QR_TTL_MS,
        status: "waiting".to_string(),
        message: String::new(),
        account: None,
        credentials: None,
    })
}

/// 步骤 2-3：轮询二维码状态
async fn poll_session(session: &mut QrSession) -> PResult<Value> {
    match session.status.as_str() {
        "expired" => {
            return Ok(json!({
                "state": "expired",
                "message": if session.message.is_empty() { "二维码已失效" } else { &session.message },
            }));
        }
        "cancelled" => {
            return Ok(json!({
                "state": "cancelled",
                "message": if session.message.is_empty() { "已取消登录" } else { &session.message },
            }));
        }
        "confirmed" => {
            if let Some(account) = &session.account {
                return Ok(json!({ "state": "confirmed", "account": account }));
            }
        }
        _ => {}
    }
    if now_ms() > session.expires_at {
        session.status = "expired".to_string();
        return Ok(json!({ "state": "expired", "message": "二维码已失效" }));
    }

    let token = hash33(&session.qrsig, 0);
    let mut url = Url::parse(&format!("{LOGIN_HOST}/ptqrlogin"))
        .map_err(|error| PlatformError::msg(error.to_string()))?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("u1", "https://graph.qq.com/oauth2.0/login_jump");
        query.append_pair("ptqrtoken", &token.to_string());
        query.append_pair("ptredirect", "0");
        query.append_pair("h", "1");
        query.append_pair("t", "1");
        query.append_pair("g", "1");
        query.append_pair("from_ui", "1");
        query.append_pair("ptlang", "2052");
        query.append_pair("action", &format!("0-0-{}", now_ms()));
        query.append_pair("js_ver", "20102616");
        query.append_pair("js_type", "1");
        query.append_pair("login_sig", &session.login_sig);
        query.append_pair("pt_uistyle", "40");
        query.append_pair("aid", APP_ID);
        query.append_pair("daid", DAID);
        query.append_pair("pt_3rd_aid", THIRD_AID);
        query.append_pair("has_onekey", "1");
    }

    let response = session
        .net
        .request_with_retry(url.as_str(), "GET", &[], None)
        .await?;
    let text = response.text();
    let captures = PTUI
        .captures(&text)
        .ok_or_else(|| PlatformError::msg("二维码状态解析失败"))?;
    let code = captures.get(1).map(|value| value.as_str()).unwrap_or("");
    let check_url = captures.get(3).map(|value| value.as_str()).unwrap_or("");
    let message = captures.get(5).map(|value| value.as_str()).unwrap_or("");

    let Some(state) = state_by_code(code) else {
        session.status = "cancelled".to_string();
        session.message = if message.is_empty() {
            format!("登录失败（{code}）")
        } else {
            message.to_string()
        };
        return Ok(json!({ "state": "cancelled", "message": session.message }));
    };

    match state {
        "waiting" | "scanned" => {
            session.status = state.to_string();
            Ok(json!({ "state": state }))
        }
        "expired" | "cancelled" => {
            session.status = state.to_string();
            session.message = message.to_string();
            Ok(json!({ "state": state, "message": message }))
        }
        _ => {
            // code=0：完整链路 check_sig → oauth → QQLogin
            match complete_login(&session.net, check_url).await {
                Ok((account, credentials)) => {
                    session.status = "confirmed".to_string();
                    session.account = Some(account.clone());
                    session.credentials = Some(credentials);
                    Ok(json!({ "state": "confirmed", "account": account }))
                }
                Err(error) => {
                    session.status = "expired".to_string();
                    session.message = error.message.clone();
                    Ok(json!({ "state": "expired", "message": error.message }))
                }
            }
        }
    }
}

/// 步骤 4-6：p_skey → code → musickey
async fn complete_login(net: &Net, check_url: &str) -> PResult<(Account, Credentials)> {
    if check_url.is_empty() {
        return Err(PlatformError::msg("登录回调地址为空"));
    }
    let parsed_check = Url::parse(check_url)
        .map_err(|error| PlatformError::msg(format!("回调地址非法：{error}")))?;
    let uin = parsed_check
        .query_pairs()
        .find(|(key, _)| key == "uin")
        .map(|(_, value)| value.to_string())
        .unwrap_or_default();

    // 4. check_sig：302 并下发 p_skey（graph.qq.com）
    let _ = net.follow(check_url, &[]).await?;
    let mut p_skey = net
        .jar_get("p_skey", &format!("{GRAPH_HOST}/"))
        .unwrap_or_default();
    if p_skey.is_empty() {
        let retry = net.request_with_retry(check_url, "GET", &[], None).await?;
        if let Some(location) = retry.location {
            let parsed = Url::parse(&location).or_else(|_| {
                Url::parse(&format!("{GRAPH_HOST}/")).and_then(|base| base.join(&location))
            });
            if let Ok(parsed) = parsed {
                p_skey = parsed
                    .query_pairs()
                    .find(|(key, _)| key == "p_skey")
                    .map(|(_, value)| value.to_string())
                    .unwrap_or_default();
            }
        }
    }
    if p_skey.is_empty() {
        return Err(PlatformError::msg("未获取到 p_skey，登录被中断"));
    }

    let g_tk = hash33(&p_skey, 5381);
    let state = Uuid::new_v4().simple().to_string();
    let ui = Uuid::new_v4().simple().to_string();

    // 5. 授权确认：PC 授权页是由 JS 表单 POST 到 authorize（qlogin_v2.js 的 Q.agree），
    //    只发 GET 会一直 302 回 show?which=Login，永远拿不到 code。
    let form = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("response_type", "code")
        .append_pair("client_id", THIRD_AID)
        .append_pair("redirect_uri", REDIRECT_URI)
        .append_pair("scope", "get_user_info,get_app_friends")
        .append_pair("state", &state[..16])
        .append_pair("switch", "")
        .append_pair("from_ptlogin", "1")
        .append_pair("src", "1")
        .append_pair("update_auth", "1")
        .append_pair("openapi", "1010_1030")
        .append_pair("g_tk", &g_tk.to_string())
        .append_pair("auth_time", &now_ms().to_string())
        .append_pair("ui", &ui)
        .finish();

    let authorized = net
        .request(
            &format!("{GRAPH_HOST}/oauth2.0/authorize"),
            "POST",
            &[
                (
                    "Content-Type".to_string(),
                    "application/x-www-form-urlencoded".to_string(),
                ),
                (
                    "Referer".to_string(),
                    format!("{GRAPH_HOST}/oauth2.0/show?which=Login&display=pc"),
                ),
                ("X-Requested-With".to_string(), "XMLHttpRequest".to_string()),
            ],
            Some(form),
        )
        .await?;

    let mut location = authorized.location.clone().unwrap_or_default();
    let mut code = String::new();
    for _ in 0..6 {
        if location.is_empty() {
            break;
        }
        let Ok(url) = Url::parse(&location).or_else(|_| {
            Url::parse(&format!("{GRAPH_HOST}/")).and_then(|base| base.join(&location))
        }) else {
            break;
        };
        if let Some((_, value)) = url.query_pairs().find(|(key, _)| key == "code") {
            code = value.to_string();
        }
        if !code.is_empty() {
            break;
        }
        if !url
            .host_str()
            .map(|host| host.ends_with("qq.com"))
            .unwrap_or(false)
        {
            break;
        }
        let next = net.request(url.as_str(), "GET", &[], None).await?;
        location = next.location.unwrap_or_default();
    }
    if code.is_empty() {
        // 少数账号返回 JSON：{ ret: 0, callback: "https://...&code=xxx" }
        let json = authorized.json_loose();
        let callback = json
            .get("callback")
            .and_then(Value::as_str)
            .or_else(|| {
                json.get("data")
                    .and_then(|data| data.get("callback"))
                    .and_then(Value::as_str)
            })
            .unwrap_or("");
        if let Ok(url) = Url::parse(callback) {
            code = url
                .query_pairs()
                .find(|(key, _)| key == "code")
                .map(|(_, value)| value.to_string())
                .unwrap_or_default();
        }
    }
    if code.is_empty() {
        return Err(PlatformError::msg("未获取到 OAuth code，请稍后重试"));
    }

    // 6. QQLogin 换 musickey
    let payload = login_payload(
        json!({
            "module": "QQConnectLogin.LoginServer",
            "method": "QQLogin",
            "param": { "code": code },
        }),
        true,
    );
    let login_response = net
        .request(
            MUSICU,
            "POST",
            &[
                ("Content-Type".to_string(), "application/json".to_string()),
                ("Referer".to_string(), "https://y.qq.com/".to_string()),
            ],
            Some(payload.to_string()),
        )
        .await?;
    let json = login_response.json_loose();
    let data = json
        .get("req_0")
        .and_then(|value| value.get("data"))
        .or_else(|| json.get("data"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    let musickey = get_string(&data, &["musickey", "musicKey", "qm_keyst"]);
    if musickey.is_empty() {
        let message = json
            .get("req_0")
            .and_then(|value| value.get("msg"))
            .and_then(Value::as_str)
            .or_else(|| json.get("msg").and_then(Value::as_str))
            .unwrap_or("QQLogin 未返回 musickey");
        return Err(PlatformError::msg(message));
    }

    let musicid = {
        let id = get_string(&data, &["musicid", "str_musicid"]);
        if id.is_empty() {
            uin
        } else {
            id
        }
    };
    let create_time = get_i64(&data, &["musickeyCreateTime"]).unwrap_or_else(now_secs);
    let expires_in = get_i64(&data, &["keyExpiresIn"]).unwrap_or(7_776_000);

    let credentials = Credentials {
        musicid,
        musickey,
        refresh_key: get_string(&data, &["refresh_key"]),
        refresh_token: get_string(&data, &["refresh_token"]),
        access_token: get_string(&data, &["access_token"]),
        openid: get_string(&data, &["openid"]),
        encrypt_uin: get_string(&data, &["encryptUin", "encrypt_uin"]),
        key_expires_in: expires_in,
        musickey_create_time: create_time,
        key_expires_at: (create_time + expires_in) * 1000,
        saved_at: now_ms(),
        ..Default::default()
    };

    let profile = fetch_profile(net, &credentials).await;
    let account = Account {
        uin: credentials.musicid.clone(),
        nickname: if profile.nickname.is_empty() {
            format!("QQ {}", credentials.musicid)
        } else {
            profile.nickname.clone()
        },
        avatar: profile.avatar.clone(),
        encrypt_uin: if credentials.encrypt_uin.is_empty() {
            profile.encrypt_uin.clone()
        } else {
            credentials.encrypt_uin.clone()
        },
        vip_level: profile.vip_level,
        key_expires_at: credentials.key_expires_at,
        vip_label: profile.vip_label.clone(),
    };

    let mut credentials = credentials;
    credentials.nickname = account.nickname.clone();
    credentials.avatar = account.avatar.clone();
    credentials.vip_level = account.vip_level;
    credentials.vip_label = account.vip_label.clone();
    credentials.encrypt_uin = account.encrypt_uin.clone();

    Ok((account, credentials))
}

/// QQ 头像常返回 http:// 链接，统一升级成 https，避免 WebView 混合内容拦截
fn upgrade_https(url: &str) -> String {
    match url.strip_prefix("http://") {
        Some(rest) => format!("https://{rest}"),
        None => url.to_string(),
    }
}

/// 用户资料：老 CGI `fcg_get_profile_homepage.fcg` 已下线（实测 200 空包），
/// 改用 musicu 的 `music.UserInfo.userInfoServer / GetLoginUserInfo`（文档 §3.4）
pub async fn fetch_profile(net: &Net, credentials: &Credentials) -> Profile {
    let result = async {
        let payload = json!({
            "comm": { "ct": 24, "cv": 4747474, "uin": "0", "format": "json", "tmeLoginType": 2 },
            "req_0": {
                "module": "music.UserInfo.userInfoServer",
                "method": "GetLoginUserInfo",
                "param": {},
            },
        });
        let headers = vec![
            ("Content-Type".to_string(), "application/json".to_string()),
            ("Cookie".to_string(), cookie_header_from(credentials, None)),
        ];
        let response = net
            .request_with_retry(MUSICU, "POST", &headers, Some(payload.to_string()))
            .await?;
        let json = response.json_loose();
        let data = json
            .get("req_0")
            .and_then(|value| value.get("data"))
            .or_else(|| json.get("data"))
            .cloned()
            .unwrap_or_else(|| json!({}));
        let info = data.get("info").cloned().unwrap_or_else(|| json!({}));

        Ok::<Profile, PlatformError>(Profile {
            nickname: get_string(&info, &["nick", "nickname"]),
            avatar: upgrade_https(&get_string(&info, &["logo", "headpic", "avatar"])),
            encrypt_uin: get_string(&info, &["encrypt_uin", "encryptUin"]),
            vip_level: 0,
            vip_label: String::new(),
        })
    }
    .await;

    result.unwrap_or_default()
}

/// 静默续期：启动时若距过期 < 24h 则刷新（文档 §3.3）
pub async fn refresh(credentials: &Credentials) -> PResult<Credentials> {
    let payload = login_payload(
        json!({
            "module": "music.login.LoginServer",
            "method": "Login",
            "param": {
                "openid": credentials.openid,
                "refresh_token": credentials.refresh_token,
                "refresh_key": credentials.refresh_key,
                "musickey": credentials.musickey,
                "loginMode": 2,
                "musicid": credentials.musicid,
                "access_token": credentials.access_token,
                "expired_in": 0,
            },
        }),
        false,
    );

    let net = Net::new();
    let response = net
        .request(
            MUSICU,
            "POST",
            &[
                ("Content-Type".to_string(), "application/json".to_string()),
                ("Referer".to_string(), "https://y.qq.com/".to_string()),
                ("Cookie".to_string(), cookie_header_from(credentials, None)),
            ],
            Some(payload.to_string()),
        )
        .await?;
    let json = response.json_loose();
    let data = json
        .get("req_0")
        .and_then(|value| value.get("data"))
        .or_else(|| json.get("data"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    let musickey = get_string(&data, &["musickey"]);
    if musickey.is_empty() {
        return Err(PlatformError::msg("续期失败"));
    }

    let create_time = get_i64(&data, &["musickeyCreateTime"]).unwrap_or_else(now_secs);
    let expires_in = get_i64(&data, &["keyExpiresIn"])
        .or_else(|| Some(credentials.key_expires_in))
        .filter(|value| *value > 0)
        .unwrap_or(7_776_000);

    let mut next = credentials.clone();
    next.musickey = musickey;
    next.refresh_key = {
        let value = get_string(&data, &["refresh_key"]);
        if value.is_empty() {
            credentials.refresh_key.clone()
        } else {
            value
        }
    };
    next.refresh_token = {
        let value = get_string(&data, &["refresh_token"]);
        if value.is_empty() {
            credentials.refresh_token.clone()
        } else {
            value
        }
    };
    next.access_token = {
        let value = get_string(&data, &["access_token"]);
        if value.is_empty() {
            credentials.access_token.clone()
        } else {
            value
        }
    };
    next.key_expires_in = expires_in;
    next.musickey_create_time = create_time;
    next.key_expires_at = (create_time + expires_in) * 1000;
    next.saved_at = now_ms();
    Ok(next)
}

pub async fn qr_start(state: &AppState) -> PResult<Value> {
    prune_qr_sessions(state).await;
    let session = create_qr().await?;
    let dto = json!({
        "qrId": session.id,
        "imageDataUrl": session.image_data_url,
        "expiresAt": session.expires_at,
    });
    let id = session.id.clone();
    state
        .qr_sessions
        .lock()
        .await
        .insert(id, Arc::new(AsyncMutex::new(session)));
    Ok(dto)
}

async fn prune_qr_sessions(state: &AppState) {
    let now = now_ms();
    let mut sessions = state.qr_sessions.lock().await;
    sessions.retain(|_, session| match session.try_lock() {
        Ok(session) => now - session.created_at <= QR_KEEP_MS,
        Err(_) => true,
    });
}

pub async fn qr_poll(state: &AppState, args: &Value) -> PResult<Value> {
    let qr_id = args
        .get("qrId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let session = {
        let sessions = state.qr_sessions.lock().await;
        sessions.get(&qr_id).cloned()
    };
    let Some(session) = session else {
        return Ok(json!({ "state": "expired", "message": "二维码会话已失效，请刷新" }));
    };

    let mut session = session.lock().await;
    let outcome = poll_session(&mut session).await;

    if session.status == "confirmed" {
        if let (Some(credentials), Some(account)) =
            (session.credentials.clone(), session.account.clone())
        {
            drop(session);
            state.set_session(Some(credentials.clone()), Some(account.clone()));
            let _ = state.secret.save(&credentials);
            let _ = persist_account(state, &account);
            let mut sessions = state.qr_sessions.lock().await;
            sessions.retain(|id, _| id == &qr_id);
            return outcome;
        }
    }

    outcome
}

pub async fn logout(state: &AppState) {
    state.secret.clear();
    state.set_session(None, None);
    state.qr_sessions.lock().await.clear();
}

/// 启动恢复 + 静默续期。与 Node 平台层一致：结果做进程内缓存。
pub async fn restore(state: &AppState) -> Value {
    let _gate = state.restore_lock.lock().await;
    if let Some(cached) = state
        .restore_cache
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
    {
        return cached;
    }

    let Some(mut credentials) = state.credentials() else {
        let value = json!({});
        cache_restore(state, &value);
        return value;
    };

    if should_refresh(&credentials) {
        match refresh(&credentials).await {
            Ok(next) => {
                credentials = next;
                let _ = state.secret.save(&credentials);
            }
            Err(_) => {
                let value = json!({ "expired": true, "account": state.account() });
                cache_restore(state, &value);
                return value;
            }
        }
    }

    let mut account = account_from_credentials(&credentials);
    if account.nickname.is_empty() || account.nickname == format!("QQ {}", account.uin) {
        let profile = fetch_profile(&state.http, &credentials).await;
        if !profile.nickname.is_empty() {
            account.nickname = profile.nickname;
        }
        if !profile.avatar.is_empty() {
            account.avatar = profile.avatar;
        }
        if !profile.encrypt_uin.is_empty() {
            account.encrypt_uin = profile.encrypt_uin;
        }
        account.vip_level = profile.vip_level;
        account.vip_label = profile.vip_label;

        credentials.nickname = account.nickname.clone();
        credentials.avatar = account.avatar.clone();
        credentials.encrypt_uin = account.encrypt_uin.clone();
        credentials.vip_level = account.vip_level;
        credentials.vip_label = account.vip_label.clone();
        let _ = state.secret.save(&credentials);
    }

    state.set_session(Some(credentials), Some(account.clone()));
    let _ = persist_account(state, &account);

    let value = json!({ "account": account });
    cache_restore(state, &value);
    value
}

fn cache_restore(state: &AppState, value: &Value) {
    if let Ok(mut cache) = state.restore_cache.lock() {
        *cache = Some(value.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_success_line_with_seven_args() {
        // 实测：手机确认后返回 7 个参数，第 5 个是文案、第 6 个是昵称
        let text = "ptuiCB('0','0','https://ssl.ptlogin2.graph.qq.com/check_sig?pttype=1&uin=123','0','登录成功！', '小Q', '')";
        let captures = PTUI.captures(text).expect("ptuiCB");
        assert_eq!(captures.get(1).unwrap().as_str(), "0");
        assert!(captures
            .get(3)
            .unwrap()
            .as_str()
            .starts_with("https://ssl.ptlogin2.graph.qq.com/check_sig"));
        assert_eq!(captures.get(5).unwrap().as_str(), "登录成功！");
    }

    #[test]
    fn maps_ptui_codes() {
        assert_eq!(state_by_code("66"), Some("waiting"));
        assert_eq!(state_by_code("67"), Some("scanned"));
        assert_eq!(state_by_code("65"), Some("expired"));
        assert_eq!(state_by_code("68"), Some("cancelled"));
        assert_eq!(state_by_code("0"), Some("confirmed"));
        assert_eq!(state_by_code("99"), None);
    }

    #[test]
    fn matches_ptui_line_with_space() {
        let text = "ptuiCB('66','0','','0','二维码未失效。', '')";
        let captures = PTUI.captures(text).expect("ptuiCB");
        assert_eq!(captures.get(1).unwrap().as_str(), "66");
        assert_eq!(captures.get(3).unwrap().as_str(), "");
        assert_eq!(captures.get(5).unwrap().as_str(), "二维码未失效。");
    }

    #[test]
    fn parses_scalar_values() {
        let value = json!({ "musicid": 123, "musickey": "key", "flag": true });
        assert_eq!(get_string(&value, &["musicid"]), "123");
        assert_eq!(get_string(&value, &["flag"]), "true");
        assert_eq!(get_string(&value, &["missing"]), "");
    }

    #[test]
    fn upgrades_http_avatar() {
        assert_eq!(
            upgrade_https("http://thirdqq.qlogo.cn/g?b=sdk&k=abc&s=100"),
            "https://thirdqq.qlogo.cn/g?b=sdk&k=abc&s=100"
        );
        assert_eq!(upgrade_https("https://y.gtimg.cn/x.jpg"), "https://y.gtimg.cn/x.jpg");
        assert_eq!(upgrade_https(""), "");
    }

    #[test]
    fn refresh_window() {
        let mut credentials = Credentials::default();
        assert!(!should_refresh(&credentials));
        credentials.key_expires_at = now_ms() + 60_000;
        assert!(should_refresh(&credentials));
        credentials.key_expires_at = now_ms() + 48 * 60 * 60 * 1000;
        assert!(!should_refresh(&credentials));
    }

    #[test]
    fn qr_ttl_is_two_minutes() {
        assert_eq!(QR_TTL_MS, 120_000);
    }
}

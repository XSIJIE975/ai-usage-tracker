//! WorkBuddy 登录凭据解析（ADR-0029）
//!
//! 网关（workbuddy.cn 前置的 APISIX/EdgeOne）放行要同时满足两件事，2026-09-21 在
//! 真实登录会话上二分实测：
//! 1. `Cookie` 必须是 `session` + `session_2` 成对——只发 session 直接 401 网关页；
//! 2. `User-Agent` 必须与登录时**逐字节相同**——把末位 `Edg/153.0.0.0` 改成
//!    `153.0.0.1`、或换成纯 Chrome/非浏览器 UA，同一有效 Cookie 也照样 401。
//!
//! 所以凭据不能只收 session 的 Value：session_2 与 UA 都得跟着用户那次登录走。
//!
//! 录入形态取「浏览器 DevTools → Network → Copy as cURL」整串（一次粘贴即拿到同源的
//! 三要素），同时兼容只贴 `Cookie:` 头、以及 0.9.0 之前那种裸 session Value。

use serde::Serialize;

/// 粘贴原文上限：真实 curl（含 `--data-raw` 请求体）约 8KB，留三十倍余量，
/// 只挡住误粘的超大文本，不承担安全判定
const MAX_PASTE_LENGTH: usize = 262_144;
/// 单个 Cookie 值上限：实测 session 近 4000 字符、session_2 近 2000 字符
const MAX_COOKIE_VALUE_LENGTH: usize = 65_536;
/// UA 上限：主流浏览器 UA 不足 200 字符，超出即视为粘错
const MAX_USER_AGENT_LENGTH: usize = 512;

/// 缺 UA 时的回落值（0.9.0 实测可用的 Edge UA）。只是兜底不是判据：浏览器一升版
/// 它就不匹配，那时唯一出路是让用户重贴 curl——所以 UA 的正确来源永远是凭据本身
pub const WORKBUDDY_FALLBACK_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0";

/// 从粘贴原文解析出的登录凭据。`session2` 与 `userAgent` 允许缺失（旧填法），
/// 缺失时按 0.9.0 的行为处理
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbuddyCredential {
    pub session: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session2: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_agent: Option<String>,
}

impl WorkbuddyCredential {
    /// 拼装 `Cookie` 头：session_2 缺失时只发 session
    pub fn cookie_header(&self) -> String {
        match &self.session2 {
            Some(second) => format!("session={}; session_2={}", self.session, second),
            None => format!("session={}", self.session),
        }
    }

    pub fn user_agent_or_default(&self) -> &str {
        self.user_agent.as_deref().unwrap_or(WORKBUDDY_FALLBACK_UA)
    }
}

/// 三形态入口：整条 curl（bash 的 `\` 续行 / cmd 的 `^` 续行）→ `Cookie:` 头 → 裸 session Value
pub fn parse_workbuddy_credential(raw: &str) -> Result<WorkbuddyCredential, String> {
    let text = raw.trim();
    if text.is_empty() {
        return Err("请填写 WorkBuddy 登录凭据（粘贴浏览器的 Copy as cURL）".to_string());
    }
    if text.len() > MAX_PASTE_LENGTH {
        return Err(format!(
            "粘贴内容过长（{} 字符），请确认只粘贴了 workbuddy.cn 的一条请求",
            text.len()
        ));
    }

    let (session, session2, user_agent) = if looks_like_curl(text) {
        let (cookie_text, pasted_ua) = from_curl(text)?;
        let cookie_text = cookie_text.ok_or_else(|| NO_SESSION_HINT.to_string())?;
        let (session, session2) = pick_session_pair(&cookie_text)?;
        let user_agent = pasted_ua.map(|value| validate_user_agent(&value)).transpose()?;
        (session, session2, user_agent)
    } else if let Some(cookie_text) = cookie_header_body(text) {
        let (session, session2) = pick_session_pair(cookie_text)?;
        (session, session2, None)
    } else {
        // 0.9.0 的填法：整串就是 session 的 Value 本体
        (validate_cookie_value(text)?, None, None)
    };

    Ok(WorkbuddyCredential {
        session,
        session2,
        user_agent,
    })
}

const NO_SESSION_HINT: &str = "粘贴内容里没有 session Cookie，请重新复制 Copy as cURL";

/// 出现 curl 命令名或 -H/-b 选项才按 curl 解析：裸 Cookie 串与自然语言都不会命中
fn looks_like_curl(text: &str) -> bool {
    text.split_whitespace().any(|token| {
        matches!(token, "curl" | "-H" | "--header" | "-b" | "--cookie")
            || token.starts_with("--header=")
            || token.starts_with("--cookie=")
    })
}

/// `curl` 串 → (Cookie 头原文, User-Agent 原文)。
///
/// 只认 `-H/--header` 与 `-b/--cookie`，其余选项（`--compressed`、`--data-raw`、`-X`、
/// `--http2` 这些 DevTools 会随版本增减的东西）一律跳过——这正是不用通用 curl 语法库的
/// 原因：白名单语法的解析器遇到没见过的选项是整条报错。取值型选项之外的 token
/// 都不吃掉后面的参数，否则 `--http2 -H 'Cookie: …'` 会把 Cookie 连带吞掉。
fn from_curl(text: &str) -> Result<(Option<String>, Option<String>), String> {
    let tokens = shell_words::split(&join_continuations(text))
        .map_err(|error| format!("粘贴的 curl 无法解析（引号不成对或被截断？）：{error}"))?;
    let mut cookies: Vec<String> = Vec::new();
    let mut user_agent: Option<String> = None;
    let mut it = tokens.iter();
    while let Some(token) = it.next() {
        let bare = token.trim_start_matches('-');
        let (flag, attached) = match bare.split_once('=') {
            Some((flag, value)) => (flag, Some(value)),
            None => (bare, None),
        };
        if !matches!(flag, "H" | "header" | "b" | "cookie") {
            continue;
        }
        let value = match attached {
            Some(value) => value.to_string(),
            None => it
                .next()
                .ok_or_else(|| format!("粘贴的 curl 在 {token} 处被截断，请重新完整复制"))?
                .clone(),
        };
        if matches!(flag, "b" | "cookie") {
            // `-b @file` 是读文件形态，不是 cookie 串
            if !value.starts_with('@') {
                cookies.push(value);
            }
            continue;
        }
        let Some((header, header_value)) = value.split_once(':') else {
            return Err(format!("curl 里的 {token} 片段缺少冒号分隔：{value}"));
        };
        let header = header.trim();
        let header_value = header_value.trim();
        if header.eq_ignore_ascii_case("cookie") {
            cookies.push(header_value.to_string());
        } else if header.eq_ignore_ascii_case("user-agent") {
            user_agent = Some(header_value.to_string());
        }
    }
    Ok((
        (!cookies.is_empty()).then(|| cookies.join("; ")),
        user_agent,
    ))
}

/// 合并续行为单行，支持 bash 的 `\` 与 cmd 的 `^` 两种行尾续行。
/// 先把 CR / CRLF 统一成 LF 再按行处理——这样任何换行符都只可能变成词间空格，
/// **头注入（CRLF  smuggle）在结构上不成立**，而不是靠下游校验器碰巧拦住。
///
/// **续行处必须补空格**：不补的话前一行收尾引号会和下一行的 `-H` 粘成同一个 token，
/// 后面的头全部静默丢失（实测踩过，症状和本次 401 一样查不出来）。
fn join_continuations(text: &str) -> String {
    let unified = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut joined = String::with_capacity(text.len());
    for line in unified.lines() {
        let mut line = line.trim_end();
        if line.ends_with('^') || line.ends_with('\\') {
            line = line[..line.len() - 1].trim_end();
        }
        joined.push_str(line);
        joined.push(' ');
    }
    joined
}

/// `Cookie: a=1; b=2` / `session=..; session_2=..` → cookie 串本体。
/// 前缀比较走 `get(..7)`：粘贴是任意用户文本，直接 `text[..7]` 会在非 ASCII 开头时
/// 踩到字符边界 panic（中文句子粘贴就是这条路径）
fn cookie_header_body(text: &str) -> Option<&str> {
    if text.get(..7).is_some_and(|head| head.eq_ignore_ascii_case("cookie:")) {
        return Some(text[7..].trim());
    }
    (!text.contains(' ') && text.contains("session=")).then_some(text)
}

/// Cookie 串 → (session, session_2)。同名取首个，其余 cookie 忽略
fn pick_session_pair(cookie_text: &str) -> Result<(String, Option<String>), String> {
    let mut session: Option<String> = None;
    let mut session2: Option<String> = None;
    for part in cookie_text.split(';') {
        let Some((name, value)) = part.trim().split_once('=') else {
            continue;
        };
        let value = value.trim();
        match name.trim() {
            "session" if session.is_none() => session = Some(validate_cookie_value(value)?),
            "session_2" if session2.is_none() => session2 = Some(validate_cookie_value(value)?),
            _ => {}
        }
    }
    session
        .map(|value| (value, session2))
        .ok_or_else(|| NO_SESSION_HINT.to_string())
}

/// RFC 6265 cookie-value 字符集（可见 ASCII，排除空白、`"`、`,`、`;` 与控制符）。
/// 白名单同时挡住 CRLF 头注入——凭据是用户粘贴的外部输入，拼进请求头之前必须先过这关
/// （字符集与 0.9.0 的 validate_session_value、前端 utils.ts 逐字符一致，避免误伤存量值）
fn validate_cookie_value(value: &str) -> Result<String, String> {
    if value.is_empty() {
        return Err("WorkBuddy session Cookie 的值为空".to_string());
    }
    if value.len() > MAX_COOKIE_VALUE_LENGTH {
        return Err("WorkBuddy Cookie 值过长，请确认只粘贴了一条请求".to_string());
    }
    if !value.chars().all(|c| {
        c == '!'
            || ('\u{23}'..='\u{2b}').contains(&c)
            || ('\u{2d}'..='\u{3a}').contains(&c)
            || ('\u{3c}'..='\u{7e}').contains(&c)
    }) {
        return Err("WorkBuddy Cookie 值包含非法字符（不能带空格、引号、分号或控制符）".to_string());
    }
    Ok(value.to_string())
}

/// UA 校验：浏览器 UA 是纯可见 ASCII；挡 CRLF 注入与误粘的整段文本
fn validate_user_agent(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("curl 里的 User-Agent 头为空".to_string());
    }
    if value.len() > MAX_USER_AGENT_LENGTH {
        return Err(format!(
            "User-Agent 过长（{} 字符），请确认粘贴的是一条 workbuddy.cn 请求",
            value.len()
        ));
    }
    if !value.chars().all(|c| ('\u{20}'..='\u{7e}').contains(&c)) {
        return Err("User-Agent 包含非法字符（不能带换行或非 ASCII）".to_string());
    }
    Ok(value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSION: &str = "Ref4V2b0nyljz|1790576618|c3y14nl-u_Xkuv4NDBI1Fuu";
    const SESSION2: &str = "9dpJFQp8g9Q9dd815CTLB1_tROaEw_610tA5Ks9Qp7lz|IcaO1bRMVJzHij6k";
    const URL: &str = "https://www.workbuddy.cn/activity/growth/buddy/travel/status";

    fn parse(raw: &str) -> WorkbuddyCredential {
        parse_workbuddy_credential(raw).unwrap_or_else(|error| panic!("解析失败：{error}"))
    }

    /// 用户实际粘贴的形态：`^` 续行 + CRLF + 单引号
    #[test]
    fn parses_caret_continuation_with_crlf() {
        let pasted = format!(
            "curl -L -X GET '{URL}' ^\r\n-H 'User-Agent: {WORKBUDDY_FALLBACK_UA}' ^\r\n-H 'Accept: application/json, text/plain, */*' ^\r\n-H 'Cookie: session={SESSION}; session_2={SESSION2}'"
        );
        let credential = parse(&pasted);
        assert_eq!(credential.session, SESSION);
        assert_eq!(credential.session2.as_deref(), Some(SESSION2));
        assert_eq!(credential.user_agent.as_deref(), Some(WORKBUDDY_FALLBACK_UA));
        assert_eq!(
            credential.cookie_header(),
            format!("session={SESSION}; session_2={SESSION2}")
        );
    }

    /// DevTools bash 版：`\` 续行 + `--compressed`/`-X` 等白名单外选项必须被忽略而不是报错
    #[test]
    fn parses_bash_continuation_ignoring_unknown_options() {
        let pasted = format!(
            "curl '{URL}' \\\n  -X 'GET' \\\n  -H 'Accept: application/json, text/plain, */*' \\\n  -H 'User-Agent: {WORKBUDDY_FALLBACK_UA}' \\\n  -H 'sec-ch-ua: \"Chromium\";v=\"153\"' \\\n  -H 'Cookie: session={SESSION}; session_2={SESSION2}' \\\n  --compressed"
        );
        let credential = parse(&pasted);
        assert_eq!(credential.session, SESSION);
        assert_eq!(credential.session2.as_deref(), Some(SESSION2));
        assert_eq!(credential.user_agent.as_deref(), Some(WORKBUDDY_FALLBACK_UA));
    }

    /// cmd 版：双引号 + `-b` 传 cookie + `\"` 转义
    #[test]
    fn parses_cmd_quotes_and_b_flag() {
        let pasted = format!(
            "curl \"{URL}\" ^\n  -H \"sec-ch-ua: \\\"Chromium\\\";v=\\\"153\\\"\" ^\n  -H \"User-Agent: {WORKBUDDY_FALLBACK_UA}\" ^\n  -b \"session={SESSION}; session_2={SESSION2}\""
        );
        let credential = parse(&pasted);
        assert_eq!(credential.session, SESSION);
        assert_eq!(credential.session2.as_deref(), Some(SESSION2));
    }

    /// 未知选项排在 -H 之前时，绝不能把后面的 Cookie 一并吃掉
    #[test]
    fn does_not_swallow_header_after_unknown_option() {
        let pasted = format!(
            "curl '{URL}' --http2 --compressed -H 'Cookie: session={SESSION}' -H 'User-Agent: {WORKBUDDY_FALLBACK_UA}'"
        );
        let credential = parse(&pasted);
        assert_eq!(credential.session, SESSION);
        assert_eq!(credential.user_agent.as_deref(), Some(WORKBUDDY_FALLBACK_UA));
    }

    /// POST 带 --data-raw 的 billing 请求形态
    #[test]
    fn parses_post_with_data_raw() {
        let pasted = format!(
            "curl '{URL}' -X 'POST' -H 'Content-Type: application/json' -H 'User-Agent: {WORKBUDDY_FALLBACK_UA}' -H 'Cookie: session={SESSION}' --data-raw '{{\"PageNumber\":1,\"PackageCodes\":[\"TCACA_code_002_AkiJS3ZHF5\"]}}'"
        );
        let credential = parse(&pasted);
        assert_eq!(credential.session, SESSION);
        assert_eq!(credential.session2, None);
        assert_eq!(credential.cookie_header(), format!("session={SESSION}"));
    }

    /// 0.9.0 的填法：整串就是 session 的 Value（无 session_2、UA 走缺省）
    #[test]
    fn parses_legacy_bare_session_value() {
        let credential = parse(SESSION);
        assert_eq!(credential.session, SESSION);
        assert_eq!(credential.session2, None);
        assert_eq!(credential.user_agent, None);
        assert_eq!(credential.user_agent_or_default(), WORKBUDDY_FALLBACK_UA);
    }

    /// 字符集与 0.9.0 的 validate_session_value 逐字符一致——存量凭据不能因为
    /// 这次改动被误判为非法（上限放宽到 65536，session_2 也在同一校验器下）
    #[test]
    fn cookie_value_charset_matches_legacy_validator() {
        for value in [
            "abc123-_=:",
            "YWJj==",
            "Ref4V2b0nyljz|1790576618|c3y14nl-u_X|kuv4NDBI1Fuu",
            &"a".repeat(16_384),
            &"a".repeat(65_536),
        ] {
            assert_eq!(validate_cookie_value(value).as_deref(), Ok(value));
        }
        for value in [
            "", "a b", "a\r\nX: 1", "\"abc\"", "会话值", "a,b", &"a".repeat(65_537),
        ] {
            assert!(validate_cookie_value(value).is_err(), "{value:?} 应当被拒");
        }
    }

    #[test]
    fn parses_bare_cookie_header_in_any_order() {
        let credential = parse(&format!(
            "Cookie: theme=dark; session_2={SESSION2}; session={SESSION}"
        ));
        assert_eq!(credential.session, SESSION);
        assert_eq!(credential.session2.as_deref(), Some(SESSION2));
    }

    #[test]
    fn keeps_base64_padding_in_values() {
        assert_eq!(parse("Cookie: session=YWJj==").session, "YWJj==");
    }

    /// 粘贴被折行截断：报错而不是静默丢头
    #[test]
    fn rejects_truncated_or_malformed_curl() {
        let unclosed = format!("curl '{URL}' -H 'User-Agent: {WORKBUDDY_FALLBACK_UA}");
        assert!(parse_workbuddy_credential(&unclosed)
            .unwrap_err()
            .contains("无法解析"));
        assert!(parse_workbuddy_credential("curl 'https://x' -H 'garbage'")
            .unwrap_err()
            .contains("缺少冒号"));
        assert!(parse_workbuddy_credential("curl 'https://x' -H")
            .unwrap_err()
            .contains("被截断"));
    }

    #[test]
    fn rejects_missing_cookie_and_empty_input() {
        assert!(parse_workbuddy_credential("")
            .unwrap_err()
            .contains("请填写"));
        assert!(parse_workbuddy_credential("curl 'https://www.workbuddy.cn/x' -H 'Accept: */*'")
            .unwrap_err()
            .contains("Cookie"));
        // 有 UA 没 Cookie、有 Cookie 名没值，都要指出来
        assert!(parse_workbuddy_credential(&format!(
            "curl '{URL}' -H 'User-Agent: {WORKBUDDY_FALLBACK_UA}'"
        ))
        .unwrap_err()
        .contains("session"));
    }

    /// 头注入在结构上不成立：换行符（CRLF 与老式 lone CR）都只会被换成词间空格——
    /// Cookie 位上空格本就非法所以必然被拒，UA 位上留下的也是无换行的普通值
    #[test]
    fn rejects_header_injection_attempts() {
        for raw in [
            format!("curl '{URL}' -H 'Cookie: session=abc\r\nX-Injected: 1'"),
            format!("curl '{URL}' -H 'Cookie: session=abc\rX-Injected: 1'"),
        ] {
            assert!(parse_workbuddy_credential(&raw)
                .unwrap_err()
                .contains("非法字符"));
        }

        for template in [
            "curl '{URL}' -H 'Cookie: session={SESSION}' -H 'User-Agent: evil\r\nX: 1'",
            "curl '{URL}' -H 'Cookie: session={SESSION}' -H 'User-Agent: evil\rX: 1'",
        ] {
            let credential = parse(&template.replace("{URL}", URL).replace("{SESSION}", SESSION));
            assert_eq!(credential.user_agent.as_deref(), Some("evil X: 1"));
            assert!(credential.cookie_header().contains(SESSION));
        }

        // 整段中文不会被当成 session Value 蒙混过关；无空格的多字节输入也不能把
        // 前缀比较踩到字符边界（曾 panic 在 text[..7]）
        for raw in ["帮我查一下 workbuddy 的余额", "中文凭据占位"] {
            assert!(parse_workbuddy_credential(raw)
                .unwrap_err()
                .contains("非法字符"));
        }
        // 中文全角冒号的 Cookie 头认不出来，但要给出可执行的报错而不是 panic
        assert!(parse_workbuddy_credential("Cookie：session=abc")
            .unwrap_err()
            .contains("session"));
    }

    #[test]
    fn rejects_oversized_input() {
        let huge = "a".repeat(MAX_PASTE_LENGTH + 1);
        assert!(parse_workbuddy_credential(&huge)
            .unwrap_err()
            .contains("过长"));
        let long_ua = format!(
            "curl '{URL}' -H 'Cookie: session={SESSION}' -H 'User-Agent: {}'",
            "u".repeat(MAX_USER_AGENT_LENGTH + 1)
        );
        assert!(parse_workbuddy_credential(&long_ua)
            .unwrap_err()
            .contains("User-Agent"));
    }

    /// 真实凭据规模（session ~4000 字符 + session_2 ~1900 字符）不被任何上限误伤
    #[test]
    fn accepts_realistic_curl_size() {
        let session = "k".repeat(4_000);
        let second = "s".repeat(1_900);
        let pasted = format!(
            "curl '{URL}' -H 'User-Agent: {WORKBUDDY_FALLBACK_UA}' -H 'Cookie: session={session}; session_2={second}' --compressed"
        );
        let credential = parse(&pasted);
        assert_eq!(credential.session, session);
        assert_eq!(credential.session2, Some(second));
    }
}

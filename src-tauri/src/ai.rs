use crate::error::{AppError, Result};
use crate::AppState;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::State;

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    /// 例如 https://api.openai.com/v1 、 https://api.deepseek.com/v1 、 http://localhost:11434/v1
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    pub model: String,
    #[serde(default)]
    pub temperature: Option<f64>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    /// "openai"（默认，兼容绝大多数服务）| "anthropic"
    #[serde(default)]
    pub api_style: Option<String>,
    #[serde(default)]
    pub extra_headers: Option<HashMap<String, String>>,
    #[serde(default)]
    pub timeout_secs: Option<u64>,
    /// 请求结构化 JSON 时启用 OpenAI-compatible response_format；Anthropic 忽略该字段。
    #[serde(default)]
    pub json_mode: bool,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct AiMessage {
    pub role: String,
    /// 字符串，或多模态数组（用于图片 OCR）
    pub content: serde_json::Value,
}

#[derive(Serialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StreamEvent {
    Delta { text: String },
    Reasoning { text: String },
    Done { finish: String },
    Error { message: String },
}

/// 增量 UTF-8 解码器。
/// SSE 的网络分片会在任意字节位置切断，一个中文字符占 3 字节，
/// 对单个分片调用 from_utf8_lossy 会把半个字符永久变成 U+FFFD。
/// 这里只吐出能完整解码的前缀，残缺字节留到下一个分片。
#[derive(Default)]
pub struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    pub fn push(&mut self, chunk: &[u8]) -> String {
        self.pending.extend_from_slice(chunk);
        let mut out = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(s) => {
                    out.push_str(s);
                    self.pending.clear();
                    break;
                }
                Err(e) => {
                    let ok = e.valid_up_to();
                    if ok > 0 {
                        out.push_str(std::str::from_utf8(&self.pending[..ok]).unwrap_or(""));
                    }
                    match e.error_len() {
                        // 真正非法的字节序列：跳过后继续解析本片剩余内容
                        Some(bad) => {
                            self.pending.drain(..ok + bad);
                        }
                        // 只是被分片切断了：留到下一片再解
                        None => {
                            self.pending.drain(..ok);
                            break;
                        }
                    }
                }
            }
        }
        out
    }
}

fn style_of(cfg: &AiConfig) -> String {
    cfg.api_style
        .clone()
        .unwrap_or_else(|| "openai".into())
        .to_lowercase()
}

fn trim_base(base: &str) -> String {
    base.trim().trim_end_matches('/').to_string()
}

/// 允许用户填 `.../v1` 或直接填完整端点
fn chat_endpoint(cfg: &AiConfig) -> String {
    let b = trim_base(&cfg.base_url);
    if b.ends_with("/chat/completions") || b.ends_with("/messages") || b.ends_with("/completions") {
        return b;
    }
    if style_of(cfg) == "anthropic" {
        format!("{b}/messages")
    } else {
        format!("{b}/chat/completions")
    }
}

fn models_endpoint(cfg: &AiConfig) -> String {
    let mut b = trim_base(&cfg.base_url);
    for suffix in ["/chat/completions", "/messages", "/completions"] {
        if b.ends_with(suffix) {
            b = b[..b.len() - suffix.len()].to_string();
            break;
        }
    }
    format!("{}/models", b.trim_end_matches('/'))
}

fn apply_headers(mut req: reqwest::RequestBuilder, cfg: &AiConfig) -> reqwest::RequestBuilder {
    if style_of(cfg) == "anthropic" {
        if !cfg.api_key.is_empty() {
            req = req.header("x-api-key", cfg.api_key.trim());
        }
        req = req.header("anthropic-version", "2023-06-01");
    } else if !cfg.api_key.is_empty() {
        req = req.header("Authorization", format!("Bearer {}", cfg.api_key.trim()));
    }
    if let Some(extra) = &cfg.extra_headers {
        for (k, v) in extra {
            if !k.trim().is_empty() {
                req = req.header(k.trim(), v.clone());
            }
        }
    }
    req
}

fn build_body(cfg: &AiConfig, messages: &[AiMessage], stream: bool) -> serde_json::Value {
    if style_of(cfg) == "anthropic" {
        let mut system = String::new();
        let mut list = Vec::new();
        for m in messages {
            if m.role == "system" {
                if let Some(s) = m.content.as_str() {
                    if !system.is_empty() {
                        system.push_str("\n\n");
                    }
                    system.push_str(s);
                }
            } else {
                list.push(serde_json::json!({ "role": m.role, "content": m.content }));
            }
        }
        let mut body = serde_json::json!({
            "model": cfg.model,
            "messages": list,
            "max_tokens": cfg.max_tokens.unwrap_or(4096),
            "stream": stream,
        });
        if !system.is_empty() {
            body["system"] = serde_json::json!(system);
        }
        if let Some(t) = cfg.temperature {
            body["temperature"] = serde_json::json!(t);
        }
        body
    } else {
        let list: Vec<serde_json::Value> = messages
            .iter()
            .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
            .collect();
        let mut body = serde_json::json!({
            "model": cfg.model,
            "messages": list,
            "stream": stream,
        });
        if let Some(t) = cfg.temperature {
            body["temperature"] = serde_json::json!(t);
        }
        if let Some(m) = cfg.max_tokens {
            body["max_tokens"] = serde_json::json!(m);
        }
        if cfg.json_mode {
            body["response_format"] = serde_json::json!({ "type": "json_object" });
        }
        body
    }
}

fn client_for(state: &AppState, cfg: &AiConfig) -> reqwest::Client {
    let secs = cfg.timeout_secs.unwrap_or(180).clamp(10, 900);
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(secs))
        .build()
        .unwrap_or_else(|_| state.http.clone())
}

/// 从一条 SSE JSON 中提取正文增量与思维链增量
fn append_text_value(value: Option<&serde_json::Value>, target: &mut String) {
    match value {
        Some(serde_json::Value::String(s)) => target.push_str(s),
        Some(serde_json::Value::Array(parts)) => {
            for part in parts {
                append_text_value(part.get("text").or_else(|| part.get("content")), target);
            }
        }
        Some(serde_json::Value::Object(map)) => {
            append_text_value(map.get("text").or_else(|| map.get("value")), target)
        }
        _ => {}
    }
}

fn extract_delta(style: &str, v: &serde_json::Value) -> (String, String) {
    let mut text = String::new();
    let mut reasoning = String::new();

    if style == "anthropic" {
        append_text_value(v.get("delta").and_then(|d| d.get("text")), &mut text);
        append_text_value(v.get("delta").and_then(|d| d.get("thinking")), &mut reasoning);
        return (text, reasoning);
    }

    if let Some(choices) = v.get("choices").and_then(|c| c.as_array()) {
        for c in choices {
            let node = c.get("delta").or_else(|| c.get("message"));
            if let Some(node) = node {
                append_text_value(node.get("content"), &mut text);
                for key in ["reasoning_content", "reasoning"] {
                    append_text_value(node.get(key), &mut reasoning);
                }
                if let Some(calls) = node.get("tool_calls").and_then(|value| value.as_array()) {
                    for call in calls {
                        append_text_value(
                            call.get("function").and_then(|f| f.get("arguments")),
                            &mut text,
                        );
                    }
                }
                append_text_value(
                    node.get("function_call").and_then(|f| f.get("arguments")),
                    &mut text,
                );
            }
        }
    }
    (text, reasoning)
}

fn extract_completion_text(style: &str, v: &serde_json::Value, prefer_json: bool) -> String {
    if style == "anthropic" {
        let text = v
            .get("content")
            .and_then(|content| content.as_array())
            .map(|parts| {
                parts
                    .iter()
                    .filter_map(|part| part.get("text").and_then(|text| text.as_str()))
                    .collect::<Vec<_>>()
                    .join("")
            })
            .unwrap_or_default();
        if prefer_json {
            if let Some(json) = extract_json_candidate(&text) {
                return json;
            }
        }
        return text;
    }

    let (chat_text, reasoning) = extract_delta(style, v);
    if prefer_json {
        for candidate in [&chat_text, &reasoning] {
            if let Some(json) = extract_json_candidate(candidate) {
                return json;
            }
        }
    }
    if !chat_text.trim().is_empty() {
        return chat_text;
    }
    if let Some(json) = extract_json_candidate(&reasoning) {
        return json;
    }

    let legacy_text = v
        .get("choices")
        .and_then(|choices| choices.as_array())
        .into_iter()
        .flatten()
        .filter_map(|choice| choice.get("text").and_then(|text| text.as_str()))
        .collect::<Vec<_>>()
        .join("");
    if !legacy_text.trim().is_empty() {
        return legacy_text;
    }

    if let Some(output_text) = v.get("output_text").and_then(|text| text.as_str()) {
        if prefer_json {
            if let Some(json) = extract_json_candidate(output_text) {
                return json;
            }
        }
        return output_text.to_string();
    }

    let output = v
        .get("output")
        .and_then(|output| output.as_array())
        .into_iter()
        .flatten()
        .flat_map(|item| {
            item.get("content")
                .and_then(|content| content.as_array())
                .into_iter()
                .flatten()
        })
        .filter_map(|part| part.get("text").and_then(|text| text.as_str()))
        .collect::<Vec<_>>()
        .join("");
    if prefer_json {
        if let Some(json) = extract_json_candidate(&output) {
            return json;
        }
    }
    output
}

fn extract_json_candidate(text: &str) -> Option<String> {
    let boundaries = text.char_indices().collect::<Vec<_>>();
    for (start, _open) in boundaries
        .iter()
        .copied()
        .filter(|(_, ch)| *ch == '{' || *ch == '[')
    {
        for (end, close) in boundaries
            .iter()
            .copied()
            .rev()
            .filter(|(end, ch)| *end >= start && (*ch == '}' || *ch == ']'))
        {
            let candidate = &text[start..end + close.len_utf8()];
            if matches!(
                serde_json::from_str::<serde_json::Value>(candidate),
                Ok(serde_json::Value::Object(_) | serde_json::Value::Array(_))
            ) {
                return Some(candidate.to_string());
            }
        }
    }
    None
}

async fn error_text(resp: reqwest::Response) -> String {
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let detail = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| {
            v.get("error")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .map(|s| s.to_string())
                .or_else(|| v.get("message").and_then(|m| m.as_str()).map(|s| s.to_string()))
        })
        .unwrap_or_else(|| {
            let t = body.trim();
            if t.is_empty() {
                "服务端未返回内容".to_string()
            } else {
                t.chars().take(400).collect()
            }
        });
    format!("HTTP {} — {}", status.as_u16(), detail)
}

// ─────────────────────────── 命令 ───────────────────────────

/// 流式对话；通过 Channel 回传增量
#[tauri::command]
pub async fn ai_chat(
    state: State<'_, AppState>,
    config: AiConfig,
    messages: Vec<AiMessage>,
    request_id: String,
    on_event: Channel<StreamEvent>,
) -> Result<()> {
    let flag = Arc::new(AtomicBool::new(false));
    {
        let mut map = state.cancels.lock().unwrap();
        map.insert(request_id.clone(), flag.clone());
    }
    let cleanup = |state: &AppState, id: &str| {
        let mut map = state.cancels.lock().unwrap();
        map.remove(id);
    };

    let style = style_of(&config);
    let client = client_for(&state, &config);
    let body = build_body(&config, &messages, true);

    let req = apply_headers(
        client
            .post(chat_endpoint(&config))
            .header("Content-Type", "application/json")
            .header("Accept", "text/event-stream"),
        &config,
    )
    .json(&body);

    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            cleanup(&state, &request_id);
            let msg = format!("无法连接到 {}：{}", trim_base(&config.base_url), e);
            let _ = on_event.send(StreamEvent::Error { message: msg.clone() });
            return Err(AppError::msg(msg));
        }
    };

    if !resp.status().is_success() {
        cleanup(&state, &request_id);
        let msg = error_text(resp).await;
        let _ = on_event.send(StreamEvent::Error { message: msg.clone() });
        return Err(AppError::msg(msg));
    }

    let mut stream = resp.bytes_stream();
    let mut decoder = Utf8Stream::default();
    let mut buf = String::new();
    let mut finish = String::from("stop");
    let mut got_any = false;

    while let Some(chunk) = stream.next().await {
        if flag.load(Ordering::Relaxed) {
            finish = "cancelled".into();
            break;
        }
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                cleanup(&state, &request_id);
                let msg = format!("传输中断：{e}");
                let _ = on_event.send(StreamEvent::Error { message: msg.clone() });
                return Err(AppError::msg(msg));
            }
        };
        buf.push_str(&decoder.push(&chunk));

        while let Some(idx) = buf.find('\n') {
            let line = buf[..idx].trim().to_string();
            buf.drain(..idx + 1);
            if line.is_empty() || line.starts_with(':') || line.starts_with("event:") {
                continue;
            }
            let payload = line.strip_prefix("data:").unwrap_or(&line).trim();
            if payload.is_empty() {
                continue;
            }
            if payload == "[DONE]" {
                finish = "stop".into();
                buf.clear();
                break;
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(payload) else {
                continue;
            };
            if let Some(err) = v.get("error") {
                let msg = err
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("服务端返回错误")
                    .to_string();
                cleanup(&state, &request_id);
                let _ = on_event.send(StreamEvent::Error { message: msg.clone() });
                return Err(AppError::msg(msg));
            }
            if let Some(r) = v
                .get("choices")
                .and_then(|c| c.get(0))
                .and_then(|c| c.get("finish_reason"))
                .and_then(|f| f.as_str())
            {
                finish = r.to_string();
            }
            let (text, reasoning) = extract_delta(&style, &v);
            if !reasoning.is_empty() {
                // 只输出思维链、正文为空的响应也算有内容，不能报成「没有返回」
                got_any = true;
                let _ = on_event.send(StreamEvent::Reasoning { text: reasoning });
            }
            if !text.is_empty() {
                got_any = true;
                let _ = on_event.send(StreamEvent::Delta { text });
            }
        }
    }

    cleanup(&state, &request_id);
    if !got_any && finish != "cancelled" {
        let _ = on_event.send(StreamEvent::Error {
            message: "模型没有返回任何内容，请检查模型名称是否正确".into(),
        });
        return Err(AppError::msg("模型没有返回任何内容"));
    }
    let _ = on_event.send(StreamEvent::Done { finish });
    Ok(())
}

#[tauri::command]
pub fn ai_cancel(state: State<'_, AppState>, request_id: String) -> Result<()> {
    let map = state.cancels.lock().unwrap();
    if let Some(f) = map.get(&request_id) {
        f.store(true, Ordering::Relaxed);
    }
    Ok(())
}

/// 一次性补全（用于生成标题、标签等短任务）
#[tauri::command]
pub async fn ai_complete(
    state: State<'_, AppState>,
    config: AiConfig,
    messages: Vec<AiMessage>,
) -> Result<String> {
    let style = style_of(&config);
    let client = client_for(&state, &config);
    let body = build_body(&config, &messages, false);
    let resp = apply_headers(
        client
            .post(chat_endpoint(&config))
            .header("Content-Type", "application/json"),
        &config,
    )
    .json(&body)
    .send()
    .await
    .map_err(|e| AppError::msg(format!("无法连接到服务：{e}")))?;

    if !resp.status().is_success() {
        return Err(AppError::msg(error_text(resp).await));
    }
    let v: serde_json::Value = resp.json().await?;

    let text = extract_completion_text(&style, &v, config.json_mode);
    if text.trim().is_empty() {
        return Err(AppError::msg(
            "模型返回了响应，但其中没有可用正文；请检查兼容服务是否返回 message.content",
        ));
    }
    Ok(text)
}

/// 拉取可用模型列表
#[tauri::command]
pub async fn ai_models(state: State<'_, AppState>, config: AiConfig) -> Result<Vec<String>> {
    let client = client_for(&state, &config);
    let resp = apply_headers(client.get(models_endpoint(&config)), &config)
        .send()
        .await
        .map_err(|e| AppError::msg(format!("无法连接到服务：{e}")))?;
    if !resp.status().is_success() {
        return Err(AppError::msg(error_text(resp).await));
    }
    let v: serde_json::Value = resp.json().await?;
    let arr = v
        .get("data")
        .and_then(|d| d.as_array())
        .cloned()
        .or_else(|| v.get("models").and_then(|d| d.as_array()).cloned())
        .unwrap_or_default();
    let mut out: Vec<String> = arr
        .iter()
        .filter_map(|m| {
            m.get("id")
                .and_then(|i| i.as_str())
                .or_else(|| m.get("name").and_then(|i| i.as_str()))
                .map(|s| s.to_string())
        })
        .collect();
    out.sort();
    out.dedup();
    Ok(out)
}

/// 连通性测试
#[tauri::command]
pub async fn ai_test(state: State<'_, AppState>, config: AiConfig) -> Result<String> {
    let messages = vec![AiMessage {
        role: "user".into(),
        content: serde_json::json!("请只回复两个字：可用"),
    }];
    let mut cfg = config.clone();
    cfg.max_tokens = Some(cfg.max_tokens.unwrap_or(64).min(64));
    cfg.timeout_secs = Some(45);
    let text = ai_complete(state, cfg, messages).await?;
    if text.trim().is_empty() {
        return Err(AppError::msg("连接成功，但模型没有返回内容"));
    }
    Ok(text.trim().chars().take(80).collect())
}

#[cfg(test)]
mod tests {
    use super::{build_body, extract_completion_text, AiConfig, AiMessage, Utf8Stream};

    /// 把一段中文在**每一个**字节位置切开，重组后必须与原文完全一致
    #[test]
    fn utf8_stream_survives_every_split_point() {
        let text = "reunote：这是一段包含中文、emoji 🎨 和符号 —— 的流式内容。";
        let bytes = text.as_bytes();
        for cut in 0..=bytes.len() {
            let mut d = Utf8Stream::default();
            let mut out = String::new();
            out.push_str(&d.push(&bytes[..cut]));
            out.push_str(&d.push(&bytes[cut..]));
            assert_eq!(out, text, "在第 {cut} 字节切开时重组失败");
        }
    }

    #[test]
    fn completion_extracts_openai_content_parts() {
        let response = serde_json::json!({
            "choices": [{
                "message": {
                    "content": [
                        {"type": "output_text", "text": "{\"kind\":"},
                        {"type": "output_text", "text": "\"finish\"}"}
                    ]
                }
            }]
        });
        assert_eq!(
            extract_completion_text("openai", &response, true),
            "{\"kind\":\"finish\"}"
        );
    }

    #[test]
    fn completion_extracts_responses_api_output() {
        let response = serde_json::json!({
            "output": [{
                "type": "message",
                "content": [{"type": "output_text", "text": "{\"kind\":\"finish\"}"}]
            }]
        });
        assert_eq!(
            extract_completion_text("openai", &response, true),
            "{\"kind\":\"finish\"}"
        );
    }

    #[test]
    fn completion_uses_valid_json_from_reasoning_when_final_content_is_empty() {
        let response = serde_json::json!({
            "choices": [{
                "message": {
                    "content": null,
                    "reasoning_content": "分析过程……最终指令：{\"kind\":\"finish\",\"summary\":\"完成\"}"
                }
            }]
        });
        assert_eq!(
            extract_completion_text("openai", &response, true),
            "{\"kind\":\"finish\",\"summary\":\"完成\"}"
        );
    }

    #[test]
    fn completion_prefers_json_in_reasoning_when_content_is_explanatory() {
        let response = serde_json::json!({
            "choices": [{
                "message": {
                    "content": "我已经分析完毕。",
                    "reasoning_content": "内部步骤……{\"kind\":\"finish\",\"summary\":\"完成\"}"
                }
            }]
        });
        assert_eq!(
            extract_completion_text("openai", &response, true),
            "{\"kind\":\"finish\",\"summary\":\"完成\"}"
        );
    }

    #[test]
    fn completion_extracts_tool_call_arguments_for_json_mode() {
        let response = serde_json::json!({
            "choices": [{
                "message": {
                    "content": null,
                    "tool_calls": [{
                        "function": {"arguments": "{\"kind\":\"finish\",\"summary\":\"完成\"}"}
                    }]
                }
            }]
        });
        assert_eq!(
            extract_completion_text("openai", &response, true),
            "{\"kind\":\"finish\",\"summary\":\"完成\"}"
        );
    }

    #[test]
    fn json_mode_adds_openai_response_format_without_affecting_messages() {
        let config = AiConfig {
            base_url: "http://localhost/v1".into(),
            api_key: String::new(),
            model: "test".into(),
            temperature: None,
            max_tokens: Some(100),
            api_style: Some("openai".into()),
            extra_headers: None,
            timeout_secs: None,
            json_mode: true,
        };
        let body = build_body(
            &config,
            &[AiMessage {
                role: "user".into(),
                content: serde_json::json!("返回 JSON"),
            }],
            false,
        );
        assert_eq!(body["response_format"]["type"], "json_object");
        assert_eq!(body["messages"][0]["content"], "返回 JSON");
    }

    /// 逐字节喂入（最极端的分片）也必须无损
    #[test]
    fn utf8_stream_byte_by_byte() {
        let text = "中文测试🎨末尾";
        let mut d = Utf8Stream::default();
        let mut out = String::new();
        for b in text.as_bytes() {
            out.push_str(&d.push(&[*b]));
        }
        assert_eq!(out, text);
    }

    /// 旧实现的反例：对分片直接 from_utf8_lossy 会产生替换字符
    #[test]
    fn old_lossy_approach_would_corrupt() {
        let text = "中文";
        let bytes = text.as_bytes();
        let naive = format!(
            "{}{}",
            String::from_utf8_lossy(&bytes[..2]),
            String::from_utf8_lossy(&bytes[2..])
        );
        assert!(naive.contains('\u{FFFD}'), "该反例应当损坏，用于证明修复的必要性");

        let mut d = Utf8Stream::default();
        let fixed = format!("{}{}", d.push(&bytes[..2]), d.push(&bytes[2..]));
        assert_eq!(fixed, text);
    }

    /// 非法字节序列不能让解码器卡死
    #[test]
    fn utf8_stream_skips_invalid_bytes() {
        let mut d = Utf8Stream::default();
        let out = d.push(&[0xFF, 0xFE, b'o', b'k']);
        assert!(out.ends_with("ok"), "非法字节之后的合法内容应当继续输出，实际得到 {out:?}");
    }
}

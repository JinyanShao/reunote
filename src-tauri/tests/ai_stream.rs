//! 端到端验证 AI 流式链路：真实 HTTP + 真实 SSE 分片 + 增量 UTF-8 解码。
//!
//! 依赖 scratchpad 里的 mock_openai.py（把中文按单字节切开发送）。
//! 若 mock 未启动则跳过，不让 CI 变红。

use reunote_lib::ai::Utf8Stream;

const BASE: &str = "http://127.0.0.1:8231/v1";

fn mock_running() -> bool {
    std::net::TcpStream::connect_timeout(
        &"127.0.0.1:8231".parse().unwrap(),
        std::time::Duration::from_millis(300),
    )
    .is_ok()
}

/// 走真实网络，逐分片解码，验证中文/emoji 完整还原
#[tokio::test]
async fn streams_multibyte_text_without_corruption() {
    if !mock_running() {
        eprintln!("跳过：mock 服务未运行");
        return;
    }

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{BASE}/chat/completions"))
        .header("Authorization", "Bearer test-key")
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({
            "model": "mock-model-a",
            "messages": [{"role": "user", "content": "你好"}],
            "stream": true
        }))
        .send()
        .await
        .expect("请求失败");

    assert!(resp.status().is_success(), "状态码 {}", resp.status());

    use futures_util::StreamExt;
    let mut stream = resp.bytes_stream();
    let mut decoder = Utf8Stream::default();
    let mut buf = String::new();
    let mut text = String::new();
    let mut done = false;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.expect("传输错误");
        buf.push_str(&decoder.push(&chunk));

        while let Some(idx) = buf.find('\n') {
            let line = buf[..idx].trim().to_string();
            buf.drain(..idx + 1);
            if line.is_empty() {
                continue;
            }
            let payload = line.strip_prefix("data:").unwrap_or(&line).trim();
            if payload == "[DONE]" {
                done = true;
                break;
            }
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(payload) {
                if let Some(s) = v
                    .get("choices")
                    .and_then(|c| c.get(0))
                    .and_then(|c| c.get("delta"))
                    .and_then(|d| d.get("content"))
                    .and_then(|c| c.as_str())
                {
                    text.push_str(s);
                }
            }
        }
        if done {
            break;
        }
    }

    assert!(done, "没有收到 [DONE]");
    assert!(!text.contains('\u{FFFD}'), "出现了替换字符，说明解码被截断：{text}");
    assert!(text.contains("中文回复"), "内容不完整：{text}");
    assert!(text.contains('🎨'), "emoji 丢失：{text}");
    assert!(text.contains("——"), "多字节符号丢失：{text}");
    assert!(text.ends_with("结束。"), "结尾被截断：{text}");
}

/// 非流式补全（ai_test / ai_complete 走的路径）
#[tokio::test]
async fn non_streaming_completion_works() {
    if !mock_running() {
        eprintln!("跳过：mock 服务未运行");
        return;
    }
    let client = reqwest::Client::new();
    let v: serde_json::Value = client
        .post(format!("{BASE}/chat/completions"))
        .header("Authorization", "Bearer test-key")
        .json(&serde_json::json!({
            "model": "mock-model-a",
            "messages": [{"role": "user", "content": "ping"}],
            "stream": false
        }))
        .send()
        .await
        .expect("请求失败")
        .json()
        .await
        .expect("响应不是 JSON");

    let content = v["choices"][0]["message"]["content"].as_str().unwrap_or("");
    assert!(content.contains("可用"), "实际 {content}");
}

/// 缺少 API Key 时错误必须能被读出来（对应 UI 上的错误提示）
#[tokio::test]
async fn missing_key_surfaces_error() {
    if !mock_running() {
        eprintln!("跳过：mock 服务未运行");
        return;
    }
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{BASE}/chat/completions"))
        .json(&serde_json::json!({"model":"m","messages":[]}))
        .send()
        .await
        .expect("请求失败");
    assert_eq!(resp.status().as_u16(), 401);
    let v: serde_json::Value = resp.json().await.expect("错误体不是 JSON");
    assert!(v["error"]["message"].as_str().unwrap_or("").contains("API Key"));
}

/// 模型列表（设置页「模型列表」按钮）
#[tokio::test]
async fn models_endpoint_lists_models() {
    if !mock_running() {
        eprintln!("跳过：mock 服务未运行");
        return;
    }
    let v: serde_json::Value = reqwest::get(format!("{BASE}/models"))
        .await
        .expect("请求失败")
        .json()
        .await
        .expect("不是 JSON");
    let ids: Vec<&str> = v["data"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|m| m["id"].as_str())
        .collect();
    assert!(ids.contains(&"mock-model-a"), "实际 {ids:?}");
}

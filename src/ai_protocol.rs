//! Adapters between the study agent's canonical messages and four wire protocols.
use crate::ai::ModelConfig;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Protocol {
    #[default]
    ChatCompletions,
    Responses,
    Anthropic,
    Gemini,
}
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct Options {
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub max_output_tokens: Option<u32>,
    pub supports_images: Option<bool>,
    pub reasoning_effort: Option<String>,
}
impl Options {
    pub fn validate(&self, p: Protocol) -> Result<(), String> {
        let tmax = if p == Protocol::Anthropic { 1.0 } else { 2.0 };
        if self
            .temperature
            .is_some_and(|v| !v.is_finite() || !(0.0..=tmax).contains(&v))
        {
            return Err(format!("温度需在 0–{tmax} 之间"));
        }
        if self
            .top_p
            .is_some_and(|v| !v.is_finite() || v <= 0.0 || v > 1.0)
        {
            return Err("Top P 需大于 0 且不超过 1".into());
        }
        if self.temperature.is_some() && self.top_p.is_some() {
            return Err("温度和 Top P 请选择一个设置，另一个留空".into());
        }
        if self
            .max_output_tokens
            .is_some_and(|v| !(128..=131072).contains(&v))
        {
            return Err("输出上限需为 128–131072 tokens；实际限制以模型为准".into());
        }
        if let Some(e) = &self.reasoning_effort {
            if p != Protocol::Responses || !["low", "medium", "high"].contains(&e.as_str()) {
                return Err("推理等级仅用于支持它的 Responses 模型".into());
            }
        }
        if self.reasoning_effort.is_some() && (self.temperature.is_some() || self.top_p.is_some()) {
            return Err("设置推理等级时请将采样参数留空，使用模型默认值".into());
        }
        Ok(())
    }
}
fn parts(m: &Value) -> Vec<Value> {
    if let Some(s) = m["content"].as_str() {
        vec![json!({"type":"text","text":s})]
    } else {
        m["content"].as_array().cloned().unwrap_or_default()
    }
}
fn text(m: &Value) -> String {
    parts(m)
        .iter()
        .filter_map(|p| p["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
}
fn image(p: &Value) -> Result<(&str, &str), String> {
    let url = p
        .pointer("/image_url/url")
        .and_then(Value::as_str)
        .ok_or("图片缺少数据")?;
    let (head, data) = url.split_once(',').ok_or("仅支持内嵌图片数据")?;
    let mime = head
        .strip_prefix("data:")
        .and_then(|h| h.strip_suffix(";base64"))
        .ok_or("图片需为 base64 数据")?;
    if !["image/png", "image/jpeg", "image/webp", "image/gif"].contains(&mime) || data.is_empty() {
        return Err("图片格式不受支持".into());
    }
    Ok((mime, data))
}
fn call(id: &str, name: &str, args: Value) -> Value {
    json!({"id":id,"type":"function","function":{"name":name,"arguments":if let Some(s)=args.as_str(){s.to_string()}else{args.to_string()}}})
}
fn wire(m: &Value, p: &str) -> Option<Vec<Value>> {
    if m.pointer("/_wire/protocol").and_then(Value::as_str) == Some(p) {
        m.pointer("/_wire/items").and_then(Value::as_array).cloned()
    } else {
        None
    }
}
fn merge(out: &mut Vec<Value>, role: &str, key: &str, items: Vec<Value>) {
    if let Some(last) = out.last_mut() {
        if last["role"] == role {
            if let Some(a) = last[key].as_array_mut() {
                a.extend(items);
                return;
            }
        }
    }
    out.push(json!({"role":role,key:items}));
}
fn params(body: &mut Value, c: &ModelConfig) {
    let o = &c.options;
    if let Some(v) = o.temperature {
        body["temperature"] = json!(v)
    }
    if let Some(v) = o.top_p {
        body["top_p"] = json!(v)
    }
    if let Some(v) = o.max_output_tokens {
        body[if c.protocol == Protocol::Responses {
            "max_output_tokens"
        } else {
            "max_tokens"
        }] = json!(v)
    }
}
pub fn build(
    c: &ModelConfig,
    messages: &[Value],
    tools: Option<Value>,
) -> Result<(String, Value), String> {
    c.validate()?;
    if c.options.supports_images == Some(false)
        && messages
            .iter()
            .any(|m| parts(m).iter().any(|p| p["type"] == "image_url"))
    {
        return Err("此连接已设为仅文字，请为图片与手写分配支持图片的模型；原稿仍保存在本机".into());
    }
    let root = c.base_url.trim_end_matches('/');
    match c.protocol {
        Protocol::ChatCompletions => {
            let mut body = json!({"model":c.model,"messages":messages,"stream":false});
            if let Some(t) = tools {
                body["tools"] = t;
                body["tool_choice"] = json!("auto")
            }
            params(&mut body, c);
            Ok((format!("{root}/chat/completions"), body))
        }
        Protocol::Responses => {
            let mut input = Vec::new();
            for m in messages {
                let role = m["role"].as_str().unwrap_or("user");
                if role == "assistant" {
                    if let Some(items) = wire(m, "responses") {
                        input.extend(items);
                        continue;
                    }
                }
                if role == "tool" {
                    input.push(json!({"type":"function_call_output","call_id":m["tool_call_id"],"output":text(m)}));
                    continue;
                }
                let mut content = Vec::new();
                for p in parts(m) {
                    match p["type"].as_str(){Some("text")=>content.push(json!({"type":if role=="assistant"{"output_text"}else{"input_text"},"text":p["text"]})),Some("image_url")=>{image(&p)?;content.push(json!({"type":"input_image","image_url":p["image_url"]["url"]}))},_=>return Err("不支持的消息类型".into())}
                }
                if !content.is_empty() {
                    input.push(json!({"role":role,"content":content}))
                }
                if let Some(calls) = m["tool_calls"].as_array() {
                    for t in calls {
                        input.push(json!({"type":"function_call","call_id":t["id"],"name":t["function"]["name"],"arguments":t["function"]["arguments"]}))
                    }
                }
            }
            let mut body = json!({"model":c.model,"input":input,"store":false,"stream":false,"include":["reasoning.encrypted_content"]});
            if let Some(t) = tools {
                body["tools"] = json!(t
                    .as_array()
                    .ok_or("工具格式错误")?
                    .iter()
                    .map(|t| {
                        let mut f = t["function"].clone();
                        f["type"] = json!("function");
                        f["strict"] = json!(false);
                        f
                    })
                    .collect::<Vec<_>>());
                body["tool_choice"] = json!("auto")
            }
            params(&mut body, c);
            if let Some(e) = &c.options.reasoning_effort {
                body["reasoning"] = json!({"effort":e})
            }
            Ok((format!("{root}/responses"), body))
        }
        Protocol::Anthropic => {
            let mut system = Vec::new();
            let mut out = Vec::new();
            for m in messages {
                let role = m["role"].as_str().unwrap_or("user");
                if role == "system" {
                    system.push(json!({"type":"text","text":text(m)}));
                    continue;
                }
                if role == "assistant" {
                    if let Some(items) = wire(m, "anthropic") {
                        merge(&mut out, "assistant", "content", items);
                        continue;
                    }
                }
                if role == "tool" {
                    merge(
                        &mut out,
                        "user",
                        "content",
                        vec![
                            json!({"type":"tool_result","tool_use_id":m["tool_call_id"],"content":text(m)}),
                        ],
                    );
                    continue;
                }
                let mut content = Vec::new();
                for p in parts(m) {
                    match p["type"].as_str() {
                        Some("text") => {
                            if p["text"].as_str().is_some_and(|t| !t.is_empty()) {
                                content.push(p)
                            }
                        }
                        Some("image_url") => {
                            let (mime, data) = image(&p)?;
                            content.push(json!({"type":"image","source":{"type":"base64","media_type":mime,"data":data}}))
                        }
                        _ => return Err("不支持的消息类型".into()),
                    }
                }
                if let Some(calls) = m["tool_calls"].as_array() {
                    for t in calls {
                        let args = serde_json::from_str::<Value>(
                            t["function"]["arguments"].as_str().unwrap_or("{}"),
                        )
                        .map_err(|_| "工具参数无效")?;
                        content.push(json!({"type":"tool_use","id":t["id"],"name":t["function"]["name"],"input":args}))
                    }
                }
                if !content.is_empty() {
                    merge(&mut out, role, "content", content)
                }
            }
            let mut body = json!({"model":c.model,"system":system,"messages":out,"max_tokens":c.options.max_output_tokens.unwrap_or(4096),"stream":false});
            if let Some(t) = tools {
                body["tools"]=json!(t.as_array().ok_or("工具格式错误")?.iter().map(|t|json!({"name":t["function"]["name"],"description":t["function"]["description"],"input_schema":t["function"]["parameters"]})).collect::<Vec<_>>());
                body["tool_choice"] = json!({"type":"auto"})
            }
            params(&mut body, c);
            Ok((format!("{root}/messages"), body))
        }
        Protocol::Gemini => {
            let mut system = Vec::new();
            let mut out = Vec::new();
            let mut names = HashMap::new();
            for m in messages {
                let role = m["role"].as_str().unwrap_or("user");
                if role == "system" {
                    system.push(json!({"text":text(m)}));
                    continue;
                }
                if let Some(calls) = m["tool_calls"].as_array() {
                    for t in calls {
                        names.insert(
                            t["id"].as_str().unwrap_or("").to_string(),
                            t["function"]["name"].as_str().unwrap_or("").to_string(),
                        );
                    }
                }
                if role == "assistant" {
                    if let Some(items) = wire(m, "gemini") {
                        merge(&mut out, "model", "parts", items);
                        continue;
                    }
                }
                if role == "tool" {
                    let id = m["tool_call_id"].as_str().ok_or("缺少工具调用编号")?;
                    let name = names.get(id).ok_or("缺少工具名称")?;
                    let value = serde_json::from_str::<Value>(&text(m))
                        .unwrap_or_else(|_| json!({"result":text(m)}));
                    let mut response = json!({"name":name,"response":if value.is_object(){value}else{json!({"result":value})}});
                    // Only echo provider-issued ids, not ids generated locally for older Gemini models.
                    if !id.starts_with("local_gemini_") {
                        response["id"] = json!(id)
                    }
                    merge(
                        &mut out,
                        "user",
                        "parts",
                        vec![json!({"functionResponse":response})],
                    );
                    continue;
                }
                let mut content = Vec::new();
                for p in parts(m) {
                    match p["type"].as_str() {
                        Some("text") => content.push(json!({"text":p["text"]})),
                        Some("image_url") => {
                            let (mime, data) = image(&p)?;
                            content.push(json!({"inlineData":{"mimeType":mime,"data":data}}))
                        }
                        _ => return Err("不支持的消息类型".into()),
                    }
                }
                if let Some(calls) = m["tool_calls"].as_array() {
                    for t in calls {
                        let args = serde_json::from_str::<Value>(
                            t["function"]["arguments"].as_str().unwrap_or("{}"),
                        )
                        .map_err(|_| "工具参数无效")?;
                        content.push(
                            json!({"functionCall":{"name":t["function"]["name"],"args":args}}),
                        )
                    }
                }
                if !content.is_empty() {
                    merge(
                        &mut out,
                        if role == "assistant" { "model" } else { "user" },
                        "parts",
                        content,
                    )
                }
            }
            let mut body = json!({"contents":out});
            if !system.is_empty() {
                body["systemInstruction"] = json!({"parts":system})
            }
            if let Some(t) = tools {
                let mut functions = t
                    .as_array()
                    .ok_or("工具格式错误")?
                    .iter()
                    .map(|t| t["function"].clone())
                    .collect::<Vec<_>>();
                fn clean(v: &mut Value) {
                    match v {
                        Value::Object(o) => {
                            o.remove("additionalProperties");
                            o.remove("$schema");
                            for v in o.values_mut() {
                                clean(v)
                            }
                        }
                        Value::Array(a) => {
                            for v in a {
                                clean(v)
                            }
                        }
                        _ => {}
                    }
                }
                for f in &mut functions {
                    clean(f)
                }
                body["tools"] = json!([{"functionDeclarations":functions}]);
                body["toolConfig"] = json!({"functionCallingConfig":{"mode":"AUTO"}})
            }
            let mut generation = json!({});
            if let Some(v) = c.options.temperature {
                generation["temperature"] = json!(v)
            }
            if let Some(v) = c.options.top_p {
                generation["topP"] = json!(v)
            }
            if let Some(v) = c.options.max_output_tokens {
                generation["maxOutputTokens"] = json!(v)
            }
            if generation.as_object().is_some_and(|o| !o.is_empty()) {
                body["generationConfig"] = generation
            }
            let model = c.model.strip_prefix("models/").unwrap_or(&c.model);
            if model.is_empty()
                || !model
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || "-._".contains(ch))
            {
                return Err("Gemini 模型 ID 格式不正确，请填写模型名称或 models/名称".into());
            }
            Ok((format!("{root}/models/{model}:generateContent"), body))
        }
    }
}
pub fn authenticate(request: reqwest::RequestBuilder, c: &ModelConfig) -> reqwest::RequestBuilder {
    let request = if c.protocol == Protocol::Anthropic {
        request.header("anthropic-version", "2023-06-01")
    } else {
        request
    };
    if c.api_key.is_empty() {
        return request;
    }
    match c.protocol {
        Protocol::Anthropic => request.header("x-api-key", &c.api_key),
        Protocol::Gemini => request.header("x-goog-api-key", &c.api_key),
        _ => request.bearer_auth(&c.api_key),
    }
}
pub fn parse(p: Protocol, v: &Value) -> Result<Value, String> {
    let mut calls = Vec::new();
    let mut texts = Vec::new();
    let (tag, items) = match p {
        Protocol::ChatCompletions => {
            if matches!(
                v.pointer("/choices/0/finish_reason")
                    .and_then(Value::as_str),
                Some("length" | "content_filter")
            ) {
                return Err("模型输出被截断或过滤，请调整输出上限或重试".into());
            }
            return v
                .pointer("/choices/0/message")
                .cloned()
                .ok_or_else(|| "没有找到 Chat Completions 回答，请检查接口协议".into());
        }
        Protocol::Responses => {
            if v["status"].as_str().is_some_and(|s| s != "completed") {
                return Err("Responses 请求未完成，请检查模型状态或输出上限后重试".into());
            }
            let items = v["output"]
                .as_array()
                .ok_or("没有找到 Responses output，请检查接口协议")?
                .clone();
            for i in &items {
                match i["type"].as_str() {
                    Some("message") => {
                        if let Some(content) = i["content"].as_array() {
                            for part in content {
                                if part["type"] == "output_text" {
                                    if let Some(t) = part["text"].as_str() {
                                        texts.push(t.to_string())
                                    }
                                } else if part["type"] == "refusal" {
                                    return Err("模型拒绝了本次请求".into());
                                }
                            }
                        }
                    }
                    Some("function_call") => {
                        let id = i["call_id"].as_str().ok_or("工具调用缺少 call_id")?;
                        calls.push(call(
                            id,
                            i["name"].as_str().ok_or("工具调用缺少名称")?,
                            i["arguments"].clone(),
                        ));
                    }
                    _ => {}
                }
            }
            ("responses", items)
        }
        Protocol::Anthropic => {
            if matches!(
                v["stop_reason"].as_str(),
                Some("max_tokens" | "refusal" | "pause_turn")
            ) {
                return Err("模型输出未完整结束，请调整输出上限或重试".into());
            }
            let items = v["content"]
                .as_array()
                .ok_or("没有找到 Anthropic content，请检查接口协议")?
                .clone();
            for i in &items {
                match i["type"].as_str() {
                    Some("text") => {
                        if let Some(t) = i["text"].as_str() {
                            texts.push(t.to_string())
                        }
                    }
                    Some("tool_use") => calls.push(call(
                        i["id"].as_str().ok_or("工具调用缺少编号")?,
                        i["name"].as_str().ok_or("工具调用缺少名称")?,
                        i["input"].clone(),
                    )),
                    _ => {}
                }
            }
            ("anthropic", items)
        }
        Protocol::Gemini => {
            let candidate = v
                .pointer("/candidates/0")
                .ok_or("Gemini 没有返回候选回答，可能被服务过滤")?;
            if candidate["finishReason"]
                .as_str()
                .is_some_and(|s| s != "STOP")
            {
                return Err(format!(
                    "Gemini 未完整返回：{}，请调整配置或重试",
                    candidate["finishReason"]
                ));
            }
            let items = candidate
                .pointer("/content/parts")
                .and_then(Value::as_array)
                .ok_or("Gemini 回答缺少 parts")?
                .clone();
            for (n, i) in items.iter().enumerate() {
                if i["thought"] != true {
                    if let Some(t) = i["text"].as_str() {
                        texts.push(t.to_string())
                    }
                }
                if let Some(f) = i.get("functionCall") {
                    let local = format!("local_gemini_{n}");
                    calls.push(call(
                        f["id"].as_str().unwrap_or(&local),
                        f["name"].as_str().ok_or("工具调用缺少名称")?,
                        f.get("args").cloned().unwrap_or(json!({})),
                    ))
                }
            }
            ("gemini", items)
        }
    };
    if texts.is_empty() && calls.is_empty() {
        return Err("模型没有返回文字或工具调用，请检查模型与接口协议".into());
    }
    let mut msg = json!({"role":"assistant","content":texts.join("\n"),"_wire":{"protocol":tag,"items":items}});
    if !calls.is_empty() {
        msg["tool_calls"] = json!(calls)
    }
    Ok(msg)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn cfg(p: Protocol) -> ModelConfig {
        ModelConfig {
            base_url: "https://fixture.test/v1".into(),
            model: "sample-model".into(),
            protocol: p,
            ..Default::default()
        }
    }
    fn tools() -> Value {
        json!([{"type":"function","function":{"name":"lookup","description":"lookup","parameters":{"type":"object","properties":{"q":{"type":"string"}},"required":["q"],"additionalProperties":false}}}])
    }
    fn messages() -> Vec<Value> {
        vec![
            json!({"role":"system","content":"rules"}),
            json!({"role":"user","content":[{"type":"text","text":"question"},{"type":"image_url","image_url":{"url":"data:image/png;base64,YWJj"}}]}),
        ]
    }
    #[test]
    fn builds_all_protocols_and_images() {
        for p in [
            Protocol::ChatCompletions,
            Protocol::Responses,
            Protocol::Anthropic,
            Protocol::Gemini,
        ] {
            let (url, b) = build(&cfg(p), &messages(), Some(tools())).unwrap();
            match p {
                Protocol::ChatCompletions => {
                    assert!(url.ends_with("/chat/completions"));
                    assert_eq!(
                        b["messages"][1]["content"][1]["image_url"]["url"],
                        "data:image/png;base64,YWJj"
                    )
                }
                Protocol::Responses => {
                    assert!(url.ends_with("/responses"));
                    assert_eq!(b["input"][1]["content"][1]["type"], "input_image");
                    assert_eq!(b["tools"][0]["name"], "lookup");
                    assert_eq!(b["store"], false)
                }
                Protocol::Anthropic => {
                    assert!(url.ends_with("/messages"));
                    assert_eq!(b["messages"][0]["content"][1]["source"]["data"], "YWJj");
                    assert_eq!(b["max_tokens"], 4096)
                }
                Protocol::Gemini => {
                    assert!(url.ends_with("/models/sample-model:generateContent"));
                    assert_eq!(b["contents"][0]["parts"][1]["inlineData"]["data"], "YWJj");
                    assert!(b["tools"][0]["functionDeclarations"][0]["parameters"]
                        .get("additionalProperties")
                        .is_none())
                }
            }
        }
    }
    #[test]
    fn responses_preserves_reasoning_and_call_identity() {
        let output = json!({"status":"completed","output":[{"type":"reasoning","id":"rs-1","encrypted_content":"opaque"},{"type":"function_call","id":"fc-1","call_id":"call-1","name":"lookup","arguments":"{\"q\":\"x\"}"}]});
        let m = parse(Protocol::Responses, &output).unwrap();
        let mut input = messages();
        input.push(m);
        input.push(json!({"role":"tool","tool_call_id":"call-1","content":"{\"ok\":true}"}));
        let (_, b) = build(&cfg(Protocol::Responses), &input, Some(tools())).unwrap();
        assert_eq!(b["input"][2]["encrypted_content"], "opaque");
        assert_eq!(b["input"][3]["call_id"], "call-1");
        assert_eq!(b["input"][4]["type"], "function_call_output");
        assert_eq!(b["input"][4]["call_id"], "call-1")
    }
    #[test]
    fn anthropic_preserves_signed_blocks_and_merges_results() {
        let m=parse(Protocol::Anthropic,&json!({"stop_reason":"tool_use","content":[{"type":"thinking","thinking":"hidden","signature":"signed"},{"type":"tool_use","id":"t1","name":"lookup","input":{"q":"x"}},{"type":"tool_use","id":"t2","name":"lookup","input":{"q":"y"}}]})).unwrap();
        let mut input = messages();
        input.push(m);
        for id in ["t1", "t2"] {
            input.push(json!({"role":"tool","tool_call_id":id,"content":"{}"}))
        }
        let (_, b) = build(&cfg(Protocol::Anthropic), &input, Some(tools())).unwrap();
        assert_eq!(b["messages"][1]["content"][0]["signature"], "signed");
        assert_eq!(b["messages"][2]["content"].as_array().unwrap().len(), 2);
        assert_eq!(b["messages"][2]["content"][1]["tool_use_id"], "t2")
    }
    #[test]
    fn gemini_preserves_thought_signature_and_issued_ids() {
        let m=parse(Protocol::Gemini,&json!({"candidates":[{"finishReason":"STOP","content":{"parts":[{"thought":true,"text":"hidden"},{"functionCall":{"id":"g1","name":"lookup","args":{"q":"x"}},"thoughtSignature":"signed"}]}}]})).unwrap();
        assert_eq!(m["content"], "");
        let mut input = messages();
        input.push(m);
        input.push(json!({"role":"tool","tool_call_id":"g1","content":"{\"ok\":true}"}));
        let (_, b) = build(&cfg(Protocol::Gemini), &input, Some(tools())).unwrap();
        assert_eq!(b["contents"][1]["parts"][1]["thoughtSignature"], "signed");
        assert_eq!(b["contents"][2]["parts"][0]["functionResponse"]["id"], "g1");
        assert_eq!(
            b["contents"][2]["parts"][0]["functionResponse"]["name"],
            "lookup"
        )
    }
    #[test]
    fn parses_text_and_rejects_partial_output() {
        assert_eq!(parse(Protocol::Responses,&json!({"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}]})).unwrap()["content"],"ok");
        assert!(parse(
            Protocol::Responses,
            &json!({"status":"incomplete","output":[]})
        )
        .is_err());
        assert!(parse(
            Protocol::Anthropic,
            &json!({"stop_reason":"max_tokens","content":[]})
        )
        .is_err());
        assert!(parse(
            Protocol::Gemini,
            &json!({"candidates":[{"finishReason":"MAX_TOKENS"}]})
        )
        .is_err());
        assert!(parse(
            Protocol::ChatCompletions,
            &json!({"choices":[{"finish_reason":"length","message":{"content":"partial"}}]})
        )
        .is_err())
    }
    #[test]
    fn text_only_prevents_image_transmission() {
        let mut c = cfg(Protocol::Gemini);
        c.options.supports_images = Some(false);
        assert!(build(&c, &messages(), None).is_err());
        c.options.supports_images = None;
        c.model = "../escape".into();
        assert!(build(&c, &messages(), None).is_err())
    }
    #[test]
    fn optional_parameters_are_not_sent_by_default() {
        let (_, b) = build(&cfg(Protocol::ChatCompletions), &messages(), None).unwrap();
        assert!(b.get("temperature").is_none());
        assert!(b.get("max_tokens").is_none());
        let mut c = cfg(Protocol::Responses);
        c.options.reasoning_effort = Some("high".into());
        c.options.max_output_tokens = Some(5000);
        let (_, b) = build(&c, &messages(), None).unwrap();
        assert_eq!(b["reasoning"]["effort"], "high");
        assert_eq!(b["max_output_tokens"], 5000);
        c.options.temperature = Some(1.0);
        assert!(build(&c, &messages(), None).is_err())
    }
}

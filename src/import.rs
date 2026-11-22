use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
pub struct ImportRequest {
    pub title: String,
    pub content: String,
    pub format: String,
}
pub struct ImportedLesson {
    pub title: String,
    pub content: String,
    pub source: String,
}

pub fn parse(req: &ImportRequest) -> Result<Vec<ImportedLesson>, String> {
    if req.content.trim().is_empty() {
        return Err("请添加课程内容".into());
    }
    if req.content.chars().count() > 500_000 {
        return Err("首版每次最多导入 50 万字，请按课程分批导入".into());
    }
    let lessons = if req.format == "course2md" {
        let value: Value = serde_json::from_str(&req.content).map_err(|_| "JSON 格式不正确")?;
        let doc = value.get("document").unwrap_or(&value);
        let sections = doc
            .get("sections")
            .and_then(Value::as_array)
            .ok_or("缺少 sections：请选择 course2md 的 document.json")?;
        let mut result = Vec::new();
        for (i, section) in sections.iter().enumerate() {
            let t = section
                .get("t")
                .and_then(Value::as_f64)
                .unwrap_or(0.0)
                .max(0.0) as u64;
            let label = format!("{:02}:{:02}", t / 60, t % 60);
            let text = section
                .get("speech")
                .and_then(Value::as_array)
                .map(|s| {
                    s.iter()
                        .filter_map(|e| e.get("text").and_then(Value::as_str))
                        .collect::<Vec<_>>()
                        .join("\n\n")
                })
                .unwrap_or_default();
            if text.trim().is_empty() {
                continue;
            }
            result.push(ImportedLesson {
                title: format!("第 {} 节 · {}", i + 1, label),
                content: text,
                source: format!("course2md · {}", label),
            });
        }
        result
    } else if req.format == "markdown" || req.format == "text" {
        split_markdown(&req.title, &req.content)
    } else {
        return Err("仅支持 Markdown、文本和 course2md JSON".into());
    };
    if lessons.is_empty() {
        return Err("没有找到可以导入的文字内容".into());
    }
    if lessons.len() > 300 {
        return Err("单门课程最多 300 节，请拆分后导入".into());
    }
    Ok(lessons)
}

fn split_markdown(title: &str, text: &str) -> Vec<ImportedLesson> {
    let mut out = Vec::new();
    let mut name = title.to_string();
    let mut buf = String::new();
    let mut fence: Option<(char, usize)> = None;
    for line in text.lines() {
        let trimmed = line.trim_start();
        let marker = trimmed.chars().next().filter(|c| *c == '`' || *c == '~');
        let count = marker
            .map(|c| trimmed.chars().take_while(|v| *v == c).count())
            .unwrap_or(0);
        let fenced = fence.is_some();
        if let Some(marker) = marker {
            if count >= 3 {
                match fence {
                    None => fence = Some((marker, count)),
                    Some((old, n)) if old == marker && count >= n => fence = None,
                    _ => {}
                }
            }
        }
        if !fenced && fence.is_none() {
            if let Some(heading) = line.strip_prefix("## ").or_else(|| line.strip_prefix("# ")) {
                if !buf.trim().is_empty() {
                    out.push(ImportedLesson {
                        title: name.clone(),
                        content: buf.trim().to_string(),
                        source: String::new(),
                    });
                    buf.clear();
                }
                name = heading.trim().to_string();
            }
        }
        buf.push_str(line);
        buf.push('\n');
    }
    if !buf.trim().is_empty() {
        out.push(ImportedLesson {
            title: name,
            content: buf.trim().to_string(),
            source: String::new(),
        });
    }
    // A document title alone is metadata, not a separate lesson.
    if out.len() > 1 && out[0].content.lines().count() == 1 && out[0].content.starts_with("# ") {
        out.remove(0);
    }
    for (i, l) in out.iter_mut().enumerate() {
        l.source = format!("导入资料 · 第 {} 节", i + 1);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn headings_keep_chinese() {
        let r = parse(&ImportRequest {
            title: "课程".into(),
            content: "# 课程\n\n## 开始\n你好\n## 下一节\n内容".into(),
            format: "markdown".into(),
        })
        .unwrap();
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].title, "开始");
        assert!(r[1].content.contains("内容"));
    }
    #[test]
    fn course2md_uses_timestamp() {
        let r = parse(&ImportRequest {
            title: "课".into(),
            content: r#"{"sections":[{"t":75,"speech":[{"text":"电流"}]}]}"#.into(),
            format: "course2md".into(),
        })
        .unwrap();
        assert_eq!(r[0].source, "course2md · 01:15");
    }
    #[test]
    fn empty_fails() {
        assert!(parse(&ImportRequest {
            title: "课".into(),
            content: " ".into(),
            format: "text".into()
        })
        .is_err());
    }
    #[test]
    fn fenced_headings_are_not_sections() {
        let r = parse(&ImportRequest {
            title: "课".into(),
            content: "# 正文\n内容\n```markdown\n## 代码示例标题\n```\n后续".into(),
            format: "markdown".into(),
        })
        .unwrap();
        assert_eq!(r.len(), 1);
        assert!(r[0].content.contains("代码示例标题"));
    }
}

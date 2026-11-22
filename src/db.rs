use serde::Serialize;
use sqlx::{
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    FromRow, SqlitePool,
};
use std::{path::Path, time::Duration};

pub fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
pub fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[derive(Serialize, FromRow, Clone)]
pub struct Course {
    pub id: String,
    pub title: String,
    pub description: String,
    pub source_kind: String,
    pub created_at: i64,
    pub lesson_count: i64,
    pub read_count: i64,
}
#[derive(Serialize, FromRow, Clone)]
pub struct Lesson {
    pub id: String,
    pub course_id: String,
    pub title: String,
    pub ordinal: i64,
    pub content: String,
    pub source_label: String,
    pub reading_status: String,
}
#[derive(Serialize, FromRow, Clone)]
pub struct Message {
    pub id: String,
    pub lesson_id: String,
    pub role: String,
    pub content: String,
    pub sources: String,
    pub created_at: i64,
}
#[derive(Serialize, FromRow, Clone)]
pub struct Job {
    pub id: String,
    pub lesson_id: String,
    pub kind: String,
    pub status: String,
    pub stage: String,
    pub error: String,
    pub result: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(skip_serializing)]
    pub payload: String,
}
#[derive(FromRow, Clone)]
pub struct Exercise {
    pub id: String,
    pub lesson_id: String,
    pub question: String,
    pub reference_answer: String,
    pub rubric: String,
    pub student_answer: String,
    pub score: Option<i64>,
    pub feedback: String,
    pub status: String,
    pub created_at: i64,
}
impl Exercise {
    pub fn public(&self) -> serde_json::Value {
        serde_json::json!({"id":self.id,"lesson_id":self.lesson_id,"question":self.question,
            "reference_answer":if self.status=="graded" {self.reference_answer.as_str()} else {""},
            "rubric":if self.status=="graded" {self.rubric.as_str()} else {""},
            "student_answer":self.student_answer,"score":self.score,"feedback":self.feedback,
            "status":self.status,"created_at":self.created_at})
    }
}

pub async fn connect(folder: &Path) -> Result<SqlitePool, sqlx::Error> {
    let opts = SqliteConnectOptions::new()
        .filename(folder.join("study.db"))
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .busy_timeout(Duration::from_secs(10));
    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(opts)
        .await?;
    sqlx::raw_sql(include_str!("schema.sql"))
        .execute(&pool)
        .await?;
    crate::connections::migrate(&pool).await?;
    recover(&pool).await?;
    Ok(pool)
}

pub async fn recover(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE learning_plans SET status='interrupted',stage='分析被中断，可从已保存的分段继续',updated_at=? WHERE status IN ('queued','running')")
        .bind(now()).execute(pool).await?;
    sqlx::query("UPDATE video_tasks SET status='interrupted',stage='上次转换被中断，请手动重试',updated_at=? WHERE status IN ('queued','running')")
        .bind(now()).execute(pool).await?;
    sqlx::query("UPDATE jobs SET status='interrupted', stage='等待重试', error='上次运行被中断。已保存资料和输入，请手动重试。', updated_at=? WHERE status IN ('queued','running')")
        .bind(now()).execute(pool).await?;
    Ok(())
}

pub async fn courses(pool: &SqlitePool) -> Result<Vec<Course>, sqlx::Error> {
    sqlx::query_as("SELECT c.*, (SELECT COUNT(*) FROM lessons l WHERE l.course_id=c.id) AS lesson_count, (SELECT COUNT(*) FROM lessons l WHERE l.course_id=c.id AND l.reading_status='read') AS read_count FROM courses c ORDER BY created_at DESC")
        .fetch_all(pool).await
}

pub async fn lesson(pool: &SqlitePool, lesson_id: &str) -> Result<Lesson, sqlx::Error> {
    sqlx::query_as("SELECT * FROM lessons WHERE id=?")
        .bind(lesson_id)
        .fetch_one(pool)
        .await
}

pub async fn exercise(pool: &SqlitePool, exercise_id: &str) -> Result<Exercise, sqlx::Error> {
    sqlx::query_as("SELECT * FROM exercises WHERE id=?")
        .bind(exercise_id)
        .fetch_one(pool)
        .await
}

pub async fn seed(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let existed: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM settings WHERE key='seeded'")
        .fetch_one(pool)
        .await?;
    if existed > 0 {
        return Ok(());
    }
    let cid = id();
    let contents = [
        ("从目标到行动", "# 从目标到行动\n\n欢迎来到你的学习工作台。这是一门用于体验界面的**示例课程**。你也可以导入自己的 Markdown、文本或 course2md 笔记。\n\n## 一个具体的目标\n\n假设我们希望：读懂一节课，并能独立解释其中的核心概念。一个学习 Agent 需要把目标拆成可检查的步骤：\n\n1. 阅读课程材料，确认学习范围。\n2. 解释概念，找出不清楚的地方。\n3. 给出一道针对性的练习。\n4. 等待学生作答，再根据答案提供反馈。\n\n> 看过讲解不等于掌握。学习进度需要和实际作答分别记录。\n\n## 三种不同的职责\n\n| 角色 | 主要职责 | 产出 |\n| --- | --- | --- |\n| 规划者 | 决定下一步做什么 | 学习步骤 |\n| 执行者 | 调用资料和工具 | 讲解或练习 |\n| 调度器 | 管理状态和执行顺序 | 可恢复的任务 |\n\n右侧助教可以解释当前章节、提出练习，并在你作答后提供反馈。首次使用 AI，请先在左下角配置模型接口。"),
        ("让工具返回可检查的结果", "# 让工具返回可检查的结果\n\n工具是 Agent 与资料或环境交互的接口。好的工具需要清楚的输入、输出和失败信息。\n\n## 以课程检索为例\n\n输入包括课程编号和检索关键词；输出应该包含命中的章节、原文片段和来源位置。\n\n```json\n{\n  \"tool\": \"search_course\",\n  \"input\": { \"query\": \"任务状态\" },\n  \"output\": { \"lesson\": \"第三节\", \"excerpt\": \"……\" }\n}\n```\n\n模型可以根据这些资料解释内容，读者也能回到原文检查。\n\n## 工具调用与文字回答\n\n“我查过资料了”是一句话；实际的检索结果才是依据。工具执行记录要与模型生成的说明分别保存。\n\n思考：如果工具没有找到资料，Agent 应该怎样回答？"),
        ("把学习过程保存下来", "# 把学习过程保存下来\n\n学习通常跨越很多次会话。保存状态，才能在第二天继续，而不是从头开始。\n\n## 状态与证据\n\n- **阅读状态**：未读、阅读中、已读。\n- **练习状态**：等待作答、已经作答、已批改。\n- **任务状态**：排队、运行、完成、失败、被中断。\n\n这些状态描述不同的事情。标记“已读”不会自动把知识点判为已掌握。\n\n## 等待学生\n\n出题之后，系统应该保存题目，等待答案。关闭浏览器不应让题目消失，也不需要持续调用模型。\n\n## 恢复与重试\n\n后台被关闭时，未完成的任务应明确标为被中断。重新启动后，用户可以选择重试，避免不知情的重复执行。\n\n练习：设计一个“阅读 → 作答 → 批改”的最小状态流程，并说明每一步要保存什么。"),
    ];
    let mut tx = pool.begin().await?;
    sqlx::query("INSERT INTO courses VALUES (?,?,?,?,?)")
        .bind(&cid)
        .bind("认识学习 Agent")
        .bind("从目标、工具到学习记录，体验一条完整的学习流程。")
        .bind("示例课程")
        .bind(now())
        .execute(&mut *tx)
        .await?;
    for (i, (title, content)) in contents.iter().enumerate() {
        sqlx::query("INSERT INTO lessons VALUES (?,?,?,?,?,?,?)")
            .bind(id())
            .bind(&cid)
            .bind(title)
            .bind(i as i64)
            .bind(content)
            .bind(format!("示例课程 · 第 {} 节", i + 1))
            .bind("unread")
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("INSERT INTO settings VALUES ('seeded','true')")
        .execute(&mut *tx)
        .await?;
    tx.commit().await
}

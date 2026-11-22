use crate::{ai, db, AppState};
use serde_json::Value;
use std::time::Duration;

pub fn launch(state: AppState, id: String) {
    tokio::spawn(async move {
        let Ok(_permit) = state.slots.acquire().await else {
            return;
        };
        let updated=sqlx::query("UPDATE jobs SET status='running',stage='正在读取课程材料',updated_at=? WHERE id=? AND status='queued'")
        .bind(db::now()).bind(&id).execute(&state.pool).await;
        if !matches!(updated,Ok(r) if r.rows_affected()==1) {
            return;
        }
        let result = tokio::time::timeout(Duration::from_secs(180), execute(&state, &id))
            .await
            .unwrap_or_else(|_| Err("本次任务超过 3 分钟。输入已保存，可以重试。".into()));
        let (status, stage, error, value) = match result {
            Ok(v) => ("done", "已完成", String::new(), v.to_string()),
            Err(e) => ("failed", "执行失败", e, "{}".into()),
        };
        if let Err(e) =
            sqlx::query("UPDATE jobs SET status=?,stage=?,error=?,result=?,updated_at=? WHERE id=?")
                .bind(status)
                .bind(stage)
                .bind(error)
                .bind(value)
                .bind(db::now())
                .bind(&id)
                .execute(&state.pool)
                .await
        {
            tracing::error!(job_id=%id,error=%e,"cannot persist job result");
        }
    });
}

async fn execute(state: &AppState, id: &str) -> Result<Value, String> {
    let job: db::Job = sqlx::query_as("SELECT * FROM jobs WHERE id=?")
        .bind(id)
        .fetch_one(&state.pool)
        .await
        .map_err(|e| e.to_string())?;
    let lesson = db::lesson(&state.pool, &job.lesson_id)
        .await
        .map_err(|_| "章节不存在")?;
    let payload: Value = serde_json::from_str(&job.payload).map_err(|_| "任务数据无效")?;
    let role = match job.kind.as_str() {
        "chat" => "chat",
        "quiz" => "practice",
        "grade" => {
            if payload.get("answer_images").is_some() || payload.get("answer_image").is_some() {
                "vision"
            } else {
                "practice"
            }
        }
        _ => return Err("未知任务类型".into()),
    };
    let cfg = crate::model_routes::config_for(state, role).await?;
    let stage = match job.kind.as_str() {
        "chat" => "助教正在思考",
        "quiz" => "正在设计练习",
        "grade" => "正在检查作答",
        _ => return Err("未知任务类型".into()),
    };
    sqlx::query("UPDATE jobs SET stage=? WHERE id=?")
        .bind(stage)
        .bind(id)
        .execute(&state.pool)
        .await
        .map_err(|e| e.to_string())?;
    match job.kind.as_str() {
        "chat" => ai::chat(state, &cfg, &job, &lesson).await,
        "quiz" => ai::quiz(state, &cfg, &job, &lesson).await,
        "grade" => ai::grade(state, &cfg, &job, &lesson).await,
        _ => Err("未知任务类型".into()),
    }
}

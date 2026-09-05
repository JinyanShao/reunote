use crate::db::{new_id, now_ms, snippet_around, tokenize};
use crate::error::{AppError, Result};
use crate::files;
use crate::models::*;
use crate::AppState;
use base64::Engine;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::State;

// ─────────────────────────── 内部工具 ───────────────────────────

fn tags_of(conn: &Connection, page_id: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT t.name FROM tags t JOIN page_tags pt ON pt.tag_id = t.id
         WHERE pt.page_id = ?1 ORDER BY t.name",
    )?;
    let rows = stmt.query_map([page_id], |r| r.get::<_, String>(0))?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

fn set_tags(conn: &Connection, page_id: &str, tags: &[String]) -> Result<()> {
    conn.execute("DELETE FROM page_tags WHERE page_id = ?1", [page_id])?;
    for raw in tags {
        let name = raw.trim();
        if name.is_empty() {
            continue;
        }
        let existing: Option<String> = conn
            .query_row("SELECT id FROM tags WHERE name = ?1", [name], |r| r.get(0))
            .optional()?;
        let tag_id = match existing {
            Some(id) => id,
            None => {
                let id = new_id();
                conn.execute(
                    "INSERT INTO tags (id, name, color) VALUES (?1, ?2, ?3)",
                    params![id, name, "#8B9BB4"],
                )?;
                id
            }
        };
        conn.execute(
            "INSERT OR IGNORE INTO page_tags (page_id, tag_id) VALUES (?1, ?2)",
            params![page_id, tag_id],
        )?;
    }
    Ok(())
}

fn next_order(conn: &Connection, table: &str, col: &str, parent: &str) -> Result<f64> {
    let sql = format!("SELECT COALESCE(MAX(sort_order), 0) + 1000 FROM {table} WHERE {col} = ?1");
    let v: f64 = conn.query_row(&sql, [parent], |r| r.get(0))?;
    Ok(v)
}

fn preview_of(plain: &str) -> String {
    let cleaned = plain.replace(['\n', '\t'], " ");
    let trimmed = cleaned.trim();
    trimmed.chars().take(140).collect()
}

// ─────────────────────────── 笔记本 ───────────────────────────

#[tauri::command]
pub fn notebooks_list(state: State<'_, AppState>) -> Result<Vec<Notebook>> {
    let conn = state.conn.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, name, color, icon, sort_order, created_at, updated_at, deleted_at
         FROM notebooks WHERE deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Notebook {
            id: r.get(0)?,
            name: r.get(1)?,
            color: r.get(2)?,
            icon: r.get(3)?,
            sort_order: r.get(4)?,
            created_at: r.get(5)?,
            updated_at: r.get(6)?,
            deleted_at: r.get(7)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

#[tauri::command]
pub fn notebook_create(
    state: State<'_, AppState>,
    name: String,
    color: Option<String>,
    icon: Option<String>,
) -> Result<Notebook> {
    let conn = state.conn.lock().unwrap();
    let now = now_ms();
    let id = new_id();
    let order: f64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order), 0) + 1000 FROM notebooks",
        [],
        |r| r.get(0),
    )?;
    let color = color.unwrap_or_else(|| "#6C8CFF".into());
    let icon = icon.unwrap_or_else(|| "book".into());
    conn.execute(
        "INSERT INTO notebooks (id, name, color, icon, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        params![id, name, color, icon, order, now],
    )?;
    Ok(Notebook {
        id,
        name,
        color,
        icon,
        sort_order: order,
        created_at: now,
        updated_at: now,
        deleted_at: None,
    })
}

#[tauri::command]
pub fn notebook_update(
    state: State<'_, AppState>,
    id: String,
    name: Option<String>,
    color: Option<String>,
    icon: Option<String>,
    sort_order: Option<f64>,
) -> Result<()> {
    let conn = state.conn.lock().unwrap();
    let now = now_ms();
    if let Some(v) = name {
        conn.execute("UPDATE notebooks SET name = ?1 WHERE id = ?2", params![v, id])?;
    }
    if let Some(v) = color {
        conn.execute(
            "UPDATE notebooks SET color = ?1 WHERE id = ?2",
            params![v, id],
        )?;
    }
    if let Some(v) = icon {
        conn.execute("UPDATE notebooks SET icon = ?1 WHERE id = ?2", params![v, id])?;
    }
    if let Some(v) = sort_order {
        conn.execute(
            "UPDATE notebooks SET sort_order = ?1 WHERE id = ?2",
            params![v, id],
        )?;
    }
    conn.execute(
        "UPDATE notebooks SET updated_at = ?1 WHERE id = ?2",
        params![now, id],
    )?;
    Ok(())
}

/// 软删除必须级联到子层，否则「已删除笔记本」里的页面仍会出现在收藏 / 最近 / 标签结果里，
/// 用户点进去编辑，随后清空回收站时被静默硬删。用同一个时间戳标记，恢复时按时间戳整体还原。
#[tauri::command]
pub fn notebook_delete(state: State<'_, AppState>, id: String) -> Result<()> {
    let conn = state.conn.lock().unwrap();
    let ts = now_ms();
    conn.execute(
        "UPDATE pages SET deleted_at = ?1 WHERE deleted_at IS NULL AND section_id IN
         (SELECT id FROM sections WHERE notebook_id = ?2)",
        params![ts, id],
    )?;
    conn.execute(
        "UPDATE sections SET deleted_at = ?1 WHERE deleted_at IS NULL AND notebook_id = ?2",
        params![ts, id],
    )?;
    conn.execute(
        "UPDATE notebooks SET deleted_at = ?1 WHERE id = ?2",
        params![ts, id],
    )?;
    Ok(())
}

// ─────────────────────────── 分区 ───────────────────────────

#[tauri::command]
pub fn sections_list(state: State<'_, AppState>, notebook_id: String) -> Result<Vec<Section>> {
    let conn = state.conn.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, notebook_id, name, color, sort_order, created_at, updated_at, deleted_at
         FROM sections WHERE notebook_id = ?1 AND deleted_at IS NULL
         ORDER BY sort_order ASC, created_at ASC",
    )?;
    let rows = stmt.query_map([notebook_id], |r| {
        Ok(Section {
            id: r.get(0)?,
            notebook_id: r.get(1)?,
            name: r.get(2)?,
            color: r.get(3)?,
            sort_order: r.get(4)?,
            created_at: r.get(5)?,
            updated_at: r.get(6)?,
            deleted_at: r.get(7)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

#[tauri::command]
pub fn section_create(
    state: State<'_, AppState>,
    notebook_id: String,
    name: String,
    color: Option<String>,
) -> Result<Section> {
    let conn = state.conn.lock().unwrap();
    let now = now_ms();
    let id = new_id();
    let order = next_order(&conn, "sections", "notebook_id", &notebook_id)?;
    let color = color.unwrap_or_else(|| "#8B9BB4".into());
    conn.execute(
        "INSERT INTO sections (id, notebook_id, name, color, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        params![id, notebook_id, name, color, order, now],
    )?;
    Ok(Section {
        id,
        notebook_id,
        name,
        color,
        sort_order: order,
        created_at: now,
        updated_at: now,
        deleted_at: None,
    })
}

#[tauri::command]
pub fn section_update(
    state: State<'_, AppState>,
    id: String,
    name: Option<String>,
    color: Option<String>,
    sort_order: Option<f64>,
    notebook_id: Option<String>,
) -> Result<()> {
    let conn = state.conn.lock().unwrap();
    if let Some(v) = name {
        conn.execute("UPDATE sections SET name = ?1 WHERE id = ?2", params![v, id])?;
    }
    if let Some(v) = color {
        conn.execute("UPDATE sections SET color = ?1 WHERE id = ?2", params![v, id])?;
    }
    if let Some(v) = sort_order {
        conn.execute(
            "UPDATE sections SET sort_order = ?1 WHERE id = ?2",
            params![v, id],
        )?;
    }
    if let Some(v) = notebook_id {
        conn.execute(
            "UPDATE sections SET notebook_id = ?1 WHERE id = ?2",
            params![v, id],
        )?;
    }
    conn.execute(
        "UPDATE sections SET updated_at = ?1 WHERE id = ?2",
        params![now_ms(), id],
    )?;
    Ok(())
}

#[tauri::command]
pub fn section_delete(state: State<'_, AppState>, id: String) -> Result<()> {
    let conn = state.conn.lock().unwrap();
    let ts = now_ms();
    conn.execute(
        "UPDATE pages SET deleted_at = ?1 WHERE deleted_at IS NULL AND section_id = ?2",
        params![ts, id],
    )?;
    conn.execute(
        "UPDATE sections SET deleted_at = ?1 WHERE id = ?2",
        params![ts, id],
    )?;
    Ok(())
}

#[derive(Debug)]
struct AgentSourcePage {
    id: String,
    parent_id: Option<String>,
    title: String,
    content: String,
    plain_text: String,
    sort_order: f64,
    favorite: i64,
}

#[derive(Debug)]
struct AgentSourceAttachment {
    id: String,
    page_id: String,
    filename: String,
    mime: String,
}

#[derive(Debug)]
struct AgentDraftAttachment {
    id: String,
    page_id: String,
    filename: String,
    mime: String,
    size: i64,
}

fn active_section(conn: &Connection, id: &str) -> Result<Section> {
    conn.query_row(
        "SELECT id, notebook_id, name, color, sort_order, created_at, updated_at, deleted_at
         FROM sections WHERE id = ?1 AND deleted_at IS NULL",
        [id],
        |r| {
            Ok(Section {
                id: r.get(0)?,
                notebook_id: r.get(1)?,
                name: r.get(2)?,
                color: r.get(3)?,
                sort_order: r.get(4)?,
                created_at: r.get(5)?,
                updated_at: r.get(6)?,
                deleted_at: r.get(7)?,
            })
        },
    )
    .optional()?
    .ok_or_else(|| AppError::msg(format!("分区不存在或已删除：{id}")))
}

/// 快照覆盖分区元信息和全部页面（包括回收站页面）。页面删除不会更新 updated_at，
/// 因此 deleted_at 必须显式进入快照，才能阻止 Agent 覆盖并发恢复/删除操作。
fn agent_section_snapshot(conn: &Connection, section_id: &str) -> Result<String> {
    let section = active_section(conn, section_id)?;
    let pages = {
        let mut stmt = conn.prepare(
            "SELECT id, parent_id, sort_order, updated_at, deleted_at
             FROM pages WHERE section_id = ?1 ORDER BY id ASC",
        )?;
        let rows = stmt.query_map([section_id], |r| {
            Ok(serde_json::json!({
                "id": r.get::<_, String>(0)?,
                "parentId": r.get::<_, Option<String>>(1)?,
                "sortOrder": r.get::<_, f64>(2)?,
                "updatedAt": r.get::<_, i64>(3)?,
                "deletedAt": r.get::<_, Option<i64>>(4)?,
            }))
        })?;
        rows.collect::<std::result::Result<Vec<_>, _>>()?
    };
    Ok(serde_json::to_string(&serde_json::json!({
        "version": 1,
        "section": {
            "id": section.id,
            "notebookId": section.notebook_id,
            "name": section.name,
            "color": section.color,
            "sortOrder": section.sort_order,
            "updatedAt": section.updated_at,
        },
        "pages": pages,
    }))?)
}

fn rewritten_asset_src(src: &str, attachment_map: &HashMap<String, String>) -> Option<String> {
    attachment_map.iter().find_map(|(old_id, new_id)| {
        let is_asset = src == files::asset_url(old_id)
            || (src.contains("inkasset") && src.rsplit('/').next() == Some(old_id.as_str()));
        is_asset.then(|| files::asset_url(new_id))
    })
}

fn rewrite_attachment_value(
    value: &mut serde_json::Value,
    attachment_map: &HashMap<String, String>,
) {
    match value {
        serde_json::Value::Array(items) => {
            for item in items {
                rewrite_attachment_value(item, attachment_map);
            }
        }
        serde_json::Value::Object(object) => {
            let mapped_id = object
                .get("attachmentId")
                .and_then(|v| v.as_str())
                .and_then(|id| attachment_map.get(id))
                .cloned();
            if let Some(new_id) = mapped_id.as_ref() {
                object.insert(
                    "attachmentId".into(),
                    serde_json::Value::String(new_id.clone()),
                );
                if object.contains_key("src") {
                    object.insert(
                        "src".into(),
                        serde_json::Value::String(files::asset_url(new_id)),
                    );
                }
            } else if let Some(src) = object
                .get("src")
                .and_then(|v| v.as_str())
                .map(str::to_owned)
            {
                if let Some(new_src) = rewritten_asset_src(&src, attachment_map) {
                    object.insert("src".into(), serde_json::Value::String(new_src));
                }
            }
            for child in object.values_mut() {
                rewrite_attachment_value(child, attachment_map);
            }
        }
        _ => {}
    }
}

fn rewrite_canvas_attachment_refs(
    content: &str,
    attachment_map: &HashMap<String, String>,
    operation: &str,
) -> Result<String> {
    if attachment_map.is_empty() {
        return Ok(content.to_owned());
    }
    let mut doc: serde_json::Value = serde_json::from_str(content).map_err(|error| {
        AppError::msg(format!(
            "页面包含附件，但画布内容无法解析，已取消{operation}：{error}"
        ))
    })?;
    rewrite_attachment_value(&mut doc, attachment_map);
    Ok(serde_json::to_string(&doc)?)
}

fn duplicate_page_owned_attachments(
    conn: &Connection,
    attachments_dir: &Path,
    page_id_map: &HashMap<String, String>,
    created_files: &mut Vec<PathBuf>,
    operation: &str,
) -> Result<(HashMap<String, String>, Vec<AgentDraftAttachment>)> {
    let mut source_attachments = Vec::new();
    for source_page_id in page_id_map.keys() {
        let mut stmt = conn.prepare(
            "SELECT id, page_id, filename, mime FROM attachments WHERE page_id = ?1",
        )?;
        let rows = stmt.query_map([source_page_id], |row| {
            Ok(AgentSourceAttachment {
                id: row.get(0)?,
                page_id: row.get(1)?,
                filename: row.get(2)?,
                mime: row.get(3)?,
            })
        })?;
        source_attachments.extend(rows.collect::<std::result::Result<Vec<_>, _>>()?);
    }

    let mut attachment_map = HashMap::new();
    let mut copied_attachments = Vec::new();
    for attachment in source_attachments {
        let old_stored = files::sanitize_name(&attachment.id);
        let extension = files::extension_of(&old_stored);
        let new_stored = format!("{}.{}", new_id(), extension);
        let target_page_id = page_id_map.get(&attachment.page_id).ok_or_else(|| {
            AppError::msg(format!(
                "附件「{}」缺少目标页面，已取消{operation}",
                attachment.filename
            ))
        })?;
        let target_path = attachments_dir.join(&new_stored);
        created_files.push(target_path.clone());
        let copied = std::fs::copy(attachments_dir.join(&old_stored), &target_path).map_err(
            |error| {
                AppError::msg(format!(
                    "复制附件「{}」失败，已取消{operation}：{error}",
                    attachment.filename
                ))
            },
        )?;
        attachment_map.insert(attachment.id, new_stored.clone());
        copied_attachments.push(AgentDraftAttachment {
            id: new_stored,
            page_id: target_page_id.clone(),
            filename: attachment.filename,
            mime: attachment.mime,
            size: copied as i64,
        });
    }
    Ok((attachment_map, copied_attachments))
}

fn section_duplicate_for_agent_impl(
    conn: &mut Connection,
    data_dir: &Path,
    source_section_id: &str,
    current_page_id: Option<&str>,
) -> Result<AgentSectionDuplicateResult> {
    let attachments_dir = files::attachments_dir(data_dir);
    std::fs::create_dir_all(&attachments_dir)?;
    let mut created_files: Vec<PathBuf> = Vec::new();

    let outcome: Result<AgentSectionDuplicateResult> = (|| {
        let tx = conn.transaction()?;
        let source_section = active_section(&tx, source_section_id)?;
        let source_snapshot = agent_section_snapshot(&tx, source_section_id)?;
        let pages = {
            let mut stmt = tx.prepare(
                "SELECT id, parent_id, title, content, plain_text, sort_order, favorite
                 FROM pages WHERE section_id = ?1 AND deleted_at IS NULL
                 ORDER BY sort_order ASC, created_at ASC",
            )?;
            let rows = stmt.query_map([source_section_id], |r| {
                Ok(AgentSourcePage {
                    id: r.get(0)?,
                    parent_id: r.get(1)?,
                    title: r.get(2)?,
                    content: r.get(3)?,
                    plain_text: r.get(4)?,
                    sort_order: r.get(5)?,
                    favorite: r.get(6)?,
                })
            })?;
            rows.collect::<std::result::Result<Vec<_>, _>>()?
        };

        let now = now_ms();
        let draft_section_id = new_id();
        let draft_order: f64 = tx.query_row(
            "SELECT COALESCE(MAX(sort_order), 0) + 1000 FROM sections WHERE notebook_id = ?1",
            [&source_section.notebook_id],
            |r| r.get(0),
        )?;
        let draft_name = format!("{}（AI 草稿）", source_section.name);
        tx.execute(
            "INSERT INTO sections (id, notebook_id, name, color, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![
                draft_section_id,
                source_section.notebook_id,
                draft_name,
                source_section.color,
                draft_order,
                now
            ],
        )?;

        let page_id_map: HashMap<String, String> = pages
            .iter()
            .map(|page| (page.id.clone(), new_id()))
            .collect();
        let page_map: Vec<AgentPageClone> = pages
            .iter()
            .map(|page| AgentPageClone {
                source_page_id: page.id.clone(),
                draft_page_id: page_id_map[&page.id].clone(),
            })
            .collect();

        let (attachment_map, draft_attachments) = duplicate_page_owned_attachments(
            &tx,
            &attachments_dir,
            &page_id_map,
            &mut created_files,
            "创建 Agent 草稿",
        )?;

        for page in &pages {
            let draft_page_id = &page_id_map[&page.id];
            let draft_parent_id = page
                .parent_id
                .as_ref()
                .and_then(|parent| page_id_map.get(parent))
                .cloned();
            let content = rewrite_canvas_attachment_refs(
                &page.content,
                &attachment_map,
                "创建 Agent 草稿",
            )?;
            tx.execute(
                "INSERT INTO pages
                 (id, section_id, parent_id, title, content, plain_text, sort_order, favorite, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
                params![
                    draft_page_id,
                    draft_section_id,
                    draft_parent_id,
                    page.title,
                    content,
                    page.plain_text,
                    page.sort_order,
                    page.favorite,
                    now
                ],
            )?;
            tx.execute(
                "INSERT OR IGNORE INTO page_tags (page_id, tag_id)
                 SELECT ?1, tag_id FROM page_tags WHERE page_id = ?2",
                params![draft_page_id, page.id],
            )?;
            tx.execute(
                "INSERT OR IGNORE INTO links (from_page, to_page)
                 SELECT ?1, to_page FROM links WHERE from_page = ?2",
                params![draft_page_id, page.id],
            )?;
        }

        for attachment in draft_attachments {
            tx.execute(
                "INSERT INTO attachments (id, page_id, filename, mime, size, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    attachment.id,
                    attachment.page_id,
                    attachment.filename,
                    attachment.mime,
                    attachment.size,
                    now
                ],
            )?;
        }

        let current_draft_page_id = current_page_id
            .and_then(|id| page_id_map.get(id).cloned())
            .or_else(|| page_map.first().map(|entry| entry.draft_page_id.clone()));
        let draft_section = Section {
            id: draft_section_id,
            notebook_id: source_section.notebook_id.clone(),
            name: draft_name,
            color: source_section.color.clone(),
            sort_order: draft_order,
            created_at: now,
            updated_at: now,
            deleted_at: None,
        };
        let result = AgentSectionDuplicateResult {
            source_section,
            draft_section,
            page_map,
            current_draft_page_id,
            source_snapshot,
        };
        tx.commit()?;
        Ok(result)
    })();

    if outcome.is_err() {
        for path in created_files {
            let _ = std::fs::remove_file(path);
        }
    }
    outcome
}

#[tauri::command]
pub fn section_duplicate_for_agent(
    state: State<'_, AppState>,
    source_section_id: String,
    current_page_id: Option<String>,
) -> Result<AgentSectionDuplicateResult> {
    let mut conn = state.conn.lock().unwrap();
    section_duplicate_for_agent_impl(
        &mut conn,
        &state.data_dir,
        &source_section_id,
        current_page_id.as_deref(),
    )
}

fn page_ids(conn: &Connection, section_id: &str, active_only: bool) -> Result<Vec<String>> {
    let sql = if active_only {
        "SELECT id FROM pages WHERE section_id = ?1 AND deleted_at IS NULL
         ORDER BY sort_order ASC, created_at ASC"
    } else {
        "SELECT id FROM pages WHERE section_id = ?1 ORDER BY sort_order ASC, created_at ASC"
    };
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([section_id], |r| r.get::<_, String>(0))?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

fn section_adopt_agent_draft_impl(
    conn: &mut Connection,
    source_section_id: &str,
    draft_section_id: &str,
    expected_snapshot: &str,
    current_page_id: Option<&str>,
) -> Result<AgentSectionAdoptResult> {
    if source_section_id == draft_section_id {
        return Err(AppError::msg("源分区和 Agent 草稿分区不能相同"));
    }

    let tx = conn.transaction()?;
    let mut source_section = active_section(&tx, source_section_id)?;
    let draft_section = active_section(&tx, draft_section_id)?;
    if source_section.notebook_id != draft_section.notebook_id {
        return Err(AppError::msg("Agent 草稿必须与源分区属于同一个笔记本"));
    }
    let current_snapshot = agent_section_snapshot(&tx, source_section_id)?;
    if current_snapshot != expected_snapshot {
        return Err(AppError::msg(
            "原分区在 Agent 处理期间已发生变化，请重新创建草稿后再采纳",
        ));
    }

    let source_page_ids = page_ids(&tx, source_section_id, false)?;
    let adopted_page_ids = page_ids(&tx, draft_section_id, true)?;
    let now = now_ms();

    // 先移动源分区的全部页面，保留之前已在回收站里的页面状态；活动页面使用
    // 与备份分区相同的删除时间戳，恢复分区时可作为一个整体还原。
    for page_id in &source_page_ids {
        let changed = tx.execute(
            "UPDATE pages
             SET section_id = ?1,
                 deleted_at = CASE WHEN deleted_at IS NULL THEN ?2 ELSE deleted_at END,
                 updated_at = CASE WHEN deleted_at IS NULL THEN ?2 ELSE updated_at END
             WHERE id = ?3 AND section_id = ?4",
            params![draft_section_id, now, page_id, source_section_id],
        )?;
        if changed != 1 {
            return Err(AppError::msg("交换原分区页面时检测到并发修改"));
        }
    }

    // ID 列表在移动源页面前已固定，因此不会把刚移入草稿分区的旧页面再移回来。
    for page_id in &adopted_page_ids {
        let changed = tx.execute(
            "UPDATE pages SET section_id = ?1, updated_at = ?2
             WHERE id = ?3 AND section_id = ?4 AND deleted_at IS NULL",
            params![source_section_id, now, page_id, draft_section_id],
        )?;
        if changed != 1 {
            return Err(AppError::msg("交换 Agent 草稿页面时检测到并发修改"));
        }
    }

    let backup_name = format!("{}（AI 替换前）", source_section.name);
    let changed = tx.execute(
        "UPDATE sections SET name = ?1, updated_at = ?2, deleted_at = ?2
         WHERE id = ?3 AND deleted_at IS NULL",
        params![backup_name, now, draft_section_id],
    )?;
    if changed != 1 {
        return Err(AppError::msg("Agent 草稿分区已发生变化，无法采纳"));
    }
    tx.execute(
        "UPDATE sections SET updated_at = ?1 WHERE id = ?2",
        params![now, source_section_id],
    )?;

    source_section.updated_at = now;
    let current_page_id = current_page_id
        .filter(|id| adopted_page_ids.iter().any(|page_id| page_id == id))
        .map(str::to_owned)
        .or_else(|| adopted_page_ids.first().cloned());
    let result = AgentSectionAdoptResult {
        source_section,
        backup_section_id: draft_section_id.to_owned(),
        current_page_id,
        adopted_page_ids,
    };
    tx.commit()?;
    Ok(result)
}

#[tauri::command]
pub fn section_adopt_agent_draft(
    state: State<'_, AppState>,
    source_section_id: String,
    draft_section_id: String,
    expected_snapshot: String,
    current_page_id: Option<String>,
) -> Result<AgentSectionAdoptResult> {
    let mut conn = state.conn.lock().unwrap();
    section_adopt_agent_draft_impl(
        &mut conn,
        &source_section_id,
        &draft_section_id,
        &expected_snapshot,
        current_page_id.as_deref(),
    )
}

// ─────────────────────────── 页面 ───────────────────────────

#[tauri::command]
pub fn pages_list(state: State<'_, AppState>, section_id: String) -> Result<Vec<PageMeta>> {
    let conn = state.conn.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT p.id, p.section_id, s.notebook_id, p.parent_id, p.title, p.plain_text,
                p.sort_order, p.favorite, p.created_at, p.updated_at, p.deleted_at
         FROM pages p JOIN sections s ON s.id = p.section_id
         WHERE p.section_id = ?1 AND p.deleted_at IS NULL
         ORDER BY p.sort_order ASC, p.created_at ASC",
    )?;
    let rows = stmt.query_map([section_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, Option<String>>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, String>(5)?,
            r.get::<_, f64>(6)?,
            r.get::<_, i64>(7)?,
            r.get::<_, i64>(8)?,
            r.get::<_, i64>(9)?,
            r.get::<_, Option<i64>>(10)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let t = row?;
        let tags = tags_of(&conn, &t.0)?;
        out.push(PageMeta {
            id: t.0,
            section_id: t.1,
            notebook_id: t.2,
            parent_id: t.3,
            title: t.4,
            preview: preview_of(&t.5),
            sort_order: t.6,
            favorite: t.7 != 0,
            created_at: t.8,
            updated_at: t.9,
            deleted_at: t.10,
            tags,
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn page_get(state: State<'_, AppState>, id: String) -> Result<Option<Page>> {
    let conn = state.conn.lock().unwrap();
    let row = conn
        .query_row(
            "SELECT p.id, p.section_id, s.notebook_id, p.parent_id, p.title, p.content,
                    p.sort_order, p.favorite, p.created_at, p.updated_at
             FROM pages p JOIN sections s ON s.id = p.section_id
             WHERE p.id = ?1",
            [&id],
            |r| {
                Ok(Page {
                    id: r.get(0)?,
                    section_id: r.get(1)?,
                    notebook_id: r.get(2)?,
                    parent_id: r.get(3)?,
                    title: r.get(4)?,
                    content: r.get(5)?,
                    sort_order: r.get(6)?,
                    favorite: r.get::<_, i64>(7)? != 0,
                    created_at: r.get(8)?,
                    updated_at: r.get(9)?,
                    tags: vec![],
                })
            },
        )
        .optional()?;
    match row {
        Some(mut p) => {
            p.tags = tags_of(&conn, &p.id)?;
            conn.execute(
                "INSERT INTO recents (page_id, visited_at) VALUES (?1, ?2)
                 ON CONFLICT(page_id) DO UPDATE SET visited_at = ?2",
                params![p.id, now_ms()],
            )?;
            Ok(Some(p))
        }
        None => Ok(None),
    }
}

#[tauri::command]
pub fn page_create(
    state: State<'_, AppState>,
    section_id: String,
    title: String,
    content: String,
    parent_id: Option<String>,
) -> Result<PageMeta> {
    let conn = state.conn.lock().unwrap();
    let now = now_ms();
    let id = new_id();
    let order = next_order(&conn, "pages", "section_id", &section_id)?;
    conn.execute(
        "INSERT INTO pages (id, section_id, parent_id, title, content, plain_text, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, '', ?6, ?7, ?7)",
        params![id, section_id, parent_id, title, content, order, now],
    )?;
    let notebook_id: String = conn.query_row(
        "SELECT notebook_id FROM sections WHERE id = ?1",
        [&section_id],
        |r| r.get(0),
    )?;
    Ok(PageMeta {
        id,
        section_id,
        notebook_id,
        parent_id,
        title,
        preview: String::new(),
        sort_order: order,
        favorite: false,
        created_at: now,
        updated_at: now,
        deleted_at: None,
        tags: vec![],
    })
}

#[tauri::command]
pub fn page_save(state: State<'_, AppState>, payload: SavePayload) -> Result<i64> {
    let conn = state.conn.lock().unwrap();
    let now = now_ms();
    let updated = conn.execute(
        "UPDATE pages SET title = ?1, content = ?2, plain_text = ?3, updated_at = ?4 WHERE id = ?5",
        params![
            payload.title,
            payload.content,
            payload.plain_text,
            now,
            payload.id
        ],
    )?;
    if updated != 1 {
        return Err(AppError::msg("页面不存在或已删除，保存失败"));
    }
    set_tags(&conn, &payload.id, &payload.tags)?;
    conn.execute("DELETE FROM links WHERE from_page = ?1", [&payload.id])?;
    for target in &payload.links {
        conn.execute(
            "INSERT OR IGNORE INTO links (from_page, to_page) VALUES (?1, ?2)",
            params![payload.id, target],
        )?;
    }
    Ok(now)
}

#[tauri::command]
pub fn page_update_meta(
    state: State<'_, AppState>,
    id: String,
    title: Option<String>,
    favorite: Option<bool>,
    sort_order: Option<f64>,
    section_id: Option<String>,
    parent_id: Option<Option<String>>,
) -> Result<()> {
    let conn = state.conn.lock().unwrap();
    if let Some(v) = title {
        conn.execute("UPDATE pages SET title = ?1 WHERE id = ?2", params![v, id])?;
    }
    if let Some(v) = favorite {
        conn.execute(
            "UPDATE pages SET favorite = ?1 WHERE id = ?2",
            params![if v { 1 } else { 0 }, id],
        )?;
    }
    if let Some(v) = sort_order {
        conn.execute(
            "UPDATE pages SET sort_order = ?1 WHERE id = ?2",
            params![v, id],
        )?;
    }
    if let Some(v) = section_id {
        conn.execute(
            "UPDATE pages SET section_id = ?1 WHERE id = ?2",
            params![v, id],
        )?;
    }
    if let Some(v) = parent_id {
        conn.execute(
            "UPDATE pages SET parent_id = ?1 WHERE id = ?2",
            params![v, id],
        )?;
    }
    conn.execute(
        "UPDATE pages SET updated_at = ?1 WHERE id = ?2",
        params![now_ms(), id],
    )?;
    Ok(())
}

#[tauri::command]
pub fn page_delete(state: State<'_, AppState>, id: String) -> Result<()> {
    let conn = state.conn.lock().unwrap();
    conn.execute(
        "UPDATE pages SET deleted_at = ?1 WHERE id = ?2",
        params![now_ms(), id],
    )?;
    Ok(())
}

fn page_duplicate_impl(conn: &mut Connection, data_dir: &Path, id: &str) -> Result<String> {
    let attachments_dir = files::attachments_dir(data_dir);
    std::fs::create_dir_all(&attachments_dir)?;
    let mut created_files: Vec<PathBuf> = Vec::new();

    let outcome: Result<String> = (|| {
        let tx = conn.transaction()?;
        let (section_id, parent_id, title, content, plain): (
            String,
            Option<String>,
            String,
            String,
            String,
        ) = tx.query_row(
            "SELECT section_id, parent_id, title, content, plain_text
             FROM pages WHERE id = ?1 AND deleted_at IS NULL",
            [id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )?;
        let new_page = new_id();
        let now = now_ms();
        let order = next_order(&tx, "pages", "section_id", &section_id)?;
        let page_id_map = HashMap::from([(id.to_owned(), new_page.clone())]);
        let (attachment_map, copied_attachments) = duplicate_page_owned_attachments(
            &tx,
            &attachments_dir,
            &page_id_map,
            &mut created_files,
            "创建页面副本",
        )?;

        let copied_content =
            rewrite_canvas_attachment_refs(&content, &attachment_map, "创建页面副本")?;
        tx.execute(
            "INSERT INTO pages
             (id, section_id, parent_id, title, content, plain_text, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
            params![
                new_page,
                section_id,
                parent_id,
                format!("{title} 副本"),
                copied_content,
                plain,
                order,
                now
            ],
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO page_tags (page_id, tag_id)
             SELECT ?1, tag_id FROM page_tags WHERE page_id = ?2",
            params![new_page, id],
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO links (from_page, to_page)
             SELECT ?1, to_page FROM links WHERE from_page = ?2",
            params![new_page, id],
        )?;
        for attachment in copied_attachments {
            tx.execute(
                "INSERT INTO attachments (id, page_id, filename, mime, size, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    attachment.id,
                    attachment.page_id,
                    attachment.filename,
                    attachment.mime,
                    attachment.size,
                    now
                ],
            )?;
        }
        tx.commit()?;
        Ok(new_page)
    })();

    if outcome.is_err() {
        for path in created_files {
            let _ = std::fs::remove_file(path);
        }
    }
    outcome
}

#[tauri::command]
pub fn page_duplicate(state: State<'_, AppState>, id: String) -> Result<String> {
    let mut conn = state.conn.lock().unwrap();
    page_duplicate_impl(&mut conn, &state.data_dir, &id)
}

// ─────────────────────────── 搜索 ───────────────────────────

#[tauri::command]
pub fn search(
    state: State<'_, AppState>,
    query: String,
    notebook_id: Option<String>,
    tag: Option<String>,
    favorites_only: Option<bool>,
    limit: Option<u32>,
) -> Result<Vec<SearchHit>> {
    let conn = state.conn.lock().unwrap();
    let tokens = tokenize(&query);
    let limit = limit.unwrap_or(80) as usize;

    let mut stmt = conn.prepare(
        "SELECT p.id, p.title, p.plain_text, p.updated_at, p.favorite,
                s.id, s.name, n.id, n.name
         FROM pages p
         JOIN sections s ON s.id = p.section_id
         JOIN notebooks n ON n.id = s.notebook_id
         WHERE p.deleted_at IS NULL AND s.deleted_at IS NULL AND n.deleted_at IS NULL",
    )?;

    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, i64>(3)?,
            r.get::<_, i64>(4)?,
            r.get::<_, String>(5)?,
            r.get::<_, String>(6)?,
            r.get::<_, String>(7)?,
            r.get::<_, String>(8)?,
        ))
    })?;

    let mut hits: Vec<SearchHit> = Vec::new();
    for row in rows {
        let (pid, title, plain, updated, fav, sid, sname, nid, nname) = row?;

        if let Some(ref nb) = notebook_id {
            if &nid != nb {
                continue;
            }
        }
        if favorites_only.unwrap_or(false) && fav == 0 {
            continue;
        }
        if let Some(ref t) = tag {
            let page_tags = tags_of(&conn, &pid)?;
            if !page_tags.iter().any(|x| x == t) {
                continue;
            }
        }

        if tokens.is_empty() {
            hits.push(SearchHit {
                page_id: pid,
                title,
                snippet: preview_of(&plain),
                notebook_id: nid,
                notebook_name: nname,
                section_id: sid,
                section_name: sname,
                updated_at: updated,
                score: updated as f64 / 1.0e12,
            });
            continue;
        }

        let lower_title = title.to_lowercase();
        let lower_plain = plain.to_lowercase();
        let mut score = 0.0f64;
        let mut all_present = true;
        for tk in &tokens {
            let in_title = lower_title.matches(tk.as_str()).count();
            let in_body = lower_plain.matches(tk.as_str()).count();
            if in_title == 0 && in_body == 0 {
                all_present = false;
                break;
            }
            score += (in_title as f64) * 12.0 + (in_body as f64).min(20.0);
            if lower_title.starts_with(tk.as_str()) {
                score += 8.0;
            }
        }
        if !all_present {
            continue;
        }
        if fav != 0 {
            score += 3.0;
        }
        score += (updated as f64) / 1.0e12;

        let needle = tokens
            .iter()
            .find(|t| lower_plain.contains(t.as_str()))
            .cloned()
            .unwrap_or_else(|| tokens[0].clone());
        hits.push(SearchHit {
            page_id: pid,
            title,
            snippet: snippet_around(&plain, &needle, 46),
            notebook_id: nid,
            notebook_name: nname,
            section_id: sid,
            section_name: sname,
            updated_at: updated,
            score,
        });
    }

    hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    hits.truncate(limit);
    Ok(hits)
}

#[tauri::command]
pub fn recent_pages(state: State<'_, AppState>, limit: Option<u32>) -> Result<Vec<SearchHit>> {
    let conn = state.conn.lock().unwrap();
    let limit = limit.unwrap_or(20) as i64;
    let mut stmt = conn.prepare(
        "SELECT p.id, p.title, p.plain_text, p.updated_at, s.id, s.name, n.id, n.name
         FROM recents r
         JOIN pages p ON p.id = r.page_id
         JOIN sections s ON s.id = p.section_id
         JOIN notebooks n ON n.id = s.notebook_id
         WHERE p.deleted_at IS NULL AND s.deleted_at IS NULL AND n.deleted_at IS NULL
         ORDER BY r.visited_at DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map([limit], |r| {
        Ok(SearchHit {
            page_id: r.get(0)?,
            title: r.get(1)?,
            snippet: preview_of(&r.get::<_, String>(2)?),
            updated_at: r.get(3)?,
            section_id: r.get(4)?,
            section_name: r.get(5)?,
            notebook_id: r.get(6)?,
            notebook_name: r.get(7)?,
            score: 0.0,
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

/// links.to_page 存的是 [[ ]] 里的**标题**（前端只能拿到标题），
/// 所以这里必须按标题反查，而不是按 page_id —— 否则反向链接面板永远是空的。
/// 同时兼容 to_page 直接存 id 的情况。
#[tauri::command]
pub fn backlinks(state: State<'_, AppState>, page_id: String) -> Result<Vec<Backlink>> {
    let conn = state.conn.lock().unwrap();
    let title: String = conn
        .query_row("SELECT title FROM pages WHERE id = ?1", [&page_id], |r| {
            r.get(0)
        })
        .optional()?
        .unwrap_or_default();

    let mut stmt = conn.prepare(
        "SELECT p.id, p.title, n.name, s.name, p.updated_at
         FROM links l
         JOIN pages p ON p.id = l.from_page
         JOIN sections s ON s.id = p.section_id
         JOIN notebooks n ON n.id = s.notebook_id
         WHERE (l.to_page = ?1 OR (?2 <> '' AND l.to_page = ?2))
           AND p.id <> ?1
           AND p.deleted_at IS NULL AND s.deleted_at IS NULL AND n.deleted_at IS NULL
         ORDER BY p.updated_at DESC",
    )?;
    let rows = stmt.query_map(params![page_id, title], |r| {
        Ok(Backlink {
            page_id: r.get(0)?,
            title: r.get(1)?,
            notebook_name: r.get(2)?,
            section_name: r.get(3)?,
            updated_at: r.get(4)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

/// 按标题查页面 id，供 [[双向链接]] 点击跳转用
#[tauri::command]
pub fn page_by_title(state: State<'_, AppState>, title: String) -> Result<Option<String>> {
    let conn = state.conn.lock().unwrap();
    let id: Option<String> = conn
        .query_row(
            "SELECT p.id FROM pages p
             JOIN sections s ON s.id = p.section_id
             JOIN notebooks n ON n.id = s.notebook_id
             WHERE p.title = ?1 AND p.deleted_at IS NULL
               AND s.deleted_at IS NULL AND n.deleted_at IS NULL
             ORDER BY p.updated_at DESC LIMIT 1",
            [&title],
            |r| r.get(0),
        )
        .optional()?;
    Ok(id)
}

// ─────────────────────────── 标签 ───────────────────────────

#[tauri::command]
pub fn tags_list(state: State<'_, AppState>) -> Result<Vec<Tag>> {
    let conn = state.conn.lock().unwrap();
    let mut stmt = conn.prepare(
        // COUNT 必须统计 p.id：统计 pt.page_id 的话，
        // LEFT JOIN 未命中的行（已删除页面）依然非空，deleted_at 过滤就白加了
        "SELECT t.id, t.name, t.color, COUNT(p.id)
         FROM tags t
         LEFT JOIN page_tags pt ON pt.tag_id = t.id
         LEFT JOIN pages p ON p.id = pt.page_id AND p.deleted_at IS NULL
         GROUP BY t.id ORDER BY COUNT(pt.page_id) DESC, t.name ASC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Tag {
            id: r.get(0)?,
            name: r.get(1)?,
            color: r.get(2)?,
            count: r.get(3)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

#[tauri::command]
pub fn tag_set_color(state: State<'_, AppState>, id: String, color: String) -> Result<()> {
    let conn = state.conn.lock().unwrap();
    conn.execute("UPDATE tags SET color = ?1 WHERE id = ?2", params![color, id])?;
    Ok(())
}

#[tauri::command]
pub fn pages_by_tag(state: State<'_, AppState>, tag: String) -> Result<Vec<SearchHit>> {
    let conn = state.conn.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT p.id, p.title, p.plain_text, p.updated_at, s.id, s.name, n.id, n.name
         FROM pages p
         JOIN page_tags pt ON pt.page_id = p.id
         JOIN tags t ON t.id = pt.tag_id
         JOIN sections s ON s.id = p.section_id
         JOIN notebooks n ON n.id = s.notebook_id
         WHERE t.name = ?1 AND p.deleted_at IS NULL
           AND s.deleted_at IS NULL AND n.deleted_at IS NULL
         ORDER BY p.updated_at DESC",
    )?;
    let rows = stmt.query_map([tag], |r| {
        Ok(SearchHit {
            page_id: r.get(0)?,
            title: r.get(1)?,
            snippet: preview_of(&r.get::<_, String>(2)?),
            updated_at: r.get(3)?,
            section_id: r.get(4)?,
            section_name: r.get(5)?,
            notebook_id: r.get(6)?,
            notebook_name: r.get(7)?,
            score: 0.0,
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

#[tauri::command]
pub fn favorites_list(state: State<'_, AppState>) -> Result<Vec<SearchHit>> {
    let conn = state.conn.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT p.id, p.title, p.plain_text, p.updated_at, s.id, s.name, n.id, n.name
         FROM pages p
         JOIN sections s ON s.id = p.section_id
         JOIN notebooks n ON n.id = s.notebook_id
         WHERE p.favorite = 1 AND p.deleted_at IS NULL
           AND s.deleted_at IS NULL AND n.deleted_at IS NULL
         ORDER BY p.updated_at DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(SearchHit {
            page_id: r.get(0)?,
            title: r.get(1)?,
            snippet: preview_of(&r.get::<_, String>(2)?),
            updated_at: r.get(3)?,
            section_id: r.get(4)?,
            section_name: r.get(5)?,
            notebook_id: r.get(6)?,
            notebook_name: r.get(7)?,
            score: 0.0,
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

// ─────────────────────────── 版本历史 ───────────────────────────

#[tauri::command]
pub fn version_create(
    state: State<'_, AppState>,
    page_id: String,
    label: Option<String>,
) -> Result<VersionMeta> {
    let conn = state.conn.lock().unwrap();
    let (title, content): (String, String) = conn.query_row(
        "SELECT title, content FROM pages WHERE id = ?1",
        [&page_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let id = new_id();
    let now = now_ms();
    let label = label.unwrap_or_else(|| "手动快照".into());
    let size = content.len() as i64;
    conn.execute(
        "INSERT INTO versions (id, page_id, title, content, label, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, page_id, title, content, label, now],
    )?;
    // 每页最多保留 50 个快照
    conn.execute(
        "DELETE FROM versions WHERE page_id = ?1 AND id NOT IN
         (SELECT id FROM versions WHERE page_id = ?1 ORDER BY created_at DESC LIMIT 50)",
        [&page_id],
    )?;
    Ok(VersionMeta {
        id,
        page_id,
        title,
        label,
        size,
        created_at: now,
    })
}

#[tauri::command]
pub fn versions_list(state: State<'_, AppState>, page_id: String) -> Result<Vec<VersionMeta>> {
    let conn = state.conn.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, page_id, title, label, LENGTH(content), created_at
         FROM versions WHERE page_id = ?1 ORDER BY created_at DESC",
    )?;
    let rows = stmt.query_map([page_id], |r| {
        Ok(VersionMeta {
            id: r.get(0)?,
            page_id: r.get(1)?,
            title: r.get(2)?,
            label: r.get(3)?,
            size: r.get(4)?,
            created_at: r.get(5)?,
        })
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

#[tauri::command]
pub fn version_content(state: State<'_, AppState>, id: String) -> Result<String> {
    let conn = state.conn.lock().unwrap();
    let content: String =
        conn.query_row("SELECT content FROM versions WHERE id = ?1", [&id], |r| {
            r.get(0)
        })?;
    Ok(content)
}

// ─────────────────────────── 附件 ───────────────────────────

#[tauri::command]
pub fn attachment_save(
    state: State<'_, AppState>,
    page_id: String,
    filename: String,
    data_base64: String,
) -> Result<Attachment> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(data_base64.as_bytes())?;
    let safe = files::sanitize_name(&filename);
    let ext = files::extension_of(&safe);
    let id = new_id();
    let stored = format!("{id}.{ext}");
    let dir = files::attachments_dir(&state.data_dir);
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join(&stored), &bytes)?;

    let mime = files::guess_mime(&safe).to_string();
    let now = now_ms();
    let size = bytes.len() as i64;
    {
        let conn = state.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO attachments (id, page_id, filename, mime, size, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![stored, page_id, safe, mime, size, now],
        )?;
    }
    Ok(Attachment {
        id: stored.clone(),
        page_id,
        filename: safe,
        mime,
        size,
        url: files::asset_url(&stored),
        created_at: now,
    })
}

#[tauri::command]
pub fn attachment_read(state: State<'_, AppState>, id: String) -> Result<String> {
    let safe = files::sanitize_name(&id);
    let path = files::attachments_dir(&state.data_dir).join(&safe);
    let bytes = std::fs::read(path)?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[tauri::command]
pub fn attachment_delete(state: State<'_, AppState>, id: String) -> Result<()> {
    let safe = files::sanitize_name(&id);
    let path = files::attachments_dir(&state.data_dir).join(&safe);
    let _ = std::fs::remove_file(path);
    let conn = state.conn.lock().unwrap();
    conn.execute("DELETE FROM attachments WHERE id = ?1", [&safe])?;
    Ok(())
}

#[tauri::command]
pub fn attachment_export(
    state: State<'_, AppState>,
    id: String,
    target_path: String,
) -> Result<()> {
    let safe = files::sanitize_name(&id);
    let src = files::attachments_dir(&state.data_dir).join(&safe);
    std::fs::copy(src, target_path)?;
    Ok(())
}

// ─────────────────────────── 文件读写 ───────────────────────────

#[tauri::command]
pub fn read_file_base64(path: String) -> Result<String> {
    let bytes = std::fs::read(&path)?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[tauri::command]
pub fn read_file_text(path: String) -> Result<String> {
    let bytes = std::fs::read(&path)?;
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

#[tauri::command]
pub fn write_file_text(path: String, contents: String) -> Result<()> {
    std::fs::write(&path, contents)?;
    Ok(())
}

#[tauri::command]
pub fn write_file_base64(path: String, data_base64: String) -> Result<()> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(data_base64.as_bytes())?;
    std::fs::write(&path, bytes)?;
    Ok(())
}

// ─────────────────────────── 回收站 ───────────────────────────

#[tauri::command]
pub fn trash_list(state: State<'_, AppState>) -> Result<Vec<TrashItem>> {
    let conn = state.conn.lock().unwrap();
    let mut out = Vec::new();

    // 只列出用户直接删除的那一层：随父级一起被软删的子项不重复占位
    let mut stmt = conn.prepare(
        "SELECT p.id, p.title, s.name, p.deleted_at FROM pages p
         JOIN sections s ON s.id = p.section_id
         WHERE p.deleted_at IS NOT NULL AND s.deleted_at IS NULL
         ORDER BY p.deleted_at DESC",
    )?;
    for row in stmt.query_map([], |r| {
        Ok(TrashItem {
            id: r.get(0)?,
            kind: "page".into(),
            title: r.get::<_, String>(1)?,
            parent_label: r.get(2)?,
            deleted_at: r.get(3)?,
        })
    })? {
        out.push(row?);
    }

    let mut stmt = conn.prepare(
        "SELECT s.id, s.name, n.name, s.deleted_at FROM sections s
         JOIN notebooks n ON n.id = s.notebook_id
         WHERE s.deleted_at IS NOT NULL AND n.deleted_at IS NULL
         ORDER BY s.deleted_at DESC",
    )?;
    for row in stmt.query_map([], |r| {
        Ok(TrashItem {
            id: r.get(0)?,
            kind: "section".into(),
            title: r.get(1)?,
            parent_label: r.get(2)?,
            deleted_at: r.get(3)?,
        })
    })? {
        out.push(row?);
    }

    let mut stmt = conn.prepare(
        "SELECT id, name, deleted_at FROM notebooks
         WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC",
    )?;
    for row in stmt.query_map([], |r| {
        Ok(TrashItem {
            id: r.get(0)?,
            kind: "notebook".into(),
            title: r.get(1)?,
            parent_label: String::new(),
            deleted_at: r.get(2)?,
        })
    })? {
        out.push(row?);
    }

    out.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
    Ok(out)
}

#[tauri::command]
pub fn trash_restore(state: State<'_, AppState>, kind: String, id: String) -> Result<()> {
    let conn = state.conn.lock().unwrap();
    match kind.as_str() {
        "page" => {
            conn.execute("UPDATE pages SET deleted_at = NULL WHERE id = ?1", [&id])?;
        }
        "section" => {
            // 只还原随本分区一起被删掉的页面（时间戳相同），
            // 之前单独删掉的页面应该继续留在回收站里
            let ts: Option<i64> = conn
                .query_row("SELECT deleted_at FROM sections WHERE id = ?1", [&id], |r| {
                    r.get(0)
                })
                .optional()?
                .flatten();
            conn.execute("UPDATE sections SET deleted_at = NULL WHERE id = ?1", [&id])?;
            if let Some(ts) = ts {
                conn.execute(
                    "UPDATE pages SET deleted_at = NULL WHERE section_id = ?1 AND deleted_at = ?2",
                    params![id, ts],
                )?;
            }
        }
        "notebook" => {
            let ts: Option<i64> = conn
                .query_row(
                    "SELECT deleted_at FROM notebooks WHERE id = ?1",
                    [&id],
                    |r| r.get(0),
                )
                .optional()?
                .flatten();
            conn.execute("UPDATE notebooks SET deleted_at = NULL WHERE id = ?1", [&id])?;
            if let Some(ts) = ts {
                conn.execute(
                    "UPDATE sections SET deleted_at = NULL WHERE notebook_id = ?1 AND deleted_at = ?2",
                    params![id, ts],
                )?;
                conn.execute(
                    "UPDATE pages SET deleted_at = NULL WHERE deleted_at = ?1 AND section_id IN
                     (SELECT id FROM sections WHERE notebook_id = ?2)",
                    params![ts, id],
                )?;
            }
        }
        _ => return Err(AppError::msg("未知的回收站条目类型")),
    }
    Ok(())
}

#[tauri::command]
pub fn trash_purge(state: State<'_, AppState>, kind: String, id: String) -> Result<()> {
    let conn = state.conn.lock().unwrap();
    let table = match kind.as_str() {
        "page" => "pages",
        "section" => "sections",
        "notebook" => "notebooks",
        _ => return Err(AppError::msg("未知的回收站条目类型")),
    };
    conn.execute(&format!("DELETE FROM {table} WHERE id = ?1"), [&id])?;
    Ok(())
}

#[tauri::command]
pub fn trash_empty(state: State<'_, AppState>) -> Result<()> {
    let conn = state.conn.lock().unwrap();
    conn.execute("DELETE FROM pages WHERE deleted_at IS NOT NULL", [])?;
    conn.execute("DELETE FROM sections WHERE deleted_at IS NOT NULL", [])?;
    conn.execute("DELETE FROM notebooks WHERE deleted_at IS NOT NULL", [])?;
    Ok(())
}

// ─────────────────────────── 设置 / 统计 ───────────────────────────

#[tauri::command]
pub fn setting_get(state: State<'_, AppState>, key: String) -> Result<Option<String>> {
    let conn = state.conn.lock().unwrap();
    let v: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key = ?1", [&key], |r| {
            r.get(0)
        })
        .optional()?;
    Ok(v)
}

#[tauri::command]
pub fn setting_set(state: State<'_, AppState>, key: String, value: String) -> Result<()> {
    let conn = state.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = ?2",
        params![key, value],
    )?;
    Ok(())
}

#[tauri::command]
pub fn stats(state: State<'_, AppState>) -> Result<Stats> {
    let conn = state.conn.lock().unwrap();
    let notebooks: i64 = conn.query_row(
        "SELECT COUNT(*) FROM notebooks WHERE deleted_at IS NULL",
        [],
        |r| r.get(0),
    )?;
    let sections: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sections WHERE deleted_at IS NULL",
        [],
        |r| r.get(0),
    )?;
    let pages: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pages WHERE deleted_at IS NULL",
        [],
        |r| r.get(0),
    )?;
    let words: i64 = conn.query_row(
        "SELECT COALESCE(SUM(LENGTH(plain_text)), 0) FROM pages WHERE deleted_at IS NULL",
        [],
        |r| r.get(0),
    )?;
    let attachments: i64 = conn.query_row("SELECT COUNT(*) FROM attachments", [], |r| r.get(0))?;
    let db_size = std::fs::metadata(state.data_dir.join(crate::db::DATABASE_FILE))
        .map(|m| m.len() as i64)
        .unwrap_or(0);
    Ok(Stats {
        notebooks,
        sections,
        pages,
        words,
        attachments,
        db_size,
        data_dir: state.data_dir.to_string_lossy().to_string(),
    })
}

/// 在访达里打开数据目录（自己实现，免去 opener 插件的路径作用域配置）
#[tauri::command]
pub fn open_data_dir(state: State<'_, AppState>) -> Result<()> {
    let dir = state.data_dir.clone();
    std::process::Command::new("open")
        .arg(&dir)
        .spawn()
        .map_err(|e| AppError::msg(format!("无法打开数据目录：{e}")))?;
    Ok(())
}

// ─────────────────────────── 备份 ───────────────────────────

const BACKUP_FORMAT: &str = "reunote-backup";
// The row and attachment schema has remained stable, so historical backups can be restored safely.
const LEGACY_JINYAN_BACKUP_FORMAT: &str = "jinyan-notes-backup";

fn is_supported_backup_format(root: &serde_json::Value) -> bool {
    matches!(
        root.get("format").and_then(|value| value.as_str()),
        Some(BACKUP_FORMAT) | Some(LEGACY_JINYAN_BACKUP_FORMAT)
    )
}

/// 备份不含 settings 表：里面存着 AI 服务的 API Key，
/// 备份文件可能被用户拷来拷去，不应该把密钥一起带走。
#[tauri::command]
pub fn backup_export(state: State<'_, AppState>, path: String, include_attachments: bool) -> Result<i64> {
    let conn = state.conn.lock().unwrap();
    let mut root = serde_json::Map::new();
    root.insert("format".into(), serde_json::json!(BACKUP_FORMAT));
    root.insert("version".into(), serde_json::json!(1));
    root.insert("exportedAt".into(), serde_json::json!(now_ms()));

    macro_rules! dump {
        ($table:expr, $cols:expr) => {{
            let cols: Vec<&str> = $cols;
            let sql = format!("SELECT {} FROM {}", cols.join(", "), $table);
            let mut stmt = conn.prepare(&sql)?;
            let n = cols.len();
            let rows = stmt.query_map([], |r| {
                let mut obj = serde_json::Map::new();
                for (i, c) in cols.iter().enumerate() {
                    let v: rusqlite::types::Value = r.get(i)?;
                    let jv = match v {
                        rusqlite::types::Value::Null => serde_json::Value::Null,
                        rusqlite::types::Value::Integer(x) => serde_json::json!(x),
                        rusqlite::types::Value::Real(x) => serde_json::json!(x),
                        rusqlite::types::Value::Text(x) => serde_json::json!(x),
                        rusqlite::types::Value::Blob(x) => serde_json::json!(
                            base64::engine::general_purpose::STANDARD.encode(x)
                        ),
                    };
                    obj.insert((*c).to_string(), jv);
                }
                let _ = n;
                Ok(serde_json::Value::Object(obj))
            })?;
            let list = rows.collect::<std::result::Result<Vec<_>, _>>()?;
            serde_json::Value::Array(list)
        }};
    }

    root.insert(
        "notebooks".into(),
        dump!(
            "notebooks",
            vec![
                "id",
                "name",
                "color",
                "icon",
                "sort_order",
                "created_at",
                "updated_at",
                "deleted_at"
            ]
        ),
    );
    root.insert(
        "sections".into(),
        dump!(
            "sections",
            vec![
                "id",
                "notebook_id",
                "name",
                "color",
                "sort_order",
                "created_at",
                "updated_at",
                "deleted_at"
            ]
        ),
    );
    root.insert(
        "pages".into(),
        dump!(
            "pages",
            vec![
                "id",
                "section_id",
                "parent_id",
                "title",
                "content",
                "plain_text",
                "sort_order",
                "favorite",
                "created_at",
                "updated_at",
                "deleted_at"
            ]
        ),
    );
    root.insert(
        "versions".into(),
        dump!(
            "versions",
            vec!["id", "page_id", "title", "content", "label", "created_at"]
        ),
    );
    root.insert("tags".into(), dump!("tags", vec!["id", "name", "color"]));
    root.insert(
        "page_tags".into(),
        dump!("page_tags", vec!["page_id", "tag_id"]),
    );
    root.insert("links".into(), dump!("links", vec!["from_page", "to_page"]));
    root.insert(
        "attachments".into(),
        dump!(
            "attachments",
            vec!["id", "page_id", "filename", "mime", "size", "created_at"]
        ),
    );

    if include_attachments {
        let dir = files::attachments_dir(&state.data_dir);
        let mut blobs = serde_json::Map::new();
        if dir.exists() {
            for entry in std::fs::read_dir(&dir)? {
                let entry = entry?;
                if entry.path().is_file() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    let bytes = std::fs::read(entry.path())?;
                    blobs.insert(
                        name,
                        serde_json::json!(
                            base64::engine::general_purpose::STANDARD.encode(bytes)
                        ),
                    );
                }
            }
        }
        root.insert("blobs".into(), serde_json::Value::Object(blobs));
    }

    let text = serde_json::to_string(&serde_json::Value::Object(root))?;
    std::fs::write(&path, &text)?;
    Ok(text.len() as i64)
}

#[tauri::command]
pub fn backup_import(state: State<'_, AppState>, path: String) -> Result<i64> {
    let text = std::fs::read_to_string(&path)?;
    let root: serde_json::Value = serde_json::from_str(&text)?;
    if !is_supported_backup_format(&root) {
        return Err(AppError::msg("这不是可恢复的笔记备份文件"));
    }
    let conn = state.conn.lock().unwrap();

    fn as_sql(v: &serde_json::Value) -> rusqlite::types::Value {
        match v {
            serde_json::Value::Null => rusqlite::types::Value::Null,
            serde_json::Value::Bool(b) => rusqlite::types::Value::Integer(*b as i64),
            serde_json::Value::Number(n) => {
                if let Some(i) = n.as_i64() {
                    rusqlite::types::Value::Integer(i)
                } else {
                    rusqlite::types::Value::Real(n.as_f64().unwrap_or(0.0))
                }
            }
            serde_json::Value::String(s) => rusqlite::types::Value::Text(s.clone()),
            other => rusqlite::types::Value::Text(other.to_string()),
        }
    }

    // ⚠️ INSERT OR REPLACE 在 SQLite 里是「先 DELETE 冲突行再 INSERT」。
    // 本库的 sections/pages/versions/page_tags/links/recents 全部是 ON DELETE CASCADE，
    // 若开着外键直接 REPLACE 笔记本，会把它名下所有分区、页面、版本历史级联删光——
    // 包括备份之后新建、根本不在备份文件里的内容。
    // 因此这里必须先关外键、再包一个事务，失败整体回滚。
    conn.execute_batch("PRAGMA foreign_keys = OFF;")?;
    let outcome = import_rows(&conn, &root, as_sql);
    match &outcome {
        Ok(_) => {
            conn.execute_batch("COMMIT;")?;
        }
        Err(_) => {
            let _ = conn.execute_batch("ROLLBACK;");
        }
    }
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    let imported = outcome?;

    if let Some(blobs) = root.get("blobs").and_then(|v| v.as_object()) {
        let dir = files::attachments_dir(&state.data_dir);
        std::fs::create_dir_all(&dir)?;
        for (name, val) in blobs {
            if let Some(b64) = val.as_str() {
                let bytes = base64::engine::general_purpose::STANDARD.decode(b64.as_bytes())?;
                std::fs::write(dir.join(files::sanitize_name(name)), bytes)?;
            }
        }
    }

    Ok(imported)
}

fn import_rows(
    conn: &Connection,
    root: &serde_json::Value,
    as_sql: fn(&serde_json::Value) -> rusqlite::types::Value,
) -> Result<i64> {
    conn.execute_batch("BEGIN;")?;
    let mut imported = 0i64;

    for (table, cols) in [
        (
            "notebooks",
            vec![
                "id",
                "name",
                "color",
                "icon",
                "sort_order",
                "created_at",
                "updated_at",
                "deleted_at",
            ],
        ),
        (
            "sections",
            vec![
                "id",
                "notebook_id",
                "name",
                "color",
                "sort_order",
                "created_at",
                "updated_at",
                "deleted_at",
            ],
        ),
        (
            "pages",
            vec![
                "id",
                "section_id",
                "parent_id",
                "title",
                "content",
                "plain_text",
                "sort_order",
                "favorite",
                "created_at",
                "updated_at",
                "deleted_at",
            ],
        ),
        ("tags", vec!["id", "name", "color"]),
        ("page_tags", vec!["page_id", "tag_id"]),
        ("links", vec!["from_page", "to_page"]),
        (
            "versions",
            vec!["id", "page_id", "title", "content", "label", "created_at"],
        ),
        (
            "attachments",
            vec!["id", "page_id", "filename", "mime", "size", "created_at"],
        ),
    ] {
        let Some(arr) = root.get(table).and_then(|v| v.as_array()) else {
            continue;
        };
        let placeholders: Vec<String> = (1..=cols.len()).map(|i| format!("?{i}")).collect();
        let sql = format!(
            "INSERT OR REPLACE INTO {table} ({}) VALUES ({})",
            cols.join(", "),
            placeholders.join(", ")
        );
        let mut stmt = conn.prepare(&sql)?;
        for item in arr {
            let values: Vec<rusqlite::types::Value> = cols
                .iter()
                .map(|c| as_sql(item.get(*c).unwrap_or(&serde_json::Value::Null)))
                .collect();
            stmt.execute(rusqlite::params_from_iter(values.iter()))?;
            imported += 1;
        }
    }

    Ok(imported)
}

#[cfg(test)]
mod backup_format_tests {
    use super::*;

    #[test]
    fn accepts_current_and_jinyan_backup_formats() {
        assert!(is_supported_backup_format(&serde_json::json!({ "format": BACKUP_FORMAT })));
        assert!(is_supported_backup_format(&serde_json::json!({
            "format": LEGACY_JINYAN_BACKUP_FORMAT
        })));
        assert!(!is_supported_backup_format(&serde_json::json!({ "format": "unknown" })));
        assert!(!is_supported_backup_format(&serde_json::json!({})));
    }
}

#[cfg(test)]
mod agent_section_tests {
    use super::*;

    const NOTEBOOK_ID: &str = "notebook-agent-test";
    const SOURCE_SECTION_ID: &str = "section-source";
    const PARENT_PAGE_ID: &str = "page-parent";
    const CHILD_PAGE_ID: &str = "page-child";
    const ATTACHMENT_ID: &str = "source-image.png";

    struct TestDb {
        root: PathBuf,
        conn: Connection,
    }

    impl Drop for TestDb {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn fixture() -> TestDb {
        let root = std::env::temp_dir().join(format!("reunote-agent-section-{}", new_id()));
        std::fs::create_dir_all(files::attachments_dir(&root)).unwrap();
        let conn = crate::db::open(&root.join(crate::db::DATABASE_FILE)).unwrap();
        conn.execute(
            "INSERT INTO notebooks
             (id, name, color, icon, sort_order, created_at, updated_at)
             VALUES (?1, '测试笔记本', '#111111', 'book', 1000, 10, 10)",
            [NOTEBOOK_ID],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sections
             (id, notebook_id, name, color, sort_order, created_at, updated_at)
             VALUES (?1, ?2, '原始分区', '#2266aa', 2000, 20, 20)",
            params![SOURCE_SECTION_ID, NOTEBOOK_ID],
        )
        .unwrap();

        let parent_content = serde_json::json!({
            "version": 1,
            "background": "grid",
            "elements": [{
                "id": "image-element",
                "type": "image",
                "attachmentId": ATTACHMENT_ID,
                "src": files::asset_url(ATTACHMENT_ID)
            }],
            "strokes": []
        })
        .to_string();
        conn.execute(
            "INSERT INTO pages
             (id, section_id, parent_id, title, content, plain_text, sort_order, favorite, created_at, updated_at)
             VALUES (?1, ?2, NULL, '父页面', ?3, '父页面正文 #测试', 1000, 1, 30, 30)",
            params![PARENT_PAGE_ID, SOURCE_SECTION_ID, parent_content],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO pages
             (id, section_id, parent_id, title, content, plain_text, sort_order, favorite, created_at, updated_at)
             VALUES (?1, ?2, ?3, '子页面', ?4, '链接到 [[目标页]]', 2000, 0, 31, 31)",
            params![
                CHILD_PAGE_ID,
                SOURCE_SECTION_ID,
                PARENT_PAGE_ID,
                serde_json::json!({
                    "version": 1,
                    "background": "dots",
                    "elements": [],
                    "strokes": []
                })
                .to_string()
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO tags (id, name, color) VALUES ('tag-1', '测试', '#333333')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO page_tags (page_id, tag_id) VALUES (?1, 'tag-1')",
            [PARENT_PAGE_ID],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO links (from_page, to_page) VALUES (?1, '目标页')",
            [CHILD_PAGE_ID],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO attachments (id, page_id, filename, mime, size, created_at)
             VALUES (?1, ?2, '公式.png', 'image/png', 4, 40)",
            params![ATTACHMENT_ID, PARENT_PAGE_ID],
        )
        .unwrap();
        std::fs::write(files::attachments_dir(&root).join(ATTACHMENT_ID), b"image").unwrap();
        TestDb { root, conn }
    }

    fn mapped_page<'a>(result: &'a AgentSectionDuplicateResult, source_page_id: &str) -> &'a str {
        result
            .page_map
            .iter()
            .find(|entry| entry.source_page_id == source_page_id)
            .map(|entry| entry.draft_page_id.as_str())
            .unwrap()
    }

    #[test]
    fn duplicates_section_hierarchy_relations_and_attachment_files() {
        let mut db = fixture();
        let result = section_duplicate_for_agent_impl(
            &mut db.conn,
            &db.root,
            SOURCE_SECTION_ID,
            Some(CHILD_PAGE_ID),
        )
        .unwrap();

        assert_eq!(result.source_section.id, SOURCE_SECTION_ID);
        assert_eq!(result.draft_section.name, "原始分区（AI 草稿）");
        assert_eq!(result.page_map.len(), 2);
        let draft_parent = mapped_page(&result, PARENT_PAGE_ID);
        let draft_child = mapped_page(&result, CHILD_PAGE_ID);
        assert_eq!(result.current_draft_page_id.as_deref(), Some(draft_child));

        let child_parent: Option<String> = db
            .conn
            .query_row(
                "SELECT parent_id FROM pages WHERE id = ?1",
                [draft_child],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(child_parent.as_deref(), Some(draft_parent));

        let copied_tag_count: i64 = db
            .conn
            .query_row(
                "SELECT COUNT(*) FROM page_tags WHERE page_id = ?1 AND tag_id = 'tag-1'",
                [draft_parent],
                |r| r.get(0),
            )
            .unwrap();
        let copied_link_count: i64 = db
            .conn
            .query_row(
                "SELECT COUNT(*) FROM links WHERE from_page = ?1 AND to_page = '目标页'",
                [draft_child],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(copied_tag_count, 1);
        assert_eq!(copied_link_count, 1);

        let (draft_attachment_id, draft_content): (String, String) = db
            .conn
            .query_row(
                "SELECT a.id, p.content FROM attachments a
                 JOIN pages p ON p.id = a.page_id WHERE a.page_id = ?1",
                [draft_parent],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_ne!(draft_attachment_id, ATTACHMENT_ID);
        assert_eq!(
            std::fs::read(files::attachments_dir(&db.root).join(&draft_attachment_id)).unwrap(),
            b"image"
        );
        let draft_doc: serde_json::Value = serde_json::from_str(&draft_content).unwrap();
        let image = &draft_doc["elements"][0];
        assert_eq!(image["attachmentId"], draft_attachment_id);
        assert_eq!(image["src"], files::asset_url(&draft_attachment_id));
    }

    #[test]
    fn duplicates_page_relations_and_attachment_files_independently() {
        let mut db = fixture();
        db.conn
            .execute(
                "INSERT INTO links (from_page, to_page) VALUES (?1, '页面副本目标')",
                [PARENT_PAGE_ID],
            )
            .unwrap();

        let duplicate_id =
            page_duplicate_impl(&mut db.conn, &db.root, PARENT_PAGE_ID).unwrap();
        let (title, content): (String, String) = db
            .conn
            .query_row(
                "SELECT title, content FROM pages WHERE id = ?1",
                [&duplicate_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(title, "父页面 副本");

        let copied_tag_count: i64 = db
            .conn
            .query_row(
                "SELECT COUNT(*) FROM page_tags WHERE page_id = ?1 AND tag_id = 'tag-1'",
                [&duplicate_id],
                |row| row.get(0),
            )
            .unwrap();
        let copied_link_count: i64 = db
            .conn
            .query_row(
                "SELECT COUNT(*) FROM links WHERE from_page = ?1 AND to_page = '页面副本目标'",
                [&duplicate_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(copied_tag_count, 1);
        assert_eq!(copied_link_count, 1);

        let duplicate_attachment_id: String = db
            .conn
            .query_row(
                "SELECT id FROM attachments WHERE page_id = ?1",
                [&duplicate_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_ne!(duplicate_attachment_id, ATTACHMENT_ID);
        assert_eq!(
            std::fs::read(files::attachments_dir(&db.root).join(&duplicate_attachment_id))
                .unwrap(),
            b"image"
        );
        assert_eq!(
            std::fs::read(files::attachments_dir(&db.root).join(ATTACHMENT_ID)).unwrap(),
            b"image"
        );

        let copied_doc: serde_json::Value = serde_json::from_str(&content).unwrap();
        let image = &copied_doc["elements"][0];
        assert_eq!(image["attachmentId"], duplicate_attachment_id);
        assert_eq!(image["src"], files::asset_url(&duplicate_attachment_id));
    }

    #[test]
    fn adopts_draft_by_preserving_source_section_and_trashing_old_pages_together() {
        let mut db = fixture();
        let duplicate = section_duplicate_for_agent_impl(
            &mut db.conn,
            &db.root,
            SOURCE_SECTION_ID,
            Some(PARENT_PAGE_ID),
        )
        .unwrap();
        let draft_id = duplicate.draft_section.id.clone();
        let draft_page_ids: Vec<String> = duplicate
            .page_map
            .iter()
            .map(|entry| entry.draft_page_id.clone())
            .collect();

        let adopted = section_adopt_agent_draft_impl(
            &mut db.conn,
            SOURCE_SECTION_ID,
            &draft_id,
            &duplicate.source_snapshot,
            Some(mapped_page(&duplicate, CHILD_PAGE_ID)),
        )
        .unwrap();
        assert_eq!(adopted.source_section.id, SOURCE_SECTION_ID);
        assert_eq!(adopted.source_section.name, "原始分区");
        assert_eq!(adopted.source_section.sort_order, 2000.0);
        assert_eq!(adopted.adopted_page_ids, draft_page_ids);
        assert_eq!(
            adopted.current_page_id.as_deref(),
            Some(mapped_page(&duplicate, CHILD_PAGE_ID))
        );

        let (backup_name, backup_deleted_at): (String, Option<i64>) = db
            .conn
            .query_row(
                "SELECT name, deleted_at FROM sections WHERE id = ?1",
                [&draft_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(backup_name, "原始分区（AI 替换前）");
        let backup_deleted_at = backup_deleted_at.unwrap();

        for old_page_id in [PARENT_PAGE_ID, CHILD_PAGE_ID] {
            let (section_id, deleted_at): (String, Option<i64>) = db
                .conn
                .query_row(
                    "SELECT section_id, deleted_at FROM pages WHERE id = ?1",
                    [old_page_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            assert_eq!(section_id, draft_id);
            assert_eq!(deleted_at, Some(backup_deleted_at));
        }
        for page_id in &draft_page_ids {
            let (section_id, deleted_at): (String, Option<i64>) = db
                .conn
                .query_row(
                    "SELECT section_id, deleted_at FROM pages WHERE id = ?1",
                    [page_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            assert_eq!(section_id, SOURCE_SECTION_ID);
            assert_eq!(deleted_at, None);
        }
    }

    #[test]
    fn rejects_stale_source_snapshot_without_partially_swapping_pages() {
        let mut db = fixture();
        let duplicate =
            section_duplicate_for_agent_impl(&mut db.conn, &db.root, SOURCE_SECTION_ID, None)
                .unwrap();
        db.conn
            .execute(
                "UPDATE pages SET title = '用户刚刚修改', updated_at = 999 WHERE id = ?1",
                [PARENT_PAGE_ID],
            )
            .unwrap();

        let error = section_adopt_agent_draft_impl(
            &mut db.conn,
            SOURCE_SECTION_ID,
            &duplicate.draft_section.id,
            &duplicate.source_snapshot,
            None,
        )
        .unwrap_err();
        assert!(error.to_string().contains("已发生变化"));

        let source_count: i64 = db
            .conn
            .query_row(
                "SELECT COUNT(*) FROM pages WHERE section_id = ?1 AND deleted_at IS NULL",
                [SOURCE_SECTION_ID],
                |r| r.get(0),
            )
            .unwrap();
        let draft_count: i64 = db
            .conn
            .query_row(
                "SELECT COUNT(*) FROM pages WHERE section_id = ?1 AND deleted_at IS NULL",
                [&duplicate.draft_section.id],
                |r| r.get(0),
            )
            .unwrap();
        let draft_deleted_at: Option<i64> = db
            .conn
            .query_row(
                "SELECT deleted_at FROM sections WHERE id = ?1",
                [&duplicate.draft_section.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(source_count, 2);
        assert_eq!(draft_count, 2);
        assert_eq!(draft_deleted_at, None);
    }

    #[test]
    fn removes_database_draft_when_attachment_copy_fails() {
        let mut db = fixture();
        std::fs::remove_file(files::attachments_dir(&db.root).join(ATTACHMENT_ID)).unwrap();

        let error =
            section_duplicate_for_agent_impl(&mut db.conn, &db.root, SOURCE_SECTION_ID, None)
                .unwrap_err();
        assert!(error.to_string().contains("复制附件"));

        let section_count: i64 = db
            .conn
            .query_row("SELECT COUNT(*) FROM sections", [], |r| r.get(0))
            .unwrap();
        let page_count: i64 = db
            .conn
            .query_row("SELECT COUNT(*) FROM pages", [], |r| r.get(0))
            .unwrap();
        let remaining_files = std::fs::read_dir(files::attachments_dir(&db.root))
            .unwrap()
            .count();
        assert_eq!(section_count, 1);
        assert_eq!(page_count, 2);
        assert_eq!(remaining_files, 0);
    }
}

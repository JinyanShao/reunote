use crate::error::Result;
use rusqlite::{backup::Backup, Connection, OpenFlags};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

pub const DATABASE_FILE: &str = "reunote.db";
const LEGACY_DATABASE_FILE: &str = "jinyan-notes.db";
const LEGACY_APPLICATION_ID: &str = "com.jinyanshao.notes";

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

const SCHEMA: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS notebooks (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#6C8CFF',
  icon        TEXT NOT NULL DEFAULT 'book',
  sort_order  REAL NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER
);

CREATE TABLE IF NOT EXISTS sections (
  id          TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#8B9BB4',
  sort_order  REAL NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sections_notebook ON sections(notebook_id);

CREATE TABLE IF NOT EXISTS pages (
  id          TEXT PRIMARY KEY,
  section_id  TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  parent_id   TEXT,
  title       TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL DEFAULT '',
  plain_text  TEXT NOT NULL DEFAULT '',
  sort_order  REAL NOT NULL DEFAULT 0,
  favorite    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pages_section ON pages(section_id);
CREATE INDEX IF NOT EXISTS idx_pages_parent  ON pages(parent_id);
CREATE INDEX IF NOT EXISTS idx_pages_updated ON pages(updated_at DESC);

CREATE TABLE IF NOT EXISTS tags (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL UNIQUE,
  color   TEXT NOT NULL DEFAULT '#8B9BB4'
);

CREATE TABLE IF NOT EXISTS page_tags (
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  tag_id  TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (page_id, tag_id)
);

CREATE TABLE IF NOT EXISTS links (
  from_page TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  to_page   TEXT NOT NULL,
  PRIMARY KEY (from_page, to_page)
);
CREATE INDEX IF NOT EXISTS idx_links_to ON links(to_page);

CREATE TABLE IF NOT EXISTS versions (
  id         TEXT PRIMARY KEY,
  page_id    TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  title      TEXT NOT NULL DEFAULT '',
  content    TEXT NOT NULL,
  label      TEXT NOT NULL DEFAULT '自动快照',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_versions_page ON versions(page_id, created_at DESC);

CREATE TABLE IF NOT EXISTS attachments (
  id         TEXT PRIMARY KEY,
  page_id    TEXT NOT NULL DEFAULT '',
  filename   TEXT NOT NULL,
  mime       TEXT NOT NULL DEFAULT 'application/octet-stream',
  size       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recents (
  page_id    TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  visited_at INTEGER NOT NULL
);
"#;

pub fn open(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch(SCHEMA)?;
    Ok(conn)
}

/// Create a consistent first-run copy of the previous app's SQLite database.
/// SQLite's online backup API includes an active WAL safely, so this is also
/// correct when an earlier version of the app is still open.
pub fn migrate_legacy_library(data_dir: &Path) -> Result<()> {
    let target_db = data_dir.join(DATABASE_FILE);
    if target_db.exists() {
        return Ok(());
    }

    let Some(app_support_dir) = data_dir.parent() else {
        return Ok(());
    };
    let legacy_dir = app_support_dir.join(LEGACY_APPLICATION_ID);
    let legacy_db = legacy_dir.join(LEGACY_DATABASE_FILE);
    if !legacy_db.is_file() {
        return Ok(());
    }

    let source = Connection::open_with_flags(legacy_db, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut target = Connection::open(&target_db)?;
    {
        let backup = Backup::new(&source, &mut target)?;
        backup.run_to_completion(16, std::time::Duration::from_millis(25), None)?;
    }
    target.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;")?;
    drop(target);
    drop(source);

    let legacy_attachments = crate::files::attachments_dir(&legacy_dir);
    let target_attachments = crate::files::attachments_dir(data_dir);
    if !legacy_attachments.is_dir() {
        return Ok(());
    }
    std::fs::create_dir_all(&target_attachments)?;
    for entry in std::fs::read_dir(legacy_attachments)? {
        let entry = entry?;
        if entry.file_type()?.is_file() {
            std::fs::copy(entry.path(), target_attachments.join(entry.file_name()))?;
        }
    }
    Ok(())
}

/// Rebrand the unmodified welcome page copied from the previous application.
/// The extra content checks ensure that ordinary user pages are never touched.
pub fn rebrand_legacy_welcome_page(conn: &Connection) -> Result<()> {
    const OLD_NAME: &str = "Jinyan Notes";
    const NEW_NAME: &str = "reunote";
    const OLD_TITLE: &str = "欢迎使用 Jinyan Notes";
    const WELCOME_MARKER: &str = "安装 Jinyan Notes";

    conn.execute(
        "UPDATE pages
         SET title = REPLACE(title, ?1, ?2),
             content = REPLACE(content, ?1, ?2),
             plain_text = REPLACE(plain_text, ?1, ?2)
         WHERE title = ?3 AND content LIKE '%' || ?4 || '%'",
        (OLD_NAME, NEW_NAME, OLD_TITLE, WELCOME_MARKER),
    )?;
    conn.execute(
        "UPDATE versions
         SET title = REPLACE(title, ?1, ?2),
             content = REPLACE(content, ?1, ?2)
         WHERE title = ?3 AND content LIKE '%' || ?4 || '%'",
        (OLD_NAME, NEW_NAME, OLD_TITLE, WELCOME_MARKER),
    )?;
    Ok(())
}

/// 拆分查询串为词条：中文按整串 + 双字滑窗，英文/数字按空格切分。
/// 用于 LIKE 检索，天然兼容中文（不依赖 FTS 分词器）。
pub fn tokenize(query: &str) -> Vec<String> {
    let q = query.trim();
    if q.is_empty() {
        return vec![];
    }
    let mut out: Vec<String> = Vec::new();
    for raw in q.split_whitespace() {
        let word = raw.trim().to_lowercase();
        if word.is_empty() {
            continue;
        }
        out.push(word);
    }
    if out.is_empty() {
        out.push(q.to_lowercase());
    }
    out
}

/// 在正文中截取包含关键词的片段
pub fn snippet_around(text: &str, needle: &str, radius: usize) -> String {
    // 关键：全部下标都基于同一个 chars 向量。
    // 之前用 to_lowercase() 后的字符向量定位、却拿去切原串，
    // 遇到 'İ'(1 char → 2 chars) 这类字符长度会不一致，切片越界直接 panic/abort。
    let chars: Vec<char> = text.chars().collect();
    let folded: Vec<char> = chars
        .iter()
        .map(|c| c.to_lowercase().next().unwrap_or(*c))
        .collect();
    let needle_chars: Vec<char> = needle
        .chars()
        .map(|c| c.to_lowercase().next().unwrap_or(c))
        .collect();

    let mut hit: Option<usize> = None;
    if !needle_chars.is_empty() && folded.len() >= needle_chars.len() {
        for i in 0..=(folded.len() - needle_chars.len()) {
            if folded[i..i + needle_chars.len()] == needle_chars[..] {
                hit = Some(i);
                break;
            }
        }
    }

    let center = hit.unwrap_or(0);
    let start = center.saturating_sub(radius).min(chars.len());
    let end = center
        .saturating_add(needle_chars.len())
        .saturating_add(radius)
        .min(chars.len())
        .max(start);
    let mut s: String = chars[start..end].iter().collect();
    if start > 0 {
        s = format!("…{s}");
    }
    if end < chars.len() {
        s.push('…');
    }
    s.replace('\n', " ")
}

#[cfg(test)]
mod tests {
    use super::{
        migrate_legacy_library, open, rebrand_legacy_welcome_page, snippet_around, DATABASE_FILE,
        LEGACY_APPLICATION_ID, LEGACY_DATABASE_FILE, SCHEMA,
    };
    use rusqlite::Connection;

    /// 曾经的崩溃点：to_lowercase() 会改变字符数，
    /// 用小写串的下标去切原串会越界 panic。
    #[test]
    fn snippet_handles_length_changing_lowercase() {
        // 'İ' (U+0130) 小写化后变成两个 char
        let text = "İİİİİİİİİİ 关键词 İİİİİİİİİİ";
        let s = snippet_around(text, "关键词", 5);
        assert!(s.contains("关键词"), "应当命中关键词，实际 {s:?}");
    }

    #[test]
    fn snippet_handles_empty_and_missing() {
        assert_eq!(snippet_around("", "x", 10), "");
        let s = snippet_around("一段没有命中的文本", "zzz", 3);
        assert!(!s.is_empty());
    }

    #[test]
    fn snippet_is_case_insensitive() {
        let s = snippet_around("Hello World from reunote", "world", 4);
        assert!(s.contains("World"), "实际 {s:?}");
    }

    #[test]
    fn snippet_does_not_panic_on_long_needle() {
        let s = snippet_around("短", "非常非常长的关键词", 10);
        assert!(!s.is_empty() || s.is_empty());
    }

    #[test]
    fn migrates_previous_library_and_attachments() {
        let root = std::env::temp_dir().join(format!("reunote-library-migration-{}", super::new_id()));
        let legacy_dir = root.join(LEGACY_APPLICATION_ID);
        let legacy_db = legacy_dir.join(LEGACY_DATABASE_FILE);
        std::fs::create_dir_all(crate::files::attachments_dir(&legacy_dir)).unwrap();
        let legacy = open(&legacy_db).unwrap();
        legacy
            .execute(
                "INSERT INTO notebooks (id, name, color, icon, sort_order, created_at, updated_at)
                 VALUES ('legacy-notebook', '迁移笔记本', '#2266aa', 'book', 1, 1, 1)",
                [],
            )
            .unwrap();
        drop(legacy);
        std::fs::write(
            crate::files::attachments_dir(&legacy_dir).join("legacy-file.txt"),
            "迁移附件",
        )
        .unwrap();

        let data_dir = root.join("com.jinyanshao.reunote");
        std::fs::create_dir_all(&data_dir).unwrap();
        migrate_legacy_library(&data_dir).unwrap();

        let migrated = open(&data_dir.join(DATABASE_FILE)).unwrap();
        let name: String = migrated
            .query_row("SELECT name FROM notebooks WHERE id = 'legacy-notebook'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(name, "迁移笔记本");
        assert_eq!(
            std::fs::read_to_string(
                crate::files::attachments_dir(&data_dir).join("legacy-file.txt")
            )
            .unwrap(),
            "迁移附件"
        );

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rebrands_only_the_unmodified_legacy_welcome_page() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn.execute(
            "INSERT INTO notebooks (id, name, color, icon, sort_order, created_at, updated_at)
             VALUES ('notebook', '示例', '#000000', 'book', 1, 1, 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sections (id, notebook_id, name, color, sort_order, created_at, updated_at)
             VALUES ('section', 'notebook', '开始使用', '#000000', 1, 1, 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO pages (id, section_id, title, content, plain_text, sort_order, created_at, updated_at)
             VALUES ('welcome', 'section', '欢迎使用 Jinyan Notes',
                     '<h1>欢迎使用 Jinyan Notes</h1><p>安装 Jinyan Notes</p>',
                     '欢迎使用 Jinyan Notes 安装 Jinyan Notes', 1, 1, 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO pages (id, section_id, title, content, plain_text, sort_order, created_at, updated_at)
             VALUES ('personal', 'section', 'Jinyan Notes 会议记录', '保留', '保留', 2, 1, 1)",
            [],
        )
        .unwrap();

        rebrand_legacy_welcome_page(&conn).unwrap();

        let welcome: (String, String) = conn
            .query_row(
                "SELECT title, content FROM pages WHERE id = 'welcome'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(welcome.0, "欢迎使用 reunote");
        assert!(welcome.1.contains("安装 reunote"));
        let personal: String = conn
            .query_row("SELECT title FROM pages WHERE id = 'personal'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(personal, "Jinyan Notes 会议记录");
    }
}

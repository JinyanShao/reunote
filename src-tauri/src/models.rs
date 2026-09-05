use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Notebook {
    pub id: String,
    pub name: String,
    pub color: String,
    pub icon: String,
    pub sort_order: f64,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    pub id: String,
    pub notebook_id: String,
    pub name: String,
    pub color: String,
    pub sort_order: f64,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentPageClone {
    pub source_page_id: String,
    pub draft_page_id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentSectionDuplicateResult {
    pub source_section: Section,
    pub draft_section: Section,
    pub page_map: Vec<AgentPageClone>,
    pub current_draft_page_id: Option<String>,
    pub source_snapshot: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentSectionAdoptResult {
    pub source_section: Section,
    pub backup_section_id: String,
    pub current_page_id: Option<String>,
    pub adopted_page_ids: Vec<String>,
}

/// 页面元信息（不含正文，用于列表渲染）
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PageMeta {
    pub id: String,
    pub section_id: String,
    pub notebook_id: String,
    pub parent_id: Option<String>,
    pub title: String,
    pub preview: String,
    pub sort_order: f64,
    pub favorite: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
    pub tags: Vec<String>,
}

/// 页面完整内容
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub id: String,
    pub section_id: String,
    pub notebook_id: String,
    pub parent_id: Option<String>,
    pub title: String,
    pub content: String,
    pub sort_order: f64,
    pub favorite: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub tags: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub color: String,
    pub count: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub page_id: String,
    pub title: String,
    pub snippet: String,
    pub notebook_id: String,
    pub notebook_name: String,
    pub section_id: String,
    pub section_name: String,
    pub updated_at: i64,
    pub score: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VersionMeta {
    pub id: String,
    pub page_id: String,
    pub title: String,
    pub label: String,
    pub size: i64,
    pub created_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub page_id: String,
    pub filename: String,
    pub mime: String,
    pub size: i64,
    pub url: String,
    pub created_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Backlink {
    pub page_id: String,
    pub title: String,
    pub notebook_name: String,
    pub section_name: String,
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TrashItem {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub parent_label: String,
    pub deleted_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SavePayload {
    pub id: String,
    pub title: String,
    pub content: String,
    pub plain_text: String,
    #[serde(default)]
    pub links: Vec<String>,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub notebooks: i64,
    pub sections: i64,
    pub pages: i64,
    pub words: i64,
    pub attachments: i64,
    pub db_size: i64,
    pub data_dir: String,
}

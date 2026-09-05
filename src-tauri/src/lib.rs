pub mod ai;
mod commands;
mod db;
mod error;
mod files;
mod models;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager, RunEvent, State};

pub struct AppState {
    pub conn: Mutex<rusqlite::Connection>,
    pub data_dir: PathBuf,
    pub http: reqwest::Client,
    pub cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
    pub exit_ready: AtomicBool,
    pub exit_requested: AtomicBool,
}

#[tauri::command]
fn complete_exit(app: tauri::AppHandle, state: State<'_, AppState>) {
    state.exit_ready.store(true, Ordering::SeqCst);
    state.exit_requested.store(false, Ordering::SeqCst);
    app.exit(0);
}

#[tauri::command]
fn exit_request_pending(state: State<'_, AppState>) -> bool {
    state.exit_requested.load(Ordering::SeqCst)
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
            if let Ok(v) = u8::from_str_radix(hex, 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let about = PredefinedMenuItem::about(
        app,
        Some("关于 reunote"),
        Some(AboutMetadata {
            name: Some("reunote".into()),
            version: Some("1.0.0".into()),
            comments: Some("本地优先的自由画布笔记本 · 数据全部保存在你的 Mac 上".into()),
            ..Default::default()
        }),
    )?;
    let settings = MenuItem::with_id(app, "settings", "设置…", true, Some("CmdOrCtrl+,"))?;
    let app_menu = Submenu::with_items(
        app,
        "reunote",
        true,
        &[
            &about,
            &PredefinedMenuItem::separator(app)?,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "quit-app",
                "退出 reunote",
                true,
                Some("CmdOrCtrl+Q"),
            )?,
        ],
    )?;

    let file_menu = Submenu::with_items(
        app,
        "文件",
        true,
        &[
            &MenuItem::with_id(app, "new-page", "新建页面", true, Some("CmdOrCtrl+N"))?,
            &MenuItem::with_id(
                app,
                "new-section",
                "新建分区",
                true,
                Some("CmdOrCtrl+Shift+N"),
            )?,
            &MenuItem::with_id(app, "new-notebook", "新建笔记本", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "save-page", "保存", true, Some("CmdOrCtrl+S"))?,
            &MenuItem::with_id(
                app,
                "duplicate-page",
                "创建页面副本",
                true,
                Some("CmdOrCtrl+Shift+D"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "import-md", "导入 Markdown…", true, None::<&str>)?,
            &MenuItem::with_id(app, "import-pdf", "导入 PDF 批注…", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                "export-md",
                "导出当前页为 Markdown…",
                true,
                Some("CmdOrCtrl+Shift+E"),
            )?,
            &MenuItem::with_id(app, "export-png", "导出当前页为图片…", true, None::<&str>)?,
            &MenuItem::with_id(app, "export-pdf", "打印 / 导出 PDF…", true, Some("CmdOrCtrl+P"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "backup-export", "备份整个库…", true, None::<&str>)?,
            &MenuItem::with_id(app, "backup-import", "从备份恢复…", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, Some("关闭窗口"))?,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        app,
        "编辑",
        true,
        &[
            &MenuItem::with_id(app, "document-undo", "撤销", true, Some("CmdOrCtrl+Z"))?,
            &MenuItem::with_id(
                app,
                "document-redo",
                "重做",
                true,
                Some("CmdOrCtrl+Shift+Z"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some("剪切"))?,
            &PredefinedMenuItem::copy(app, Some("拷贝"))?,
            &PredefinedMenuItem::paste(app, Some("粘贴"))?,
            &PredefinedMenuItem::select_all(app, Some("全选"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "search", "全局搜索…", true, Some("CmdOrCtrl+K"))?,
            &MenuItem::with_id(app, "find-in-page", "在本页查找…", true, Some("CmdOrCtrl+F"))?,
            &MenuItem::with_id(app, "find-next", "查找下一个", true, Some("CmdOrCtrl+G"))?,
            &MenuItem::with_id(
                app,
                "find-previous",
                "查找上一个",
                true,
                Some("CmdOrCtrl+Shift+G"),
            )?,
        ],
    )?;

    let view_menu = Submenu::with_items(
        app,
        "显示",
        true,
        &[
            &MenuItem::with_id(app, "toggle-sidebar", "显示/隐藏边栏", true, Some("CmdOrCtrl+\\"))?,
            &MenuItem::with_id(app, "toggle-ai", "显示/隐藏 AI 助手", true, Some("CmdOrCtrl+J"))?,
            &MenuItem::with_id(app, "toggle-theme", "切换深色模式", true, Some("CmdOrCtrl+Shift+L"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "zoom-in", "放大画布", true, Some("CmdOrCtrl+="))?,
            &MenuItem::with_id(app, "zoom-out", "缩小画布", true, Some("CmdOrCtrl+-"))?,
            &MenuItem::with_id(app, "zoom-reset", "实际大小", true, Some("CmdOrCtrl+0"))?,
            &MenuItem::with_id(app, "zoom-fit", "适应内容", true, Some("CmdOrCtrl+9"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, Some("进入全屏"))?,
        ],
    )?;

    let window_menu = Submenu::with_items(
        app,
        "窗口",
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some("最小化"))?,
            &PredefinedMenuItem::maximize(app, Some("缩放"))?,
        ],
    )?;

    let help_menu = Submenu::with_items(
        app,
        "帮助",
        true,
        &[
            &MenuItem::with_id(app, "shortcuts", "键盘快捷键", true, None::<&str>)?,
            &MenuItem::with_id(app, "open-data-dir", "打开数据文件夹", true, None::<&str>)?,
        ],
    )?;

    Menu::with_items(
        app,
        &[
            &app_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &window_menu,
            &help_menu,
        ],
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .register_asynchronous_uri_scheme_protocol("inkasset", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            std::thread::spawn(move || {
                let raw = request.uri().path().trim_start_matches('/').to_string();
                let name = files::sanitize_name(&percent_decode(&raw));
                let dir = app
                    .path()
                    .app_data_dir()
                    .map(|d| files::attachments_dir(&d))
                    .unwrap_or_default();
                let path = dir.join(&name);
                match std::fs::read(&path) {
                    Ok(bytes) => {
                        let mime = files::guess_mime(&name);
                        let resp = tauri::http::Response::builder()
                            .status(200)
                            .header("Content-Type", mime)
                            .header("Cache-Control", "max-age=31536000, immutable")
                            .header("Access-Control-Allow-Origin", "*")
                            .body(bytes)
                            .unwrap_or_else(|_| {
                                tauri::http::Response::builder()
                                    .status(500)
                                    .body(Vec::new())
                                    .unwrap()
                            });
                        responder.respond(resp);
                    }
                    Err(_) => {
                        let resp = tauri::http::Response::builder()
                            .status(404)
                            .header("Access-Control-Allow-Origin", "*")
                            .body(Vec::new())
                            .unwrap();
                        responder.respond(resp);
                    }
                }
            });
        })
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            db::migrate_legacy_library(&data_dir)?;
            std::fs::create_dir_all(files::attachments_dir(&data_dir))?;
            let conn = db::open(&data_dir.join(db::DATABASE_FILE))?;
            db::rebrand_legacy_welcome_page(&conn)?;

            app.manage(AppState {
                conn: Mutex::new(conn),
                data_dir,
                http: reqwest::Client::new(),
                cancels: Mutex::new(HashMap::new()),
                exit_ready: AtomicBool::new(false),
                exit_requested: AtomicBool::new(false),
            });

            let handle = app.handle();
            let menu = build_menu(handle)?;
            app.set_menu(menu)?;

            // macOS 26 can leave a Tauri window in the background after Finder launches it.
            // Explicitly restore the first window after all plugins and application state are ready.
            if let Some(window) = app.get_webview_window("main") {
                window.show()?;
                window.set_focus()?;
            }
            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id().0.clone();
            if id == "quit-app" {
                app.exit(0);
            } else {
                let _ = app.emit("menu-action", id);
            }
        })
        .invoke_handler(tauri::generate_handler![
            complete_exit,
            exit_request_pending,
            commands::notebooks_list,
            commands::notebook_create,
            commands::notebook_update,
            commands::notebook_delete,
            commands::sections_list,
            commands::section_create,
            commands::section_update,
            commands::section_delete,
            commands::section_duplicate_for_agent,
            commands::section_adopt_agent_draft,
            commands::pages_list,
            commands::page_get,
            commands::page_create,
            commands::page_save,
            commands::page_update_meta,
            commands::page_delete,
            commands::page_duplicate,
            commands::search,
            commands::recent_pages,
            commands::backlinks,
            commands::page_by_title,
            commands::tags_list,
            commands::tag_set_color,
            commands::pages_by_tag,
            commands::favorites_list,
            commands::version_create,
            commands::versions_list,
            commands::version_content,
            commands::attachment_save,
            commands::attachment_read,
            commands::attachment_delete,
            commands::attachment_export,
            commands::read_file_base64,
            commands::read_file_text,
            commands::write_file_text,
            commands::write_file_base64,
            commands::trash_list,
            commands::trash_restore,
            commands::trash_purge,
            commands::trash_empty,
            commands::setting_get,
            commands::setting_set,
            commands::stats,
            commands::open_data_dir,
            commands::backup_export,
            commands::backup_import,
            ai::ai_chat,
            ai::ai_cancel,
            ai::ai_complete,
            ai::ai_models,
            ai::ai_test,
        ])
        .build(tauri::generate_context!())
        .expect("启动 reunote 失败");

    app.run(|app_handle, event| {
        if let RunEvent::ExitRequested { api, .. } = event {
            let ready = app_handle
                .state::<AppState>()
                .exit_ready
                .load(Ordering::SeqCst);
            if !ready {
                app_handle
                    .state::<AppState>()
                    .exit_requested
                    .store(true, Ordering::SeqCst);
                api.prevent_exit();
                let _ = app_handle.emit("app-exit-requested", ());
            }
        }
    });
}

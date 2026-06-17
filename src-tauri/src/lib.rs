// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager};

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

// ── Workspace file tree ────────────────────────────────────────────────
//
// `read_dir_tree` walks a user-chosen folder and returns a nested structure.
// It's a custom command, so it bypasses the fs-plugin scope in default.json
// (no capability changes needed) — but it deliberately surfaces ONLY the
// extensions HIKMA can actually open, so every click in the tree routes
// cleanly through the existing scoped `openFile`/`readTextFile` path.
//
// To show *every* file instead: empty out EXTS (the extension filter is then
// skipped) AND broaden `fs:allow-read-text-file` in default.json accordingly.

#[derive(Serialize)]
struct FileNode {
    name: String,
    path: String,
    is_dir: bool,
    children: Option<Vec<FileNode>>, // None = file, Some = directory
}

/// Folder names we never descend into.
const IGNORE: &[&str] = &[".git", "node_modules", "target", ".DS_Store", ".obsidian"];
/// File extensions surfaced in the tree. Empty this slice to show all files.
/// The text formats are openable; the image formats are display-only — the
/// frontend (FileTree.tsx) decides what's clickable, not this list.
const EXTS: &[&str] = &[
    "md", "markdown", "txt", // editable
    "png", "jpg", "jpeg", "gif", "svg", "webp", // shown but inert
];
/// Safety cap so a pathological tree can't recurse forever.
const MAX_DEPTH: usize = 12;

fn read_node(path: &Path, depth: usize) -> Option<FileNode> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());

    if depth > 0 && IGNORE.contains(&name.as_str()) {
        return None;
    }

    if path.is_dir() {
        let mut kids: Vec<FileNode> = if depth < MAX_DEPTH {
            fs::read_dir(path)
                .into_iter()
                .flatten()
                .filter_map(|e| e.ok())
                .filter_map(|e| read_node(&e.path(), depth + 1))
                .collect()
        } else {
            Vec::new()
        };

        // Directories first, then case-insensitive alphabetical.
        kids.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });

        // Prune folders that contain no editable files anywhere beneath —
        // but never prune the root, so an empty folder still opens cleanly.
        if depth > 0 && kids.is_empty() {
            return None;
        }

        Some(FileNode {
            name,
            path: path.to_string_lossy().into_owned(),
            is_dir: true,
            children: Some(kids),
        })
    } else {
        let keep = EXTS.is_empty()
            || path
                .extension()
                .map(|e| EXTS.contains(&e.to_string_lossy().to_lowercase().as_str()))
                .unwrap_or(false);
        if !keep {
            return None;
        }
        Some(FileNode {
            name,
            path: path.to_string_lossy().into_owned(),
            is_dir: false,
            children: None,
        })
    }
}

#[tauri::command]
fn read_dir_tree(path: String) -> Result<FileNode, String> {
    read_node(Path::new(&path), 0).ok_or_else(|| "could not read directory".to_string())
}

#[derive(Serialize)]
struct ContentMatch {
    path: String,
    name: String,
    line_number: usize,
    line_content: String,
}

#[tauri::command]
fn search_content(path: String, query: String) -> Result<Vec<ContentMatch>, String> {
    if query.trim().len() < 2 {
        return Ok(Vec::new());
    }
    let mut matches = Vec::new();
    let root = Path::new(&path);
    search_recursive(root, &query.to_lowercase(), &mut matches);
    Ok(matches)
}

#[tauri::command]
fn rename_file(old_path: String, new_path: String) -> Result<(), String> {
    fs::rename(old_path, new_path).map_err(|e| e.to_string())
}

fn search_recursive(path: &Path, query: &str, matches: &mut Vec<ContentMatch>) {
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let child_path = entry.path();
            let name = child_path.file_name().unwrap_or_default().to_string_lossy();

            if IGNORE.contains(&name.as_ref()) {
                continue;
            }

            if child_path.is_dir() {
                search_recursive(&child_path, query, matches);
            } else {
                let ext = child_path
                    .extension()
                    .map(|e| e.to_string_lossy().to_lowercase());
                if let Some(e) = ext {
                    if ["md", "markdown", "txt"].contains(&e.as_str()) {
                        if let Ok(content) = fs::read_to_string(&child_path) {
                            for (idx, line) in content.lines().enumerate() {
                                if line.to_lowercase().contains(query) {
                                    matches.push(ContentMatch {
                                        path: child_path.to_string_lossy().into_owned(),
                                        name: name.to_string(),
                                        line_number: idx + 1,
                                        line_content: line.trim().to_string(),
                                    });
                                    if matches.len() > 50 {
                                        return;
                                    }
                                }
                            }
                        }
                    }
                }
            }
            if matches.len() > 50 {
                return;
            }
        }
    }
}

//tracks the directories already granted asset access this session, so we don't keep re-adding overlapping grants.
#[derive(Default)]
struct AssetGrants(Mutex<Vec<PathBuf>>);

//grants the asset protocol read access to a directory the user has explicitly opened (a file's folder or a workspace root)
#[tauri::command]
fn allow_asset_dir(
    app: tauri::AppHandle,
    grants: tauri::State<'_, AssetGrants>,
    path: String,
) -> Result<(), String> {
    // Canonicalize for a reliable containment check (resolves `..`, symlinks).
    // Fall back to the raw path if canonicalization fails for any reason.
    let canon = fs::canonicalize(&path).unwrap_or_else(|_| PathBuf::from(&path));

    let mut granted = grants.0.lock().map_err(|e| e.to_string())?;
    // Already covered by (equal to, or nested under) an existing grant? Skip.
    if granted.iter().any(|root| canon.starts_with(root)) {
        return Ok(());
    }

    app.asset_protocol_scope()
        .allow_directory(&path, true)
        .map_err(|e| e.to_string())?;
    granted.push(canon);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AssetGrants::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let app_menu = Submenu::with_id_and_items(
                app,
                "app",
                "Hikma",
                true,
                &[
                    &MenuItem::with_id(app, "about", "About Hikma", true, None::<&str>)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::show_all(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?;

            let file_menu = Submenu::with_id_and_items(
                app,
                "file",
                "File",
                true,
                &[
                    &MenuItem::with_id(app, "new", "New", true, Some("CmdOrCtrl+N"))?,
                    &MenuItem::with_id(app, "open", "Open...", true, Some("CmdOrCtrl+O"))?,
                    &MenuItem::with_id(
                        app,
                        "open_folder",
                        "Open Folder...",
                        true,
                        Some("CmdOrCtrl+Shift+O"),
                    )?,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(app, "save", "Save", true, Some("CmdOrCtrl+S"))?,
                    &MenuItem::with_id(
                        app,
                        "save_as",
                        "Save As...",
                        true,
                        Some("CmdOrCtrl+Shift+S"),
                    )?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::close_window(app, None)?,
                ],
            )?;

            let edit_menu = Submenu::with_id_and_items(
                app,
                "edit",
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?;

            let insert_menu = Submenu::with_id_and_items(
                app,
                "insert",
                "Insert",
                true,
                &[
                    &MenuItem::with_id(
                        app,
                        "insert-code",
                        "Code Block",
                        true,
                        Some("CmdOrCtrl+Alt+C"),
                    )?,
                    &MenuItem::with_id(
                        app,
                        "insert-table",
                        "Table",
                        true,
                        Some("CmdOrCtrl+Alt+T"),
                    )?,
                    &MenuItem::with_id(
                        app,
                        "insert-image",
                        "Image",
                        true,
                        Some("CmdOrCtrl+Alt+I"),
                    )?,
                    &MenuItem::with_id(app, "insert-link", "Link", true, Some("CmdOrCtrl+Alt+L"))?,
                    &MenuItem::with_id(
                        app,
                        "insert-rule",
                        "Horizontal Rule",
                        true,
                        Some("CmdOrCtrl+Alt+H"),
                    )?,
                    &MenuItem::with_id(
                        app,
                        "insert-task",
                        "Task List",
                        true,
                        Some("CmdOrCtrl+Alt+X"),
                    )?,
                    &MenuItem::with_id(
                        app,
                        "insert-quote",
                        "Blockquote",
                        true,
                        Some("CmdOrCtrl+Alt+Q"),
                    )?,
                ],
            )?;

            let theme_menu = Submenu::with_id_and_items(
                app,
                "theme",
                "Theme",
                true,
                &[
                    &MenuItem::with_id(app, "theme-light", "Light", true, None::<&str>)?,
                    &MenuItem::with_id(app, "theme-dark", "Dark", true, None::<&str>)?,
                    &MenuItem::with_id(app, "theme-system", "System", true, None::<&str>)?,
                ],
            )?;

            let view_menu = Submenu::with_id_and_items(
                app,
                "view",
                "View",
                true,
                &[
                    &PredefinedMenuItem::fullscreen(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(app, "reload", "Reload", true, Some("CmdOrCtrl+R"))?,
                    &PredefinedMenuItem::separator(app)?,
                    &theme_menu,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(
                        app,
                        "toggle_devtools",
                        "Toggle Developer Tools",
                        true,
                        Some("CmdOrCtrl+Shift+I"),
                    )?,
                ],
            )?;

            let window_menu = Submenu::with_id_and_items(
                app,
                "window",
                "Window",
                true,
                &[
                    &PredefinedMenuItem::minimize(app, None)?,
                    &PredefinedMenuItem::maximize(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::close_window(app, None)?,
                ],
            )?;

            let help_menu = Submenu::with_id_and_items(
                app,
                "help",
                "Help",
                true,
                &[
                    &MenuItem::with_id(app, "learn_more", "Learn More", true, None::<&str>)?,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(app, "github", "GitHub Repository", true, None::<&str>)?,
                    &MenuItem::with_id(app, "report_issue", "Report Issue", true, None::<&str>)?,
                ],
            )?;

            let menu = Menu::with_items(
                app,
                &[
                    &app_menu,
                    &file_menu,
                    &edit_menu,
                    &insert_menu,
                    &view_menu,
                    &window_menu,
                    &help_menu,
                ],
            )?;

            app.set_menu(menu)?;

            app.on_menu_event(move |app, event| match event.id.as_ref() {
                "about" => {
                    let _ = app.emit("menu-about", ());
                }
                "new" => {
                    let _ = app.emit("menu-new", ());
                }
                "open" => {
                    let _ = app.emit("menu-open", ());
                }
                "open_folder" => {
                    let _ = app.emit("menu-open-folder", ());
                }
                "save" => {
                    let _ = app.emit("menu-save", ());
                }
                "save_as" => {
                    let _ = app.emit("menu-save-as", ());
                }
                "reload" => {
                    let _ = app.get_webview_window("main").map(|w| w.reload());
                }
                "toggle_devtools" => {
                    if let Some(window) = app.get_webview_window("main") {
                        if window.is_devtools_open() {
                            window.close_devtools();
                        } else {
                            window.open_devtools();
                        }
                    }
                }
                "learn_more" => {
                    let _ = app.emit("menu-learn-more", ());
                }
                "github" => {
                    let _ = app.emit("menu-github", ());
                }
                "report_issue" => {
                    let _ = app.emit("menu-report-issue", ());
                }
                "insert-code" => {
                    let _ = app.emit("menu-insert", "code");
                }
                "insert-table" => {
                    let _ = app.emit("menu-insert", "table");
                }
                "insert-image" => {
                    let _ = app.emit("menu-insert", "image");
                }
                "insert-link" => {
                    let _ = app.emit("menu-insert", "link");
                }
                "insert-rule" => {
                    let _ = app.emit("menu-insert", "rule");
                }
                "insert-task" => {
                    let _ = app.emit("menu-insert", "task");
                }
                "insert-quote" => {
                    let _ = app.emit("menu-insert", "quote");
                }
                "theme-light" => {
                    let _ = app.emit("menu-theme", "light");
                }
                "theme-dark" => {
                    let _ = app.emit("menu-theme", "dark");
                }
                "theme-system" => {
                    let _ = app.emit("menu-theme", "system");
                }
                _ => {}
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            read_dir_tree,
            search_content,
            rename_file,
            allow_asset_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

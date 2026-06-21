// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::ShellExt;

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

const PREAMBLE: &str = r##"
#set page(margin: 2.4cm)
#set text(fill: rgb("#1a1a1a"), size: 11pt, font: ("Liberation Sans", "Noto Sans Arabic"))
#set par(justify: true, leading: 0.72em)

#show heading.where(level: 1): set text(font: ("Liberation Serif", "Noto Naskh Arabic"), size: 25pt, weight: "regular")
#show link: set text(fill: rgb("#2563eb"))

#show quote.where(block: true): it => block(
  fill: rgb("#f5f5f5"),
  stroke: (left: 3pt + rgb("#9ca3af")),
  inset: (left: 1em, rest: 0.7em),
  width: 100%, radius: 2pt,
  it.body,
)

#show raw.where(block: false): it => box(
  fill: rgb("#f3f4f6"), inset: (x: 3pt), outset: (y: 3pt), radius: 3pt,
  text(fill: rgb("#111827"), it),
)

#show raw.where(block: true): it => block(
  width: 100%, fill: rgb("#f8f9fa"), inset: 10pt, radius: 6pt, breakable: true,
)[
  #set text(size: 9pt, font: "Liberation Mono")
  #grid(
    columns: (auto, 1fr), column-gutter: 12pt, row-gutter: 0.35em,
    ..it.lines.map(line => (
      align(right, text(fill: rgb("#9ca3af"))[#line.number]),
      line.body,
    )).flatten()
  )
]

#set table(stroke: 0.5pt + rgb("#d1d5db"), inset: 8pt)
#show table.cell.where(y: 0): set text(weight: "bold")

"##;

fn markdown_to_typst(markdown: &str) -> String {
    let mut c = Converter::new();
    let parser = Parser::new_ext(markdown, Options::all());
    for event in parser {
        c.handle(event);
    }
    c.finish()
}

struct Converter {
    out: String,
    list_stack: Vec<bool>,
    in_code_block: bool,
    in_link: bool,
    link_url: String,
    link_buf: String,
    table_cols: usize,
    in_head: bool,
    in_cell: bool,
    cell_buf: String,
    header_cells: Vec<String>,
    body_cells: Vec<String>,
    in_table: bool,
}

impl Converter {
    fn new() -> Self {
        let mut out = String::from(PREAMBLE);
        out.push('\n');
        Self {
            out,
            list_stack: Vec::new(),
            in_code_block: false,
            in_link: false,
            link_url: String::new(),
            link_buf: String::new(),
            table_cols: 0,
            in_head: false,
            in_cell: false,
            cell_buf: String::new(),
            header_cells: Vec::new(),
            body_cells: Vec::new(),
            in_table: false,
        }
    }

    fn finish(self) -> String {
        self.out
    }

    fn push_inline(&mut self, s: &str) {
        if self.in_link {
            self.link_buf.push_str(s);
        } else if self.in_cell {
            self.cell_buf.push_str(s);
        } else {
            self.out.push_str(s);
        }
    }

    fn handle(&mut self, event: Event) {
        match event {
            Event::Start(Tag::Heading { level, .. }) => {
                let depth = match level {
                    HeadingLevel::H1 => 1,
                    HeadingLevel::H2 => 2,
                    HeadingLevel::H3 => 3,
                    HeadingLevel::H4 => 4,
                    HeadingLevel::H5 => 5,
                    HeadingLevel::H6 => 6,
                };
                self.out.push_str(&"=".repeat(depth));
                self.out.push(' ');
            }
            Event::End(TagEnd::Heading(_)) => self.out.push_str("\n\n"),

            Event::Start(Tag::Paragraph) => {}
            Event::End(TagEnd::Paragraph) => {
                if !self.in_cell {
                    self.out.push_str("\n\n");
                }
            }

            Event::Start(Tag::Strong) => self.push_inline("#strong["),
            Event::End(TagEnd::Strong) => self.push_inline("]"),
            Event::Start(Tag::Emphasis) => self.push_inline("#emph["),
            Event::End(TagEnd::Emphasis) => self.push_inline("]"),
            Event::Start(Tag::Strikethrough) => self.push_inline("#strike["),
            Event::End(TagEnd::Strikethrough) => self.push_inline("]"),

            Event::Start(Tag::BlockQuote(_)) => self.out.push_str("#quote(block: true)[\n"),
            Event::End(TagEnd::BlockQuote(_)) => self.out.push_str("]\n\n"),

            Event::Start(Tag::CodeBlock(kind)) => {
                self.in_code_block = true;
                let lang = match kind {
                    CodeBlockKind::Fenced(l) => l.to_string(),
                    CodeBlockKind::Indented => String::new(),
                };
                self.out.push_str("```");
                self.out.push_str(&lang);
                self.out.push('\n');
            }
            Event::End(TagEnd::CodeBlock) => {
                self.in_code_block = false;
                self.out.push_str("```\n\n");
            }

            Event::Start(Tag::List(first)) => {
                self.list_stack.push(first.is_some());
            }
            Event::End(TagEnd::List(_)) => {
                self.list_stack.pop();
                if self.list_stack.is_empty() {
                    self.out.push('\n');
                }
            }
            Event::Start(Tag::Item) => {
                let indent = "  ".repeat(self.list_stack.len().saturating_sub(1));
                self.out.push_str(&indent);
                let ordered = *self.list_stack.last().unwrap_or(&false);
                self.out.push_str(if ordered { "+ " } else { "- " });
            }
            Event::End(TagEnd::Item) => self.out.push('\n'),
            Event::TaskListMarker(checked) => {
                self.out.push_str(if checked {
                    "#box[#sym.ballot.x] "
                } else {
                    "#box[#sym.ballot] "
                });
            }

            Event::Start(Tag::Link { dest_url, .. }) => {
                self.in_link = true;
                self.link_url = dest_url.to_string();
                self.link_buf.clear();
            }
            Event::End(TagEnd::Link) => {
                self.in_link = false;
                let s = format!("#link(\"{}\")[{}]", self.link_url, self.link_buf);
                self.push_inline(&s);
                self.link_url.clear();
                self.link_buf.clear();
            }

            Event::Start(Tag::Image { dest_url, .. }) => {
                self.push_inline(&format!("#image(\"{}\")", dest_url));
            }
            Event::End(TagEnd::Image) => {}

            Event::Start(Tag::Table(aligns)) => {
                self.in_table = true;
                self.table_cols = aligns.len();
                self.header_cells.clear();
                self.body_cells.clear();
            }
            Event::End(TagEnd::Table) => {
                self.emit_table();
                self.in_table = false;
            }
            Event::Start(Tag::TableHead) => self.in_head = true,
            Event::End(TagEnd::TableHead) => self.in_head = false,
            Event::Start(Tag::TableRow) => {}
            Event::End(TagEnd::TableRow) => {}
            Event::Start(Tag::TableCell) => {
                self.in_cell = true;
                self.cell_buf.clear();
            }
            Event::End(TagEnd::TableCell) => {
                self.in_cell = false;
                let cell = self.cell_buf.trim().to_string();
                if self.in_head {
                    self.header_cells.push(cell);
                } else {
                    self.body_cells.push(cell);
                }
            }

            Event::Code(text) => {
                self.push_inline("`");
                self.push_inline(&text);
                self.push_inline("`");
            }
            Event::Text(text) => {
                if self.in_code_block {
                    self.out.push_str(&text);
                } else {
                    let escaped = escape_typst(&text);
                    self.push_inline(&escaped);
                }
            }
            Event::SoftBreak => {
                if self.in_code_block {
                    self.out.push('\n');
                } else {
                    self.push_inline(" ");
                }
            }
            Event::HardBreak => self.push_inline(" \\ \n"),
            Event::Rule => self
                .out
                .push_str("#line(length: 100%, stroke: 0.5pt + rgb(\"#d1d5db\"))\n\n"),
            _ => {}
        }
    }

    fn emit_table(&mut self) {
        if self.table_cols == 0 {
            return;
        }
        self.out
            .push_str(&format!("#table(\n  columns: {},\n", self.table_cols));
        if !self.header_cells.is_empty() {
            self.out.push_str("  table.header(\n");
            for c in &self.header_cells {
                self.out.push_str(&format!("    [{}],\n", c));
            }
            self.out.push_str("  ),\n");
        }
        for c in &self.body_cells {
            self.out.push_str(&format!("  [{}],\n", c));
        }
        self.out.push_str(")\n\n");
    }
}

fn escape_typst(text: &str) -> String {
    let mut s = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '\\' | '#' | '$' | '*' | '_' | '`' | '<' | '@' | '[' | ']' | '~' => {
                s.push('\\');
                s.push(ch);
            }
            _ => s.push(ch),
        }
    }
    s
}

#[tauri::command]
async fn export_to_pdf(
    app: tauri::AppHandle,
    markdown: String,
    output_path: String,
    source_path: Option<String>,
) -> Result<(), String> {
    let typst_markup = markdown_to_typst(&markdown);

    // Write the .typ file next to the source document so that Typst resolves
    // #image() and other relative paths against the correct directory.
    let tmp_dir = source_path
        .as_deref()
        .and_then(|p| Path::new(p).parent())
        .map(|p| p.to_path_buf())
        .unwrap_or_else(std::env::temp_dir);
    let tmp_input = tmp_dir.join("hikma_export.typ");
    fs::write(&tmp_input, &typst_markup).map_err(|e| e.to_string())?;

    let result = app
        .shell()
        .sidecar("typst")
        .map_err(|e| e.to_string())?
        .args(["compile", tmp_input.to_str().unwrap(), &output_path])
        .output()
        .await
        .map_err(|e| e.to_string())?;

    let _ = fs::remove_file(&tmp_input);

    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr);
        return Err(format!("typst failed:\n{stderr}"));
    }

    app.opener()
        .open_path(&output_path, None::<&str>)
        .map_err(|e| e.to_string())?;

    Ok(())
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
        .plugin(tauri_plugin_shell::init())
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
                    &MenuItem::with_id(
                        app,
                        "toggle-editor",
                        "Toggle Editor",
                        true,
                        Some("CmdOrCtrl+J"),
                    )?,
                    &MenuItem::with_id(
                        app,
                        "toggle-preview",
                        "Toggle Preview",
                        true,
                        Some("CmdOrCtrl+P"),
                    )?,
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
                "toggle-editor" => {
                    let _ = app.emit("menu-toggle-editor", ());
                }
                "toggle-preview" => {
                    let _ = app.emit("menu-toggle-preview", ());
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
            allow_asset_dir,
            export_to_pdf
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

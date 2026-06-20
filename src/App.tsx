import { useCallback, useEffect, useRef, useState } from "react";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { ask, message, open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { gutters } from "@codemirror/view";
import { MilkdownEditor } from "./MilkdownEditor";
import { FileTree, type FileNode } from "./FileTree";
import { CommandPalette, FindOverlay } from "./SearchOverlays";
import { AboutDialog } from "./AboutDialog";
import { HelpDialog } from "./HelpDialog";
import "./App.css";

const initialSource = `# Welcome to HIKMA حكمة

> حكمة — wisdom in every edit

\`\`\`
       ╱|、
      (˚ˎ 。7
       |、˜〵
      じしˍ,)ノ
\`\`\`

Start typing **Markdown** on the left — the preview updates on the right.

- Supports GitHub-flavored Markdown
- Tables, task lists, strikethrough, and more

\`\`\`js
// Fenced code blocks get syntax-highlighted too
const greet = (name) => \`Hello, \${name}!\`;
\`\`\`
`;

const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");

// File pickers and native fs are unavailable when the frontend runs in a plain browser
const isTauri = "__TAURI_INTERNALS__" in window;

const RECENT_KEY = "hikma.recent-files";
const MAX_RECENT = 10;

const markdownFilters = [{ name: "Markdown", extensions: ["md", "markdown", "txt"] }];

function loadRecentFiles(): string[] {
  try {
    const stored = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(stored) ? stored.filter((p) => typeof p === "string") : [];
  } catch {
    return [];
  }
}

function baseName(path: string) {
  return path.split(/[/\\]/).pop() ?? path;
}

// Ensure a file name carries a Markdown extension, defaulting to .md
function withMarkdownExt(name: string) {
  return /\.(md|markdown|txt)$/i.test(name) ? name : `${name}.md`;
}

function dirName(path: string) {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx === -1 ? path : path.slice(0, idx);
}

//grants the asset protocol read access to `dir` so the preview can load local images via `convertFileSrc`
function allowAssetDir(dir: string) {
  void invoke("allow_asset_dir", { path: dir }).catch(() => {});
}

function App() {
  const [source, setSource] = useState(initialSource);
  const [savedSource, setSavedSource] = useState(initialSource);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<FileNode | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [recentFiles, setRecentFiles] = useState<string[]>(loadRecentFiles);
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark" | "system">("system");
  const [systemDark, setSystemDark] = useState(prefersDark.matches);
  const isDark = theme === "system" ? systemDark : theme === "dark";

  const [starredPaths, setStarredPaths] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem("starred-notes");
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });

  const [noteTags, setNoteTags] = useState<Record<string, string[]>>(() => {
    try {
      const stored = localStorage.getItem("note-tags");
      return stored ? JSON.parse(stored) : {};
    } catch {
      return {};
    }
  });

  const toggleStar = useCallback((path: string) => {
    setStarredPaths((prev) => {
      const next = prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path];
      localStorage.setItem("starred-notes", JSON.stringify(next));
      return next;
    });
  }, []);

  const addTag = useCallback((path: string, tag: string) => {
    setNoteTags((prev) => {
      const current = prev[path] ?? [];
      if (current.includes(tag)) return prev;
      const next = { ...prev, [path]: [...current, tag] };
      localStorage.setItem("note-tags", JSON.stringify(next));
      return next;
    });
  }, []);

  const removeTag = useCallback((path: string, tag: string) => {
    setNoteTags((prev) => {
      const current = prev[path] ?? [];
      if (!current.includes(tag)) return prev;
      const next = { ...prev, [path]: current.filter((t) => t !== tag) };
      localStorage.setItem("note-tags", JSON.stringify(next));
      return next;
    });
  }, []);
  
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [showFindOverlay, setShowFindOverlay] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [editorView, setEditorView] = useState<EditorView | null>(null);

  const [viewMode, setViewMode] = useState<"both" | "editor" | "preview">("both");
  const [editorWidth, setEditorWidth] = useState(50); // percentage
  const [isResizing, setIsResizing] = useState(false);

  const [isEditingName, setIsEditingName] = useState(false);
  const [tempFileName, setTempFileName] = useState("");
  const [copied, setCopied] = useState(false);
  const nameBeforeEditRef = useRef("");

  const editorViewRef = useRef<EditorView | null>(null);

  const dirty = source !== savedSource;
  const fileName = filePath ? baseName(filePath) : (tempFileName || "Untitled");

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(source);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  }, [source]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isResizing) return;
    const container = document.querySelector(".editor-layout");
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const percentage = ((e.clientX - rect.left) / rect.width) * 100;
    
    if (percentage < 5) {
      setViewMode("preview");
      setIsResizing(false);
    } else if (percentage > 95) {
      setViewMode("editor");
      setIsResizing(false);
    } else {
      setEditorWidth(percentage);
    }
  }, [isResizing]);

  const handleMouseUp = useCallback(() => {
    setIsResizing(false);
  }, []);

  useEffect(() => {
    if (isResizing) {
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    } else {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    }
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing, handleMouseMove, handleMouseUp]);

  const handleRename = useCallback(async () => {
    setIsEditingName(false);
    const newName = withMarkdownExt(tempFileName.trim());
    if (!tempFileName.trim() || newName === fileName) return;

    if (!filePath) {
      // No file on disk yet — keep the name (with extension) as the suggestion for Save As
      setTempFileName(newName);
      return;
    }

    try {
      const parentDir = dirName(filePath);
      const newPath = `${parentDir}/${newName}`;

      await invoke("rename_file", { oldPath: filePath, newPath });
      setFilePath(newPath);

      setStarredPaths((prev) => {
        const next = prev.map((p) => (p === filePath ? newPath : p));
        localStorage.setItem("starred-notes", JSON.stringify(next));
        return next;
      });
      setNoteTags((prev) => {
        if (!(filePath in prev)) return prev;
        const next = { ...prev, [newPath]: prev[filePath] };
        delete next[filePath];
        localStorage.setItem("note-tags", JSON.stringify(next));
        return next;
      });
    } catch (err) {
      await message(`Could not rename file:\n${err}`, { title: "Rename failed", kind: "error" });
      setTempFileName(baseName(filePath));
    }
  }, [tempFileName, fileName, filePath]);

  const startEditing = useCallback(() => {
    // Remember the current name so Escape can restore it cleanly
    nameBeforeEditRef.current = filePath ? baseName(filePath) : tempFileName;
    // Show the full name including its extension so the user can edit it directly
    setTempFileName(withMarkdownExt(fileName));
    setIsEditingName(true);
  }, [fileName, filePath, tempFileName]);

  const cancelEditing = useCallback(() => {
    setIsEditingName(false);
    setTempFileName(nameBeforeEditRef.current);
  }, []);

  // Latest state for the stable window/keyboard listeners registered once below
  const stateRef = useRef({ source, filePath, dirty });
  useEffect(() => {
    stateRef.current = { source, filePath, dirty };
  });

  useEffect(() => {
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    prefersDark.addEventListener("change", onChange);
    return () => prefersDark.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add("dark");
      document.documentElement.classList.remove("light");
    } else {
      document.documentElement.classList.add("light");
      document.documentElement.classList.remove("dark");
    }
  }, [isDark]);

  const updateRecentFiles = useCallback((update: (prev: string[]) => string[]) => {
    setRecentFiles((prev) => {
      const next = update(prev);
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const addRecentFile = useCallback(
    (path: string) => {
      updateRecentFiles((prev) => [path, ...prev.filter((p) => p !== path)].slice(0, MAX_RECENT));
    },
    [updateRecentFiles],
  );

  const confirmDiscard = useCallback(async () => {
    if (!stateRef.current.dirty) return true;
    return ask("You have unsaved changes that will be lost.", {
      title: "Discard changes?",
      kind: "warning",
      okLabel: "Discard",
      cancelLabel: "Cancel",
    });
  }, []);

  const openFile = useCallback(
    async (path?: string) => {
      if (!isTauri) {
        window.alert("File open/save needs the desktop app — run `npm run tauri dev`.");
        return;
      }
      setFileMenuOpen(false);
      if (!(await confirmDiscard())) return;
      const target =
        path ?? (await openDialog({ multiple: false, directory: false, filters: markdownFilters }));
      if (!target) return;
      try {
        const text = await readTextFile(target);
        setSource(text);
        setSavedSource(text);
        setFilePath(target);
        addRecentFile(target);
        allowAssetDir(dirName(target));
      } catch (err) {
        updateRecentFiles((prev) => prev.filter((p) => p !== target));
        await message(`Could not open ${target}:\n${err}`, { title: "Open failed", kind: "error" });
      }
    },
    [addRecentFile, confirmDiscard, updateRecentFiles],
  );

  const openWorkspace = useCallback(async () => {
    if (!isTauri) {
      window.alert("Opening a folder needs the desktop app — run `npm run tauri dev`.");
      return;
    }
    const dir = await openDialog({ directory: true });
    if (typeof dir !== "string") return; // cancelled
    try {
      const tree = await invoke<FileNode>("read_dir_tree", { path: dir });
      setWorkspace(tree);
      setSidebarOpen(true);
      allowAssetDir(dir);
    } catch (err) {
      await message(`Could not open folder:\n${err}`, {
        title: "Open folder failed",
        kind: "error",
      });
    }
  }, []);

  const newFile = useCallback(async () => {
    if (!(await confirmDiscard())) return;
    setSource(initialSource);
    setSavedSource(initialSource);
    setFilePath(null);
  }, [confirmDiscard]);

  const saveFileAs = useCallback(async () => {
    if (!isTauri) {
      window.alert("File open/save needs the desktop app — run `npm run tauri dev`.");
      return false;
    }
    const target = await saveDialog({
      defaultPath: stateRef.current.filePath ?? "Untitled.md",
      filters: markdownFilters,
    });
    if (!target) return false;
    try {
      await writeTextFile(target, stateRef.current.source);
      setSavedSource(stateRef.current.source);
      setFilePath(target);
      addRecentFile(target);
      return true;
    } catch (err) {
      await message(`Could not save ${target}:\n${err}`, { title: "Save failed", kind: "error" });
      return false;
    }
  }, [addRecentFile]);

  const saveFile = useCallback(async () => {
    const { filePath: path, source: text } = stateRef.current;
    if (!path) return saveFileAs();
    try {
      await writeTextFile(path, text);
      setSavedSource(text);
      return true;
    } catch (err) {
      await message(`Could not save ${path}:\n${err}`, { title: "Save failed", kind: "error" });
      return false;
    }
  }, [saveFileAs]);

  const insertText = useCallback((type: string) => {
    if (!editorViewRef.current) return;

    let snippet = "";
    switch (type) {
      case "code":
        snippet = "\n```js\n// Code block\n\n```\n";
        break;
      case "table":
        snippet = "\n| Header | Header |\n| ------ | ------ |\n| Cell   | Cell   |\n";
        break;
      case "image":
        snippet = "![Alt text](https://via.placeholder.com/150)";
        break;
      case "link":
        snippet = "[Link text](https://example.com)";
        break;
      case "rule":
        snippet = "\n---\n";
        break;
      case "task":
        snippet = "\n- [ ] New task\n";
        break;
      case "quote":
        snippet = "\n> Blockquote\n";
        break;
    }

    const { state, dispatch } = editorViewRef.current;
    const { from, to } = state.selection.main;
    dispatch({
      changes: { from, to, insert: snippet },
      selection: { anchor: from + snippet.length },
      scrollIntoView: true,
    });
  }, []);

  useEffect(() => {
    if (!isTauri) return;

    const unlistens = [
      listen("menu-new", () => void newFile()),
      listen("menu-open", () => void openFile()),
      listen("menu-open-folder", () => void openWorkspace()),
      listen("menu-save", () => void saveFile()),
      listen("menu-save-as", () => void saveFileAs()),
      listen("menu-toggle-editor", () => {
        setViewMode((prev) => (prev === "preview" ? "both" : "preview"));
      }),
      listen("menu-toggle-preview", () => {
        setViewMode((prev) => (prev === "editor" ? "both" : "editor"));
      }),
      listen("menu-theme", (event) => {
        setTheme(event.payload as "light" | "dark" | "system");
      }),
      listen("menu-insert", (event) => {
        insertText(event.payload as string);
      }),
      listen("menu-learn-more", () => {
        window.open("https://github.com/HashDBrown/HIKMA", "_blank");
      }),
      listen("menu-github", () => {
        window.open("https://github.com/HashDBrown/HIKMA", "_blank");
      }),
      listen("menu-report-issue", () => {
        window.open("https://github.com/HashDBrown/HIKMA/issues", "_blank");
      }),
      listen("menu-about", () => setShowAbout(true)),
    ];

    return () => {
      void Promise.all(unlistens).then((fns) => fns.forEach((fn) => fn()));
    };
  }, [insertText, newFile, openFile, openWorkspace, saveFile, saveFileAs]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "o") {
        e.preventDefault();
        void (e.shiftKey ? openWorkspace() : openFile());
      } else if (key === "s") {
        e.preventDefault();
        void (e.shiftKey ? saveFileAs() : saveFile());
      } else if (key === "k") {
        e.preventDefault();
        setShowCommandPalette(true);
      } else if (key === "f") {
        e.preventDefault();
        setShowFindOverlay(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [newFile, openFile, openWorkspace, saveFile, saveFileAs, insertText]);

  useEffect(() => {
    const handleGlobalEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setShowCommandPalette(false);
        setShowFindOverlay(false);
        setShowHelp(false);
      }
    };
    window.addEventListener("keydown", handleGlobalEsc);
    return () => window.removeEventListener("keydown", handleGlobalEsc);
  }, []);

  useEffect(() => {
    if (!isTauri) return;
    void getCurrentWindow().setTitle(`${dirty ? "• " : ""}${fileName} — HIKMA`);
  }, [dirty, fileName]);

  useEffect(() => {
    if (!isTauri) return;
    const win = getCurrentWindow();
    const unlisten = win.onCloseRequested(async (event) => {
      if (!stateRef.current.dirty) return;
      event.preventDefault();
      const discard = await ask(`${baseName(stateRef.current.filePath ?? "Untitled")} has unsaved changes. Close without saving?`, {
        title: "Unsaved changes",
        kind: "warning",
        okLabel: "Discard & Close",
        cancelLabel: "Cancel",
      });
      if (discard) await win.destroy();
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    if (!fileMenuOpen) return;
    const onClick = () => setFileMenuOpen(false);
    window.addEventListener("click", onClick);
    return () => window.removeEventListener("click", onClick);
  }, [fileMenuOpen]);

  return (
    <div className="app">
      <CommandPalette
        isOpen={showCommandPalette}
        onClose={() => setShowCommandPalette(false)}
        workspace={workspace}
        recentFiles={recentFiles}
        onOpenFile={(path) => void openFile(path)}
      />
      <AboutDialog isOpen={showAbout} onClose={() => setShowAbout(false)} />
      <HelpDialog isOpen={showHelp} onClose={() => setShowHelp(false)} />
      <header className="toolbar">
        <span className="toolbar-brand">HIKMA <span className="toolbar-brand-ar">حكمة</span></span>
        <div className="toolbar-file-container">
          {isEditingName ? (
            <input
              className="toolbar-file-input"
              value={tempFileName}
              onChange={(e) => setTempFileName(e.target.value)}
              onBlur={handleRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleRename();
                if (e.key === "Escape") cancelEditing();
              }}
              autoFocus
            />
          ) : (
            <span 
              className="toolbar-file" 
              title={filePath ?? "Click to rename"}
              onClick={startEditing}
            >
              {fileName}
              {dirty && <span className="toolbar-dirty">●</span>}
            </span>
          )}
        </div>
        <div className="toolbar-actions">
          <button 
            className={`toolbar-btn ${viewMode === "preview" ? "active" : ""}`} 
            onClick={() => setViewMode(viewMode === "preview" ? "both" : "preview")}
            title={viewMode === "preview" ? "Show Editor" : "Hide Editor"}
          >
            {viewMode === "preview" ? "Show Editor" : "Hide Editor"}
          </button>
          <button 
            className={`toolbar-btn ${viewMode === "editor" ? "active" : ""}`} 
            onClick={() => setViewMode(viewMode === "editor" ? "both" : "editor")}
            title={viewMode === "editor" ? "Show Preview" : "Hide Preview"}
          >
            {viewMode === "editor" ? "Show Preview" : "Hide Preview"}
          </button>
          <div className="toolbar-divider" style={{ width: '1px', height: '20px', background: 'var(--toolbar-border)', margin: '0 4px' }} />
          <button className="toolbar-btn" onClick={handleCopy} title="Copy Markdown">
            {copied ? "✓" : "Copy"}
          </button>
          <div className="toolbar-menu" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="toolbar-btn"
              aria-haspopup="menu"
              aria-expanded={fileMenuOpen}
              aria-controls="file-menu"
              onClick={() => setFileMenuOpen((open) => !open)}
            >
              File ▾
            </button>
            {fileMenuOpen && (
              <ul id="file-menu" role="menu" className="toolbar-menu-list">
                <li>
                  <button
                    role="menuitem"
                    onClick={() => {
                      setFileMenuOpen(false);
                      void newFile();
                    }}
                  >
                    <span>New File</span>
                  </button>
                </li>
                <li>
                  <button
                    role="menuitem"
                    onClick={() => {
                      setFileMenuOpen(false);
                      void openFile();
                    }}
                  >
                    <span>Open…</span>
                    <span className="toolbar-shortcut">⌘O</span>
                  </button>
                </li>
                <li>
                  <button
                    role="menuitem"
                    onClick={() => {
                      setFileMenuOpen(false);
                      void openWorkspace();
                    }}
                  >
                    <span>Open Folder…</span>
                    <span className="toolbar-shortcut">⇧⌘O</span>
                  </button>
                </li>
                <li className="toolbar-menu-divider" role="separator" />
                <li>
                  <button
                    role="menuitem"
                    onClick={() => {
                      setFileMenuOpen(false);
                      void saveFile();
                    }}
                  >
                    <span>Save</span>
                    <span className="toolbar-shortcut">⌘S</span>
                  </button>
                </li>
                <li>
                  <button
                    role="menuitem"
                    onClick={() => {
                      setFileMenuOpen(false);
                      void saveFileAs();
                    }}
                  >
                    <span>Save As…</span>
                    <span className="toolbar-shortcut">⇧⌘S</span>
                  </button>
                </li>
                {recentFiles.length > 0 && (
                  <>
                    <li className="toolbar-menu-divider" role="separator" />
                    <li className="toolbar-menu-label">Recent</li>
                    {recentFiles.map((path) => (
                      <li key={path}>
                        <button role="menuitem" title={path} onClick={() => void openFile(path)}>
                          <span className="toolbar-menu-ellipsis">{baseName(path)}</span>
                        </button>
                      </li>
                    ))}
                  </>
                )}
              </ul>
            )}
          </div>
          <span className="toolbar-mode">Markdown</span>
        </div>
      </header>
      <div className="app-body">
        <nav className="activity-bar">
          <div className="activity-bar-top">
            <button
              className={`activity-btn ${sidebarOpen ? "active" : ""}`}
              onClick={() => setSidebarOpen((prev) => !prev)}
              title="Toggle File Tree Sidebar"
            >
              <svg className="activity-icon" viewBox="0 0 24 24" width="20" height="20">
                <path fill="currentColor" d="M19 5.5H12L10 3.5H5c-1.1 0-2 .9-2 2v13c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-11c0-1.1-.9-2-2-2zm0 13H5v-11h14v11z"/>
              </svg>
            </button>
            
            <button
              className="activity-btn"
              onClick={() => setShowCommandPalette(true)}
              title="Search Files and Content"
            >
              <svg className="activity-icon" viewBox="0 0 24 24" width="20" height="20">
                <path fill="currentColor" d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
              </svg>
            </button>
          </div>
          
          <div className="activity-bar-bottom">
            <button
              className={`activity-btn ${showHelp ? "active" : ""}`}
              onClick={() => setShowHelp(true)}
              title="Help & Shortcuts"
            >
              <svg className="activity-icon" viewBox="0 0 24 24" width="20" height="20">
                <path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
              </svg>
            </button>
            
            <button
              className="activity-btn"
              onClick={() => {
                setTheme((t) => (t === "dark" || (t === "system" && systemDark) ? "light" : "dark"));
              }}
              title="Toggle Theme (Settings)"
            >
              <svg className="activity-icon" viewBox="0 0 24 24" width="20" height="20">
                <path fill="currentColor" d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84a.48.48 0 0 0-.48.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87a.49.49 0 0 0 .12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
              </svg>
            </button>
          </div>
        </nav>

        <aside className={`sidebar ${sidebarOpen ? "expanded" : "collapsed"}`}>
          {workspace ? (
            <>
              <div className="sidebar-header">
                <span className="sidebar-title" title={workspace.path}>
                  {workspace.name}
                </span>
                <button
                  className="sidebar-collapse"
                  title="Hide sidebar"
                  onClick={() => setSidebarOpen(false)}
                >
                  ⟨
                </button>
              </div>
              <div className="sidebar-actions-top">
                <button className="sidebar-new-note-btn" onClick={() => void newFile()}>
                  <span className="plus-icon">+</span> New Note
                </button>
              </div>
              <div className="sidebar-tree">
                <FileTree
                  root={workspace}
                  activePath={filePath}
                  onOpenFile={(path) => void openFile(path)}
                  starredPaths={starredPaths}
                  onToggleStar={toggleStar}
                  noteTags={noteTags}
                  onAddTag={addTag}
                  onRemoveTag={removeTag}
                />
              </div>
            </>
          ) : (
            <div className="sidebar-placeholder">
              <div className="sidebar-header">
                <span className="sidebar-title">No Workspace</span>
              </div>
              <div className="sidebar-placeholder-content">
                <p>Open a folder to start taking notes.</p>
                <button className="sidebar-new-note-btn" onClick={() => void openWorkspace()}>
                  Open Folder
                </button>
              </div>
            </div>
          )}
        </aside>
        <main className="editor grow min-h-0">
          <div className="editor-layout relative">
            <FindOverlay
              isOpen={showFindOverlay}
              onClose={() => setShowFindOverlay(false)}
              editorView={editorView}
            />
            
            {(viewMode === "both" || viewMode === "editor") && (
              <div 
                className="editor-pane" 
                style={{ width: viewMode === "both" ? `${editorWidth}%` : "100%" }}
              >
                <CodeMirror
                  className="editor-source h-full"
                  value={source}
                  height="100%"
                  theme={isDark ? "dark" : "light"}
                  basicSetup={{ lineNumbers: true, foldGutter: false }}
                  extensions={[markdown({ codeLanguages: languages }), gutters({ fixed: false }), EditorView.lineWrapping]}
                  onChange={(value) => setSource(value)}
                  onCreateEditor={(view) => {
                    editorViewRef.current = view;
                    setEditorView(view);
                  }}
                />
              </div>
            )}

            {viewMode === "both" && (
              <div 
                className={`editor-resizer ${isResizing ? "dragging" : ""}`}
                onMouseDown={() => setIsResizing(true)}
              />
            )}

            {(viewMode === "both" || viewMode === "preview") && (
              <div 
                className="editor-pane"
                style={{ width: viewMode === "both" ? `${100 - editorWidth}%` : "100%" }}
              >
                <div className="editor-preview flex h-full flex-1 flex-col border-gray-300 dark:border-gray-800">
                  <MilkdownEditor markdown={source} className="milkdown-host" onChange={setSource} filePath={filePath} />
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

export default App;

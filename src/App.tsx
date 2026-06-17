import { useCallback, useEffect, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { ask, message, open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile, rename } from "@tauri-apps/plugin-fs";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { gutters } from "@codemirror/view";
import { MilkdownEditor } from "./MilkdownEditor";
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

// Directory portion of a path, including the trailing separator (empty if none)
function dirName(path: string) {
  return path.slice(0, path.length - baseName(path).length);
}

function withMarkdownExt(name: string) {
  return /\.(md|markdown|txt)$/i.test(name) ? name : `${name}.md`;
}

function App() {
  const [source, setSource] = useState(initialSource);
  const [savedSource, setSavedSource] = useState(initialSource);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [draftName, setDraftName] = useState<string | null>(null);
  const [recentFiles, setRecentFiles] = useState<string[]>(loadRecentFiles);
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [isDark, setIsDark] = useState(prefersDark.matches);

  // Set when Escape ends an edit, so the resulting blur doesn't commit the change
  const cancelEditRef = useRef(false);

  const dirty = source !== savedSource;
  const fileName = filePath ? baseName(filePath) : draftName ?? "Untitled";

  // Latest state for the stable window/keyboard listeners registered once below
  const stateRef = useRef({ source, filePath, dirty, draftName });
  useEffect(() => {
    stateRef.current = { source, filePath, dirty, draftName };
  });

  useEffect(() => {
    const onChange = (e: MediaQueryListEvent) => setIsDark(e.matches);
    prefersDark.addEventListener("change", onChange);
    return () => prefersDark.removeEventListener("change", onChange);
  }, []);

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
      } catch (err) {
        updateRecentFiles((prev) => prev.filter((p) => p !== target));
        await message(`Could not open ${target}:\n${err}`, { title: "Open failed", kind: "error" });
      }
    },
    [addRecentFile, confirmDiscard, updateRecentFiles],
  );

  const saveFileAs = useCallback(async () => {
    if (!isTauri) {
      window.alert("File open/save needs the desktop app — run `npm run tauri dev`.");
      return false;
    }
    const fallbackName = stateRef.current.draftName
      ? withMarkdownExt(stateRef.current.draftName)
      : "Untitled.md";
    const target = await saveDialog({
      defaultPath: stateRef.current.filePath ?? fallbackName,
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

  const startEditingName = useCallback(() => {
    setFileMenuOpen(false);
    setNameDraft(fileName);
    setEditingName(true);
  }, [fileName]);

  const commitName = useCallback(
    async (raw: string) => {
      setEditingName(false);
      const path = stateRef.current.filePath;
      const name = withMarkdownExt(raw.trim());
      if (!raw.trim()) return;

      // Unsaved document: remember the chosen name for the next Save As
      if (!path) {
        setDraftName(name);
        return;
      }
      if (name === baseName(path)) return;

      const newPath = dirName(path) + name;
      try {
        await rename(path, newPath);
        setFilePath(newPath);
        updateRecentFiles((prev) =>
          [newPath, ...prev.filter((p) => p !== path && p !== newPath)].slice(0, MAX_RECENT),
        );
      } catch (err) {
        await message(`Could not rename to ${name}:\n${err}`, { title: "Rename failed", kind: "error" });
      }
    },
    [updateRecentFiles],
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "o") {
        e.preventDefault();
        void openFile();
      } else if (key === "s") {
        e.preventDefault();
        void (e.shiftKey ? saveFileAs() : saveFile());
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openFile, saveFile, saveFileAs]);

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
      <header className="toolbar">
        <span className="toolbar-brand">HIKMA <span className="toolbar-brand-ar">حكمة</span></span>
        {editingName ? (
          <input
            className="toolbar-file-input"
            autoFocus
            value={nameDraft}
            spellCheck={false}
            aria-label="File name"
            onChange={(e) => setNameDraft(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.currentTarget.blur();
              } else if (e.key === "Escape") {
                cancelEditRef.current = true;
                e.currentTarget.blur();
              }
            }}
            onBlur={() => {
              if (cancelEditRef.current) {
                cancelEditRef.current = false;
                setEditingName(false);
                return;
              }
              void commitName(nameDraft);
            }}
          />
        ) : (
          <button
            type="button"
            className="toolbar-file"
            title={`${filePath ?? "Unsaved document"} — click to rename`}
            onClick={startEditingName}
          >
            {fileName}
            {dirty && <span className="toolbar-dirty">●</span>}
          </button>
        )}
        <div className="toolbar-actions">
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
                  <button role="menuitem" onClick={() => void openFile()}>
                    <span>Open…</span>
                    <span className="toolbar-shortcut">⌘O</span>
                  </button>
                </li>
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
      <main className="editor grow min-h-0">
        <div className="editor-whole grid h-full grid-rows-2 md:grid-cols-2 md:grid-rows-1 border-gray-300 dark:border-gray-600">
          <CodeMirror
            className="editor-source min-h-0 overflow-auto"
            value={source}
            height="100%"
            theme={isDark ? "dark" : "light"}
            basicSetup={{ lineNumbers: true, foldGutter: false }}
            extensions={[markdown({ codeLanguages: languages }), gutters({ fixed: false })]}
            onChange={(value) => setSource(value)}
          />
          <div className="editor-preview min-h-0 overflow-auto border-l border-gray-300 dark:border-gray-600">
            <MilkdownEditor markdown={source} onChange={setSource} />
          </div>
        </div>
      </main>
    </div>
  );
}

export default App;

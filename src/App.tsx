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
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Search, Folder, Info, Settings, ClipboardCopy, Check, X, Plus } from "lucide-react";
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
const TABS_KEY = "hikma.open-tabs";
const MAX_RECENT = 10;

const markdownFilters = [{ name: "Markdown", extensions: ["md", "markdown", "txt"] }];

/** A single open document. Multiple of these are shown as tabs. */
type OpenDoc = {
  id: string; // stable id — survives rename, used as the React key for the tab + editor
  filePath: string | null; // null = untitled, not yet saved to disk
  source: string;
  savedSource: string; // last persisted content, for per-tab dirty tracking
  tempName: string; // suggested/edited name for untitled docs (and the rename buffer)
};

let docCounter = 0;
function makeDoc(partial: Partial<OpenDoc> = {}): OpenDoc {
  docCounter += 1;
  return {
    id: `doc-${Date.now()}-${docCounter}`,
    filePath: null,
    source: "",
    savedSource: "",
    tempName: "",
    ...partial,
  };
}

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

function docName(doc: OpenDoc) {
  return doc.filePath ? baseName(doc.filePath) : doc.tempName || "Untitled";
}

//grants the asset protocol read access to `dir` so the preview can load local images via `convertFileSrc`
function allowAssetDir(dir: string) {
  void invoke("allow_asset_dir", { path: dir }).catch(() => {});
}

function App() {
  // Both initializers are lazy, so the welcome doc is created exactly once on mount.
  const [docs, setDocs] = useState<OpenDoc[]>(() => [
    makeDoc({ source: initialSource, savedSource: initialSource }),
  ]);
  const [activeId, setActiveId] = useState<string>(() => docs[0].id);

  const [workspace, setWorkspace] = useState<FileNode | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [recentFiles, setRecentFiles] = useState<string[]>(loadRecentFiles);
  const [fileMenuOpen, setFileMenuOpen] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark" | "system">("system");
  const [systemDark, setSystemDark] = useState(prefersDark.matches);
  const isDark = theme === "system" ? systemDark : theme === "dark";

  // Always-current mirrors so the once-registered window/keyboard listeners and
  // async file ops read the latest tab state without re-subscribing.
  const docsRef = useRef(docs);
  const activeIdRef = useRef(activeId);
  useEffect(() => {
    docsRef.current = docs;
    activeIdRef.current = activeId;
  });

  const patchDoc = useCallback((id: string, patch: Partial<OpenDoc>) => {
    setDocs((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  }, []);

  const patchActiveDoc = useCallback(
    (patch: Partial<OpenDoc>) => patchDoc(activeIdRef.current, patch),
    [patchDoc],
  );

  // Compatibility setters so the rest of the component reads/writes the active doc
  // as if it were flat state.
  const setSource = useCallback((v: string) => patchActiveDoc({ source: v }), [patchActiveDoc]);
  const setFilePath = useCallback((v: string | null) => patchActiveDoc({ filePath: v }), [patchActiveDoc]);
  const setTempFileName = useCallback((v: string) => patchActiveDoc({ tempName: v }), [patchActiveDoc]);

  const activeDoc = docs.find((d) => d.id === activeId) ?? docs[0];
  const source = activeDoc.source;
  const savedSource = activeDoc.savedSource;
  const filePath = activeDoc.filePath;
  const tempFileName = activeDoc.tempName;
  const dirty = source !== savedSource;
  const fileName = docName(activeDoc);

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
  const [copied, setCopied] = useState(false);
  const nameBeforeEditRef = useRef("");

  const editorViewRef = useRef<EditorView | null>(null);
  const activeTabRef = useRef<HTMLDivElement | null>(null);
  // Per-tab CodeMirror viewport + cursor, kept across the keyed remount on switch.
  const editorStatesRef = useRef<Map<string, { scrollTop: number; anchor: number; head: number }>>(
    new Map(),
  );

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
  }, [tempFileName, fileName, filePath, setFilePath, setTempFileName]);

  const startEditing = useCallback(() => {
    // Remember the current name so Escape can restore it cleanly
    nameBeforeEditRef.current = filePath ? baseName(filePath) : tempFileName;
    // Show the full name including its extension so the user can edit it directly
    setTempFileName(withMarkdownExt(fileName));
    setIsEditingName(true);
  }, [fileName, filePath, tempFileName, setTempFileName]);

  const cancelEditing = useCallback(() => {
    setIsEditingName(false);
    setTempFileName(nameBeforeEditRef.current);
  }, [setTempFileName]);

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

  // --- Tab management ---------------------------------------------------------

  const openFile = useCallback(
    async (path?: string) => {
      if (!isTauri) {
        window.alert("File open/save needs the desktop app — run `npm run tauri dev`.");
        return;
      }
      setFileMenuOpen(false);
      const target =
        path ?? (await openDialog({ multiple: false, directory: false, filters: markdownFilters }));
      if (!target || typeof target !== "string") return;

      // Already open? Just focus that tab.
      const existing = docsRef.current.find((d) => d.filePath === target);
      if (existing) {
        setActiveId(existing.id);
        return;
      }

      try {
        const text = await readTextFile(target);
        const doc = makeDoc({ filePath: target, source: text, savedSource: text });
        setDocs((prev) => [...prev, doc]);
        setActiveId(doc.id);
        addRecentFile(target);
        allowAssetDir(dirName(target));
      } catch (err) {
        updateRecentFiles((prev) => prev.filter((p) => p !== target));
        await message(`Could not open ${target}:\n${err}`, { title: "Open failed", kind: "error" });
      }
    },
    [addRecentFile, updateRecentFiles],
  );

  const newFile = useCallback(() => {
    const doc = makeDoc();
    setDocs((prev) => [...prev, doc]);
    setActiveId(doc.id);
  }, []);

  const closeTab = useCallback(async (id: string) => {
    const list = docsRef.current;
    const doc = list.find((d) => d.id === id);
    if (!doc) return;

    if (doc.source !== doc.savedSource) {
      const discard = await ask(`${docName(doc)} has unsaved changes. Close without saving?`, {
        title: "Unsaved changes",
        kind: "warning",
        okLabel: "Discard",
        cancelLabel: "Cancel",
      });
      if (!discard) return;
    }

    editorStatesRef.current.delete(id);
    const idx = list.findIndex((d) => d.id === id);
    const next = list.filter((d) => d.id !== id);

    if (next.length === 0) {
      // Keep one Untitled document so there's always an editor.
      const fresh = makeDoc();
      setDocs([fresh]);
      setActiveId(fresh.id);
      return;
    }

    setDocs(next);
    if (id === activeIdRef.current) {
      const neighbor = next[Math.min(idx, next.length - 1)];
      setActiveId(neighbor.id);
    }
  }, []);

  const cycleTab = useCallback((dir: number) => {
    const list = docsRef.current;
    if (list.length < 2) return;
    const i = list.findIndex((d) => d.id === activeIdRef.current);
    const next = list[(i + dir + list.length) % list.length];
    setActiveId(next.id);
  }, []);

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

  const saveFileAs = useCallback(async () => {
    if (!isTauri) {
      window.alert("File open/save needs the desktop app — run `npm run tauri dev`.");
      return false;
    }
    const id = activeIdRef.current;
    const doc = docsRef.current.find((d) => d.id === id);
    if (!doc) return false;
    const target = await saveDialog({
      defaultPath: doc.filePath ?? withMarkdownExt(doc.tempName || "Untitled"),
      filters: markdownFilters,
    });
    if (!target) return false;
    try {
      const latest = docsRef.current.find((d) => d.id === id) ?? doc;
      await writeTextFile(target, latest.source);
      patchDoc(id, { filePath: target, savedSource: latest.source });
      addRecentFile(target);
      allowAssetDir(dirName(target));
      return true;
    } catch (err) {
      await message(`Could not save ${target}:\n${err}`, { title: "Save failed", kind: "error" });
      return false;
    }
  }, [addRecentFile, patchDoc]);

  const saveFile = useCallback(async () => {
    const id = activeIdRef.current;
    const doc = docsRef.current.find((d) => d.id === id);
    if (!doc) return false;
    if (!doc.filePath) return saveFileAs();
    try {
      await writeTextFile(doc.filePath, doc.source);
      patchDoc(id, { savedSource: doc.source });
      return true;
    } catch (err) {
      await message(`Could not save ${doc.filePath}:\n${err}`, { title: "Save failed", kind: "error" });
      return false;
    }
  }, [saveFileAs, patchDoc]);

  const exportToPdf = useCallback(async () => {
    if (!isTauri) {
      window.alert("PDF export needs the desktop app — run `npm run tauri dev`.");
      return;
    }

    const stem = filePath
      ? baseName(filePath).replace(/\.(md|markdown|txt)$/i, "")
      : tempFileName || "Untitled";

    let outputPath: string;

    if (workspace) {
      outputPath = `${workspace.path}/${stem}.pdf`;
    } else {
      const target = await saveDialog({
        defaultPath: `${stem}.pdf`,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (!target) return;
      outputPath = target;
    }

    try {
      await invoke("export_to_pdf", { markdown: source, outputPath, sourcePath: filePath ?? null });
    } catch (err) {
      await message(`Could not export PDF:\n${err}`, { title: "Export failed", kind: "error" });
    }
  }, [source, filePath, tempFileName, workspace]);

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

  // Restore previously open file-backed tabs on launch.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (!isTauri) {
      hydratedRef.current = true;
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const raw = localStorage.getItem(TABS_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw) as { openPaths?: string[]; activePath?: string | null };
        const paths = Array.isArray(parsed.openPaths) ? parsed.openPaths : [];
        if (paths.length === 0) return;

        const loaded: OpenDoc[] = [];
        for (const p of paths) {
          try {
            const text = await readTextFile(p);
            loaded.push(makeDoc({ filePath: p, source: text, savedSource: text }));
            allowAssetDir(dirName(p));
          } catch {
            /* file moved or deleted — skip it */
          }
        }
        if (cancelled || loaded.length === 0) return;
        setDocs(loaded);
        const active = loaded.find((d) => d.filePath === parsed.activePath) ?? loaded[0];
        setActiveId(active.id);
      } catch {
        /* ignore malformed persistence */
      } finally {
        if (!cancelled) hydratedRef.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist open file-backed tabs (untitled buffers are not restorable).
  // Only the set of paths + active path matter, so skip the per-keystroke write.
  const lastPersistedRef = useRef("");
  useEffect(() => {
    if (!hydratedRef.current) return;
    const openPaths = docs.filter((d) => d.filePath).map((d) => d.filePath as string);
    const serialized = JSON.stringify({ openPaths, activePath: activeDoc.filePath ?? null });
    if (serialized === lastPersistedRef.current) return;
    lastPersistedRef.current = serialized;
    localStorage.setItem(TABS_KEY, serialized);
  }, [docs, activeId, activeDoc.filePath]);

  useEffect(() => {
    if (!isTauri) return;

    const unlistens = [
      listen("menu-new", () => newFile()),
      listen("menu-open", () => void openFile()),
      listen("menu-open-folder", () => void openWorkspace()),
      listen("menu-save", () => void saveFile()),
      listen("menu-save-as", () => void saveFileAs()),
      listen("menu-close-tab", () => void closeTab(activeIdRef.current)),
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
  }, [insertText, newFile, openFile, openWorkspace, saveFile, saveFileAs, closeTab]);

  // Shortcuts that are NOT native-menu accelerators live here. File ops
  // (⌘N/O/S, ⌘W, etc.) are owned by the native menu so they don't double-fire.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;

      // Don't hijack these while typing in a form field (rename, find, tag inputs).
      // The CodeMirror/Milkdown editors are contenteditable, not inputs, so shortcuts
      // like ⌘1–9 still work while editing a note.
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      const key = e.key.toLowerCase();

      // Tab cycling: Ctrl+Tab / Ctrl+Shift+Tab
      if (key === "tab" && e.ctrlKey) {
        e.preventDefault();
        cycleTab(e.shiftKey ? -1 : 1);
        return;
      }
      if (e.altKey) return;

      if (key === "k") {
        e.preventDefault();
        setShowCommandPalette(true);
      } else if (key === "f") {
        e.preventDefault();
        setShowFindOverlay(true);
      } else if (/^[1-9]$/.test(key)) {
        e.preventDefault();
        const target = docsRef.current[parseInt(key, 10) - 1];
        if (target) setActiveId(target.id);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cycleTab]);

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

  // Keep the active tab visible when switching via keyboard/cycle into the overflow strip.
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId]);

  useEffect(() => {
    if (!isTauri) return;
    void getCurrentWindow().setTitle(`${dirty ? "• " : ""}${fileName} — HIKMA`);
  }, [dirty, fileName]);

  useEffect(() => {
    if (!isTauri) return;
    const win = getCurrentWindow();
    const unlisten = win.onCloseRequested(async (event) => {
      const dirtyDocs = docsRef.current.filter((d) => d.source !== d.savedSource);
      if (dirtyDocs.length === 0) return;
      event.preventDefault();
      const label =
        dirtyDocs.length === 1
          ? `${docName(dirtyDocs[0])} has unsaved changes.`
          : `${dirtyDocs.length} tabs have unsaved changes.`;
      const discard = await ask(`${label} Close without saving?`, {
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
            className={`toolbar-btn toolbar-btn--icon ${viewMode === "preview" ? "active" : ""}`}
            onClick={() => setViewMode(viewMode === "preview" ? "both" : "preview")}
            title={viewMode === "preview" ? "Show Editor" : "Hide Editor"}
            aria-label={viewMode === "preview" ? "Show editor" : "Hide editor"}
          >
            {viewMode === "preview" ? <PanelLeftOpen size={18} strokeWidth={1.5} /> : <PanelLeftClose size={18} strokeWidth={1.5} />}
          </button>
          <button
            className={`toolbar-btn toolbar-btn--icon ${viewMode === "editor" ? "active" : ""}`}
            onClick={() => setViewMode(viewMode === "editor" ? "both" : "editor")}
            title={viewMode === "editor" ? "Show Preview" : "Hide Preview"}
            aria-label={viewMode === "editor" ? "Show preview" : "Hide preview"}
          >
            {viewMode === "editor" ? <PanelRightOpen size={18} strokeWidth={1.5} /> : <PanelRightClose size={18} strokeWidth={1.5} />}
          </button>
          <div className="toolbar-divider" style={{ width: '1px', height: '20px', background: 'var(--toolbar-border)', margin: '0 4px' }} />
          <button
            className="toolbar-btn toolbar-btn--icon"
            onClick={handleCopy}
            title="Copy Markdown"
            aria-label={copied ? "Copied" : "Copy Markdown"}
          >
            {copied ? <Check size={18} strokeWidth={1.5}/> : <ClipboardCopy size={18} />}
          </button>
          <button className="toolbar-btn" onClick={() => void exportToPdf()} title="Export as PDF">
            Export PDF
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
                      newFile();
                    }}
                  >
                    <span>New File</span>
                    <span className="toolbar-shortcut">⌘N</span>
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
              aria-label="Toggle file tree sidebar"
            >
              <Folder className="activity-icon" size={20} />
            </button>

            <button
              className="activity-btn"
              onClick={() => setShowCommandPalette(true)}
              title="Search Files and Content"
              aria-label="Search files and content"
            >
              <Search className="activity-icon" size={20} />
            </button>
          </div>

          <div className="activity-bar-bottom">
            <button
              className={`activity-btn ${showHelp ? "active" : ""}`}
              onClick={() => setShowHelp(true)}
              title="Help & Shortcuts"
              aria-label="Help and shortcuts"
            >
              <Info className="activity-icon" size={20} />
            </button>

            <button
              className="activity-btn"
              onClick={() => {
                setTheme((t) => (t === "dark" || (t === "system" && systemDark) ? "light" : "dark"));
              }}
              title="Toggle Theme (Settings)"
              aria-label="Toggle theme"
            >
              <Settings className="activity-icon" size={20} />
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
                <button className="sidebar-new-note-btn" onClick={() => newFile()}>
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
          <div className="tab-bar" role="tablist">
            {docs.map((doc) => {
              const name = docName(doc);
              const isActive = doc.id === activeId;
              const isDirty = doc.source !== doc.savedSource;
              return (
                <div
                  key={doc.id}
                  ref={isActive ? activeTabRef : undefined}
                  role="tab"
                  aria-selected={isActive}
                  className={`tab ${isActive ? "active" : ""}`}
                  title={doc.filePath ?? name}
                  onClick={() => setActiveId(doc.id)}
                  onAuxClick={(e) => {
                    if (e.button === 1) {
                      e.preventDefault();
                      void closeTab(doc.id);
                    }
                  }}
                >
                  <span className="tab-name">{name}</span>
                  <span className="tab-actions">
                    {isDirty && <span className="tab-dirty" aria-hidden>●</span>}
                    <button
                      className="tab-close"
                      aria-label={`Close ${name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        void closeTab(doc.id);
                      }}
                    >
                      <X size={13} strokeWidth={2} />
                    </button>
                  </span>
                </div>
              );
            })}
            <button className="tab-new" aria-label="New tab" title="New tab (⌘N)" onClick={() => newFile()}>
              <Plus size={15} strokeWidth={2} />
            </button>
          </div>
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
                  key={activeId}
                  className="editor-source h-full"
                  value={source}
                  height="100%"
                  theme={isDark ? "dark" : "light"}
                  basicSetup={{ lineNumbers: true, foldGutter: false }}
                  extensions={[markdown({ codeLanguages: languages }), gutters({ fixed: false }), EditorView.lineWrapping]}
                  onChange={(value) => setSource(value)}
                  onUpdate={(vu) => {
                    if (!vu.selectionSet) return;
                    const sel = vu.state.selection.main;
                    const prev = editorStatesRef.current.get(activeIdRef.current);
                    editorStatesRef.current.set(activeIdRef.current, {
                      scrollTop: prev?.scrollTop ?? 0,
                      anchor: sel.anchor,
                      head: sel.head,
                    });
                  }}
                  onCreateEditor={(view) => {
                    editorViewRef.current = view;
                    setEditorView(view);

                    // Restore this tab's saved cursor + scroll position.
                    const saved = editorStatesRef.current.get(activeIdRef.current);
                    if (saved) {
                      const len = view.state.doc.length;
                      view.dispatch({
                        selection: {
                          anchor: Math.min(saved.anchor, len),
                          head: Math.min(saved.head, len),
                        },
                      });
                      // Scroll after layout, otherwise scrollTop won't stick.
                      requestAnimationFrame(() => {
                        view.scrollDOM.scrollTop = saved.scrollTop;
                      });
                    }

                    // Keep the saved scroll position current as the user scrolls.
                    view.scrollDOM.addEventListener(
                      "scroll",
                      () => {
                        const prev = editorStatesRef.current.get(activeIdRef.current);
                        editorStatesRef.current.set(activeIdRef.current, {
                          anchor: prev?.anchor ?? 0,
                          head: prev?.head ?? 0,
                          scrollTop: view.scrollDOM.scrollTop,
                        });
                      },
                      { passive: true },
                    );
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
                  <MilkdownEditor key={activeId} markdown={source} className="milkdown-host" onChange={setSource} filePath={filePath} />
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

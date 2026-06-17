import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { EditorView } from "@codemirror/view";
import type { FileNode } from "./FileTree";

// --- Command Palette (Cmd+K) ---

type ContentMatch = {
  path: string;
  name: string;
  line_number: number;
  line_content: string;
};

type SearchResultItem = {
  name: string;
  path: string;
  isRecent?: boolean;
  contentMatch?: {
    line: number;
    text: string;
  };
};

type CommandPaletteProps = {
  isOpen: boolean;
  onClose: () => void;
  workspace: FileNode | null;
  recentFiles: string[];
  onOpenFile: (path: string) => void;
};

function baseName(path: string) {
  return path.split(/[/\\]/).pop() ?? path;
}

export function CommandPalette({ isOpen, onClose, workspace, recentFiles, onOpenFile }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [contentResults, setContentResults] = useState<ContentMatch[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  // Flatten workspace files for filename searching
  const allFiles = useMemo(() => {
    const flattened: { name: string; path: string; isRecent?: boolean }[] = [];
    
    if (workspace) {
      const walk = (node: FileNode) => {
        if (!node.is_dir) flattened.push({ name: node.name, path: node.path });
        if (node.children) node.children.forEach(walk);
      };
      walk(workspace);
    }
    
    recentFiles.forEach(path => {
      if (!flattened.some(f => f.path === path)) {
        flattened.push({ name: baseName(path), path, isRecent: true });
      }
    });

    return flattened;
  }, [workspace, recentFiles]);

  // Deep content search (debounced)
  useEffect(() => {
    const q = query.trim();
    if (!workspace || q.length < 2) {
      // Small timeout to avoid setState in effect warning during sync execution
      const timer = setTimeout(() => setContentResults([]), 0);
      return () => clearTimeout(timer);
    }

    const timer = setTimeout(async () => {
      try {
        const results = await invoke<ContentMatch[]>("search_content", {
          path: workspace.path,
          query: q,
        });
        setContentResults(results);
      } catch (err) {
        console.error("Content search failed:", err);
      }
    }, 150);

    return () => clearTimeout(timer);
  }, [query, workspace]);

  const filteredResults = useMemo(() => {
    const q = query.toLowerCase().trim();
    
    // 1. Filename matches
    const fileMatches: SearchResultItem[] = (q 
      ? allFiles.filter((f) => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q))
      : allFiles
    ).map(f => ({ ...f }));

    // 2. Content matches
    const contentMatches: SearchResultItem[] = contentResults.map(m => ({
      name: m.name,
      path: m.path,
      contentMatch: {
        line: m.line_number,
        text: m.line_content,
      }
    }));

    return [...fileMatches, ...contentMatches]
      .sort((a, b) => {
        if (q) {
          const aName = a.name.toLowerCase();
          const bName = b.name.toLowerCase();
          
          if (!a.contentMatch && b.contentMatch) return -1;
          if (a.contentMatch && !b.contentMatch) return 1;

          if (!a.contentMatch && !b.contentMatch) {
            if (aName === q && bName !== q) return -1;
            if (bName === q && aName !== q) return 1;
            if (aName.startsWith(q) && !bName.startsWith(q)) return -1;
            if (bName.startsWith(q) && !aName.startsWith(q)) return 1;
          }
        }
        return 0;
      })
      .slice(0, 30);
  }, [allFiles, query, contentResults]);

  useEffect(() => {
    if (isOpen) {
      const timer = setTimeout(() => {
        setQuery("");
        setSelectedIndex(0);
        setContentResults([]);
        inputRef.current?.focus();
        requestAnimationFrame(() => inputRef.current?.focus());
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => (filteredResults.length > 0 ? (i + 1) % filteredResults.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => (filteredResults.length > 0 ? (i - 1 + filteredResults.length) % filteredResults.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const selected = filteredResults[selectedIndex];
      if (selected) {
        onOpenFile(selected.path);
        onClose();
      }
    } else if (e.key === "Escape") {
      onClose();
    }
  };

  return isOpen ? (
    <div className="search-overlay-backdrop" onClick={onClose}>
      <div className="command-palette" onClick={(e) => e.stopPropagation()}>
        <div className="search-input-container">
          <span style={{ opacity: 0.6, fontSize: '1.1rem' }}>🔍</span>
          <input
            ref={inputRef}
            className="search-input"
            placeholder={workspace ? "Search files and content..." : "Search recent files..."}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
          />
        </div>
        <div className="search-results">
          {filteredResults.length > 0 ? (
            filteredResults.map((item, i) => (
              <div
                key={`${item.path}-${item.contentMatch?.line || 0}-${i}`}
                className={`search-result-item ${i === selectedIndex ? "selected" : ""}`}
                onMouseEnter={() => setSelectedIndex(i)}
                onClick={() => {
                  onOpenFile(item.path);
                  onClose();
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span className="search-result-name">
                    {item.name}
                    {item.contentMatch && (
                      <span style={{ opacity: 0.5, fontWeight: 400, fontSize: '0.75rem', marginLeft: '8px' }}>
                        line {item.contentMatch.line}
                      </span>
                    )}
                  </span>
                  {item.isRecent && <span style={{ fontSize: '0.6rem', opacity: 0.5, textTransform: 'uppercase' }}>Recent</span>}
                </div>
                {item.contentMatch ? (
                  <span className="search-result-path" style={{ 
                    fontFamily: 'ui-monospace, monospace', 
                    background: 'rgba(0,0,0,0.1)',
                    padding: '2px 4px',
                    borderRadius: '3px',
                    marginTop: '4px',
                    color: 'var(--app-fg)',
                    opacity: 0.8
                  }}>
                    {item.contentMatch.text}
                  </span>
                ) : (
                  <span className="search-result-path">{item.path}</span>
                )}
              </div>
            ))
          ) : (
            <div className="search-empty">
              {query ? `No matches found for "${query}"` : workspace ? "Type to search files and content" : "Open a folder to search all files"}
            </div>
          )}
        </div>
      </div>
    </div>
  ) : null;
}

// --- Find Overlay (Ctrl+F) ---

type FindOverlayProps = {
  isOpen: boolean;
  onClose: () => void;
  editorView: EditorView | null;
};

export function FindOverlay({ isOpen, onClose, editorView }: FindOverlayProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const navigateToMatch = useCallback((match: { from: number; to: number }) => {
    if (!editorView || !match) return;
    editorView.dispatch({
      selection: { anchor: match.from, head: match.to },
      scrollIntoView: true,
    });
  }, [editorView]);

  const searchResults = useMemo(() => {
    if (!searchTerm || !editorView) return [];
    const doc = editorView.state.doc.toString();
    const found: { from: number; to: number }[] = [];
    const lowerSearch = searchTerm.toLowerCase();
    const lowerDoc = doc.toLowerCase();
    let pos = 0;
    while ((pos = lowerDoc.indexOf(lowerSearch, pos)) !== -1) {
      found.push({ from: pos, to: pos + searchTerm.length });
      pos += searchTerm.length;
    }
    return found;
  }, [searchTerm, editorView]);

  const [currentIndex, setCurrentIndex] = useState(-1);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchResults.length > 0 && editorView) {
        const cursor = editorView.state.selection.main.from;
        let nearest = 0;
        for (let i = 0; i < searchResults.length; i++) {
          if (searchResults[i].from >= cursor) {
            nearest = i;
            break;
          }
        }
        setCurrentIndex(nearest);
        navigateToMatch(searchResults[nearest]);
      } else {
        setCurrentIndex(-1);
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [searchResults, editorView, navigateToMatch]);

  useEffect(() => {
    if (isOpen) {
      const timer = setTimeout(() => {
        requestAnimationFrame(() => inputRef.current?.focus());
        if (editorView) {
          const selection = editorView.state.selection.main;
          if (!selection.empty) {
            const selectedText = editorView.state.doc.sliceString(selection.from, selection.to);
            if (selectedText && selectedText.length < 100 && !selectedText.includes("\n")) {
              setSearchTerm(selectedText);
            }
          }
        }
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [isOpen, editorView]);

  const handleNext = () => {
    if (searchResults.length === 0) return;
    const next = (currentIndex + 1) % searchResults.length;
    setCurrentIndex(next);
    navigateToMatch(searchResults[next]);
  };

  const handlePrev = () => {
    if (searchResults.length === 0) return;
    const prev = (currentIndex - 1 + searchResults.length) % searchResults.length;
    setCurrentIndex(prev);
    navigateToMatch(searchResults[prev]);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) handlePrev();
      else handleNext();
    } else if (e.key === "Escape") {
      onClose();
    }
  };

  return isOpen ? (
    <div className="find-overlay" onClick={(e) => e.stopPropagation()}>
      <input
        ref={inputRef}
        className="find-input"
        placeholder="Find..."
        value={searchTerm}
        onChange={(e) => setSearchTerm(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="find-stats">
        {searchResults.length > 0 ? `${currentIndex + 1} / ${searchResults.length}` : "No results"}
      </div>
      <div className="find-actions">
        <button className="find-btn" onClick={handlePrev} disabled={searchResults.length === 0}>↑</button>
        <button className="find-btn" onClick={handleNext} disabled={searchResults.length === 0}>↓</button>
        <button className="find-btn" onClick={onClose}>✕</button>
      </div>
    </div>
  ) : null;
}

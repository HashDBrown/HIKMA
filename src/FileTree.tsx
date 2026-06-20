import { useState, useEffect } from "react";
import { readTextFile } from "@tauri-apps/plugin-fs";

/** Mirrors the `FileNode` struct returned by the `read_dir_tree` Rust command. */
export type FileNode = {
  name: string;
  path: string;
  is_dir: boolean;
  children: FileNode[] | null;
};

/** Extensions HIKMA can open in the editor. Everything else (images, etc.)
 *  is shown in the tree for orientation but rendered inert. */
const EDITABLE = new Set(["md", "markdown", "txt"]);

function isEditable(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return EDITABLE.has(ext);
}

function baseName(path: string) {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1];
}

function cleanMarkdown(md: string): string {
  let text = md.replace(/<[^>]*>/g, "");
  text = text.replace(/^#+\s+/gm, "");
  text = text.replace(/[\*_]{1,3}([^*_]+)[\*_]{1,3}/g, "$1");
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/^\s*[-*+]\s+/gm, "");
  text = text.replace(/^\s*\d+\.\s+/gm, "");
  text = text.replace(/^\s*>\s+/gm, "");
  return text.replace(/\s+/g, " ").trim();
}

type FileTreeProps = {
  root: FileNode;
  activePath: string | null;
  onOpenFile: (path: string) => void;
  starredPaths: string[];
  onToggleStar: (path: string) => void;
  noteTags: Record<string, string[]>;
  onAddTag: (path: string, tag: string) => void;
  onRemoveTag: (path: string, tag: string) => void;
};

export function FileTree({
  root,
  activePath,
  onOpenFile,
  starredPaths,
  onToggleStar,
  noteTags,
  onAddTag,
  onRemoveTag,
}: FileTreeProps) {
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    path: string;
  } | null>(null);

  const [addingTagToPath, setAddingTagToPath] = useState<string | null>(null);

  // Close context menu on click elsewhere
  useEffect(() => {
    const handleGlobalClick = () => setContextMenu(null);
    window.addEventListener("click", handleGlobalClick);
    return () => window.removeEventListener("click", handleGlobalClick);
  }, []);

  const handleContextMenu = (e: React.MouseEvent, path: string) => {
    e.preventDefault();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      path,
    });
  };

  return (
    <div className="file-tree-container">
      {/* Context Menu */}
      {contextMenu && (
        <div
          className="sidebar-context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => {
              onToggleStar(contextMenu.path);
              setContextMenu(null);
            }}
          >
            {starredPaths.includes(contextMenu.path) ? "☆ Unstar Note" : "★ Star Note"}
          </button>
          <button
            onClick={() => {
              setAddingTagToPath(contextMenu.path);
              setContextMenu(null);
            }}
          >
            🏷️ Add Tag...
          </button>
        </div>
      )}

      {/* Starred Section */}
      {starredPaths.length > 0 && (
        <div className="sidebar-section-container starred-section">
          <div className="sidebar-section-header">
            <span>★ Starred</span>
            <span className="sidebar-section-count">{starredPaths.length}</span>
          </div>
          <ul className="sidebar-starred-list">
            {starredPaths.map((path) => {
              const tags = noteTags[path] ?? [];
              const active = path === activePath;
              return (
                <StarredItem
                  key={path}
                  path={path}
                  active={active}
                  tags={tags}
                  onOpenFile={onOpenFile}
                  onToggleStar={onToggleStar}
                  onAddTag={onAddTag}
                  onRemoveTag={onRemoveTag}
                  onContextMenu={handleContextMenu}
                  addingTagToPath={addingTagToPath}
                  setAddingTagToPath={setAddingTagToPath}
                />
              );
            })}
          </ul>
        </div>
      )}

      {/* Main Folder/File List */}
      <div className="sidebar-section-container files-section">
        <div className="sidebar-section-header">
          <span>Notes</span>
        </div>
        <ul className="tree-root">
          {root.children?.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={1}
              activePath={activePath}
              onOpenFile={onOpenFile}
              starredPaths={starredPaths}
              onToggleStar={onToggleStar}
              noteTags={noteTags}
              onAddTag={onAddTag}
              onRemoveTag={onRemoveTag}
              addingTagToPath={addingTagToPath}
              setAddingTagToPath={setAddingTagToPath}
              onContextMenu={handleContextMenu}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}

type StarredItemProps = {
  path: string;
  active: boolean;
  tags: string[];
  onOpenFile: (path: string) => void;
  onToggleStar: (path: string) => void;
  onAddTag: (path: string, tag: string) => void;
  onRemoveTag: (path: string, tag: string) => void;
  onContextMenu: (e: React.MouseEvent, path: string) => void;
  addingTagToPath: string | null;
  setAddingTagToPath: (path: string | null) => void;
};

function StarredItem({
  path,
  active,
  tags,
  onOpenFile,
  onToggleStar,
  onAddTag,
  onRemoveTag,
  onContextMenu,
  addingTagToPath,
  setAddingTagToPath,
}: StarredItemProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const name = baseName(path);

  const handleMouseEnter = async () => {
    setIsHovered(true);
    if (previewText) return;
    setLoading(true);
    try {
      const text = await readTextFile(path);
      const plainText = cleanMarkdown(text);
      setPreviewText(plainText.substring(0, 160) + (plainText.length > 160 ? "..." : ""));
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleMouseLeave = () => {
    setIsHovered(false);
  };

  return (
    <li className="tree-file-wrapper">
      <div
        className={`tree-row tree-file${active ? " active" : ""}`}
        style={{ paddingLeft: "0.5rem" }}
        onClick={() => onOpenFile(path)}
        onContextMenu={(e) => onContextMenu(e, path)}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <span
          className="tree-star starred"
          onClick={(e) => {
            e.stopPropagation();
            onToggleStar(path);
          }}
        >
          ★
        </span>
        <span className="tree-label">{name}</span>

        {isHovered && previewText && (
          <div className="sidebar-preview-tooltip">
            {loading ? "Loading preview..." : previewText}
          </div>
        )}
      </div>

      {addingTagToPath === path && (
        <div style={{ paddingLeft: "1.6rem", paddingRight: "0.5rem", marginBottom: "4px" }}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const input = (e.currentTarget.elements.namedItem("tagInput") as HTMLInputElement);
              const val = input.value.trim();
              if (val) {
                onAddTag(path, val);
              }
              setAddingTagToPath(null);
            }}
            onClick={(e) => e.stopPropagation()}
            className="inline-tag-form"
          >
            <input
              name="tagInput"
              type="text"
              placeholder="Add tag..."
              autoFocus
              onBlur={() => setAddingTagToPath(null)}
              className="inline-tag-input"
            />
          </form>
        </div>
      )}

      {tags && tags.length > 0 && (
        <div className="tree-tag-list" style={{ paddingLeft: "1.6rem" }}>
          {tags.map((tag) => (
            <span key={tag} className="tree-tag-pill">
              {tag}
              <button
                className="tree-tag-remove"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemoveTag(path, tag);
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </li>
  );
}

type TreeNodeProps = {
  node: FileNode;
  depth: number;
  activePath: string | null;
  onOpenFile: (path: string) => void;
  starredPaths: string[];
  onToggleStar: (path: string) => void;
  noteTags: Record<string, string[]>;
  onAddTag: (path: string, tag: string) => void;
  onRemoveTag: (path: string, tag: string) => void;
  addingTagToPath: string | null;
  setAddingTagToPath: (path: string | null) => void;
  onContextMenu: (e: React.MouseEvent, path: string) => void;
};

function TreeNode({
  node,
  depth,
  activePath,
  onOpenFile,
  starredPaths,
  onToggleStar,
  noteTags,
  onAddTag,
  onRemoveTag,
  addingTagToPath,
  setAddingTagToPath,
  onContextMenu,
}: TreeNodeProps) {
  const [open, setOpen] = useState(depth <= 1);
  const [isHovered, setIsHovered] = useState(false);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const indent = { paddingLeft: `${(depth - 1) * 0.85 + 0.5}rem` };

  const handleMouseEnter = async () => {
    setIsHovered(true);
    if (previewText) return;
    setLoading(true);
    try {
      const text = await readTextFile(node.path);
      const plainText = cleanMarkdown(text);
      setPreviewText(plainText.substring(0, 160) + (plainText.length > 160 ? "..." : ""));
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleMouseLeave = () => {
    setIsHovered(false);
  };

  if (!node.is_dir) {
    const editable = isEditable(node.name);
    const active = node.path === activePath;
    const isStarred = starredPaths.includes(node.path);
    const tags = noteTags[node.path] ?? [];

    return (
      <li className="tree-file-wrapper">
        <div
          className={`tree-row tree-file${active ? " active" : ""}${editable ? "" : " inert"}`}
          style={indent}
          onClick={editable ? () => onOpenFile(node.path) : undefined}
          onContextMenu={editable ? (e) => onContextMenu(e, node.path) : undefined}
          onMouseEnter={editable ? handleMouseEnter : undefined}
          onMouseLeave={editable ? handleMouseLeave : undefined}
        >
          <span className="tree-twist" />
          {editable && (
            <span
              className={`tree-star${isStarred ? " starred" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                onToggleStar(node.path);
              }}
            >
              {isStarred ? "★" : "☆"}
            </span>
          )}
          <span className="tree-label" title={editable ? node.name : `${node.name} — preview only`}>
            {node.name}
          </span>

          {isHovered && previewText && (
            <div className="sidebar-preview-tooltip">
              {loading ? "Loading preview..." : previewText}
            </div>
          )}
        </div>

        {addingTagToPath === node.path && (
          <div style={{ paddingLeft: `${(depth - 1) * 0.85 + 2.1}rem`, paddingRight: "0.5rem", marginBottom: "4px" }}>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const input = (e.currentTarget.elements.namedItem("tagInput") as HTMLInputElement);
                const val = input.value.trim();
                if (val) {
                  onAddTag(node.path, val);
                }
                setAddingTagToPath(null);
              }}
              onClick={(e) => e.stopPropagation()}
              className="inline-tag-form"
            >
              <input
                name="tagInput"
                type="text"
                placeholder="Add tag..."
                autoFocus
                onBlur={() => setAddingTagToPath(null)}
                className="inline-tag-input"
              />
            </form>
          </div>
        )}

        {editable && tags && tags.length > 0 && (
          <div
            className="tree-tag-list"
            style={{ paddingLeft: `${(depth - 1) * 0.85 + 2.1}rem` }}
          >
            {tags.map((tag) => (
              <span key={tag} className="tree-tag-pill">
                {tag}
                <button
                  className="tree-tag-remove"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveTag(node.path, tag);
                  }}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </li>
    );
  }

  const hasChildren = !!node.children && node.children.length > 0;

  return (
    <li className="tree-branch">
      <div
        className="tree-row tree-dir"
        style={indent}
        title={node.name}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="tree-twist">{hasChildren ? (open ? "▾" : "▸") : ""}</span>
        <span className="tree-label">{node.name}</span>
      </div>
      {open && hasChildren && (
        <ul className="tree-children">
          {node.children!.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              activePath={activePath}
              onOpenFile={onOpenFile}
              starredPaths={starredPaths}
              onToggleStar={onToggleStar}
              noteTags={noteTags}
              onAddTag={onAddTag}
              onRemoveTag={onRemoveTag}
              addingTagToPath={addingTagToPath}
              setAddingTagToPath={setAddingTagToPath}
              onContextMenu={onContextMenu}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
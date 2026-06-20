import { useEffect } from "react";

type HelpDialogProps = {
  isOpen: boolean;
  onClose: () => void;
};

type ShortcutItem = {
  keys: string;
  desc: string;
};

const SHORTCUTS: { category: string; items: ShortcutItem[] }[] = [
  {
    category: "File Operations",
    items: [
      { keys: "⌘N", desc: "New Note" },
      { keys: "⌘O", desc: "Open File" },
      { keys: "⇧⌘O", desc: "Open Folder" },
      { keys: "⌘S", desc: "Save Note" },
      { keys: "⇧⌘S", desc: "Save Note As" },
    ],
  },
  {
    category: "Search & Navigation",
    items: [
      { keys: "⌘K", desc: "Command Palette / Search Notes" },
      { keys: "⌘F", desc: "Find within Current Editor" },
      { keys: "Esc", desc: "Close Palette / Dialog" },
      { keys: "File Tree Icon", desc: "Expand/Collapse Notes Sidebar" },
    ],
  },
  {
    category: "Actions & Interactions",
    items: [
      { keys: "Settings Icon", desc: "Toggle Light/Dark Theme" },
      { keys: "Right-Click Note", desc: "Star Note / Add Tags" },
      { keys: "Hover Note", desc: "Preview Note Content" },
    ],
  },
];

export function HelpDialog({ isOpen, onClose }: HelpDialogProps) {
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;

  const renderKeys = (keys: string) => {
    if (!isMac) {
      // Convert standard Mac symbols to Windows/Linux equivalent keys
      return keys
        .replace(/⌘/g, "Ctrl")
        .replace(/⇧/g, "Shift");
    }
    return keys;
  };

  return (
    <div className="search-overlay-backdrop" onClick={onClose}>
      <div
        className="help-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard Shortcuts"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="help-dialog-header">
          <span className="help-dialog-title">Keyboard Shortcuts & Help</span>
          <button className="help-dialog-close" onClick={onClose} aria-label="Close dialog">
            ×
          </button>
        </div>
        <div className="help-dialog-content">
          {SHORTCUTS.map((section) => (
            <div key={section.category} className="help-section">
              <div className="help-section-title">{section.category}</div>
              <ul className="help-shortcut-list">
                {section.items.map((item) => (
                  <li key={item.desc} className="help-shortcut-item">
                    <span className="help-shortcut-desc">{item.desc}</span>
                    <kbd className="help-shortcut-kbd">{renderKeys(item.keys)}</kbd>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

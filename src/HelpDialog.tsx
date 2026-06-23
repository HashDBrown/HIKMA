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
    category: "File",
    items: [
      { keys: "⌘N", desc: "New Tab" },
      { keys: "⌘O", desc: "Open File" },
      { keys: "⇧⌘O", desc: "Open Folder" },
      { keys: "⌘S", desc: "Save" },
      { keys: "⇧⌘S", desc: "Save As" },
      { keys: "⌘W", desc: "Close Tab" },
    ],
  },
  {
    category: "Tabs",
    items: [
      { keys: "⌘1–9", desc: "Jump to Tab" },
      { keys: "⌃Tab", desc: "Next Tab" },
      { keys: "⌃⇧Tab", desc: "Previous Tab" },
    ],
  },
  {
    category: "View",
    items: [
      { keys: "⌘J", desc: "Toggle Editor" },
      { keys: "⌘P", desc: "Toggle Preview" },
    ],
  },
  {
    category: "Search & Navigation",
    items: [
      { keys: "⌘K", desc: "Command Palette / Search Notes" },
      { keys: "⌘F", desc: "Find within Current Editor" },
      { keys: "Esc", desc: "Close Palette / Dialog" },
    ],
  },
  {
    category: "Insert",
    items: [
      { keys: "⌥⌘C", desc: "Code Block" },
      { keys: "⌥⌘T", desc: "Table" },
      { keys: "⌥⌘I", desc: "Image" },
      { keys: "⌥⌘L", desc: "Link" },
      { keys: "⌥⌘H", desc: "Horizontal Rule" },
      { keys: "⌥⌘X", desc: "Task List Item" },
      { keys: "⌥⌘Q", desc: "Blockquote" },
    ],
  },
  {
    category: "Editing",
    items: [
      { keys: "⌘Z", desc: "Undo" },
      { keys: "⇧⌘Z", desc: "Redo" },
      { keys: "⌘C", desc: "Copy" },
      { keys: "⌘V", desc: "Paste" },
    ],
  },
  {
    category: "Mouse & UI",
    items: [
      { keys: "Folder Icon", desc: "Toggle Notes Sidebar" },
      { keys: "Settings Icon", desc: "Toggle Light/Dark Theme" },
      { keys: "Middle-Click Tab", desc: "Close Tab" },
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
        .replace(/⌃/g, "Ctrl")
        .replace(/⌥/g, "Alt")
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

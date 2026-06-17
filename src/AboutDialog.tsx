import { useEffect } from "react";

const CAT = `       ╱|、
      (˚ˎ 。7
       |、˜〵
      じしˍ,)ノ`;

const VERSION = "0.1.0";
const REPO_URL = "https://github.com/HashDBrown/HIKMA";

type AboutDialogProps = {
  isOpen: boolean;
  onClose: () => void;
  onOpenRepo?: () => void;
};

export function AboutDialog({ isOpen, onClose, onOpenRepo }: AboutDialogProps) {
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="search-overlay-backdrop" onClick={onClose}>
      <div
        className="about-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="About Hikma"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="about-brand">
          HIKMA <span className="about-brand-ar">حكمة</span>
        </div>
        <div className="about-slogan">wisdom in every edit</div>
        <pre className="about-cat" aria-hidden="true">{CAT}</pre>
        <div className="about-tagline">A modern, polished Markdown editor.</div>
        <div className="about-meta">
          <span>Version {VERSION}</span>
          <span className="about-dot">·</span>
          <button
            type="button"
            className="about-link"
            onClick={() => (onOpenRepo ? onOpenRepo() : window.open(REPO_URL, "_blank"))}
          >
            GitHub
          </button>
        </div>
        <div className="about-copyright">© 2026 Hikma Team</div>
      </div>
    </div>
  );
}

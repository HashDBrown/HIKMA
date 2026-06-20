import { useEffect, useRef } from "react";
import { Crepe } from "@milkdown/crepe";
import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react";
import { replaceAll } from "@milkdown/kit/utils";
import { convertFileSrc } from "@tauri-apps/api/core";

import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame.css';
import './crepe-dark.css';
import './crepe-light.css';

const isTauri = "__TAURI_INTERNALS__" in window;

//resolve image srcs in markdown to absolute file URLs
function resolveImageSrc(src: string, baseDir: string | null): string {
  if (!isTauri || !baseDir) return src;
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return src; // http(s):, data:, asset:, etc.

  const isAbsolute = src.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(src);
  if (isAbsolute) return convertFileSrc(src);

  const sep = baseDir.includes("\\") ? "\\" : "/";
  return convertFileSrc(`${baseDir}${sep}${src}`);
}

function baseDirOf(filePath: string | null): string | null {
  if (!filePath) return null;
  const idx = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return idx === -1 ? null : filePath.slice(0, idx);
}

interface MilkdownEditorProps {
  markdown: string;
  onChange: (markdown: string) => void;
  filePath: string | null;
  className?: string;
}

function Editor({ markdown, onChange, filePath, className }: MilkdownEditorProps) {
  const focused = useRef(false);          // is the user editing in THIS pane?
  const lastSynced = useRef(markdown);
  const crepeRef = useRef<Crepe | null>(null);
  const baseDirRef = useRef(baseDirOf(filePath));

  useEffect(() => {
    baseDirRef.current = baseDirOf(filePath);
  }, [filePath]);

  useEditor((root) => {
    const crepe = new Crepe({
      root,
      defaultValue: markdown,
      featureConfigs: {
        [Crepe.Feature.ImageBlock]: {
          proxyDomURL: (src) => resolveImageSrc(src, baseDirRef.current),
        },
      },
    });
    crepeRef.current = crepe;
    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, updatedMarkdown) => {
        if (!focused.current) return;     // ← swallows the replaceAll echo
        if (updatedMarkdown === lastSynced.current) return;
        lastSynced.current = updatedMarkdown;
        onChange(updatedMarkdown);
      });
    });
    return crepe;
  }, []);

  useEffect(() => {
    if (focused.current) return;          // ← don't clobber while typing here
    if (markdown === lastSynced.current) return;
    lastSynced.current = markdown;
    crepeRef.current?.editor.action(replaceAll(markdown));
  }, [markdown]);

  return (
    <div
      className={className ?? "milkdown-host"}
      onFocusCapture={() => (focused.current = true)}
      onBlurCapture={() => (focused.current = false)}
    >
      <Milkdown />
    </div>
  );
}

export function MilkdownEditor(props: MilkdownEditorProps) {
  return (
    <MilkdownProvider>
      <Editor {...props} />
    </MilkdownProvider>
  );
}
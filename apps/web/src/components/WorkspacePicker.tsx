import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  Home,
  Loader2,
} from "lucide-react";
import type { WorkspaceBrowseResponse } from "@codefly/protocol";
import { api, asApiError } from "../lib/api.js";
import { useAppStore } from "../lib/store.js";
import { basename, cn } from "../lib/utils.js";
import { Button } from "./ui.js";

interface PanelPosition {
  left: number;
  width: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
}

const ICON_BUTTON =
  "inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-40";

/**
 * Click-to-browse workspace picker. Opening it lists directories (starting
 * at the current value or the server user's home) inside a popup; clicking a
 * folder navigates into it and the footer confirms the current directory.
 */
export function WorkspacePicker({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (path: string) => void;
  disabled?: boolean;
}) {
  const sessions = useAppStore((state) => state.sessions);
  const [open, setOpen] = useState(false);
  const [browse, setBrowse] = useState<WorkspaceBrowseResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState<PanelPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const requestId = useRef(0);
  const autoFocused = useRef(false);

  const recent = useMemo(() => {
    const seen = new Set<string>();
    const paths: string[] = [];
    for (const session of sessions) {
      if (session.kind !== "agent") continue;
      if (seen.has(session.workspaceRoot)) continue;
      seen.add(session.workspaceRoot);
      paths.push(session.workspaceRoot);
      if (paths.length >= 5) break;
    }
    return paths;
  }, [sessions]);

  const load = useCallback(async (target?: string) => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const result = await api.browseWorkspaces(target);
      if (requestId.current !== id) return;
      setBrowse(result);
    } catch (err) {
      if (requestId.current !== id) return;
      setError(asApiError(err).message);
    } finally {
      if (requestId.current === id) setLoading(false);
    }
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setPosition(null);
  }, []);

  const choose = useCallback(
    (target: string) => {
      onChange(target);
      close();
      triggerRef.current?.focus();
    },
    [close, onChange],
  );

  // Reload each time the popup opens, and when the parent resets the value
  // as the dialog starts over.
  useEffect(() => {
    if (!open) return;
    setBrowse(null);
    setError(null);
    void load(value.trim() || undefined);
  }, [open, load, value]);

  // Anchor the portaled panel to the trigger and keep it on screen.
  useEffect(() => {
    if (!open) return;
    const update = (): void => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const margin = 12;
      const spaceBelow = window.innerHeight - rect.bottom - margin;
      const spaceAbove = rect.top - margin;
      const openUp = spaceBelow < 220 && spaceAbove > spaceBelow;
      const maxHeight = Math.min(
        360,
        Math.max(180, (openUp ? spaceAbove : spaceBelow) - 6),
      );
      setPosition(
        openUp
          ? {
              left: rect.left,
              width: rect.width,
              maxHeight,
              bottom: window.innerHeight - rect.top + 6,
            }
          : {
              left: rect.left,
              width: rect.width,
              maxHeight,
              top: rect.bottom + 6,
            },
      );
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      autoFocused.current = false;
      return;
    }
    if (!position || autoFocused.current) return;
    autoFocused.current = true;
    panelRef.current
      ?.querySelector<HTMLElement>("button:not([disabled])")
      ?.focus();
  }, [open, position]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      // Capture phase: close only the picker, not the surrounding modal.
      event.stopPropagation();
      event.preventDefault();
      close();
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [close, open]);

  const trapTab = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = Array.from(
      panel.querySelectorAll<HTMLElement>("button:not([disabled])"),
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={cn(
          "flex h-10 w-full items-center gap-2 rounded-lg border border-border bg-background px-3 text-left font-mono text-xs transition-colors",
          "hover:border-primary/30 focus-visible:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20",
          "disabled:pointer-events-none disabled:opacity-45",
          open && "border-primary/40 ring-2 ring-primary/20",
        )}
      >
        <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            value ? "text-foreground" : "text-muted-foreground/50",
          )}
          title={value || undefined}
        >
          {value || "点击选择工作区目录"}
        </span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground/70 transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && position
        ? createPortal(
            <div
              ref={panelRef}
              role="dialog"
              aria-label="选择工作区目录"
              onKeyDown={trapTab}
              style={{
                left: position.left,
                width: position.width,
                maxHeight: position.maxHeight,
                ...(position.top !== undefined ? { top: position.top } : {}),
                ...(position.bottom !== undefined
                  ? { bottom: position.bottom }
                  : {}),
              }}
              className="cf-fade-up fixed z-[70] flex flex-col overflow-hidden rounded-xl border border-border bg-card p-1.5 shadow-2xl"
            >
              <div className="flex items-center gap-1 px-1 pb-1.5">
                <button
                  type="button"
                  onClick={() => void load(undefined)}
                  className={ICON_BUTTON}
                  title={browse ? `主目录：${browse.home}` : "回到主目录"}
                  aria-label="回到主目录"
                >
                  <Home className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (browse?.parent) void load(browse.parent);
                  }}
                  disabled={!browse?.parent || loading}
                  className={ICON_BUTTON}
                  title="上一级"
                  aria-label="上一级"
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
                <span
                  className="min-w-0 flex-1 truncate text-right font-mono text-[10px] text-muted-foreground"
                  title={browse?.path}
                >
                  {browse?.path ?? "正在读取…"}
                </span>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto">
                {recent.length > 0 ? (
                  <div className="mb-1 border-b border-border/60 pb-1.5">
                    <p className="px-2 pb-1 pt-0.5 text-[9px] font-medium uppercase tracking-[0.14em] text-muted-foreground/60">
                      最近使用
                    </p>
                    {recent.map((path) => (
                      <button
                        key={path}
                        type="button"
                        onClick={() => choose(path)}
                        title={path}
                        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted/60"
                      >
                        <FolderOpen className="h-3.5 w-3.5 shrink-0 text-primary/80" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs text-foreground">
                            {basename(path)}
                          </span>
                          <span className="block truncate font-mono text-[9px] leading-4 text-muted-foreground/60">
                            {path}
                          </span>
                        </span>
                        {value === path ? (
                          <Check className="h-3 w-3 shrink-0 text-primary" />
                        ) : null}
                      </button>
                    ))}
                  </div>
                ) : null}

                {loading ? (
                  <div className="flex items-center gap-2 px-2 py-3 text-[11px] text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    正在读取目录…
                  </div>
                ) : error ? (
                  <div className="flex items-start gap-2 px-2 py-2.5">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" />
                    <div className="min-w-0 flex-1">
                      <p className="break-words text-[11px] leading-4 text-danger">
                        {error}
                      </p>
                      <button
                        type="button"
                        onClick={() => void load(undefined)}
                        className="mt-1 text-[10px] font-medium text-primary hover:underline"
                      >
                        回到主目录
                      </button>
                    </div>
                  </div>
                ) : browse && browse.entries.length > 0 ? (
                  <div className="space-y-0.5">
                    {browse.entries.map((entry) => (
                      <button
                        key={entry.path}
                        type="button"
                        onClick={() => void load(entry.path)}
                        title={entry.path}
                        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted/60"
                      >
                        <Folder className="h-3.5 w-3.5 shrink-0 text-primary/70" />
                        <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                          {entry.name}
                        </span>
                        <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/50" />
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="px-2 py-3 text-[11px] text-muted-foreground/70">
                    没有可进入的子目录。
                  </p>
                )}
              </div>

              <div className="mt-1 flex items-center gap-2 border-t border-border/60 px-1 pt-1.5">
                <span
                  className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground"
                  title={browse?.path}
                >
                  {browse ? `当前：${basename(browse.path)}` : "当前目录未知"}
                </span>
                <Button
                  variant="primary"
                  size="sm"
                  className="shrink-0"
                  disabled={!browse || browse.parent === null || loading}
                  title={
                    browse && browse.parent === null
                      ? "不能把文件系统根目录作为工作区"
                      : undefined
                  }
                  onClick={() => {
                    if (browse) choose(browse.path);
                  }}
                >
                  <Check className="h-3.5 w-3.5" />
                  选择此目录
                </Button>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

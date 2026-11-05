import { useMemo, useState } from "react";
import {
  BookOpen,
  Library,
  Loader2,
  Plus,
  Trash2,
} from "lucide-react";
import type { PaperSession } from "@codefly/protocol";
import { useAppStore } from "../../lib/store.js";
import { cn, relativeTime } from "../../lib/utils.js";
import { SidebarHeader } from "../SidebarHeader.js";
import { Button, Modal } from "../ui.js";

/** Sidebar for paper sessions, with a shortcut to the global library. */
export function PaperSidebar() {
  const allSessions = useAppStore((state) => state.sessions);
  const sessions = useMemo(
    () =>
      allSessions.filter(
        (session): session is PaperSession => session.kind === "paper",
      ),
    [allSessions],
  );
  const currentId = useAppStore((state) => state.currentSessionId);
  const selectSession = useAppStore((state) => state.selectSession);
  const createPaperSession = useAppStore((state) => state.createPaperSession);
  const paperCreating = useAppStore((state) => state.paperCreating);
  const paperBusy = useAppStore((state) => state.paperBusy);
  const deleteSession = useAppStore((state) => state.deleteSession);
  const openPaperLibrary = useAppStore((state) => state.openPaperLibrary);
  const papers = useAppStore((state) => state.papers);
  const paperTotal = useAppStore((state) => state.paperTotal);
  const open = useAppStore((state) => state.ui.sidebarOpen);
  const close = useAppStore((state) => state.closeSidebar);
  const [pendingDelete, setPendingDelete] = useState<PaperSession | null>(null);
  const [deleting, setDeleting] = useState(false);

  const confirmDelete = async (): Promise<void> => {
    if (!pendingDelete || deleting) return;
    setDeleting(true);
    const deleted = await deleteSession(pendingDelete.id);
    setDeleting(false);
    if (deleted) setPendingDelete(null);
  };

  return (
    <>
      {open ? (
        <div
          className="fixed inset-0 z-30 bg-black/60 backdrop-blur-[1px] lg:hidden"
          onClick={close}
          aria-hidden="true"
        />
      ) : null}

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-72 shrink-0 flex-col border-r border-border bg-canvas transition-transform duration-200 lg:static lg:z-auto lg:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <SidebarHeader subtitle="paper research console" />

        <div className="space-y-2 px-3 pb-2">
          <Button
            variant="secondary"
            size="md"
            className="w-full justify-start border-dashed text-xs"
            disabled={paperCreating}
            onClick={() => void createPaperSession()}
          >
            {paperCreating ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            {paperCreating ? "创建中…" : "新建论文会话"}
          </Button>
          <Button
            variant="outline"
            size="md"
            className="w-full justify-start text-xs"
            onClick={openPaperLibrary}
          >
            <Library className="h-4 w-4" />
            论文库
            <span className="ml-auto font-mono text-[10px] text-muted-foreground/60">
              {paperTotal > 0 ? paperTotal : papers.length}
            </span>
          </Button>
        </div>

        <div className="flex items-center justify-between px-4 pb-1 pt-2">
          <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/60">
            论文会话
          </span>
          <span className="font-mono text-[10px] text-muted-foreground/50">
            {sessions.length}
          </span>
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {sessions.length === 0 ? (
            <p className="px-2 py-6 text-center text-[11px] leading-5 text-muted-foreground/60">
              还没有论文会话。
              <br />
              新建一个，开始检索和阅读论文。
            </p>
          ) : (
            <ul className="space-y-1">
              {sessions.map((session) => {
                const active = session.id === currentId;
                const busy = Boolean(paperBusy[session.id]);
                return (
                  <li key={session.id} className="group relative">
                    <button
                      type="button"
                      onClick={() => selectSession(session.id)}
                      className={cn(
                        "w-full rounded-xl border px-2.5 py-2 pr-9 text-left transition-colors",
                        active
                          ? "border-primary/30 bg-primary/10"
                          : "border-transparent hover:border-border hover:bg-muted/40",
                      )}
                      title={session.title}
                    >
                      <div className="flex items-center gap-2">
                        <BookOpen
                          className={cn(
                            "h-3 w-3 shrink-0",
                            active
                              ? "text-primary"
                              : "text-muted-foreground/60",
                          )}
                        />
                        <span
                          className={cn(
                            "truncate text-xs font-medium",
                            active ? "text-foreground" : "text-foreground/85",
                          )}
                        >
                          {session.title}
                        </span>
                        <span className="ml-auto flex shrink-0 items-center gap-1.5">
                          {session.paperIds.length > 0 ? (
                            <span className="rounded bg-muted/50 px-1 py-px font-mono text-[8px] text-muted-foreground/70">
                              {session.paperIds.length} 篇
                            </span>
                          ) : null}
                          {busy ? (
                            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
                          ) : (
                            <span className="text-[9px] text-muted-foreground/50">
                              {relativeTime(session.updatedAt)}
                            </span>
                          )}
                        </span>
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => setPendingDelete(session)}
                      disabled={busy}
                      aria-label={`删除论文会话 ${session.title}`}
                      title={busy ? "会话执行中，停止后才能删除" : "删除会话"}
                      className="absolute right-1.5 top-1.5 rounded-md p-1.5 text-muted-foreground/40 opacity-100 transition-colors hover:bg-danger/10 hover:text-danger focus-visible:opacity-100 disabled:cursor-not-allowed disabled:opacity-30 lg:opacity-0 lg:group-hover:opacity-100"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </nav>

        <div className="border-t border-border/70 p-2.5">
          <button
            type="button"
            onClick={openPaperLibrary}
            className="flex w-full items-center gap-2.5 rounded-xl border border-border/70 bg-card/40 px-2.5 py-2 text-left transition-colors hover:border-primary/25 hover:bg-muted/30"
          >
            <Library className="h-4 w-4 shrink-0 text-primary" />
            <span className="min-w-0 flex-1">
              <span className="text-[11px] font-medium">全局论文库</span>
              <span className="mt-0.5 block truncate text-[9px] text-muted-foreground/60">
                {paperTotal > 0
                  ? `${paperTotal} 篇论文 · 标签、笔记与阅读状态`
                  : "检索或上传论文后在这里整理"}
              </span>
            </span>
          </button>
        </div>
      </aside>

      <Modal
        open={pendingDelete !== null}
        onClose={deleting ? undefined : () => setPendingDelete(null)}
        title="删除论文会话"
        description="此操作仅删除会话与聊天记录，不会删除论文库中的论文。"
        footer={
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPendingDelete(null)}
              disabled={deleting}
            >
              取消
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => void confirmDelete()}
              disabled={deleting}
            >
              {deleting ? "删除中…" : "删除"}
            </Button>
          </>
        }
      >
        <p className="text-xs leading-5 text-muted-foreground">
          将永久删除论文会话「{pendingDelete?.title ?? ""}」及其全部消息。
        </p>
      </Modal>
    </>
  );
}

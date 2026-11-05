import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight,
  Folder,
  Plus,
  Settings,
  ShieldCheck,
  ShieldX,
  Trash2,
} from "lucide-react";
import type { AgentSession, SandboxMode } from "@codefly/protocol";
import { useAppStore } from "../../lib/store.js";
import { MODE_SHORT_LABEL, basename, cn, relativeTime } from "../../lib/utils.js";
import { SidebarHeader } from "../SidebarHeader.js";
import { Button, Modal, StatusDot } from "../ui.js";

const MODE_DOT: Record<SandboxMode, string> = {
  "read-only": "bg-sky-400",
  "workspace-write": "bg-primary",
  "danger-full-access": "bg-danger",
};

interface SessionGroup {
  root: string;
  sessions: AgentSession[];
}

/** Groups sessions by workspace while preserving the store's recency order. */
function groupSessions(sessions: AgentSession[]): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();
  for (const session of sessions) {
    const existing = groups.get(session.workspaceRoot);
    if (existing) existing.sessions.push(session);
    else
      groups.set(session.workspaceRoot, {
        root: session.workspaceRoot,
        sessions: [session],
      });
  }
  return [...groups.values()];
}

export function AgentSidebar() {
  const allSessions = useAppStore((state) => state.sessions);
  const sessions = useMemo(
    () =>
      allSessions.filter(
        (session): session is AgentSession => session.kind === "agent",
      ),
    [allSessions],
  );
  const currentId = useAppStore((state) => state.currentSessionId);
  const selectSession = useAppStore((state) => state.selectSession);
  const openNewSession = useAppStore((state) => state.openNewSession);
  const openSettings = useAppStore((state) => state.openSettings);
  const open = useAppStore((state) => state.ui.sidebarOpen);
  const close = useAppStore((state) => state.closeSidebar);
  const sandbox = useAppStore((state) => state.sandbox);
  const deleteSession = useAppStore((state) => state.deleteSession);
  const chatBusy = useAppStore((state) => state.chatBusy);
  const agentBusy = useAppStore((state) => state.agentBusy);
  const [pendingDelete, setPendingDelete] = useState<AgentSession | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    new Set(),
  );
  const groups = useMemo(() => groupSessions(sessions), [sessions]);
  // Keep a live handle on sessions so the auto-expand effect only reruns when
  // the selected conversation changes, not on every title update.
  const sessionsRef = useRef(sessions);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    if (!currentId) return;
    const active = sessionsRef.current.find(
      (session) => session.id === currentId,
    );
    if (!active) return;
    setCollapsedGroups((previous) => {
      if (!previous.has(active.workspaceRoot)) return previous;
      const next = new Set(previous);
      next.delete(active.workspaceRoot);
      return next;
    });
  }, [currentId]);

  const toggleGroup = (root: string): void => {
    setCollapsedGroups((previous) => {
      const next = new Set(previous);
      if (next.has(root)) next.delete(root);
      else next.add(root);
      return next;
    });
  };

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
        <SidebarHeader subtitle="local agent console" />

        <div className="px-3 pb-2">
          <Button
            variant="secondary"
            size="md"
            className="w-full justify-start border-dashed text-xs"
            onClick={openNewSession}
          >
            <Plus className="h-4 w-4" />
            新建 Agent 会话
          </Button>
        </div>

        <div className="flex items-center justify-between px-4 pb-1 pt-2">
          <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/60">
            Agent 会话
          </span>
          <span className="font-mono text-[10px] text-muted-foreground/50">
            {sessions.length}
          </span>
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {sessions.length === 0 ? (
            <p className="px-2 py-6 text-center text-[11px] leading-5 text-muted-foreground/60">
              还没有 Agent 会话。
              <br />
              创建一个并绑定工作区目录。
            </p>
          ) : (
            <ul className="space-y-1.5">
              {groups.map((group) => {
                const collapsed = collapsedGroups.has(group.root);
                const groupActive = group.sessions.some(
                  (session) => session.id === currentId,
                );
                return (
                  <li key={group.root}>
                    <button
                      type="button"
                      onClick={() => toggleGroup(group.root)}
                      aria-expanded={!collapsed}
                      title={group.root}
                      className={cn(
                        "flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted/40",
                        groupActive
                          ? "text-foreground"
                          : "text-muted-foreground",
                      )}
                    >
                      <ChevronRight
                        className={cn(
                          "h-3 w-3 shrink-0 text-muted-foreground/50 transition-transform",
                          !collapsed && "rotate-90",
                        )}
                      />
                      <Folder className="h-3 w-3 shrink-0 text-muted-foreground/60" />
                      <span className="truncate font-mono text-[10px] font-medium">
                        {basename(group.root)}
                      </span>
                      <span className="ml-auto shrink-0 font-mono text-[9px] text-muted-foreground/50">
                        {group.sessions.length}
                      </span>
                    </button>
                    {collapsed ? null : (
                      <ul className="mt-1 space-y-1 pl-1.5">
                        {group.sessions.map((session) => {
                          const active = session.id === currentId;
                          const busy = Boolean(
                            chatBusy[session.id] || agentBusy[session.id],
                          );
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
                                title={`${session.title} · ${session.workspaceRoot}`}
                              >
                                <div className="flex items-center gap-2">
                                  <span
                                    className={cn(
                                      "h-1.5 w-1.5 shrink-0 rounded-full",
                                      MODE_DOT[session.mode],
                                    )}
                                  />
                                  <span
                                    className={cn(
                                      "truncate text-xs font-medium",
                                      active
                                        ? "text-foreground"
                                        : "text-foreground/85",
                                    )}
                                  >
                                    {session.title}
                                  </span>
                                  <span className="ml-auto flex shrink-0 items-center gap-1.5">
                                    <span className="rounded bg-muted/50 px-1 py-px text-[8px] text-muted-foreground/70">
                                      {MODE_SHORT_LABEL[session.mode]}
                                    </span>
                                    <span className="text-[9px] text-muted-foreground/50">
                                      {relativeTime(session.updatedAt)}
                                    </span>
                                  </span>
                                </div>
                              </button>
                              <button
                                type="button"
                                onClick={() => setPendingDelete(session)}
                                disabled={busy}
                                aria-label={`删除会话 ${session.title}`}
                                title={
                                  busy
                                    ? "会话执行中，停止后才能删除"
                                    : "删除会话"
                                }
                                className="absolute right-1.5 top-1.5 rounded-md p-1.5 text-muted-foreground/40 opacity-100 transition-colors hover:bg-danger/10 hover:text-danger focus-visible:opacity-100 disabled:cursor-not-allowed disabled:opacity-30 lg:opacity-0 lg:group-hover:opacity-100"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </nav>

        <div className="border-t border-border/70 p-2.5">
          <button
            type="button"
            onClick={openSettings}
            className="flex w-full items-center gap-2.5 rounded-xl border border-border/70 bg-card/40 px-2.5 py-2 text-left transition-colors hover:border-primary/25 hover:bg-muted/30"
          >
            {sandbox?.available ? (
              <ShieldCheck className="h-4 w-4 shrink-0 text-primary" />
            ) : (
              <ShieldX className="h-4 w-4 shrink-0 text-danger" />
            )}
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5 text-[11px] font-medium">
                <StatusDot
                  className={sandbox?.available ? "bg-primary" : "bg-danger"}
                  pulse={Boolean(sandbox?.available)}
                />
                {sandbox?.available
                  ? `${sandbox.runner} · ${sandbox.probe}`
                  : "沙箱不可用"}
              </span>
              <span className="mt-0.5 block truncate text-[9px] text-muted-foreground/60">
                {sandbox?.available
                  ? "非完全权限命令在沙箱内执行"
                  : "非完全权限执行会被拒绝"}
              </span>
            </span>
            <Settings className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
          </button>
        </div>
      </aside>

      <Modal
        open={pendingDelete !== null}
        onClose={deleting ? undefined : () => setPendingDelete(null)}
        title="删除会话"
        description="此操作不可撤销。"
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
          将永久删除会话「{pendingDelete?.title ?? ""}」及其全部聊天与工具记录。
          工作区中的文件不会被删除。
        </p>
      </Modal>
    </>
  );
}

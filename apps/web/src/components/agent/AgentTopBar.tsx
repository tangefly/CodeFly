import { Activity, FolderOpen, Menu, Settings } from "lucide-react";
import { selectCurrentAgentSession, useAppStore } from "../../lib/store.js";
import { PermissionPicker } from "../PermissionPicker.js";
import { Button } from "../ui.js";

export function AgentTopBar() {
  const session = useAppStore(selectCurrentAgentSession);
  const toggleSidebar = useAppStore((state) => state.toggleSidebar);
  const openAudit = useAppStore((state) => state.openAudit);
  const openSettings = useAppStore((state) => state.openSettings);
  const pendingApprovals = useAppStore((state) => state.approvals.length);

  return (
    <header className="relative z-20 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background/80 px-3 backdrop-blur sm:px-4">
      <Button
        variant="ghost"
        size="icon"
        aria-label="打开会话列表"
        onClick={toggleSidebar}
        className="lg:hidden"
      >
        <Menu className="h-4 w-4" />
      </Button>

      <div className="min-w-0 flex-1">
        {session ? (
          <>
            <div className="flex items-center gap-2">
              <h1 className="truncate text-sm font-semibold">{session.title}</h1>
              {pendingApprovals > 0 ? (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-warning/30 bg-warning/10 px-1.5 py-px text-[9px] text-warning">
                  <span className="h-1 w-1 animate-pulse rounded-full bg-warning" />
                  {pendingApprovals} 待审批
                </span>
              ) : null}
            </div>
            <div className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground/70">
              <FolderOpen className="h-2.5 w-2.5 shrink-0" />
              <span className="truncate font-mono" title={session.workspaceRoot}>
                {session.workspaceRoot}
              </span>
            </div>
          </>
        ) : (
          <div>
            <h1 className="text-sm font-semibold">CodeFly</h1>
            <p className="text-[10px] text-muted-foreground/70">未选择会话</p>
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <PermissionPicker disabled={!session} />
        <div className="mx-1 hidden h-5 w-px bg-border sm:block" />
        <Button
          variant="ghost"
          size="icon"
          aria-label="审计日志"
          title="审计日志"
          disabled={!session}
          onClick={openAudit}
        >
          <Activity className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="设置"
          title="设置"
          onClick={openSettings}
        >
          <Settings className="h-4 w-4" />
        </Button>
      </div>
    </header>
  );
}

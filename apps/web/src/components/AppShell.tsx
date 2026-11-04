import { AlertTriangle, CheckCircle2, X } from "lucide-react";
import { useAppStore } from "../lib/store.js";
import { cn } from "../lib/utils.js";
import { ApprovalDialog } from "./ApprovalDialog.js";
import { AuditDrawer } from "./AuditDrawer.js";
import { ChatTimeline } from "./ChatTimeline.js";
import { Composer } from "./Composer.js";
import { AgentSettingsDialog } from "./AgentSettingsDialog.js";
import { LlmSettingsDialog } from "./LlmSettingsDialog.js";
import { NewSessionDialog } from "./NewSessionDialog.js";
import { SearchSettingsDialog } from "./SearchSettingsDialog.js";
import { SettingsDialog } from "./SettingsDialog.js";
import { Sidebar } from "./Sidebar.js";
import { TopBar } from "./TopBar.js";

function NotificationToast() {
  const notification = useAppStore((state) => state.notification);
  const clear = useAppStore((state) => state.clearNotification);

  if (!notification) return null;
  const error = notification.kind === "error";

  return (
    <div className="cf-fade-up fixed right-4 top-16 z-[60] w-[min(92vw,380px)]">
      <div
        className={cn(
          "flex items-start gap-2.5 rounded-xl border p-3 shadow-2xl backdrop-blur",
          error
            ? "border-danger/30 bg-[#1b1012]/95"
            : "border-primary/30 bg-[#0c1713]/95",
        )}
        role="status"
      >
        {error ? (
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
        ) : (
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        )}
        <p className="min-w-0 flex-1 whitespace-pre-wrap text-xs leading-5 text-foreground/90">
          {notification.message}
        </p>
        <button
          type="button"
          onClick={clear}
          aria-label="关闭提示"
          className="rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

export function AppShell() {
  return (
    <div className="flex h-dvh overflow-hidden bg-background text-foreground">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="min-h-0 flex-1">
          <ChatTimeline />
        </main>
        <Composer />
      </div>

      <ApprovalDialog />
      <NewSessionDialog />
      <SettingsDialog />
      <LlmSettingsDialog />
      <SearchSettingsDialog />
      <AgentSettingsDialog />
      <AuditDrawer />
      <NotificationToast />
    </div>
  );
}

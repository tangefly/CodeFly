import { Menu, Settings, Sparkles } from "lucide-react";
import { selectCurrentChatSession, useAppStore } from "../../lib/store.js";
import { Button } from "../ui.js";

/** Top bar for plain conversations: model status only, no permissions. */
export function ChatTopBar() {
  const session = useAppStore(selectCurrentChatSession);
  const toggleSidebar = useAppStore((state) => state.toggleSidebar);
  const openLlmSettings = useAppStore((state) => state.openLlmSettings);
  const llmSettings = useAppStore((state) => state.llmSettings);

  return (
    <header className="relative z-20 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background/80 px-3 backdrop-blur sm:px-4">
      <Button
        variant="ghost"
        size="icon"
        aria-label="打开对话列表"
        onClick={toggleSidebar}
        className="lg:hidden"
      >
        <Menu className="h-4 w-4" />
      </Button>

      <div className="min-w-0 flex-1">
        {session ? (
          <>
            <h1 className="truncate text-sm font-semibold">{session.title}</h1>
            <p className="mt-0.5 text-[10px] text-muted-foreground/70">
              本地模型对话 · 不执行命令
            </p>
          </>
        ) : (
          <div>
            <h1 className="text-sm font-semibold">对话</h1>
            <p className="text-[10px] text-muted-foreground/70">
              选择或新建一个对话
            </p>
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={openLlmSettings}
          title="模型设置"
          className="inline-flex h-8 max-w-[220px] items-center gap-1.5 rounded-lg border border-border bg-elevated px-2.5 text-[10px] text-muted-foreground transition-colors hover:border-primary/30 hover:text-foreground"
        >
          <Sparkles className="h-3 w-3 shrink-0 text-primary" />
          <span className="truncate">
            {llmSettings?.configured ? llmSettings.model : "未配置模型"}
          </span>
        </button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="模型设置"
          title="模型设置"
          onClick={openLlmSettings}
        >
          <Settings className="h-4 w-4" />
        </Button>
      </div>
    </header>
  );
}

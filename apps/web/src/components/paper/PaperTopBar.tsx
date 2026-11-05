import { Activity, Library, Menu, Settings, X } from "lucide-react";
import { selectCurrentPaperSession, useAppStore } from "../../lib/store.js";
import { Button } from "../ui.js";

export function PaperTopBar() {
  const session = useAppStore(selectCurrentPaperSession);
  const paperIndex = useAppStore((state) => state.paperIndex);
  const paperTotal = useAppStore((state) => state.paperTotal);
  const toggleSidebar = useAppStore((state) => state.toggleSidebar);
  const openSettings = useAppStore((state) => state.openSettings);
  const openAudit = useAppStore((state) => state.openAudit);
  const openPaperLibrary = useAppStore((state) => state.openPaperLibrary);
  const openPaperDetail = useAppStore((state) => state.openPaperDetail);
  const removePaperFromContext = useAppStore(
    (state) => state.removePaperFromContext,
  );

  const contextPapers = (session?.paperIds ?? [])
    .map((id) => paperIndex[id])
    .filter((paper) => paper !== undefined);

  return (
    <header className="relative z-20 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background/80 px-3 backdrop-blur sm:px-4">
      <Button
        variant="ghost"
        size="icon"
        aria-label="打开论文会话列表"
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
              <span className="shrink-0 rounded-full border border-primary/25 bg-primary/10 px-1.5 py-px text-[9px] text-primary">
                论文助手
              </span>
            </div>
            {contextPapers.length > 0 ? (
              <div className="mt-0.5 flex flex-wrap items-center gap-1">
                {contextPapers.slice(0, 4).map((paper) => (
                  <span
                    key={paper.id}
                    className="group inline-flex max-w-[18rem] items-center gap-1 rounded border border-border/70 bg-card/60 px-1.5 py-0.5 text-[9px] text-muted-foreground"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        openPaperLibrary();
                        openPaperDetail(paper.id);
                      }}
                      className="truncate text-left hover:text-foreground"
                      title={paper.title}
                    >
                      {paper.title}
                    </button>
                    <button
                      type="button"
                      aria-label="从当前上下文移除"
                      title="从当前上下文移除"
                      onClick={() => void removePaperFromContext(paper.id)}
                      className="rounded text-muted-foreground/40 hover:text-danger"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </span>
                ))}
                {contextPapers.length > 4 ? (
                  <span className="text-[9px] text-muted-foreground/50">
                    +{contextPapers.length - 4}
                  </span>
                ) : null}
              </div>
            ) : (
              <p className="mt-0.5 text-[10px] text-muted-foreground/70">
                arXiv 检索 · PDF 阅读 · 本地论文库
              </p>
            )}
          </>
        ) : (
          <div>
            <h1 className="text-sm font-semibold">论文助手</h1>
            <p className="text-[10px] text-muted-foreground/70">
              选择或新建一个论文会话
            </p>
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          variant="outline"
          size="sm"
          onClick={openPaperLibrary}
          className="h-8"
        >
          <Library className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">论文库</span>
          <span className="font-mono text-[9px] text-muted-foreground/60">
            {paperTotal}
          </span>
        </Button>
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

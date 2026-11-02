import { useEffect, useRef, type ReactNode } from "react";
import { AlertTriangle, Loader2, Terminal } from "lucide-react";
import { bootstrapToken, clearToken } from "./lib/api.js";
import { useAppStore } from "./lib/store.js";
import { AppShell } from "./components/AppShell.js";
import { TokenGate } from "./components/TokenGate.js";
import { Button } from "./components/ui.js";

function CenteredCard({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-background p-6">
      <div className="pointer-events-none absolute -top-40 left-1/2 h-96 w-[36rem] -translate-x-1/2 rounded-full bg-primary/10 blur-3xl" />
      <div className="relative w-full max-w-md rounded-2xl border border-border bg-card/80 p-8 text-center shadow-2xl">
        {children}
      </div>
    </div>
  );
}

function LoadingScreen() {
  return (
    <CenteredCard>
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-primary/25 bg-gradient-to-br from-primary/20 to-primary/5 text-primary shadow-[0_0_40px_-10px_var(--primary)]">
        <Terminal className="h-6 w-6" />
      </div>
      <h1 className="mt-4 text-lg font-semibold">CodeFly</h1>
      <p className="mt-1 text-xs text-muted-foreground">正在连接本地服务…</p>
      <Loader2 className="mx-auto mt-6 h-5 w-5 animate-spin text-primary" />
    </CenteredCard>
  );
}

function ErrorScreen() {
  const error = useAppStore((state) => state.error);
  const init = useAppStore((state) => state.init);

  const changeToken = (): void => {
    clearToken();
    useAppStore.setState({ phase: "token-required", error: null });
  };

  return (
    <CenteredCard>
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-danger/30 bg-danger/10 text-danger">
        <AlertTriangle className="h-6 w-6" />
      </div>
      <h1 className="mt-4 text-lg font-semibold">无法连接本地服务</h1>
      <p className="mt-2 break-words rounded-lg border border-border bg-background/50 px-3 py-2 text-left font-mono text-[11px] leading-5 text-muted-foreground">
        {error ?? "unknown error"}
      </p>
      <div className="mt-5 flex justify-center gap-2">
        <Button variant="outline" onClick={changeToken}>
          更换令牌
        </Button>
        <Button variant="primary" onClick={() => void init()}>
          重试
        </Button>
      </div>
    </CenteredCard>
  );
}

export default function App() {
  const phase = useAppStore((state) => state.phase);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    bootstrapToken();
    void useAppStore.getState().init();
  }, []);

  if (phase === "token-required") return <TokenGate />;
  if (phase === "error") return <ErrorScreen />;
  if (phase !== "ready") return <LoadingScreen />;
  return <AppShell />;
}

import { useState, type FormEvent } from "react";
import { KeyRound, Loader2, Terminal } from "lucide-react";
import { useAppStore } from "../lib/store.js";
import { Button } from "./ui.js";

export function TokenGate() {
  const error = useAppStore((state) => state.error);
  const setToken = useAppStore((state) => state.setToken);
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const token = value.trim();
    if (!token || pending) return;
    setPending(true);
    await setToken(token);
    setPending(false);
  };

  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-background p-6">
      <div className="pointer-events-none absolute -top-40 left-1/2 h-96 w-[36rem] -translate-x-1/2 rounded-full bg-primary/10 blur-3xl" />
      <div className="pointer-events-none absolute bottom-0 right-0 h-72 w-72 rounded-full bg-sky-400/5 blur-3xl" />

      <form
        onSubmit={(event) => void submit(event)}
        className="cf-fade-up relative w-full max-w-sm rounded-2xl border border-border bg-card/80 p-6 shadow-2xl backdrop-blur"
      >
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-primary/25 bg-gradient-to-br from-primary/20 to-primary/5 text-primary shadow-[0_0_30px_-8px_var(--primary)]">
            <Terminal className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-base font-semibold tracking-tight">CodeFly</h1>
            <p className="text-[11px] text-muted-foreground">本地 agent 控制台</p>
          </div>
        </div>

        <div className="mt-6 space-y-2">
          <label htmlFor="codefly-token" className="block text-xs font-medium">
            访问令牌
          </label>
          <div className="relative">
            <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              id="codefly-token"
              type="password"
              autoFocus
              autoComplete="off"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="粘贴启动日志中的 token"
              className="h-10 w-full rounded-lg border border-border bg-background pl-9 pr-3 font-mono text-xs text-foreground placeholder:font-sans placeholder:text-muted-foreground/50 focus:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>
          <p className="text-[10px] leading-5 text-muted-foreground/70">
            打开服务终端打印的{" "}
            <code className="rounded bg-muted/60 px-1 font-mono text-[10px]">
              http://127.0.0.1:8787/?token=…
            </code>{" "}
            链接会自动完成登录。令牌只保存在当前浏览器标签页的 sessionStorage。
          </p>
        </div>

        {error ? (
          <p className="mt-3 rounded-lg border border-danger/25 bg-danger/5 px-3 py-2 text-[11px] leading-5 text-danger">
            {error}
          </p>
        ) : null}

        <Button
          type="submit"
          variant="primary"
          className="mt-5 w-full"
          disabled={pending || !value.trim()}
        >
          {pending ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              正在连接…
            </>
          ) : (
            "连接"
          )}
        </Button>

        <p className="mt-4 text-center text-[10px] text-muted-foreground/50">
          服务只监听 127.0.0.1；所有 API 请求都需要 Bearer token。
        </p>
      </form>
    </div>
  );
}

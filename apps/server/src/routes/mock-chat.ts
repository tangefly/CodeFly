import type { FastifyInstance } from "fastify";
import { mockChatSchema } from "@codefly/protocol";
import { SSE_HEADERS, sseFrame } from "../exec/sse.js";
import type { SessionStore } from "../session/store.js";

function buildMockReply(userMessage: string): string {
  const quoted = userMessage.replace(/\r\n/g, "\n").split("\n").join("\n> ");
  return [
    "## 流式渲染自检",
    "",
    `> 你说：${quoted}`,
    "",
    "这是一段由 **mock 服务** 分块推送的示例回复，用来验证 Markdown、GFM 表格、KaTeX 与代码高亮在流式输出过程中的稳定性。",
    "",
    "| 能力 | 状态 | 说明 |",
    "| --- | :---: | --- |",
    "| Markdown | ✅ | 标题、列表、引用 |",
    "| GFM 表格 | ✅ | 你正在看的这张表 |",
    "| KaTeX | ✅ | 行内与块级公式 |",
    "| Shiki | ✅ | 代码高亮与复制按钮 |",
    "",
    "行内公式 $E = mc^2$，块级公式：",
    "",
    "$$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$",
    "",
    "```ts",
    'type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";',
    "",
    "function allowsWrite(mode: SandboxMode): boolean {",
    '  return mode !== "read-only";',
    "}",
    "```",
    "",
    "```python",
    "def fib(n: int) -> int:",
    "    a, b = 0, 1",
    "    for _ in range(n):",
    "        a, b = b, a + b",
    "    return a",
    "```",
    "",
    "```mermaid",
    "flowchart LR",
    "  Browser[Browser] --> API[Fastify API]",
    "  API --> Sandbox[Sandbox runner]",
    "  Sandbox --> Landlock[Landlock]",
    "```",
    "",
    "---",
    "",
    "流式结束。接下来可以接入真正的 LLM tool call，UI 不需要重做。",
  ].join("\n");
}

export function registerMockChatRoutes(
  app: FastifyInstance,
  deps: { sessions: SessionStore },
): void {
  app.post("/api/sessions/:id/mock-chat", async (request, reply) => {
    const { id } = request.params as { id: string };
    deps.sessions.getOrThrow(id);
    const body = mockChatSchema.parse(request.body);
    const points = Array.from(buildMockReply(body.message));

    reply.hijack();
    reply.raw.writeHead(200, SSE_HEADERS);
    reply.raw.setTimeout(0);

    let seq = 0;
    let index = 0;
    let closed = false;

    const write = (data: unknown): void => {
      if (!closed && !reply.raw.writableEnded) {
        seq += 1;
        reply.raw.write(sseFrame(String(seq), data));
      }
    };

    const finish = (): void => {
      clearInterval(timer);
      if (!closed) {
        write({ type: "done" });
        closed = true;
        reply.raw.end();
      }
    };

    const tick = (): void => {
      if (closed) return;
      const size = 6 + ((index * 7) % 19);
      const chunk = points.slice(index, index + size).join("");
      index += size;
      if (chunk) write({ type: "chunk", data: chunk });
      if (index >= points.length) finish();
    };

    const timer = setInterval(tick, 24);
    timer.unref?.();

    reply.raw.on("close", () => {
      closed = true;
      clearInterval(timer);
    });

    return reply;
  });
}

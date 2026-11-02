import { createServer, type RequestListener, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  LlmClient,
  LlmError,
  chatCompletionsUrl,
  type LlmChatMessage,
} from "../src/llm/client.js";
import type { LlmInternalConfig } from "../src/llm/config-store.js";

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function startServer(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no server port");
  return `http://127.0.0.1:${address.port}/v1`;
}

function makeConfig(baseUrl: string, overrides: Partial<LlmInternalConfig> = {}): LlmInternalConfig {
  return {
    baseUrl,
    apiKey: "sk-test-key",
    model: "test-model",
    temperature: null,
    maxTokens: null,
    systemPrompt: "system",
    timeoutMs: 5000,
    updatedAt: null,
    ...overrides,
  };
}

const messages: LlmChatMessage[] = [{ role: "user", content: "hello" }];

describe("chatCompletionsUrl", () => {
  it("appends the endpoint and preserves an explicit one", () => {
    expect(chatCompletionsUrl("https://api.example.com/v1")).toBe(
      "https://api.example.com/v1/chat/completions",
    );
    expect(chatCompletionsUrl("https://api.example.com/v1/")).toBe(
      "https://api.example.com/v1/chat/completions",
    );
    expect(
      chatCompletionsUrl("https://api.example.com/v1/chat/completions"),
    ).toBe("https://api.example.com/v1/chat/completions");
  });
});

describe("LlmClient", () => {
  it("parses SSE deltas split across chunks", async () => {
    let auth = "";
    let requestUrl = "";
    const baseUrl = await startServer((req, res) => {
      auth = String(req.headers.authorization ?? "");
      requestUrl = req.url ?? "";
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      // Deliberately split a JSON line across two TCP chunks.
      res.write('data: {"choices":[{"delta":{"content":"Hel');
      setTimeout(() => {
        res.write('lo"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}\n\n');
        res.end("data: [DONE]\n\n");
      }, 5);
    });

    const client = new LlmClient();
    const deltas: string[] = [];
    const result = await client.streamChat(
      makeConfig(baseUrl),
      messages,
      (delta) => deltas.push(delta),
      new AbortController().signal,
    );

    expect(requestUrl).toBe("/v1/chat/completions");
    expect(auth).toBe("Bearer sk-test-key");
    expect(deltas).toEqual(["Hello", " world"]);
    expect(result.content).toBe("Hello world");
    expect(result.finishReason).toBe("stop");
  });

  it("supports non-streaming JSON responses", async () => {
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          model: "test-model",
          choices: [{ message: { content: "JSON ok" } }],
        }),
      );
    });

    const client = new LlmClient();
    const deltas: string[] = [];
    const result = await client.streamChat(
      makeConfig(baseUrl),
      messages,
      (delta) => deltas.push(delta),
      new AbortController().signal,
    );

    expect(deltas).toEqual(["JSON ok"]);
    expect(result.content).toBe("JSON ok");
  });

  it("redacts the api key from HTTP errors", async () => {
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bad key sk-test-key" } }));
    });

    const client = new LlmClient();
    try {
      await client.streamChat(
        makeConfig(baseUrl),
        messages,
        () => undefined,
        new AbortController().signal,
      );
      throw new Error("expected the client to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(LlmError);
      expect((error as LlmError).code).toBe("LLM_HTTP_ERROR");
      expect((error as Error).message).toContain("认证失败");
      expect((error as Error).message).not.toContain("sk-test-key");
      expect((error as Error).message).toContain("[redacted]");
    }
  });

  it("surfaces an upstream error event", async () => {
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end('data: {"error":{"message":"quota exceeded"}}\n\n');
    });

    const client = new LlmClient();
    await expect(
      client.streamChat(
        makeConfig(baseUrl),
        messages,
        () => undefined,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "LLM_UPSTREAM_ERROR" });
  });

  it("completes a non-streaming request", async () => {
    let receivedBody = "";
    const baseUrl = await startServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        receivedBody = Buffer.concat(chunks).toString("utf8");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            model: "returned-model",
            choices: [{ message: { content: "OK" } }],
          }),
        );
      });
    });

    const client = new LlmClient();
    const result = await client.complete(
      makeConfig(baseUrl),
      messages,
      AbortSignal.timeout(5000),
      16,
    );

    expect(result.content).toBe("OK");
    expect(result.model).toBe("returned-model");
    const body = JSON.parse(receivedBody) as { stream: boolean; max_tokens: number };
    expect(body.stream).toBe(false);
    expect(body.max_tokens).toBe(16);
  });

  it("accumulates streamed tool calls and forwards tool definitions", async () => {
    let receivedBody = "";
    let requestUrl = "";
    const baseUrl = await startServer((req, res) => {
      requestUrl = req.url ?? "";
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        receivedBody = Buffer.concat(chunks).toString("utf8");
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: "Let me check." } }] })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
                      type: "function",
                      function: { name: "run_command", arguments: '{"comm' },
                    },
                  ],
                },
              },
            ],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      function: { arguments: 'and":"ls"}' },
                    },
                  ],
                },
              },
            ],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: {}, finish_reason: "tool_calls" }],
          })}\n\n`,
        );
        res.end("data: [DONE]\n\n");
      });
    });

    const client = new LlmClient();
    const deltas: string[] = [];
    const result = await client.streamChat(
      makeConfig(baseUrl),
      messages,
      (delta) => deltas.push(delta),
      new AbortController().signal,
      {
        tools: [
          {
            type: "function",
            function: {
              name: "run_command",
              description: "run a command",
              parameters: {
                type: "object",
                properties: { command: { type: "string" } },
                required: ["command"],
              },
            },
          },
        ],
      },
    );

    expect(requestUrl).toBe("/v1/chat/completions");
    expect(deltas).toEqual(["Let me check."]);
    expect(result.content).toBe("Let me check.");
    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toEqual([
      {
        id: "call_1",
        name: "run_command",
        arguments: '{"command":"ls"}',
      },
    ]);

    const body = JSON.parse(receivedBody) as {
      tools?: unknown[];
      tool_choice?: string;
      stream?: boolean;
    };
    expect(body.stream).toBe(true);
    expect(body.tools).toHaveLength(1);
    expect(body.tool_choice).toBe("auto");
  });

  it("aborts an in-flight stream", async () => {
    const baseUrl = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
      // Keep the connection open until the test aborts.
    });

    const client = new LlmClient();
    const controller = new AbortController();
    const deltas: string[] = [];
    const pending = client.streamChat(
      makeConfig(baseUrl),
      messages,
      (delta) => deltas.push(delta),
      controller.signal,
    );
    setTimeout(() => controller.abort(), 30);

    await expect(pending).rejects.toMatchObject({ code: "LLM_ABORTED" });
    expect(deltas).toEqual(["partial"]);
  });
});

import { existsSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { ZodError } from "zod";
import { config, paths } from "./config.js";
import { registerSecurity } from "./auth.js";
import { AppError, errnoCode } from "./http/errors.js";
import { AuditLog } from "./audit/log.js";
import { SessionStore } from "./session/store.js";
import { SettingsStore } from "./settings/store.js";
import { ApprovalService } from "./approval/service.js";
import { SandboxManager } from "./sandbox/runner.js";
import { gpuReadWritePaths } from "./sandbox/devices.js";
import { ExecService } from "./exec/service.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerExecRoutes } from "./routes/exec.js";
import { registerFsRoutes } from "./routes/fs.js";
import { registerAuditRoutes } from "./routes/audit.js";
import { registerMockChatRoutes } from "./routes/mock-chat.js";
import { registerLlmRoutes } from "./routes/llm.js";
import { registerAgentRoutes } from "./routes/agent.js";
import { LlmConfigStore } from "./llm/config-store.js";
import { MessageStore } from "./llm/messages.js";
import { LlmClient } from "./llm/client.js";
import { ChatService } from "./llm/service.js";
import { SessionRunLock } from "./llm/run-lock.js";
import { AgentConfigStore } from "./agent/config-store.js";
import { AgentToolExecutor } from "./agent/tools.js";
import { AgentService } from "./agent/service.js";

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  await mkdir(config.dataDir, { recursive: true });
  try {
    // Audit + chat history and the provider key live here.
    await chmod(config.dataDir, 0o700);
  } catch {
    // Best effort on filesystems without POSIX modes.
  }
  await mkdir(paths.spills, { recursive: true });

  const audit = new AuditLog(paths.audit);
  await audit.init();

  const sessions = new SessionStore(paths.sessions);
  await sessions.init();

  const settings = new SettingsStore(paths.settings);
  await settings.init();

  const llmConfig = new LlmConfigStore(paths.llm);
  await llmConfig.init();

  const agentConfig = new AgentConfigStore(paths.agent);
  await agentConfig.init();

  const messageStore = new MessageStore(
    paths.messages,
    config.llm.maxHistoryMessages,
  );
  await messageStore.init();

  const runLock = new SessionRunLock();
  const chat = new ChatService({
    messages: messageStore,
    llmConfig,
    audit,
    client: new LlmClient(),
    lock: runLock,
    options: {
      contextBudgetChars: config.llm.contextBudgetChars,
      testMaxTokens: config.llm.testMaxTokens,
    },
  });

  const sandbox = new SandboxManager();
  sandbox.init();

  const sandboxExtraReadWritePaths = [
    ...new Set([
      ...(config.sandbox.gpuAccess ? gpuReadWritePaths() : []),
      ...config.sandbox.extraReadWritePaths,
    ]),
  ];

  const approvals = new ApprovalService(audit);
  const exec = new ExecService({
    sessions,
    approvals,
    audit,
    sandbox,
    options: {
      defaultTimeoutMs: config.exec.defaultTimeoutMs,
      maxTimeoutMs: config.exec.maxTimeoutMs,
      outputLimitBytes: config.exec.outputLimitBytes,
      flushIntervalMs: config.exec.flushIntervalMs,
      approvalTimeoutMs: config.approvalTimeoutMs,
      denialTtlMs: config.exec.denialTtlMs,
      spillDir: paths.spills,
      extraReadWritePaths: sandboxExtraReadWritePaths,
    },
  });

  const agent = new AgentService({
    messages: messageStore,
    llmConfig,
    agentConfig,
    audit,
    client: new LlmClient(),
    tools: new AgentToolExecutor(),
    lock: runLock,
    exec,
    dataDir: config.dataDir,
    maxReadBytes: config.fs.maxReadBytes,
    maxWriteBytes: config.fs.maxWriteBytes,
    contextBudgetChars: config.llm.contextBudgetChars,
  });

  const app = Fastify({
    logger: false,
    bodyLimit: 16 * 1024 * 1024,
    forceCloseConnections: true,
    trustProxy: false,
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      });
    }

    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "invalid request payload",
          details: error.issues,
        },
      });
    }

    const errno = errnoCode(error);
    if (errno === "ENOENT") {
      return reply
        .code(404)
        .send({ error: { code: "FS_NOT_FOUND", message: formatError(error) } });
    }
    if (errno === "EACCES" || errno === "EPERM") {
      return reply
        .code(403)
        .send({ error: { code: "FS_DENIED", message: formatError(error) } });
    }
    if (errno === "EISDIR" || errno === "ENOTDIR" || errno === "ELOOP") {
      return reply
        .code(400)
        .send({ error: { code: "FS_ERROR", message: formatError(error) } });
    }

    const statusCode =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : 500;
    if (statusCode >= 400 && statusCode < 500) {
      const code = (error as { code?: unknown }).code;
      return reply.code(statusCode).send({
        error: {
          code: typeof code === "string" ? code : "BAD_REQUEST",
          message: formatError(error),
        },
      });
    }

    console.error("[server] unhandled error", error);
    return reply
      .code(500)
      .send({ error: { code: "INTERNAL", message: "internal server error" } });
  });

  registerSecurity(app, config.token);

  registerHealthRoute(app, {
    sandbox,
    version: config.version,
    dev: Boolean(config.devWebUrl),
  });
  registerSessionRoutes(app, {
    sessions,
    settings,
    audit,
    messages: messageStore,
    lock: runLock,
    exec,
  });
  registerExecRoutes(app, { sessions, exec });
  registerFsRoutes(app, {
    sessions,
    audit,
    dataDir: config.dataDir,
    maxReadBytes: config.fs.maxReadBytes,
    maxWriteBytes: config.fs.maxWriteBytes,
  });
  registerAuditRoutes(app, { sessions, audit });
  registerMockChatRoutes(app, { sessions });
  registerLlmRoutes(app, {
    sessions,
    messages: messageStore,
    llmConfig,
    chat,
    audit,
  });
  registerAgentRoutes(app, {
    sessions,
    agentConfig,
    agent,
    audit,
  });

  if (config.devWebUrl) {
    app.get("/", async (_request, reply) => {
      return reply.redirect(
        `${config.devWebUrl}/?token=${encodeURIComponent(config.token)}`,
      );
    });
  } else if (existsSync(paths.webDist)) {
    await app.register(fastifyStatic, { root: paths.webDist, prefix: "/" });
    app.setNotFoundHandler((request, reply) => {
      if (
        (request.method === "GET" || request.method === "HEAD") &&
        !request.url.startsWith("/api")
      ) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({
        error: { code: "NOT_FOUND", message: "not found" },
      });
    });
  } else {
    app.get("/", async () => ({
      name: "CodeFly",
      message: "Web build not found. Run `pnpm build` or start with `pnpm dev`.",
    }));
  }

  await app.listen({ host: config.host, port: config.port });

  const status = sandbox.status();
  const llmStatus = llmConfig.getPublic();
  const displayHost = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
  const url = `http://${displayHost}:${config.port}/?token=${encodeURIComponent(config.token)}`;

  console.log("");
  console.log(`  CodeFly v${config.version}`);
  console.log(
    `  sandbox : ${status.runner ?? "unavailable"} (${status.probe})` +
      (config.devWebUrl ? "  [dev: redirecting to Vite]" : ""),
  );
  const deviceStatus =
    sandboxExtraReadWritePaths.length > 0
      ? `${sandboxExtraReadWritePaths.length} path(s) granted read-write`
      : config.sandbox.gpuAccess
        ? "no device paths found"
        : "device access disabled";
  console.log(`  devices : ${deviceStatus}`);
  console.log(
    `  llm     : ${
      llmStatus.configured
        ? `${llmStatus.model} @ ${llmStatus.baseUrl}`
        : "not configured (chat disabled)"
    }`,
  );
  console.log(`  data    : ${config.dataDir}`);
  console.log(`  open    : ${url}`);
  console.log("");

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[codefly] ${signal} received, shutting down...`);
    const hardExit = setTimeout(() => process.exit(1), 2000);
    hardExit.unref();
    try {
      await exec.shutdown();
      await app.close();
    } catch (error) {
      console.error("[codefly] shutdown error", error);
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => {
    console.error("[process] unhandled rejection", reason);
  });
}

main().catch((error) => {
  console.error("[codefly] failed to start", error);
  process.exit(1);
});

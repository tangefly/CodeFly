# CodeFly

本地单用户 agent 控制台：浏览器通过 REST + SSE 与本机 Node 服务通信，shell 命令在
Landlock 沙箱内执行，文件工具通过 canonicalize + containment 做写围栏。

当前版本包含：

- Web UI：会话列表、聊天式时间线、Agent 工具卡片、实时输出、审批弹窗、审计抽屉。
- **真实聊天模式**：通过 OpenAI-compatible `/chat/completions` 接入 LLM，流式输出、
  多轮上下文、消息持久化与取消。
- **Agent 模式**：OpenAI tool-calling + agent loop。模型可调用 `run_command`、
  `read_file`、`write_file`、`edit_file`、`list_files`；工具执行复用 shell 沙箱、
  文件围栏和一次性审批。
- 三种权限：`read-only` / `workspace-write` / `danger-full-access`（默认 `workspace-write + ask`）。
- Linux 沙箱：优先 `bwrap`，不可用时用 `@deepseek-ai/node-addon-system` 的 Landlock launcher；
  两者都不可用时 **fail-closed**，拒绝执行。
- 文件工具写围栏：workspace + `/tmp`；拒绝 `.git/`、`.claude/` 等受保护路径。
- 一次性审批：越界操作可带 `sandbox_permissions` + `justification` 重试；只对本次生效。
- Markdown / GFM / KaTeX / Shiki 流式渲染。
- 审计：JSONL 追加到 `data/audit.jsonl`。

> 安全模型：**读取与网络默认不隔离**。它防的是误写/越界写，不是防读密钥或网络外传。
> 服务只监听 `127.0.0.1`，所有 API 请求需要启动时随机生成的 Bearer token。
> 聊天模式只对话；Agent 模式会用当前会话权限执行工具，受同样的沙箱、写围栏与审批约束。

## 快速开始

要求：Node.js >= 20.19、pnpm 11、Linux（Landlock ABI）或已安装 bwrap。

```bash
pnpm install
pnpm dev
```

`pnpm dev` 会先编译共享协议包，然后同时启动：

- 服务端：`http://127.0.0.1:8787`（Vite 开发服务器在 `http://127.0.0.1:5173`，API 经代理转发）
- 打开终端打印的 `open` 链接（含 `?token=...`）。服务端在开发模式下会重定向到 Vite，
  前端把 token 存入 `sessionStorage` 后从地址栏移除。

生产模式：

```bash
pnpm build
pnpm start
```

然后打开启动日志中的 `http://127.0.0.1:8787/?token=...`。

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CODEFLY_PORT` | `8787` | 监听端口 |
| `CODEFLY_HOST` | `127.0.0.1` | 监听地址；不要改成 `0.0.0.0` |
| `CODEFLY_TOKEN` | 随机生成 | 固定 token（仅建议本地调试） |
| `CODEFLY_DATA_DIR` | `<repo>/data` | 审计、会话、消息、设置、LLM 配置、spill 目录 |
| `CODEFLY_DEV_WEB_URL` | 无 | 设置后把 `/` 重定向到 Vite 开发服务器 |
| `CODEFLY_APPROVAL_TIMEOUT_MS` | `120000` | 审批超时；超时视为拒绝 |

## 配置模型 API

聊天使用 **OpenAI-compatible** 协议，兼容 DeepSeek、OpenAI、Ollama、vLLM、OpenRouter 等。

### 通过 UI

1. 顶栏齿轮 → 「设置」→「聊天模型」→「配置」。
2. 在「厂商」下拉选择服务商，Base URL 与模型会自动填充；列表中没有的厂商/模型选
   「其他（自定义）」后手动填写 URL 与模型名。常见示例：
   - DeepSeek：`https://api.deepseek.com/v1`，`deepseek-chat`
   - OpenAI：`https://api.openai.com/v1`，`gpt-4o-mini` 等
   - Ollama：`http://127.0.0.1:11434/v1`，`qwen2.5`（API Key 可留空）
3. 「测试连接」通过后「保存配置」。
4. Composer 切换到「聊天」或「Agent」，输入消息即可流式对话 / 执行任务。

### 通过 API

```bash
# 从服务启动日志中获取 token
TOKEN=...
BASE=http://127.0.0.1:8787

# 保存配置（apiKey 不会出现在任何响应中）
curl -X PUT "$BASE/api/llm/settings" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"baseUrl":"https://api.deepseek.com/v1","apiKey":"sk-...","model":"deepseek-chat"}'

# 查看公开配置（无 apiKey；只返回 hasApiKey / apiKeyHint）
curl "$BASE/api/llm/settings" -H "Authorization: Bearer $TOKEN"

# 测试连接
curl -X POST "$BASE/api/llm/test" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{}'

# 创建会话并聊天（SSE 流）
SID=...
curl -N -X POST "$BASE/api/sessions/$SID/chat" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"message":"你好，介绍一下你自己"}'

# 读取持久化的聊天历史
curl "$BASE/api/sessions/$SID/messages" -H "Authorization: Bearer $TOKEN"
```

配置与聊天历史保存位置：

- `data/llm.json`：Base URL、Model、API Key 等；文件权限 `0600`，数据目录 `0700`。
- `data/agent.json`：Agent 最大步数、命令超时、启用工具、system prompt；权限 `0600`。
- `data/messages.json`：每个会话的聊天与 Agent 消息、工具调用/结果（最多保留 500 条/会话）。
- `data/audit.jsonl`：`llm.config.changed`、`llm.chat`、`agent.run`、`agent.tool` 等事件
  （不记录消息内容与 Key）。

Base URL 可以带 `/v1`，也可以直接填写完整的 `/chat/completions` 地址。API Key 只保存在
服务端本地，不会返回给前端，也不会传给执行 shell 的沙箱进程。

## Agent 模式

Composer 的「Agent」标签会启动 tool-calling loop：

1. 模型收到系统提示、当前会话历史和工具定义。
2. 模型流式输出文本和/或一个或多个 tool call。
3. 服务端顺序执行工具，把结果作为 `tool` 消息回传，再次请求模型。
4. 模型不再调用工具时输出最终回答；达到最大步数则停止并提示。

可用工具：

| 工具 | 说明 |
| --- | --- |
| `run_command` | `bash -c`，在 Landlock 沙箱内运行；默认只能写工作区与 `/tmp` |
| `read_file` | 读取 UTF-8 文本；相对路径基于工作区，绝对路径可读 |
| `write_file` | 创建/覆盖文件；受写围栏与受保护路径限制 |
| `edit_file` | 精确字符串替换，默认要求唯一匹配 |
| `list_files` | 列目录（最多 500 项） |

Agent 设置（顶栏设置 → Agent 模式 → 配置，或 Agent 标签旁的齿轮）：

- 最大步数（默认 10，范围 1–500）
- 每条命令超时（默认 60s）
- 启用哪些工具
- 自定义 Agent system prompt

命令被沙箱拒绝后，模型可以按工具结果提示，用**完全相同的命令**加
`sandbox_permissions` + `justification` 重试；这会复用 exec 的一次性审批弹窗，
只有用户点「仅本次允许」才会以更宽模式执行。文件工具不能请求提权。

通过 API 配置 Agent：

```bash
curl -X PUT "$BASE/api/agent/settings" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"maxSteps":10,"commandTimeoutMs":60000,"enabledTools":["run_command","read_file","write_file","edit_file","list_files"]}'

curl -N -X POST "$BASE/api/sessions/$SID/agent" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"message":"检查项目结构并运行测试"}'
```

Agent SSE 事件：`agent.started`、`agent.step`、`agent.delta`、`agent.message`、
`agent.tool.started`、`agent.tool.finished`、`agent.approval_required`、
`agent.approval_decided`、`agent.done`、`agent.error`。

## 使用

1. 「新建会话」点击工作区下拉框，逐级浏览目录并选择已存在的**绝对路径**作为工作区。
2. Composer 的「聊天」标签与模型流式对话；生成中可点「停止」取消。
3. Composer 的「Agent」标签启动 tool-calling loop；工具卡片显示命令/文件操作及结果，
   提权时弹出审批；执行中可点「停止」。
4. 顶栏 / Agent 标签的权限选择器切换会话权限；选「完全权限」需要二次风险确认。
5. Agent 命令被沙箱拒绝时，模型可按工具结果提示用同一命令请求提权，弹出审批弹窗，
   允许只对这次调用生效。
6. 顶栏「审计日志」查看当前会话的 `approval.*`、`exec.*`、`fs.write`、`llm.*`、`agent.*` 事件。

刷新页面后会从 `data/messages.json` 恢复聊天与 Agent 历史（含工具调用/结果）。

## 目录结构

```text
packages/protocol/   # 共享类型 + zod schemas
apps/server/         # Fastify：policy / sandbox / exec / fs / approval / llm / agent / session / audit / routes
apps/web/            # React 19 + Vite + Tailwind + Streamdown
data/                # 运行时数据（gitignore）
```

服务端关键路径：

| 路径 | 作用 |
| --- | --- |
| `PUT /api/llm/settings` | 保存 OpenAI-compatible 配置（不返回 Key） |
| `GET /api/llm/settings` | 公开配置（`configured` / `model` / `apiKeyHint`） |
| `POST /api/llm/test` | 用保存的配置做一次最小非流式请求 |
| `GET /api/fs/browse` | 新建会话时的目录浏览（子目录列表，无需会话） |
| `POST /api/sessions/:id/chat` | SSE 聊天流（`chat.started` / `chat.delta` / `chat.done`） |
| `PUT /api/agent/settings` | 保存 Agent 最大步数 / 工具 / 超时 / prompt |
| `POST /api/sessions/:id/agent` | Agent tool-calling SSE 流（工具调用/结果、审批） |
| `GET /api/sessions/:id/messages` | 持久化的聊天与 Agent 历史 |
| `POST /api/sessions/:id/exec` | 内部执行 API（Agent 的 `run_command` 使用同一 ExecService；UI 无手动命令模式） |
| `GET /api/exec/:execId/events` | 内部执行 SSE（调试/集成用） |
| `POST /api/exec/:execId/approval` | Agent 提权审批的 `allow_once` / `deny` |
| `POST /api/exec/:execId/cancel` | 内部取消执行 |
| `POST /api/sessions/:id/fs/write` / `edit` | 受围栏保护的文件写入 |
| `GET /api/sessions/:id/audit` | 最近审计事件 |

## 已知限制

- 读取、网络、PID 可见性不隔离（Landlock 只限制文件写）。
- 读取不隔离意味着 shell 命令可以读取本机任意可读文件，包括 `data/llm.json` 中的
  API Key；不要用本应用执行不受信任的命令。必要时用 `CODEFLY_DATA_DIR` 把数据目录
  放到独立位置，并保持目录权限为 `0700`。
- 文件工具的 canonicalize 与写入之间仍有很小的 TOCTOU 窗口。
- `danger-full-access` 没有沙箱也没有审批，仅在你明确确认后使用。
- Agent 工具按顺序执行；不支持并行 tool call、交互式 stdin、后台 PTY。
- UI 只提供聊天与 Agent 模式，没有独立的手动命令输入框；需要执行命令时由 Agent 的
  `run_command` 工具完成。
- Agent 的最大步数与上下文预算有上限；工具输出对模型做了截断。
- Agent 会执行模型选择的命令/文件操作。虽然有沙箱、写围栏和提权审批，但读取/网络不隔离，
  且提示注入可能诱导模型执行命令；只在你信任任务来源时使用 Agent。
- 聊天/Agent 历史按字符预算截断上下文（默认 120k 字符），每条会话最多存 500 条。
- 文件工具暂不支持「读后写」版本检查（`FS_NOT_OBSERVED` / `FS_STALE_VERSION`）。

## 测试

```bash
pnpm test          # Vitest：策略、路径围栏、审批状态机、真实 Landlock、LLM/Agent 客户端与编排
pnpm typecheck
pnpm build
```

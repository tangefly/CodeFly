# CodeFly

本地单用户编码控制台：浏览器通过 REST + SSE 连接本机 Node 服务，在 Landlock 沙箱中
执行命令，文件写操作限制在工作区与 `/tmp`。

## 功能

- **三界面**：侧栏顶部切换「对话」「Code」「论文」，三者拥有独立的会话列表、输入框
  与历史；地址栏用 `#/chat`、`#/code`、`#/paper` 记住当前界面（旧的 `#/agent` 仍兼容）。
- **对话**：不绑定工作区，只与模型聊天，不执行命令或读写文件；支持多个独立对话、
  自动标题、删除与历史持久化。
- **Code 会话**：按工作区新建、切换、删除；工具调用与消息历史持久化，刷新后恢复。
- **论文助手**：不绑定工作区，通过 arXiv 检索最新论文，下载并解析 PDF，按目录/页码/
  章节分段阅读，把标签、阅读状态、用户笔记与结构化摘要整理进全局论文库；支持本地上传
  PDF、BibTeX/Markdown 导出。论文工具与 Code 工具完全分离。
- **聊天模型**：通过 OpenAI-compatible `/chat/completions` 流式对话，支持多轮上下文、
  取消生成、Markdown / GFM / KaTeX / Shiki 渲染。
- **Code 模式**：tool-calling loop，可调用 `run_command`、`read_file`、`write_file`、
  `edit_file`、`list_files`、`grep`、`glob`、`web_search`、`web_fetch`、`read_image`；
  `read_file` 支持行号与 `offset`/`limit`，`edit_file` 支持一次多处原子替换，
  只读工具（含 `web_search`、`web_fetch`、`read_image`）并行执行；工具输出以可折叠
  卡片展示，失败时自动展开；每轮的工具调用汇总为一张可折叠卡片，优先展示模型最终回答。
- **抓取网页**：`web_fetch` 直接读取一个 http(s) URL 的正文（HTML 转纯文本，JSON/XML
  原样返回），最多 5 次重定向、2 MiB、10 万字符；拒绝回环/内网/链路本地地址并在
  每次重定向后重新校验，防止 DNS rebinding 绕过。
- **看图**：`read_image` 读取 PNG/JPEG/GIF/WebP（≤ 4 MiB），解析尺寸后把图片作为
  带图的多模态 tool result 发给模型，UI 直接渲染缩略图。
- **联网搜索**：`web_search` 使用独立配置的搜索 API（兼容 DeepSeek Search 的
  `POST /v1/tools/search`）返回标题、链接、摘要与可选网页正文，支持 `site:`、
  `lang:`、`after:` 等搜索语法；搜索地址与 API Key 在「搜索 API」中单独配置，
  与聊天模型互不复用。
- **思考模式**：DeepSeek V4 默认开启，思维链流式展示在回复上方，可关闭或调整
  `low / high / max` 强度。
- **权限与审批**：只读 / 工作区内修改 / 完全权限；越界操作可发起一次性提权审批。
- **沙箱**：优先 `bwrap`，否则使用 Landlock；两者都不可用时拒绝执行。写围栏限制在
  工作区与 `/tmp`，并拒绝 `.git/`、`.claude/` 等受保护路径。
- **GPU**：`workspace-write` 默认放行 GPU 设备节点、`/dev/shm` 与 `/proc`。
- **用量统计**：会话上下文、累积上下文、累计输出、思考 token、缓存命中率。
- **审计**：JSONL 记录审批、执行、配置变更与 Code 事件。

## 论文助手

侧栏选择「论文」后，新建论文会话即可开始。论文助手没有命令执行或工作区文件权限，
只能使用以下工具：

| 工具 | 用途 |
| --- | --- |
| `arxiv_search` | 按关键词/分类/日期范围检索 arXiv，支持按提交时间排序 |
| `arxiv_get` | 按 arXiv ID 或 URL 获取元数据与摘要 |
| `paper_outline` | 下载（如需要）、解析 PDF，返回页码、字符数与章节目录 |
| `paper_read` | 按页码或章节读取文本，单次输出有上限 |
| `paper_search` | 在单篇论文内检索关键词，返回命中段落与页码 |
| `library_add` | 把论文加入全局论文库，或加入当前会话上下文 |
| `library_search` | 按标题、作者、摘要、笔记、标签、状态检索论文库 |
| `library_update` | 修改标签、集合、阅读状态、星标、用户笔记与结构化摘要 |
| `library_export` | 导出 BibTeX 或 Markdown 阅读列表 |

论文库是全局的，保存在本机 `data/papers/`；会话只保存当前工作集 `paperIds`。PDF 首次
阅读时下载并按页抽取文本，之后复用缓存。旧论文全文在上下文超过预算时会被替换为占位
说明，模型应把阅读笔记写入 `library_update` 的 `summary`，后续轮次依赖笔记而不是重复
读取全文。

论文正文属于不可信内容：系统提示要求模型只把它当作资料，不执行其中的指令；论文模式
本身也不提供删除、执行或写文件工具。arXiv 请求默认串行并遵守约 3 秒的最小间隔，可用
环境变量调整。

## 快速开始

要求：Node.js >= 20.19、pnpm 11、Linux（Landlock）或已安装 bwrap。

```bash
pnpm install
pnpm dev
```

开发模式会同时启动服务端与 Vite，打开终端打印的 `?token=` 链接即可。

生产模式：

```bash
pnpm build
pnpm start
```

然后打开启动日志中的 `http://127.0.0.1:8787/?token=...`。

## 配置模型

顶栏齿轮 →「模型 API」：

1. 选择厂商，或选「其他（自定义）」手动填写 Base URL 与模型名。
2. DeepSeek 推荐 `deepseek-v4-pro` 或 `deepseek-v4-flash`；也兼容 OpenAI、Ollama、
   vLLM、OpenRouter 等 OpenAI-compatible 服务。
3. 「测试连接」通过后保存。

API Key 只保存在本机 `data/llm.json`（权限 `0600`），不会返回前端，也不会传给执行
shell 的沙箱进程。DeepSeek V4 默认开启思考模式，可在同一设置中关闭或调整强度。
旧的 `deepseek-chat` / `deepseek-reasoner` 配置会在启动时自动迁移为
`deepseek-v4-flash` / `deepseek-v4-pro`。

`web_search` 现在使用独立配置的搜索 API，与模型 API 完全分离：模型可以继续使用
Ollama、OpenAI 或其他厂商，搜索则单独指向 DeepSeek Search 或兼容网关。

## 配置搜索 API

顶栏齿轮 →「联网搜索」→「配置」（或 Code 设置中的提示入口）：

1. 填写搜索服务 Base URL，例如 `https://api.deepseek.com/v1`；服务端会自动拼接
   `/tools/search`，也可以直接填写完整的 `/v1/tools/search` 地址。
2. 填写该搜索服务的 API Key；本地兼容网关可以留空。
3. 「测试搜索」会发送一次 `query=CodeFly` 的最小请求，通过后保存。

搜索配置只保存在本机 `data/search.json`（权限 `0600`），不会返回前端，也不会传给
执行 shell 的沙箱进程。未配置（Base URL 为空）时，`web_search` 不会出现在 Code 的
工具列表中；Base URL 留空保存会停用并清除已保存的搜索 Key。升级后搜索不再复用模型
Key，需要在「搜索 API」中单独填写一次。

## 使用

1. 侧栏顶部选择「对话」「Code」或「论文」。
2. 对话：点击「新建对话」，无需选择工作区，直接开始聊天；每个对话有独立历史。
3. Code：点击「新建 Code 会话」，选择一个已存在的绝对路径作为工作区。
   Code 会携带历史工具输出和思考内容；长会话的上下文与 token 消耗更大。
4. 论文：点击「新建论文会话」，直接检索 arXiv、阅读 PDF 或上传本地论文。
   左上/顶栏的「论文库」打开全局论文库，可筛选、编辑标签/状态/笔记、打开 PDF 与导出。
5. Code 工具卡片可展开/收起命令与结果；执行失败时自动展开。
6. 顶栏或 Code 输入框旁的权限选择器切换会话权限；越界命令会弹出一次性审批。
7. 顶栏「审计日志」查看当前 Code 会话的审批、执行、文件写入与模型事件。
8. 侧边栏会话右侧的删除按钮可删除会话及其聊天/工具记录，不会删除工作区文件。
9. 底部用量显示：
   - **会话上下文**：当前会话已保存的全部消息长度（条数与估算 token）。
   - **累积上下文**：本会话所有模型请求的上下文之和，包含缓存命中。
   - **累计输出**：所有回复的 completion tokens 之和。
   - **思考**：思考 token（已计入输出）。
   - **缓存命中**：prompt 缓存命中率。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CODEFLY_PORT` | `8787` | 监听端口 |
| `CODEFLY_HOST` | `127.0.0.1` | 监听地址 |
| `CODEFLY_TOKEN` | 随机生成 | 固定访问 token（仅建议本地调试） |
| `CODEFLY_DATA_DIR` | `<repo>/data` | 会话、消息、配置、审计与 spill 目录 |
| `CODEFLY_APPROVAL_TIMEOUT_MS` | `120000` | 审批超时；超时视为拒绝 |
| `CODEFLY_ALLOW_GPU` | `1` | 是否允许 `workspace-write` 读写 GPU 设备、`/dev/shm` 与 `/proc`；设为 `0` 关闭 |
| `CODEFLY_SANDBOX_RW_PATHS` | 无 | 逗号分隔的绝对路径，追加到 `workspace-write` 的读写授权 |
| `CODEFLY_ARXIV_MIN_INTERVAL_MS` | `3000` | arXiv API/PDF 请求的最小间隔 |
| `CODEFLY_ARXIV_CONTACT` | 无 | 可选的联系邮箱，写入 arXiv 请求的 User-Agent |
| `CODEFLY_PAPER_MAX_PDF_BYTES` | `26214400` | 单个 PDF 大小上限（25 MB） |
| `CODEFLY_PAPER_MAX_PAGES` | `200` | 单个 PDF 页数上限 |
| `CODEFLY_PAPER_EXTRACT_TIMEOUT_MS` | `60000` | PDF 文本抽取超时 |
| `CODEFLY_PAPER_MAX_READ_CHARS` | `20000` | `paper_read` 单次返回字符上限 |
| `CODEFLY_PAPER_HISTORY_BUDGET_CHARS` | `160000` | 论文会话送给模型的论文文本预算 |
| `CODEFLY_PAPER_MAX_STEPS` | `80` | 论文助手单回合最大步数 |
| `CODEFLY_PAPER_DOWNLOAD_TIMEOUT_MS` | `120000` | arXiv PDF 下载空闲超时：连续该时长未收到新数据才中断，慢速但持续的下载不会被打断 |

数据文件：

- `data/llm.json`：模型地址、模型名、API Key、思考设置。
- `data/search.json`：搜索服务地址、搜索 API Key、请求超时。
- `data/agent.json`：Code 最大步数、命令超时、启用工具、system prompt。
- `data/papers/library.json`：全局论文库元数据、标签、阅读状态、笔记与摘要。
- `data/papers/pdf/`：下载或上传的 PDF 缓存。
- `data/papers/text/`：按页抽取的论文文本与章节索引。
- `data/messages.json`：会话消息、思考内容、工具调用与结果。
- `data/audit.jsonl`：审计事件。

## 安全边界

- 服务默认只监听 `127.0.0.1`，所有 API 请求都需要 Bearer token；不要把
  `CODEFLY_HOST` 改成 `0.0.0.0`。
- **读取、网络、PID 可见性不隔离**；Landlock 只限制文件写。命令可以读取本机任意
  可读文件，包括 `data/llm.json` 与 `data/search.json` 中的 API Key。不要执行不受
  信任的命令。
- 启用 `web_search` 时，搜索查询词与可选网页正文会发送到「搜索 API」中配置的服务；
  启用 `web_fetch` 时，目标 URL 会从本机直接访问（只放行公网 http/https）。
- `read_image` 会把图片以 base64 存入 `data/messages.json`，并把图片发送给模型
  提供商；不要读取含敏感信息的截图。
- 论文助手会把 arXiv 元数据、抽取后的论文文本与论文库字段发送给模型提供商；PDF 原文
  和本地笔记只保存在本机 `data/papers/`。论文正文与上传文件都是不可信数据，请勿把
  含有恶意指令的 PDF 当作可信内容。
- 论文模式没有 `run_command`、文件写入或删除工具；论文库删除只能由用户在 UI 发起。
- `danger-full-access` 没有沙箱也没有审批，仅在明确确认后使用。
- `workspace-write` 默认放行 GPU 设备、`/dev/shm` 与 `/proc`（CUDA 需要）；可用
  `CODEFLY_ALLOW_GPU=0` 收紧。GPU 显存不是进程间安全边界。
- 思考 token 计入输出；Code 模式会在每步回传历史思考内容，进一步增加上下文。
- Code 的只读工具（`read_file`、`list_files`、`grep`、`glob`）并行执行；写操作与
  `run_command` 严格按顺序执行。不支持交互式 stdin 或后台 PTY。
- 历史上下文按字符预算截断（默认 120k 字符），每个会话最多保存 500 条消息。

## 开发

```bash
pnpm test        # 服务端测试：策略、路径围栏、审批、真实 Landlock、LLM/Agent
pnpm typecheck
pnpm build
```

目录：

```text
packages/protocol/   # 共享类型与 zod schemas
apps/server/         # Fastify 服务端：sandbox / exec / fs / approval / llm / agent / paper / routes
apps/web/            # React + Vite + Tailwind 前端
data/                # 运行时数据（gitignore）
```

# 日程规划助手实现方案

## Context

CodeFly 目前有「对话 / Code / 论文」三个独立界面。「论文助手」已经验证了一套可复用的模式：独立会话类型、独立工具集、全局结构化存储、独立 system prompt、独立 SSE 路由和前端 Shell。日程助手将按同样方式新增为第四个界面「日程」。

目标：
1. 用结构化 JSON 文档持久化用户偏好、约束、任务和每周计划，支持查询、新增、修改、删除。
2. 每次用户报告进度/变化后，助手能更新任务与 block，并把未完成工作自动推后、重新排期。
3. 生成一周计划，每个任务有预估时长、置信度、缓冲和历史实际耗时校准。
4. 把计划渲染成「任务 × 星期」表格 PNG，保存到本机并可在界面预览/下载；配置 SMTP 后可发送到用户自己的邮箱。

## 一、协议类型（packages/protocol）

`types.ts`：
- `SessionKind` 增加 `"schedule"`，新增 `ScheduleSession`（`workspaceRoot: null`，固定 `mode: "read-only"`、`approvalPolicy: "never"`），加入 `Session` union。
- 新增领域类型：
  - `ScheduleMemory`：`id/key/category/title/content/data(结构化字段)/tags/pinned/createdAt/updatedAt`。
  - `ScheduleTask`：标题、备注、项目、优先级、状态、`estimatedMinutes/remainingMinutes/actualMinutes`、`estimateConfidence(low|medium|high)`、deadline、是否可拆分、最小 block、偏好时段。
  - `ScheduleBlock`：`taskId/date/start/end/status(planned|done|skipped)/actualMinutes/note`。
  - `SchedulePlan`：`weekStart/weekEnd/timezone/status/blocks/notes`。
  - `ScheduleOverview`、`ScheduleEmailSettingsPublic/Input`、计划汇总/未排期项等响应类型。
- `AgentToolMeta.kind` 增加 `"schedule" | "memory"`；`AuditType` 增加 `schedule.run`、`schedule.memory.changed`、`schedule.task.changed`、`schedule.plan.changed`、`schedule.email.sent`。
- 新增 `SCHEDULE_TOOL_NAMES` 常量。

`schemas.ts`：
- `sessionKindSchema` 增加 `"schedule"`；创建会话的 refine 文案改为通用「非 agent 会话不接收 workspaceRoot」。
- 新增 memory/task 更新、email 设置/测试/发送、overview 查询的 zod schema。

复用现有的 tool-loop 事件协议，不新增 SSE 事件类型；计划变化通过工具结果 `meta.data` 和界面刷新呈现。

## 二、服务端存储（apps/server/src/schedule）

新增 `store.ts`，使用现有 `atomicWriteFile`（`apps/server/src/fs/atomic-write.ts`）落盘：
- `data/schedule/memories.json`：`{ version, memories: ScheduleMemory[] }`。
- `data/schedule/tasks.json`：`{ version, tasks: ScheduleTask[] }`。
- `data/schedule/plans.json`：`{ version, plans: SchedulePlan[] }`。
- `data/schedule/exports/`：PNG 输出目录。
- 读取时做宽松校验和归一化；损坏文件记录日志但保留可用数据。
- 启动时创建目录；内存索引 + 串行持久化，提供：
  - memory：list/search/getByKey/upsert/update/delete；
  - task：list/get/upsert/update/delete（删除时清理未来 planned blocks）；
  - plan：getByWeek/upsert/deleteBlocks/updateBlocks；
  - `getPreferences()`：读取 key 为 `scheduling_preferences` 的记忆 `data`，与默认值合并并校验。
- 默认偏好：`timezone` 取服务端时区，工作日 1–5，09:00–18:00，午休 12:00–13:00，`maxFocusMinutes=90`，`minBlockMinutes=30`，`bufferRatio=0.15`，`dailyFocusLimitMinutes=480`。

## 三、排期算法（apps/server/src/schedule/scheduler.ts，纯函数、可单测）

核心 `generateSchedule(input)`：
- 输入：日期范围、任务、已有 blocks、偏好、是否允许溢出到下一周。
- 日期/时间用 `YYYY-MM-DD` 和 `HH:mm` 计算，避免时区/夏令时问题；`today` 用 `Intl.DateTimeFormat` 按偏好时区取。
- 可用时间 = 工作日工作时段 − 休息时段 − 已完成/保留的 blocks − 每日专注上限。
- 任务目标时长 = `remainingMinutes × (1 + bufferRatio + 置信度缓冲)`：
  - low +25%，medium +10%，high +0%；
  - 同时返回历史完成任务的 `actual / estimated` 平均比例，供模型校准新预估。
- 排序：优先级（urgent > high > medium > low）→ 截止日期 → 创建时间。
- 拆分：可拆分任务按 `maxFocusMinutes` 切成块，最后一块不小于 `minBlockMinutes`；不可拆分任务保持单块。
- 优先时段：morning/afternoon/evening 映射到可用区间；放不下则顺延到后面的日期。
- 结果包含：生成的 blocks、未排入任务及原因、超载/逾期/截止日风险 warnings。
- `planWeek`：从指定周的周一开始，保留已完成 blocks，替换未来 planned blocks；允许溢出时扩展到下一周。
- `replanFrom`：从指定日期（默认今天）开始，把该日期之前的 planned blocks 标记 skipped，删除该日期之后 included 任务的 planned blocks，再重排；已完成 block 永不移动。用于「任务没做完，推后」。

## 四、工具集（apps/server/src/schedule/tools.ts）

参考 `paper/tools.ts` 的 `parseArgs`、`tooleError`、`definitions()`、`execute()` 模式，提供 12 个工具：

记忆：
- `memory_search`：按 query/category/tags/key 查询。
- `memory_upsert`：按 `memory_id` 或唯一 `key` 新增/修改；支持 `data` 结构化字段。
- `memory_delete`：按 id/key 删除。

任务：
- `task_list`：列出 active/done 任务、剩余时长、历史校准比例。
- `task_upsert`：新增/修改任务；支持 `add_actual_minutes` 记录实际进度，remaining 归零时自动 done。
- `task_delete`：删除任务并清理未来 planned blocks。

计划：
- `plan_get`：读取指定周计划，按天分组，附任务标题、状态、剩余时长、未排期列表。
- `plan_schedule`：创建/重排一周计划，`week_start? / task_ids? / allow_spill? / notes?`；保留已完成 blocks，替换 planned blocks；自动渲染 PNG。
- `plan_replan`：`from_date? / days? / task_ids? / allow_spill?`；把过去 planned 标记 skipped，从指定日期重排，自动渲染 PNG。
- `block_update`：标记 block done/skipped/planned，记录 actual_minutes，可调整时间（做重叠校验）；标记 done 时同步扣减 task.remainingMinutes 并累加 actualMinutes。
- `plan_render`：重新渲染指定周 PNG，返回表格数据、绝对路径和 data URL。
- `plan_email`：把指定周计划渲染后发送到已配置的固定收件邮箱；仅用户明确要求时调用。

工具结果 `meta.data` 携带结构化表格数据供前端卡片渲染；`meta.imageDataUrl` 供预览。`plan_schedule`/`plan_replan` 默认自动渲染，保证每次计划变更都有图片。

## 五、图片渲染（apps/server/src/schedule/render.ts）

- 新增依赖 `sharp`（已验证可在本机用 Noto Sans CJK 渲染中文）。
- 生成 SVG 表格再转 PNG：
  - 标题：周日期范围、时区、生成时间。
  - 汇总：任务数、计划总时长、未排期数、warnings。
  - 表格：行 = 任务，列 = 周一…周日；单元格显示时间段和状态（✓ done / — skipped），任务列显示优先级、预估/剩余、置信度。
  - 底部：未排期任务与备注。
- 输出到 `data/schedule/exports/week-YYYY-MM-DD-<时间戳>.png`；限制图片尺寸和数据 URL 大小，避免 messages.json 膨胀。
- 对长标题做按字符宽度换行；无任务时输出空状态表格。

## 六、SMTP 邮件（apps/server/src/schedule/email.ts）

- 新增依赖 `nodemailer`。
- `data/schedule/email.json`（权限 0600）保存 host/port/secure/user/password/from/to。
- `to` 只允许一个已配置的本人邮箱；工具不接受任意收件人参数，避免被利用群发。
- 提供 `verify()` 连接测试；`sendPlan()` 发送带 PNG 附件的邮件，并写审计 `schedule.email.sent`。
- 系统提示要求：只有用户明确说「发到我邮箱」才调用；未配置时提示用户去设置页配置。

## 七、服务与路由

新增 `schedule/service.ts`，镜像 `paper/service.ts`：
- 复用 `runToolLoop`，`runKind: "schedule"`，独立 system prompt。
- 每轮注入 runtime context：当前时间/时区/本周一、偏好是否存在、active 任务数、本周计划摘要、可用工具。
- `assertReady`/`isBusy` 与 paper 一致。

新增 `routes/schedule.ts`：
- `POST /api/sessions/:id/schedule`：SSE 工具运行，复用 `routes/paper.ts` 的 hijack/heartbeat/title 逻辑。
- `GET /api/schedule/overview?week_start=`：返回 memories、tasks、本周 plan、汇总。
- `POST/PATCH/DELETE /api/schedule/memories...`。
- `PATCH/DELETE /api/schedule/tasks/:id`。
- `GET/PUT /api/schedule/email/settings`、`POST /api/schedule/email/test`、`POST /api/schedule/email/send`（手动发送按钮）。
- `GET /api/schedule/exports/:name` 下载 PNG（限制文件名，防路径穿越）。

修改：
- `session/store.ts`：增加 schedule 的加载/创建/`getScheduleOrThrow`，默认标题「新日程会话」。
- `llm/run-lock.ts`、`llm/tool-loop.ts`：`RunKind`/profile/abort 文案增加 schedule。
- `index.ts`：初始化 ScheduleStore、ScheduleToolExecutor、ScheduleService、邮件服务，注册路由，启动日志打印计划/记忆统计。
- `apps/server/package.json` build 脚本复制 `src/schedule/prompt.md` 到 dist；依赖加入 `sharp`、`nodemailer`。

## 八、系统提示（apps/server/src/schedule/prompt.md）

- 角色：日程规划助手，先读记忆和任务，再规划。
- 首次使用：检索 `scheduling_preferences`；缺失时询问用户工作时段、工作日、休息时间、每日专注上限，并写入记忆。
- 收集任务：标题、预估分钟、优先级、截止日期、可拆分性、预估置信度；不确定时用 `task_list` 返回的历史 actual/estimate 比例校准，明确说明假设。
- 周计划：`plan_schedule` 生成；用表格总结并说明 warnings/未排期项；图片路径一并告知。
- 进度变化：`block_update` 记录完成/跳过/实际耗时；未完成时 `plan_replan` 从今天推后，解释哪些任务被移动、哪些被挤占。
- 偏好变化：`memory_upsert` 更新偏好后再问是否重排。
- 邮件：仅在明确要求时 `plan_email`；绝不声称发送成功除非工具成功。
- 输出语言跟随用户；时间估算取整到 5/15 分钟，不编造精度。

## 九、前端（apps/web）

- `ModeSwitcher`：四项，`BookOpen` 图标改为日程图标（如 `CalendarDays`），加「日程」。
- 路由/存储：`#/schedule`，`CURRENT_SESSION_KEYS` 增加 `schedule`；`readStoredMode/writeStoredMode` 支持 schedule。
- 新增 `components/schedule/`：
  - `ScheduleShell`、`ScheduleSidebar`（新建日程会话、本周计划入口、会话列表）、`ScheduleTopBar`（本周、日程面板、邮件设置、审计/设置）、`ScheduleComposer`、`ScheduleTimeline`。
  - `SchedulePanel` 抽屉：三个 tab
    - 本周计划：任务 × 星期 React 表格，显示 block 状态与汇总；
    - 记忆：列表 + 行内编辑（title/content/tags/pinned）+ 删除 + 手动新增；
    - 任务：列表 + 状态/剩余时长 + 删除。
  - `ScheduleEmailSettingsDialog`：SMTP 配置与「测试连接」。
  - `ScheduleToolCard`：计划任务/记忆/任务列表卡片；计划卡片显示表格预览、PNG 预览、下载按钮和「发送到我的邮箱」按钮。
- `ToolCard` 增加 schedule 工具识别与标签；`tool-labels.ts` 增加 `SCHEDULE_TOOL_LABEL`。
- `AgentTimeline` 支持 `mode="schedule"`，增加日程空状态和三个建议卡（「规划这一周」「记录任务进度」「查看计划表」）。
- `store.ts`：增加 `scheduleBusy`、`scheduleAborters`、`scheduleCreating`、schedule overview 状态、`createScheduleSession/sendSchedule/cancelSchedule`、记忆/任务 CRUD、邮件设置 actions；把 `streamToolRun` 的 kind 扩展到 schedule。
- 打开日程界面时拉取 overview；执行完 schedule 工具后刷新 overview，保证面板与工具结果一致。

## 十、测试与验证

新增：
- `apps/server/test/schedule-store.test.ts`：memory/task/plan CRUD、偏好合并、删除任务清理 blocks、持久化重载。
- `apps/server/test/schedule-scheduler.test.ts`：工作时长扣减、休息时段、优先级排序、拆分/不可拆分、deadline warning、容量不足、replan 保留 done 并标记过去 planned skipped、跨周溢出。
- `apps/server/test/schedule-tools.test.ts`：12 个工具的参数校验与关键副作用，重点覆盖 `plan_schedule`、`plan_replan`、`block_update`、`memory_upsert/delete`。
- `apps/server/test/schedule-service.test.ts`：fake LLM 调用工具、runtime context 包含当前时间/任务数/计划摘要、工具集合正确、取消行为。
- `apps/server/test/schedule-render.test.ts`：生成 PNG 的 magic bytes、尺寸>0、文件落盘；CJK 字体不抛错。
- `apps/server/test/schedule-email.test.ts`：设置脱敏/持久化/收件人限制；不进行真实发信。
- 扩展 `session-kind.test.ts`：schedule 创建、持久化、跨 kind 拒绝。

验证命令：
1. `pnpm --filter @codefly/server add sharp nodemailer`
2. `pnpm build:protocol`
3. `pnpm typecheck`
4. `pnpm test`
5. `pnpm build`
6. `pnpm dev` 后手工走通：
   - 新建日程会话 → 首次配置偏好 → 添加 3–5 个任务 → 生成本周计划 → 查看表格/PNG。
   - 报告某任务只完成一半 → 助手更新 block 并 replan → 检查任务被推后且已完成 block 未移动。
   - 在日程面板编辑/删除一条记忆，再让助手读取确认变化。
   - 配置 SMTP → 测试连接 → 明确要求发送 → 收到带 PNG 的邮件。
   - 刷新页面后计划、记忆、会话历史仍在。

## 十一、文档

更新 `README.md`：
- 功能列表增加「日程」第四界面。
- 新增「日程助手」章节：工具表、记忆/任务/计划存储文件、时间估算与动态重排规则、PNG 导出、SMTP 配置步骤与安全边界。
- 环境变量/数据文件列表补充 `data/schedule/*`，说明邮件只发给配置的本人地址。

## 关键复用点

- 独立模式骨架：`apps/server/src/paper/service.ts`、`paper/tools.ts`、`routes/paper.ts`、`routes/papers.ts`。
- 工具循环：`apps/server/src/llm/tool-loop.ts`（扩展 runKind/auditType）。
- 会话管理：`apps/server/src/session/store.ts`（增加 schedule 分支）。
- 原子写入：`apps/server/src/fs/atomic-write.ts`。
- 前端模式骨架：`components/paper/*`、`AppShell.tsx`、`ModeSwitcher.tsx`、`AgentTimeline.tsx`、`ToolCard.tsx`。
- 设置弹窗模式：`SearchSettingsDialog.tsx` + `Modal/Button`。
- 流式状态机：`store.ts` 的 `streamToolRun`。

## 风险与处理

- **邮件是外部动作**：只允许已配置的本人收件人，工具无任意收件人参数；仅显式要求时调用；审计记录。
- **智能体可能过度排期**：算法返回 warnings 和未排期列表，系统提示要求如实告知，不能静默超载。
- **时间估算不准**：显式置信度 + 缓冲 + 历史实际比例校准，并在结果中展示依据。
- **图片体积**：限制尺寸/数据 URL 大小；旧图片在模型历史中自动替换为文本占位符（复用 `toolContentForModel`）。
- **PNG 依赖 native 包**：sharp 已在本机验证可安装并渲染中文；若安装失败，构建会明确报错，届时降级为保存 SVG（实现中加 fallback 路径）。
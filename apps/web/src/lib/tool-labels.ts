export const PAPER_TOOL_LABEL: Record<string, string> = {
  arxiv_search: "arXiv 检索",
  arxiv_get: "arXiv 论文",
  paper_outline: "论文目录",
  paper_read: "阅读论文",
  paper_search: "论文内检索",
  library_add: "加入论文库",
  library_search: "检索论文库",
  library_update: "整理论文",
  library_export: "导出论文",
};

export const PAPER_TOOL_NAMES = new Set(Object.keys(PAPER_TOOL_LABEL));

export function isPaperTool(name: string): boolean {
  return PAPER_TOOL_NAMES.has(name);
}

export const SCHEDULE_TOOL_LABEL: Record<string, string> = {
  memory_search: "检索记忆",
  memory_upsert: "保存记忆",
  memory_delete: "删除记忆",
  task_list: "任务列表",
  task_upsert: "保存任务",
  task_delete: "删除任务",
  plan_get: "查看计划",
  plan_schedule: "生成周计划",
  plan_replan: "重排计划",
  block_update: "更新时段",
  plan_render: "渲染计划表",
  plan_email: "邮件发送计划",
};

export const SCHEDULE_TOOL_NAMES = new Set(Object.keys(SCHEDULE_TOOL_LABEL));

export function isScheduleTool(name: string): boolean {
  return SCHEDULE_TOOL_NAMES.has(name);
}

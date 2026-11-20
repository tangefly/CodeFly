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
  preferences_get: "读取排期偏好",
  preferences_update: "保存排期偏好",
  task_list: "任务列表",
  task_upsert: "保存任务",
  task_delete: "删除任务",
  fixed_event_list: "固定安排",
  fixed_event_upsert: "保存固定安排",
  fixed_event_delete: "删除固定安排",
  plan_get: "查看日程",
  plan_schedule: "生成日程",
  plan_replan: "重排日程",
  block_update: "更新时段",
  plan_render: "渲染日程图",
  plan_email: "邮件发送日程",
};

export const SCHEDULE_TOOL_NAMES = new Set(Object.keys(SCHEDULE_TOOL_LABEL));

export function isScheduleTool(name: string): boolean {
  return SCHEDULE_TOOL_NAMES.has(name);
}

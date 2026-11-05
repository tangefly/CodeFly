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

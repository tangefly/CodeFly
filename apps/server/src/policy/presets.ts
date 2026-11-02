import type { ApprovalPolicy, SandboxMode } from "@codefly/protocol";

export interface Preset {
  id: SandboxMode;
  mode: SandboxMode;
  approvalPolicy: ApprovalPolicy;
  label: string;
  description: string;
}

export const PRESETS: readonly Preset[] = [
  {
    id: "read-only",
    mode: "read-only",
    approvalPolicy: "ask",
    label: "仅可查看",
    description: "不能写任何文件；只读浏览、搜索与分析。",
  },
  {
    id: "workspace-write",
    mode: "workspace-write",
    approvalPolicy: "ask",
    label: "工作区内修改",
    description: "只能写工作区与临时目录；日常编码的默认值。",
  },
  {
    id: "danger-full-access",
    mode: "danger-full-access",
    approvalPolicy: "never",
    label: "完全权限",
    description: "命令可读写工作区外文件、访问网络；无审批。",
  },
] as const;

export function presetForMode(mode: SandboxMode): Preset {
  const preset = PRESETS.find((candidate) => candidate.mode === mode);
  if (!preset) throw new Error(`unknown mode: ${mode}`);
  return preset;
}

export function isSandboxMode(value: string): value is SandboxMode {
  return PRESETS.some((preset) => preset.mode === value);
}

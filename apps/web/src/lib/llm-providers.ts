export interface LlmProviderPreset {
  id: string;
  label: string;
  /** OpenAI-compatible base URL, without a trailing slash. */
  baseUrl: string;
  /** Model ids offered in the dialog's model dropdown. */
  models: string[];
  /** Optional note shown under the provider field. */
  note?: string;
}

export const CUSTOM_PROVIDER_ID = "custom";

/** Providers with a public OpenAI-compatible /chat/completions endpoint. */
export const LLM_PROVIDERS: LlmProviderPreset[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    models: ["deepseek-v4-pro", "deepseek-v4-flash"],
    note: "V4 模型默认开启思考模式；思考内容会显示在回复上方，可在下方关闭。",
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "o3", "o4-mini"],
  },
  {
    id: "qwen",
    label: "阿里云百炼（Qwen）",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: ["qwen-max", "qwen-plus", "qwen-turbo", "qwen3-coder-plus"],
  },
  {
    id: "zhipu",
    label: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: ["glm-4.5", "glm-4.5-air", "glm-4-plus", "glm-4-flash"],
  },
  {
    id: "moonshot",
    label: "Moonshot（Kimi）",
    baseUrl: "https://api.moonshot.cn/v1",
    models: [
      "kimi-k2-0711-preview",
      "moonshot-v1-8k",
      "moonshot-v1-32k",
      "moonshot-v1-128k",
    ],
  },
  {
    id: "siliconflow",
    label: "硅基流动 SiliconFlow",
    baseUrl: "https://api.siliconflow.cn/v1",
    models: [
      "deepseek-ai/DeepSeek-V3",
      "deepseek-ai/DeepSeek-R1",
      "Qwen/Qwen2.5-72B-Instruct",
    ],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    models: [
      "openai/gpt-4o",
      "anthropic/claude-sonnet-4",
      "google/gemini-2.5-pro",
      "deepseek/deepseek-chat",
    ],
  },
  {
    id: "ollama",
    label: "Ollama（本地）",
    baseUrl: "http://127.0.0.1:11434/v1",
    models: ["qwen3:8b", "qwen2.5-coder:7b", "llama3.2:3b", "deepseek-r1:8b"],
    note: "本地服务，API Key 可以留空；模型名需与本机 ollama list 一致。",
  },
];

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}

export function findProvider(id: string): LlmProviderPreset | null {
  return LLM_PROVIDERS.find((provider) => provider.id === id) ?? null;
}

/** Infers the provider preset from a saved base URL, if it matches one. */
export function findProviderByBaseUrl(
  baseUrl: string,
): LlmProviderPreset | null {
  const target = normalizeBaseUrl(baseUrl);
  if (target === "") return null;
  return (
    LLM_PROVIDERS.find(
      (provider) => normalizeBaseUrl(provider.baseUrl) === target,
    ) ?? null
  );
}

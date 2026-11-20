import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Loads a markdown prompt that ships next to the calling module. Prompts are
 * data, not code: wording changes never require a rebuild of logic, only the
 * build step that copies the .md files next to the compiled output.
 */
export function loadPromptFile(moduleUrl: string, file = "prompt.md"): string {
  return readFileSync(fileURLToPath(new URL(file, moduleUrl)), "utf8").trim();
}

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

/** Same budget as DeepSeek Harness's agent-instructions plugin. */
const MAX_TOTAL_BYTES = 64 * 1024;

interface CollectedFile {
  absolutePath: string;
  content: string;
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function readFirstInstruction(dir: string): Promise<CollectedFile | null> {
  for (const name of INSTRUCTION_FILES) {
    const absolutePath = path.join(dir, name);
    try {
      const content = (await readFile(absolutePath, "utf8")).trim();
      if (content !== "") return { absolutePath, content };
    } catch {
      // Try the next candidate name.
    }
  }
  return null;
}

/**
 * Directories whose instruction files apply, from the outermost (repository
 * root) to the workspace root, so more specific files are appended last. When
 * no git root encloses the workspace, only the workspace itself is considered
 * — unrelated parent-directory files must not leak into the session.
 */
async function instructionDirs(workspaceRoot: string): Promise<string[]> {
  const root = path.parse(workspaceRoot).root;
  const dirs: string[] = [];
  let sawGitRoot = false;
  for (let dir = workspaceRoot; ; dir = path.dirname(dir)) {
    dirs.push(dir);
    if (await fileExists(path.join(dir, ".git"))) {
      sawGitRoot = true;
      break;
    }
    if (dir === root) break;
  }
  return sawGitRoot ? dirs.reverse() : dirs.slice(0, 1);
}

/**
 * Collects project instructions (AGENTS.md, falling back to CLAUDE.md) for a
 * workspace. Returns the user-role message content, or null when the project
 * has none. Nested files override: a deeper file's instructions are more
 * specific and appear later in the message.
 */
export async function collectProjectInstructions(
  workspaceRoot: string,
): Promise<string | null> {
  const dirs = await instructionDirs(path.resolve(workspaceRoot));
  const files: CollectedFile[] = [];
  let totalBytes = 0;
  for (const dir of dirs) {
    if (totalBytes >= MAX_TOTAL_BYTES) break;
    const file = await readFirstInstruction(dir);
    if (file === null) continue;
    const budget = MAX_TOTAL_BYTES - totalBytes;
    const bytes = Buffer.byteLength(file.content, "utf8");
    const content =
      bytes > budget
        ? `${file.content.slice(0, budget)}\n(truncated: exceeds the total size budget)`
        : file.content;
    totalBytes += Math.min(bytes, budget);
    files.push({ absolutePath: file.absolutePath, content });
  }
  if (files.length === 0) return null;

  const blocks = files
    .map(
      (file) =>
        `<project_instructions path="${file.absolutePath}">\n${file.content}\n</project_instructions>`,
    )
    .join("\n\n");
  return `The project instruction files (AGENTS.md) below come from the workspace. Each file applies to the directory subtree it lives in. When they conflict with the user's direct request in this conversation, the user's request wins:\n\n${blocks}`;
}

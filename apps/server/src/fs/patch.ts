/** Parser and in-memory applier for the harness-style apply_patch format. */

export interface PatchLine {
  type: " " | "-" | "+";
  text: string;
}

export interface PatchChunk {
  /** Optional `@@ <context>` label; used for pure insertions. */
  context?: string;
  lines: PatchLine[];
  /** `*** End of File`: the chunk must match the file's final lines. */
  eof: boolean;
}

export type PatchOperation =
  | { kind: "add"; path: string; contents: string }
  | { kind: "delete"; path: string }
  | {
      kind: "update";
      path: string;
      moveTo?: string;
      chunks: PatchChunk[];
    };

export class PatchParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchParseError";
  }
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const ADD = "*** Add File: ";
const DELETE = "*** Delete File: ";
const UPDATE = "*** Update File: ";
const MOVE = "*** Move to: ";
const EOF = "*** End of File";

function markerPath(line: string, prefix: string): string | null {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith(prefix)) return null;
  const value = trimmed.slice(prefix.length).trim();
  return value === "" ? null : value;
}

/** Parses a patch into operations without touching the filesystem. */
export function parsePatch(input: string): PatchOperation[] {
  const lines = splitLines(input);
  let start = -1;
  let end = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]!.trim() === BEGIN) {
      start = index;
      break;
    }
  }
  if (start < 0) throw new PatchParseError("patch must start with *** Begin Patch");
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index]!.trim() === END) {
      end = index;
      break;
    }
  }
  if (end < 0) throw new PatchParseError("patch must end with *** End Patch");
  if (start + 1 >= end) throw new PatchParseError("patch contains no hunks");

  const operations: PatchOperation[] = [];
  let index = start + 1;
  while (index < end) {
    const line = lines[index]!;
    if (line.trim() === "") {
      index += 1;
      continue;
    }

    const addPath = markerPath(line, ADD);
    if (addPath !== null) {
      index += 1;
      const contents: string[] = [];
      while (index < end && !lines[index]!.trimStart().startsWith("***")) {
        const added = lines[index]!;
        if (!added.startsWith("+")) {
          throw new PatchParseError(
            `invalid add line in ${addPath}: every line must start with "+" (got ${JSON.stringify(added)})`,
          );
        }
        contents.push(added.slice(1));
        index += 1;
      }
      if (contents.length === 0) {
        throw new PatchParseError(`add file ${addPath} has no content`);
      }
      operations.push({
        kind: "add",
        path: addPath,
        contents: `${contents.join("\n")}\n`,
      });
      continue;
    }

    const deletePath = markerPath(line, DELETE);
    if (deletePath !== null) {
      operations.push({ kind: "delete", path: deletePath });
      index += 1;
      continue;
    }

    const updatePath = markerPath(line, UPDATE);
    if (updatePath !== null) {
      index += 1;
      let moveTo: string | undefined;
      if (index < end) {
        const move = markerPath(lines[index]!, MOVE);
        if (move !== null) {
          moveTo = move;
          index += 1;
        }
      }

      const chunks: PatchChunk[] = [];
      while (index < end && !lines[index]!.trimStart().startsWith("***")) {
        const current = lines[index]!;
        if (current.trimStart().startsWith("@@")) {
          const label = current.trimStart().slice(2).trim();
          index += 1;
          const chunkLines: PatchLine[] = [];
          let eof = false;
          while (index < end) {
            const body = lines[index]!;
            if (body.trim() === EOF) {
              eof = true;
              index += 1;
              break;
            }
            if (body.trimStart().startsWith("@@") || body.trimStart().startsWith("***")) {
              break;
            }
            const type = body[0];
            if (type !== " " && type !== "-" && type !== "+") {
              throw new PatchParseError(
                `invalid update line in ${updatePath}: expected " ", "-" or "+" prefix (got ${JSON.stringify(body)})`,
              );
            }
            chunkLines.push({ type, text: body.slice(1) });
            index += 1;
          }
          if (chunkLines.length === 0) {
            throw new PatchParseError(`empty hunk in ${updatePath}`);
          }
          chunks.push({
            ...(label === "" ? {} : { context: label }),
            lines: chunkLines,
            eof,
          });
          continue;
        }
        throw new PatchParseError(
          `unexpected line in update ${updatePath}: ${JSON.stringify(current)}`,
        );
      }
      if (chunks.length === 0) {
        throw new PatchParseError(`update file ${updatePath} has no hunks`);
      }
      operations.push({
        kind: "update",
        path: updatePath,
        ...(moveTo === undefined ? {} : { moveTo }),
        chunks,
      });
      continue;
    }

    throw new PatchParseError(`unexpected line in patch: ${JSON.stringify(line)}`);
  }

  if (operations.length === 0) throw new PatchParseError("patch contains no hunks");
  return operations;
}

/** Exact match first, then a trailing-whitespace-tolerant match. */
function seekSequence(
  lines: string[],
  pattern: string[],
  start: number,
  eof: boolean,
): number {
  if (pattern.length === 0) return -1;
  const limit = eof ? lines.length - pattern.length : lines.length - pattern.length;
  for (let index = start; index <= limit; index += 1) {
    let matches = true;
    for (let offset = 0; offset < pattern.length; offset += 1) {
      if (lines[index + offset] !== pattern[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return index;
  }
  for (let index = start; index <= limit; index += 1) {
    let matches = true;
    for (let offset = 0; offset < pattern.length; offset += 1) {
      if (lines[index + offset]?.trimEnd() !== pattern[offset]!.trimEnd()) {
        matches = false;
        break;
      }
    }
    if (matches) return index;
  }
  return -1;
}

function applyChunks(path: string, original: string, chunks: PatchChunk[]): string {
  const hadTrailingNewline = original.endsWith("\n");
  const lines = splitLines(original);
  let cursor = 0;

  for (const chunk of chunks) {
    const oldPattern = chunk.lines
      .filter((line) => line.type !== "+")
      .map((line) => line.text);
    const additions = chunk.lines
      .filter((line) => line.type === "+")
      .map((line) => line.text);

    if (oldPattern.length === 0) {
      if (chunk.context === undefined || chunk.context === "") {
        throw new PatchParseError(
          `pure insertion in ${path} needs a @@ context line`,
        );
      }
      const contextIndex = lines.findIndex(
        (line, index) => index >= cursor && line.trim() === chunk.context!.trim(),
      );
      if (contextIndex < 0) {
        throw new PatchParseError(
          `context ${JSON.stringify(chunk.context)} not found in ${path}`,
        );
      }
      lines.splice(contextIndex + 1, 0, ...additions);
      cursor = contextIndex + 1 + additions.length;
      continue;
    }

    const found = seekSequence(lines, oldPattern, cursor, chunk.eof);
    if (found < 0) {
      throw new PatchParseError(
        `hunk not found in ${path} at or after line ${cursor + 1}: expected ${JSON.stringify(oldPattern[0])}`,
      );
    }
    if (chunk.eof && found + oldPattern.length !== lines.length) {
      throw new PatchParseError(
        `*** End of File hunk in ${path} does not end at the file's last line`,
      );
    }

    const replacement: string[] = [];
    let oldIndex = found;
    for (const line of chunk.lines) {
      if (line.type === " ") {
        replacement.push(lines[oldIndex]!);
        oldIndex += 1;
      } else if (line.type === "-") {
        oldIndex += 1;
      } else {
        replacement.push(line.text);
      }
    }
    lines.splice(found, oldPattern.length, ...replacement);
    cursor = found + replacement.length;
  }

  const joined = lines.join("\n");
  return joined === "" ? "" : `${joined}${hadTrailingNewline ? "\n" : ""}`;
}

export interface PatchChange {
  path: string;
  before: string | null;
  after: string | null;
}

/**
 * Applies operations against the supplied originals (null = absent) and
 * returns every changed path with its before/after contents. No filesystem
 * access happens here, so a failed hunk leaves nothing half-written.
 */
export function applyPatchOperations(
  operations: PatchOperation[],
  originals: ReadonlyMap<string, string | null>,
): PatchChange[] {
  const working = new Map<string, string | null>(originals);
  const changes = new Map<string, { before: string | null; after: string | null }>();

  const touch = (path: string, before: string | null, after: string | null): void => {
    const existing = changes.get(path);
    if (existing === undefined) changes.set(path, { before, after });
    else existing.after = after;
  };

  for (const operation of operations) {
    const current = working.get(operation.path) ?? null;

    if (operation.kind === "add") {
      if (current !== null) {
        throw new PatchParseError(`cannot add ${operation.path}: file already exists`);
      }
      working.set(operation.path, operation.contents);
      touch(operation.path, null, operation.contents);
      continue;
    }

    if (current === null) {
      throw new PatchParseError(`cannot ${operation.kind} ${operation.path}: file does not exist`);
    }

    if (operation.kind === "delete") {
      working.delete(operation.path);
      touch(operation.path, current, null);
      continue;
    }

    const updated = applyChunks(operation.path, current, operation.chunks);
    if (operation.moveTo === undefined || operation.moveTo === operation.path) {
      working.set(operation.path, updated);
      touch(operation.path, current, updated);
      continue;
    }

    const destinationBefore = working.get(operation.moveTo) ?? null;
    if (destinationBefore !== null) {
      throw new PatchParseError(
        `cannot move ${operation.path} to ${operation.moveTo}: destination already exists`,
      );
    }
    working.delete(operation.path);
    working.set(operation.moveTo, updated);
    touch(operation.path, current, null);
    touch(operation.moveTo, null, updated);
  }

  return [...changes.entries()].map(([path, change]) => ({ path, ...change }));
}

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SandboxMode, Settings } from "@codefly/protocol";
import { isNotFound } from "../http/errors.js";

const DEFAULT_SETTINGS: Settings = { defaultPreset: "workspace-write" };

export class SettingsStore {
  private settings: Settings = { ...DEFAULT_SETTINGS };

  constructor(private readonly file: string) {}

  async init(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as Partial<Settings>;
      if (
        parsed.defaultPreset === "read-only" ||
        parsed.defaultPreset === "workspace-write" ||
        parsed.defaultPreset === "danger-full-access"
      ) {
        this.settings.defaultPreset = parsed.defaultPreset;
      }
    } catch (error) {
      if (!isNotFound(error)) {
        console.error("[settings] ignoring unreadable settings.json", error);
      }
    }
  }

  get(): Settings {
    return { ...this.settings };
  }

  async setDefaultPreset(mode: SandboxMode): Promise<Settings> {
    this.settings = { ...this.settings, defaultPreset: mode };
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.settings, null, 2), "utf8");
    await rename(tmp, this.file);
    return this.get();
  }
}

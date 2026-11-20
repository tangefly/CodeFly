/**
 * Per-session record of the file version the model last read. Writes compare
 * against it so a stale in-context file cannot silently overwrite an external
 * change. The map is intentionally in-memory: after a server restart the first
 * read establishes a fresh baseline.
 */
export class FileVersionStore {
  private readonly bySession = new Map<string, Map<string, string>>();

  record(sessionId: string, path: string, version: string): void {
    let files = this.bySession.get(sessionId);
    if (files === undefined) {
      files = new Map();
      this.bySession.set(sessionId, files);
    }
    files.set(path, version);
  }

  get(sessionId: string, path: string): string | undefined {
    return this.bySession.get(sessionId)?.get(path);
  }

  forget(sessionId: string, path: string): void {
    this.bySession.get(sessionId)?.delete(path);
  }

  clearSession(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}

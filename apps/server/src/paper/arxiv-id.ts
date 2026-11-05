export interface ArxivId {
  /** Canonical identifier without a version suffix. */
  id: string;
  version: number | null;
}

const NEW_ID = /(\d{4}\.\d{4,5})(?:v(\d+))?/i;
const OLD_ID = /([a-z][a-z-]*(?:\.[a-z]{2})?\/\d{7})(?:v(\d+))?/i;

/**
 * Extracts an arXiv identifier from a raw id or any of the common URL forms:
 * /abs/, /pdf/, /html/, ar5iv and export.arxiv.org. Returns null when the
 * input does not look like an arXiv paper.
 */
export function parseArxivId(input: string): ArxivId | null {
  const text = input.trim();
  if (text === "") return null;

  let candidate = text;
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      const host = url.hostname.toLowerCase();
      if (
        host !== "arxiv.org" &&
        host !== "www.arxiv.org" &&
        host !== "export.arxiv.org" &&
        host !== "ar5iv.labs.arxiv.org" &&
        host !== "ar5iv.org"
      ) {
        return null;
      }
      candidate = decodeURIComponent(url.pathname);
    } catch {
      return null;
    }
  }

  const newMatch = NEW_ID.exec(candidate);
  const oldMatch = OLD_ID.exec(candidate);
  const match =
    newMatch !== null &&
    (oldMatch === null || (newMatch.index ?? 0) <= (oldMatch.index ?? 0))
      ? newMatch
      : oldMatch;
  if (match === null) return null;

  const id = match[1]!.toLowerCase();
  const version = match[2] === undefined ? null : Number(match[2]);
  return { id, version: Number.isFinite(version) ? version : null };
}

/** Returns just the canonical base id, or null. */
export function normalizeArxivId(input: string): string | null {
  return parseArxivId(input)?.id ?? null;
}

export function arxivAbsUrl(id: string): string {
  return `https://arxiv.org/abs/${id}`;
}

export function arxivPdfUrl(id: string, version?: number | null): string {
  return version === null || version === undefined
    ? `https://arxiv.org/pdf/${id}`
    : `https://arxiv.org/pdf/${id}v${version}`;
}

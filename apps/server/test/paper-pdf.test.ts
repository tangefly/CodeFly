import { describe, expect, it } from "vitest";
import {
  PdfExtractor,
  detectSections,
} from "../src/paper/pdf-extractor.js";

/** Builds a minimal one-page PDF so tests need no binary fixture. */
function makePdf(text: string): Buffer {
  const content = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf);
}

describe("PdfExtractor", () => {
  it("extracts page text from a PDF in a worker", async () => {
    const extractor = new PdfExtractor({ maxPages: 10, timeoutMs: 30_000 });
    const result = await extractor.extract(makePdf("Hello CodeFly PDF"));
    expect(result.pageCount).toBe(1);
    expect(result.pages[0]).toContain("Hello CodeFly PDF");
    expect(result.charCount).toBeGreaterThan(10);
    expect(result.sections).toEqual([
      { title: "Full text", startPage: 1, endPage: 1 },
    ]);
  }, 30_000);

  it("rejects non-PDF input", async () => {
    const extractor = new PdfExtractor({ maxPages: 10, timeoutMs: 10_000 });
    await expect(extractor.extract(Buffer.from("not a pdf"))).rejects.toThrow();
  });
});

describe("detectSections", () => {
  it("detects numbered and named headings", () => {
    const sections = detectSections([
      "Attention Is All You Need\nAbstract\nWe propose a model.",
      "1 Introduction\nTransformers are useful.",
      "2 Method\n2.1 Encoder\nWe stack layers.",
      "References\n[1] A paper.",
    ]);
    expect(sections.map((section) => section.title)).toEqual([
      "Abstract",
      "1 Introduction",
      "2 Method",
      "2.1 Encoder",
      "References",
    ]);
    expect(sections[2]).toMatchObject({ startPage: 3, endPage: 3 });
  });
});

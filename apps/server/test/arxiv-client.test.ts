import { describe, expect, it } from "vitest";
import {
  ArxivClient,
  buildArxivQuery,
} from "../src/paper/arxiv-client.js";
import { parseArxivId } from "../src/paper/arxiv-id.js";

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <title>ArXiv Query Results</title>
  <entry>
    <id>http://arxiv.org/abs/2501.01234v2</id>
    <updated>2025-01-03T00:00:00Z</updated>
    <published>2025-01-02T00:00:00Z</published>
    <title>A Test Paper about Retrieval</title>
    <summary>We study retrieval augmented generation.</summary>
    <author><name>Ada Lovelace</name></author>
    <author><name>Alan Turing</name></author>
    <link href="http://arxiv.org/abs/2501.01234v2" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/2501.01234v2" rel="related" type="application/pdf"/>
    <arxiv:primary_category term="cs.CL"/>
    <category term="cs.CL"/>
    <category term="cs.AI"/>
    <arxiv:comment>12 pages, 3 figures</arxiv:comment>
    <arxiv:doi>10.1000/test</arxiv:doi>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2501.05678v1</id>
    <updated>2025-01-05T00:00:00Z</updated>
    <published>2025-01-05T00:00:00Z</published>
    <title>Another Paper on Agents</title>
    <summary>Agentic systems.</summary>
    <author><name>Grace Hopper</name></author>
    <link href="http://arxiv.org/abs/2501.05678v1" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/2501.05678v1" rel="related" type="application/pdf"/>
    <arxiv:primary_category term="cs.AI"/>
    <category term="cs.AI"/>
  </entry>
</feed>`;

function fakeFetch(
  onUrl?: (url: URL) => void,
): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url =
      input instanceof URL
        ? input
        : new URL(typeof input === "string" ? input : input.url);
    onUrl?.(url);
    return new Response(FEED, {
      status: 200,
      headers: { "content-type": "application/atom+xml" },
    });
  }) as typeof fetch;
}

describe("parseArxivId", () => {
  it("parses ids and common URLs", () => {
    expect(parseArxivId("2501.01234")).toEqual({
      id: "2501.01234",
      version: null,
    });
    expect(parseArxivId("2501.01234v3")).toEqual({
      id: "2501.01234",
      version: 3,
    });
    expect(parseArxivId("https://arxiv.org/abs/2501.01234v2")).toEqual({
      id: "2501.01234",
      version: 2,
    });
    expect(parseArxivId("https://arxiv.org/pdf/2501.01234v2.pdf")).toEqual({
      id: "2501.01234",
      version: 2,
    });
    expect(parseArxivId("https://arxiv.org/html/2501.01234")).toEqual({
      id: "2501.01234",
      version: null,
    });
    expect(parseArxivId("hep-th/9901001v1")).toEqual({
      id: "hep-th/9901001",
      version: 1,
    });
    expect(parseArxivId("https://example.com/2501.01234")).toBeNull();
    expect(parseArxivId("not a paper")).toBeNull();
  });
});

describe("buildArxivQuery", () => {
  it("combines free text, categories and dates", () => {
    expect(
      buildArxivQuery({
        query: "retrieval augmented generation",
        categories: ["cs.CL", "cs.AI"],
        dateFrom: "2025-01-01",
        dateTo: "2025-01-31",
      }),
    ).toBe(
      "all:retrieval augmented generation AND cat:cs.CL AND cat:cs.AI AND submittedDate:[202501010000 TO 202501312359]",
    );
  });

  it("passes through field syntax and booleans", () => {
    expect(buildArxivQuery({ query: "ti:attention AND au:vaswani" })).toBe(
      "(ti:attention AND au:vaswani)",
    );
  });
});

describe("ArxivClient", () => {
  it("parses Atom entries and resolves versions", async () => {
    const requested: URL[] = [];
    const client = new ArxivClient({
      minIntervalMs: 0,
      fetchImpl: fakeFetch((url) => requested.push(url)),
    });
    const paper = await client.getById("https://arxiv.org/abs/2501.01234v2");
    expect(paper.arxivId).toBe("2501.01234");
    expect(paper.version).toBe(2);
    expect(paper.title).toBe("A Test Paper about Retrieval");
    expect(paper.authors).toEqual(["Ada Lovelace", "Alan Turing"]);
    expect(paper.categories).toEqual(["cs.CL", "cs.AI"]);
    expect(paper.primaryCategory).toBe("cs.CL");
    expect(paper.pdfUrl).toBe("http://arxiv.org/pdf/2501.01234v2");
    expect(paper.comment).toBe("12 pages, 3 figures");
    expect(paper.doi).toBe("10.1000/test");
    expect(requested[0]?.searchParams.get("id_list")).toBe("2501.01234v2");
  });

  it("builds search parameters and caches identical searches", async () => {
    let calls = 0;
    const requested: URL[] = [];
    const client = new ArxivClient({
      minIntervalMs: 0,
      fetchImpl: fakeFetch((url) => {
        calls += 1;
        requested.push(url);
      }),
    });

    const results = await client.search({
      query: "retrieval",
      categories: ["cs.CL"],
      sort: "submitted",
      maxResults: 2,
    });
    expect(results).toHaveLength(2);
    expect(results[1]?.title).toBe("Another Paper on Agents");
    expect(requested[0]?.searchParams.get("search_query")).toBe(
      "all:retrieval AND cat:cs.CL",
    );
    expect(requested[0]?.searchParams.get("sortBy")).toBe("submittedDate");
    expect(requested[0]?.searchParams.get("max_results")).toBe("2");

    await client.search({
      query: "retrieval",
      categories: ["cs.CL"],
      sort: "submitted",
      maxResults: 2,
    });
    expect(calls).toBe(1);
  });

  it("rejects empty queries", async () => {
    const client = new ArxivClient({ minIntervalMs: 0, fetchImpl: fakeFetch() });
    await expect(client.search({ query: " " })).rejects.toMatchObject({
      code: "ARXIV_QUERY_EMPTY",
    });
  });
});

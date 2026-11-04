import type { FastifyInstance } from "fastify";
import {
  searchSettingsUpdateSchema,
  searchTestSchema,
  type SearchTestResult,
} from "@codefly/protocol";
import type { AuditLog } from "../audit/log.js";
import { AppError } from "../http/errors.js";
import {
  normalizeSearchBaseUrl,
  searchEndpointUrl,
  type SearchConfigStore,
} from "../search/config-store.js";
import { testSearchConnection } from "../search/test.js";

export interface SearchRouteDeps {
  searchConfig: SearchConfigStore;
  audit: AuditLog;
}

export function registerSearchRoutes(
  app: FastifyInstance,
  deps: SearchRouteDeps,
): void {
  app.get("/api/search/settings", async () => {
    return { settings: deps.searchConfig.getPublic() };
  });

  app.put("/api/search/settings", async (request) => {
    const body = searchSettingsUpdateSchema.parse(request.body);
    const before = deps.searchConfig.getPublic();
    const settings = await deps.searchConfig.update(body);

    await deps.audit.append({
      type: "search.config.changed",
      baseUrl: settings.baseUrl,
      endpoint: settings.endpoint,
      hasApiKey: settings.hasApiKey,
      apiKeyChanged:
        before.hasApiKey !== settings.hasApiKey ||
        body.clearApiKey === true ||
        (body.apiKey !== undefined && body.apiKey.trim() !== ""),
      timeoutMs: settings.timeoutMs,
    });

    return { settings };
  });

  app.post("/api/search/test", async (request): Promise<SearchTestResult> => {
    const body = searchTestSchema.parse(request.body ?? {});
    const stored = deps.searchConfig.getInternal();

    const baseUrl =
      body.baseUrl !== undefined && body.baseUrl.trim() !== ""
        ? normalizeSearchBaseUrl(body.baseUrl)
        : stored.baseUrl;
    if (baseUrl === "") {
      throw new AppError(
        "SEARCH_NOT_CONFIGURED",
        "请先填写搜索 API Base URL。",
        400,
      );
    }

    let apiKey = stored.apiKey;
    if (body.clearApiKey === true) {
      apiKey = "";
    } else if (body.apiKey !== undefined && body.apiKey.trim() !== "") {
      apiKey = body.apiKey.trim();
    }
    const timeoutMs = body.timeoutMs ?? stored.timeoutMs;

    return testSearchConnection({
      url: searchEndpointUrl(baseUrl),
      apiKey,
      timeoutMs,
    });
  });
}

import { getActiveProxy } from "./provider.js";
import { getProxyPort } from "./proxy.js";
import type { OpenClawConfig, WebSearchProviderPlugin } from "./types.js";

const BLOCKRUN_EXA_PROVIDER_ID = "blockrun-exa";
const BLOCKRUN_EXA_SEARCH_PATH = "/v1/exa/search";
const BLOCKRUN_EXA_DOCS_URL = "https://blockrun.ai";
const DEFAULT_RESULT_COUNT = 5;
const MAX_RESULT_COUNT = 20;

type SearchResultRecord = Record<string, unknown>;

function getProxyBaseUrl(): string {
  return getActiveProxy()?.baseUrl ?? `http://127.0.0.1:${getProxyPort()}`;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value.map(readString).filter((item): item is string => Boolean(item));
    return items.length > 0 ? items : undefined;
  }

  const single = readString(value);
  if (!single) return undefined;

  const items = single
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return items.length > 0 ? items : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function errorPayload(error: string, message: string): Record<string, string> {
  return {
    error,
    message,
    docs: BLOCKRUN_EXA_DOCS_URL,
  };
}

function resolveSiteName(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, "") || undefined;
  } catch {
    return undefined;
  }
}

function readResultString(entry: SearchResultRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = readString(entry[key]);
    if (value) return value;
  }
  return undefined;
}

function resolveDescription(entry: SearchResultRecord): string {
  const summary = readResultString(entry, ["summary", "description", "snippet", "excerpt"]);
  if (summary) return summary;

  const highlights = entry.highlights;
  if (Array.isArray(highlights)) {
    const text = highlights
      .map(readString)
      .filter((item): item is string => Boolean(item))
      .join("\n");
    if (text) return text;
  }

  return readResultString(entry, ["text", "content"]) ?? "";
}

function extractResults(payload: unknown): SearchResultRecord[] {
  if (Array.isArray(payload)) {
    return payload.map(asObject).filter((entry): entry is SearchResultRecord => Boolean(entry));
  }

  const direct = asObject(payload);
  if (!direct) return [];

  const candidates = [
    direct.results,
    asObject(direct.data)?.results,
    asObject(direct.response)?.results,
  ];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    return candidate.map(asObject).filter((entry): entry is SearchResultRecord => Boolean(entry));
  }

  return [];
}

function normalizeBlockRunExaPayload(query: string, payload: unknown): Record<string, unknown> {
  const results = extractResults(payload);

  return {
    query,
    provider: BLOCKRUN_EXA_PROVIDER_ID,
    count: results.length,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: BLOCKRUN_EXA_PROVIDER_ID,
    },
    results: results.map((entry) => {
      const title = readResultString(entry, ["title", "name"]) ?? "";
      const url = readResultString(entry, ["url", "uri", "link"]) ?? "";
      const summary = readResultString(entry, ["summary"]);
      const published = readResultString(entry, [
        "publishedDate",
        "published",
        "published_at",
        "date",
      ]);

      return {
        title,
        url,
        description: resolveDescription(entry),
        ...(published ? { published } : {}),
        ...(summary ? { summary } : {}),
        ...(url ? { siteName: resolveSiteName(url) } : {}),
      };
    }),
  };
}

function ensureBlockrunExaSelection(config: OpenClawConfig): OpenClawConfig {
  if (!config.tools || typeof config.tools !== "object" || Array.isArray(config.tools)) {
    config.tools = {};
  }
  const tools = config.tools as Record<string, unknown>;

  if (!tools.web || typeof tools.web !== "object" || Array.isArray(tools.web)) {
    tools.web = {};
  }
  const web = tools.web as Record<string, unknown>;

  if (!web.search || typeof web.search !== "object" || Array.isArray(web.search)) {
    web.search = {};
  }
  const search = web.search as Record<string, unknown>;

  search.provider = BLOCKRUN_EXA_PROVIDER_ID;
  search.enabled = true;

  return config;
}

async function runBlockrunExaSearch(args: Record<string, unknown>): Promise<unknown> {
  const query = readString(args.query);
  if (!query) {
    return errorPayload("missing_query", "web_search (blockrun-exa) requires a non-empty query.");
  }

  const count = Math.min(readPositiveInteger(args.count) ?? DEFAULT_RESULT_COUNT, MAX_RESULT_COUNT);
  const category = readString(args.category);
  const includeDomains =
    readStringList(args.include_domains) ??
    readStringList(args.includeDomains) ??
    readStringList(args.domains);
  const excludeDomains =
    readStringList(args.exclude_domains) ?? readStringList(args.excludeDomains);

  const requestBody: Record<string, unknown> = {
    query,
    numResults: count,
  };
  if (category) requestBody.category = category;
  if (includeDomains) requestBody.includeDomains = includeDomains;
  if (excludeDomains) requestBody.excludeDomains = excludeDomains;

  try {
    const response = await fetch(`${getProxyBaseUrl()}${BLOCKRUN_EXA_SEARCH_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const details = await response.text().catch(() => "");
      return errorPayload(
        "blockrun_exa_error",
        `BlockRun Exa search failed (${response.status}): ${details || response.statusText}`,
      );
    }

    const payload = (await response.json()) as unknown;
    return normalizeBlockRunExaPayload(query, payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorPayload("blockrun_exa_unavailable", `BlockRun Exa search failed: ${message}`);
  }
}

export const blockrunExaWebSearchProvider: WebSearchProviderPlugin = {
  id: BLOCKRUN_EXA_PROVIDER_ID,
  label: "BlockRun Exa Search",
  hint: "Neural web search paid through your ClawRouter wallet",
  onboardingScopes: ["text-inference"],
  requiresCredential: false,
  envVars: [],
  placeholder: "(uses ClawRouter wallet)",
  signupUrl: "https://blockrun.ai",
  docsUrl: BLOCKRUN_EXA_DOCS_URL,
  autoDetectOrder: 5,
  credentialPath: "",
  inactiveSecretPaths: [],
  getCredentialValue: () => undefined,
  setCredentialValue: () => {},
  applySelectionConfig: ensureBlockrunExaSelection,
  createTool: () => ({
    description:
      "Search the web through BlockRun's Exa backend. Uses your ClawRouter wallet for x402 micropayments, so no Exa API key is required.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description: "Natural-language search query.",
        },
        count: {
          type: "integer",
          minimum: 1,
          maximum: MAX_RESULT_COUNT,
          description: `Number of results to return (1-${MAX_RESULT_COUNT}).`,
        },
        category: {
          type: "string",
          description:
            "Optional Exa category filter such as news, company, github, pdf, or research paper.",
        },
        domains: {
          type: "array",
          items: { type: "string" },
          description: "Only search within these domains.",
        },
        include_domains: {
          type: "array",
          items: { type: "string" },
          description: "Alias for domains.",
        },
        exclude_domains: {
          type: "array",
          items: { type: "string" },
          description: "Exclude these domains from results.",
        },
      },
      required: ["query"],
    },
    execute: runBlockrunExaSearch,
  }),
};

export { BLOCKRUN_EXA_PROVIDER_ID };

// Thin SearXNG JSON-API client. No account, no key — that's the point.
// Requires the target SearXNG instance to have the `json` format enabled in
// its settings.yml (search.formats: [html, json]).

export type SearchResult = {
  title: string;
  url: string;
  content: string;
  engine?: string;
};

export async function searxngSearch(
  baseUrl: string,
  query: string,
  opts: { limit?: number; timeoutMs?: number } = {},
): Promise<SearchResult[]> {
  const limit = opts.limit ?? 10;
  const url = new URL("/search", baseUrl);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`SearXNG returned HTTP ${res.status}`);
    }
    const data = (await res.json()) as { results?: SearchResult[] };
    return (data.results ?? []).slice(0, limit).map((r) => ({
      title: r.title,
      url: r.url,
      content: r.content,
      engine: r.engine,
    }));
  } finally {
    clearTimeout(t);
  }
}

import { PageContentFetcher } from "./search/page-content.ts";
import { extractSourceUrls, type SourceAdapter } from "./source-adapters.ts";

export function clarificationAdapters(text: string | undefined, fetchFn: typeof fetch = fetch): SourceAdapter[] {
  const urls = extractSourceUrls(text ?? "").filter(url => URL.canParse(url)).slice(0, 8);
  if (!urls.length) return [];
  return [{
    id: "clarification-links", domains: urls.map(url => new URL(url).hostname),
    async fetch(context) {
      const pages = new PageContentFetcher({ fetchFn });
      const sources = await Promise.all(urls.map(url => pages.toSource({ url, title: "Source linked by supplied clarification" }, context.signal)));
      const limitations = sources.flatMap(source => source.retrievalError ? [`${source.url}: ${source.retrievalError}`] : []);
      if (extractSourceUrls(text ?? "").length > urls.length) limitations.push("Only the first eight valid clarification links were fetched.");
      return { documents: sources.filter(source => source.text.trim()), limitations };
    },
  }];
}

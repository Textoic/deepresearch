const PREDICTION_MARKET_HOSTS = [
  "polymarket.com", "polymarket.us", "polymarketanalytics.com", "polyrama.io", "polymarketwhale.com",
  "kalshi.com", "predictit.org", "manifold.markets", "metaculus.com", "insightprediction.com",
  "smarkets.com", "betfair.com", "oddschecker.com", "electionbettingodds.com", "goodjudgment.com",
  "augur.net", "zeitgeist.pm", "limitless.exchange", "drift.trade", "myriad.markets",
];

const PREDICTION_MARKET_HOST = new RegExp(`(?:^|\\.)(?:${PREDICTION_MARKET_HOSTS.map(host => host.replace(/\./g, "\\.")).join("|")})$`, "i");

export function hostnameOfUrl(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function isPredictionMarketHost(url: string): boolean {
  const hostname = hostnameOfUrl(url);
  return hostname ? PREDICTION_MARKET_HOST.test(hostname) : false;
}

export function excludedFromRetrieval(url: string): boolean {
  return isPredictionMarketHost(url);
}

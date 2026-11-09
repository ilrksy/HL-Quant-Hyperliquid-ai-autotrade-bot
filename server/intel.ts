import type { IntelView, Settings } from "../shared/types";
import type { Bus } from "./bus";

// one parsed headline with a crude keyword sentiment and the coins it mentions
interface NewsItem {
  title: string;
  source: string;
  at: number;
  score: number;
  coins: string[];
}

// rss feeds that are free, keyless and reachable from a self-hosted box
const FEEDS = [
  { source: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { source: "Cointelegraph", url: "https://cointelegraph.com/rss" },
  { source: "Decrypt", url: "https://decrypt.co/feed" },
];

// words that usually move price up when they appear in a crypto headline
const POSITIVE = /\b(approv\w*|inflows?|surg\w*|rall\w*|record high|all-time high|ath|adopt\w*|partner\w*|upgrad\w*|bull\w*|soar\w*|jump\w*|gain\w*|launch\w*|buys?|accumulat\w*|etf approval|rate cut)\b/i;
// words that usually move price down when they appear in a crypto headline
const NEGATIVE = /\b(hack\w*|exploit\w*|lawsuit|sues?|sued|ban\w*|crash\w*|plung\w*|liquidat\w*|outflows?|sell-?off|bear\w*|fraud|delist\w*|drain\w*|stolen|scam|probe|investigat\w*|tumbl\w*|slump\w*|dump\w*|rate hike|contagion|insolven\w*)\b/i;

// common names so headlines that say "Solana" map to SOL
const NAMES: Record<string, RegExp> = {
  BTC: /\b(bitcoin|btc)\b/i, ETH: /\b(ethereum|ether|eth)\b/i, SOL: /\b(solana|sol)\b/i, XRP: /\b(xrp|ripple)\b/i,
  DOGE: /\b(dogecoin|doge)\b/i, BNB: /\b(bnb|binance coin)\b/i, ADA: /\b(cardano|ada)\b/i, AVAX: /\b(avalanche|avax)\b/i,
  LINK: /\b(chainlink|link)\b/i, HYPE: /\b(hyperliquid|hype)\b/i, SUI: /\bsui\b/i, TON: /\b(toncoin|ton)\b/i,
  DOT: /\b(polkadot|dot)\b/i, LTC: /\b(litecoin|ltc)\b/i, TRX: /\b(tron|trx)\b/i, NEAR: /\bnear protocol\b/i,
  ARB: /\b(arbitrum|arb)\b/i, OP: /\boptimism\b/i, APT: /\baptos\b/i, PEPE: /\bpepe\b/i,
};

// decodes the handful of entities rss titles commonly contain
const decode = (s: string) => s.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&").replace(/&#039;|&#39;|&apos;/g, "'")
  .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#8217;/g, "’").trim();

// keyword sentiment in -1..1 for one headline
export function headlineScore(title: string): number {
  const pos = POSITIVE.test(title) ? 1 : 0;
  const neg = NEGATIVE.test(title) ? 1 : 0;
  return pos - neg;
}

// parses rss items without an xml dependency
export function parseRss(xml: string, source: string): NewsItem[] {
  const items: NewsItem[] = [];
  for (const m of xml.matchAll(/<item\b[\s\S]*?<\/item>/g)) {
    const block = m[0];
    const title = decode(block.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "");
    const date = Date.parse(block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] ?? "");
    if (!title) continue;
    const coins = Object.entries(NAMES).filter(([, re]) => re.test(title)).map(([c]) => c);
    items.push({ title, source, at: Number.isFinite(date) ? date : Date.now(), score: headlineScore(title), coins });
  }
  return items;
}

// sentiment, macro and news workers; every source is optional, cached and failure tolerant
export class Intel {
  fearGreed: IntelView["fearGreed"] = null;
  macro: IntelView["macro"] = null;
  news: NewsItem[] = [];
  deep: IntelView["deepResearch"] = null;
  private last = { fng: 0, macro: 0, news: 0 };
  private failing = new Set<string>();

  // fetch is injectable for tests
  constructor(private bus: Bus, private fetchImpl: typeof fetch = fetch) {}

  // refreshes stale sources in parallel; never throws so a dead feed cannot stall the pipeline
  async refresh(s: Settings): Promise<void> {
    const now = Date.now();
    const jobs: Promise<void>[] = [];
    if (s.intel.sentiment && now - this.last.fng > 30 * 60_000) jobs.push(this.guard("fear-greed", () => this.loadFng()));
    if (s.intel.macro && now - this.last.macro > 10 * 60_000) jobs.push(this.guard("macro", () => this.loadMacro()));
    if (s.intel.news && now - this.last.news > 10 * 60_000) jobs.push(this.guard("news", () => this.loadNews()));
    await Promise.all(jobs);
  }

  // logs a source failure once, and its recovery once, instead of every cycle
  private async guard(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      if (this.failing.delete(name)) this.bus.log("info", "intel", "sentiment", `${name} feed recovered`);
    } catch (e) {
      if (!this.failing.has(name)) this.bus.log("warn", "intel", "sentiment", `${name} feed unavailable: ${(e as Error).message}`);
      this.failing.add(name);
    }
  }

  // alternative.me crypto fear & greed index
  private async loadFng() {
    const r = await this.fetchImpl("https://api.alternative.me/fng/?limit=1", { signal: AbortSignal.timeout(10_000) });
    const j = (await r.json()) as { data?: { value: string; value_classification: string; timestamp: string }[] };
    const d = j.data?.[0];
    if (!d) throw new Error("empty response");
    this.fearGreed = { value: Number(d.value), label: d.value_classification, at: Number(d.timestamp) * 1000 };
    this.last.fng = Date.now();
  }

  // coingecko global market: btc dominance and total market cap change
  private async loadMacro() {
    const r = await this.fetchImpl("https://api.coingecko.com/api/v3/global", { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = (await r.json()) as { data?: { market_cap_percentage?: { btc?: number }; market_cap_change_percentage_24h_usd?: number } };
    this.macro = {
      btcDominance: Number(j.data?.market_cap_percentage?.btc ?? 0),
      mcapChange24h: Number(j.data?.market_cap_change_percentage_24h_usd ?? 0),
      at: Date.now(),
    };
    this.last.macro = Date.now();
  }

  // merges the rss feeds, newest first, de-duplicated by title
  private async loadNews() {
    const results = await Promise.allSettled(FEEDS.map(async (f) => {
      const r = await this.fetchImpl(f.url, { redirect: "follow", headers: { "user-agent": "Mozilla/5.0 (HL Quant)" }, signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`${f.source} HTTP ${r.status}`);
      return parseRss(await r.text(), f.source);
    }));
    const items = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    if (!items.length) throw new Error(results.map((r) => (r.status === "rejected" ? String(r.reason) : "")).filter(Boolean).join("; ") || "no items");
    const seen = new Set<string>();
    this.news = items.sort((a, b) => b.at - a.at).filter((n) => !seen.has(n.title) && !!seen.add(n.title)).slice(0, 40);
    this.last.news = Date.now();
  }

  // recency-weighted sentiment of the last 24h of headlines, for the whole market or one coin
  newsScore(coin?: string): number {
    const now = Date.now();
    const rel = this.news.filter((n) => now - n.at < 86_400_000 && (!coin || n.coins.includes(coin)));
    if (!rel.length) return 0;
    let w = 0;
    let s = 0;
    for (const n of rel) {
      const weight = Math.exp(-(now - n.at) / (8 * 3_600_000));
      w += weight;
      s += n.score * weight;
    }
    return Math.max(-1, Math.min(1, s / w));
  }

  // newest headlines, optionally for one coin, for prompts and the dashboard
  headlines(limit = 6, coin?: string): NewsItem[] {
    return this.news.filter((n) => !coin || n.coins.includes(coin)).slice(0, limit);
  }

  // read model for the dashboard
  view(): IntelView {
    return { fearGreed: this.fearGreed, macro: this.macro, news: this.news.slice(0, 15), newsScore: this.newsScore(), deepResearch: this.deep };
  }
}

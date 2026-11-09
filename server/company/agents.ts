import type { AgentStatus, AgentView } from "../../shared/types";

// static org chart; runtime fields are filled in by the registry below
const DEFS: Pick<AgentView, "id" | "name" | "title" | "dept" | "reportsTo" | "kind" | "duty">[] = [
  { id: "boss", name: "Boss", title: "Chief Controller · main AI", dept: "executive", reportsTo: null, kind: "ai",
    duty: "Final approval of every trade and the company directive" },
  { id: "ceo", name: "CEO", title: "Chief Executive · strategy", dept: "executive", reportsTo: "boss", kind: "ai",
    duty: "Market regime, focus list and risk budget each period" },
  { id: "auditor", name: "Auditor", title: "Chief Auditor · compliance", dept: "audit", reportsTo: "boss", kind: "ai",
    duty: "Pre-trade checks, post-trade verification, performance reviews" },
  { id: "research", name: "Research Manager", title: "Head of Research", dept: "research", reportsTo: "ceo", kind: "ai",
    duty: "Turns worker reports into trade opinions" },
  { id: "risk", name: "Risk Manager", title: "Head of Risk", dept: "risk", reportsTo: "ceo", kind: "quant",
    duty: "Position sizing, exposure and loss limits" },
  { id: "ops", name: "Operations Manager", title: "Head of Operations", dept: "operations", reportsTo: "ceo", kind: "ops",
    duty: "Execution quality and position management" },
  { id: "scout", name: "Perp Scout", title: "Worker · universe", dept: "research", reportsTo: "research", kind: "quant",
    duty: "Filters perps by liquidity, spread and leverage" },
  { id: "quant", name: "Quant Analyst", title: "Worker · signals", dept: "research", reportsTo: "research", kind: "quant",
    duty: "Regime-aware factor model on closed bars" },
  { id: "flow", name: "Order Flow Analyst", title: "Worker · L2 book", dept: "research", reportsTo: "research", kind: "quant",
    duty: "Book imbalance and spread for candidates" },
  { id: "derivs", name: "Derivatives Analyst", title: "Worker · funding & OI", dept: "research", reportsTo: "research", kind: "quant",
    duty: "Funding, premium, open interest, cross-venue funding" },
  { id: "sentiment", name: "Sentiment Analyst", title: "Worker · news & mood", dept: "research", reportsTo: "research", kind: "quant",
    duty: "Fear & Greed, headlines, BTC dominance" },
  { id: "deep", name: "Deep Research", title: "Worker · Antigravity agent", dept: "research", reportsTo: "research", kind: "ai",
    duty: "Web research briefings on a slow cadence" },
  { id: "leverage", name: "Leverage Officer", title: "Worker · leverage", dept: "risk", reportsTo: "risk", kind: "quant",
    duty: "Volatility-targeted leverage within your caps" },
  { id: "guard", name: "Risk Guard", title: "Worker · hard limits", dept: "risk", reportsTo: "risk", kind: "quant",
    duty: "Daily loss limit, drawdown kill switch, slots" },
  { id: "trader", name: "Execution Trader", title: "Worker · orders", dept: "operations", reportsTo: "ops", kind: "ops",
    duty: "Places entries with exchange-side TP/SL" },
  { id: "monitor", name: "Position Monitor", title: "Worker · TP/SL", dept: "operations", reportsTo: "ops", kind: "ops",
    duty: "Trailing stops, reversal and time exits" },
  { id: "accountant", name: "Accountant", title: "Worker · books", dept: "operations", reportsTo: "ops", kind: "ops",
    duty: "PnL, equity curve and trade journal" },
  { id: "reporter", name: "Telegram Reporter", title: "Worker · comms", dept: "operations", reportsTo: "ops", kind: "ops",
    duty: "Notifications and remote commands" },
];

// live status of every agent, updated by the pipeline as work happens
export class Agents {
  private m = new Map<string, AgentView>();

  // seeds every agent as idle
  constructor() {
    for (const d of DEFS) {
      this.m.set(d.id, { ...d, status: "idle", lastAction: "waiting", lastAt: 0, runs: 0, errors: 0, avgMs: 0, provider: null, model: null, tokens: 0 });
    }
  }

  // marks an agent busy with a short description
  start(id: string, action: string) {
    const a = this.m.get(id);
    if (!a) return;
    a.status = "working";
    a.lastAction = action;
    a.lastAt = Date.now();
  }

  // records completion, a running latency average and which model did the work
  done(id: string, status: AgentStatus, action: string, ms: number, extra: { provider?: string | null; model?: string | null; tokens?: number } = {}) {
    const a = this.m.get(id);
    if (!a) return;
    a.runs++;
    a.avgMs = Math.round(a.avgMs + (ms - a.avgMs) / Math.min(a.runs, 50));
    a.status = status;
    a.lastAction = action;
    a.lastAt = Date.now();
    if (status === "error") a.errors++;
    if (extra.provider !== undefined) a.provider = extra.provider;
    if (extra.model !== undefined) a.model = extra.model;
    if (extra.tokens) a.tokens += extra.tokens;
  }

  // marks an agent as switched off (e.g. deep research disabled)
  set(id: string, status: AgentStatus, action: string) {
    const a = this.m.get(id);
    if (!a) return;
    a.status = status;
    a.lastAction = action;
  }

  // snapshot for the org chart
  list(): AgentView[] {
    return [...this.m.values()].map((a) => ({ ...a }));
  }
}

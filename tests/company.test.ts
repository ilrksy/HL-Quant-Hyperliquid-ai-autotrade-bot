import { describe, expect, it } from "vitest";
import { AiGateway } from "../server/ai/gateway";
import { Bus } from "../server/bus";
import { Company } from "../server/company/company";
import { Intel } from "../server/intel";
import type { MarketData, MarketInfo } from "../server/market";
import { PaperBroker } from "../server/paper";
import { SettingsStore } from "../server/settings";
import { Store } from "../server/store";
import type { Candle } from "../core/types";

// strongly trending synthetic bars that end at the last closed bar boundary
function trend(n: number, intervalMs: number, drift: number, start = 100): Candle[] {
  const end = Math.floor(Date.now() / intervalMs) * intervalMs - intervalMs;
  let p = start;
  return Array.from({ length: n }, (_, i) => {
    const o = p;
    p = p * (1 + drift + (i % 3 === 0 ? -drift * 0.4 : 0));
    return { t: end - (n - 1 - i) * intervalMs, o, h: Math.max(o, p) * 1.002, l: Math.min(o, p) * 0.998, c: p, v: 1000 };
  });
}

// fake exchange: one coin trending up on both timeframes
function fakeMarket(drift = 0.002): MarketData & { price: number } {
  const ltf = trend(400, 300_000, drift);
  const htf = trend(250, 3_600_000, drift * 3);
  const price = ltf[ltf.length - 1].c;
  const info: MarketInfo = {
    index: 0, name: "TEST", szDecimals: 3, maxLeverage: 20, funding: 0.00001, markPx: price, midPx: price, oraclePx: price,
    premium: 0, oiUsd: 5e7, volumeUsd: 1e9, prevDayPx: price * 0.97, change24h: 3, spreadBps: 1,
  };
  return {
    price,
    snapshot: async () => new Map([["TEST", info]]),
    mids: async () => ({ TEST: price }),
    candles: async (_c, interval) => (interval === "1h" ? htf : ltf),
    book: async () => ({ imbalance: 0.1, spreadBps: 1 }),
    crossFunding: async () => new Map(),
  };
}

// scripted openai-compatible endpoint keyed by the role found in the system prompt
function fakeAi(replies: Record<string, unknown>, failAll = false) {
  return (async (_url: string, init?: RequestInit) => {
    if (failAll) return new Response("down", { status: 503 });
    const body = JSON.parse(String(init?.body));
    const sys = String(body.messages[0].content);
    const role = /Research Manager/.test(sys) ? "research" : /the Boss/.test(sys) ? "boss" : /CEO/.test(sys) ? "ceo" : "auditor";
    const content = JSON.stringify(replies[role] ?? {});
    return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 50, completion_tokens: 20 } }), { status: 200 });
  }) as unknown as typeof fetch;
}

// company wired to fakes, armed, with permissive thresholds so the synthetic trend becomes a candidate
function setup(fetchImpl: typeof fetch, market = fakeMarket()) {
  const store = new Store(":memory:");
  const bus = new Bus(store);
  const settings = new SettingsStore(store);
  settings.update({
    bot: { coins: ["TEST"], interval: "5m" }, strategy: { entryThreshold: 0.1, adxChop: 0, minAtrPct: 0 },
    risk: { maxCostR: 5, maxDrawdownPct: 0.5, dailyLossLimitPct: 0.5 }, ai: { minConfidence: 0.5 },
  });
  const ai = new AiGateway(store, bus, { fetch: fetchImpl });
  ai.registry.add("custom", { name: "Fake", baseUrl: "http://fake.test/v1", models: ["fake-1"] });
  const intel = new Intel(bus, (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch);
  settings.update({ intel: { news: false, sentiment: false, macro: false, crossFunding: false } });
  const broker = new PaperBroker(1000, "");
  const company = new Company({ broker, store, bus, settings, ai, intel, market });
  company.arm();
  return { store, company, broker, market, settings };
}

describe("company pipeline", () => {
  it("runs scout → quant → research → risk → boss → audit → execute and opens a protected position", async () => {
    const { company, broker, store } = setup(fakeAi({
      research: { items: [{ id: 1, decision: "long", confidence: 0.82, thesis: "trend aligned", risk: "none" }] },
      boss: { decisions: [{ id: 1, approve: true, size: 1, note: "clean setup" }], directive: "normal", note: "ok" },
      ceo: { regime: "risk-on", riskMultiplier: 1, focus: ["TEST"], avoid: [], bias: { TEST: "long" }, summary: "trend" },
      auditor: { grade: "B", issues: [], recommendation: "continue", summary: "fine" },
    }));
    await company.cycle();
    const snap = await broker.snapshot();
    expect(snap.positions).toHaveLength(1);
    const pos = snap.positions[0];
    expect(pos.side).toBe("long");
    expect(pos.stopPx).toBeLessThan(pos.entryPx);
    expect(pos.takePx).toBeGreaterThan(pos.entryPx);
    const d = store.decisions()[0];
    expect(d.outcome).toBe("executed");
    expect(d.research?.source).toContain("Fake");
    expect(d.boss?.source).toContain("Fake");
    expect(d.audit?.ok).toBe(true);
    expect(company.state().pipeline.funnel).toMatchObject({ candidates: 1, researched: 1, passedRisk: 1, approved: 1, passedAudit: 1, executed: 1 });
    expect(store.events({ cat: "trade" })[0].msg).toMatch(/^OPEN LONG TEST/);
  });

  it("does not trade when the boss rejects", async () => {
    const { company, broker, store } = setup(fakeAi({
      research: { items: [{ id: 1, decision: "long", confidence: 0.9, thesis: "x", risk: "y" }] },
      boss: { decisions: [{ id: 1, approve: false, size: 1, note: "too extended" }], directive: "cautious", note: "be careful" },
      ceo: { regime: "neutral", riskMultiplier: 0.5, focus: [], avoid: [], bias: {}, summary: "meh" },
    }));
    await company.cycle();
    expect((await broker.snapshot()).positions).toHaveLength(0);
    expect(store.decisions()[0]).toMatchObject({ outcome: "rejected", stage: "boss" });
    expect(company.state().directive?.mode).toBe("cautious");
  });

  it("ignores an ai opinion that flips the quant direction", async () => {
    const { company, broker, store } = setup(fakeAi({
      research: { items: [{ id: 1, decision: "short", confidence: 0.95, thesis: "contrarian", risk: "" }] },
      ceo: { regime: "neutral", riskMultiplier: 1, focus: [], avoid: [], bias: {}, summary: "" },
    }));
    await company.cycle();
    expect((await broker.snapshot()).positions).toHaveLength(0);
    expect(store.decisions()[0].research?.thesis).toMatch(/contradicts quant/);
  });

  it("falls back to the rules engine when every ai provider is down", async () => {
    const { company, broker, store } = setup(fakeAi({}, true));
    await company.cycle();
    const d = store.decisions()[0];
    expect(d.research?.source).toBe("rules");
    expect(d.boss?.source ?? "rules").toBe("rules");
    expect((await broker.snapshot()).positions.length).toBe(d.outcome === "executed" ? 1 : 0);
    expect(store.events({ cat: "ai", level: "warn" }).length).toBeGreaterThan(0);
  });

  it("analyses but never executes while disarmed", async () => {
    const { company, broker } = setup(fakeAi({}));
    company.disarm("test");
    await company.cycle();
    expect((await broker.snapshot()).positions).toHaveLength(0);
    expect(company.state().pipeline.stages.find((s) => s.id === "research")?.metric).toBe("standby");
  });

  it("closes the position on a stop and books the trade with a loss cooldown", async () => {
    const market = fakeMarket();
    const { company, broker, store } = setup(fakeAi({
      research: { items: [{ id: 1, decision: "long", confidence: 0.8, thesis: "t", risk: "r" }] },
      boss: { decisions: [{ id: 1, approve: true, size: 1, note: "" }], directive: "normal", note: "" },
      ceo: { regime: "risk-on", riskMultiplier: 1, focus: [], avoid: [], bias: {}, summary: "" },
    }), market);
    await company.cycle();
    const pos = (await broker.snapshot()).positions[0];
    expect(pos).toBeDefined();
    market.mids = async () => ({ TEST: pos.stopPx! * 0.99 });
    await company.cycle();
    expect((await broker.snapshot()).positions).toHaveLength(0);
    const t = store.trades({ mode: "paper" });
    expect(t).toHaveLength(1);
    expect(t[0].source).toBe("bot");
    expect(t[0].pnl).toBeLessThan(0);
    expect(store.events({ cat: "trade" })[0].msg).toMatch(/^CLOSE LONG TEST/);
  });

  it("kill switch flattens bot positions and disarms", async () => {
    const { company, broker } = setup(fakeAi({
      research: { items: [{ id: 1, decision: "long", confidence: 0.8, thesis: "t", risk: "r" }] },
      boss: { decisions: [{ id: 1, approve: true, size: 1, note: "" }], directive: "normal", note: "" },
      ceo: { regime: "risk-on", riskMultiplier: 1, focus: [], avoid: [], bias: {}, summary: "" },
    }));
    await company.cycle();
    expect((await broker.snapshot()).positions).toHaveLength(1);
    await company.kill("test");
    expect((await broker.snapshot()).positions).toHaveLength(0);
    expect(company.state().bot.armed).toBe(false);
  });
});

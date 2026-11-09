import { describe, expect, it } from "vitest";
import { leverageFor } from "../core/leverage";
import { validateBoss, validateCeo, validateResearch } from "../server/ai/prompts";
import { headlineScore, parseRss } from "../server/intel";
import { portfolioStats, toCsv } from "../server/portfolio";
import { defaultSettings, MASK, sanitize, SettingsStore } from "../server/settings";
import { Store } from "../server/store";
import type { TradeView } from "../shared/types";

describe("settings", () => {
  it("clamps dangerous values and keeps types", () => {
    const s = sanitize({ risk: { riskPerTradePct: 5, maxLeverage: 500 }, bot: { cycleSec: 1, interval: "1d" }, telegram: { chatIds: ["123456", "x", "-100200300"] } });
    expect(s.risk.riskPerTradePct).toBe(0.1);
    expect(s.risk.maxLeverage).toBe(50);
    expect(s.bot.cycleSec).toBe(5);
    expect(s.bot.interval).toBe(defaultSettings().bot.interval);
    expect(s.telegram.chatIds).toEqual(["123456", "-100200300"]);
  });

  it("persists, masks secrets and ignores the mask on update", () => {
    const store = new Store(":memory:");
    const st = new SettingsStore(store);
    st.update({ telegram: { token: "123:secret" } });
    expect(st.masked().telegram.token).toBe(MASK);
    st.update({ telegram: { token: MASK, enabled: true } });
    expect(st.get().telegram.token).toBe("123:secret");
    expect(new SettingsStore(store).get().telegram.enabled).toBe(true);
  });
});

describe("model output validators", () => {
  it("research keeps only well-formed items in range", () => {
    const v = validateResearch(2)({ items: [{ id: 1, decision: "LONG", confidence: 85, thesis: "t" }, { id: 7, decision: "long" }, { id: 2, decision: "maybe" }] });
    expect(v?.size).toBe(1);
    expect(v?.get(1)).toMatchObject({ decision: "long", confidence: 0.85 });
    expect(validateResearch(1)({ nope: true })).toBeNull();
  });
  it("boss clamps size and defaults directive", () => {
    const v = validateBoss(1)({ decisions: [{ id: 1, approve: "true", size: 9 }], directive: "yolo" });
    expect(v?.decisions.get(1)).toMatchObject({ approve: true, size: 1 });
    expect(v?.directive).toBe("normal");
  });
  it("ceo maps coin names to the universe and drops unknown coins", () => {
    const v = validateCeo(["BTC", "kPEPE"])({ regime: "risk-off", riskMultiplier: 0.1, focus: ["btc", "FAKE"], avoid: ["KPEPE"], bias: { btc: "short" }, summary: "s" });
    expect(v).toMatchObject({ regime: "risk-off", riskMultiplier: 0.25, focus: ["BTC"], avoid: ["kPEPE"], bias: { BTC: "short" } });
  });
});

describe("leverage officer", () => {
  it("targets volatility and respects every cap", () => {
    const calm = leverageFor(0.001, "15m", 40, { mode: "auto", fixed: 3, volTargetPct: 30, userCap: 10 });
    const wild = leverageFor(0.02, "15m", 40, { mode: "auto", fixed: 3, volTargetPct: 30, userCap: 10 });
    expect(calm.cap).toBe(10);
    expect(wild.cap).toBe(1);
    expect(leverageFor(0.001, "15m", 3, { mode: "fixed", fixed: 20, volTargetPct: 30, userCap: 10 }).cap).toBe(3);
    expect(leverageFor(0.001, "15m", 40, { mode: "auto", fixed: 3, volTargetPct: 30, userCap: 10, perCoinCap: 2 }).cap).toBe(2);
  });
});

describe("intel", () => {
  it("scores headlines and maps coin names", () => {
    expect(headlineScore("Bitcoin ETF inflows surge to record")).toBe(1);
    expect(headlineScore("Exchange hack drains $40M")).toBe(-1);
    const items = parseRss("<rss><item><title><![CDATA[Solana rallies as ETF approval nears]]></title><pubDate>Mon, 09 Nov 2026 13:52:46 +0000</pubDate></item></rss>", "X");
    expect(items[0]).toMatchObject({ coins: ["SOL"], score: 1, source: "X" });
  });
});

describe("portfolio", () => {
  const t = (pnl: number, i: number, coin = "BTC"): TradeView => ({
    id: String(i), mode: "paper", source: "bot", coin, side: "long", size: 1, entry: 1, exit: 1, pnl, fees: 0.01, r: pnl, leverage: 2,
    opened: i * 3_600_000, closed: i * 3_600_000 + 1_800_000, entryReason: "", exitReason: "",
  });
  it("computes win rate, profit factor, streaks and drawdown", () => {
    const s = portfolioStats([t(1, 1), t(-0.5, 2), t(-0.5, 3), t(2, 4, "ETH")], [{ t: 0, v: 10 }, { t: 1, v: 12 }, { t: 2, v: 9 }, { t: 3, v: 13 }], 10, { calls24h: 0, tokens24h: 0, fallbacks24h: 0, ruleDecisions24h: 0 });
    expect(s.winRate).toBe(0.5);
    expect(s.profitFactor).toBe(3);
    expect(s.longestLossStreak).toBe(2);
    expect(s.maxDrawdownPct).toBeCloseTo(25);
    expect(s.byCoin[0]).toMatchObject({ coin: "ETH", pnl: 2 });
    expect(s.avgHoldMin).toBe(30);
  });
  it("quotes csv cells safely", () => {
    expect(toCsv([{ a: 'x,"y"', b: 1 }])).toBe('a,b\n"x,""y""",1');
  });
});

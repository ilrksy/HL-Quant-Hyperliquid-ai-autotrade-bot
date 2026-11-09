import { describe, expect, it } from "vitest";
import { AiGateway } from "../server/ai/gateway";
import { Bus } from "../server/bus";
import { Company } from "../server/company/company";
import { Intel } from "../server/intel";
import type { MarketData } from "../server/market";
import { PaperBroker } from "../server/paper";
import { SettingsStore } from "../server/settings";
import { Store } from "../server/store";
import { Telegram } from "../server/telegram";

// telegram stub that records sendMessage calls
function setup() {
  const sent: { chat_id: string; text: string }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = url.split("/").pop();
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (method === "sendMessage") sent.push(body);
    return new Response(JSON.stringify({ ok: true, result: method === "getMe" ? { username: "hlq_bot" } : [] }), { status: 200 });
  }) as unknown as typeof fetch;
  const store = new Store(":memory:");
  const bus = new Bus(store);
  const settings = new SettingsStore(store);
  settings.update({ telegram: { token: "123:abc" } });
  const ai = new AiGateway(store, bus, { fetch: fetchImpl });
  const market: MarketData = {
    snapshot: async () => new Map(), mids: async () => ({}), candles: async () => [], book: async () => ({ imbalance: 0, spreadBps: 1 }),
    crossFunding: async () => new Map(),
  };
  const broker = new PaperBroker(10, "");
  const company = new Company({ broker, store, bus, settings, ai, intel: new Intel(bus, fetchImpl), market });
  const tg = new Telegram({ bus, settings, store, company, broker, ai, apiBase: "http://tg.test", fetch: fetchImpl });
  return { tg, sent, settings, company, bus };
}

// lets the rate-limited sender flush
const flush = () => new Promise((r) => setTimeout(r, 50));

describe("telegram", () => {
  it("rejects unknown chats and pairs with a valid code only", async () => {
    const { tg, sent, settings } = setup();
    await tg.handle("555", "/status");
    await flush();
    expect(sent[0].text).toMatch(/Not authorised/);
    await tg.handle("555", "/pair 000000");
    expect(settings.get().telegram.chatIds).toEqual([]);
    const { code } = tg.createPairCode();
    await tg.handle("555", `/pair ${code}`);
    expect(settings.get().telegram.chatIds).toEqual(["555"]);
  });

  it("controls the company from an authorised chat with confirmation for kill", async () => {
    const { tg, settings, company } = setup();
    settings.update({ telegram: { chatIds: ["42"] } });
    await tg.handle("42", "/arm");
    expect(company.state().bot.armed).toBe(true);
    await tg.handle("42", "/disarm");
    expect(company.state().bot.armed).toBe(false);
    await tg.handle("42", "/kill");
    expect(company.state().bot.halted).toBeNull();
    await tg.handle("42", "/kill confirm");
    expect(company.state().bot.halted).toMatch(/Telegram/);
  });

  it("notifies paired chats about trades but not about routine info", async () => {
    const { settings, sent, bus } = setup();
    settings.update({ telegram: { enabled: true, chatIds: ["42"] } });
    bus.log("info", "pipeline", "quant", "routine");
    bus.log("success", "trade", "trader", "OPEN LONG BTC", { data: { kind: "open" } });
    await flush();
    expect(sent.map((m) => m.text)).toEqual(["🟦 OPEN LONG BTC"]);
  });
});

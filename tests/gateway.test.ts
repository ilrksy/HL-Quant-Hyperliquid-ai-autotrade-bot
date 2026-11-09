import { describe, expect, it } from "vitest";
import { AiGateway } from "../server/ai/gateway";
import { extractJson, retryAfterMs } from "../server/ai/json";
import { Bus } from "../server/bus";
import { Store } from "../server/store";

// one scripted http reply for the fake provider
type Reply = { status: number; body: unknown; headers?: Record<string, string> } | "timeout";

// fake fetch that answers by base url and records every request
function fakeFetch(script: Record<string, Reply[]>) {
  const calls: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? null;
    calls.push({ url, auth, body: init?.body ? JSON.parse(String(init.body)) : {} });
    const host = new URL(url).host;
    const r = script[host]?.shift() ?? { status: 500, body: { error: "unscripted" } };
    if (r === "timeout") {
      return new Promise((_, rej) => init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    }
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status, headers: r.headers });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

// minimal chat completion body
const chat = (content: string) => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });

// fresh in-memory gateway with two custom providers
function setup(script: Record<string, Reply[]>) {
  const store = new Store(":memory:");
  const bus = new Bus(store);
  const f = fakeFetch(script);
  const ai = new AiGateway(store, bus, { fetch: f.impl });
  const a = ai.registry.add("custom", { name: "A", baseUrl: "http://a.test/v1", models: ["m-a"], keys: ["key-a1", "key-a2"] });
  const b = ai.registry.add("custom", { name: "B", baseUrl: "http://b.test/v1", models: ["m-b"] });
  return { store, ai, calls: f.calls, a, b };
}

// request used by most cases
const req = { role: "research" as const, system: "s", prompt: "p", deadlineMs: 20_000, validate: (j: unknown) => ((j as { ok?: boolean })?.ok ? j : null) };

describe("ai gateway", () => {
  it("rotates to the next key when one is rate limited, then succeeds", async () => {
    const { ai, calls, store } = setup({ "a.test": [{ status: 429, body: { error: { message: "quota" } }, headers: { "retry-after": "30" } }, { status: 200, body: chat('{"ok":true}') }] });
    const r = await ai.complete(req);
    expect(r.ok).toBe(true);
    expect(r.provider).toBe("custom");
    expect(r.depth).toBe(0);
    expect(calls.map((c) => c.auth)).toEqual(["Bearer key-a1", "Bearer key-a2"]);
    const key1 = ai.view()[0].keys.find((k) => k.label === "key 1")!;
    expect(key1.state).toBe("cooldown");
    expect(key1.cooldownUntil - Date.now()).toBeGreaterThan(25_000);
    expect(store.aiCalls().map((c) => c.status)).toEqual(["ok", "rate_limited"]);
  });

  it("falls back to the next provider on server errors and auth failures", async () => {
    const { ai, store } = setup({
      "a.test": [{ status: 401, body: { error: "Invalid API Key" } }, { status: 503, body: "overloaded" }],
      "b.test": [{ status: 200, body: chat('```json\n{"ok":true}\n```') }],
    });
    const r = await ai.complete(req);
    expect(r.ok).toBe(true);
    expect(r.providerName).toBe("B");
    expect(r.depth).toBe(1);
    expect(r.attempts.map((x) => x.status)).toEqual(["auth", "server", "ok"]);
    expect(ai.view()[0].keys[0].state).toBe("invalid");
    expect(new AiGateway(store, new Bus(store)).view()[0].keys[0].state).toBe("invalid");
  });

  it("treats unusable model output as a failure and tries the next provider", async () => {
    const { ai } = setup({ "a.test": [{ status: 200, body: chat("I think you should buy") }], "b.test": [{ status: 200, body: chat('{"ok":true}') }] });
    const r = await ai.complete(req);
    expect(r.ok).toBe(true);
    expect(r.attempts[0].status).toBe("bad_output");
  });

  it("opens a circuit after repeated failures and skips the provider", async () => {
    const { ai } = setup({ "a.test": [{ status: 500, body: "x" }, { status: 500, body: "x" }, { status: 500, body: "x" }], "b.test": Array(4).fill({ status: 200, body: chat('{"ok":true}') }) });
    for (let i = 0; i < 3; i++) await ai.complete(req);
    const r = await ai.complete(req);
    expect(r.attempts[0]).toMatchObject({ status: "skipped", error: "circuit open" });
    expect(ai.view()[0].health).toBe("down");
  });

  it("returns ok=false with a readable trail when every provider fails", async () => {
    const { ai } = setup({ "a.test": [{ status: 400, body: { error: { message: "bad model" } } }], "b.test": [{ status: 402, body: "Free limit reached. Retry after 40s" }] });
    const r = await ai.complete(req);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("bad model");
    expect(ai.view()[1].keys[0].state).toBe("cooldown");
  });

  it("gives a slow provider only part of the deadline so the fallback still runs", async () => {
    const { ai } = setup({ "a.test": ["timeout"], "b.test": [{ status: 200, body: chat('{"ok":true}') }] });
    ai.registry.update(ai.registry.list()[0].id, { removeKeys: ai.registry.list()[0].keys.slice(1).map((k) => k.id) });
    const t0 = Date.now();
    const r = await ai.complete({ ...req, deadlineMs: 9_000 });
    expect(r.ok).toBe(true);
    expect(r.providerName).toBe("B");
    expect(Date.now() - t0).toBeLessThan(8_000);
  }, 15_000);

  it("retries without json mode when a provider rejects response_format", async () => {
    const { ai, calls } = setup({ "a.test": [{ status: 400, body: { error: { message: "response_format is not supported" } } }, { status: 200, body: chat('{"ok":true}') }] });
    const r = await ai.complete(req);
    expect(r.ok).toBe(true);
    expect(calls[0].body.response_format).toBeDefined();
    expect(calls[1].body.response_format).toBeUndefined();
    expect(ai.registry.list()[0].jsonMode).toBe(false);
  });

  it("serves identical requests from cache inside the ttl", async () => {
    const { ai, calls } = setup({ "a.test": [{ status: 200, body: chat('{"ok":true}') }] });
    await ai.complete({ ...req, cacheTtlMs: 60_000 });
    const r = await ai.complete({ ...req, cacheTtlMs: 60_000 });
    expect(r.cached).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("never exposes secrets in the provider view", () => {
    const { ai } = setup({});
    ai.registry.update(ai.registry.list()[0].id, { addKeys: [{ key: "sk-live-0123456789abcdef" }] });
    const json = JSON.stringify(ai.view());
    expect(json).not.toContain("key-a1");
    expect(json).not.toContain("0123456789abcdef");
    expect(json).toContain("sk-l…cdef");
  });

  it("honours an explicit route over automatic ordering", async () => {
    const { ai, b } = setup({ "b.test": [{ status: 200, body: chat('{"ok":true}') }] });
    ai.registry.setRoute("research", [{ providerId: b.id, model: "m-b" }]);
    const r = await ai.complete(req);
    expect(r.providerName).toBe("B");
    expect(r.depth).toBe(0);
  });
});

describe("json helpers", () => {
  it("extracts json from fences and chatter", () => {
    expect(extractJson('Sure! {"a":{"b":[1,2]}} hope this helps')).toEqual({ a: { b: [1, 2] } });
    expect(extractJson("```json\n[1,2]\n```")).toEqual([1, 2]);
    expect(extractJson('{"s":"brace } inside"}')).toEqual({ s: "brace } inside" });
    expect(extractJson("nothing here")).toBeNull();
  });
  it("parses retry hints", () => {
    expect(retryAfterMs("12", "")).toBe(12_000);
    expect(retryAfterMs(null, '"retryDelay": "35s"')).toBe(35_000);
    expect(retryAfterMs(null, "Free limit reached. Retry after 21s, or upgrade")).toBe(21_000);
  });
});

import { randomBytes } from "node:crypto";
import type { AiRole, ChainLink } from "../../shared/types";
import type { Store } from "../store";
import { presetById } from "./presets";

// one api key inside a provider's pool
export interface KeyConfig {
  id: string;
  label: string;
  key: string;
  enabled: boolean;
  invalid?: string | null; // set when the provider rejected the key, cleared by a passing test
}

// one configured provider; several can share a preset (e.g. two Gemini projects)
export interface ProviderConfig {
  id: string;
  preset: string;
  name: string;
  kind: "openai" | "antigravity";
  baseUrl: string;
  enabled: boolean;
  keyRequired: boolean;
  keys: KeyConfig[];
  models: string[];
  rpm: number;
  timeoutSec: number;
  jsonMode: boolean;
  headers: Record<string, string>;
}

// explicit fallback chain for one role
export interface RouteConfig {
  role: AiRole;
  chain: ChainLink[];
}

// every role that can be routed
export const AI_ROLES: AiRole[] = ["boss", "ceo", "research", "auditor", "intel"];

// fields a client may change on a provider
export interface ProviderPatch {
  name?: string;
  enabled?: boolean;
  baseUrl?: string;
  models?: string[];
  rpm?: number;
  timeoutSec?: number;
  jsonMode?: boolean;
  headers?: Record<string, string>;
  addKeys?: { key: string; label?: string }[];
  removeKeys?: string[];
  keyEnabled?: Record<string, boolean>;
  keyLabels?: Record<string, string>;
}

// short random id for keys
const rid = () => randomBytes(4).toString("hex");
// trims user input and strips accidental "Bearer " prefixes
const cleanKey = (k: string) => k.trim().replace(/^Bearer\s+/i, "");

// persisted provider and routing configuration with crud helpers
export class AiRegistry {
  private providers: ProviderConfig[];
  private routes: RouteConfig[];
  private listeners: (() => void)[] = [];

  // loads saved configuration, repairing missing fields from older versions
  constructor(private store: Store) {
    this.providers = (store.kvGet<ProviderConfig[]>("ai.providers") ?? []).map((p) => ({
      ...p, headers: p.headers ?? {}, keys: p.keys ?? [], models: p.models ?? [], timeoutSec: p.timeoutSec ?? 30,
    }));
    this.routes = store.kvGet<RouteConfig[]>("ai.routes") ?? [];
  }

  // notifies the gateway so key runtime state for edited keys is reset
  onChange(fn: () => void) {
    this.listeners.push(fn);
  }

  // persists and fans out a change
  private save() {
    this.store.kvSet("ai.providers", this.providers);
    this.store.kvSet("ai.routes", this.routes);
    for (const fn of this.listeners) fn();
  }

  // providers in priority order
  list(): ProviderConfig[] {
    return this.providers;
  }

  // lookup by id
  get(id: string): ProviderConfig | undefined {
    return this.providers.find((p) => p.id === id);
  }

  // explicit routes as stored
  routeList(): RouteConfig[] {
    return AI_ROLES.map((role) => this.routes.find((r) => r.role === role) ?? { role, chain: [] });
  }

  // creates a provider from a preset with optional keys, appended at the lowest priority
  add(presetId: string, init: { name?: string; keys?: string[]; models?: string[]; baseUrl?: string } = {}): ProviderConfig {
    const preset = presetById(presetId);
    if (!preset) throw new Error(`unknown preset ${presetId}`);
    let id = preset.id;
    for (let i = 2; this.get(id); i++) id = `${preset.id}-${i}`;
    const p: ProviderConfig = {
      id, preset: preset.id, name: init.name?.trim() || preset.name, kind: preset.kind,
      baseUrl: (init.baseUrl ?? preset.baseUrl).trim(), enabled: true, keyRequired: preset.keyRequired,
      keys: (init.keys ?? []).map(cleanKey).filter(Boolean).map((key, i) => ({ id: rid(), label: `key ${i + 1}`, key, enabled: true })),
      models: init.models?.length ? init.models : [...preset.models], rpm: preset.rpm,
      timeoutSec: preset.kind === "antigravity" ? 360 : 30, jsonMode: preset.kind === "openai", headers: {},
    };
    if (preset.id === "openrouter") p.headers = { "X-Title": "HL Quant" };
    this.providers.push(p);
    this.save();
    return p;
  }

  // applies a validated patch, including key pool edits
  update(id: string, patch: ProviderPatch): ProviderConfig {
    const p = this.get(id);
    if (!p) throw new Error(`unknown provider ${id}`);
    if (typeof patch.name === "string" && patch.name.trim()) p.name = patch.name.trim().slice(0, 60);
    if (typeof patch.enabled === "boolean") p.enabled = patch.enabled;
    if (typeof patch.baseUrl === "string") p.baseUrl = patch.baseUrl.trim();
    if (Array.isArray(patch.models)) p.models = [...new Set(patch.models.map((m) => String(m).trim()).filter(Boolean))].slice(0, 30);
    if (patch.rpm !== undefined && Number.isFinite(Number(patch.rpm))) p.rpm = Math.max(1, Math.min(10_000, Math.round(Number(patch.rpm))));
    if (patch.timeoutSec !== undefined && Number.isFinite(Number(patch.timeoutSec)))
      p.timeoutSec = Math.max(5, Math.min(900, Math.round(Number(patch.timeoutSec))));
    if (typeof patch.jsonMode === "boolean") p.jsonMode = patch.jsonMode;
    if (patch.headers && typeof patch.headers === "object") p.headers = Object.fromEntries(
      Object.entries(patch.headers).filter(([k]) => /^[A-Za-z0-9-]{1,60}$/.test(k)).map(([k, v]) => [k, String(v).slice(0, 300)]));
    if (patch.removeKeys?.length) p.keys = p.keys.filter((k) => !patch.removeKeys!.includes(k.id));
    for (const k of p.keys) {
      if (patch.keyEnabled && typeof patch.keyEnabled[k.id] === "boolean") k.enabled = patch.keyEnabled[k.id];
      if (patch.keyLabels?.[k.id]) k.label = String(patch.keyLabels[k.id]).trim().slice(0, 40) || k.label;
    }
    for (const nk of patch.addKeys ?? []) {
      const key = cleanKey(String(nk.key ?? ""));
      if (!key || p.keys.some((k) => k.key === key)) continue;
      p.keys.push({ id: rid(), label: nk.label?.trim().slice(0, 40) || `key ${p.keys.length + 1}`, key, enabled: true });
    }
    this.save();
    return p;
  }

  // remembers a rejected key across restarts so it is not retried every cycle; null clears the flag
  markInvalid(providerId: string, keyId: string, reason: string | null) {
    const k = this.get(providerId)?.keys.find((x) => x.id === keyId);
    if (!k || (k.invalid ?? null) === reason) return;
    k.invalid = reason;
    this.store.kvSet("ai.providers", this.providers);
  }

  // deletes a provider and drops it from explicit routes
  remove(id: string) {
    this.providers = this.providers.filter((p) => p.id !== id);
    this.routes = this.routes.map((r) => ({ ...r, chain: r.chain.filter((l) => l.providerId !== id) }));
    this.save();
  }

  // moves a provider up or down in the automatic fallback order
  move(id: string, dir: -1 | 1) {
    const i = this.providers.findIndex((p) => p.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= this.providers.length) return;
    [this.providers[i], this.providers[j]] = [this.providers[j], this.providers[i]];
    this.save();
  }

  // replaces a role's explicit chain; an empty chain restores automatic ordering
  setRoute(role: AiRole, chain: ChainLink[]) {
    if (!AI_ROLES.includes(role)) throw new Error(`unknown role ${role}`);
    const clean = chain.filter((l) => this.get(l.providerId) && typeof l.model === "string" && l.model.trim())
      .map((l) => ({ providerId: l.providerId, model: l.model.trim() })).slice(0, 12);
    this.routes = [...this.routes.filter((r) => r.role !== role), { role, chain: clean }];
    this.save();
  }

  // the chain actually used for a role: explicit if set, otherwise every enabled provider in priority order
  chainFor(role: AiRole): ChainLink[] {
    const usable = (id: string) => {
      const p = this.get(id);
      return !!p && p.enabled && p.models.length > 0 && (!p.keyRequired || p.keys.some((k) => k.enabled));
    };
    const explicit = this.routes.find((r) => r.role === role)?.chain ?? [];
    if (explicit.length) return explicit.filter((l) => usable(l.providerId));
    const auto = this.providers
      .filter((p) => usable(p.id) && (role === "intel" || p.kind !== "antigravity"))
      .map((p) => ({ providerId: p.id, model: p.models[0] }));
    if (role === "intel") auto.sort((a, b) => Number(this.get(b.providerId)?.kind === "antigravity") - Number(this.get(a.providerId)?.kind === "antigravity"));
    return auto;
  }
}

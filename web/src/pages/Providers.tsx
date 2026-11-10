import { useCallback, useEffect, useState } from "react";
import type { AiCallView, AiMode, AiRole, ChainLink, PresetView, ProviderView, RouteView } from "../../../shared/types";
import { api, type AppState, type KeyTest } from "../api";
import { time, tokens, until } from "../fmt";
import { refreshNow } from "../live";
import { Field, HealthBadge, Icon, Modal, Panel, Seg, Stat, Toggle, toast, useAction } from "../ui";

// display names and purpose of each routable role
const ROLES: [AiRole, string, string][] = [
  ["boss", "Boss", "final trade approval and company directive"],
  ["research", "Research Manager", "confirms or skips quant candidates (batched, one call per cycle)"],
  ["ceo", "CEO", "market regime and risk budget every period"],
  ["auditor", "Auditor", "performance reviews"],
  ["intel", "Deep Research", "slow web research; Antigravity is preferred here"],
];

// badge colour per call status
const STATUS_CLS: Record<string, string> = { ok: "ok", cached: "info", rate_limited: "warn", auth: "bad", bad_request: "bad", server: "warn", timeout: "warn", network: "warn", bad_output: "warn" };

// ai providers, key pools, fallback routes and the call log
export function Providers({ s }: { s: AppState }) {
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [routes, setRoutes] = useState<RouteView[]>([]);
  const [calls, setCalls] = useState<AiCallView[]>([]);
  const [presets, setPresets] = useState<PresetView[]>([]);
  const [adding, setAdding] = useState(false);
  const { busy, run } = useAction();

  const load = useCallback(async () => {
    const [p, r, c] = await Promise.all([api.providers(), api.routes(), api.aiCalls({ limit: 80 })]);
    setProviders(p);
    setRoutes(r);
    setCalls(c);
  }, []);
  useEffect(() => {
    void load().catch((e) => toast((e as Error).message, false));
    void api.presets().then(setPresets).catch(() => undefined);
    const id = setInterval(() => void load().catch(() => undefined), 5000);
    return () => clearInterval(id);
  }, [load]);

  const setMode = (mode: AiMode) => run("mode", () => api.saveSettings({ ai: { mode } }), `AI mode: ${mode}`).then(refreshNow);
  const ok = calls.filter((c) => c.status === "ok").length;

  return (
    <div className="page">
      <div className="page-h">
        <h1>AI providers</h1>
        <span className="muted small">Multiple keys per provider rotate automatically; failing keys cool down and the next provider in the chain takes over. If every model fails, the deterministic rules engine decides.</span>
        <button className="btn primary right" onClick={() => setAdding(true)}><Icon name="plus" />Add provider</button>
      </div>

      <div className="grid g4">
        <Panel title="AI authority">
          <div className="col">
            <Seg full value={s.ai.mode} onChange={setMode} disabled={busy === "mode"} options={[["off", "Off"], ["advisory", "Advisory"], ["control", "Control"]]} />
            <div className="dim small">{s.ai.mode === "control" ? "Models make research, boss, CEO and audit decisions inside hard risk limits." : s.ai.mode === "advisory" ? "Rules decide; model opinions are logged for comparison." : "No model calls. The rules engine runs every role (zero token cost)."}</div>
          </div>
        </Panel>
        <Stat k="Calls 24h" v={s.ai.calls24h} s={`${s.ai.failures24h} failed or rate-limited`} />
        <Stat k="Tokens 24h" v={tokens(s.ai.tokens24h)} s="input + output" />
        <Stat k="Recent success" v={calls.length ? `${Math.round((ok / calls.length) * 100)}%` : "—"} s={`last ${calls.length} calls`} tone={calls.length && ok / calls.length < 0.6 ? "down" : "up"} />
      </div>

      {!providers.length && (
        <div className="msg warn">No providers yet. Add Gemini, Groq, OpenRouter or any OpenAI-compatible endpoint. To try the system without keys, add “Pollinations (no key)” or “OVHcloud AI Endpoints”; both are rate-limited per IP.</div>
      )}

      {providers.map((p, i) => (
        <ProviderCard key={p.id} p={p} first={i === 0} last={i === providers.length - 1} reload={load} />
      ))}

      <RoutesPanel routes={routes} providers={providers} reload={load} />

      <Panel title="AI call log" flush actions={<a className="small" href="#/history">all calls in History</a>}>
        <div className="scroll" style={{ maxHeight: 420 }}>
          <table>
            <thead><tr><th>Time</th><th className="l">Role</th><th className="l">Provider · key</th><th className="l">Model</th><th className="l">Status</th><th>Latency</th><th>Fallback</th><th>Tokens</th><th className="l">Error</th></tr></thead>
            <tbody>
              {calls.map((c) => (
                <tr key={c.id}>
                  <td className="muted">{time(c.ts)}</td><td className="l">{c.role}</td><td className="l">{c.provider} <span className="dim">· {c.keyLabel}</span></td>
                  <td className="l muted ellipsis" style={{ maxWidth: 180 }}>{c.model}</td>
                  <td className="l"><span className={`badge ${STATUS_CLS[c.status] ?? "mut"}`}>{c.status}{c.http ? ` ${c.http}` : ""}</span></td>
                  <td>{c.latency} ms</td><td className={c.depth ? "warn-t" : "dim"}>{c.depth ? `#${c.depth}` : "primary"}</td>
                  <td className="muted">{c.tokIn + c.tokOut || ""}</td><td className="l wrap small down">{c.error}</td>
                </tr>
              ))}
              {!calls.length && <tr><td colSpan={9} className="empty">No calls yet</td></tr>}
            </tbody>
          </table>
        </div>
      </Panel>

      {adding && <AddProvider presets={presets} onClose={() => setAdding(false)} onAdded={() => { setAdding(false); void load(); refreshNow(); }} />}
    </div>
  );
}

// one provider: settings, key pool, test and ordering
function ProviderCard({ p, first, last, reload }: { p: ProviderView; first: boolean; last: boolean; reload: () => Promise<void> }) {
  const { busy, run } = useAction();
  const [newKeys, setNewKeys] = useState("");
  const [models, setModels] = useState(p.models.join(", "));
  const [available, setAvailable] = useState<string[] | null>(null);
  const [tests, setTests] = useState<KeyTest[] | null>(null);
  const [baseUrl, setBaseUrl] = useState(p.baseUrl);
  useEffect(() => { setModels(p.models.join(", ")); setBaseUrl(p.baseUrl); }, [p.models, p.baseUrl]);
  const patch = (body: Record<string, unknown>, msg?: string) => run("patch", () => api.updateProvider(p.id, body), msg).then(reload);
  const modelList = models.split(/[,\n]/).map((m) => m.trim()).filter(Boolean);
  const dirty = modelList.join("|") !== p.models.join("|") || baseUrl !== p.baseUrl;

  return (
    <Panel title={<span className="row" style={{ textTransform: "none", letterSpacing: 0, fontSize: 13, color: "var(--text)" }}>{p.name} <HealthBadge h={p.health} />{p.kind === "antigravity" && <span className="badge acc">agent</span>}</span>}
      actions={<>
        <span className="dim small mono">{p.calls24h ? `${p.ok24h}/${p.calls24h} ok · ${p.avgMs} ms avg · ${tokens(p.tokens24h)} tok` : "no calls 24h"}</span>
        {p.circuitOpenUntil > Date.now() && <span className="badge warn">circuit open {until(p.circuitOpenUntil)}</span>}
        <button className="btn ghost icon-btn" disabled={first} title="Higher priority" onClick={() => run("mv", () => api.moveProvider(p.id, -1)).then(reload)}><Icon name="up" /></button>
        <button className="btn ghost icon-btn" disabled={last} title="Lower priority" onClick={() => run("mv", () => api.moveProvider(p.id, 1)).then(reload)}><Icon name="down" /></button>
        <Toggle on={p.enabled} label="Enabled" onChange={(v) => patch({ enabled: v }, v ? `${p.name} enabled` : `${p.name} disabled`)} />
      </>}>
      <div className="col gap-12">
        <div className="fields">
          <Field label="Base URL" className="span2"><input className="input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} /></Field>
          <Field label="Models (first = default)" className="span2" hint={available ? undefined : "Comma separated. Use Fetch models to see what this key can use."}>
            <input className="input" value={models} onChange={(e) => setModels(e.target.value)} />
          </Field>
          <Field label="Requests / min / key"><input className="input" type="number" defaultValue={p.rpm} onBlur={(e) => Number(e.target.value) !== p.rpm && patch({ rpm: Number(e.target.value) })} /></Field>
          <Field label="Timeout (s)"><input className="input" type="number" defaultValue={p.timeoutSec} onBlur={(e) => Number(e.target.value) !== p.timeoutSec && patch({ timeoutSec: Number(e.target.value) })} /></Field>
          <Field label="JSON mode"><div style={{ height: 30, display: "flex", alignItems: "center" }}><Toggle on={p.jsonMode} onChange={(v) => patch({ jsonMode: v })} /></div></Field>
        </div>
        {available && (
          <div className="row wrap gap-4">
            <span className="small muted">Available ({available.length}):</span>
            {available.slice(0, 60).map((m) => (
              <button key={m} className={`btn sm ${modelList.includes(m) ? "primary" : ""}`} onClick={() => setModels((modelList.includes(m) ? modelList.filter((x) => x !== m) : [...modelList, m]).join(", "))}>{m}</button>
            ))}
          </div>
        )}
        <div className="row wrap">
          <button className="btn sm primary" disabled={!dirty || !!busy} onClick={() => patch({ models: modelList, baseUrl }, "Saved")}>Save</button>
          <button className="btn sm" disabled={!!busy} onClick={() => run("models", () => api.models(p.id)).then((m) => m && setAvailable(m))}><Icon name="download" size={12} />Fetch models</button>
          <button className="btn sm" disabled={!!busy} onClick={() => run("test", () => api.testProvider(p.id)).then((t) => { if (t) setTests(t); void reload(); })}><Icon name="check" size={12} />{busy === "test" ? "Testing…" : "Test keys"}</button>
          <button className="btn sm" disabled={!!busy} onClick={() => run("reset", () => api.resetProvider(p.id), "Cooldowns and breaker cleared").then(reload)}><Icon name="refresh" size={12} />Reset</button>
          <button className="btn sm danger right" disabled={!!busy} onClick={() => confirm(`Remove ${p.name} and its keys?`) && run("rm", () => api.removeProvider(p.id), "Provider removed").then(reload)}><Icon name="trash" size={12} />Remove</button>
        </div>
        <div className="scroll">
          <table>
            <thead><tr><th>Key</th><th className="l">Secret</th><th className="l">State</th><th>Calls 24h</th><th>OK</th><th>429</th><th>Avg</th><th className="l">Last error</th><th>On</th><th /></tr></thead>
            <tbody>
              {p.keys.map((k) => {
                const t = tests?.find((x) => x.keyId === k.id);
                return (
                  <tr key={k.id}>
                    <td style={{ fontFamily: "var(--sans)" }}>{k.label}</td><td className="l muted">{k.masked}</td>
                    <td className="l"><span className={`badge ${k.state === "ready" ? "ok" : k.state === "invalid" ? "bad" : k.state === "disabled" ? "mut" : "warn"}`}>{k.state}{k.state === "cooldown" ? ` ${until(k.cooldownUntil)}` : ""}</span>
                      {t && <span className={`small ${t.ok ? "up" : "down"}`}> test {t.ok ? `ok ${t.ms} ms` : t.status}</span>}</td>
                    <td>{k.calls24h}</td><td>{k.ok24h}</td><td className={k.rateLimited24h ? "warn-t" : ""}>{k.rateLimited24h}</td><td>{k.avgMs ? `${k.avgMs} ms` : "—"}</td>
                    <td className="l wrap small down">{t && !t.ok ? t.error : k.lastError}</td>
                    <td>{k.id !== "anon" && <Toggle on={k.enabled} onChange={(v) => patch({ keyEnabled: { [k.id]: v } })} />}</td>
                    <td>{k.id !== "anon" && <button className="btn ghost icon-btn" title="Remove key" onClick={() => confirm(`Remove ${k.label}?`) && patch({ removeKeys: [k.id] }, "Key removed")}><Icon name="trash" size={13} /></button>}</td>
                  </tr>
                );
              })}
              {!p.keys.length && <tr><td colSpan={10} className="empty">{p.keyRequired ? "Add at least one key" : "No key needed"}</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="row top">
          <textarea className="input grow" rows={2} placeholder="Add API keys, one per line (several keys of the same provider form a rotation pool)" value={newKeys} onChange={(e) => setNewKeys(e.target.value)} />
          <button className="btn" disabled={!newKeys.trim() || !!busy} onClick={() => patch({ addKeys: newKeys.split(/\s+/).filter(Boolean).map((key) => ({ key })) }, "Keys added").then(() => setNewKeys(""))}><Icon name="plus" />Add keys</button>
        </div>
      </div>
    </Panel>
  );
}

// fallback chain editor per role
function RoutesPanel({ routes, providers, reload }: { routes: RouteView[]; providers: ProviderView[]; reload: () => Promise<void> }) {
  const { run } = useAction();
  const [editing, setEditing] = useState<AiRole | null>(null);
  const [chain, setChain] = useState<ChainLink[]>([]);
  const name = (id: string) => providers.find((p) => p.id === id)?.name ?? id;
  const save = (role: AiRole, c: ChainLink[]) => run("route", () => api.setRoute(role, c), c.length ? "Route saved" : "Automatic order restored").then(() => { setEditing(null); void reload(); });
  return (
    <Panel title="Fallback routes" actions={<span className="dim small">Automatic order follows provider priority above. Override per role for cheaper or faster models.</span>}>
      <div className="col gap-12">
        {ROLES.map(([role, label, purpose]) => {
          const r = routes.find((x) => x.role === role);
          const isEdit = editing === role;
          const shown = isEdit ? chain : r?.effective ?? [];
          return (
            <div key={role} className="col gap-4" style={{ borderBottom: "1px solid var(--line)", paddingBottom: 10 }}>
              <div className="row wrap">
                <b>{label}</b><span className="dim small">{purpose}</span>
                <span className={`badge right ${r?.chain.length ? "acc" : "mut"}`}>{r?.chain.length ? "custom" : "automatic"}</span>
                {!isEdit && <button className="btn sm" onClick={() => { setEditing(role); setChain(r?.chain.length ? r.chain : r?.effective ?? []); }}>Edit</button>}
              </div>
              <div className="row wrap gap-4">
                {shown.map((l, i) => (
                  <span key={`${l.providerId}-${i}`} className="row gap-4" style={{ border: "1px solid var(--line-2)", borderRadius: 4, padding: "2px 4px 2px 8px" }}>
                    <span className="dim tiny">{i + 1}</span><span className="small">{name(l.providerId)}</span><span className="dim small mono">{l.model}</span>
                    {isEdit && <>
                      <button className="btn ghost icon-btn" disabled={i === 0} onClick={() => setChain((c) => { const n = [...c]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; return n; })}><Icon name="up" size={12} /></button>
                      <button className="btn ghost icon-btn" onClick={() => setChain((c) => c.filter((_, j) => j !== i))}><Icon name="x" size={12} /></button>
                    </>}
                    {!isEdit && i < shown.length - 1 && <Icon name="chevron" size={12} className="dim" />}
                  </span>
                ))}
                {!shown.length && <span className="small warn-t">No provider available: the rules engine will decide.</span>}
                <span className="small dim">→ rules engine</span>
              </div>
              {isEdit && (
                <div className="row wrap">
                  <select className="select" style={{ width: "auto", minWidth: 260 }} value="" onChange={(e) => { const [pid, ...m] = e.target.value.split("::"); if (pid) setChain((c) => [...c, { providerId: pid, model: m.join("::") }]); }}>
                    <option value="">+ add provider · model</option>
                    {providers.flatMap((p) => p.models.map((m) => <option key={`${p.id}::${m}`} value={`${p.id}::${m}`}>{p.name} · {m}</option>))}
                  </select>
                  <button className="btn sm primary" onClick={() => save(role, chain)}>Save</button>
                  <button className="btn sm" onClick={() => save(role, [])}>Use automatic</button>
                  <button className="btn sm ghost" onClick={() => setEditing(null)}>Cancel</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

// add-provider dialog with the preset catalogue
function AddProvider({ presets, onClose, onAdded }: { presets: PresetView[]; onClose: () => void; onAdded: () => void }) {
  const [sel, setSel] = useState<PresetView | null>(null);
  const [keys, setKeys] = useState("");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [models, setModels] = useState("");
  const { busy, run } = useAction();
  const pick = (p: PresetView) => { setSel(p); setName(p.name); setBaseUrl(p.baseUrl); setModels(p.models.join(", ")); };
  const submit = () => sel && run("add", () => api.addProvider({
    preset: sel.id, name, baseUrl, keys: keys.split(/\s+/).filter(Boolean), models: models.split(/[,\n]/).map((m) => m.trim()).filter(Boolean),
  }), `${name} added`).then((r) => r && onAdded());
  return (
    <Modal title={sel ? `Add ${sel.name}` : "Add AI provider"} onClose={onClose}
      footer={sel && <><button className="btn ghost" onClick={() => setSel(null)}>Back</button><button className="btn primary" disabled={!!busy || (sel.keyRequired && !keys.trim()) || !baseUrl} onClick={submit}>{busy ? "Adding…" : "Add provider"}</button></>}>
      {!sel ? (
        <div className="col gap-4">
          {presets.map((p) => (
            <button key={p.id} className="btn" style={{ height: "auto", padding: "8px 10px", justifyContent: "flex-start", textAlign: "left", whiteSpace: "normal" }} onClick={() => pick(p)}>
              <div className="col gap-4" style={{ width: "100%" }}>
                <div className="row"><b>{p.name}</b>{!p.keyRequired && <span className="badge ok">no key</span>}{p.kind === "antigravity" && <span className="badge acc">agent</span>}<span className="dim small right">{p.pricing}</span></div>
                {p.notes && <span className="dim small">{p.notes}</span>}
              </div>
            </button>
          ))}
        </div>
      ) : (
        <>
          {sel.signupUrl && <div className="small muted">Get keys at <a href={sel.signupUrl} target="_blank" rel="noreferrer">{sel.signupUrl}</a>. {sel.notes}</div>}
          <Field label="Display name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Base URL"><input className="input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} /></Field>
          <Field label="Models (comma separated, first is the default)"><input className="input" value={models} onChange={(e) => setModels(e.target.value)} /></Field>
          <Field label={sel.keyRequired ? "API keys (one per line; several keys rotate)" : "API keys (optional)"}>
            <textarea className="input" rows={3} value={keys} onChange={(e) => setKeys(e.target.value)} placeholder={sel.keyRequired ? "paste key(s)" : "leave empty to use the keyless tier"} />
          </Field>
        </>
      )}
    </Modal>
  );
}

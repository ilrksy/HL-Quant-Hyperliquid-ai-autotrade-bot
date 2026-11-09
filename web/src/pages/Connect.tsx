import { useState } from "react";
import { type Conn, normalizeUrl, probe, suggestedUrl } from "../api";
import { Field, Logo } from "../ui";

// first screen on any device: point the client at the self-hosted server with its api token
export function Connect({ onConnected }: { onConnected: (c: Conn) => void }) {
  const [url, setUrl] = useState(suggestedUrl);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const desktop = window.hlqDesktop;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const c = { url: normalizeUrl(url), token: token.trim() };
    try {
      await probe(c);
      onConnected(c);
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="connect">
      <form className="card" onSubmit={submit}>
        <div className="row gap-12"><Logo size={34} /><div><div style={{ fontWeight: 700, fontSize: 16 }}>HL Quant</div><div className="muted small">Connect to your self-hosted server</div></div></div>
        <Field label="Server URL" hint="LAN address (http://192.168.x.x:8787), Tailscale name or HTTPS tunnel">
          <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://192.168.1.20:8787" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        </Field>
        <Field label="API token" hint="Printed in the server console on first start and stored in data/server.json">
          <input className="input" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="paste token" autoComplete="off" />
        </Field>
        {err && <div className="msg err">{err}</div>}
        <button className="btn primary block" style={{ height: 36 }} disabled={busy || !url.trim() || !token.trim()}>{busy ? "Checking…" : "Connect"}</button>
        <div className="dim tiny" style={{ lineHeight: 1.5 }}>
          Every device (browser, desktop app, Android app) uses this same URL and token. The token stays on this device.
          {desktop && !desktop.hostMode && <> On this computer you can also enable <b>Host mode</b> from the tray icon to run the server locally.</>}
        </div>
      </form>
    </div>
  );
}

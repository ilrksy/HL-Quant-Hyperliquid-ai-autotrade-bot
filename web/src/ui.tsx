import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import type { AgentStatus } from "../../shared/types";

// minimal flat icon set drawn on a 16px grid, stroke only, so no icon font or emoji is needed
const PATHS: Record<string, string> = {
  trade: "M3 13V7M3 7V3M6 11V5M9 14V8M9 8V2M12 12V6M3 7h0M2 7h2M5 5h2M8 8h2M11 6h2",
  company: "M8 2v3M3 9V7h10v2M3 9v0M2 9h2v3H2zM7 9h2v3H7zM12 9h2v3h-2zM6 2h4v3H6z",
  ai: "M5 5h6v6H5zM7 2v3M9 2v3M7 11v3M9 11v3M2 7h3M2 9h3M11 7h3M11 9h3",
  history: "M3 4h10M3 8h10M3 12h6M12 11v3M10.5 12.5h3",
  portfolio: "M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2.5 14c.6-2.6 2.8-4 5.5-4s4.9 1.4 5.5 4",
  settings: "M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4",
  power: "M8 2v6M4.5 4.5a5 5 0 1 0 7 0",
  stop: "M4 4h8v8H4z",
  bolt: "M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z",
  plus: "M8 3v10M3 8h10",
  trash: "M3 4h10M6 4V2.5h4V4M4.5 4l.7 9.5h5.6l.7-9.5",
  up: "M8 12V4M4.5 7.5 8 4l3.5 3.5",
  down: "M8 4v8M4.5 8.5 8 12l3.5-3.5",
  refresh: "M13 8a5 5 0 1 1-1.5-3.5M13 2.5V5h-2.5",
  copy: "M5.5 5.5h7v7h-7zM3.5 10.5v-7h7",
  check: "M3 8.5 6.5 12 13 4.5",
  x: "M4 4l8 8M12 4l-8 8",
  link: "M7 9a2.5 2.5 0 0 0 3.5 0l2-2a2.5 2.5 0 0 0-3.5-3.5L8.3 4.2M9 7a2.5 2.5 0 0 0-3.5 0l-2 2A2.5 2.5 0 0 0 7 12.5l.7-.7",
  send: "M14 2 2 7l5 2 2 5zM7 9l7-7",
  play: "M5 3.5v9l7-4.5z",
  chevron: "M6 4l4 4-4 4",
  search: "M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10zM14 14l-3.5-3.5",
  download: "M8 2v8M4.5 6.5 8 10l3.5-3.5M3 13h10",
  shield: "M8 1.5 13 3.5v4c0 3-2.2 5.6-5 6.5-2.8-.9-5-3.5-5-6.5v-4z",
  logout: "M6 3H3v10h3M10 5l3 3-3 3M13 8H6",
};

// stroke icon by name
export function Icon({ name, size = 16, className }: { name: keyof typeof PATHS | string; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d={PATHS[name] ?? ""} />
    </svg>
  );
}

// brand mark used in the top bar and connect screen
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="#0f1a1f" />
      <path d="M8 22V10M8 16h8M16 10v12M20 10v12h5" stroke="#50d2c1" strokeWidth="2.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// bordered card with an optional header row
export function Panel({ title, hl, actions, children, className, bodyClass, flush }: {
  title?: ReactNode; hl?: boolean; actions?: ReactNode; children: ReactNode; className?: string; bodyClass?: string; flush?: boolean;
}) {
  return (
    <section className={`panel ${className ?? ""}`}>
      {(title || actions) && (
        <div className="panel-h">
          {title && <span className={`t ${hl ? "hl" : ""}`}>{title}</span>}
          {actions && <div className="row right wrap">{actions}</div>}
        </div>
      )}
      {flush ? children : <div className={`panel-b ${bodyClass ?? ""}`}>{children}</div>}
    </section>
  );
}

// headline number tile
export function Stat({ k, v, s, tone }: { k: ReactNode; v: ReactNode; s?: ReactNode; tone?: string }) {
  return (
    <div className="stat">
      <span className="k">{k}</span>
      <span className={`v ${tone ?? ""}`}>{v}</span>
      {s !== undefined && <span className="s">{s}</span>}
    </div>
  );
}

// on/off switch
export function Toggle({ on, onChange, disabled, label }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={`toggle ${on ? "on" : ""}`} disabled={disabled} onClick={() => onChange(!on)} />;
}

// labelled form control wrapper
export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={`field ${className ?? ""}`}>
      <span>{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

// segmented control for small enums
export function Seg<T extends string>({ value, options, onChange, full, disabled }: {
  value: T; options: (T | [T, ReactNode])[]; onChange: (v: T) => void; full?: boolean; disabled?: boolean;
}) {
  return (
    <div className={`seg ${full ? "full" : ""}`}>
      {options.map((o) => {
        const [v, label] = Array.isArray(o) ? o : [o, o];
        return <button key={v} type="button" disabled={disabled} className={v === value ? "on" : ""} onClick={() => onChange(v)}>{label}</button>;
      })}
    </div>
  );
}

// tab strip with optional counters
export function Tabs<T extends string>({ value, tabs, onChange }: { value: T; tabs: (T | [T, ReactNode, number?])[]; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => {
        const [v, label, count] = Array.isArray(t) ? t : [t, t, undefined];
        return (
          <button key={v} role="tab" aria-selected={v === value} className={v === value ? "on" : ""} onClick={() => onChange(v)}>
            {label}{count ? <span className="count">{count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

// status dot matching agent and stage states
export const Dot = ({ s, title }: { s: AgentStatus | "ok" | "error" | "warn" | "idle"; title?: string }) => <span className={`dot ${s}`} title={title} />;

// health badge for ai providers
export function HealthBadge({ h }: { h: string }) {
  const cls = h === "healthy" ? "ok" : h === "degraded" ? "warn" : h === "disabled" ? "mut" : "bad";
  return <span className={`badge ${cls}`}>{h}</span>;
}

// centered overlay dialog
export function Modal({ title, onClose, children, footer }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="panel-h"><span className="t hl">{title}</span><button className="btn ghost icon-btn right" onClick={onClose} aria-label="Close"><Icon name="x" /></button></div>
        <div className="panel-b col gap-12">{children}</div>
        {footer && <div className="panel-b row" style={{ borderTop: "1px solid var(--line)", justifyContent: "flex-end" }}>{footer}</div>}
      </div>
    </div>
  );
}

// toast store kept outside react so any module can notify
type Toast = { id: number; ok: boolean; text: string };
let toasts: Toast[] = [];
const toastSubs = new Set<() => void>();
let toastId = 0;

// shows a short confirmation or error message
export function toast(text: string, ok = true) {
  const t = { id: ++toastId, ok, text };
  toasts = [...toasts, t].slice(-4);
  toastSubs.forEach((f) => f());
  setTimeout(() => {
    toasts = toasts.filter((x) => x.id !== t.id);
    toastSubs.forEach((f) => f());
  }, ok ? 3500 : 7000);
}

// renders active toasts
export function Toasts() {
  const list = useSyncExternalStore((cb) => (toastSubs.add(cb), () => toastSubs.delete(cb)), () => toasts);
  return <div className="toast-wrap" aria-live="polite">{list.map((t) => <div key={t.id} className={`toast ${t.ok ? "ok" : "err"}`}>{t.text}</div>)}</div>;
}

// wraps an async action with busy state and error toasts
export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const run = async <T,>(key: string, fn: () => Promise<T>, okMsg?: string): Promise<T | undefined> => {
    setBusy(key);
    try {
      const r = await fn();
      if (okMsg) toast(okMsg);
      return r;
    } catch (e) {
      toast((e as Error).message, false);
      return undefined;
    } finally {
      setBusy(null);
    }
  };
  return { busy, run };
}

// -1..1 conviction bar
export function ScoreBar({ v }: { v: number }) {
  const w = Math.min(50, Math.abs(v) * 50);
  return <span className="score"><i style={{ left: v >= 0 ? "50%" : `${50 - w}%`, width: `${w}%`, background: v >= 0 ? "var(--up)" : "var(--down)" }} /></span>;
}

// copies text and confirms with a toast
export async function copy(text: string, what = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    toast(what);
  } catch {
    toast("Clipboard unavailable; select and copy manually", false);
  }
}

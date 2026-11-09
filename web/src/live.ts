import { useSyncExternalStore } from "react";
import { api, ApiError, type AppState, type EventView, streamUrl } from "./api";

// connection health shown in the top bar
export type LinkStatus = "connecting" | "live" | "polling" | "offline" | "unauthorized";

// everything the live store exposes
interface Snapshot {
  state: AppState | null;
  logs: EventView[];
  status: LinkStatus;
  lastUpdate: number;
}

let snap: Snapshot = { state: null, logs: [], status: "connecting", lastUpdate: 0 };
const subs = new Set<() => void>();
let es: EventSource | null = null;
let pollTimer: number | null = null;
let retryTimer: number | null = null;
let generation = 0;

// immutable update plus subscriber notification
function set(patch: Partial<Snapshot>) {
  snap = { ...snap, ...patch };
  for (const s of subs) s();
}

// one polling round, used while the event stream is unavailable
async function pollOnce(gen: number) {
  try {
    const state = await api.state();
    if (gen !== generation) return;
    set({ state, status: es && es.readyState === EventSource.OPEN ? "live" : "polling", lastUpdate: Date.now() });
  } catch (e) {
    if (gen !== generation) return;
    set({ status: e instanceof ApiError && e.status === 401 ? "unauthorized" : "offline" });
  }
}

// opens the server-sent event stream, falling back to polling and retrying the stream periodically
function openStream(gen: number) {
  const url = streamUrl();
  if (!url || typeof EventSource === "undefined") return;
  es?.close();
  es = new EventSource(url);
  es.addEventListener("state", (ev) => {
    if (gen !== generation) return;
    set({ state: JSON.parse((ev as MessageEvent).data), status: "live", lastUpdate: Date.now() });
  });
  es.addEventListener("log", (ev) => {
    if (gen !== generation) return;
    const e = JSON.parse((ev as MessageEvent).data) as EventView;
    set({ logs: [e, ...snap.logs].slice(0, 400) });
  });
  es.onerror = () => {
    if (gen !== generation) return;
    es?.close();
    es = null;
    void pollOnce(gen);
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = window.setTimeout(() => openStream(gen), 10_000);
  };
}

// (re)starts live updates for the current connection
export function startLive() {
  stopLive();
  const gen = ++generation;
  set({ state: null, logs: [], status: "connecting" });
  void pollOnce(gen);
  api.logs({ limit: 150 }).then((logs) => gen === generation && set({ logs })).catch(() => undefined);
  openStream(gen);
  pollTimer = window.setInterval(() => {
    if (!es || es.readyState !== EventSource.OPEN || Date.now() - snap.lastUpdate > 8000) void pollOnce(gen);
  }, 3000);
}

// stops every timer and the stream, e.g. on disconnect
export function stopLive() {
  generation++;
  es?.close();
  es = null;
  if (pollTimer) clearInterval(pollTimer);
  if (retryTimer) clearTimeout(retryTimer);
  pollTimer = retryTimer = null;
}

// pulls a fresh state right after a user action instead of waiting for the next push
export function refreshNow() {
  void pollOnce(generation);
}

// react hook over the live store
export function useLive(): Snapshot {
  return useSyncExternalStore((cb) => {
    subs.add(cb);
    return () => subs.delete(cb);
  }, () => snap);
}

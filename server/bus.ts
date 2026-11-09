import { EventEmitter } from "node:events";
import type { EventCat, EventLevel, EventView } from "../shared/types";
import type { Store } from "./store";

// optional context attached to a history entry
export interface LogExtra {
  coin?: string | null;
  cycle?: number | null;
  data?: unknown;
}

// single funnel for history: persists to sqlite, then fans out to sse clients and telegram
export class Bus extends EventEmitter {
  // listeners include every open dashboard stream, so the default cap of 10 is too low
  constructor(private store: Store) {
    super();
    this.setMaxListeners(200);
  }

  // debug lines are streamed live but not stored, everything else becomes permanent history
  log(level: EventLevel, cat: EventCat, agent: string, msg: string, extra: LogExtra = {}): EventView {
    const base = { ts: Date.now(), level, cat, agent, coin: extra.coin ?? null, cycle: extra.cycle ?? null, msg, data: extra.data };
    const ev = level === "debug" ? { ...base, id: 0 } : this.store.addEvent(base);
    this.emit("event", ev);
    if (level === "warn" || level === "error") console.log(`[${level}] ${agent}: ${msg}`);
    return ev;
  }
}

// pulls the first json object or array out of model text, tolerating code fences and chatter
export function extractJson(text: string): unknown {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(body);
  } catch {
    // fall through to bracket scanning
  }
  for (const [open, close] of [["{", "}"], ["[", "]"]] as const) {
    const start = body.indexOf(open);
    if (start < 0) continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < body.length; i++) {
      const ch = body[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close && --depth === 0) {
        try {
          return JSON.parse(body.slice(start, i + 1));
        } catch {
          break;
        }
      }
    }
  }
  return null;
}

// readable one-line error from a provider error body
export function shortError(body: string): string {
  try {
    const j = JSON.parse(body);
    const m = j?.error?.message ?? j?.message ?? j?.error ?? j?.detail;
    if (m) return String(typeof m === "string" ? m : JSON.stringify(m)).slice(0, 240);
  } catch {
    // not json
  }
  return body.replace(/\s+/g, " ").trim().slice(0, 240) || "empty response";
}

// retry hint from a 429, from the header or from google style retryDelay fields
export function retryAfterMs(header: string | null, body: string): number | undefined {
  if (header) {
    const s = Number(header);
    if (Number.isFinite(s)) return Math.max(1000, s * 1000);
    const d = Date.parse(header);
    if (Number.isFinite(d)) return Math.max(1000, d - Date.now());
  }
  const m = body.match(/retry[_ -]?(?:delay|after|in)?"?\s*[:=]?\s*"?(\d+(?:\.\d+)?)\s*(?:s\b|sec|seconds)/i);
  return m ? Math.max(1000, Number(m[1]) * 1000) : undefined;
}

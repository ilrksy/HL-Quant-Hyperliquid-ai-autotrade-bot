// exponential moving average seeded with an sma, used for trend and crossover factors
export function ema(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// rolling mean used for bollinger-style z-scores and volume baselines
export function sma(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

// rolling population deviation so stretch from the mean can be measured in sigmas
export function stdev(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  const mean = sma(values, period);
  for (let i = period - 1; i < values.length; i++) {
    let acc = 0;
    for (let j = i - period + 1; j <= i; j++) acc += (values[j] - mean[i]) ** 2;
    out[i] = Math.sqrt(acc / period);
  }
  return out;
}

// wilder rsi, the momentum and overextension gauge used by both regimes
export function rsi(values: number[], period = 14): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

// bar range including gaps, the base of atr and adx
function trueRange(h: number[], l: number[], c: number[]): number[] {
  return h.map((hi, i) =>
    i === 0 ? hi - l[i] : Math.max(hi - l[i], Math.abs(hi - c[i - 1]), Math.abs(l[i] - c[i - 1])),
  );
}

// wilder smoothing shared by atr and adx so both match common charting packages
function wilder(values: number[], period: number, start = 0): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length < start + period) return out;
  let acc = 0;
  for (let i = start; i < start + period; i++) acc += values[i];
  let prev = acc / period;
  out[start + period - 1] = prev;
  for (let i = start + period; i < values.length; i++) {
    prev = (prev * (period - 1) + values[i]) / period;
    out[i] = prev;
  }
  return out;
}

// volatility unit that every stop, target and position size is expressed in
export function atr(h: number[], l: number[], c: number[], period = 14): number[] {
  return wilder(trueRange(h, l, c), period);
}

// average directional index, separates trending from ranging markets regardless of direction
export function adx(h: number[], l: number[], c: number[], period = 14): number[] {
  const n = h.length;
  const plusDM = new Array<number>(n).fill(0);
  const minusDM = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = h[i] - h[i - 1];
    const down = l[i - 1] - l[i];
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }
  const tr = wilder(trueRange(h, l, c), period, 1);
  const pdm = wilder(plusDM, period, 1);
  const mdm = wilder(minusDM, period, 1);
  const dx = new Array<number>(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(tr[i]) || tr[i] === 0) continue;
    const pdi = (100 * pdm[i]) / tr[i];
    const mdi = (100 * mdm[i]) / tr[i];
    dx[i] = pdi + mdi === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / (pdi + mdi);
  }
  const first = dx.findIndex(Number.isFinite);
  if (first < 0) return dx.map(() => NaN);
  const out = wilder(dx.map((v) => (Number.isFinite(v) ? v : 0)), period, first);
  return out;
}

// rolling volume-weighted price, the fair-value anchor for mean reversion
export function vwap(h: number[], l: number[], c: number[], v: number[], period: number): number[] {
  const out = new Array<number>(c.length).fill(NaN);
  let pv = 0;
  let vol = 0;
  for (let i = 0; i < c.length; i++) {
    const tp = (h[i] + l[i] + c[i]) / 3;
    pv += tp * v[i];
    vol += v[i];
    if (i >= period) {
      const j = i - period;
      pv -= ((h[j] + l[j] + c[j]) / 3) * v[j];
      vol -= v[j];
    }
    if (i >= period - 1) out[i] = vol > 0 ? pv / vol : c[i];
  }
  return out;
}

// latest value of an indicator series
export const last = (a: number[]) => a[a.length - 1];
// keeps every factor inside the shared -1..1 scale
export const clamp = (x: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x));

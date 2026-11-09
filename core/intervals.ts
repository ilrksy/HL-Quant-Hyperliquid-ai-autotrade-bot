// bar length per interval, shared by pure modules that must not import network code
export const INTERVAL_MS_PURE: Record<string, number> = {
  "1m": 60e3, "3m": 180e3, "5m": 300e3, "15m": 900e3, "30m": 1_800e3, "1h": 3_600e3, "4h": 14_400e3, "1d": 86_400e3,
};

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// optional dotenv file so docker, systemd and desktop host mode can each point at their own config
const envFile = process.env.ENV_FILE ?? ".env";
if (existsSync(envFile)) process.loadEnvFile(envFile);
// short alias for the process environment
const env = process.env;

// live mode must be requested explicitly and acknowledged, never inferred
const wantsLive = env.TRADING_MODE === "live";
// a raw secp256k1 private key in hex form
const hasKey = /^0x[0-9a-fA-F]{64}$/.test(env.HL_PRIVATE_KEY ?? "");
if (wantsLive && !hasKey) throw new Error("TRADING_MODE=live requires HL_PRIVATE_KEY (0x + 64 hex)");
if (wantsLive && env.LIVE_CONFIRM !== "I_ACCEPT_LOSS_RISK")
  throw new Error("TRADING_MODE=live requires LIVE_CONFIRM=I_ACCEPT_LOSS_RISK");

// every persistent file lives here so one volume or folder backs up the whole server
const DATA_DIR = resolve(env.DATA_DIR ?? "data");
mkdirSync(DATA_DIR, { recursive: true });

// explicit env token wins, otherwise one is generated on first start and reused afterwards
function loadToken(): string {
  if (env.API_TOKEN) return env.API_TOKEN;
  const file = join(DATA_DIR, "server.json");
  try {
    const saved = JSON.parse(readFileSync(file, "utf8"));
    if (typeof saved.token === "string" && saved.token.length >= 16) return saved.token;
  } catch {
    // first start: fall through and create a token
  }
  const token = randomBytes(24).toString("base64url");
  writeFileSync(file, JSON.stringify({ token, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  return token;
}

// coin list from env, used only to seed the first settings file
const seedCoins = (env.BOT_COINS ?? "BTC,ETH,SOL").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
// bar interval from env, used only to seed the first settings file
const seedInterval = (["1m", "5m", "15m"].includes(env.BOT_INTERVAL ?? "") ? env.BOT_INTERVAL : "15m") as "1m" | "5m" | "15m";

// process-wide configuration; runtime-tunable values live in the settings store instead
export const config = {
  version: "0.2.0",
  mode: (wantsLive ? "live" : "paper") as "live" | "paper",
  testnet: env.HL_TESTNET === "true",
  privateKey: env.HL_PRIVATE_KEY as `0x${string}` | undefined,
  // set when HL_PRIVATE_KEY belongs to an API/agent wallet trading for a main account
  accountAddress: env.HL_ACCOUNT_ADDRESS as `0x${string}` | undefined,
  paperEquity: Number(env.PAPER_START_EQUITY ?? 10),
  host: env.HOST ?? "127.0.0.1",
  port: Number(env.PORT ?? 8787),
  apiToken: loadToken(),
  tokenFromEnv: !!env.API_TOKEN,
  dataDir: DATA_DIR,
  webDist: resolve(env.WEB_DIST ?? "web/dist"),
  telegramApi: env.TELEGRAM_API_BASE ?? "https://api.telegram.org",
  seed: { coins: seedCoins, interval: seedInterval, cycleSec: Number(env.BOT_LOOP_SEC ?? 15) },
};

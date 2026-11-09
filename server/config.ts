import { existsSync } from "node:fs";
import { defaultRiskParams, type RiskParams } from "../core/risk";
import { defaultStrategyParams, type StrategyParams } from "../core/strategy";

if (existsSync(".env")) process.loadEnvFile(".env");
const env = process.env;

const wantsLive = env.TRADING_MODE === "live";
const hasKey = /^0x[0-9a-fA-F]{64}$/.test(env.HL_PRIVATE_KEY ?? "");
if (wantsLive && !hasKey) throw new Error("TRADING_MODE=live requires HL_PRIVATE_KEY (0x + 64 hex)");
if (wantsLive && env.LIVE_CONFIRM !== "I_ACCEPT_LOSS_RISK")
  throw new Error("TRADING_MODE=live requires LIVE_CONFIRM=I_ACCEPT_LOSS_RISK");

// runtime-tunable bot settings, editable from the dashboard
export interface BotConfig {
  coins: string[];
  interval: "1m" | "5m" | "15m";
  loopSec: number;
  risk: RiskParams;
  strategy: StrategyParams;
}

// environment-derived settings; live trading needs a key and an explicit risk acknowledgement
export const config = {
  mode: (wantsLive ? "live" : "paper") as "live" | "paper",
  testnet: env.HL_TESTNET === "true",
  privateKey: env.HL_PRIVATE_KEY as `0x${string}` | undefined,
  // Set when HL_PRIVATE_KEY belongs to an API/agent wallet trading for a main account.
  accountAddress: env.HL_ACCOUNT_ADDRESS as `0x${string}` | undefined,
  paperEquity: Number(env.PAPER_START_EQUITY ?? 10),
  host: env.HOST ?? "127.0.0.1",
  port: Number(env.PORT ?? 8787),
  apiToken: env.API_TOKEN ?? "",
  bot: {
    coins: (env.BOT_COINS ?? "BTC,ETH,SOL").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean),
    interval: (env.BOT_INTERVAL ?? "15m") as BotConfig["interval"],
    loopSec: Number(env.BOT_LOOP_SEC ?? 20),
    risk: { ...defaultRiskParams },
    strategy: { ...defaultStrategyParams },
  } satisfies BotConfig,
};

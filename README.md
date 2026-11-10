# HL Quant

Self-hosted AI trading company for **Hyperliquid perpetuals**: a team of AI and quant agents (Boss, CEO, Auditor, managers and workers) runs a filtered pipeline every few seconds, with hard risk limits enforced in code, full history logs, Telegram control, and a fast flat dashboard that runs in the browser, as a Windows/Linux/macOS app and as an Android app. Every device connects to **one self-hosted server** through **one API** (server URL + token).

> **Read this first.** No trading system — with or without AI — can guarantee profit or "no losses". Leveraged perpetuals can lose your entire deposit. HL Quant is built to *control* risk (exchange-side stop on every trade, risk-per-trade sizing, daily loss limit, drawdown kill switch, pre-trade audit), not to remove it. The quant layer's backtests on real Hyperliquid data showed **no proven edge** (see [Backtest results](#backtest-results)). Start in paper mode, then testnet, and only trade money you can afford to lose.

---

## Contents

- [Architecture](#architecture)
- [The company](#the-company)
- [The pipeline](#the-pipeline)
- [AI providers and fallback](#ai-providers-and-fallback)
- [Risk controls](#risk-controls)
- [Quick start](#quick-start)
- [Devices](#devices)
- [Telegram](#telegram)
- [Live trading](#live-trading)
- [History and logs](#history-and-logs)
- [Backtest results](#backtest-results)
- [Development](#development)
- [Limitations](#limitations)

## Architecture

```
 Browser / PWA ─┐
 Windows .exe  ─┤                        ┌──────────────── self-hosted server (Node 22.13+) ───────────────┐
 Linux / macOS ─┼── one API: URL+token ──►  REST + SSE  ─►  Company: Boss · CEO · Auditor · 15 workers   │
 Android APK   ─┤   (x-api-token)        │                   │ 9-stage pipeline every 5–300 s              │
 Telegram bot  ─┘                        │                   ├─ AI gateway (multi-provider, key pools,     │──► Gemini, Antigravity, Grok,
                                         │                   │   cooldowns, circuit breakers, fallback)    │    Groq, OpenRouter, Ollama…
                                         │                   ├─ Risk engine + leverage officer             │
                                         │                   ├─ Paper broker │ Live broker (signed L1)     │──► Hyperliquid API
                                         │                   └─ SQLite history (logs, decisions, AI calls, │
                                         │                      trades, equity) · settings · Telegram      │
                                         └─────────────────────────────────────────────────────────────────┘
 Market data (charts, book, tape) streams from Hyperliquid's public WebSocket directly to each client.
```

- **Server** (`server/`): composition root in `server/index.ts`; all state lives in `DATA_DIR` (SQLite `hlq.db`, `paper.json`, `server.json` with the generated token).
- **Pure logic** (`core/`): indicators, regime-aware factor model, risk sizing, leverage targeting, backtester. Shared by the server, backtests and tests.
- **Dashboard** (`web/`): React + lightweight-charts, flat Hyperliquid-style theme, responsive from phones to wide desktops. The same build is served by the server, packaged into the desktop app and into the Android app.

## The company

| Role | Kind | What it does |
|---|---|---|
| **Boss** (main AI) | AI | Final approval of every sized trade, can scale size down (0.25–1×), sets the company directive: normal, cautious (half risk) or halt. |
| **CEO** | AI | Every period: market regime, risk multiplier (0.25–1×), focus/avoid lists and per-coin bias from majors, breadth, macro, sentiment and news. |
| **Auditor** | AI + rules | Deterministic pre-trade audit on every order; periodic performance reviews (grade A–F) whose recommendation becomes a binding directive. |
| Research Manager | AI | Confirms or skips quant candidates using all worker evidence. One batched call per cycle; opinions are memoised per signal bar. |
| Risk Manager · Risk Guard | quant | Position sizing, slots, margin budget, daily loss limit, drawdown kill switch. |
| Leverage Officer | quant | Volatility-targeted leverage inside your global and per-coin caps. |
| Perp Scout | quant | Manual list or automatic universe by volume, spread and max leverage. |
| Quant Analyst | quant | Regime-aware factor model (EMA cross, RSI, ADX, VWAP z-score, higher-timeframe bias) on closed bars only. |
| Order Flow · Derivatives · Sentiment analysts | quant | L2 imbalance and spread; funding, premium, open interest and Binance/Bybit funding; Fear & Greed, BTC dominance, market cap and RSS headlines. |
| Deep Research | AI | Optional slow web research through the Google **Antigravity** agent (minutes per run), fed to the CEO. |
| Execution Trader · Position Monitor · Accountant · Telegram Reporter | ops | Orders with exchange-side TP/SL, trailing/reversal/time exits and missing-stop repair, journal and equity, notifications. |

**AI authority** is a setting: `control` (models decide inside hard limits), `advisory` (rules decide, model opinions are logged next to them) or `off` (zero token cost). In every mode, if all models fail or time out, the **rules engine** takes the decision, so trading never depends on a free API being up.

## The pipeline

Each cycle (default 15 s) runs nine stages; every candidate leaves a decision record with the reason it stopped.

1. **Perp Scout** — universe filter.
2. **Quant Engine** — factor score −1…+1 per coin; only scores past the entry threshold in a tradeable regime become candidates; one decision per coin per signal bar.
3. **Market Intel** — book imbalance, spread, funding vs. cross-venue funding, news score; raises red flags (crowded funding, book against, news against, wide spread).
4. **AI Research** — confirm or skip (never flip) the quant direction with a confidence; below the minimum confidence → rejected.
5. **Risk Guard** — kill switch, daily loss, directive, leverage officer, fixed-fractional sizing anchored to the live mid, fee/slippage filter, margin budget, slots.
6. **Boss Approval** — approve/reject/scale, directive.
7. **Pre-trade Audit** — stop and target on the correct side, R:R ≥ 1.2, liquidation ≥ 2× stop distance, caps, exchange minimum, price drift, signal freshness, risk ≤ 1.5× budget.
8. **L1 Execution** — paper fills with Hyperliquid fees and slippage, or live IOC orders followed by reduce-only TP/SL trigger orders sized to the actual fill.
9. **TP/SL Monitor** — breakeven and trailing stops, reversal and time exits, missing-stop repair, close detection and the journal.

## AI providers and fallback

Add as many providers as you like, each with **several API keys** that rotate least-recently-used. Presets (model IDs change often; use **Fetch models** in the AI page to pick current ones):

| Preset | Cost | Notes |
|---|---|---|
| Google Gemini (AI Studio, OpenAI-compatible endpoint) | free tier on Flash / Flash-Lite / Gemma | Restrict keys to the Generative Language API. |
| Google **Antigravity** agent (Gemini Interactions API) | free-tier quota, then per token | Managed agent that browses the web; takes minutes, so it only powers Deep Research. |
| xAI **Grok** | paid only (no free credits) | `grok-4.20-0309-non-reasoning` is the quick choice for short JSON decisions. |
| Groq · Cerebras · OpenRouter (`:free`) · Mistral · NVIDIA NIM · Cloudflare Workers AI · Z.AI · SambaNova | free tiers | OpenAI-compatible. |
| DeepSeek | paid, low cost | |
| OVHcloud AI Endpoints · Pollinations | free, **no key** | IP rate-limited; handy to try the system or as a last resort. |
| Ollama / any OpenAI-compatible URL | your hardware | Private and unlimited. |

How a request is served:

1. The role's chain (Boss, Research, CEO, Auditor, Deep Research) is either automatic (enabled providers in priority order) or a custom list of provider·model links.
2. For each provider, ready keys are tried in rotation. **429/402** → that key cools down (honouring `Retry-After`, exponential backoff, 1 h for daily quotas). **401/403** → the key is marked invalid (persisted until a passing test). **5xx/timeouts** → after 3 failures the provider's circuit opens for 30 s…10 min.
3. A slow provider only gets ~60 % of the remaining deadline so the next one can still answer.
4. Output must be valid JSON that passes the role's validator; otherwise the next provider is tried. Providers that reject `response_format` are retried without it and switched to plain mode automatically.
5. If nothing answers within the deadline, the deterministic rules engine decides and the decision is logged as `rules`.

Every request is logged (role, provider, key label, model, status, HTTP code, latency, fallback depth, tokens). Keys are never sent back to clients (masked as `abcd…wxyz`).

**Token economy:** one batched research call per cycle (only when candidates exist and autotrade is armed), opinions memoised per signal bar, CEO every 30 min, audit every 2 h or after 5 trades, short prompts with compact factor encoding.

## Risk controls

| Control | Default | |
|---|---|---|
| Risk per trade | 2 % of equity | Loss at the stop including round-trip taker fees. |
| Fee/slippage filter | 0.2 R | Skips trades whose costs exceed 20 % of the stop distance — the main lesson from the backtests. |
| Max leverage | 5× | Also capped by the coin's max and optional per-coin caps; auto mode targets a daily volatility budget. |
| Max positions | 1 | Fits a $10 account with Hyperliquid's $10 minimum order. |
| Daily loss limit | 6 % | No new entries until the next UTC day. |
| Kill switch | 20 % from peak | Closes all bot positions and disarms. |
| Loss cooldown | 30 min per coin | |
| Exchange-side stop | always | Live TP/SL are reduce-only trigger orders on Hyperliquid, so they survive a server crash. |

Hard limits are code, not prompts: no model output can change them.

## Quick start

Requirements: **Node.js 22.13 or newer** (uses the built-in `node:sqlite`).

```bash
npm install
cp .env.example .env        # paper mode with $10 by default
npm run build               # type-check + build the dashboard
npm start                   # http://127.0.0.1:8787
```

On first start the server prints its **API token** (also saved in `data/server.json`). Open `http://127.0.0.1:8787`, paste the token, then:

1. **AI** page → *Add provider* (e.g. Gemini with one or more keys, or a no-key preset to try it out) → *Test keys*.
2. **Command** page → *Arm autotrade* (paper). Watch the pipeline, decisions, org chart and live activity.
3. **Settings** → risk, leverage, AI authority, intel workers, Telegram.

Development with hot reload: `npm run dev` (server on :8787, dashboard on :5173 proxied).

Self-hosting with Docker, systemd, Windows host mode and remote access: see [`deploy/README.md`](deploy/README.md).

## Devices

| Platform | Package | Notes |
|---|---|---|
| Any browser | served by the server | Installable as a PWA (iOS/Android/desktop). |
| Windows | `HL-Quant-Setup-<version>-x64.exe` (NSIS installer) | Can run the server itself (**Host mode**, tray icon). |
| Linux | `.AppImage`, `.deb`, `.rpm`, `.tar.gz` | Same host mode as Windows. |
| macOS | `.dmg` (built on a macOS CI runner) | Unsigned. |
| Android | `HL-Quant-<version>.apk` | Thin client; connects to your server over LAN, Tailscale or an HTTPS tunnel. |

Every client uses the same **server URL + API token**. To reach the server from phones or other PCs, run it with `HOST=0.0.0.0` (desktop: tray → *Allow LAN devices*). For access outside your network use Tailscale or a Cloudflare Tunnel; **never expose the port to the internet without HTTPS**. Settings → *Devices & connection* shows LAN URLs and a sign-in link for browsers.

Build commands and CI release workflow: `desktop/`, `mobile/`, `.github/workflows/release.yml`.

## Telegram

1. Create a bot with [@BotFather](https://t.me/BotFather), paste the token in **Settings → Telegram**, enable and save.
2. Click **Pair a chat** and send `/pair 123456` to your bot within 10 minutes. Unknown chats are rejected and logged.
3. Commands: `/status` `/positions` `/pnl` `/pipeline` `/ai` `/logs` `/arm` (`/arm confirm` in live mode) `/disarm` `/kill confirm`.
4. Notifications (toggle each): trades, risk and audit alerts, AI failures, daily summary, CEO plans and audits.

Long polling is used, so no public URL or webhook is needed.

## Live trading

1. Create an **API wallet** at <https://app.hyperliquid.xyz/API> (it can trade but cannot withdraw).
2. Try testnet first: `HL_TESTNET=true` with testnet funds.
3. In `.env`: `TRADING_MODE=live`, `HL_PRIVATE_KEY=0x…` (the API wallet key), `HL_ACCOUNT_ADDRESS=0x…` (your main account), `LIVE_CONFIRM=I_ACCEPT_LOSS_RISK`.
4. Restart the server. The dashboard shows a red **LIVE** badge and every arm/kill/order asks for confirmation.

The live broker has been type-checked against the SDK but not exercised against a funded account in this repository; verify it on testnet before mainnet.

## History and logs

Everything is stored in SQLite under `DATA_DIR` (90-day retention) and is visible from any device in **History**:

- **Activity log** — every agent action with level, category, agent, coin and cycle; live tail, search, filters, CSV/JSON export.
- **Decisions** — each candidate's full trail: research opinion, sizing, boss verdict, audit result, outcome.
- **AI calls** — provider, key, model, status, latency, fallback depth and tokens for every request.
- **Cycles** — duration and funnel counts per pipeline run.
- **Trades** — bot and manual round trips with R-multiples, fees and holding time; CSV export.

**Portfolio** adds the equity curve, daily PnL, win rate, profit factor, expectancy, drawdown, streaks, per-market stats and AI usage.

## Backtest results

The quant layer was measured on real Hyperliquid candles (BTC, ETH, SOL, HYPE) with fees and slippage, comparing the strategy against inverted signals and random entries (sum of R over four coins):

| Variant | 5m (~17 days) | 15m | 1h (~208 days) |
|---|---|---|---|
| Strategy | −23.4 R | −37.3 R | −54.0 R |
| Inverted signals | −28.9 R | −24.6 R | −75.1 R |
| Random entries | −6.1 R | −2.0 R | −70.9 R |

The strategy did not beat random entries; trading costs dominate short timeframes (without the cost filter the 5m variant lost −242 R). The AI layers can only veto or downsize quant candidates, and their judgement cannot be replayed historically here, so **forward paper trading is the only honest test** of the full system. Run your own backtests from the Trade page or `npm run backtest -- SOL 15m 30 10`.

## Development

```bash
npm test            # vitest: indicators, risk, strategy, backtest, paper broker, AI gateway, company pipeline, Telegram, settings
npm run typecheck
npm run build
```

```
core/       pure trading logic (indicators, strategy, risk, leverage, backtest)
server/     API, company pipeline, AI gateway, brokers, intel, Telegram, SQLite store
shared/     types shared by server and dashboard
web/        dashboard (React + Vite)
desktop/    Electron app with host mode (Windows, Linux, macOS)
mobile/     Capacitor Android app
deploy/     Dockerfile, docker-compose, systemd unit
tests/      vitest suites
```

## Limitations

- No profit guarantee; the quant model has no demonstrated edge and AI opinions are unproven.
- Free AI tiers are rate-limited and change often; the system degrades to the rules engine, not to failure.
- Grok has no free API tier. Antigravity is an agent that takes minutes, so it is only used for deep research.
- Live trading supports Hyperliquid main perps (not HIP-3 builder markets or portfolio margin).
- Desktop and Android builds are unsigned (SmartScreen/Gatekeeper/Play Protect warnings). There is no native iOS app; use the PWA.
- Paper resting limit orders do not reserve margin, and paper liquidation prices are approximations.

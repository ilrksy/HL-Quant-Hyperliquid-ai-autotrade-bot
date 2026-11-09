# HL Quant Terminal

Terminal dagangan perps Hyperliquid dengan bot autotrade kuantitatif, pengurusan risiko berlapis, paper trading, backtester dan dashboard gaya terminal (carta, order book, tape, tiket order, posisi, order, fills, log, lengkung ekuiti).

> **Amaran penting.** Tiada sistem dagangan yang boleh menjamin keuntungan atau "tiada rugi". Perps berleveraj boleh menghabiskan keseluruhan deposit. Sistem ini direka untuk **mengawal** kerugian (stop loss wajib, had rugi harian, kill switch drawdown), bukan menghapuskannya. Lihat bahagian *Keputusan backtest* di bawah — strategi lalai **tidak** menunjukkan edge yang terbukti.

## Mula cepat

```bash
npm install
cp .env.example .env          # lalai: TRADING_MODE=paper, modal $10
npm run dev                   # server bot :8787 + dashboard http://localhost:5173
```

Produksi (satu proses, dashboard dihidangkan oleh server):

```bash
npm run build && npm start    # http://127.0.0.1:8787
```

Backtest dari terminal:

```bash
npm run backtest -- SOL 15m 30 10    # coin interval hari modal
```

## Seni bina

```
core/      logik tulen, dikongsi server/backtest/ujian
  indicators.ts   EMA, SMA, stdev, RSI, ATR, ADX, VWAP
  strategy.ts     model multi-faktor ikut rejim (trend / range / chop)
  risk.ts         saiz posisi fixed-fractional, penapis kos, trailing stop, circuit breaker
  backtest.ts     replay bar-demi-bar pesimis (yuran + slippage, stop dianggap kena dahulu)
server/
  market.ts       data Hyperliquid (meta, mids, candles, L2)
  paper.ts        bursa simulasi (yuran taker/maker HL, margin silang, likuidasi anggaran)
  live.ts         pelaksanaan sebenar melalui @nktkas/hyperliquid (IOC + trigger SL/TP reduce-only)
  bot.ts          gelung autotrade: analisis → gate risiko → saiz → entry → trailing / keluar
  index.ts        REST API + hidang dashboard
web/       dashboard React + lightweight-charts; data pasaran terus dari WebSocket Hyperliquid
tests/     vitest untuk indikator, risiko, strategi, backtest, paper broker
```

"AI" di sini ialah model kuantitatif deterministik — **sifar token LLM**, jadi tiada kos API dan setiap keputusan boleh diterangkan (hover baris isyarat untuk melihat setiap faktor dan beratnya).

## Lapisan risiko

| Kawalan | Lalai | Fungsi |
|---|---|---|
| Risiko per dagangan | 2% ekuiti | Saiz dikira supaya kena stop = rugi ~2% (termasuk yuran) |
| Penapis kos | 0.2R | Tolak dagangan jika yuran + slippage > 20% jarak stop |
| Leveraj maks | 5x | Juga dihadkan oleh maxLeverage setiap coin |
| Posisi serentak | 1 | Sesuai untuk akaun $10 |
| Had rugi harian | 6% | Tiada entry baharu sehingga hari UTC seterusnya |
| Kill switch | 20% dari puncak | Tutup semua posisi bot dan hentikan autotrade |
| Cooldown | 30 min | Rehat per coin selepas dagangan rugi |
| Stop di bursa | sentiasa | Live: SL/TP diletak sebagai trigger order reduce-only di Hyperliquid, jadi kekal walaupun server mati |

Nota akaun $10: Hyperliquid mewajibkan nilai order minimum $10, jadi akaun $10 perlu leveraj ≥1x pada setiap dagangan dan hanya boleh memegang satu posisi.

## Keputusan backtest (jujur)

Diukur pada 2026-11-09 dengan data sebenar Hyperliquid (BTC, ETH, SOL, HYPE; 5m ≈ 17 hari, 1h ≈ 208 hari), jumlah R merentas 4 coin:

| Varian | 5m | 15m | 1h |
|---|---|---|---|
| Strategi lalai | −23.4R | −37.3R | −54.0R |
| Isyarat diterbalikkan | −28.9R | −24.6R | −75.1R |
| Entry rawak | −6.1R | −2.0R | −70.9R |

Kesimpulan: model ini **tidak** mengatasi entry rawak secara bermakna; kos dagangan ialah musuh utama. Tanpa penapis kos, strategi 5m kehilangan −242R. Gunakan backtester dan paper mode untuk menilai sebarang perubahan sebelum menggunakan wang sebenar.

## Live trading

1. Cipta **API wallet** di <https://app.hyperliquid.xyz/API> (boleh berdagang, tidak boleh withdraw).
2. Uji dahulu di testnet: `HL_TESTNET=true`.
3. Dalam `.env`: `TRADING_MODE=live`, `HL_PRIVATE_KEY=0x...`, `HL_ACCOUNT_ADDRESS=0x<akaun utama>`, `LIVE_CONFIRM=I_ACCEPT_LOSS_RISK`.
4. Jangan dedahkan server ke internet tanpa `API_TOKEN` dan HTTPS. Lalai bind ke `127.0.0.1` sahaja.

## Ujian

```bash
npm test          # vitest
npm run typecheck
```

# Forex Signal Engine

Personal, free-tier Forex analysis and multi-timeframe signal-generation app.
**Backend:** GitHub repository (JSON files). **Frontend:** static dashboard on GitHub Pages.
**Automation:** GitHub Actions fetches data & runs the signal engine every 15 minutes.

> ⚠️ **Personal use only.** No trading guarantees. Signal strength is a confluence score, not a win probability. Never risk money you cannot afford to lose.

---

## Architecture

```
 ┌─────────────────────────────────────────────────────┐
 │  Data provider (Twelve Data / Yahoo)                │  ← API keys live ONLY in
 └──────────────────┬──────────────────────────────────┘     GitHub Actions secrets
                    │ HTTPS
 ┌──────────────────▼──────────────────────────────────┐
 │  GitHub Actions (every 15 min)                      │
 │  ┌─────────────────────────────────────────────┐    │
 │  │ actions/fetch-and-analyze.mjs               │    │
 │  │  ├── fetch candles                          │    │
 │  │  ├── validate (records provider, quality)   │    │
 │  │  └── run pure engine/signals.js             │    │
 │  └─────────────────┬───────────────────────────┘    │
 │                    │ commits JSON                   │
 └────────────────────┼────────────────────────────────┘
                      ▼
 ┌─────────────────────────────────────────────────────┐
 │  GitHub Repository (data/*.json)                    │
 │  ├── data/prices/{PAIR}-{TF}.json                   │
 │  ├── data/signals/signals.json  (immutable history) │
 │  └── data/trades/trades.json                        │
 └──────────────────┬──────────────────────────────────┘
                    │ GitHub Pages (static HTTPS)
 ┌──────────────────▼──────────────────────────────────┐
 │  Browser Dashboard (index.html)                     │
 │  Reads JSON only. No keys. No writes.               │
 │  Renders charts, signals, performance, backtests.   │
 └─────────────────────────────────────────────────────┘
```

### Key design rules

- **Pure engine** (`engine/`) — framework-agnostic JS. Identical logic runs in browser, Actions, backtester, and tests.
- **No credentials in browser** — API keys are GitHub Actions secrets. The frontend never sees them.
- **Data acquisition ≠ signal generation** — engine receives normalized candles; provider can be swapped without touching strategy code.
- **Provider provenance** — every price file records which provider, timestamp, quality, issues, and transformations.
- **Immutable signals** — signals are appended, never overwritten. Each includes `strategyVersion` for honest auditing.
- **No fabricated performance** — stats are computed only from closed trades you have verified.
- **NO TRADE is normal** — the engine stays flat more often than it signals; there is no pressure to produce trades.

---

## Signal Hierarchy (D1 → H4 → H1 → M15 → M5)

Higher timeframes establish context (trend direction, key S/R levels).
Lower timeframes confirm entries and refine timing.
A signal is only emitted when multiple factors align across the hierarchy.

## Multi-factor confluence

The initial deterministic strategy combines:
- EMA 9/21 + SMA 50/200 alignment
- RSI (14) overbought/oversold & direction
- MACD (12,26,9) crossover & histogram direction
- ATR (14) volatility regime & stop sizing
- Swing high/low detection, support/resistance zones
- HH/HL/LH/LL trend structure
- Breakouts & retests of key levels
- Multi-timeframe alignment weighting (D1=4×, H4=3×, H1=2×, M15=1.5×, M5=0.8×)

SL = min(ATR-multiple distance, nearest structural swing) with a small buffer.
TP = nearest opposing structure level (or ATR extension) meeting min R:R of 1:1.5.

---

## Setup

### 1. Create a private GitHub repository

Create a new private repo on GitHub, commit this code to it, and push.

### 2. Get a free Twelve Data API key

Sign up at https://twelvedata.com/ (free tier: 800 requests/day).

### 3. Add the key as a repository secret

In GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**:
- Name: `TWELVEDATA_API_KEY`
- Value: your API key

If you don't add a key, the system will fall back to Yahoo Finance (no key needed).

### 4. Enable GitHub Pages

- Go to **Settings → Pages**
- Source: **GitHub Actions**
- The `pages.yml` workflow will deploy automatically on push.

Your dashboard will be at `https://<your-username>.github.io/<repo-name>/`.

### 5. Enable the Actions

- Go to the **Actions** tab and enable workflows if prompted.
- The `Forex Analysis` workflow runs every 15 minutes and on manual trigger.
- The first run will populate real data (replacing the demo candles).

### Running locally

```bash
# Run engine tests
npm test

# Serve the dashboard locally (no data fetch without API key)
npm run serve
```

---

## Repository structure

```
forex-signals/
├── index.html                  # Dashboard
├── assets/
│   ├── css/styles.css
│   └── js/                     # Frontend modules (app, api, ui, charts, config)
├── engine/                     # ★ Pure signal engine (no DOM, no I/O)
│   ├── indicators.js           # SMA, EMA, RSI, MACD, ATR, Bollinger, Stochastic
│   ├── structure.js            # Swings, S/R zones, trend, MA alignment, breakouts
│   ├── momentum.js             # RSI + MACD composite momentum score
│   ├── volatility.js           # ATR regime & squeeze detection
│   ├── risk.js                 # Entry, SL, TP, position sizing
│   ├── signals.js              # ORCHESTRATOR: multi-TF confluence → BUY/SELL/NO TRADE
│   ├── validation.js           # Candle normalization & provider-provenance
│   ├── performance.js          # Win rate, profit factor, drawdown, equity curve
│   ├── backtest.js             # Walk-forward backtester (no look-ahead)
│   └── __tests__/              # Unit tests (node:test, zero deps)
├── actions/
│   └── fetch-and-analyze.mjs   # GitHub Actions entry: fetch → validate → analyze → commit
├── data/                       # THE DATABASE (JSON, updated by Actions)
│   ├── prices/{PAIR}-{TF}.json
│   ├── signals/signals.json
│   └── trades/trades.json
├── scripts/generate-demo-data.mjs
└── .github/workflows/
    ├── analyze.yml             # Every 15 min: fetch + analyze + commit
    ├── test.yml                # On push: run engine tests
    └── pages.yml               # Deploy to GitHub Pages
```

---

## Phase 1 deliverable (this version)

- ✅ Repository structure & configuration-driven pairs/timeframes
- ✅ Professional dark-themed dashboard (Signals, Chart, Pairs, Performance, Backtest, About tabs)
- ✅ Lightweight Charts (TradingView) candlesticks with EMA/SMA overlays
- ✅ Core indicator engine (SMA, EMA, RSI, MACD, ATR, Bollinger, Stochastic)
- ✅ Market structure (swings, S/R zones, HH/HL/LH/LL, MA alignment, breakouts/retests)
- ✅ Momentum & volatility modules
- ✅ Risk module (ATR + structure SL/TP, R:R)
- ✅ Multi-timeframe hierarchical signal orchestrator with confluence scoring
- ✅ Data validation with provider provenance
- ✅ Performance statistics (win rate, profit factor, expectancy, drawdown, equity curve)
- ✅ Walk-forward backtesting engine (no look-ahead bias)
- ✅ Duplicate-signal prevention
- ✅ 25 unit tests (all passing)
- ✅ GitHub Actions workflows (analyze, test, deploy pages)
- ✅ Demo data generation for UI preview (clearly labeled)

### Next phases

- **Phase 2:** Full client-side "Analyze Now" via a secure serverless proxy (Cloudflare Worker or Vercel function) so you can trigger analysis without waiting for the cron.
- **Phase 3:** Economic calendar integration (high-impact news filter).
- **Phase 4:** Trade outcome UI (mark signals WIN/LOSS directly from the dashboard).
- **Phase 5:** Advanced backtest reports (per-pair stats, equity curve overlay, parameter sensitivity).
- **Phase 6:** Telegram/email alert delivery on new signals.
- **Phase 7:** Forward-test dashboards (signal-strength bucket calibration — only after enough trades accumulate).

---

## Strategy version

Current strategy version: **v1.0.0**. If/when you tune indicator parameters or add new confluence rules, bump `STRATEGY_VERSION` in `assets/js/config.js` so you can later slice performance by version without corrupting historical results.

/**
 * charts.js — Lightweight Charts (TradingView) rendering.
 */

let chart = null;
let candleSeries = null;
let emaSeries = {};
const INDICATOR_COLORS = {
  ema9:   "#f5a623",
  ema21:  "#39d2c0",
  sma50:  "#58a6ff",
  sma200: "#bc8cff",
};

/**
 * Create the main candlestick chart in the given container element.
 */
export function createChart(containerEl) {
  if (chart) { chart.remove(); chart = null; candleSeries = null; emaSeries = {}; }
  chart = LightweightCharts.createChart(containerEl, {
    layout: {
      background: { type: "solid", color: "#1a1f26" },
      textColor: "#8b949e",
      fontFamily: "'SF Mono', 'Consolas', monospace",
      fontSize: 11,
    },
    grid: {
      vertLines: { color: "rgba(48,54,61,0.3)" },
      horzLines: { color: "rgba(48,54,61,0.3)" },
    },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
      vertLine: { color: "#58a6ff", width: 1, style: 2 },
      horzLine: { color: "#58a6ff", width: 1, style: 2 },
    },
    rightPriceScale: { borderColor: "#30363d" },
    timeScale: { borderColor: "#30363d", timeVisible: true, secondsVisible: false },
    width: containerEl.clientWidth,
    height: containerEl.clientHeight,
  });

  candleSeries = chart.addCandlestickSeries({
    upColor: "#26a69a",
    downColor: "#ef5350",
    borderUpColor: "#26a69a",
    borderDownColor: "#ef5350",
    wickUpColor: "#26a69a",
    wickDownColor: "#ef5350",
  });

  // EMA/SMA lines (created on demand)
  emaSeries.ema9   = chart.addLineSeries({ color: INDICATOR_COLORS.ema9,   lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
  emaSeries.ema21  = chart.addLineSeries({ color: INDICATOR_COLORS.ema21,  lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
  emaSeries.sma50  = chart.addLineSeries({ color: INDICATOR_COLORS.sma50,  lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
  emaSeries.sma200 = chart.addLineSeries({ color: INDICATOR_COLORS.sma200, lineWidth: 2, priceLineVisible: false, lastValueVisible: false });

  // Responsive
  const resize = () => {
    chart.applyOptions({ width: containerEl.clientWidth, height: containerEl.clientHeight });
  };
  window.addEventListener("resize", resize);

  return chart;
}

/**
 * Load candle data into the chart. Candles are in engine format
 * { time, open, high, low, close } (time = unix seconds).
 */
export function setCandles(candles) {
  if (!candleSeries) return;
  const data = candles.map(c => ({
    time: c.time,
    open: c.open, high: c.high, low: c.low, close: c.close,
  }));
  candleSeries.setData(data);
  chart.timeScale().fitContent();
}

/**
 * Simple EMA calculated in-browser for overlay display.
 */
function emaValues(closes, period) {
  const result = [];
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += closes[i].value;
  let prev = seed / period;
  for (let i = 0; i < closes.length; i++) {
    if (i < period) {
      result.push({ time: closes[i].time, value: null });
      continue;
    }
    if (i === period) {
      result.push({ time: closes[i].time, value: prev });
      continue;
    }
    prev = closes[i].value * k + prev * (1 - k);
    result.push({ time: closes[i].time, value: prev });
  }
  return result.filter(p => p.value !== null);
}

function smaValues(closes, period) {
  const result = [];
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i].value;
    if (i >= period) sum -= closes[i - period].value;
    result.push({ time: closes[i].time, value: i >= period - 1 ? sum / period : null });
  }
  return result.filter(p => p.value !== null);
}

/**
 * Show/hide indicator overlays.
 */
export function setIndicatorsVisible(candles, visible) {
  for (const key of Object.keys(emaSeries)) {
    emaSeries[key].applyOptions({ visible });
  }
  if (!visible) return;
  const closes = candles.map(c => ({ time: c.time, value: c.close }));
  emaSeries.ema9.setData(emaValues(closes, 9));
  emaSeries.ema21.setData(emaValues(closes, 21));
  emaSeries.sma50.setData(smaValues(closes, 50));
  emaSeries.sma200.setData(smaValues(closes, 200));
}

/**
 * Plot S/R zones as horizontal price lines.
 */
export function setZones(zones) {
  // Remove existing price lines
  if (!candleSeries) return;
  // lightweight-charts: createPriceLine
  // We re-create them each time
  candleSeries.removeAllPriceLines?.();
  for (const z of (zones || []).slice(0, 5)) {
    const color = z.type === "support" ? "#26a69a" : z.type === "resistance" ? "#ef5350" : "#d29922";
    candleSeries.createPriceLine({
      price: z.price,
      color,
      lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      axisLabelVisible: true,
      title: `${z.type} ${z.touches}×`,
    });
  }
}

/**
 * Plot entry/SL/TP markers for a signal.
 */
export function setSignalMarkers(signal) {
  if (!candleSeries) return;
  candleSeries.setMarkers([]);
  if (!signal) return;
  const markers = [
    { time: signal.timestamp ? Math.floor(new Date(signal.timestamp).getTime()/1000) : 0,
      position: signal.signal === "BUY" ? "belowBar" : "aboveBar",
      color: signal.signal === "BUY" ? "#26a69a" : "#ef5350",
      shape: signal.signal === "BUY" ? "arrowUp" : "arrowDown",
      text: `${signal.signal} ${signal.entry.toFixed(5)}`,
    },
  ];
  candleSeries.setMarkers(markers);
}

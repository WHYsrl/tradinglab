// Client minimale per Alpaca (conto PAPER — nessun denaro reale in Fase 2)
const TRADE_BASE = "https://paper-api.alpaca.markets";
const DATA_BASE = "https://data.alpaca.markets";

function headers() {
  return {
    "APCA-API-KEY-ID": process.env.ALPACA_KEY_ID,
    "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY,
    "Content-Type": "application/json",
  };
}

async function req(base, path, opts = {}) {
  const res = await fetch(base + path, { ...opts, headers: headers() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Alpaca ${res.status} su ${path}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

module.exports = {
  clock: () => req(TRADE_BASE, "/v2/clock"),
  account: () => req(TRADE_BASE, "/v2/account"),
  positions: () => req(TRADE_BASE, "/v2/positions"),

  // Prezzi correnti + variazione giornaliera (con segno) da un'unica chiamata snapshot
  async marketData(symbols) {
    const j = await req(DATA_BASE, `/v2/stocks/snapshots?symbols=${symbols.join(",")}&feed=iex`);
    const prices = {};
    const daily = {};
    for (const s of symbols) {
      const snap = j[s];
      if (!snap) continue;
      const price =
        snap.latestTrade?.p ??
        snap.minuteBar?.c ??
        snap.dailyBar?.c ??
        snap.prevDailyBar?.c ??
        null;
      prices[s] = price;
      const prevClose = snap.prevDailyBar?.c ?? null;
      daily[s] = {
        prevClose,
        changePct: price != null && prevClose ? (price / prevClose - 1) * 100 : null,
      };
    }
    return { prices, daily };
  },

  // Trend % sugli ultimi N giorni di barre giornaliere (una chiamata per sessione decisionale)
  async trend(symbols, days) {
    const start = new Date(Date.now() - (days * 2 + 6) * 86400000).toISOString();
    const j = await req(
      DATA_BASE,
      `/v2/stocks/bars?symbols=${symbols.join(",")}&timeframe=1Day&start=${start}&limit=1000&adjustment=raw&feed=iex`
    );
    const out = {};
    for (const s of symbols) {
      const bars = (j.bars && j.bars[s]) || [];
      if (bars.length >= 2) {
        const win = bars.slice(-(days + 1));
        out[s] = (win[win.length - 1].c / win[0].c - 1) * 100;
      }
    }
    return out;
  },

  async news(symbols, sinceTs) {
    const start = new Date(sinceTs).toISOString();
    const j = await req(
      DATA_BASE,
      `/v1beta1/news?symbols=${symbols.join(",")}&start=${start}&limit=50&sort=desc`
    );
    return (j.news || []).map((n) => ({
      url: n.url,
      ts: new Date(n.created_at).getTime(),
      headline: n.headline,
      symbols: n.symbols,
    }));
  },

  submitOrder({ symbol, notional, side }) {
    return req(TRADE_BASE, "/v2/orders", {
      method: "POST",
      body: JSON.stringify({
        symbol,
        notional: Math.round(notional * 100) / 100,
        side, // "buy" | "sell"
        type: "market",
        time_in_force: "day",
      }),
    });
  },

  // Chiusura totale di una posizione (usata dallo stop-loss deterministico)
  closePosition: (symbol) => req(TRADE_BASE, `/v2/positions/${symbol}`, { method: "DELETE" }),
};

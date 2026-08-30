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
  asset: (symbol) => req(TRADE_BASE, `/v2/assets/${symbol}`),
  account: () => req(TRADE_BASE, "/v2/account"),
  positions: () => req(TRADE_BASE, "/v2/positions"),

  // Prezzi correnti + variazione giornaliera (con segno): azioni (v2) e crypto (v1beta3) in parallelo
  async marketData(symbols, cryptoSymbols = []) {
    const [stocks, crypto] = await Promise.all([
      symbols.length
        ? req(DATA_BASE, `/v2/stocks/snapshots?symbols=${symbols.join(",")}&feed=iex`)
        : {},
      cryptoSymbols.length
        ? req(DATA_BASE, `/v1beta3/crypto/us/snapshots?symbols=${cryptoSymbols.map(encodeURIComponent).join(",")}`)
        : { snapshots: {} },
    ]);
    const prices = {};
    const daily = {};
    const digest = (sym, snap) => {
      if (!snap) return;
      const price =
        snap.latestTrade?.p ??
        snap.minuteBar?.c ??
        snap.dailyBar?.c ??
        snap.prevDailyBar?.c ??
        null;
      prices[sym] = price;
      const prevClose = snap.prevDailyBar?.c ?? null;
      daily[sym] = {
        prevClose,
        changePct: price != null && prevClose ? (price / prevClose - 1) * 100 : null,
      };
    };
    for (const s of symbols) digest(s, stocks[s]);
    for (const s of cryptoSymbols) digest(s, (crypto.snapshots || {})[s]);
    return { prices, daily };
  },

  // Trend % sugli ultimi N giorni di barre giornaliere: azioni + crypto (una volta per sessione)
  async trend(symbols, cryptoSymbols, days) {
    const start = new Date(Date.now() - (days * 2 + 6) * 86400000).toISOString();
    const [js, jc] = await Promise.all([
      symbols.length
        ? req(DATA_BASE, `/v2/stocks/bars?symbols=${symbols.join(",")}&timeframe=1Day&start=${start}&limit=1000&adjustment=raw&feed=iex`)
        : { bars: {} },
      cryptoSymbols.length
        ? req(DATA_BASE, `/v1beta3/crypto/us/bars?symbols=${cryptoSymbols.map(encodeURIComponent).join(",")}&timeframe=1Day&start=${start}&limit=1000`)
        : { bars: {} },
    ]);
    const out = {};
    const digest = (sym, bars) => {
      if (bars.length >= 2) {
        const win = bars.slice(-(days + 1));
        out[sym] = (win[win.length - 1].c / win[0].c - 1) * 100;
      }
    };
    for (const s of symbols) digest(s, (js.bars && js.bars[s]) || []);
    for (const s of cryptoSymbols) digest(s, (jc.bars && jc.bars[s]) || []);
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
        time_in_force: symbol.includes("/") ? "gtc" : "day", // crypto: gtc (day non supportato)
      }),
    });
  },

  // Storico degli eseguiti (fills): prezzo e quantita reali di ogni operazione, stop-loss inclusi
  async fills(maxPages = 5) {
    let out = [];
    let pageToken = null;
    for (let i = 0; i < maxPages; i++) {
      const q = pageToken ? `&page_token=${pageToken}` : "";
      const j = await req(TRADE_BASE, `/v2/account/activities/FILL?page_size=100&direction=desc${q}`);
      if (!Array.isArray(j) || !j.length) break;
      out = out.concat(j);
      if (j.length < 100) break;
      pageToken = j[j.length - 1].id;
    }
    return out.map((f) => ({
      ts: new Date(f.transaction_time).getTime(),
      symbol: f.symbol,
      side: f.side,
      qty: Number(f.qty),
      price: Number(f.price),
    }));
  },

  // Ordine LIMIT per le sessioni estese ETF (pre-market, after-hours, overnight 24/5):
  // fuori dall'orario regolare Alpaca accetta solo limit + extended_hours (qty anche frazionaria)
  submitLimitOrder({ symbol, qty, side, limit_price }) {
    return req(TRADE_BASE, "/v2/orders", {
      method: "POST",
      body: JSON.stringify({
        symbol,
        qty: String(qty),
        side,
        type: "limit",
        limit_price: String(limit_price),
        time_in_force: "day",
        extended_hours: true,
      }),
    });
  },

  // Cancella tutti gli ordini aperti (limit non eseguiti di sessioni precedenti:
  // evita doppie esecuzioni quando una nuova sessione decide di nuovo)
  cancelOpenOrders: () => req(TRADE_BASE, "/v2/orders", { method: "DELETE" }),

  // Chiusura totale di una posizione (usata dallo stop-loss deterministico)
  closePosition: (symbol) => req(TRADE_BASE, `/v2/positions/${symbol.replace("/", "")}`, { method: "DELETE" }),
};

const C = require("./config");
const db = require("./db");
const alpaca = require("./alpaca");
const engine = require("./engine");
const risk = require("./risk");

let tickCount = 0;
let running = false;
let warnedNoKeys = false;

const ALL_ASSETS = [...C.ASSETS, ...C.CRYPTO_ASSETS];

const nyTime = () => {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  return { h: +p.find((x) => x.type === "hour").value, m: +p.find((x) => x.type === "minute").value };
};
const today = () => new Date().toISOString().slice(0, 10);

function riskProfile() {
  return C.RISK_PROFILES[process.env.RISK_PROFILE] ? process.env.RISK_PROFILE : "bilanciato";
}

// Esiti delle ultime decisioni: cosa è stato eseguito e come si è mosso il prezzo da allora
function decisionsWithOutcome(prices) {
  return db
    .lastDecisions(3)
    .map((d) => {
      const when = new Date(d.ts).toISOString().slice(0, 16);
      let ops = [];
      try { ops = JSON.parse(d.orders).executed || []; } catch (_) {}
      const snap = db.snapshotNear(d.ts);
      let then = {};
      try { then = snap ? JSON.parse(snap.prices) : {}; } catch (_) {}
      const parts = ops.map((o) => {
        const p0 = then[o.symbol], p1 = prices[o.symbol];
        let chg = "";
        if (p0 && p1) {
          const v = (p1 / p0 - 1) * 100;
          chg = `, da allora ${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
        }
        return `${o.side.toUpperCase()} ${o.symbol} $${Math.round(o.notional)}${chg}`;
      });
      return `${when}: ${d.view}${parts.length ? " [" + parts.join("; ") + "]" : ""}`;
    })
    .join(" | ");
}

async function tick() {
  if (running) return; // mai due tick sovrapposti
  running = true;
  try {
    // Senza chiavi Alpaca il sistema resta in attesa: si deploya anche prima di avere l'account
    if (!process.env.ALPACA_KEY_ID || !process.env.ALPACA_SECRET_KEY) {
      if (!warnedNoKeys) {
        warnedNoKeys = true;
        db.addEvent("waiting_keys", { msg: "Chiavi Alpaca non configurate: monitor in attesa" });
      }
      return;
    }
    tickCount++;
    const [clock, account, positions, market] = await Promise.all([
      alpaca.clock(),
      alpaca.account(),
      alpaca.positions(),
      alpaca.marketData(C.ASSETS, C.CRYPTO_ASSETS),
    ]);
    const prices = market.prices;
    const equity = Number(account.equity);
    const cash = Number(account.cash);
    const profile = riskProfile();
    const prof = C.RISK_PROFILES[profile];

    // Snapshot: sempre a borsa aperta; ogni ~5 min a borsa chiusa (le crypto si muovono comunque)
    if (clock.is_open || tickCount % C.CLOSED_SNAPSHOT_EVERY_TICKS === 1) {
      db.addSnapshot(equity, cash, prices);
    }

    // Baseline (rendimento da inizio esperimento) + stop TRAILING dal picco di equity
    let baseline = db.kvGet("baseline_equity");
    if (!baseline) { baseline = equity; db.kvSet("baseline_equity", baseline); }
    let peak = db.kvGet("equity_peak", baseline);
    if (equity > peak) { peak = equity; db.kvSet("equity_peak", peak); }
    if (!db.kvGet("halted") && equity <= peak * (1 - C.GLOBAL_STOP_DRAWDOWN)) {
      db.kvSet("halted", { reason: `Stop globale: -${C.GLOBAL_STOP_DRAWDOWN * 100}% dal picco di equity`, ts: Date.now() });
      db.addEvent("halt", { equity, peak });
    }

    const tradingOn = process.env.TRADING_ENABLED === "true" && !db.kvGet("halted");

    // Stop-loss deterministico per posizione: non passa dall'AI e non conta nel tetto ordini.
    // ETF solo a borsa aperta; crypto 24/7.
    const closedNow = new Set();
    if (tradingOn) {
      for (const p of positions) {
        const crypto = p.asset_class === "crypto";
        if (!crypto && !clock.is_open) continue;
        const slPct = crypto ? prof.cryptoStopLossPct : prof.stopLossPct;
        const plpc = Number(p.unrealized_plpc);
        const key = `stoploss:${p.symbol}`;
        if (plpc <= -slPct && Date.now() - db.kvGet(key, 0) > 30 * 60 * 1000) {
          try {
            await alpaca.closePosition(p.symbol);
            closedNow.add(p.symbol);
            db.kvSet(key, Date.now());
            db.addEvent("stop_loss", { symbol: p.symbol, plpc: (plpc * 100).toFixed(2) + "%", value: Number(p.market_value) });
          } catch (e) {
            db.addEvent("error", { where: "stop_loss", symbol: p.symbol, msg: e.message });
          }
        }
      }
    }
    const openPositions = positions.filter((p) => !closedNow.has(p.symbol));

    // Notizie (anche a borsa chiusa: le crypto possono reagire subito, gli ETF in apertura)
    let freshNews = [];
    if (tickCount % C.NEWS_EVERY_TICKS === 1) {
      const since = db.kvGet("news_since", Date.now() - 12 * 3600 * 1000);
      try {
        const items = await alpaca.news([...C.ASSETS, ...C.CRYPTO_NEWS_SYMBOLS], since);
        freshNews = db.addNews(items);
        db.kvSet("news_since", Date.now() - 5 * 60 * 1000);
      } catch (e) {
        db.addEvent("error", { where: "news", msg: e.message });
      }
    }

    // ————— Trigger —————
    const triggers = [];
    const ref = db.kvGet("last_decision_prices", prices);

    const priceTrigger = (a, thr) => {
      if (!prices[a] || !ref[a]) return;
      const movePct = (prices[a] / ref[a] - 1) * 100; // CON SEGNO: il modello deve sapere la direzione
      if (Math.abs(movePct) >= thr) {
        triggers.push({
          type: "price",
          desc: `${a} ${movePct >= 0 ? "+" : ""}${movePct.toFixed(2)}% dall'ultima sessione`,
          emergency: Math.abs(movePct) >= thr * 2,
        });
      }
    };

    // Crypto: trigger di prezzo attivi 24/7 (soglia più larga: volatilità maggiore)
    for (const a of C.CRYPTO_ASSETS) priceTrigger(a, prof.cryptoTriggerPct);

    if (clock.is_open) {
      for (const a of C.ASSETS) priceTrigger(a, prof.priceTriggerPct);

      // Check-in programmati (una volta al giorno ciascuno; robusti a riavvii tardivi)
      const t = nyTime();
      const mins = t.h * 60 + t.m;
      const day = today();
      const done = db.kvGet(`checkins:${day}`, {});
      const marks = [["open", 9 * 60 + 45], ["midday", 12 * 60 + 30], ["preclose", 15 * 60 + 30]];
      let dirty = false;
      for (const [name, mm] of marks) {
        if (mins >= mm && !done[name]) {
          done[name] = true;
          dirty = true;
          triggers.push({ type: "schedule", desc: `check-in programmato: ${name}`, emergency: false });
        }
      }
      if (dirty) db.kvSet(`checkins:${day}`, done);
    }

    // Notizie con parole chiave: anche a borsa chiusa (le crypto sono sempre negoziabili)
    for (const n of freshNews) {
      const h = (n.headline || "").toLowerCase();
      if (C.NEWS_KEYWORDS.some((k) => h.includes(k))) {
        triggers.push({ type: "news", desc: `notizia rilevante: "${n.headline}"`, emergency: false });
        break;
      }
    }

    // ————— Decisione —————
    if (triggers.length === 0) return;
    if (!tradingOn) {
      db.addEvent("trigger_ignored", { triggers, reason: "trading disabilitato o in halt" });
      db.kvSet("last_decision_prices", prices); // il riferimento avanza: lo stesso trigger non rilogga ogni 60s
      return;
    }
    const lastTs = db.kvGet("last_decision_ts", 0);
    const cooldownOk = Date.now() - lastTs >= C.DECISION_COOLDOWN_MIN * 60 * 1000;
    const emergency = triggers.some((x) => x.emergency);
    if (!cooldownOk && !emergency) return;

    const orderCountKey = `orders:${today()}`;
    const usedOrders = db.kvGet(orderCountKey, 0);
    if (usedOrders >= C.MAX_ORDERS_PER_DAY) {
      db.addEvent("trigger_ignored", { triggers, reason: "limite ordini giornaliero raggiunto" });
      db.kvSet("last_decision_prices", prices);
      return;
    }

    const triggerDesc = triggers.map((x) => x.desc).join("; ");
    db.addEvent("session_start", { trigger: triggerDesc });

    // Trend a N giorni: una sola chiamata, solo quando serve davvero una decisione
    let trendData = {};
    try {
      trendData = await alpaca.trend(C.ASSETS, C.CRYPTO_ASSETS, C.TREND_DAYS);
    } catch (e) {
      db.addEvent("error", { where: "trend", msg: e.message });
    }
    const marketCtx = {};
    for (const a of ALL_ASSETS) {
      marketCtx[a] = {
        price: prices[a] ?? null,
        changePct: (market.daily[a] && market.daily[a].changePct) ?? null,
        trendPct: trendData[a] ?? null,
      };
    }

    const slEvents = db.eventsSince("stop_loss", 24);
    const stopLossNote = slEvents.length
      ? "nelle ultime 24h il sistema ha chiuso in stop-loss: " +
        slEvents.map((e) => { try { return JSON.parse(e.data).symbol; } catch (_) { return "?"; } }).join(", ") +
        ". Rientra su questi asset solo con una motivazione forte."
      : "";

    const ctx = {
      trigger: triggerDesc,
      market: marketCtx,
      prices,
      equity,
      cash,
      positions: openPositions,
      risk: profile,
      marketOpen: clock.is_open,
      news: db.recentNews(12),
      lastDecisionsSummary: decisionsWithOutcome(prices),
      stopLossNote,
      remainingOrders: C.MAX_ORDERS_PER_DAY - usedOrders,
    };

    const { parsed, raw } = await engine.decide(ctx);
    const { orders, rejected } = risk.clampDecisions(parsed.decisions, ctx);

    const executed = [];
    for (const o of orders) {
      try {
        const r = await alpaca.submitOrder(o);
        executed.push({ ...o, order_id: r.id, status: r.status });
        db.kvSet(orderCountKey, db.kvGet(orderCountKey, 0) + 1);
      } catch (e) {
        db.addEvent("error", { where: "order", order: o, msg: e.message });
      }
    }

    db.addDecision(triggerDesc, parsed.view, parsed.decisions, { executed, rejected }, raw);
    db.kvSet("last_decision_ts", Date.now());
    db.kvSet("last_decision_prices", prices);
  } catch (e) {
    db.addEvent("error", { where: "tick", msg: e.message });
  } finally {
    running = false;
  }
}

function start() {
  db.addEvent("boot", { risk: riskProfile(), assets: ALL_ASSETS });
  tick();
  setInterval(tick, C.TICK_SECONDS * 1000);
}

module.exports = { start };

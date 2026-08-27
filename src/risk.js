const C = require("./config");

// Trasforma le decisioni del modello in ordini SICURI.
// Ogni limite qui è deterministico e ha la precedenza sull'AI.
function clampDecisions(decisions, ctx) {
  const r = C.RISK_PROFILES[ctx.risk];
  const orders = [];
  const rejected = [];
  let cash = ctx.cash;
  let invested = ctx.equity - ctx.cash;
  const singleCap = ctx.equity * r.maxTradePct;
  const exposureCap = ctx.equity * r.maxExposure;
  // Budget ordini residuo del giorno: la sessione non può sforare il tetto giornaliero
  const maxNew = Math.max(0, Math.min(C.MAX_ORDERS_PER_DAY, ctx.remainingOrders ?? C.MAX_ORDERS_PER_DAY));

  for (const d of decisions || []) {
    if (!C.ASSETS.includes(d.asset)) { rejected.push({ ...d, why: "asset fuori universo" }); continue; }
    if (d.action === "hold" || !d.usd || d.usd <= 0) continue;
    if (orders.length >= maxNew) { rejected.push({ ...d, why: "tetto ordini giornaliero raggiunto" }); continue; }

    let notional = Math.min(Number(d.usd) || 0, singleCap);

    if (d.action === "buy") {
      notional = Math.min(notional, cash, Math.max(0, exposureCap - invested));
      if (notional < 5) { rejected.push({ ...d, why: "sotto il minimo o oltre i limiti di esposizione/liquidità" }); continue; }
      cash -= notional;
      invested += notional;
      orders.push({ symbol: d.asset, side: "buy", notional, reasoning: d.reasoning });
    } else if (d.action === "sell") {
      const pos = ctx.positions.find((p) => p.symbol === d.asset);
      const posValue = pos ? Number(pos.market_value) : 0;
      notional = Math.min(notional, posValue);
      if (notional < 5) { rejected.push({ ...d, why: "posizione assente o insufficiente" }); continue; }
      cash += notional;
      invested -= notional;
      orders.push({ symbol: d.asset, side: "sell", notional, reasoning: d.reasoning });
    } else {
      rejected.push({ ...d, why: "azione non riconosciuta" });
    }
  }
  return { orders, rejected };
}

module.exports = { clampDecisions };

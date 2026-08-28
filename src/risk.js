const C = require("./config");

const isCrypto = (a) => C.CRYPTO_ASSETS.includes(a);
const posKey = (a) => a.replace("/", ""); // nelle posizioni Alpaca BTC/USD compare come BTCUSD

// Trasforma le decisioni del modello in ordini SICURI.
// Ogni limite qui è deterministico e ha la precedenza sull'AI.
function clampDecisions(decisions, ctx) {
  const r = C.RISK_PROFILES[ctx.risk];
  const orders = [];
  const rejected = [];
  let cash = ctx.cash;
  let invested = ctx.equity - ctx.cash;
  let cryptoInvested = (ctx.positions || [])
    .filter((p) => p.asset_class === "crypto")
    .reduce((sum, p) => sum + Number(p.market_value || 0), 0);
  const singleCap = ctx.equity * r.maxTradePct;
  const exposureCap = ctx.equity * r.maxExposure;
  const cryptoCap = ctx.equity * r.cryptoExposure;
  // Budget ordini residuo del giorno: la sessione non può sforare il tetto giornaliero
  const maxNew = Math.max(0, Math.min(C.MAX_ORDERS_PER_DAY, ctx.remainingOrders ?? C.MAX_ORDERS_PER_DAY));
  const universe = [...C.ASSETS, ...C.CRYPTO_ASSETS];

  for (const d of decisions || []) {
    if (!universe.includes(d.asset)) { rejected.push({ ...d, why: "asset fuori universo" }); continue; }
    if (d.action === "hold" || !d.usd || d.usd <= 0) continue;
    if (!isCrypto(d.asset) && ctx.etfSession === "closed") {
      rejected.push({ ...d, why: "weekend: borsa USA chiusa, sono negoziabili solo le crypto" });
      continue;
    }
    if (orders.length >= maxNew) { rejected.push({ ...d, why: "tetto ordini giornaliero raggiunto" }); continue; }

    let notional = Math.min(Number(d.usd) || 0, singleCap);

    if (d.action === "buy") {
      notional = Math.min(notional, cash, Math.max(0, exposureCap - invested));
      if (isCrypto(d.asset)) notional = Math.min(notional, Math.max(0, cryptoCap - cryptoInvested));
      if (notional < 5) { rejected.push({ ...d, why: "sotto il minimo o oltre i limiti di esposizione/liquidità" }); continue; }
      cash -= notional;
      invested += notional;
      if (isCrypto(d.asset)) cryptoInvested += notional;
      orders.push({ symbol: d.asset, side: "buy", notional, reasoning: d.reasoning });
    } else if (d.action === "sell") {
      const pos = ctx.positions.find((p) => p.symbol === d.asset || p.symbol === posKey(d.asset));
      const posValue = pos ? Number(pos.market_value) : 0;
      notional = Math.min(notional, posValue);
      if (notional < 5) { rejected.push({ ...d, why: "posizione assente o insufficiente" }); continue; }
      cash += notional;
      invested -= notional;
      if (isCrypto(d.asset)) cryptoInvested -= notional;
      orders.push({ symbol: d.asset, side: "sell", notional, reasoning: d.reasoning });
    } else {
      rejected.push({ ...d, why: "azione non riconosciuta" });
    }
  }
  return { orders, rejected };
}

module.exports = { clampDecisions };

const express = require("express");
const path = require("path");
const db = require("./db");
const alpaca = require("./alpaca");
const monitor = require("./monitor");
const supervisor = require("./supervisor");
const C = require("./config");

const app = express();
app.use(express.json());

// Autenticazione minimale via token (?token=... o header x-token)
function auth(req, res, next) {
  const t = req.query.token || req.headers["x-token"];
  if (!process.env.DASH_TOKEN || t !== process.env.DASH_TOKEN) {
    return res.status(401).send("Token mancante o non valido");
  }
  next();
}

app.get("/health", (_req, res) => res.send("ok"));

app.get("/", auth, (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.get("/api/state", auth, async (_req, res) => {
  if (!process.env.ALPACA_KEY_ID || !process.env.ALPACA_SECRET_KEY) {
    return res.status(503).send("In attesa delle chiavi Alpaca: aggiungi ALPACA_KEY_ID e ALPACA_SECRET_KEY nelle variabili d'ambiente su Render.");
  }
  try {
    const [account, positions, clock] = await Promise.all([
      alpaca.account(),
      alpaca.positions(),
      alpaca.clock(),
    ]);
    res.json({
      account: {
        equity: Number(account.equity),
        cash: Number(account.cash),
        baseline: db.kvGet("baseline_equity"),
        peak: db.kvGet("equity_peak"),
      },
      market_open: clock.is_open,
      etf_session: monitor.etfSessionNow(clock),
      halted: db.kvGet("halted"),
      trading_enabled: process.env.TRADING_ENABLED === "true",
      risk: monitor.riskProfile(),
      risk_base: process.env.RISK_PROFILE || "bilanciato",
      positions,
      history: db.history(),
      decisions: db.lastDecisions(30).map((d) => ({
        ...d,
        decisions: JSON.parse(d.decisions),
        orders: JSON.parse(d.orders),
      })),
      events: db.lastEvents(30),
      reviews: db.lastReviews(6).map((r) => { try { return { ...r, actions: JSON.parse(r.actions) }; } catch (_) { return r; } }),
      news: db.recentNews(12),
      config: { assets: C.ASSETS, stop: C.GLOBAL_STOP_DRAWDOWN },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Kill switch manuale dal telefono
app.post("/api/halt", auth, (_req, res) => {
  db.kvSet("halted", { reason: "Halt manuale dalla dashboard", ts: Date.now() });
  db.addEvent("halt", { manual: true });
  res.json({ ok: true });
});
app.post("/api/resume", auth, (_req, res) => {
  db.kvSet("halted", null);
  db.kvSet("baseline_equity", null); // rendimento mostrato: riparte dalla ripresa
  db.kvSet("equity_peak", null);    // lo stop trailing riparte dal nuovo picco
  db.addEvent("resume", { manual: true });
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Trading Lab attivo sulla porta ${PORT}`);
  monitor.start();
  supervisor.start(monitor);
});

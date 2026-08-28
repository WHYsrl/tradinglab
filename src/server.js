const express = require("express");
const path = require("path");
const db = require("./db");
const alpaca = require("./alpaca");
const monitor = require("./monitor");
const supervisor = require("./supervisor");
const settings = require("./settings");
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
      trading_enabled: settings.tradingEnabled(),
      risk: monitor.riskProfile(),
      risk_base: settings.riskProfileBase(),
      settings: {
        risk_base: settings.riskProfileBase(),
        model: settings.model(),
        supervisor_model: settings.supervisorModel(),
        supervisor_every_min: settings.supervisorEveryMin(),
        stocks: settings.stocks(),
        risk_override: db.kvGet("risk_override"),
      },
      positions,
      history: db.history(),
      decisions: db.lastDecisions(30).map((d) => ({
        ...d,
        decisions: JSON.parse(d.decisions),
        orders: JSON.parse(d.orders),
      })),
      events: db.lastEvents(30),
      suggestions: db.lastSuggestions(5),
      reviews: db.lastReviews(6).map((r) => { try { return { ...r, actions: JSON.parse(r.actions) }; } catch (_) { return r; } }),
      news: db.recentNews(12),
      config: { assets: C.ASSETS, stop: C.GLOBAL_STOP_DRAWDOWN },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Proposte dell'utente: entrano nella prossima sessione decisionale del motore
app.post("/api/suggest", auth, (req, res) => {
  const text = String((req.body || {}).text || "").trim().slice(0, 500);
  if (!text) return res.status(400).send("testo vuoto");
  db.addSuggestion(text);
  db.addEvent("user_suggestion", { text });
  res.json({ ok: true });
});

// Impostazioni dalla dashboard: salvate nel DB persistente, effetto immediato
app.post("/api/settings", auth, async (req, res) => {
  const b = req.body || {};
  const changes = {};
  if (b.risk_profile !== undefined) {
    if (!C.RISK_PROFILES[b.risk_profile]) return res.status(400).send("profilo non valido");
    db.kvSet("cfg_risk_profile", b.risk_profile);
    changes.risk_profile = b.risk_profile;
  }
  if (b.trading_enabled !== undefined) {
    const v = b.trading_enabled === true || b.trading_enabled === "true";
    db.kvSet("cfg_trading_enabled", v);
    changes.trading_enabled = v;
  }
  if (b.model !== undefined) {
    if (!/^claude-[a-z0-9.-]+$/.test(b.model)) return res.status(400).send("modello non valido");
    db.kvSet("cfg_model", b.model);
    changes.model = b.model;
  }
  if (b.supervisor_model !== undefined) {
    if (!/^claude-[a-z0-9.-]+$/.test(b.supervisor_model)) return res.status(400).send("modello supervisore non valido");
    db.kvSet("cfg_supervisor_model", b.supervisor_model);
    changes.supervisor_model = b.supervisor_model;
  }
  if (b.supervisor_every_min !== undefined) {
    const n = Math.min(240, Math.max(10, Number(b.supervisor_every_min) || 30));
    db.kvSet("cfg_supervisor_every_min", n);
    changes.supervisor_every_min = n;
  }
  if (b.add_stock !== undefined) {
    const sym = String(b.add_stock).trim().toUpperCase();
    if (!/^[A-Z.]{1,6}$/.test(sym)) return res.status(400).send("simbolo non valido");
    const cur = settings.stocks();
    if (cur.includes(sym) || C.ASSETS.includes(sym)) return res.status(400).send(sym + " e gia nel bacino");
    if (cur.length >= C.MAX_STOCKS) return res.status(400).send("bacino pieno (max " + C.MAX_STOCKS + " azioni)");
    let asset;
    try { asset = await alpaca.asset(sym); } catch (_) { return res.status(400).send(sym + ": non trovato su Alpaca"); }
    if (asset.status !== "active" || !asset.tradable) return res.status(400).send(sym + ": non negoziabile su Alpaca");
    if (asset.class && asset.class !== "us_equity") return res.status(400).send(sym + ": non e un titolo azionario USA");
    if (!asset.fractionable) return res.status(400).send(sym + ": non frazionabile, incompatibile con gli ordini in controvalore");
    db.kvSet("cfg_stocks", [...cur, sym]);
    changes.add_stock = sym;
  }
  if (b.remove_stock !== undefined) {
    const sym = String(b.remove_stock).trim().toUpperCase();
    try {
      const positions = await alpaca.positions();
      if (positions.find((p) => p.symbol === sym)) {
        return res.status(400).send(sym + ": posizione aperta, chiudila prima di rimuoverlo dal bacino");
      }
    } catch (_) {}
    db.kvSet("cfg_stocks", settings.stocks().filter((x) => x !== sym));
    changes.remove_stock = sym;
  }
  if (b.clear_derisk) {
    db.kvSet("risk_override", null);
    changes.clear_derisk = true;
  }
  db.addEvent("settings_change", changes);
  res.json({ ok: true, changes });
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

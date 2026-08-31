// ————— Configurazione dell'esperimento —————

module.exports = {
  // Universo azionario: ETF internazionali quotati USA (orario di borsa: 15:30–22:00 ora italiana)
  ASSETS: ["SPY", "QQQ", "EZU", "EWJ", "EEM", "GLD"],
  ASSET_DESC:
    "SPY (S&P 500 USA), QQQ (Nasdaq 100), EZU (Eurozona), EWJ (Giappone), EEM (mercati emergenti), GLD (oro)",

  // Azioni USA singole (mega-cap liquide; soglie trigger più larghe: più volatili degli indici)
  // 42 azioni: con 6 ETF e 2 crypto il paniere totale è di 50 strumenti
  STOCKS: [
    // mega-cap core
    "AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "TSLA", "AVGO", "JPM", "XOM",
    // tech/AI e filiera chip (TSM e ASML sono ADR internazionali)
    "AMD", "TSM", "ASML", "PLTR", "MU", "INTC",
    // software enterprise
    "ORCL", "CRM", "ADBE",
    // salute
    "LLY", "NVO", "UNH", "JNJ", "PFE",
    // consumo e media
    "WMT", "COST", "NFLX", "MCD", "NKE", "DIS",
    // finanza e pagamenti
    "V", "MA", "GS", "BRK.B",
    // industria, difesa, aerospazio, logistica
    "CAT", "RTX", "BA", "GE", "UPS",
    // energia e utility
    "CVX", "NEE",
    // proxy azionario di BTC
    "COIN",
  ],
  STOCK_TRIGGER_MULT: 1.5, // soglia trigger azioni = priceTriggerPct * questo fattore
  MAX_STOCKS: 50, // tetto del bacino azioni modificabile dalla dashboard

  // Universo crypto: negoziabile 24/7 su Alpaca (nelle posizioni compare senza slash: BTCUSD)
  CRYPTO_ASSETS: ["BTC/USD", "ETH/USD"],
  CRYPTO_DESC: "BTC/USD (Bitcoin), ETH/USD (Ethereum) — negoziabili 24/7",
  CRYPTO_NEWS_SYMBOLS: ["BTCUSD", "ETHUSD"],

  // Profili di rischio: limiti HARD applicati dal risk layer, fuori dal controllo dell'AI.
  // stopLossPct: chiusura automatica della posizione sotto -X%.
  // cryptoExposure è un SUB-tetto dentro maxExposure; trigger e stop-loss crypto sono più larghi (volatilità).
  RISK_PROFILES: {
    prudente:   { label: "Prudente",   maxExposure: 0.30, maxTradePct: 0.05, priceTriggerPct: 1.5, stopLossPct: 0.04,
                  cryptoExposure: 0.10, cryptoTriggerPct: 3.0, cryptoStopLossPct: 0.06 },
    bilanciato: { label: "Bilanciato", maxExposure: 0.60, maxTradePct: 0.10, priceTriggerPct: 1.0, stopLossPct: 0.06,
                  cryptoExposure: 0.20, cryptoTriggerPct: 2.5, cryptoStopLossPct: 0.08 },
    aggressivo: { label: "Aggressivo", maxExposure: 0.95, maxTradePct: 0.25, priceTriggerPct: 0.7, stopLossPct: 0.08,
                  cryptoExposure: 0.40, cryptoTriggerPct: 2.0, cryptoStopLossPct: 0.10 },
  },

  // Motore
  MODEL: process.env.MODEL || "claude-opus-5",
  MAX_TOKENS: 4000, // i modelli gen-5 spendono parte del budget in ragionamento interno: serve margine
  // Nota: i modelli di generazione 5 non accettano `temperature` (thinking adattivo integrato)

  // Ritmo del monitor
  TICK_SECONDS: 60,          // frequenza lettura prezzi
  NEWS_EVERY_TICKS: 5,       // notizie ogni 5 tick (~5 min)
  DECISION_COOLDOWN_MIN: 20, // minimo tra due decisioni (salvo emergenza: 2x soglia)
  MAX_ORDERS_PER_DAY: 24,      // default: regolabile dalla dashboard (tarato sul paniere da 50)
  MAX_ORDERS_PER_SESSION: 4,   // una singola sessione non puo bruciare il budget del giorno
  CLOSED_SNAPSHOT_EVERY_TICKS: 5, // a borsa chiusa uno snapshot ogni ~5 min (le crypto si muovono comunque)

  // Supervisore: review periodica con Fable che analizza l'andamento e può SOLO ridurre il rischio
  SUPERVISOR_MODEL: process.env.SUPERVISOR_MODEL || "claude-fable-5",
  SUPERVISOR_EVERY_MIN: Number(process.env.SUPERVISOR_EVERY_MIN) || 30,
  SUPERVISOR_MAX_TOKENS: 3000, // idem: margine per il thinking adattivo

  // Kill switch automatico TRAILING: se l'equity scende oltre X% dal PICCO (high-water mark)
  // il trading si ferma da solo. Protegge anche i profitti accumulati, non solo il capitale iniziale.
  GLOBAL_STOP_DRAWDOWN: 0.20,

  // Sessioni estese ETF (pre-market, after-hours, overnight 24/5): solo ordini limit.
  // Buffer sul prezzo per farsi eseguire in book sottili senza subire slippage arbitrario.
  EXT_LIMIT_BUFFER: 0.002, // 0.2%

  // Barre giornaliere passate al modello come contesto di trend
  TREND_DAYS: 5,

  // Parole chiave per trigger da notizie
  NEWS_KEYWORDS: [
    "fed", "rate", "tassi", "bce", "ecb", "inflation", "cpi", "recession",
    "tariff", "dazio", "war", "crash", "selloff", "default", "opec", "earnings",
    "bitcoin", "btc", "ethereum", "crypto", "stablecoin", "halving", "sec",
  ],
};

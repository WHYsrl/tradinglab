// ————— Configurazione dell'esperimento —————

module.exports = {
  // Universo: ETF internazionali quotati USA (negoziabili su Alpaca)
  ASSETS: ["SPY", "QQQ", "EZU", "EWJ", "EEM", "GLD"],
  ASSET_DESC:
    "SPY (S&P 500 USA), QQQ (Nasdaq 100), EZU (Eurozona), EWJ (Giappone), EEM (mercati emergenti), GLD (oro)",

  // Profili di rischio: limiti HARD applicati dal risk layer, fuori dal controllo dell'AI.
  // stopLossPct: chiusura automatica e deterministica della posizione se il P/L scende sotto -X%.
  RISK_PROFILES: {
    prudente:   { label: "Prudente",   maxExposure: 0.30, maxTradePct: 0.05, priceTriggerPct: 1.5, stopLossPct: 0.04 },
    bilanciato: { label: "Bilanciato", maxExposure: 0.60, maxTradePct: 0.10, priceTriggerPct: 1.0, stopLossPct: 0.06 },
    aggressivo: { label: "Aggressivo", maxExposure: 0.95, maxTradePct: 0.25, priceTriggerPct: 0.7, stopLossPct: 0.08 },
  },

  // Motore
  MODEL: process.env.MODEL || "claude-sonnet-4-6",
  MAX_TOKENS: 1200,
  TEMPERATURE: 0, // decisioni deterministiche e riproducibili: essenziale per l'esperimento

  // Ritmo del monitor
  TICK_SECONDS: 60,          // frequenza lettura prezzi
  NEWS_EVERY_TICKS: 5,       // notizie ogni 5 tick (~5 min)
  DECISION_COOLDOWN_MIN: 20, // minimo tra due decisioni (salvo emergenza: 2x soglia)
  MAX_ORDERS_PER_DAY: 12,
  CLOSED_SNAPSHOT_EVERY_TICKS: 30, // a mercato chiuso uno snapshot ogni ~30 min (l'equity non cambia)

  // Kill switch automatico TRAILING: se l'equity scende oltre X% dal PICCO (high-water mark)
  // il trading si ferma da solo. Protegge anche i profitti accumulati, non solo il capitale iniziale.
  GLOBAL_STOP_DRAWDOWN: 0.20,

  // Barre giornaliere passate al modello come contesto di trend
  TREND_DAYS: 5,

  // Parole chiave per trigger da notizie
  NEWS_KEYWORDS: [
    "fed", "rate", "tassi", "bce", "ecb", "inflation", "cpi", "recession",
    "tariff", "dazio", "war", "crash", "selloff", "default", "opec", "earnings",
  ],
};

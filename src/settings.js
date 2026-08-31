// ————— Impostazioni runtime —————
// Priorità: valore impostato dalla dashboard (kv su disco persistente) > variabile
// d'ambiente > default. Lette a ogni uso: le modifiche hanno effetto immediato.

const db = require("./db");
const C = require("./config");

module.exports = {
  riskProfileBase() {
    const kv = db.kvGet("cfg_risk_profile");
    if (kv && C.RISK_PROFILES[kv]) return kv;
    return C.RISK_PROFILES[process.env.RISK_PROFILE] ? process.env.RISK_PROFILE : "bilanciato";
  },
  tradingEnabled() {
    const kv = db.kvGet("cfg_trading_enabled");
    if (kv === null || kv === undefined) return process.env.TRADING_ENABLED === "true";
    return kv === true;
  },
  model() {
    return db.kvGet("cfg_model") || process.env.MODEL || C.MODEL;
  },
  supervisorModel() {
    return db.kvGet("cfg_supervisor_model") || C.SUPERVISOR_MODEL;
  },
  stocks() {
    const kv = db.kvGet("cfg_stocks");
    if (Array.isArray(kv)) return kv.filter((x) => typeof x === "string");
    return C.STOCKS;
  },
  maxOrdersPerDay() {
    const kv = Number(db.kvGet("cfg_max_orders"));
    if (kv >= 6 && kv <= 60) return kv;
    return C.MAX_ORDERS_PER_DAY;
  },
  supervisorEveryMin() {
    const kv = Number(db.kvGet("cfg_supervisor_every_min"));
    if (kv >= 10 && kv <= 240) return kv;
    return C.SUPERVISOR_EVERY_MIN;
  },
};

// ————— Supervisore: review periodica dell'andamento con Claude Fable —————
// Analizza lo stato dell'esperimento ogni SUPERVISOR_EVERY_MIN minuti e può applicare
// SOLO correttivi conservativi: halt, chiusura posizioni, cancellazione ordini,
// passaggio a profilo più prudente, note al motore. MAI aumentare il rischio,
// MAI riattivare da un halt (la ripresa resta manuale dalla dashboard).

const C = require("./config");
const db = require("./db");
const alpaca = require("./alpaca");
const settings = require("./settings");
const anthropic = require("./anthropic");

let running = false;
const PRUDENCE_ORDER = ["prudente", "bilanciato", "aggressivo"];

function fmtPct(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return "n/d";
  return (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
}

function buildPrompt(s) {
  const posList = s.positions.length
    ? s.positions.map((p) =>
        `- ${p.symbol}: ${Number(p.qty)} @ ${Number(p.avg_entry_price)} → valore ${Number(p.market_value).toFixed(0)} USD, P/L ${fmtPct(Number(p.unrealized_plpc) * 100)}`
      ).join("\n")
    : "- nessuna posizione aperta";
  const evList = s.newEvents.length
    ? s.newEvents.map((e) => `- [${new Date(e.ts).toISOString().slice(0, 16)}] ${e.type}: ${(e.data || "").slice(0, 160)}`).join("\n")
    : "- nessun evento dall'ultima review";

  return `Sei il SUPERVISORE indipendente di un ESPERIMENTO di trading AI su conto PAPER Alpaca (nessun denaro reale).
Un motore decisionale separato apre e chiude posizioni su trigger; un risk layer deterministico applica i limiti hard.
Il tuo compito: valutare l'andamento con occhio critico e applicare SOLO correttivi conservativi, se davvero necessari.

STATO:
- Equity: ${s.equity.toFixed(2)} USD (da inizio esperimento ${fmtPct(s.retFromBaseline)}, dal picco ${fmtPct(s.retFromPeak)}, dall'ultima review ${fmtPct(s.retFromLastReview)})
- Liquidità: ${s.cash.toFixed(2)} USD · Profilo: ${s.profile}${s.override ? ` (ridotto dal supervisore, base ${s.baseProfile})` : ""}
- Sessione ETF: ${s.etfSession} · Trading: ${s.halted ? "IN HALT: " + (s.haltReason || "") : s.tradingEnabled ? "attivo" : "solo monitor"}

POSIZIONI:
${posList}

ULTIME DECISIONI DEL MOTORE (con esito):
${s.lastDecisionsSummary || "- nessuna"}

EVENTI DALL'ULTIMA REVIEW:
${evList}

I tuoi poteri sono limitati per design — puoi solo RIDURRE il rischio, mai aumentarlo:
- "halt": ferma il trading (la ripresa è solo manuale dell'utente)
- "close_position": chiude una posizione specifica (campo "symbol")
- "cancel_orders": cancella gli ordini limit pendenti
- "derisk_profile": passa a un profilo più prudente (campo "profile": "prudente" o "bilanciato")
- "note_to_engine": lascia un'indicazione operativa al motore per le prossime sessioni (campo "note", max 2 frasi)
Nessuna azione è quasi sempre la risposta giusta: intervieni solo con motivazioni concrete (perdite anomale, comportamento incoerente del motore, concentrazione eccessiva, errori ripetuti).

Rispondi SOLO con JSON valido, nessun testo prima o dopo:
{"assessment":"valutazione critica in 2-4 frasi","risk_flag":"ok|warning|critical","actions":[{"type":"halt|close_position|cancel_orders|derisk_profile|note_to_engine","symbol":"","profile":"","note":"","reason":"perché"}]}
Se non serve nulla: "actions": [].`;
}

function extractJSON(text) {
  const clean = text.replace(/```json|```/g, "");
  const m = clean.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("Nessun JSON nella risposta del supervisore");
  return JSON.parse(m[0]);
}

async function callFable(prompt) {
  const data = await anthropic.call({
    model: settings.supervisorModel(),
    maxTokens: C.SUPERVISOR_MAX_TOKENS,
    prompt,
  });
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  return { parsed: extractJSON(text), raw: text };
}

// Esecutore deterministico: applica solo le azioni dell'allowlist, mai oltre
async function applyActions(actions, s) {
  const applied = [];
  for (const a of (actions || []).slice(0, 5)) {
    try {
      if (a.type === "halt") {
        db.kvSet("halted", { reason: `Supervisore: ${a.reason || "review"}`, ts: Date.now() });
        db.addEvent("halt", { by: "supervisor", reason: a.reason });
        applied.push({ ...a, ok: true });
      } else if (a.type === "close_position") {
        const pos = s.positions.find((p) => p.symbol === a.symbol || p.symbol === String(a.symbol || "").replace("/", ""));
        if (!pos) { applied.push({ ...a, ok: false, why: "posizione non trovata" }); continue; }
        await alpaca.closePosition(pos.symbol);
        db.addEvent("supervisor_close", { symbol: pos.symbol, reason: a.reason });
        applied.push({ ...a, ok: true });
      } else if (a.type === "cancel_orders") {
        await alpaca.cancelOpenOrders();
        applied.push({ ...a, ok: true });
      } else if (a.type === "derisk_profile") {
        const target = a.profile;
        if (!C.RISK_PROFILES[target] ||
            PRUDENCE_ORDER.indexOf(target) >= PRUDENCE_ORDER.indexOf(s.profile)) {
          applied.push({ ...a, ok: false, why: "solo profili più prudenti di quello attuale" });
          continue;
        }
        db.kvSet("risk_override", target);
        db.addEvent("supervisor_derisk", { from: s.profile, to: target, reason: a.reason });
        applied.push({ ...a, ok: true });
      } else if (a.type === "note_to_engine") {
        if (a.note) {
          db.kvSet("supervisor_note", { text: String(a.note).slice(0, 400), ts: Date.now() });
          applied.push({ ...a, ok: true });
        }
      }
    } catch (e) {
      applied.push({ ...a, ok: false, why: e.message });
      db.addEvent("error", { where: "supervisor_action", action: a, msg: e.message });
    }
  }
  return applied;
}

async function reviewOnce(monitor) {
  if (running) return;
  running = true;
  try {
    if (!process.env.ALPACA_KEY_ID || !process.env.ALPACA_SECRET_KEY || !process.env.ANTHROPIC_API_KEY) return;

    const [clock, account, positions] = await Promise.all([alpaca.clock(), alpaca.account(), alpaca.positions()]);
    const equity = Number(account.equity);
    const cash = Number(account.cash);
    const baseline = db.kvGet("baseline_equity") || equity;
    const peak = db.kvGet("equity_peak", baseline);
    const lastReviewTs = db.kvGet("last_review_ts", 0);
    const lastReviewEquity = db.kvGet("last_review_equity", equity);
    const halted = db.kvGet("halted");
    const override = db.kvGet("risk_override");
    const baseProfile = settings.riskProfileBase();
    const profile = monitor.riskProfile();

    const sinceHours = Math.max(0.6, (Date.now() - lastReviewTs) / 3600000);
    const newEvents = db.lastEvents(40).filter((e) => e.ts > lastReviewTs && e.type !== "boot");
    const newDecisions = db.lastDecisions(5).filter((d) => d.ts > lastReviewTs);
    const equityChg = lastReviewEquity ? (equity / lastReviewEquity - 1) * 100 : 0;

    // Gate: se non c'è nulla da guardare, salta la chiamata (il registro lo dice comunque)
    const quiet = positions.length === 0 && newDecisions.length === 0 && newEvents.length === 0 && Math.abs(equityChg) < 0.1;
    if (quiet) {
      db.addReview(true, "ok", "Nessuna attività dall'ultima review: nulla da valutare.", [], "");
      db.kvSet("last_review_ts", Date.now());
      db.kvSet("last_review_equity", equity);
      return;
    }

    const prices = {};
    try {
      const md = await alpaca.marketData([...C.ASSETS, ...settings.stocks()], C.CRYPTO_ASSETS);
      Object.assign(prices, md.prices);
    } catch (_) {}

    const s = {
      equity, cash, positions,
      retFromBaseline: (equity / baseline - 1) * 100,
      retFromPeak: (equity / peak - 1) * 100,
      retFromLastReview: equityChg,
      profile, baseProfile, override,
      etfSession: monitor.etfSessionNow(clock),
      halted: !!halted,
      haltReason: halted && halted.reason,
      tradingEnabled: settings.tradingEnabled(),
      lastDecisionsSummary: monitor.decisionsWithOutcome ? monitor.decisionsWithOutcome(prices) : "",
      newEvents,
      sinceHours,
    };

    const { parsed, raw } = await callFable(buildPrompt(s));
    const applied = await applyActions(parsed.actions, s);
    db.addReview(false, parsed.risk_flag || "ok", parsed.assessment || "", applied, raw);
    db.kvSet("last_review_ts", Date.now());
    db.kvSet("last_review_equity", equity);
  } catch (e) {
    db.addEvent("error", { where: "supervisor", msg: e.message });
  } finally {
    running = false;
  }
}

// Fuori orario regolare le review rallentano: x2 in sessione estesa, x4 nel weekend
function paceMultiplier() {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date());
  const wd = p.find((x) => x.type === "weekday").value;
  const mins = +p.find((x) => x.type === "hour").value * 60 + +p.find((x) => x.type === "minute").value;
  const weekend = wd === "Sat" || (wd === "Sun" && mins < 20 * 60) || (wd === "Fri" && mins >= 20 * 60);
  if (weekend) return 4;
  const regular = wd !== "Sun" && mins >= 9 * 60 + 30 && mins < 16 * 60;
  return regular ? 1 : 2;
}

function schedule(monitor) {
  // cadenza letta a ogni giro: modificabile dalla dashboard senza riavvio
  setTimeout(async () => { await reviewOnce(monitor); schedule(monitor); }, settings.supervisorEveryMin() * paceMultiplier() * 60 * 1000);
}

function start(monitor) {
  // prima review dopo 3 minuti dal boot, poi a cadenza regolare
  setTimeout(async () => { await reviewOnce(monitor); schedule(monitor); }, 3 * 60 * 1000);
}

module.exports = { start };

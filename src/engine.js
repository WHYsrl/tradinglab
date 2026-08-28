const C = require("./config");

function fmtPct(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "n/d";
  const v = Number(n);
  return (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
}

function buildPrompt(ctx) {
  const r = C.RISK_PROFILES[ctx.risk];

  // Quadro di mercato: prezzo, variazione odierna CON SEGNO e trend a N giorni
  const marketLines = Object.entries(ctx.market || {})
    .map(([s, m]) =>
      `- ${s}: ${m.price != null ? m.price + " USD" : "n/d"} · oggi ${fmtPct(m.changePct)} · ultimi ${C.TREND_DAYS} giorni ${fmtPct(m.trendPct)}`
    )
    .join("\n");

  // Posizioni "slim": solo i campi che servono alla decisione
  const positions = (ctx.positions || []).map((p) => ({
    symbol: p.symbol,
    qty: Number(p.qty),
    avg_entry: Number(p.avg_entry_price),
    market_value: Number(p.market_value),
    upl_pct: fmtPct(Number(p.unrealized_plpc) * 100),
  }));

  const newsList = ctx.news.length
    ? ctx.news.map((n) => `- [${new Date(n.ts).toISOString().slice(0, 16)}] ${n.headline}`).join("\n")
    : "- nessuna notizia rilevante nelle ultime ore";

  return `Sei il motore decisionale di un ESPERIMENTO di trading su conto PAPER (nessun denaro reale).
Universo: ETF internazionali — ${C.ASSET_DESC} — e crypto — ${C.CRYPTO_DESC}.

MOTIVO DI QUESTA SESSIONE: ${ctx.trigger}
${ctx.etfSession === "extended" ? "\nBORSA USA IN SESSIONE ESTESA (pre-market/after-hours/overnight): gli ordini ETF verranno piazzati come limit; liquidità ridotta e spread più ampi — opera sugli ETF solo con segnale forte." : ""}${ctx.etfSession === "closed" ? "\nWEEKEND: borsa USA chiusa, sono eseguibili solo ordini crypto; per gli ETF usa hold." : ""}

MERCATO:
${marketLines}

PORTAFOGLIO:
- Equity: ${ctx.equity.toFixed(2)} USD, liquidità: ${ctx.cash.toFixed(2)} USD
- Posizioni: ${JSON.stringify(positions)}
- Profilo di rischio: ${r.label} → esposizione max ${r.maxExposure * 100}% dell'equity, singola operazione max ${r.maxTradePct * 100}% (${(ctx.equity * r.maxTradePct).toFixed(0)} USD)
- Stop-loss automatico (lo applica il sistema, non devi gestirlo tu): -${r.stopLossPct * 100}% sugli ETF, -${r.cryptoStopLossPct * 100}% sulle crypto
- Crypto: esposizione massima ${r.cryptoExposure * 100}% dell'equity (sub-tetto dentro l'esposizione totale)
- Ordini ancora disponibili oggi: ${ctx.remainingOrders}

ULTIME DECISIONI E COME SONO ANDATE: ${ctx.lastDecisionsSummary || "nessuna"}
${ctx.supervisorNote ? "\nINDICAZIONE DEL SUPERVISORE (review periodica indipendente): " + ctx.supervisorNote : ""}
${ctx.stopLossNote ? "\nATTENZIONE: " + ctx.stopLossNote + "\n" : ""}
NOTIZIE RECENTI:
${newsList}

Valuta il quadro e decidi. L'orizzonte è tattico (ore/giorni), non scalping. Operare non è obbligatorio: se il segnale è debole, hold è la scelta corretta — l'iperattività distrugge rendimento. Usa gli esiti delle decisioni passate riportati sopra per correggere la rotta.

Rispondi SOLO con JSON valido, nessun testo prima o dopo:
{"view":"quadro di mercato in 1-2 frasi","decisions":[{"asset":"SPY","action":"buy|sell|hold","usd":0,"reasoning":"motivazione breve"}]}
"usd" è il controvalore dell'operazione (0 se hold). I simboli crypto vanno scritti esattamente "BTC/USD" o "ETH/USD". Rispetta i limiti del profilo di rischio.`;
}

function extractJSON(text) {
  const clean = text.replace(/```json|```/g, "");
  const m = clean.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("Nessun JSON nella risposta del modello");
  return JSON.parse(m[0]);
}

async function decide(ctx) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: C.MODEL,
      max_tokens: C.MAX_TOKENS,
      messages: [{ role: "user", content: buildPrompt(ctx) }],
    }),
  });
  if (!res.ok) throw new Error(`API Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  return { parsed: extractJSON(text), raw: text };
}

module.exports = { decide };

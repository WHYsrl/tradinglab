# Trading Lab — esperimento di trading AI event-driven

Sistema autonomo che monitora prezzi e notizie sui mercati internazionali (ETF USA: SPY, QQQ, EZU, EWJ, EEM, GLD), e chiama Claude come motore decisionale **solo quando succede qualcosa**: movimento di prezzo oltre soglia, notizia rilevante, o check-in programmati (apertura, metà seduta, pre-chiusura). Gli ordini vengono eseguiti su conto **Alpaca paper** (denaro virtuale) e passano da un risk layer deterministico che l'AI non può scavalcare.

## Architettura

- `src/monitor.js` — loop ogni 60s: prezzi, notizie (ogni 5 min), trigger (con direzione del movimento), stop-loss automatico per posizione, kill switch trailing
- `src/engine.js` — chiamata all'API Claude (temperature 0) con quadro di mercato completo: prezzi, variazione odierna con segno, trend a 5 giorni, P/L delle decisioni passate → JSON operativo
- `src/risk.js` — limiti hard: esposizione max, size max per operazione, tetto ordini/giorno (budget residuo applicato anche dentro la singola sessione)
- `src/alpaca.js` — dati di mercato, notizie e ordini (conto paper)
- `src/server.js` + `public/index.html` — dashboard mobile con equity curve, registro decisioni e kill switch manuale
- `src/db.js` — SQLite su disco persistente: ogni snapshot, decisione e motivazione viene salvata (è il dataset dell'esperimento)

## Prerequisiti

1. **Account Alpaca** (alpaca.markets) → dalla dashboard genera le chiavi **Paper Trading** (`ALPACA_KEY_ID`, `ALPACA_SECRET_KEY`). Il conto paper parte con capitale virtuale configurabile.
2. **Chiave API Anthropic** (console.anthropic.com) → `ANTHROPIC_API_KEY`.
3. **Repo GitHub**: https://github.com/WHYsrl/tradinglab (privato).

## Deploy su Render

1. Su render.com → **New → Blueprint** → collega il repo: il file `render.yaml` configura tutto (web service Starter + disco persistente da 1 GB montato su `/data`).
2. Inserisci le variabili d'ambiente richieste:
   - `ANTHROPIC_API_KEY`
   - `ALPACA_KEY_ID`, `ALPACA_SECRET_KEY`
   - `DASH_TOKEN` → una stringa lunga a tua scelta: è la password della dashboard
   - `RISK_PROFILE` → `prudente` | `bilanciato` | `aggressivo`
   - `TRADING_ENABLED` → `true` (con `false` il sistema monitora e logga ma non ordina: utile i primi giorni)
3. Al termine del deploy apri: `https://<nome-servizio>.onrender.com/?token=<DASH_TOKEN>`

Costo indicativo: istanza Starter ~7 $/mese + disco ~0,25 $/mese + consumo API Anthropic (event-driven: pochi euro/mese).

## Sicurezza e limiti (non negoziabili)

- **Stop globale automatico TRAILING**: se l'equity scende oltre il drawdown massimo (default −20% dal picco di equity, high-water mark) il trading si ferma da solo; si riparte solo manualmente dalla dashboard. Protegge anche i profitti accumulati.
- **Stop-loss automatico per posizione**: −4% (prudente) / −6% (bilanciato) / −8% (aggressivo). Chiusura deterministica eseguita dal monitor, fuori dal controllo dell'AI; non conta nel tetto ordini giornaliero.
- **Cooldown**: minimo 20 minuti tra due sessioni decisionali (salvo emergenza: movimento ≥ 2× soglia).
- **Tetto ordini**: massimo 12 al giorno.
- Il risk layer taglia qualunque ordine oltre i limiti del profilo, qualunque cosa dica il modello.

## Metodo sperimentale suggerito

- Prima settimana con `TRADING_ENABLED=false`: verifichi trigger e qualità delle analisi senza operare.
- Poi attiva e non toccare i parametri per blocchi di 2–4 settimane, così i dati sono comparabili.
- Il braccio "umano" dell'esperimento: apri un secondo conto paper Alpaca e gestiscilo tu con le stesse regole (stesso universo, stessi limiti); il confronto sarà diretto sulle stesse condizioni di mercato.
- Fase 3 (denaro reale): identico codice puntato su `api.alpaca.markets` invece di `paper-api` — da fare solo dopo settimane di dati paper e con una somma che sei disposto a perdere interamente.

## Disclaimer

Progetto sperimentale. Non è consulenza finanziaria; nessuna garanzia di rendimento. I mercati azionari hanno orari: fuori sessione il sistema monitora le notizie e decide alla riapertura.

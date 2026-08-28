# Trading Lab — esperimento di trading AI event-driven

Sistema autonomo che monitora prezzi e notizie su ETF internazionali (SPY, QQQ, EZU, EWJ, EEM, GLD), azioni USA mega-cap (AAPL, MSFT, NVDA, GOOGL, AMZN, META, TSLA, AVGO, JPM, XOM) e crypto (BTC/USD, ETH/USD, 24/7), e chiama Claude come motore decisionale **solo quando succede qualcosa**: movimento di prezzo oltre soglia, notizia rilevante, o check-in programmati (apertura, metà seduta, pre-chiusura). Gli ordini vengono eseguiti su conto **Alpaca paper** (denaro virtuale) e passano da un risk layer deterministico che l'AI non può scavalcare.

## Architettura

- `src/monitor.js` — loop ogni 60s: prezzi, notizie (ogni 5 min), trigger (con direzione del movimento), stop-loss automatico per posizione, kill switch trailing
- `src/engine.js` — chiamata all'API Claude (temperature 0) con quadro di mercato completo: prezzi, variazione odierna con segno, trend a 5 giorni, P/L delle decisioni passate → JSON operativo
- `src/risk.js` — limiti hard: esposizione max, size max per operazione, tetto ordini/giorno (budget residuo applicato anche dentro la singola sessione)
- `src/alpaca.js` — dati di mercato, notizie e ordini (conto paper)
- `src/supervisor.js` — review periodica (default ogni 30 min) con Claude Fable: valuta l'andamento e può applicare SOLO correttivi conservativi (halt, chiusura posizioni, cancellazione ordini, profilo più prudente, note al motore); salta la chiamata quando non c'è attività
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
4. Da quel momento profilo di rischio, trading on/off, modelli e cadenza delle review si regolano **dalla dashboard** (card Impostazioni): salvate nel DB persistente, effetto immediato senza riavvio. Le variabili d'ambiente restano solo come default iniziali.

Costo indicativo: istanza Starter ~7 $/mese + disco ~0,25 $/mese + consumo API Anthropic (event-driven: pochi euro/mese).

## Sicurezza e limiti (non negoziabili)

- **Stop globale automatico TRAILING**: se l'equity scende oltre il drawdown massimo (default −20% dal picco di equity, high-water mark) il trading si ferma da solo; si riparte solo manualmente dalla dashboard. Protegge anche i profitti accumulati.
- **Stop-loss automatico per posizione**: ETF −4% / −6% / −8% e crypto −6% / −8% / −10% (prudente / bilanciato / aggressivo). Chiusura deterministica eseguita dal monitor, fuori dal controllo dell'AI; non conta nel tetto ordini giornaliero.
- **Cooldown**: minimo 20 minuti tra due sessioni decisionali (salvo emergenza: movimento ≥ 2× soglia).
- **Tetto ordini**: massimo 12 al giorno.
- **Crypto**: sub-tetto di esposizione (10% / 20% / 40% dell'equity per profilo), trigger di prezzo più larghi (3% / 2.5% / 2%) e trading 24/7.
- **ETF 24/5**: fuori dall'orario regolare (pre-market, after-hours e sessione overnight, da domenica sera a venerdì sera ora di New York) gli ordini ETF vengono piazzati come limit con `extended_hours` e un piccolo buffer di prezzo (0,2%); liquidità ridotta, il modello ne è avvisato. Nel weekend restano negoziabili solo le crypto. I limit non eseguiti vengono cancellati all'inizio della sessione decisionale successiva.
- **Supervisore Fable**: può solo ridurre il rischio, mai aumentarlo; la ripresa da un halt resta manuale. Modello e cadenza configurabili via `SUPERVISOR_MODEL` / `SUPERVISOR_EVERY_MIN`.
- Il risk layer taglia qualunque ordine oltre i limiti del profilo, qualunque cosa dica il modello.

## Proposte dell'utente

Dalla dashboard (card "Chiedi al motore") puoi proporre operazioni o fare domande ("non è il caso di comprare Apple in vista del keynote?"). La proposta fa partire una sessione decisionale alla prima occasione utile (scavalca il cooldown, non i limiti di rischio): il motore la valuta esplicitamente, risponde nella dashboard e decide in autonomia — non è obbligato ad assecondarla, e il risk layer si applica comunque.

## Metodo sperimentale suggerito

- Prima settimana con `TRADING_ENABLED=false`: verifichi trigger e qualità delle analisi senza operare.
- Poi attiva e non toccare i parametri per blocchi di 2–4 settimane, così i dati sono comparabili.
- Il braccio "umano" dell'esperimento: apri un secondo conto paper Alpaca e gestiscilo tu con le stesse regole (stesso universo, stessi limiti); il confronto sarà diretto sulle stesse condizioni di mercato.
- Fase 3 (denaro reale): identico codice puntato su `api.alpaca.markets` invece di `paper-api` — da fare solo dopo settimane di dati paper e con una somma che sei disposto a perdere interamente.

## Disclaimer

Progetto sperimentale. Non è consulenza finanziaria; nessuna garanzia di rendimento. Gli ETF sono negoziabili quasi 24/5 (sessioni estese con ordini limit); nel weekend restano solo le crypto.

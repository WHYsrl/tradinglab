const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "lab.sqlite"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS snapshots (
  ts INTEGER PRIMARY KEY,
  equity REAL, cash REAL, prices TEXT
);
CREATE TABLE IF NOT EXISTS decisions (
  ts INTEGER PRIMARY KEY,
  trigger TEXT, view TEXT, decisions TEXT, orders TEXT, raw TEXT
);
CREATE TABLE IF NOT EXISTS events (
  ts INTEGER, type TEXT, data TEXT
);
CREATE TABLE IF NOT EXISTS news (
  url TEXT PRIMARY KEY, ts INTEGER, headline TEXT, symbols TEXT
);
CREATE TABLE IF NOT EXISTS reviews (
  ts INTEGER PRIMARY KEY, skipped INTEGER, flag TEXT, assessment TEXT, actions TEXT, raw TEXT
);
CREATE TABLE IF NOT EXISTS suggestions (
  ts INTEGER PRIMARY KEY, text TEXT, status TEXT, answer TEXT, answered_ts INTEGER
);
`);

module.exports = {
  kvGet(key, fallback = null) {
    const r = db.prepare("SELECT value FROM kv WHERE key=?").get(key);
    return r ? JSON.parse(r.value) : fallback;
  },
  kvSet(key, value) {
    db.prepare(
      "INSERT INTO kv (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    ).run(key, JSON.stringify(value));
  },
  addSnapshot(equity, cash, prices) {
    db.prepare("INSERT OR REPLACE INTO snapshots VALUES (?,?,?,?)").run(
      Date.now(), equity, cash, JSON.stringify(prices)
    );
  },
  addDecision(trigger, view, decisions, orders, raw) {
    db.prepare("INSERT OR REPLACE INTO decisions VALUES (?,?,?,?,?,?)").run(
      Date.now(), trigger, view, JSON.stringify(decisions), JSON.stringify(orders), raw
    );
  },
  addEvent(type, data) {
    db.prepare("INSERT INTO events VALUES (?,?,?)").run(Date.now(), type, JSON.stringify(data));
  },
  addNews(items) {
    const ins = db.prepare("INSERT OR IGNORE INTO news VALUES (?,?,?,?)");
    let fresh = [];
    for (const n of items) {
      const r = ins.run(n.url || `${n.headline}-${n.ts}`, n.ts, n.headline, JSON.stringify(n.symbols || []));
      if (r.changes > 0) fresh.push(n);
    }
    return fresh;
  },
  recentNews(hours = 12) {
    return db
      .prepare("SELECT * FROM news WHERE ts > ? ORDER BY ts DESC LIMIT 20")
      .all(Date.now() - hours * 3600 * 1000);
  },
  history(limitPoints = 500) {
    const rows = db.prepare("SELECT ts, equity FROM snapshots ORDER BY ts").all();
    if (rows.length <= limitPoints) return rows;
    const step = Math.ceil(rows.length / limitPoints);
    return rows.filter((_, i) => i % step === 0 || i === rows.length - 1);
  },
  historySince(fromTs, limitPoints = 400) {
    const rows = db.prepare("SELECT ts, equity FROM snapshots WHERE ts >= ? ORDER BY ts").all(fromTs || 0);
    if (rows.length <= limitPoints) return rows;
    const step = Math.ceil(rows.length / limitPoints);
    return rows.filter((_, i) => i % step === 0 || i === rows.length - 1);
  },
  lastDecisions(n = 30) {
    return db.prepare("SELECT * FROM decisions ORDER BY ts DESC LIMIT ?").all(n);
  },
  lastEvents(n = 50) {
    return db.prepare("SELECT * FROM events ORDER BY ts DESC LIMIT ?").all(n);
  },
  eventsSince(type, hours = 24) {
    return db
      .prepare("SELECT * FROM events WHERE type=? AND ts>? ORDER BY ts DESC")
      .all(type, Date.now() - hours * 3600 * 1000);
  },
  addSuggestion(text) {
    db.prepare("INSERT INTO suggestions (ts, text, status) VALUES (?,?,?)").run(Date.now(), text, "pending");
  },
  pendingSuggestions() {
    return db.prepare("SELECT * FROM suggestions WHERE status='pending' ORDER BY ts").all();
  },
  answerSuggestions(tsList, answer) {
    const up = db.prepare("UPDATE suggestions SET status='answered', answer=?, answered_ts=? WHERE ts=?");
    for (const t of tsList) up.run(answer, Date.now(), t);
  },
  lastSuggestions(n = 5) {
    return db.prepare("SELECT * FROM suggestions ORDER BY ts DESC LIMIT ?").all(n);
  },
  addReview(skipped, flag, assessment, actions, raw) {
    db.prepare("INSERT OR REPLACE INTO reviews VALUES (?,?,?,?,?,?)").run(
      Date.now(), skipped ? 1 : 0, flag || "", assessment || "", JSON.stringify(actions || []), raw || ""
    );
  },
  lastReviews(n = 10) {
    return db.prepare("SELECT * FROM reviews ORDER BY ts DESC LIMIT ?").all(n);
  },
  // Snapshot più vicino (a ritroso) a un istante: serve a valutare l'esito delle decisioni passate
  snapshotNear(ts) {
    return db.prepare("SELECT * FROM snapshots WHERE ts<=? ORDER BY ts DESC LIMIT 1").get(ts);
  },
};

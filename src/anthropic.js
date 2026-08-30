// Client API Anthropic con retry: i 5xx (es. "credential validation failed"), i 429
// e gli errori di rete sono transitori — si riprova fino a 3 volte con backoff.
async function call({ model, maxTokens, prompt }) {
  let lastErr;
  for (const wait of [0, 2000, 8000]) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    let res;
    try {
      res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          messages: [{ role: "user", content: prompt }],
        }),
      });
    } catch (e) {
      lastErr = e; // errore di rete: riprova
      continue;
    }
    if (res.ok) return res.json();
    const txt = (await res.text()).slice(0, 300);
    lastErr = new Error(`API Anthropic ${res.status}: ${txt}`);
    if (res.status < 500 && res.status !== 429) break; // 4xx: non transitorio, inutile riprovare
  }
  throw lastErr;
}

module.exports = { call };

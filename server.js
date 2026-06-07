const express = require('express');
const webpush = require('web-push');
const cron = require('node-cron');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const VAPID_PUBLIC  = 'BJ7mqVu3GlhVulKYmRnFT8OZgCMPwvBWarO3ASRXev2gUSQWcmzgsl1ELhH1jQhIfwCsy2Npu0w59cywSkAtGUQ';
const VAPID_PRIVATE = '_uaYQFALkREgxlJ6OyR8j1qqWM2aIOgMDki4vxfe_kE';
webpush.setVapidDetails('mailto:din@epost.no', VAPID_PUBLIC, VAPID_PRIVATE);

const FINNHUB_KEY = process.env.FINNHUB_KEY || 'DIN_FINNHUB_NOKKEL';
const GROQ_KEY    = process.env.GROQ_KEY    || '';

const subscriptions = {};
const alerts = {};

// ─── GROQ AI KALL ─────────────────────────────
async function askGroq(prompt, maxTokens = 1200) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROQ_KEY}`
    },
    body: JSON.stringify({
      model: 'llama3-8b-8192',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

// ─── LIVE PRIS ────────────────────────────────
async function getLivePrice(ticker) {
  try {
    const res  = await fetch(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${FINNHUB_KEY}`);
    const data = await res.json();
    return { price: data.c, prevClose: data.pc, change: data.d, changePct: data.dp };
  } catch (e) { return null; }
}

// ─── SEND PUSH ────────────────────────────────
async function sendPush(subscription, title, body, data = {}) {
  try {
    await webpush.sendNotification(subscription, JSON.stringify({ title, body, ...data }));
  } catch (e) { console.error('Push feil:', e.message); }
}

// ─── AI NYHETER ───────────────────────────────
app.post('/ai-news', async (req, res) => {
  const { ticker, company } = req.body;
  if (!ticker) return res.status(400).json({ error: 'Mangler ticker' });
  try {
    const raw = await askGroq(`Du er senior finansanalytiker. Gi nyheter og analyse for: "${company}" (${ticker}).

Svar KUN med rent JSON (ingen markdown, ingen tekst utenfor JSON):
{
  "company": "${company}",
  "ticker": "${ticker}",
  "currentSituation": "2 setninger norsk om markedssituasjon.",
  "priceOutlook": "2-3 setninger norsk om mulig prisutvikling.",
  "signals": ["BULL: årsak","BEAR: årsak"],
  "news": [
    {"title":"Overskrift","source":"Kilde","time":"${new Date().toISOString()}","summary":"1-2 setninger norsk","sentiment":"positive|negative|neutral"}
  ]
}
Lag 3 realistiske nyheter.`);
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    res.json(parsed);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── AI SELSKAPSNAVN ──────────────────────────
app.post('/ai-name', async (req, res) => {
  const { ticker } = req.body;
  if (!ticker) return res.json({ name: ticker });
  try {
    const name = await askGroq(`Full company name for stock ticker "${ticker}"? Reply with ONLY the name, nothing else.`, 80);
    res.json({ name: name.trim().split('\n')[0] });
  } catch (e) {
    res.json({ name: ticker });
  }
});

// ─── PRIS ─────────────────────────────────────
app.get('/price/:ticker', async (req, res) => {
  const data = await getLivePrice(req.params.ticker.toUpperCase());
  if (!data) return res.status(500).json({ error: 'Kunne ikke hente pris' });
  res.json(data);
});

// ─── PUSH ENDEPUNKTER ─────────────────────────
app.get('/vapid-key', (req, res) => res.json({ publicKey: VAPID_PUBLIC }));

app.post('/subscribe', (req, res) => {
  const { deviceId, subscription } = req.body;
  if (!deviceId || !subscription) return res.status(400).json({ error: 'Mangler data' });
  subscriptions[deviceId] = subscription;
  if (!alerts[deviceId]) alerts[deviceId] = [];
  res.json({ ok: true });
});

app.post('/alerts', (req, res) => {
  const { deviceId, ticker, alertUp, alertDown } = req.body;
  if (!deviceId || !ticker) return res.status(400).json({ error: 'Mangler data' });
  if (!alerts[deviceId]) alerts[deviceId] = [];
  alerts[deviceId] = alerts[deviceId].filter(a => a.ticker !== ticker.toUpperCase());
  alerts[deviceId].push({ ticker: ticker.toUpperCase(), alertUp: alertUp ? parseFloat(alertUp) : null, alertDown: alertDown ? parseFloat(alertDown) : null, triggeredUp: false, triggeredDown: false });
  res.json({ ok: true });
});

app.delete('/alerts/:deviceId/:ticker', (req, res) => {
  const { deviceId, ticker } = req.params;
  if (alerts[deviceId]) alerts[deviceId] = alerts[deviceId].filter(a => a.ticker !== ticker.toUpperCase());
  res.json({ ok: true });
});

app.get('/alerts/:deviceId', (req, res) => res.json({ alerts: alerts[req.params.deviceId] || [] }));

app.post('/test-push', async (req, res) => {
  const sub = subscriptions[req.body.deviceId];
  if (!sub) return res.status(404).json({ error: 'Ingen abonnement funnet' });
  await sendPush(sub, 'MarketPulse er klar!', 'Push-varsler fungerer!');
  res.json({ ok: true });
});

app.get('/status', (req, res) => res.json({ status: 'MarketPulse server kjoerer' }));

// ─── PRIS-VARSLER (hvert minutt) ──────────────
cron.schedule('* * * * *', async () => {
  for (const [deviceId, deviceAlerts] of Object.entries(alerts)) {
    const sub = subscriptions[deviceId];
    if (!sub) continue;
    for (const alert of deviceAlerts) {
      const pd = await getLivePrice(alert.ticker);
      if (!pd || !pd.price) continue;
      const price = pd.price;
      if (alert.alertUp && price >= alert.alertUp && !alert.triggeredUp) {
        alert.triggeredUp = true;
        await sendPush(sub, `🚀 ${alert.ticker} nådde $${alert.alertUp}!`, `Nåværende pris: $${price.toFixed(2)}`, { ticker: alert.ticker, type: 'TARGET_HIT' });
      }
      if (alert.alertUp && price < alert.alertUp * 0.995) alert.triggeredUp = false;
      if (alert.alertDown && price <= alert.alertDown && !alert.triggeredDown) {
        alert.triggeredDown = true;
        await sendPush(sub, `⚠️ ${alert.ticker} falt under $${alert.alertDown}`, `Nåværende pris: $${price.toFixed(2)}`, { ticker: alert.ticker, type: 'STOP_HIT' });
      }
      if (alert.alertDown && price > alert.alertDown * 1.005) alert.triggeredDown = false;
    }
  }
});

// ─── MORGENRAPPORT kl 09:00 ───────────────────
cron.schedule('0 9 * * 1-5', async () => {
  for (const [deviceId, deviceAlerts] of Object.entries(alerts)) {
    const sub = subscriptions[deviceId];
    if (!sub || deviceAlerts.length === 0) continue;
    const summaries = [];
    for (const alert of deviceAlerts) {
      const data = await getLivePrice(alert.ticker);
      if (data && data.price) summaries.push(`${alert.ticker} $${data.price.toFixed(2)} ${data.changePct >= 0 ? '▲' : '▼'}${Math.abs(data.changePct || 0).toFixed(2)}%`);
    }
    if (summaries.length > 0) await sendPush(sub, '📊 God morgen! Dagens aksjer', summaries.join(' | '), { type: 'MORNING_SUMMARY' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MarketPulse server på port ${PORT}`));

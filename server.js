const express = require('express');
const webpush = require('web-push');
const cron = require('node-cron');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const VAPID_PUBLIC  = 'BJ7mqVu3GlhVulKYmRnFT8OZgCMPwvBWarO3ASRXev2gUSQWcmzgsl1ELhH1jQhIfwCsy2Npu0w59cywSkAtGUQ';
const VAPID_PRIVATE = '_uaYQFALkREgxlJ6OyR8j1qqWM2aIOgMDki4vxfe_kE';

webpush.setVapidDetails('mailto:din@epost.no', VAPID_PUBLIC, VAPID_PRIVATE);

const FINNHUB_KEY = process.env.FINNHUB_KEY || 'DIN_FINNHUB_NOKKEL';

const subscriptions = {};
const alerts = {};

async function getLivePrice(ticker) {
  try {
    const url = `https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${FINNHUB_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    return { price: data.c, prevClose: data.pc, change: data.d, changePct: data.dp };
  } catch (e) {
    return null;
  }
}

async function sendPush(subscription, title, body, data = {}) {
  const payload = JSON.stringify({ title, body, ...data });
  try {
    await webpush.sendNotification(subscription, payload);
  } catch (e) {
    console.error('Push feil:', e.message);
  }
}

cron.schedule('* * * * *', async () => {
  for (const [deviceId, deviceAlerts] of Object.entries(alerts)) {
    const sub = subscriptions[deviceId];
    if (!sub) continue;
    for (const alert of deviceAlerts) {
      const priceData = await getLivePrice(alert.ticker);
      if (!priceData || !priceData.price) continue;
      const price = priceData.price;
      if (alert.alertUp && price >= alert.alertUp && !alert.triggeredUp) {
        alert.triggeredUp = true;
        await sendPush(sub, `Aksje opp! ${alert.ticker} naadde $${alert.alertUp}!`, `Naavaerende pris: $${price.toFixed(2)}`, { ticker: alert.ticker, price, type: 'TARGET_HIT' });
      }
      if (alert.alertUp && price < alert.alertUp * 0.995) alert.triggeredUp = false;
      if (alert.alertDown && price <= alert.alertDown && !alert.triggeredDown) {
        alert.triggeredDown = true;
        await sendPush(sub, `Aksje ned! ${alert.ticker} falt under $${alert.alertDown}`, `Naavaerende pris: $${price.toFixed(2)}`, { ticker: alert.ticker, price, type: 'STOP_HIT' });
      }
      if (alert.alertDown && price > alert.alertDown * 1.005) alert.triggeredDown = false;
    }
  }
});

cron.schedule('0 9 * * 1-5', async () => {
  for (const [deviceId, deviceAlerts] of Object.entries(alerts)) {
    const sub = subscriptions[deviceId];
    if (!sub || deviceAlerts.length === 0) continue;
    const summaries = [];
    for (const alert of deviceAlerts) {
      const data = await getLivePrice(alert.ticker);
      if (data && data.price) {
        const arrow = data.changePct >= 0 ? 'opp' : 'ned';
        summaries.push(`${alert.ticker} $${data.price.toFixed(2)} ${arrow} ${Math.abs(data.changePct || 0).toFixed(2)}%`);
      }
    }
    if (summaries.length > 0) {
      await sendPush(sub, 'God morgen! Dagens aksjer', summaries.join(' | '), { type: 'MORNING_SUMMARY' });
    }
  }
});

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

app.get('/price/:ticker', async (req, res) => {
  const data = await getLivePrice(req.params.ticker.toUpperCase());
  if (!data) return res.status(500).json({ error: 'Kunne ikke hente pris' });
  res.json(data);
});

app.get('/alerts/:deviceId', (req, res) => res.json({ alerts: alerts[req.params.deviceId] || [] }));

app.get('/', (req, res) => res.json({ status: 'MarketPulse server kjoerer' }));

const path = require('path');
app.use(express.static(path.join(__dirname, 'public')));

app.post('/test-push', async (req, res) => {
  const { deviceId } = req.body;
  const sub = subscriptions[deviceId];
  if (!sub) return res.status(404).json({ error: 'Ingen abonnement funnet' });
  await sendPush(sub, 'MarketPulse er klar!', 'Push-varsler fungerer!');
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MarketPulse server paa port ${PORT}`));

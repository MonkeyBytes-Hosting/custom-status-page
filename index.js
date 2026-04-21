'use strict';

// Auto-install missing dependencies when invoked directly with `node index.js`
(function autoInstall() {
  const { execSync } = require('child_process');
  const path = require('path');
  const fs   = require('fs');
  const pkg  = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  const missing = Object.keys(pkg.dependencies || {}).filter(dep => {
    try { require.resolve(dep); return false; } catch { return true; }
  });
  if (missing.length) {
    console.log('[boot] Installing missing packages:', missing.join(', '));
    execSync('npm install --prefer-offline --silent', { cwd: __dirname, stdio: 'inherit' });
  }
})();

require('dotenv').config();

const express  = require('express');
const session  = require('express-session');
const https    = require('https');
const path     = require('path');
const { PORT, HOST }       = require('./src/config');
const { initDB }           = require('./src/db');
const { startMonitoring }  = require('./src/monitor');
const apiRouter            = require('./src/routes/api');
const dbRouter             = require('./src/routes/dbManager');
const endpointsRouter      = require('./src/routes/endpoints');
const requestRouter        = require('./src/routes/request');
const adminRouter          = require('./src/routes/admin');
const { startBot }         = require('./src/bot');

const app = express();

// ─── Sessions ─────────────────────────────────────────────────────────────────
app.use(session({
  secret:            process.env.SESSION_SECRET || process.env.AUTH_PASSWORD,
  resave:            false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 },
}));

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ─── GitHub Device Flow helpers ───────────────────────────────────────────────
const deviceFlows = new Map(); // flowId → { userCode, verificationUri, deviceCode, interval, expiresAt, status, username }

function ghPost(hostname, path, body) {
  return new Promise((resolve, reject) => {
    const data = new URLSearchParams(body).toString();
    const req = https.request(
      { hostname, path, method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded',
                   'Content-Length': Buffer.byteLength(data),
                   'Accept': 'application/json' } },
      r => { let s = ''; r.on('data', c => s += c); r.on('end', () => resolve(JSON.parse(s))); }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function ghGet(path, token) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: 'api.github.com', path, method: 'GET',
        headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': 'status-page', 'Accept': 'application/json' } },
      r => { let s = ''; r.on('data', c => s += c); r.on('end', () => resolve(JSON.parse(s))); }
    );
    req.on('error', reject);
    req.end();
  });
}

function pollDevice(flowId) {
  const flow = deviceFlows.get(flowId);
  if (!flow || flow.status !== 'pending') return;
  if (Date.now() > flow.expiresAt) { flow.status = 'expired'; return; }

  setTimeout(async () => {
    try {
      const data = await ghPost('github.com', '/login/oauth/access_token', {
        client_id:   process.env.GITHUB_CLIENT_ID,
        device_code: flow.deviceCode,
        grant_type:  'urn:ietf:params:oauth:grant-type:device_code',
      });

      if (data.error === 'authorization_pending') return pollDevice(flowId);
      if (data.error === 'slow_down') { flow.interval = (flow.interval || 5) + 5; return pollDevice(flowId); }
      if (data.error) { flow.status = 'error'; return; }

      const user = await ghGet('/user', data.access_token);
      const allowed = process.env.GITHUB_ALLOWED_USERNAME;
      if (allowed && user.login?.toLowerCase() !== allowed.toLowerCase()) {
        flow.status = 'denied';
      } else {
        flow.status   = 'authed';
        flow.username = user.login;
      }
    } catch { pollDevice(flowId); }
  }, (flow.interval || 5) * 1000);
}

// ─── Auth gate ────────────────────────────────────────────────────────────────
// Public: GET /, /login, /favicon.svg, and all read-only API calls the status
// page needs (GET /api/services, /api/events, /api/history/:id).
// Everything else requires a valid session.
app.use((req, res, next) => {
  const p = req.path;
  const isPublic =
    p === '/' ||
    p === '/favicon.svg' ||
    p.startsWith('/login') ||
    p.startsWith('/auth/github/device') ||
    p === '/request' ||
    p.startsWith('/request/submit') ||
    p === '/api/incidents/active' ||
    p === '/rss.xml' ||
    p === '/subscribe' ||
    p.startsWith('/subscribe/') ||
    p === '/unsubscribe' ||
    p === '/webhook-subscribe' ||
    (req.method === 'GET' && p.startsWith('/api/'));

  if (isPublic || req.session?.authed) return next();

  // API calls from protected pages return 401 JSON so the UI can handle it
  if (p.startsWith('/api/') || p.startsWith('/db/api/')) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
});

// ─── Login / logout ───────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.session?.authed) return res.redirect('/endpoints');
  res.sendFile(path.join(__dirname, 'src/views/login.html'));
});

// Start a device flow — returns { flowId, userCode, verificationUri }
app.post('/auth/github/device/start', async (req, res) => {
  if (!process.env.GITHUB_CLIENT_ID)
    return res.status(500).json({ error: 'GITHUB_CLIENT_ID not set in .env' });
  try {
    const data = await ghPost('github.com', '/login/device/code', {
      client_id: process.env.GITHUB_CLIENT_ID,
      scope: 'read:user',
    });
    console.log('[device flow] GitHub response:', JSON.stringify(data));
    if (data.error) return res.status(400).json({ error: data.error_description || data.error });

    const flowId = require('crypto').randomUUID();
    deviceFlows.set(flowId, {
      userCode:        data.user_code,
      verificationUri: data.verification_uri,
      deviceCode:      data.device_code,
      interval:        data.interval || 5,
      expiresAt:       Date.now() + (data.expires_in || 900) * 1000,
      status:          'pending',
    });
    // clean up old flows
    for (const [id, f] of deviceFlows) if (Date.now() > f.expiresAt) deviceFlows.delete(id);

    pollDevice(flowId);
    res.json({ flowId, userCode: data.user_code, verificationUri: data.verification_uri });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Poll status from the browser
app.get('/auth/github/device/status', (req, res) => {
  const flow = deviceFlows.get(req.query.flowId);
  if (!flow) return res.status(404).json({ status: 'not_found' });

  if (flow.status === 'authed') {
    req.session.authed    = true;
    req.session.ghUser    = flow.username;
    deviceFlows.delete(req.query.flowId);
    return res.json({ status: 'authed' });
  }
  res.json({ status: flow.status });
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/favicon.svg', (_req, res) =>
  res.sendFile(path.join(__dirname, 'src/views/favicon.svg'))
);
app.get('/manifest.json', (_req, res) =>
  res.sendFile(path.join(__dirname, 'src/views/manifest.json'))
);
app.get('/sw.js', (_req, res) => {
  res.setHeader('Service-Worker-Allowed', '/');
  res.sendFile(path.join(__dirname, 'src/views/sw.js'));
});
app.get('/', (_req, res) =>
  res.sendFile(path.join(__dirname, 'src/views/main.html'))
);

// ─── Email subscription (public, no auth) ────────────────────────────────────
const { randomUUID } = require('crypto');
const { sendMail }   = require('./src/mailer');
const { pool: dbPool } = require('./src/db');

app.post('/subscribe', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'Invalid email' });
  const token = randomUUID().replace(/-/g,'');
  try {
    await dbPool.execute(
      'INSERT INTO subscribers (id, email, token) VALUES (?,?,?) ON DUPLICATE KEY UPDATE token=VALUES(token), confirmed=0',
      [randomUUID(), email, token],
    );
    const confirmUrl = `${process.env.SITE_URL || 'http://localhost:' + (process.env.PORT||3000)}/subscribe/confirm?token=${token}`;
    await sendMail({ to: email, subject: 'Confirm your status page subscription',
      html: `<p>Click to confirm: <a href="${confirmUrl}">${confirmUrl}</a></p><p>If you didn't request this, ignore this email.</p>` });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/subscribe/confirm', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.redirect('/?sub=invalid');
  const [rows] = await dbPool.execute('SELECT id FROM subscribers WHERE token=?', [token]);
  if (!rows.length) return res.redirect('/?sub=invalid');
  await dbPool.execute('UPDATE subscribers SET confirmed=1 WHERE token=?', [token]);
  res.redirect('/?sub=confirmed');
});

app.get('/unsubscribe', async (req, res) => {
  const { token } = req.query;
  if (token) await dbPool.execute('DELETE FROM subscribers WHERE token=?', [token]);
  res.redirect('/?sub=unsubscribed');
});

// Discord webhook subscriptions (public)
app.post('/webhook-subscribe', async (req, res) => {
  const url = (req.body.url || '').trim();
  if (!url.startsWith('https://discord.com/api/webhooks/') && !url.startsWith('https://discordapp.com/api/webhooks/'))
    return res.status(400).json({ error: 'Invalid Discord webhook URL' });
  try {
    await dbPool.execute(
      'INSERT IGNORE INTO webhook_subscribers (id, url) VALUES (?,?)',
      [randomUUID(), url],
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// RSS feed (public)
app.get('/rss.xml', async (_req, res) => {
  try {
    const [incidents] = await dbPool.execute(
      `SELECT id, title, body, severity, status, created_at, resolved_at FROM incidents ORDER BY created_at DESC LIMIT 40`
    );
    const siteUrl = process.env.SITE_URL || `http://localhost:${process.env.PORT || 3000}`;
    const now = new Date().toUTCString();
    const items = incidents.map(inc => {
      const desc = [
        inc.body ? inc.body.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') : '',
        `Severity: ${inc.severity}`,
        `Status: ${inc.status}`,
        inc.resolved_at ? `Resolved: ${new Date(inc.resolved_at).toUTCString()}` : '',
      ].filter(Boolean).join(' | ');
      return `    <item>
      <title>${inc.title.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')} [${inc.status}]</title>
      <link>${siteUrl}/</link>
      <guid isPermaLink="false">${inc.id}</guid>
      <pubDate>${new Date(inc.created_at).toUTCString()}</pubDate>
      <description>${desc}</description>
    </item>`;
    }).join('\n');
    res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Status Page — Incidents</title>
    <link>${siteUrl}/</link>
    <description>Incident and status updates</description>
    <lastBuildDate>${now}</lastBuildDate>
${items}
  </channel>
</rss>`);
  } catch(e) { res.status(500).send('<!-- error: ' + e.message + ' -->'); }
});

// Uptime badge SVG (public)
app.get('/badge/:id', async (req, res) => {
  try {
    const [[svc]] = await dbPool.execute('SELECT id, name FROM services WHERE id=?', [req.params.id]);
    if (!svc) return res.status(404).send('<!-- not found -->');

    const since = new Date(Date.now() - 24 * 3_600_000);
    const [[{ total, up }]] = await dbPool.execute(
      `SELECT COUNT(*) AS total, SUM(status='up') AS up FROM history WHERE service_id=? AND checked_at>?`,
      [svc.id, since],
    );
    const pct   = total ? ((up / total) * 100).toFixed(1) : null;
    const label = pct != null ? pct + '%' : 'no data';
    const color = pct == null ? '#888' : parseFloat(pct) >= 99 ? '#22c55e' : parseFloat(pct) >= 95 ? '#f59e0b' : '#ef4444';

    const name    = svc.name.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const nameW   = Math.min(Math.max(name.length * 7 + 16, 60), 220);
    const labelW  = label.length * 7 + 16;
    const totalW  = nameW + labelW;

    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.send(`<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="20">
  <linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
  <clipPath id="r"><rect width="${totalW}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${nameW}" height="20" fill="#555"/>
    <rect x="${nameW}" width="${labelW}" height="20" fill="${color}"/>
    <rect width="${totalW}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11">
    <text x="${nameW / 2}" y="15" fill="#010101" fill-opacity=".3">${name}</text>
    <text x="${nameW / 2}" y="14">${name}</text>
    <text x="${nameW + labelW / 2}" y="15" fill="#010101" fill-opacity=".3">${label}</text>
    <text x="${nameW + labelW / 2}" y="14">${label}</text>
  </g>
</svg>`);
  } catch(e) { res.status(500).send('<!-- error -->'); }
});

// Public: active incidents for the status page banner
app.get('/api/incidents/active', async (_req, res) => {
  try {
    const [rows] = await require('./src/db').pool.execute(
      `SELECT id, title, body, severity, created_at FROM incidents WHERE status='active' ORDER BY created_at DESC`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.use('/api',       apiRouter);
app.use('/db',        dbRouter);
app.use('/endpoints', endpointsRouter);
app.use('/admin',    adminRouter);
app.use('/request',  requestRouter);
app.get('/requests', (req, res) => req.session?.authed ? res.sendFile(path.join(__dirname, 'src/views/requests.html')) : res.redirect('/login?next=/requests'));
app.use('/requests', requestRouter);

// ─── Boot ─────────────────────────────────────────────────────────────────────
initDB()
  .then(startMonitoring)
  .then(startBot)
  .then(() => app.listen(PORT, HOST, () => {
    console.log(`\n  Status page  →  http://localhost:${PORT}   (public)`);
    console.log(`  Admin        →  http://localhost:${PORT}/admin`);
    console.log(`  Endpoints    →  http://localhost:${PORT}/endpoints`);
    console.log(`  DB manager   →  http://localhost:${PORT}/db`);
    console.log(`  Requests     →  http://localhost:${PORT}/requests`);
    console.log(`  Request form →  http://localhost:${PORT}/request  (public)`);
    console.log(`\n  Password set in .env → AUTH_PASSWORD\n`);
  }))
  .catch(err => { console.error('[fatal]', err.message); process.exit(1); });

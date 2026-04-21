'use strict';

const { Router }    = require('express');
const path          = require('path');
const https         = require('https');
const { randomUUID } = require('crypto');
const { pool }      = require('../db');
const { broadcast } = require('../broadcast');
const { broadcastUpdate } = require('../mailer');

const router = Router();

router.get('/', (_req, res) =>
  res.sendFile(path.join(__dirname, '../views/admin.html'))
);

// ─── Stats summary ────────────────────────────────────────────────────────────
router.get('/api/stats', async (_req, res) => {
  try {
    const [[{ total }]]   = await pool.execute('SELECT COUNT(*) AS total FROM services');
    const [[{ pending }]] = await pool.execute("SELECT COUNT(*) AS pending FROM requests WHERE status='pending'");

    const [latest] = await pool.execute(`
      SELECT h.service_id, h.status, h.checked_at, s.name
      FROM history h
      JOIN services s ON s.id = h.service_id
      WHERE h.checked_at = (
        SELECT MAX(checked_at) FROM history WHERE service_id = h.service_id
      )
    `);

    const up       = latest.filter(r => r.status === 'up').length;
    const down     = latest.filter(r => r.status === 'down').length;
    const degraded = latest.filter(r => r.status === 'degraded').length;

    const [rtRows] = await pool.execute(`
      SELECT AVG(response_time) AS avg_rt
      FROM history
      WHERE checked_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)
        AND response_time IS NOT NULL
    `);

    res.json({ total, up, down, degraded, pending, avgRt: Math.round(rtRows[0]?.avg_rt ?? 0) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Recent incidents ─────────────────────────────────────────────────────────
router.get('/api/incidents', async (_req, res) => {
  try {
    const [rows] = await pool.execute(`
      SELECT h.service_id, h.status, h.response_time, h.status_code, h.checked_at, s.name, s.url
      FROM   history h
      JOIN   services s ON s.id = h.service_id
      WHERE  h.status IN ('down','degraded')
        AND  h.checked_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)
      ORDER  BY h.checked_at DESC
      LIMIT  40
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Webhook test ─────────────────────────────────────────────────────────────
router.post('/api/webhook/test', async (req, res) => {
  const WEBHOOK_URL = process.env.DISCORD_WEBHOOK;
  if (!WEBHOOK_URL) return res.status(400).json({ error: 'DISCORD_WEBHOOK not configured in .env' });

  const type  = req.body.type || 'ping';   // ping | down | recovery
  const COLOR = { ping: 0x7c5cfc, down: 0xef4444, recovery: 0x22c55e };
  const TITLE = {
    ping:     '🔔  Webhook test — ping',
    down:     '🔴  Webhook test — simulated outage',
    recovery: '🟢  Webhook test — simulated recovery',
  };

  const embed = {
    color: COLOR[type] ?? 0x7c5cfc,
    title: TITLE[type] ?? '🔔  Webhook test',
    description: 'This is a test message sent from the status page admin panel.',
    fields: [
      { name: '📡 Source', value: 'Admin panel — System tab', inline: true },
      { name: '🕐 Time',   value: new Date().toUTCString(),   inline: false },
    ],
    footer: { text: 'Status Page Admin' },
    timestamp: new Date().toISOString(),
  };

  const body = JSON.stringify({ embeds: [embed] });
  const u    = new URL(WEBHOOK_URL);

  try {
    await new Promise((resolve, reject) => {
      const req = https.request(
        { hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
        r => { r.resume(); resolve(r.statusCode); }
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── SLA / uptime summary ─────────────────────────────────────────────────────
router.get('/api/sla', async (_req, res) => {
  try {
    const [svcs] = await pool.execute('SELECT id, name FROM services');
    const periods = [{ label:'24h', hours:24 }, { label:'7d', hours:168 }, { label:'30d', hours:720 }];
    const rows = await Promise.all(svcs.map(async s => {
      const cols = {};
      for (const p of periods) {
        const since = new Date(Date.now() - p.hours * 3_600_000);
        const [[{ total, up }]] = await pool.execute(
          `SELECT COUNT(*) AS total, SUM(status='up') AS up FROM history WHERE service_id=? AND checked_at>?`,
          [s.id, since],
        );
        cols[p.label] = total ? ((up / total) * 100).toFixed(2) : null;
      }
      return { id: s.id, name: s.name, ...cols };
    }));
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Incident announcements ───────────────────────────────────────────────────
router.get('/api/announcements', async (_req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT * FROM incidents ORDER BY created_at DESC LIMIT 20`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/announcements', async (req, res) => {
  const { title, body, severity = 'minor', notify = false } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'title required' });
  const id = randomUUID();
  try {
    await pool.execute(
      `INSERT INTO incidents (id, title, body, severity, status) VALUES (?,?,?,?,'active')`,
      [id, title.trim(), body?.trim() || '', severity],
    );
    const [[row]] = await pool.execute('SELECT * FROM incidents WHERE id = ?', [id]);
    broadcast({ type: 'incident_created', incident: row });
    let notifyResult = null;
    if (notify) {
      notifyResult = await broadcastUpdate(pool, { title: title.trim(), body: body?.trim() || '', severity }).catch(e => ({ errors: [e.message] }));
    }
    res.json({ ...row, notifyResult });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Broadcast update to all subscribers + webhooks ───────────────────────────
router.post('/api/broadcast', async (req, res) => {
  const { title, body, severity = 'info' } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'title required' });
  try {
    const result = await broadcastUpdate(pool, { title: title.trim(), body: (body || '').trim(), severity });
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/announcements/:id/resolve', async (req, res) => {
  try {
    await pool.execute(
      `UPDATE incidents SET status='resolved', resolved_at=NOW() WHERE id=?`,
      [req.params.id],
    );
    broadcast({ type: 'incident_resolved', id: req.params.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/api/announcements/:id', async (req, res) => {
  try {
    await pool.execute('DELETE FROM incidents WHERE id=?', [req.params.id]);
    broadcast({ type: 'incident_deleted', id: req.params.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Public endpoint (no auth) for active incidents ───────────────────────────
// registered in index.js before auth middleware

// ─── Email subscribers (admin view) ───────────────────────────────────────────
router.get('/api/subscribers', async (_req, res) => {
  try {
    const [rows] = await pool.execute('SELECT id, email, confirmed, created_at FROM subscribers ORDER BY created_at DESC');
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/api/subscribers/:id', async (req, res) => {
  await pool.execute('DELETE FROM subscribers WHERE id=?', [req.params.id]);
  res.json({ ok: true });
});

router.get('/api/webhook-subscribers', async (_req, res) => {
  try {
    const [rows] = await pool.execute('SELECT id, url, created_at FROM webhook_subscribers ORDER BY created_at DESC');
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/api/webhook-subscribers/:id', async (req, res) => {
  await pool.execute('DELETE FROM webhook_subscribers WHERE id=?', [req.params.id]);
  res.json({ ok: true });
});

// ─── Test email ───────────────────────────────────────────────────────────────
router.post('/api/email/test', async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'to address required' });
  const { sendMail } = require('../mailer');
  try {
    await sendMail({
      to,
      subject: 'Status Page — test email',
      html: `<div style="font-family:Inter,system-ui,sans-serif;max-width:500px;margin:0 auto;background:#07070e;color:#e8e8f0;border-radius:14px;overflow:hidden">
        <div style="background:#7c5cfc;padding:18px 24px"><h2 style="margin:0;color:#fff;font-size:1.1rem">Test email — Status Page</h2></div>
        <div style="padding:20px 24px">
          <p style="margin:0 0 12px;font-size:.9rem">SMTP is configured and working correctly.</p>
          <p style="margin:0;font-size:.84rem;color:#8888aa">Sent from the admin panel at ${new Date().toUTCString()}.</p>
        </div>
      </div>`,
    });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── CSV export ───────────────────────────────────────────────────────────────
router.get('/api/export/history.csv', async (_req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT s.name, s.url, h.status, h.response_time, h.status_code, h.checked_at
       FROM history h JOIN services s ON s.id = h.service_id
       ORDER BY h.checked_at DESC LIMIT 100000`
    );
    const header = 'service,url,status,response_time_ms,status_code,checked_at\n';
    const csv = rows.map(r =>
      [r.name, r.url, r.status, r.response_time ?? '', r.status_code ?? '', new Date(r.checked_at).toISOString()].map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')
    ).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="history-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(header + csv);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── History prune ────────────────────────────────────────────────────────────
router.post('/api/prune-history', async (req, res) => {
  try {
    const days = Math.max(1, parseInt(req.body.days) || 30);
    const [r]  = await pool.execute(
      'DELETE FROM history WHERE checked_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
      [days],
    );
    res.json({ ok: true, deleted: r.affectedRows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

'use strict';

const { Router }     = require('express');
const { randomUUID } = require('crypto');
const path           = require('path');
const https          = require('https');
const { pool }       = require('../db');
const { performCheck } = require('../monitor');

const router = Router();

// ─── Public: request form ─────────────────────────────────────────────────────
router.get('/', (_req, res) =>
  res.sendFile(path.join(__dirname, '../views/request.html'))
);

router.post('/submit', async (req, res) => {
  const {
    name, url, service_type = 'Website', category = 'General',
    description = '', discord_id = '', contact = '',
    priority = 'normal', notify_down, notify_recover, notes = '',
  } = req.body;

  if (!name?.trim() || !url?.trim())
    return res.status(400).json({ error: 'Name and URL are required' });

  try { new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }

  const id = randomUUID();
  await pool.execute(
    `INSERT INTO requests
       (id, url, name, service_type, category, description, discord_id, contact,
        priority, notify_down, notify_recover, notes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id, url.trim(), name.trim(), service_type, category,
      description, discord_id.trim(), contact.trim(),
      priority,
      notify_down  ? 1 : 0,
      notify_recover ? 1 : 0,
      notes,
    ],
  );

  // Notify admin via Discord webhook
  notifyAdmin({ id, name: name.trim(), url: url.trim(), service_type, priority, discord_id, contact }).catch(() => {});

  res.json({ ok: true });
});

// ─── Admin API (auth-gated in index.js) ──────────────────────────────────────
router.get('/api/list', async (_req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM requests ORDER BY created_at DESC'
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/approve/:id', async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM requests WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const r = rows[0];

    // Build tags: always include "Client Status"
    const extraTags = req.body.extra_tags
      ? req.body.extra_tags.split(',').map(t => t.trim()).filter(Boolean)
      : [];
    const tags = JSON.stringify(['Client Status', ...extraTags]);

    const svcId = randomUUID();
    const svc = {
      id:       svcId,
      name:     r.name,
      url:      r.url,
      category: r.category,
      tags,
    };

    await pool.execute(
      'INSERT INTO services (id, name, url, category, tags) VALUES (?,?,?,?,?)',
      [svc.id, svc.name, svc.url, svc.category, svc.tags],
    );

    await performCheck(svc);

    await pool.execute(
      'UPDATE requests SET status = ? WHERE id = ?',
      ['approved', req.params.id],
    );

    res.json({ ok: true, serviceId: svcId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/reject/:id', async (req, res) => {
  try {
    const [r] = await pool.execute(
      'UPDATE requests SET status = ? WHERE id = ?',
      ['rejected', req.params.id],
    );
    if (!r.affectedRows) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/api/delete/:id', async (req, res) => {
  try {
    const [r] = await pool.execute('DELETE FROM requests WHERE id = ?', [req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Discord admin notification ───────────────────────────────────────────────
function notifyAdmin({ id, name, url, service_type, priority, discord_id, contact }) {
  const WEBHOOK_URL = process.env.DISCORD_WEBHOOK;
  if (!WEBHOOK_URL) return Promise.resolve();

  const priorityColor = { urgent: 0xef4444, high: 0xf59e0b, normal: 0x7c5cfc, low: 0x6b7280 };
  const color = priorityColor[priority] || 0x7c5cfc;

  const embed = {
    color,
    title: `📋  New monitoring request — ${name}`,
    description: `A new service monitoring request has been submitted and is waiting for review.`,
    fields: [
      { name: '🔗 URL',          value: `\`${url}\``,                  inline: false },
      { name: '🖥️ Type',         value: service_type,                  inline: true  },
      { name: '⚡ Priority',     value: priority.charAt(0).toUpperCase() + priority.slice(1), inline: true },
      ...(discord_id ? [{ name: '💬 Discord',   value: `<@${discord_id}>`, inline: true }] : []),
      ...(contact    ? [{ name: '📧 Contact',   value: contact,           inline: true }] : []),
    ],
    footer: { text: `Request ID: ${id}  •  Review at /requests` },
    timestamp: new Date().toISOString(),
  };

  const body = JSON.stringify({ embeds: [embed] });
  const u    = new URL(WEBHOOK_URL);

  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      res => { res.resume(); resolve(); }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = router;

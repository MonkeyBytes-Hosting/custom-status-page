'use strict';

const { Router }     = require('express');
const { randomUUID } = require('crypto');
const { pool }             = require('../db');
const { performCheck }     = require('../monitor');
const { allServiceViews }  = require('../stats');
const { broadcast, addClient, removeClient } = require('../broadcast');
const { broadcastUpdate } = require('../mailer');

const router = Router();

router.get('/services', async (req, res) => {
  try {
    const hours = Math.min(720, Math.max(1, parseInt(req.query.hours) || 24));
    res.json(await allServiceViews(hours));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/services', async (req, res) => {
  const { name, url, category = 'General', tags = [] } = req.body;
  if (!name?.trim() || !url?.trim())
    return res.status(400).json({ error: 'name and url required' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'invalid URL' }); }

  const svc = {
    id:       randomUUID(),
    name:     name.trim(),
    url:      url.trim(),
    category,
    tags:     JSON.stringify(tags),
  };
  await pool.execute(
    'INSERT INTO services (id, name, url, category, tags) VALUES (?,?,?,?,?)',
    [svc.id, svc.name, svc.url, svc.category, svc.tags],
  );
  const first = await performCheck(svc);
  const out   = { ...svc, tags, currentStatus: first.status };
  broadcast({ type: 'service_added', service: out });
  res.json(out);
});

router.post('/services/:id/maintenance', async (req, res) => {
  const { minutes } = req.body; // 0 = clear, positive = set window
  const until = minutes > 0 ? new Date(Date.now() + minutes * 60_000) : null;
  try {
    const [[svc]] = await pool.execute('SELECT name, url FROM services WHERE id=?', [req.params.id]);
    await pool.execute('UPDATE services SET maintenance_until=? WHERE id=?', [until, req.params.id]);
    broadcast({ type: 'service_updated', serviceId: req.params.id });

    if (svc) {
      const isOn = until !== null;
      broadcastUpdate(pool, {
        title:    `${svc.name} — Maintenance ${isOn ? 'Started' : 'Ended'}`,
        body:     isOn
          ? `${svc.name} has been placed under maintenance until ${until.toUTCString()}.\n${svc.url}`
          : `${svc.name} maintenance window has ended. Monitoring has resumed.\n${svc.url}`,
        severity: 'info',
      }).catch(e => console.error('[maintenance notify]', e.message));
    }

    res.json({ ok: true, until });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/services/:id/check', async (req, res) => {
  const [[svc]] = await pool.execute('SELECT id, name, url, rt_threshold FROM services WHERE id = ?', [req.params.id]);
  if (!svc) return res.status(404).json({ error: 'not found' });
  try {
    const result = await performCheck(svc);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/services/:id/threshold', async (req, res) => {
  const ms = req.body.ms == null || req.body.ms === '' ? null : Math.max(1, parseInt(req.body.ms));
  try {
    const [r] = await pool.execute('UPDATE services SET rt_threshold=? WHERE id=?', [ms || null, req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, rt_threshold: ms || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/services/reorder', async (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array' });
  try {
    await Promise.all(order.map(({ id, position }) =>
      pool.execute('UPDATE services SET position = ? WHERE id = ?', [position, id])
    ));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/services/:id', async (req, res) => {
  const { name, url, category = 'General', tags = [] } = req.body;
  if (!name?.trim() || !url?.trim()) return res.status(400).json({ error: 'name and url required' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'invalid URL' }); }
  const [r] = await pool.execute(
    'UPDATE services SET name=?, url=?, category=?, tags=? WHERE id=?',
    [name.trim(), url.trim(), category, JSON.stringify(tags), req.params.id],
  );
  if (!r.affectedRows) return res.status(404).json({ error: 'not found' });
  broadcast({ type: 'service_updated', serviceId: req.params.id });
  res.json({ ok: true });
});

router.delete('/services/:id', async (req, res) => {
  const [r] = await pool.execute('DELETE FROM services WHERE id = ?', [req.params.id]);
  if (!r.affectedRows) return res.status(404).json({ error: 'not found' });
  broadcast({ type: 'service_removed', serviceId: req.params.id });
  res.json({ ok: true });
});

router.get('/history/:id', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT status, response_time, status_code, checked_at
       FROM   history
       WHERE  service_id = ?
       ORDER  BY checked_at DESC
       LIMIT  200`,
      [req.params.id],
    );
    res.json({ recent: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/events', (req, res) => {
  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');   // prevent Nginx buffering
  res.flushHeaders();

  const send = data => { try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {} };
  send({ type: 'connected' });

  // keepalive comment every 20 s to prevent proxy/browser timeout
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { clearInterval(ping); } }, 20_000);

  addClient(res);
  req.on('close', () => { removeClient(res); clearInterval(ping); });
});

module.exports = router;

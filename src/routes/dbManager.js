'use strict';

const { Router } = require('express');
const path       = require('path');
const { pool }   = require('../db');

const router = Router();

function safeName(n) { return /^[a-zA-Z0-9_\-]+$/.test(n) ? n : null; }

// ── UI ───────────────────────────────────────────────────────────────────────
router.get('/', (_req, res) =>
  res.sendFile(path.join(__dirname, '../views/db.html'))
);

// ── DB info (for client-side display) ────────────────────────────────────────
router.get('/api/info', (_req, res) => {
  res.json({
    host:     process.env.DB_HOST,
    port:     process.env.DB_PORT,
    database: process.env.DB_NAME,
  });
});

// ── Tables list ───────────────────────────────────────────────────────────────
router.get('/api/tables', async (_req, res) => {
  try {
    const [rows] = await pool.execute('SHOW TABLES');
    const names  = rows.map(r => Object.values(r)[0]);
    const out    = await Promise.all(names.map(async n => {
      const [[{ cnt }]] = await pool.execute(`SELECT COUNT(*) AS cnt FROM \`${n}\``);
      return { name: n, rows: cnt };
    }));
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Table rows (paginated) ────────────────────────────────────────────────────
router.get('/api/table/:name/rows', async (req, res) => {
  const name = safeName(req.params.name);
  if (!name) return res.status(400).json({ error: 'invalid table name' });

  const page   = Math.max(1, parseInt(req.query.page)  || 1);
  const limit  = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
  const offset = (page - 1) * limit;

  try {
    const [[{ total }]] = await pool.execute(`SELECT COUNT(*) AS total FROM \`${name}\``);
    const [rows]        = await pool.execute(`SELECT * FROM \`${name}\` LIMIT ${limit} OFFSET ${offset}`);
    const [cols]        = await pool.execute(`DESCRIBE \`${name}\``);
    const pk            = cols.find(c => c.Key === 'PRI')?.Field ?? null;

    res.json({ rows, columns: cols.map(c => c.Field), pk, total, page, limit, pages: Math.ceil(total / limit) || 1 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Table structure ───────────────────────────────────────────────────────────
router.get('/api/table/:name/structure', async (req, res) => {
  const name = safeName(req.params.name);
  if (!name) return res.status(400).json({ error: 'invalid table name' });
  try {
    const [cols]     = await pool.execute(`DESCRIBE \`${name}\``);
    const [[create]] = await pool.execute(`SHOW CREATE TABLE \`${name}\``);
    res.json({ columns: cols, createSQL: create['Create Table'] ?? '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Raw SQL runner ────────────────────────────────────────────────────────────
router.post('/api/query', async (req, res) => {
  const { sql: raw } = req.body;
  if (!raw?.trim()) return res.status(400).json({ error: 'sql required' });
  try {
    const t0 = Date.now();
    const [result, fields] = await pool.query(raw);
    const elapsed = Date.now() - t0;

    if (Array.isArray(result)) {
      res.json({ type: 'select', rows: result, columns: fields?.map(f => f.name) ?? [], rowCount: result.length, elapsed });
    } else {
      res.json({ type: 'mutation', affectedRows: result.affectedRows, insertId: result.insertId, elapsed });
    }
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Delete row ────────────────────────────────────────────────────────────────
router.delete('/api/table/:name/row', async (req, res) => {
  const name  = safeName(req.params.name);
  const pkCol = safeName(req.body.pk);
  if (!name || !pkCol) return res.status(400).json({ error: 'invalid params' });
  try {
    await pool.execute(`DELETE FROM \`${name}\` WHERE \`${pkCol}\` = ? LIMIT 1`, [req.body.pkValue]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Truncate table ────────────────────────────────────────────────────────────
router.post('/api/table/:name/truncate', async (req, res) => {
  const name = safeName(req.params.name);
  if (!name) return res.status(400).json({ error: 'invalid' });
  try {
    await pool.execute(`TRUNCATE TABLE \`${name}\``);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

'use strict';

const { pool } = require('./db');

async function getHistory(serviceId, hours = 24) {
  const since = new Date(Date.now() - hours * 3_600_000);
  const [rows] = await pool.execute(
    `SELECT status, response_time AS responseTime, checked_at
     FROM   history
     WHERE  service_id = ?
       AND  checked_at > ?
     ORDER  BY checked_at ASC`,
    [serviceId, since],
  );
  return rows;
}

// Keep for internal callers that still use the old name
const history24h = (id) => getHistory(id, 24);

function computeStats(hist, hours = 24) {
  // 144 bars for 24 h (one per 10 min), 90 bars for longer ranges
  const BAR_COUNT = hours <= 24 ? 144 : 90;

  if (!hist.length)
    return { uptime: null, avgResponseTime: null, bars: Array.from({ length: BAR_COUNT }, (_, i) => ({ status: 'no-data', time: Date.now() - (BAR_COUNT - i) * ((hours * 3_600_000) / BAR_COUNT) })) };

  const upCnt           = hist.filter(e => e.status === 'up').length;
  const uptime          = ((upCnt / hist.length) * 100).toFixed(2);
  const avgResponseTime = Math.round(hist.reduce((s, e) => s + (e.responseTime || 0), 0) / hist.length);

  const cutoff = Date.now() - hours * 3_600_000;
  const segMs  = (hours * 3_600_000) / BAR_COUNT;

  const bars = Array.from({ length: BAR_COUNT }, (_, i) => {
    const s   = cutoff + i * segMs;
    const e   = s + segMs;
    const seg = hist.filter(h => { const t = new Date(h.checked_at).getTime(); return t >= s && t < e; });
    let status;
    if (!seg.length)                            status = 'no-data';
    else if (seg.some(h => h.status === 'down')) status = 'down';
    else if (seg.some(h => h.status === 'degraded')) status = 'degraded';
    else                                         status = 'up';
    return { status, time: s };
  });

  return { uptime, avgResponseTime, bars };
}

async function allServiceViews(hours = 24) {
  const [svcs] = await pool.execute('SELECT * FROM services ORDER BY position ASC, created_at ASC');

  return Promise.all(svcs.map(async s => {
    const hist = await getHistory(s.id, hours);
    const [[latest]] = await pool.execute(
      'SELECT status, response_time, checked_at FROM history WHERE service_id = ? ORDER BY checked_at DESC LIMIT 1',
      [s.id],
    );
    return {
      id:                  s.id,
      name:                s.name,
      url:                 s.url,
      category:            s.category,
      tags:                tryJSON(s.tags, []),
      createdAt:           s.created_at,
      maintenance_until:   s.maintenance_until ?? null,
      currentStatus:       s.maintenance_until && new Date(s.maintenance_until) > new Date() ? 'maintenance' : (latest?.status ?? 'pending'),
      currentResponseTime: latest?.response_time ?? null,
      lastChecked:         latest?.checked_at    ?? null,
      ...computeStats(hist, hours),
    };
  }));
}

function tryJSON(v, fb) { try { return JSON.parse(v); } catch { return fb; } }

module.exports = { getHistory, history24h, computeStats, allServiceViews };

'use strict';

const http  = require('http');
const https = require('https');
const { pool }      = require('./db');
const { notify }              = require('./notifier');
const { notifySubscribers, notifyWebhookSubscribers } = require('./mailer');
const { broadcast } = require('./broadcast');
const { CHECK_INTERVAL, MAX_HISTORY } = require('./config');

function checkService(service) {
  return new Promise(resolve => {
    const start = Date.now();
    let fired = false;
    const done = v => { if (!fired) { fired = true; resolve(v); } };

    let parsed;
    try { parsed = new URL(service.url); }
    catch { return done({ status: 'down', responseTime: 0, statusCode: 0 }); }

    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.get(service.url, {
      timeout: 10_000,
      headers: { 'User-Agent': 'StatusPage/1.0' },
    }, res => {
      const rt   = Date.now() - start;
      const code = res.statusCode;
      res.resume();
      done({
        status:       code >= 500 ? 'down' : code >= 400 ? 'degraded' : 'up',
        responseTime: rt,
        statusCode:   code,
      });
    });

    req.on('error',   () => done({ status: 'down', responseTime: Date.now() - start, statusCode: 0 }));
    req.on('timeout', () => { req.destroy(); done({ status: 'down', responseTime: 10_000, statusCode: 0 }); });
  });
}

async function performCheck(service) {
  const r = await checkService(service);

  // 1-minute grace: if raw status is "down", hold at "degraded" until the
  // non-up streak has lasted ≥ 60 s (avoids red flashes on transient failures).
  // rawStatus is preserved so notifications can describe the real failure.
  // RT threshold: if response was otherwise "up" but slower than threshold, mark degraded
  if (r.status === 'up' && service.rt_threshold && r.responseTime > service.rt_threshold) {
    r.status = 'degraded';
  }

  r.rawStatus = r.status;
  if (r.status === 'down') {
    const since = new Date(Date.now() - 120_000); // only look back 2 min for efficiency
    const [[row]] = await pool.execute(
      `SELECT MIN(checked_at) AS streak_start
       FROM history
       WHERE service_id = ?
         AND checked_at > COALESCE(
           (SELECT MAX(checked_at) FROM history WHERE service_id = ? AND status = 'up'),
           ?
         )`,
      [service.id, service.id, since],
    );
    const streakStart = row?.streak_start ? new Date(row.streak_start).getTime() : Date.now();
    if (Date.now() - streakStart < 60_000) r.status = 'degraded';
  }

  await pool.execute(
    'INSERT INTO history (service_id, status, response_time, status_code) VALUES (?,?,?,?)',
    [service.id, r.status, r.responseTime, r.statusCode],
  );

  // prune oldest rows beyond cap
  const [[{ cnt }]] = await pool.execute(
    'SELECT COUNT(*) AS cnt FROM history WHERE service_id = ?', [service.id],
  );
  if (cnt > MAX_HISTORY) {
    await pool.execute(
      'DELETE FROM history WHERE service_id = ? ORDER BY checked_at ASC LIMIT ?',
      [service.id, cnt - MAX_HISTORY],
    );
  }

  const entry = { timestamp: new Date().toISOString(), ...r };
  broadcast({ type: 'check', serviceId: service.id, result: entry });
  notify(service, r.status, r).catch(e => console.error('[notify]', e.message));
  notifySubscribers(pool, service, r.status).catch(() => {});
  notifyWebhookSubscribers(pool, service, r.status).catch(() => {});
  return entry;
}

async function startMonitoring() {
  const sweep = async () => {
    const [svcs] = await pool.execute('SELECT id, name, url, maintenance_until, rt_threshold FROM services');
    for (const s of svcs) {
      if (s.maintenance_until && new Date(s.maintenance_until) > new Date()) {
        broadcast({ type: 'check', serviceId: s.id, result: { status: 'maintenance', responseTime: null, statusCode: null, timestamp: new Date().toISOString() } });
        continue;
      }
      performCheck(s).catch(e => console.error('[check]', e.message));
    }
  };
  setTimeout(sweep, 600);
  setInterval(sweep, CHECK_INTERVAL);
}

module.exports = { checkService, performCheck, startMonitoring };

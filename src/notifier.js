'use strict';

const https = require('https');

const WEBHOOK_URL  = process.env.DISCORD_WEBHOOK;
const COOLDOWN_MS  = (parseInt(process.env.WEBHOOK_COOLDOWN_MIN) || 30) * 60_000;

// serviceId → { status, sentAt }
const state       = new Map();
// serviceId → timestamp outage started
const outageSince = new Map();
// serviceIds that have had their baseline set (no alert on first check)
const baseline    = new Set();

// ─── Discord color ints ───────────────────────────────────────────────────────
const COLOR = { up: 0x22c55e, degraded: 0xf59e0b, down: 0xef4444 };
const EMOJI = { up: '🟢',    degraded: '🟡',      down: '🔴'     };
const LABEL = { up: 'Operational', degraded: 'Degraded', down: 'Down' };

// ─── Simple rate-limit state ──────────────────────────────────────────────────
let rateLimitReset = 0;   // epoch ms — don't send before this

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Low-level HTTP POST; resolves with status code, rejects on network error
function httpPost(body) {
  return new Promise((resolve, reject) => {
    const u   = new URL(WEBHOOK_URL);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      res => {
        // Track rate-limit headers
        const remaining  = parseInt(res.headers['x-ratelimit-remaining'] ?? '1');
        const resetAfter = parseFloat(res.headers['x-ratelimit-reset-after'] ?? '0') * 1000;
        if (remaining === 0) rateLimitReset = Date.now() + resetAfter + 100;

        if (res.statusCode === 429) {
          // Read body to get retry_after
          let raw = '';
          res.on('data', d => raw += d);
          res.on('end', () => {
            try {
              const j = JSON.parse(raw);
              rateLimitReset = Date.now() + (j.retry_after ?? 5) * 1000 + 100;
            } catch { rateLimitReset = Date.now() + 5000; }
            resolve(429);
          });
        } else {
          res.resume();
          resolve(res.statusCode);
        }
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Send embed with up to 3 attempts, honouring rate-limits between retries
async function sendEmbed(embed) {
  if (!WEBHOOK_URL) return;
  const body = JSON.stringify({ embeds: [embed] });
  for (let attempt = 0; attempt < 3; attempt++) {
    const wait = rateLimitReset - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      const status = await httpPost(body);
      if (status === 429) {
        // rateLimitReset was updated in httpPost; loop will sleep before next attempt
        continue;
      }
      return; // success (204 No Content from Discord)
    } catch (e) {
      console.error('[webhook http error]', e.message);
      if (attempt < 2) await sleep(2000);
    }
  }
  console.error('[webhook] gave up after 3 attempts');
}

// ─── Build embed ──────────────────────────────────────────────────────────────
function buildEmbed(service, newStatus, result, prevStatus) {
  const color   = COLOR[newStatus] ?? 0x888888;
  const emoji   = EMOJI[newStatus] ?? '⚪';
  const label   = LABEL[newStatus] ?? newStatus;
  const isUp    = newStatus === 'up';
  const wasDown = prevStatus && prevStatus !== 'up';

  let title, description;
  if (isUp && wasDown) {
    title       = `${emoji}  ${service.name} — Recovered`;
    description = 'Service is back online and responding normally.';
  } else if (newStatus === 'down') {
    title       = `${emoji}  ${service.name} — Down`;
    description = result.statusCode
      ? `Service is returning HTTP ${result.statusCode}.`
      : 'Service is unreachable or timed out.';
  } else if (newStatus === 'degraded') {
    title = `${emoji}  ${service.name} — Degraded`;
    const raw = result.rawStatus;
    if (raw === 'down' && result.statusCode >= 500) {
      description = `Service is returning HTTP ${result.statusCode}. Escalates to Down if unresolved.`;
    } else if (raw === 'down') {
      description = 'Service is unreachable. Escalates to Down if unresolved.';
    } else {
      description = result.statusCode
        ? `Service is returning HTTP ${result.statusCode}.`
        : 'Service health check failed.';
    }
  } else {
    title       = `${emoji}  ${service.name} — ${label}`;
    description = '';
  }

  const fields = [
    { name: '🔗 URL', value: `\`${service.url.replace(/`/g, "'")}\``, inline: false },
    { name: '📊 Status', value: label, inline: true },
  ];

  if (result.responseTime != null) {
    const rt = result.responseTime >= 10_000 ? 'Timeout' : `${result.responseTime} ms`;
    fields.push({ name: '⏱️ Response', value: rt, inline: true });
  }
  if (result.statusCode) {
    fields.push({ name: '📡 HTTP', value: String(result.statusCode), inline: true });
  }
  if (prevStatus && prevStatus !== newStatus) {
    fields.push({ name: '↩️ Was', value: LABEL[prevStatus] ?? prevStatus, inline: true });
  }

  // Outage duration (if recovering)
  const since = outageSince.get(service.id);
  if (isUp && since) {
    const secs = Math.round((Date.now() - since) / 1000);
    const dur  = secs < 60 ? `${secs}s` : secs < 3600 ? `${Math.round(secs/60)}m` : `${Math.round(secs/3600)}h ${Math.round((secs%3600)/60)}m`;
    fields.push({ name: '⏳ Outage duration', value: dur, inline: true });
  }

  return {
    color,
    title,
    description,
    fields,
    footer: { text: `Status Page  •  ${service.url}` },
    timestamp: new Date().toISOString(),
  };
}

// ─── Main entry point (called from monitor.js after each check) ───────────────
async function notify(service, newStatus, result) {
  if (!WEBHOOK_URL) return;

  // First ever check for this service → set baseline silently, no alert
  if (!baseline.has(service.id)) {
    baseline.add(service.id);
    state.set(service.id, { status: newStatus, sentAt: 0 });
    if (newStatus !== 'up') outageSince.set(service.id, Date.now());
    return;
  }

  const prev   = state.get(service.id);
  const prevSt = prev?.status;

  const statusChanged = prevSt !== newStatus;
  const cooldownOver  = newStatus !== 'up' && Date.now() - (prev?.sentAt ?? 0) > COOLDOWN_MS;

  if (!statusChanged && !cooldownOver) return;

  // Track outage start / clear
  if (statusChanged && newStatus !== 'up') {
    if (prevSt === 'up' || !outageSince.has(service.id)) {
      outageSince.set(service.id, Date.now());
    }
  }

  const embed = buildEmbed(service, newStatus, result, prevSt);

  try {
    await sendEmbed(embed);
    console.log(`[webhook] ${service.name} → ${newStatus}`);
    state.set(service.id, { status: newStatus, sentAt: Date.now() });
    if (newStatus === 'up') outageSince.delete(service.id);
  } catch(e) {
    console.error('[webhook error]', e.message);
  }
}

module.exports = { notify };

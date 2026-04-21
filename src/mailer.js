'use strict';

let nodemailer;
try { nodemailer = require('nodemailer'); } catch { nodemailer = null; }

function getTransport() {
  if (!nodemailer) return null;
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) return null;
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

async function sendMail({ to, subject, html }) {
  const transport = getTransport();
  if (!transport) throw new Error('SMTP is not configured — set SMTP_HOST and SMTP_USER in .env');
  await transport.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to, subject, html,
  });
}

async function notifySubscribers(pool, service, newStatus) {
  if (!getTransport()) return;
  try {
    const [subs] = await pool.execute('SELECT email FROM subscribers WHERE confirmed=1');
    if (!subs.length) return;
    const statusLabel = { up:'Recovered', down:'Down', degraded:'Degraded', maintenance:'Maintenance' }[newStatus] ?? newStatus;
    const color = { up:'#22c55e', down:'#ef4444', degraded:'#f59e0b', maintenance:'#06b6d4' }[newStatus] ?? '#888';
    const html = `
      <div style="font-family:Inter,system-ui,sans-serif;max-width:500px;margin:0 auto;background:#07070e;color:#e8e8f0;border-radius:14px;overflow:hidden">
        <div style="background:${color};padding:18px 24px">
          <h2 style="margin:0;color:#fff;font-size:1.1rem">${service.name} — ${statusLabel}</h2>
        </div>
        <div style="padding:20px 24px">
          <p style="margin:0 0 12px;color:#8888aa;font-size:.9rem">${service.url}</p>
          <p style="margin:0;font-size:.88rem">Status changed to <strong style="color:${color}">${statusLabel}</strong>.</p>
        </div>
        <div style="padding:12px 24px 20px;border-top:1px solid rgba(255,255,255,.08)">
          <a href="${process.env.SITE_URL||''}" style="font-size:.78rem;color:#7c5cfc">View status page →</a>
        </div>
      </div>`;
    await Promise.all(subs.map(s => sendMail({ to: s.email, subject: `[Status] ${service.name} — ${statusLabel}`, html })));
  } catch(e) { console.error('[mailer]', e.message); }
}

async function notifyWebhookSubscribers(pool, service, newStatus) {
  const https = require('https');
  try {
    const [subs] = await pool.execute('SELECT id, url FROM webhook_subscribers');
    if (!subs.length) return;
    const COLOR  = { up: 0x22c55e, down: 0xef4444, degraded: 0xf59e0b, maintenance: 0x06b6d4 };
    const LABEL  = { up:'Recovered', down:'Down', degraded:'Degraded', maintenance:'Maintenance' };
    const embed  = {
      color: COLOR[newStatus] ?? 0x7c5cfc,
      title: `${service.name} — ${LABEL[newStatus] ?? newStatus}`,
      description: `Status changed to **${LABEL[newStatus] ?? newStatus}**.`,
      fields: [{ name: 'URL', value: service.url, inline: false }],
      footer: { text: 'Status Page' },
      timestamp: new Date().toISOString(),
    };
    const body = JSON.stringify({ embeds: [embed] });
    await Promise.all(subs.map(s => new Promise(resolve => {
      try {
        const u = new URL(s.url);
        const req = https.request(
          { hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
          r => { r.resume(); resolve(); }
        );
        req.on('error', resolve);
        req.write(body); req.end();
      } catch { resolve(); }
    })));
  } catch(e) { console.error('[webhook-subs]', e.message); }
}

// Sends an admin-authored update to ALL channels:
//   - confirmed email subscribers
//   - all Discord webhook_subscribers rows
//   - the admin DISCORD_WEBHOOK env var
async function broadcastUpdate(pool, { title, body, severity = 'info' }) {
  const https    = require('https');
  const siteUrl  = process.env.SITE_URL || '';
  const COLOR_MAP = { info: 0x7c5cfc, minor: 0xf59e0b, major: 0xef4444, critical: 0x7c3aed };
  const color     = COLOR_MAP[severity] ?? 0x7c5cfc;
  const hexColor  = '#' + color.toString(16).padStart(6, '0');

  const results = { emailSent: 0, webhooksSent: 0, errors: [] };

  // ── Email ──────────────────────────────────────────────────────────────────
  if (getTransport()) {
    try {
      const [subs] = await pool.execute('SELECT email, token FROM subscribers WHERE confirmed=1');
      await Promise.all(subs.map(async s => {
        const unsubUrl = `${siteUrl}/unsubscribe?token=${s.token}`;
        const html = `
          <div style="font-family:Inter,system-ui,sans-serif;max-width:520px;margin:0 auto;background:#07070e;color:#e8e8f0;border-radius:14px;overflow:hidden">
            <div style="background:${hexColor};padding:18px 26px">
              <h2 style="margin:0;color:#fff;font-size:1.05rem;font-weight:700">${title.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</h2>
            </div>
            <div style="padding:22px 26px">
              <p style="margin:0 0 16px;font-size:.9rem;line-height:1.65;white-space:pre-wrap">${(body||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</p>
            </div>
            <div style="padding:12px 26px 18px;border-top:1px solid rgba(255,255,255,.08);display:flex;justify-content:space-between;align-items:center">
              <a href="${siteUrl}" style="font-size:.78rem;color:#7c5cfc;text-decoration:none">View status page →</a>
              <a href="${unsubUrl}" style="font-size:.72rem;color:#5a5a78;text-decoration:none">Unsubscribe</a>
            </div>
          </div>`;
        try {
          await sendMail({ to: s.email, subject: `[Status Update] ${title}`, html });
          results.emailSent++;
        } catch(e) { results.errors.push('email ' + s.email + ': ' + e.message); }
      }));
    } catch(e) { results.errors.push('email query: ' + e.message); }
  }

  // ── Discord webhooks ───────────────────────────────────────────────────────
  const embed = {
    color,
    title,
    description: body || undefined,
    footer: { text: 'Status Page Update' },
    timestamp: new Date().toISOString(),
  };
  const discordBody = JSON.stringify({ embeds: [embed] });

  async function postWebhook(url) {
    return new Promise(resolve => {
      try {
        const u = new URL(url);
        const req = https.request(
          { hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(discordBody) } },
          r => { r.resume(); resolve(r.statusCode); }
        );
        req.on('error', e => { results.errors.push('webhook ' + url + ': ' + e.message); resolve(0); });
        req.write(discordBody); req.end();
      } catch(e) { results.errors.push('webhook ' + url + ': ' + e.message); resolve(0); }
    });
  }

  // subscriber webhooks
  try {
    const [wSubs] = await pool.execute('SELECT url FROM webhook_subscribers');
    await Promise.all(wSubs.map(async s => {
      const code = await postWebhook(s.url);
      if (code >= 200 && code < 300) results.webhooksSent++;
    }));
  } catch(e) { results.errors.push('webhook query: ' + e.message); }

  // admin webhook
  if (process.env.DISCORD_WEBHOOK) {
    const code = await postWebhook(process.env.DISCORD_WEBHOOK);
    if (code >= 200 && code < 300) results.webhooksSent++;
  }

  return results;
}

module.exports = { sendMail, notifySubscribers, notifyWebhookSubscribers, broadcastUpdate };

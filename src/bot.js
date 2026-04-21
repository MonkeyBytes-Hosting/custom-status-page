'use strict';

const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle,
  EmbedBuilder,
} = require('discord.js');

const { randomUUID } = require('crypto');
const { pool }       = require('./db');
const { broadcast }  = require('./broadcast');
const { performCheck } = require('./monitor');

// ─── Slash command definitions ────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('service')
    .setDescription('Manage monitored services')
    .addSubcommand(s => s.setName('add').setDescription('Add a new service'))
    .addSubcommand(s => s.setName('edit').setDescription('Edit an existing service'))
    .addSubcommand(s => s.setName('remove').setDescription('Remove a service'))
    .addSubcommand(s => s.setName('list').setDescription('List all services')),

  new SlashCommandBuilder()
    .setName('incident')
    .setDescription('Manage incidents')
    .addSubcommand(s => s.setName('create').setDescription('Create a new incident'))
    .addSubcommand(s => s.setName('resolve').setDescription('Resolve an active incident'))
    .addSubcommand(s => s.setName('list').setDescription('List active incidents')),
].map(c => c.toJSON());

// ─── Register slash commands ──────────────────────────────────────────────────
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), { body: commands });
    console.log('[bot] Slash commands registered');
  } catch (e) {
    console.error('[bot] Failed to register commands:', e.message);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const STATUS_EMOJI = { up: '🟢', down: '🔴', degraded: '🟡', unknown: '⚫' };

async function getServices() {
  const [rows] = await pool.execute('SELECT id, name, url, category FROM services ORDER BY position, name');
  return rows;
}

async function getActiveIncidents() {
  const [rows] = await pool.execute(
    `SELECT id, title, severity, created_at FROM incidents WHERE status='active' ORDER BY created_at DESC`
  );
  return rows;
}

function serviceSelectMenu(services, customId, placeholder = 'Select a service…') {
  if (!services.length) return null;
  const options = services.slice(0, 25).map(s => ({ label: s.name, description: s.url.slice(0, 50), value: s.id }));
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).addOptions(options)
  );
}

function incidentSelectMenu(incidents, customId) {
  const options = incidents.slice(0, 25).map(i => ({
    label: i.title.slice(0, 100),
    description: `${i.severity} — ${new Date(i.created_at).toUTCString().slice(0,16)}`,
    value: i.id,
  }));
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder('Select an incident…').addOptions(options)
  );
}

// ─── Bot startup ──────────────────────────────────────────────────────────────
function startBot() {
  const token = process.env.DISCORD_BOT_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;
  if (!token || !clientId) {
    console.warn('[bot] DISCORD_BOT_TOKEN or DISCORD_CLIENT_ID not set — bot disabled');
    return;
  }

  registerCommands();

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once('ready', () => console.log(`[bot] Logged in as ${client.user.tag}`));

  client.on('interactionCreate', async interaction => {
    try {
      await handleInteraction(interaction);
    } catch (e) {
      console.error('[bot] interaction error:', e.message);
      const msg = { content: `❌ Error: ${e.message}`, ephemeral: true };
      if (interaction.replied || interaction.deferred) await interaction.followUp(msg).catch(() => {});
      else await interaction.reply(msg).catch(() => {});
    }
  });

  client.login(token);
}

// ─── Interaction router ───────────────────────────────────────────────────────
async function handleInteraction(interaction) {
  // ── Slash commands ──
  if (interaction.isChatInputCommand()) {
    const sub = interaction.options.getSubcommand();
    const cmd = interaction.commandName;

    if (cmd === 'service') {
      if (sub === 'add') return onServiceAdd(interaction);
      if (sub === 'edit') return onServiceEditPick(interaction);
      if (sub === 'remove') return onServiceRemovePick(interaction);
      if (sub === 'list') return onServiceList(interaction);
    }
    if (cmd === 'incident') {
      if (sub === 'create') return onIncidentCreate(interaction);
      if (sub === 'resolve') return onIncidentResolvePick(interaction);
      if (sub === 'list') return onIncidentList(interaction);
    }
    return;
  }

  // ── Select menus ──
  if (interaction.isStringSelectMenu()) {
    const id = interaction.customId;
    if (id === 'edit_service_pick')   return onServiceEditModal(interaction);
    if (id === 'remove_service_pick') return onServiceRemoveConfirm(interaction);
    if (id === 'resolve_incident_pick') return onIncidentResolveConfirm(interaction);
    return;
  }

  // ── Modals ──
  if (interaction.isModalSubmit()) {
    const id = interaction.customId;
    if (id === 'modal_service_add')         return onServiceAddSubmit(interaction);
    if (id.startsWith('modal_service_edit_')) return onServiceEditSubmit(interaction);
    if (id === 'modal_incident_create')     return onIncidentCreateSubmit(interaction);
    return;
  }

  // ── Buttons ──
  if (interaction.isButton()) {
    const id = interaction.customId;
    if (id.startsWith('confirm_remove_')) return onServiceRemoveSubmit(interaction);
    if (id.startsWith('cancel_'))         return interaction.update({ content: '↩️ Cancelled.', components: [] });
    if (id.startsWith('confirm_resolve_')) return onIncidentResolveSubmit(interaction);
    return;
  }
}

// ─── /service add ─────────────────────────────────────────────────────────────
async function onServiceAdd(interaction) {
  const modal = new ModalBuilder().setCustomId('modal_service_add').setTitle('Add Service');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('name').setLabel('Service Name').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('url').setLabel('URL').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('https://example.com')
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('category').setLabel('Category').setStyle(TextInputStyle.Short).setRequired(false).setValue('General').setMaxLength(80)
    ),
  );
  await interaction.showModal(modal);
}

async function onServiceAddSubmit(interaction) {
  const name     = interaction.fields.getTextInputValue('name').trim();
  const url      = interaction.fields.getTextInputValue('url').trim();
  const category = interaction.fields.getTextInputValue('category').trim() || 'General';

  try { new URL(url); } catch { return interaction.reply({ content: '❌ Invalid URL.', ephemeral: true }); }

  await interaction.deferReply({ ephemeral: true });

  const svc = { id: randomUUID(), name, url, category, tags: '[]' };
  await pool.execute(
    'INSERT INTO services (id, name, url, category, tags) VALUES (?,?,?,?,?)',
    [svc.id, svc.name, svc.url, svc.category, svc.tags],
  );
  const check = await performCheck(svc);
  broadcast({ type: 'service_added', service: { ...svc, tags: [], currentStatus: check.status } });

  await interaction.editReply({
    embeds: [new EmbedBuilder()
      .setColor(0x22c55e)
      .setTitle('✅ Service Added')
      .addFields(
        { name: 'Name',     value: name,     inline: true },
        { name: 'URL',      value: url,      inline: true },
        { name: 'Category', value: category, inline: true },
        { name: 'Status',   value: `${STATUS_EMOJI[check.status] ?? '⚫'} ${check.status}`, inline: true },
      )
    ],
  });
}

// ─── /service edit ────────────────────────────────────────────────────────────
async function onServiceEditPick(interaction) {
  const services = await getServices();
  if (!services.length) return interaction.reply({ content: '⚠️ No services found.', ephemeral: true });
  const row = serviceSelectMenu(services, 'edit_service_pick', 'Choose a service to edit…');
  await interaction.reply({ content: '✏️ Select a service to edit:', components: [row], ephemeral: true });
}

async function onServiceEditModal(interaction) {
  const svcId = interaction.values[0];
  const [[svc]] = await pool.execute('SELECT id, name, url, category FROM services WHERE id=?', [svcId]);
  if (!svc) return interaction.update({ content: '❌ Service not found.', components: [] });

  const modal = new ModalBuilder().setCustomId(`modal_service_edit_${svcId}`).setTitle('Edit Service');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('name').setLabel('Service Name').setStyle(TextInputStyle.Short).setRequired(true).setValue(svc.name)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('url').setLabel('URL').setStyle(TextInputStyle.Short).setRequired(true).setValue(svc.url)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('category').setLabel('Category').setStyle(TextInputStyle.Short).setRequired(false).setValue(svc.category || 'General')
    ),
  );
  await interaction.showModal(modal);
}

async function onServiceEditSubmit(interaction) {
  const svcId    = interaction.customId.replace('modal_service_edit_', '');
  const name     = interaction.fields.getTextInputValue('name').trim();
  const url      = interaction.fields.getTextInputValue('url').trim();
  const category = interaction.fields.getTextInputValue('category').trim() || 'General';

  try { new URL(url); } catch { return interaction.reply({ content: '❌ Invalid URL.', ephemeral: true }); }

  await interaction.deferReply({ ephemeral: true });
  const [r] = await pool.execute(
    'UPDATE services SET name=?, url=?, category=? WHERE id=?',
    [name, url, category, svcId],
  );
  if (!r.affectedRows) return interaction.editReply({ content: '❌ Service not found.' });
  broadcast({ type: 'service_updated', serviceId: svcId });

  await interaction.editReply({
    embeds: [new EmbedBuilder()
      .setColor(0x7c5cfc)
      .setTitle('✏️ Service Updated')
      .addFields(
        { name: 'Name',     value: name,     inline: true },
        { name: 'URL',      value: url,      inline: true },
        { name: 'Category', value: category, inline: true },
      )
    ],
  });
}

// ─── /service remove ──────────────────────────────────────────────────────────
async function onServiceRemovePick(interaction) {
  const services = await getServices();
  if (!services.length) return interaction.reply({ content: '⚠️ No services found.', ephemeral: true });
  const row = serviceSelectMenu(services, 'remove_service_pick', 'Choose a service to remove…');
  await interaction.reply({ content: '🗑️ Select a service to remove:', components: [row], ephemeral: true });
}

async function onServiceRemoveConfirm(interaction) {
  const svcId = interaction.values[0];
  const [[svc]] = await pool.execute('SELECT name, url FROM services WHERE id=?', [svcId]);
  if (!svc) return interaction.update({ content: '❌ Service not found.', components: [] });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`confirm_remove_${svcId}`).setLabel('Yes, delete').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`cancel_remove`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );
  await interaction.update({
    content: `⚠️ Are you sure you want to remove **${svc.name}** (\`${svc.url}\`)? This cannot be undone.`,
    components: [row],
  });
}

async function onServiceRemoveSubmit(interaction) {
  const svcId = interaction.customId.replace('confirm_remove_', '');
  await interaction.deferUpdate();
  const [r] = await pool.execute('DELETE FROM services WHERE id=?', [svcId]);
  if (!r.affectedRows) return interaction.editReply({ content: '❌ Service not found.', components: [] });
  broadcast({ type: 'service_removed', serviceId: svcId });
  await interaction.editReply({ content: '🗑️ Service removed.', components: [] });
}

// ─── /service list ────────────────────────────────────────────────────────────
async function onServiceList(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const services = await getServices();
  if (!services.length) return interaction.editReply({ content: '⚠️ No services.' });

  const [latestRows] = await pool.execute(`
    SELECT h.service_id, h.status
    FROM history h
    WHERE h.checked_at = (SELECT MAX(checked_at) FROM history WHERE service_id = h.service_id)
  `);
  const statusMap = Object.fromEntries(latestRows.map(r => [r.service_id, r.status]));

  const lines = services.map(s => {
    const st = statusMap[s.id] || 'unknown';
    return `${STATUS_EMOJI[st] ?? '⚫'} **${s.name}** — \`${s.url}\` *(${s.category})*`;
  });

  const embed = new EmbedBuilder()
    .setColor(0x7c5cfc)
    .setTitle(`Services (${services.length})`)
    .setDescription(lines.join('\n').slice(0, 4096));

  await interaction.editReply({ embeds: [embed] });
}

// ─── /incident create ─────────────────────────────────────────────────────────
async function onIncidentCreate(interaction) {
  const modal = new ModalBuilder().setCustomId('modal_incident_create').setTitle('Create Incident');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('title').setLabel('Title').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('body').setLabel('Description').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('severity').setLabel('Severity (minor / major / critical)').setStyle(TextInputStyle.Short).setRequired(false).setValue('minor').setMaxLength(10)
    ),
  );
  await interaction.showModal(modal);
}

async function onIncidentCreateSubmit(interaction) {
  const title    = interaction.fields.getTextInputValue('title').trim();
  const body     = interaction.fields.getTextInputValue('body').trim();
  const severity = ['minor','major','critical'].includes(interaction.fields.getTextInputValue('severity').trim().toLowerCase())
    ? interaction.fields.getTextInputValue('severity').trim().toLowerCase()
    : 'minor';

  await interaction.deferReply({ ephemeral: true });
  const id = randomUUID();
  await pool.execute(
    `INSERT INTO incidents (id, title, body, severity, status) VALUES (?,?,?,?,'active')`,
    [id, title, body, severity],
  );
  const [[row]] = await pool.execute('SELECT * FROM incidents WHERE id=?', [id]);
  broadcast({ type: 'incident_created', incident: row });

  const COLOR = { minor: 0xf59e0b, major: 0xef4444, critical: 0x7f1d1d };
  await interaction.editReply({
    embeds: [new EmbedBuilder()
      .setColor(COLOR[severity] ?? 0xf59e0b)
      .setTitle('🚨 Incident Created')
      .addFields(
        { name: 'Title',    value: title,    inline: false },
        { name: 'Severity', value: severity, inline: true },
        { name: 'Body',     value: body || '*(none)*', inline: false },
      )
    ],
  });
}

// ─── /incident resolve ────────────────────────────────────────────────────────
async function onIncidentResolvePick(interaction) {
  const incidents = await getActiveIncidents();
  if (!incidents.length) return interaction.reply({ content: '✅ No active incidents.', ephemeral: true });
  const row = incidentSelectMenu(incidents, 'resolve_incident_pick');
  await interaction.reply({ content: '✅ Select an incident to resolve:', components: [row], ephemeral: true });
}

async function onIncidentResolveConfirm(interaction) {
  const incId = interaction.values[0];
  const [[inc]] = await pool.execute('SELECT title FROM incidents WHERE id=?', [incId]);
  if (!inc) return interaction.update({ content: '❌ Incident not found.', components: [] });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`confirm_resolve_${incId}`).setLabel('Resolve').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`cancel_resolve`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );
  await interaction.update({
    content: `✅ Mark **${inc.title}** as resolved?`,
    components: [row],
  });
}

async function onIncidentResolveSubmit(interaction) {
  const incId = interaction.customId.replace('confirm_resolve_', '');
  await interaction.deferUpdate();
  await pool.execute(`UPDATE incidents SET status='resolved', resolved_at=NOW() WHERE id=?`, [incId]);
  broadcast({ type: 'incident_resolved', id: incId });
  await interaction.editReply({ content: '✅ Incident resolved.', components: [] });
}

// ─── /incident list ───────────────────────────────────────────────────────────
async function onIncidentList(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const incidents = await getActiveIncidents();
  if (!incidents.length) return interaction.editReply({ content: '✅ No active incidents.' });

  const lines = incidents.map(i =>
    `🚨 **${i.title}** — \`${i.severity}\` *(${new Date(i.created_at).toUTCString().slice(0,16)})*`
  );
  await interaction.editReply({
    embeds: [new EmbedBuilder()
      .setColor(0xef4444)
      .setTitle(`Active Incidents (${incidents.length})`)
      .setDescription(lines.join('\n').slice(0, 4096))
    ],
  });
}

module.exports = { startBot };

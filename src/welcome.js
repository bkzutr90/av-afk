// Pesan Welcome & Bye: dikirim saat member bergabung / keluar. Bisa pakai kartu gambar, template pesan bebas.
// Diatur lewat /welcome (channel, message, card, toggle, preview, status). Butuh Server Members Intent.
const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder, ChannelType, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const cfg = require('./config');
const { db } = require('./db');
require('./card'); // memastikan font CardRegular / CardBold sudah terdaftar

const EPHEMERAL = MessageFlags.Ephemeral;
const KINDS = ['welcome', 'bye'];

const DEFAULTS = {
  welcome: 'Selamat datang {user} di **{server}**! 🎉\nKamu member ke-**{count}**. Semoga betah ya!',
  bye: '**{username}** telah meninggalkan **{server}**. Sampai jumpa lagi! 👋',
};
const COLORS = { welcome: 0x2ecc71, bye: 0xe74c3c };
const LABEL = { welcome: 'Welcome', bye: 'Bye' };

db.exec(`
  CREATE TABLE IF NOT EXISTS welcome_settings (
    guild_id           TEXT PRIMARY KEY,
    welcome_channel_id TEXT,
    welcome_enabled    INTEGER NOT NULL DEFAULT 1,
    welcome_message    TEXT,
    welcome_card       INTEGER NOT NULL DEFAULT 1,
    bye_channel_id     TEXT,
    bye_enabled        INTEGER NOT NULL DEFAULT 1,
    bye_message        TEXT,
    bye_card           INTEGER NOT NULL DEFAULT 1
  );
`);

// ---------------------------------------------------------------- pengaturan
function getSettings(guildId) {
  const row = db.prepare('SELECT * FROM welcome_settings WHERE guild_id=?').get(guildId);
  const envChannel = { welcome: cfg.welcomeChannelId, bye: cfg.byeChannelId };
  const out = {};
  for (const k of KINDS) {
    out[k] = {
      channelId: row?.[`${k}_channel_id`] || envChannel[k] || null,
      enabled: row ? row[`${k}_enabled`] !== 0 : true,
      message: row?.[`${k}_message`] || DEFAULTS[k],
      card: row ? row[`${k}_card`] !== 0 : true,
    };
  }
  return out;
}

// kind hanya berasal dari KINDS (pilihan command), jadi aman dipakai di nama kolom
function setField(guildId, kind, field, value) {
  if (!KINDS.includes(kind)) throw new Error('kind tidak valid');
  const col = { channel: `${kind}_channel_id`, enabled: `${kind}_enabled`, message: `${kind}_message`, card: `${kind}_card` }[field];
  if (!col) throw new Error('field tidak valid');
  db.prepare(
    `INSERT INTO welcome_settings (guild_id, ${col}) VALUES (?, ?)
     ON CONFLICT(guild_id) DO UPDATE SET ${col}=excluded.${col}`
  ).run(guildId, value);
}

// ---------------------------------------------------------------- template
function format(template, user, guild) {
  return template
    .replace(/\\n/g, '\n')
    .replace(/\{user\}/gi, `<@${user.id}>`)
    .replace(/\{username\}/gi, user.globalName || user.username)
    .replace(/\{tag\}/gi, user.tag || user.username)
    .replace(/\{server\}/gi, guild.name)
    .replace(/\{count\}/gi, String(guild.memberCount));
}

// ---------------------------------------------------------------- kartu gambar
const CW = 934;
const CH = 300;

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function fit(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
}

async function fetchBuffer(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

async function renderGreetingCard({ kind, name, subtitle, avatarUrl }) {
  const canvas = createCanvas(CW, CH);
  const ctx = canvas.getContext('2d');
  const accent = kind === 'welcome' ? cfg.accent : '#e74c3c';

  const g = ctx.createLinearGradient(0, 0, CW, CH);
  g.addColorStop(0, '#1b1d24');
  g.addColorStop(1, '#2b2f3a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, CW, CH);

  roundRect(ctx, 20, 20, CW - 40, CH - 40, 24);
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = accent;
  ctx.stroke();

  // Avatar bulat di tengah
  const cx = CW / 2;
  const cy = 98;
  const r = 58;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  let drew = false;
  const buf = avatarUrl ? await fetchBuffer(avatarUrl) : null;
  if (buf) {
    try {
      ctx.drawImage(await loadImage(buf), cx - r, cy - r, r * 2, r * 2);
      drew = true;
    } catch {}
  }
  if (!drew) {
    ctx.fillStyle = '#4f545c';
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  }
  ctx.restore();
  ctx.beginPath();
  ctx.arc(cx, cy, r + 3, 0, Math.PI * 2);
  ctx.lineWidth = 5;
  ctx.strokeStyle = accent;
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '38px CardBold';
  ctx.fillStyle = accent;
  ctx.fillText(kind === 'welcome' ? 'WELCOME' : 'GOODBYE', cx, 202);

  ctx.font = '28px CardBold';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(fit(ctx, name, CW - 120), cx, 240);

  ctx.font = '20px CardRegular';
  ctx.fillStyle = '#b9bbbe';
  ctx.fillText(fit(ctx, subtitle, CW - 120), cx, 271);

  return canvas.toBuffer('image/png');
}

// ---------------------------------------------------------------- kirim
async function buildPayload(kind, guild, user, s, { ping }) {
  const embed = new EmbedBuilder().setColor(COLORS[kind]).setDescription(format(s.message, user, guild).slice(0, 4000)).setTimestamp();
  const payload = { embeds: [embed], allowedMentions: { users: ping && kind === 'welcome' ? [user.id] : [] } };

  if (s.card) {
    try {
      const png = await renderGreetingCard({
        kind,
        name: user.globalName || user.username,
        subtitle: kind === 'welcome' ? `Member ke-${guild.memberCount} • ${guild.name}` : `Sekarang ${guild.memberCount} member • ${guild.name}`,
        avatarUrl: user.displayAvatarURL({ extension: 'png', size: 256, forceStatic: true }),
      });
      payload.files = [new AttachmentBuilder(png, { name: `${kind}.png` })];
      embed.setImage(`attachment://${kind}.png`);
    } catch (err) {
      console.warn('[welcome] gagal membuat kartu, kirim tanpa gambar:', err.message);
    }
  }
  return payload;
}

async function sendGreeting(kind, guild, user) {
  const s = getSettings(guild.id)[kind];
  if (!s.enabled || !s.channelId) return;
  const ch = await guild.channels.fetch(s.channelId).catch(() => null);
  if (!ch?.isTextBased()) {
    console.warn(`[welcome] channel ${kind} (${s.channelId}) tidak ditemukan`);
    return;
  }
  const payload = await buildPayload(kind, guild, user, s, { ping: true });
  await ch.send(payload).catch((err) => console.warn(`[welcome] gagal kirim ${kind}:`, err.message));
}

function startWelcome(client) {
  client.on('guildMemberAdd', (member) => {
    if (member.user.bot) return;
    sendGreeting('welcome', member.guild, member.user).catch((err) => console.error('[welcome] error:', err));
  });
  client.on('guildMemberRemove', (member) => {
    if (!member.user || member.user.bot) return;
    sendGreeting('bye', member.guild, member.user).catch((err) => console.error('[bye] error:', err));
  });
  console.log('[welcome] aktif (welcome & bye)');
}

// ---------------------------------------------------------------- /welcome
const kindOption = (o) =>
  o
    .setName('tipe')
    .setDescription('Welcome (member masuk) atau Bye (member keluar)')
    .setRequired(true)
    .addChoices({ name: 'Welcome (masuk)', value: 'welcome' }, { name: 'Bye (keluar)', value: 'bye' });

const command = {
  data: new SlashCommandBuilder()
    .setName('welcome')
    .setDescription('Atur pesan welcome & bye')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) =>
      s
        .setName('channel')
        .setDescription('Pilih channel untuk pesan welcome / bye')
        .addStringOption(kindOption)
        .addChannelOption((o) =>
          o.setName('channel').setDescription('Channel teks tujuan').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true)
        )
    )
    .addSubcommand((s) =>
      s
        .setName('message')
        .setDescription('Ubah isi pesan (kosongkan = kembali ke default)')
        .addStringOption(kindOption)
        .addStringOption((o) =>
          o.setName('teks').setDescription('Variabel: {user} {username} {tag} {server} {count}. Pakai \\n untuk baris baru.').setMaxLength(1000)
        )
    )
    .addSubcommand((s) =>
      s.setName('card').setDescription('Aktif/nonaktifkan gambar kartu').addStringOption(kindOption).addBooleanOption((o) => o.setName('aktif').setDescription('Pakai kartu gambar?').setRequired(true))
    )
    .addSubcommand((s) =>
      s.setName('toggle').setDescription('Hidupkan/matikan pesan').addStringOption(kindOption).addBooleanOption((o) => o.setName('aktif').setDescription('Aktifkan?').setRequired(true))
    )
    .addSubcommand((s) => s.setName('preview').setDescription('Lihat contoh pesan (hanya kamu yang melihat)').addStringOption(kindOption))
    .addSubcommand((s) => s.setName('status').setDescription('Lihat pengaturan welcome & bye saat ini')),

  async execute(i) {
    const sub = i.options.getSubcommand();
    const kind = i.options.getString('tipe');

    if (sub === 'channel') {
      const ch = i.options.getChannel('channel', true);
      const perms = ch.permissionsFor(i.guild.members.me);
      const need = [
        ['ViewChannel', 'Lihat Channel'],
        ['SendMessages', 'Kirim Pesan'],
        ['EmbedLinks', 'Sematkan Link'],
        ['AttachFiles', 'Lampirkan File'],
      ].filter(([f]) => !perms?.has(PermissionFlagsBits[f]));
      setField(i.guildId, kind, 'channel', ch.id);
      let msg = `✅ Channel **${LABEL[kind]}** diatur ke ${ch}.`;
      if (need.length) msg += `\n⚠️ Bot belum punya izin: ${need.map((n) => n[1]).join(', ')} di channel itu.`;
      return i.reply({ content: msg, flags: EPHEMERAL });
    }

    if (sub === 'message') {
      const teks = i.options.getString('teks');
      setField(i.guildId, kind, 'message', teks || null);
      return i.reply({ content: teks ? `✅ Pesan **${LABEL[kind]}** diperbarui. Coba dengan \`/welcome preview\`.` : `♻️ Pesan **${LABEL[kind]}** dikembalikan ke default.`, flags: EPHEMERAL });
    }

    if (sub === 'card') {
      const on = i.options.getBoolean('aktif', true);
      setField(i.guildId, kind, 'card', on ? 1 : 0);
      return i.reply({ content: `✅ Kartu gambar **${LABEL[kind]}**: ${on ? 'aktif' : 'nonaktif'}.`, flags: EPHEMERAL });
    }

    if (sub === 'toggle') {
      const on = i.options.getBoolean('aktif', true);
      setField(i.guildId, kind, 'enabled', on ? 1 : 0);
      return i.reply({ content: `✅ Pesan **${LABEL[kind]}**: ${on ? 'aktif' : 'nonaktif'}.`, flags: EPHEMERAL });
    }

    if (sub === 'preview') {
      await i.deferReply({ flags: EPHEMERAL });
      const s = getSettings(i.guildId)[kind];
      const payload = await buildPayload(kind, i.guild, i.user, s, { ping: false });
      return i.editReply(payload);
    }

    // status
    const all = getSettings(i.guildId);
    const embed = new EmbedBuilder().setColor(cfg.accent).setTitle('👋 Pengaturan Welcome & Bye');
    for (const k of KINDS) {
      const s = all[k];
      embed.addFields({
        name: LABEL[k],
        value: [
          `Status: **${s.enabled ? 'aktif' : 'nonaktif'}**`,
          `Channel: ${s.channelId ? `<#${s.channelId}>` : '_belum diatur_'}`,
          `Kartu gambar: **${s.card ? 'ya' : 'tidak'}**`,
          `Pesan: ${s.message.slice(0, 200).replace(/\n/g, ' ')}`,
        ].join('\n'),
      });
    }
    embed.setFooter({ text: 'Variabel: {user} {username} {tag} {server} {count}' });
    return i.reply({ embeds: [embed], flags: EPHEMERAL, allowedMentions: { parse: [] } });
  },
};

module.exports = { command, startWelcome };

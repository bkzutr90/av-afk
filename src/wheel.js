// Spin wheel bersama: roda berputar dikirim sebagai GIF, setelah berhenti pesan diganti kartu hasil (gambar).
// Dipakai oleh /bracket spin (undian slot tim) dan /spin (map, killer, pilihan bebas).
// Butuh paket: gifenc (npm i gifenc)
const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { createCanvas } = require('@napi-rs/canvas');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');
const { randomInt } = require('crypto');
const cfg = require('./config');
const { db } = require('./db');
require('./card'); // memastikan font CardRegular / CardBold sudah terdaftar

const EPHEMERAL = MessageFlags.Ephemeral;
const NO_PING = { parse: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SPIN_SECONDS = 5; // lama roda berputar di GIF
const FRAME_MS = 60; // jeda antar frame GIF
const GIF_SCALE = 0.6; // GIF digambar lebih kecil supaya file ringan
const MAX_ITEMS = 40;
const SPIN_PUBLIC = process.env.SPIN_PUBLIC === '1'; // 1 = semua member boleh /spin; default hanya admin

const spinning = new Set(); // guild yang sedang memutar roda (dipakai juga oleh bracket.js)

db.exec(`
  CREATE TABLE IF NOT EXISTS spin_items (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    kind     TEXT NOT NULL,               -- map | killer
    name     TEXT NOT NULL COLLATE NOCASE,
    UNIQUE (guild_id, kind, name)
  );
`);

// ---------------------------------------------------------------- gambar roda
const PALETTE = ['#e74c3c', '#e67e22', '#d4a017', '#2ecc71', '#1abc9c', '#3498db', '#9b59b6', '#e84393'];
const WW = 580;
const WH = 600;

function fit(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
}

/** Gambar roda di ctx (koordinat 580x600). Penunjuk di atas (-90°). Irisan ke-i mulai di `angle + i*step`. */
function drawWheel(ctx, labels, angle, winnerIdx = null) {
  const cx = WW / 2;
  const cy = 330;
  const R = 250;
  const n = labels.length;
  const step = (Math.PI * 2) / n;

  const bg = ctx.createLinearGradient(0, 0, WW, WH);
  bg.addColorStop(0, '#1b1d24');
  bg.addColorStop(1, '#2b2f3a');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, WW, WH);

  const fontSize = n > 24 ? 12 : n > 16 ? 14 : n > 10 ? 17 : n > 6 ? 20 : 24;
  for (let i = 0; i < n; i++) {
    let ci = i % PALETTE.length;
    if (i === n - 1 && n > 1 && ci === 0) ci = 3; // irisan terakhir jangan sama warna dengan irisan pertama
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R, angle + i * step, angle + (i + 1) * step);
    ctx.closePath();
    ctx.fillStyle = PALETTE[ci];
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#1b1d24';
    ctx.stroke();

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle + (i + 0.5) * step);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.font = `${fontSize}px CardBold`;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(fit(ctx, labels[i], R - 80), R - 20, 0);
    ctx.restore();
  }

  if (winnerIdx !== null) {
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R - 2, angle + winnerIdx * step, angle + (winnerIdx + 1) * step);
    ctx.closePath();
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
  }

  // Cincin luar + hub tengah
  ctx.beginPath();
  ctx.arc(cx, cy, R + 4, 0, Math.PI * 2);
  ctx.lineWidth = 8;
  ctx.strokeStyle = cfg.accent;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, 30, 0, Math.PI * 2);
  ctx.fillStyle = '#1b1d24';
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = cfg.accent;
  ctx.stroke();

  // Penunjuk
  ctx.beginPath();
  ctx.moveTo(cx - 20, cy - R - 28);
  ctx.lineTo(cx + 20, cy - R - 28);
  ctx.lineTo(cx, cy - R + 12);
  ctx.closePath();
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#1b1d24';
  ctx.stroke();
}

/** GIF roda berputar: melambat (ease-out) lalu berhenti tepat di pemenang. Diputar sekali, berhenti di frame terakhir. */
async function buildSpinGif(labels, winner) {
  const n = labels.length;
  const step = (Math.PI * 2) / n;
  const start = Math.random() * Math.PI * 2;
  const target = -Math.PI / 2 - (winner + 0.5) * step + (Math.random() - 0.5) * step * 0.6;
  const delta = ((((target - start) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) + Math.PI * 2 * 4;

  const w = Math.round(WW * GIF_SCALE);
  const h = Math.round(WH * GIF_SCALE);
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  const frames = Math.round((SPIN_SECONDS * 1000) / FRAME_MS);
  const gif = GIFEncoder();

  const paint = (angle, win) => {
    ctx.setTransform(GIF_SCALE, 0, 0, GIF_SCALE, 0, 0);
    drawWheel(ctx, labels, angle, win);
    return ctx.getImageData(0, 0, w, h).data;
  };

  // Palet satu kali dari frame akhir (berisi semua warna roda) supaya cepat dan konsisten antar frame
  const palette = quantize(paint(start + delta, winner), 256, { format: 'rgb565' });

  for (let k = 0; k <= frames; k++) {
    const t = k / frames;
    const eased = 1 - (1 - t) ** 3;
    const last = k === frames;
    const data = paint(start + delta * eased, last ? winner : null);
    gif.writeFrame(applyPalette(data, palette, 'rgb565'), w, h, {
      palette: k === 0 ? palette : undefined,
      delay: last ? 3000 : FRAME_MS,
      repeat: -1, // putar sekali saja
    });
    if (k % 8 === 7) await new Promise((r) => setImmediate(r)); // beri napas ke event loop
  }
  gif.finish();
  return Buffer.from(gif.bytes());
}

/** Kartu hasil (gambar): judul kecil, nama besar, keterangan. */
function renderResultCard({ heading, name, subtitle }) {
  const W = 934;
  const H = 300;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const accent = cfg.accent;

  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#1b1d24');
  g.addColorStop(1, '#2b2f3a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  ctx.beginPath();
  const x = 20, y = 20, w = W - 40, h = H - 40, r = 24;
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = accent;
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '28px CardBold';
  ctx.fillStyle = accent;
  ctx.fillText(fit(ctx, heading, W - 120), W / 2, 92);

  let size = 64;
  ctx.font = `${size}px CardBold`;
  while (size > 30 && ctx.measureText(name).width > W - 120) {
    size -= 4;
    ctx.font = `${size}px CardBold`;
  }
  ctx.fillStyle = '#ffffff';
  ctx.fillText(fit(ctx, name, W - 120), W / 2, 180);

  ctx.font = '24px CardRegular';
  ctx.fillStyle = '#b9bbbe';
  ctx.fillText(fit(ctx, subtitle, W - 120), W / 2, 238);

  return canvas.toBuffer('image/png');
}

/**
 * Putar roda: kirim GIF dulu, lalu ganti dengan kartu hasil.
 * `i` harus interaksi yang belum dibalas (atau sudah deferReply tanpa edit).
 */
async function playSpin(i, { labels, winner, title, heading, subtitle, resultText }) {
  if (!i.deferred && !i.replied) await i.deferReply();

  const gif = await buildSpinGif(labels, winner);
  const spinEmbed = new EmbedBuilder()
    .setColor(cfg.accent)
    .setTitle(title)
    .setDescription(`Roda berputar... (${labels.length} pilihan)`)
    .setImage('attachment://spin.gif');
  await i.editReply({ embeds: [spinEmbed], files: [new AttachmentBuilder(gif, { name: 'spin.gif' })], attachments: [], allowedMentions: NO_PING });

  await sleep(SPIN_SECONDS * 1000 + 1500); // tunggu GIF selesai berputar

  const png = renderResultCard({ heading, name: labels[winner], subtitle });
  const doneEmbed = new EmbedBuilder().setColor(cfg.accent).setTitle(title).setDescription(resultText).setImage('attachment://result.png');
  await i.editReply({ embeds: [doneEmbed], files: [new AttachmentBuilder(png, { name: 'result.png' })], attachments: [], allowedMentions: NO_PING });
}

// ---------------------------------------------------------------- daftar map / killer
const KINDS = {
  map: { label: 'Map', emoji: '🗺️', heading: 'MAP TERPILIH' },
  killer: { label: 'Killer', emoji: '🔪', heading: 'KILLER TERPILIH' },
  custom: { label: 'Pilihan', emoji: '🎡', heading: 'HASIL SPIN' },
};
const kindChoices = [
  { name: 'Map', value: 'map' },
  { name: 'Killer', value: 'killer' },
];

const getItems = (g, kind) => db.prepare('SELECT name FROM spin_items WHERE guild_id=? AND kind=? ORDER BY id').all(g, kind).map((r) => r.name);
const splitList = (s) => [...new Set(s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean))];

const isAdmin = (i) => !!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
const adminOnly = (i) => i.reply({ content: '❌ Hanya admin (izin **Manage Server**) yang bisa memakai perintah ini.', flags: EPHEMERAL });

async function runSpin(i, kind, labels) {
  const g = i.guildId;
  if (!SPIN_PUBLIC && !isAdmin(i)) return adminOnly(i);
  if (spinning.has(g)) return i.reply({ content: '⏳ Roda masih berputar, tunggu sebentar.', flags: EPHEMERAL });

  spinning.add(g);
  try {
    await i.deferReply();
    const K = KINDS[kind];
    const winner = randomInt(labels.length);
    const by = i.member?.displayName || i.user.globalName || i.user.username;
    await playSpin(i, {
      labels,
      winner,
      title: `${K.emoji} Spin ${K.label}`,
      heading: K.heading,
      subtitle: `Dari ${labels.length} pilihan • diputar oleh ${by}`,
      resultText: `${K.emoji} **${labels[winner]}**`,
    });
  } catch (err) {
    console.error('[spin] gagal:', err);
    await i.editReply({ content: '❌ Terjadi error saat memutar roda.', embeds: [], files: [], attachments: [] }).catch(() => {});
  } finally {
    spinning.delete(g);
  }
}

// ---------------------------------------------------------------- /spin
const jenis = (o) => o.setName('jenis').setDescription('Map atau Killer').setRequired(true).addChoices(...kindChoices);

const command = {
  data: new SlashCommandBuilder()
    .setName('spin')
    .setDescription('Spin wheel: map, killer, atau pilihan bebas')
    .addSubcommand((s) => s.setName('map').setDescription('Putar roda untuk memilih map'))
    .addSubcommand((s) => s.setName('killer').setDescription('Putar roda untuk memilih killer'))
    .addSubcommand((s) =>
      s
        .setName('custom')
        .setDescription('Putar roda dengan pilihan bebas')
        .addStringOption((o) => o.setName('opsi').setDescription('Pisahkan dengan koma, mis. "A, B, C"').setRequired(true).setMaxLength(900))
    )
    .addSubcommand((s) =>
      s
        .setName('tambah')
        .setDescription('Tambah map/killer ke daftar roda (admin). Banyak sekaligus: pisahkan dengan koma')
        .addStringOption(jenis)
        .addStringOption((o) => o.setName('nama').setDescription('Nama, mis. "Map A, Map B"').setRequired(true).setMaxLength(900))
    )
    .addSubcommand((s) =>
      s
        .setName('hapus')
        .setDescription('Hapus satu map/killer dari daftar (admin)')
        .addStringOption(jenis)
        .addStringOption((o) => o.setName('nama').setDescription('Nama yang dihapus').setRequired(true).setMaxLength(40))
    )
    .addSubcommand((s) => s.setName('daftar').setDescription('Lihat daftar map/killer di roda').addStringOption(jenis))
    .addSubcommand((s) => s.setName('reset').setDescription('Kosongkan daftar map/killer (admin)').addStringOption(jenis)),

  async execute(i) {
    const sub = i.options.getSubcommand();
    const g = i.guildId;

    if (sub === 'map' || sub === 'killer') {
      const items = getItems(g, sub);
      if (items.length < 2) {
        return i.reply({ content: `❌ Daftar ${KINDS[sub].label.toLowerCase()} belum cukup (minimal 2). Isi dengan \`/spin tambah\`.`, flags: EPHEMERAL });
      }
      return runSpin(i, sub, items);
    }

    if (sub === 'custom') {
      const items = splitList(i.options.getString('opsi', true)).map((x) => x.slice(0, 40));
      if (items.length < 2) return i.reply({ content: '❌ Isi minimal 2 pilihan, dipisah koma.', flags: EPHEMERAL });
      if (items.length > MAX_ITEMS) return i.reply({ content: `❌ Maksimal ${MAX_ITEMS} pilihan.`, flags: EPHEMERAL });
      return runSpin(i, 'custom', items);
    }

    if (sub === 'daftar') {
      const kind = i.options.getString('jenis', true);
      const items = getItems(g, kind);
      const K = KINDS[kind];
      const embed = new EmbedBuilder()
        .setColor(cfg.accent)
        .setTitle(`${K.emoji} Daftar ${K.label} (${items.length}/${MAX_ITEMS})`)
        .setDescription(items.length ? items.map((n, idx) => `**${idx + 1}.** ${n}`).join('\n').slice(0, 4000) : `_Kosong. Tambah dengan \`/spin tambah jenis:${K.label}\`._`);
      return i.reply({ embeds: [embed], flags: EPHEMERAL, allowedMentions: NO_PING });
    }

    // ---- sisanya khusus admin
    if (!isAdmin(i)) return adminOnly(i);
    const kind = i.options.getString('jenis', true);
    const K = KINDS[kind];

    if (sub === 'tambah') {
      const names = splitList(i.options.getString('nama', true));
      if (!names.length) return i.reply({ content: '❌ Nama kosong.', flags: EPHEMERAL });
      let count = getItems(g, kind).length;
      const added = [];
      const skipped = [];
      for (const n of names) {
        if (n.length > 40) {
          skipped.push(`${n.slice(0, 20)}… (terlalu panjang)`);
          continue;
        }
        if (count >= MAX_ITEMS) {
          skipped.push(`${n} (maksimal ${MAX_ITEMS})`);
          continue;
        }
        const r = db.prepare('INSERT OR IGNORE INTO spin_items (guild_id, kind, name) VALUES (?, ?, ?)').run(g, kind, n);
        if (r.changes) {
          added.push(n);
          count++;
        } else skipped.push(`${n} (sudah ada)`);
      }
      let msg = `✅ ${K.label}: ditambahkan **${added.length}**. Total: **${count}**.`;
      if (added.length) msg += `\n${added.map((n) => `• ${n}`).join('\n')}`;
      if (skipped.length) msg += `\n⚠️ Dilewati:\n${skipped.map((n) => `• ${n}`).join('\n')}`;
      return i.reply({ content: msg.slice(0, 1900), flags: EPHEMERAL, allowedMentions: NO_PING });
    }

    if (sub === 'hapus') {
      const nama = i.options.getString('nama', true).trim();
      const r = db.prepare('DELETE FROM spin_items WHERE guild_id=? AND kind=? AND name=?').run(g, kind, nama);
      return i.reply({ content: r.changes ? `🗑️ **${nama}** dihapus dari daftar ${K.label.toLowerCase()}.` : '❌ Tidak ditemukan.', flags: EPHEMERAL, allowedMentions: NO_PING });
    }

    // reset
    db.prepare('DELETE FROM spin_items WHERE guild_id=? AND kind=?').run(g, kind);
    return i.reply({ content: `♻️ Daftar ${K.label.toLowerCase()} dikosongkan.`, flags: EPHEMERAL });
  },
};

module.exports = { command, playSpin, spinning, getItems, buildSpinGif, renderResultCard };

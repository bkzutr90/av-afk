// Bracket / bagan turnamen 16 tim + Spin Wheel undian slot.
// Alur: /bracket tambah (daftar tim) -> /bracket spin (undi slot satu per satu) -> /bracket hasil (isi pemenang) -> /bracket tampil
// Bagan digambar sebagai gambar PNG (canvas). Roda undian: GIF berputar dulu, lalu diganti kartu hasil (lihat wheel.js).
const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { createCanvas } = require('@napi-rs/canvas');
const { randomInt } = require('crypto');
const cfg = require('./config');
const { db } = require('./db');
require('./card'); // memastikan font CardRegular / CardBold sudah terdaftar
const { playSpin, spinning } = require('./wheel'); // roda GIF + kartu hasil

const EPHEMERAL = MessageFlags.Ephemeral;
const NO_PING = { parse: [] };
const SIZE = 16;
const ROUNDS = 4; // 16 besar, quarter, semifinal, final
const DEFAULT_TITLE = 'ARVEXIS COMMUNITY — VIOLENCE DISTRICT FUN MATCH';
const DEFAULT_PRIZE = 'Rp250.000';

const pad = (n) => String(n).padStart(2, '0');

db.exec(`
  CREATE TABLE IF NOT EXISTS bracket_event (
    guild_id TEXT PRIMARY KEY,
    title    TEXT,
    prize    TEXT
  );
  CREATE TABLE IF NOT EXISTS bracket_teams (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    name     TEXT NOT NULL COLLATE NOCASE,
    slot     INTEGER,                      -- 1..16 setelah diundi, NULL = belum diundi
    UNIQUE (guild_id, name),
    UNIQUE (guild_id, slot)
  );
  CREATE TABLE IF NOT EXISTS bracket_results (
    guild_id TEXT NOT NULL,
    stage    INTEGER NOT NULL,             -- 1 = 16 besar, 2 = QF, 3 = SF, 4 = Final
    idx      INTEGER NOT NULL,             -- urutan match di babak itu (mulai 0)
    winner   INTEGER NOT NULL,             -- nomor slot pemenang
    PRIMARY KEY (guild_id, stage, idx)
  );
`);

// ---------------------------------------------------------------- struktur match
// Match "M1" = Tim 01 vs Tim 02, "QF1" = Pemenang M1 vs M2, dst.
const MATCHES = {};
for (let j = 0; j < 8; j++) MATCHES[`M${j + 1}`] = { r: 1, j, label: `Match ${pad(j + 1)} (16 Besar)`, short: `Match ${pad(j + 1)}` };
for (let j = 0; j < 4; j++) MATCHES[`QF${j + 1}`] = { r: 2, j, label: `Quarter Final ${j + 1}`, short: `QF ${j + 1}` };
for (let j = 0; j < 2; j++) MATCHES[`SF${j + 1}`] = { r: 3, j, label: `Semifinal ${j + 1}`, short: `SF ${j + 1}` };
MATCHES.F = { r: 4, j: 0, label: 'Grand Final', short: 'Grand Final' };

// Slot yang menempati kotak (r, j): r=0 -> slot awal; r>0 -> pemenang match (r, j) kalau sudah ada.
const slotOf = (results, r, j) => (r === 0 ? j + 1 : (results.get(`${r}:${j}`) ?? null));

// ---------------------------------------------------------------- data
function loadState(guildId) {
  const names = Array(SIZE).fill(null);
  const teams = db.prepare('SELECT id, name, slot FROM bracket_teams WHERE guild_id=? ORDER BY id').all(guildId);
  for (const t of teams) if (t.slot) names[t.slot - 1] = t.name;
  const results = new Map();
  for (const r of db.prepare('SELECT stage, idx, winner FROM bracket_results WHERE guild_id=?').all(guildId)) results.set(`${r.stage}:${r.idx}`, r.winner);
  const ev = db.prepare('SELECT title, prize FROM bracket_event WHERE guild_id=?').get(guildId);
  return { teams, names, results, title: ev?.title || DEFAULT_TITLE, prize: ev?.prize || DEFAULT_PRIZE };
}

// Kalau hasil sebuah match berubah / dihapus, hasil di babak berikutnya yang tidak valid lagi ikut dihapus.
function pruneDownstream(guildId, results, r, j) {
  if (r >= ROUNDS) return;
  const nr = r + 1;
  const nj = j >> 1;
  const key = `${nr}:${nj}`;
  const w = results.get(key);
  if (w === undefined) return;
  const a = slotOf(results, r, nj * 2);
  const b = slotOf(results, r, nj * 2 + 1);
  if (w === a || w === b) return;
  results.delete(key);
  db.prepare('DELETE FROM bracket_results WHERE guild_id=? AND stage=? AND idx=?').run(guildId, nr, nj);
  pruneDownstream(guildId, results, nr, nj);
}

// ---------------------------------------------------------------- gambar bagan
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

function placeholder(r, j) {
  if (r === 0) return `Tim ${pad(j + 1)}`;
  if (r === ROUNDS) return 'Juara';
  return `Pemenang ${r === 1 ? 'M' : r === 2 ? 'QF' : 'SF'}${j + 1}`;
}

function renderBracket({ title, prize, names, results }) {
  const W = 1430;
  const H = 790;
  const X0 = 40;
  const CW = 230;
  const GAP = 50;
  const TOP = 120;
  const ROWH = 40;
  const BH = 32;
  const accent = cfg.accent;
  const colX = (r) => X0 + r * (CW + GAP);

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#1b1d24');
  g.addColorStop(1, '#2b2f3a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // Posisi tengah-y tiap kotak: babak berikutnya di tengah dua kotak sebelumnya
  const ys = [Array.from({ length: SIZE }, (_, j) => TOP + j * ROWH + BH / 2)];
  for (let r = 1; r <= ROUNDS; r++) {
    ys[r] = Array.from({ length: SIZE >> r }, (_, j) => (ys[r - 1][2 * j] + ys[r - 1][2 * j + 1]) / 2);
  }

  // Judul
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '30px CardBold';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(fit(ctx, title, W - 80), W / 2, 40);
  ctx.font = '18px CardRegular';
  ctx.fillStyle = '#b9bbbe';
  ctx.fillText(`Prize Pool ${prize}`, W / 2, 74);

  // Judul kolom
  const heads = ['BABAK 16 BESAR', 'QUARTER FINAL', 'SEMIFINAL', 'GRAND FINAL', 'JUARA'];
  ctx.font = '17px CardBold';
  ctx.fillStyle = accent;
  heads.forEach((h, r) => ctx.fillText(h, colX(r) + CW / 2, 102));

  // Garis penghubung
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  for (let r = 1; r <= ROUNDS; r++) {
    for (let j = 0; j < SIZE >> r; j++) {
      const x1 = colX(r - 1) + CW;
      const xm = x1 + GAP / 2;
      const x2 = colX(r);
      const ya = ys[r - 1][2 * j];
      const yb = ys[r - 1][2 * j + 1];
      const yp = ys[r][j];
      ctx.beginPath();
      ctx.moveTo(x1, ya);
      ctx.lineTo(xm, ya);
      ctx.lineTo(xm, yb);
      ctx.lineTo(x1, yb);
      ctx.moveTo(xm, yp);
      ctx.lineTo(x2, yp);
      ctx.stroke();
    }
  }

  // Kotak tim
  for (let r = 0; r <= ROUNDS; r++) {
    for (let j = 0; j < SIZE >> r; j++) {
      const slot = slotOf(results, r, j);
      const name = slot ? names[slot - 1] : null;
      const x = colX(r);
      const cy = ys[r][j];
      const parent = r < ROUNDS ? results.get(`${r + 1}:${j >> 1}`) : undefined;
      const lost = !!name && parent !== undefined && parent !== slot;
      const champion = r === ROUNDS && !!name;

      roundRect(ctx, x, cy - BH / 2, CW, BH, 8);
      if (champion) {
        ctx.fillStyle = accent;
        ctx.fill();
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#f1c40f';
        ctx.stroke();
      } else if (name && r > 0) {
        ctx.fillStyle = 'rgba(46,204,113,0.18)';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#2ecc71';
        ctx.stroke();
      } else if (name) {
        ctx.fillStyle = lost ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.10)';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = lost ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.35)';
        ctx.stroke();
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.04)';
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        ctx.stroke();
      }

      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      if (r === 0 && name) {
        ctx.font = '13px CardRegular';
        ctx.fillStyle = '#8e9297';
        ctx.fillText(pad(slot), x + 10, cy);
        ctx.font = '17px CardBold';
        ctx.fillStyle = lost ? '#6b6f78' : '#ffffff';
        ctx.fillText(fit(ctx, name, CW - 52), x + 38, cy);
      } else if (name) {
        ctx.font = '17px CardBold';
        ctx.fillStyle = lost ? '#6b6f78' : '#ffffff';
        ctx.fillText(fit(ctx, name, CW - 24), x + 12, cy);
      } else {
        ctx.font = '15px CardRegular';
        ctx.fillStyle = '#7c808a';
        ctx.fillText(placeholder(r, j), x + (r === 0 ? 38 : 12), cy);
      }
    }
  }

  return canvas.toBuffer('image/png');
}

// ---------------------------------------------------------------- aksi
const isAdmin = (i) => !!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
const adminOnly = (i) => i.reply({ content: '❌ Hanya admin (izin **Manage Server**) yang bisa memakai perintah ini.', flags: EPHEMERAL });

const bracketAttachment = (st) =>
  new AttachmentBuilder(renderBracket({ title: st.title, prize: st.prize, names: st.names, results: st.results }), { name: 'bracket.png' });

async function doSpin(i) {
  const g = i.guildId;
  if (spinning.has(g)) return i.reply({ content: '⏳ Roda masih berputar, tunggu sebentar.', flags: EPHEMERAL });

  const used = new Set(db.prepare('SELECT slot FROM bracket_teams WHERE guild_id=? AND slot IS NOT NULL').all(g).map((r) => r.slot));
  let slot = null;
  for (let s = 1; s <= SIZE; s++) {
    if (!used.has(s)) {
      slot = s;
      break;
    }
  }
  if (!slot) return i.reply({ content: '✅ Semua slot sudah terisi. Lihat hasilnya dengan `/bracket tampil`.', flags: EPHEMERAL });

  const pool = db.prepare('SELECT id, name FROM bracket_teams WHERE guild_id=? AND slot IS NULL ORDER BY id').all(g);
  if (!pool.length) return i.reply({ content: '❌ Tidak ada tim yang tersisa untuk diundi. Tambahkan dulu dengan `/bracket tambah`.', flags: EPHEMERAL });

  spinning.add(g);
  try {
    await i.deferReply();
    const w = randomInt(pool.length);
    const picked = pool[w];
    db.prepare('UPDATE bracket_teams SET slot=? WHERE id=?').run(slot, picked.id); // simpan dulu, animasi hanya tampilan

    const matchNo = Math.ceil(slot / 2);
    const partner = slot % 2 === 1 ? slot + 1 : slot - 1;
    const opp = db.prepare('SELECT name FROM bracket_teams WHERE guild_id=? AND slot=?').get(g, partner)?.name;
    const left = pool.length - 1;

    await playSpin(i, {
      labels: pool.map((t) => t.name),
      winner: w,
      title: `🎡 Undian Slot ${pad(slot)} • Match ${pad(matchNo)}`,
      heading: `SLOT ${pad(slot)} • MATCH ${pad(matchNo)}`,
      subtitle: opp ? `vs ${opp}` : 'Lawan belum diundi',
      resultText:
        `🎯 **${picked.name}** mendapat **Slot ${pad(slot)}**\n` +
        `Match ${pad(matchNo)}: ${opp ? `vs **${opp}**` : 'lawan belum diundi'}\n` +
        (left ? `Sisa **${left}** tim belum diundi.` : '✅ **Undian selesai!** Pakai `/bracket tampil` untuk melihat bagan.'),
    });
  } catch (err) {
    console.error('[bracket] spin gagal:', err);
    await i.editReply({ content: '❌ Terjadi error saat memutar roda. Cek `/bracket daftar` untuk melihat hasil undian terakhir.', embeds: [], files: [], attachments: [] }).catch(() => {});
  } finally {
    spinning.delete(g);
  }
}

// ---------------------------------------------------------------- /bracket
const matchChoices = Object.entries(MATCHES).map(([value, m]) => ({ name: m.label, value }));

const command = {
  data: new SlashCommandBuilder()
    .setName('bracket')
    .setDescription('Bagan turnamen 16 tim + spin wheel undian')
    .addSubcommand((s) =>
      s
        .setName('judul')
        .setDescription('Atur judul & prize pool pada bagan (admin)')
        .addStringOption((o) => o.setName('nama').setDescription('Judul event').setMaxLength(80))
        .addStringOption((o) => o.setName('prize').setDescription('Prize pool, mis. Rp250.000').setMaxLength(40))
    )
    .addSubcommand((s) =>
      s
        .setName('tambah')
        .setDescription('Tambah tim peserta (admin). Beberapa tim: pisahkan dengan koma')
        .addStringOption((o) => o.setName('nama').setDescription('Nama tim, mis. "Tim A, Tim B, Tim C"').setRequired(true).setMaxLength(600))
    )
    .addSubcommand((s) =>
      s.setName('hapus').setDescription('Hapus satu tim (admin)').addStringOption((o) => o.setName('nama').setDescription('Nama tim').setRequired(true).setMaxLength(40))
    )
    .addSubcommand((s) => s.setName('daftar').setDescription('Lihat daftar tim & slot undian'))
    .addSubcommand((s) => s.setName('spin').setDescription('Putar roda: undi 1 tim ke slot berikutnya (admin)'))
    .addSubcommand((s) =>
      s
        .setName('hasil')
        .setDescription('Isi pemenang sebuah match (admin). Kosongkan pemenang = batalkan hasil')
        .addStringOption((o) => o.setName('match').setDescription('Match yang dimainkan').setRequired(true).addChoices(...matchChoices))
        .addStringOption((o) => o.setName('pemenang').setDescription('Nama tim pemenang').setMaxLength(40))
    )
    .addSubcommand((s) => s.setName('tampil').setDescription('Tampilkan bagan turnamen terbaru'))
    .addSubcommand((s) =>
      s
        .setName('reset')
        .setDescription('Reset data bracket (admin)')
        .addStringOption((o) =>
          o
            .setName('bagian')
            .setDescription('Apa yang direset')
            .setRequired(true)
            .addChoices(
              { name: 'Hasil match saja', value: 'hasil' },
              { name: 'Undian + hasil (tim tetap ada)', value: 'undian' },
              { name: 'Semuanya (tim, undian, hasil)', value: 'semua' }
            )
        )
    ),

  async execute(i) {
    const sub = i.options.getSubcommand();
    const g = i.guildId;

    if (sub === 'tampil') {
      await i.deferReply();
      const st = loadState(g);
      return i.editReply({ files: [bracketAttachment(st)] });
    }

    if (sub === 'daftar') {
      const st = loadState(g);
      if (!st.teams.length) return i.reply({ content: 'Belum ada tim. Admin bisa menambah dengan `/bracket tambah`.', flags: EPHEMERAL });
      const sorted = [...st.teams].sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99) || a.id - b.id);
      const lines = sorted.map((t) => (t.slot ? `**Slot ${pad(t.slot)}** — ${t.name}` : `⏳ ${t.name} _(belum diundi)_`));
      const embed = new EmbedBuilder()
        .setColor(cfg.accent)
        .setTitle(`📋 Daftar Tim (${st.teams.length}/${SIZE})`)
        .setDescription(lines.join('\n').slice(0, 4000));
      return i.reply({ embeds: [embed], allowedMentions: NO_PING });
    }

    // ---- semua di bawah ini khusus admin
    if (sub === 'judul') {
      const nama = i.options.getString('nama');
      const prize = i.options.getString('prize');
      if (!nama && !prize) {
        const st = loadState(g);
        return i.reply({ content: `Judul: **${st.title}**\nPrize pool: **${st.prize}**`, flags: EPHEMERAL });
      }
      if (!isAdmin(i)) return adminOnly(i);
      const cur = loadState(g);
      db.prepare(
        `INSERT INTO bracket_event (guild_id, title, prize) VALUES (?, ?, ?)
         ON CONFLICT(guild_id) DO UPDATE SET title=excluded.title, prize=excluded.prize`
      ).run(g, nama || cur.title, prize || cur.prize);
      return i.reply({ content: '✅ Judul/prize diperbarui.', flags: EPHEMERAL });
    }

    if (!isAdmin(i)) return adminOnly(i);

    if (sub === 'tambah') {
      const names = [...new Set(i.options.getString('nama', true).split(/[,\n]/).map((s) => s.trim()).filter(Boolean))];
      if (!names.length) return i.reply({ content: '❌ Nama tim kosong.', flags: EPHEMERAL });
      let count = db.prepare('SELECT COUNT(*) AS c FROM bracket_teams WHERE guild_id=?').get(g).c;
      const added = [];
      const skipped = [];
      for (const n of names) {
        if (n.length > 40) {
          skipped.push(`${n.slice(0, 20)}… (terlalu panjang)`);
          continue;
        }
        if (count >= SIZE) {
          skipped.push(`${n} (kuota ${SIZE} tim penuh)`);
          continue;
        }
        const r = db.prepare('INSERT OR IGNORE INTO bracket_teams (guild_id, name) VALUES (?, ?)').run(g, n);
        if (r.changes) {
          added.push(n);
          count++;
        } else skipped.push(`${n} (sudah ada)`);
      }
      let msg = `✅ Ditambahkan **${added.length}** tim. Total: **${count}/${SIZE}**.`;
      if (added.length) msg += `\n${added.map((n) => `• ${n}`).join('\n')}`;
      if (skipped.length) msg += `\n⚠️ Dilewati:\n${skipped.map((n) => `• ${n}`).join('\n')}`;
      return i.reply({ content: msg.slice(0, 1900), flags: EPHEMERAL, allowedMentions: NO_PING });
    }

    if (sub === 'hapus') {
      const nama = i.options.getString('nama', true).trim();
      const hasResults = db.prepare('SELECT COUNT(*) AS c FROM bracket_results WHERE guild_id=?').get(g).c > 0;
      if (hasResults) return i.reply({ content: '❌ Sudah ada hasil match. Pakai `/bracket reset` dulu kalau ingin mengubah peserta.', flags: EPHEMERAL });
      const r = db.prepare('DELETE FROM bracket_teams WHERE guild_id=? AND name=?').run(g, nama);
      return i.reply({
        content: r.changes ? `🗑️ Tim **${nama}** dihapus (slotnya kosong lagi kalau sudah diundi).` : '❌ Tim tidak ditemukan.',
        flags: EPHEMERAL,
        allowedMentions: NO_PING,
      });
    }

    if (sub === 'spin') return doSpin(i);

    if (sub === 'hasil') {
      const m = MATCHES[i.options.getString('match', true)];
      const input = i.options.getString('pemenang')?.trim().toLowerCase();
      const st = loadState(g);
      const key = `${m.r}:${m.j}`;

      if (!input) {
        if (!st.results.has(key)) return i.reply({ content: 'Match itu belum punya hasil.', flags: EPHEMERAL });
        db.prepare('DELETE FROM bracket_results WHERE guild_id=? AND stage=? AND idx=?').run(g, m.r, m.j);
        st.results.delete(key);
        pruneDownstream(g, st.results, m.r, m.j);
        await i.deferReply();
        return i.editReply({ content: `↩️ Hasil **${m.short}** dibatalkan.`, files: [bracketAttachment(st)] });
      }

      const a = slotOf(st.results, m.r - 1, m.j * 2);
      const b = slotOf(st.results, m.r - 1, m.j * 2 + 1);
      if (a === null || b === null) return i.reply({ content: '❌ Peserta match ini belum ditentukan (hasil babak sebelumnya belum diisi).', flags: EPHEMERAL });
      const na = st.names[a - 1];
      const nb = st.names[b - 1];
      if (!na || !nb) return i.reply({ content: '❌ Slot untuk match ini belum terisi tim. Selesaikan undian dulu dengan `/bracket spin`.', flags: EPHEMERAL });

      const exact = [[a, na], [b, nb]].filter(([, n]) => n.toLowerCase() === input);
      const partial = [[a, na], [b, nb]].filter(([, n]) => n.toLowerCase().includes(input));
      const hit = exact.length === 1 ? exact[0] : partial.length === 1 ? partial[0] : null;
      if (!hit) return i.reply({ content: `❌ Pemenang harus salah satu: **${na}** atau **${nb}**.`, flags: EPHEMERAL, allowedMentions: NO_PING });

      const [win, winName] = hit;
      const loseName = win === a ? nb : na;
      db.prepare(
        `INSERT INTO bracket_results (guild_id, stage, idx, winner) VALUES (?, ?, ?, ?)
         ON CONFLICT(guild_id, stage, idx) DO UPDATE SET winner=excluded.winner`
      ).run(g, m.r, m.j, win);
      st.results.set(key, win);
      pruneDownstream(g, st.results, m.r, m.j);

      await i.deferReply();
      const embed = new EmbedBuilder()
        .setColor(m.r === ROUNDS ? 0xf1c40f : 0x2ecc71)
        .setTitle(m.r === ROUNDS ? '👑 JUARA!' : `✅ ${m.label}`)
        .setDescription(
          m.r === ROUNDS
            ? `Selamat kepada **${winName}** sebagai juara! 🏆\nMengalahkan **${loseName}** di Grand Final.`
            : `🏆 **${winName}** mengalahkan **${loseName}** dan lanjut ke babak berikutnya.`
        )
        .setImage('attachment://bracket.png');
      return i.editReply({ embeds: [embed], files: [bracketAttachment(st)], allowedMentions: NO_PING });
    }

    if (sub === 'reset') {
      const part = i.options.getString('bagian', true);
      if (spinning.has(g)) return i.reply({ content: '⏳ Roda masih berputar, tunggu sebentar.', flags: EPHEMERAL });
      db.prepare('DELETE FROM bracket_results WHERE guild_id=?').run(g);
      if (part === 'undian') db.prepare('UPDATE bracket_teams SET slot=NULL WHERE guild_id=?').run(g);
      if (part === 'semua') db.prepare('DELETE FROM bracket_teams WHERE guild_id=?').run(g);
      const label = { hasil: 'Hasil match direset.', undian: 'Undian & hasil direset. Tim tetap terdaftar.', semua: 'Semua data bracket dihapus.' }[part];
      return i.reply({ content: `♻️ ${label}`, flags: EPHEMERAL });
    }
  },
};

module.exports = { command };

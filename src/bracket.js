// Bracket / bagan turnamen 16 tim + Spin Wheel undian slot.
// Alur: /bracket tambah (tim) -> /bracket spin | spinall (undi slot) -> /bracket spinmk (map & killer tiap match, 16 besar s.d. final)
//       -> /bracket hasil (isi pemenang) -> /bracket tampil | jadwal
// Bagan yang sudah jadi bisa diedit lewat /bracket edit (tukar posisi tim, isi posisi, map & killer manual, ganti nama tim).
// Bagan digambar sebagai gambar PNG (canvas). Roda undian: GIF berputar dulu, lalu diganti kartu hasil (lihat wheel.js)
const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { createCanvas } = require('@napi-rs/canvas');
const { randomInt } = require('crypto');
const cfg = require('./config');
const { db } = require('./db');
require('./card'); // memastikan font CardRegular / CardBold sudah terdaftar
const { playSpin, spinning, getItems } = require('./wheel'); // roda GIF + kartu hasil + daftar map/killer

const EPHEMERAL = MessageFlags.Ephemeral;
const NO_PING = { parse: [] };
const SIZE = 16;
const ROUNDS = 4; // 16 besar, quarter, semifinal, final
const DEFAULT_TITLE = 'ARVEXIS COMMUNITY — VIOLENCE DISTRICT FUN MATCH';
const DEFAULT_PRIZE = 'Rp250.000';

const pad = (n) => String(n).padStart(2, '0');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  CREATE TABLE IF NOT EXISTS bracket_picks (
    guild_id    TEXT NOT NULL,
    stage       INTEGER NOT NULL,
    idx         INTEGER NOT NULL,
    map_name    TEXT NOT NULL,
    killer_name TEXT NOT NULL,
    PRIMARY KEY (guild_id, stage, idx)
  );
  CREATE TABLE IF NOT EXISTS bracket_overrides (
    guild_id TEXT NOT NULL,
    stage    INTEGER NOT NULL,             -- kolom bagan 1 = QF, 2 = SF, 3 = Grand Final (kolom 0 = slot, diedit lewat tukar slot)
    idx      INTEGER NOT NULL,             -- posisi kotak di kolom itu (mulai 0, dari atas)
    slot     INTEGER NOT NULL,             -- tim (nomor slot) yang ditempatkan manual di kotak itu
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

// Hasil match + penempatan manual (override) hasil /bracket edit. `over` menimpa pemenang di kotak itu.
class Results extends Map {
  over = new Map(); // "r:j" -> slot
}

// Slot yang menempati kotak (r, j): r=0 -> slot awal; r>0 -> penempatan manual kalau ada, kalau tidak pemenang match (r, j).
const slotOf = (results, r, j) => (r === 0 ? j + 1 : (results.over?.get(`${r}:${j}`) ?? results.get(`${r}:${j}`) ?? null));

// ---------------------------------------------------------------- data
function loadState(guildId) {
  const names = Array(SIZE).fill(null);
  const teams = db.prepare('SELECT id, name, slot FROM bracket_teams WHERE guild_id=? ORDER BY id').all(guildId);
  for (const t of teams) if (t.slot) names[t.slot - 1] = t.name;
  const results = new Results();
  for (const r of db.prepare('SELECT stage, idx, winner FROM bracket_results WHERE guild_id=?').all(guildId)) results.set(`${r.stage}:${r.idx}`, r.winner);
  for (const r of db.prepare('SELECT stage, idx, slot FROM bracket_overrides WHERE guild_id=?').all(guildId)) results.over.set(`${r.stage}:${r.idx}`, r.slot);
  const picks = new Map();
  for (const r of db.prepare('SELECT stage, idx, map_name, killer_name FROM bracket_picks WHERE guild_id=?').all(guildId)) {
    picks.set(`${r.stage}:${r.idx}`, { map: r.map_name, killer: r.killer_name });
  }
  const ev = db.prepare('SELECT title, prize FROM bracket_event WHERE guild_id=?').get(guildId);
  return { teams, names, results, picks, title: ev?.title || DEFAULT_TITLE, prize: ev?.prize || DEFAULT_PRIZE };
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

// Setelah peserta berubah (edit manual), hapus semua hasil match yang pemenangnya tidak lagi ikut di match itu. Return daftar key yang dihapus.
function revalidate(guildId, results) {
  const removed = [];
  for (let r = 1; r <= ROUNDS; r++) {
    for (let j = 0; j < SIZE >> r; j++) {
      const key = `${r}:${j}`;
      const w = results.get(key);
      if (w === undefined) continue;
      const a = slotOf(results, r - 1, j * 2);
      const b = slotOf(results, r - 1, j * 2 + 1);
      if (w === a || w === b) continue;
      results.delete(key);
      db.prepare('DELETE FROM bracket_results WHERE guild_id=? AND stage=? AND idx=?').run(guildId, r, j);
      removed.push(key);
    }
  }
  return removed;
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

function renderBracket({ title, prize, names, results, picks }) {
  const W = 1675;
  const H = 790;
  const X0 = 40;
  const CW = 215;
  const GAP = 130; // ruang antar kolom: juga tempat tulisan map & killer tiap match
  const TOP = 120;
  const ROWH = 40;
  const BH = 32;
  const accent = cfg.accent;
  const MAPC = '#7fd1ff';
  const KILLC = '#ff8a80';
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

  // Keterangan warna (kanan atas)
  ctx.textAlign = 'right';
  ctx.font = '15px CardBold';
  ctx.fillStyle = KILLC;
  ctx.fillText('Killer', W - 40, 74);
  const kw = ctx.measureText('Killer').width;
  ctx.fillStyle = '#8e9297';
  ctx.fillText(' • ', W - 40 - kw, 74);
  const sw = ctx.measureText(' • ').width;
  ctx.fillStyle = MAPC;
  ctx.fillText('Map', W - 40 - kw - sw, 74);

  // Judul kolom
  ctx.textAlign = 'center';
  const heads = ['BABAK 16 BESAR', 'QUARTER FINAL', 'SEMIFINAL', 'GRAND FINAL', 'JUARA'];
  ctx.font = '17px CardBold';
  ctx.fillStyle = accent;
  heads.forEach((h, r) => ctx.fillText(h, colX(r) + CW / 2, 102));

  // Garis penghubung + map & killer tiap match
  ctx.lineWidth = 2;
  for (let r = 1; r <= ROUNDS; r++) {
    for (let j = 0; j < SIZE >> r; j++) {
      const x1 = colX(r - 1) + CW;
      const xm = x1 + 20;
      const x2 = colX(r);
      const ya = ys[r - 1][2 * j];
      const yb = ys[r - 1][2 * j + 1];
      const yp = ys[r][j];
      ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      ctx.beginPath();
      ctx.moveTo(x1, ya);
      ctx.lineTo(xm, ya);
      ctx.lineTo(xm, yb);
      ctx.lineTo(x1, yb);
      ctx.moveTo(xm, yp);
      ctx.lineTo(x2, yp);
      ctx.stroke();

      const pk = picks?.get(`${r}:${j}`);
      if (pk) {
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.font = '12px CardBold';
        ctx.fillStyle = MAPC;
        ctx.fillText(fit(ctx, pk.map, GAP - 28), xm + 6, yp - 9);
        ctx.fillStyle = KILLC;
        ctx.fillText(fit(ctx, pk.killer, GAP - 28), xm + 6, yp + 10);
      }
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

      // Kotak yang ditempatkan manual lewat /bracket edit: garis putus-putus oranye
      if (name && r > 0 && r < ROUNDS && results.over?.has(`${r}:${j}`)) {
        ctx.save();
        ctx.setLineDash([6, 4]);
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#f39c12';
        roundRect(ctx, x, cy - BH / 2, CW, BH, 8);
        ctx.stroke();
        ctx.restore();
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

  if (results.over?.size) {
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = '13px CardRegular';
    ctx.fillStyle = '#f39c12';
    ctx.fillText('- - -  posisi diatur manual oleh admin', X0, H - 16);
  }

  return canvas.toBuffer('image/png');
}

// ---------------------------------------------------------------- aksi
const isAdmin = (i) => !!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
const adminOnly = (i) => i.reply({ content: '❌ Hanya admin (izin **Manage Server**) yang bisa memakai perintah ini.', flags: EPHEMERAL });

const bracketAttachment = (st) =>
  new AttachmentBuilder(renderBracket({ title: st.title, prize: st.prize, names: st.names, results: st.results, picks: st.picks }), { name: 'bracket.png' });

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
        (left ? `Sisa **${left}** tim belum diundi.` : '✅ **Undian selesai!** Lanjut `/bracket spinmk` untuk map & killer tiap match.'),
    });
  } catch (err) {
    console.error('[bracket] spin gagal:', err);
    await i.editReply({ content: '❌ Terjadi error saat memutar roda. Cek `/bracket daftar` untuk melihat hasil undian terakhir.', embeds: [], files: [], attachments: [] }).catch(() => {});
  } finally {
    spinning.delete(g);
  }
}

// ---------------------------------------------------------------- map & killer per match + undian massal
const boxLabel = (st, r, j) => {
  const slot = slotOf(st.results, r, j);
  return slot ? st.names[slot - 1] || `Tim ${pad(slot)}` : placeholder(r, j);
};
const versus = (st, m) => `${boxLabel(st, m.r - 1, m.j * 2)} vs ${boxLabel(st, m.r - 1, m.j * 2 + 1)}`;

function matchLine(st, key) {
  const m = MATCHES[key];
  const pk = st.picks.get(`${m.r}:${m.j}`);
  return `**${m.short}:** ${versus(st, m)}\n↳ ${pk ? `🗺️ **${pk.map}** • 🔪 **${pk.killer}**` : '_map & killer belum di-spin_'}`;
}

function jadwalEmbed(st) {
  const keys = Object.keys(MATCHES); // M1..M8, QF1..QF4, SF1, SF2, F
  const grp = (a, b) => keys.slice(a, b).map((k) => matchLine(st, k)).join('\n').slice(0, 1024);
  return new EmbedBuilder()
    .setColor(cfg.accent)
    .setTitle('📅 Jadwal Match, Map & Killer')
    .addFields(
      { name: '16 Besar (Match 01–04)', value: grp(0, 4) },
      { name: '16 Besar (Match 05–08)', value: grp(4, 8) },
      { name: 'Quarter Final', value: grp(8, 12) },
      { name: 'Semifinal & Grand Final', value: grp(12, 15) }
    );
}

const savePick = (g, m, map, killer) =>
  db
    .prepare(
      `INSERT INTO bracket_picks (guild_id, stage, idx, map_name, killer_name) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(guild_id, stage, idx) DO UPDATE SET map_name=excluded.map_name, killer_name=excluded.killer_name`
    )
    .run(g, m.r, m.j, map, killer);

// Map/killer yang sudah dipakai match lain tidak muncul lagi di roda sampai semuanya terpakai (lalu mulai putaran baru).
function usedSets(st, exceptKey) {
  const um = new Set();
  const uk = new Set();
  for (const [k, p] of st.picks) {
    if (k === exceptKey) continue;
    um.add(p.map.toLowerCase());
    uk.add(p.killer.toLowerCase());
  }
  return { um, uk };
}
function candidates(items, used) {
  let c = items.filter((n) => !used.has(n.toLowerCase()));
  if (!c.length) {
    used.clear();
    c = items.slice();
  }
  return c;
}
function pickOne(items, used) {
  const c = candidates(items, used);
  const p = c[randomInt(c.length)];
  used.add(p.toLowerCase());
  return p;
}

/** /bracket spinall : undi semua tim yang tersisa sekaligus (tanpa animasi). */
async function doSpinAll(i) {
  const g = i.guildId;
  if (spinning.has(g)) return i.reply({ content: '⏳ Roda masih berputar, tunggu sebentar.', flags: EPHEMERAL });

  const used = new Set(db.prepare('SELECT slot FROM bracket_teams WHERE guild_id=? AND slot IS NOT NULL').all(g).map((r) => r.slot));
  const free = [];
  for (let s = 1; s <= SIZE; s++) if (!used.has(s)) free.push(s);
  const pool = db.prepare('SELECT id, name FROM bracket_teams WHERE guild_id=? AND slot IS NULL ORDER BY id').all(g);
  if (!free.length) return i.reply({ content: '✅ Semua slot sudah terisi. Lihat hasilnya dengan `/bracket tampil`.', flags: EPHEMERAL });
  if (!pool.length) return i.reply({ content: '❌ Tidak ada tim yang tersisa untuk diundi. Tambahkan dulu dengan `/bracket tambah`.', flags: EPHEMERAL });

  spinning.add(g);
  try {
    await i.deferReply();
    let n = 0;
    for (const slot of free) {
      if (!pool.length) break;
      const t = pool.splice(randomInt(pool.length), 1)[0];
      db.prepare('UPDATE bracket_teams SET slot=? WHERE id=?').run(slot, t.id);
      n++;
    }
    const st = loadState(g);
    const total = st.teams.length;
    const embed = new EmbedBuilder()
      .setColor(cfg.accent)
      .setTitle('🎲 Undian Semua Tim Selesai')
      .setDescription(`**${n}** tim diundi acak ke slot bagan.` + (total < SIZE ? `\n⚠️ Baru ${total}/${SIZE} tim terdaftar, sisa slot masih kosong.` : '\nLanjut `/bracket spinmk` untuk map & killer tiap match.'))
      .setImage('attachment://bracket.png');
    await i.editReply({ embeds: [embed], files: [bracketAttachment(st)], allowedMentions: NO_PING });
  } catch (err) {
    console.error('[bracket] spinall gagal:', err);
    await i.editReply({ content: '❌ Terjadi error saat mengundi. Cek `/bracket daftar`.', embeds: [], files: [], attachments: [] }).catch(() => {});
  } finally {
    spinning.delete(g);
  }
}

/** /bracket spinmk : spin map lalu killer untuk 1 match (berikutnya yang belum di-spin, atau `match`), atau `semua`. */
async function doSpinMk(i) {
  const g = i.guildId;
  if (spinning.has(g)) return i.reply({ content: '⏳ Roda masih berputar, tunggu sebentar.', flags: EPHEMERAL });

  const maps = getItems(g, 'map');
  const killers = getItems(g, 'killer');
  if (maps.length < 2 || killers.length < 2) {
    return i.reply({ content: '❌ Daftar map dan killer masing-masing minimal 2. Isi dulu dengan `/spin tambah`.', flags: EPHEMERAL });
  }

  const st = loadState(g);
  const all = i.options.getBoolean('semua') === true;
  const wanted = i.options.getString('match');
  const missing = Object.keys(MATCHES).filter((k) => !st.picks.has(`${MATCHES[k].r}:${MATCHES[k].j}`));
  const key = wanted || missing[0];
  if (!key || (all && !missing.length)) {
    return i.reply({
      content: 'Semua match sudah punya map & killer. Pilih `match:` untuk spin ulang satu match, atau `/bracket reset bagian:Map & killer saja`.',
      flags: EPHEMERAL,
    });
  }

  spinning.add(g);
  try {
    await i.deferReply();

    if (all) {
      const { um, uk } = usedSets(st, null);
      for (const k of missing) {
        const m = MATCHES[k];
        const mp = pickOne(maps, um);
        const kl = pickOne(killers, uk);
        savePick(g, m, mp, kl);
        st.picks.set(`${m.r}:${m.j}`, { map: mp, killer: kl });
      }
      const embed = jadwalEmbed(st).setImage('attachment://bracket.png');
      await i.editReply({ content: `✅ Map & killer untuk **${missing.length}** match sudah di-spin.`, embeds: [embed], files: [bracketAttachment(st)], allowedMentions: NO_PING });
      return;
    }

    const m = MATCHES[key];
    const { um, uk } = usedSets(st, `${m.r}:${m.j}`);
    const mapLabels = candidates(maps, um);
    const killerLabels = candidates(killers, uk);
    const wm = randomInt(mapLabels.length);
    const wk = randomInt(killerLabels.length);
    const mapName = mapLabels[wm];
    const killerName = killerLabels[wk];
    savePick(g, m, mapName, killerName); // simpan dulu, animasi hanya tampilan

    const vs = versus(st, m);
    const tag = m.short.toUpperCase();
    await playSpin(i, {
      labels: mapLabels,
      winner: wm,
      title: `🗺️ Spin Map • ${m.short}`,
      heading: `MAP • ${tag}`,
      subtitle: vs,
      resultText: `**${m.label}**\n${vs}\n🗺️ Map: **${mapName}**\n🔪 Killer: _diputar berikutnya..._`,
    });
    await sleep(2500);
    await playSpin(i, {
      labels: killerLabels,
      winner: wk,
      title: `🔪 Spin Killer • ${m.short}`,
      heading: `KILLER • ${tag}`,
      subtitle: `Map: ${mapName}`,
      resultText: `**${m.label}**\n${vs}\n🗺️ Map: **${mapName}**\n🔪 Killer: **${killerName}**`,
    });
  } catch (err) {
    console.error('[bracket] spinmk gagal:', err);
    await i.editReply({ content: '❌ Terjadi error saat memutar roda. Cek `/bracket jadwal`.', embeds: [], files: [], attachments: [] }).catch(() => {});
  } finally {
    spinning.delete(g);
  }
}

// ---------------------------------------------------------------- edit bagan yang sudah jadi (/bracket edit)
const COL_NAME = ['16 Besar', 'Quarter Final', 'Semifinal', 'Grand Final']; // kolom bagan: peserta yang bermain di babak itu
const norm = (s) => String(s || '').trim().toLowerCase();
const matchShort = (key) => Object.values(MATCHES).find((m) => `${m.r}:${m.j}` === key)?.short || key;

/** Cari tim di kolom `r` bagan (nama persis, atau sebagian nama kalau hanya satu yang cocok). */
function findInColumn(st, r, input) {
  const q = norm(input);
  const found = [];
  for (let j = 0; j < SIZE >> r; j++) {
    const slot = slotOf(st.results, r, j);
    const name = slot ? st.names[slot - 1] : null;
    if (name) found.push({ j, slot, name });
  }
  const exact = found.filter((f) => f.name.toLowerCase() === q);
  if (exact.length === 1) return exact[0];
  const part = found.filter((f) => f.name.toLowerCase().includes(q));
  return part.length === 1 ? part[0] : null;
}

/** Cari tim terdaftar berdasarkan nama (persis, atau sebagian nama kalau unik). */
function findTeam(st, input, placedOnly) {
  const q = norm(input);
  const all = st.teams.filter((t) => !placedOnly || t.slot);
  const exact = all.filter((t) => t.name.toLowerCase() === q);
  if (exact.length === 1) return exact[0];
  const part = all.filter((t) => t.name.toLowerCase().includes(q));
  return part.length === 1 ? part[0] : null;
}

/** Tempatkan tim `slot` di kotak (r, j) kolom 1..3. Kalau sama dengan pemenang aslinya, penempatan manual dihapus. */
function setBox(g, st, r, j, slot) {
  const key = `${r}:${j}`;
  if (slot === null || slot === st.results.get(key)) {
    db.prepare('DELETE FROM bracket_overrides WHERE guild_id=? AND stage=? AND idx=?').run(g, r, j);
    st.results.over.delete(key);
  } else {
    db.prepare(
      `INSERT INTO bracket_overrides (guild_id, stage, idx, slot) VALUES (?, ?, ?, ?)
       ON CONFLICT(guild_id, stage, idx) DO UPDATE SET slot=excluded.slot`
    ).run(g, r, j, slot);
    st.results.over.set(key, slot);
  }
}

// Tukar dua tim di kolom awal (slot). Hasil match & penempatan manual ikut pindah bersama timnya.
const swapSlots = db.transaction((g, sa, sb) => {
  const ta = db.prepare('SELECT id FROM bracket_teams WHERE guild_id=? AND slot=?').get(g, sa);
  const tb = db.prepare('SELECT id FROM bracket_teams WHERE guild_id=? AND slot=?').get(g, sb);
  db.prepare('UPDATE bracket_teams SET slot=NULL WHERE id=?').run(ta.id);
  db.prepare('UPDATE bracket_teams SET slot=? WHERE id=?').run(sa, tb.id);
  db.prepare('UPDATE bracket_teams SET slot=? WHERE id=?').run(sb, ta.id);
  db.prepare('UPDATE bracket_results SET winner = CASE winner WHEN ? THEN ? WHEN ? THEN ? ELSE winner END WHERE guild_id=?').run(sa, sb, sb, sa, g);
  db.prepare('UPDATE bracket_overrides SET slot = CASE slot WHEN ? THEN ? WHEN ? THEN ? ELSE slot END WHERE guild_id=?').run(sa, sb, sb, sa, g);
});

async function sendEdited(i, g, text) {
  const st = loadState(g);
  const removed = revalidate(g, st.results);
  let msg = text;
  if (removed.length) msg += `\n⚠️ Hasil ini ikut dibatalkan karena pesertanya berubah: **${removed.map(matchShort).join(', ')}**. Isi lagi dengan \`/bracket hasil\`.`;
  return i.editReply({ content: msg.slice(0, 1900), files: [bracketAttachment(st)], allowedMentions: NO_PING });
}

async function doEdit(i, sub) {
  const g = i.guildId;
  if (spinning.has(g)) return i.reply({ content: '⏳ Roda masih berputar, tunggu sebentar.', flags: EPHEMERAL });
  const st = loadState(g);
  const fail = (content) => i.reply({ content, flags: EPHEMERAL, allowedMentions: NO_PING });

  // ---- tukar dua tim dalam satu kolom
  if (sub === 'tukar') {
    const r = i.options.getInteger('babak', true);
    const A = findInColumn(st, r, i.options.getString('tim1', true));
    const B = findInColumn(st, r, i.options.getString('tim2', true));
    if (!A || !B) return fail(`❌ Tim tidak ditemukan di kolom **${COL_NAME[r]}** (nama harus persis, atau bagian nama yang unik). Cek dengan \`/bracket tampil\`.`);
    if (A.slot === B.slot) return fail('❌ Pilih dua tim yang berbeda.');
    await i.deferReply();
    if (r === 0) {
      swapSlots(g, A.slot, B.slot);
    } else {
      setBox(g, st, r, A.j, B.slot);
      setBox(g, st, r, B.j, A.slot);
    }
    return sendEdited(i, g, `🔄 **${A.name}** ⇄ **${B.name}** ditukar di kolom **${COL_NAME[r]}**.`);
  }

  // ---- taruh tim di posisi tertentu
  if (sub === 'isi') {
    const r = i.options.getInteger('babak', true);
    const pos = i.options.getInteger('posisi', true);
    const j = pos - 1;
    if (j < 0 || j >= SIZE >> r) return fail(`❌ Kolom **${COL_NAME[r]}** hanya punya posisi 1–${SIZE >> r} (dari atas).`);
    const team = findTeam(st, i.options.getString('tim', true), true);
    if (!team) return fail('❌ Tim tidak ditemukan (atau namanya ambigu / belum diundi ke slot). Cek `/bracket daftar`.');
    for (let k = 0; k < SIZE >> r; k++) {
      if (k !== j && slotOf(st.results, r, k) === team.slot) {
        return fail(`❌ **${team.name}** sudah ada di posisi ${k + 1} kolom ${COL_NAME[r]}. Pakai \`/bracket edit tukar\` untuk menukar posisi.`);
      }
    }
    await i.deferReply();
    setBox(g, st, r, j, team.slot);
    return sendEdited(i, g, `✏️ **${team.name}** ditempatkan di posisi **${pos}** kolom **${COL_NAME[r]}**.`);
  }

  // ---- kembalikan penempatan manual
  if (sub === 'pulihkan') {
    const r = i.options.getInteger('babak');
    const q = r === null ? db.prepare('DELETE FROM bracket_overrides WHERE guild_id=?').run(g) : db.prepare('DELETE FROM bracket_overrides WHERE guild_id=? AND stage=?').run(g, r);
    if (!q.changes) return fail('Tidak ada posisi manual yang perlu dipulihkan.');
    await i.deferReply();
    return sendEdited(i, g, `♻️ Posisi manual ${r === null ? 'di semua kolom' : `kolom **${COL_NAME[r]}**`} dikembalikan ke hasil match (${q.changes} posisi).`);
  }

  // ---- map & killer manual
  if (sub === 'mapkiller') {
    const key = i.options.getString('match', true);
    const m = MATCHES[key];
    const mapIn = i.options.getString('map')?.trim();
    const killerIn = i.options.getString('killer')?.trim();
    if (!mapIn && !killerIn) return fail('❌ Isi minimal salah satu: `map` atau `killer`.');
    const cur = st.picks.get(`${m.r}:${m.j}`);
    const mp = (mapIn || cur?.map || '').slice(0, 40);
    const kl = (killerIn || cur?.killer || '').slice(0, 40);
    if (!mp || !kl) return fail(`❌ **${m.short}** belum punya map & killer, jadi isi dua-duanya.`);
    await i.deferReply();
    savePick(g, m, mp, kl);
    st.picks.set(`${m.r}:${m.j}`, { map: mp, killer: kl });
    return i.editReply({ content: `🗺️ **${m.label}** diubah manual:\n${matchLine(st, key)}`, files: [bracketAttachment(st)], allowedMentions: NO_PING });
  }

  // ---- ganti nama tim
  if (sub === 'nama') {
    const team = findTeam(st, i.options.getString('lama', true), false);
    const baru = i.options.getString('baru', true).trim();
    if (!team) return fail('❌ Tim tidak ditemukan (atau namanya ambigu). Cek `/bracket daftar`.');
    if (!baru || baru.length > 40) return fail('❌ Nama baru harus 1–40 karakter.');
    try {
      db.prepare('UPDATE bracket_teams SET name=? WHERE id=?').run(baru, team.id);
    } catch {
      return fail('❌ Nama itu sudah dipakai tim lain.');
    }
    await i.deferReply();
    return sendEdited(i, g, `📝 **${team.name}** diganti menjadi **${baru}**.`);
  }
}

// ---------------------------------------------------------------- /bracket
const matchChoices = Object.entries(MATCHES).map(([value, m]) => ({ name: m.label, value }));
// Kolom bagan = peserta yang bermain di babak itu (0 = kolom awal 16 tim)
const columnChoices = [
  { name: '16 Besar (kolom awal)', value: 0 },
  { name: 'Quarter Final', value: 1 },
  { name: 'Semifinal', value: 2 },
  { name: 'Grand Final', value: 3 },
];

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
    .addSubcommand((s) => s.setName('spinall').setDescription('Undi semua tim yang tersisa sekaligus, tanpa animasi (admin)'))
    .addSubcommand((s) =>
      s
        .setName('spinmk')
        .setDescription('Spin map & killer untuk match berikutnya yang belum di-spin (admin)')
        .addStringOption((o) => o.setName('match').setDescription('Match tertentu (kosong = berikutnya yang belum di-spin)').addChoices(...matchChoices))
        .addBooleanOption((o) => o.setName('semua').setDescription('Spin semua match yang belum punya map & killer sekaligus, tanpa animasi'))
    )
    .addSubcommand((s) => s.setName('jadwal').setDescription('Lihat semua match beserta map & killer-nya'))
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
              { name: 'Map & killer saja', value: 'mapkiller' },
              { name: 'Semuanya (tim, undian, hasil)', value: 'semua' }
            )
        )
    )
    .addSubcommandGroup((grp) =>
      grp
        .setName('edit')
        .setDescription('Edit bagan yang sudah jadi (admin)')
        .addSubcommand((s) =>
          s
            .setName('tukar')
            .setDescription('Tukar posisi dua tim di satu kolom bagan (mis. paksa dua tim bertemu)')
            .addIntegerOption((o) => o.setName('babak').setDescription('Kolom bagan tempat dua tim ini berada').setRequired(true).addChoices(...columnChoices))
            .addStringOption((o) => o.setName('tim1').setDescription('Tim pertama (nama / sebagian nama)').setRequired(true).setMaxLength(40))
            .addStringOption((o) => o.setName('tim2').setDescription('Tim kedua (nama / sebagian nama)').setRequired(true).setMaxLength(40))
        )
        .addSubcommand((s) =>
          s
            .setName('isi')
            .setDescription('Taruh sebuah tim di posisi tertentu pada kolom QF / SF / Final')
            .addIntegerOption((o) => o.setName('babak').setDescription('Kolom bagan').setRequired(true).addChoices(...columnChoices.slice(1)))
            .addIntegerOption((o) => o.setName('posisi').setDescription('Posisi dari atas (1-2 = match pertama, 3-4 = match kedua, dst)').setRequired(true).setMinValue(1).setMaxValue(8))
            .addStringOption((o) => o.setName('tim').setDescription('Tim yang ditempatkan (nama / sebagian nama)').setRequired(true).setMaxLength(40))
        )
        .addSubcommand((s) =>
          s
            .setName('pulihkan')
            .setDescription('Batalkan posisi manual, kembali sesuai hasil match')
            .addIntegerOption((o) => o.setName('babak').setDescription('Kolom tertentu (kosong = semua)').addChoices(...columnChoices.slice(1)))
        )
        .addSubcommand((s) =>
          s
            .setName('mapkiller')
            .setDescription('Atur map / killer sebuah match secara manual (tanpa spin)')
            .addStringOption((o) => o.setName('match').setDescription('Match yang diubah').setRequired(true).addChoices(...matchChoices))
            .addStringOption((o) => o.setName('map').setDescription('Nama map (kosong = tetap)').setMaxLength(40))
            .addStringOption((o) => o.setName('killer').setDescription('Nama killer (kosong = tetap)').setMaxLength(40))
        )
        .addSubcommand((s) =>
          s
            .setName('nama')
            .setDescription('Ganti nama tim (mis. typo / nama terpotong)')
            .addStringOption((o) => o.setName('lama').setDescription('Nama tim sekarang').setRequired(true).setMaxLength(40))
            .addStringOption((o) => o.setName('baru').setDescription('Nama baru').setRequired(true).setMaxLength(40))
        )
    ),

  async execute(i) {
    const sub = i.options.getSubcommand();
    const g = i.guildId;

    if (i.options.getSubcommandGroup(false) === 'edit') {
      if (!isAdmin(i)) return adminOnly(i);
      return doEdit(i, sub);
    }

    if (sub === 'tampil') {
      await i.deferReply();
      const st = loadState(g);
      return i.editReply({ files: [bracketAttachment(st)] });
    }

    if (sub === 'jadwal') {
      await i.deferReply();
      const st = loadState(g);
      return i.editReply({ embeds: [jadwalEmbed(st)], allowedMentions: NO_PING });
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
    if (sub === 'spinall') return doSpinAll(i);
    if (sub === 'spinmk') return doSpinMk(i);

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
      if (part !== 'mapkiller') {
        db.prepare('DELETE FROM bracket_results WHERE guild_id=?').run(g);
        db.prepare('DELETE FROM bracket_overrides WHERE guild_id=?').run(g); // posisi manual ikut direset
      }
      if (part === 'undian') db.prepare('UPDATE bracket_teams SET slot=NULL WHERE guild_id=?').run(g);
      if (part === 'mapkiller' || part === 'semua') db.prepare('DELETE FROM bracket_picks WHERE guild_id=?').run(g);
      if (part === 'semua') db.prepare('DELETE FROM bracket_teams WHERE guild_id=?').run(g);
      const label = {
        hasil: 'Hasil match direset.',
        undian: 'Undian & hasil direset. Tim tetap terdaftar, map & killer tetap tersimpan.',
        mapkiller: 'Map & killer tiap match direset.',
        semua: 'Semua data bracket dihapus.',
      }[part];
      return i.reply({ content: `♻️ ${label}`, flags: EPHEMERAL });
    }
  },
};

module.exports = { command };

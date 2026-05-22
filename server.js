// server.js - aplicación principal Express
const express = require('express');
const cookieSession = require('cookie-session');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('./db');
const { getFlag } = require('./countries');

// Cargar .env de forma simple (sin dependencia extra)
try {
  const fs = require('fs');
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(line => {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    });
  }
} catch (e) { /* ignore */ }

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(cookieSession({
  name: 'quiniela_sess',
  secret: process.env.SESSION_SECRET || 'cambia-este-secret',
  maxAge: 1000 * 60 * 60 * 24 * 60, // 60 días en el browser
  httpOnly: true,
  sameSite: 'lax'
}));

// Parsea "HH:MM UTC±N" y devuelve un Date en UTC representando el inicio del partido
function parseMatchUTC(match) {
  if (!match.match_date || !match.match_time) return null;
  const m = match.match_time.trim().match(/^(\d{1,2}):(\d{2})(?:\s+UTC([+-]\d+))?/);
  if (!m) return null;
  const hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const offsetHours = m[3] ? parseInt(m[3], 10) : 0;
  // Construir como si fuera UTC, luego restar el offset para obtener UTC real
  // "13:00 UTC-6" => UTC = 13:00 - (-6h) = 19:00 UTC
  const local = new Date(`${match.match_date}T${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:00.000Z`);
  return new Date(local.getTime() - offsetHours * 3600000);
}

// Devuelve true si ya no se puede modificar el pronóstico
// (1 minuto antes del inicio del partido o si ya finalizó)
function isMatchLocked(match) {
  if (match.finished) return true;
  const startUTC = parseMatchUTC(match);
  if (!startUTC) return false;
  const lockTime = new Date(startUTC.getTime() - 60 * 1000); // 1 min antes
  return Date.now() >= lockTime.getTime();
}

// Formatea el horario del partido en zona horaria Argentina (ART, UTC-3)
function formatMatchTimeART(match) {
  const startUTC = parseMatchUTC(match);
  if (!startUTC) return match.match_time || match.match_date || '';
  try {
    return new Intl.DateTimeFormat('es-AR', {
      timeZone: 'America/Argentina/Buenos_Aires',
      weekday: 'short',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).format(startUTC);
  } catch {
    return match.match_time || match.match_date || '';
  }
}

app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.flash = req.session.flash || null;
  res.locals.getFlag = getFlag;
  res.locals.isMatchLocked = isMatchLocked;
  res.locals.formatMatchTimeART = formatMatchTimeART;
  delete req.session.flash;
  next();
});

function requireLogin(req, res, next) {
  if (!req.session.user) {
    req.session.flash = { type: 'error', msg: 'Necesitás iniciar sesión.' };
    return res.redirect('/login');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || !req.session.user.is_admin) {
    return res.status(403).render('error', { msg: 'Solo el administrador puede acceder a esta sección.' });
  }
  next();
}

// ──────────────────────────────────────────────────────────────
// HELPERS DE APUESTAS
// ──────────────────────────────────────────────────────────────

// Construye un Map matchId → jornada label
function buildJornadaMap() {
  const map = new Map();
  const groupMs = db.prepare(`
    SELECT id, grp FROM matches WHERE grp IS NOT NULL
    ORDER BY grp, match_date, match_time, id
  `).all();
  const cnt = {};
  for (const m of groupMs) {
    cnt[m.grp] = (cnt[m.grp] || 0) + 1;
    const idx = cnt[m.grp];
    map.set(m.id, `Jornada ${idx <= 2 ? 1 : idx <= 4 ? 2 : 3}`);
  }
  db.prepare(`SELECT id, round FROM matches WHERE grp IS NULL`).all()
    .forEach(m => map.set(m.id, m.round));
  return map;
}

// Liquida las apuestas de un partido cuando tiene resultado
// Distribución: 70% del pozo de perdedores → exactos, 30% → outcome correcto
// Si no hay exactos: 100% → outcome correcto
// Si no hay ningún ganador: devuelve las apuestas
function settleBets(matchId) {
  const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
  if (!match || !match.finished) return;

  const pending = db.prepare(
    'SELECT * FROM bets WHERE match_id = ? AND settled = 0'
  ).all(matchId);
  if (pending.length === 0) return;

  const actualOutcome = match.goals1 > match.goals2 ? 'local'
    : match.goals1 < match.goals2 ? 'visitante' : 'empate';

  const classified = pending.map(b => {
    const bOut = b.pred_goals1 > b.pred_goals2 ? 'local'
      : b.pred_goals1 < b.pred_goals2 ? 'visitante' : 'empate';
    const exact = b.pred_goals1 === match.goals1 && b.pred_goals2 === match.goals2;
    return { ...b, result: exact ? 'exact' : bOut === actualOutcome ? 'outcome' : 'miss' };
  });

  const missers        = classified.filter(b => b.result === 'miss');
  const exactWinners   = classified.filter(b => b.result === 'exact');
  const outcomeWinners = classified.filter(b => b.result === 'outcome');
  const missPool       = missers.reduce((s, b) => s + b.amount, 0);
  const noWinners      = exactWinners.length === 0 && outcomeWinners.length === 0;

  const exactShare   = exactWinners.length > 0 ? 0.70 : 0;
  const outcomeShare = exactWinners.length > 0 ? 0.30 : 1.00;
  const exactPool    = missPool * exactShare;
  const outcomePool  = missPool * outcomeShare;
  const exactTotal   = exactWinners.reduce((s, b) => s + b.amount, 0);
  const outcomeTotal = outcomeWinners.reduce((s, b) => s + b.amount, 0);

  const updBet     = db.prepare('UPDATE bets SET result=?, payout=?, settled=1, updated_at=CURRENT_TIMESTAMP WHERE id=?');
  const updBalance = db.prepare('UPDATE users SET balance = balance + ? WHERE id=?');

  db.runInTx(() => {
    if (noWinners) {
      // Devolver apuestas a todos
      for (const b of pending) {
        updBet.run('miss', b.amount, b.id);
        updBalance.run(b.amount, b.user_id);
      }
      return;
    }
    for (const b of exactWinners) {
      const prize  = exactTotal   > 0 ? exactPool   * (b.amount / exactTotal)   : 0;
      const payout = Math.round((b.amount + prize) * 100) / 100;
      updBet.run('exact', payout, b.id);
      updBalance.run(payout, b.user_id);
    }
    for (const b of outcomeWinners) {
      const prize  = outcomeTotal > 0 ? outcomePool * (b.amount / outcomeTotal) : 0;
      const payout = Math.round((b.amount + prize) * 100) / 100;
      updBet.run('outcome', payout, b.id);
      updBalance.run(payout, b.user_id);
    }
    for (const b of missers) {
      updBet.run('miss', 0, b.id);
    }
  });
  console.log(`[bets] Partido ${matchId} liquidado — exactos:${exactWinners.length} outcome:${outcomeWinners.length} miss:${missers.length} pozo:${missPool.toFixed(2)}`);
}

// -------- Cálculo de puntos --------
// 5 puntos si acierta el resultado exacto
// 2 puntos si solo acierta el ganador (o el empate)
// 0 puntos en otro caso
function calcPoints(predA, predB, realA, realB) {
  if (realA === null || realB === null) return 0;
  if (predA === realA && predB === realB) return 5;
  const predSign = Math.sign(predA - predB);
  const realSign = Math.sign(realA - realB);
  if (predSign === realSign) return 2;
  return 0;
}

function recalcMatchPoints(matchId) {
  const match = db.prepare('SELECT goals1, goals2, finished FROM matches WHERE id = ?').get(matchId);
  if (!match) return;
  const preds = db.prepare('SELECT id, pred_goals1, pred_goals2 FROM predictions WHERE match_id = ?').all(matchId);
  const upd = db.prepare('UPDATE predictions SET points = ? WHERE id = ?');
  db.runInTx(() => {
    for (const p of preds) {
      const pts = match.finished
        ? calcPoints(p.pred_goals1, p.pred_goals2, match.goals1, match.goals2)
        : 0;
      upd.run(pts, p.id);
    }
  });
}

// =========================================
// RUTAS
// =========================================

app.get('/', (req, res) => {
  if (req.session.user) return res.redirect('/matches');
  res.redirect('/login');
});

app.get('/instructions', (req, res) => {
  res.render('instructions');
});

// ----- Registro -----
app.get('/register', (req, res) => {
  if (req.session.user) return res.redirect('/matches');
  res.render('register', { values: {}, error: null });
});

app.post('/register', (req, res) => {
  const { nickname, password, password2 } = req.body;
  const nick = (nickname || '').trim();
  if (!nick || nick.length < 3) {
    return res.render('register', { values: { nickname: nick }, error: 'El nickname debe tener al menos 3 caracteres.' });
  }
  if (!password || password.length < 4) {
    return res.render('register', { values: { nickname: nick }, error: 'La clave debe tener al menos 4 caracteres.' });
  }
  if (password !== password2) {
    return res.render('register', { values: { nickname: nick }, error: 'La clave y su confirmación no coinciden.' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE nickname = ?').get(nick);
  if (existing) {
    return res.render('register', { values: { nickname: nick }, error: 'Ese nickname ya está registrado.' });
  }
  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare('INSERT INTO users (nickname, password_hash, is_admin) VALUES (?, ?, 0)').run(nick, hash);
  req.session.user = { id: info.lastInsertRowid, nickname: nick, is_admin: 0 };
  req.session.flash = { type: 'success', msg: '¡Usuario creado! Ya estás logueado.' };
  res.redirect('/matches');
});

// ----- Login / Logout -----
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/matches');
  res.render('login', { error: null, values: {} });
});

app.post('/login', (req, res) => {
  const { nickname, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE nickname = ?').get((nickname || '').trim());
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.render('login', { error: 'Usuario o clave incorrectos.', values: { nickname } });
  }
  req.session.user = { id: user.id, nickname: user.nickname, is_admin: !!user.is_admin };
  res.redirect('/matches');
});

app.post('/logout', (req, res) => {
  req.session = null;
  res.redirect('/login');
});

// ----- Pantalla de partidos / pronósticos -----
app.get('/matches', requireLogin, (req, res) => {
  const matches = db.prepare(`
    SELECT m.*, p.pred_goals1, p.pred_goals2, p.points
    FROM matches m
    LEFT JOIN predictions p ON p.match_id = m.id AND p.user_id = ?
    ORDER BY m.match_date ASC, m.match_time ASC, m.id ASC
  `).all(req.session.user.id);

  // agrupar por ronda preservando orden
  const groups = [];
  const seen = new Map();
  for (const m of matches) {
    m.locked = isMatchLocked(m);
    m.matchTimeART = formatMatchTimeART(m);
    if (!seen.has(m.round)) {
      seen.set(m.round, groups.length);
      groups.push({ round: m.round, matches: [] });
    }
    groups[seen.get(m.round)].matches.push(m);
  }

  res.render('matches', { groups });
});

app.post('/predict/:id', requireLogin, (req, res) => {
  const matchId = parseInt(req.params.id, 10);
  const g1 = parseInt(req.body.goals1, 10);
  const g2 = parseInt(req.body.goals2, 10);
  if (Number.isNaN(g1) || Number.isNaN(g2) || g1 < 0 || g2 < 0 || g1 > 20 || g2 > 20) {
    req.session.flash = { type: 'error', msg: 'Goles inválidos.' };
    return res.redirect('/matches');
  }
  const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
  if (!match) {
    req.session.flash = { type: 'error', msg: 'Partido no encontrado.' };
    return res.redirect('/matches');
  }
  if (isMatchLocked(match)) {
    const msg = match.finished
      ? 'No podés modificar el pronóstico: el partido ya finalizó.'
      : 'No podés modificar el pronóstico: los pronósticos se cerraron 1 minuto antes del inicio.';
    req.session.flash = { type: 'error', msg };
    return res.redirect('/matches');
  }
  db.prepare(`
    INSERT INTO predictions (user_id, match_id, pred_goals1, pred_goals2)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, match_id) DO UPDATE SET
      pred_goals1 = excluded.pred_goals1,
      pred_goals2 = excluded.pred_goals2,
      updated_at = CURRENT_TIMESTAMP
  `).run(req.session.user.id, matchId, g1, g2);

  req.session.flash = { type: 'success', msg: `Pronóstico guardado: ${match.team1} ${g1} - ${g2} ${match.team2}` };
  res.redirect('/matches');
});

// ----- Ranking -----
app.get('/ranking', requireLogin, (req, res) => {

  // ── Ranking general (todos los partidos finalizados) ──────────
  const general = db.prepare(`
    SELECT u.nickname,
           COALESCE(SUM(p.points), 0) AS points,
           COUNT(p.id) AS preds,
           SUM(CASE WHEN p.points = 5 THEN 1 ELSE 0 END) AS exactos,
           SUM(CASE WHEN p.points = 2 THEN 1 ELSE 0 END) AS ganadores
    FROM users u
    LEFT JOIN predictions p ON p.user_id = u.id
    LEFT JOIN matches m ON m.id = p.match_id AND m.finished = 1
    WHERE 1=1
    GROUP BY u.id
    ORDER BY points DESC, exactos DESC, u.nickname ASC
  `).all();

  // ── Checkpoints de jornada (fase de grupos) ───────────────────
  // Cada grupo tiene 6 partidos: los primeros 2 = Jornada 1, siguientes 2 = J2, últimos 2 = J3
  // Jornada completa = todos sus 24 partidos (12 grupos × 2 partidos) finalizados
  const groupMatchesRaw = db.prepare(`
    SELECT id, grp, match_date, match_time, finished
    FROM matches
    WHERE grp IS NOT NULL
    ORDER BY grp, match_date, match_time, id
  `).all();

  // Asignar jornada a cada partido según su posición dentro del grupo
  const jornadaOf = {};
  const groupCount = {};
  for (const m of groupMatchesRaw) {
    groupCount[m.grp] = (groupCount[m.grp] || 0) + 1;
    const idx = groupCount[m.grp];
    jornadaOf[m.id] = idx <= 2 ? 1 : idx <= 4 ? 2 : 3;
  }
  const finishedById = Object.fromEntries(groupMatchesRaw.map(m => [m.id, m.finished === 1]));

  // Checkpoints: mostrar ranking acumulado al cierre de cada jornada completa
  const jornadaCheckpoints = [];
  let cumulativeIds = [];
  for (const jornada of [1, 2, 3]) {
    const jornadaIds = Object.entries(jornadaOf)
      .filter(([, j]) => j === jornada)
      .map(([id]) => +id);
    cumulativeIds = [...cumulativeIds, ...jornadaIds];

    const complete = jornadaIds.every(id => finishedById[id]);
    if (!complete) break; // si esta jornada no terminó, las siguientes tampoco

    const ph = cumulativeIds.map(() => '?').join(',');
    const ranking = db.prepare(`
      SELECT u.nickname,
             COALESCE(SUM(p.points), 0) AS points,
             SUM(CASE WHEN p.points = 5 THEN 1 ELSE 0 END) AS exactos,
             SUM(CASE WHEN p.points = 2 THEN 1 ELSE 0 END) AS ganadores
      FROM users u
      LEFT JOIN predictions p ON p.user_id = u.id AND p.match_id IN (${ph})
      WHERE 1=1
      GROUP BY u.id
      ORDER BY points DESC, exactos DESC, u.nickname ASC
    `).all(...cumulativeIds);

    jornadaCheckpoints.push({ jornada, ranking });
  }

  res.render('ranking', { general, jornadaCheckpoints });
});

// ----- Panel admin -----
app.get('/admin', requireLogin, requireAdmin, (req, res) => {
  const matches = db.prepare(`
    SELECT * FROM matches
    ORDER BY match_date ASC, match_time ASC, id ASC
  `).all();
  const groups = [];
  const seen = new Map();
  for (const m of matches) {
    if (!seen.has(m.round)) {
      seen.set(m.round, groups.length);
      groups.push({ round: m.round, matches: [] });
    }
    groups[seen.get(m.round)].matches.push(m);
  }
  res.render('admin', { groups, lastSync, lastSyncResult });
});

app.post('/admin/result/:id', requireLogin, requireAdmin, (req, res) => {
  const matchId = parseInt(req.params.id, 10);
  const g1raw = req.body.goals1;
  const g2raw = req.body.goals2;
  const clear = req.body.clear === '1';

  if (clear) {
    db.prepare('UPDATE matches SET goals1 = NULL, goals2 = NULL, finished = 0 WHERE id = ?').run(matchId);
    recalcMatchPoints(matchId);
    req.session.flash = { type: 'success', msg: 'Resultado borrado y puntos recalculados.' };
    return res.redirect('/admin');
  }

  const g1 = parseInt(g1raw, 10);
  const g2 = parseInt(g2raw, 10);
  if (Number.isNaN(g1) || Number.isNaN(g2) || g1 < 0 || g2 < 0 || g1 > 30 || g2 > 30) {
    req.session.flash = { type: 'error', msg: 'Resultado inválido.' };
    return res.redirect('/admin');
  }
  db.prepare('UPDATE matches SET goals1 = ?, goals2 = ?, finished = 1 WHERE id = ?').run(g1, g2, matchId);
  recalcMatchPoints(matchId);
  settleBets(matchId);
  req.session.flash = { type: 'success', msg: 'Resultado guardado y puntos/apuestas calculados.' };
  res.redirect('/admin');
});

app.post('/admin/reload-fixture', requireLogin, requireAdmin, async (req, res) => {
  try {
    const fetch = require('node-fetch');
    const URL = process.env.WORLDCUP_JSON_URL ||
      'https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json';
    const r = await fetch(URL);
    const data = await r.json();
    const insert = db.prepare(`
      INSERT INTO matches (round, match_date, match_time, team1, team2, grp, ground, goals1, goals2, finished)
      VALUES (@round, @match_date, @match_time, @team1, @team2, @grp, @ground, @goals1, @goals2, @finished)
      ON CONFLICT(round, match_date, team1, team2) DO UPDATE SET
        match_time = excluded.match_time,
        grp = excluded.grp,
        ground = excluded.ground
    `);
    const items = data.matches || [];
    db.runInTx(() => {
      for (const m of items) {
        const ft = (m.score && m.score.ft) ? m.score.ft : null;
        insert.run({
          round: m.round || 'Desconocida',
          match_date: m.date || '',
          match_time: m.time || null,
          team1: m.team1 || '', team2: m.team2 || '',
          grp: m.group || null, ground: m.ground || null,
          goals1: ft ? ft[0] : null, goals2: ft ? ft[1] : null,
          finished: ft ? 1 : 0
        });
      }
    });
    req.session.flash = { type: 'success', msg: `Fixture recargado (${(data.matches || []).length} partidos).` };
  } catch (e) {
    console.error(e);
    req.session.flash = { type: 'error', msg: 'No se pudo recargar el fixture: ' + e.message };
  }
  res.redirect('/admin');
});

// ─── Sync automático de resultados ───────────────────────────────────────────
const FIXTURE_URL = process.env.WORLDCUP_JSON_URL ||
  'https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json';

let lastSync = null;      // Date del último intento
let lastSyncResult = null; // { updated, total, error }

async function syncResults() {
  const fetch = require('node-fetch');
  const started = new Date();
  try {
    const r = await fetch(FIXTURE_URL, { timeout: 12000 });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();

    const items = (data.matches || []).filter(m => m.score && m.score.ft);
    let updated = 0;

    for (const m of items) {
      const [g1, g2] = m.score.ft;
      const row = db.prepare(`
        SELECT id, finished, goals1, goals2
        FROM matches
        WHERE round = ? AND match_date = ? AND team1 = ? AND team2 = ?
      `).get(m.round, m.date, m.team1, m.team2);

      if (!row) continue;
      // Solo escribir si algo cambió
      if (row.finished === 1 && row.goals1 === g1 && row.goals2 === g2) continue;

      db.prepare('UPDATE matches SET goals1=?, goals2=?, finished=1 WHERE id=?').run(g1, g2, row.id);
      recalcMatchPoints(row.id);
      settleBets(row.id);
      updated++;
    }

    lastSync = started;
    lastSyncResult = { ok: true, updated, total: items.length };
    if (updated > 0) console.log(`[sync] ${updated} partido(s) actualizado(s) con resultado`);

  } catch (e) {
    lastSync = started;
    lastSyncResult = { ok: false, error: e.message };
    console.error('[sync] Error al sincronizar resultados:', e.message);
  }
}

// Sync al arrancar + cada hora
syncResults();
setInterval(syncResults, 60 * 60 * 1000);

// Sync manual desde el admin
app.post('/admin/sync', requireLogin, requireAdmin, async (req, res) => {
  await syncResults();
  const r = lastSyncResult;
  if (r.ok) {
    req.session.flash = { type: 'success', msg: `Sync OK — ${r.updated} partido(s) actualizado(s) de ${r.total} con resultado.` };
  } else {
    req.session.flash = { type: 'error', msg: `Error en sync: ${r.error}` };
  }
  res.redirect('/admin');
});

// =========================================
// APUESTAS
// =========================================

// Helper: jornada activa = primera jornada con al menos un partido no bloqueado
function getActiveJornada(jornadaMap) {
  const matches = db.prepare(
    'SELECT * FROM matches ORDER BY match_date, match_time, id'
  ).all();
  for (const m of matches) {
    if (!isMatchLocked(m)) return jornadaMap.get(m.id) || m.round;
  }
  // Todas bloqueadas → primera con algún partido sin resultado
  for (const m of matches) {
    if (!m.finished) return jornadaMap.get(m.id) || m.round;
  }
  return matches.length ? jornadaMap.get(matches[matches.length - 1].id) : null;
}

// GET /betting — vista principal de apuestas
app.get('/betting', requireLogin, (req, res) => {
  const uid      = req.session.user.id;
  const jMap     = buildJornadaMap();
  const jornada  = req.query.jornada || getActiveJornada(jMap);
  if (!jornada) {
    return res.render('betting', { currentJornada: null, matches: [], balance: 0, jornadaDeposit: 0, jornadaBet: 0, allJornadas: [] });
  }

  // Lista de todas las jornadas disponibles para el selector
  const allJornadas = [...new Set([...jMap.values()])];

  // Partidos de esta jornada
  const jornadaMatches = db.prepare(
    'SELECT * FROM matches ORDER BY match_date, match_time, id'
  ).all()
    .filter(m => (jMap.get(m.id) || m.round) === jornada)
    .map(m => ({
      ...m,
      locked:       isMatchLocked(m),
      matchTimeART: formatMatchTimeART(m),
      jornada:      jMap.get(m.id) || m.round,
    }));

  const mIds = jornadaMatches.map(m => m.id);
  const ph   = mIds.map(() => '?').join(',');

  // Bets del usuario en esta jornada
  const userBets = mIds.length
    ? db.prepare(`SELECT * FROM bets WHERE user_id = ? AND match_id IN (${ph})`).all(uid, ...mIds)
    : [];
  const betByMatch = Object.fromEntries(userBets.map(b => [b.match_id, b]));

  // Pozo por partido (todos los usuarios)
  const pools = mIds.length
    ? db.prepare(`
        SELECT match_id,
          COUNT(*)  AS betters,
          SUM(amount) AS total,
          SUM(CASE WHEN pred_goals1 > pred_goals2 THEN amount ELSE 0 END) AS local_pool,
          SUM(CASE WHEN pred_goals1 = pred_goals2 THEN amount ELSE 0 END) AS empate_pool,
          SUM(CASE WHEN pred_goals1 < pred_goals2 THEN amount ELSE 0 END) AS visitante_pool
        FROM bets WHERE match_id IN (${ph})
        GROUP BY match_id
      `).all(...mIds)
    : [];
  const poolByMatch = Object.fromEntries(pools.map(p => [p.match_id, p]));

  jornadaMatches.forEach(m => {
    m.myBet = betByMatch[m.id] || null;
    m.pool  = poolByMatch[m.id] || { betters: 0, total: 0, local_pool: 0, empate_pool: 0, visitante_pool: 0 };
  });

  const user          = db.prepare('SELECT balance FROM users WHERE id = ?').get(uid);
  const jornadaDeposit = db.prepare('SELECT COALESCE(SUM(amount),0) AS t FROM jornada_deposits WHERE user_id=? AND jornada=?').get(uid, jornada).t;
  const jornadaBet     = db.prepare('SELECT COALESCE(SUM(amount),0) AS t FROM bets WHERE user_id=? AND jornada=? AND settled=0').get(uid, jornada).t;

  res.render('betting', { currentJornada: jornada, matches: jornadaMatches, balance: user.balance, jornadaDeposit, jornadaBet, allJornadas });
});

// POST /betting/deposit
app.post('/betting/deposit', requireLogin, (req, res) => {
  const uid     = req.session.user.id;
  const amount  = parseFloat(req.body.amount);
  const jornada = (req.body.jornada || '').trim();
  if (!amount || amount <= 0 || isNaN(amount)) {
    req.session.flash = { type: 'error', msg: 'Monto inválido.' };
    return res.redirect('/betting' + (jornada ? `?jornada=${encodeURIComponent(jornada)}` : ''));
  }
  db.runInTx(() => {
    db.prepare('INSERT INTO jornada_deposits (user_id, jornada, amount) VALUES (?,?,?)').run(uid, jornada, amount);
    db.prepare('UPDATE users SET balance = balance + ? WHERE id=?').run(amount, uid);
  });
  req.session.flash = { type: 'success', msg: `$${amount.toFixed(2)} agregados para ${jornada}.` };
  res.redirect('/betting?jornada=' + encodeURIComponent(jornada));
});

// POST /betting/bet/:matchId
app.post('/betting/bet/:matchId', requireLogin, (req, res) => {
  const uid     = req.session.user.id;
  const matchId = parseInt(req.params.matchId, 10);
  const amount  = parseFloat(req.body.amount);
  const g1      = parseInt(req.body.goals1, 10);
  const g2      = parseInt(req.body.goals2, 10);

  if (isNaN(g1) || isNaN(g2) || g1 < 0 || g2 < 0 || g1 > 20 || g2 > 20) {
    req.session.flash = { type: 'error', msg: 'Marcador inválido.' };
    return res.redirect('/betting');
  }
  if (isNaN(amount) || amount <= 0) {
    req.session.flash = { type: 'error', msg: 'Monto inválido.' };
    return res.redirect('/betting');
  }

  const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
  if (!match) { req.session.flash = { type: 'error', msg: 'Partido no encontrado.' }; return res.redirect('/betting'); }
  if (isMatchLocked(match)) { req.session.flash = { type: 'error', msg: 'El partido ya cerró para apuestas.' }; return res.redirect('/betting'); }

  const jMap    = buildJornadaMap();
  const jornada = jMap.get(matchId) || match.round;

  const user     = db.prepare('SELECT balance FROM users WHERE id=?').get(uid);
  const existing = db.prepare('SELECT amount FROM bets WHERE user_id=? AND match_id=?').get(uid, matchId);
  const prevAmt  = existing ? existing.amount : 0;
  const diff     = amount - prevAmt; // cuánto más se descuenta (puede ser negativo si baja la apuesta)

  if (diff > 0 && user.balance < diff) {
    req.session.flash = { type: 'error', msg: `Saldo insuficiente ($${user.balance.toFixed(2)} disponible).` };
    return res.redirect('/betting?jornada=' + encodeURIComponent(jornada));
  }

  db.runInTx(() => {
    db.prepare(`
      INSERT INTO bets (user_id, match_id, jornada, amount, pred_goals1, pred_goals2)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(user_id, match_id) DO UPDATE SET
        amount=excluded.amount, pred_goals1=excluded.pred_goals1,
        pred_goals2=excluded.pred_goals2, updated_at=CURRENT_TIMESTAMP
    `).run(uid, matchId, jornada, amount, g1, g2);
    db.prepare('UPDATE users SET balance = balance - ? WHERE id=?').run(diff, uid);
  });

  req.session.flash = { type: 'success', msg: `Apuesta guardada: ${match.team1} ${g1}-${g2} ${match.team2} · $${amount.toFixed(2)}` };
  res.redirect('/betting?jornada=' + encodeURIComponent(jornada));
});

// GET /betting/ranking
app.get('/betting/ranking', requireLogin, (req, res) => {
  const ranking = db.prepare(`
    SELECT u.nickname, u.balance,
      COALESCE((SELECT SUM(d.amount) FROM jornada_deposits d WHERE d.user_id=u.id), 0) AS deposited,
      COALESCE((SELECT SUM(b.payout) FROM bets b WHERE b.user_id=u.id AND b.settled=1), 0) AS total_won,
      COALESCE((SELECT SUM(b.amount) FROM bets b WHERE b.user_id=u.id AND b.settled=1), 0) AS total_wagered,
      (SELECT COUNT(*) FROM bets b WHERE b.user_id=u.id AND b.result='exact')   AS exact_hits,
      (SELECT COUNT(*) FROM bets b WHERE b.user_id=u.id AND b.result='outcome') AS outcome_hits,
      (SELECT COUNT(*) FROM bets b WHERE b.user_id=u.id AND b.result='miss')    AS misses
    FROM users u
    WHERE 1=1
    ORDER BY u.balance DESC, total_won DESC
  `).all();
  res.render('betting-ranking', { ranking });
});

// 404
app.use((req, res) => {
  res.status(404).render('error', { msg: 'Página no encontrada.' });
});

app.listen(PORT, () => {
  console.log(`Quiniela del Mundial corriendo en http://localhost:${PORT}`);
});

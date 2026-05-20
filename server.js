// server.js - aplicación principal Express
const express = require('express');
const session = require('express-session');
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

app.use(session({
  secret: process.env.SESSION_SECRET || 'cambia-este-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 24 * 7 } // 7 días
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
  req.session.destroy(() => res.redirect('/login'));
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

// ----- Ranking por ronda -----
app.get('/ranking', requireLogin, (req, res) => {
  // Por ronda: suma de puntos por usuario en partidos finalizados de esa ronda
  const rows = db.prepare(`
    SELECT m.round AS round, u.nickname AS nickname,
           SUM(p.points) AS points,
           COUNT(p.id) AS preds,
           SUM(CASE WHEN p.points = 5 THEN 1 ELSE 0 END) AS exactos,
           SUM(CASE WHEN p.points = 2 THEN 1 ELSE 0 END) AS ganadores
    FROM predictions p
    JOIN users u ON u.id = p.user_id
    JOIN matches m ON m.id = p.match_id
    WHERE m.finished = 1
    GROUP BY m.round, u.id
    ORDER BY m.round ASC, points DESC, u.nickname ASC
  `).all();

  // Mejor pronosticador de cada ronda
  const byRound = new Map();
  for (const r of rows) {
    if (!byRound.has(r.round)) byRound.set(r.round, []);
    byRound.get(r.round).push(r);
  }

  // Ranking general
  const general = db.prepare(`
    SELECT u.nickname,
           COALESCE(SUM(p.points), 0) AS points,
           COUNT(p.id) AS preds,
           SUM(CASE WHEN p.points = 5 THEN 1 ELSE 0 END) AS exactos,
           SUM(CASE WHEN p.points = 2 THEN 1 ELSE 0 END) AS ganadores
    FROM users u
    LEFT JOIN predictions p ON p.user_id = u.id
    LEFT JOIN matches m ON m.id = p.match_id AND m.finished = 1
    WHERE u.is_admin = 0
    GROUP BY u.id
    ORDER BY points DESC, exactos DESC, u.nickname ASC
  `).all();

  res.render('ranking', { byRound: Array.from(byRound.entries()), general });
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
  res.render('admin', { groups });
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
  req.session.flash = { type: 'success', msg: 'Resultado guardado y puntos calculados.' };
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

// 404
app.use((req, res) => {
  res.status(404).render('error', { msg: 'Página no encontrada.' });
});

app.listen(PORT, () => {
  console.log(`Quiniela del Mundial corriendo en http://localhost:${PORT}`);
});

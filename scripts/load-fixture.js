// scripts/load-fixture.js - descarga fixture del Mundial 2026 desde openfootball
const fetch = require('node-fetch');
const db = require('../db');

const URL = process.env.WORLDCUP_JSON_URL ||
  'https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json';

async function main() {
  console.log('Descargando fixture desde:', URL);
  const res = await fetch(URL);
  if (!res.ok) {
    console.error('Error al descargar fixture:', res.status, res.statusText);
    process.exit(1);
  }
  const data = await res.json();
  const matches = data.matches || [];
  console.log(`Recibidos ${matches.length} partidos. Cargando...`);

  const insert = db.prepare(`
    INSERT INTO matches (round, match_date, match_time, team1, team2, grp, ground, goals1, goals2, finished)
    VALUES (@round, @match_date, @match_time, @team1, @team2, @grp, @ground, @goals1, @goals2, @finished)
    ON CONFLICT(round, match_date, team1, team2) DO UPDATE SET
      match_time = excluded.match_time,
      grp = excluded.grp,
      ground = excluded.ground
  `);

  db.runInTx(() => {
    for (const m of matches) {
      const ft = (m.score && m.score.ft) ? m.score.ft : null;
      insert.run({
        round: m.round || 'Desconocida',
        match_date: m.date || '',
        match_time: m.time || null,
        team1: m.team1 || '',
        team2: m.team2 || '',
        grp: m.group || null,
        ground: m.ground || null,
        goals1: ft ? ft[0] : null,
        goals2: ft ? ft[1] : null,
        finished: ft ? 1 : 0
      });
    }
  });

  const count = db.prepare('SELECT COUNT(*) AS c FROM matches').get().c;
  console.log(`Fixture cargado. Total partidos en la base: ${count}`);
}

main().catch(err => { console.error(err); process.exit(1); });

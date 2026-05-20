// scripts/init-db.js - crea las tablas y un usuario admin por defecto
const bcrypt = require('bcryptjs');
const db = require('../db');

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

const exists = db.prepare('SELECT id FROM users WHERE nickname = ?').get(ADMIN_USER);
if (!exists) {
  const hash = bcrypt.hashSync(ADMIN_PASS, 10);
  db.prepare('INSERT INTO users (nickname, password_hash, is_admin) VALUES (?, ?, 1)').run(ADMIN_USER, hash);
  console.log(`Usuario admin creado: ${ADMIN_USER} / ${ADMIN_PASS}`);
} else {
  console.log(`Usuario admin "${ADMIN_USER}" ya existe`);
}
console.log('Base de datos inicializada.');

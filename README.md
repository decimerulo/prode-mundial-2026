# Quiniela del Mundial 2026

Juego web para pronosticar el resultado de cada partido del Mundial 2026.
Cada jugador ingresa cantidad de goles para los dos equipos. Cuando el administrador carga el resultado real:

- **5 puntos** si acertó el resultado exacto (goles de cada equipo).
- **2 puntos** si solo acertó al ganador (o al empate).
- **0 puntos** en cualquier otro caso.

El sistema muestra una **tabla de posiciones** general y por ronda.

---

## Stack

- **Node.js 22+** (usa el módulo built-in `node:sqlite`, no necesita dependencias nativas).
- **Express + EJS** para servir páginas server-rendered.
- **SQLite** (archivo único `data/quiniela.db`).
- **bcryptjs** para hashear contraseñas.
- **Fixture** del Mundial 2026 desde [openfootball/worldcup.json](https://github.com/openfootball/worldcup.json) (dominio público, sin API key).

---

## Estructura del proyecto

```
mundial-quiniela/
├── server.js              # Aplicación Express
├── db.js                  # Conexión + schema SQLite
├── package.json
├── .env.example           # Copialo a .env y editalo
├── data/quiniela.db       # Se crea al iniciar
├── scripts/
│   ├── init-db.js         # Crea tablas y usuario admin
│   └── load-fixture.js    # Descarga los partidos del Mundial
├── public/css/styles.css
└── views/                 # Plantillas EJS
    ├── partials/{head,foot}.ejs
    ├── login.ejs
    ├── register.ejs
    ├── matches.ejs
    ├── ranking.ejs
    ├── admin.ejs
    └── error.ejs
```

---

## Correr localmente

```bash
# 1) Clonar / copiar el proyecto
cd mundial-quiniela

# 2) Configurar variables
cp .env.example .env
nano .env   # cambiá SESSION_SECRET, ADMIN_PASS, etc.

# 3) Instalar dependencias
npm install

# 4) Crear la base y el usuario admin
npm run init-db

# 5) Descargar el fixture del Mundial 2026
npm run load-fixture

# 6) Levantar el servidor
npm start
# -> http://localhost:3000
```

**Usuario admin por defecto**: `admin` / `admin123` (cambialo en `.env` antes del primer init).

---

## Publicar en EC2 — paso a paso

### 1. Crear la instancia EC2

1. Entrá a la consola AWS → EC2 → **Launch instance**.
2. Nombre: `quiniela-mundial`.
3. AMI: **Ubuntu Server 24.04 LTS** (HVM, 64-bit x86).
4. Tipo: **t2.micro** (free tier) o `t3.micro`.
5. Key pair: creá uno nuevo o usá uno existente y descargá el `.pem`.
6. **Network → Security group**: creá uno nuevo con estas reglas inbound:
   - SSH (22) desde *Mi IP*.
   - HTTP (80) desde *Anywhere (0.0.0.0/0)*.
   - HTTPS (443) desde *Anywhere* (opcional, si configurás dominio + TLS).
7. Storage: 8 GB es más que suficiente.
8. Launch instance.

Anotá la **IP pública** y el **DNS público** (ej: `ec2-1-2-3-4.compute-1.amazonaws.com`).

### 2. Conectarse por SSH

```bash
chmod 400 ~/Downloads/mi-key.pem
ssh -i ~/Downloads/mi-key.pem ubuntu@<IP_PUBLICA>
```

### 3. Instalar Node 22, nginx y herramientas

```bash
sudo apt update && sudo apt -y upgrade
# Node 22 LTS desde NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs nginx git
node --version   # debería decir v22.x
```

### 4. Subir el código

Opción A — vía Git (recomendada):
```bash
# en tu máquina local: crear repo en GitHub y pushear el proyecto
cd mundial-quiniela
git init && git add . && git commit -m "init"
git remote add origin git@github.com:TU_USUARIO/quiniela.git
git push -u origin main

# en EC2:
cd ~
git clone https://github.com/TU_USUARIO/quiniela.git mundial-quiniela
cd mundial-quiniela
```

Opción B — vía scp:
```bash
# desde tu máquina local
scp -i ~/Downloads/mi-key.pem -r mundial-quiniela ubuntu@<IP_PUBLICA>:~/
```

### 5. Instalar dependencias y configurar

```bash
cd ~/mundial-quiniela
cp .env.example .env
nano .env
# Editar:
#   PORT=3000
#   SESSION_SECRET=<una clave larga aleatoria, ej: openssl rand -hex 32>
#   ADMIN_USER=admin
#   ADMIN_PASS=<una clave fuerte>
npm install --omit=dev
npm run init-db
npm run load-fixture
```

Probá manualmente que arranque:
```bash
npm start
# en otra terminal: curl http://localhost:3000/login
# Ctrl+C para frenar
```

### 6. Correr como servicio con PM2

```bash
sudo npm install -g pm2
pm2 start server.js --name quiniela --update-env
pm2 save
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u ubuntu --hp /home/ubuntu
# (pegá el comando que te imprime y ejecutalo)
pm2 status
pm2 logs quiniela --lines 20
```

### 7. Configurar nginx como reverse proxy (puerto 80 → 3000)

```bash
sudo tee /etc/nginx/sites-available/quiniela > /dev/null <<'EOF'
server {
    listen 80 default_server;
    server_name _;

    client_max_body_size 1m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF

sudo ln -sf /etc/nginx/sites-available/quiniela /etc/nginx/sites-enabled/quiniela
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

### 8. Probar

Desde tu navegador andá a `http://<IP_PUBLICA>` y deberías ver la pantalla de login.

### 9. (Opcional) Dominio + HTTPS gratis con Let's Encrypt

1. Apuntá un A-record desde tu dominio (ej. `quiniela.midominio.com`) a la IP pública.
2. En EC2:
   ```bash
   sudo apt install -y certbot python3-certbot-nginx
   sudo certbot --nginx -d quiniela.midominio.com
   ```
3. Certbot edita nginx para servir HTTPS y renueva el certificado solo.

### 10. Mantenimiento

- Ver logs: `pm2 logs quiniela`
- Reiniciar app: `pm2 restart quiniela`
- Recargar fixture (también disponible desde el panel admin web): `npm run load-fixture`
- Backup de la base: `cp ~/mundial-quiniela/data/quiniela.db ~/backup-$(date +%F).db`

---

## Uso del sistema

1. Andá a la URL pública y hacé clic en **Registrarme**. Completá nickname + clave + confirmación.
2. Te logueás automáticamente y llegás a la pantalla de **Partidos**. Cada partido tiene dos combos (0 a 15 goles). Elegí tu pronóstico y *Guardar*. Podés editar mientras el partido no esté finalizado.
3. En **Ranking** ves tu puntaje y el de los demás jugadores, total y por ronda.
4. El **administrador** (login con la cuenta `admin`) accede a **Admin** y carga el resultado real de cada partido. Al guardar, el sistema recalcula los puntos automáticamente.
5. Desde el panel admin también podés tocar *Recargar fixture* para volver a tirar de la API de openfootball (útil si OpenFootball agrega más partidos a medida que avanza el sorteo).

---

## Reglas de puntos

| Pronóstico vs Resultado real | Puntos |
|---|---|
| Goles exactos de ambos equipos | **5** |
| Solo acertó al ganador (o al empate) | **2** |
| Equivocado | **0** |

Implementado en `server.js → calcPoints()`.

---

## Licencia

MIT.

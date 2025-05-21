const express = require('express');
const multer = require('multer');
const unzipper = require('unzipper');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// Connexion à PostgreSQL via DATABASE_URL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));
app.use('/modules', express.static(path.join(__dirname, 'modules')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(session({
  secret: 'secret-ultra-secure',
  resave: false,
  saveUninitialized: false
}));

// Multer pour upload
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, './uploads');
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage: storage });

// 🔧 Création des tables si elles n'existent pas
const initDB = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS modules (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      name TEXT NOT NULL,
      folder TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
};
initDB();

// 🔐 Auth
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'register.html')));
app.get('/dashboard', (req, res) => {
  if (!req.session.userId) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

app.post('/register', async (req, res) => {
  const { email, password } = req.body;
  const hash = await bcrypt.hash(password, 10);
  try {
    await pool.query('INSERT INTO users (email, password) VALUES ($1, $2)', [email, hash]);
    res.send('✅ Compte créé avec succès. <a href="/login">Se connecter</a>');
  } catch {
    res.send('❌ Email déjà utilisé.');
  }
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  const user = result.rows[0];
  if (!user) return res.send('❌ Utilisateur non trouvé.');
  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.send('❌ Mot de passe incorrect.');
  req.session.userId = user.id;
  res.redirect('/dashboard');
});

// 📤 Upload SCORM
app.post('/upload', upload.single('scormfile'), async (req, res) => {
  if (!req.session.userId) return res.redirect('/login');
  if (!req.file) return res.status(400).send('❌ Aucun fichier reçu.');

  const zipPath = req.file.path;
  const moduleName = path.parse(req.file.filename).name;
  const extractPath = path.join(__dirname, 'modules', moduleName);

  fs.createReadStream(zipPath)
    .pipe(unzipper.Extract({ path: extractPath }))
    .on('close', async () => {
      const candidates = [
        path.join(extractPath, 'story.html'),
        path.join(extractPath, 'genially.html'),
        path.join(extractPath, 'scormcontent', 'index.html')
      ];
      const found = candidates.find(f => fs.existsSync(f));
      if (!found) {
        return res.send('✅ Module décompressé, mais aucun fichier HTML reconnu trouvé.');
      }
      const relative = found.replace(path.join(__dirname, 'modules'), '').replace(/\\/g, '/');
      const accessUrl = `https://${req.headers.host}/modules${relative}`;
      await pool.query(
        'INSERT INTO modules (user_id, name, folder) VALUES ($1, $2, $3)',
        [req.session.userId, req.file.originalname, moduleName]
      );
      res.send(`✅ Module prêt !<br><br><a href="${accessUrl}" target="_blank">➡️ Lancer le module</a><br><br><a href="/dashboard">⬅️ Retour au tableau de bord</a>`);
    })
    .on('error', (err) => {
      console.error('Erreur de décompression :', err);
      res.status(500).send('❌ Erreur de décompression.');
    });
});

// 📃 Liste des modules
app.get('/list', async (req, res) => {
  if (!req.session.userId) return res.redirect('/login');
  const result = await pool.query('SELECT * FROM modules WHERE user_id = $1', [req.session.userId]);
  const modules = result.rows.map(mod => {
    const base = path.join(__dirname, 'modules', mod.folder);
    const candidates = [
      path.join(base, 'story.html'),
      path.join(base, 'genially.html'),
      path.join(base, 'scormcontent', 'index.html')
    ];
    const found = candidates.find(f => fs.existsSync(f));
    if (!found) return null;
    const relative = found.replace(path.join(__dirname, 'modules'), '').replace(/\\/g, '/');
    return {
      name: mod.name,
      folder: mod.folder,
      url: `/modules${relative}`
    };
  }).filter(Boolean);
  res.json(modules);
});

// ❌ Suppression d’un module
app.post('/delete', async (req, res) => {
  if (!req.session.userId) return res.redirect('/login');
  const folder = req.body.module;
  await pool.query('DELETE FROM modules WHERE user_id = $1 AND folder = $2', [req.session.userId, folder]);

  const modulePath = path.join(__dirname, 'modules', folder);
  if (fs.existsSync(modulePath)) {
    fs.rmSync(modulePath, { recursive: true, force: true });
  }

  res.redirect('/dashboard');
});

// ▶️ Lancer le serveur
app.listen(PORT, () => {
  console.log(`✅ Serveur en ligne sur le port ${PORT}`);
});

const express = require('express');
const multer = require('multer');
const unzipper = require('unzipper');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');
const db = new Database('data.db');

const app = express();
const PORT = 3000;

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));
app.use('/modules', express.static(path.join(__dirname, 'modules')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(session({
    secret: 'ton-secret-ultra-secure',
    resave: false,
    saveUninitialized: false
}));

// Multer pour l'upload
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, './uploads');
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage });

// 📄 Pages HTML
app.get('/', (req, res) => {
    res.redirect('/login');
});
app.get('/register', (req, res) => {
    res.sendFile(path.join(__dirname, 'register.html'));
});
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});
app.get('/dashboard', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});
app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// 🧑 Inscription
app.post('/register', async (req, res) => {
    const { email, password } = req.body;
    const hash = await bcrypt.hash(password, 10);
    try {
        const stmt = db.prepare('INSERT INTO users (email, password) VALUES (?, ?)');
        stmt.run(email, hash);
        res.send('✅ Compte créé avec succès. <a href="/login">Se connecter</a>');
    } catch (err) {
        res.send('❌ Email déjà utilisé.');
    }
});

// 🔐 Connexion
app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    const stmt = db.prepare('SELECT * FROM users WHERE email = ?');
    const user = stmt.get(email);

    if (!user) return res.send('❌ Utilisateur non trouvé.');
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.send('❌ Mot de passe incorrect.');

    req.session.userId = user.id;
    res.redirect('/dashboard');
});

// 📤 Upload d’un module
app.post('/upload', upload.single('scormfile'), async (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    if (!req.file) return res.status(400).send('❌ Aucun fichier reçu.');

    const zipPath = req.file.path;
    const moduleName = path.parse(req.file.filename).name;
    const extractPath = path.join(__dirname, 'modules', moduleName);

    fs.createReadStream(zipPath)
        .pipe(unzipper.Extract({ path: extractPath }))
        .on('close', () => {
            const candidates = [
                path.join(extractPath, 'story.html'),
                path.join(extractPath, 'genially.html'),
                path.join(extractPath, 'scormcontent', 'index.html')
            ];

            const found = candidates.find(f => fs.existsSync(f));
            if (!found) {
                return res.send('✅ Module décompressé, mais aucun fichier HTML reconnu trouvé.');
            }

            const relativePath = found.replace(path.join(__dirname, 'modules'), '').replace(/\\/g, '/');
            const stmt = db.prepare('INSERT INTO modules (user_id, name, folder) VALUES (?, ?, ?)');
            stmt.run(req.session.userId, req.file.originalname, moduleName);

            const accessUrl = `http://localhost:${PORT}/modules${relativePath}`;
            res.send(`✅ Module prêt !<br><br><a href="${accessUrl}" target="_blank">➡️ Lancer le module</a><br><br><a href="/dashboard">⬅️ Retour au tableau de bord</a>`);
        })
        .on('error', (err) => {
            console.error('Erreur de décompression :', err);
            res.status(500).send('❌ Erreur de décompression.');
        });
});

// 📃 Liste des modules de l'utilisateur connecté
app.get('/list', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const stmt = db.prepare('SELECT * FROM modules WHERE user_id = ?');
    const modules = stmt.all(req.session.userId);

    const result = modules.map(mod => {
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

    res.json(result);
});

// ❌ Suppression d’un module
app.post('/delete', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    const folder = req.body.module;
    const stmt = db.prepare('DELETE FROM modules WHERE user_id = ? AND folder = ?');
    stmt.run(req.session.userId, folder);

    const modulePath = path.join(__dirname, 'modules', folder);
    if (fs.existsSync(modulePath)) {
        fs.rmSync(modulePath, { recursive: true, force: true });
    }

    res.redirect('/dashboard');
});

// ✅ Lancer le serveur
app.listen(PORT, () => {
    console.log(`✅ Serveur en ligne sur : http://localhost:${PORT}`);
});


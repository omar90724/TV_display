const express = require('express');
const https = require('https');
const { Server } = require("socket.io");
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
const sslOptions = {
    key: fs.readFileSync(path.join(__dirname, 'server.key')),
    cert: fs.readFileSync(path.join(__dirname, 'server.cert'))
};
const server = https.createServer(sslOptions, app);
const io = new Server(server, { cors: { origin: "*" } });

const uploadDir = path.join(__dirname, 'uploads');
const dataDir = path.join(__dirname, 'data');
const allPlayersFile = path.join(dataDir, 'players.json');

if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

app.use(express.static(path.join(__dirname, '../frontend')));
app.use('/uploads', express.static(uploadDir));
app.use(express.json());

const getMediaFilePath = (id) => path.join(dataDir, `media_${id}.json`);

// ROTAS DE PLAYERS
app.get('/api/players', (req, res) => {
    const players = fs.existsSync(allPlayersFile) ? JSON.parse(fs.readFileSync(allPlayersFile)) : [];
    res.json(players);
});

app.post('/api/players', (req, res) => {
    const { id, name } = req.body;
    let players = fs.existsSync(allPlayersFile) ? JSON.parse(fs.readFileSync(allPlayersFile)) : [];
    if (!players.find(p => p.id === id)) {
        players.push({ id, name });
        fs.writeFileSync(allPlayersFile, JSON.stringify(players, null, 2));
    }
    res.sendStatus(201);
});

app.post('/api/players/edit/:id', (req, res) => {
    const { id } = req.params;
    const { newName } = req.body;
    let players = JSON.parse(fs.readFileSync(allPlayersFile));
    const idx = players.findIndex(p => p.id === id);
    if (idx !== -1) {
        players[idx].name = newName;
        fs.writeFileSync(allPlayersFile, JSON.stringify(players, null, 2));
        res.sendStatus(200);
    } else res.sendStatus(404);
});

app.post('/api/players/delete/:id', (req, res) => {
    const { id } = req.params;
    let players = JSON.parse(fs.readFileSync(allPlayersFile));
    players = players.filter(p => p.id !== id);
    fs.writeFileSync(allPlayersFile, JSON.stringify(players, null, 2));
    const mFile = getMediaFilePath(id);
    if (fs.existsSync(mFile)) fs.unlinkSync(mFile);
    res.sendStatus(200);
});

// ATUALIZAR DATA DE EXPIRAÇÃO
app.post('/api/media/update-expiry/:id', (req, res) => {
    const playerId = req.params.id;
    const { filename, newExpiry } = req.body;
    const dataPath = getMediaFilePath(playerId);

    if (!fs.existsSync(dataPath)) return res.status(404).send("Arquivo não encontrado");

    let mediaList = JSON.parse(fs.readFileSync(dataPath));
    const index = mediaList.findIndex(m => m.filename === filename);

    if (index !== -1) {
        mediaList[index].expiresAt = new Date(newExpiry).getTime();
        fs.writeFileSync(dataPath, JSON.stringify(mediaList, null, 2));
        io.emit(`mediaUpdate:${playerId}`); // Notifica a TV para atualizar
        res.sendStatus(200);
    } else {
        res.status(404).send("Mídia não encontrada");
    }
});

// ROTAS DE MÍDIA
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

app.post('/api/upload/:id', upload.single('file'), (req, res) => {
    const playerId = req.params.id;
    const dataPath = getMediaFilePath(playerId);
    let mediaList = fs.existsSync(dataPath) ? JSON.parse(fs.readFileSync(dataPath)) : [];

    const type = req.body.type;
    let filename = req.file ? req.file.filename : req.body.url;
    
    // CRIA ID ÚNICO: Se for Power BI, combina o ID do Relatório com o Nome da Página
    if (type === 'powerbi' && req.body.pageName) {
        filename = `${req.body.url}_${req.body.pageName}`;
    }

    mediaList.push({
        filename: filename, // Este agora é o ID único de cada aba
        reportId: type === 'powerbi' ? req.body.url : null,
        type: type,
        displayDuration: parseInt(req.body.displayDuration) || 15,
        expiresAt: req.body.expirationDateTime ? new Date(req.body.expirationDateTime).getTime() : null,
        pageName: type === 'powerbi' ? req.body.pageName : null
    });

    fs.writeFileSync(dataPath, JSON.stringify(mediaList, null, 2));
    io.emit(`mediaUpdate:${playerId}`);
    res.sendStatus(200);
});

// A rota de DELETE usa o filename (que agora é único por aba/página)
app.delete('/api/media/:id/:filename', (req, res) => {
    const dataPath = getMediaFilePath(req.params.id);
    let list = JSON.parse(fs.readFileSync(dataPath));
    
    // Remove apenas o item com o identificador específico (ex: RelatorioID_Secao1)
    list = list.filter(m => m.filename !== req.params.filename);
    
    fs.writeFileSync(dataPath, JSON.stringify(list, null, 2));
    io.emit(`mediaUpdate:${req.params.id}`);
    res.sendStatus(200);
});

app.post('/api/reorder/:id', (req, res) => {
    const dataPath = getMediaFilePath(req.params.id);
    const currentList = JSON.parse(fs.readFileSync(dataPath));
    const newList = req.body.orderedFilenames.map(f => currentList.find(m => m.filename === f)).filter(Boolean);
    fs.writeFileSync(dataPath, JSON.stringify(newList, null, 2));
    io.emit(`mediaUpdate:${req.params.id}`);
    res.sendStatus(200);
});

app.get('/api/media/:id', (req, res) => {
    const dataPath = getMediaFilePath(req.params.id);
    res.json(fs.existsSync(dataPath) ? JSON.parse(fs.readFileSync(dataPath)) : []);
});

app.delete('/api/media/:id/:filename', (req, res) => {
    const dataPath = getMediaFilePath(req.params.id);
    let list = JSON.parse(fs.readFileSync(dataPath));
    const item = list.find(m => m.filename === req.params.filename);
    
    if (item && item.type !== 'url' && item.type !== 'powerbi') {
        const fullPath = path.join(uploadDir, item.filename);
        if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
    }

    list = list.filter(m => m.filename !== req.params.filename);
    fs.writeFileSync(dataPath, JSON.stringify(list, null, 2));
    io.emit(`mediaUpdate:${req.params.id}`);
    res.sendStatus(200);
});

server.listen(3000, () => console.log('Servidor HTTPS Ativo na porta 3000'));
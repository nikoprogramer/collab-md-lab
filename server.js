const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");
const { setupWSConnection, setPersistence } = require("y-websocket/bin/utils");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const { rateLimit } = require("express-rate-limit");

const PORT = process.env.PORT || 3000;

// DATA_DIR points to a persistent volume on Railway (or __dirname locally)
const DATA_DIR = process.env.DATA_DIR || __dirname;
const FILES_DIR = path.join(DATA_DIR, "files");

if (!fs.existsSync(FILES_DIR)) {
  fs.mkdirSync(FILES_DIR, { recursive: true });
}

// ── SQLite – users & sessions ────────────────────────────────────

const db = new Database(path.join(__dirname, "users.db"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    username     TEXT    UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT   NOT NULL,
    created_at   TEXT    DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT    PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    username   TEXT    NOT NULL,
    created_at TEXT    DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

const sql = {
  insertUser:    db.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)"),
  findUser:      db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE"),
  insertSession: db.prepare("INSERT INTO sessions (token, user_id, username) VALUES (?, ?, ?)"),
  findSession:   db.prepare("SELECT username FROM sessions WHERE token = ?"),
  deleteSession: db.prepare("DELETE FROM sessions WHERE token = ?"),
};

function createSession(userId, username) {
  const token = crypto.randomUUID();
  sql.insertSession.run(token, userId, username);
  return token;
}

// ── Persistence (y-websocket) ────────────────────────────────────

const saveTimers = {};

setPersistence({
  bindState: (docName, doc) => {
    const filePath = path.resolve(FILES_DIR, docName);
    if (filePath.startsWith(FILES_DIR + path.sep) && fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf8");
      if (content) doc.getText("content").insert(0, content);
    }

    doc.on("update", () => {
      clearTimeout(saveTimers[docName]);
      saveTimers[docName] = setTimeout(() => {
        try {
          fs.writeFileSync(
            path.resolve(FILES_DIR, docName),
            doc.getText("content").toString(),
            "utf8",
          );
        } catch (err) {
          console.error(`[save] ${docName}:`, err.message);
        }
      }, 300);
    });
  },
  writeState: () => Promise.resolve(),
});

// ── Express ──────────────────────────────────────────────────────

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

if (process.env.NODE_ENV === "production") {
  app.use(express.static(path.join(__dirname, "dist")));
}

// ── Auth routes ──────────────────────────────────────────────────

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minut
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Zbyt wiele prób logowania. Spróbuj ponownie za 15 minut." },
});

app.post("/api/auth/register", authLimiter, (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: "Wymagana nazwa i hasło." });

  const trimmed = username.trim();
  if (trimmed.length < 3 || trimmed.length > 30)
    return res.status(400).json({ error: "Nazwa: 3–30 znaków." });
  if (!/^[\w\-]+$/.test(trimmed))
    return res.status(400).json({ error: "Nazwa: tylko litery, cyfry, _ i -." });
  if (password.length < 6)
    return res.status(400).json({ error: "Hasło: min. 6 znaków." });

  const hash = bcrypt.hashSync(password, 10);
  try {
    const result = sql.insertUser.run(trimmed, hash);
    const token = createSession(result.lastInsertRowid, trimmed);
    res.json({ token, username: trimmed });
  } catch (err) {
    if (err.message.includes("UNIQUE"))
      return res.status(409).json({ error: "Ta nazwa jest już zajęta." });
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/auth/login", authLimiter, (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: "Wymagana nazwa i hasło." });

  const user = sql.findUser.get(username.trim());
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: "Błędna nazwa użytkownika lub hasło." });

  const token = createSession(user.id, user.username);
  res.json({ token, username: user.username });
});

app.get("/api/auth/me", (req, res) => {
  const raw = req.headers.authorization || "";
  const token = raw.startsWith("Bearer ") ? raw.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Brak tokenu." });

  const session = sql.findSession.get(token);
  if (!session) return res.status(401).json({ error: "Nieważny lub wygasły token." });

  res.json({ username: session.username });
});

app.post("/api/auth/logout", (req, res) => {
  const raw = req.headers.authorization || "";
  const token = raw.startsWith("Bearer ") ? raw.slice(7) : null;
  if (token) sql.deleteSession.run(token);
  res.json({ ok: true });
});

// ── File routes ──────────────────────────────────────────────────

app.get("/api/files", (req, res) => {
  try {
    const files = fs
      .readdirSync(FILES_DIR)
      .filter((f) => f.endsWith(".md"))
      .sort();
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/files", (req, res) => {
  let { name } = req.body;
  if (!name || typeof name !== "string")
    return res.status(400).json({ error: "Nazwa jest wymagana" });

  name = name.replace(/[/\\:*?"<>|]/g, "").trim();
  if (!name.endsWith(".md")) name += ".md";
  if (name === ".md")
    return res.status(400).json({ error: "Nieprawidłowa nazwa" });

  const filePath = path.resolve(FILES_DIR, name);
  if (!filePath.startsWith(FILES_DIR + path.sep))
    return res.status(400).json({ error: "Nieprawidłowa nazwa" });
  if (fs.existsSync(filePath))
    return res.status(409).json({ error: "Plik już istnieje" });

  fs.writeFileSync(filePath, "", "utf8");
  res.json({ name });
});

app.delete("/api/files/:name", (req, res) => {
  const name = req.params.name;
  if (!name || !name.endsWith(".md") || name.includes("/") || name.includes("\\"))
    return res.status(400).json({ error: "Nieprawidłowa nazwa" });

  const filePath = path.resolve(FILES_DIR, name);
  if (!filePath.startsWith(FILES_DIR + path.sep))
    return res.status(400).json({ error: "Nieprawidłowa nazwa" });
  if (!fs.existsSync(filePath))
    return res.status(404).json({ error: "Plik nie istnieje" });

  try {
    fs.unlinkSync(filePath);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── HTTP + WebSocket server ──────────────────────────────────────

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  const docName = decodeURIComponent(req.url.slice(1).split("?")[0]);

  if (!docName || docName.includes("/") || !docName.endsWith(".md")) {
    ws.close(1003, "Invalid document name");
    return;
  }

  setupWSConnection(ws, req, { docName, gc: true });
});

server.listen(PORT, () => {
  console.log(`Serwer działa na http://localhost:${PORT}`);
  console.log(`Pliki trzymane w: ${FILES_DIR}`);
});

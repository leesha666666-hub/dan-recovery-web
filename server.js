// Dan Recovery — real-time social web platform server.
// Express + Socket.io. Single JSON-file DB with atomic writes.
// Real auth: scrypt-hashed passwords + Bearer session tokens (see README).

import express from "express";
import http from "http";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import multer from "multer";
import { Server } from "socket.io";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
// Cloud-ready: all persistent state lives under DATA_DIR (db.json + uploads/).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "db.json");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------------- JSON file DB (atomic writes) ----------------
// users: [{id, username, displayName, passHash, salt, bio, avatarUrl, createdAt}]
// sessions: [{token, userId, createdAt}]
// messages: [{id, from, to, text, createdAt}]
// posts: [{id, userId, username, text, photoUrl, channelId, createdAt}]
// friends: [{id, userId, friendId, createdAt}]
// channels: [{id, name, description, ownerId, createdAt}]
// channelMembers: [{channelId, userId, createdAt}]
// notifications: [{id, userId, type, fromName, text, createdAt, read}]
// matches: [{id, userA, userB, createdAt}] (userA < userB lexicographically)
const EMPTY_DB = () => ({
  users: [], sessions: [], messages: [], posts: [],
  friends: [], channels: [], channelMembers: [], notifications: [], matches: [],
});
let db = EMPTY_DB();

function loadDb() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
    const fresh = EMPTY_DB();
    for (const k of Object.keys(fresh)) fresh[k] = Array.isArray(parsed[k]) ? parsed[k] : [];
    db = fresh;
  } catch {
    db = EMPTY_DB();
  }
}

let writeChain = Promise.resolve();
// Serialize writes and write atomically (tmp file + rename) so a crash
// never leaves a half-written db.json.
function saveDb() {
  writeChain = writeChain.then(
    () =>
      new Promise((resolve, reject) => {
        const tmp = DB_PATH + ".tmp";
        fs.writeFile(tmp, JSON.stringify(db, null, 2), (err) => {
          if (err) return reject(err);
          fs.rename(tmp, DB_PATH, (err2) => (err2 ? reject(err2) : resolve()));
        });
      })
  );
  return writeChain;
}

const uid = () => crypto.randomBytes(8).toString("hex");
const nowIso = () => new Date().toISOString();
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}
function verifyPassword(password, salt, expectedHash) {
  try {
    const a = Buffer.from(expectedHash, "hex");
    const b = Buffer.from(hashPassword(password, salt), "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
const publicUser = (u) => ({
  id: u.id, username: u.username, displayName: u.displayName || u.username,
  bio: u.bio || "", avatarUrl: u.avatarUrl || null, createdAt: u.createdAt,
});

loadDb();

// ---------------- Express app ----------------
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(UPLOAD_DIR));

// ---- Signup ----
app.post("/api/signup", async (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");
  const displayName = String(req.body?.displayName || "").trim().slice(0, 40) || username;
  if (!USERNAME_RE.test(username))
    return res.status(400).json({ error: "username must be 3-20 chars: letters, numbers, underscore" });
  if (password.length < 6)
    return res.status(400).json({ error: "password must be at least 6 characters" });
  if (db.users.some((u) => u.username.toLowerCase() === username.toLowerCase()))
    return res.status(409).json({ error: "username already taken" });
  const salt = crypto.randomBytes(16).toString("hex");
  const user = {
    id: uid(), username, displayName,
    passHash: hashPassword(password, salt), salt,
    bio: "", avatarUrl: null, createdAt: nowIso(),
  };
  db.users.push(user);
  const token = crypto.randomBytes(32).toString("hex");
  db.sessions.push({ token, userId: user.id, createdAt: nowIso() });
  await saveDb();
  res.status(201).json({ token, user: publicUser(user) });
});

// ---- Login ----
app.post("/api/login", async (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");
  const user = db.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
  if (!user || !verifyPassword(password, user.salt, user.passHash))
    return res.status(401).json({ error: "invalid username or password" });
  const token = crypto.randomBytes(32).toString("hex");
  db.sessions.push({ token, userId: user.id, createdAt: nowIso() });
  await saveDb();
  res.json({ token, user: publicUser(user) });
});

// ---- Guest access: no sign-in needed, the app is open for all ----
app.post("/api/guest", async (req, res) => {
  let username;
  do {
    username = "guest_" + crypto.randomBytes(4).toString("hex");
  } while (db.users.some((u) => u.username === username));
  const n = 1000 + Math.floor(Math.random() * 9000);
  const user = {
    id: uid(), username, displayName: `Guest ${n}`,
    passHash: null, salt: null,
    bio: "", avatarUrl: null, createdAt: nowIso(), guest: true,
  };
  db.users.push(user);
  const token = crypto.randomBytes(32).toString("hex");
  db.sessions.push({ token, userId: user.id, createdAt: nowIso() });
  await saveDb();
  res.status(201).json({ token, user: publicUser(user) });
});

// ---- Auth guard: everything below except signup/login/guest needs Bearer token ----
function requireAuth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  const sess = db.sessions.find((s) => s.token === token);
  const user = sess && db.users.find((u) => u.id === sess.userId);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  req.user = user;
  next();
}
app.use("/api", (req, res, next) => {
  if (req.method === "POST" && (req.path === "/signup" || req.path === "/login" || req.path === "/guest")) return next();
  requireAuth(req, res, next);
});

app.post("/api/logout", async (req, res) => {
  const token = (req.headers.authorization || "").slice(7);
  db.sessions = db.sessions.filter((s) => s.token !== token);
  await saveDb();
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => res.json(publicUser(req.user)));

// ---- Matches (mutual friends) ----
app.get("/api/matches", (req, res) => {
  res.json(
    db.matches
      .filter((m) => m.userA === req.user.id || m.userB === req.user.id)
      .map((m) => {
        const otherId = m.userA === req.user.id ? m.userB : m.userA;
        const u = db.users.find((x) => x.id === otherId);
        if (!u) return null;
        return { id: m.id, matchedAt: m.createdAt, ...publicUser(u), online: online.has(u.id) };
      })
      .filter(Boolean)
      .sort((a, b) => b.matchedAt.localeCompare(a.matchedAt))
  );
});

// ---- Discover: all users (for the Discover screen) ----
app.get("/api/users", (req, res) => {
  res.json(
    db.users
      .filter((u) => u.id !== req.user.id)
      .slice(0, 50)
      .map((u) => ({ ...publicUser(u), online: online.has(u.id) }))
  );
});

// ---- User search ----
app.get("/api/users/search", (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  if (!q) return res.json([]);
  res.json(
    db.users
      .filter((u) => u.id !== req.user.id &&
        (u.username.toLowerCase().includes(q) || (u.displayName || "").toLowerCase().includes(q)))
      .slice(0, 20)
      .map((u) => ({ ...publicUser(u), online: online.has(u.id) }))
  );
});

// ---- Friends ----
app.post("/api/friends", async (req, res) => {
  const username = String(req.body?.username || "").trim();
  const other = db.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
  if (!other) return res.status(404).json({ error: "user not found" });
  if (other.id === req.user.id) return res.status(400).json({ error: "cannot add yourself" });
  if (db.friends.some((f) => f.userId === req.user.id && f.friendId === other.id))
    return res.status(409).json({ error: "already friends" });
  const rel = { id: uid(), userId: req.user.id, friendId: other.id, createdAt: nowIso() };
  db.friends.push(rel);
  // Mutual-friend matching: if they already added me, it's a match.
  const reverse = db.friends.find((f) => f.userId === other.id && f.friendId === req.user.id);
  const [userA, userB] = [req.user.id, other.id].sort();
  let matched = false;
  if (reverse && !db.matches.some((m) => m.userA === userA && m.userB === userB)) {
    const match = { id: uid(), userA, userB, createdAt: nowIso() };
    db.matches.push(match);
    matched = true;
    const meName = req.user.displayName || req.user.username;
    const otherName = other.displayName || other.username;
    await pushNotification(other.id, { type: "match", fromName: meName, text: "You have a new match!" });
    await pushNotification(req.user.id, { type: "match", fromName: otherName, text: "You have a new match!" });
    const sA = online.get(req.user.id);
    const sB = online.get(other.id);
    if (sA) sA.emit("match:new", { with: other.id, withName: otherName });
    if (sB) sB.emit("match:new", { with: req.user.id, withName: meName });
  }
  await saveDb();
  res.status(201).json({ id: rel.id, ...publicUser(other), online: online.has(other.id), matched });
});

app.get("/api/friends", (req, res) => {
  res.json(
    db.friends
      .filter((f) => f.userId === req.user.id)
      .map((f) => db.users.find((u) => u.id === f.friendId))
      .filter(Boolean)
      .map((u) => ({ ...publicUser(u), online: online.has(u.id) }))
  );
});

app.delete("/api/friends/:id", async (req, res) => {
  const before = db.friends.length;
  db.friends = db.friends.filter(
    (f) => !(f.userId === req.user.id && f.friendId === req.params.id)
  );
  if (db.friends.length === before) return res.status(404).json({ error: "not a friend" });
  await saveDb();
  res.json({ ok: true });
});

// ---- Channels ----
const channelView = (c, meId) => ({
  id: c.id, name: c.name, description: c.description || "",
  ownerId: c.ownerId, createdAt: c.createdAt,
  memberCount: db.channelMembers.filter((m) => m.channelId === c.id).length,
  joined: db.channelMembers.some((m) => m.channelId === c.id && m.userId === meId),
});

app.post("/api/channels", async (req, res) => {
  const name = String(req.body?.name || "").trim().slice(0, 60);
  const description = String(req.body?.description || "").trim().slice(0, 300);
  if (!name) return res.status(400).json({ error: "channel name required" });
  const c = { id: uid(), name, description, ownerId: req.user.id, createdAt: nowIso() };
  db.channels.push(c);
  db.channelMembers.push({ channelId: c.id, userId: req.user.id, createdAt: nowIso() });
  await saveDb();
  res.status(201).json(channelView(c, req.user.id));
});

app.get("/api/channels", (req, res) => {
  res.json(db.channels.map((c) => channelView(c, req.user.id)));
});

function isMember(channelId, userId) {
  return db.channelMembers.some((m) => m.channelId === channelId && m.userId === userId);
}

app.post("/api/channels/:id/join", async (req, res) => {
  const c = db.channels.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "channel not found" });
  if (!isMember(c.id, req.user.id)) {
    db.channelMembers.push({ channelId: c.id, userId: req.user.id, createdAt: nowIso() });
    await saveDb();
  }
  res.json(channelView(c, req.user.id));
});

app.post("/api/channels/:id/leave", async (req, res) => {
  db.channelMembers = db.channelMembers.filter(
    (m) => !(m.channelId === req.params.id && m.userId === req.user.id)
  );
  await saveDb();
  const c = db.channels.find((x) => x.id === req.params.id);
  res.json(c ? channelView(c, req.user.id) : { ok: true });
});

app.get("/api/channels/:id/posts", (req, res) => {
  const c = db.channels.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: "channel not found" });
  if (!isMember(c.id, req.user.id)) return res.status(403).json({ error: "join the channel first" });
  res.json(
    db.posts.filter((p) => p.channelId === c.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  );
});

// ---- Feed: global posts are ones with no channelId ----
app.get("/api/posts", (req, res) => {
  res.json(
    db.posts.filter((p) => !p.channelId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  );
});

// ---- Photo upload: safe unique names, image-only, ~5MB cap ----
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = (path.extname(file.originalname || "").toLowerCase() || "").slice(0, 8);
    const safeExt = [".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext) ? ext : ".png";
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${safeExt}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_PHOTO_BYTES },
  fileFilter: (_req, file, cb) =>
    file.mimetype.startsWith("image/") ? cb(null, true) : cb(new Error("only image files allowed")),
});

app.post("/api/posts", upload.single("photo"), async (req, res) => {
  const text = String(req.body?.text || "").trim().slice(0, 2000);
  const channelId = req.body?.channelId ? String(req.body.channelId) : null;
  if (channelId) {
    const c = db.channels.find((x) => x.id === channelId);
    if (!c) { if (req.file) fs.unlink(req.file.path, () => {}); return res.status(404).json({ error: "channel not found" }); }
    if (!isMember(channelId, req.user.id)) { if (req.file) fs.unlink(req.file.path, () => {}); return res.status(403).json({ error: "join the channel first" }); }
  }
  if (!text && !req.file) return res.status(400).json({ error: "post needs text or a photo" });
  const post = {
    id: uid(), userId: req.user.id, username: req.user.username,
    displayName: req.user.displayName || req.user.username,
    text, photoUrl: req.file ? `/uploads/${req.file.filename}` : null,
    channelId, createdAt: nowIso(),
  };
  db.posts.push(post);
  await saveDb();
  res.status(201).json(post);
});

// ---- Notifications ----
async function pushNotification(userId, { type, fromName, text }) {
  const n = { id: uid(), userId, type, fromName, text: text || "", createdAt: nowIso(), read: false };
  db.notifications.push(n);
  await saveDb();
  const s = online.get(userId);
  if (s) s.emit("notification", n); // live badge update if they're online
  return n;
}

app.get("/api/notifications", (req, res) => {
  res.json(
    db.notifications.filter((n) => n.userId === req.user.id)
      .sort((a, b) => (a.read - b.read) || b.createdAt.localeCompare(a.createdAt))
  );
});

app.post("/api/notifications/read", async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : null;
  db.notifications.forEach((n) => {
    if (n.userId === req.user.id && (!ids || ids.includes(n.id))) n.read = true;
  });
  await saveDb();
  res.json({ ok: true });
});

// ---- Profile ----
app.get("/api/profile", (req, res) => res.json(publicUser(req.user)));

app.patch("/api/profile", async (req, res) => {
  if (req.body?.displayName !== undefined)
    req.user.displayName = String(req.body.displayName).trim().slice(0, 40) || req.user.username;
  if (req.body?.bio !== undefined)
    req.user.bio = String(req.body.bio).trim().slice(0, 300);
  await saveDb();
  res.json(publicUser(req.user));
});

app.post("/api/profile/avatar", upload.single("avatar"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "no image uploaded" });
  if (req.user.avatarUrl) {
    const old = path.join(UPLOAD_DIR, path.basename(req.user.avatarUrl));
    fs.unlink(old, () => {});
  }
  req.user.avatarUrl = `/uploads/${req.file.filename}`;
  await saveDb();
  res.json(publicUser(req.user));
});

// Multer errors -> clean JSON 400s
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err) return res.status(400).json({ error: err.message || "upload failed" });
  res.status(500).json({ error: "server error" });
});

// ---------------- Socket.io: presence, chat, call signaling ----------------
// Auth: connect with handshake auth {token}. Invalid token -> connection refused.
const online = new Map(); // userId -> socket
const activePeer = new Map(); // userId -> other userId currently in a call with them

function broadcastPresence() {
  io.emit("presence", [...online.entries()].map(([id, s]) => ({
    id, username: s.data.username, displayName: s.data.displayName,
  })));
}

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  const sess = db.sessions.find((s) => s.token === token);
  const user = sess && db.users.find((u) => u.id === sess.userId);
  if (!user) return next(new Error("invalid token"));
  socket.data.userId = user.id;
  socket.data.username = user.username;
  socket.data.displayName = user.displayName || user.username;
  next();
});

io.on("connection", (socket) => {
  const me = socket.data.userId;

  // One socket per user: drop any stale older socket for the same user.
  const stale = online.get(me);
  if (stale && stale.id !== socket.id) stale.disconnect(true);
  online.set(me, socket);
  broadcastPresence();

  // ---- Real-time chat: persist then deliver; offline recipient -> notification ----
  socket.on("chat:send", async ({ to, text }) => {
    const clean = String(text || "").trim().slice(0, 4000);
    const peer = db.users.find((u) => u.id === String(to));
    if (!peer || !clean) return;
    const msg = { id: uid(), from: me, to: peer.id, text: clean, createdAt: nowIso() };
    db.messages.push(msg);
    const peerSocket = online.get(peer.id);
    if (peerSocket) {
      peerSocket.emit("chat:recv", {
        from: me, fromName: socket.data.displayName, text: msg.text, createdAt: msg.createdAt,
      });
    } else {
      await pushNotification(peer.id, { type: "message", fromName: socket.data.displayName, text: clean });
    }
    await saveDb();
    socket.emit("chat:sent", { id: msg.id, to: peer.id, createdAt: msg.createdAt });
  });

  // ---- Chat history via ack callback: survives server restarts ----
  socket.on("chat:history", ({ with: otherId }, callback) => {
    const other = String(otherId || "");
    const history = db.messages
      .filter((m) => (m.from === me && m.to === other) || (m.from === other && m.to === me))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-100);
    if (typeof callback === "function") callback(history);
  });

  // ---- WebRTC signaling relay ----
  socket.on("call:offer", async ({ to, sdp, kind }) => {
    const peerSocket = online.get(String(to));
    if (!peerSocket) {
      await pushNotification(String(to), { type: "call", fromName: socket.data.displayName, text: `${kind} call missed` });
      await saveDb();
      socket.emit("call:rejected", { to: String(to), reason: "offline" });
      return;
    }
    activePeer.set(me, String(to));
    activePeer.set(String(to), me);
    peerSocket.emit("call:incoming", {
      from: me, fromName: socket.data.displayName, sdp, kind: kind === "video" ? "video" : "audio",
    });
  });

  socket.on("call:answer", ({ to, sdp }) => {
    const peerSocket = online.get(String(to));
    if (peerSocket) peerSocket.emit("call:answered", { from: me, sdp });
  });

  socket.on("call:ice", ({ to, candidate }) => {
    const peerSocket = online.get(String(to));
    if (peerSocket) peerSocket.emit("call:ice", { from: me, candidate });
  });

  socket.on("call:reject", ({ to }) => {
    activePeer.delete(me);
    activePeer.delete(String(to));
    const peerSocket = online.get(String(to));
    if (peerSocket) peerSocket.emit("call:rejected", { from: me });
  });

  socket.on("call:end", ({ to }) => {
    activePeer.delete(me);
    if (to) activePeer.delete(String(to));
    const peerSocket = to ? online.get(String(to)) : null;
    if (peerSocket) peerSocket.emit("call:ended", { from: me });
  });

  socket.on("disconnect", () => {
    if (online.get(me) === socket) online.delete(me);
    const peerId = activePeer.get(me);
    activePeer.delete(me);
    if (peerId) {
      activePeer.delete(peerId);
      const peerSocket = online.get(peerId);
      if (peerSocket) peerSocket.emit("call:ended", { from: me });
    }
    broadcastPresence();
  });
});

server.listen(PORT, () => {
  console.log(`Dan Recovery web platform running on http://localhost:${PORT}`);
});

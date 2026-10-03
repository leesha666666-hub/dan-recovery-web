// Dan Recovery end-to-end tests. Run: npm test
// Real server on a test port, real socket.io clients + HTTP. Covers:
// auth (signup/login/logout, failures), presence, chat + history + restart
// persistence, posts + photo posts, WebRTC signaling (offer/answer/ICE/reject/
// end/disconnect/offline), friends, mutual matching, search, channels,
// notifications, profile + avatar. Exits 0 only if EVERY check passes.
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { io } from "socket.io-client";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PORT = 3457;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "danrec-test-"));
const DATA_DIR = path.join(TMP, "data");

let failures = 0, passes = 0;
function check(name, cond, extra = "") {
  if (cond) { console.log(`PASS: ${name}`); passes++; }
  else { console.log(`FAIL: ${name}${extra ? " — " + extra : ""}`); failures++; }
}
const waitFor = (fn, timeout = 10000, label = "condition") =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      let ok = false;
      try { ok = fn(); } catch {}
      if (ok) { clearInterval(timer); resolve(); }
      else if (Date.now() - t0 > timeout) { clearInterval(timer); reject(new Error("timeout: " + label)); }
    }, 100);
  });
const once = (sock, ev, timeout = 10000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout waiting for " + ev)), timeout);
    sock.once(ev, (d) => { clearTimeout(t); resolve(d); });
  });

function startServer() {
  return spawn("node", ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
async function waitReady(child) {
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start")), 15000);
    child.stdout.on("data", (d) => { if (String(d).includes("running")) { clearTimeout(t); resolve(); } });
    child.on("exit", (c) => { clearTimeout(t); reject(new Error("server exited: " + c)); });
  });
}
const stopServer = (child) =>
  new Promise((resolve) => { child.on("exit", () => resolve()); child.kill("SIGTERM"); });

// REST helper with optional Bearer token
async function api(method, p, { token, body, form } = {}) {
  const headers = {};
  if (token) headers["Authorization"] = "Bearer " + token;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  const r = await fetch(BASE + p, { method, headers, body: payload });
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}
const sock = (token) => io(BASE, { auth: { token } });

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

let server = startServer();
try {
  await waitReady(server);
  const t = Date.now();

  // ===== 1-5. AUTH =====
  const sA = await api("POST", "/api/signup", { body: { username: "alice_e2e", password: "secret123", displayName: "Alice" } });
  const sB = await api("POST", "/api/signup", { body: { username: "bob_e2e", password: "secret123", displayName: "Bob" } });
  const sC = await api("POST", "/api/signup", { body: { username: "carol_e2e", password: "secret123" } });
  check("signup returns 201 + token", [sA, sB, sC].every((r) => r.status === 201 && r.body.token));
  const tokA = sA.body.token, tokB = sB.body.token, tokC = sC.body.token;
  const A = sA.body.user, B = sB.body.user;

  const dup = await api("POST", "/api/signup", { body: { username: "ALICE_e2e", password: "secret123" } });
  check("duplicate signup -> 409", dup.status === 409);
  const badPw = await api("POST", "/api/login", { body: { username: "alice_e2e", password: "wrong" } });
  check("wrong-password login -> 401", badPw.status === 401);
  const goodLogin = await api("POST", "/api/login", { body: { username: "alice_e2e", password: "secret123" } });
  check("correct login -> 200 + token", goodLogin.status === 200 && !!goodLogin.body.token);
  const noAuth = await api("GET", "/api/posts");
  check("unauthenticated REST -> 401", noAuth.status === 401);
  const badSock = sock("bad-token");
  const sockErr = await once(badSock, "connect_error").catch(() => null);
  check("socket with bad token rejected", !!sockErr);
  badSock.disconnect();

  // ===== 6. PRESENCE =====
  const sockA = sock(tokA), sockB = sock(tokB);
  const seenA = [], seenB = [];
  sockA.on("presence", (u) => seenA.push(u));
  sockB.on("presence", (u) => seenB.push(u));
  await waitFor(() => sockA.connected && sockB.connected, 10000, "sockets connect");
  await waitFor(() => seenA.some((u) => u.some((x) => x.id === B.id)), 10000, "A sees B");
  await waitFor(() => seenB.some((u) => u.some((x) => x.id === A.id)), 10000, "B sees A");
  check("presence: A sees B online and B sees A online", true);
  sockB.disconnect();
  await waitFor(() => seenA.some((u) => !u.some((x) => x.id === B.id)), 10000, "A sees B offline");
  check("presence: offline accuracy after disconnect", true);

  // ===== 7-9. CHAT + HISTORY + RESTART =====
  const sockB2 = sock(tokB);
  await waitFor(() => sockB2.connected, 10000, "B reconnect");
  const TEXT = "hello bob " + t;
  const recvP = once(sockB2, "chat:recv");
  const sentP = once(sockA, "chat:sent");
  sockA.emit("chat:send", { to: B.id, text: TEXT });
  const recv = await recvP; await sentP;
  check("chat: B receives exact text", recv.text === TEXT && recv.from === A.id);
  const hist = (s, id) => new Promise((res) => s.emit("chat:history", { with: id }, (m) => res(m)));
  const h1 = await hist(sockA, B.id);
  check("chat:history returns the message", h1.some((m) => m.text === TEXT));
  sockA.disconnect(); sockB2.disconnect();
  await stopServer(server);
  server = startServer(); await waitReady(server);
  const sockA2 = sock(tokA);
  await waitFor(() => sockA2.connected, 10000, "reconnect after restart");
  const h2 = await hist(sockA2, B.id);
  check("history survives server restart", h2.some((m) => m.text === TEXT));

  // ===== 10-12. POSTS + PHOTO =====
  const f1 = new FormData(); f1.append("text", "post " + t);
  const pr = await api("POST", "/api/posts", { token: tokA, form: f1 });
  check("text post created (201)", pr.status === 201);
  const f2 = new FormData();
  f2.append("text", "photo " + t);
  f2.append("photo", new Blob([PNG], { type: "image/png" }), "red.png");
  const pr2 = await api("POST", "/api/posts", { token: tokA, form: f2 });
  check("photo post created with photoUrl", pr2.status === 201 && !!pr2.body.photoUrl);
  const feed = (await api("GET", "/api/posts", { token: tokB })).body;
  check("feed visible to B, newest-first, photo renders", feed.length >= 2 &&
    feed[0].createdAt >= feed[1].createdAt && feed.some((p) => p.photoUrl));
  const files = fs.readdirSync(path.join(DATA_DIR, "uploads"));
  const img = await fetch(BASE + pr2.body.photoUrl);
  check("photo file stored + served as image", files.some((x) => x.endsWith(".png")) &&
    img.status === 200 && (img.headers.get("content-type") || "").startsWith("image/"));

  // ===== 13-19. SIGNALING =====
  const sockB3 = sock(tokB);
  await waitFor(() => sockB3.connected, 10000, "B online again");
  const FAKE = { type: "offer", sdp: "x" };
  let inc = once(sockB3, "call:incoming");
  sockA2.emit("call:offer", { to: B.id, sdp: FAKE, kind: "video" });
  inc = await inc;
  check("offer -> incoming (video)", inc.kind === "video" && inc.from === A.id);
  const ansP = once(sockA2, "call:answered");
  sockB3.emit("call:answer", { to: A.id, sdp: { type: "answer", sdp: "y" } });
  check("answer -> answered", (await ansP).from === B.id);
  const iceBP = once(sockB3, "call:ice");
  sockA2.emit("call:ice", { to: B.id, candidate: { candidate: "a" } });
  const iceAP = once(sockA2, "call:ice");
  sockB3.emit("call:ice", { to: A.id, candidate: { candidate: "b" } });
  check("ICE A->B and B->A relay", (await iceBP).candidate.candidate === "a" && (await iceAP).candidate.candidate === "b");

  // reject flow
  let inc2 = once(sockB3, "call:incoming");
  sockA2.emit("call:offer", { to: B.id, sdp: FAKE, kind: "audio" });
  await inc2;
  const rejP = once(sockA2, "call:rejected");
  sockB3.emit("call:reject", { to: A.id });
  check("reject flow: caller gets call:rejected", (await rejP).from === B.id);

  // end flow
  let inc3 = once(sockB3, "call:incoming");
  sockA2.emit("call:offer", { to: B.id, sdp: FAKE, kind: "audio" });
  await inc3;
  const ansP2 = once(sockA2, "call:answered");
  sockB3.emit("call:answer", { to: A.id, sdp: { type: "answer", sdp: "y" } });
  await ansP2;
  const endP = once(sockB3, "call:ended");
  sockA2.emit("call:end", { to: B.id });
  check("end flow: peer gets call:ended", (await endP).from === A.id);

  // disconnect mid-call notifies peer
  let inc4 = once(sockB3, "call:incoming");
  sockA2.emit("call:offer", { to: B.id, sdp: FAKE, kind: "audio" });
  await inc4;
  const ansP3 = once(sockA2, "call:answered");
  sockB3.emit("call:answer", { to: A.id, sdp: { type: "answer", sdp: "y" } });
  await ansP3;
  const endP2 = once(sockB3, "call:ended");
  sockA2.disconnect();
  check("disconnect mid-call -> peer notified", (await endP2).from === A.id);
  const sockA3 = sock(tokA);
  await waitFor(() => sockA3.connected, 10000, "A reconnect");

  // offline callee -> rejected + notification stored
  sockB3.disconnect();
  await new Promise((r) => setTimeout(r, 400)); // let presence settle
  const rejOff = once(sockA3, "call:rejected");
  sockA3.emit("call:offer", { to: B.id, sdp: FAKE, kind: "audio" });
  const rejO = await rejOff;
  check("offline callee -> rejected(reason=offline)", rejO.reason === "offline");

  // offline chat -> notification stored
  sockA3.emit("chat:send", { to: B.id, text: "missed msg " + t });
  await new Promise((r) => setTimeout(r, 600)); // let server persist
  const notifs = (await api("GET", "/api/notifications", { token: tokB })).body;
  const types = notifs.map((n) => n.type);
  check("offline message+call -> notifications stored", types.includes("message") && types.includes("call"));
  check("notifications unread-first", notifs[0].read === false);
  const rd = await api("POST", "/api/notifications/read", { token: tokB, body: {} });
  const notifs2 = (await api("GET", "/api/notifications", { token: tokB })).body;
  check("mark-read works", rd.status === 200 && notifs2.every((n) => n.read));

  // ===== 20-22. FRIENDS + MATCHING =====
  const sockB4 = sock(tokB);
  await waitFor(() => sockB4.connected, 10000, "B online for match");
  const mA = once(sockA3, "match:new"), mB = once(sockB4, "match:new");
  const add1 = await api("POST", "/api/friends", { token: tokA, body: { username: "bob_e2e" } });
  check("A adds B: 201, no match yet", add1.status === 201 && add1.body.matched === false);
  const add2 = await api("POST", "/api/friends", { token: tokB, body: { username: "alice_e2e" } });
  check("B adds A: mutual -> matched", add2.status === 201 && add2.body.matched === true);
  const [evA, evB] = [await mA, await mB];
  check("match:new emitted to BOTH", evA.with === B.id && evB.with === A.id);
  const matchesA = (await api("GET", "/api/matches", { token: tokA })).body;
  const matchesB = (await api("GET", "/api/matches", { token: tokB })).body;
  check("GET /api/matches: 1 each with online flag", matchesA.length === 1 && matchesB.length === 1 &&
    matchesA[0].online === true);
  const dupF = await api("POST", "/api/friends", { token: tokA, body: { username: "bob_e2e" } });
  check("duplicate friend add -> 409", dupF.status === 409);
  const C = sC.body.user;
  const addC = await api("POST", "/api/friends", { token: tokA, body: { username: "carol_e2e" } });
  const delC = await api("DELETE", `/api/friends/${C.id}`, { token: tokA });
  const fl = (await api("GET", "/api/friends", { token: tokA })).body;
  check("friend remove works", addC.status === 201 && delC.status === 200 && fl.every((f) => f.id !== C.id));

  // ===== 23. SEARCH =====
  const sr = (await api("GET", "/api/users/search?q=ali", { token: tokB })).body;
  check("user search finds alice", sr.some((u) => u.username === "alice_e2e"));
  const disc = (await api("GET", "/api/users", { token: tokB })).body;
  check("discover lists users", disc.some((u) => u.username === "alice_e2e"));

  // ===== 24-25. CHANNELS =====
  const ch = await api("POST", "/api/channels", { token: tokA, body: { name: "general", description: "main" } });
  check("channel created", ch.status === 201 && ch.body.memberCount === 1 && ch.body.joined === true);
  const chId = ch.body.id;
  const jn = await api("POST", `/api/channels/${chId}/join`, { token: tokB });
  check("B joins channel", jn.status === 200 && jn.body.memberCount === 2 && jn.body.joined === true);
  const cf = new FormData(); cf.append("text", "channel post " + t); cf.append("channelId", chId);
  const cp = await api("POST", "/api/posts", { token: tokB, form: cf });
  const chPosts = (await api("GET", `/api/channels/${chId}/posts`, { token: tokA })).body;
  check("channel post + channel feed", cp.status === 201 && chPosts.some((p) => p.text === "channel post " + t));
  const lv = await api("POST", `/api/channels/${chId}/leave`, { token: tokB });
  check("B leaves channel", lv.status === 200 && lv.body.joined === false);

  // ===== 26-27. PROFILE + AVATAR =====
  const prof = (await api("GET", "/api/profile", { token: tokA })).body;
  check("GET /api/profile", prof.username === "alice_e2e");
  const pat = await api("PATCH", "/api/profile", { token: tokA, body: { displayName: "Alice R", bio: "hello" } });
  check("PATCH /api/profile", pat.status === 200 && pat.body.displayName === "Alice R" && pat.body.bio === "hello");
  const af = new FormData();
  af.append("avatar", new Blob([PNG], { type: "image/png" }), "av.png");
  const av = await api("POST", "/api/profile/avatar", { token: tokA, form: af });
  const avGet = await fetch(BASE + av.body.avatarUrl);
  check("avatar upload + served", av.status === 200 && !!av.body.avatarUrl && avGet.status === 200 &&
    (avGet.headers.get("content-type") || "").startsWith("image/"));

  // ===== 28. LOGOUT =====
  const lo = await api("POST", "/api/logout", { token: tokA });
  const afterLo = await api("GET", "/api/me", { token: tokA });
  check("logout invalidates token", lo.status === 200 && afterLo.status === 401);

  sockA3.disconnect(); sockB4.disconnect();
} catch (e) {
  console.log("FAIL: unexpected error —", e.message);
  failures++;
} finally {
  try { await stopServer(server); } catch {}
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(failures === 0 ? `\nALL TESTS PASSED (${passes} checks)` : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

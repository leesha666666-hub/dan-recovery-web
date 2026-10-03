// Dan Recovery web client: auth, presence, friends, matches, discover, channels,
// real-time chat, WebRTC voice/video calls, notifications, profile, feed.
// Two-tap UX: tap a person once -> quick-action panel opens; tap Chat/Audio/Video -> action starts.
"use strict";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const state = {
  me: null, token: null, socket: null,
  onlineUsers: [], friends: [], matches: [], channels: [], discover: [],
  chatWith: null, chatWithName: "",
  channel: null, // {id, name, description} or null = global feed
  sideTab: "online",
  pc: null, localStream: null, callPeer: null, callKind: null,
  incomingOffer: null, muted: false,
};

const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

// ---------------- API helper (Bearer token) ----------------
async function api(path, { method = "GET", body, form } = {}) {
  const headers = {};
  if (state.token) headers["Authorization"] = "Bearer " + state.token;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await fetch(path, { method, headers, body: payload });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

// ---------------- Session (guest mode) ----------------
// No sign-in screen: the app is open for all. Guests are created silently.
async function enterApp(token, user) {
  state.token = token;
  state.me = user;
  localStorage.setItem("dr_token", token);
  $("app-screen").classList.remove("hidden");
  renderMe();
  connectSocket();
  await refreshAll();
  setInterval(refreshNotifications, 20000);
}

// Guest mode: logout just rotates to a fresh guest identity.
async function logout() {
  try { await api("/api/logout", { method: "POST" }); } catch {}
  if (state.socket) state.socket.disconnect();
  localStorage.removeItem("dr_token");
  location.reload();
}
$("logout-btn").addEventListener("click", logout);

// Open for all: reuse the saved guest token, otherwise become a guest silently.
(async function init() {
  const token = localStorage.getItem("dr_token");
  if (token) {
    state.token = token;
    const { status, data } = await api("/api/me");
    if (status === 200) return enterApp(token, data);
    state.token = null;
    localStorage.removeItem("dr_token");
  }
  const { status, data } = await api("/api/guest", { method: "POST" });
  if (status === 201) enterApp(data.token, data.user);
  else document.body.innerHTML = "<p style='padding:2rem;font-family:sans-serif'>Could not start. Please reload.</p>";
})();

function renderMe() {
  const name = state.me.displayName || state.me.username;
  $("me-name").textContent = name;
  const letter = $("me-avatar-letter");
  const img = $("me-avatar");
  if (state.me.avatarUrl) {
    img.src = state.me.avatarUrl; img.classList.remove("hidden"); letter.classList.add("hidden");
  } else {
    img.classList.add("hidden"); letter.classList.remove("hidden");
    letter.textContent = name[0].toUpperCase();
  }
}

// ---------------- Socket ----------------
function connectSocket() {
  state.socket = io({ auth: { token: state.token } });
  const s = state.socket;
  s.on("connect", () => { $("conn-dot").className = "dot online"; });
  s.on("disconnect", () => { $("conn-dot").className = "dot offline"; });
  s.on("connect_error", () => { /* bad token: force re-login */ logout(); });

  s.on("presence", (users) => {
    state.onlineUsers = users.filter((u) => u.id !== state.me.id);
    renderOnline(); renderMatches(); renderDiscover();
  });

  s.on("chat:recv", (msg) => {
    if (state.chatWith === msg.from) appendBubble(msg.text, false, msg.createdAt);
    else {
      const badge = document.querySelector(`#user-list li[data-id="${CSS.escape(msg.from)}"] .unread`);
      if (badge) { badge.textContent = String((parseInt(badge.textContent || "0", 10) || 0) + 1); badge.classList.remove("hidden"); }
    }
  });

  s.on("notification", () => refreshNotifications());

  s.on("match:new", ({ withName }) => {
    refreshMatches();
    toast(`🎉 You matched with ${withName}!`);
  });

  s.on("call:incoming", ({ from, fromName, sdp, kind }) => {
    if (state.pc) { s.emit("call:reject", { to: from }); return; }
    state.incomingOffer = { from, sdp, kind };
    $("incoming-title").textContent = `Incoming ${kind} call`;
    $("incoming-sub").textContent = `${fromName} is calling you…`;
    $("incoming-modal").classList.remove("hidden");
  });
  s.on("call:answered", async ({ sdp }) => {
    if (!state.pc) return;
    await state.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    $("call-status").textContent = "Connected";
  });
  s.on("call:ice", async ({ candidate }) => {
    try { if (state.pc && candidate) await state.pc.addIceCandidate(new RTCIceCandidate(candidate)); }
    catch (e) { console.warn("ICE add failed", e); }
  });
  s.on("call:rejected", ({ reason } = {}) => {
    cleanupCall();
    if (reason === "offline") toast("That user is offline — they got a missed-call notification.");
    else toast("Call declined.");
  });
  s.on("call:ended", () => { cleanupCall(); toast("Call ended."); });
}

function toast(text) {
  const m = $("composer-msg");
  m.textContent = text; m.className = "msg ok";
  setTimeout(() => { if (m.textContent === text) m.textContent = ""; }, 4000);
}

// ---------------- Sidebar tabs ----------------
document.querySelectorAll(".side-tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    state.sideTab = btn.dataset.tab;
    document.querySelectorAll(".side-tab").forEach((b) => b.classList.toggle("active", b === btn));
    ["online", "friends", "matches", "channels", "discover"].forEach((t) =>
      $("tabpane-" + t).classList.toggle("hidden", t !== state.sideTab));
    if (state.sideTab === "friends") { loadFriends(); }
    if (state.sideTab === "matches") refreshMatches();
    if (state.sideTab === "channels") loadChannels();
    if (state.sideTab === "discover") loadDiscover();
  });
});

// ---------------- Person rows with two-tap quick actions ----------------
// Tap 1: row expands -> quick-action panel. Tap 2: Chat / Audio / Video starts.
function personRow(u, { showAdd = false, showRemove = false } = {}) {
  const li = document.createElement("li");
  li.className = "urow";
  li.dataset.id = u.id;
  const name = u.displayName || u.username;
  const av = u.avatarUrl
    ? `<img class="avatar-img" src="${esc(u.avatarUrl)}" alt="">`
    : `<span class="avatar">${esc(name[0].toUpperCase())}</span>`;
  li.innerHTML = `
    <div class="urow-main">
      ${av}
      <span class="urow-name">${esc(name)}<small>@${esc(u.username)}</small></span>
      <span class="dot ${u.online ? "online" : "offline"}"></span>
      ${showAdd ? `<button class="btn-mini">+ Add</button>` : ""}
      ${showRemove ? `<button class="btn-mini danger">✕</button>` : ""}
      <span class="unread pill hidden" style="margin-left:auto"></span>
    </div>
    <div class="quick-actions hidden">
      <button class="qa-btn" data-act="chat">💬 Chat</button>
      <button class="qa-btn" data-act="audio">📞 Audio</button>
      <button class="qa-btn" data-act="video">🎥 Video</button>
    </div>`;
  const main = li.querySelector(".urow-main");
  const qa = li.querySelector(".quick-actions");
  main.addEventListener("click", (e) => {
    if (e.target.closest(".btn-mini")) return; // let add/remove buttons work
    // collapse any other open panel (one panel at a time)
    document.querySelectorAll(".quick-actions").forEach((q) => { if (q !== qa) q.classList.add("hidden"); });
    qa.classList.toggle("hidden");
  });
  qa.querySelector('[data-act="chat"]').addEventListener("click", () => openChat(u.id, name));
  qa.querySelector('[data-act="audio"]').addEventListener("click", () => startCall("audio", u.id));
  qa.querySelector('[data-act="video"]').addEventListener("click", () => startCall("video", u.id));
  if (showAdd) li.querySelector(".btn-mini:not(.danger)").addEventListener("click", (e) => {
    e.stopPropagation(); addFriend(u.username);
  });
  if (showRemove) li.querySelector(".btn-mini.danger").addEventListener("click", (e) => {
    e.stopPropagation(); removeFriend(u.id);
  });
  return li;
}

// ---------------- Online / Friends / Matches / Discover ----------------
function renderOnline() {
  const ul = $("user-list");
  ul.innerHTML = "";
  state.onlineUsers.forEach((u) => ul.appendChild(personRow(u)));
}

async function loadFriends() {
  const { data } = await api("/api/friends");
  state.friends = data || [];
  const ul = $("friend-list");
  ul.innerHTML = "";
  state.friends.forEach((f) => ul.appendChild(personRow(f, { showRemove: true })));
}

async function addFriend(username) {
  const { status, data } = await api("/api/friends", { method: "POST", body: { username } });
  if (status === 201) {
    toast(data.matched ? `🎉 It's a match with ${data.displayName}!` : `Added ${data.displayName} as friend.`);
    loadFriends(); loadDiscover();
  } else toast(data?.error || "Couldn't add friend.");
}

async function removeFriend(friendId) {
  await api("/api/friends/" + friendId, { method: "DELETE" });
  loadFriends();
}

let searchTimer = null;
$("friend-search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const q = $("friend-search").value.trim();
    const ul = $("search-results");
    ul.innerHTML = "";
    if (!q) return;
    const { data } = await api("/api/users/search?q=" + encodeURIComponent(q));
    (data || []).forEach((u) => ul.appendChild(personRow(u, { showAdd: true })));
  }, 250);
});

async function refreshMatches() {
  const { data } = await api("/api/matches");
  state.matches = data || [];
  renderMatches();
}
function renderMatches() {
  const ul = $("match-list");
  if (!ul) return;
  ul.innerHTML = "";
  // merge live online flags
  const on = new Map(state.onlineUsers.map((u) => [u.id, u]));
  state.matches.forEach((m) => {
    const live = on.get(m.id);
    ul.appendChild(personRow({ ...m, online: live ? true : m.online }));
  });
  if (!state.matches.length) ul.innerHTML = `<li class="muted small" style="padding:8px">No matches yet — add friends who add you back!</li>`;
}

async function loadDiscover() {
  const { data } = await api("/api/users");
  state.discover = data || [];
  const ul = $("discover-list");
  ul.innerHTML = "";
  const friendIds = new Set(state.friends.map((f) => f.id));
  state.discover.forEach((u) => {
    if (!friendIds.has(u.id)) ul.appendChild(personRow(u, { showAdd: true }));
  });
}

// ---------------- Channels ----------------
async function loadChannels() {
  const { data } = await api("/api/channels");
  state.channels = data || [];
  const ul = $("channel-list");
  ul.innerHTML = "";
  state.channels.forEach((c) => {
    const li = document.createElement("li");
    li.className = "crow";
    li.innerHTML = `
      <div class="crow-main">
        <span class="avatar chan">${esc(c.name[0].toUpperCase())}</span>
        <span class="urow-name">${esc(c.name)}<small>${c.memberCount} members</small></span>
        <button class="btn-mini ${c.joined ? "joined" : ""}">${c.joined ? "✓ Joined" : "+ Join"}</button>
      </div>`;
    li.querySelector(".crow-main").addEventListener("click", (e) => {
      if (e.target.closest(".btn-mini")) return;
      if (c.joined) viewChannel(c.id);
    });
    li.querySelector(".btn-mini").addEventListener("click", async (e) => {
      e.stopPropagation();
      await api(`/api/channels/${c.id}/${c.joined ? "leave" : "join"}`, { method: "POST" });
      if (state.channel?.id === c.id && c.joined) viewChannel(null);
      loadChannels();
    });
    ul.appendChild(li);
  });
}

$("chan-create-btn").addEventListener("click", async () => {
  const name = $("chan-name").value.trim();
  const description = $("chan-desc").value.trim();
  if (!name) return;
  const { status, data } = await api("/api/channels", { method: "POST", body: { name, description } });
  if (status === 201) {
    $("chan-name").value = ""; $("chan-desc").value = "";
    loadChannels(); viewChannel(data.id);
  }
});

function viewChannel(id) {
  const c = state.channels.find((x) => x.id === id) || null;
  state.channel = c;
  $("channel-banner").classList.toggle("hidden", !c);
  if (c) {
    $("channel-banner-name").textContent = "#" + c.name;
    $("channel-banner-desc").textContent = c.description || "";
    $("composer-title").textContent = "Post to #" + c.name;
  } else {
    $("composer-title").textContent = "Share something";
  }
  loadFeed();
}
$("channel-banner-all").addEventListener("click", () => viewChannel(null));
$("channel-banner-leave").addEventListener("click", async () => {
  if (!state.channel) return;
  await api(`/api/channels/${state.channel.id}/leave`, { method: "POST" });
  viewChannel(null); loadChannels();
});

// ---------------- Feed ----------------
async function loadFeed() {
  const path = state.channel ? `/api/channels/${state.channel.id}/posts` : "/api/posts";
  const { data } = await api(path);
  const feed = $("feed");
  feed.innerHTML = "";
  (data || []).forEach((p) => {
    const div = document.createElement("div");
    div.className = "post card";
    const name = p.displayName || p.username;
    const av = p.avatarUrl
      ? `<img class="avatar-img" src="${esc(p.avatarUrl)}" alt="">`
      : `<span class="avatar">${esc((name || "?")[0].toUpperCase())}</span>`;
    div.innerHTML = `
      <div class="post-head">${av}
        <span class="who">${esc(name)}</span>
        <span class="when">${esc(new Date(p.createdAt).toLocaleString())}</span>
      </div>
      ${p.text ? `<p class="body">${esc(p.text)}</p>` : ""}
      ${p.photoUrl ? `<img class="photo" src="${esc(p.photoUrl)}" alt="post photo" loading="lazy">` : ""}`;
    feed.appendChild(div);
  });
  if (!(data || []).length) feed.innerHTML = `<div class="card muted" style="margin-top:14px">No posts yet — be the first!</div>`;
}

$("post-photo").addEventListener("change", () => {
  const f = $("post-photo").files[0];
  const prev = $("photo-preview");
  if (f) { prev.src = URL.createObjectURL(f); prev.classList.remove("hidden"); }
  else { prev.classList.add("hidden"); prev.src = ""; }
});

$("post-btn").addEventListener("click", async () => {
  const text = $("post-text").value.trim();
  const file = $("post-photo").files[0];
  const msg = $("composer-msg");
  msg.className = "msg"; msg.textContent = "";
  if (!text && !file) { msg.textContent = "Write something or add a photo."; return; }
  const form = new FormData();
  form.append("text", text);
  if (file) form.append("photo", file);
  if (state.channel) form.append("channelId", state.channel.id);
  const { status, data } = await api("/api/posts", { method: "POST", form });
  if (status !== 201) { msg.textContent = data?.error || "Post failed."; return; }
  $("post-text").value = ""; $("post-photo").value = "";
  $("photo-preview").classList.add("hidden");
  msg.className = "msg ok"; msg.textContent = "Posted!";
  loadFeed();
});

// ---------------- Chat ----------------
async function openChat(userId, name) {
  state.chatWith = userId;
  state.chatWithName = name || userId;
  $("chat-with-name").textContent = state.chatWithName;
  $("chat-empty").classList.add("hidden");
  $("chat-active").classList.remove("hidden");
  document.querySelectorAll("#user-list .urow").forEach((li) =>
    li.classList.toggle("active", li.dataset.id === userId));
  const badge = document.querySelector(`#user-list li[data-id="${CSS.escape(userId)}"] .unread`);
  if (badge) { badge.textContent = ""; badge.classList.add("hidden"); }
  $("chat-messages").innerHTML = "";
  const history = await new Promise((resolve) =>
    state.socket.emit("chat:history", { with: userId }, (msgs) => resolve(msgs || [])));
  history.forEach((m) => appendBubble(m.text, m.from === state.me.id, m.createdAt));
}

function appendBubble(text, mine, createdAt) {
  const box = $("chat-messages");
  const div = document.createElement("div");
  div.className = "bubble " + (mine ? "mine" : "theirs");
  const t = createdAt ? new Date(createdAt).toLocaleTimeString() : "";
  div.innerHTML = `${esc(text)}<span class="t">${esc(t)}</span>`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function sendChat() {
  const text = $("chat-input").value.trim();
  if (!text || !state.chatWith) return;
  state.socket.emit("chat:send", { to: state.chatWith, text });
  appendBubble(text, true, new Date().toISOString());
  $("chat-input").value = "";
}
$("chat-send-btn").addEventListener("click", sendChat);
$("chat-input").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });
$("chat-close-btn").addEventListener("click", () => {
  state.chatWith = null;
  $("chat-active").classList.add("hidden");
  $("chat-empty").classList.remove("hidden");
});

// ---------------- Notifications ----------------
async function refreshNotifications() {
  if (!state.token) return;
  const { data } = await api("/api/notifications");
  const list = data || [];
  const unread = list.filter((n) => !n.read).length;
  const badge = $("notif-badge");
  badge.textContent = unread;
  badge.classList.toggle("hidden", unread === 0);
  const ul = $("notif-list");
  ul.innerHTML = "";
  list.slice(0, 30).forEach((n) => {
    const li = document.createElement("li");
    li.className = "notif" + (n.read ? "" : " unread-n");
    const icon = n.type === "call" ? "📞" : n.type === "match" ? "🎉" : "💬";
    li.innerHTML = `${icon} <strong>${esc(n.fromName)}</strong> — ${esc(n.text || n.type)}
      <small>${esc(new Date(n.createdAt).toLocaleString())}</small>`;
    ul.appendChild(li);
  });
  if (!list.length) ul.innerHTML = `<li class="muted small">No notifications.</li>`;
}
$("notif-bell").addEventListener("click", () => {
  $("notif-panel").classList.toggle("hidden");
  refreshNotifications();
});
$("notif-read-all").addEventListener("click", async () => {
  await api("/api/notifications/read", { method: "POST", body: {} });
  refreshNotifications();
});

// ---------------- Profile ----------------
async function openProfile() {
  const { data } = await api("/api/profile");
  if (!data) return;
  $("profile-username").textContent = "@" + data.username;
  $("profile-display").value = data.displayName || "";
  $("profile-bio").value = data.bio || "";
  updateProfileAvatar(data.avatarUrl, data.displayName);
  $("profile-msg").textContent = ""; $("profile-msg").className = "msg";
  $("profile-modal").classList.remove("hidden");
}
function updateProfileAvatar(url, name) {
  const img = $("profile-avatar");
  if (url) { img.src = url; img.style.display = ""; }
  else { img.removeAttribute("src"); img.style.display = "none"; }
}
$("profile-btn").addEventListener("click", openProfile);
$("profile-close").addEventListener("click", () => $("profile-modal").classList.add("hidden"));
$("profile-save").addEventListener("click", async () => {
  const { status, data } = await api("/api/profile", {
    method: "PATCH",
    body: { displayName: $("profile-display").value, bio: $("profile-bio").value },
  });
  const msg = $("profile-msg");
  if (status === 200) {
    state.me = { ...state.me, displayName: data.displayName, bio: data.bio };
    renderMe();
    msg.textContent = "Saved!"; msg.className = "msg ok";
  } else { msg.textContent = data?.error || "Save failed."; msg.className = "msg"; }
});
$("avatar-input").addEventListener("change", async () => {
  const f = $("avatar-input").files[0];
  if (!f) return;
  const form = new FormData();
  form.append("avatar", f);
  const { status, data } = await api("/api/profile/avatar", { method: "POST", form });
  const msg = $("profile-msg");
  if (status === 200) {
    state.me.avatarUrl = data.avatarUrl;
    renderMe(); updateProfileAvatar(data.avatarUrl);
    msg.textContent = "Photo updated!"; msg.className = "msg ok";
  } else { msg.textContent = data?.error || "Upload failed."; msg.className = "msg"; }
});

// ---------------- WebRTC voice/video calls ----------------
function newPeerConnection() {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  pc.onicecandidate = (e) => {
    if (e.candidate && state.callPeer)
      state.socket.emit("call:ice", { to: state.callPeer, candidate: e.candidate });
  };
  pc.ontrack = (e) => { $("remote-video").srcObject = e.streams[0]; };
  return pc;
}

async function startCall(kind, peerId) {
  if (!peerId) return toast("Pick someone first.");
  if (state.pc) return toast("You're already in a call.");
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({
      audio: true, video: kind === "video",
    });
  } catch { return toast("Camera/microphone access was denied."); }
  $("local-video").srcObject = state.localStream;
  state.pc = newPeerConnection();
  state.localStream.getTracks().forEach((t) => state.pc.addTrack(t, state.localStream));
  state.callPeer = peerId; state.callKind = kind;
  const offer = await state.pc.createOffer();
  await state.pc.setLocalDescription(offer);
  state.socket.emit("call:offer", { to: peerId, sdp: state.pc.localDescription, kind });
  $("call-status").textContent = `Calling… (${kind})`;
  $("incoming-modal").classList.add("hidden");
  $("call-overlay").classList.remove("hidden");
  document.querySelector(".video-wrap").style.display = kind === "video" ? "" : "none";
}

async function acceptCall() {
  const offer = state.incomingOffer;
  if (!offer) return;
  state.incomingOffer = null;
  $("incoming-modal").classList.add("hidden");
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({
      audio: true, video: offer.kind === "video",
    });
  } catch { state.socket.emit("call:reject", { to: offer.from }); return toast("Camera/microphone access was denied."); }
  $("local-video").srcObject = state.localStream;
  state.pc = newPeerConnection();
  state.localStream.getTracks().forEach((t) => state.pc.addTrack(t, state.localStream));
  state.callPeer = offer.from; state.callKind = offer.kind;
  await state.pc.setRemoteDescription(new RTCSessionDescription(offer.sdp));
  const answer = await state.pc.createAnswer();
  await state.pc.setLocalDescription(answer);
  state.socket.emit("call:answer", { to: offer.from, sdp: state.pc.localDescription });
  $("call-status").textContent = "Connected";
  $("call-overlay").classList.remove("hidden");
  document.querySelector(".video-wrap").style.display = offer.kind === "video" ? "" : "none";
}

function hangup() {
  if (state.callPeer && state.socket) state.socket.emit("call:end", { to: state.callPeer });
  cleanupCall();
}

function cleanupCall() {
  if (state.pc) { try { state.pc.close(); } catch {} state.pc = null; }
  if (state.localStream) { state.localStream.getTracks().forEach((t) => t.stop()); state.localStream = null; }
  $("remote-video").srcObject = null; $("local-video").srcObject = null;
  $("call-overlay").classList.add("hidden");
  state.callPeer = null; state.callKind = null; state.muted = false;
  $("mute-btn").textContent = "🎙️";
}

$("call-audio-btn").addEventListener("click", () => startCall("audio", state.chatWith));
$("call-video-btn").addEventListener("click", () => startCall("video", state.chatWith));
$("incoming-accept").addEventListener("click", acceptCall);
$("incoming-decline").addEventListener("click", () => {
  const o = state.incomingOffer; state.incomingOffer = null;
  $("incoming-modal").classList.add("hidden");
  if (o && state.socket) state.socket.emit("call:reject", { to: o.from });
});
$("hangup-btn").addEventListener("click", hangup);
$("mute-btn").addEventListener("click", () => {
  if (!state.localStream) return;
  state.muted = !state.muted;
  state.localStream.getAudioTracks().forEach((t) => (t.enabled = !state.muted));
  $("mute-btn").textContent = state.muted ? "🔇" : "🎙️";
});

// ---------------- boot ----------------
async function refreshAll() {
  renderOnline();
  await Promise.all([loadFeed(), loadChannels(), refreshMatches(), refreshNotifications()]);
}

# Dan Recovery — Social Web Platform

A **real working** social web platform: real auth, real-time chat, voice/video
calls (WebRTC), mutual-friend matching, friends, channels, persistent posts with
photo uploads, notifications, and profiles. Brand: Dan Recovery (teal/emerald).

## What actually works (verified by `npm test`, see TEST-REPORT.md)

- **Real auth** — signup/login with scrypt-hashed passwords + Bearer session tokens.
- **Real-time chat** — instant delivery, history persists in `db.json`, survives restarts.
- **Voice/video calls** — full WebRTC flow (offer/answer/ICE, mute, hangup, decline,
  disconnect-mid-call notifies peer, offline callee gets a missed-call notification).
- **Matching** — mutual friend-adds create a match; both users get `match:new` live.
- **Friends, user search, discover, channels** (create/join/leave/channel feed).
- **Notifications** — missed messages/calls/matches stored while offline, bell with unread count.
- **Posts + photo posts** — persistent feed (newest-first), image upload + serving.
- **Profiles** — display name, bio, avatar upload.

## Run locally

```bash
cd dan-recovery-web
npm install
npm start        # http://localhost:3000
npm test         # end-to-end suite — must exit 0
```

Open the URL in **two browser windows**, sign up as two users, and: chat from the
sidebar (tap a person → quick actions → Chat), tap 📞/🎥 to call, match by adding
each other as friends, post text + photos.

## Two-tap UX (max 2 taps from seeing a person to chat/call)

- **Online list / Matches**: tap 1 = tap the person's row → inline quick-action
  panel opens (💬 Chat · 📞 Audio · 🎥 Video). Tap 2 = tap the action → chat opens
  or the call starts ringing immediately.
- **Video call in two taps**: Matches tab → tap match → tap 🎥 Video.
- **Discover**: one tap on "+ Add" adds a friend.

## Deploy to Render (click-by-click)

Browsers **require HTTPS** (or localhost) for camera/microphone — deploy with HTTPS
or calls can't access media. Render gives you HTTPS automatically.

1. Create a free account at https://render.com (sign up with GitHub).
2. Push this folder to a GitHub repo (`dan-recovery-web`).
3. Render dashboard → **New +** → **Web Service** → connect the repo.
4. When prompted for the service setup:
   - **Runtime:** Docker (the repo has a `Dockerfile`; Render detects it).
   - Or use the `render.yaml` blueprint: dashboard → New → Blueprint → connect repo.
5. **Environment variables** (Render → service → Environment):
   - `DATA_DIR` = `/data`
   - `PORT` = `3000` (Render also injects its own `PORT`; the app honors it)
6. Click **Create Web Service** → wait for the build → open the
   `https://dan-recovery-web.onrender.com` URL. Sign up two users and test.

**Alternative — Railway:** New Project → Deploy from GitHub → same env vars;
add a Volume mounted at `/data` for persistence.

**Alternative — VPS:** install Node 20+, `npm ci --omit=dev`, run with
`pm2`/`systemd` with `DATA_DIR=/data`, front with Caddy for automatic HTTPS:
`caddy reverse-proxy --from example.com --to localhost:3000`.

## Honest limits

- **JSON-file DB** (`db.json` under `DATA_DIR`) is correct for start/small scale,
  not for high concurrency — move to Postgres when you grow.
- **Auth is password sessions, not OAuth** — fine for launch; add OAuth/2FA later.
- **Calls are P2P WebRTC** — both users must be online at the same time; media
  goes directly between browsers (public STUN included; symmetric NATs may need
  a TURN server).
- **Single server** — presence/routing live in memory; scale-out needs a shared
  Socket.io adapter (e.g. Redis).
- Render free tier sleeps when idle and has no persistent disk — data resets on
  redeploy unless you use a paid instance with the disk in `render.yaml`.

## API + socket protocol (summary)

- `POST /api/signup {username, password, displayName?}` → `{token, user}` (409 if taken)
- `POST /api/login {username, password}` → `{token, user}` · `POST /api/logout`
- `GET /api/me` · `GET /api/users` · `GET /api/users/search?q=`
- `POST/GET /api/friends`, `DELETE /api/friends/:id` · `GET /api/matches`
- `POST/GET /api/channels`, `POST /api/channels/:id/join|leave`, `GET /api/channels/:id/posts`
- `GET /api/posts`, `POST /api/posts` (multipart `text` + `photo`, optional `channelId`)
- `GET /api/notifications`, `POST /api/notifications/read`
- `GET/PATCH /api/profile`, `POST /api/profile/avatar`
- All `/api/*` except signup/login need `Authorization: Bearer <token>`.
- Socket.io: `auth: {token}` → `presence`, `chat:send`/`chat:recv`/`chat:history`,
  `call:offer`/`call:incoming`/`call:answer`/`call:answered`/`call:ice`/`call:reject`/
  `call:rejected`/`call:end`/`call:ended`, `match:new`, `notification`.

# Snake Arena Online

A real-time online multiplayer Snake game for up to 8 players per room.
Players join the same room from any device or browser and play at the same time.
The **server is authoritative**: it runs the game, and browsers only send the direction a player wants to turn.

- **Frontend:** HTML5, CSS3, JavaScript, Canvas API (responsive: phone, tablet, desktop)
- **Backend:** Node.js, Express, Socket.IO
- **Database:** none needed for version 1 (rooms live in memory); a persistence hook is ready for MongoDB / Firebase

---

## Quick start

Requires **Node.js 18 or newer** (<https://nodejs.org>).

```bash
npm install
npm start
```

Then open <http://localhost:3000>.

The server prints a `Network:` URL as well. Use it to play from phones or other computers on the same Wi-Fi.

## How to play

1. Enter a player name and press **Create Room**. You get a 6-character Room ID.
2. Share the Room ID (the **Copy** and **Share** buttons in the lobby help). Friends enter it and press **Join Room**.
3. Everyone except the host presses **Ready**. The host presses **Start Game** (needs 2 to 8 players).
4. After a server-synchronised **3 – 2 – 1 – GO!** the match runs for 3 minutes (the host can pick 1, 2, 3 or 5 minutes in the lobby).
5. Eat the glowing food to grow and score **10 points** each. Hitting a wall, yourself or another snake kills you.
   If two heads collide head-on, both snakes die.
6. When the timer ends (or everyone is dead) the highest score wins. Ties are broken by who survived, then who lasted longest.

| Device | Controls |
| --- | --- |
| Desktop | Arrow keys or **W A S D** |
| Phone / tablet | On-screen pad (↑ / ← ↓ →) or **swipe** on the arena |

Reversing straight into yourself is impossible: pressing the opposite direction is ignored.

---

## Project structure

```
snake-arena-online/
├── client/
│   ├── index.html      # all screens: home, lobby, game, game over
│   ├── style.css       # dark neon theme, responsive layout, on-screen pad
│   ├── game.js         # Socket.IO client, canvas renderer, input handling
│   ├── config.js       # optional SERVER_URL for split hosting
│   └── assets/         # logo and favicon
├── server/
│   ├── server.js       # Express + Socket.IO, validation, rate limits, lifecycle
│   ├── room.js         # rooms, lobby, ready/host logic, countdown, match loop
│   ├── game.js         # authoritative game engine (pure logic, no sockets)
│   └── player.js       # Player model, colours, name sanitising
├── test/               # automated tests (engine + real Socket.IO multiplayer)
├── package.json
└── README.md
```

---

## Testing multiplayer locally

### Two browsers (or tabs) on one computer

1. Start the server: `npm start`.
2. Open <http://localhost:3000> in **Browser 1**, enter a name and press **Create Room**.
3. Open <http://localhost:3000> in **Browser 2** (or a second tab, or a private window).
   Enter a different name and the Room ID, then press **Join Room**.
4. Browser 2 presses **Ready**, Browser 1 presses **Start Game**.
5. Steer both snakes. Each browser should show the other snake moving in real time.
6. Test the rules: run into a wall (you should see **YOU DIED** with your score while the other player keeps playing),
   run into the other snake, and eat food (score, length and leaderboard update on both screens).
7. Close one tab mid-game: the other player sees *"<name> disconnected."*.
   Reload a tab within 20 seconds and it jumps back into the room and the running match.

> Player names must be unique within a room. Each tab keeps its own session, so two tabs of the same browser are two different players.

### Several phones on the same network

1. Connect the computer and the phones to the **same Wi-Fi**.
2. Start the server. It prints something like `Network: http://192.168.1.23:3000`.
3. Open that address in the phone browser (Chrome on Android works well). Create a room on one device and join with the others.
4. If a phone cannot connect, allow Node.js through the computer's firewall (Windows: *Allow an app through firewall*; macOS: *Firewall options*), and make sure the Wi-Fi does not isolate clients ("AP isolation" / "guest network").
5. The **Copy** button uses the clipboard API, which browsers only allow on HTTPS or `localhost`. On plain `http://192.168.x.x` it falls back to a legacy copy method, or you can just read the Room ID aloud.

### Automated tests

```bash
npm test
```

32 tests run with Node's built-in test runner:
engine rules (movement, reversal, walls, self/snake/head-on collisions, food, timer, winner, spawn fairness, name validation)
and a real Socket.IO server with real clients (rooms, full room, errors, countdown, movement seen by another client,
cheat attempts, disconnect/host reassignment, reconnection, play again, HTTP headers).

---

## Configuration

All settings are optional environment variables.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP + WebSocket port. Hosting platforms set this for you. |
| `HOST` | `0.0.0.0` | Interface to bind to. |
| `MATCH_DURATION_SECONDS` | `180` | Default match length (10 – 1800). The host can change it per room in the lobby. |
| `TICK_MS` | `120` | Server game tick in milliseconds (40 – 500). Lower is faster. |
| `RECONNECT_GRACE_SECONDS` | `20` | How long a disconnected player's seat is held for reconnecting. |
| `MAX_ROOMS` | `1000` | Upper limit of simultaneous rooms. |
| `CORS_ORIGIN` | *(unset)* | Only needed when the frontend is hosted on a different domain. Comma-separated list of origins, or `*`. |

Example: `PORT=8080 TICK_MS=100 MATCH_DURATION_SECONDS=120 npm start`

No secrets or API keys are used, and none are sent to the browser.

---

## Deployment (real internet)

The simplest and recommended architecture is **one Node.js app that serves the frontend and Socket.IO together**.
The server already listens on `process.env.PORT` and on all interfaces, uses WebSocket with an automatic long-polling fallback,
and exposes `GET /healthz` for health checks.

### Platform-as-a-service (Render, Railway, Fly.io, Heroku-style hosts)

1. Push this folder to a Git repository.
2. Create a new **Web Service** from the repository.
3. Build command: `npm install` (use `npm install --omit=dev` to skip test dependencies). Start command: `npm start`.
4. Do **not** set `PORT` yourself; the platform provides it. Optionally set the variables from the table above.
5. Set the health check path to `/healthz`.
6. Open the public `https://…` URL and play. Share the page link or just the Room ID.

Things to check on any platform:

- **WebSocket support** must be enabled (it is by default on the platforms above).
- Run **a single instance**. Rooms live in the memory of one process, so two instances would not see each other's rooms.
  (Scaling beyond one instance needs sticky sessions plus a shared room store such as the Socket.IO Redis adapter; that is outside version 1.)
- Use **HTTPS**. Browsers then use `wss://` automatically, and clipboard and sharing features work.
- Free tiers that put the app to sleep will disconnect players when it sleeps; players reconnect when it wakes.

### Your own server (VPS) with a process manager and nginx

```bash
# on the server
git clone <your repo> snake-arena-online && cd snake-arena-online
npm install --omit=dev
PORT=3000 NODE_ENV=production npm start          # quick test

# keep it running and restart on reboot
npm install -g pm2
PORT=3000 NODE_ENV=production pm2 start server/server.js --name snake-arena
pm2 save && pm2 startup
```

nginx reverse proxy (the `Upgrade` headers are what make WebSockets work):

```nginx
server {
    listen 80;
    server_name snake.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
}
```

Add HTTPS with Let's Encrypt (`sudo certbot --nginx -d snake.example.com`).

### Hosting frontend and backend separately (optional)

Only do this if you really want a static host for `client/`.

1. Deploy the Node app as above and set `CORS_ORIGIN=https://your-frontend.example.com` on it.
2. Copy the `client/` folder to your static host.
3. In `client/config.js` set `SERVER_URL: 'https://your-backend.example.com'`.
4. In `client/index.html` change `<script src="/socket.io/socket.io.js">` to
   `<script src="https://your-backend.example.com/socket.io/socket.io.js">`.
5. The built-in Content-Security-Policy only applies to pages served by the Node app. Add an equivalent policy on your static host if you want one.

---

## How it works

### Server-authoritative loop

- Each room owns a `Game` (`server/game.js`) and ticks it every `TICK_MS` (default 120 ms, about 8 moves per second).
- Clients send only `game:input { dir }`. Directions are validated, rate-limited, and queued (max 2). Every queued turn is checked against the previous one, so quick double turns work but reversals never do.
- On each tick the server moves all snakes at once, resolves collisions on the resulting board (walls, self, other snakes, head-on), awards food, tops up food on empty cells only, checks the timer, and broadcasts one compact `game:state` message to the room.
- The browser interpolates between two server states, so movement looks smooth without being the source of truth.

### Socket.IO events

| Direction | Event | Purpose |
| --- | --- | --- |
| client → server | `room:create` `{name}` | create a room (acknowledged with Room ID + private session token) |
| | `room:join` `{name, roomId}` | join a room |
| | `session:resume` `{roomId, token}` | restore a player after a dropped connection or page reload |
| | `room:leave`, `room:ready` `{ready}`, `room:settings` `{durationSec}` | lobby actions |
| | `game:start`, `game:playAgain` | host only |
| | `game:input` `{dir}` | `up` / `down` / `left` / `right` |
| server → client | `room:state` | lobby: players, colours, ready flags, host, match length |
| | `room:notice` | "Player2 disconnected.", "X is now the host.", … |
| | `game:init` | match metadata + first state (also used to re-sync after reconnecting) |
| | `game:countdown` `{n}` | 3, 2, 1, 0 (GO!) |
| | `game:state` | tick, time left, foods, snakes (flat coordinate arrays), scores |
| | `game:events` | deaths and their reasons |
| | `game:over` | winner(s) and final ranking |
| | `game:aborted` | match cancelled (for example, a player left during the countdown) |

A worst-case state message (8 snakes of 25 segments) is about 1.7 KB, roughly 14 KB/s per player at the default tick rate.

### Disconnects and reconnection

- A dropped player is marked **offline** and everyone sees *"<name> disconnected."*. If that was the host, the next connected player becomes host automatically.
- The seat is held for `RECONNECT_GRACE_SECONDS`. During a match the snake keeps heading straight (it usually crashes, which is fair to the others).
- The browser reconnects automatically (Socket.IO reconnection) and re-sends its private token with `session:resume`. The server restores the player and sends the current room and match state. This also works after refreshing the page.
- After the grace period (or when someone presses Leave) the player is removed and the room is deleted when empty. No ghost players remain.

### Anti-cheat and security

- The server computes positions, collisions, food, scores, timer, and the winner. Clients cannot send any of them; unknown fields in messages are ignored.
- All inputs are validated: names (letters, numbers, space, `_ - .`, 1–16 characters; no HTML-significant characters), Room IDs (6 letters/digits), directions (4 allowed values), payload types.
- Names are only ever rendered with `textContent` or canvas text, never as HTML.
- Per-socket rate limiting, a small Socket.IO message size limit, and a cap on the number of rooms.
- Security headers on every response, including a strict Content-Security-Policy (no inline scripts or styles).
- Session tokens are random, secret, and never sent to other players.

---

## Preparing for a database later

Version 1 stores nothing. When a match ends, the server calls `store.saveMatch({ roomId, endedAt, result })` on a pluggable store (`NullStore` by default).
To add MongoDB (or Firebase), implement the same method and pass it to `createServer`:

```js
// server/start-with-mongo.js (example, not included)
const { MongoClient } = require('mongodb');
const { createServer } = require('./server');

(async () => {
  const mongo = await MongoClient.connect(process.env.MONGODB_URI);
  const matches = mongo.db('snake').collection('matches');
  const store = { saveMatch: (match) => matches.insertOne(match) };
  const server = createServer({ store });
  await server.listen();
})();
```

The same hook is the place for leaderboards, accounts, or statistics.

---

## Troubleshooting

| Problem | Likely cause and fix |
| --- | --- |
| Page loads but says *"Server unavailable. Retrying…"* | The server is not running or WebSockets are blocked by a proxy. Check that `npm start` is running, and that your proxy forwards `Upgrade` headers. |
| Phones cannot open the Network URL | Same Wi-Fi? Firewall allows Node.js? Guest-network client isolation is off? |
| *"Room not found."* | The Room ID is wrong, or the room closed because everyone left. |
| *"Room is full. Please join another room."* | Rooms hold at most 8 players. |
| *"A match is in progress."* | Rooms accept new players only between matches. |
| Port already in use | Run on another port: `PORT=3001 npm start` (Windows PowerShell: `$env:PORT=3001; npm start`). |

## License

MIT

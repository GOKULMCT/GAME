'use strict';

const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const { Room, RoomError, MAX_PLAYERS } = require('./room');
const { sanitizeName } = require('./player');

const CLIENT_DIR = path.join(__dirname, '..', 'client');
const ROOM_ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const ROOM_ID_LENGTH = 6;
const ROOM_ID_PATTERN = /^[A-Z0-9]{6}$/;

// Per-socket token buckets: { burst, perSec }.
const LIMITS = {
  action: { burst: 12, perSec: 4 },
  input: { burst: 30, perSec: 20 },
};

function envInt(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Persistence hook. The first version keeps everything in memory. To add
 * MongoDB / Firebase later, pass a store with the same shape to createServer():
 *   { async saveMatch({ roomId, endedAt, result }) { ... } }
 */
class NullStore {
  async saveMatch() {}
}

const fail = (code, message) => ({ ok: false, error: { code, message } });

function createServer(options = {}) {
  const config = {
    port: envInt('PORT', 3000, 0, 65535),
    host: process.env.HOST || '0.0.0.0',
    matchDurationMs: envInt('MATCH_DURATION_SECONDS', 180, 10, 1800) * 1000,
    tickMs: envInt('TICK_MS', 120, 40, 500),
    graceMs: envInt('RECONNECT_GRACE_SECONDS', 20, 1, 300) * 1000,
    maxRooms: envInt('MAX_ROOMS', 1000, 1, 100000),
    countdownStepMs: 1000,
    corsOrigin: process.env.CORS_ORIGIN || '',
    store: new NullStore(),
    rng: Math.random,
    ...options,
  };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' data:",
        "connect-src 'self' ws: wss:",
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
      ].join('; ')
    );
    next();
  });

  app.get('/healthz', (req, res) => {
    res.json({ ok: true, rooms: rooms.size, uptimeSeconds: Math.round(process.uptime()) });
  });
  app.use(express.static(CLIENT_DIR));

  const httpServer = http.createServer(app);

  const ioOptions = {
    pingInterval: 10000,
    pingTimeout: 8000,
    maxHttpBufferSize: 10 * 1024,
    transports: ['websocket', 'polling'],
  };
  if (config.corsOrigin) {
    ioOptions.cors = {
      origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',').map((s) => s.trim()),
      methods: ['GET', 'POST'],
    };
  }
  const io = new Server(httpServer, ioOptions);

  const rooms = new Map();

  // ---- helpers -----------------------------------------------------------

  function generateRoomId() {
    for (let attempt = 0; attempt < 50; attempt++) {
      let id = '';
      for (let i = 0; i < ROOM_ID_LENGTH; i++) {
        id += ROOM_ID_ALPHABET[crypto.randomInt(ROOM_ID_ALPHABET.length)];
      }
      if (!rooms.has(id)) return id;
    }
    throw new RoomError('SERVER_BUSY', 'The server is busy. Please try again in a moment.');
  }

  function allow(socket, bucket) {
    const cfg = LIMITS[bucket];
    const now = Date.now();
    const buckets = socket.data.buckets;
    const b = buckets[bucket] || (buckets[bucket] = { tokens: cfg.burst, last: now });
    b.tokens = Math.min(cfg.burst, b.tokens + ((now - b.last) / 1000) * cfg.perSec);
    b.last = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  function requireObject(payload) {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new RoomError('BAD_REQUEST', 'Invalid request.');
    }
    return payload;
  }

  function parseName(raw) {
    const result = sanitizeName(raw);
    if (!result.ok) throw new RoomError('INVALID_NAME', result.message);
    return result.value;
  }

  function parseRoomId(raw) {
    const id = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
    if (!id) throw new RoomError('EMPTY_ROOM_ID', 'Please enter a Room ID.');
    if (!ROOM_ID_PATTERN.test(id)) {
      throw new RoomError('INVALID_ROOM_ID', 'Room IDs are 6 letters or numbers (for example ABC123).');
    }
    return id;
  }

  function membership(socket) {
    const m = socket.data.member;
    const room = m && rooms.get(m.roomId);
    const player = room && room.players.get(m.playerId);
    if (!room || !player || player.socketId !== socket.id) {
      socket.data.member = null;
      throw new RoomError('NOT_IN_ROOM', 'You are not in a room.');
    }
    return { room, player };
  }

  function leaveCurrent(socket) {
    const m = socket.data.member;
    socket.data.member = null;
    if (!m) return;
    const room = rooms.get(m.roomId);
    if (!room) return;
    socket.leave(room.id);
    const player = room.players.get(m.playerId);
    if (player && player.socketId === socket.id) room.removePlayer(player.id, 'left');
  }

  function joinedReply(room, player, socket) {
    socket.data.member = { roomId: room.id, playerId: player.id };
    return { roomId: room.id, playerId: player.id, token: player.token, room: room.toPublic() };
  }

  /** Register an acknowledged event handler with rate limiting and error handling. */
  function handle(socket, event, fn) {
    socket.on(event, async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      if (!allow(socket, 'action')) {
        return reply(fail('RATE_LIMITED', 'You are doing that too fast. Please slow down.'));
      }
      try {
        const data = await fn(payload);
        return reply({ ok: true, ...(data || {}) });
      } catch (err) {
        if (err instanceof RoomError) return reply(fail(err.code, err.message));
        console.error(`[${event}] unexpected error:`, err);
        return reply(fail('SERVER_ERROR', 'Something went wrong on the server. Please try again.'));
      }
    });
  }

  // ---- socket handlers ---------------------------------------------------

  io.on('connection', (socket) => {
    socket.data.buckets = {};
    socket.data.member = null;

    handle(socket, 'room:create', (payload) => {
      const { name } = requireObject(payload);
      const playerName = parseName(name);
      if (rooms.size >= config.maxRooms) {
        throw new RoomError('SERVER_BUSY', 'The server is busy. Please try again in a moment.');
      }
      leaveCurrent(socket);
      const room = new Room(generateRoomId(), io, {
        durationMs: config.matchDurationMs,
        tickMs: config.tickMs,
        countdownStepMs: config.countdownStepMs,
        graceMs: config.graceMs,
        rng: config.rng,
        onEmpty: (r) => rooms.delete(r.id),
        onMatchEnd: (r, result) => {
          Promise.resolve(config.store.saveMatch({ roomId: r.id, endedAt: Date.now(), result })).catch(
            (err) => console.error('store.saveMatch failed:', err)
          );
        },
      });
      rooms.set(room.id, room);
      const player = room.addPlayer(playerName, socket);
      return joinedReply(room, player, socket);
    });

    handle(socket, 'room:join', (payload) => {
      const { name, roomId } = requireObject(payload);
      const playerName = parseName(name);
      const id = parseRoomId(roomId);
      const room = rooms.get(id);
      if (!room) throw new RoomError('ROOM_NOT_FOUND', 'Room not found.');
      const existing = socket.data.member;
      if (existing && existing.roomId === id) {
        throw new RoomError('ALREADY_IN_ROOM', 'You are already in this room.');
      }
      // Validate against the target room before leaving the current one.
      if (room.players.size >= MAX_PLAYERS) {
        throw new RoomError('ROOM_FULL', 'Room is full. Please join another room.');
      }
      leaveCurrent(socket);
      const player = room.addPlayer(playerName, socket);
      return joinedReply(room, player, socket);
    });

    handle(socket, 'session:resume', (payload) => {
      const { roomId, token } = requireObject(payload);
      const id = parseRoomId(roomId);
      const room = rooms.get(id);
      const player = room && room.findByToken(token);
      if (!room || !player) throw new RoomError('ROOM_NOT_FOUND', 'Your previous room no longer exists.');

      // Detach an older socket that the server has not noticed closing yet.
      if (player.socketId && player.socketId !== socket.id) {
        const old = io.sockets.sockets.get(player.socketId);
        if (old) {
          old.data.member = null;
          old.leave(room.id);
        }
      }
      room.reconnect(player, socket);
      const reply = joinedReply(room, player, socket);
      // Send the snapshot after the ack so the client has restored its session first.
      setImmediate(() => {
        if (socket.connected) room.sendSync(socket);
      });
      return reply;
    });

    handle(socket, 'room:leave', () => {
      leaveCurrent(socket);
    });

    handle(socket, 'room:ready', (payload) => {
      const { ready } = requireObject(payload);
      const { room, player } = membership(socket);
      room.setReady(player.id, ready);
    });

    handle(socket, 'room:settings', (payload) => {
      const { durationSec } = requireObject(payload);
      const { room, player } = membership(socket);
      room.setDuration(player.id, durationSec);
    });

    handle(socket, 'game:start', () => {
      const { room, player } = membership(socket);
      room.startGame(player.id, { requireReady: true });
    });

    handle(socket, 'game:playAgain', () => {
      const { room, player } = membership(socket);
      room.startGame(player.id, { requireReady: false });
    });

    // Movement input: fire-and-forget, validated and rate limited. The client
    // only ever says which way it wants to turn.
    socket.on('game:input', (payload) => {
      if (!allow(socket, 'input')) return;
      if (payload === null || typeof payload !== 'object' || typeof payload.dir !== 'string') return;
      const m = socket.data.member;
      const room = m && rooms.get(m.roomId);
      const player = room && room.players.get(m.playerId);
      if (!room || !player || player.socketId !== socket.id) return;
      room.handleInput(player.id, payload.dir);
    });

    socket.on('disconnect', () => {
      const m = socket.data.member;
      socket.data.member = null;
      if (!m) return;
      const room = rooms.get(m.roomId);
      const player = room && room.players.get(m.playerId);
      // A newer socket may already have taken over this player (page refresh).
      if (room && player && player.socketId === socket.id) room.markDisconnected(player);
    });

    socket.on('error', (err) => console.error('socket error:', err && err.message));
  });

  // ---- lifecycle ---------------------------------------------------------

  function listen(port = config.port, host = config.host) {
    return new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(port, host, () => {
        httpServer.removeListener('error', reject);
        resolve(httpServer.address().port);
      });
    });
  }

  async function close() {
    for (const room of rooms.values()) room.destroy();
    rooms.clear();
    await new Promise((resolve) => io.close(() => resolve()));
  }

  return { app, httpServer, io, rooms, config, listen, close };
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list || []) {
      if ((iface.family === 'IPv4' || iface.family === 4) && !iface.internal) out.push(iface.address);
    }
  }
  return out;
}

if (require.main === module) {
  const server = createServer();
  server
    .listen()
    .then((port) => {
      console.log(`Snake Arena Online is running on port ${port}`);
      console.log(`  Local:   http://localhost:${port}`);
      for (const ip of lanAddresses()) console.log(`  Network: http://${ip}:${port}`);
    })
    .catch((err) => {
      console.error(`Could not start the server: ${err.message}`);
      process.exit(1);
    });

  const shutdown = () => {
    console.log('Shutting down...');
    server.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { createServer, NullStore };

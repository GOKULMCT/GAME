'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');

const { createServer } = require('../server/server');

/** Start a real server on a random port with fast timings. */
async function startServer(overrides = {}) {
  const server = createServer({
    port: 0,
    host: '127.0.0.1',
    tickMs: 40,
    countdownStepMs: 25,
    graceMs: 400,
    matchDurationMs: 60000,
    ...overrides,
  });
  const port = await server.listen(0, '127.0.0.1');
  return { server, url: `http://127.0.0.1:${port}` };
}

/** Thin wrapper around a socket.io-client connection with promise helpers. */
function makeClient(url) {
  const socket = connect(url, { transports: ['websocket'], reconnection: false, forceNew: true });
  const log = [];
  const waiters = [];
  socket.onAny((event, payload) => {
    log.push({ event, payload });
    for (const w of [...waiters]) {
      if (w.event === event && (!w.pred || w.pred(payload))) {
        waiters.splice(waiters.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolve(payload);
      }
    }
  });
  const client = {
    socket,
    log,
    state: null,
    ready: new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    }),
    request(event, payload) {
      return new Promise((resolve, reject) => {
        socket.timeout(3000).emit(event, payload, (err, res) => (err ? reject(err) : resolve(res)));
      });
    },
    waitFor(event, pred, ms = 4000) {
      const earlier = log.find((l) => l.event === event && (!pred || pred(l.payload)));
      if (earlier) return Promise.resolve(earlier.payload);
      return new Promise((resolve, reject) => {
        const w = { event, pred, resolve };
        w.timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(w), 1);
          reject(new Error(`timed out waiting for ${event}`));
        }, ms);
        waiters.push(w);
      });
    },
    // Wait for a *future* event, ignoring anything already logged.
    next(event, pred, ms = 4000) {
      return new Promise((resolve, reject) => {
        const w = { event, pred, resolve };
        w.timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(w), 1);
          reject(new Error(`timed out waiting for next ${event}`));
        }, ms);
        waiters.push(w);
      });
    },
    close() {
      socket.close();
    },
  };
  socket.on('room:state', (s) => {
    client.state = s;
  });
  return client;
}

async function twoPlayers(url) {
  const a = makeClient(url);
  const b = makeClient(url);
  await Promise.all([a.ready, b.ready]);
  const created = await a.request('room:create', { name: 'Alice' });
  assert.equal(created.ok, true);
  const joined = await b.request('room:join', { name: 'Bob', roomId: created.roomId });
  assert.equal(joined.ok, true);
  return { a, b, created, joined, roomId: created.roomId };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('create room, join, lobby state and ready flow', async () => {
  const { server, url } = await startServer();
  const clients = [];
  try {
    const { a, b, created, joined, roomId } = await twoPlayers(url);
    clients.push(a, b);
    assert.match(roomId, /^[A-Z2-9]{6}$/);
    assert.equal(created.room.players.length, 1);
    assert.equal(joined.room.players.length, 2);
    assert.equal(joined.room.hostId, created.playerId);
    assert.equal(typeof created.token, 'string');
    // Public player entries never leak the secret token.
    assert.ok(!JSON.stringify(joined.room).includes(created.token));

    await a.waitFor('room:state', (s) => s.players.length === 2);
    const colors = new Set(a.state.players.map((p) => p.color));
    assert.equal(colors.size, 2);

    // Host cannot start until the other player is ready.
    const early = await a.request('game:start');
    assert.equal(early.ok, false);
    assert.equal(early.error.code, 'NOT_READY');

    // A non-host cannot start the game.
    const notHost = await b.request('game:start');
    assert.equal(notHost.error.code, 'NOT_HOST');

    assert.equal((await b.request('room:ready', { ready: true })).ok, true);
    await a.waitFor('room:state', (s) => s.players.some((p) => p.name === 'Bob' && p.ready));
  } finally {
    clients.forEach((c) => c.close());
    await server.close();
  }
});

test('error handling: invalid names, empty id, missing room, bad payloads', async () => {
  const { server, url } = await startServer();
  const c = makeClient(url);
  try {
    await c.ready;
    assert.equal((await c.request('room:create', { name: '' })).error.code, 'INVALID_NAME');
    assert.equal((await c.request('room:create', { name: '<script>alert(1)</script>' })).error.code, 'INVALID_NAME');
    assert.equal((await c.request('room:create', { name: 'x'.repeat(40) })).error.code, 'INVALID_NAME');
    assert.equal((await c.request('room:create', null)).error.code, 'BAD_REQUEST');
    assert.equal((await c.request('room:create', 'hello')).error.code, 'BAD_REQUEST');
    assert.equal((await c.request('room:join', { name: 'Bob', roomId: '' })).error.code, 'EMPTY_ROOM_ID');
    assert.equal((await c.request('room:join', { name: 'Bob', roomId: 'ab' })).error.code, 'INVALID_ROOM_ID');
    const missing = await c.request('room:join', { name: 'Bob', roomId: 'ZZZZZZ' });
    assert.equal(missing.error.code, 'ROOM_NOT_FOUND');
    assert.equal(missing.error.message, 'Room not found.');
    assert.equal((await c.request('game:start')).error.code, 'NOT_IN_ROOM');
    assert.equal((await c.request('room:ready', { ready: true })).error.code, 'NOT_IN_ROOM');
  } finally {
    c.close();
    await server.close();
  }
});

test('room is full after 8 players and the 9th is rejected', async () => {
  const { server, url } = await startServer();
  const clients = [];
  try {
    const host = makeClient(url);
    clients.push(host);
    await host.ready;
    const created = await host.request('room:create', { name: 'Host' });
    for (let i = 1; i < 8; i++) {
      const c = makeClient(url);
      clients.push(c);
      await c.ready;
      const res = await c.request('room:join', { name: `Guest${i}`, roomId: created.roomId });
      assert.equal(res.ok, true, `guest ${i} should join`);
    }
    await host.waitFor('room:state', (s) => s.players.length === 8);
    const colors = new Set(host.state.players.map((p) => p.color));
    assert.equal(colors.size, 8, 'all 8 players get a unique colour');

    const ninth = makeClient(url);
    clients.push(ninth);
    await ninth.ready;
    const res = await ninth.request('room:join', { name: 'Late', roomId: created.roomId });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'ROOM_FULL');
    assert.equal(res.error.message, 'Room is full. Please join another room.');
  } finally {
    clients.forEach((c) => c.close());
    await server.close();
  }
});

test('duplicate names in one room are rejected', async () => {
  const { server, url } = await startServer();
  const clients = [];
  try {
    const { a, b, roomId } = await twoPlayers(url);
    clients.push(a, b);
    const c = makeClient(url);
    clients.push(c);
    await c.ready;
    const res = await c.request('room:join', { name: 'alice', roomId });
    assert.equal(res.error.code, 'NAME_TAKEN');
  } finally {
    clients.forEach((c) => c.close());
    await server.close();
  }
});

test('full match: countdown, real-time movement seen by both players, food, timer and game over', async () => {
  const { server, url } = await startServer({ matchDurationMs: 1500 });
  const clients = [];
  try {
    const { a, b, created, joined } = await twoPlayers(url);
    clients.push(a, b);
    await b.request('room:ready', { ready: true });

    const counts = { a: [], b: [] };
    a.socket.on('game:countdown', (p) => counts.a.push(p.n));
    b.socket.on('game:countdown', (p) => counts.b.push(p.n));

    const initA = a.next('game:init');
    const initB = b.next('game:init');
    const started = await a.request('game:start');
    assert.equal(started.ok, true);
    const [ia, ib] = await Promise.all([initA, initB]);
    assert.equal(ia.meta.players.length, 2);
    assert.equal(ib.meta.players.length, 2);
    assert.equal(ia.meta.width, 32);

    await Promise.all([a.waitFor('game:countdown', (p) => p.n === 0), b.waitFor('game:countdown', (p) => p.n === 0)]);
    assert.deepEqual(counts.a, [3, 2, 1, 0]);
    assert.deepEqual(counts.b, [3, 2, 1, 0]);

    // Both players receive the same authoritative state.
    const stateB = await b.next('game:state', (s) => s.phase === 'playing' && s.tick >= 1);
    const myBefore = stateB.snakes.find((s) => s.id === created.playerId);
    assert.ok(myBefore.alive);

    // Alice is spawned heading down. Turning left must be visible to Bob.
    const headBefore = { x: myBefore.body[0], y: myBefore.body[1] };
    a.socket.emit('game:input', { dir: 'left' });
    const turned = await b.next('game:state', (s) => {
      const me = s.snakes.find((x) => x.id === created.playerId);
      return me.alive && me.body[0] < headBefore.x;
    });
    const me = turned.snakes.find((x) => x.id === created.playerId);
    assert.ok(me.body[0] < headBefore.x, 'Bob sees Alice moving left');

    // A reversal (right after left) is ignored by the server: Alice keeps going left.
    a.socket.emit('game:input', { dir: 'right' });
    await sleep(160);
    const afterReverse = b.log.filter((l) => l.event === 'game:state').pop().payload;
    const meAfter = afterReverse.snakes.find((x) => x.id === created.playerId);
    if (meAfter.alive) assert.ok(meAfter.body[0] <= me.body[0], 'snake did not reverse');

    // The match ends by itself and both clients get the same result.
    const [overA, overB] = await Promise.all([a.waitFor('game:over', null, 8000), b.waitFor('game:over', null, 8000)]);
    assert.deepEqual(overA.result, overB.result);
    assert.equal(overA.result.ranking.length, 2);
    assert.ok(overA.result.winners.length >= 1);
    assert.ok(['time', 'all-dead'].includes(overA.result.reason));
    for (const r of overA.result.ranking) assert.equal(typeof r.score, 'number');

    // Back in the lobby with ready flags reset, host can play again without anyone pressing ready.
    await a.waitFor('room:state', (s) => s.phase === 'lobby');
    const again = await a.request('game:playAgain');
    assert.equal(again.ok, true);
    const initAgain = await b.next('game:init');
    assert.equal(initAgain.phase, 'countdown');
    const nonHostAgain = await b.request('game:playAgain');
    assert.equal(nonHostAgain.ok, false);
    assert.ok(joined.ok);
  } finally {
    clients.forEach((c) => c.close());
    await server.close();
  }
});

test('clients cannot set their own score or position', async () => {
  const { server, url } = await startServer();
  const clients = [];
  try {
    const { a, b, created } = await twoPlayers(url);
    clients.push(a, b);
    await b.request('room:ready', { ready: true });
    await a.request('game:start');
    await a.waitFor('game:countdown', (p) => p.n === 0);

    a.socket.emit('game:input', { dir: 'left', score: 999999, body: [0, 0], alive: true });
    a.socket.emit('game:input', { score: 999999 });
    a.socket.emit('game:input', 'up');
    a.socket.emit('game:input', { dir: { toString: 'x' } });
    a.socket.emit('game:score', { score: 999999 });
    await sleep(300);
    const last = b.log.filter((l) => l.event === 'game:state').pop().payload;
    const alice = last.snakes.find((s) => s.id === created.playerId);
    assert.equal(alice.score, 0);
    assert.ok(alice.body.length <= 6 + 2 * 20, 'body length is controlled by the server');
  } finally {
    clients.forEach((c) => c.close());
    await server.close();
  }
});

test('game cannot start alone and a room in progress rejects new players', async () => {
  const { server, url } = await startServer();
  const clients = [];
  try {
    const a = makeClient(url);
    clients.push(a);
    await a.ready;
    const created = await a.request('room:create', { name: 'Solo' });
    const alone = await a.request('game:start');
    assert.equal(alone.error.code, 'NOT_ENOUGH_PLAYERS');

    const b = makeClient(url);
    clients.push(b);
    await b.ready;
    await b.request('room:join', { name: 'Duo', roomId: created.roomId });
    await b.request('room:ready', { ready: true });
    assert.equal((await a.request('game:start')).ok, true);

    const c = makeClient(url);
    clients.push(c);
    await c.ready;
    const late = await c.request('room:join', { name: 'Late', roomId: created.roomId });
    assert.equal(late.error.code, 'GAME_IN_PROGRESS');
  } finally {
    clients.forEach((c) => c.close());
    await server.close();
  }
});

test('disconnect handling: notice, host reassignment and removal after the grace period', async () => {
  const { server, url } = await startServer({ graceMs: 300 });
  const clients = [];
  try {
    const { a, b, created, joined } = await twoPlayers(url);
    clients.push(a, b);
    const notice = b.next('room:notice', (n) => n.type === 'disconnect');
    a.close(); // the host drops
    const n = await notice;
    assert.equal(n.message, 'Alice disconnected.');

    await b.waitFor('room:state', (s) => s.hostId === joined.playerId);
    assert.equal(b.state.hostId, joined.playerId, 'Bob became host');
    assert.equal(b.state.players.find((p) => p.id === created.playerId).connected, false);

    await b.waitFor('room:state', (s) => s.players.length === 1, 3000);
    assert.equal(b.state.players.length, 1, 'ghost player removed after the grace period');
  } finally {
    clients.forEach((c) => c.close());
    await server.close();
  }
});

test('reconnection: a dropped player resumes with their token and gets the game state', async () => {
  const { server, url } = await startServer({ graceMs: 5000 });
  const clients = [];
  try {
    const { a, b, created, roomId } = await twoPlayers(url);
    clients.push(a, b);
    await b.request('room:ready', { ready: true });
    await a.request('game:start');
    await a.waitFor('game:countdown', (p) => p.n === 0);

    b.close();
    await a.waitFor('room:notice', (n) => n.message === 'Bob disconnected.');

    const b2 = makeClient(url);
    clients.push(b2);
    await b2.ready;
    const bad = await b2.request('session:resume', { roomId, token: 'not-a-real-token' });
    assert.equal(bad.ok, false);

    const bobToken = (await (async () => {
      // The token was handed to Bob's first socket; read it from the server-side room.
      const room = server.rooms.get(roomId);
      return [...room.players.values()].find((p) => p.name === 'Bob').token;
    })());
    const syncInit = b2.next('game:init');
    const res = await b2.request('session:resume', { roomId, token: bobToken });
    assert.equal(res.ok, true);
    assert.equal(res.roomId, roomId);
    const init = await syncInit;
    assert.equal(init.meta.players.length, 2);
    assert.ok(init.state.snakes.length === 2);
    await a.waitFor('room:notice', (n) => n.message === 'Bob reconnected.');

    // The restored player can steer again.
    const bobId = res.playerId;
    b2.socket.emit('game:input', { dir: 'right' });
    const st = await a.next('game:state', (s) => s.snakes.some((x) => x.id === bobId));
    assert.ok(st);
    assert.ok(created.ok);
  } finally {
    clients.forEach((c) => c.close());
    await server.close();
  }
});

test('leaving a room tells the others and deletes empty rooms', async () => {
  const { server, url } = await startServer();
  const clients = [];
  try {
    const { a, b, roomId } = await twoPlayers(url);
    clients.push(a, b);
    const left = a.next('room:notice', (n) => n.type === 'leave');
    assert.equal((await b.request('room:leave')).ok, true);
    assert.equal((await left).message, 'Bob left the room.');
    assert.equal(server.rooms.has(roomId), true);
    assert.equal((await a.request('room:leave')).ok, true);
    await sleep(50);
    assert.equal(server.rooms.has(roomId), false, 'empty room is removed');
    assert.equal((await b.request('room:join', { name: 'Bob', roomId })).error.code, 'ROOM_NOT_FOUND');
  } finally {
    clients.forEach((c) => c.close());
    await server.close();
  }
});

test('HTTP: serves the client and a health endpoint with security headers', async () => {
  const { server, url } = await startServer();
  try {
    const home = await fetch(url + '/');
    assert.equal(home.status, 200);
    const html = await home.text();
    assert.match(html, /Snake Arena Online/);
    assert.match(home.headers.get('content-security-policy') || '', /default-src 'self'/);
    assert.equal(home.headers.get('x-powered-by'), null);

    for (const file of ['/style.css', '/game.js', '/socket.io/socket.io.js']) {
      const r = await fetch(url + file);
      assert.equal(r.status, 200, `${file} should be served`);
    }
    const health = await (await fetch(url + '/healthz')).json();
    assert.equal(health.ok, true);
  } finally {
    await server.close();
  }
});

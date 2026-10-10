/* Snake Arena Online - browser client.
 *
 * The server is authoritative: this file only sends the direction the player wants
 * to turn, and draws whatever state the server broadcasts. It never computes scores,
 * collisions or food positions.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants and tiny helpers
  // ---------------------------------------------------------------------------

  // Must match server/player.js (the server sends colour *indexes*).
  const COLORS = ['#39ff14', '#2d9bff', '#ffe600', '#ff3b3b', '#b64dff', '#ff8c1a', '#00f0ff', '#ff4fd8'];
  const MEDALS = ['\u{1F947}', '\u{1F948}', '\u{1F949}'];
  const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} _.\-]*$/u;
  const SESSION_KEY = 'snakeArena.session';
  const NAME_KEY = 'snakeArena.name';
  const DEATH_TEXT = {
    wall: 'You hit the wall.',
    self: 'You ran into yourself.',
    snake: 'You crashed into another snake.',
    headon: 'Head-on crash!',
    left: 'You left the match.',
  };

  const $ = (id) => document.getElementById(id);

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text; // textContent only: names can never inject HTML
    return node;
  }

  function safeGet(storage, key) {
    try { return storage.getItem(key); } catch (e) { return null; }
  }
  function safeSet(storage, key, value) {
    try { storage.setItem(key, value); } catch (e) { /* storage unavailable (private mode) */ }
  }
  function safeRemove(storage, key) {
    try { storage.removeItem(key); } catch (e) { /* ignore */ }
  }

  // sessionStorage is per tab, so two tabs of one browser can play against each other.
  function loadSession() {
    try {
      const s = JSON.parse(safeGet(window.sessionStorage, SESSION_KEY) || 'null');
      if (s && typeof s.roomId === 'string' && typeof s.token === 'string' && typeof s.playerId === 'string') return s;
    } catch (e) { /* corrupt value */ }
    return null;
  }
  function saveSession(me) {
    safeSet(window.sessionStorage, SESSION_KEY, JSON.stringify({
      roomId: me.roomId, token: me.token, playerId: me.id, name: me.name,
    }));
  }
  function clearSession() { safeRemove(window.sessionStorage, SESSION_KEY); }

  // ---------------------------------------------------------------------------
  // Global client state
  // ---------------------------------------------------------------------------

  const state = {
    screen: 'home',
    room: null,            // latest room:state from the server
    me: null,              // { id, roomId, token, name }
    gameOverPending: false,
    overTimer: null,
    game: null,            // live match data, see part 2
  };

  let socket = null;

  // ---------------------------------------------------------------------------
  // UI helpers
  // ---------------------------------------------------------------------------

  function showScreen(name) {
    state.screen = name;
    // While playing, toasts move to the top so they never cover the on-screen pad.
    document.body.classList.toggle('playing', name === 'game');
    document.querySelectorAll('.screen').forEach((s) => {
      s.classList.toggle('active', s.id === 'screen-' + name);
    });
    if (name === 'game') {
      fitCanvas();
      startLoop();
    } else {
      stopLoop();
    }
    window.scrollTo(0, 0);
  }

  function toast(message, kind) {
    const box = $('toasts');
    const node = el('div', 'toast' + (kind ? ' ' + kind : ''), message);
    box.appendChild(node);
    while (box.children.length > 4) box.removeChild(box.firstChild);
    setTimeout(() => {
      node.classList.add('out');
      setTimeout(() => node.remove(), 350);
    }, 3200);
  }

  function setBanner(text, warn) {
    const banner = $('conn-banner');
    if (!text) {
      banner.classList.add('hidden');
      return;
    }
    banner.textContent = text;
    banner.classList.toggle('warn', !!warn);
    banner.classList.remove('hidden');
  }

  function showError(id, message) { $(id).textContent = message || ''; }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise((resolve, reject) => {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.className = 'hidden-copy';
      document.body.appendChild(area);
      area.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      area.remove();
      ok ? resolve() : reject(new Error('copy failed'));
    });
  }

  function myId() { return state.me ? state.me.id : null; }

  // ---------------------------------------------------------------------------
  // Networking
  // ---------------------------------------------------------------------------

  function request(event, payload) {
    return new Promise((resolve) => {
      if (!socket || !socket.connected) {
        resolve({ ok: false, error: { code: 'OFFLINE', message: 'Not connected to the server. Reconnecting…' } });
        return;
      }
      socket.timeout(6000).emit(event, payload, (err, res) => {
        if (err) {
          resolve({ ok: false, error: { code: 'TIMEOUT', message: 'Server unavailable. Please try again.' } });
        } else if (res && typeof res === 'object') {
          resolve(res);
        } else {
          resolve({ ok: false, error: { code: 'BAD_RESPONSE', message: 'Unexpected response from the server.' } });
        }
      });
    });
  }

  function initSocket() {
    if (typeof window.io !== 'function') {
      setBanner('Could not load the game connection. Please reload the page.');
      return false;
    }
    const cfg = window.SNAKE_CONFIG || {};
    socket = window.io(cfg.SERVER_URL || undefined, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 4000,
      timeout: 8000,
    });

    let wasConnected = false;

    socket.on('connect', () => {
      setBanner(null);
      if (wasConnected) toast('Reconnected.', 'good');
      wasConnected = true;
      const saved = loadSession();
      if (saved) resumeSession(saved);
    });

    socket.on('disconnect', (reason) => {
      setBanner('Connection lost. Reconnecting…', true);
      // The server closed the socket on purpose: reconnect manually.
      if (reason === 'io server disconnect') socket.connect();
    });

    socket.on('connect_error', () => {
      setBanner('Server unavailable. Retrying…');
    });

    socket.on('room:state', onRoomState);
    socket.on('room:notice', onRoomNotice);
    socket.on('game:init', handleGameInit);
    socket.on('game:countdown', handleCountdown);
    socket.on('game:state', handleGameState);
    socket.on('game:events', handleGameEvents);
    socket.on('game:over', onGameOver);
    socket.on('game:aborted', (p) => {
      toast((p && p.message) || 'The match was cancelled.', 'error');
      endMatchView();
      renderLobby();
      showScreen('lobby');
    });
    return true;
  }

  async function resumeSession(saved) {
    // Set identity first so events that arrive right behind the ack already know who we are.
    state.me = { id: saved.playerId, roomId: saved.roomId, token: saved.token, name: saved.name };
    const res = await request('session:resume', { roomId: saved.roomId, token: saved.token });
    if (res.ok) {
      state.me = { id: res.playerId, roomId: res.roomId, token: res.token, name: saved.name };
      state.room = res.room;
      if (state.screen === 'home') {
        renderLobby();
        showScreen('lobby');
      } else if (state.screen === 'game' && !state.gameOverPending && res.room.phase === 'lobby') {
        toast('The match ended while you were away.');
        endMatchView();
        renderLobby();
        showScreen('lobby');
      } else if (state.screen === 'lobby') {
        renderLobby();
      }
      return;
    }
    const code = res.error && res.error.code;
    if (code === 'ROOM_NOT_FOUND' || code === 'INVALID_ROOM_ID' || code === 'BAD_REQUEST') {
      clearSession();
      state.me = null;
      state.room = null;
      endMatchView();
      showScreen('home');
      showError('home-error', 'Your previous room is no longer available.');
    }
    // Other failures (offline, timeout) keep the session; the next reconnect retries.
  }

  // ---------------------------------------------------------------------------
  // Home screen
  // ---------------------------------------------------------------------------

  function readName() {
    const input = $('player-name');
    const name = input.value.replace(/\s+/g, ' ').trim();
    let problem = '';
    if (!name) problem = 'Please enter a player name.';
    else if (Array.from(name).length > 16) problem = 'Name must be 16 characters or fewer.';
    else if (!NAME_RE.test(name)) problem = 'Name can only contain letters, numbers, spaces and the characters _ - .';
    if (problem) {
      showError('home-error', problem);
      input.focus();
      return null;
    }
    safeSet(window.localStorage, NAME_KEY, name);
    return name;
  }

  function setHomeBusy(busy) {
    $('btn-create').disabled = busy;
    $('btn-join').disabled = busy;
  }

  function enterRoom(res, name) {
    state.me = { id: res.playerId, roomId: res.roomId, token: res.token, name };
    saveSession(state.me);
    state.room = res.room;
    endMatchView();
    renderLobby();
    showScreen('lobby');
  }

  async function onCreate() {
    showError('home-error', '');
    const name = readName();
    if (!name) return;
    setHomeBusy(true);
    const res = await request('room:create', { name });
    setHomeBusy(false);
    if (!res.ok) return showError('home-error', res.error.message);
    enterRoom(res, name);
  }

  async function onJoin() {
    showError('home-error', '');
    const name = readName();
    if (!name) return;
    const roomId = $('room-id').value.trim().toUpperCase();
    if (!roomId) {
      showError('home-error', 'Please enter a Room ID.');
      $('room-id').focus();
      return;
    }
    setHomeBusy(true);
    const res = await request('room:join', { name, roomId });
    setHomeBusy(false);
    if (!res.ok) return showError('home-error', res.error.message);
    enterRoom(res, name);
  }

  async function leaveRoom() {
    await request('room:leave');
    clearSession();
    state.me = null;
    state.room = null;
    endMatchView();
    showError('home-error', '');
    showScreen('home');
  }

  // ---------------------------------------------------------------------------
  // Lobby
  // ---------------------------------------------------------------------------

  function onRoomState(room) {
    state.room = room;
    if (state.screen === 'lobby') renderLobby();
  }

  function onRoomNotice(n) {
    if (!n || typeof n.message !== 'string') return;
    // Skip the "joined the room" notice about ourselves.
    if (state.me && n.type === 'join' && n.message === state.me.name + ' joined the room.') return;
    toast(n.message, n.type === 'disconnect' ? 'error' : undefined);
  }

  function renderLobby() {
    const room = state.room;
    if (!room) return;
    const me = room.players.find((p) => p.id === myId());
    const isHost = room.hostId === myId();
    const inLobby = room.phase === 'lobby';

    $('lobby-room').textContent = room.roomId;
    $('lobby-count').textContent = room.players.length + ' / ' + room.maxPlayers;

    const list = $('player-list');
    list.textContent = '';
    for (const p of room.players) {
      const row = el('li', 'player-row' + (p.id === myId() ? ' me' : '') + (p.connected ? '' : ' offline'));
      const dot = el('span', 'dot');
      dot.style.color = COLORS[p.color] || '#ffffff';
      const name = el('span', 'player-name', p.name);
      if (p.id === myId()) name.appendChild(el('span', 'player-tag', '(you)'));
      if (p.isHost) name.appendChild(el('span', 'player-tag', 'HOST'));
      let label = 'Not ready';
      let cls = 'waiting';
      if (!p.connected) { label = 'Offline'; cls = 'offline'; }
      else if (p.ready) { label = 'Ready'; cls = 'ready'; }
      row.append(dot, name, el('span', 'status ' + cls, label));
      list.appendChild(row);
    }

    // Match length (only the host can change it).
    const select = $('duration');
    if (select.options.length !== room.durationOptions.length) {
      select.textContent = '';
      for (const sec of room.durationOptions) {
        const opt = document.createElement('option');
        opt.value = String(sec);
        opt.textContent = sec / 60 + (sec === 60 ? ' minute' : ' minutes');
        select.appendChild(opt);
      }
    }
    select.value = String(room.durationSec);
    select.disabled = !isHost || !inLobby;

    // Buttons and hint.
    const others = room.players.filter((p) => p.connected && p.id !== room.hostId);
    const connected = room.players.filter((p) => p.connected).length;
    const allReady = others.every((p) => p.ready);
    const canStart = isHost && inLobby && connected >= room.minPlayers && allReady;

    $('btn-ready').classList.toggle('hidden', isHost);
    $('btn-start').classList.toggle('hidden', !isHost);
    $('btn-ready').disabled = !inLobby;
    $('btn-ready').textContent = me && me.ready ? 'NOT READY' : 'READY';
    $('btn-start').disabled = !canStart;

    let hint;
    if (!inLobby) hint = 'A match is in progress…';
    else if (isHost && connected < room.minPlayers) hint = 'Share the Room ID. At least ' + room.minPlayers + ' players are needed to start.';
    else if (isHost && !allReady) hint = 'Waiting for everyone to press READY.';
    else if (isHost) hint = 'Everyone is ready. Start when you are!';
    else if (me && me.ready) hint = 'You are ready. Waiting for the host to start…';
    else hint = 'Press READY when you are set.';
    $('lobby-hint').textContent = hint;
  }

  async function onReadyClick() {
    showError('lobby-error', '');
    const me = state.room && state.room.players.find((p) => p.id === myId());
    const res = await request('room:ready', { ready: !(me && me.ready) });
    if (!res.ok) showError('lobby-error', res.error.message);
  }

  async function onStartClick() {
    showError('lobby-error', '');
    $('btn-start').disabled = true;
    const res = await request('game:start');
    if (!res.ok) {
      showError('lobby-error', res.error.message);
      renderLobby();
    }
  }

  async function onDurationChange() {
    showError('lobby-error', '');
    const res = await request('room:settings', { durationSec: Number($('duration').value) });
    if (!res.ok) {
      showError('lobby-error', res.error.message);
      renderLobby();
    }
  }

  function onCopyClick() {
    const id = state.room && state.room.roomId;
    if (!id) return;
    copyText(id).then(
      () => toast('Room ID ' + id + ' copied.', 'good'),
      () => toast('Could not copy. Room ID: ' + id)
    );
  }

  function onShareClick() {
    const id = state.room && state.room.roomId;
    if (!id || !navigator.share) return;
    navigator.share({
      title: 'Snake Arena Online',
      text: 'Join my Snake Arena room: ' + id,
      url: location.origin + '/?room=' + encodeURIComponent(id),
    }).catch(() => { /* user cancelled */ });
  }

  // ---------------------------------------------------------------------------
  // Game over screen
  // ---------------------------------------------------------------------------

  function onGameOver(payload) {
    if (!payload || !payload.result) return;
    state.gameOverPending = true;
    clearTimeout(state.overTimer);
    // Let the final frame stay visible for a moment before showing the results.
    state.overTimer = setTimeout(() => {
      state.gameOverPending = false;
      renderOver(payload.result);
      showScreen('over');
    }, 900);
  }

  function renderOver(result) {
    const ranking = result.ranking || [];
    const byId = new Map(ranking.map((r) => [r.id, r]));
    const winners = (result.winners || []).map((id) => byId.get(id)).filter(Boolean);
    const topScore = winners.length ? winners[0].score : 0;

    $('winner-label').textContent = result.draw ? 'DRAW' : 'WINNER';
    $('winner-name').textContent = winners.length ? winners.map((w) => w.name).join(' & ') : '—';
    $('winner-score').textContent = 'Score: ' + topScore;

    const board = $('final-board');
    board.textContent = '';
    for (const r of ranking) {
      const row = el('li', 'final-row' + (r.id === myId() ? ' me' : '') + (winners.includes(r) ? ' winner' : ''));
      const rank = el('span', 'final-rank', r.rank <= 3 ? MEDALS[r.rank - 1] : r.rank + '.');
      const dot = el('span', 'dot');
      dot.style.color = COLORS[r.colorIndex] || '#ffffff';
      row.append(rank, dot, el('span', 'final-name', r.name), el('span', 'final-score', String(r.score)));
      board.appendChild(row);
    }

    const mine = byId.get(myId());
    $('over-me').textContent = mine
      ? 'You finished #' + mine.rank + ' with ' + mine.score + ' points.'
      : 'You watched this match as a spectator.';
    showError('over-error', '');
  }

  async function onPlayAgain() {
    showError('over-error', '');
    const room = state.room;
    if (room && room.hostId === myId()) {
      $('btn-again').disabled = true;
      const res = await request('game:playAgain');
      $('btn-again').disabled = false;
      if (!res.ok) showError('over-error', res.error.message);
      return;
    }
    // Everyone else: go back to the lobby and mark ready for the host's next round.
    renderLobby();
    showScreen('lobby');
    const me = room && room.players.find((p) => p.id === myId());
    if (!me || !me.ready) await request('room:ready', { ready: true });
    toast('You are ready. Waiting for the host…');
  }

  function onBackToLobby() {
    renderLobby();
    showScreen('lobby');
  }

  // ---------------------------------------------------------------------------
  // Match state (everything here mirrors what the server sent)
  // ---------------------------------------------------------------------------

  function findSnake(snapshot, id) {
    if (!snapshot) return null;
    for (const s of snapshot.snakes) if (s.id === id) return s;
    return null;
  }

  function validSnapshot(s) {
    if (!s || typeof s !== 'object') return false;
    if (!Array.isArray(s.snakes) || !Array.isArray(s.foods)) return false;
    if (typeof s.timeLeftMs !== 'number') return false;
    for (const sn of s.snakes) {
      if (!sn || typeof sn.id !== 'string' || !Array.isArray(sn.body) || typeof sn.score !== 'number') return false;
    }
    return true;
  }

  let lastResync = 0;
  function resync() {
    const now = Date.now();
    if (now - lastResync < 3000) return;
    lastResync = now;
    toast('Received an invalid game state. Re-syncing…', 'error');
    const saved = loadSession();
    if (saved) resumeSession(saved);
  }

  function newGame(meta, phase) {
    return {
      meta,
      phase,
      names: new Map(meta.players.map((p) => [p.id, p.name])),
      colors: new Map(meta.players.map((p) => [p.id, p.color])),
      order: new Map(meta.players.map((p, i) => [p.id, i])),
      isPlayer: meta.players.some((p) => p.id === myId()),
      prev: null,
      prevById: null,
      cur: null,
      curAt: 0,
      deathShown: false,
      deathReason: '',
      lastSentDir: null,
      lastSentAt: 0,
      lbSig: '',
      timeText: '',
      cdTimer: 0,
      deathTimer: 0,
    };
  }

  function hideOverlays() {
    $('overlay-countdown').classList.add('hidden');
    $('overlay-death').classList.add('hidden');
    $('overlay-death').classList.remove('compact');
  }

  /** Forget the current match (leaving a room, match cancelled, new session). */
  function endMatchView() {
    const g = state.game;
    if (g) {
      clearTimeout(g.cdTimer);
      clearTimeout(g.deathTimer);
    }
    clearTimeout(state.overTimer);
    state.gameOverPending = false;
    state.game = null;
    hideOverlays();
    stopLoop();
  }

  function handleGameInit(p) {
    if (!p || !p.meta || !Array.isArray(p.meta.players) || !validSnapshot(p.state)) return resync();
    const old = state.game;
    if (old) {
      clearTimeout(old.cdTimer);
      clearTimeout(old.deathTimer);
    }
    clearTimeout(state.overTimer);
    state.gameOverPending = false;

    const g = newGame(p.meta, p.phase);
    g.cur = p.state;
    g.curAt = performance.now();
    state.game = g;

    hideOverlays();
    $('spectator-badge').classList.toggle('hidden', g.isPlayer);
    $('dpad').classList.toggle('hidden', !g.isPlayer);
    $('hud-room').textContent = p.roomId || (state.room ? state.room.roomId : '------');
    $('hud-time').classList.remove('low');
    updateHud();
    showScreen('game');
    if (p.phase === 'countdown' && typeof p.countdown === 'number') showCountdown(p.countdown);
    checkMyDeath();
  }

  function showCountdown(n) {
    const g = state.game;
    if (!g) return;
    const box = $('overlay-countdown');
    const num = $('countdown-number');
    num.textContent = n === 0 ? 'GO!' : String(n);
    num.classList.toggle('go', n === 0);
    box.classList.remove('hidden');
    num.style.animation = 'none'; // restart the pop animation
    void num.offsetWidth;
    num.style.animation = '';
    clearTimeout(g.cdTimer);
    if (n === 0) g.cdTimer = setTimeout(() => box.classList.add('hidden'), 800);
  }

  function handleCountdown(p) {
    if (!state.game || !p || typeof p.n !== 'number') return;
    showCountdown(p.n);
  }

  function handleGameState(s) {
    const g = state.game;
    if (!g) return;
    if (!validSnapshot(s)) return resync();
    const now = performance.now();
    g.prev = g.cur && g.cur.phase === 'playing' && s.phase === 'playing' ? g.cur : null;
    g.prevById = g.prev ? new Map(g.prev.snakes.map((sn) => [sn.id, sn])) : null;
    g.cur = s;
    g.curAt = now;
    g.phase = s.phase;

    const mine = findSnake(s, myId());
    // Re-sync our idea of the current heading with the server's, unless an input is in flight.
    if (mine && mine.alive && now - g.lastSentAt > 250) g.lastSentDir = mine.dir;

    updateHud();
    checkMyDeath();
  }

  function handleGameEvents(events) {
    const g = state.game;
    if (!g || !Array.isArray(events)) return;
    const verbs = {
      wall: 'crashed into the wall.',
      self: 'ran into themselves.',
      snake: 'crashed into another snake.',
      headon: 'crashed head-on.',
      left: 'left the match.',
    };
    for (const e of events) {
      if (!e || e.type !== 'death') continue;
      if (e.id === myId()) {
        g.deathReason = DEATH_TEXT[e.reason] || '';
        if (g.deathShown) showDeathNote();
      } else {
        toast((g.names.get(e.id) || 'A player') + ' ' + (verbs[e.reason] || 'was eliminated.'));
      }
    }
  }

  function showDeathNote() {
    const g = state.game;
    if (!g) return;
    $('death-note').textContent = (g.deathReason ? g.deathReason + ' ' : '') + 'Spectating until the match ends…';
  }

  function checkMyDeath() {
    const g = state.game;
    if (!g || !g.isPlayer || g.deathShown || !g.cur || g.cur.phase === 'countdown') return;
    const mine = findSnake(g.cur, myId());
    if (!mine || mine.alive) return;
    g.deathShown = true;
    $('death-score').textContent = 'Score: ' + mine.score;
    showDeathNote();
    const card = $('overlay-death');
    card.classList.remove('compact', 'hidden');
    clearTimeout(g.deathTimer);
    g.deathTimer = setTimeout(() => card.classList.add('compact'), 2400);
  }

  // ---------------------------------------------------------------------------
  // HUD and leaderboard
  // ---------------------------------------------------------------------------

  function updateHud() {
    const g = state.game;
    if (!g || !g.cur) return;
    const mine = findSnake(g.cur, myId());
    $('hud-score').textContent = g.isPlayer ? 'SCORE: ' + (mine ? mine.score : 0) : 'SPECTATING';
    updateLeaderboard();
  }

  function updateLeaderboard() {
    const g = state.game;
    const snakes = g.cur.snakes.slice().sort((a, b) => (
      b.score - a.score ||
      (b.alive ? 1 : 0) - (a.alive ? 1 : 0) ||
      (g.order.get(a.id) || 0) - (g.order.get(b.id) || 0)
    ));
    const sig = snakes.map((s) => s.id + ':' + s.score + ':' + (s.alive ? 1 : 0)).join('|');
    if (sig === g.lbSig) return;
    g.lbSig = sig;

    const list = $('leaderboard');
    list.textContent = '';
    snakes.forEach((s, i) => {
      const row = el('li', 'lb-row' + (s.id === myId() ? ' me' : '') + (s.alive ? '' : ' dead'));
      const dot = el('span', 'dot');
      dot.style.color = COLORS[g.colors.get(s.id)] || '#ffffff';
      const name = (g.names.get(s.id) || '?') + (s.alive ? '' : ' ☠');
      row.append(
        el('span', 'lb-rank', i < 3 ? MEDALS[i] : i + 1 + '.'),
        dot,
        el('span', 'lb-name', name),
        el('span', 'lb-score', String(s.score))
      );
      list.appendChild(row);
    });
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function updateTimer(now) {
    const g = state.game;
    if (!g || !g.cur) return;
    let ms = g.cur.timeLeftMs;
    if (g.cur.phase === 'playing') ms = Math.max(0, ms - (now - g.curAt));
    const total = Math.ceil(ms / 1000);
    const text = 'TIME: ' + pad2(Math.floor(total / 60)) + ':' + pad2(total % 60);
    if (text !== g.timeText) {
      g.timeText = text;
      const node = $('hud-time');
      node.textContent = text;
      node.classList.toggle('low', g.cur.phase === 'playing' && total <= 10);
    }
  }

  // ---------------------------------------------------------------------------
  // Canvas rendering
  // ---------------------------------------------------------------------------

  const canvas = $('arena');
  const ctx = canvas.getContext('2d');
  let cssSize = 0;
  let dpr = 1;
  let rafId = 0;
  let bgCache = null;
  let bgKey = '';

  function mix(hex, other, t) {
    const a = parseInt(hex.slice(1), 16);
    const b = parseInt(other.slice(1), 16);
    const ch = (shift) => Math.round(((a >> shift) & 255) * (1 - t) + ((b >> shift) & 255) * t);
    return 'rgb(' + ch(16) + ',' + ch(8) + ',' + ch(0) + ')';
  }
  const LIGHT = COLORS.map((c) => mix(c, '#ffffff', 0.4));

  function fitCanvas() {
    const wrap = $('arena-wrap');
    const rect = wrap.getBoundingClientRect();
    const size = Math.floor(Math.min(rect.width, rect.height));
    if (size < 60) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2.5);
    if (size === cssSize && ratio === dpr) return;
    cssSize = size;
    dpr = ratio;
    canvas.style.width = size + 'px';
    canvas.style.height = size + 'px';
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    bgKey = '';
  }

  let fitQueued = false;
  function scheduleFit() {
    if (fitQueued) return;
    fitQueued = true;
    requestAnimationFrame(() => {
      fitQueued = false;
      if (state.screen === 'game') fitCanvas();
    });
  }

  function startLoop() {
    if (!rafId) rafId = requestAnimationFrame(frame);
  }

  function stopLoop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  function frame(now) {
    rafId = requestAnimationFrame(frame);
    updateTimer(now);
    draw(now);
  }

  /** Grid, checker tint and glowing wall are static, so draw them once per size. */
  function ensureBackground(W, H, cell) {
    const key = [cssSize, dpr, W, H].join('x');
    if (bgCache && key === bgKey) return bgCache;
    const off = document.createElement('canvas');
    off.width = canvas.width;
    off.height = canvas.height;
    const c = off.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = '#070b14';
    c.fillRect(0, 0, cssSize, cssSize);
    c.fillStyle = 'rgba(255,255,255,0.02)';
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if ((x + y) & 1) c.fillRect(x * cell, y * cell, cell, cell);
      }
    }
    c.strokeStyle = 'rgba(0,240,255,0.07)';
    c.lineWidth = 1;
    c.beginPath();
    for (let i = 1; i < W; i++) { c.moveTo(i * cell, 0); c.lineTo(i * cell, H * cell); }
    for (let j = 1; j < H; j++) { c.moveTo(0, j * cell); c.lineTo(W * cell, j * cell); }
    c.stroke();
    const lw = Math.max(3, cell * 0.22);
    c.shadowColor = '#00f0ff';
    c.shadowBlur = 14;
    c.strokeStyle = 'rgba(0,240,255,0.9)';
    c.lineWidth = lw;
    c.strokeRect(lw / 2, lw / 2, W * cell - lw, H * cell - lw);
    bgCache = off;
    bgKey = key;
    return off;
  }

  function draw(now) {
    const g = state.game;
    if (!g || !g.cur || !cssSize) return;
    const W = g.meta.width;
    const H = g.meta.height;
    const cell = cssSize / Math.max(W, H);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(ensureBackground(W, H, cell), 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    drawFoods(g.cur.foods, cell, now);

    const t = g.prev ? Math.min(1, (now - g.curAt) / g.meta.tickMs) : 1;
    let mineSnake = null;
    for (const s of g.cur.snakes) {
      if (!s.alive || s.body.length < 4) continue;
      if (s.id === myId()) { mineSnake = s; continue; } // draw our own snake on top
      drawSnake(g, s, t, cell, now);
    }
    if (mineSnake) drawSnake(g, mineSnake, t, cell, now);
  }

  function drawFoods(foods, cell, now) {
    for (let i = 0; i < foods.length; i += 2) {
      const fx = foods[i];
      const fy = foods[i + 1];
      const cx = (fx + 0.5) * cell;
      const cy = (fy + 0.5) * cell;
      const pulse = 1 + 0.14 * Math.sin(now / 230 + fx * 7 + fy * 3);
      const r = cell * 0.3 * pulse;
      ctx.save();
      ctx.shadowColor = '#ff2e63';
      ctx.shadowBlur = cell * 0.9;
      const grad = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r);
      grad.addColorStop(0, '#ffe3ea');
      grad.addColorStop(0.45, '#ff5c82');
      grad.addColorStop(1, '#ff2e63');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  function snakePoints(body, prevBody, t, cell) {
    const n = body.length / 2;
    const pts = new Array(n);
    for (let i = 0; i < n; i++) {
      let x = body[2 * i];
      let y = body[2 * i + 1];
      if (prevBody && t < 1 && 2 * i + 1 < prevBody.length) {
        const px = prevBody[2 * i];
        const py = prevBody[2 * i + 1];
        // Only blend between neighbouring cells so a respawn never "slides" across the board.
        if (Math.abs(x - px) + Math.abs(y - py) === 1) {
          x = px + (x - px) * t;
          y = py + (y - py) * t;
        }
      }
      pts[i] = [(x + 0.5) * cell, (y + 0.5) * cell];
    }
    return pts;
  }

  function tracePath(pts) {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  }

  function drawSnake(g, s, t, cell, now) {
    const prevSnake = g.prevById ? g.prevById.get(s.id) : null;
    const pts = snakePoints(s.body, prevSnake && prevSnake.alive ? prevSnake.body : null, t, cell);
    const colorIndex = g.colors.get(s.id) || 0;
    const color = COLORS[colorIndex] || '#ffffff';
    const light = LIGHT[colorIndex] || '#ffffff';
    const isMe = s.id === myId();
    const n = pts.length;

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Soft neon glow under the whole snake.
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = cell * 0.9;
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = color;
    ctx.lineWidth = cell * 0.5;
    tracePath(pts);
    ctx.stroke();
    ctx.restore();

    // Body, tapering towards the tail.
    ctx.strokeStyle = color;
    for (let i = n - 1; i > 0; i--) {
      const k = 1 - i / n;
      ctx.lineWidth = cell * (0.44 + 0.34 * k);
      ctx.beginPath();
      ctx.moveTo(pts[i][0], pts[i][1]);
      ctx.lineTo(pts[i - 1][0], pts[i - 1][1]);
      ctx.stroke();
    }

    // Highlight stripe.
    ctx.save();
    ctx.globalAlpha = 0.28;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = cell * 0.14;
    tracePath(pts);
    ctx.stroke();
    ctx.restore();

    // Head with eyes that follow the heading.
    const hx = pts[0][0];
    const hy = pts[0][1];
    ctx.fillStyle = light;
    ctx.beginPath();
    ctx.arc(hx, hy, cell * 0.47, 0, Math.PI * 2);
    ctx.fill();

    let dx = s.body[0] - s.body[2];
    let dy = s.body[1] - s.body[3];
    if (Math.abs(dx) + Math.abs(dy) !== 1) { dx = 1; dy = 0; }
    const sx = -dy;
    const sy = dx;
    for (const side of [-1, 1]) {
      const ex = hx + dx * cell * 0.13 + sx * side * cell * 0.19;
      const ey = hy + dy * cell * 0.13 + sy * side * cell * 0.19;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(ex, ey, cell * 0.12, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#05070d';
      ctx.beginPath();
      ctx.arc(ex + dx * cell * 0.05, ey + dy * cell * 0.05, cell * 0.06, 0, Math.PI * 2);
      ctx.fill();
    }

    if (isMe) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(1.5, cell * 0.08);
      ctx.beginPath();
      ctx.arc(hx, hy, cell * (0.6 + 0.04 * Math.sin(now / 180)), 0, Math.PI * 2);
      ctx.stroke();
    }

    drawLabel(g, s, hx, hy, cell, isMe, light);
  }

  function drawLabel(g, s, hx, hy, cell, isMe, light) {
    let name = g.names.get(s.id) || '?';
    if (name.length > 12) name = name.slice(0, 11) + '…';
    const text = name + ' · ' + s.score;
    const fontSize = Math.max(10, Math.round(cell * 0.52));
    ctx.font = '700 ' + fontSize + 'px "Trebuchet MS", "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(text).width;
    const x = Math.min(cssSize - w / 2 - 3, Math.max(w / 2 + 3, hx));
    let y = hy - cell * 1.0;
    if (y < fontSize) y = hy + cell * 1.05;
    ctx.lineJoin = 'round';
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(3,5,10,0.85)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = isMe ? '#ffffff' : light;
    ctx.fillText(text, x, y);
  }

  // ---------------------------------------------------------------------------
  // Input: keyboard, on-screen pad, swipe
  // ---------------------------------------------------------------------------

  const KEY_DIRS = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    w: 'up', W: 'up', s: 'down', S: 'down', a: 'left', A: 'left', d: 'right', D: 'right',
  };
  const CODE_DIRS = { KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right' };
  const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };

  /** Tell the server which way we want to turn. The server validates and applies it. */
  function sendDirection(dir) {
    const g = state.game;
    if (!g || !g.isPlayer || state.screen !== 'game' || !g.cur) return;
    if (!socket || !socket.connected || g.cur.phase !== 'playing') return;
    const mine = findSnake(g.cur, myId());
    if (!mine || !mine.alive) return;
    const reference = g.lastSentDir || mine.dir;
    if (dir === reference || dir === OPPOSITE[reference]) return; // no-op or impossible reversal
    g.lastSentDir = dir;
    g.lastSentAt = performance.now();
    socket.emit('game:input', { dir });
  }

  function setupInput() {
    window.addEventListener('keydown', (e) => {
      if (state.screen !== 'game') return;
      const tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const dir = KEY_DIRS[e.key] || CODE_DIRS[e.code];
      if (!dir) return;
      e.preventDefault();
      if (!e.repeat) sendDirection(dir);
    });

    document.querySelectorAll('.dpad-btn').forEach((btn) => {
      const release = () => btn.classList.remove('pressed');
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        btn.classList.add('pressed');
        sendDirection(btn.dataset.dir);
      });
      btn.addEventListener('pointerup', release);
      btn.addEventListener('pointercancel', release);
      btn.addEventListener('pointerleave', release);
      btn.addEventListener('contextmenu', (e) => e.preventDefault());
    });

    // Swipe anywhere on the arena. Chained swipes work without lifting the finger.
    const wrap = $('arena-wrap');
    const THRESHOLD = 24;
    let startX = 0;
    let startY = 0;
    let tracking = false;
    wrap.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      tracking = true;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      e.preventDefault();
    }, { passive: false });
    wrap.addEventListener('touchmove', (e) => {
      if (!tracking || e.touches.length !== 1) return;
      e.preventDefault();
      const x = e.touches[0].clientX;
      const y = e.touches[0].clientY;
      const dx = x - startX;
      const dy = y - startY;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < THRESHOLD) return;
      sendDirection(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
      startX = x;
      startY = y;
    }, { passive: false });
    const stop = () => { tracking = false; };
    wrap.addEventListener('touchend', stop);
    wrap.addEventListener('touchcancel', stop);

    $('screen-game').addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // ---------------------------------------------------------------------------
  // Start-up
  // ---------------------------------------------------------------------------

  function setupUi() {
    const savedName = safeGet(window.localStorage, NAME_KEY);
    if (savedName) $('player-name').value = savedName;

    // ?room=ABC123 invite links prefill the Room ID.
    const invited = new URLSearchParams(window.location.search).get('room');
    if (invited && /^[A-Za-z0-9]{6}$/.test(invited)) $('room-id').value = invited.toUpperCase();

    $('btn-create').addEventListener('click', onCreate);
    $('btn-join').addEventListener('click', onJoin);
    $('btn-ready').addEventListener('click', onReadyClick);
    $('btn-start').addEventListener('click', onStartClick);
    $('btn-leave').addEventListener('click', leaveRoom);
    $('btn-copy').addEventListener('click', onCopyClick);
    $('btn-share').addEventListener('click', onShareClick);
    $('duration').addEventListener('change', onDurationChange);
    $('btn-again').addEventListener('click', onPlayAgain);
    $('btn-back-lobby').addEventListener('click', onBackToLobby);
    $('btn-home').addEventListener('click', leaveRoom);
    $('btn-quit').addEventListener('click', () => {
      if (window.confirm('Leave this match?')) leaveRoom();
    });
    if (navigator.share) $('btn-share').classList.remove('hidden');

    $('room-id').addEventListener('input', (e) => {
      const clean = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (clean !== e.target.value) e.target.value = clean;
    });
    $('player-name').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      if ($('room-id').value.trim()) onJoin(); else onCreate();
    });
    $('room-id').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') onJoin();
    });
    $('player-name').addEventListener('input', () => showError('home-error', ''));
    $('room-id').addEventListener('input', () => showError('home-error', ''));

    window.addEventListener('resize', scheduleFit);
    window.addEventListener('orientationchange', () => setTimeout(scheduleFit, 250));
    if (typeof ResizeObserver === 'function') new ResizeObserver(scheduleFit).observe($('arena-wrap'));

    // Phones suspend timers in the background: reconnect as soon as the tab is visible again.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && socket && !socket.connected) socket.connect();
    });

    // Never show raw JavaScript errors to players.
    let lastErrorToast = 0;
    const generic = () => {
      const now = Date.now();
      if (now - lastErrorToast < 5000) return;
      lastErrorToast = now;
      toast('Something went wrong. If the game misbehaves, please reload the page.', 'error');
    };
    window.addEventListener('error', generic);
    window.addEventListener('unhandledrejection', generic);
  }

  setupUi();
  setupInput();
  initSocket();
})();

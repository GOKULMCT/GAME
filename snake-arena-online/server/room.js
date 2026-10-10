'use strict';

const { Game } = require('./game');
const { Player, COLORS } = require('./player');

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 8;
const DURATION_OPTIONS_SEC = [60, 120, 180, 300];

/** Error with a machine-readable code and a message that is safe to show to players. */
class RoomError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

class Room {
  /**
   * @param {string} id
   * @param {import('socket.io').Server} io
   * @param {object} [options]
   */
  constructor(id, io, options = {}) {
    this.id = id;
    this.io = io;
    this.durationMs = options.durationMs || 180000;
    this.tickMs = options.tickMs || 120;
    this.countdownStepMs = options.countdownStepMs || 1000;
    this.graceMs = options.graceMs != null ? options.graceMs : 20000;
    this.rng = options.rng || Math.random;
    this.onEmpty = options.onEmpty || (() => {});
    this.onMatchEnd = options.onMatchEnd || (() => {});

    this.players = new Map();
    this.nextPlayerNumber = 1;
    this.hostId = null;
    this.phase = 'lobby'; // 'lobby' | 'countdown' | 'playing'
    this.game = null;
    this.tickTimer = null;
    this.countdownTimer = null;
    this.countdownValue = null;
    this.lastResult = null;
    this.destroyed = false;
    this.createdAt = Date.now();
  }

  // ---- messaging ---------------------------------------------------------

  emit(event, payload) {
    this.io.to(this.id).emit(event, payload);
  }

  notice(type, message) {
    this.emit('room:notice', { type, message });
  }

  get connectedPlayers() {
    return [...this.players.values()].filter((p) => p.connected);
  }

  toPublic() {
    return {
      roomId: this.id,
      phase: this.phase,
      hostId: this.hostId,
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
      durationSec: Math.round(this.durationMs / 1000),
      durationOptions: DURATION_OPTIONS_SEC,
      players: [...this.players.values()].map((p) => p.toPublic(this.hostId)),
    };
  }

  broadcastState() {
    if (!this.destroyed) this.emit('room:state', this.toPublic());
  }

  syncPayload() {
    return {
      roomId: this.id,
      phase: this.phase,
      countdown: this.countdownValue,
      meta: this.game.getMeta(),
      state: this.game.getState(Date.now()),
    };
  }

  /** Bring a (re)connected socket up to date with the room and any running match. */
  sendSync(socket) {
    socket.emit('room:state', this.toPublic());
    if (this.game) socket.emit('game:init', this.syncPayload());
  }

  // ---- membership --------------------------------------------------------

  findByToken(token) {
    if (typeof token !== 'string') return null;
    for (const p of this.players.values()) {
      if (p.token === token) return p;
    }
    return null;
  }

  nameTaken(name) {
    const lower = name.toLowerCase();
    for (const p of this.players.values()) {
      if (p.name.toLowerCase() === lower) return true;
    }
    return false;
  }

  addPlayer(name, socket) {
    if (this.players.size >= MAX_PLAYERS) {
      throw new RoomError('ROOM_FULL', 'Room is full. Please join another room.');
    }
    if (this.phase !== 'lobby') {
      throw new RoomError(
        'GAME_IN_PROGRESS',
        'A match is in progress. Please try again when it ends.'
      );
    }
    if (this.nameTaken(name)) {
      throw new RoomError('NAME_TAKEN', 'That name is already used in this room. Pick another one.');
    }
    const used = new Set([...this.players.values()].map((p) => p.colorIndex));
    let colorIndex = 0;
    while (used.has(colorIndex) && colorIndex < COLORS.length - 1) colorIndex++;

    const player = new Player({
      id: `p${this.nextPlayerNumber++}`,
      name,
      colorIndex,
      socketId: socket.id,
    });
    this.players.set(player.id, player);
    socket.join(this.id);
    if (!this.hostId) this.hostId = player.id;
    // Tell everyone else; the new player already knows they joined.
    socket.to(this.id).emit('room:notice', { type: 'join', message: `${player.name} joined the room.` });
    this.broadcastState();
    return player;
  }

  /** Re-attach a player to a fresh socket after a dropped connection. */
  reconnect(player, socket) {
    clearTimeout(player.disconnectTimer);
    player.disconnectTimer = null;
    const wasConnected = player.connected;
    player.socketId = socket.id;
    player.connected = true;
    socket.join(this.id);
    if (!wasConnected) {
      socket.to(this.id).emit('room:notice', { type: 'reconnect', message: `${player.name} reconnected.` });
    }
    this._ensureHost();
    this.broadcastState();
  }

  markDisconnected(player) {
    if (!player.connected || !this.players.has(player.id)) return;
    player.connected = false;
    player.socketId = null;
    player.ready = false;
    this.notice('disconnect', `${player.name} disconnected.`);
    this._ensureHost();
    clearTimeout(player.disconnectTimer);
    player.disconnectTimer = setTimeout(() => this.removePlayer(player.id, 'timeout'), this.graceMs);
    this.broadcastState();
    this._abortCountdownIfShort();
  }

  removePlayer(playerId, reason = 'left') {
    const player = this.players.get(playerId);
    if (!player) return;
    clearTimeout(player.disconnectTimer);
    this.players.delete(playerId);

    if (this.game && this.game.hasPlayer(playerId)) {
      this._publishEvents(this.game.killPlayer(playerId, 'left', Date.now()));
    }

    this.notice(
      'leave',
      reason === 'timeout' ? `${player.name} was removed (connection lost).` : `${player.name} left the room.`
    );

    if (this.players.size === 0) {
      this.destroy();
      this.onEmpty(this);
      return;
    }
    this._ensureHost();
    this.broadcastState();
    this._abortCountdownIfShort();
    if (this.game && this.game.isOver()) this._finishGame();
  }

  // ---- lobby actions -----------------------------------------------------

  setReady(playerId, ready) {
    if (this.phase !== 'lobby') {
      throw new RoomError('INVALID_STATE', 'You can only change ready status in the lobby.');
    }
    const player = this.players.get(playerId);
    if (!player) throw new RoomError('NOT_IN_ROOM', 'You are not in this room.');
    player.ready = ready === true;
    this.broadcastState();
  }

  setDuration(requesterId, seconds) {
    if (requesterId !== this.hostId) {
      throw new RoomError('NOT_HOST', 'Only the host can change the match length.');
    }
    if (this.phase !== 'lobby') {
      throw new RoomError('INVALID_STATE', 'The match length can only be changed in the lobby.');
    }
    if (!DURATION_OPTIONS_SEC.includes(seconds)) {
      throw new RoomError('BAD_REQUEST', 'Invalid match length.');
    }
    this.durationMs = seconds * 1000;
    this.broadcastState();
  }

  /**
   * Start a match. The host needs at least MIN_PLAYERS connected players.
   * With requireReady every other player must also have pressed Ready.
   */
  startGame(requesterId, { requireReady = true } = {}) {
    if (requesterId !== this.hostId) {
      throw new RoomError('NOT_HOST', 'Only the host can start the game.');
    }
    if (this.phase !== 'lobby') {
      throw new RoomError('INVALID_STATE', 'A match is already running.');
    }
    const participants = this.connectedPlayers;
    if (participants.length < MIN_PLAYERS) {
      throw new RoomError('NOT_ENOUGH_PLAYERS', `At least ${MIN_PLAYERS} players are needed to start.`);
    }
    if (requireReady && participants.some((p) => p.id !== this.hostId && !p.ready)) {
      throw new RoomError('NOT_READY', 'Waiting for all players to be ready.');
    }

    this.game = new Game(
      participants.map((p) => ({ id: p.id, name: p.name, colorIndex: p.colorIndex })),
      { durationMs: this.durationMs, tickMs: this.tickMs, rng: this.rng }
    );
    this.phase = 'countdown';
    this.countdownValue = null;
    this.emit('game:init', this.syncPayload());
    this.broadcastState();
    this._runCountdown();
  }

  handleInput(playerId, dir) {
    if (!this.game || this.phase !== 'playing') return false;
    return this.game.setDirection(playerId, dir);
  }

  // ---- match flow --------------------------------------------------------

  _runCountdown() {
    let n = 3;
    const step = () => {
      if (this.phase !== 'countdown' || this.destroyed) return;
      this.countdownValue = n;
      this.emit('game:countdown', { n });
      if (n === 0) {
        this._beginPlay();
        return;
      }
      n -= 1;
      this.countdownTimer = setTimeout(step, this.countdownStepMs);
    };
    step();
  }

  _beginPlay() {
    const now = Date.now();
    this.phase = 'playing';
    this.game.beginPlay(now);
    this.emit('game:state', this.game.getState(now));
    this.broadcastState();
    this.tickTimer = setInterval(() => this._tick(), this.tickMs);
  }

  _tick() {
    if (!this.game || this.phase !== 'playing') return;
    const now = Date.now();
    let events;
    try {
      events = this.game.tick(now);
    } catch (err) {
      console.error(`[room ${this.id}] game tick failed:`, err);
      this._abortMatch('The match was stopped because of a server error.');
      return;
    }
    this.emit('game:state', this.game.getState(now));
    this._publishEvents(events);
    if (this.game.isOver()) this._finishGame();
  }

  _publishEvents(events) {
    const deaths = events.filter((e) => e.type === 'death');
    if (deaths.length) this.emit('game:events', deaths);
  }

  _finishGame() {
    if (!this.game) return;
    this._clearMatchTimers();
    const result = this.game.result || this.game.finish(Date.now(), 'time');
    this.game = null;
    this.phase = 'lobby';
    this.countdownValue = null;
    this.lastResult = result;
    for (const p of this.players.values()) p.ready = false;
    this._ensureHost();
    this.emit('game:over', { roomId: this.id, result });
    this.broadcastState();
    try {
      this.onMatchEnd(this, result);
    } catch (err) {
      console.error(`[room ${this.id}] onMatchEnd failed:`, err);
    }
  }

  _abortMatch(message) {
    this._clearMatchTimers();
    this.game = null;
    this.phase = 'lobby';
    this.countdownValue = null;
    for (const p of this.players.values()) p.ready = false;
    this._ensureHost();
    this.emit('game:aborted', { message });
    this.broadcastState();
  }

  _abortCountdownIfShort() {
    if (this.phase !== 'countdown' || !this.game) return;
    const stillHere = this.connectedPlayers.filter((p) => this.game.hasPlayer(p.id));
    if (stillHere.length < MIN_PLAYERS) {
      this._abortMatch('Not enough players. The match was cancelled.');
    }
  }

  _clearMatchTimers() {
    clearTimeout(this.countdownTimer);
    clearInterval(this.tickTimer);
    this.countdownTimer = null;
    this.tickTimer = null;
  }

  /** Make sure the host is a connected player; promote the next one if not. */
  _ensureHost() {
    const current = this.players.get(this.hostId);
    if (current && current.connected) return;
    const next = this.connectedPlayers[0] || current || [...this.players.values()][0] || null;
    if (!next) {
      this.hostId = null;
      return;
    }
    if (next.id !== this.hostId) {
      this.hostId = next.id;
      if (next.connected) this.notice('host', `${next.name} is now the host.`);
    }
  }

  destroy() {
    this.destroyed = true;
    this._clearMatchTimers();
    for (const p of this.players.values()) clearTimeout(p.disconnectTimer);
    this.game = null;
  }
}

module.exports = { Room, RoomError, MIN_PLAYERS, MAX_PLAYERS, DURATION_OPTIONS_SEC };

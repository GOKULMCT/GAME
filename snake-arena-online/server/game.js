'use strict';

/**
 * Authoritative Snake game engine.
 *
 * Pure game logic: no sockets, no timers. The Room drives it by calling
 * tick() at a fixed rate and forwarding player input to setDirection().
 * Clients never send positions, scores or collision results.
 */

const DIRS = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };

const MAX_SNAKES = 8;
const MAX_INPUT_QUEUE = 2;

const DEFAULTS = {
  width: 32,
  height: 32,
  durationMs: 3 * 60 * 1000,
  tickMs: 120,
  initialLength: 3,
  foodScore: 10,
  growthPerFood: 1,
  minFood: 3,
  maxFood: 10,
  rng: Math.random,
};

/**
 * Eight spawn points spread around the arena, every snake facing inward.
 * Columns and rows are staggered so snakes do not collide with each other
 * during the first moments of a match.
 */
function spawnSlots(width, height) {
  const m = 4; // distance from the wall
  const fx = (f) => Math.round(f * width);
  const fy = (f) => Math.round(f * height);
  return [
    { x: fx(0.22), y: m, dir: 'down' },
    { x: fx(0.78), y: height - 1 - m, dir: 'up' },
    { x: width - 1 - m, y: fy(0.22), dir: 'left' },
    { x: m, y: fy(0.78), dir: 'right' },
    { x: fx(0.62), y: m, dir: 'down' },
    { x: fx(0.38), y: height - 1 - m, dir: 'up' },
    { x: width - 1 - m, y: fy(0.62), dir: 'left' },
    { x: m, y: fy(0.38), dir: 'right' },
  ];
}

class Game {
  /**
   * @param {Array<{id:string,name:string,colorIndex:number}>} players
   * @param {object} [options]
   */
  constructor(players, options = {}) {
    this.opts = Object.assign({}, DEFAULTS, options);
    this.width = this.opts.width;
    this.height = this.opts.height;
    this.durationMs = this.opts.durationMs;
    this.tickMs = this.opts.tickMs;
    this.rng = this.opts.rng;

    this.phase = 'countdown'; // 'countdown' -> 'playing' -> 'over'
    this.tickCount = 0;
    this.startedAt = null;
    this.endsAt = null;
    this.endedAt = null;
    this.result = null;

    this.snakes = new Map();
    this.order = [];
    this.foods = [];

    const slots = spawnSlots(this.width, this.height);
    players.slice(0, MAX_SNAKES).forEach((p, index) => {
      const slot = slots[index];
      const d = DIRS[slot.dir];
      const body = [];
      for (let i = 0; i < this.opts.initialLength; i++) {
        body.push({ x: slot.x - d.x * i, y: slot.y - d.y * i });
      }
      this.snakes.set(p.id, {
        id: p.id,
        name: p.name,
        colorIndex: p.colorIndex,
        body,
        dir: slot.dir,
        queue: [],
        growth: 0,
        alive: true,
        score: 0,
        foodEaten: 0,
        deathReason: null,
        deathTick: null,
      });
      this.order.push(p.id);
    });

    this.foodTarget = Math.max(
      this.opts.minFood,
      Math.min(this.opts.maxFood, this.order.length + 2)
    );
    this._topUpFood();
  }

  hasPlayer(id) {
    return this.snakes.has(id);
  }

  beginPlay(now = Date.now()) {
    if (this.phase !== 'countdown') return;
    this.phase = 'playing';
    this.startedAt = now;
    this.endsAt = now + this.durationMs;
  }

  /**
   * Queue a direction change. Returns true when accepted.
   * Every queued direction is validated against the previous one, so a quick
   * double-tap such as UP then LEFT while moving RIGHT is legal (two valid
   * turns on two ticks) while a direct reversal never is.
   */
  setDirection(id, dir) {
    if (this.phase !== 'playing') return false;
    if (typeof dir !== 'string' || !Object.prototype.hasOwnProperty.call(DIRS, dir)) return false;
    const snake = this.snakes.get(id);
    if (!snake || !snake.alive) return false;
    const last = snake.queue.length ? snake.queue[snake.queue.length - 1] : snake.dir;
    if (dir === last || dir === OPPOSITE[last]) return false;
    if (snake.queue.length >= MAX_INPUT_QUEUE) return false;
    snake.queue.push(dir);
    return true;
  }

  /** Advance the simulation by one step. Returns a list of events. */
  tick(now = Date.now()) {
    const events = [];
    if (this.phase !== 'playing') return events;
    this.tickCount += 1;
    const W = this.width;
    const H = this.height;

    // 1. Decide every snake's direction and the cell its head moves into.
    const plan = [];
    for (const id of this.order) {
      const s = this.snakes.get(id);
      if (!s.alive) continue;
      while (s.queue.length) {
        const next = s.queue.shift();
        if (next !== OPPOSITE[s.dir]) {
          s.dir = next;
          break;
        }
      }
      const d = DIRS[s.dir];
      const head = { x: s.body[0].x + d.x, y: s.body[0].y + d.y };
      const ate = this.foods.some((f) => f.x === head.x && f.y === head.y);
      plan.push({ s, head, ate });
    }

    // 2. Move everybody at once.
    for (const p of plan) {
      const s = p.s;
      s.body.unshift(p.head);
      if (p.ate) s.growth += this.opts.growthPerFood;
      if (s.growth > 0) s.growth -= 1;
      else s.body.pop();
    }

    // 3. Collisions are resolved on the post-move board, so head-on crashes
    //    and simultaneous moves are fair to every player.
    const occupancy = new Map();
    for (const p of plan) {
      p.s.body.forEach((c, i) => {
        if (c.x < 0 || c.y < 0 || c.x >= W || c.y >= H) return;
        const key = c.y * W + c.x;
        let list = occupancy.get(key);
        if (!list) {
          list = [];
          occupancy.set(key, list);
        }
        list.push({ id: p.s.id, i });
      });
    }

    const dying = [];
    for (const p of plan) {
      const { x, y } = p.head;
      let reason = null;
      if (x < 0 || y < 0 || x >= W || y >= H) {
        reason = 'wall';
      } else {
        for (const o of occupancy.get(y * W + x)) {
          if (o.id === p.s.id) {
            if (o.i !== 0) reason = reason || 'self';
          } else if (o.i === 0) {
            reason = 'headon';
          } else {
            reason = reason || 'snake';
          }
        }
      }
      if (reason) dying.push({ s: p.s, reason });
    }
    for (const d of dying) this._kill(d.s, d.reason, events);

    // 4. Survivors that reached food score. The server computes all scores.
    const eaten = new Set();
    for (const p of plan) {
      if (!p.s.alive || !p.ate) continue;
      p.s.score += this.opts.foodScore;
      p.s.foodEaten += 1;
      eaten.add(p.head.y * W + p.head.x);
      events.push({ type: 'eat', id: p.s.id, score: p.s.score });
    }
    if (eaten.size) {
      this.foods = this.foods.filter((f) => !eaten.has(f.y * W + f.x));
    }
    this._topUpFood();

    // 5. End conditions.
    if (!this._anyAlive()) this.finish(now, 'all-dead');
    else if (now >= this.endsAt) this.finish(now, 'time');

    return events;
  }

  /** Remove a player's snake (disconnect timeout or leaving mid-match). */
  killPlayer(id, reason = 'left', now = Date.now()) {
    const s = this.snakes.get(id);
    if (!s || !s.alive) return [];
    const events = [];
    this._kill(s, reason, events);
    if (this.phase === 'playing' && !this._anyAlive()) this.finish(now, 'all-dead');
    return events;
  }

  finish(now = Date.now(), reason = 'time') {
    if (this.phase === 'over') return this.result;
    this.phase = 'over';
    this.endedAt = now;
    const ranking = this.getRanking();
    const top = ranking[0];
    const winners = top
      ? ranking.filter((r) => this._sameStanding(r, top)).map((r) => r.id)
      : [];
    this.result = {
      reason,
      draw: winners.length > 1,
      winners,
      ranking: ranking.map((r, i) => ({
        id: r.id,
        name: r.name,
        colorIndex: r.colorIndex,
        score: r.score,
        alive: r.alive,
        rank: i + 1,
      })),
    };
    return this.result;
  }

  isOver() {
    return this.phase === 'over';
  }

  /** Score first, then survivors, then whoever lasted longest, then join order. */
  getRanking() {
    const survival = (s) => (s.alive ? Infinity : s.deathTick);
    return this.order
      .map((id, index) => ({ s: this.snakes.get(id), index }))
      .sort((a, b) => {
        if (b.s.score !== a.s.score) return b.s.score - a.s.score;
        const sa = survival(a.s);
        const sb = survival(b.s);
        if (sa !== sb) return sb > sa ? 1 : -1;
        return a.index - b.index;
      })
      .map((e) => e.s);
  }

  getMeta() {
    return {
      width: this.width,
      height: this.height,
      tickMs: this.tickMs,
      durationMs: this.durationMs,
      players: this.order.map((id) => {
        const s = this.snakes.get(id);
        return { id, name: s.name, color: s.colorIndex };
      }),
    };
  }

  /** Compact snapshot sent to clients on every tick. Coordinates are flat arrays. */
  getState(now = Date.now()) {
    let timeLeftMs = this.durationMs;
    if (this.phase === 'playing') timeLeftMs = Math.max(0, this.endsAt - now);
    else if (this.phase === 'over') timeLeftMs = Math.max(0, this.endsAt - this.endedAt);

    const snakes = this.order.map((id) => {
      const s = this.snakes.get(id);
      const body = [];
      for (const c of s.body) body.push(c.x, c.y);
      return {
        id,
        alive: s.alive,
        score: s.score,
        dir: s.queue.length ? s.queue[s.queue.length - 1] : s.dir,
        body,
      };
    });
    const foods = [];
    for (const f of this.foods) foods.push(f.x, f.y);
    return { phase: this.phase, tick: this.tickCount, timeLeftMs, foods, snakes };
  }

  // ---- internals ---------------------------------------------------------

  _sameStanding(a, b) {
    return (
      a.score === b.score &&
      a.alive === b.alive &&
      (a.alive || a.deathTick === b.deathTick)
    );
  }

  _anyAlive() {
    for (const s of this.snakes.values()) if (s.alive) return true;
    return false;
  }

  _kill(s, reason, events) {
    if (!s.alive) return;
    s.alive = false;
    s.deathReason = reason;
    s.deathTick = this.tickCount;
    s.body = [];
    s.queue = [];
    events.push({ type: 'death', id: s.id, name: s.name, reason, score: s.score });
  }

  _topUpFood() {
    while (this.foods.length < this.foodTarget) {
      const cell = this._randomEmptyCell();
      if (!cell) break;
      this.foods.push(cell);
    }
  }

  /** Uniformly random cell that holds neither a snake nor food. */
  _randomEmptyCell() {
    const W = this.width;
    const H = this.height;
    const blocked = new Set();
    for (const s of this.snakes.values()) {
      for (const c of s.body) blocked.add(c.y * W + c.x);
    }
    for (const f of this.foods) blocked.add(f.y * W + f.x);
    const free = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!blocked.has(y * W + x)) free.push({ x, y });
      }
    }
    if (free.length === 0) return null;
    return free[Math.floor(this.rng() * free.length)];
  }
}

module.exports = { Game, DIRS, OPPOSITE, DEFAULTS, MAX_SNAKES, spawnSlots };

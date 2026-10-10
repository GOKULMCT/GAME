'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { Game, spawnSlots, MAX_SNAKES } = require('../server/game');
const { sanitizeName } = require('../server/player');

function makePlayers(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `Player${i + 1}`, colorIndex: i }));
}

/** Deterministic game with one snake placed exactly where a test wants it. */
function playing(players, opts = {}) {
  const game = new Game(players, { rng: () => 0.5, ...opts });
  game.beginPlay(0);
  return game;
}

function place(game, id, cells, dir) {
  const s = game.snakes.get(id);
  s.body = cells.map(([x, y]) => ({ x, y }));
  s.dir = dir;
  s.queue = [];
}

function clearFood(game) {
  game.foods = [];
  game.foodTarget = 0;
}

test('every player count from 2 to 8 spawns safely and survives the first ticks', () => {
  for (let n = 2; n <= MAX_SNAKES; n++) {
    const game = playing(makePlayers(n));
    for (let t = 1; t <= 8; t++) game.tick(t * 120);
    const alive = [...game.snakes.values()].filter((s) => s.alive).length;
    assert.equal(alive, n, `${n} players: all snakes should still be alive after 8 straight ticks`);
  }
});

test('spawn slots are unique and inside the arena', () => {
  const slots = spawnSlots(32, 32);
  assert.equal(slots.length, 8);
  const keys = new Set(slots.map((s) => `${s.x},${s.y}`));
  assert.equal(keys.size, 8);
  for (const s of slots) {
    assert.ok(s.x >= 0 && s.x < 32 && s.y >= 0 && s.y < 32);
  }
});

test('a snake moves one cell per tick in its direction', () => {
  const game = playing(makePlayers(2));
  clearFood(game);
  place(game, 'p1', [[10, 10], [9, 10], [8, 10]], 'right');
  game.tick(120);
  const s = game.snakes.get('p1');
  assert.deepEqual(s.body[0], { x: 11, y: 10 });
  assert.equal(s.body.length, 3);
});

test('direct reversal is rejected, valid turns are accepted', () => {
  const game = playing(makePlayers(2));
  clearFood(game);
  place(game, 'p1', [[10, 10], [9, 10], [8, 10]], 'right');
  assert.equal(game.setDirection('p1', 'left'), false);
  assert.equal(game.setDirection('p1', 'right'), false);
  assert.equal(game.setDirection('p1', 'up'), true);
  // Left right after Up is a legal second turn, but it must never reverse the snake on one tick.
  assert.equal(game.setDirection('p1', 'left'), true);
  game.tick(120);
  assert.deepEqual(game.snakes.get('p1').body[0], { x: 10, y: 9 });
  game.tick(240);
  assert.deepEqual(game.snakes.get('p1').body[0], { x: 9, y: 9 });
  assert.equal(game.snakes.get('p1').alive, true);
});

test('invalid directions and unknown players are ignored', () => {
  const game = playing(makePlayers(2));
  assert.equal(game.setDirection('p1', 'diagonal'), false);
  assert.equal(game.setDirection('p1', 42), false);
  assert.equal(game.setDirection('p1', '__proto__'), false);
  assert.equal(game.setDirection('nobody', 'up'), false);
});

test('input is ignored before the match starts', () => {
  const game = new Game(makePlayers(2), { rng: () => 0.5 });
  assert.equal(game.setDirection('p1', 'left'), false);
});

test('wall collision kills the snake', () => {
  const game = playing(makePlayers(2));
  clearFood(game);
  place(game, 'p1', [[31, 10], [30, 10], [29, 10]], 'right');
  const events = game.tick(120);
  assert.equal(game.snakes.get('p1').alive, false);
  assert.equal(game.snakes.get('p1').deathReason, 'wall');
  assert.ok(events.some((e) => e.type === 'death' && e.id === 'p1' && e.reason === 'wall'));
  assert.equal(game.snakes.get('p2').alive, true);
});

test('self collision kills the snake', () => {
  const game = playing(makePlayers(2));
  clearFood(game);
  // Head (10,10) moving left goes to (9,10): that is the tail cell, which moves away on the
  // same tick, so this is safe.
  place(game, 'p1', [[10, 10], [11, 10], [11, 11], [10, 11], [9, 11], [9, 10]], 'left');
  game.tick(120);
  assert.equal(game.snakes.get('p1').alive, true);

  // Here the head turns left into a segment in the middle of its own body.
  const g2 = playing(makePlayers(2));
  clearFood(g2);
  place(g2, 'p1', [[5, 5], [6, 5], [6, 6], [5, 6], [4, 6], [4, 5], [4, 4]], 'left');
  g2.tick(120); // head -> (4,5), which is body segment
  assert.equal(g2.snakes.get('p1').alive, false);
  assert.equal(g2.snakes.get('p1').deathReason, 'self');
});

test('hitting another snake body kills only the snake that ran into it', () => {
  const game = playing(makePlayers(2));
  clearFood(game);
  place(game, 'p1', [[10, 10], [9, 10], [8, 10]], 'right');
  place(game, 'p2', [[11, 8], [11, 9], [11, 10], [11, 11], [11, 12]], 'up');
  game.tick(120);
  // p2 moved up one (its body shifted), p1 head moves to (11,10) which p2 still occupies (index 2 after move).
  assert.equal(game.snakes.get('p1').alive, false);
  assert.equal(game.snakes.get('p1').deathReason, 'snake');
  assert.equal(game.snakes.get('p2').alive, true);
});

test('head-on collision kills both snakes', () => {
  const game = playing(makePlayers(2));
  clearFood(game);
  place(game, 'p1', [[10, 10], [9, 10], [8, 10]], 'right');
  place(game, 'p2', [[12, 10], [13, 10], [14, 10]], 'left');
  game.tick(120); // both heads land on (11,10)
  assert.equal(game.snakes.get('p1').alive, false);
  assert.equal(game.snakes.get('p2').alive, false);
  assert.equal(game.snakes.get('p1').deathReason, 'headon');
  assert.equal(game.isOver(), true);
});

test('following into the cell a tail just left is allowed', () => {
  const game = playing(makePlayers(2));
  clearFood(game);
  place(game, 'p1', [[10, 10], [9, 10], [8, 10]], 'right');
  place(game, 'p2', [[8, 9], [8, 8], [8, 7]], 'down');
  game.tick(120);
  assert.equal(game.snakes.get('p1').alive, true);
  assert.equal(game.snakes.get('p2').alive, true);
});

test('eating food grows the snake, adds score and spawns replacement food', () => {
  const game = playing(makePlayers(2));
  clearFood(game);
  game.foodTarget = 3;
  game.foods = [{ x: 11, y: 10 }];
  place(game, 'p1', [[10, 10], [9, 10], [8, 10]], 'right');
  place(game, 'p2', [[20, 20], [19, 20], [18, 20]], 'right');
  const events = game.tick(120);
  const s = game.snakes.get('p1');
  assert.equal(s.body.length, 4);
  assert.equal(s.score, 10);
  assert.ok(events.some((e) => e.type === 'eat' && e.id === 'p1'));
  assert.equal(game.foods.length, 3);
  // The eaten food is gone and the replacement is not under any snake.
  const occupied = new Set();
  for (const sn of game.snakes.values()) for (const c of sn.body) occupied.add(`${c.x},${c.y}`);
  for (const f of game.foods) assert.ok(!occupied.has(`${f.x},${f.y}`));
});

test('food never spawns inside a snake or on other food', () => {
  let seed = 12345;
  const rng = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const game = playing(makePlayers(8), { rng });
  for (let i = 0; i < 300; i++) {
    game._topUpFood();
    const occupied = new Set();
    for (const s of game.snakes.values()) for (const c of s.body) occupied.add(`${c.x},${c.y}`);
    const seen = new Set();
    for (const f of game.foods) {
      const k = `${f.x},${f.y}`;
      assert.ok(!occupied.has(k), 'food inside a snake');
      assert.ok(!seen.has(k), 'duplicate food');
      seen.add(k);
    }
    game.foods.shift();
  }
});

test('scores only change through eating food inside the engine', () => {
  const game = playing(makePlayers(2));
  clearFood(game);
  place(game, 'p1', [[10, 10], [9, 10], [8, 10]], 'right');
  place(game, 'p2', [[20, 20], [19, 20], [18, 20]], 'right');
  // The only input the engine accepts is a direction; there is no way to pass a score in.
  assert.equal(game.setDirection('p1', 'down'), true);
  assert.equal(game.setDirection.length, 2);
  for (let t = 1; t <= 5; t++) game.tick(t * 120);
  assert.equal(game.getState(600).snakes[0].score, 0);
});

test('timer ends the match and the highest score wins', () => {
  const game = playing(makePlayers(3), { durationMs: 1000 });
  clearFood(game);
  place(game, 'p1', [[10, 10], [9, 10], [8, 10]], 'right');
  place(game, 'p2', [[10, 20], [9, 20], [8, 20]], 'right');
  place(game, 'p3', [[10, 25], [9, 25], [8, 25]], 'right');
  game.snakes.get('p1').score = 30;
  game.snakes.get('p2').score = 50;
  game.snakes.get('p3').score = 20;
  game.tick(500);
  assert.equal(game.isOver(), false);
  game.tick(1000);
  assert.equal(game.isOver(), true);
  assert.equal(game.result.reason, 'time');
  assert.deepEqual(game.result.winners, ['p2']);
  assert.equal(game.result.draw, false);
  assert.deepEqual(game.result.ranking.map((r) => r.id), ['p2', 'p1', 'p3']);
});

test('equal scores: the survivor beats a snake that died', () => {
  const game = playing(makePlayers(2), { durationMs: 1000 });
  clearFood(game);
  place(game, 'p1', [[10, 10], [9, 10], [8, 10]], 'right');
  place(game, 'p2', [[31, 20], [30, 20], [29, 20]], 'right');
  game.snakes.get('p1').score = 20;
  game.snakes.get('p2').score = 20;
  game.tick(120); // p2 hits the wall
  game.tick(1000);
  assert.deepEqual(game.result.winners, ['p1']);
});

test('identical standings are reported as a draw', () => {
  const game = playing(makePlayers(2), { durationMs: 500 });
  clearFood(game);
  place(game, 'p1', [[10, 10], [9, 10], [8, 10]], 'right');
  place(game, 'p2', [[10, 20], [9, 20], [8, 20]], 'right');
  game.tick(600);
  assert.equal(game.result.draw, true);
  assert.deepEqual(game.result.winners.sort(), ['p1', 'p2']);
});

test('the match ends early when every snake is dead', () => {
  const game = playing(makePlayers(2));
  clearFood(game);
  place(game, 'p1', [[31, 10], [30, 10], [29, 10]], 'right');
  place(game, 'p2', [[0, 20], [1, 20], [2, 20]], 'left');
  game.tick(120);
  assert.equal(game.isOver(), true);
  assert.equal(game.result.reason, 'all-dead');
});

test('killPlayer removes a snake (disconnect / leave) and the others carry on', () => {
  const game = playing(makePlayers(3));
  const events = game.killPlayer('p2', 'left', 100);
  assert.equal(events.length, 1);
  assert.equal(game.snakes.get('p2').alive, false);
  assert.equal(game.isOver(), false);
  assert.deepEqual(game.killPlayer('p2', 'left', 100), []);
});

test('state snapshots use compact flat arrays', () => {
  const game = playing(makePlayers(2));
  const st = game.getState(0);
  assert.equal(st.phase, 'playing');
  assert.equal(st.snakes.length, 2);
  assert.equal(st.snakes[0].body.length, 6); // 3 segments * (x,y)
  assert.equal(st.foods.length % 2, 0);
  assert.equal(st.timeLeftMs, game.durationMs);
});

test('player names are validated and cannot carry HTML or script', () => {
  assert.equal(sanitizeName('Gokul').ok, true);
  assert.equal(sanitizeName('  Player  2 ').value, 'Player 2');
  assert.equal(sanitizeName('Zoë_99').ok, true);
  assert.equal(sanitizeName('').ok, false);
  assert.equal(sanitizeName('   ').ok, false);
  assert.equal(sanitizeName(null).ok, false);
  assert.equal(sanitizeName({}).ok, false);
  assert.equal(sanitizeName('<script>alert(1)</script>').ok, false);
  assert.equal(sanitizeName('"><img src=x onerror=alert(1)>').ok, false);
  assert.equal(sanitizeName("Bob'); DROP TABLE").ok, false);
  assert.equal(sanitizeName('A'.repeat(17)).ok, false);
  assert.equal(sanitizeName('A'.repeat(16)).ok, true);
  assert.equal(sanitizeName('a‮b').value, 'ab');
});

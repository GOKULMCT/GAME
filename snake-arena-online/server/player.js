'use strict';

const crypto = require('crypto');

const MAX_NAME_LENGTH = 16;

// One colour per slot. The server owns the palette so every client agrees on it.
const COLORS = [
  { name: 'Green', hex: '#39ff14' },
  { name: 'Blue', hex: '#2d9bff' },
  { name: 'Yellow', hex: '#ffe600' },
  { name: 'Red', hex: '#ff3b3b' },
  { name: 'Purple', hex: '#b64dff' },
  { name: 'Orange', hex: '#ff8c1a' },
  { name: 'Cyan', hex: '#00f0ff' },
  { name: 'Pink', hex: '#ff4fd8' },
];

// Control characters, zero-width characters and bidi overrides.
const INVISIBLE_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
// Letters/digits first, then letters, digits, space, underscore, dot or hyphen.
// This rules out <, >, &, quotes and every other character used for HTML/JS injection.
const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} _.\-]*$/u;

function sanitizeName(raw) {
  if (typeof raw !== 'string') {
    return { ok: false, message: 'Please enter a player name.' };
  }
  if (raw.length > 200) {
    return { ok: false, message: `Name must be ${MAX_NAME_LENGTH} characters or fewer.` };
  }
  const cleaned = raw.normalize('NFC').replace(INVISIBLE_CHARS, '').replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) {
    return { ok: false, message: 'Please enter a player name.' };
  }
  if (Array.from(cleaned).length > MAX_NAME_LENGTH) {
    return { ok: false, message: `Name must be ${MAX_NAME_LENGTH} characters or fewer.` };
  }
  if (!NAME_PATTERN.test(cleaned)) {
    return {
      ok: false,
      message: 'Name can only contain letters, numbers, spaces and the characters _ - .',
    };
  }
  return { ok: true, value: cleaned };
}

class Player {
  /**
   * @param {object} init
   * @param {string} init.id         Public id (safe to show to other players)
   * @param {string} init.name       Already sanitised name
   * @param {number} init.colorIndex Index into COLORS
   * @param {string} init.socketId   Current Socket.IO connection id
   */
  constructor({ id, name, colorIndex, socketId }) {
    this.id = id;
    // Secret used to prove identity when resuming after a dropped connection.
    this.token = crypto.randomBytes(16).toString('hex');
    this.name = name;
    this.colorIndex = colorIndex;
    this.socketId = socketId;
    this.ready = false;
    this.connected = true;
    this.joinedAt = Date.now();
    this.disconnectTimer = null;
  }

  toPublic(hostId) {
    const isHost = this.id === hostId;
    return {
      id: this.id,
      name: this.name,
      color: this.colorIndex,
      colorName: COLORS[this.colorIndex].name,
      // The host never needs to press Ready.
      ready: isHost ? true : this.ready,
      connected: this.connected,
      isHost,
    };
  }
}

module.exports = { Player, COLORS, MAX_NAME_LENGTH, sanitizeName };

// Join and leave lines in the channel chat. Offline. Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { channelLabel, enterEvent, moveEvent, leaveEvent, type EventPart } from '../src/chat-events.js';

// The line as the page shows it, with the bold parts in *stars*.
const text = (parts: EventPart[] | null) => parts === null ? null : parts.map((p) => typeof p === 'string' ? p : `*${p.b}*`).join('');

test('channelLabel: a spacer\'s tag is left out, other names stay as they are', () => {
  assert.equal(channelLabel('[cspacer1]AFK'), 'AFK');
  assert.equal(channelLabel('[*spacer0]-=-'), '-=-');
  assert.equal(channelLabel('Gaming'), 'Gaming');
  assert.equal(channelLabel('[spacer3]'), '[spacer3]', 'an empty spacer keeps its name');
  assert.equal(channelLabel(undefined), 'another channel');
});

test('someone comes into our channel', () => {
  const base = { who: 'Alex', self: false, intoHere: true, from: 'AFK', to: 'Lobby' };
  assert.equal(text(moveEvent({ ...base, reason: 0 })), '*Alex* joined coming from *AFK*');
  assert.equal(text(moveEvent({ ...base, reason: 1, invoker: 'Sam' })), '*Alex* was moved here from *AFK* by *Sam*');
  assert.equal(text(enterEvent('Alex')), '*Alex* connected');
  assert.equal(text(enterEvent('Alex', 'Gaming')), '*Alex* joined coming from *Gaming*');
});

test('someone leaves our channel or the server', () => {
  const base = { who: 'Alex', self: false, intoHere: false, from: 'Lobby', to: 'Gaming' };
  assert.equal(text(moveEvent({ ...base, reason: 0 })), '*Alex* left to *Gaming*');
  assert.equal(text(moveEvent({ ...base, reason: 1, invoker: 'Sam' })), '*Alex* was moved to *Gaming* by *Sam*');
  assert.equal(text(moveEvent({ ...base, reason: 4, invoker: 'Sam', reasonMsg: 'too loud' })), '*Alex* was kicked from the channel by *Sam* (too loud)');
  assert.equal(text(leaveEvent('Alex', false, 8, undefined, 'good night')), '*Alex* disconnected (good night)');
  assert.equal(text(leaveEvent('Alex', false, 8)), '*Alex* disconnected');
  assert.equal(text(leaveEvent('Alex', false, 3)), '*Alex* lost connection');
  assert.equal(text(leaveEvent('Alex', false, 5, 'Sam')), '*Alex* was kicked from the server by *Sam*');
  assert.equal(text(leaveEvent('Alex', false, 6, 'Sam', 'spam')), '*Alex* was banned by *Sam* (spam)');
  assert.equal(leaveEvent('Alex', false, 11), null, 'the server shutting down: no line');
});

test('it happens to us', () => {
  const base = { who: 'Jamie', self: true, intoHere: false, from: 'Lobby', to: 'AFK' };
  assert.equal(moveEvent({ ...base, reason: 0 }), null, 'our own switch: no line');
  assert.equal(text(moveEvent({ ...base, reason: 1, invoker: 'Sam' })), 'You were moved to *AFK* by *Sam*');
  assert.equal(text(moveEvent({ ...base, reason: 4, invoker: 'Sam', reasonMsg: 'afk' })), 'You were kicked from *Lobby* by *Sam* (afk)');
  assert.equal(text(leaveEvent('Jamie', true, 5, 'Sam')), 'You were kicked from the server by *Sam*');
  assert.equal(leaveEvent('Jamie', true, 8), null);
});

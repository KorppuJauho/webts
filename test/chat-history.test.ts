// Chat history across days. Offline (npm test).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ChatHistoryStore, conversationKey, historyFileName, historyWanted, openHistory, parseHistoryKey,
    sealHistory, trimHistory, type HistoryEntry } from '../src/chat-history.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 14, 18, 0);
const KEY = crypto.randomBytes(32);
const line = (id: string, at: number, cid = 5): HistoryEntry => ({ id, time: at, targetmode: 2, cid, msg: `hello ${id}` });
const tempDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'chat-history-'));
const quiet = () => {};

test('the switch and the key', () => {
  assert.equal(historyWanted('on'), true);
  assert.equal(historyWanted(' TRUE '), true);
  assert.equal(historyWanted(undefined), false);
  assert.equal(historyWanted('off'), false);
  const key = crypto.randomBytes(32);
  assert.deepEqual(parseHistoryKey(key.toString('base64')), key);
  assert.deepEqual(parseHistoryKey(key.toString('base64url')), key);
  assert.equal(parseHistoryKey(crypto.randomBytes(16).toString('base64')), null, 'too short');
  assert.equal(parseHistoryKey('not a key'), null);
  assert.equal(parseHistoryKey(undefined), null);
});

test('conversations and file names', () => {
  assert.equal(conversationKey({ targetmode: 2, cid: 7 }), '7');
  assert.equal(conversationKey({ targetmode: 1, partnerUid: 'abc=' }), 'pm:abc=');
  assert.equal(conversationKey({ targetmode: 2, cid: 0 }), null, 'no channel');
  assert.equal(conversationKey({ targetmode: 3 }), null, 'server chat is not kept');
  assert.equal(historyFileName('user:2'), 'user-2.json');
  assert.match(historyFileName('alice@example.com'), /^p-[0-9a-f]{32}\.json$/, 'an email is not on disk');
  assert.match(historyFileName('public:a1b2c3'), /^p-[0-9a-f]{32}\.json$/, "a browser's id is not on disk");
  assert.match(historyFileName('../../etc'), /^p-[0-9a-f]{32}\.json$/);
});

test('30 days, 300 lines per conversation, the most recent conversations', () => {
  const history = {
    '5': [line('old', NOW - 31 * DAY), line('monday', NOW - 2 * DAY)],
    '6': Array.from({ length: 310 }, (_, i) => line(`n${i}`, NOW - 1000 + i, 6)),
    '7': [line('gone', NOW - 40 * DAY, 7)]
  };
  const trimmed = trimHistory(history, NOW);
  assert.deepEqual(trimmed['5'].map((e) => e.id), ['monday']);
  assert.equal(trimmed['6'].length, 300);
  assert.equal(trimmed['6'][0].id, 'n10', 'the oldest went');
  assert.equal(trimmed['7'], undefined, 'an empty conversation goes');
  const many = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [String(i + 1), [line(`c${i}`, NOW - i * 1000, i + 1)]]));
  assert.deepEqual(Object.keys(trimHistory(many, NOW, 30, 300, 3)).sort(), ['1', '2', '3']);
});

test('locked: opens only with the same key and for the same person, and nothing in it can be changed', () => {
  const history = { '5': [line('a', NOW)] };
  const sealed = sealHistory(KEY, 'user:2', history);
  assert.ok(!sealed.includes('hello'), 'no chat text in the file');
  assert.deepEqual(openHistory(KEY, 'user:2', sealed), history);
  assert.throws(() => openHistory(crypto.randomBytes(32), 'user:2', sealed), 'another key');
  assert.throws(() => openHistory(KEY, 'user:3', sealed), 'another person');
  const box = JSON.parse(sealed);
  const data = Buffer.from(box.data, 'base64');
  data[0] ^= 1;
  assert.throws(() => openHistory(KEY, 'user:2', JSON.stringify({ ...box, data: data.toString('base64') })), 'changed');
  assert.notEqual(sealHistory(KEY, 'user:2', history), sealed, 'a fresh IV every time');
});

test('the store: kept across connections and bridge restarts', async () => {
  const dir = await tempDir();
  let store = new ChatHistoryStore(dir, KEY, { now: () => NOW, log: quiet });
  assert.equal(await store.prepare(), true);
  assert.deepEqual(await store.open('user:2'), []);
  store.add('user:2', line('monday', NOW - 2 * DAY));
  store.add('user:2', { id: 'pm', time: NOW - DAY, targetmode: 1, partnerUid: 'u1', msg: 'hi there' });
  store.add('user:2', { id: 'server', time: NOW, targetmode: 3, msg: 'not kept' });
  await store.release('user:2');
  const file = await fs.readFile(path.join(dir, 'user-2.json'), 'utf8');
  // Whole phrases with a space: the locked file is base64 (no spaces), where a short word like "hi" turns up by chance.
  assert.ok(!file.includes('hello monday') && !file.includes('hi there'), 'locked on disk');

  store = new ChatHistoryStore(dir, KEY, { now: () => NOW, log: quiet }); // the bridge restarted
  assert.deepEqual((await store.open('user:2')).map((e) => e.id), ['monday', 'pm']);
  assert.deepEqual(await store.open('user:3'), [], 'each person has their own');
  await fs.rm(dir, { recursive: true });
});

test('the store: lines are written together a little later, and right away at disconnect', async () => {
  const dir = await tempDir();
  const store = new ChatHistoryStore(dir, KEY, { now: () => NOW, log: quiet, writeDelayMs: 20 });
  await store.open('user:2');
  store.add('user:2', line('a', NOW));
  store.add('user:2', line('b', NOW));
  await assert.rejects(fs.access(path.join(dir, 'user-2.json')), 'not yet');
  await new Promise((r) => setTimeout(r, 60));
  const fresh = new ChatHistoryStore(dir, KEY, { now: () => NOW, log: quiet });
  assert.deepEqual((await fresh.open('user:2')).map((e) => e.id), ['a', 'b']);
  await fs.rm(dir, { recursive: true });
});

test('the store: a file that does not open is left exactly as it is', async () => {
  const dir = await tempDir();
  const other = new ChatHistoryStore(dir, crypto.randomBytes(32), { now: () => NOW, log: quiet });
  await other.open('user:2');
  other.add('user:2', line('a', NOW));
  await other.release('user:2');
  const before = await fs.readFile(path.join(dir, 'user-2.json'), 'utf8');

  const logs: string[] = [];
  const store = new ChatHistoryStore(dir, KEY, { now: () => NOW, log: (l) => logs.push(l) });
  assert.deepEqual(await store.open('user:2'), []);
  store.add('user:2', line('b', NOW));
  await store.release('user:2');
  assert.equal(await fs.readFile(path.join(dir, 'user-2.json'), 'utf8'), before, 'not written over');
  assert.ok(logs.some((l) => /doesn't open/.test(l)), logs.join('\n'));
  await fs.rm(dir, { recursive: true });
});

test('the store: two connections of one person share one history', async () => {
  const dir = await tempDir();
  const store = new ChatHistoryStore(dir, KEY, { now: () => NOW, log: quiet });
  await store.open('user:2');
  await store.open('user:2'); // the new device, before the old one has gone
  store.add('user:2', line('a', NOW));
  await store.release('user:2'); // the old device goes
  store.add('user:2', line('b', NOW));
  await store.release('user:2');
  const fresh = new ChatHistoryStore(dir, KEY, { now: () => NOW, log: quiet });
  assert.deepEqual((await fresh.open('user:2')).map((e) => e.id), ['a', 'b']);
  await fs.rm(dir, { recursive: true });
});

test('sweep: files untouched for 30 days and half-written files go, nothing else', async () => {
  const dir = await tempDir();
  const old = new Date(NOW - 31 * DAY);
  for (const name of ['user-1.json', 'user-2.json', 'user-3.json.tmp', 'notes.txt']) await fs.writeFile(path.join(dir, name), '{}');
  await fs.utimes(path.join(dir, 'user-1.json'), old, old);
  await fs.utimes(path.join(dir, 'user-3.json.tmp'), old, old);
  await fs.utimes(path.join(dir, 'notes.txt'), old, old);
  const store = new ChatHistoryStore(dir, KEY, { now: () => NOW, log: quiet });
  assert.equal(await store.sweep(), 2);
  assert.deepEqual((await fs.readdir(dir)).sort(), ['notes.txt', 'user-2.json']);
  await fs.rm(dir, { recursive: true });
});

// "Connect anywhere" (src/any-server.ts): reading an address, refusing private ones, the lookups and the try limit.
// Favourites too. Offline: the DNS answers come from stand-ins.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAddress, addressText, isPrivateAddress, parseAllowList, resolveServer, TryLimit, ServerAddressError,
  type Resolver } from '../src/any-server.js';
import { cleanFavorites, FavoritesStore, FAVORITES_MAX } from '../src/favorites.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

test('parseAddress: names, IPs and ports as people type them', () => {
  assert.deepEqual(parseAddress('TeamSpeak.Server.net'), { host: 'teamspeak.server.net', ip: 0 });
  assert.deepEqual(parseAddress(' 44.43.32.1:8887 '), { host: '44.43.32.1', port: 8887, ip: 4 });
  assert.deepEqual(parseAddress('[2001:db8::1]:9987'), { host: '2001:db8::1', port: 9987, ip: 6 });
  assert.deepEqual(parseAddress('2001:db8::1'), { host: '2001:db8::1', ip: 6 });
  for (const bad of ['', '44.434.32.1', 'ts.example.com:0', 'ts.example.com:70000', 'http://ts.example.com', 'a b',
    '-bad.example.com', 'ts..example.com', '[nope]:9987', 42, null]) {
    assert.equal(parseAddress(bad), null, String(bad));
  }
});

test('addressText: as shown and remembered, the default port left out', () => {
  assert.equal(addressText({ host: 'ts.example.com', port: 9987 }), 'ts.example.com');
  assert.equal(addressText({ host: 'ts.example.com', port: 8887 }), 'ts.example.com:8887');
  assert.equal(addressText({ host: '2001:db8::1', port: 9988 }), '[2001:db8::1]:9988');
});

test('private and reserved addresses are refused, the internet is not', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.5', '192.168.1.10', '100.64.0.1', '169.254.1.1', '0.0.0.0',
    '224.0.0.1', '255.255.255.255', '::1', '::', 'fd12::1', 'fe80::1', '::ffff:192.168.1.10', '::ffff:c0a8:010a']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['44.43.32.1', '8.8.8.8', '2606:4700::1111', '::ffff:8.8.8.8']) assert.equal(isPrivateAddress(ip), false, ip);
});

const dns = (srv: Record<string, { name: string; port: number }[]>, hosts: Record<string, string[]>): Resolver => ({
  srv: async (name) => { if (!srv[name]) throw new Error('ENODATA'); return srv[name].map((r) => ({ ...r, priority: 0, weight: 0 })); },
  lookup: async (host) => { if (!hosts[host]) throw new Error('ENOTFOUND'); return hosts[host].map((address) => ({ address, family: address.includes(':') ? 6 : 4 })); },
});
const none = parseAllowList('');

test('resolveServer: a name\'s _ts3._udp record first, then the name; a typed port wins', async () => {
  const r = dns({ '_ts3._udp.ts.example.com': [{ name: 'voice.example.net.', port: 9988 }] },
    { 'voice.example.net': ['44.43.32.9'], 'ts.example.com': ['44.43.32.1'] });
  assert.deepEqual(await resolveServer('ts.example.com', none, r), { id: 'addr:ts.example.com', name: 'ts.example.com', host: '44.43.32.9', port: 9988 });
  assert.deepEqual(await resolveServer('ts.example.com:8887', none, r), { id: 'addr:ts.example.com:8887', name: 'ts.example.com:8887', host: '44.43.32.1', port: 8887 });
  assert.deepEqual(await resolveServer('44.43.32.1', none, r), { id: 'addr:44.43.32.1', name: '44.43.32.1', host: '44.43.32.1', port: 9987 });
});

test('resolveServer: private addresses are refused, also behind a name, unless allowed on purpose', async () => {
  const r = dns({}, { 'sneaky.example.com': ['192.168.1.10'], 'mixed.example.com': ['10.0.0.1', '44.43.32.2'], teamspeak: ['172.20.0.3'] });
  await assert.rejects(resolveServer('192.168.1.10', none, r), (e: any) => e instanceof ServerAddressError && /private/.test(e.message));
  await assert.rejects(resolveServer('sneaky.example.com', none, r), /private/);
  assert.equal((await resolveServer('mixed.example.com', none, r)).host, '44.43.32.2', 'the public one of its addresses');
  await assert.rejects(resolveServer('nowhere.example.com', none, r), /No server found/);
  await assert.rejects(resolveServer('not an address', none, r), /isn't a server address/);
  const allow = parseAllowList('192.168.1.0/24, teamspeak');
  assert.equal((await resolveServer('192.168.1.10', allow, r)).host, '192.168.1.10');
  assert.equal((await resolveServer('sneaky.example.com', allow, r)).host, '192.168.1.10');
  assert.equal((await resolveServer('teamspeak', allow, r)).host, '172.20.0.3', 'an allowed name');
  assert.throws(() => parseAllowList('10.0.0.0/99'), /ALLOW_SERVERS/);
});

test('TryLimit: at most 10 different servers an hour; the same one again is fine', () => {
  const limit = new TryLimit(10, 3_600_000);
  for (let i = 0; i < 10; i++) assert.equal(limit.allow('alex', `s${i}`, 0), true);
  assert.equal(limit.allow('alex', 's10', 1000), false);
  assert.equal(limit.allow('alex', 's3', 1000), true, 'one tried already');
  assert.equal(limit.allow('sam', 's10', 1000), true, 'per person');
  assert.equal(limit.allow('alex', 's10', 3_600_001), true, 'an hour later');
});

test('favourites: cleaned, no duplicates, only one connects automatically, never more than the limit', () => {
  assert.deepEqual(cleanFavorites([
    { address: 'TS.Example.com:9987', name: '  Friends ', auto: true },
    { address: 'ts.example.com', name: 'again' },
    { address: '44.43.32.1:8887', auto: true, password: 'never kept' },
  ]), [
    { address: 'ts.example.com', name: 'Friends', auto: true },
    { address: '44.43.32.1:8887', name: '', auto: false },
  ]);
  assert.equal(cleanFavorites([{ address: 'not an address!' }]), null);
  assert.equal(cleanFavorites('nope'), null);
  assert.equal(cleanFavorites(Array.from({ length: FAVORITES_MAX + 1 }, (_, i) => ({ address: `s${i}.example.com` }))), null);
});

test('favourites: kept per person in one file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'webts-fav-'));
  const store = new FavoritesStore(path.join(dir, 'favorites.json'));
  await store.set('pub:a', [{ address: 'ts.example.com', name: 'A', auto: true }]);
  await store.set('pub:b', [{ address: '44.43.32.1', name: '', auto: false }]);
  assert.deepEqual(await store.get('pub:a'), [{ address: 'ts.example.com', name: 'A', auto: true }]);
  assert.deepEqual(await new FavoritesStore(path.join(dir, 'favorites.json')).get('pub:b'), [{ address: '44.43.32.1', name: '', auto: false }]);
  await store.set('pub:a', []);
  assert.deepEqual(await store.get('pub:a'), []);
  await fs.rm(dir, { recursive: true, force: true });
});

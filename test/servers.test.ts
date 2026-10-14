// The server list (src/servers.ts): servers.json, its checks, and which server a connection gets. Offline.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseServers, pickServer, publicServer, serverFromSettings } from '../src/servers.js';

const two = JSON.stringify({
  servers: [
    { id: 'friends', name: 'Friends', host: 'ts.example.com', password: 'secret', defaultChannel: 'Lobby' },
    { id: 'club', name: 'Club', host: '10.0.0.5', port: 9988, filePort: 30035 },
  ],
});

test('servers.json: each server with its defaults; a plain list works too', () => {
  const list = parseServers(two);
  assert.deepEqual(list, [
    { id: 'friends', name: 'Friends', host: 'ts.example.com', port: 9987, password: 'secret', defaultChannel: 'Lobby' },
    { id: 'club', name: 'Club', host: '10.0.0.5', port: 9988, filePort: 30035 },
  ]);
  assert.equal(parseServers(JSON.stringify([{ id: 'a', name: 'A', host: 'h' }])).length, 1);
});

test('servers.json: mistakes stop WebTS with a message that says what is wrong', () => {
  const bad = (servers: unknown, why: RegExp) => assert.throws(() => parseServers(JSON.stringify({ servers })), why);
  assert.throws(() => parseServers('{ nope'), /isn't valid JSON/);
  bad([], /at least one server/);
  bad([{ name: 'A', host: 'h' }], /server 1: "id" is missing/);
  bad([{ id: 'a b', name: 'A', host: 'h' }], /may only have letters/);
  bad([{ id: 'a', name: 'A', host: 'h' }, { id: 'a', name: 'B', host: 'h' }], /used twice/);
  bad([{ id: 'a', name: 'A', host: 'h', port: 70000 }], /"port" must be a port number/);
  bad([{ id: 'a', name: 'A', host: 'http://h' }], /"host" must be a host name/);
  bad([{ id: 'a', host: 'h' }], /"name" is missing/);
});

test('the page learns only ids and names, never addresses or passwords', () => {
  assert.deepEqual(parseServers(two).map(publicServer), [{ id: 'friends', name: 'Friends' }, { id: 'club', name: 'Club' }]);
});

test('which server a connection gets', () => {
  const list = parseServers(two);
  assert.equal(pickServer(list, 'club')?.id, 'club');
  assert.equal(pickServer(list, 'elsewhere'), null, 'an unknown choice is refused, not swapped');
  assert.equal(pickServer(list, undefined), null, 'with several, the page must say');
  const one = [serverFromSettings({ host: 'h', port: 9987, filePort: 0 })];
  assert.equal(pickServer(one, undefined)?.id, 'main', 'with one, it needn\'t');
  assert.equal(pickServer(one, 'main')?.id, 'main');
  assert.equal(pickServer(one, 'from-an-earlier-list')?.id, 'main', "with one, a remembered old choice doesn't matter");
  assert.deepEqual(one[0], { id: 'main', name: 'TeamSpeak', host: 'h', port: 9987 });
});

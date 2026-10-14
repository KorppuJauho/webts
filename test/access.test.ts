// Who gets in (src/access.ts): the four access modes. Offline: Cloudflare Access's keys come from a stand-in.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createAccess, verifyAccessToken, verifyNote, signNote, nameFrom, cookieValue, PUBLIC_COOKIE } from '../src/access.js';

const TEAM = 'myteam.cloudflareaccess.com';
const AUD = 'a'.repeat(64);
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: 'jwk' }) as object), kid: 'key-1', alg: 'RS256', use: 'sig' };
const fakeFetch = (async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })) as typeof fetch;

function token(claims: Record<string, unknown>, opts: { kid?: string; alg?: string; key?: crypto.KeyObject } = {}) {
  const head = Buffer.from(JSON.stringify({ alg: opts.alg ?? 'RS256', kid: opts.kid ?? 'key-1', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), opts.key ?? privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
}
const now = Date.now();
const good = { aud: [AUD], iss: `https://${TEAM}`, email: 'Alex@Example.com', exp: Math.floor(now / 1000) + 600 };

test('cloudflare-access: a token signed by the team, for this application, in date is let in', async () => {
  assert.deepEqual(await verifyAccessToken(token(good), TEAM, AUD, now, fakeFetch), { key: 'cf:alex@example.com', name: 'alex' });
});

test('cloudflare-access: wrong audience, issuer, expiry, signature or algorithm is refused', async () => {
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  for (const [what, t] of [
    ['another application', token({ ...good, aud: ['b'.repeat(64)] })],
    ['another team', token({ ...good, iss: 'https://evil.cloudflareaccess.com' })],
    ['expired', token({ ...good, exp: Math.floor(now / 1000) - 5 })],
    ['signed by someone else', token(good, { key: other })],
    ['an unknown key', token(good, { kid: 'nope' })],
    ['alg none', token(good, { alg: 'none' })],
    ['garbage', 'a.b.c'],
    ['empty', ''],
  ] as const) {
    assert.equal(await verifyAccessToken(t, TEAM, AUD, now, fakeFetch), null, what);
  }
});

const req = (headers: Record<string, string>) => ({ headers } as unknown as IncomingMessage);
const baseConfig = {
  accessMode: 'header', accessHeader: 'remote-user', accessNameHeader: '', noteSecret: '', noteHeader: 'x-webts-note',
  cfAccessTeamDomain: TEAM, cfAccessAud: AUD, publicUrl: '',
} as any;

test('header: the login proxy\'s user header names the person; without it nobody', async () => {
  const access = createAccess({ ...baseConfig, accessMode: 'header', accessNameHeader: 'remote-name' });
  assert.deepEqual(await access.identify(req({ 'remote-user': 'Robin', 'remote-name': 'Robin Example' })), { key: 'hdr:robin', name: 'Robin Example' });
  assert.equal(await access.identify(req({})), null);
});

test('signed-note: a note from your own gateway, signed with the shared secret, valid for a minute', async () => {
  const secret = 's'.repeat(40);
  const access = createAccess({ ...baseConfig, accessMode: 'signed-note', noteSecret: secret });
  const note = signNote({ id: 7, name: 'Sam' }, secret);
  assert.deepEqual(await access.identify(req({ 'x-webts-note': note })), { key: 'user:7', name: 'Sam' });
  assert.equal(await access.identify(req({ 'x-webts-note': signNote({ id: 7, name: 'Sam' }, 'x'.repeat(40)) })), null, 'wrong secret');
  assert.equal(verifyNote(signNote({ id: 7, name: 'Sam' }, secret, now - 120_000), secret, now), null, 'expired');
  assert.equal(await access.identify(req({})), null);
});

test('public: each browser gets its own id in a cookie, set by the bridge when the page loads', async () => {
  const access = createAccess({ ...baseConfig, accessMode: 'public', publicUrl: 'https://webts.example.com' });
  const headers: Record<string, string> = {};
  const res = { setHeader: (k: string, v: string) => { headers[k] = v; } } as unknown as ServerResponse;
  access.ensurePublicCookie(req({}), res);
  assert.match(headers['Set-Cookie'], new RegExp(`^${PUBLIC_COOKIE}=[A-Za-z0-9_-]{32}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax; Secure$`));
  const id = cookieValue(headers['Set-Cookie'].split(';')[0], PUBLIC_COOKIE)!;
  assert.deepEqual(await access.identify(req({ cookie: `${PUBLIC_COOKIE}=${id}` })), { key: `pub:${id}`, name: 'Guest' });
  const again: Record<string, string> = {};
  access.ensurePublicCookie(req({ cookie: `${PUBLIC_COOKIE}=${id}` }), { setHeader: (k: string, v: string) => { again[k] = v; } } as any);
  assert.equal(again['Set-Cookie'], undefined, 'kept, not replaced');
  assert.equal(await access.identify(req({ cookie: `${PUBLIC_COOKIE}=../../x` })), null, 'a made-up id is refused');
});

test('nameFrom: the part before @, at most 30 characters', () => {
  assert.equal(nameFrom('alex@example.com'), 'alex');
  assert.equal(nameFrom('x'.repeat(40)).length, 30);
  assert.equal(nameFrom(''), 'Guest');
});

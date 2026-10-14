// The protocol encryption's per-generation keys (src/tslib/crypto.ts). The TeamSpeak server bumps its per-type
// generation each time its 16-bit packet id wraps, and a packet sealed at one generation can only be opened at that
// generation; client.ts retries with generation + 1 on a decrypt failure. These tests pin that premise.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveKeyNonce, eaxEncrypt, eaxDecrypt } from '../src/tslib/crypto.js';

const iv = Buffer.alloc(20, 0xab); // fixed shared-secret layout for a deterministic test
const packetId = 100;
const packetType = 2; // Command

test('a different key and nonce for each generation', () => {
  const g0 = deriveKeyNonce(true, packetId, 0, packetType, iv);
  const g1 = deriveKeyNonce(true, packetId, 1, packetType, iv);
  assert.equal(g0.key.equals(g1.key), false);
  assert.equal(g0.nonce.equals(g1.nonce), false);
});

test('a packet sealed at generation 1 fails at generation 0 and opens at generation 1', () => {
  const header = Buffer.from([0x00, 0x64, 0x02]); // an arbitrary server-to-client header (associated data)
  const plaintext = Buffer.from('notifyclientmoved clid=7 ctid=3', 'utf8');
  const g1 = deriveKeyNonce(true, packetId, 1, packetType, iv);
  const { ciphertext, mac } = eaxEncrypt(g1.key, g1.nonce, header, plaintext);
  const g0 = deriveKeyNonce(true, packetId, 0, packetType, iv);
  assert.equal(eaxDecrypt(g0.key, g0.nonce, header, ciphertext, mac), null);
  const recovered = eaxDecrypt(g1.key, g1.nonce, header, ciphertext, mac);
  assert.ok(recovered && recovered.equals(plaintext));
});

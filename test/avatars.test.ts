// Profile pictures (src/avatars.ts): the checks on a picture the page sends, the myTeamSpeak
// address rule and WebTS's own copy. Offline. Run: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { AvatarStore, avatarFlag, checkAvatar, imageSize, myTeamSpeakAvatarUrl, shouldUploadSaved } from '../src/avatars.js';

function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

function jpeg(width: number, height: number): Buffer {
  const seg = (marker: number, data: Buffer) => Buffer.concat([Buffer.from([0xff, marker, (data.length + 2) >> 8, (data.length + 2) & 0xff]), data]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
    seg(0xdb, Buffer.alloc(65, 1)),
    seg(0xc0, Buffer.from([8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0])),
    seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
    Buffer.from([0x12, 0x34, 0xff, 0xd9]),
  ]);
}

test('the flag is the file\'s MD5', () => {
  assert.equal(avatarFlag(Buffer.from('hello')), '5d41402abc4b2a76b9719d911017c592');
});

test('picture sizes are read from PNG and JPEG headers', () => {
  assert.deepEqual(imageSize(png(300, 200)), { width: 300, height: 200 });
  assert.deepEqual(imageSize(jpeg(320, 229)), { width: 320, height: 229 });
  assert.equal(imageSize(Buffer.from('GIF89a......')), null);
});

test('a profile picture must be a JPEG or PNG inside 320×320', () => {
  assert.deepEqual(checkAvatar(png(320, 240)), { ext: 'png' });
  assert.deepEqual(checkAvatar(jpeg(229, 320)), { ext: 'jpg' });
  assert.ok('error' in checkAvatar(png(321, 100)));
  assert.ok('error' in checkAvatar(jpeg(100, 400)));
  assert.ok('error' in checkAvatar(Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1')));
  assert.ok('error' in checkAvatar(Buffer.alloc(0)));
  assert.ok('error' in checkAvatar(Buffer.concat([png(10, 10), Buffer.alloc(600 * 1024)])));
});

test('only myTeamSpeak\'s own picture address is accepted', () => {
  const url = 'https://storage.googleapis.com/ts-sys-myts-avatars/591eb29f-af0c-40bc-b53b-844a3f6a1e80/1722796975';
  assert.equal(myTeamSpeakAvatarUrl(`2,${url}`), url);
  assert.equal(myTeamSpeakAvatarUrl(url), url);
  assert.equal(myTeamSpeakAvatarUrl(''), '');
  assert.equal(myTeamSpeakAvatarUrl('2,https://example.com/ts-sys-myts-avatars/a/1'), '');
  assert.equal(myTeamSpeakAvatarUrl('2,https://storage.googleapis.com/other-bucket/a/1'), '');
  assert.equal(myTeamSpeakAvatarUrl('2,https://storage.googleapis.com/ts-sys-myts-avatars/../x/1'), '');
  assert.equal(myTeamSpeakAvatarUrl('2,http://storage.googleapis.com/ts-sys-myts-avatars/a/1'), '');
  assert.equal(myTeamSpeakAvatarUrl(`2,${url}?x=1`), '');
});

test('the saved copy: set, read, where it went, and removed', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'webts-avatars-'));
  try {
    const store = new AvatarStore(dir);
    const picture = png(64, 64);
    const flag = await store.set('alex@example.com', picture, 'png', 'main');
    assert.equal(flag, avatarFlag(picture));
    const saved = await store.get('alex@example.com');
    assert.ok(saved && saved.data.equals(picture));
    assert.deepEqual(saved!.servers, { main: flag });

    // A new store (a restart) reads the same from disk.
    const again = await new AvatarStore(dir).get('alex@example.com');
    assert.ok(again && again.data.equals(picture));

    // A JPEG replaces the PNG: one file stays.
    await store.set('alex@example.com', jpeg(32, 32), 'jpg', 'main');
    assert.deepEqual((await readdir(dir)).filter((f) => !f.startsWith('index')).length, 1);

    await store.markUploaded('alex@example.com', 'other', 'abc');
    assert.equal((await store.get('alex@example.com'))!.servers.other, 'abc');

    await store.remove('alex@example.com');
    assert.equal(await store.get('alex@example.com'), null);
    assert.deepEqual((await readdir(dir)).filter((f) => !f.startsWith('index')), []);
    assert.equal(await store.get('nobody'), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a saved picture goes only to a server it never went to, where none is shown', () => {
  const saved = { file: 'x.png', flag: 'f1', servers: { main: 'f1' } };
  assert.equal(shouldUploadSaved(saved, 'other', ''), true);
  assert.equal(shouldUploadSaved(saved, 'main', ''), false);       // removed there: not put back
  assert.equal(shouldUploadSaved(saved, 'other', 'abc'), false);   // already has one there
  assert.equal(shouldUploadSaved(null, 'other', ''), false);
});

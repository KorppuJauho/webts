// Pictures in the chat (public/chat-pictures.js): the hidden details come off, the picture itself stays byte for
// byte, and TeamSpeak's picture lines are found. Offline. Run: npm run test:talk
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('../public/chat-pictures.js', import.meta.url), 'utf8');
const ctx = vm.createContext({});
const P = vm.runInContext(`${code}
;({ PICTURE_MAX_BYTES, pictureKind, jpegOrientation, stripJpegMetadata, stripPngMetadata, stripWebpMetadata,
    preparePicture, channelPictures, channelPictureUrl })`, ctx);
const plain = (v) => JSON.parse(JSON.stringify(v)); // objects from the test's own realm, for deepEqual
const hasText = (bytes, text) => Buffer.from(bytes).includes(Buffer.from(text, 'latin1'));

// --- A JPEG as phones write it ---
const seg = (marker, data) => Buffer.concat([Buffer.from([0xff, marker, (data.length + 2) >> 8, (data.length + 2) & 0xff]), data]);
function exifBlock(orientation, little = true) {
  const w16 = (v) => (little ? [v & 0xff, v >> 8] : [v >> 8, v & 0xff]);
  const w32 = (v) => (little ? [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24] : [v >>> 24, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]);
  const tiff = [...(little ? [0x49, 0x49] : [0x4d, 0x4d]), ...w16(42), ...w32(8),
    ...w16(2),
    ...w16(0x010f), ...w16(2), ...w32(4), 0x41, 0x43, 0x4d, 0x00,              // Make "ACM"
    ...w16(0x0112), ...w16(3), ...w32(1), ...w16(orientation), 0, 0,          // Orientation
    ...w32(0)];
  return Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.from(tiff), Buffer.from('GPS 60.1699N 24.9384E serial 1234', 'latin1')]);
}
const picture = Buffer.concat([
  seg(0xdb, Buffer.alloc(65, 1)),                                            // quantisation table
  seg(0xc0, Buffer.from([8, 0, 16, 0, 16, 1, 1, 0x11, 0])),                  // frame 16x16
  seg(0xc4, Buffer.from([0, 0xff, 0xd9, 0, 0, 0])),                          // a table that happens to hold FF D9
  seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),                               // scan
  Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0xff, 0xd9]), // coded data, a restart, fill, end
]);
function phoneJpeg(orientation, little) {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe1, exifBlock(orientation, little)),
    seg(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
    seg(0xe2, Buffer.from('ICC_PROFILE\0\x01\x01colour', 'latin1')),
    seg(0xe2, Buffer.from('MPF\0 offsets to the extra picture', 'latin1')),
    seg(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>GPS 60.17</x:xmpmeta>', 'latin1')),
    seg(0xed, Buffer.from('Photoshop 3.0\0 IPTC city Springfield', 'latin1')),
    seg(0xfe, Buffer.from('a comment', 'latin1')),
    seg(0xee, Buffer.from('Adobe\0\x64\0\0\0\0\x01', 'latin1')),
    picture,
    // an extra picture after the end (e.g. a gain map), with details of its own
    Buffer.from([0xff, 0xd8]), seg(0xe1, exifBlock(1)), Buffer.from([0xff, 0xd9]),
  ]);
}

test('JPEG: GPS, camera, XMP, IPTC, comments and anything after the picture come off; the picture stays byte for byte', () => {
  const original = phoneJpeg(6, true);
  const out = Buffer.from(P.stripJpegMetadata(new Uint8Array(original)));
  for (const secret of ['GPS', 'serial', 'ACM', 'Springfield', 'a comment', 'xmpmeta', 'MPF']) assert.ok(!hasText(out, secret), secret);
  assert.ok(out.subarray(-picture.length).equals(picture), 'the coded picture and its tables unchanged, ending at its end marker');
  assert.ok(hasText(out, 'ICC_PROFILE') && hasText(out, 'JFIF') && hasText(out, 'Adobe'), 'colour information kept');
  assert.deepEqual([...out.subarray(0, 2)], [0xff, 0xd8]);
  assert.equal(out[2], 0xff);
  assert.equal(out[3], 0xe1, 'a new EXIF block right after the start…');
  assert.equal(P.jpegOrientation(out.subarray(6, 4 + 0x22)), 6, '…with the same turn, so the photo stays upright');
  assert.ok(out.length < original.length);
});

test('JPEG: a big-endian EXIF block is read too; an upright photo gets no EXIF block at all', () => {
  assert.equal(P.jpegOrientation(new Uint8Array(exifBlock(8, false))), 8);
  const out = Buffer.from(P.stripJpegMetadata(new Uint8Array(phoneJpeg(1, false))));
  assert.ok(!hasText(out, 'Exif'));
  assert.ok(out.subarray(-picture.length).equals(picture));
});

test('JPEG: a broken file is refused (null), so it is saved again instead of sent with its details', () => {
  const original = phoneJpeg(6, true);
  const scanAt = original.indexOf(Buffer.from([0xff, 0xda]));
  assert.equal(P.stripJpegMetadata(new Uint8Array(original.subarray(0, scanAt + 12))), null, 'cut off in the middle');
  assert.equal(P.stripJpegMetadata(new Uint8Array(Buffer.from([0xff, 0xd8, 0x00, 0x01]))), null);
});

// --- PNG ---
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.from([1, 2, 3, 4])]);
};
test('PNG: text, time and EXIF chunks come off; the rest stays in order', () => {
  const ihdr = chunk('IHDR', Buffer.alloc(13, 2));
  const idat = chunk('IDAT', Buffer.from('pixels'));
  const iend = chunk('IEND', Buffer.alloc(0));
  const original = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), ihdr, chunk('tEXt', Buffer.from('Comment\0GPS')),
    chunk('eXIf', Buffer.from('MM serial')), chunk('tIME', Buffer.alloc(7)), idat, iend]);
  const out = Buffer.from(P.stripPngMetadata(new Uint8Array(original)));
  assert.ok(out.equals(Buffer.concat([original.subarray(0, 8), ihdr, idat, iend])));
});

// --- WebP ---
test('WebP: EXIF and XMP chunks and their flags come off, and the RIFF size is right', () => {
  const riff = (type, data) => {
    const size = Buffer.alloc(4);
    size.writeUInt32LE(data.length);
    return Buffer.concat([Buffer.from(type, 'latin1'), size, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  };
  const vp8x = riff('VP8X', Buffer.from([0x08 | 0x04 | 0x10, 0, 0, 0, 1, 0, 0, 1, 0, 0]));
  const image = riff('VP8L', Buffer.from('pixel'));
  const body = Buffer.concat([vp8x, image, riff('EXIF', Buffer.from('GPS 60.1')), riff('XMP ', Buffer.from('<x>GPS</x>'))]);
  const head = Buffer.from('RIFF\0\0\0\0WEBP', 'latin1');
  head.writeUInt32LE(body.length + 4, 4);
  const out = Buffer.from(P.stripWebpMetadata(new Uint8Array(Buffer.concat([head, body]))));
  assert.ok(!hasText(out, 'GPS'));
  assert.equal(out.readUInt32LE(4), out.length - 8);
  assert.equal(out[20], 0x10, 'only the "has alpha" flag is left');
  assert.ok(out.subarray(-image.length).equals(image));
});

test('pictureKind: by the bytes', () => {
  assert.equal(P.pictureKind(new Uint8Array(phoneJpeg(1))), 'jpeg');
  assert.equal(P.pictureKind(new Uint8Array(Buffer.from('GIF89a'))), 'gif');
  assert.equal(P.pictureKind(new Uint8Array(Buffer.from('<svg>'))), null);
});

test('preparePicture: a GIF goes as it is (at most 15 MB), a JPEG without its details, an unknown format gets a clear error', async () => {
  const file = (bytes) => ({ arrayBuffer: async () => new Uint8Array(bytes).buffer });
  const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(100, 9)]);
  assert.ok(Buffer.from(await P.preparePicture(file(gif))).equals(gif));
  const bigGif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(P.PICTURE_MAX_BYTES)]);
  await assert.rejects(P.preparePicture(file(bigGif)), /GIFs can be at most 15 MB/);
  const jpeg = await P.preparePicture(file(phoneJpeg(6)));
  assert.ok(!hasText(jpeg, 'GPS'));
  ctx.createImageBitmap = async () => { throw new Error('unsupported'); };
  await assert.rejects(P.preparePicture(file(Buffer.from('ftypheic....'))), /format isn't supported/);
});

test('channelPictures: TeamSpeak picture lines become pictures; the rest stays text', () => {
  const line = '[img]ts3image://2026-10-12_18-35-01_a7k3f9.jpg?channel=1&path=/webTS[/img]';
  assert.deepEqual(plain(P.channelPictures(line)),
    { pictures: [{ cid: 1, path: '/webTS', name: '2026-10-12_18-35-01_a7k3f9.jpg' }], rest: '' });
  assert.deepEqual(plain(P.channelPictures('look [IMG]TS3IMAGE://IMG_4388.jpeg?channel=4&path=/webTS/[/IMG] and this')),
    { pictures: [{ cid: 4, path: '/webTS/', name: 'IMG_4388.jpeg' }], rest: 'look  and this' });
  assert.deepEqual(plain(P.channelPictures('[img]ts3image://teamspeak.jpg?channel=4&path=[/img]')).pictures,
    [{ cid: 4, path: '/', name: 'teamspeak.jpg' }], 'the owner\'s example with an empty path: the files\' top level');
  assert.equal(P.channelPictures('[img]ts3image://x.jpg?path=/[/img]').pictures.length, 0, 'no channel: stays text');
  assert.equal(P.channelPictures('[img]ts3image://a/b.jpg?channel=1[/img]').pictures.length, 0, 'no folders in the name');
  assert.deepEqual(plain(P.channelPictures('just text')), { pictures: [], rest: 'just text' });
  assert.equal(P.channelPictureUrl({ cid: 1, path: '/webTS', name: 'a b&c.jpg' }), '/channel-image?cid=1&path=%2FwebTS&name=a%20b%26c.jpg');
});

// Pictures in the chat (2026-10-12): the file transfer against a stand-in TeamSpeak server, and the picture rules.
// Offline. Run in this folder: npx tsx --test test/pictures.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { parseCommand } from '../src/tslib/commands.js';
import { createDirectory, uploadFile, downloadFile, FileTransferError } from '../src/tslib/filetransfer.js';
import { imageType, channelImageRef, pictureName, pictureMessage, PictureCache, IMAGE_MAX_BYTES,
  iconId, iconFileName, avatarFileNames, iconType, groupIds } from '../src/pictures.js';

// A stand-in for the server: a TCP port for the bytes, and a client whose commands it answers like TeamSpeak.
async function fakeServer(answer: (cmd: ReturnType<typeof parseCommand>, port: number) => string[]) {
  const received: Buffer[] = [];
  const keys: string[] = [];
  let download: Buffer = Buffer.alloc(0);
  const tcp = net.createServer((socket) => {
    let key = '';
    const parts: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => {
      if (key.length < 8) {
        const need = 8 - key.length;
        key += chunk.subarray(0, need).toString('ascii');
        chunk = chunk.subarray(need);
        if (key.length === 8) {
          keys.push(key);
          if (key.startsWith('down')) socket.end(download);
        }
      }
      if (chunk.length) parts.push(chunk);
    });
    socket.on('end', () => {
      received.push(Buffer.concat(parts));
      socket.end();
    });
  });
  await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', r));
  const port = (tcp.address() as net.AddressInfo).port;
  const sent: string[] = [];
  const client = new (class extends EventEmitter {
    sendCommand(cmd: string) {
      sent.push(cmd);
      for (const line of answer(parseCommand(cmd), port)) setImmediate(() => this.emit('command', parseCommand(line)));
    }
  })();
  return { client, sent, received, keys, port, setDownload: (b: Buffer) => { download = b; }, close: () => tcp.close() };
}

test('a folder: made, or already there; a refusal is an error with its code', async () => {
  const s = await fakeServer((cmd) => {
    if (cmd.params.dirname === '/webTS') return [`error id=2050 msg=file\\salready\\sexists return_code=${cmd.params.return_code}`];
    return [`error id=2568 msg=insufficient\\sclient\\spermissions return_code=${cmd.params.return_code}`];
  });
  await createDirectory(s.client, 4, '/webTS');
  assert.match(s.sent[0], /^ftcreatedir cid=4 cpw= dirname=\\\/webTS return_code=ft-\d+$/);
  await assert.rejects(createDirectory(s.client, 4, '/other'), (e: any) => e instanceof FileTransferError && e.code === 2568);
  s.close();
});

test('upload: asks, then sends the key and the bytes to the port it was given', async () => {
  const s = await fakeServer((cmd, port) => cmd.name === 'ftinitupload'
    ? [`notifystartupload clientftfid=${cmd.params.clientftfid} serverftfid=7 ftkey=upkey123 port=${port} seekpos=0 proto=1`,
       `error id=0 msg=ok return_code=${cmd.params.return_code}`]
    : []);
  const data = Buffer.from('a picture '.repeat(50000));
  await uploadFile(s.client, '127.0.0.1', 1, '/webTS/x.jpg', data);
  assert.match(s.sent[0], new RegExp(`^ftinitupload clientftfid=\\d+ name=\\\\/webTS\\\\/x.jpg cid=1 cpw= size=${data.length} overwrite=0 resume=0 return_code=ft-\\d+$`));
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(s.keys, ['upkey123']);
  assert.ok(s.received[0].equals(data), 'the server got exactly the file');
  s.close();
});

test('upload refused (no permission): the error carries TeamSpeak\'s code, and nothing is sent', async () => {
  const s = await fakeServer((cmd) => [`error id=2568 msg=insufficient\\sclient\\spermissions failed_permid=12 return_code=${cmd.params.return_code}`]);
  await assert.rejects(uploadFile(s.client, '127.0.0.1', 1, '/webTS/x.jpg', Buffer.from('x')),
    (e: any) => e instanceof FileTransferError && e.code === 2568);
  assert.equal(s.keys.length, 0);
  s.close();
});

test('download: the file\'s bytes; a file over the limit is stopped before reading', async () => {
  const file = Buffer.alloc(300000, 7);
  const s = await fakeServer((cmd, port) => cmd.name === 'ftinitdownload'
    ? [`notifystartdownload clientftfid=${cmd.params.clientftfid} serverftfid=9 ftkey=downkey1 port=${port} size=${cmd.params.name.includes('big') ? 99999999 : file.length}`]
    : []);
  s.setDownload(file);
  const got = await downloadFile(s.client, '127.0.0.1', 1, '/webTS/x.jpg', 1000000);
  assert.ok(got.equals(file));
  assert.match(s.sent[0], /^ftinitdownload clientftfid=\d+ name=\\\/webTS\\\/x.jpg cid=1 cpw= seekpos=0 return_code=ft-\d+$/);
  await assert.rejects(downloadFile(s.client, '127.0.0.1', 1, '/big.jpg', 1000000), /too big/);
  assert.match(s.sent.at(-1)!, /^ftstop serverftfid=9 delete=0$/);
  s.close();
});

test('a status refusal (e.g. file not found) for this transfer ends it', async () => {
  const s = await fakeServer((cmd) => [`notifystatusfiletransfer clientftfid=${cmd.params.clientftfid} status=2051 msg=file\\snot\\sfound`]);
  await assert.rejects(downloadFile(s.client, '127.0.0.1', 1, '/nope.jpg', 1000), (e: any) => e.code === 2051);
  s.close();
});

test('the TeamSpeak connection closing ends a waiting transfer', async () => {
  const s = await fakeServer(() => []);
  const waiting = downloadFile(s.client, '127.0.0.1', 1, '/x.jpg', 1000);
  s.client.emit('disconnected');
  await assert.rejects(waiting, /closed/);
  s.close();
});

test('imageType: the bytes decide, never the name; no SVG', () => {
  assert.equal(imageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))?.mime, 'image/jpeg');
  assert.equal(imageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))?.ext, 'png');
  assert.equal(imageType(Buffer.from('GIF89a...'))?.ext, 'gif');
  assert.equal(imageType(Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 '))?.ext, 'webp');
  assert.equal(imageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>')), null);
  assert.equal(imageType(Buffer.from('<html>')), null);
  assert.equal(imageType(Buffer.alloc(0)), null);
});

test('channelImageRef: inside the channel\'s files only', () => {
  assert.deepEqual(channelImageRef({ cid: '1', path: '/webTS', name: 'IMG_4388.jpeg' }), { cid: 1, fullPath: '/webTS/IMG_4388.jpeg' });
  assert.deepEqual(channelImageRef({ cid: '1', path: '/webTS/', name: 'a.jpg' }), { cid: 1, fullPath: '/webTS/a.jpg' });
  assert.deepEqual(channelImageRef({ cid: '4', path: '/', name: 'teamspeak.jpg' }), { cid: 4, fullPath: '/teamspeak.jpg' });
  assert.deepEqual(channelImageRef({ cid: '4', name: 'root.jpg' }), { cid: 4, fullPath: '/root.jpg' });
  for (const bad of [
    { cid: '0', path: '/', name: 'a.jpg' }, { cid: 'x', path: '/', name: 'a.jpg' }, { cid: '1.5', path: '/', name: 'a.jpg' },
    { cid: '1', path: '/../other', name: 'a.jpg' }, { cid: '1', path: '/webTS', name: '../a.jpg' },
    { cid: '1', path: '/webTS', name: '..' }, { cid: '1', path: 'webTS', name: 'a.jpg' },
    { cid: '1', path: '/web\\TS', name: 'a.jpg' }, { cid: '1', path: '/', name: '' }, { cid: '1', path: '/', name: 'a\nb.jpg' },
    { cid: '1', path: ['/', '/x'], name: 'a.jpg' }, { cid: '1', path: '/', name: 'x'.repeat(151) },
  ]) assert.equal(channelImageRef(bad as any), null, JSON.stringify(bad));
});

test('pictureName and pictureMessage: local time, a plain name, the line the TeamSpeak app shows', () => {
  const name = pictureName({ ext: 'jpg', mime: 'image/jpeg' }, 'a7K3f9', new Date('2026-10-12T15:35:01Z'), 'Europe/Helsinki'); // UTC+3 in October
  assert.equal(name, '2026-10-12_18-35-01_a7k3f9.jpg');
  assert.equal(pictureMessage(name, 1), '[img]ts3image://2026-10-12_18-35-01_a7k3f9.jpg?channel=1&path=/webTS[/img]');
  assert.equal(IMAGE_MAX_BYTES, 15 * 1024 * 1024);
});

test('PictureCache: oldest out beyond the size limit, and entries expire', () => {
  const cache = new PictureCache(100, 1000);
  cache.set('a', Buffer.alloc(40), 0);
  cache.set('b', Buffer.alloc(40), 0);
  assert.ok(cache.get('a', 10)); // a is now the newest
  cache.set('c', Buffer.alloc(40), 10);
  assert.equal(cache.get('b', 10), undefined, 'b was the oldest');
  assert.ok(cache.get('a', 10) && cache.get('c', 10));
  assert.equal(cache.size, 80);
  assert.equal(cache.get('a', 2000), undefined, 'expired');
  assert.equal(cache.size, 40);
  cache.set('huge', Buffer.alloc(101), 0);
  assert.equal(cache.get('huge', 0), undefined, 'bigger than the whole cache: not kept');
});

test('icons: numbers as the server sends them (also negative), built-in ones have no file', () => {
  assert.equal(iconId('3171498743'), 3171498743);
  assert.equal(iconId('-1123468553'), 3171498743, 'a negative 32-bit number is the same icon');
  assert.equal(iconId(undefined), 0);
  assert.equal(iconId('x'), 0);
  assert.equal(iconFileName(3171498743), '/icon_3171498743');
  assert.equal(iconFileName(300), null, 'built in: drawn by the page');
  assert.equal(iconFileName(0), null);
  assert.equal(iconFileName(2 ** 33), null);
  assert.equal(iconFileName(1.5), null);
});

test('iconType: pictures and SVG drawings, nothing else', () => {
  assert.deepEqual(iconType(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>')), { mime: 'image/svg+xml', svg: true });
  assert.deepEqual(iconType(Buffer.from('﻿  <svg viewBox="0 0 16 16"><path/></svg>')), { mime: 'image/svg+xml', svg: true });
  assert.deepEqual(iconType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), { mime: 'image/png', svg: false });
  assert.equal(iconType(Buffer.from('<html><script>alert(1)</script>')), null);
  assert.equal(iconType(Buffer.from('<?xml version="1.0"?><note>no picture</note>')), null);
});

test("avatarFileNames: the server's own name first, then the likely namings; nothing for a bad identity", () => {
  const uid = 'MT+e6FAkq/jR8xzQ4mE5Grk6RHU=';
  const names = avatarFileNames(uid, 'abcdefghijklmnopabcdefghijklmnop');
  assert.equal(names[0], '/avatar_abcdefghijklmnopabcdefghijklmnop');
  assert.equal(names.length, 4);
  for (const n of names) assert.match(n, /^\/avatar_[a-p]+$/);
  assert.equal(names[1], '/avatar_' + [...Buffer.from(uid, 'base64')].map((b) => String.fromCharCode(97 + (b >> 4), 97 + (b & 15))).join(''), "first guess: the identity's bytes as letters (worked on TeamSpeak 6)");
  assert.ok(names.slice(1).every((n) => n !== names[0]));
  assert.deepEqual(avatarFileNames('../../etc/passwd'), []);
  assert.deepEqual(avatarFileNames(uid, '../x').length, 3, 'a bad name from the server is ignored');
});

test('groupIds: a comma list of group numbers', () => {
  assert.deepEqual(groupIds('6,8,13'), [6, 8, 13]);
  assert.deepEqual(groupIds(''), []);
  assert.deepEqual(groupIds('6,x,-1,0'), [6]);
});

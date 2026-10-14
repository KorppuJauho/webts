// Pictures in the chat: getting a picture ready to send, and finding TeamSpeak's picture lines in a
// message. Loaded before ts-client.js; plain functions, so test/pictures.test.mjs can try them offline.
//
// Sending: a picture up to 15 MB goes as it is, at full quality, with only its hidden details
// removed: a phone photo's EXIF block says where it was taken (GPS), which camera, and more. A JPEG keeps just its
// turn (orientation), so it still shows the right way up. A picture over 15 MB, or in a format TeamSpeak may not
// show (e.g. HEIC), is saved again as a JPEG, shrunk only as much as needed. GIFs go as they are, so they keep moving.
//
// Showing: the TeamSpeak app's picture line [img]ts3image://<name>?channel=<cid>&path=<folder>[/img] (the bridge
// writes these for WebTS pictures, and TeamSpeak app users can too) becomes the picture, fetched through
// /channel-image. Like the TeamSpeak app, the query is used as written (an encoded %2F isn't a folder there either).

let PICTURE_MAX_BYTES = 15 * 1024 * 1024; // the bridge's PICTURE_MAX_MB (webts-config)

function bytesAre(bytes, at, text) {
    if (at + text.length > bytes.length) return false;
    for (let k = 0; k < text.length; k++) if (bytes[at + k] !== text.charCodeAt(k)) return false;
    return true;
}

function joinBytes(parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    return out;
}

// What the bytes really are: 'jpeg', 'png', 'gif', 'webp' or null.
function pictureKind(bytes) {
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
    if (bytesAre(bytes, 0, '\x89PNG\r\n\x1a\n')) return 'png';
    if (bytesAre(bytes, 0, 'GIF87a') || bytesAre(bytes, 0, 'GIF89a')) return 'gif';
    if (bytesAre(bytes, 0, 'RIFF') && bytesAre(bytes, 8, 'WEBP')) return 'webp';
    return null;
}

// The orientation (1-8) in a JPEG's EXIF block (the APP1 segment's data), or null.
function jpegOrientation(data) {
    if (!bytesAre(data, 0, 'Exif\0\0') || data.length < 14) return null;
    const t = 6;
    const little = bytesAre(data, t, 'II');
    if (!little && !bytesAre(data, t, 'MM')) return null;
    const u16 = (o) => (little ? data[o] | (data[o + 1] << 8) : (data[o] << 8) | data[o + 1]);
    const u32 = (o) => (little
        ? (data[o] | (data[o + 1] << 8) | (data[o + 2] << 16) | (data[o + 3] << 24)) >>> 0
        : ((data[o] << 24) | (data[o + 1] << 16) | (data[o + 2] << 8) | data[o + 3]) >>> 0);
    const ifd = t + u32(t + 4);
    if (ifd + 2 > data.length) return null;
    const count = u16(ifd);
    for (let k = 0; k < count; k++) {
        const entry = ifd + 2 + k * 12;
        if (entry + 12 > data.length) return null;
        if (u16(entry) === 0x0112) {
            const value = u16(entry + 8);
            return value >= 1 && value <= 8 ? value : null;
        }
    }
    return null;
}

// A new EXIF block that says only the orientation.
function orientationSegment(orientation) {
    return new Uint8Array([
        0xff, 0xe1, 0x00, 0x22,                         // APP1, 34 bytes
        0x45, 0x78, 0x69, 0x66, 0x00, 0x00,             // "Exif\0\0"
        0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // big-endian TIFF, first list at 8
        0x00, 0x01,                                     // one entry:
        0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, //   Orientation, SHORT, 1 value
        0x00, orientation, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,                         // no further lists
    ]);
}

// Where a JPEG's picture data ends (just after its end marker), starting from its first scan; -1 if it's broken.
// Anything after it (some phones add extra pictures there, with their own details) is left out.
function jpegEnd(bytes, i) {
    while (i + 1 < bytes.length) {
        const marker = bytes[i + 1];
        if (marker === 0xd9) return i + 2;
        if (i + 4 > bytes.length) return -1;
        i += 2 + ((bytes[i + 2] << 8) | bytes[i + 3]);
        if (marker === 0xda) {
            // The coded picture: runs until a real marker (0xFF followed by neither 0x00 nor a restart marker).
            while (i + 1 < bytes.length && !(bytes[i] === 0xff && bytes[i + 1] !== 0x00 && !(bytes[i + 1] >= 0xd0 && bytes[i + 1] <= 0xd7))) i++;
        }
        while (i + 2 < bytes.length && bytes[i] === 0xff && bytes[i + 1] === 0xff) i++; // fill bytes
        if (i + 1 >= bytes.length || bytes[i] !== 0xff) return -1;
    }
    return -1;
}

// A JPEG without its detail blocks (EXIF, XMP, IPTC, comments, maker data): kept are the picture itself, its colour
// profile (ICC) and the JFIF/Adobe colour notes, plus a fresh EXIF block with only the orientation. Null if broken.
function stripJpegMetadata(bytes) {
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    const keep = [];
    let orientation = null;
    let i = 2;
    while (i + 4 <= bytes.length) {
        if (bytes[i] !== 0xff) return null;
        const marker = bytes[i + 1];
        if (marker === 0xff) { i++; continue; }
        if (marker === 0xda) {
            const end = jpegEnd(bytes, i);
            if (end < 0) return null;
            keep.push(bytes.subarray(i, end));
            const head = [bytes.subarray(0, 2)];
            if (orientation && orientation !== 1) head.push(orientationSegment(orientation));
            return joinBytes(head.concat(keep));
        }
        if (marker === 0xd8 || marker === 0xd9) return null;
        const length = (bytes[i + 2] << 8) | bytes[i + 3];
        if (length < 2 || i + 2 + length > bytes.length) return null;
        const data = bytes.subarray(i + 4, i + 2 + length);
        const isApp = marker >= 0xe0 && marker <= 0xef;
        if (marker === 0xe1) {
            const o = jpegOrientation(data);
            if (o) orientation = o;
        } else if (!isApp && marker !== 0xfe) {
            keep.push(bytes.subarray(i, i + 2 + length)); // the picture's own tables and frame
        } else if (marker === 0xe0 || marker === 0xee || (marker === 0xe2 && bytesAre(data, 0, 'ICC_PROFILE\0'))) {
            keep.push(bytes.subarray(i, i + 2 + length));
        }
        i += 2 + length;
    }
    return null;
}

// A PNG without its text, time and EXIF chunks. Null if broken.
function stripPngMetadata(bytes) {
    const drop = new Set(['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME']);
    const keep = [bytes.subarray(0, 8)];
    let i = 8;
    while (i + 12 <= bytes.length) {
        const length = ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
        const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
        const end = i + 12 + length;
        if (end > bytes.length) return null;
        if (!drop.has(type)) keep.push(bytes.subarray(i, end));
        i = end;
        if (type === 'IEND') return joinBytes(keep);
    }
    return null;
}

// A WebP without its EXIF and XMP chunks (and their flags in the VP8X header). Null if broken.
function stripWebpMetadata(bytes) {
    const chunks = [];
    let i = 12;
    while (i + 8 <= bytes.length) {
        const type = String.fromCharCode(bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]);
        const size = (bytes[i + 4] | (bytes[i + 5] << 8) | (bytes[i + 6] << 16) | (bytes[i + 7] << 24)) >>> 0;
        let end = i + 8 + size + (size & 1);
        if (end > bytes.length) {
            if (i + 8 + size !== bytes.length) return null;
            end = bytes.length; // a last chunk without its padding byte
        }
        if (type !== 'EXIF' && type !== 'XMP ') {
            const chunk = bytes.slice(i, end);
            if (type === 'VP8X' && chunk.length > 8) chunk[8] &= ~(0x08 | 0x04); // "has EXIF", "has XMP"
            chunks.push(chunk);
        }
        i = end;
    }
    if (!chunks.length) return null;
    const body = joinBytes(chunks);
    const out = new Uint8Array(12 + body.length);
    out.set(bytes.subarray(0, 12));
    const riffSize = out.length - 8;
    out[4] = riffSize & 0xff;
    out[5] = (riffSize >>> 8) & 0xff;
    out[6] = (riffSize >>> 16) & 0xff;
    out[7] = (riffSize >>> 24) & 0xff;
    out.set(body, 12);
    return out;
}

function stripPictureMetadata(bytes, kind) {
    if (kind === 'jpeg') return stripJpegMetadata(bytes);
    if (kind === 'png') return stripPngMetadata(bytes);
    if (kind === 'webp') return stripWebpMetadata(bytes);
    if (kind === 'gif') return bytes;
    return null;
}

// Saves the picture again as a JPEG (no hidden details), at full size if that fits in `maxBytes`, otherwise
// shrunk step by step until it does. Phones refuse canvases over about 16 million pixels, so bigger is scaled to that.
async function reencodeAsJpeg(blob, maxBytes) {
    let bitmap;
    try {
        bitmap = await createImageBitmap(blob);
    } catch (e) {
        throw new Error("This picture's format isn't supported. Try a JPEG or PNG.");
    }
    try {
        let scale = Math.min(1, Math.sqrt(16e6 / (bitmap.width * bitmap.height)));
        for (let attempt = 0; attempt < 6; attempt++) {
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(bitmap.width * scale));
            canvas.height = Math.max(1, Math.round(bitmap.height * scale));
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ffffff'; // a see-through PNG gets white behind it, not black
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            const out = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
            if (!out) break;
            if (out.size <= maxBytes) return new Uint8Array(await out.arrayBuffer());
            scale *= Math.sqrt(maxBytes / out.size) * 0.95;
        }
    } finally {
        if (bitmap.close) bitmap.close();
    }
    throw new Error("The picture couldn't be made small enough to send.");
}

// The bytes to send for a picture the person picked, pasted or dropped.
async function preparePicture(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const kind = pictureKind(bytes);
    if (kind === 'gif') {
        if (bytes.length > PICTURE_MAX_BYTES) throw new Error(`GIFs can be at most ${Math.round(PICTURE_MAX_BYTES / 1048576)} MB.`);
        return bytes;
    }
    const clean = kind ? stripPictureMetadata(bytes, kind) : null;
    if (clean && clean.length <= PICTURE_MAX_BYTES) return clean;
    return reencodeAsJpeg(file, PICTURE_MAX_BYTES);
}

// The picture lines in a chat message: { pictures: [{ cid, path, name }], rest: the text without them }.
function channelPictures(text) {
    const pictures = [];
    if (typeof text !== 'string' || !/ts3image:\/\//i.test(text)) return { pictures, rest: text };
    const rest = text.replace(/\[img\]\s*ts3image:\/\/([^?[\]]+)\?([^[\]\s]*)\s*\[\/img\]/gi, (whole, rawName, query) => {
        const params = {};
        for (const pair of query.split('&')) {
            const eq = pair.indexOf('=');
            if (eq > 0) params[pair.slice(0, eq).toLowerCase()] = pair.slice(eq + 1);
        }
        const cid = Number(params.channel);
        const name = rawName.trim();
        if (!Number.isInteger(cid) || cid <= 0 || !name || name.includes('/')) return whole;
        pictures.push({ cid, path: params.path || '/', name });
        return '';
    }).trim();
    return { pictures, rest };
}

function channelPictureUrl(picture) {
    return `/channel-image?cid=${picture.cid}&path=${encodeURIComponent(picture.path)}&name=${encodeURIComponent(picture.name)}`;
}

import { createHash } from "crypto";

// Pictures in the chat: the rules the bridge uses for them, kept apart from index.ts so they can be tested.
//
// A picture sent from WebTS goes into the channel's own file browser, folder /webTS (PICTURE_FOLDER), and the chat gets
//   [img]ts3image://<name>?channel=<cid>&path=/webTS[/img]
// which the TeamSpeak app shows as the picture (path=/webTS, /webTS/ and / work; an encoded %2F doesn't, the app uses
// the path as written). WebTS shows the same line through /channel-image.

export const IMAGE_MAX_BYTES = 15 * 1024 * 1024; // the default limit (PICTURE_MAX_MB), GIFs included
export const IMAGE_FOLDER = "/webTS";

export interface ImageType {
  ext: "jpg" | "png" | "gif" | "webp";
  mime: string;
}

// What the bytes really are (never the name): JPEG, PNG, GIF or WebP, or null. No SVG, which can carry scripts.
export function imageType(buf: Uint8Array): ImageType | null {
  const at = (i: number, ...bytes: number[]) => bytes.every((b, k) => buf[i + k] === b);
  const ascii = (i: number, text: string) => at(i, ...[...text].map((c) => c.charCodeAt(0)));
  if (buf.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return { ext: "jpg", mime: "image/jpeg" };
  if (buf.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { ext: "png", mime: "image/png" };
  if (buf.length >= 6 && (ascii(0, "GIF87a") || ascii(0, "GIF89a"))) return { ext: "gif", mime: "image/gif" };
  if (buf.length >= 12 && ascii(0, "RIFF") && ascii(8, "WEBP")) return { ext: "webp", mime: "image/webp" };
  return null;
}

// A picture asked for by the page (/channel-image?cid=…&path=…&name=…), checked: a channel number, a folder path
// that stays inside the channel's files, and a plain file name. Returns the full path, or null.
export function channelImageRef(query: Record<string, unknown>): { cid: number; fullPath: string } | null {
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  if (query.path !== undefined && typeof query.path !== "string") return null; // ?path=a&path=b
  const cid = Number(text(query.cid));
  if (!Number.isInteger(cid) || cid <= 0 || cid > 2 ** 31) return null;
  const name = text(query.name).trim();
  const folder = text(query.path) || "/";
  const bad = /[\u0000-\u001f\u007f\\]/;
  if (!name || name.length > 150 || bad.test(name) || name.includes("/") || name === "." || name === "..") return null;
  if (folder.length > 200 || bad.test(folder) || !folder.startsWith("/")) return null;
  const segments = folder.split("/").filter(Boolean);
  if (segments.some((s) => s === "." || s === "..")) return null;
  return { cid, fullPath: `/${[...segments, name].join("/")}` };
}

// A new picture's file name: local time (the TZ setting) and a random part, e.g. 2026-10-12_18-35-01_a7k3f9.jpg (only
// letters, digits, - and _, so the TeamSpeak app's link never needs escaping).
export function pictureName(type: ImageType, random: string, now = new Date(), timeZone?: string): string {
  let stamp: string;
  try {
    stamp = new Intl.DateTimeFormat("sv-SE", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).format(now).replace(" ", "_").replace(/:/g, "-");
  } catch (e) {
    stamp = now.toISOString().slice(0, 19).replace("T", "_").replace(/:/g, "-");
  }
  return `${stamp}_${random.replace(/[^a-z0-9]/gi, "").toLowerCase()}.${type.ext}`;
}

// The chat line the TeamSpeak app shows as the picture.
export function pictureMessage(name: string, cid: number, folder = IMAGE_FOLDER): string {
  return `[img]ts3image://${name}?channel=${cid}&path=${folder}[/img]`;
}

// Recently shown pictures, kept in memory so a chat full of them isn't fetched again on every look. Per person,
// because each person fetches with their own TeamSpeak permissions. Oldest out first beyond `maxBytes`.
export class PictureCache {
  private entries = new Map<string, { data: Buffer; at: number }>();
  private bytes = 0;

  constructor(private maxBytes = 150 * 1024 * 1024, private ttlMs = 30 * 60 * 1000) {}

  get(key: string, now = Date.now()): Buffer | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (now - entry.at > this.ttlMs) {
      this.bytes -= entry.data.length;
      return undefined;
    }
    this.entries.set(key, entry); // newest again
    return entry.data;
  }

  set(key: string, data: Buffer, now = Date.now()): void {
    if (data.length > this.maxBytes) return;
    const old = this.entries.get(key);
    if (old) {
      this.entries.delete(key);
      this.bytes -= old.data.length;
    }
    this.entries.set(key, { data, at: now });
    this.bytes += data.length;
    for (const [k, entry] of this.entries) {
      if (this.bytes <= this.maxBytes) break;
      this.entries.delete(k);
      this.bytes -= entry.data.length;
    }
  }

  get size(): number {
    return this.bytes;
  }
}

// --- Server icons and avatars ---
// TeamSpeak keeps the icons (of channels, groups, people and the server) and the avatars in the server's own files,
// "channel 0": /icon_<id> and /avatar_<name>. The server tells every client the numbers; the TeamSpeak app downloads
// the files like any other. Ids under 1000 are TeamSpeak's built-in icons (the app draws them; no file exists).

export const BUILTIN_ICON_MAX = 999;
export const ICON_MAX_BYTES = 1024 * 1024;
export const AVATAR_MAX_BYTES = 4 * 1024 * 1024;

// An icon number as the server sends it (sometimes as a negative 32-bit number): unsigned, 0 = none.
export function iconId(value: string | undefined): number {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? n >>> 0 : 0;
}

// The file of an icon in the server's files, or null for none or a built-in one.
export function iconFileName(id: number): string | null {
  return Number.isInteger(id) && id > BUILTIN_ICON_MAX && id <= 0xffffffff ? `/icon_${id}` : null;
}

// The possible files of a person's avatar, best guess first: the identity (base64) as bytes, each half-byte written
// as a letter a-p. That is TeamSpeak 3's naming and works on TeamSpeak 6 too (its identities are 32 bytes, so 64
// letters). SHA-256 namings stay as fallbacks. A name the server sends wins over all.
export function avatarFileNames(uid: string, serverName?: string): string[] {
  const letters = (bytes: Uint8Array) => {
    let name = "";
    for (const b of bytes) name += String.fromCharCode(97 + (b >> 4), 97 + (b & 15));
    return name;
  };
  const names: string[] = [];
  if (serverName && /^[a-p]{32,128}$/.test(serverName)) names.push(`/avatar_${serverName}`);
  if (typeof uid === "string" && /^[A-Za-z0-9+/]{20,88}={0,2}$/.test(uid)) {
    const raw = Buffer.from(uid, "base64");
    if (raw.length >= 16) names.push(`/avatar_${letters(raw)}`);
    names.push(`/avatar_${letters(createHash("sha256").update(uid).digest())}`);
    if (raw.length >= 16) names.push(`/avatar_${letters(createHash("sha256").update(raw).digest())}`);
  }
  return [...new Set(names)];
}

// What an icon file really is: one of the picture types, or SVG (most of TeamSpeak 6's icons are SVG). An SVG is only
// ever shown as a picture (scripts in it never run there), and is sent with rules that block scripts if opened directly.
export function iconType(buf: Uint8Array): { mime: string; svg: boolean } | null {
  const picture = imageType(buf);
  if (picture) return { mime: picture.mime, svg: false };
  const head = Buffer.from(buf.subarray(0, 4096)).toString("utf8").replace(/^﻿/, "").trimStart();
  if (/^(<\?xml|<svg|<!--|<!DOCTYPE svg)/i.test(head) && /<svg[\s>]/i.test(head)) return { mime: "image/svg+xml", svg: true };
  return null;
}

// A comma list of group numbers ("6,8") as numbers.
export function groupIds(value: string | undefined): number[] {
  return String(value ?? "").split(",").map((s) => Number.parseInt(s, 10)).filter((n) => Number.isInteger(n) && n > 0);
}

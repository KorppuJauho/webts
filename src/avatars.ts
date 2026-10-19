import { createHash } from "crypto";
import fs from "fs/promises";
import path from "path";
import { imageType } from "./pictures.js";

// Profile pictures: a person's own TeamSpeak avatar, set from WebTS, and the rules for showing other people's.
//
// How TeamSpeak 6 does it (the TeamSpeak app does the same): the picture is uploaded into the server's own files
// (channel 0) as "/avatar", and the server stores it under a name made from the uploader's public key; then
// clientupdate client_flag_avatar=<the file's MD5> tells everyone it changed. The server shows every client's
// identity as the SHA-256 of their key (WebTS's own too), so viewers find the file by the identity's bytes as
// letters (avatarFileNames in pictures.ts). Uploading again needs overwrite. A normal user can't delete the file
// (ftdeletefile is refused); removing clears the flag, so nobody shows it, and the next picture replaces the file.
// The server's limit is the permission "max avatar file size" (stock 200 KB, -1 = none): a bigger file is refused
// with 2565 at the start of the upload. The server doesn't check pixels; the app fits avatars inside 320×320.

export const AVATAR_UPLOAD_NAME = "/avatar";
export const AVATAR_MAX_SIDE = 320;
export const AVATAR_UPLOAD_MAX_BYTES = 512 * 1024; // what the page may send (a 320 px picture is far smaller)
export const AVATAR_TOO_BIG = 2565;                // TeamSpeak: "invalid size" (over the max avatar file size)

// The value for client_flag_avatar: the file's MD5, as TeamSpeak and its app use.
export function avatarFlag(data: Uint8Array): string {
  return createHash("md5").update(data).digest("hex");
}

// A picture's size in pixels from its header: PNG (IHDR) or JPEG (the first SOF marker), else null.
export function imageSize(buf: Uint8Array): { width: number; height: number } | null {
  const type = imageType(buf);
  const u16 = (i: number) => (buf[i] << 8) | buf[i + 1];
  if (type?.ext === "png" && buf.length >= 24) {
    const u32 = (i: number) => ((buf[i] << 24) >>> 0) + (buf[i + 1] << 16) + (buf[i + 2] << 8) + buf[i + 3];
    return { width: u32(16), height: u32(20) };
  }
  if (type?.ext === "jpg") {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1];
      if (marker === 0xff) { i++; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const length = u16(i + 2);
      // SOF0-15, except DHT (c4), JPG (c8) and DAC (cc)
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: u16(i + 7), height: u16(i + 5) };
      }
      if (length < 2) return null;
      i += 2 + length;
    }
  }
  return null;
}

// A picture the page sends as someone's avatar, checked: a JPEG or PNG, not too big, inside 320×320. Returns its
// type, or why not.
export function checkAvatar(data: Uint8Array): { ext: "jpg" | "png" } | { error: string } {
  if (!data.length || data.length > AVATAR_UPLOAD_MAX_BYTES) return { error: "The picture is too big." };
  const type = imageType(data);
  if (type?.ext !== "jpg" && type?.ext !== "png") return { error: "Only JPEG and PNG pictures can be a profile picture." };
  const size = imageSize(data);
  if (!size || !size.width || !size.height) return { error: "The picture couldn't be read." };
  if (size.width > AVATAR_MAX_SIDE || size.height > AVATAR_MAX_SIDE) return { error: "The picture is larger than 320×320." };
  return { ext: type.ext };
}

// A myTeamSpeak picture (someone signed in to myTeamSpeak in the TeamSpeak app), as the server passes it on:
// "2,https://storage.googleapis.com/ts-sys-myts-avatars/<id>/<time>". Only that exact place is accepted: the
// bridge fetches it, so the page never names an address to fetch.
const MYTS_AVATAR = /^(?:\d+,)?(https:\/\/storage\.googleapis\.com\/ts-sys-myts-avatars\/[A-Za-z0-9-]{1,64}\/[0-9]{1,20})$/;
export function myTeamSpeakAvatarUrl(value: string | undefined): string {
  const m = MYTS_AVATAR.exec(String(value ?? "").trim());
  return m ? m[1] : "";
}

// --- WebTS's own copy ---
// Each person's picture is also kept in DATA_DIR/avatars/ (the file, named by a hash of the person, and index.json),
// so it can be put on another server they use ("Several servers", "connect anywhere"). `servers` remembers where
// it was uploaded: a server it was uploaded to but that now shows no avatar had it removed (by an admin, or from
// the app), and it is never put back there.

export interface SavedAvatar {
  file: string;                       // the file in the folder
  flag: string;                       // its MD5
  servers: Record<string, string>;    // server id -> the flag uploaded there
}

export class AvatarStore {
  private index: Record<string, SavedAvatar> | null = null;
  private saving: Promise<void> = Promise.resolve();

  constructor(private dir: string) {}

  private fileFor(personKey: string, ext: string): string {
    return `${createHash("sha256").update(personKey).digest("hex").slice(0, 32)}.${ext}`;
  }

  private async load(): Promise<Record<string, SavedAvatar>> {
    if (this.index) return this.index;
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(this.dir, "index.json"), "utf-8"));
      this.index = parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      this.index = {};
    }
    return this.index!;
  }

  // One write at a time, the index last (a crash between leaves at most an unused file).
  private async save(): Promise<void> {
    const write = this.saving.then(async () => {
      await fs.mkdir(this.dir, { recursive: true });
      const tmp = path.join(this.dir, `index.json.${process.pid}.tmp`);
      await fs.writeFile(tmp, JSON.stringify(this.index));
      await fs.rename(tmp, path.join(this.dir, "index.json"));
    });
    this.saving = write.catch(() => {});
    return write;
  }

  async get(personKey: string): Promise<(SavedAvatar & { data: Buffer }) | null> {
    const saved = (await this.load())[personKey];
    if (!saved) return null;
    try {
      return { ...saved, data: await fs.readFile(path.join(this.dir, saved.file)) };
    } catch {
      return null;
    }
  }

  async set(personKey: string, data: Buffer, ext: "jpg" | "png", serverId: string): Promise<string> {
    const index = await this.load();
    const old = index[personKey];
    const file = this.fileFor(personKey, ext);
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(path.join(this.dir, file), data);
    if (old && old.file !== file) await fs.unlink(path.join(this.dir, old.file)).catch(() => {});
    const flag = avatarFlag(data);
    index[personKey] = { file, flag, servers: { [serverId]: flag } };
    await this.save();
    return flag;
  }

  async markUploaded(personKey: string, serverId: string, flag: string): Promise<void> {
    const saved = (await this.load())[personKey];
    if (!saved) return;
    saved.servers[serverId] = flag;
    await this.save();
  }

  async remove(personKey: string): Promise<void> {
    const index = await this.load();
    const old = index[personKey];
    if (!old) return;
    delete index[personKey];
    await this.save();
    await fs.unlink(path.join(this.dir, old.file)).catch(() => {});
  }
}

// On connecting to a server: put the saved picture there only if it has never been uploaded to that server and
// the person shows no avatar there now.
export function shouldUploadSaved(saved: SavedAvatar | null, serverId: string, currentFlag: string): boolean {
  return !!saved && !(serverId in saved.servers) && !currentFlag;
}

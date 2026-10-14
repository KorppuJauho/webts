// Chat history across days, like the TeamSpeak app's: each person's channel chats, private chats and join/leave
// lines, kept in DATA_DIR/chat/ (by default 30 days, at most 300 lines per conversation), so yesterday's picture is
// still in the chat today. Only what the person's own connection saw: WebTS can't see chat while the page is closed.
//
// Off unless CHAT_HISTORY=on. Each person's file is locked with CHAT_HISTORY_KEY (AES-256-GCM): keep the key out of
// your backups of the data folder, and the copies there are files nobody can read. A file that doesn't open (another
// key, damaged) is left exactly as it is and that person simply gets no history; nothing is ever written over it.

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

export const HISTORY_DAYS = 30;
export const HISTORY_LINES = 300;          // per conversation (a channel, or a private chat)
export const HISTORY_CONVERSATIONS = 100;  // per person: the least recently used go first
const DAY = 86_400_000;

// A chat message or a join/leave line as the bridge sends it to the page (kept whole), with its moment (`time`, ms).
export interface HistoryEntry {
    id: string;
    time: number;
    targetmode: number;
    cid?: number;
    partnerUid?: string;
    msg?: string;
}
export type History = Record<string, HistoryEntry[]>; // conversation -> entries, oldest first

// CHAT_HISTORY=on (or true/yes/1) switches it on.
export function historyWanted(value: string | undefined): boolean {
    return /^(on|true|yes|1)$/i.test(String(value || '').trim());
}

// The key: 32 random bytes written as base64 (44 letters). null when it isn't one.
export function parseHistoryKey(value: string | undefined): Buffer | null {
    const text = String(value || '').trim();
    if (!/^[A-Za-z0-9+/_-]{43}=?$/.test(text)) return null;
    const key = Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    return key.length === 32 ? key : null;
}

// The conversation a message belongs to, as the page files it: the channel's id, or "pm:<their identity>".
export function conversationKey(m: { targetmode?: number; cid?: number; partnerUid?: string }): string | null {
    if (m.targetmode === 2 && Number(m.cid) > 0) return String(m.cid);
    if (m.targetmode === 1 && m.partnerUid) return `pm:${m.partnerUid}`;
    return null;
}

// A person's file name: "user:2" -> "user-2.json"; any other key (an email, a browser's id) is hashed, so it isn't
// on disk.
export function historyFileName(personKey: string): string {
    if (/^user:\d{1,12}$/.test(personKey)) return `user-${personKey.slice(5)}.json`;
    return `p-${crypto.createHash('sha256').update(personKey).digest('hex').slice(0, 32)}.json`;
}

// Lines older than `days` go, then each conversation keeps its newest `lines`, and at most `conversations` stay.
export function trimHistory(history: History, now: number, days = HISTORY_DAYS, lines = HISTORY_LINES,
    conversations = HISTORY_CONVERSATIONS): History {
    const from = now - days * DAY;
    const kept: [string, HistoryEntry[]][] = [];
    for (const [key, list] of Object.entries(history)) {
        if (!Array.isArray(list)) continue;
        const recent = list.filter((e) => e && typeof e.time === 'number' && e.time >= from).slice(-lines);
        if (recent.length) kept.push([key, recent]);
    }
    kept.sort((a, b) => b[1][b[1].length - 1].time - a[1][a[1].length - 1].time);
    return Object.fromEntries(kept.slice(0, conversations));
}

// Locked with AES-256-GCM: a fresh random IV for every write, and the person's key as associated data, so one
// person's file can't be passed off as another's.
export function sealHistory(key: Buffer, personKey: string, history: History): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(personKey, 'utf8'));
    const data = Buffer.concat([cipher.update(JSON.stringify(history), 'utf8'), cipher.final()]);
    return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
}

// Throws when the file isn't ours, the key is another one or anything in it was changed.
export function openHistory(key: Buffer, personKey: string, text: string): History {
    const box = JSON.parse(text);
    if (!box || box.v !== 1) throw new Error('unknown file format');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
    decipher.setAAD(Buffer.from(personKey, 'utf8'));
    decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]).toString('utf8');
    const history = JSON.parse(plain);
    if (!history || typeof history !== 'object' || Array.isArray(history)) throw new Error('not a history');
    return history;
}

interface PersonState {
    loading: Promise<void>;
    history: History;
    blocked: boolean;    // the file didn't open: no history, never written
    users: number;       // connections using it
    dirty: boolean;
    timer: ReturnType<typeof setTimeout> | null;
    writing: Promise<void>;
}

export interface HistoryOptions {
    days?: number;
    lines?: number;
    writeDelayMs?: number;       // new lines are written together, at most this often
    now?: () => number;
    log?: (line: string) => void;
}

// The people's histories while they are connected: loaded on connect, written a few seconds after a new line and
// when the connection ends, then forgotten from memory.
export class ChatHistoryStore {
    private people = new Map<string, PersonState>();
    private days: number;
    private lines: number;
    private writeDelayMs: number;
    private now: () => number;
    private log: (line: string) => void;

    constructor(private dir: string, private key: Buffer, opts: HistoryOptions = {}) {
        this.days = opts.days ?? HISTORY_DAYS;
        this.lines = opts.lines ?? HISTORY_LINES;
        this.writeDelayMs = opts.writeDelayMs ?? 10_000;
        this.now = opts.now ?? Date.now;
        this.log = opts.log ?? ((line) => console.log(line));
    }

    // Makes the folder; false (and a log line) when it can't be written.
    async prepare(): Promise<boolean> {
        const probe = path.join(this.dir, `.write-test-${process.pid}`);
        try {
            await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
            await fs.writeFile(probe, '');
            await fs.unlink(probe);
            return true;
        } catch (e: any) {
            this.log(`[History] ${this.dir} can't be written (${e.code || e.message})`);
            return false;
        }
    }

    private file(personKey: string): string {
        return path.join(this.dir, historyFileName(personKey));
    }

    // A connection starts: the person's history, oldest first (empty when the file didn't open).
    async open(personKey: string): Promise<HistoryEntry[]> {
        let p = this.people.get(personKey);
        if (!p) {
            p = { loading: Promise.resolve(), history: {}, blocked: false, users: 0, dirty: false, timer: null, writing: Promise.resolve() };
            p.loading = this.load(personKey, p);
            this.people.set(personKey, p);
        }
        p.users++;
        await p.loading;
        if (p.blocked) return [];
        return Object.values(p.history).flat().sort((a, b) => a.time - b.time);
    }

    private async load(personKey: string, p: PersonState): Promise<void> {
        const name = historyFileName(personKey);
        let text: string;
        try {
            text = await fs.readFile(this.file(personKey), 'utf8');
        } catch (e: any) {
            if (e.code !== 'ENOENT') {
                p.blocked = true;
                this.log(`[History] Can't read ${name} (${e.code || e.message}): left as it is, no history for this person`);
            }
            return;
        }
        try {
            const saved = openHistory(this.key, personKey, text);
            for (const [key, list] of Object.entries(p.history)) saved[key] = [...(saved[key] || []), ...list]; // added while loading
            p.history = trimHistory(saved, this.now(), this.days, this.lines);
        } catch (e) {
            p.blocked = true;
            this.log(`[History] ${name} doesn't open (another CHAT_HISTORY_KEY, or damaged): left as it is, no history for this person`);
        }
    }

    // A new line in one of the person's conversations (not kept if it belongs to none, or the file didn't open).
    add(personKey: string, entry: HistoryEntry): void {
        const p = this.people.get(personKey);
        const conversation = conversationKey(entry);
        if (!p || p.blocked || conversation === null) return;
        const list = p.history[conversation] || (p.history[conversation] = []);
        list.push(entry);
        if (list.length > this.lines) list.splice(0, list.length - this.lines);
        p.dirty = true;
        if (!p.timer) {
            p.timer = setTimeout(() => { p.timer = null; void this.flush(personKey); }, this.writeDelayMs);
            p.timer.unref?.();
        }
    }

    // Writes what is new now (one write at a time per person).
    flush(personKey: string): Promise<void> {
        const p = this.people.get(personKey);
        if (!p || p.blocked) return Promise.resolve();
        if (p.timer) { clearTimeout(p.timer); p.timer = null; }
        if (p.dirty) p.writing = p.writing.then(() => this.write(personKey, p));
        return p.writing;
    }

    private async write(personKey: string, p: PersonState): Promise<void> {
        if (!p.dirty) return;
        p.dirty = false;
        p.history = trimHistory(p.history, this.now(), this.days, this.lines);
        const file = this.file(personKey);
        const tmp = `${file}.tmp`;
        try {
            await fs.writeFile(tmp, sealHistory(this.key, personKey, p.history), { mode: 0o600 });
            await fs.rename(tmp, file); // the old file stays whole until the new one is complete
        } catch (e: any) {
            p.dirty = true; // tried again with the next line or at disconnect
            this.log(`[History] Couldn't save ${historyFileName(personKey)} (${e.code || e.message})`);
        }
    }

    // A connection ended: written now, and forgotten once nobody uses it.
    async release(personKey: string): Promise<void> {
        const p = this.people.get(personKey);
        if (!p) return;
        p.users = Math.max(0, p.users - 1);
        await p.loading;
        await this.flush(personKey);
        if (p.users === 0 && !p.dirty && this.people.get(personKey) === p) this.people.delete(personKey);
    }

    // Before the bridge stops.
    async flushAll(): Promise<void> {
        await Promise.all([...this.people.keys()].map((k) => this.flush(k)));
    }

    // A file nobody has changed for `days` holds only lines past their time: removed (it doesn't need the key).
    // Also half-written files left by a stop in the middle of a write.
    async sweep(): Promise<number> {
        const loaded = new Set([...this.people.keys()].map(historyFileName));
        let removed = 0;
        let names: string[];
        try { names = await fs.readdir(this.dir); } catch (e) { return 0; }
        for (const name of names) {
            const isTmp = name.endsWith('.json.tmp');
            if (!isTmp && (!name.endsWith('.json') || loaded.has(name))) continue;
            try {
                const st = await fs.stat(path.join(this.dir, name));
                const limit = isTmp ? 3_600_000 : this.days * DAY;
                if (!st.isFile() || this.now() - st.mtimeMs < limit) continue;
                await fs.unlink(path.join(this.dir, name));
                removed++;
            } catch (e) {}
        }
        if (removed) this.log(`[History] Removed ${removed} file(s) with nothing newer than ${this.days} days`);
        return removed;
    }
}

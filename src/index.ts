// WebTS bridge: lets a browser join a TeamSpeak server. Every browser connection (Socket.IO) gets its own TeamSpeak
// client ("Web - <name>") with a persistent identity per person; the bridge passes the channel and client lists,
// chat, voice, streams (WebRTC signalling), pictures and the server's icons between the two, and serves the page
// itself (public/). Settings: src/config.ts and .env.example. Who gets in: src/access.ts.

import express from 'express';
import http from 'http';
import { Server, Socket } from 'socket.io';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { Ts3Client, generateIdentity, restoreIdentity, buildCommand, ParsedCommand,
    createDirectory, uploadFile, downloadFile, FileTransferError } from './tslib/index.js';
import { imageType, channelImageRef, pictureName, pictureMessage, PictureCache,
    iconId, iconFileName, avatarFileNames, iconType, groupIds, ICON_MAX_BYTES, AVATAR_MAX_BYTES } from './pictures.js';
import { channelLabel, enterEvent, moveEvent, leaveEvent, type EventPart } from './chat-events.js';
import { ChatHistoryStore } from './chat-history.js';
import { config } from './config.js';
import { createAccess, Person } from './access.js';

// --- CONFIGURATION ---
const access = createAccess(config);
const TS_HOST = config.tsHost;
const DATA_DIR = config.dataDir;
const IDENTITIES_FILE = path.join(DATA_DIR, 'identities.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const IMAGE_MAX_BYTES = config.pictureMaxMb * 1024 * 1024;
const IMAGE_FOLDER = config.pictureFolder;
const STREAM_LOG_VERBOSE = config.streamLogVerbose; // the per-candidate lines too (STREAM_LOG=verbose)

// --- STREAM LOG ---
// One line per stream message in or out: its type, which fields it has, and for an SDP a short summary
// (codecs, the video line's port: 0 = video switched off, DTLS role, candidate count). Never the full SDP,
// which carries connection credentials.
let streamCommandCounter = 0;
function sdpSummary(sdp: string | undefined): string {
    if (!sdp) return 'no SDP';
    const lines = sdp.split(/\r?\n/);
    const parts: string[] = [];
    let media = '';
    for (const line of lines) {
        const m = line.match(/^m=(\w+) (\d+)/);
        if (m) { media = m[1]; parts.push(`${media}:port=${m[2]}`); continue; }
        const r = line.match(/^a=rtpmap:\d+ ([\w-]+)\//);
        if (r && media && !/^(rtx|red|ulpfec|flexfec-03)$/i.test(r[1])) parts.push(`${media}:${r[1]}`);
        const f = line.match(/profile-level-id=([0-9a-f]{6})/i);
        if (f) parts.push(`${media}:h264-profile=${f[1]}`);
        const d = line.match(/^a=(sendrecv|sendonly|recvonly|inactive)$/);
        if (d) parts.push(`${media}:${d[1]}`);
        const st = line.match(/^a=setup:(\w+)/);
        if (st) parts.push(`setup=${st[1]}`);
    }
    const candidates = lines.filter((l) => l.startsWith('a=candidate:')).length;
    return `${[...new Set(parts)].join(' ')} candidates=${candidates} bytes=${sdp.length}`;
}
function streamLog(direction: 'in' | 'out' | 'browser', what: string, detail = ''): void {
    console.log(`[Stream ${direction}] ${what}${detail ? ' ' + detail : ''}`);
}
// --- DATA FOLDER ---
// The only place the bridge writes: the identities and saved settings. It stops at once if the folder can't be
// written, rather than losing saves quietly.
async function prepareDataDir(): Promise<void> {
    try { await fs.mkdir(DATA_DIR, { recursive: true }); } catch (e) {}
    const probe = path.join(DATA_DIR, `.write-test-${process.pid}`);
    try {
        await fs.writeFile(probe, '');
        await fs.unlink(probe);
    } catch (e: any) {
        console.error(`[FATAL] ${DATA_DIR} can't be written (${e.code || e.message}): give the bridge's user write access to it.`);
        process.exit(1);
    }
}
await prepareDataDir();

// --- CHAT HISTORY ---
// Off unless CHAT_HISTORY=on (then the chat lasts while the page is open). When on, each person's chat is kept in
// DATA_DIR/chat/, locked with CHAT_HISTORY_KEY. chat-history.ts has the rules.
let chatHistory: ChatHistoryStore | null = null;
if (config.chatHistory && config.chatHistoryKey) {
    const store = new ChatHistoryStore(path.join(DATA_DIR, 'chat'), config.chatHistoryKey,
        { days: config.chatHistoryDays, lines: config.chatHistoryLines });
    if (await store.prepare()) {
        chatHistory = store;
        console.log(`[History] On: ${config.chatHistoryDays} days, at most ${config.chatHistoryLines} lines per conversation, locked`);
        void store.sweep();
        setInterval(() => void store.sweep(), 6 * 3_600_000).unref();
    } else {
        console.log("[History] Off: the chat folder can't be written (everything else works)");
    }
} else {
    console.log('[History] Off (CHAT_HISTORY is not on)');
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
const server = http.createServer(app);

// --- THE PAGE ---
// Its rules: only its own scripts; pictures from anywhere over https (image links in the chat get a preview);
// connections only back to this address.
export const PAGE_CSP = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'self'",
].join('; ');

app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
    next();
});

app.get(['/', '/index.html'], async (req, res) => {
    access.ensurePublicCookie(req, res);
    if (access.mode !== 'public' && !(await access.identify(req))) {
        res.status(401).type('text/plain').send("You're not signed in. WebTS is only for people let in by this site's sign-in.");
        return;
    }
    res.set({ 'Content-Security-Policy': PAGE_CSP, 'Cache-Control': 'no-store', 'X-Frame-Options': 'SAMEORIGIN' });
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});
// Revalidated on every load (ETag), so an update reaches everyone at once.
app.use(express.static(PUBLIC_DIR, { index: false, maxAge: 0 }));

// --- UI SOUNDS ---
// Optional: TeamSpeak's own sound pack is copyrighted and can't be shipped, so each server owner copies the .wav
// files from their own TeamSpeak 3 client into SOUNDS_DIR (README: "Sounds"). Without them the page is silent.
const SOUNDS_DIR = config.soundsDir;
const SOUND_FILES = new Set([
    'connected', 'disconnected', 'connection_lost', 'channel_switched', 'you_were_moved',
    'you_kicked_channel', 'you_kicked_server', 'you_were_banned', 'you_were_poked',
    'chat_message_inbound', 'chat_message_outbound', 'mic_muted', 'mic_activated',
    'sound_muted', 'sound_resumed', 'testsound',
    'neutral_connection_connected_currentchannel', 'neutral_connection_disconnected_currentchannel',
    'neutral_connection_connectionlost_currentchannel', 'neutral_switched_tocurrentchannel',
    'neutral_switched_awayfromcurrentchannel', 'neutral_moved_tocurrentchannel',
    'neutral_moved_awayfromcurrentchannel', 'neutral_kicked_channel_tocurrentchannel',
    'neutral_kicked_channel_awayfromcurrentchannel', 'neutral_kicked_server_currentchannel',
    'neutral_banned_server_currentchannel'
].map((name) => `${name}.wav`));

app.get('/sounds/:name', async (req, res) => {
    const name = req.params.name;
    if (!SOUND_FILES.has(name)) return res.status(404).end();
    if (!(await access.identify(req))) return res.status(403).end();
    res.set('Cache-Control', 'private, max-age=86400');
    res.sendFile(path.join(SOUNDS_DIR, name), (sendErr) => {
        if (sendErr && !res.headersSent) res.status(404).end();
    });
});

// The voice connection only from the page's own address (a page elsewhere can't use a visitor's sign-in here).
function originAllowed(req: http.IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true; // same-site requests without an Origin header (browsers always send it cross-site)
    try {
        const from = new URL(origin);
        if (config.publicUrl) return from.origin === new URL(config.publicUrl).origin;
        const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
        return from.host === host;
    } catch (e) {
        return false;
    }
}

const io = new Server(server, {
    maxHttpBufferSize: 1e6,
    allowRequest: (req, callback) => callback(null, originAllowed(req))
});

// --- RELAY FOR PEOPLE WHOSE NETWORK BLOCKS DIRECT CONNECTIONS ---
// Streams go straight between browsers and the TeamSpeak app. Behind some networks (e.g. CG-NAT) that fails, and a
// TURN relay carries the video instead. Two options, both optional (README: "Relay"):
//   - your own coturn server: TURN_URLS + TURN_SECRET (its static-auth-secret); credentials last 30 minutes;
//   - Cloudflare Realtime TURN: CF_TURN_KEY_ID + CF_TURN_KEY_TOKEN, and for a monthly cap (CF_TURN_CAP_GB, default
//     950 GB in the last 31 days; Cloudflare bills over 1,000 GB) CF_ACCOUNT_ID + CF_ANALYTICS_TOKEN. At the cap, or
//     when the usage can't be read, no credentials are given and the ones handed out are revoked.
const RELAY_CAP_BYTES = config.cfTurnCapGb * 1e9;
const RELAY_WINDOW_DAYS = 31;
const RELAY_TTL_SECONDS = 1800;
const RELAY_CHECK_MS = 10 * 60 * 1000;
const RELAY_STALE_MS = 35 * 60 * 1000;           // no successful usage reading for this long = treated as capped
const relay = {
    coturn: config.turnUrls.length > 0,
    cloudflare: !!(config.cfTurnKeyId && config.cfTurnKeyToken),
    capped: !!(config.cfAccountId && config.cfAnalyticsToken),
    usageBytes: null as number | null,
    checkedAt: 0,
    overCap: false,
    issued: new Map<string, number>()             // credential username -> expires at (ms)
};

function relayStatus() {
    const fresh = !relay.capped || Date.now() - relay.checkedAt < RELAY_STALE_MS;
    const configured = relay.coturn || relay.cloudflare;
    return {
        configured,
        available: relay.coturn || (relay.cloudflare && fresh && !relay.overCap),
        usageGB: relay.usageBytes === null ? null : Math.round(relay.usageBytes / 1e8) / 10,
        capGB: relay.capped ? RELAY_CAP_BYTES / 1e9 : null,
        windowDays: RELAY_WINDOW_DAYS
    };
}

async function revokeRelayCredentials(reason: string) {
    const now = Date.now();
    const live = [...relay.issued.entries()].filter(([, expires]) => expires > now).map(([user]) => user);
    relay.issued.clear();
    if (!live.length) return;
    console.log(`[Relay] Revoking ${live.length} credential(s): ${reason}`);
    await Promise.all(live.map((user) => fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${config.cfTurnKeyId}/credentials/${encodeURIComponent(user)}/revoke`,
        { method: 'POST', headers: { Authorization: `Bearer ${config.cfTurnKeyToken}` } }
    ).catch((e) => console.warn(`[Relay] Revoke failed: ${e.message}`))));
}

async function checkRelayUsage() {
    if (!relay.cloudflare || !relay.capped) return;
    const until = new Date();
    const since = new Date(until.getTime() - RELAY_WINDOW_DAYS * 86400000);
    const query = `{ viewer { accounts(filter: { accountTag: "${config.cfAccountId}" }) {
        callsTurnUsageAdaptiveGroups(filter: { datetimeMinute_geq: "${since.toISOString()}", datetimeMinute_lt: "${until.toISOString()}" }, limit: 1) {
            sum { egressBytes } } } } }`;
    try {
        const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
            method: 'POST',
            headers: { Authorization: `Bearer ${config.cfAnalyticsToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ query })
        });
        const data: any = await res.json();
        if (!res.ok || data.errors?.length) throw new Error(JSON.stringify(data.errors || res.status).slice(0, 300));
        const groups = data.data?.viewer?.accounts?.[0]?.callsTurnUsageAdaptiveGroups || [];
        relay.usageBytes = groups.reduce((sum: number, g: any) => sum + (Number(g.sum?.egressBytes) || 0), 0);
        relay.checkedAt = Date.now();
        const wasOver = relay.overCap;
        relay.overCap = relay.usageBytes >= RELAY_CAP_BYTES;
        console.log(`[Relay] Usage ${(relay.usageBytes / 1e9).toFixed(2)} GB of ${RELAY_CAP_BYTES / 1e9} GB (last ${RELAY_WINDOW_DAYS} days)${relay.overCap ? ' - CAPPED' : ''}`);
        if (relay.overCap && !wasOver) await revokeRelayCredentials('the monthly cap was reached');
    } catch (e: any) {
        console.warn(`[Relay] Usage check failed: ${e.message}`);
        if (Date.now() - relay.checkedAt >= RELAY_STALE_MS) await revokeRelayCredentials('usage unknown for too long');
    }
    io.emit('relay-status', relayStatus());
}

// coturn's "TURN REST API" credentials: user = expiry time, password = HMAC-SHA1 of it with the shared secret.
function coturnIceServers(): any[] {
    const username = `${Math.floor(Date.now() / 1000) + RELAY_TTL_SECONDS}:webts`;
    const credential = crypto.createHmac('sha1', config.turnSecret).update(username).digest('base64');
    return [{ urls: config.turnUrls, username, credential }];
}

async function relayIceServers(who: string): Promise<any[] | null> {
    if (relay.coturn) return coturnIceServers();
    if (!relayStatus().available) return null;
    try {
        const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${config.cfTurnKeyId}/credentials/generate-ice-servers`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${config.cfTurnKeyToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ttl: RELAY_TTL_SECONDS })
        });
        if (res.status !== 201 && res.status !== 200) throw new Error(`HTTP ${res.status}`);
        const data: any = await res.json();
        const now = Date.now();
        for (const [user, expires] of relay.issued) if (expires <= now) relay.issued.delete(user);
        // Only the relay itself (TeamSpeak's own STUN stays the page's); port 53 is blocked by browsers.
        const servers = (data.iceServers || [])
            .filter((server: any) => server.username)
            .map((server: any) => ({ ...server, urls: [].concat(server.urls).filter((u: string) => !/:53\b/.test(u)) }));
        for (const server of servers) relay.issued.set(server.username, now + RELAY_TTL_SECONDS * 1000);
        console.log(`[Relay] Credentials for ${who} (${relay.issued.size} live)`);
        return servers;
    } catch (e: any) {
        console.warn(`[Relay] Credentials failed: ${e.message}`);
        return null;
    }
}

// --- WHO IS CONNECTING ---
// The voice connection is let in only for a person access.ts recognises; they are identified by person.key
// (their TeamSpeak identity, saved settings and "one connection per person" go by it).
io.use(async (socket, next) => {
    const person = await access.identify(socket.request);
    if (!person) {
        console.warn(`[Access] Connection refused: not signed in (${access.mode}).`);
        return next(new Error('Access denied'));
    }
    if (activeBots.size >= config.maxUsers && !sessionByKey.has(person.key)) {
        console.warn(`[Access] Connection refused: MAX_USERS (${config.maxUsers}) reached.`);
        return next(new Error('WebTS is full right now. Please try again later.'));
    }
    (socket as any).person = person;
    return next();
});

// --- IDENTITY MANAGEMENT ---
async function getUserIdentity(email: string) {
    let identities: Record<string, any> = {};
    
    try {
        const data = await fs.readFile(IDENTITIES_FILE, 'utf-8');
        identities = JSON.parse(data);
    } catch (e) {
        // File doesn't exist yet, which is completely fine
    }

    if (identities[email]) {
        const idData = identities[email];
        if (idData.privateKeyBigInt && idData.publicKeyString) {
            console.log(`[Identity] Found existing identity for ${email}`);
            return restoreIdentity({
                privateKeyBigInt: idData.privateKeyBigInt,
                keyOffset: idData.keyOffset ?? '0',
                publicKeyString: idData.publicKeyString,
                uid: idData.uid ?? '',
                hwid: idData.hwid || '',
            });
        }
        console.log(`[Identity] Found corrupted identity for ${email}, regenerating...`);
        delete identities[email];
    }

    if (email.startsWith('pub:') && Object.keys(identities).filter((k) => k.startsWith('pub:')).length >= config.publicMaxIdentities) {
        throw new Error(`PUBLIC_MAX_IDENTITIES (${config.publicMaxIdentities}) reached: no new guest identities`);
    }
    console.log(`[Identity] Generating NEW persistent identity for ${email}...`);
    const newIdentity = generateIdentity();
    
    identities[email] = {
        privateKeyBigInt: newIdentity.privateKeyBigInt.toString(),
        publicKeyString: newIdentity.publicKeyString,
        keyOffset: newIdentity.keyOffset.toString(),
        uid: newIdentity.uid,
        hwid: newIdentity.hwid,
    };

    await fs.writeFile(IDENTITIES_FILE, JSON.stringify(identities, null, 2));
    console.log(`[Identity] Saved new identity securely to disk.`);
    
    return newIdentity;
}

// --- SETTINGS MANAGEMENT ---
// Limits: a device id as the page makes it ("dev_" + letters/numbers), one save at most 8 KB (today's are
// about 1 KB), at most 10 devices per person (an 11th isn't saved). Saves go one at a time, so two at once
// can't garble the file. Nothing already saved is changed.
const DEVICE_ID = /^dev_[a-z0-9]{1,20}$/;
const SETTINGS_MAX_BYTES = 8 * 1024;
const SETTINGS_MAX_DEVICES = 10;
let settingsWrites: Promise<unknown> = Promise.resolve();

async function loadUserSettings(email: string, deviceId: string) {
    try {
        const data = await fs.readFile(SETTINGS_FILE, 'utf-8');
        const allSettings = JSON.parse(data);
        
        // By the person's key and the device's id
        if (allSettings[email] && allSettings[email][deviceId]) {
            return allSettings[email][deviceId];
        }
    } catch (e) {
        // No file yet, or nothing saved for this device
    }
    return null;
}

async function saveUserSettings(email: string, deviceId: string, settings: any): Promise<string | null> {
    const run = settingsWrites.then(() => writeUserSettings(email, deviceId, settings));
    settingsWrites = run.catch(() => {});
    return run;
}

// Returns why the save was refused, or null when it was saved.
async function writeUserSettings(email: string, deviceId: string, settings: any): Promise<string | null> {
    if (!DEVICE_ID.test(String(deviceId))) return 'unknown device id';
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return 'not a settings object';
    if (Buffer.byteLength(JSON.stringify(settings)) > SETTINGS_MAX_BYTES) return `larger than ${SETTINGS_MAX_BYTES} bytes`;
    let allSettings: Record<string, any> = {};
    
    try {
        const data = await fs.readFile(SETTINGS_FILE, 'utf-8');
        allSettings = JSON.parse(data);
    } catch (e) {
        // No file yet: start an empty one
    }

    // The person's own entry
    if (!allSettings[email]) {
        allSettings[email] = {};
    }
    
    if (!allSettings[email][deviceId] && Object.keys(allSettings[email]).length >= SETTINGS_MAX_DEVICES) {
        return `already ${SETTINGS_MAX_DEVICES} devices saved`;
    }

    // Tallennetaan asetukset kyseisen laitteen ID:n alle
    allSettings[email][deviceId] = settings;

    // Kirjoitetaan muutokset levylle
    await fs.writeFile(SETTINGS_FILE, JSON.stringify(allSettings, null, 2));
    return null;
}

// A number from TeamSpeak, or null when the field wasn't sent (then nothing is assumed from it).
const tsNumber = (v: string | undefined): number | null => {
    if (v === undefined || v === '') return null;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
};

// --- DATA INTERFACES ---
interface ChannelData {
    cid: number;
    pid: number;
    name: string;
    topic: string;
    order: number;
    isDefault: boolean;
    isPassword: boolean;
    codec: number;
    neededTalkPower: number | null; // the talk power needed to be heard here (null = not known)
    iconId: number;                 // the channel's icon (0 = none; under 1000 = built in)
    // For spacers and banners: a spacer is a permanent top-level channel named [...spacer...].
    permanent: boolean;
    bannerUrl: string;              // https:// or ts3image:// (a file in the server's files), '' = none
    bannerMode: number;
}

interface ClientData {
    clid: number;
    cid: number;
    nickname: string;
    type: number;
    uid: string;
    away: boolean;
    awayMsg: string;
    inputMuted: boolean;
    outputMuted: boolean;
    isTalker: boolean;
    isTalking: boolean;
    isSelf: boolean;
    isStreaming: boolean;
    talkPower: number | null;       // null = not known
    myTeamSpeakId?: string;
    userTag?: string;
    // Icons: their own icon, their groups (whose icons are the badges) and their avatar's hash ('' = none).
    iconId: number;
    serverGroups: number[];
    channelGroup: number;
    avatar: string;
    avatarName?: string;            // the avatar's file name, when the server says it
}

// A server or channel group: its name and icon, for the badges next to people.
interface GroupData {
    id: number;
    name: string;
    iconId: number;
    sortId: number;
    type: number;                   // 0 template, 1 regular, 2 query
}

interface ServerInfo {
    name: string;
    welcomeMessage: string;
    platform: string;
    version: string;
    // For the server info window; empty/0 when the server didn't say.
    maxClients: number;
    created: number;      // unix seconds
    startedAt: number;    // ms, from the uptime
    bannerImage: string;
    bannerLink: string;
    websiteUrl: string;
    websiteName: string;
    iconId: number;       // the server's own icon
}

// Can this client be heard in its channel? TeamSpeak's rule: enough talk power, or made a talker. Unknown
// numbers count as "yes" (as before), so nobody is silenced on a guess.
function canTalkIn(c: ClientData, channels: Map<number, ChannelData>): boolean {
    if (c.isTalker) return true;
    const needed = channels.get(c.cid)?.neededTalkPower ?? null;
    if (needed === null || needed <= 0 || c.talkPower === null) return true;
    return c.talkPower >= needed;
}

interface ChatMessage {
    id: string;
    invokerid: number;
    invokername: string;
    targetmode: number;
    cid?: number;         // the channel a channel message was written in
    msg: string;
    timestamp: string;
    time: number;         // ms; the page formats it for the viewer (and the chat history keeps it)
    invokeruid?: string;  // the sender's identity, for their avatar
    // Private messages (targetmode 1): the other person by their identity, and whether we sent it.
    partnerUid?: string;
    partnerName?: string;
    outgoing?: boolean;
    // A join/leave line instead of a message (chat-events.ts): kept and sent like one.
    event?: EventPart[];
}

// --- STATE MANAGEMENT ---
const activeBots = new Map<string, Ts3Client>();
// One connection per person: the TeamSpeak server allows one client per identity ("too many clones",
// error 521), and every device of a person uses the same identity. The newest device takes over.
const sessionByKey = new Map<string, Socket>();

function waitForBotGone(bot: Ts3Client, ms: number): Promise<void> {
    return new Promise((resolve) => {
        if (bot.getState() === 'disconnected') return resolve();
        const timer = setTimeout(resolve, ms);
        bot.once('disconnected', () => { clearTimeout(timer); resolve(); });
    });
}

// --- PICTURES IN THE CHAT ---
// A picture sent from WebTS goes into the channel's file browser (PICTURE_FOLDER) and a [img]ts3image://… line into
// the chat, which the TeamSpeak app shows as the picture (pictures.ts). The page shows such lines through
// /channel-image. Every transfer uses the person's own TeamSpeak connection, so they can send and see only what
// their TeamSpeak permissions allow.
const PICTURE_SERVE_MAX = IMAGE_MAX_BYTES + 1024 * 1024; // 16 MB: also pictures the TeamSpeak app put there
const pictureCache = new PictureCache();
const pictureFetches = new Map<string, Promise<Buffer>>();         // the same picture asked for twice at once

// --- PACING ---
// The TeamSpeak server counts commands per connection and per address, and every WebTS user shares the bridge's
// address. Too many at once and it answers "client is flooding" (524) and ignores them; more, and it bans the address
// for a while (3329), which shuts out every WebTS user. Sent in one burst right after connecting, the channel
// subscriptions were ignored and nobody in other channels was visible. So the commands sent in bulk (the start-up lists, channel subscriptions, stream info requests) leave one at a
// time, PACE_MS apart, for all connections together. What a person does (chat, moving, muting) still goes at once.
// Measured on a TeamSpeak 6 test server (2026-10-14): 18 of these commands at once passed, 36 at once got 9 refused;
// 100 ms apart is well inside that. (It was 250 ms, which made opening the page slow.)
const PACE_MS = 100;
let paceChain: Promise<void> = Promise.resolve();
function paced(work: () => void): Promise<void> {
    const run = paceChain.then(() => {
        try { work(); } catch (e) {}
    });
    paceChain = run.then(() => new Promise<void>((resolve) => setTimeout(resolve, PACE_MS)));
    return run;
}
function sendPaced(bot: Ts3Client, cmd: string): Promise<void> {
    return paced(() => {
        if (bot.getState() === 'connected') bot.sendCommand(cmd);
    });
}

// File transfers (pictures, icons, avatars) don't count towards the flood limit: on the same test server 300 requests
// at once were all accepted. So they skip the pacing, and a few run side by side per connection (they used to go one
// at a time, which made a page full of avatars and pictures fill in one by one).
const TRANSFERS_AT_ONCE = 4;
const transferSlots = new WeakMap<Ts3Client, { running: number; waiting: (() => void)[] }>();
function queueTransfer<T>(bot: Ts3Client, work: () => Promise<T>): Promise<T> {
    let slots = transferSlots.get(bot);
    if (!slots) transferSlots.set(bot, slots = { running: 0, waiting: [] });
    const s = slots;
    const turn = new Promise<void>((resolve) => {
        if (s.running < TRANSFERS_AT_ONCE) { s.running++; resolve(); }
        else s.waiting.push(resolve); // the slot is handed over when one finishes
    });
    return turn.then(work).finally(() => {
        const next = s.waiting.shift();
        if (next) next();
        else s.running--;
    });
}

function fetchPicture(personKey: string, bot: Ts3Client, cid: number, fullPath: string): Promise<Buffer> {
    const key = `${personKey}|${cid}|${fullPath}`;
    const cached = pictureCache.get(key);
    if (cached) return Promise.resolve(cached);
    const running = pictureFetches.get(key);
    if (running) return running;
    const fetching = queueTransfer(bot, () => downloadFile(bot, TS_HOST, cid, fullPath, PICTURE_SERVE_MAX))
        .then((data) => {
            pictureCache.set(key, data);
            return data;
        })
        .finally(() => pictureFetches.delete(key));
    pictureFetches.set(key, fetching);
    return fetching;
}

function pictureErrorText(e: any): string {
    if (e instanceof FileTransferError) {
        if (e.code === 2568) return "You don't have permission to upload pictures in this channel.";
        if (e.code) return `TeamSpeak refused the picture (${e.code}: ${e.message}).`;
        return `The picture couldn't be saved (${e.message}).`;
    }
    return "The picture couldn't be sent.";
}

app.get('/channel-image', async (req, res) => {
    const person = await access.identify(req);
    if (!person) return res.status(403).end();
    const ref = channelImageRef(req.query as Record<string, unknown>);
    if (!ref) return res.status(404).end();
    // Only while the person is on the server (the page tries again once it has connected).
    const bot = await waitForSessionBot(person.key);
    if (!bot) return res.status(503).set('Retry-After', '3').end();
    try {
        const data = await fetchPicture(person.key, bot, ref.cid, ref.fullPath);
        const type = imageType(data);
        if (!type) return res.status(415).end();
        res.set({
            'Content-Type': type.mime,
            'Content-Length': String(data.length),
            'Cache-Control': 'private, max-age=86400',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'none'; sandbox",
            'Content-Disposition': 'inline'
        });
        res.end(data);
    } catch (e: any) {
        console.log(`[Pictures] Couldn't fetch ${ref.fullPath} in channel ${ref.cid} for ${person.key}: ${e.message}${e.code ? ` (${e.code})` : ''}`);
        res.status(404).end();
    }
});

// --- SERVER ICONS AND AVATARS ---
// The page shows the server's own icons (channels, groups, people, the server) and avatars, from the server's files
// (channel 0), fetched with the asking person's own connection like the pictures. Every client may fetch these (the
// TeamSpeak app does), so they are kept for everyone: 30 MB, 6 hours; a missing one isn't asked again for 10 minutes.
const iconCache = new PictureCache(30 * 1024 * 1024, 6 * 60 * 60 * 1000);
const iconMissing = new Map<string, number>();        // file -> until when it counts as missing
const avatarFound = new Map<string, string>();        // identity -> the avatar file name that worked
let avatarNamingLogged = false;

function sessionBot(personKey: string): Ts3Client | null {
    const session = sessionByKey.get(personKey);
    const bot = session ? activeBots.get(session.id) : undefined;
    return bot && bot.getState() === 'connected' ? bot : null;
}

// Right after the page opens, it asks for pictures and icons before the person's TeamSpeak connection is up. Instead of
// "try again later", wait for the connection a little, so they come as soon as it is.
async function waitForSessionBot(personKey: string, ms = 10_000): Promise<Ts3Client | null> {
    const until = Date.now() + ms;
    for (;;) {
        const bot = sessionBot(personKey);
        if (bot || Date.now() >= until) return bot;
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
}

async function fetchServerFile(bot: Ts3Client, name: string, maxBytes: number): Promise<Buffer | null> {
    const cached = iconCache.get(name);
    if (cached) return cached;
    if ((iconMissing.get(name) || 0) > Date.now()) return null;
    try {
        const data = await queueTransfer(bot, () => downloadFile(bot, TS_HOST, 0, name, maxBytes));
        iconCache.set(name, data);
        return data;
    } catch (e: any) {
        iconMissing.set(name, Date.now() + 10 * 60 * 1000);
        if (iconMissing.size > 2000) iconMissing.clear();
        return null;
    }
}

function sendIcon(res: express.Response, data: Buffer, svgAllowed: boolean): void {
    const type = iconType(data);
    if (!type || (type.svg && !svgAllowed)) {
        res.status(415).end();
        return;
    }
    res.set({
        'Content-Type': type.mime,
        'Content-Length': String(data.length),
        'Cache-Control': 'private, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
        // An SVG opened on its own can't run anything (as a picture in the page it never can).
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
        'Content-Disposition': 'inline'
    });
    res.end(data);
}

app.get('/server-icon', async (req, res) => {
    const person = await access.identify(req);
    if (!person) return res.status(403).end();
    const name = iconFileName(Number(req.query.id));
    if (!name) return res.status(404).end();
    const bot = await waitForSessionBot(person.key);
    if (!bot) return res.status(503).set('Retry-After', '3').end();
    const data = await fetchServerFile(bot, name, ICON_MAX_BYTES);
    if (!data) return res.status(404).end();
    sendIcon(res, data, true);
});

app.get('/avatar', async (req, res) => {
    const person = await access.identify(req);
    if (!person) return res.status(403).end();
    const uid = typeof req.query.uid === 'string' ? req.query.uid : '';
    const serverName = typeof req.query.name === 'string' ? req.query.name : undefined;
    const known = avatarFound.get(uid);
    const names = known ? [known] : avatarFileNames(uid, serverName);
    if (!names.length) return res.status(404).end();
    const bot = await waitForSessionBot(person.key);
    if (!bot) return res.status(503).set('Retry-After', '3').end();
    for (const [i, name] of names.entries()) {
        const data = await fetchServerFile(bot, name, AVATAR_MAX_BYTES);
        if (!data) continue;
        if (!known) {
            avatarFound.set(uid, name);
            if (avatarFound.size > 2000) avatarFound.clear();
            if (!avatarNamingLogged) {
                avatarNamingLogged = true;
                console.log(`[Icons] Avatar files are named by guess ${i + 1} of ${names.length}${serverName ? ' (the server sent a name)' : ''}`);
            }
        }
        return sendIcon(res, data, false);
    }
    res.status(404).end();
});

// --- WEBSOCKET EVENT LISTENERS ---
io.on('connection', async (socket) => {
    // The person access.ts let in. Identity, settings and "one connection per person" go by their key.
    const person: Person = (socket as any).person;
    const email: string = person.key;
    const socketId = socket.id;

    // The nickname the page asks for (its settings), else the name from the sign-in.
    const requestedNick = typeof socket.handshake.query.nick === 'string' ? socket.handshake.query.nick.trim().slice(0, 30) : '';
    const namePart = requestedNick || person.name || 'Guest';
    const botNickname = `${config.nickPrefix}${namePart.charAt(0).toUpperCase() + namePart.slice(1)}`.slice(0, 30);

    console.log(`[WebSocket] Client connected: ${email}. Preparing TS bot: ${botNickname}...`);
    // The settings the page follows (its menu links and the picture limit).
    socket.emit('webts-config', {
        logoutUrl: config.logoutUrl,
        backUrl: config.backUrl,
        backLabel: config.backLabel,
        picturesEnabled: config.picturesEnabled,
        pictureMaxMb: config.pictureMaxMb
    });

    // Cleanup is registered first: a page closed while its bot is still connecting must not leave the bot
    // on the server (it would hold the identity and refuse the next connection).
    let closed = false;
    let historyOpen = false;
    socket.on('disconnect', () => {
        closed = true;
        if (historyOpen && chatHistory) void chatHistory.release(email); // written now
        console.log(`[WebSocket] Client disconnected: ${email}. Cleaning up bot...`);
        const bot = activeBots.get(socketId);
        if (bot) {
            bot.disconnect();
            activeBots.delete(socketId);
        }
        if (sessionByKey.get(email) === socket) sessionByKey.delete(email);
    });

    // The same person on another device: that page is told and closed, and its bot leaves first.
    const previous = sessionByKey.get(email);
    sessionByKey.set(email, socket);
    if (previous && previous.id !== socketId) {
        console.log(`[WebSocket] ${email} connected on another device: closing the earlier connection.`);
        const oldBot = activeBots.get(previous.id);
        previous.emit('session-replaced');
        previous.disconnect(true);
        if (oldBot) await waitForBotGone(oldBot, 3000);
        await new Promise((resolve) => setTimeout(resolve, 500)); // the server forgets the old client
    }

    const channels = new Map<number, ChannelData>();
    const clients = new Map<number, ClientData>();
    const messages: ChatMessage[] = [];
    // Keyed by the streamer's client id, so a new stream replaces their old one
    const activeStreams = new Map<number, string>();
    let serverInfo: ServerInfo = {
        name: 'Teamspeak Server',
        welcomeMessage: '',
        platform: '',
        version: '',
        maxClients: 0,
        created: 0,
        startedAt: 0,
        bannerImage: '',
        bannerLink: '',
        websiteUrl: '',
        websiteName: '',
        iconId: 0
    };
    // Server and channel groups by number (their names and icons).
    const serverGroupList = new Map<number, GroupData>();
    const channelGroupList = new Map<number, GroupData>();
    // A person's icon fields from a list or an update; a copy without them keeps what is known.
    const iconFields = (clid: number, g: Record<string, string>) => {
        const old = clients.get(clid);
        return {
            iconId: g.client_icon_id !== undefined ? iconId(g.client_icon_id) : old?.iconId ?? 0,
            serverGroups: g.client_servergroups !== undefined ? groupIds(g.client_servergroups) : old?.serverGroups ?? [],
            channelGroup: g.client_channel_group_id !== undefined ? (parseInt(g.client_channel_group_id) || 0) : old?.channelGroup ?? 0,
            avatar: g.client_flag_avatar !== undefined ? g.client_flag_avatar : old?.avatar ?? '',
            avatarName: g.client_base64HashClientUID || old?.avatarName
        };
    };
    const channelExtras = (cid: number, g: Record<string, string>) => {
        const old = channels.get(cid);
        const banner = (v: string) => (/^(https|ts3image):\/\/[^\s]{1,500}$/i.test(v) ? v : '');
        return {
            iconId: g.channel_icon_id !== undefined ? iconId(g.channel_icon_id) : old?.iconId ?? 0,
            permanent: g.channel_flag_permanent !== undefined ? g.channel_flag_permanent === '1' : old?.permanent ?? true,
            bannerUrl: g.channel_banner_gfx_url !== undefined ? banner(g.channel_banner_gfx_url) : old?.bannerUrl ?? '',
            bannerMode: g.channel_banner_mode !== undefined ? (parseInt(g.channel_banner_mode) || 0) : old?.bannerMode ?? 0
        };
    };
    // Once per connection: which banner fields the server sends (names only), to see what TeamSpeak 6 uses.
    let channelFieldsLogged = false;
    const logChannelFields = (list: Record<string, string>[]) => {
        if (channelFieldsLogged || !list.length) return;
        channelFieldsLogged = true;
        const keys = new Set<string>();
        for (const g of list) for (const k of Object.keys(g)) if (/banner|permanent/.test(k)) keys.add(k);
        console.log(`[Channels] Banner/permanent fields from the server: ${[...keys].join(', ') || 'none'}`);
    };
    const readGroups = (target: Map<number, GroupData>, idKey: string, list: Record<string, string>[]) => {
        for (const g of list) {
            const id = parseInt(g[idKey]);
            if (!(id > 0)) continue;
            target.set(id, { id, name: g.name || '', iconId: iconId(g.iconid), sortId: parseInt(g.sortid || '0') || 0, type: parseInt(g.type ?? '1') || 0 });
        }
    };
    let ownTalkPower: number | null = null; // from initserver, for our own entry until the server lists us
    // TeamSpeak sends the lists more than once, and not every copy carries the talk power: a copy without
    // it keeps what is known (the "can't talk" mark flashed and went away).
    const knownTalkPower = (clid: number, v: string | undefined): number | null => {
        const n = tsNumber(v);
        if (n !== null) return n;
        const known = clients.get(clid)?.talkPower ?? null;
        if (known !== null) return known;
        return userBot && clid === userBot.getClientId() ? ownTalkPower : null;
    };
    const knownNeededTalkPower = (cid: number, v: string | undefined): number | null =>
        tsNumber(v) ?? channels.get(cid)?.neededTalkPower ?? null;
    // One log line whenever our own talk situation changes (not per update).
    let lastTalkLog = '';
    const logOwnTalk = () => {
        const self = userBot ? clients.get(userBot.getClientId()) : undefined;
        if (!self) return;
        const needed = channels.get(self.cid)?.neededTalkPower ?? null;
        const line = `talk power ${self.talkPower ?? '?'}${self.isTalker ? ' (talker)' : ''}, channel ${self.cid} needs ${needed ?? '?'}: ${canTalkIn(self, channels) ? 'can talk' : "can't talk"}`;
        if (line === lastTalkLog) return;
        lastTalkLog = line;
        console.log(`[Talk] ${botNickname}: ${line}`);
    };
    // The server's own fields (initserver at the start, notifyserverupdated later). Only https links are kept.
    const readServerFields = (g: Record<string, string>) => {
        const https = (v: string | undefined) => (typeof v === 'string' && /^https:\/\/[^\s]+$/i.test(v) ? v : '');
        if (g.virtualserver_name) serverInfo.name = g.virtualserver_name;
        const welcome = g.virtualserver_welcomemessage ?? g.virtualserver_welcome_message;
        if (welcome !== undefined) serverInfo.welcomeMessage = welcome;
        if (g.virtualserver_platform) serverInfo.platform = g.virtualserver_platform;
        if (g.virtualserver_version) serverInfo.version = g.virtualserver_version;
        const max = tsNumber(g.virtualserver_maxclients);
        if (max !== null) serverInfo.maxClients = max;
        const created = tsNumber(g.virtualserver_created);
        if (created !== null) serverInfo.created = created;
        const uptime = tsNumber(g.virtualserver_uptime);
        if (uptime !== null) serverInfo.startedAt = Date.now() - uptime * 1000;
        if (g.virtualserver_hostbanner_gfx_url !== undefined) serverInfo.bannerImage = https(g.virtualserver_hostbanner_gfx_url);
        if (g.virtualserver_hostbanner_url !== undefined) serverInfo.bannerLink = https(g.virtualserver_hostbanner_url);
        if (g.virtualserver_hostbutton_url !== undefined) serverInfo.websiteUrl = https(g.virtualserver_hostbutton_url);
        if (g.virtualserver_hostbutton_tooltip !== undefined) serverInfo.websiteName = g.virtualserver_hostbutton_tooltip;
        if (g.virtualserver_icon_id !== undefined) serverInfo.iconId = iconId(g.virtualserver_icon_id);
    };

    let userBot: Ts3Client | null = null;
    let refusedAsClone = false;    // TS3 error 521 while connecting: our previous connection is still there
    // Private messages we sent, in order: the server's echo of each is filed under its recipient.
    const pendingPrivateTargets: { clid: number; uid: string; name: string }[] = [];
    let watchedStream: { id: string; streamerClid: number } | null = null;
    // Our own screen share: asked for with setupstream, its id comes in notifystreamstarted.
    let publishPending = false;
    let publishedStreamId: string | null = null;
    const publishSignal = (clid: number, payload: unknown, what: string) => {
        if (!userBot || !publishedStreamId) return;
        const returnCode = `publish-signal-${++streamCommandCounter}`;
        streamLog('out', `streamsignaling (share) ${what}`, `id=${publishedStreamId} clid=${clid} return_code=${returnCode}`);
        userBot.sendCommand(buildCommand('streamsignaling', {
            id: publishedStreamId,
            clid,
            json: JSON.stringify(payload),
            return_code: returnCode
        }));
    };
    let pendingStreamJoin = false;
    // WATCH pressed before the stream's id was known: joined as soon as notifystreaminfo brings it.
    let pendingWatchClid: number | null = null;
    // UI sounds: the page plays TeamSpeak's sound for these events. Quiet for the first seconds
    // after connecting, while the server lists who is already there.
    let soundsFrom = Date.now() + 3000;
    const sound = (name: string) => {
        if (Date.now() >= soundsFrom && socket.connected) socket.emit('ts-sound', name);
    };
    const myCid = () => (userBot ? (clients.get(userBot.getClientId())?.cid || 0) : 0);
    // Join and leave lines: filed in a channel's chat with the messages, like the TeamSpeak app keeps them in its chat
    // history. Not in the first seconds after connecting, while the server lists who is there.
    const label = (cid: number) => channelLabel(channels.get(cid)?.name);
    // Who made each channel: TeamSpeak moves the maker into it "by Server", which reads like a switch of their own.
    const channelMaker = new Map<number, number>();
    // Kept for the following days too, when the chat history is on.
    const keepInHistory = (m: ChatMessage) => {
        if (historyOpen && chatHistory) chatHistory.add(email, m);
    };
    const chatEvent = (cid: number, parts: EventPart[] | null) => {
        if (!parts || !(cid > 0) || Date.now() < soundsFrom) return;
        const msgObj: ChatMessage = {
            id: Date.now().toString() + Math.random().toString(36).substring(2, 6),
            invokerid: 0,
            invokername: '',
            targetmode: 2,
            cid,
            msg: '',
            time: Date.now(), // the page shows it in the viewer's own time format
            timestamp: new Date().toISOString().slice(11, 16),
            event: parts
        };
        keepInHistory(msgObj);
        messages.push(msgObj);
        if (messages.length > 200) messages.shift();
        if (socket.connected) socket.emit('ts-message', msgObj);
    };
    // Seeing the people in other channels takes a subscription to them (paced, and checked). The server
    // confirms each with notifychannelsubscribed; what isn't confirmed a few seconds later is asked again (twice).
    const subscribedChannels = new Set<number>();
    // Each request checks back on its own channels, so a later one (a channel created after connecting) doesn't
    // cancel an earlier one's retries.
    const subscribeTimers = new Set<ReturnType<typeof setTimeout>>();
    const subscribeChannels = (cids: number[], attempt = 0) => {
        const bot = userBot;
        if (!bot) return;
        const missing = cids.filter((cid) => !subscribedChannels.has(cid) && channels.has(cid));
        if (!missing.length) return;
        if (attempt > 0) console.log(`[Channels] ${botNickname}: ${missing.length} channel(s) without a subscription confirmation, asking again (${attempt}/2)`);
        for (let i = 0; i < missing.length; i += 50) {
            sendPaced(bot, `channelsubscribe ${missing.slice(i, i + 50).map((id) => `cid=${id}`).join('|')}`);
        }
        if (attempt < 2) {
            const timer = setTimeout(() => { subscribeTimers.delete(timer); subscribeChannels(missing, attempt + 1); }, 6000);
            subscribeTimers.add(timer);
        }
    };
    const requestStreamInfo = (clid: number) => {
        if (!userBot || !(clid > 0)) return;
        streamLog('out', 'requeststreaminfo', `clid=${clid}`);
        sendPaced(userBot, buildCommand('requeststreaminfo', { clid: String(clid), return_code: `stream-info-${++streamCommandCounter}` }));
    };
    
    function sendStateUpdate() {
        if (!socket.connected) return;
        logOwnTalk();
        socket.emit('ts-state', {
            connected: userBot ? userBot.getState() === 'connected' : false,
            selfClid: userBot ? userBot.getClientId() : 0,
            // Our own entry's channel: the library's getChannelId() is only the channel joined at start (no moves).
            currentChannelId: userBot ? (clients.get(userBot.getClientId())?.cid ?? 0) : 0,
            serverInfo,
            channels: Array.from(channels.values()).sort((a, b) => a.order - b.order || a.cid - b.cid),
            // Without ServerQuery clients (such as serveradmin)
            // canTalk: can they be heard in their channel (the page glows and sends voice only then).
            clients: Array.from(clients.values()).filter(c => c.type === 0).map(c => ({ ...c, canTalk: canTalkIn(c, channels) })),
            // The groups with an icon, for the badges.
            serverGroups: Array.from(serverGroupList.values()).filter(g => g.iconId > 0),
            channelGroups: Array.from(channelGroupList.values()).filter(g => g.iconId > 0),
            messages
        });
    }

    // The days before: sent once, before TeamSpeak connects (not with every state update).
    if (chatHistory && !closed) {
        historyOpen = true;
        const past = await chatHistory.open(email);
        if (closed) return;
        if (past.length) socket.emit('ts-history', past);
    }

    try {
        const userSpecificIdentity = await getUserIdentity(email);
        if (closed) return;

        userBot = new Ts3Client();
        activeBots.set(socketId, userBot);

        // --- Sending voice in the channel's own codec ---
        (userBot as any).sendVoice = function(opusData: Buffer) {
            if (this.state !== "connected") return;
            
            let targetCodec = 4; // Oletuksena Opus Voice (4)
            const botClid = this.getClientId();
            const botClient = clients.get(botClid);
            
            if (botClient && botClient.cid) {
                const currentChannel = channels.get(botClient.cid);
                if (currentChannel && currentChannel.codec !== undefined) {
                    targetCodec = currentChannel.codec;
                }
            }

            // Always Opus (Voice 4 or Music 5): the page encodes nothing else
            if (targetCodec !== 4 && targetCodec !== 5) {
                targetCodec = 4;
            }

            const voiceBuf = Buffer.alloc(3 + opusData.length);
            voiceBuf[2] = targetCodec; 
            opusData.copy(voiceBuf, 3);
            (this as any).sendOutgoing(voiceBuf, 0 /* PacketType.Voice */);
        };

        userBot.on('command', (parsed: ParsedCommand) => {
            interface FlatParams { [key: string]: string; }
            
            function flattenParams(p: Record<string, string>): FlatParams {
                for (const k of Object.keys(p)) {
                    const stripped = k.replace(/^\\?"?/, '').replace(/^'/, '');
                    if (stripped.startsWith('{')) {
                        try {
                            const json = JSON.parse(stripped);
                            if (typeof json === 'object' && !Array.isArray(json)) {
                                const flat: FlatParams = {};
                                for (const [jk, jv] of Object.entries(json)) {
                                    flat[jk] = String(jv);
                                }
                                return flat;
                            }
                        } catch (e) {}
                    }
                    try {
                        const quoted = k.replace(/^"/, '').replace(/"$/, '');
                        if (quoted.startsWith('{')) {
                            const json = JSON.parse(quoted);
                            if (typeof json === 'object' && !Array.isArray(json)) {
                                const flat: FlatParams = {};
                                for (const [jk, jv] of Object.entries(json)) {
                                    flat[jk] = String(jv);
                                }
                                return flat;
                            }
                        }
                    } catch (e) {}
                }
                return p;
            }

            const rawGroups = parsed.groups || [parsed.params];
            const groups = rawGroups.map(g => flattenParams(g));

            switch (parsed.name) {
                case 'initserver': {
                    const g = groups.length > 0 ? groups[0] : parsed.params;
                    readServerFields(g);
                    ownTalkPower = tsNumber(g.client_talk_power);
                    sendStateUpdate();
                    break;
                }

                case 'notifyserverupdated': {
                    readServerFields(groups.length > 0 ? groups[0] : parsed.params);
                    sendStateUpdate();
                    break;
                }

                case 'clientlist': {
                    for (const g of groups) {
                        const clid = parseInt(g.clid);
                        if (clid > 0) {
                            const isStreaming = g.client_is_streaming === '1';
                            clients.set(clid, {
                                clid,
                                cid: parseInt(g.cid || '0') || 0,
                                nickname: g.client_nickname || `Client ${clid}`,
                                type: parseInt(g.client_type || '0') || 0,
                                uid: g.client_unique_identifier || '',
                                away: g.client_away === '1',
                                awayMsg: g.client_away_message || '',
                                inputMuted: g.client_input_muted === '1',
                                outputMuted: g.client_output_muted === '1',
                                isTalker: g.client_is_talker === '1',
                                isTalking: g.client_flag_talking === '1',
                                isSelf: clid === (userBot ? userBot.getClientId() : 0),
                                isStreaming,
                                myTeamSpeakId: g.client_myteamspeak_id,
                                userTag: g.client_user_tag,
                                talkPower: knownTalkPower(clid, g.client_talk_power),
                                ...iconFields(clid, g)
                            });
                            // TS6 announces nothing for a stream that was already running when we joined: only
                            // client_is_streaming is set, and the stream id is pulled with requeststreaminfo
                            // (answered by notifystreaminfo; as WebSpeak3 does).
                            if (isStreaming) requestStreamInfo(clid);
                        }
                    }
                    sendStateUpdate();
                    break;
                }

                case 'channellist': {
                    for (const g of groups) {
                        const cid = parseInt(g.cid);
                        if (!isNaN(cid) && cid >= 0) {
                            channels.set(cid, {
                                cid,
                                pid: parseInt(g.cpid || g.pid || '0') || 0,
                                name: g.channel_name || `Channel ${cid}`,
                                topic: g.channel_topic || '',
                                order: parseInt(g.channel_order || '0') || 0,
                                isDefault: g.channel_flag_default === '1',
                                isPassword: g.channel_flag_password === '1',
                                codec: parseInt(g.channel_codec || '4'),
                                neededTalkPower: knownNeededTalkPower(cid, g.channel_needed_talk_power),
                                ...channelExtras(cid, g)
                            });
                        }
                    }
                    logChannelFields(groups);
                    sendStateUpdate();
                    break;
                }

                case 'clientinfo': {
                    const g = groups.length > 0 ? groups[0] : parsed.params;
                    const clid = parseInt(g.clid || '0');
                    const existing = clients.get(clid);
                    if (existing) {
                        existing.myTeamSpeakId = g.client_myteamspeak_id || existing.myTeamSpeakId;
                        existing.userTag = g.client_user_tag || existing.userTag;
                    }

                    const streamId = g.client_stream_id || g.client_streaming_id || g.stream_id;
                    if (clid > 0 && streamId) {
                        activeStreams.set(clid, streamId);
                        if (existing) existing.isStreaming = true;
                        sendStateUpdate();
                    }
                    break;
                }

                case 'channellistfinished': {
                    if (userBot) {
                        const botClid = userBot.getClientId();
                        let botCid = 0;
                        
                        // 1. Our own channel
                        for (const [cid, ch] of channels) {
                            if (ch.isDefault) { botCid = cid; break; }
                        }
                        if (botCid === 0 && channels.size > 0) {
                            botCid = channels.values().next().value.cid;
                        }

                        // 2. Our own entry, until the server lists us
                        if (botClid > 0 && !clients.has(botClid)) {
                            clients.set(botClid, {
                                clid: botClid,
                                cid: botCid,
                                nickname: botNickname,
                                type: 0,
                                uid: '',
                                away: false,
                                awayMsg: '',
                                inputMuted: false,
                                outputMuted: false,
                                isTalker: false,
                                isTalking: false,
                                isSelf: true,
                                isStreaming: false,
                                talkPower: ownTalkPower,
                                iconId: 0,
                                serverGroups: [],
                                channelGroup: 0,
                                avatar: ''
                            });
                        }

                        // --- 3. Subscribe to the other channels (to see who is in them) ---
                        const cidsToSubscribe: number[] = [];
                        for (const [cid, ch] of channels) {
                            // Not the one we are in
                            if (cid !== botCid) {
                                cidsToSubscribe.push(cid);
                            }
                        }

                        subscribeChannels(cidsToSubscribe);
                    }
                    sendStateUpdate();
                    break;
                }

                case 'notifychannelsubscribed': {
                    for (const g of groups) {
                        const cid = parseInt(g.cid);
                        if (cid > 0) subscribedChannels.add(cid);
                    }
                    break;
                }
                case 'notifychannelunsubscribed': {
                    for (const g of groups) subscribedChannels.delete(parseInt(g.cid));
                    break;
                }

                case 'notifycliententerview': {
                    const botCurrentCid = userBot ? (clients.get(userBot.getClientId())?.cid || 0) : 0;
                    let lastCid = botCurrentCid;
                    let enterReason = 0;

                    for (const g of groups) {
                        const clid = parseInt(g.clid);
                        if (g.reasonid !== undefined) enterReason = parseInt(g.reasonid) || 0;
                        if (clid > 0) {
                            // Turvallisempi tarkistus: 'in' operaattori varmistaa ettei falsy-arvoja (kuten 0) pudoteta
                            if ('ctid' in g) lastCid = parseInt(g.ctid);
                            else if ('cid' in g) lastCid = parseInt(g.cid);
                            else if ('ctargetid' in g) lastCid = parseInt(g.ctargetid);
                            else if ('cfid' in g) lastCid = parseInt(g.cfid);

                            clients.set(clid, {
                                clid,
                                cid: lastCid,
                                nickname: g.client_nickname || `Client ${clid}`,
                                type: parseInt(g.client_type || '0') || 0,
                                uid: g.client_unique_identifier || '',
                                away: g.client_away === '1',
                                awayMsg: g.client_away_message || '',
                                inputMuted: g.client_input_muted === '1',
                                outputMuted: g.client_output_muted === '1',
                                isTalker: g.client_is_talker === '1',
                                isTalking: g.client_flag_talking === '1',
                                isSelf: clid === (userBot ? userBot.getClientId() : 0),
                                isStreaming: g.client_is_streaming === '1',
                                talkPower: knownTalkPower(clid, g.client_talk_power),
                                ...iconFields(clid, g)
                            });
                            // Someone connected into our channel (reasonid 0 = a new connection).
                            if (enterReason === 0 && clid !== (userBot ? userBot.getClientId() : 0)
                                && lastCid === botCurrentCid && botCurrentCid > 0 && g.client_type !== '1') {
                                sound('neutral_connection_connected_currentchannel');
                            }
                            // Its line: connected, or came over from a channel we don't see (cfid).
                            if (clid !== (userBot ? userBot.getClientId() : 0) && lastCid === botCurrentCid
                                && botCurrentCid > 0 && g.client_type !== '1') {
                                const cfid = parseInt(g.cfid || '0') || 0;
                                chatEvent(botCurrentCid, enterEvent(g.client_nickname || `Client ${clid}`, cfid > 0 ? label(cfid) : undefined));
                            }
                        }
                    }
                    sendStateUpdate();
                    break;
                }

                case 'notifyclientleftview': {
                    let lastCtid = 0;
                    let lastReasonId = 0;
                    let invoker = '';
                    let reasonMsg = '';

                    for (const g of groups) {
                        if (g.ctid) lastCtid = parseInt(g.ctid);
                        if (g.reasonid) lastReasonId = parseInt(g.reasonid);
                        if (g.invokername !== undefined) invoker = g.invokername;
                        if (g.reasonmsg !== undefined) reasonMsg = g.reasonmsg;

                        const clid = parseInt(g.clid);
                        if (clid > 0) {
                            // Its line: left our channel for one we don't see, or left the server.
                            const gone = clients.get(clid);
                            if (clid === (userBot ? userBot.getClientId() : 0)) {
                                chatEvent(myCid(), leaveEvent(gone?.nickname || '', true, lastReasonId, invoker, reasonMsg));
                            } else if (gone && gone.cid === myCid() && gone.type === 0) {
                                chatEvent(myCid(), lastCtid > 0 && [0, 1, 4].includes(lastReasonId)
                                    ? moveEvent({ who: gone.nickname, self: false, intoHere: false,
                                        reason: lastReasonId === 1 && channelMaker.get(lastCtid) === clid ? 0 : lastReasonId, // see channelMaker
                                        from: label(gone.cid), to: label(lastCtid), invoker, reasonMsg })
                                    : leaveEvent(gone.nickname, false, lastReasonId, invoker, reasonMsg));
                            }
                            // Sounds: we were kicked or banned; or someone in our channel left, dropped, was kicked or banned.
                            const selfId = userBot ? userBot.getClientId() : 0;
                            if (clid === selfId) {
                                if (lastReasonId === 5) sound('you_kicked_server');
                                if (lastReasonId === 6) sound('you_were_banned');
                            } else if (clients.get(clid)?.cid === myCid() && clients.get(clid)?.type === 0) {
                                const leftSound: Record<number, string> = {
                                    3: 'neutral_connection_connectionlost_currentchannel',
                                    5: 'neutral_kicked_server_currentchannel',
                                    6: 'neutral_banned_server_currentchannel',
                                    8: 'neutral_connection_disconnected_currentchannel'
                                };
                                if (leftSound[lastReasonId]) sound(leftSound[lastReasonId]);
                            }
                            // reasonid 1 = switched channel, others = disconnect/kick
                            if (lastReasonId === 1 && lastCtid > 0 && clients.has(clid)) {
                                clients.get(clid)!.cid = lastCtid;
                                clients.get(clid)!.isTalking = false;
                            } else if (lastReasonId !== 1) {
                                clients.delete(clid);
                            }
                        }
                    }
                    sendStateUpdate();
                    break;
                }

                case 'notifyclientmoved': {
                    let lastCtid = 0;
                    let moveReason = 0;
                    let invoker = '';
                    let reasonMsg = '';
                    const botClid = userBot ? userBot.getClientId() : 0;

                    for (const g of groups) {
                        if (g.ctid) lastCtid = parseInt(g.ctid);
                        else if (g.cid) lastCtid = parseInt(g.cid);
                        if (g.reasonid !== undefined) moveReason = parseInt(g.reasonid) || 0;
                        if (g.invokername !== undefined) invoker = g.invokername;
                        if (g.reasonmsg !== undefined) reasonMsg = g.reasonmsg;

                        const clid = parseInt(g.clid);
                        if (clid > 0 && clients.has(clid)) {
                            // Its line: our own move goes into the new channel's chat, someone else's into ours.
                            const mover = clients.get(clid)!;
                            const here = myCid();
                            const ownChannel = moveReason === 1 && channelMaker.get(lastCtid) === clid;
                            const move = { who: mover.nickname, reason: ownChannel ? 0 : moveReason, from: label(mover.cid), to: label(lastCtid), invoker, reasonMsg };
                            if (clid === botClid) chatEvent(lastCtid, moveEvent({ ...move, self: true, intoHere: false }));
                            else if (mover.type === 0 && lastCtid === here) chatEvent(here, moveEvent({ ...move, self: false, intoHere: true }));
                            else if (mover.type === 0 && mover.cid === here) chatEvent(here, moveEvent({ ...move, self: false, intoHere: false }));
                            // Sounds (reasonid 0 = switched, 1 = moved by someone, 4 = kicked from the channel).
                            const kind = moveReason === 1 ? 'moved' : moveReason === 4 ? 'kicked_channel' : 'switched';
                            if (clid === botClid) {
                                sound(moveReason === 1 ? 'you_were_moved' : moveReason === 4 ? 'you_kicked_channel' : 'channel_switched');
                            } else if (clients.get(clid)!.type === 0) {
                                const here = myCid();
                                if (lastCtid === here) sound(`neutral_${kind}_tocurrentchannel`);
                                else if (clients.get(clid)!.cid === here) sound(`neutral_${kind}_awayfromcurrentchannel`);
                            }
                            clients.get(clid)!.cid = lastCtid;
                            clients.get(clid)!.isTalking = false; // someone who switches channel stops glowing
                            
                            // JOS VAIHTAJA OLI BOTTI ITSE:
                            // When we switch, nobody is talking any more: we no longer hear the old channel's stop messages
                            if (clid === botClid) {
                                clients.forEach(c => c.isTalking = false);
                            }
                        }
                    }
                    sendStateUpdate();
                    break;
                }

                case 'notifyclientupdated': {
                    for (const g of groups) {
                        const clid = parseInt(g.clid);
                        const clientItem = clients.get(clid);
                        if (clientItem) {
                            if (g.client_nickname) clientItem.nickname = g.client_nickname;
                            if (g.client_input_muted !== undefined) clientItem.inputMuted = g.client_input_muted === '1';
                            if (g.client_output_muted !== undefined) clientItem.outputMuted = g.client_output_muted === '1';
                            if (g.client_away !== undefined) clientItem.away = g.client_away === '1';
                            if (g.client_away_message !== undefined) clientItem.awayMsg = g.client_away_message;
                            if (g.client_flag_talking !== undefined) clientItem.isTalking = g.client_flag_talking === '1';
                            // Talk power changes with server/channel groups; a talker is someone allowed to talk.
                            if (g.client_talk_power !== undefined) clientItem.talkPower = tsNumber(g.client_talk_power);
                            if (g.client_is_talker !== undefined) clientItem.isTalker = g.client_is_talker === '1';
                            Object.assign(clientItem, iconFields(clid, g)); // icon, groups, avatar
                            // Someone in another channel starts or stops a stream: the server sends no notifystreamstarted
                            // there, only this flag (the desktop client shows the stream from it). The stream id is pulled
                            // as for streams already running when we joined.
                            if (g.client_is_streaming !== undefined) {
                                const streaming = g.client_is_streaming === '1';
                                streamLog('in', 'notifyclientupdated', `clid=${clid} client_is_streaming=${g.client_is_streaming}`);
                                if (streaming && !activeStreams.has(clid)) requestStreamInfo(clid);
                                if (!streaming) activeStreams.delete(clid);
                                clientItem.isStreaming = streaming;
                            }
                        }
                    }
                    sendStateUpdate();
                    break;
                }

                // Server and channel groups: their names and icons, and who joins or leaves one.
                case 'notifyservergrouplist':
                case 'servergrouplist': {
                    readGroups(serverGroupList, 'sgid', groups);
                    sendStateUpdate();
                    break;
                }
                case 'notifychannelgrouplist':
                case 'channelgrouplist': {
                    readGroups(channelGroupList, 'cgid', groups);
                    sendStateUpdate();
                    break;
                }
                case 'notifyservergroupclientadded':
                case 'notifyservergroupclientdeleted': {
                    for (const g of groups) {
                        const person = clients.get(parseInt(g.clid));
                        const sgid = parseInt(g.sgid);
                        if (!person || !(sgid > 0)) continue;
                        const others = person.serverGroups.filter((id) => id !== sgid);
                        person.serverGroups = parsed.name === 'notifyservergroupclientadded' ? [...others, sgid] : others;
                    }
                    sendStateUpdate();
                    break;
                }
                case 'notifyclientchannelgroupchanged': {
                    for (const g of groups) {
                        const person = clients.get(parseInt(g.clid));
                        if (person && g.cgid !== undefined) person.channelGroup = parseInt(g.cgid) || 0;
                    }
                    sendStateUpdate();
                    break;
                }

                case 'notifytalkstatuschange': {
                    const g = groups.length > 0 ? groups[0] : parsed.params;
                    const clid = parseInt(g.clid);
                    if (clid > 0 && clients.has(clid)) {
                        clients.get(clid)!.isTalking = g.status === '1';
                    }
                    sendStateUpdate();
                    break;
                }

                case 'notifychannelcreated': {
                    const g = groups.length > 0 ? groups[0] : parsed.params;
                    const cid = parseInt(g.cid);
                    if (cid && g.invokerid) channelMaker.set(cid, parseInt(g.invokerid));
                    if (cid) {
                        channels.set(cid, {
                            cid,
                            pid: parseInt(g.pid || '0') || 0,
                            name: g.channel_name || `Channel ${cid}`,
                            topic: g.channel_topic || '',
                            order: parseInt(g.channel_order || '0') || 0,
                            isDefault: g.channel_flag_default === '1',
                            isPassword: g.channel_flag_password === '1',
                            codec: parseInt(g.channel_codec || '4'),
                            neededTalkPower: knownNeededTalkPower(cid, g.channel_needed_talk_power),
                            ...channelExtras(cid, g)
                        });
                        // A channel made after we connected: without a subscription, people who join it straight
                        // from outside (or connect into it) would stay unseen.
                        subscribeChannels([cid]);
                    }
                    sendStateUpdate();
                    break;
                }

                // A channel dragged to another place: its parent and the channel it now comes after.
                case 'notifychannelmoved': {
                    for (const g of groups) {
                        const channel = channels.get(parseInt(g.cid));
                        if (!channel) continue;
                        if (g.cpid !== undefined) channel.pid = parseInt(g.cpid) || 0;
                        if (g.order !== undefined) channel.order = parseInt(g.order) || 0;
                    }
                    sendStateUpdate();
                    break;
                }

                case 'notifychanneldeleted': {
                    const g = groups.length > 0 ? groups[0] : parsed.params;
                    const cid = parseInt(g.cid);
                    if (cid) { channels.delete(cid); subscribedChannels.delete(cid); channelMaker.delete(cid); }
                    sendStateUpdate();
                    break;
                }

                case 'notifychanneledited': {
                    const g = groups.length > 0 ? groups[0] : parsed.params;
                    const cid = parseInt(g.cid);
                    const channel = channels.get(cid);
                    if (channel) {
                        if (g.channel_name) channel.name = g.channel_name;
                        if (g.channel_topic !== undefined) channel.topic = g.channel_topic;
                        if (g.channel_codec !== undefined) channel.codec = parseInt(g.channel_codec);
                        if (g.channel_needed_talk_power !== undefined) channel.neededTalkPower = tsNumber(g.channel_needed_talk_power);
                        if (g.channel_order !== undefined) channel.order = parseInt(g.channel_order) || 0;
                        Object.assign(channel, channelExtras(cid, g)); // icon, permanence, banner
                    }
                    sendStateUpdate();
                    break;
                }

                case 'notifytextmessage': {
                    const g = groups.length > 0 ? groups[0] : parsed.params;
                    const targetmode = parseInt(g.targetmode || '2');
                    
                    // A channel message (targetmode 2) always arrives in the channel we are in
                    let msgCid = 0;
                    if (targetmode === 2) {
                        msgCid = userBot ? (clients.get(userBot.getClientId())?.cid || 0) : 0;
                    }

                    // Private message: filed under the other person's identity, so a reconnect keeps the conversation.
                    let partnerUid: string | undefined;
                    let partnerName: string | undefined;
                    let outgoing = false;
                    if (targetmode === 1) {
                        const invokerId = parseInt(g.invokerid || '0');
                        if (userBot && invokerId === userBot.getClientId()) {
                            outgoing = true;
                            const sent = pendingPrivateTargets.shift();
                            const partner = clients.get(parseInt(g.target || '0') || sent?.clid || 0);
                            partnerUid = partner?.uid || sent?.uid;
                            partnerName = partner?.nickname || sent?.name;
                        } else {
                            partnerUid = g.invokeruid || clients.get(invokerId)?.uid;
                            partnerName = g.invokername;
                        }
                        if (!partnerUid) break;
                    }

                    const msgObj: ChatMessage = {
                        id: Date.now().toString() + Math.random().toString(36).substring(2, 6),
                        invokerid: parseInt(g.invokerid || '0'),
                        invokername: g.invokername || 'System',
                        invokeruid: g.invokeruid || undefined,
                        targetmode,
                        cid: msgCid,
                        msg: g.msg || '',
                        time: Date.now(), // the page shows it in the viewer's own time format
                        timestamp: new Date().toISOString().slice(11, 16),
                        ...(targetmode === 1 ? { partnerUid, partnerName, outgoing } : {})
                    };
                    keepInHistory(msgObj);
                    messages.push(msgObj);
                    if (messages.length > 200) messages.shift();
                    socket.emit('ts-message', msgObj);
                    sendStateUpdate();
                    break;
                }

                // Someone poked us: the page shows it until dismissed.
                case 'notifyclientpoke': {
                    const g = groups.length > 0 ? groups[0] : parsed.params;
                    socket.emit('ts-poke', {
                        invokerid: parseInt(g.invokerid || '0'),
                        invokername: g.invokername || 'Someone',
                        msg: g.msg || '',
                        time: Date.now(),
                        timestamp: new Date().toISOString().slice(11, 16)
                    });
                    break;
                }

                // --- STRIIMIEN SEURANTA ---
                case 'notifystreaminfo':
                case 'notifystreamstarted': {
                    const g = groups.length > 0 ? groups[0] : parsed.params;
                    const streamId = g?.id || g?.stream_id;
                    const clid = parseInt(g?.clid || '0');
                    streamLog('in', parsed.name, `id=${streamId} clid=${clid} type=${g?.type ?? '?'} audio=${g?.audio ?? '?'}`);
                    
                    if (streamId && clid > 0 && parsed.name === 'notifystreamstarted' && publishPending
                        && userBot && clid === userBot.getClientId()) {
                        // The answer to our own setupstream: the share is live.
                        publishPending = false;
                        publishedStreamId = streamId;
                        socket.emit('publish-started', { streamId });
                    }
                    if (streamId && clid > 0) {
                        activeStreams.set(clid, streamId); // Tallennetaan CLID:n taakse!
                        if (clients.has(clid)) clients.get(clid)!.isStreaming = true;
                        sendStateUpdate();
                        if (pendingWatchClid === clid) {
                            pendingWatchClid = null;
                            joinStream(clid, streamId);
                        }
                    }
                    break;
                }

                case 'notifystreamstopped': {
                    const g = groups.length > 0 ? groups[0] : parsed.params;
                    const clid = parseInt(g?.clid || '0');
                    streamLog('in', 'notifystreamstopped', `id=${g?.id || g?.stream_id} clid=${clid}`);
                    // The stream being watched ended: the page closes its player.
                    const stoppedId = g?.id || g?.stream_id;
                    if (publishedStreamId && stoppedId === publishedStreamId) {
                        publishedStreamId = null;
                        socket.emit('publish-stopped', {});
                    }
                    if (watchedStream && (stoppedId === watchedStream.id || clid === watchedStream.streamerClid)) {
                        socket.emit('stream-ended', { streamId: watchedStream.id });
                        watchedStream = null;
                        pendingStreamJoin = false;
                    }
                    
                    if (clid > 0) {
                        activeStreams.delete(clid);
                        if (clients.has(clid)) clients.get(clid)!.isStreaming = false;
                        sendStateUpdate();
                    }
                    break;
                }


                case 'notifystreamclientjoined':
                case 'notifystreamclientleft': {
                    const g = groups.length > 0 ? groups[0] : parsed.params;
                    streamLog('in', parsed.name, `id=${g?.id} clid=${g?.clid}${g?.reason ? ' reason=' + g.reason : ''}`);
                    if (parsed.name === 'notifystreamclientleft' && publishedStreamId && g?.id === publishedStreamId) {
                        socket.emit('publish-viewer-left', { clid: parseInt(g.clid || '0') });
                    }
                    break;
                }

                // Someone asks to watch our share (is_remove=1: they stopped watching). Everyone may watch, so
                // the page offers each viewer the stream right away.
                case 'notifyjoinstreamrequest': {
                    const g = groups.length > 0 ? groups[0] : parsed.params;
                    const clid = parseInt(g?.clid || '0');
                    streamLog('in', 'notifyjoinstreamrequest', `id=${g?.id} clid=${clid} is_remove=${g?.is_remove ?? '0'}`);
                    if (!publishedStreamId || g?.id !== publishedStreamId || !(clid > 0)) break;
                    if (g.is_remove === '1') socket.emit('publish-viewer-left', { clid });
                    else socket.emit('publish-viewer', { clid, nickname: clients.get(clid)?.nickname || `Client ${clid}` });
                    break;
                }

                // --- WEBRTC SIGNALLING (TeamSpeak -> browser) ---
                case 'notifyrespondjoinstreamrequest': {
                    const g = groups.length > 0 ? groups[0] : parsed.params;
                    const decision = parseInt(g.decision || '0');
                    
                    // The streamer accepted our request: their SDP offer follows
                    pendingStreamJoin = false;
                    streamLog('in', 'notifyrespondjoinstreamrequest', `decision=${decision} fields=${Object.keys(g).join(',')} offer: ${sdpSummary(g.offer)}`);
                    if (decision === 1 && g.offer) {
                        const streamId = g.id || g.stream_id || watchedStream?.id;
                        console.log(`[WebRTC] Received Offer for stream ${streamId}`);
                        socket.emit('webrtc-offer', { streamId, sdp: g.offer });
                    } else {
                        console.log(`[WebRTC] Stream join request denied or no offer.`);
                        socket.emit('webrtc-error', { message: g.msg || 'The stream request was denied.' });
                    }
                    break;
                }

                case 'notifystreamsignaling': {
                    const g = groups.length > 0 ? groups[0] : parsed.params;
                    const dataStr = g.json || g.data || '';
                    if (!dataStr) break;

                    try {
                        const payload = JSON.parse(dataStr);
                        
                        // On accepting us, the streamer sends joinResponse, which carries the WebRTC offer
                        const streamId = g.id || g.stream_id || watchedStream?.id;
                        const sigArgs = payload.args && typeof payload.args === 'object' ? payload.args : {};

                        // A viewer of our own share: its answer and candidates go to the page's sharing side.
                        if (publishedStreamId && (g.id || g.stream_id) === publishedStreamId) {
                            if (payload.cmd !== 'iceCandidate' || STREAM_LOG_VERBOSE) {
                                streamLog('in', `notifystreamsignaling (share) cmd=${payload.cmd}`, `clid=${g.clid}`
                                    + (sigArgs.answer ? ` sdp: ${sdpSummary(sigArgs.answer)}` : ''));
                            }
                            socket.emit('publish-signal', { clid: parseInt(g.clid || '0'), cmd: payload.cmd, args: sigArgs });
                            break;
                        }
                        if (payload.cmd !== 'iceCandidate' || STREAM_LOG_VERBOSE) {
                            streamLog('in', `notifystreamsignaling cmd=${payload.cmd}`, `id=${streamId} clid=${g.clid} args=${Object.keys(sigArgs).join(',')}`
                                + (sigArgs.offer || sigArgs.answer ? ` sdp: ${sdpSummary(sigArgs.offer || sigArgs.answer)}` : '')
                                + (payload.cmd === 'iceCandidate' ? ` mid=${JSON.stringify(sigArgs.mid)} mLine=${JSON.stringify(sigArgs.mLine)} type=${String(sigArgs.sdp || '').match(/ typ (\w+)/)?.[1] || '?'}` : ''));
                        }

                        // An offer that arrives as signaling (a new or a reconnecting offer) is answered the same way.
                        if ((payload.cmd === 'offer' || payload.cmd === 'reconnectOffer') && streamId && (sigArgs.offer || sigArgs.sdp)) {
                            socket.emit('webrtc-offer', { streamId, sdp: sigArgs.offer || sigArgs.sdp });
                        }

                        if (payload.cmd === 'joinResponse' && payload.args?.decision !== false && payload.args?.offer && streamId) {
                            pendingStreamJoin = false;
                            console.log(`[WebRTC] Received Offer from stream ${streamId}`);
                            socket.emit('webrtc-offer', { streamId, sdp: payload.args.offer });
                        }
                        
                        // The streamer's ICE candidates go on to the browser
                        if (payload.cmd === 'iceCandidate' && streamId && payload.args) {
                            socket.emit('webrtc-ice', { 
                                streamId,
                                candidate: payload.args.candidate || payload.args.sdp,
                                sdpMid: payload.args.mid || payload.args.sdp_mid,
                                sdpMLineIndex: payload.args.mLine ?? payload.args.sdp_mline_index
                            });
                        }
                    } catch (e) {
                        console.warn(`[WebRTC] Failed to parse signaling JSON`);
                    }
                    break;
                }

                default: {
                    const g = groups.length > 0 ? groups[0] : parsed.params;
                    const cmdClidMatch = parsed.name.match(/^clid=(\d+)$/);
                    const cmdCidMatch = parsed.name.match(/^cid=(\d+)$/);

                    if (cmdClidMatch) {
                        const clid = parseInt(cmdClidMatch[1]);
                        if (clid > 0) {
                            clients.set(clid, {
                                clid,
                                cid: parseInt(g.cid || g.ctid || g.cfid || '0') || 0,
                                nickname: g.client_nickname || `Client ${clid}`,
                                type: parseInt(g.client_type || '0') || 0,
                                uid: g.client_unique_identifier || '',
                                away: g.client_away === '1',
                                awayMsg: g.client_away_message || '',
                                inputMuted: g.client_input_muted === '1',
                                outputMuted: g.client_output_muted === '1',
                                isTalker: g.client_is_talker === '1',
                                isTalking: g.client_flag_talking === '1',
                                isSelf: clid === (userBot ? userBot.getClientId() : 0),
                                isStreaming: g.client_is_streaming === '1',
                                talkPower: knownTalkPower(clid, g.client_talk_power),
                                ...iconFields(clid, g)
                            });
                        }
                        sendStateUpdate();
                        break;
                    }
                    // A group list as a plain answer ("sgid=6 name=…|sgid=8 …"): the first id is in the name.
                    const groupListMatch = parsed.name.match(/^(sgid|cgid)=(\d+)$/);
                    if (groupListMatch) {
                        const [, idKey, firstId] = groupListMatch;
                        const list = [{ ...groups[0], [idKey]: firstId }, ...groups.slice(1)];
                        readGroups(idKey === 'sgid' ? serverGroupList : channelGroupList, idKey, list);
                        sendStateUpdate();
                        break;
                    }
                    
                    if (cmdCidMatch) {
                        const cid = parseInt(cmdCidMatch[1]);
                        if (!isNaN(cid) && cid >= 0) {
                            channels.set(cid, {
                                cid,
                                pid: parseInt(g.cpid || g.pid || '0') || 0,
                                name: g.channel_name || `Channel ${cid}`,
                                topic: g.channel_topic || '',
                                order: parseInt(g.channel_order || '0') || 0,
                                isDefault: g.channel_flag_default === '1',
                                isPassword: g.channel_flag_password === '1',
                                codec: parseInt(g.channel_codec || '4'),
                                neededTalkPower: knownNeededTalkPower(cid, g.channel_needed_talk_power),
                                ...channelExtras(cid, g)
                            });
                        }
                        sendStateUpdate();
                        break;
                    }
                    break;
                }
                
            
            }
        });

        userBot.on('disconnected', () => {
            for (const timer of subscribeTimers) clearTimeout(timer);
            subscribeTimers.clear();
            sendStateUpdate();
        });

        userBot.on('ts3error', (params) => {
            const errId = parseInt(params.id || '0');
            // An "ok" answer to a candidate is logged only with STREAM_LOG=verbose.
            if (String(params.return_code || '').startsWith('stream-')
                && (errId !== 0 || STREAM_LOG_VERBOSE || !String(params.return_code).startsWith('stream-ice-'))) {
                streamLog('in', `answer to ${params.return_code}`, `error=${errId} msg=${params.msg || ''}${params.extra_msg ? ' extra=' + params.extra_msg : ''}`);
            }
            if (errId === 516 || errId === 2568) return;

            // Error 0 is TeamSpeak's "ok": not logged as an error.
            if (errId !== 0) console.log(`[TeamSpeak Non-Fatal Error] ${botNickname}: TS3 error ${errId}: ${params.msg || 'unknown'}`);
            // Only a refused start ends a share. A refusal for one viewer (their offer or a connection address,
            // e.g. 5636 "You are not participating in this stream") is logged and leaves the others watching.
            if (String(params.return_code || '').startsWith('publish-setup-') && errId !== 0) {
                if (publishPending) publishPending = false;
                socket.emit('publish-error', { message: `TeamSpeak refused (${errId}: ${params.msg || 'unknown'}).` });
            } else if (String(params.return_code || '').startsWith('publish-') && errId !== 0) {
                streamLog('in', `refused for one viewer: ${params.return_code}`, `error=${errId} msg=${params.msg || ''}`);
            }
            if (errId === 521) refusedAsClone = true;
            if (pendingStreamJoin && errId !== 0) {
                pendingStreamJoin = false;
                socket.emit('webrtc-error', {
                    message: `TeamSpeak rejected the stream request (${errId}: ${params.msg || 'unknown'}).`
                });
            }
        });

        userBot.on('error', (err) => {
            console.error(`[TeamSpeak Error] ${botNickname}:`, err);
            sendStateUpdate();
        });

        await userBot.connect({
            host: TS_HOST,
            port: config.tsPort,
            nickname: botNickname,
            identity: userSpecificIdentity,
            serverPassword: config.tsServerPassword,
            defaultChannel: config.tsDefaultChannel
        });
        
        if (closed) {
            // The page went away while connecting: its cleanup already ran, so leave here.
            userBot.disconnect();
            return;
        }
        console.log(`[TeamSpeak] Bot '${botNickname}' successfully connected to ${TS_HOST}`);
        soundsFrom = Date.now() + 3000;
        socket.emit('ts-sound', 'connected');

        // Register first so stream notifications cannot race the initial snapshots.
        // All paced (see PACING): sent at once, they tripped the server's flood limit.
        sendPaced(userBot, "servernotifyregister event=server");
        sendPaced(userBot, "servernotifyregister event=channel id=0");
        sendPaced(userBot, "servernotifyregister event=textchannel");

        sendPaced(userBot, "channellist");
        // The extended client snapshot includes client_is_streaming and, on TS6,
        // causes existing streams to be announced with notifystreaminfo.
        sendPaced(userBot, "clientlist -uid -away -voice -times -groups -info -icon");
        // The groups' names and icons, for the badges (also sent by the server at connect; asked in case not).
        sendPaced(userBot, "servergrouplist");
        sendPaced(userBot, "channelgrouplist");
        // The rest of the server info window (e.g. the uptime) comes as notifyserverupdated.
        sendPaced(userBot, "servergetvariables");

        sendStateUpdate();

    } catch (error) {
        console.error(`[TeamSpeak] Failed to connect bot '${botNickname}':`, error);
        if (refusedAsClone) {
            // Our previous connection is still on the server (e.g. right after a restart): the page reconnects
            // by itself a little later, when the server has forgotten it.
            socket.emit('ts-retry', { afterMs: 10000, message: 'TeamSpeak still has your previous connection. Trying again in 10 seconds...' });
            setTimeout(() => socket.disconnect(true), 200);
            return;
        }
        // The page says why instead of waiting at "Connecting..." for good.
        socket.emit('ts-error', { message: `Couldn't connect to the TeamSpeak server (${(error as Error)?.message || 'unknown error'}).` });
        sendStateUpdate();
    }
    // --- CLIENT WEBSOCKET ACTIONS ---
    socket.on('client-update', (data: { inputMuted?: boolean, outputMuted?: boolean }) => {
        if (!userBot || userBot.getState() !== 'connected') return;
        
        const updates: string[] = [];
        if (data.inputMuted !== undefined) updates.push(`client_input_muted=${data.inputMuted ? '1' : '0'}`);
        if (data.outputMuted !== undefined) updates.push(`client_output_muted=${data.outputMuted ? '1' : '0'}`);
        
        if (updates.length > 0) {
            userBot.sendCommand(`clientupdate ${updates.join(' ')}`);
            const self = clients.get(userBot.getClientId());
            if (self) {
                if (data.inputMuted !== undefined) self.inputMuted = !!data.inputMuted;
                if (data.outputMuted !== undefined) self.outputMuted = !!data.outputMuted;
                sendStateUpdate();
            }
        }
    });

    socket.on('move-channel', (data: { cid: number }) => {
        if (userBot && data.cid !== undefined && data.cid !== null && !isNaN(data.cid)) {
            // cpw (the channel password) must be there, even empty, or the server refuses the move
            userBot.sendCommand(buildCommand("clientmove", { cid: data.cid, clid: userBot.getClientId(), cpw: "" }));
        }
    });

    // Channel message (targetmode 2) or private message to a person on the server (targetmode 1).
    socket.on('send-message', (data: { msg: string; targetmode?: number; target?: number }) => {
        if (userBot && data && typeof data.msg === 'string' && data.msg) {
            const targetmode = data.targetmode === 1 ? 1 : 2;
            let target = 1;
            if (targetmode === 1) {
                const partner = clients.get(Number(data.target));
                if (!partner || partner.clid === userBot.getClientId()) return;
                target = partner.clid;
                pendingPrivateTargets.push({ clid: partner.clid, uid: partner.uid, name: partner.nickname });
                if (pendingPrivateTargets.length > 20) pendingPrivateTargets.shift();
            } else {
                const botClient = clients.get(userBot.getClientId());
                if (botClient && botClient.cid !== undefined && botClient.cid !== null) {
                    target = botClient.cid;
                }
            }
            userBot.sendCommand(buildCommand("sendtextmessage", { targetmode, target, msg: data.msg }));
        }
    });

    // A picture for the channel chat: the page sends it in parts (image-upload-start → -part … →
    // -end, each answered), at most 15 MB; then it goes into the channel's /webTS folder and its line into the chat.
    let pictureUpload: { size: number; parts: Buffer[]; received: number } | null = null;
    let pictureSaving = false;
    socket.on('image-upload-start', (data: { size?: number }, ack?: (answer: object) => void) => {
        if (typeof ack !== 'function') return;
        const size = Number(data?.size);
        if (!config.picturesEnabled) return ack({ error: 'Pictures are switched off on this server.' });
        if (!Number.isInteger(size) || size <= 0 || size > IMAGE_MAX_BYTES) return ack({ error: `Pictures can be at most ${config.pictureMaxMb} MB.` });
        if (pictureSaving) return ack({ error: 'The previous picture is still being saved.' });
        pictureUpload = { size, parts: [], received: 0 };
        ack({ ok: true });
    });
    socket.on('image-upload-part', (data: unknown, ack?: (answer: object) => void) => {
        if (typeof ack !== 'function') return;
        const part = Buffer.isBuffer(data) ? data : data instanceof ArrayBuffer ? Buffer.from(data) : null;
        if (!pictureUpload || !part || !part.length || pictureUpload.received + part.length > pictureUpload.size) {
            pictureUpload = null;
            return ack({ error: 'The picture arrived garbled. Please try again.' });
        }
        pictureUpload.parts.push(part);
        pictureUpload.received += part.length;
        ack({ ok: true, received: pictureUpload.received });
    });
    socket.on('image-upload-end', async (_data: unknown, ack?: (answer: object) => void) => {
        if (typeof ack !== 'function') return;
        const upload = pictureUpload;
        pictureUpload = null;
        if (!upload || upload.received !== upload.size) return ack({ error: 'The picture arrived incomplete. Please try again.' });
        const bot = userBot;
        const cid = bot ? clients.get(bot.getClientId())?.cid : undefined;
        if (!bot || bot.getState() !== 'connected' || !cid) return ack({ error: 'Not connected to TeamSpeak.' });
        const data = Buffer.concat(upload.parts, upload.size);
        const type = imageType(data);
        if (!type) return ack({ error: "Only JPEG, PNG, GIF and WebP pictures can be sent." });
        const name = pictureName(type, crypto.randomBytes(3).toString('hex'));
        pictureSaving = true;
        try {
            await queueTransfer(bot, async () => {
                // A folder that's there already is fine; without the right to make one, the upload says what's wrong.
                await createDirectory(bot, cid, IMAGE_FOLDER).catch((e: any) =>
                    console.log(`[Pictures] ${botNickname}: no ${IMAGE_FOLDER} folder made in channel ${cid}: ${e.message} (${e.code})`));
                await uploadFile(bot, TS_HOST, cid, `${IMAGE_FOLDER}/${name}`, data);
            });
            console.log(`[Pictures] ${botNickname} shared ${name} (${(data.length / 1048576).toFixed(1)} MB) in channel ${cid}`);
            bot.sendCommand(buildCommand('sendtextmessage', { targetmode: 2, target: cid, msg: pictureMessage(name, cid, IMAGE_FOLDER) }));
            ack({ ok: true });
        } catch (e: any) {
            console.log(`[Pictures] ${botNickname}: upload to channel ${cid} failed: ${e.message}${e.code ? ` (${e.code})` : ''}`);
            ack({ error: pictureErrorText(e) });
        } finally {
            pictureSaving = false;
        }
    });

    // Poke a person; TeamSpeak takes up to 100 characters of message.
    socket.on('poke', (data: { clid?: number; msg?: string }) => {
        if (!userBot || userBot.getState() !== 'connected' || !data) return;
        const target = clients.get(Number(data.clid));
        if (!target || target.clid === userBot.getClientId()) return;
        const msg = typeof data.msg === 'string' ? data.msg.slice(0, 100) : '';
        userBot.sendCommand(buildCommand('clientpoke', { clid: target.clid, msg }));
    });

    // --- STRIIMAUKSEN WEBSOCKET ACTIONS ---
    
    // 1. The browser asks to watch a stream.
    socket.on('watch-stream', (data: { clid: number }) => {
        if (!userBot || !Number.isInteger(data?.clid)) return;
        // Like the desktop client, only a stream in our own channel can be watched. The page
        // shows WATCH only there; this is the check that counts.
        const streamer = clients.get(data.clid);
        const ownCid = clients.get(userBot.getClientId())?.cid;
        if (!streamer || ownCid === undefined || streamer.cid !== ownCid) {
            socket.emit('webrtc-error', { message: 'Join the streamer\'s channel to watch.' });
            return;
        }
        
        const targetStreamId = activeStreams.get(data.clid);
        if (!targetStreamId) {
            if (clients.get(data.clid)?.isStreaming) {
                // A stream that started before we joined: ask for its id, the join follows (notifystreaminfo).
                pendingWatchClid = data.clid;
                requestStreamInfo(data.clid);
                return;
            }
            socket.emit('webrtc-error', { message: 'Stream is no longer available.' });
            return;
        }
        joinStream(data.clid, targetStreamId);
    });

    function joinStream(streamerClid: number, targetStreamId: string) {
        if (!userBot) return;
        const data = { clid: streamerClid };
        watchedStream = { id: targetStreamId, streamerClid: data.clid };
        pendingStreamJoin = true;

        // The viewer's join as TeamSpeak 6 accepts it (as WebSpeak3 sends it):
        // the stream and the streamer, no myTeamSpeak ID. The streamer answers with
        // notifyrespondjoinstreamrequest carrying the SDP offer.
        const joinParams: Record<string, string> = {
            id: targetStreamId,
            clid: String(data.clid),
            msg: '',
            is_remove: '0',
            return_code: `stream-join-${++streamCommandCounter}`
        };
        streamLog('out', 'joinstreamrequest', `id=${targetStreamId} clid=${data.clid} return_code=${joinParams.return_code}`);
        userBot.sendCommand(buildCommand('joinstreamrequest', joinParams));
    }

    // Stop watching: the same command with is_remove=1, as TeamSpeak 6 leaves a stream.
    socket.on('stop-watching', () => {
        if (!userBot || !watchedStream) return;
        const leave = { id: watchedStream.id, clid: String(watchedStream.streamerClid), msg: '', is_remove: '1', return_code: `stream-leave-${++streamCommandCounter}` };
        streamLog('out', 'joinstreamrequest (leave)', `id=${leave.id} clid=${leave.clid}`);
        userBot.sendCommand(buildCommand('joinstreamrequest', leave));
        watchedStream = null;
        pendingStreamJoin = false;
    });

    // What the browser saw (its connection states, its answer's codecs), so the stream log has both ends.
    socket.on('stream-diagnostics', (data: { stage?: string; detail?: string }) => {
        streamLog('browser', String(data?.stage || '?').slice(0, 40), String(data?.detail || '').slice(0, 400));
    });

    // 2. The browser got the offer, made its answer and sends it back
    socket.on('webrtc-answer', (data: { streamId: string, sdp: string }) => {
        if (!userBot) return;
        console.log(`[WebRTC] Sending Answer for stream ${data.streamId}`);
        
        if (!watchedStream || data.streamId !== watchedStream.id) return;

        // Exactly what a desktop TS6 viewer sends (recorded): the SDP under args.answer.
        const payload = { cmd: 'answer', args: { answer: data.sdp } };
        const returnCode = `stream-answer-${++streamCommandCounter}`;
        streamLog('out', 'streamsignaling cmd=answer', `id=${data.streamId} clid=${watchedStream.streamerClid} return_code=${returnCode} sdp: ${sdpSummary(data.sdp)}`);
        userBot.sendCommand(buildCommand('streamsignaling', {
            id: data.streamId,
            clid: watchedStream.streamerClid,
            json: JSON.stringify(payload),
            return_code: returnCode
        }));
    });

    // 3. ICE Kandidaatit selaimelta striimaajalle
    socket.on('webrtc-ice', (data: { streamId: string, candidate: string, sdpMid: string, sdpMLineIndex: number }) => {
        if (!userBot || !watchedStream || data.streamId !== watchedStream.id) return;
        // As a desktop TS6 viewer sends it (recorded): the candidate line under sdp, mid a string,
        // mLine a number, one message per candidate.
        const payload = { cmd: 'iceCandidate', args: { sdp: data.candidate, mid: String(data.sdpMid ?? '0'), mLine: Number(data.sdpMLineIndex ?? 0) } };
        const returnCode = `stream-ice-${++streamCommandCounter}`;
        if (STREAM_LOG_VERBOSE) streamLog('out', 'streamsignaling cmd=iceCandidate', `mid=${payload.args.mid} mLine=${payload.args.mLine} type=${String(data.candidate || '').match(/ typ (\w+)/)?.[1] || '?'} return_code=${returnCode}`);
        userBot.sendCommand(buildCommand('streamsignaling', {
            id: data.streamId,
            clid: watchedStream.streamerClid,
            json: JSON.stringify(payload),
            return_code: returnCode
        }));
    });

    // --- SCREEN SHARING: the page captures and offers; the bridge talks to TeamSpeak ---
    socket.on('publish-start', (data: { name?: string; type?: number; bitrate?: number; audio?: boolean }) => {
        if (!userBot || userBot.getState() !== 'connected' || publishPending || publishedStreamId) return;
        publishPending = true;
        const name = String(data?.name || 'Screen').replace(/[\r\n]+/g, ' ').trim().slice(0, 64) || 'Screen';
        const returnCode = `publish-setup-${++streamCommandCounter}`;
        streamLog('out', 'setupstream', `type=${data?.type} bitrate=${data?.bitrate} audio=${data?.audio ? 1 : 0} return_code=${returnCode}`);
        userBot.sendCommand(buildCommand('setupstream', {
            name,
            type: [1, 2].includes(Number(data?.type)) ? Number(data?.type) : 3, // 1 = camera, 2 = screen, 3 = window (TeamSpeak's own values)
            bitrate: Math.max(500, Math.min(10000, Math.round(Number(data?.bitrate) || 6000))),
            accessibility: 1,                                      // public: anyone may watch
            mode: 1,                                               // peer-to-peer
            viewer_limit: 0,                                       // no limit
            audio: data?.audio ? 1 : 0,
            return_code: returnCode
        }));
    });

    socket.on('publish-offer', (data: { clid?: number; sdp?: string }) => {
        if (!userBot || !publishedStreamId || typeof data?.sdp !== 'string') return;
        const clid = Number(data.clid);
        if (!clients.has(clid)) return;
        const returnCode = `publish-respond-${++streamCommandCounter}`;
        streamLog('out', 'respondjoinstreamrequest (share)', `id=${publishedStreamId} clid=${clid} return_code=${returnCode} offer: ${sdpSummary(data.sdp)}`);
        userBot.sendCommand(buildCommand('respondjoinstreamrequest', {
            id: publishedStreamId,
            clid,
            msg: '',
            offer: data.sdp,
            decision: 1,
            return_code: returnCode
        }));
    });

    socket.on('publish-ice', (data: { clid?: number; candidate?: string; sdpMid?: string; sdpMLineIndex?: number }) => {
        const clid = Number(data?.clid);
        if (!publishedStreamId || !clients.has(clid) || typeof data?.candidate !== 'string' || !data.candidate) return;
        publishSignal(clid, { cmd: 'iceCandidate', args: { sdp: data.candidate, mid: String(data.sdpMid ?? '0'), mLine: Number(data.sdpMLineIndex ?? 0) } }, 'cmd=iceCandidate');
    });

    // A viewer asked to reconnect: the page's fresh offer goes to it as TeamSpeak's "reconnectOffer".
    socket.on('publish-reconnect-offer', (data: { clid?: number; sdp?: string }) => {
        const clid = Number(data?.clid);
        if (!publishedStreamId || !clients.has(clid) || typeof data?.sdp !== 'string' || !data.sdp) return;
        publishSignal(clid, { cmd: 'reconnectOffer', args: { offer: data.sdp } }, `cmd=reconnectOffer sdp: ${sdpSummary(data.sdp)}`);
    });

    socket.on('publish-stop', () => {
        if (!userBot) return;
        publishPending = false;
        if (!publishedStreamId) return;
        streamLog('out', 'stopstream', `id=${publishedStreamId}`);
        userBot.sendCommand(buildCommand('stopstream', { id: publishedStreamId, reason: '' }));
        publishedStreamId = null;
    });

    // Relay credentials for this page: asked at connect and every 25 minutes.
    let lastRelayRequest = 0;
    socket.on('relay-request', async () => {
        if (Date.now() - lastRelayRequest < 60000) return;
        lastRelayRequest = Date.now();
        socket.emit('relay-credentials', { iceServers: await relayIceServers(email), status: relayStatus() });
    });

    socket.on('request-state', () => sendStateUpdate());

    // --- VOICE RELAY ---
    userBot?.on('voice', (data: Buffer) => {
        try {
            if (!socket.connected || data.length < 5) return;
            
            const producerId = data.readUInt16BE(2); 
            const codec = data[4];                   
            const opusData = data.subarray(5);       

            if (codec !== 4 && codec !== 5) return; // Vain Opus Voice & Opus Music

            const buf = opusData.buffer.slice(opusData.byteOffset, opusData.byteOffset + opusData.byteLength);
            socket.emit('ts-voice', { clid: producerId, producerId, codec, data: buf });
        } catch (e) {
            console.error(`[Voice] Error relaying incoming voice:`, e);
        }
    });

    socket.on('voice-out', (data: ArrayBuffer) => {
        try {
            if (!userBot || userBot.getState() !== 'connected') return;
            // Not where we can't be heard (not enough talk power): TeamSpeak would drop it anyway.
            const self = clients.get(userBot.getClientId());
            if (self && !canTalkIn(self, channels)) return;
            userBot.sendVoice(Buffer.from(data));
        } catch (e) {
            console.error(`[Voice] Error sending outgoing voice:`, e);
        }
    });

    socket.on('voice-stop', () => {
        try {
            if (userBot && userBot.getState() === 'connected') userBot.sendVoiceStop();
        } catch (e) {
            console.error(`[Voice] Error sending voice-stop:`, e);
        }
    });
    
    // --- SETTINGS WEBSOCKET ACTIONS ---
    
    // The page asks for this device's saved settings
    socket.on('load-settings', async (data: { deviceId: string }) => {
        if (!data || !DEVICE_ID.test(String(data.deviceId))) return;

        try {
            const settings = await loadUserSettings(email, data.deviceId);
            if (settings) {
                console.log(`[Settings] Loaded settings for ${email} (Device: ${data.deviceId})`);
                socket.emit('settings-loaded', settings);
            }
        } catch (error) {
            console.error(`[Settings] Error loading settings for ${email}:`, error);
        }
    });

    // The page saves its settings
    socket.on('save-settings', async (data: { deviceId: string, settings: any }) => {
        if (!data || !data.deviceId || !data.settings) return;
        
        try {
            const refused = await saveUserSettings(email, data.deviceId, data.settings);
            if (refused) console.warn(`[Settings] Not saved for ${email}: ${refused}`);
            else console.log(`[Settings] Saved settings for ${email} (Device: ${data.deviceId})`);
        } catch (error) {
            console.error(`[Settings] Error saving settings for ${email}:`, error);
        }
    });

});

// Stopping (docker stop / restart): every TeamSpeak connection says goodbye first, so the server forgets
// it at once. Otherwise the old "you" lingers on the server and the page's reconnect is refused as a clone
// (TS3 error 521) for up to half a minute.
let shuttingDown = false;
function shutDown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Server] ${signal}: disconnecting ${activeBots.size} TeamSpeak client(s) before stopping...`);
    for (const bot of activeBots.values()) {
        try { bot.disconnect(); } catch (e) {}
    }
    io.close();
    if (chatHistory) void chatHistory.flushAll(); // the last lines (well within the 1.5 s)
    setTimeout(() => process.exit(0), 1500); // disconnect() sends at once and cleans up after 500 ms
}
process.on('SIGTERM', () => shutDown('SIGTERM'));
process.on('SIGINT', () => shutDown('SIGINT'));

process.on('uncaughtException', (err) => console.error('[FATAL] Uncaught exception:', err));
process.on('unhandledRejection', (reason) => console.error('[FATAL] Unhandled rejection:', reason));

const PORT = config.port;
if (relay.coturn) {
    console.log(`[Relay] coturn: ${config.turnUrls.join(', ')}`);
} else if (relay.cloudflare) {
    console.log(`[Relay] Cloudflare Realtime TURN${relay.capped ? `, capped at ${config.cfTurnCapGb} GB per ${RELAY_WINDOW_DAYS} days` : ' (no cap: CF_ACCOUNT_ID / CF_ANALYTICS_TOKEN not set)'}`);
    if (relay.capped) {
        checkRelayUsage();
        setInterval(checkRelayUsage, RELAY_CHECK_MS);
    }
} else {
    console.log('[Relay] Off (README: "Relay")');
}

server.listen(PORT, () => {
    console.log(`[Server] WebTS running on port ${PORT} (access: ${access.mode}; TeamSpeak server ${TS_HOST}:${config.tsPort})`);
});
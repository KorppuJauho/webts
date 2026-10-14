// WebTS settings, all from environment variables (see .env.example). Read once at start; a wrong value stops the
// bridge with a clear message rather than running half-configured.

import path from "path";
import { parseHistoryKey } from "./chat-history.js";

export type AccessMode = "cloudflare-access" | "header" | "public" | "signed-note";

const env = (name: string): string => (process.env[name] ?? "").trim();
const number = (name: string, fallback: number, min: number, max: number): number => {
  const raw = env(name);
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) fail(`${name} must be a number from ${min} to ${max} (got "${raw}")`);
  return n;
};
const flag = (name: string, fallback: boolean): boolean => {
  const raw = env(name).toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  fail(`${name} must be true or false (got "${raw}")`);
  return fallback;
};

function fail(message: string): never {
  console.error(`[Config] ${message}`);
  process.exit(1);
}

function readConfig() {
  const accessMode = (env("ACCESS_MODE") || "cloudflare-access") as AccessMode;
  if (!["cloudflare-access", "header", "public", "signed-note"].includes(accessMode)) {
    fail(`ACCESS_MODE must be cloudflare-access, header, public or signed-note (got "${accessMode}")`);
  }
  const publicUrl = env("PUBLIC_URL").replace(/\/+$/, "");
  if (publicUrl && !/^https?:\/\/[^/\s]+$/i.test(publicUrl)) fail(`PUBLIC_URL must look like https://webts.example.com (got "${publicUrl}")`);

  const config = {
    // The TeamSpeak server
    tsHost: env("TS_HOST") || "127.0.0.1",
    tsPort: number("TS_PORT", 9987, 1, 65535),
    tsServerPassword: env("TS_SERVER_PASSWORD") || undefined,
    tsDefaultChannel: env("TS_DEFAULT_CHANNEL") || undefined,
    nickPrefix: process.env.NICK_PREFIX ?? "Web - ",

    // This bridge
    port: number("PORT", 3002, 1, 65535),
    publicUrl, // where people open WebTS; '' = accept the address the browser used
    dataDir: path.resolve(env("DATA_DIR") || "data"),
    soundsDir: path.resolve(env("SOUNDS_DIR") || "sounds"),
    maxUsers: number("MAX_USERS", 50, 1, 1000),
    streamLogVerbose: env("STREAM_LOG") === "verbose",
    // The page's menu: a sign-out address (with Cloudflare Access, Access's own unless set) and a link back to your site.
    logoutUrl: env("LOGOUT_URL") || (accessMode === "cloudflare-access" ? "/cdn-cgi/access/logout" : ""),
    backUrl: env("BACK_URL"),
    backLabel: env("BACK_LABEL") || "Back",

    // Who gets in (README: "Access")
    accessMode,
    cfAccessTeamDomain: env("CF_ACCESS_TEAM_DOMAIN").replace(/^https?:\/\//, "").replace(/\/+$/, ""),
    cfAccessAud: env("CF_ACCESS_AUD"),
    accessHeader: (env("ACCESS_HEADER") || "remote-user").toLowerCase(),
    accessNameHeader: env("ACCESS_NAME_HEADER").toLowerCase(),
    publicConfirmed: flag("I_UNDERSTAND_THIS_IS_PUBLIC", false),
    publicMaxIdentities: number("PUBLIC_MAX_IDENTITIES", 500, 1, 100000),
    noteSecret: env("ACCESS_NOTE_SECRET"),
    noteHeader: (env("ACCESS_NOTE_HEADER") || "x-webts-note").toLowerCase(),

    // Pictures in the chat
    picturesEnabled: flag("PICTURES", true),
    pictureMaxMb: number("PICTURE_MAX_MB", 15, 1, 100),
    pictureFolder: env("PICTURE_FOLDER") || "/webTS",

    // Chat history across days (README: "Chat history"): off unless CHAT_HISTORY=on, which needs CHAT_HISTORY_KEY.
    chatHistory: flag("CHAT_HISTORY", false),
    chatHistoryKey: parseHistoryKey(env("CHAT_HISTORY_KEY")),
    chatHistoryDays: number("CHAT_HISTORY_DAYS", 30, 1, 3650),
    chatHistoryLines: number("CHAT_HISTORY_LINES", 300, 10, 5000),

    // The optional relay for people whose network blocks direct connections
    turnUrls: env("TURN_URLS").split(",").map((u) => u.trim()).filter(Boolean),
    turnSecret: env("TURN_SECRET"),
    cfTurnKeyId: env("CF_TURN_KEY_ID"),
    cfTurnKeyToken: env("CF_TURN_KEY_TOKEN"),
    cfAccountId: env("CF_ACCOUNT_ID"),
    cfAnalyticsToken: env("CF_ANALYTICS_TOKEN"),
    cfTurnCapGb: number("CF_TURN_CAP_GB", 950, 1, 1000000),
  };

  if (accessMode === "cloudflare-access" && (!config.cfAccessTeamDomain || !config.cfAccessAud)) {
    fail("ACCESS_MODE=cloudflare-access needs CF_ACCESS_TEAM_DOMAIN (e.g. myteam.cloudflareaccess.com) and CF_ACCESS_AUD (the application's Audience tag)");
  }
  if (accessMode === "public" && !config.publicConfirmed) {
    fail("ACCESS_MODE=public lets anyone who finds the address join your TeamSpeak server. Set I_UNDERSTAND_THIS_IS_PUBLIC=true if that's what you want.");
  }
  if (accessMode === "signed-note" && config.noteSecret.length < 32) {
    fail("ACCESS_MODE=signed-note needs ACCESS_NOTE_SECRET (at least 32 characters, shared with your gate)");
  }
  if (config.backUrl && !/^https?:\/\/\S+$/i.test(config.backUrl)) fail(`BACK_URL must be an http(s) address (got "${config.backUrl}")`);
  if (config.logoutUrl && !/^(https?:\/\/\S+|\/\S*)$/i.test(config.logoutUrl)) fail(`LOGOUT_URL must be an http(s) address or a path (got "${config.logoutUrl}")`);
  if (!/^\/[A-Za-z0-9_-]{1,40}$/.test(config.pictureFolder)) fail(`PICTURE_FOLDER must look like /webTS (got "${config.pictureFolder}")`);
  if (config.chatHistory && !config.chatHistoryKey) {
    fail("CHAT_HISTORY=on needs CHAT_HISTORY_KEY: 32 random bytes as base64, e.g. from: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"");
  }
  if (config.turnUrls.length && !config.turnSecret) fail("TURN_URLS needs TURN_SECRET (the static-auth-secret of your coturn server)");
  return config;
}

export const config = readConfig();
export type Config = typeof config;

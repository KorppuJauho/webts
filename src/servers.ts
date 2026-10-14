// The TeamSpeak servers WebTS offers. One server: the TS_* settings (as before). Several: a servers.json file, set up
// by whoever runs WebTS; people pick one of them in the page. Nobody can make WebTS connect anywhere else, so it can't
// be used to reach (or flood) other people's servers from your address.

export interface TsServer {
  id: string;              // in the page's choice and the chat history's file names: letters, digits, - and _
  name: string;            // what the page's server list shows
  host: string;
  port: number;            // voice (UDP)
  filePort?: number;       // only when WebTS must reach the file transfer port under another number (TS_FILE_PORT)
  password?: string;       // the server password, if it has one
  defaultChannel?: string; // the channel people land in (its name)
}

// What the page may know about a server: no addresses or passwords.
export const publicServer = (s: TsServer) => ({ id: s.id, name: s.name });

const ID = /^[A-Za-z0-9_-]{1,30}$/;

// The single server from the TS_* settings.
export function serverFromSettings(s: { host: string; port: number; filePort: number; password?: string; defaultChannel?: string }): TsServer {
  return {
    id: "main",
    name: "TeamSpeak",
    host: s.host,
    port: s.port,
    ...(s.filePort ? { filePort: s.filePort } : {}),
    ...(s.password ? { password: s.password } : {}),
    ...(s.defaultChannel ? { defaultChannel: s.defaultChannel } : {}),
  };
}

// servers.json: { "servers": [ { "id", "name", "host", "port"?, "filePort"?, "password"?, "defaultChannel"? }, ... ] }
// (a plain list works too). Throws an Error saying exactly what is wrong.
export function parseServers(text: string): TsServer[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e: any) {
    throw new Error(`servers.json isn't valid JSON (${e.message})`);
  }
  const list = Array.isArray(data) ? data : (data as any)?.servers;
  if (!Array.isArray(list) || list.length === 0) throw new Error('servers.json needs a "servers" list with at least one server');
  const seen = new Set<string>();
  return list.map((raw: any, i: number) => {
    const where = `servers.json, server ${i + 1}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where}: not an object`);
    const text = (key: string, max: number, required: boolean): string | undefined => {
      const v = raw[key];
      if (v === undefined || v === null || v === "") {
        if (required) throw new Error(`${where}: "${key}" is missing`);
        return undefined;
      }
      if (typeof v !== "string" || v.length > max || /[\u0000-\u001f]/.test(v)) throw new Error(`${where}: "${key}" must be text of at most ${max} characters`);
      return v.trim();
    };
    const port = (key: string, fallback?: number): number | undefined => {
      const v = raw[key];
      if (v === undefined || v === null || v === "") return fallback;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${where}: "${key}" must be a port number from 1 to 65535`);
      return n;
    };
    const id = text("id", 30, true)!;
    if (!ID.test(id)) throw new Error(`${where}: "id" may only have letters, digits, - and _ (got "${id}")`);
    if (seen.has(id)) throw new Error(`${where}: the id "${id}" is used twice`);
    seen.add(id);
    const host = text("host", 255, true)!;
    if (/\s|\//.test(host)) throw new Error(`${where}: "host" must be a host name or an IP address (got "${host}")`);
    const server: TsServer = { id, name: text("name", 60, true)!, host, port: port("port", 9987)! };
    const filePort = port("filePort");
    const password = text("password", 200, false);
    const defaultChannel = text("defaultChannel", 100, false);
    if (filePort) server.filePort = filePort;
    if (password) server.password = password;
    if (defaultChannel) server.defaultChannel = defaultChannel;
    return server;
  });
}

// The server a connection asked for. With one server there's nothing to choose (also when a device remembers a server
// from an earlier list); with several an unknown choice is refused (the page then shows the list), never quietly
// swapped for another server.
export function pickServer(servers: TsServer[], asked: unknown): TsServer | null {
  if (servers.length === 1) return servers[0];
  return typeof asked === "string" ? servers.find((s) => s.id === asked) ?? null : null;
}

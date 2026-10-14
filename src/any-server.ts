// "Connect anywhere" (ALLOW_ANY_SERVER=on): a person types a server's address and WebTS connects there. Every such
// connection comes from WebTS's own address, so: what's typed is read strictly, a name is looked up the way the
// TeamSpeak app does (its _ts3._udp record first), private and reserved addresses are refused unless allowed on purpose
// (ALLOW_SERVERS), and each person may try only so many different servers an hour.

import net from "net";
import { promises as dnsPromises } from "dns";
import type { TsServer } from "./servers.js";

export const DEFAULT_PORT = 9987;

export interface TypedAddress {
  host: string;   // a name (lower case) or an IP address (IPv6 without brackets)
  port?: number;  // only when typed
  ip: 4 | 6 | 0;  // 0 = a name
}

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

// "teamspeak.server.net", "44.43.32.1:8887", "[2001:db8::1]:9987", "2001:db8::1". Null when it isn't an address.
export function parseAddress(input: unknown): TypedAddress | null {
  if (typeof input !== "string") return null;
  const text = input.trim().toLowerCase();
  if (!text || text.length > 260) return null;
  let host = text;
  let portText: string | undefined;
  const bracketed = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(text);
  if (bracketed) {
    host = bracketed[1];
    portText = bracketed[2];
    if (net.isIP(host) !== 6) return null;
  } else if (net.isIP(text) === 6) {
    host = text; // IPv6 without brackets: no port
  } else {
    const m = /^([^:]+)(?::(\d{1,5}))?$/.exec(text);
    if (!m) return null;
    host = m[1].replace(/\.$/, "");
    portText = m[2];
  }
  let port: number | undefined;
  if (portText !== undefined) {
    port = Number(portText);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  }
  const ip = net.isIP(host) as 0 | 4 | 6;
  if (!ip) {
    if (host.length > 253 || /^[0-9.]+$/.test(host)) return null; // "44.434.32.1" is a broken IP, not a name
    if (!host.split(".").every((label) => LABEL.test(label))) return null;
  }
  return { host, ...(port ? { port } : {}), ip };
}

// The address as shown and remembered: "name", "name:8887", "[v6]:9987" (the default port left out).
export function addressText(a: { host: string; port?: number }): string {
  const host = net.isIP(a.host) === 6 ? `[${a.host}]` : a.host;
  return a.port && a.port !== DEFAULT_PORT ? `${host}:${a.port}` : host;
}

// Addresses that are never the internet: this machine, private networks, carrier NAT, link-local, documentation,
// benchmarking, multicast and reserved ranges.
const blocked = new net.BlockList();
for (const [range, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(range, bits, "ipv4");
for (const [range, bits] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23], ["2001:db8::", 32],
  ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) blocked.addSubnet(range, bits, "ipv6");

// An IPv6 address that carries an IPv4 one (::ffff:10.0.0.1) is judged by the IPv4 one.
function embeddedV4(ip: string): string | null {
  const m = /^::ffff:(?:0:)?(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (m) return m[1];
  const hex = /^::ffff:(?:0:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (hex) {
    const a = parseInt(hex[1], 16), b = parseInt(hex[2], 16);
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return null;
}

export function isPrivateAddress(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) return blocked.check(ip, "ipv4");
  if (v === 6) {
    const v4 = embeddedV4(ip);
    return v4 ? blocked.check(v4, "ipv4") : blocked.check(ip, "ipv6");
  }
  return true; // not an address at all
}

// ALLOW_SERVERS: addresses and ranges ("192.168.1.10", "10.0.0.0/8", "fd00::/8") and names ("teamspeak") that may be
// reached although private. Throws on a bad entry.
export interface AllowList { names: Set<string>; list: net.BlockList; size: number }
export function parseAllowList(text: string): AllowList {
  const names = new Set<string>();
  const list = new net.BlockList();
  let size = 0;
  for (const raw of text.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    const [addr, bitsText] = raw.split("/");
    const v = net.isIP(addr);
    if (v && bitsText === undefined) list.addAddress(addr, v === 4 ? "ipv4" : "ipv6");
    else if (v && /^\d{1,3}$/.test(bitsText) && Number(bitsText) <= (v === 4 ? 32 : 128)) list.addSubnet(addr, Number(bitsText), v === 4 ? "ipv4" : "ipv6");
    else if (!v && bitsText === undefined && parseAddress(addr)?.ip === 0) names.add(addr);
    else throw new Error(`ALLOW_SERVERS: "${raw}" isn't an address, a range like 10.0.0.0/8 or a host name`);
    size++;
  }
  return { names, list, size };
}
const allowedIp = (allow: AllowList, ip: string) => {
  const v = net.isIP(ip);
  return v ? allow.list.check(ip, v === 4 ? "ipv4" : "ipv6") : false;
};

export class ServerAddressError extends Error {}

// What the lookups need (the real ones by default; tests pass stand-ins).
export interface Resolver {
  srv(name: string): Promise<{ name: string; port: number; priority: number; weight: number }[]>;
  lookup(host: string): Promise<{ address: string; family: number }[]>;
}
export const systemResolver: Resolver = {
  srv: (name) => dnsPromises.resolveSrv(name),
  lookup: (host) => dnsPromises.lookup(host, { all: true, verbatim: false }),
};

// From what was typed to a server WebTS may connect to: looked up once (the connection goes to that very address, so a
// name can't point somewhere else afterwards) and checked. Throws ServerAddressError with a message for the person.
export async function resolveServer(input: unknown, allow: AllowList, resolver: Resolver = systemResolver): Promise<TsServer> {
  const typed = parseAddress(input);
  if (!typed) throw new ServerAddressError("That isn't a server address. Type e.g. ts.example.com or 203.0.113.7:9987.");
  let host = typed.host;
  let port = typed.port;
  // A name without a port: the server's own _ts3._udp record says where it really is, if it has one.
  if (!typed.ip && !port) {
    try {
      const records = (await resolver.srv(`_ts3._udp.${host}`)).sort((a, b) => a.priority - b.priority || b.weight - a.weight);
      if (records[0]?.name) {
        host = records[0].name.toLowerCase().replace(/\.$/, "");
        port = records[0].port;
      }
    } catch (e) {} // none: the name itself, on the default port
  }
  port = port || DEFAULT_PORT;
  let addresses: string[];
  if (net.isIP(host)) addresses = [host];
  else {
    try {
      addresses = (await resolver.lookup(host)).sort((a, b) => a.family - b.family).map((a) => a.address);
    } catch (e) {
      addresses = [];
    }
    if (!addresses.length) throw new ServerAddressError(`No server found at ${addressText(typed)}.`);
  }
  const nameAllowed = allow.names.has(typed.host) || allow.names.has(host);
  const ip = addresses.find((a) => nameAllowed || allowedIp(allow, a) || !isPrivateAddress(a));
  if (!ip) throw new ServerAddressError(`${addressText(typed)} is a private or reserved address, which this WebTS doesn't connect to.`);
  const shown = addressText(typed);
  return { id: `addr:${shown}`, name: shown, host: ip, port };
}

// At most `max` different servers per person per hour (the same server again doesn't count).
export class TryLimit {
  private tries = new Map<string, Map<string, number>>(); // person -> server -> last try

  constructor(private max = 10, private windowMs = 3_600_000) {}

  allow(person: string, server: string, now = Date.now()): boolean {
    const mine = this.tries.get(person) || new Map<string, number>();
    for (const [s, at] of mine) if (now - at >= this.windowMs) mine.delete(s);
    if (!mine.has(server) && mine.size >= this.max) return false;
    mine.set(server, now);
    this.tries.set(person, mine);
    if (this.tries.size > 5000) this.tries.clear(); // a safety valve, not a normal case
    return true;
  }
}

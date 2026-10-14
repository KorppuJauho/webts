// File transfer: the TeamSpeak file browser's folders, uploads and downloads (for pictures in the chat,
// server icons and avatars).
//
// The request goes over the client's command connection (ftcreatedir / ftinitupload / ftinitdownload). The server
// answers with a key and a port, and the bytes then go over a separate TCP connection to that port (30033 by
// default): first the key, then the file. As in DreamSpeak/TSLib's FileTransferManager.

import net from "net";
import type { EventEmitter } from "events";
import { buildCommand } from "./commands.js";
import type { ParsedCommand } from "./commands.js";

// What this needs from a client: send a command, and see every command that comes back.
export interface FileTransferClient extends EventEmitter {
  sendCommand(cmd: string): void;
}

export class FileTransferError extends Error {
  // code: TeamSpeak's error number (e.g. 2568 = no permission), or 0 when the problem is ours or the network's.
  constructor(message: string, public code = 0) {
    super(message);
    this.name = "FileTransferError";
  }
}

export const ERROR_FILE_ALREADY_EXISTS = 2050;

// Where the bytes go: the server's address, and optionally a port that wins over the one the server names. The server
// always names its own port (30033), which is wrong when it is published under another number (e.g. Docker
// "30035:30033") and WebTS reaches it from outside.
export type TransferTarget = string | { host: string; port?: number };
const targetOf = (t: TransferTarget, serverPort: number) =>
  typeof t === "string" ? { host: t, port: serverPort } : { host: t.host, port: t.port || serverPort };
const ANSWER_MS = 15_000;
const TRANSFER_MS = 120_000;

let counter = 0;
const nextTransferId = () => (counter = (counter % 65535) + 1); // clientftfid is 16-bit
const nextReturnCode = () => `ft-${nextTransferId()}`;

// Waits for the first command `pick` returns a value for (or throws on), the client's disconnect, or the time limit.
function waitFor<T>(client: FileTransferClient, pick: (cmd: ParsedCommand) => T | undefined, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      client.off("command", onCommand);
      client.off("disconnected", onGone);
    };
    const onCommand = (cmd: ParsedCommand) => {
      let value: T | undefined;
      try {
        value = pick(cmd);
      } catch (e) {
        finish();
        reject(e);
        return;
      }
      if (value !== undefined) {
        finish();
        resolve(value);
      }
    };
    const onGone = () => {
      finish();
      reject(new FileTransferError("The TeamSpeak connection closed"));
    };
    const timer = setTimeout(() => {
      finish();
      reject(new FileTransferError("TeamSpeak didn't answer"));
    }, ms);
    client.on("command", onCommand);
    client.on("disconnected", onGone);
  });
}

const refused = (params: Record<string, string>, code: string | undefined) =>
  new FileTransferError(params.msg || "refused", parseInt(code || "0") || 0);

// The command's own answer ("error id=… return_code=…"): id 0 is "ok".
function commandAnswer(cmd: ParsedCommand, returnCode: string): { id: number; msg: string } | undefined {
  if (cmd.name !== "error" || cmd.params.return_code !== returnCode) return undefined;
  return { id: parseInt(cmd.params.id || "0") || 0, msg: cmd.params.msg || "" };
}

// A folder in a channel's files ("/webTS"). One that already exists is fine.
export async function createDirectory(client: FileTransferClient, cid: number, dirname: string, cpw = ""): Promise<void> {
  const returnCode = nextReturnCode();
  const answer = waitFor(client, (cmd) => commandAnswer(cmd, returnCode), ANSWER_MS);
  client.sendCommand(buildCommand("ftcreatedir", { cid, cpw, dirname, return_code: returnCode }));
  const { id, msg } = await answer;
  if (id !== 0 && id !== ERROR_FILE_ALREADY_EXISTS) throw new FileTransferError(msg || "refused", id);
}

interface StartAnswer {
  serverftfid: string;
  ftkey: string;
  port: number;
  size: number;
}

// Asks for a transfer and waits for the server's key and port, or its refusal.
async function startTransfer(client: FileTransferClient, command: string, params: Record<string, string | number>,
  started: string): Promise<StartAnswer> {
  const clientftfid = nextTransferId();
  const returnCode = nextReturnCode();
  const answer = waitFor<StartAnswer>(client, (cmd) => {
    const p = cmd.params;
    if (cmd.name === started && parseInt(p.clientftfid) === clientftfid) {
      const port = parseInt(p.port);
      if (!p.ftkey || !(port > 0 && port < 65536)) throw new FileTransferError("TeamSpeak gave no transfer address");
      return { serverftfid: p.serverftfid || "", ftkey: p.ftkey, port, size: parseInt(p.size || "0") || 0 };
    }
    if (cmd.name === "notifystatusfiletransfer" && parseInt(p.clientftfid) === clientftfid) throw refused(p, p.status);
    const own = commandAnswer(cmd, returnCode);
    if (own && own.id !== 0) throw refused(p, p.id);
    return undefined;
  }, ANSWER_MS);
  client.sendCommand(buildCommand(command, { clientftfid, ...params, return_code: returnCode }));
  return answer;
}

// Uploads `data` as `name` (a full path such as "/webTS/picture.jpg") into channel `cid`'s files. An existing file
// of the same name is not overwritten (TeamSpeak refuses instead).
export async function uploadFile(client: FileTransferClient, host: TransferTarget, cid: number, name: string, data: Buffer,
  cpw = ""): Promise<void> {
  const start = await startTransfer(client, "ftinitupload",
    { name, cid, cpw, size: data.length, overwrite: 0, resume: 0 }, "notifystartupload");
  await new Promise<void>((resolve, reject) => {
    let sent = false;
    const socket = net.connect(targetOf(host, start.port));
    const timer = setTimeout(() => {
      socket.destroy();
      if (sent) resolve(); // everything was handed over; the server just didn't close its side
      else reject(new FileTransferError("The upload took too long"));
    }, TRANSFER_MS);
    socket.on("connect", () => {
      socket.write(Buffer.from(start.ftkey, "ascii"));
      socket.end(data, () => { sent = true; });
    });
    socket.on("error", (e) => {
      clearTimeout(timer);
      reject(new FileTransferError(`Upload connection failed: ${e.message}`));
    });
    socket.on("close", (hadError) => {
      clearTimeout(timer);
      if (hadError) return; // "error" already rejected
      if (sent) resolve();
      else reject(new FileTransferError("The upload connection closed early"));
    });
  });
}

// Downloads `name` (a full path) from channel `cid`'s files. A file over `maxBytes` is refused before any of it is read.
export async function downloadFile(client: FileTransferClient, host: TransferTarget, cid: number, name: string,
  maxBytes: number, cpw = ""): Promise<Buffer> {
  const start = await startTransfer(client, "ftinitdownload", { name, cid, cpw, seekpos: 0 }, "notifystartdownload");
  if (start.size > maxBytes) {
    if (start.serverftfid) client.sendCommand(buildCommand("ftstop", { serverftfid: start.serverftfid, delete: 0 }));
    throw new FileTransferError("The file is too big");
  }
  if (start.size === 0) return Buffer.alloc(0);
  return new Promise<Buffer>((resolve, reject) => {
    const parts: Buffer[] = [];
    let received = 0;
    let done = false;
    const finish = (error: FileTransferError | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(Buffer.concat(parts, start.size));
    };
    const socket = net.connect(targetOf(host, start.port));
    const timer = setTimeout(() => finish(new FileTransferError("The download took too long")), TRANSFER_MS);
    socket.on("connect", () => socket.write(Buffer.from(start.ftkey, "ascii")));
    socket.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > start.size) return finish(new FileTransferError("The server sent more than the file's size"));
      parts.push(chunk);
      if (received === start.size) finish(null);
    });
    socket.on("error", (e) => finish(new FileTransferError(`Download connection failed: ${e.message}`)));
    socket.on("close", () => finish(new FileTransferError("The download connection closed early")));
  });
}

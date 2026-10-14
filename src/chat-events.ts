// Join and leave lines in the channel chat, worded like the TeamSpeak app ("Alex joined coming from
// Gaming"). Pure functions: index.ts decides which events concern the person's own channel and keeps the result with
// the chat messages, like the app keeps them in its chat history.

// A line's pieces: plain text, or { b } for a name or a channel (shown bold, as in the app).
export type EventPart = string | { b: string };

const SPACER = /^\[[^\]]*spacer[^\]]*\](.*)$/i;

// A channel's name as the tree shows it: a spacer's tag left out ("[cspacer1]AFK" -> "AFK").
export function channelLabel(name: string | undefined): string {
  const raw = String(name || "");
  const m = SPACER.exec(raw);
  return (m ? m[1].trim() : raw) || raw || "another channel";
}

const by = (invoker?: string): EventPart[] => (invoker ? [" by ", { b: invoker }] : []);
const why = (reasonMsg?: string): EventPart[] => (reasonMsg ? [` (${reasonMsg})`] : []);

// Someone appeared in our channel: connected, or (from a channel we don't see) came over.
export function enterEvent(who: string, from?: string): EventPart[] {
  return from ? [{ b: who }, " joined coming from ", { b: from }] : [{ b: who }, " connected"];
}

export interface MoveInfo {
  who: string;
  self: boolean;        // it's us
  intoHere: boolean;    // into our channel (else: out of it); for `self`, unused
  reason: number;       // TeamSpeak's reasonid: 0 = switched, 1 = moved by someone, 4 = kicked from the channel
  from: string;         // channel labels (channelLabel)
  to: string;
  invoker?: string;     // who did it (moves and kicks)
  reasonMsg?: string;
}

// A move between channels; null when it needs no line (our own switch: we know).
export function moveEvent(m: MoveInfo): EventPart[] | null {
  if (m.self) {
    if (m.reason === 1) return ["You were moved to ", { b: m.to }, ...by(m.invoker)];
    if (m.reason === 4) return ["You were kicked from ", { b: m.from }, ...by(m.invoker), ...why(m.reasonMsg)];
    return null;
  }
  const who = { b: m.who };
  if (m.intoHere) {
    if (m.reason === 1) return [who, " was moved here from ", { b: m.from }, ...by(m.invoker)];
    if (m.reason === 4) return [who, " was kicked from ", { b: m.from }, ...by(m.invoker), ...why(m.reasonMsg)];
    return [who, " joined coming from ", { b: m.from }];
  }
  if (m.reason === 1) return [who, " was moved to ", { b: m.to }, ...by(m.invoker)];
  if (m.reason === 4) return [who, " was kicked from the channel", ...by(m.invoker), ...why(m.reasonMsg)];
  return [who, " left to ", { b: m.to }];
}

// Someone left the server (reasonid 3 = connection lost, 5 = kicked, 6 = banned, 8 = disconnected, 11 = the server
// shut down); null when it needs no line.
export function leaveEvent(who: string, self: boolean, reason: number, invoker?: string, reasonMsg?: string): EventPart[] | null {
  if (self) {
    if (reason === 5) return ["You were kicked from the server", ...by(invoker), ...why(reasonMsg)];
    if (reason === 6) return ["You were banned", ...by(invoker), ...why(reasonMsg)];
    return null;
  }
  const w = { b: who };
  if (reason === 3) return [w, " lost connection"];
  if (reason === 5) return [w, " was kicked from the server", ...by(invoker), ...why(reasonMsg)];
  if (reason === 6) return [w, " was banned", ...by(invoker), ...why(reasonMsg)];
  if (reason === 11) return null;
  return [w, " disconnected", ...why(reasonMsg)];
}

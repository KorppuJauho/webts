// Favourite servers ("connect anywhere"): each person's list, kept by WebTS so it follows them to their other devices.
// Addresses and names only, never server passwords (the page can remember a password in that browser only). At most one
// favourite connects automatically when the page opens.

import fs from "fs/promises";
import { parseAddress, addressText } from "./any-server.js";

export interface Favorite {
  address: string; // as addressText writes it
  name: string;    // the person's own name for it ('' = the address)
  auto: boolean;   // connect to it when the page opens
}

export const FAVORITES_MAX = 20;

// A list from the page, cleaned; null when it isn't one. Duplicates go, and only the first "auto" stays.
export function cleanFavorites(input: unknown): Favorite[] | null {
  if (!Array.isArray(input) || input.length > FAVORITES_MAX) return null;
  const out: Favorite[] = [];
  let auto = false;
  for (const raw of input) {
    if (!raw || typeof raw !== "object") return null;
    const typed = parseAddress((raw as any).address);
    if (!typed) return null;
    const name = typeof (raw as any).name === "string" ? (raw as any).name.trim().slice(0, 60).replace(/[\u0000-\u001f]/g, "") : "";
    const address = addressText(typed);
    if (out.some((f) => f.address === address)) continue;
    const wantsAuto = (raw as any).auto === true && !auto;
    if (wantsAuto) auto = true;
    out.push({ address, name, auto: wantsAuto });
  }
  return out;
}

// One file for everyone (DATA_DIR/favorites.json), written one save at a time.
export class FavoritesStore {
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private file: string) {}

  private async readAll(): Promise<Record<string, Favorite[]>> {
    try {
      const data = JSON.parse(await fs.readFile(this.file, "utf-8"));
      return data && typeof data === "object" && !Array.isArray(data) ? data : {};
    } catch (e) {
      return {};
    }
  }

  async get(person: string): Promise<Favorite[]> {
    return cleanFavorites((await this.readAll())[person] || []) || [];
  }

  set(person: string, list: Favorite[]): Promise<void> {
    const run = this.writes.then(async () => {
      const all = await this.readAll();
      if (list.length) all[person] = list;
      else delete all[person];
      await fs.writeFile(this.file, JSON.stringify(all, null, 2));
    });
    this.writes = run.catch(() => {});
    return run;
  }
}

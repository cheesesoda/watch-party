import type { ScreenInfo, ScreenMessage } from "../../shared/protocol.ts";

const MAX_SCREENS = 200;

interface Screen {
  id: string;
  /** Who the TV is signed in as; a phone lists the TVs signed in under its own name. */
  name: string;
  /** The TV's own name, like "Living Room TV". */
  label: string;
  /** The party the TV is in, if any. */
  room: string | null;
  send: (msg: ScreenMessage) => void;
}

/**
 * Watch on TV: TVs with the app open keep a connection here, so a phone signed in under the same name can list them
 * and send one a party.
 */
export class Screens {
  private screens = new Map<string, Screen>();

  /** A TV came online. A TV that reconnects under the same id replaces its old connection. Returns false when full. */
  add(id: string, name: string, label: string, send: (msg: ScreenMessage) => void): boolean {
    if (!this.screens.has(id) && this.screens.size >= MAX_SCREENS) return false;
    this.screens.set(id, { id, name, label, room: null, send });
    return true;
  }

  /** The TV went away; [send] tells a stale close apart from the connection that replaced it. */
  remove(id: string, send: (msg: ScreenMessage) => void): void {
    if (this.screens.get(id)?.send === send) this.screens.delete(id);
  }

  /** The TV joined or left a party. */
  setRoom(id: string, room: string | null): void {
    const s = this.screens.get(id);
    if (s) s.room = room;
  }

  /** The TVs signed in under [name], with what each is watching. */
  list(name: string, titleOf: (room: string) => string | null): ScreenInfo[] {
    return [...this.screens.values()]
      .filter((s) => same(s.name, name))
      .map((s) => ({ id: s.id, label: s.label, watching: s.room ? titleOf(s.room) : null }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  /** Tells the TV to open a party. False when there's no such TV under [name]. */
  send(id: string, name: string, msg: ScreenMessage): boolean {
    const s = this.screens.get(id);
    if (!s || !same(s.name, name)) return false;
    s.send(msg);
    return true;
  }
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

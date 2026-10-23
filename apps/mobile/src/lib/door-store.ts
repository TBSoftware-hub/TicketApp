import { File, Paths } from "expo-file-system";
import { Platform } from "react-native";

// What the door keeps for working offline: the event's list of who can get in, and the scans made
// while offline that are still to be sent. Both are too big for the keychain, so they're files in
// the app's own documents folder; the web preview (development only) keeps them in localStorage.
const web = Platform.OS === "web";

export const DOOR_LIST_FILE = "door-list.json";
export const DOOR_QUEUE_FILE = "door-queue.json";

export async function readFile(name: string): Promise<string | null> {
  if (web) return globalThis.localStorage?.getItem(`ticketapp.${name}`) ?? null;
  // A finished copy not yet put in place, after the app stopped part-way: it's the latest.
  const pending = new File(Paths.document, `${name}.new`);
  if (pending.exists) return pending.text();
  const file = new File(Paths.document, name);
  return file.exists ? file.text() : null;
}

// Writes to the same file wait their turn, so an older save can't land after a newer one.
const writes = new Map<string, Promise<void>>();

export function writeFile(name: string, text: string | null): Promise<void> {
  const write = async () => {
    if (web) {
      if (text === null) globalThis.localStorage?.removeItem(`ticketapp.${name}`);
      else globalThis.localStorage?.setItem(`ticketapp.${name}`, text);
      return;
    }
    const file = new File(Paths.document, name);
    const pending = new File(Paths.document, `${name}.new`);
    const draft = new File(Paths.document, `${name}.tmp`);
    if (text === null) {
      for (const f of [file, pending, draft]) if (f.exists) f.delete();
      return;
    }
    // Written in full to a draft and checked, then named as a finished copy, then put in place: a
    // write that fails or is cut off leaves the last one, or a finished copy, never half a file.
    if (draft.exists) draft.delete();
    draft.create();
    await draft.write(text);
    if ((await draft.text()) !== text) {
      draft.delete();
      throw new Error(`Couldn't save ${name}`);
    }
    if (pending.exists) pending.delete();
    draft.rename(pending.name);
    await new File(Paths.document, `${name}.new`).move(file, { overwrite: true });
  };
  const next = (writes.get(name) ?? Promise.resolve()).then(write, write);
  writes.set(name, next);
  return next;
}

/**
 * Forgets the saved list on sign-out: it names everyone coming, so it shouldn't outlast the staff
 * member who downloaded it. Scans still to be sent are kept, to go once someone signs back in.
 */
export function forgetDoorList(): Promise<void> {
  return writeFile(DOOR_LIST_FILE, null).catch(() => undefined);
}

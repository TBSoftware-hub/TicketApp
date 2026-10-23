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
    if (text === null) {
      if (file.exists) file.delete();
      return;
    }
    if (!file.exists) file.create();
    await file.write(text);
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

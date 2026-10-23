import type { DoorEvent } from "@ticketapp/shared";
import { StyleSheet, Text, View } from "react-native";
import { Button } from "@/components/button";
import { useOffline } from "@/lib/offline";
import { colors, ui } from "@/lib/theme";

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Tells door staff when scans are being answered from the list saved on the device, and how many
 * are still to send.
 */
export function OfflineStatus({ event }: { event: DoorEvent }) {
  const { offline, reachable, listSavedAt, pending, waitingForOthers } = useOffline();
  const time = (d: Date) =>
    d.toLocaleTimeString("en-US", {
      timeZone: event.organization.timezone,
      hour: "numeric",
      minute: "2-digit",
    });
  const scans = plural(pending, "scan", "scans");
  // Someone else's scans wait for them to sign back in here; the ones after them wait too.
  const waiting =
    waitingForOthers > 0
      ? ` ${plural(waitingForOthers, "scan", "scans")} saved by someone else ${waitingForOthers === 1 ? "waits" : "wait"} for them to sign in on this device, and later scans for this event go after them.`
      : "";

  if (!offline) return null;
  return (
    <View style={[styles.banner, reachable && styles.sending]} accessibilityLiveRegion="polite">
      <Text style={styles.title}>{reachable ? "Back online" : "Offline"}</Text>
      <Text style={styles.text}>
        {reachable
          ? waiting
            ? `New scans are checked against the saved list.${waiting}`
            : `Sending ${scans} saved while offline. New scans are checked against the saved list until they've gone.`
          : listSavedAt
            ? `Checking tickets against the list saved at ${time(listSavedAt)}.${pending > waitingForOthers ? ` ${plural(pending - waitingForOthers, "scan", "scans")} will be sent when the connection is back.` : ""}${waiting}`
            : "This device has no saved list for this event, so tickets can't be checked until the connection is back."}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: { backgroundColor: colors.warn, borderRadius: 12, padding: 14, gap: 4 },
  sending: { backgroundColor: colors.accent },
  title: { color: "#fff", fontSize: 17, fontWeight: "700" },
  text: { color: "#fff", fontSize: 15, lineHeight: 21 },
});

/**
 * Scans made offline that TicketApp answered differently once they were sent, for staff to look
 * into. Shown for every event, on the event picker too: the event may have ended since.
 */
export function SyncProblems() {
  const { problems, dismissProblems } = useOffline();
  if (problems.length === 0) return null;
  const time = (iso: string, timeZone: string) =>
    new Date(iso).toLocaleTimeString("en-US", { timeZone, hour: "numeric", minute: "2-digit" });
  const events = new Set(problems.map((p) => p.eventId));
  return (
    <View style={[ui.card, { gap: 8 }]} accessibilityRole="alert">
      <Text style={ui.heading}>
        Check {problems.length === 1 ? "this scan" : `these ${problems.length} scans`} made offline
      </Text>
      {problems.map((p) => (
        <Text key={p.key} style={ui.body}>
          {p.name}
          {events.size > 1 ? ` (${p.eventName})` : ""}: “{p.shown}” at{" "}
          {time(p.offlineAt, p.timeZone)}, but TicketApp says “{p.answer}”.
        </Text>
      ))}
      <Button label="Got it" variant="secondary" onPress={dismissProblems} />
    </View>
  );
}

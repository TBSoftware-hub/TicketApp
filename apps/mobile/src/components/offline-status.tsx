import type { DoorEvent } from "@ticketapp/shared";
import { StyleSheet, Text, View } from "react-native";
import { Button } from "@/components/button";
import { useOffline } from "@/lib/offline";
import { colors, ui } from "@/lib/theme";

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Tells door staff when scans are being answered from the list saved on the device, how many are
 * still to send, and which of those TicketApp answered differently once they were sent.
 */
export function OfflineStatus({ event }: { event: DoorEvent }) {
  const { offline, reachable, listSavedAt, pending, problems, dismissProblems } = useOffline();
  const time = (d: Date) =>
    d.toLocaleTimeString("en-US", {
      timeZone: event.organization.timezone,
      hour: "numeric",
      minute: "2-digit",
    });
  const scans = plural(pending, "scan", "scans");

  return (
    <>
      {offline && (
        <View style={[styles.banner, reachable && styles.sending]} accessibilityLiveRegion="polite">
          <Text style={styles.title}>{reachable ? "Back online" : "Offline"}</Text>
          <Text style={styles.text}>
            {reachable
              ? `Sending ${scans} saved while offline. New scans are checked against the saved list until they've gone.`
              : listSavedAt
                ? `Checking tickets against the list saved at ${time(listSavedAt)}.${pending > 0 ? ` ${scans} will be sent when the connection is back.` : ""}`
                : "This device has no saved list for this event, so tickets can't be checked until the connection is back."}
          </Text>
        </View>
      )}
      {problems.length > 0 && (
        <View style={[ui.card, { gap: 8 }]} accessibilityRole="alert">
          <Text style={ui.heading}>
            Check {problems.length === 1 ? "this scan" : `these ${problems.length} scans`} made
            offline
          </Text>
          {problems.map((p) => (
            <Text key={p.key} style={ui.body}>
              {p.name}: “{p.shown}” at {time(new Date(p.offlineAt))}, but TicketApp says “{p.answer}
              ”.
            </Text>
          ))}
          <Button label="Got it" variant="secondary" onPress={dismissProblems} />
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  banner: { backgroundColor: colors.warn, borderRadius: 12, padding: 14, gap: 4 },
  sending: { backgroundColor: colors.accent },
  title: { color: "#fff", fontSize: 17, fontWeight: "700" },
  text: { color: "#fff", fontSize: 15, lineHeight: 21 },
});

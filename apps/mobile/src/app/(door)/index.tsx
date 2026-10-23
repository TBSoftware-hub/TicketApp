import { doorEventsResponseSchema, formatDoorEventTime } from "@ticketapp/shared";
import { useEffect, useState } from "react";
import { AppState, KeyboardAvoidingView, Platform, ScrollView, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "@/components/button";
import { OfflineStatus, SyncProblems } from "@/components/offline-status";
import { Scanner } from "@/components/scanner";
import { StaffBar } from "@/components/staff-bar";
import { useSession } from "@/lib/session";
import { ui } from "@/lib/theme";

/** How long the check that the event is still on may take before the scanner opens anyway. */
const EVENT_CHECK_TIMEOUT_MS = 5000;

/**
 * Home screen for the chosen event: the scanner, for check-in and check-out, lookup by name, and
 * whether it's working offline.
 */
export default function Door() {
  const { event, call, chooseEvent } = useSession();
  const [checking, setChecking] = useState(true);

  // The saved event may have ended, been cancelled, or the staff member may have lost access since
  // it was picked. Re-check when the screen opens and whenever the app comes back to the
  // foreground: drop the event if the API no longer lists it, refresh it if it was edited, and keep
  // it as it is if the API can't be reached.
  const eventId = event?.id;
  useEffect(() => {
    if (!eventId) return;
    let current = true;
    let latest = 0;
    const recheck = () => {
      const attempt = ++latest;
      // Offline the scanner works from the saved list, so it mustn't wait long on this.
      call("/door/events", { timeoutMs: EVENT_CHECK_TIMEOUT_MS })
        .then((res) => {
          // Ignore an answer overtaken by a later check, or arriving after the event changed.
          if (!current || attempt !== latest) return;
          const listed = doorEventsResponseSchema.parse(res).events.find((e) => e.id === eventId);
          void chooseEvent(listed ?? null);
        })
        .catch(() => undefined)
        .finally(() => {
          if (current && attempt === latest) setChecking(false);
        });
    };
    recheck();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") recheck();
    });
    return () => {
      current = false;
      subscription.remove();
    };
  }, [eventId, call, chooseEvent]);

  if (!event) return null;

  return (
    <SafeAreaView style={ui.screen}>
      {/* Looking someone up, or letting them in anyway, brings the keyboard up over the scanner. */}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
          <StaffBar />
          <Text style={ui.eyebrow}>{event.organization.name.toUpperCase()}</Text>
          <Text style={ui.title}>{event.name}</Text>
          <Text style={ui.muted}>
            {formatDoorEventTime(event)}
            {event.venue ? ` · ${event.venue}` : ""}
          </Text>
          <OfflineStatus event={event} />
          <SyncProblems />
          {checking ? (
            <Text style={ui.muted}>Checking the event is still on…</Text>
          ) : (
            // A fresh scanner for each event, so nothing from the last one carries over.
            <Scanner key={event.id} event={event} />
          )}
          <Button label="Change event" variant="secondary" onPress={() => void chooseEvent(null)} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

import { doorEventsResponseSchema, formatDoorEventTime } from "@ticketapp/shared";
import { useEffect, useState } from "react";
import { AppState, ScrollView, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "@/components/button";
import { Scanner } from "@/components/scanner";
import { StaffBar } from "@/components/staff-bar";
import { useSession } from "@/lib/session";
import { ui } from "@/lib/theme";

/** Home screen for the chosen event: the ticket scanner, and later name lookup (E7.5). */
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
      call("/door/events")
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
      <ScrollView contentContainerStyle={ui.content}>
        <StaffBar />
        <Text style={ui.eyebrow}>{event.organization.name.toUpperCase()}</Text>
        <Text style={ui.title}>{event.name}</Text>
        <Text style={ui.muted}>
          {formatDoorEventTime(event)}
          {event.venue ? ` · ${event.venue}` : ""}
        </Text>
        {checking ? (
          <Text style={ui.muted}>Checking the event is still on…</Text>
        ) : (
          // A fresh scanner for each event, so nothing from the last one carries over.
          <Scanner key={event.id} event={event} />
        )}
        <Button label="Change event" variant="secondary" onPress={() => void chooseEvent(null)} />
      </ScrollView>
    </SafeAreaView>
  );
}

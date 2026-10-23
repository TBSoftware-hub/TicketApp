import { doorEventsResponseSchema, formatDoorEventTime } from "@ticketapp/shared";
import { useEffect, useState } from "react";
import { AppState, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "@/components/button";
import { StaffBar } from "@/components/staff-bar";
import { useSession } from "@/lib/session";
import { ui } from "@/lib/theme";

/** Home screen for the chosen event. The scanner (E7.2) and name lookup (E7.5) start from here. */
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
        <View style={ui.card}>
          <Text style={ui.body}>{formatDoorEventTime(event)}</Text>
          {event.venue && <Text style={ui.muted}>{event.venue}</Text>}
        </View>
        <View style={[ui.card, { gap: 8 }]}>
          <Text style={ui.heading}>Ready for the door</Text>
          <Text style={ui.muted}>
            {checking
              ? "Checking the event is still on…"
              : "Ticket scanning comes to this screen in the next update."}
          </Text>
        </View>
        <Button label="Change event" variant="secondary" onPress={() => void chooseEvent(null)} />
      </ScrollView>
    </SafeAreaView>
  );
}

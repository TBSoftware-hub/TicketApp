import {
  doorEventsResponseSchema,
  doorEventTiming,
  formatDoorEventTime,
  type DoorEvent,
} from "@ticketapp/shared";
import { useCallback, useEffect, useState } from "react";
import { Pressable, RefreshControl, SectionList, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "@/components/button";
import { StaffBar } from "@/components/staff-bar";
import { ApiError, UNREACHABLE } from "@/lib/api";
import { useSession } from "@/lib/session";
import { colors, ui } from "@/lib/theme";

/** Pick the event this device is working the door for. */
export default function EventPicker() {
  const { call, chooseEvent } = useSession();
  const [events, setEvents] = useState<DoorEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = doorEventsResponseSchema.parse(await call("/door/events"));
      setEvents(res.events);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : UNREACHABLE);
    }
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  const now = new Date();
  const sections = [
    { title: "On now", data: (events ?? []).filter((e) => doorEventTiming(e, now) === "now") },
    { title: "Coming up", data: (events ?? []).filter((e) => doorEventTiming(e, now) === "later") },
  ].filter((s) => s.data.length > 0);

  return (
    <SafeAreaView style={ui.screen}>
      <SectionList
        contentContainerStyle={ui.content}
        sections={sections}
        keyExtractor={(e) => e.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
        ListHeaderComponent={
          <View style={{ gap: 12 }}>
            <StaffBar />
            <Text style={ui.eyebrow}>TICKETAPP DOOR</Text>
            <Text style={ui.title}>Choose an event</Text>
          </View>
        }
        renderSectionHeader={({ section }) => (
          <Text style={[ui.eyebrow, styles.section]}>{section.title.toUpperCase()}</Text>
        )}
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${item.name}, ${formatDoorEventTime(item)}`}
            onPress={() => void chooseEvent(item)}
            style={({ pressed }) => [ui.card, styles.event, pressed && { opacity: 0.7 }]}
          >
            <Text style={ui.heading}>{item.name}</Text>
            <Text style={ui.muted}>{formatDoorEventTime(item)}</Text>
            <Text style={ui.muted}>
              {item.venue ? `${item.venue} · ${item.organization.name}` : item.organization.name}
            </Text>
          </Pressable>
        )}
        ListEmptyComponent={
          error ? (
            <View style={{ gap: 12 }}>
              <Text style={ui.error} accessibilityRole="alert">
                {error}
              </Text>
              <Button label="Try again" variant="secondary" onPress={() => void load()} />
            </View>
          ) : events === null ? (
            <Text style={ui.muted}>Loading events…</Text>
          ) : (
            <View style={[ui.card, { gap: 8 }]}>
              <Text style={ui.heading}>No events to run the door for</Text>
              <Text style={ui.muted}>
                Events show here once they&apos;re published and an organizer has added you as door
                staff. Pull down to check again.
              </Text>
            </View>
          )
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: 8, backgroundColor: colors.bg, paddingVertical: 4 },
  event: { marginBottom: 10 },
});

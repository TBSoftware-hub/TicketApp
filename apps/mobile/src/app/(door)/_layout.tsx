import { Stack } from "expo-router";
import { OfflineProvider } from "@/lib/offline";
import { useSession } from "@/lib/session";
import { colors } from "@/lib/theme";

/**
 * A device works one event at a time: it picks the event first, then stays on it. What it keeps
 * for working offline outlasts a change of event, so scans saved for the last one still get sent.
 */
export default function DoorLayout() {
  const { event } = useSession();
  return (
    <OfflineProvider>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
        <Stack.Protected guard={!!event}>
          <Stack.Screen name="index" />
        </Stack.Protected>
        <Stack.Protected guard={!event}>
          <Stack.Screen name="events" />
        </Stack.Protected>
      </Stack>
    </OfflineProvider>
  );
}

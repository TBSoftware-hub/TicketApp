import { Stack } from "expo-router";
import { useSession } from "@/lib/session";
import { colors } from "@/lib/theme";

/** A device works one event at a time: it picks the event first, then stays on it. */
export default function DoorLayout() {
  const { event } = useSession();
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
      <Stack.Protected guard={!!event}>
        <Stack.Screen name="index" />
      </Stack.Protected>
      <Stack.Protected guard={!event}>
        <Stack.Screen name="events" />
      </Stack.Protected>
    </Stack>
  );
}

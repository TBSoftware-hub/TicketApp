import { Link } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSession } from "@/lib/session";
import { colors, ui } from "@/lib/theme";

/** Who is signed in on this device, with a way out for handing the phone to someone else. */
export function StaffBar() {
  const { session, signOut } = useSession();
  return (
    <View style={styles.bar}>
      <Text style={[ui.muted, styles.name]} numberOfLines={1}>
        Signed in as {session?.staff.name}
      </Text>
      <View style={styles.actions}>
        <Link href="/privacy" style={styles.privacy}>
          Privacy
        </Link>
        <Pressable accessibilityRole="button" onPress={() => void signOut()} hitSlop={12}>
          <Text style={styles.signOut}>Sign out</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  name: { flexShrink: 1 },
  actions: { flexDirection: "row", alignItems: "center", gap: 16 },
  privacy: { color: colors.muted, fontSize: 15 },
  signOut: { color: colors.accent, fontSize: 15, fontWeight: "600" },
});

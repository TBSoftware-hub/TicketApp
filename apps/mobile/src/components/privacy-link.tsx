import { Link } from "expo-router";
import { StyleSheet } from "react-native";
import { colors } from "@/lib/theme";

/** A quiet link to the privacy policy, for the bottom of a screen. */
export function PrivacyLink() {
  return (
    <Link href="/privacy" style={styles.link} accessibilityRole="link">
      Privacy policy
    </Link>
  );
}

const styles = StyleSheet.create({
  link: { color: colors.accent, fontSize: 15, alignSelf: "center", padding: 8, marginTop: 12 },
});

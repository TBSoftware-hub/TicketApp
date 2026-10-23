import { ActivityIndicator, Pressable, StyleSheet, Text } from "react-native";
import { colors } from "@/lib/theme";

interface ButtonProps {
  label: string;
  onPress: () => void;
  /** Secondary buttons are outlined, for the less likely choice next to a primary one. */
  variant?: "primary" | "secondary";
  busy?: boolean;
  disabled?: boolean;
}

/** Full-width button sized for a thumb at the door. */
export function Button({ label, onPress, variant = "primary", busy, disabled }: ButtonProps) {
  const primary = variant === "primary";
  const inactive = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        primary ? styles.primary : styles.secondary,
        (pressed || inactive) && styles.dimmed,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={primary ? "#fff" : colors.accent} />
      ) : (
        <Text style={[styles.label, { color: primary ? "#fff" : colors.accent }]}>{label}</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 52,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  primary: { backgroundColor: colors.accent },
  secondary: { borderWidth: 1.5, borderColor: colors.accent, backgroundColor: "transparent" },
  dimmed: { opacity: 0.6 },
  label: { fontSize: 17, fontWeight: "600" },
});

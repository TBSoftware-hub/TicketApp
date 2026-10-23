import { StyleSheet } from "react-native";

/** The dashboard's palette, so the door app reads as the same product. */
export const colors = {
  bg: "#f3f4f1",
  card: "#ffffff",
  ink: "#1d2420",
  muted: "#5d665f",
  accent: "#2f5d50",
  line: "#d9ddd7",
  error: "#a3312a",
  placeholder: "#9aa39c",
};

export const ui = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, gap: 12, maxWidth: 480, width: "100%", alignSelf: "center" },
  eyebrow: { color: colors.muted, letterSpacing: 1.2, fontSize: 12, fontWeight: "600" },
  title: { color: colors.ink, fontSize: 28, fontWeight: "700" },
  heading: { color: colors.ink, fontSize: 17, fontWeight: "600" },
  body: { color: colors.ink, fontSize: 16, lineHeight: 22 },
  muted: { color: colors.muted, fontSize: 15, lineHeight: 21 },
  error: { color: colors.error, fontSize: 15, lineHeight: 21 },
  label: { color: colors.ink, fontSize: 15, fontWeight: "600" },
  input: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 10,
    backgroundColor: colors.card,
    color: colors.ink,
    fontSize: 17,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 16,
    gap: 4,
  },
});

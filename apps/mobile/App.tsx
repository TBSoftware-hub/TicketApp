import { isAdmittingOutcome, type ScanOutcome } from "@ticketapp/shared";
import { StatusBar } from "expo-status-bar";
import { StyleSheet, Text, View } from "react-native";

// Placeholder until the scanner lands (story E7.2): shows the shared scan rules are wired in.
const SAMPLE_OUTCOME: ScanOutcome = "admitted";

export default function App() {
  return (
    <View style={styles.container}>
      <Text style={styles.eyebrow}>DOOR CHECK-IN</Text>
      <Text style={styles.title}>TicketApp</Text>
      <Text style={styles.body}>
        Sample scan: {SAMPLE_OUTCOME} ({isAdmittingOutcome(SAMPLE_OUTCOME) ? "let in" : "stop"})
      </Text>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#f3f4f1",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    padding: 16,
  },
  eyebrow: { color: "#5d665f", letterSpacing: 1.2, fontSize: 12 },
  title: { color: "#1d2420", fontSize: 28, fontWeight: "700" },
  body: { color: "#1d2420" },
});

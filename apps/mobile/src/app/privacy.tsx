import { PRIVACY_POLICY, type PrivacyBlock } from "@ticketapp/shared";
import { router } from "expo-router";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useSession } from "@/lib/session";
import { colors, ui } from "@/lib/theme";

/** The privacy policy, open to anyone, signed in or not, as the app stores require. */
export default function Privacy() {
  const { session } = useSession();
  // Opened from a link there's a screen to go back to; opened directly (such as on the web
  // preview), go to wherever this device would start.
  const back = () =>
    router.canGoBack() ? router.back() : router.replace(session ? "/" : "/sign-in");
  return (
    <SafeAreaView style={ui.screen}>
      <ScrollView contentContainerStyle={ui.content}>
        <Pressable accessibilityRole="button" onPress={back} hitSlop={12}>
          <Text style={styles.back}>‹ Back</Text>
        </Pressable>
        <Text style={ui.eyebrow}>TICKETAPP</Text>
        <Text style={ui.title} accessibilityRole="header">
          Privacy policy
        </Text>
        <Text style={ui.muted}>Last updated {PRIVACY_POLICY.updated}</Text>
        {PRIVACY_POLICY.intro.map((text) => (
          <Text key={text} style={ui.body}>
            {text}
          </Text>
        ))}
        {PRIVACY_POLICY.sections.map((section) => (
          <View key={section.heading} style={styles.section}>
            <Text style={ui.heading} accessibilityRole="header">
              {section.heading}
            </Text>
            {section.blocks.map((block, i) => (
              <Block key={i} block={block} />
            ))}
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

function Block({ block }: { block: PrivacyBlock }) {
  if (typeof block === "string") return <Text style={ui.body}>{block}</Text>;
  return (
    <View style={{ gap: 6 }}>
      {block.bullets.map((item) => (
        <View key={item} style={styles.bullet}>
          <Text style={ui.body}>•</Text>
          <Text style={[ui.body, { flex: 1 }]}>{item}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  back: { color: colors.accent, fontSize: 16, fontWeight: "600" },
  section: { gap: 8, marginTop: 12 },
  bullet: { flexDirection: "row", gap: 8, paddingLeft: 4 },
});

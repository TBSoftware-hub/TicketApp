import { signInCodeRequestSchema, verifySignInCodeSchema } from "@ticketapp/shared";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button } from "@/components/button";
import { api, ApiError } from "@/lib/api";
import { useSession, type Staff } from "@/lib/session";
import { colors, ui } from "@/lib/theme";

const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Something went wrong. Try again.";

export default function SignIn() {
  const { signIn } = useSession();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  /** The address a code went to; set once the email step is done. */
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function sendCode(to: string) {
    const parsed = signInCodeRequestSchema.safeParse({ email: to.trim() });
    if (!parsed.success) {
      setError("Enter the email address you use for TicketApp.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api("/auth/sign-in-code", { method: "POST", body: parsed.data });
      setSentTo(parsed.data.email);
      setCode("");
      setNotice(sentTo ? "We sent another code. Check your inbox." : null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    const parsed = verifySignInCodeSchema.safeParse({ email: sentTo, code });
    if (!parsed.success) {
      setError("Enter the six-digit code from the email.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ sessionToken: string; user: Staff }>("/auth/verify-code", {
        method: "POST",
        body: parsed.data,
      });
      await signIn({ token: res.sessionToken, staff: res.user });
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={ui.screen}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
          <Text style={ui.eyebrow}>TICKETAPP DOOR</Text>
          <Text style={ui.title}>Sign in</Text>

          {sentTo === null ? (
            <>
              <Text style={ui.muted}>
                We&apos;ll email you a six-digit code. You can read it on any device.
              </Text>
              <View style={{ gap: 6 }}>
                <Text style={ui.label}>Email</Text>
                <TextInput
                  style={ui.input}
                  value={email}
                  onChangeText={setEmail}
                  onSubmitEditing={() => void sendCode(email)}
                  placeholder="you@school.org"
                  placeholderTextColor={colors.placeholder}
                  autoCapitalize="none"
                  autoComplete="email"
                  autoCorrect={false}
                  keyboardType="email-address"
                  textContentType="emailAddress"
                  returnKeyType="send"
                  accessibilityLabel="Email"
                />
              </View>
              {error && (
                <Text style={ui.error} accessibilityRole="alert">
                  {error}
                </Text>
              )}
              <Button label="Email me a code" busy={busy} onPress={() => void sendCode(email)} />
            </>
          ) : (
            <>
              <Text style={ui.muted}>
                Enter the code we sent to <Text style={ui.label}>{sentTo}</Text>. It expires in 15
                minutes.
              </Text>
              {notice && <Text style={ui.muted}>{notice}</Text>}
              <View style={{ gap: 6 }}>
                <Text style={ui.label}>Code</Text>
                <TextInput
                  style={[ui.input, { fontSize: 24, letterSpacing: 6 }]}
                  value={code}
                  onChangeText={setCode}
                  onSubmitEditing={() => void verify()}
                  placeholder="123 456"
                  placeholderTextColor={colors.placeholder}
                  keyboardType="number-pad"
                  autoComplete="one-time-code"
                  textContentType="oneTimeCode"
                  maxLength={7}
                  autoFocus
                  accessibilityLabel="Six-digit code"
                />
              </View>
              {error && (
                <Text style={ui.error} accessibilityRole="alert">
                  {error}
                </Text>
              )}
              <Button label="Sign in" busy={busy} onPress={() => void verify()} />
              <Button
                label="Send a new code"
                variant="secondary"
                disabled={busy}
                onPress={() => void sendCode(sentTo)}
              />
              <Button
                label="Use a different email"
                variant="secondary"
                disabled={busy}
                onPress={() => {
                  setSentTo(null);
                  setNotice(null);
                  setError(null);
                }}
              />
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

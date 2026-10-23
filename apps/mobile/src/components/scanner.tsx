import {
  describeScan,
  doorScanResultSchema,
  doorScanSchema,
  WAIVER_OVERRIDE_REASONS,
  type DoorEvent,
  type ScanDisplay,
} from "@ticketapp/shared";
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import * as Crypto from "expo-crypto";
import * as Haptics from "expo-haptics";
import * as Linking from "expo-linking";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Button } from "@/components/button";
import { ApiError, UNREACHABLE } from "@/lib/api";
import { useSession } from "@/lib/session";
import { colors, ui } from "@/lib/theme";

/** A valid ticket's green clears itself after this long, so a steady line keeps moving. */
const ADMITTED_SHOWN_MS = 2500;
/** The camera is usually still on the code just answered; ignore it for this long afterwards. */
const SAME_CODE_IGNORED_MS = 5000;
/** How long a check may take before staff are offered Try again or Skip. */
const SCAN_TIMEOUT_MS = 10_000;

/**
 * What was scanned: the code, the key a retry of the same scan sends again, and the reason staff
 * gave for letting them in when it's a waiver override.
 */
interface Scan {
  code: string;
  key: string;
  overrideReason?: string;
}

type Shown = (Scan & { display: ScanDisplay }) | (Scan & { error: string });

const HAPTIC: Record<ScanDisplay["tone"], Haptics.NotificationFeedbackType> = {
  go: Haptics.NotificationFeedbackType.Success,
  warn: Haptics.NotificationFeedbackType.Warning,
  stop: Haptics.NotificationFeedbackType.Error,
};

/** The camera, reading ticket QR codes for `event` one at a time and showing each answer over it. */
export function Scanner({ event }: { event: DoorEvent }) {
  const { call } = useSession();
  const [permission, requestPermission, getPermission] = useCameraPermissions();
  const [shown, setShown] = useState<Shown | null>(null);
  // Set while staff give a reason for letting in someone whose waiver is missing.
  const [overriding, setOverriding] = useState<{ code: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [torch, setTorch] = useState(false);
  const [width, setWidth] = useState(0);
  // The camera reports the same code many times a second; this holds it to one check at a time.
  const locked = useRef(false);
  // Set while a check is on its way, so a retry tapped twice can't send the code twice.
  const inFlight = useRef(false);
  const lastCode = useRef<{ code: string; until: number } | null>(null);
  // Set false on unmount, so a late answer isn't shown on a screen that moved on.
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  // Staff who turn camera access on in Settings come back to the app without it restarting.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void getPermission();
    });
    return () => subscription.remove();
  }, [getPermission]);

  const check = useCallback(
    ({ code, key, overrideReason }: Scan) => {
      if (inFlight.current) return;
      inFlight.current = true;
      locked.current = true;
      setBusy(true);
      call(`/orgs/${event.organization.id}/events/${event.id}/scans`, {
        method: "POST",
        body: { scanKey: key, code, overrideReason },
        // A stalled network shows Try again, which resends the same key, rather than hanging.
        timeoutMs: SCAN_TIMEOUT_MS,
      })
        .then((res) => {
          if (!mounted.current) return;
          const display = describeScan(
            doorScanResultSchema.parse(res),
            event.organization.timezone,
          );
          setOverriding(null);
          setShown({ code, key, overrideReason, display });
          void Haptics.notificationAsync(HAPTIC[display.tone]).catch(() => undefined);
        })
        .catch((err: unknown) => {
          if (!mounted.current) return;
          setOverriding(null);
          setShown({
            code,
            key,
            overrideReason,
            error: err instanceof ApiError ? err.message : UNREACHABLE,
          });
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(
            () => undefined,
          );
        })
        .finally(() => {
          inFlight.current = false;
          if (mounted.current) setBusy(false);
        });
    },
    [call, event],
  );

  const scanned = useCallback(
    ({ data }: BarcodeScanningResult) => {
      const code = data.trim();
      if (locked.current || !code) return;
      const last = lastCode.current;
      if (last && last.code === code && Date.now() < last.until) return;
      check({ code, key: Crypto.randomUUID() });
    },
    [check],
  );

  const next = useCallback(() => {
    const code = shown?.code ?? overriding?.code;
    if (code) lastCode.current = { code, until: Date.now() + SAME_CODE_IGNORED_MS };
    setShown(null);
    setOverriding(null);
    locked.current = false;
  }, [shown, overriding]);

  useEffect(() => {
    if (!shown || !("display" in shown) || shown.display.tone !== "go") return;
    const timer = setTimeout(next, ADMITTED_SHOWN_MS);
    return () => clearTimeout(timer);
  }, [shown, next]);

  if (!permission) return null;
  if (!permission.granted) {
    return (
      <View style={[ui.card, { gap: 12 }]}>
        <Text style={ui.heading}>Scan tickets with the camera</Text>
        <Text style={ui.muted}>
          {permission.canAskAgain
            ? "TicketApp needs the camera to read the QR codes on tickets."
            : "Camera access is off for TicketApp. Turn it on in Settings to scan tickets."}
        </Text>
        {permission.canAskAgain ? (
          <Button label="Allow camera" onPress={() => void requestPermission()} />
        ) : (
          <Button label="Open Settings" onPress={() => void Linking.openSettings()} />
        )}
      </View>
    );
  }

  return (
    <View style={{ gap: 12 }}>
      {/* Square while scanning; a result taller than that (large text, a long name) grows it. */}
      <View style={styles.frame} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={shown || overriding || busy ? undefined : scanned}
          enableTorch={torch}
        />
        {overriding ? (
          <Override
            name={overriding.name}
            busy={busy}
            minHeight={width}
            onCancel={next}
            // A new key: the blocked scan wasn't an admission, so this one is a scan of its own.
            onSubmit={(reason) =>
              check({ code: overriding.code, key: Crypto.randomUUID(), overrideReason: reason })
            }
          />
        ) : shown ? (
          <Result
            shown={shown}
            busy={busy}
            minHeight={width}
            onNext={next}
            onRetry={() => check(shown)}
            onOverride={() => {
              if (!("display" in shown)) return;
              setShown(null);
              setOverriding({ code: shown.code, name: shown.display.lines[0] ?? "" });
            }}
          />
        ) : (
          <View style={styles.square}>
            <View style={styles.hint} pointerEvents="none">
              <Text style={styles.hintText}>
                {busy ? "Checking ticket…" : "Point at a ticket's QR code"}
              </Text>
            </View>
          </View>
        )}
      </View>
      {Platform.OS !== "web" && (
        <Button
          label={torch ? "Turn off light" : "Turn on light"}
          variant="secondary"
          onPress={() => setTorch((on) => !on)}
        />
      )}
    </View>
  );
}

function Result({
  shown,
  busy,
  minHeight,
  onNext,
  onRetry,
  onOverride,
}: {
  shown: Shown;
  /** At least the camera square's height, so a short result still covers the camera. */
  minHeight: number;
  /** A retry is on its way: its answer replaces this one, so nothing here can be tapped. */
  busy: boolean;
  onNext: () => void;
  onRetry: () => void;
  onOverride: () => void;
}) {
  const failed = "error" in shown;
  const overridable = !failed && shown.display.overridable === true;
  const tone = failed ? "stop" : shown.display.tone;
  const title = failed ? "Couldn't check this ticket" : shown.display.title;
  const lines = failed ? [shown.error] : shown.display.lines;
  return (
    <Pressable
      accessibilityRole="alert"
      accessibilityLiveRegion="assertive"
      // Tapping anywhere on a result moves on; after a failed check it tries the same code again.
      onPress={failed ? onRetry : onNext}
      disabled={busy}
      // Screen readers treat the whole result as one element, so Skip is offered as an action on it.
      accessibilityActions={
        busy
          ? []
          : failed
            ? [
                { name: "activate", label: "Try again" },
                { name: "skip", label: "Skip" },
              ]
            : overridable
              ? [
                  { name: "activate", label: "Turn away and scan next" },
                  { name: "override", label: "Let in anyway" },
                ]
              : [{ name: "activate", label: "Scan next" }]
      }
      onAccessibilityAction={({ nativeEvent }) => {
        if (busy) return;
        if (nativeEvent.actionName === "skip") onNext();
        else if (nativeEvent.actionName === "override") onOverride();
        else if (failed) onRetry();
        else onNext();
      }}
      style={[styles.result, { minHeight, backgroundColor: colors[tone] }]}
    >
      <Text style={styles.resultTitle}>{title}</Text>
      {lines.map((line, i) => (
        <Text
          key={i}
          style={
            i === 0 && (tone !== "stop" || overridable) ? styles.resultName : styles.resultLine
          }
        >
          {line}
        </Text>
      ))}
      {busy ? (
        <Text style={styles.resultLine}>Checking ticket…</Text>
      ) : overridable ? (
        <View style={styles.overrideActions}>
          <Pressable accessibilityRole="button" onPress={onOverride} style={styles.overrideButton}>
            <Text style={styles.overrideButtonText}>Let in anyway</Text>
          </Pressable>
          <Text style={styles.resultAction}>Tap elsewhere to turn away</Text>
        </View>
      ) : (
        <Text style={styles.resultAction}>{failed ? "Tap to try again" : "Tap to scan next"}</Text>
      )}
      {failed && !busy && (
        <Pressable accessibilityRole="button" onPress={onNext} hitSlop={12}>
          <Text style={styles.resultAction}>Skip</Text>
        </Pressable>
      )}
    </Pressable>
  );
}

/** Asks why someone whose waiver is missing is being let in, which goes on the scan's record. */
function Override({
  name,
  busy,
  minHeight,
  onCancel,
  onSubmit,
}: {
  name: string;
  busy: boolean;
  minHeight: number;
  onCancel: () => void;
  onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    const parsed = doorScanSchema.shape.overrideReason.safeParse(reason);
    if (!parsed.success || !parsed.data) {
      setError(parsed.error?.issues[0]?.message ?? "Say why you're letting them in");
      return;
    }
    setError(null);
    onSubmit(parsed.data);
  };
  return (
    <View style={[styles.override, { minHeight }]}>
      <Text style={ui.heading}>Let {name} in without a waiver?</Text>
      <Text style={ui.muted}>Your reason is kept with this check-in.</Text>
      <View style={styles.chips}>
        {WAIVER_OVERRIDE_REASONS.map((r) => (
          <Pressable
            key={r}
            accessibilityRole="button"
            accessibilityState={{ selected: reason === r }}
            onPress={() => {
              setReason(r);
              setError(null);
            }}
            style={[styles.chip, reason === r && styles.chipOn]}
          >
            <Text style={[styles.chipText, reason === r && styles.chipTextOn]}>{r}</Text>
          </Pressable>
        ))}
      </View>
      <TextInput
        style={[ui.input, styles.reasonInput]}
        value={reason}
        onChangeText={(text) => {
          setReason(text);
          setError(null);
        }}
        placeholder="Or type the reason"
        placeholderTextColor={colors.placeholder}
        multiline
        maxLength={500}
        accessibilityLabel="Reason for letting them in"
      />
      {error && (
        <Text style={ui.error} accessibilityRole="alert">
          {error}
        </Text>
      )}
      <Button label="Let them in" onPress={submit} busy={busy} />
      <Button label="Cancel" variant="secondary" onPress={onCancel} disabled={busy} />
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    width: "100%",
    borderRadius: 16,
    overflow: "hidden",
    backgroundColor: "#000",
  },
  square: { aspectRatio: 1, width: "100%" },
  hint: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    padding: 14,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  hintText: { color: "#fff", fontSize: 16, fontWeight: "600", textAlign: "center" },
  result: { padding: 24, gap: 10, justifyContent: "center", alignItems: "center" },
  resultTitle: { color: "#fff", fontSize: 32, fontWeight: "800", textAlign: "center" },
  resultName: { color: "#fff", fontSize: 24, fontWeight: "700", textAlign: "center" },
  resultLine: { color: "#fff", fontSize: 18, lineHeight: 24, textAlign: "center" },
  overrideActions: { alignItems: "center", gap: 4, marginTop: 8, alignSelf: "stretch" },
  overrideButton: {
    minHeight: 52,
    borderRadius: 10,
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 20,
    alignSelf: "stretch",
  },
  overrideButtonText: { color: colors.stop, fontSize: 18, fontWeight: "700" },
  override: { padding: 20, gap: 12, backgroundColor: colors.card, justifyContent: "center" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    borderWidth: 1.5,
    borderColor: colors.accent,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  chipOn: { backgroundColor: colors.accent },
  chipText: { color: colors.accent, fontSize: 15, fontWeight: "600" },
  chipTextOn: { color: "#fff" },
  reasonInput: { minHeight: 72, textAlignVertical: "top" },
  resultAction: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
    marginTop: 12,
    textDecorationLine: "underline",
  },
});

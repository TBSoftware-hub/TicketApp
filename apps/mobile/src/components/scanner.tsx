import {
  describeScan,
  doorScanResultSchema,
  type DoorEvent,
  type ScanDisplay,
} from "@ticketapp/shared";
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import * as Haptics from "expo-haptics";
import * as Linking from "expo-linking";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { Button } from "@/components/button";
import { ApiError, UNREACHABLE } from "@/lib/api";
import { useSession } from "@/lib/session";
import { colors, ui } from "@/lib/theme";

/** A valid ticket's green clears itself after this long, so a steady line keeps moving. */
const ADMITTED_SHOWN_MS = 2500;
/** The camera is usually still on the code just answered; ignore it for this long afterwards. */
const SAME_CODE_IGNORED_MS = 5000;

type Shown = { code: string; display: ScanDisplay } | { code: string; error: string };

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
  const [busy, setBusy] = useState(false);
  const [torch, setTorch] = useState(false);
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
    (code: string) => {
      if (inFlight.current) return;
      inFlight.current = true;
      locked.current = true;
      setBusy(true);
      call(`/orgs/${event.organization.id}/events/${event.id}/scans`, {
        method: "POST",
        body: { code },
      })
        .then((res) => {
          if (!mounted.current) return;
          const display = describeScan(
            doorScanResultSchema.parse(res),
            event.organization.timezone,
          );
          setShown({ code, display });
          void Haptics.notificationAsync(HAPTIC[display.tone]).catch(() => undefined);
        })
        .catch((err: unknown) => {
          if (!mounted.current) return;
          setShown({ code, error: err instanceof ApiError ? err.message : UNREACHABLE });
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
      check(code);
    },
    [check],
  );

  const next = useCallback(() => {
    if (shown) lastCode.current = { code: shown.code, until: Date.now() + SAME_CODE_IGNORED_MS };
    setShown(null);
    locked.current = false;
  }, [shown]);

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
      <View style={styles.frame}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={shown || busy ? undefined : scanned}
          enableTorch={torch}
        />
        {shown ? (
          <Result shown={shown} busy={busy} onNext={next} onRetry={() => check(shown.code)} />
        ) : (
          <View style={styles.hint} pointerEvents="none">
            <Text style={styles.hintText}>
              {busy ? "Checking ticket…" : "Point at a ticket's QR code"}
            </Text>
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
  onNext,
  onRetry,
}: {
  shown: Shown;
  /** A retry is on its way: its answer replaces this one, so nothing here can be tapped. */
  busy: boolean;
  onNext: () => void;
  onRetry: () => void;
}) {
  const failed = "error" in shown;
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
      style={[StyleSheet.absoluteFill, styles.result, { backgroundColor: colors[tone] }]}
    >
      <Text style={styles.resultTitle}>{title}</Text>
      {lines.map((line, i) => (
        <Text key={i} style={i === 0 && tone !== "stop" ? styles.resultName : styles.resultLine}>
          {line}
        </Text>
      ))}
      {busy ? (
        <Text style={styles.resultLine}>Checking ticket…</Text>
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

const styles = StyleSheet.create({
  frame: {
    aspectRatio: 1,
    width: "100%",
    borderRadius: 16,
    overflow: "hidden",
    backgroundColor: "#000",
  },
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
  resultAction: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
    marginTop: 12,
    textDecorationLine: "underline",
  },
});

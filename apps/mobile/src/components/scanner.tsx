import {
  describeScan,
  doorScanResultSchema,
  doorScanSchema,
  SCAN_OVERRIDES,
  type DoorEvent,
  type ScanDirection,
  type ScanDisplay,
  type ScanOverride,
} from "@ticketapp/shared";
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import * as Crypto from "expo-crypto";
import * as Haptics from "expo-haptics";
import * as Linking from "expo-linking";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Button } from "@/components/button";
import { Lookup } from "@/components/lookup";
import { ApiError, UNREACHABLE } from "@/lib/api";
import { useOffline, type DoorScanRequest } from "@/lib/offline";
import { useSession } from "@/lib/session";
import { colors, ui } from "@/lib/theme";

/** A valid ticket's green clears itself after this long, so a steady line keeps moving. */
const ADMITTED_SHOWN_MS = 2500;
/** The camera is usually still on the code just answered; ignore it for this long afterwards. */
const SAME_CODE_IGNORED_MS = 5000;
/** Shown when scans saved offline are still to send and there's no list to check this one on. */
const PENDING_NO_LIST =
  "This device is still sending scans saved offline and has no saved list to check this one against. Try again once they've gone.";
/** Shown when the scans saved offline on this device can't be read back. */
const QUEUE_UNREADABLE =
  "This device couldn't read back the scans it saved offline, so it can't check tickets in order. Try again in a moment, or restart the app.";
/** How long a check may take before staff are offered Try again or Skip. */
const SCAN_TIMEOUT_MS = 10_000;

type Scan = DoorScanRequest;

/** What staff tap to let someone in past each answer. */
const OVERRIDE_LABEL: Record<ScanOverride, string> = {
  waiver_missing: "Let in anyway",
  reentry_denied: "Let back in",
};

type Shown = (Scan & { display: ScanDisplay }) | (Scan & { error: string });

const HAPTIC: Record<ScanDisplay["tone"], Haptics.NotificationFeedbackType> = {
  go: Haptics.NotificationFeedbackType.Success,
  warn: Haptics.NotificationFeedbackType.Warning,
  stop: Haptics.NotificationFeedbackType.Error,
};

/** The camera, reading ticket QR codes for `event` one at a time and showing each answer over it. */
export function Scanner({ event }: { event: DoorEvent }) {
  const { call } = useSession();
  const door = useOffline();
  // Read when a scan is checked: the camera can hold on to the handler from an earlier render.
  const doorRef = useRef(door);
  doorRef.current = door;
  const [permission, requestPermission, getPermission] = useCameraPermissions();
  const [shown, setShown] = useState<Shown | null>(null);
  // Scanning people in, or out as they leave. The camera can hold on to the scan handler it started
  // with, so the handler reads the direction from a ref rather than from its closure.
  const [direction, setDirection] = useState<ScanDirection>("in");
  const directionRef = useRef(direction);
  directionRef.current = direction;
  // Set while staff give a reason for letting someone in past a waiver or re-entry answer.
  const [overriding, setOverriding] = useState<{
    code?: string;
    ticketId?: string;
    name: string;
    kind: ScanOverride;
  } | null>(null);
  // Set while staff look someone up by name, for a guest who can't show their QR code.
  const [lookingUp, setLookingUp] = useState(false);
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
    (sent: Scan) => {
      if (inFlight.current) return;
      // Timed from when staff scanned it, not from when a slow connection gave up, and kept for a
      // retry of the same scan.
      const scan = { ...sent, at: sent.at ?? Date.now() };
      inFlight.current = true;
      locked.current = true;
      setBusy(true);
      const show = (display: ScanDisplay) => {
        if (!mounted.current) return;
        setOverriding(null);
        setShown({ ...scan, display });
        void Haptics.notificationAsync(HAPTIC[display.tone]).catch(() => undefined);
      };
      const fail = (error: string) => {
        if (!mounted.current) return;
        setOverriding(null);
        setShown({ ...scan, error });
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(
          () => undefined,
        );
      };
      void (async () => {
        const offline = doorRef.current;
        // As the saved list had them before this scan was sent, in case its answer is lost.
        let before: Awaited<ReturnType<typeof offline.before>> = null;
        try {
          // Scans saved offline before the app last stopped go first, so they're read back first.
          if (!(await offline.ready())) return fail(QUEUE_UNREADABLE);
          // Offline, or still sending scans saved offline, the saved list answers straight away:
          // waiting on a dead connection for each person would back up the line.
          if (offline.isOffline()) {
            const display = await offline.answer(scan);
            if (display) return show(display);
            // Sent now, this scan could reach TicketApp ahead of the earlier ones it follows.
            if (offline.hasPending()) return fail(PENDING_NO_LIST);
          }
          const { code, ticketId, direction, key, override, overrideReason } = scan;
          before = await offline.before(scan);
          const result = doorScanResultSchema.parse(
            await call(`/orgs/${event.organization.id}/events/${event.id}/scans`, {
              method: "POST",
              body: { scanKey: key, code, ticketId, direction, override, overrideReason },
              // A stalled network answers from the saved list, or shows Try again, which resends
              // the same key, rather than hanging.
              timeoutMs: SCAN_TIMEOUT_MS,
            }),
          );
          void offline.answered(scan, result);
          show(describeScan(result, event.organization.timezone));
        } catch (err) {
          // A screen closed meanwhile can't show the answer, so it mustn't let anyone in or out.
          if (err instanceof ApiError && err.status === 0 && mounted.current) {
            // The scan may have reached TicketApp before the connection went: one saved here goes
            // with the same key, so it can't count twice.
            offline.unreachable();
            const display = await offline.answer(scan, before).catch(() => null);
            if (display) return show(display);
          }
          // TicketApp won't let this account work the event, or it can't be worked any more: its
          // saved list mustn't answer for it either.
          if (err instanceof ApiError && [403, 404, 409].includes(err.status)) {
            offline.refused(event.id);
          }
          fail(err instanceof ApiError ? err.message : UNREACHABLE);
        } finally {
          inFlight.current = false;
          if (mounted.current) setBusy(false);
        }
      })();
    },
    [call, event],
  );

  const scanned = useCallback(
    ({ data }: BarcodeScanningResult) => {
      const code = data.trim();
      if (locked.current || !code) return;
      const last = lastCode.current;
      if (last && last.code === code && Date.now() < last.until) return;
      check({ code, direction: directionRef.current, key: Crypto.randomUUID() });
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

  // Looking people up by name doesn't need the camera, so only the camera waits on permission.
  const cameraOn = !!permission?.granted;

  return (
    <View style={{ gap: 12 }}>
      <View style={styles.modes} accessibilityRole="radiogroup">
        {(["in", "out"] as const).map((mode) => (
          <Pressable
            key={mode}
            accessibilityRole="radio"
            accessibilityState={{ checked: direction === mode, disabled: busy || !!overriding }}
            // A scan on its way keeps the direction it was sent with; the next one takes the new one.
            disabled={busy || !!overriding}
            onPress={() => setDirection(mode)}
            style={[styles.mode, direction === mode && styles.modeOn]}
          >
            <Text style={[styles.modeText, direction === mode && styles.modeTextOn]}>
              {mode === "in" ? "Check in" : "Check out"}
            </Text>
          </Pressable>
        ))}
      </View>
      {/* Square while scanning; a result taller than that (large text, a long name) grows it. */}
      <View
        style={[styles.frame, !cameraOn && styles.frameOff]}
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      >
        {cameraOn && (
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={shown || overriding || lookingUp || busy ? undefined : scanned}
            enableTorch={torch}
          />
        )}
        {overriding ? (
          <Override
            name={overriding.name}
            kind={overriding.kind}
            busy={busy}
            minHeight={width}
            onCancel={next}
            // A new key: the blocked scan wasn't an admission, so this one is a scan of its own.
            onSubmit={(reason) =>
              check({
                code: overriding.code,
                ticketId: overriding.ticketId,
                direction: "in",
                key: Crypto.randomUUID(),
                override: overriding.kind,
                overrideReason: reason,
              })
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
              if (!("display" in shown) || !shown.display.override) return;
              setShown(null);
              setOverriding({
                code: shown.code,
                ticketId: shown.ticketId,
                name: shown.display.lines[0] ?? "",
                kind: shown.display.override,
              });
            }}
          />
        ) : lookingUp ? (
          <Lookup
            event={event}
            direction={direction}
            minHeight={width}
            onCancel={() => setLookingUp(false)}
            // Their answer shows just as a scan's would, and the camera comes back after it.
            onPick={(ticket) => {
              setLookingUp(false);
              check({ ticketId: ticket.ticketId, direction, key: Crypto.randomUUID() });
            }}
          />
        ) : !cameraOn ? (
          // Still asking the device whether the camera is allowed, when there's no permission yet.
          permission && (
            <View style={styles.cameraOff}>
              <Text style={ui.heading}>Scan tickets with the camera</Text>
              <Text style={ui.muted}>
                {permission.canAskAgain
                  ? "TicketApp needs the camera to read the QR codes on tickets. You can still look people up by name."
                  : "Camera access is off for TicketApp. Turn it on in Settings to scan tickets, or look people up by name."}
              </Text>
              {permission.canAskAgain ? (
                <Button label="Allow camera" onPress={() => void requestPermission()} />
              ) : (
                <Button label="Open Settings" onPress={() => void Linking.openSettings()} />
              )}
            </View>
          )
        ) : (
          <View style={styles.square}>
            <View style={[styles.hint, direction === "out" && styles.hintOut]} pointerEvents="none">
              <Text style={styles.hintText}>
                {busy
                  ? "Checking ticket…"
                  : direction === "in"
                    ? "Point at a ticket's QR code"
                    : "Checking out: point at a ticket's QR code"}
              </Text>
            </View>
          </View>
        )}
      </View>
      {!lookingUp && !shown && !overriding && (
        <Button
          label="Look up by name"
          variant="secondary"
          disabled={busy}
          onPress={() => setLookingUp(true)}
        />
      )}
      {Platform.OS !== "web" && cameraOn && !lookingUp && (
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
  const override = failed ? undefined : shown.display.override;
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
            : override
              ? [
                  { name: "activate", label: "Turn away and scan next" },
                  { name: "override", label: OVERRIDE_LABEL[override] },
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
          style={i === 0 && (tone !== "stop" || override) ? styles.resultName : styles.resultLine}
        >
          {line}
        </Text>
      ))}
      {busy ? (
        <Text style={styles.resultLine}>Checking ticket…</Text>
      ) : override ? (
        <View style={styles.overrideActions}>
          <Pressable accessibilityRole="button" onPress={onOverride} style={styles.overrideButton}>
            <Text style={styles.overrideButtonText}>{OVERRIDE_LABEL[override]}</Text>
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

/**
 * Asks why someone whose waiver is missing, or who left an event without re-entry, is being let
 * in, which goes on the scan's record.
 */
function Override({
  name,
  kind,
  busy,
  minHeight,
  onCancel,
  onSubmit,
}: {
  name: string;
  kind: ScanOverride;
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
      <Text style={ui.heading}>{SCAN_OVERRIDES[kind].question(name)}</Text>
      <Text style={ui.muted}>Your reason is kept with this check-in.</Text>
      <View style={styles.chips}>
        {SCAN_OVERRIDES[kind].reasons.map((r) => (
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
  // Without the camera there's nothing to frame, so it reads as a card like the rest of the screen.
  frameOff: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line },
  cameraOff: { padding: 16, gap: 12 },
  square: { aspectRatio: 1, width: "100%" },
  modes: {
    flexDirection: "row",
    borderWidth: 1.5,
    borderColor: colors.accent,
    borderRadius: 12,
    overflow: "hidden",
  },
  mode: { flex: 1, minHeight: 48, alignItems: "center", justifyContent: "center" },
  modeOn: { backgroundColor: colors.accent },
  modeText: { color: colors.accent, fontSize: 17, fontWeight: "700" },
  modeTextOn: { color: "#fff" },
  hint: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    padding: 14,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  // Check-out mode shows in a different colour, so nobody scans people out by mistake.
  hintOut: { backgroundColor: colors.warn },
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

import {
  describeLookupTicket,
  doorLookupResultSchema,
  doorLookupSchema,
  type DoorEvent,
  type DoorLookupResult,
  type DoorLookupTicket,
  type ScanDirection,
} from "@ticketapp/shared";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Button } from "@/components/button";
import { ApiError, UNREACHABLE } from "@/lib/api";
import { useOffline } from "@/lib/offline";
import { useSession } from "@/lib/session";
import { colors, ui } from "@/lib/theme";

/** How long typing has to pause before the name is looked up, so each letter isn't a request. */
const TYPING_PAUSE_MS = 300;
/** How long a lookup may take before staff are told it couldn't reach TicketApp. */
const LOOKUP_TIMEOUT_MS = 10_000;

/**
 * The answer to the last name looked up, and which name it was for. `offline` marks one found on
 * the list saved on the device.
 */
type Found = ({ result: DoorLookupResult; offline?: boolean } | { error: string }) & { q: string };

/**
 * Finds someone coming to `event` by name, for a guest who can't show their QR code. Picking them
 * checks them in or out just as scanning their ticket would.
 */
export function Lookup({
  event,
  direction,
  minHeight,
  onPick,
  onCancel,
}: {
  event: DoorEvent;
  direction: ScanDirection;
  minHeight: number;
  onPick: (ticket: DoorLookupTicket) => void;
  onCancel: () => void;
}) {
  const { call } = useSession();
  const { offline, search, unreachable, refused } = useOffline();
  const [name, setName] = useState("");
  const [found, setFound] = useState<Found | null>(null);
  const [searching, setSearching] = useState(false);
  const parsed = doorLookupSchema.safeParse({ q: name });
  const q = parsed.success ? parsed.data.q : null;
  // Only the answer for the name as it's typed now is shown: an earlier name's list could check in
  // the wrong person.
  const answer = found && !searching && found.q === q ? found : null;

  useEffect(() => {
    if (!q) {
      setFound(null);
      setSearching(false);
      return;
    }
    // Offline, the saved list answers as they type.
    const saved = offline ? search(q) : null;
    if (saved) {
      setFound({ q, result: saved, offline: true });
      setSearching(false);
      return;
    }
    // An answer for a name since changed is dropped, so results never lag behind the typing.
    let current = true;
    setSearching(true);
    const timer = setTimeout(() => {
      call(`/orgs/${event.organization.id}/events/${event.id}/lookup?q=${encodeURIComponent(q)}`, {
        timeoutMs: LOOKUP_TIMEOUT_MS,
      })
        .then((res) => {
          if (current) setFound({ q, result: doorLookupResultSchema.parse(res) });
        })
        .catch((err: unknown) => {
          // TicketApp won't let this account work the event, or it can't be worked any more: its
          // saved list mustn't answer for it either, whatever name is typed now.
          if (err instanceof ApiError && [403, 404, 409].includes(err.status)) refused(event.id);
          if (!current) return;
          // No answer, or TicketApp is down for now: the saved list answers instead.
          if (err instanceof ApiError && (err.status === 0 || err.status >= 500)) {
            unreachable();
            const saved = search(q);
            if (saved) return setFound({ q, result: saved, offline: true });
          }
          setFound({ q, error: err instanceof ApiError ? err.message : UNREACHABLE });
        })
        .finally(() => {
          if (current) setSearching(false);
        });
    }, TYPING_PAUSE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [q, call, event, offline, search, unreachable, refused]);

  return (
    <View style={[styles.lookup, { minHeight }]}>
      <Text style={ui.heading}>
        {direction === "in" ? "Find someone to check in" : "Find someone to check out"}
      </Text>
      <TextInput
        style={ui.input}
        value={name}
        onChangeText={setName}
        placeholder="First or last name"
        placeholderTextColor={colors.placeholder}
        autoFocus
        autoCorrect={false}
        autoComplete="off"
        autoCapitalize="words"
        returnKeyType="search"
        maxLength={100}
        accessibilityLabel="Name to look up"
      />
      {!q ? (
        <Text style={ui.muted}>Type at least two letters of their first or last name.</Text>
      ) : !answer ? (
        <ActivityIndicator color={colors.accent} accessibilityLabel="Looking them up" />
      ) : "error" in answer ? (
        <Text style={ui.error} accessibilityRole="alert">
          {answer.error}
        </Text>
      ) : answer.result.tickets.length === 0 ? (
        <Text style={ui.muted} accessibilityLiveRegion="polite">
          No one coming to this event matches “{answer.q}”. Check the spelling, or try their last
          name.
        </Text>
      ) : (
        <View style={styles.list}>
          {answer.offline && (
            <Text style={ui.muted}>Offline: found on the list saved on this device.</Text>
          )}
          {answer.result.tickets.map((ticket) => (
            <Person key={ticket.ticketId} ticket={ticket} onPress={() => onPick(ticket)} />
          ))}
          {answer.result.more && (
            <Text style={ui.muted}>More people match. Type more of their name to narrow it.</Text>
          )}
        </View>
      )}
      <Button label="Back to scanning" variant="secondary" onPress={onCancel} />
    </View>
  );
}

/** One person a lookup found, with where they stand, tapped to check them in or out. */
function Person({ ticket, onPress }: { ticket: DoorLookupTicket; onPress: () => void }) {
  const { tone, status } = describeLookupTicket(ticket);
  const details = [
    ticket.ticketTypeName,
    ...(ticket.grade === null ? [] : [`Grade ${ticket.grade}`]),
  ].join(" · ");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${ticket.attendeeName}, ${details}, ${status}`}
      onPress={onPress}
      style={({ pressed }) => [styles.person, pressed && styles.pressed]}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.name}>{ticket.attendeeName}</Text>
        <Text style={ui.muted}>{details}</Text>
      </View>
      <Text style={[styles.status, { backgroundColor: colors[tone] }]}>{status}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  lookup: { padding: 16, gap: 12, backgroundColor: colors.card },
  list: { gap: 8 },
  person: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 60,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 10,
    backgroundColor: colors.card,
  },
  pressed: { backgroundColor: colors.bg },
  name: { color: colors.ink, fontSize: 18, fontWeight: "700" },
  status: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "700",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    overflow: "hidden",
  },
});

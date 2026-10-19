import { formatCents } from "@ticketapp/shared";

export default function HomePage() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "48px 16px" }}>
      <p style={{ color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
        Dashboard
      </p>
      <h1 style={{ margin: "4px 0 12px" }}>TicketApp</h1>
      <p>
        Sell tickets with waivers built in, check students in and out at the door, and text parents
        when they arrive and leave.
      </p>
      <p style={{ color: "var(--muted)" }}>
        Sample ticket price: <strong style={{ color: "var(--accent)" }}>{formatCents(2500)}</strong>
      </p>
    </main>
  );
}

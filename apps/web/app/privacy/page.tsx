import { PRIVACY_POLICY, type PrivacyBlock } from "@ticketapp/shared";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Privacy policy · TicketApp" };

/** The privacy policy, public so the app stores and buyers can link to it. */
export default function PrivacyPage() {
  return (
    <main className="public privacy">
      <p className="eyebrow">TicketApp</p>
      <h1>Privacy policy</h1>
      <p className="muted">Last updated {PRIVACY_POLICY.updated}</p>
      {PRIVACY_POLICY.intro.map((text) => (
        <p key={text}>{text}</p>
      ))}
      {PRIVACY_POLICY.sections.map((section) => (
        <section key={section.heading}>
          <h2>{section.heading}</h2>
          {section.blocks.map((block, i) => (
            <Block key={i} block={block} />
          ))}
        </section>
      ))}
    </main>
  );
}

function Block({ block }: { block: PrivacyBlock }) {
  if (typeof block === "string") return <p>{block}</p>;
  return (
    <ul>
      {block.bullets.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

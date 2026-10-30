/**
 * The privacy policy, shared by the dashboard's /privacy page and the door app's privacy screen so
 * the two never drift. Each block is a paragraph or a bulleted list. When this changes, update
 * `updated` too, and check the store listings (Apple's privacy labels, Play's data safety form)
 * still match.
 */

export type PrivacyBlock = string | { bullets: string[] };

export interface PrivacySection {
  heading: string;
  blocks: PrivacyBlock[];
}

export const PRIVACY_CONTACT_EMAIL = "privacy@myschooltix.com";

export const PRIVACY_POLICY: { updated: string; intro: string[]; sections: PrivacySection[] } = {
  updated: "October 30, 2026",
  intro: [
    "TicketApp (myschooltix.com) sells tickets, collects waivers and checks people in at school events. This policy covers the website, the dashboard schools use, and the TicketApp Door app. It explains what we collect, why, who we share it with, and the choices you have.",
    "Schools and other organizations use TicketApp to run their own events. For information about students, the school decides what is collected and we handle it on the school's behalf. If you have a question about your child's information, you can ask the school or us.",
  ],
  sections: [
    {
      heading: "What we collect",
      blocks: [
        "When you buy tickets: your name, email address and, if you give it, your phone number. Card payments are handled by Stripe. We never see or store your full card number.",
        "About each attendee, depending on what the event asks for: their name, email, phone, date of birth, grade and student ID, an emergency contact, and medical notes.",
        "When a waiver is signed: the signer's name, their answers, the date and time, and the IP address and browser they signed from, kept as a record of the signature.",
        "About parents and guardians, when a school or buyer lists them: name, email and phone, so we can send waiver requests and event notices.",
        "From schools: staff names and email addresses, and, if the school imports one, a roster of student names, IDs and grades used to check who can buy student tickets.",
        "At the door: which ticket was scanned, when, by which staff member, and whether the person was let in.",
      ],
    },
    {
      heading: "The TicketApp Door app",
      blocks: [
        "The Door app is for school staff and volunteers. You can only sign in with an email address your school has already invited; the app can't create accounts.",
        {
          bullets: [
            "Your email address, to send you a sign-in code.",
            "The camera, only to read ticket codes. Camera images aren't saved or sent anywhere.",
            "Your sign-in is kept in the phone's secure storage. Scans made without a connection are kept on the phone until they can be sent.",
            "The app has no ads, no analytics and no tracking, and doesn't use your location or contacts.",
          ],
        },
      ],
    },
    {
      heading: "How we use it",
      blocks: [
        {
          bullets: [
            "To sell and deliver tickets, take payments and issue refunds.",
            "To collect waivers and check people in at the door.",
            "To email tickets, receipts, sign-in codes and waiver requests, and to text parents and guardians about waivers and check-ins when a phone number is given. Reply STOP to any text to stop them.",
            "To keep the service secure, prevent fraud and fix problems.",
          ],
        },
        "We don't sell personal information, use it for advertising, or share it with data brokers. We don't use advertising or analytics cookies. The dashboard uses one cookie to keep staff signed in.",
      ],
    },
    {
      heading: "Who we share it with",
      blocks: [
        "The school or organization running the event sees the orders, attendees, waivers and check-ins for its own events. Other schools don't.",
        "We use these service providers to run TicketApp. They may only use the information to provide their service to us:",
        {
          bullets: [
            "Stripe, for card payments and payouts to schools.",
            "Resend, to send email.",
            "Twilio, to send text messages.",
            "Render, which hosts our servers and database.",
            "Vercel, which hosts our website.",
          ],
        },
        "We may also share information if the law requires it, or to protect the safety of people at an event.",
      ],
    },
    {
      heading: "Children and students",
      blocks: [
        "TicketApp is used by parents, adults and schools, not by children on their own. Information about students comes from their school or from the parent or guardian who buys their ticket. Where a student's information is part of their school record, we handle it as a service provider to the school, which stays in charge of it under laws such as FERPA.",
        "A parent or guardian can ask to see, correct or delete their child's information by contacting the school or us.",
      ],
    },
    {
      heading: "How long we keep it",
      blocks: [
        "We keep order, ticket, waiver and check-in records while the school uses TicketApp, and as long as needed afterwards for the school's records, accounting and legal obligations. Signed waivers are kept as long as the school needs them as proof. Sign-in codes expire after 15 minutes.",
      ],
    },
    {
      heading: "Your choices",
      blocks: [
        `You can ask to see, correct or delete your information, or the information of a child in your care, by emailing ${PRIVACY_CONTACT_EMAIL}. We may need to confirm who you are, and we may need to check with the school, since some records (such as signed waivers and payments) have to be kept. Staff who want their account deleted can ask their school or email us.`,
        "Depending on where you live, you may have other rights under local law. We'll honor them, and we won't treat you differently for using them.",
      ],
    },
    {
      heading: "Security",
      blocks: [
        "Information is encrypted in transit. Sign-in codes and links are stored only in hashed form, and staff see only the events and data their role allows. No system is perfectly secure, but if we learn of a breach that affects you, we'll let you and the school know.",
      ],
    },
    {
      heading: "Changes and contact",
      blocks: [
        "If we change this policy, we'll update the date at the top, and tell schools about important changes before they take effect.",
        `Questions or requests: ${PRIVACY_CONTACT_EMAIL}.`,
      ],
    },
  ],
};

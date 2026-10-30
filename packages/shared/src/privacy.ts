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
        "When you buy tickets: your name, email address and, if you give it, your phone number, plus any note or promo code on the order. Card payments are handled on Stripe's checkout page. We never see or store your full card number. When staff sell tickets at the door, the buyer's email is optional.",
        "About each attendee, depending on what the event asks for: their name, email, phone, date of birth, grade and student ID, an emergency contact, and medical notes.",
        "When a waiver is signed: the signer's name, their answers, the date and time, and the IP address and browser they signed from, kept as a record of the signature.",
        "About parents and guardians, when a school or buyer lists them: name, email and phone, so we can send them a link to sign a waiver. We keep a record of each message we send (where it went and what it said).",
        "From schools: staff names and email addresses, and, if the school imports one, a roster of student names, IDs and grades used to check who can buy student tickets. Schools give their business and bank details for payouts directly to Stripe.",
        "At the door: which ticket was scanned, when, by which staff member, and whether the person was let in. We also record which staff member sold, comped or cancelled an order.",
        "Technical data: IP addresses, browser or device type, and request logs, used for security, to limit abuse of sign-in, and to fix problems.",
      ],
    },
    {
      heading: "The TicketApp Door app",
      blocks: [
        "The Door app is for school staff and volunteers. You can only sign in with an email address that already has a TicketApp account, which schools set up by inviting their staff on the dashboard; the app itself can't create accounts.",
        {
          bullets: [
            "Your email address, to send you a sign-in code.",
            "The camera, only to read ticket codes. Camera images aren't saved or sent anywhere.",
            "Your sign-in is kept in the phone's secure storage.",
            "So the door keeps working without a connection, the app keeps a list of the event's attendee names and check-in status on the phone. It's removed when you sign out. Scans made offline stay on the phone until they've been sent.",
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
            "To email tickets, receipts, sign-in codes and waiver requests, and to text a parent or guardian a link to sign a waiver when a phone number is given. Reply STOP to any text and our text provider will stop sending them.",
            "To keep the service secure, prevent fraud and fix problems.",
          ],
        },
        "We don't sell personal information, use it for advertising, or share it with data brokers.",
        "Cookies: we don't use advertising or analytics cookies. The dashboard sets one cookie, needed to keep staff signed in, which lasts up to 30 days. Buying tickets and signing waivers set no cookies of ours. Stripe's checkout page sets its own cookies under Stripe's privacy policy.",
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
        "Students may buy their own tickets and fill in and sign waivers themselves. When the attendee is a minor, an event can also require a parent or guardian to sign, and we send them a link to do so. Other information about students comes from their school (such as a roster) or from the parent or guardian who buys their ticket. Where a student's information is part of their school record, we handle it as a service provider to the school, which stays in charge of it under laws such as FERPA.",
        "Tickets for children under 13 should be bought by a parent, guardian or the school. If we learn we collected information directly from a child under 13 without that consent, we'll delete it.",
        "A parent or guardian can ask to see, correct or delete their child's information by contacting the school or us.",
      ],
    },
    {
      heading: "How long we keep it",
      blocks: [
        "Sign-in codes and links expire after 15 minutes, and staff stay signed in for up to 30 days.",
        "Order, ticket, waiver and check-in records are kept while the school uses TicketApp, so it has them for its records, accounting and legal obligations. We delete them when the school asks, or when you ask and the school no longer needs them (signed waivers and payment records may have to be kept as proof).",
      ],
    },
    {
      heading: "Your choices",
      blocks: [
        `You can ask to see, correct or delete your information, or the information of a child in your care, by emailing ${PRIVACY_CONTACT_EMAIL}. We may need to confirm who you are, and we may need to check with the school, since some records (such as signed waivers and payments) have to be kept. Staff who want their account deleted can ask their school or email us.`,
        "Depending on where you live, you may have other rights under local law. We'll honor them, and we won't treat you differently for using them. TicketApp is run from the United States and your information is stored there.",
      ],
    },
    {
      heading: "Security",
      blocks: [
        "Information is encrypted in transit. Sign-in codes and sign-in, order and waiver links are stored in hashed form; a message waiting to be sent is kept readable only until it goes out. Staff see only the events and data their role allows. No system is perfectly secure, but if we learn of a breach that affects you, we'll let you and the school know.",
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

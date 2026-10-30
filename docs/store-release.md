# Releasing the door app

The door app in `apps/mobile` is built, signed and uploaded by EAS (Expo Application Services),
so nobody needs Xcode or Android Studio. The order is: internal testing first (TestFlight and a
Play internal testing track), then a store release once it has worked at a real door.

Everything here runs from `apps/mobile`. Use `npx eas-cli@latest` wherever the Expo docs say
`eas`.

## What's already set up in the repo

- `eas.json` has two build profiles. `preview` makes an internal build for a quick look: on
  Android an APK that installs on any phone, on iOS an ad hoc build that installs only on iPhones
  registered first with `npx eas-cli@latest device:create`. TestFlight (below) has no such limit.
  `production` makes store builds, and its build numbers count up
  on their own (kept by EAS, so they never go backwards).
- `eas.json` sends Android uploads to the **internal testing** track, so `eas submit` never
  reaches the public by accident.
- `app.json` answers Apple's export compliance question (the app only uses HTTPS, so no
  non-exempt encryption) and strips Android permissions the app doesn't use (draw over other apps,
  read and write storage), which keeps the Play data safety form short.
- `.env.production` bakes the production API address (`https://api.myschooltix.com`) into store
  builds. A build always talks to the address it was built with, so if the API ever moves, change
  that file first and make a new build.
- The API has a review sign-in (below) so Apple's and Google's reviewers can get past the email
  code.

## One-time setup (Tim)

These need your accounts and cards, so they can't be done from the repo.

1. **Apple Developer Program** ($99 a year) at developer.apple.com, enrolled as an organization if
   you want the seller name to be the company rather than you. Organization enrollment needs a
   D-U-N-S number and can take a week or two, so start this first.
2. **Google Play Console** ($25 once) at play.google.com/console. New personal accounts must run a
   closed test with at least 12 testers for 14 days before they can publish to production;
   organization accounts don't. Another reason to register as an organization.
3. **Expo account** (free) at expo.dev. Then, in `apps/mobile`:

   ```bash
   npx eas-cli@latest login
   npx eas-cli@latest init
   ```

   `init` links the app to an Expo project and adds its ID to `app.json` as `extra.eas.projectId`.
   That's done: the ID is in the repo. Discard your local `app.json` change (`git checkout
app.json`) and pull instead.

4. **App Store Connect**: first register the bundle ID `com.tbsoftware.ticketapp` at
   developer.apple.com under **Certificates, Identifiers & Profiles > Identifiers > +** (App IDs,
   App), since creating the app means picking an ID that already exists. Then create the app under
   **Apps > +** with that bundle ID. The store name must be unique
   across the App Store, and "TicketApp" is likely taken, so pick something like "MySchoolTix
   Door". The name on the home screen stays "TicketApp" unless we change `app.json`.
5. **Play Console**: **Create app**, then fill in the **App content** section (privacy policy,
   app access, ads, content rating, target audience, data safety). Package name
   `com.tbsoftware.ticketapp`.

Signing is handled by EAS. On the first build it offers to create the iOS distribution
certificate and provisioning profile (sign in with your Apple ID when asked) and the Android
upload keystore. Say yes to each; EAS keeps them, so no keys live in the repo or on a laptop.

## Internal testing

```bash
npx eas-cli@latest build --platform all --profile production
npx eas-cli@latest submit --platform ios --latest
npx eas-cli@latest submit --platform android --latest
```

- **iOS**: `submit` uploads to App Store Connect. After Apple's processing (10 to 30 minutes), the
  build shows in **TestFlight**. **Internal Testing** is only for people added as users of your
  App Store Connect team (up to 100), so use it for yourself and anyone helping run the app; those
  builds need no Apple review. For door staff and volunteers, make an **External Testing** group
  and invite them by email or a public link. The first build sent to an external group goes
  through Beta App Review (usually a day), so the review sign-in below has to be set up by then.
- **Android**: the very first upload has to be done by hand in the Play Console (Google's rule).
  Download the `.aab` from the build page on expo.dev and upload it under **Testing > Internal
  testing > Create new release**. After that, `eas submit` works, using a Google service account
  key: follow the link `eas submit` prints to create one, and keep the JSON file out of the repo.
  Until the app's first production release, Google only accepts uploads as drafts, so `eas.json`
  submits with `releaseStatus: draft`: open the internal testing release in the Play Console and
  tap **Review release > Start rollout** after each submit. Once the app is live, Claude can
  switch that to `completed` so submits roll out on their own. Add testers by email list on the
  internal testing page and share the opt-in link.

Each new build gets the next build number automatically. Bump `version` in `app.json` (for
example to `1.0.1`) only when you want a new version number in the store.

## Review sign-in

Store reviewers need to sign in, but the door app emails a six-digit code, which they can't read.
Set these two on Render (**ticketapp-api > Environment**):

- `REVIEW_SIGN_IN_EMAIL`: an address you own that isn't easy to guess, for example
  `appreview-k7q2@myschooltix.com`. Anyone who knows it can lock it for 15 minutes with wrong
  codes, so share it only in the review notes.
- `REVIEW_SIGN_IN_CODE`: any six digits

That address's code is then always the one you set. Everything else about sign-in still applies:
the reviewer still taps **Email me a code**, the code works once per request, and five wrong
guesses lock the address for 15 minutes. The API refuses to start if only one of the two is set,
or the code isn't six digits.

Give the review address door access to a demo event only. Create a demo organization in the
dashboard with a **published** event dated in the future (drafts don't show in the door app) and a
few tickets (one with a missing waiver shows the override). Invite the review address as door
staff, then open the invitation email and **accept it**: until it's accepted the address isn't a
member and sees no events. Never add it to a real school. Before submitting, sign in on a test
build with the review email and code and check the demo event is listed.

In the review notes for both stores, give the email and code and say: "Tap Email me a code, then
enter the code below and tap Sign in. Pick the demo event, then use Look up by name to admit an
attendee, as the camera scans printed tickets." Attach a PDF of a demo ticket if you want them to
try the scanner.

Leave both set after approval. Google reviews apps again at any time and expects the sign-in in
**App access** to keep working, and Apple reviews every update. The address only reaches the demo
event, so a working review sign-in exposes nothing real. If you change the code, update the review
notes in both stores.

## Store listing

- **Privacy policy URL**: `https://app.myschooltix.com/privacy`. The door app shows the same policy
  from its sign-in and event screens. The text lives in `packages/shared/src/privacy.ts`; if it
  changes, check the answers below still match.
- **Data the app collects** (for Apple's privacy labels and Play's data safety form): the staff
  member's email address, for sign-in and app functionality, linked to them, not used for
  tracking, encrypted in transit. Scan records (who was admitted, when and by whom) are app
  functionality data. The app also downloads the event's attendee names and check-in status
  (other people's names, for app functionality, kept on the phone until sign-out). No analytics,
  ads or third-party tracking.
- **Account deletion**: the door app can't create accounts. Its sign-in only works for an email
  that already has a TicketApp account, which a school makes by inviting someone on the dashboard;
  any other address is emailed a note to ask their school for an invite. Apple's in-app deletion
  rule and Google's deletion page rule apply to apps that let people create accounts, so when the
  forms ask, answer that the app doesn't create accounts: they're made by the organization on the
  web. Reviewers sometimes ask anyway, so give a deletion contact address up front: in Play's data
  safety form (the account deletion URL can be a short page on the site that says to email it) and
  in Apple's review notes.
- **Screenshots**: iPhone 6.9-inch (1320 x 2868) is the only size Apple requires. The app also
  runs on iPad (`supportsTablet`), so Apple asks for 13-inch iPad screenshots too. Play needs at
  least two phone screenshots.
- **Category**: Business (or Utilities). **Content rating**: everyone; no user-generated content
  is shared publicly.

## Store release

Once internal testing has been through a real event:

- **iOS**: in App Store Connect, open the app's version page, pick the TestFlight build, fill in
  the review notes above and **Submit for Review**. Reviews usually take a day or two. Choose
  manual release if you want to pick the day it goes live.
- **Android**: in the Play Console, **promote** the internal testing release to **Production**
  (or to a closed test first, if the account needs the 12-tester run), then **Send for review**.

## Later builds

JavaScript-only changes still need a new build and submit with the setup above; over-the-air
updates (`eas update`) aren't set up. Any change to native modules, permissions or `app.json` always
needs a new build.

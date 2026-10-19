# Deploying

The API and its Postgres database run on Render, set up from `render.yaml`. The web dashboard
runs on Vercel. The mobile app ships through Expo later (E1.7).

## Email for sign-in links

In production the API refuses to start without a real email sender, so sign-in links never
land in logs. It sends through any SMTP provider configured with two variables:

- `SMTP_URL`: for example `smtps://user:password@smtp.example.com:465`
- `MAIL_FROM`: for example `TicketApp <tickets@example.com>`

Until our own domain is ready, we use Resend's shared test sender. Create an API key in Resend
and set `SMTP_URL` to `smtps://resend:<API key>@smtp.resend.com:465`. `MAIL_FROM` is already
`TicketApp <onboarding@resend.dev>`. The test sender only delivers to the email address that
owns the Resend account, so only that person can sign in until the domain is verified.

Moving to the real domain is a settings change: update `SMTP_URL` and `MAIL_FROM` on Render.

## API on Render

1. In Render, choose **New > Blueprint**, pick this repository and confirm. Render creates
   `ticketapp-db` and `ticketapp-api` from `render.yaml`.
2. When asked, fill in `SMTP_URL` (above). Leave `WEB_BASE_URL` and `WEB_ORIGIN` as a
   placeholder until the dashboard has a URL, then set both to it (for example
   `https://ticketapp.vercel.app`).
3. Every push to `main` redeploys. Migrations run when the service starts.
4. Check `https://<service>.onrender.com/health` returns `{"status":"ok"}`.

Free plans sleep when idle and the free database expires after 30 days; switch both to paid
plans before a real event.

## Dashboard on Vercel

1. In Vercel, choose **Add New > Project** and import this repository.
2. Set **Root Directory** to `apps/web`. Vercel detects Next.js, pnpm and the workspace.
3. Deploy. Every push to `main` deploys production; pull requests get preview URLs.

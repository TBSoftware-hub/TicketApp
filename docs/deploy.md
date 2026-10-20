# Deploying

The API and its Postgres database run on Render, set up from `render.yaml`. The web dashboard
runs on Vercel. The mobile app ships through Expo later (E1.7).

## Email for sign-in links

In production the API refuses to start without a real email sender, so sign-in links never
land in logs. Configure one of:

- `RESEND_API_KEY`: sends through Resend's HTTPS API. Works on Render's free plan.
- `SMTP_URL`: any SMTP provider, for example `smtps://user:password@smtp.example.com:465`.
  Render's free web services block outbound SMTP ports, so this needs a paid instance.

Both need `MAIL_FROM`, for example `TicketApp <tickets@example.com>`. If both are set, Resend wins.

We send from `mail.myschooltix.com`, which is verified in Resend: set `RESEND_API_KEY`, and
`MAIL_FROM` is already `TicketApp <no-reply@mail.myschooltix.com>`. Its DNS records live at GoDaddy
under the `mail` subdomain, so they don't touch the Microsoft 365 mailboxes on the main domain.

## Payments

Each organization connects its own Stripe Express account from **Payouts** in the dashboard, so
ticket money goes straight to them; TicketApp is the Connect platform and never holds it.

1. In the Stripe dashboard, open **Connect**, choose **Platform or marketplace** and enable
   **Express** accounts. Add the TicketApp name and colour under Connect branding.
2. Set `STRIPE_SECRET_KEY` on the API (an `sk_test_` key until launch, then the live key).

Without the key, the Payouts page says payments aren't switched on yet.

## API on Render

1. In Render, choose **New > Blueprint**, pick this repository and confirm. Render creates
   `ticketapp-db` and `ticketapp-api` from `render.yaml`.
2. When asked, fill in `RESEND_API_KEY` (above). Leave `WEB_BASE_URL` and `WEB_ORIGIN` as a
   placeholder until the dashboard has a URL, then set both to it (for example
   `https://ticketapp.vercel.app`).
3. Every push to `main` redeploys. Migrations run when the service starts.
4. Check `https://<service>.onrender.com/health` returns `{"status":"ok"}`.

`TRUSTED_PROXY_HOPS=1` makes the API take the client IP from the address Render's load
balancer appends to `X-Forwarded-For`, so forged entries can't dodge the per-IP rate limit.

Free plans sleep when idle and the free database expires after 30 days; switch both to paid
plans before a real event.

## Dashboard on Vercel

1. In Vercel, choose **Add New > Project** and import this repository.
2. Set **Root Directory** to `apps/web`. Vercel detects Next.js, pnpm and the workspace.
3. Deploy. Every push to `main` deploys production; pull requests get preview URLs.

The dashboard finds the API through `NEXT_PUBLIC_API_URL`, set in `apps/web/.env.production`.
If the API's address changes, update that file (or set the variable in Vercel, which wins).

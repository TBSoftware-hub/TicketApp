# TicketApp

Ticketing for school events where minors attend: online tickets with waivers and guardian
signatures built into checkout, QR check-in and check-out at the door, and a text to parents when
their student arrives and leaves.

See [docs/build-plan.md](docs/build-plan.md) for the architecture, epics and phases.

## Repository layout

| Path              | What it is                                                        |
| ----------------- | ----------------------------------------------------------------- |
| `apps/api`        | Backend API (Node.js, Fastify, TypeScript)                        |
| `apps/web`        | Web dashboard and public event/checkout pages (Next.js)           |
| `apps/mobile`     | iOS and Android app, door check-in first (React Native with Expo) |
| `packages/shared` | Types, validation schemas and helpers shared by all three apps    |

## Getting started

Requires Node.js 22 and pnpm 10 (`corepack enable` picks up the pinned version).

```bash
pnpm install
cp packages/db/.env.example packages/db/.env   # point DATABASE_URL at a local Postgres 16
cp apps/api/.env.example apps/api/.env         # same DATABASE_URL; the API and its tests use it
pnpm --filter @ticketapp/db migrate:deploy
pnpm --filter @ticketapp/db seed                # demo after-prom with one ticket
pnpm dev            # API on :4000, web on :3000, Expo dev server for mobile
```

In development the API writes sign-in emails to its log instead of sending them, so copy the
link from there.

Run one app with a filter, for example `pnpm --filter @ticketapp/api dev`. For the mobile app,
`pnpm --filter @ticketapp/mobile start` and scan the QR code with Expo Go.

## Checks

These run in CI on every pull request (the database tests need `DATABASE_URL` and migrations applied):

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Database changes

Edit `packages/db/prisma/schema.prisma`, then run `pnpm --filter @ticketapp/db migrate:dev --name <change>`
to create and apply a migration. Commit the generated folder under `prisma/migrations`.

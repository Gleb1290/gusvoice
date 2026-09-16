# Contributing to GusVoice

Thanks for wanting to help. Bug reports, fixes, translations and ideas are all welcome. Issues and pull requests can be
written in **English or Russian**.

## Before you start

- **Security problems** go to the private report described in [`SECURITY.md`](SECURITY.md), never to a public issue.
- **Bigger changes** (a new feature, a change to the API or the database) — open an issue first and describe what you
  want to do. It saves you work if the idea collides with something already planned.
- **Contributor License Agreement.** Before your first pull request is merged, the CLA bot asks you to accept
  [`CLA.md`](CLA.md) with a one-line comment. [`LICENSING.md`](LICENSING.md) explains why the project asks for it.

## How the project is built

Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) first — it maps the services, the repository and how requests flow.

You need Node.js 20+, pnpm via corepack, Docker with Compose v2 and, for the desktop app, Rust (`rust-toolchain.toml`
pins the version) with the [Tauri prerequisites](https://tauri.app/start/prerequisites/).

```bash
corepack enable
pnpm install
pnpm -r run typecheck
pnpm -r run test
node scripts/check-tests-listed.mjs
```

Run the stack locally with `docker compose up -d --build` and a `.env` you create for development (see `.env.example`;
the backend refuses the placeholder secrets, so generate real ones with `openssl rand -hex 32`). For quick UI work,
`pnpm --filter @gusvoice/client dev` serves the web client with hot reload.

## Rules that keep things working

- **Backward compatibility.** Desktop and Android apps update separately from servers, and servers will talk to each
  other. Changes to the REST API, the WebSocket protocol and anything another instance sees are **additions only**;
  unknown fields are ignored. Details: [`docs/federation-compat.md`](docs/federation-compat.md).
- **Pinned versions.** Dependencies and Docker images use exact versions, no `^` or `latest`. The LiveKit server image
  and the LiveKit client SDKs are upgraded together ([`docs/livekit.md`](docs/livekit.md) §3).
- **Tests next to the code.** A test for `fooRules.ts` lives in `fooRules.test.ts` and must be listed in the `test`
  script of its package — CI fails otherwise. Logic that is hard to test (it touches the database, Redis or the network)
  is usually split into a pure `*Rules.ts` module that the route calls.
- **Migrations** are new SQL files in `packages/backend/drizzle/` with the next number. Never edit a migration that has
  already been released — servers record them by file name and will not run it again.
- **No secrets, personal data or private addresses** in code, tests or comments. Use `example.com` and the
  documentation address ranges (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`).

## Pull requests

1. Fork, create a branch, make the change with tests for new logic.
2. Make sure typecheck, tests and `check-tests-listed` pass.
3. Describe **what the user sees** before and after, and how you checked it. Screenshots help for UI changes.

The public repository is a published copy of the maintainer's working repository. Accepted pull requests are applied
there with your authorship preserved and come back to GitHub with the next release — so your PR may be closed as
"applied" rather than merged with GitHub's button.

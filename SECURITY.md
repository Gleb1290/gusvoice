# Security policy

## Reporting a vulnerability

**Please do not report security problems in public issues, discussions or pull requests.**

Use GitHub's private reporting instead: open the repository's **Security** tab and choose **Report a vulnerability**.
Only the maintainer sees the report. Please include:

- what an attacker can do, and against whom (an anonymous visitor, a registered user, a server member, an admin);
- the steps or a request that reproduces it, and the GusVoice version (the server's `TAG` or the app version);
- whether it needs a particular setup (your own reverse proxy, storage outside the box, a feature flag).

The maintainer confirms the report in the same private thread and keeps you posted on the fix. Once a fix is released,
the report is published as a security advisory with credit to you, unless you prefer to stay anonymous.

## Supported versions

Fixes land in the latest release only. Self-hosted servers get them with `./update.sh`; the desktop and Android apps
update themselves.

## What helps operators stay safe

- Keep the setup code (`SETUP_TOKEN` in `.env`) private until the setup wizard has created the administrator.
- Never start a server with the placeholder secrets from `.env.example` — the backend refuses to, on purpose; use
  `install.sh`, which generates real ones.
- Put the backend behind a reverse proxy on the same machine or network (the bundled Caddy does this); per-IP limits
  trust `X-Forwarded-For` only from proxies on internal networks.

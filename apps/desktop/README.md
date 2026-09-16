# GusVoice Desktop (Tauri)

A thin Tauri v2 wrapper around the React web client. It bundles the same SPA and
talks to your self-hosted GusVoice server. All media still flows through the
LiveKit SFU — the desktop app is just a native shell around the web client.

## Prerequisites

- Rust toolchain (`rustup`), and the platform's Tauri system deps
  (see https://tauri.app/start/prerequisites/).
- Node 20+ and pnpm (via corepack), deps installed at the repo root (`pnpm install`).

## Generate icons (once)

The committed source is `src-tauri/app-icon.png`. Generate the platform icon set
(`.ico`, `.icns`, PNGs) from it:

```bash
pnpm --filter @gusvoice/desktop icons
```

## Develop

Runs the Vite dev server and opens the native window pointing at it:

```bash
pnpm --filter @gusvoice/desktop dev
```

## Build installers

Bakes the production server URLs into the bundle, builds the SPA, then packages a
native installer for the current OS:

```bash
# point the bundled SPA at your deployed server
export VITE_API_URL=https://api.voice.example.com
export VITE_PRESENCE_WS=wss://presence.voice.example.com

pnpm --filter @gusvoice/desktop icons      # if not done already
pnpm --filter @gusvoice/desktop build
```

Artifacts land in `src-tauri/target/release/bundle/`. Without `VITE_API_URL` the build is the generic
"picker" client: it asks for the server address on first launch, like the builds in the project's Releases.

## Notes

- The bundled SPA reads `VITE_API_URL` / `VITE_PRESENCE_WS` baked at build time
  (there is no runtime `config.js` injection in the desktop bundle).
- Screen capture / microphone use the system webview (WebView2 on Windows,
  WebKitGTK on Linux). On Linux you may need a recent WebKitGTK for `getDisplayMedia`.

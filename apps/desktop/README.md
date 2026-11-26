# driftnet Desktop (Tauri v2)

Lightweight menu bar / system tray wrapper for macOS, Windows and Linux.
It bundles the real `driftnet` server as a standalone Node 22 SEA sidecar so users don't need to install Node.js or open a terminal.

## Features

- Lives in the menu bar / system tray (no Dock icon on macOS).
- Starts `driftnet` locally and opens `http://127.0.0.1:8787` in your default browser.
- **Save link from clipboard** right from the tray menu.
- **Launch at login** toggle.

## Local build

Prerequisites: Node.js >= 22.13, `pnpm`, and the [Rust / Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
pnpm install
node scripts/build-desktop-sidecar.mjs
npx @tauri-apps/cli build --config apps/desktop/src-tauri/tauri.conf.json
```

## CI Releases

See [.github/workflows/desktop.yml](../../.github/workflows/desktop.yml): builds macOS (Apple Silicon & Intel), Windows (x64) and Linux (x64) installers automatically on `v*` tags or manual workflow dispatch.

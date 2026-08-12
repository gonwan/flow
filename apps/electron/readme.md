# Flow Electron

This folder contains a minimal Electron wrapper for the FlowOSS desktop app.

Commands

- pnpm --filter @flow/electron dev
  - Runs the reader dev server and launches Electron (ts-node-dev).
- pnpm --filter @flow/electron build
  - Builds the reader in standalone mode and packages the Electron app using electron-builder.

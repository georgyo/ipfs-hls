# Svelte Example App

## Plan
Build a Svelte-based example app for IPFS HLS playback at `packages/example-svelte`.

## Features Implemented
- Svelte 5 app with Vite, node polyfills for IPFS/Helia
- Input field to load arbitrary IPFS paths
- Client-side history persisted to localStorage with default presets (Charade, Big Buck Bunny)
- Click history item to load and play
- Quality selector (auto + per-level) when multiple HLS streams available
- Dark theme UI matching the project style

## Technical Notes
- `@sveltejs/vite-plugin-svelte@^6.2.4` is needed for vite 7 compatibility
- Svelte 5 runes API used (`$state`, `$effect`)
- Added to root workspace and tsconfig references
- Build and typecheck pass cleanly

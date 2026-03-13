# ipfs-hls

HLS video streaming over IPFS. A custom [HLS.js](https://github.com/video-dev/hls.js) loader that fetches media segments via [Helia](https://github.com/ipfs/helia) (IPFS in JavaScript), with a Svelte 5 demo player app.

## Features

- **IPFS-native HLS playback** — Stream adaptive bitrate video directly from IPFS content-addressed storage
- **Transparent fallback** — Non-IPFS URLs automatically fall back to the default XHR loader
- **DAG path caching** — Resolved directory paths are cached to avoid redundant DAG traversals
- **P2P block exchange** — Bitswap protocol for peer-to-peer block transfer
- **Concurrent gateway fetching** — `DirectGatewayBroker` races multiple trustless IPFS gateways via `Promise.any()`
- **Persistent block cache** — IndexedDB-backed blockstore survives page reloads
- **Quality selection** — Manual or automatic adaptive bitrate switching

## Quick Start

```bash
npm install hls-ipfs-loader
```

```ts
import Hls from 'hls.js'
import { createHelia } from 'helia'
import { createIpfsLoader } from 'hls-ipfs-loader'

const helia = await createHelia()
const IpfsLoader = createIpfsLoader({ helia })

const hls = new Hls({
  fLoader: IpfsLoader,
  pLoader: IpfsLoader,
})

hls.attachMedia(document.querySelector('video')!)
hls.loadSource('/ipfs/QmbdmJ2JRvEFhWWzHKrAcjjBdkcs46F2N7ggZnrdKKAu4s/manifest.m3u8')
```

## API Reference

### `createIpfsLoader(config: IpfsLoaderConfig)`

Factory that returns an HLS.js `Loader` class. The returned class intercepts URLs matching `/ipfs/<cid>[/path]` and fetches content via Helia UnixFS. All other URLs are delegated to the default XHR loader.

```ts
interface IpfsLoaderConfig {
  helia: Helia
}
```

Pass the returned class as both `fLoader` (fragment loader) and `pLoader` (playlist loader) when constructing an HLS.js instance.

### `parseIpfsPath(url: string): IpfsPath | null`

Parses a URL or path containing `/ipfs/<cid>[/path]` into its components. Returns `null` if the URL is not an IPFS path.

```ts
interface IpfsPath {
  cid: CID    // Parsed CID from multiformats
  path: string // Path within the DAG (e.g. "/manifest.m3u8"), empty string if none
}
```

## Example App

The `packages/example-svelte` workspace is a Svelte 5 demo player that demonstrates the full integration:

- Initializes a Helia node with WebRTC, WebSocket, and circuit relay transports
- Fetches blocks via both Bitswap (P2P) and trustless HTTP gateways concurrently
- Provides quality selection, bandwidth monitoring, and peer management UI
- Persists fetched blocks in IndexedDB across page reloads
- Supports URL hash routing with quality and time parameters (e.g. `#/ipfs/Qm...?q=720p&t=60`)

**Preset content:**
- *Charade* — `/ipfs/QmbdmJ2JRvEFhWWzHKrAcjjBdkcs46F2N7ggZnrdKKAu4s/manifest.m3u8`
- *Big Buck Bunny* — `/ipfs/QmfL9GReWbQbwgrQG4j3aFJaJb6UEyeDfuy8GRQcH5F5NS/manifest.m3u8`

To run it:

```bash
npm install
npm run dev -w packages/example-svelte
```

## How It Works

1. HLS.js requests a playlist or segment URL
2. The IPFS loader checks if the URL matches `/ipfs/<cid>[/path]`
3. If it matches:
   - The DAG path is resolved by walking directory entries via `UnixFS.ls()`, with intermediate resolutions cached in a shared `Map<string, CID>`
   - File content is streamed via `UnixFS.cat()` and assembled into a single buffer
   - The buffer is returned to HLS.js as either `ArrayBuffer` or decoded text, depending on the request type
4. If it doesn't match, the request is delegated to HLS.js's default XHR loader

The example app's `DirectGatewayBroker` provides an additional block retrieval strategy: it fires parallel `fetch()` requests to multiple trustless gateways and returns the first valid response, giving faster initial block availability compared to sequential gateway attempts.

## Browser Requirements

- Modern ES2022 support
- WebRTC (for P2P connectivity in the example app)
- IndexedDB (for persistent block caching)
- MediaSource Extensions (for HLS.js)

## Development

```bash
# Install all workspace dependencies
npm install

# Build all packages
npm run build

# Type-check all packages
npm run typecheck

# Clean build artifacts
npm run clean

# Library unit tests (vitest)
npm test -w packages/hls-ipfs-loader

# Library tests in watch mode
npm run test:watch -w packages/hls-ipfs-loader

# Lint library
npm run lint -w packages/hls-ipfs-loader

# Start example dev server
npm run dev -w packages/example-svelte

# Run E2E tests (Playwright)
npm test -w tests/e2e
```

## Project Structure

```
ipfs-hls/
├── packages/
│   ├── hls-ipfs-loader/     # Core library — HLS.js IPFS loader
│   │   └── src/index.ts     # createIpfsLoader, parseIpfsPath, types
│   └── example-svelte/      # Svelte 5 demo player app
│       └── src/
│           ├── App.svelte              # Main UI and Helia/HLS integration
│           └── direct-gateway-broker.ts # Concurrent trustless gateway fetcher
├── tests/
│   └── e2e/                 # Playwright E2E tests
├── package.json             # Workspace root (npm workspaces)
└── tsconfig.json            # Composite TypeScript project references
```

## License

MIT

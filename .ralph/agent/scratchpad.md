# Add public STUN server for IPFS to all examples

## Understanding
Both examples (`example-player` and `example-svelte`) use `createHelia()` with default config.
The `@libp2p/webrtc` library has internal default STUN servers but they're not explicitly configured.
The objective is to explicitly configure public STUN servers for better WebRTC connectivity.

## Approach
1. Use `libp2pDefaults()` from helia to get the default libp2p config
2. Replace the transports array with one that includes explicit STUN server configuration
3. Pass the modified config to `createHelia({ libp2p })`

## STUN servers used
- Google: `stun:stun.l.google.com:19302`, `stun:stun1.l.google.com:19302`
- Twilio: `stun:global.stun.twilio.com:3478`
- Cloudflare: `stun:stun.cloudflare.com:3478`

## Implementation
- Updated `packages/example-player/src/main.ts` - added explicit STUN config
- Updated `packages/example-svelte/src/App.svelte` - added explicit STUN config
- Both typecheck and build pass successfully
- Unit tests pass (12/12)

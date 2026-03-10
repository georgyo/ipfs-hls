<script lang="ts">
  import Hls from 'hls.js'
  import type { FragmentLoaderConstructor, PlaylistLoaderConstructor, Level } from 'hls.js'
  import { createHelia, libp2pDefaults } from 'helia'
  import { webRTC, webRTCDirect } from '@libp2p/webrtc'
  import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
  import { webSockets } from '@libp2p/websockets'
  import { createIpfsLoader } from 'hls-ipfs-loader'

  const ICE_SERVERS: RTCIceServer[] = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: ['stun:global.stun.twilio.com:3478'] },
    { urls: ['stun:stun.cloudflare.com:3478'] },
  ]

  interface PeerInfo {
    id: string
    address: string
    direction: string
    relay: boolean
  }

  interface HistoryEntry {
    label: string
    path: string
  }

  interface BlockedPeer {
    blockedAt: number
  }

  const STORAGE_KEY = 'ipfs-hls-history'
  const BLOCKLIST_KEY = 'ipfs-hls-peer-blocklist'
  const BLOCK_DURATION_MS = 10 * 60 * 1000

  function loadBlocklist(): Record<string, BlockedPeer> {
    try {
      const stored = sessionStorage.getItem(BLOCKLIST_KEY)
      if (!stored) return {}
      const list = JSON.parse(stored) as Record<string, BlockedPeer>
      const now = Date.now()
      for (const id in list) {
        if (now - list[id].blockedAt >= BLOCK_DURATION_MS) delete list[id]
      }
      return list
    } catch { return {} }
  }

  function saveBlocklist(list: Record<string, BlockedPeer>): void {
    sessionStorage.setItem(BLOCKLIST_KEY, JSON.stringify(list))
  }

  function blockPeer(peerId: string): void {
    const list = loadBlocklist()
    list[peerId] = { blockedAt: Date.now() }
    saveBlocklist(list)
    blockedCount = Object.keys(list).length
  }

  function isPeerBlocked(peerId: string): boolean {
    const list = loadBlocklist()
    const entry = list[peerId]
    if (!entry) return false
    if (Date.now() - entry.blockedAt >= BLOCK_DURATION_MS) {
      delete list[peerId]
      saveBlocklist(list)
      return false
    }
    return true
  }
  const DEFAULT_PRESETS: HistoryEntry[] = [
    { label: 'Charade', path: '/ipfs/QmbdmJ2JRvEFhWWzHKrAcjjBdkcs46F2N7ggZnrdKKAu4s/manifest.m3u8' },
    { label: 'Big Buck Bunny', path: '/ipfs/QmfL9GReWbQbwgrQG4j3aFJaJb6UEyeDfuy8GRQcH5F5NS/manifest.m3u8' },
  ]

  let status = $state('Initializing...')
  let statusClass = $state<'loading' | 'ready' | 'error'>('loading')
  let ipfsPath = $state('')
  let history = $state<HistoryEntry[]>(loadHistory())
  let levels = $state<Level[]>([])
  let currentLevel = $state(-1)
  let videoEl: HTMLVideoElement
  let hls: Hls | null = null
  let heliaNode = $state<Awaited<ReturnType<typeof createHelia>> | null>(null)
  let peers = $state<PeerInfo[]>([])
  let showPeers = $state(false)
  let blockedCount = $state(Object.keys(loadBlocklist()).length)

  function loadHistory(): HistoryEntry[] {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) {
        const parsed = JSON.parse(stored) as HistoryEntry[]
        if (parsed.length > 0) return parsed
      }
    } catch { /* ignore */ }
    return [...DEFAULT_PRESETS]
  }

  function saveHistory() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history))
  }

  function addToHistory(path: string) {
    const existing = history.findIndex(h => h.path === path)
    if (existing !== -1) return
    const label = path.split('/').filter(Boolean).pop() ?? path
    history = [{ label, path }, ...history]
    saveHistory()
  }

  function refreshPeers() {
    if (!heliaNode) return
    const conns = heliaNode.libp2p.getConnections()
    peers = conns.map(conn => {
      const peerId = conn.remotePeer.toString()
      const addr = conn.remoteAddr.toString()
      return {
        id: peerId.slice(0, 8) + '...' + peerId.slice(-4),
        address: addr,
        direction: conn.direction,
        relay: addr.includes('/p2p-circuit/'),
      }
    })
  }

  function setStatus(message: string, cls: 'loading' | 'ready' | 'error') {
    status = message
    statusClass = cls
  }

  function loadSource(path: string) {
    if (!hls) return
    addToHistory(path)
    ipfsPath = path
    levels = []
    currentLevel = -1
    setStatus('Loading manifest from IPFS...', 'loading')
    hls.loadSource(path)
  }

  function handleSubmit(e: Event) {
    e.preventDefault()
    if (ipfsPath.trim()) loadSource(ipfsPath.trim())
  }

  function selectHistoryItem(entry: HistoryEntry) {
    loadSource(entry.path)
  }

  function removeHistoryItem(index: number) {
    history = history.filter((_, i) => i !== index)
    saveHistory()
  }

  function setQuality(levelIndex: number) {
    if (!hls) return
    hls.currentLevel = levelIndex
    currentLevel = levelIndex
  }

  function qualityLabel(level: Level): string {
    if (level.height) return `${level.height}p`
    if (level.bitrate) return `${Math.round(level.bitrate / 1000)}kbps`
    return `Level ${levels.indexOf(level)}`
  }

  async function init() {
    if (!Hls.isSupported()) {
      setStatus('HLS.js is not supported in this browser', 'error')
      return
    }

    try {
      setStatus('Creating Helia IPFS node...', 'loading')
      const rtcConfig: RTCConfiguration = { iceServers: ICE_SERVERS }
      const libp2p = libp2pDefaults()
      libp2p.transports = [
        circuitRelayTransport({ discoverRelays: 1 }),
        webRTC({ rtcConfiguration: rtcConfig }),
        webRTCDirect({ rtcConfiguration: rtcConfig }),
        webSockets(),
      ]
      libp2p.connectionManager = {
        minConnections: 5,
        maxConnections: 100,
      }
      libp2p.connectionGater = {
        denyDialPeer: (peerId: { toString(): string }) => isPeerBlocked(peerId.toString()),
      }
      heliaNode = await createHelia({ libp2p })

      setStatus('Helia node ready. Initializing HLS player...', 'loading')
      const IpfsLoader = createIpfsLoader({ helia: heliaNode })

      hls = new Hls({
        fLoader: IpfsLoader as unknown as FragmentLoaderConstructor,
        pLoader: IpfsLoader as unknown as PlaylistLoaderConstructor,
      })

      hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
        levels = hls!.levels
        currentLevel = hls!.currentLevel
        setStatus('Manifest loaded. Playing video...', 'ready')
        videoEl.play().catch(() => {
          setStatus('Ready to play (click play button)', 'ready')
        })
      })

      hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
        currentLevel = data.level
      })

      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          setStatus(`Fatal error: ${data.details}`, 'error')
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            hls!.startLoad()
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            hls!.recoverMediaError()
          }
        }
      })

      hls.attachMedia(videoEl)
      setStatus('Ready. Enter an IPFS path or select from history.', 'ready')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      setStatus(`Failed to initialize: ${message}`, 'error')
    }
  }

  $effect(() => {
    init()
    return () => {
      hls?.destroy()
    }
  })

  $effect(() => {
    if (!heliaNode) return
    const openHandler = () => refreshPeers()
    const closeHandler = (evt: CustomEvent<any>) => {
      const conn = evt.detail
      if (conn?.timeline && !conn.timeline.upgraded) {
        blockPeer(conn.remotePeer.toString())
      }
      refreshPeers()
    }
    heliaNode.libp2p.addEventListener('connection:open', openHandler)
    heliaNode.libp2p.addEventListener('connection:close', closeHandler)
    refreshPeers()
    return () => {
      heliaNode!.libp2p.removeEventListener('connection:open', openHandler)
      heliaNode!.libp2p.removeEventListener('connection:close', closeHandler)
    }
  })
</script>

<main>
  <h1>IPFS HLS Player</h1>

  <div class="status {statusClass}">{status}</div>

  <form onsubmit={handleSubmit}>
    <input
      type="text"
      bind:value={ipfsPath}
      placeholder="/ipfs/Qm.../manifest.m3u8"
    />
    <button type="submit" disabled={statusClass === 'loading' && !heliaNode}>Load</button>
  </form>

  <video bind:this={videoEl} controls></video>

  {#if levels.length > 1}
    <div class="quality-selector">
      <label>Quality:</label>
      <select onchange={(e) => setQuality(Number((e.target as HTMLSelectElement).value))} value={currentLevel}>
        <option value={-1}>Auto</option>
        {#each levels as level, i}
          <option value={i}>{qualityLabel(level)}</option>
        {/each}
      </select>
    </div>
  {/if}

  <div class="peers-section">
    <button class="peers-header" onclick={() => showPeers = !showPeers}>
      <h2>Peers ({peers.length}){#if blockedCount > 0} | Blocked ({blockedCount}){/if}</h2>
      <span class="toggle">{showPeers ? '▾' : '▸'}</span>
    </button>
    {#if showPeers}
      {#if peers.length === 0}
        <p class="empty">No connected peers.</p>
      {:else}
        <ul class="peer-list">
          {#each peers as peer}
            <li class="peer-item">
              <span class="peer-id">{peer.id}</span>
              <span class="peer-transport">{peer.address.includes('/webrtc') ? 'WebRTC' : peer.address.includes('/ws') ? 'WebSocket' : 'Other'}</span>
              <span class="peer-badge {peer.direction}">{peer.direction}</span>
              {#if peer.relay}<span class="peer-badge relay">relay</span>{/if}
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </div>

  <div class="history">
    <h2>History</h2>
    {#if history.length === 0}
      <p class="empty">No items in history.</p>
    {:else}
      <ul>
        {#each history as entry, i}
          <li>
            <button class="history-item" onclick={() => selectHistoryItem(entry)}>
              <span class="label">{entry.label}</span>
              <span class="path">{entry.path}</span>
            </button>
            <button class="remove" onclick={() => removeHistoryItem(i)} title="Remove">&times;</button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</main>

<style>
  :global(body) {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #1a1a2e;
    color: #e0e0e0;
  }

  main {
    max-width: 900px;
    margin: 0 auto;
    padding: 2rem 1rem;
  }

  h1 {
    text-align: center;
    color: #fff;
    margin-bottom: 1rem;
  }

  .status {
    text-align: center;
    padding: 0.5rem 1rem;
    border-radius: 6px;
    margin-bottom: 1rem;
    font-size: 0.9rem;
  }

  .status.loading {
    background: #2d3748;
    color: #63b3ed;
  }

  .status.ready {
    background: #1c3a2a;
    color: #68d391;
  }

  .status.error {
    background: #3a1c1c;
    color: #fc8181;
  }

  form {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }

  input[type='text'] {
    flex: 1;
    padding: 0.6rem 0.8rem;
    border: 1px solid #4a5568;
    border-radius: 6px;
    background: #2d3748;
    color: #e0e0e0;
    font-size: 0.95rem;
  }

  input[type='text']::placeholder {
    color: #718096;
  }

  button[type='submit'] {
    padding: 0.6rem 1.2rem;
    border: none;
    border-radius: 6px;
    background: #4299e1;
    color: white;
    font-size: 0.95rem;
    cursor: pointer;
  }

  button[type='submit']:hover {
    background: #3182ce;
  }

  button[type='submit']:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  video {
    width: 100%;
    border-radius: 8px;
    background: #000;
    margin-bottom: 1rem;
  }

  .quality-selector {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }

  .quality-selector label {
    font-size: 0.9rem;
    color: #a0aec0;
  }

  .quality-selector select {
    padding: 0.4rem 0.6rem;
    border: 1px solid #4a5568;
    border-radius: 6px;
    background: #2d3748;
    color: #e0e0e0;
    font-size: 0.9rem;
  }

  .history h2 {
    font-size: 1.1rem;
    color: #a0aec0;
    margin-bottom: 0.5rem;
  }

  .history ul {
    list-style: none;
    padding: 0;
    margin: 0;
  }

  .history li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.4rem;
  }

  .history-item {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    padding: 0.5rem 0.8rem;
    border: 1px solid #4a5568;
    border-radius: 6px;
    background: #2d3748;
    color: #e0e0e0;
    cursor: pointer;
    text-align: left;
  }

  .history-item:hover {
    background: #3d4f6a;
    border-color: #4299e1;
  }

  .history-item .label {
    font-weight: 600;
    font-size: 0.95rem;
  }

  .history-item .path {
    font-size: 0.75rem;
    color: #718096;
    word-break: break-all;
  }

  .remove {
    background: none;
    border: none;
    color: #718096;
    font-size: 1.2rem;
    cursor: pointer;
    padding: 0.2rem 0.5rem;
    border-radius: 4px;
  }

  .remove:hover {
    color: #fc8181;
    background: #3a1c1c;
  }

  .empty {
    color: #718096;
    font-style: italic;
  }

  .peers-section {
    margin-bottom: 1rem;
  }

  .peers-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    color: inherit;
  }

  .peers-header h2 {
    font-size: 1.1rem;
    color: #a0aec0;
    margin: 0 0 0.5rem 0;
  }

  .peers-header .toggle {
    color: #718096;
    font-size: 1rem;
    margin-bottom: 0.5rem;
  }

  .peer-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .peer-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.8rem;
    border: 1px solid #4a5568;
    border-radius: 6px;
    background: #2d3748;
    font-size: 0.85rem;
  }

  .peer-id {
    font-family: monospace;
    color: #e0e0e0;
  }

  .peer-transport {
    color: #a0aec0;
    font-size: 0.75rem;
  }

  .peer-badge {
    font-size: 0.7rem;
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    font-weight: 600;
    text-transform: uppercase;
  }

  .peer-badge.inbound {
    background: #2d3a4a;
    color: #63b3ed;
  }

  .peer-badge.outbound {
    background: #1c3a2a;
    color: #68d391;
  }

  .peer-badge.relay {
    background: #3a3a1c;
    color: #ecc94b;
  }
</style>

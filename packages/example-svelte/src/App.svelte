<script lang="ts">
  import Hls from 'hls.js'
  import type { FragmentLoaderConstructor, PlaylistLoaderConstructor, Level } from 'hls.js'
  import { createHelia, libp2pDefaults } from 'helia'
  import { IDBBlockstore } from 'blockstore-idb'
  import { webRTC, webRTCDirect } from '@libp2p/webrtc'
  import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
  import { webSockets } from '@libp2p/websockets'
  import { simpleMetrics } from '@libp2p/simple-metrics'
  import { multiaddr } from '@multiformats/multiaddr'
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

  const STORAGE_KEY = 'ipfs-hls-history'

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
  let cacheSize = $state('')
  let dialAddr = $state('')
  let dialStatus = $state('')
  let showAddrs = $state(false)
  let multiaddrs = $state<string[]>([])
  let downloadRate = $state('0 B/s')
  let uploadRate = $state('0 B/s')
  let prevSent = 0
  let prevRecv = 0
  let prevTime = Date.now()

  function formatRate(bytesPerSec: number): string {
    if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)} B/s`
    if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`
    return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`
  }

  function onMetrics(metrics: Record<string, any>) {
    const now = Date.now()
    const elapsed = (now - prevTime) / 1000
    if (elapsed <= 0) return

    const sent = Number(metrics['global sent'] ?? 0)
    const recv = Number(metrics['global received'] ?? 0)

    if (prevTime > 0) {
      downloadRate = formatRate((recv - prevRecv) / elapsed)
      uploadRate = formatRate((sent - prevSent) / elapsed)
    }

    prevSent = sent
    prevRecv = recv
    prevTime = now
  }

  function refreshMultiaddrs() {
    if (!heliaNode) return
    multiaddrs = heliaNode.libp2p.getMultiaddrs().map(ma => ma.toString())
  }

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
        id: peerId,
        address: addr,
        direction: conn.direction,
        relay: addr.includes('/p2p-circuit/'),
      }
    })
    if (showAddrs) refreshMultiaddrs()
  }

  async function dialPeer(addr: string) {
    if (!heliaNode || !addr.trim()) return
    dialStatus = 'Connecting...'
    try {
      const ma = multiaddr(addr.trim())
      await heliaNode.libp2p.dial(ma)
      dialStatus = 'Connected!'
      dialAddr = ''
      refreshPeers()
      setTimeout(() => { dialStatus = '' }, 3000)
    } catch (err) {
      dialStatus = err instanceof Error ? err.message : 'Failed to connect'
      setTimeout(() => { dialStatus = '' }, 5000)
    }
  }

  function setStatus(message: string, cls: 'loading' | 'ready' | 'error') {
    status = message
    statusClass = cls
  }

  function parseHash(hash: string): { path: string; quality?: string; time?: number } {
    const raw = hash.startsWith('#') ? hash.slice(1) : hash
    const qIndex = raw.indexOf('?')
    if (qIndex === -1) return { path: raw }
    const path = raw.slice(0, qIndex)
    const params = new URLSearchParams(raw.slice(qIndex + 1))
    const quality = params.get('q') ?? undefined
    const time = params.has('t') ? Number(params.get('t')) : undefined
    return { path, quality, time: time && !isNaN(time) ? time : undefined }
  }

  function updateHash() {
    if (!ipfsPath) return
    const params = new URLSearchParams()
    if (currentLevel >= 0 && levels[currentLevel]) {
      params.set('q', qualityLabel(levels[currentLevel]))
    }
    if (videoEl && videoEl.currentTime > 0) {
      params.set('t', String(Math.floor(videoEl.currentTime)))
    }
    const qs = params.toString()
    location.hash = qs ? `${ipfsPath}?${qs}` : ipfsPath
  }

  let pendingQuality: string | undefined = undefined
  let pendingTime: number | undefined = undefined

  function loadSource(path: string) {
    if (!hls) return
    addToHistory(path)
    ipfsPath = path
    location.hash = path
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

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  }

  async function updateCacheSize() {
    try {
      const estimate = await navigator.storage.estimate()
      cacheSize = formatBytes(estimate.usage ?? 0)
    } catch {
      cacheSize = ''
    }
  }

  async function clearBlockstoreCache() {
    const databases = await indexedDB.databases()
    for (const db of databases) {
      if (db.name?.startsWith('ipfs-hls-blocks')) {
        indexedDB.deleteDatabase(db.name)
      }
    }
    setStatus('Cache cleared. Reloading...', 'loading')
    location.reload()
  }

  function setQuality(levelIndex: number) {
    if (!hls) return
    hls.currentLevel = levelIndex
    currentLevel = levelIndex
    updateHash()
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
      libp2p.metrics = simpleMetrics({
        onMetrics,
        intervalMs: 1000,
      })
      const blockstore = new IDBBlockstore('ipfs-hls-blocks')
      await blockstore.open()
      heliaNode = await createHelia({ libp2p, blockstore })

      setStatus('Helia node ready. Initializing HLS player...', 'loading')
      const IpfsLoader = createIpfsLoader({ helia: heliaNode })

      hls = new Hls({
        fLoader: IpfsLoader as unknown as FragmentLoaderConstructor,
        pLoader: IpfsLoader as unknown as PlaylistLoaderConstructor,
      })

      hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
        levels = hls!.levels
        currentLevel = hls!.currentLevel

        if (pendingQuality) {
          const idx = levels.findIndex(l => qualityLabel(l) === pendingQuality)
          if (idx >= 0) setQuality(idx)
          pendingQuality = undefined
        }

        if (pendingTime !== undefined) {
          videoEl.currentTime = pendingTime
          pendingTime = undefined
        }

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

      const initial = parseHash(location.hash)
      if (initial.path) {
        pendingQuality = initial.quality
        pendingTime = initial.time
        loadSource(initial.path)
      } else {
        setStatus('Ready. Enter an IPFS path or select from history.', 'ready')
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      setStatus(`Failed to initialize: ${message}`, 'error')
    }
  }

  function onHashChange() {
    const parsed = parseHash(location.hash)
    if (parsed.path && parsed.path !== ipfsPath) {
      pendingQuality = parsed.quality
      pendingTime = parsed.time
      loadSource(parsed.path)
    }
  }

  $effect(() => {
    init()
    updateCacheSize()
    const interval = setInterval(updateCacheSize, 10000)
    window.addEventListener('hashchange', onHashChange)
    const onVideoState = () => updateHash()
    videoEl?.addEventListener('pause', onVideoState)
    videoEl?.addEventListener('seeked', onVideoState)
    return () => {
      clearInterval(interval)
      window.removeEventListener('hashchange', onHashChange)
      videoEl?.removeEventListener('pause', onVideoState)
      videoEl?.removeEventListener('seeked', onVideoState)
      hls?.destroy()
    }
  })

  $effect(() => {
    if (!heliaNode) return
    const openHandler = () => refreshPeers()
    const closeHandler = () => refreshPeers()
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
    {#if heliaNode}
      <div class="bandwidth">
        <span class="bw-down">↓ {downloadRate}</span>
        <span class="bw-up">↑ {uploadRate}</span>
      </div>
      <button class="our-peer-id" onclick={() => { showAddrs = !showAddrs; if (showAddrs) refreshMultiaddrs() }}>
        <span>Peer ID: <span class="peer-id">{heliaNode.libp2p.peerId.toString()}</span></span>
        <span class="toggle">{showAddrs ? '▾' : '▸'}</span>
      </button>
      {#if showAddrs}
        {#if multiaddrs.length === 0}
          <p class="empty">No listening addresses.</p>
        {:else}
          <ul class="multiaddr-list">
            {#each multiaddrs as addr}
              <li class="multiaddr-item">{addr}</li>
            {/each}
          </ul>
        {/if}
      {/if}
    {/if}
    <button class="peers-header" onclick={() => showPeers = !showPeers}>
      <h2>Peers ({peers.length})</h2>
      <span class="toggle">{showPeers ? '▾' : '▸'}</span>
    </button>
    {#if showPeers}
      <form class="dial-form" onsubmit={(e) => { e.preventDefault(); dialPeer(dialAddr) }}>
        <input
          type="text"
          bind:value={dialAddr}
          placeholder="/ip4/.../tcp/.../p2p/PeerId"
        />
        <button type="submit" disabled={!dialAddr.trim()}>Dial</button>
      </form>
      {#if dialStatus}<p class="dial-status">{dialStatus}</p>{/if}
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

  <div class="cache-controls">
    <button class="clear-cache" onclick={clearBlockstoreCache}>Clear Block Cache</button>
    {#if cacheSize}<span class="cache-size">{cacheSize} used</span>{/if}
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

  .bandwidth {
    display: flex;
    justify-content: center;
    gap: 1.5rem;
    margin-bottom: 1rem;
    font-size: 0.85rem;
    font-family: monospace;
  }

  .bw-down {
    color: #68d391;
  }

  .bw-up {
    color: #63b3ed;
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

  .our-peer-id {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    width: 100%;
    font-size: 0.8rem;
    color: #718096;
    word-break: break-all;
    margin: 0 0 0.5rem 0;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    text-align: left;
  }

  .our-peer-id .toggle {
    flex-shrink: 0;
    margin-left: 0.5rem;
  }

  .multiaddr-list {
    list-style: none;
    padding: 0;
    margin: 0 0 0.5rem 0;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .multiaddr-item {
    font-size: 0.75rem;
    font-family: monospace;
    color: #a0aec0;
    word-break: break-all;
    padding: 0.3rem 0.6rem;
    background: #2d3748;
    border: 1px solid #4a5568;
    border-radius: 4px;
  }

  .dial-form {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }

  .dial-form input {
    flex: 1;
    padding: 0.4rem 0.6rem;
    border: 1px solid #4a5568;
    border-radius: 6px;
    background: #2d3748;
    color: #e0e0e0;
    font-size: 0.85rem;
  }

  .dial-form input::placeholder {
    color: #718096;
  }

  .dial-form button {
    padding: 0.4rem 0.8rem;
    border: none;
    border-radius: 6px;
    background: #4299e1;
    color: white;
    font-size: 0.85rem;
    cursor: pointer;
  }

  .dial-form button:hover {
    background: #3182ce;
  }

  .dial-form button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .dial-status {
    font-size: 0.8rem;
    color: #a0aec0;
    margin: 0 0 0.5rem 0;
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

  .cache-controls {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    margin: 1rem auto 0;
  }

  .cache-size {
    font-size: 0.85rem;
    color: #718096;
  }

  .clear-cache {
    padding: 0.5rem 1rem;
    border: 1px solid #4a5568;
    border-radius: 6px;
    background: #2d3748;
    color: #a0aec0;
    font-size: 0.85rem;
    cursor: pointer;
  }

  .clear-cache:hover {
    background: #3a1c1c;
    border-color: #fc8181;
    color: #fc8181;
  }
</style>

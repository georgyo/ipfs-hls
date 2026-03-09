<script lang="ts">
  import Hls from 'hls.js'
  import type { FragmentLoaderConstructor, PlaylistLoaderConstructor, Level } from 'hls.js'
  import { createHelia } from 'helia'
  import { createIpfsLoader } from 'hls-ipfs-loader'

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
      heliaNode = await createHelia()

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
</style>

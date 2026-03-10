/**
 * hls-ipfs-loader - Custom HLS.js loader that fetches segments via Helia IPFS
 */
import { CID } from 'multiformats/cid'
import { unixfs as createUnixFs } from '@helia/unixfs'
import type { Helia } from '@helia/interface'
import type { UnixFS } from '@helia/unixfs'
import type Hls from 'hls.js'
import type {
  Loader,
  LoaderContext,
  LoaderConfiguration,
  LoaderCallbacks,
  LoaderStats,
} from 'hls.js'

/** Parsed IPFS path: a CID and optional file path within the DAG */
export interface IpfsPath {
  cid: CID
  path: string
}

/** Config passed to the loader factory */
export interface IpfsLoaderConfig {
  helia: Helia
}

/**
 * Parse a URL/path that starts with `/ipfs/<cid>[/path]`.
 * Returns null if the URL is not an IPFS path.
 */
export function parseIpfsPath(url: string): IpfsPath | null {
  const match = url.match(/\/ipfs\/([^/?#]+)(\/[^?#]*)?/)
  if (!match) return null

  try {
    const cid = CID.parse(match[1])
    const path = match[2] ?? ''
    return { cid, path }
  } catch {
    return null
  }
}

function makeStats(): LoaderStats {
  return {
    aborted: false,
    loaded: 0,
    retry: 0,
    total: 0,
    chunkCount: 0,
    bwEstimate: 0,
    loading: { start: 0, first: 0, end: 0 },
    parsing: { start: 0, end: 0 },
    buffering: { start: 0, first: 0, end: 0 },
  }
}

/**
 * Resolve an IPFS path with nested directories by walking the DAG using `ls`.
 * Uses a cache to skip already-resolved path prefixes.
 */
async function resolveIpfsPath(
  fs: UnixFS,
  rootCid: CID,
  path: string,
  pathCache: Map<string, CID>,
): Promise<CID> {
  if (!path || path === '/') return rootCid

  const cacheKey = `${rootCid.toString()}${path}`

  // Fast exit: full path already resolved
  const cached = pathCache.get(cacheKey)
  if (cached) return cached

  const segments = path.split('/').filter(Boolean)

  // Find the deepest cached prefix to skip already-resolved segments
  let startIndex = 0
  let currentCid = rootCid
  for (let i = segments.length - 1; i >= 0; i--) {
    const prefixKey = `${rootCid.toString()}/${segments.slice(0, i + 1).join('/')}`
    const prefixCid = pathCache.get(prefixKey)
    if (prefixCid) {
      currentCid = prefixCid
      startIndex = i + 1
      break
    }
  }

  // Walk only the remaining uncached segments
  for (let i = startIndex; i < segments.length; i++) {
    const segment = segments[i]
    let found = false
    for await (const entry of fs.ls(currentCid)) {
      if (entry.name === segment) {
        currentCid = entry.cid
        found = true
        // Cache each intermediate resolution
        const intermediateKey = `${rootCid.toString()}/${segments.slice(0, i + 1).join('/')}`
        pathCache.set(intermediateKey, currentCid)
        break
      }
    }
    if (!found) {
      throw new Error(`IPFS path segment not found: ${segment}`)
    }
  }

  // Cache the full path
  pathCache.set(cacheKey, currentCid)
  return currentCid
}

/**
 * Fetch content from IPFS via Helia UnixFS, returning the data as a single buffer.
 */
async function fetchFromIpfs(
  fs: UnixFS,
  ipfsPath: IpfsPath,
  pathCache: Map<string, CID>,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const resolvedCid = await resolveIpfsPath(fs, ipfsPath.cid, ipfsPath.path, pathCache)
  const chunks: Uint8Array[] = []
  let totalLength = 0

  for await (const chunk of fs.cat(resolvedCid, { signal })) {
    chunks.push(chunk)
    totalLength += chunk.byteLength
  }

  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }

  return result
}

/**
 * Creates a custom HLS.js Loader class that uses Helia to fetch IPFS content.
 * Non-IPFS URLs fall back to the default XHR loader.
 *
 * @example
 * ```ts
 * import Hls from 'hls.js'
 * import { createHelia } from 'helia'
 * import { createIpfsLoader } from 'hls-ipfs-loader'
 *
 * const helia = await createHelia()
 * const IpfsLoader = createIpfsLoader({ helia })
 *
 * const hls = new Hls({
 *   fLoader: IpfsLoader,
 *   pLoader: IpfsLoader,
 * })
 * ```
 */
export function createIpfsLoader(
  config: IpfsLoaderConfig,
): new (hlsConfig: Hls['config']) => Loader<LoaderContext> {
  const fs = createUnixFs(config.helia)
  const pathCache = new Map<string, CID>()

  return class IpfsLoader implements Loader<LoaderContext> {
    context: LoaderContext | null = null
    stats: LoaderStats = makeStats()

    private abortController: AbortController | null = null
    private defaultLoader: Loader<LoaderContext> | null = null
    private hlsConfig: Hls['config']

    constructor(hlsConfig: Hls['config']) {
      this.hlsConfig = hlsConfig
    }

    load(
      context: LoaderContext,
      loaderConfig: LoaderConfiguration,
      callbacks: LoaderCallbacks<LoaderContext>,
    ): void {
      this.context = context
      const ipfsPath = parseIpfsPath(context.url)

      if (ipfsPath) {
        this.loadFromIpfs(ipfsPath, context, loaderConfig, callbacks)
      } else {
        this.loadFromXhr(context, loaderConfig, callbacks)
      }
    }

    private loadFromIpfs(
      ipfsPath: IpfsPath,
      context: LoaderContext,
      _loaderConfig: LoaderConfiguration,
      callbacks: LoaderCallbacks<LoaderContext>,
    ): void {
      this.stats = makeStats()
      this.stats.loading.start = performance.now()

      this.abortController = new AbortController()

      fetchFromIpfs(fs, ipfsPath, pathCache, this.abortController.signal)
        .then((data) => {
          if (this.stats.aborted) return

          this.stats.loaded = data.byteLength
          this.stats.total = data.byteLength
          this.stats.loading.first = performance.now()
          this.stats.loading.end = performance.now()

          const response =
            context.responseType === 'arraybuffer'
              ? { url: context.url, data: data.buffer as ArrayBuffer }
              : { url: context.url, data: new TextDecoder().decode(data) }

          callbacks.onSuccess(response, this.stats, context, undefined)
        })
        .catch((error: unknown) => {
          if (this.stats.aborted) return

          const message =
            error instanceof Error ? error.message : 'Unknown IPFS error'
          callbacks.onError(
            { code: 0, text: message },
            context,
            undefined,
            this.stats,
          )
        })
    }

    private loadFromXhr(
      context: LoaderContext,
      loaderConfig: LoaderConfiguration,
      callbacks: LoaderCallbacks<LoaderContext>,
    ): void {
      const DefaultLoader = this.hlsConfig.loader as new (
        config: Hls['config'],
      ) => Loader<LoaderContext>
      this.defaultLoader = new DefaultLoader(this.hlsConfig)
      this.defaultLoader.load(context, loaderConfig, callbacks)
      this.stats = this.defaultLoader.stats
    }

    abort(): void {
      if (this.defaultLoader) {
        this.defaultLoader.abort()
      }
      if (this.abortController) {
        this.abortController.abort()
        this.stats.aborted = true
      }
    }

    destroy(): void {
      this.abort()
      if (this.defaultLoader) {
        this.defaultLoader.destroy()
        this.defaultLoader = null
      }
      this.abortController = null
      this.context = null
    }
  }
}

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { LoaderContext, LoaderConfiguration, LoaderCallbacks, LoaderStats } from 'hls.js'

// Mock @helia/unixfs before importing index
vi.mock('@helia/unixfs', () => ({
  unixfs: (helia: { _catData: Uint8Array; _lsEntries: Array<{ name: string; cid: unknown }> }) => ({
    cat: async function* (_cid: unknown, _options?: unknown) {
      yield helia._catData
    },
    ls: async function* (_cid: unknown) {
      for (const entry of helia._lsEntries) {
        yield entry
      }
    },
  }),
}))

const { parseIpfsPath, createIpfsLoader } = await import('./index.ts')

describe('parseIpfsPath', () => {
  it('parses a simple IPFS CID path', () => {
    const result = parseIpfsPath('/ipfs/QmbdmJ2JRvEFhWWzHKrAcjjBdkcs46F2N7ggZnrdKKAu4s')
    expect(result).not.toBeNull()
    expect(result!.cid.toString()).toBe('QmbdmJ2JRvEFhWWzHKrAcjjBdkcs46F2N7ggZnrdKKAu4s')
    expect(result!.path).toBe('')
  })

  it('parses an IPFS path with nested file path', () => {
    const result = parseIpfsPath('/ipfs/QmbdmJ2JRvEFhWWzHKrAcjjBdkcs46F2N7ggZnrdKKAu4s/manifest.m3u8')
    expect(result).not.toBeNull()
    expect(result!.cid.toString()).toBe('QmbdmJ2JRvEFhWWzHKrAcjjBdkcs46F2N7ggZnrdKKAu4s')
    expect(result!.path).toBe('/manifest.m3u8')
  })

  it('parses IPFS path embedded in a full URL', () => {
    const result = parseIpfsPath('https://gateway.example.com/ipfs/QmbdmJ2JRvEFhWWzHKrAcjjBdkcs46F2N7ggZnrdKKAu4s/file.ts')
    expect(result).not.toBeNull()
    expect(result!.cid.toString()).toBe('QmbdmJ2JRvEFhWWzHKrAcjjBdkcs46F2N7ggZnrdKKAu4s')
    expect(result!.path).toBe('/file.ts')
  })

  it('returns null for non-IPFS URLs', () => {
    expect(parseIpfsPath('https://example.com/video.m3u8')).toBeNull()
    expect(parseIpfsPath('/api/video/stream')).toBeNull()
  })

  it('returns null for invalid CIDs', () => {
    expect(parseIpfsPath('/ipfs/not-a-valid-cid')).toBeNull()
  })

  it('ignores query params and hash fragments', () => {
    const result = parseIpfsPath('/ipfs/QmbdmJ2JRvEFhWWzHKrAcjjBdkcs46F2N7ggZnrdKKAu4s/file.m3u8?foo=bar#baz')
    expect(result).not.toBeNull()
    expect(result!.path).toBe('/file.m3u8')
  })
})

describe('createIpfsLoader', () => {
  const mockCatData = new TextEncoder().encode('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nstream.m3u8')

  function createMockHelia() {
    return {
      blockstore: { get: vi.fn(), put: vi.fn(), has: vi.fn() },
      _lsEntries: [
        { name: 'manifest.m3u8', cid: { toString: () => 'QmManifest' } },
        { name: 'segment0.ts', cid: { toString: () => 'QmSegment0' } },
      ],
      _catData: mockCatData,
    }
  }

  const fakeHlsConfig = {
    loader: class FakeXhrLoader {
      stats: LoaderStats = {
        aborted: false, loaded: 0, retry: 0, total: 0, chunkCount: 0,
        bwEstimate: 0,
        loading: { start: 0, first: 0, end: 0 },
        parsing: { start: 0, end: 0 },
        buffering: { start: 0, first: 0, end: 0 },
      }
      context: LoaderContext | null = null
      load(context: LoaderContext, _config: LoaderConfiguration, callbacks: LoaderCallbacks<LoaderContext>) {
        this.context = context
        callbacks.onSuccess(
          { url: context.url, data: 'xhr response' },
          this.stats,
          context,
          undefined,
        )
      }
      abort() {}
      destroy() {}
    },
  } as unknown as import('hls.js').default['config']

  let mockHelia: ReturnType<typeof createMockHelia>
  let LoaderClass: ReturnType<typeof createIpfsLoader>

  beforeEach(() => {
    mockHelia = createMockHelia()
    LoaderClass = createIpfsLoader({ helia: mockHelia } as never)
  })

  it('creates a loader class', () => {
    expect(LoaderClass).toBeDefined()
    expect(typeof LoaderClass).toBe('function')
  })

  it('loads IPFS content for /ipfs/ URLs', async () => {
    const loader = new LoaderClass(fakeHlsConfig)
    const context: LoaderContext = {
      url: '/ipfs/QmbdmJ2JRvEFhWWzHKrAcjjBdkcs46F2N7ggZnrdKKAu4s/manifest.m3u8',
      responseType: '',
    }

    const result = await new Promise<{ response: unknown; stats: LoaderStats }>((resolve, reject) => {
      loader.load(context, {} as LoaderConfiguration, {
        onSuccess: (response, stats) => resolve({ response, stats }),
        onError: (error) => reject(new Error(error.text)),
        onTimeout: () => reject(new Error('timeout')),
      })
    })

    expect(result.response).toHaveProperty('url', context.url)
    expect(typeof (result.response as { data: string }).data).toBe('string')
    expect(result.stats.loaded).toBeGreaterThan(0)
  })

  it('returns ArrayBuffer when responseType is arraybuffer', async () => {
    const loader = new LoaderClass(fakeHlsConfig)
    const context: LoaderContext = {
      url: '/ipfs/QmbdmJ2JRvEFhWWzHKrAcjjBdkcs46F2N7ggZnrdKKAu4s/manifest.m3u8',
      responseType: 'arraybuffer',
    }

    const result = await new Promise<{ response: { data: unknown } }>((resolve, reject) => {
      loader.load(context, {} as LoaderConfiguration, {
        onSuccess: (response) => resolve({ response: response as { data: unknown } }),
        onError: (error) => reject(new Error(error.text)),
        onTimeout: () => reject(new Error('timeout')),
      })
    })

    expect(result.response.data).toBeInstanceOf(ArrayBuffer)
  })

  it('falls back to XHR loader for non-IPFS URLs', async () => {
    const loader = new LoaderClass(fakeHlsConfig)
    const context: LoaderContext = {
      url: 'https://example.com/video.m3u8',
      responseType: '',
    }

    const result = await new Promise<{ response: { data: unknown } }>((resolve, reject) => {
      loader.load(context, {} as LoaderConfiguration, {
        onSuccess: (response) => resolve({ response: response as { data: unknown } }),
        onError: (error) => reject(new Error(error.text)),
        onTimeout: () => reject(new Error('timeout')),
      })
    })

    expect(result.response.data).toBe('xhr response')
  })

  it('abort cancels IPFS loading', () => {
    const loader = new LoaderClass(fakeHlsConfig)
    const context: LoaderContext = {
      url: '/ipfs/QmbdmJ2JRvEFhWWzHKrAcjjBdkcs46F2N7ggZnrdKKAu4s/manifest.m3u8',
      responseType: '',
    }

    loader.load(context, {} as LoaderConfiguration, {
      onSuccess: () => {},
      onError: () => {},
      onTimeout: () => {},
    })

    loader.abort()
    expect(loader.stats.aborted).toBe(true)
  })

  it('destroy cleans up resources', () => {
    const loader = new LoaderClass(fakeHlsConfig)
    loader.destroy()
    expect(loader.context).toBeNull()
  })
})

import type { BlockBroker, BlockRetrievalOptions } from '@helia/interface'
import type { CID } from 'multiformats/cid'

const DEFAULT_PER_FETCH_TIMEOUT_MS = 10_000
const DEFAULT_HEDGE_DELAY_MS = 200

/** Resolve after `ms`, or reject as soon as `signal` aborts. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('The operation was aborted.', 'AbortError'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new DOMException('The operation was aborted.', 'AbortError'))
      },
      { once: true },
    )
  })
}

/**
 * A block broker that fetches from multiple trustless gateways and returns the
 * first valid response, much faster than the default TrustlessGatewayBlockBroker
 * which tries gateways sequentially.
 *
 * Rather than hitting every gateway at once (which downloads the same block N
 * times), requests are *hedged*: gateway `i` only starts `i * hedgeDelayMs`
 * after the first. As soon as any gateway succeeds the rest are aborted, so a
 * fast first gateway means the slower ones never fire — keeping latency low
 * while avoiding redundant bandwidth in the common case.
 */
export class DirectGatewayBroker implements BlockBroker {
  name = 'direct-gateway'
  private gateways: string[]
  private perFetchTimeoutMs: number
  private hedgeDelayMs: number

  constructor(
    gateways: string[],
    perFetchTimeoutMs = DEFAULT_PER_FETCH_TIMEOUT_MS,
    hedgeDelayMs = DEFAULT_HEDGE_DELAY_MS,
  ) {
    this.gateways = gateways
    this.perFetchTimeoutMs = perFetchTimeoutMs
    this.hedgeDelayMs = hedgeDelayMs
  }

  async retrieve(cid: CID, options: BlockRetrievalOptions = {}): Promise<Uint8Array> {
    const controller = new AbortController()

    if (options.signal?.aborted === true) {
      controller.abort()
      throw new DOMException('The operation was aborted.', 'AbortError')
    }
    const onAbort = (): void => { controller.abort() }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    try {
      return await Promise.any(
        this.gateways.map(async (gw, i) => {
          // Stagger the start so we don't fetch the same block from every
          // gateway simultaneously; bail out early if another already won.
          if (i > 0) {
            await delay(i * this.hedgeDelayMs, controller.signal)
          }
          if (controller.signal.aborted) {
            throw new DOMException('The operation was aborted.', 'AbortError')
          }
          const url = `${gw}/ipfs/${cid.toString()}?format=raw`
          const fetchSignal = AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(this.perFetchTimeoutMs),
          ])
          const resp = await fetch(url, {
            signal: fetchSignal,
            headers: { Accept: 'application/vnd.ipld.raw' },
          })
          if (!resp.ok) {
            throw new Error(`${gw} returned ${resp.status}`)
          }
          const block = new Uint8Array(await resp.arrayBuffer())
          // Verify the bytes hash to the requested CID. Without validateFn a
          // gateway is fully trusted to return correct content, so Helia should
          // always supply it — guard so we never hand back unverified blocks.
          if (options.validateFn === undefined) {
            throw new Error('refusing to return unverified block (no validateFn)')
          }
          await options.validateFn(block)
          return block
        }),
      )
    } catch (err) {
      if (err instanceof AggregateError) {
        throw new AggregateError(
          err.errors,
          `All gateways failed for CID ${cid}`,
        )
      }
      throw err
    } finally {
      controller.abort()
      options.signal?.removeEventListener('abort', onAbort)
    }
  }
}

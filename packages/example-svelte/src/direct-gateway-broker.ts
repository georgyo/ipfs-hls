import type { BlockBroker, BlockRetrievalOptions } from '@helia/interface'
import type { CID } from 'multiformats/cid'

const DEFAULT_PER_FETCH_TIMEOUT_MS = 10_000

/**
 * A block broker that races fetch requests to multiple trustless gateways
 * concurrently, returning the first valid response. This is much more
 * aggressive than the default TrustlessGatewayBlockBroker which tries
 * gateways sequentially.
 */
export class DirectGatewayBroker implements BlockBroker {
  name = 'direct-gateway'
  private gateways: string[]
  private perFetchTimeoutMs: number

  constructor(gateways: string[], perFetchTimeoutMs = DEFAULT_PER_FETCH_TIMEOUT_MS) {
    this.gateways = gateways
    this.perFetchTimeoutMs = perFetchTimeoutMs
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
        this.gateways.map(async (gw) => {
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
          await options.validateFn?.(block)
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

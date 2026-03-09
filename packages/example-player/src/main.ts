import Hls from 'hls.js'
import type { FragmentLoaderConstructor, PlaylistLoaderConstructor } from 'hls.js'
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

const IPFS_MANIFEST =
  '/ipfs/QmbdmJ2JRvEFhWWzHKrAcjjBdkcs46F2N7ggZnrdKKAu4s/manifest.m3u8'

const statusEl = document.getElementById('status')!
const videoEl = document.getElementById('video') as HTMLVideoElement

function setStatus(message: string, className: 'loading' | 'ready' | 'error') {
  statusEl.textContent = message
  statusEl.className = className
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
      circuitRelayTransport(),
      webRTC({ rtcConfiguration: rtcConfig }),
      webRTCDirect({ rtcConfiguration: rtcConfig }),
      webSockets(),
    ]
    const helia = await createHelia({ libp2p })

    setStatus('Helia node ready. Initializing HLS player...', 'loading')
    const IpfsLoader = createIpfsLoader({ helia })

    const hls = new Hls({
      fLoader: IpfsLoader as unknown as FragmentLoaderConstructor,
      pLoader: IpfsLoader as unknown as PlaylistLoaderConstructor,
    })

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      setStatus('Manifest loaded. Playing video...', 'ready')
      videoEl.play().catch(() => {
        setStatus('Ready to play (click play button)', 'ready')
      })
    })

    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data.fatal) {
        setStatus(`Fatal error: ${data.details}`, 'error')
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          hls.startLoad()
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls.recoverMediaError()
        }
      }
    })

    hls.loadSource(IPFS_MANIFEST)
    hls.attachMedia(videoEl)

    setStatus('Loading manifest from IPFS...', 'loading')
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    setStatus(`Failed to initialize: ${message}`, 'error')
  }
}

init()

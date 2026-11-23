/// <reference lib="es2024" />

const CHANNEL_CONNECT_TIMEOUT_MS = 15_000

export interface WebRtcAudioSessionOptions {
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>
  createPeerConnection?: () => RTCPeerConnection
}

export interface WebRtcAudioSessionConnectOptions {
  exchangeSdp: (offer: string) => Promise<string>
  onMessage?: (data: string) => void
  onRemoteStream?: (stream: MediaStream | null) => void
}

interface RemoteTrack {
  track: MediaStreamTrack
  clear: () => void
}

interface SessionResources {
  disposed: boolean
  stream: MediaStream | null
  peer: RTCPeerConnection | null
  channel: RTCDataChannel | null
  onMessage?: (event: MessageEvent) => void
  onTrack?: (event: RTCTrackEvent) => void
  remoteTracks: RemoteTrack[]
  onRemoteStream?: (stream: MediaStream | null) => void
  cancelChannelWait?: () => void
}

function stopTracks(stream: MediaStream | null): void {
  if (!stream) return
  for (const track of stream.getTracks()) track.stop()
}

export class WebRtcAudioSession {
  private readonly getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>
  private readonly createPeerConnection: () => RTCPeerConnection
  private resources: SessionResources | null = null
  private generation = 0

  constructor(options: WebRtcAudioSessionOptions = {}) {
    this.getUserMedia = options.getUserMedia ?? ((constraints) => navigator.mediaDevices.getUserMedia(constraints))
    this.createPeerConnection = options.createPeerConnection ?? (() => new RTCPeerConnection())
  }

  async connect(options: WebRtcAudioSessionConnectOptions): Promise<boolean> {
    this.close()
    const generation = ++this.generation
    const resources: SessionResources = {
      disposed: false,
      stream: null,
      peer: null,
      channel: null,
      remoteTracks: [],
      onRemoteStream: options.onRemoteStream,
    }
    this.resources = resources
    try {
      const stream = await this.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false })
      resources.stream = stream
      if (!this.isCurrent(resources, generation)) {
        stopTracks(stream)
        return false
      }
      const peer = this.createPeerConnection()
      resources.peer = peer
      for (const track of stream.getTracks()) peer.addTrack(track, stream)
      const channel = peer.createDataChannel('oai-events')
      resources.channel = channel
      resources.onMessage = (event) => {
        if (this.isCurrent(resources, generation)) options.onMessage?.(String(event.data))
      }
      channel.addEventListener('message', resources.onMessage)
      resources.onTrack = (event) => {
        if (!this.isCurrent(resources, generation) || event.track.kind !== 'audio') return
        const clear = () => {
          if (this.isCurrent(resources, generation)) options.onRemoteStream?.(null)
        }
        resources.remoteTracks.push({ track: event.track, clear })
        event.track.addEventListener('ended', clear)
        event.track.addEventListener('error', clear)
        options.onRemoteStream?.(event.streams[0] ?? null)
      }
      peer.addEventListener('track', resources.onTrack)
      const offer = await peer.createOffer()
      if (!this.isCurrent(resources, generation)) return false
      await peer.setLocalDescription(offer)
      if (!this.isCurrent(resources, generation)) return false
      const answer = await options.exchangeSdp(offer.sdp ?? '')
      if (!this.isCurrent(resources, generation)) return false
      await peer.setRemoteDescription({ type: 'answer', sdp: answer })
      if (!this.isCurrent(resources, generation)) return false
      return await this.waitForChannel(resources, generation)
    } catch (error) {
      if (!this.isCurrent(resources, generation)) return false
      this.close()
      throw error
    }
  }

  send(data: string): void {
    const channel = this.resources?.channel
    if (!channel || this.resources?.disposed || channel.readyState !== 'open') throw new Error('Realtime audio session is not connected.')
    channel.send(data)
  }

  close(): void {
    this.generation += 1
    const resources = this.resources
    this.resources = null
    if (!resources || resources.disposed) return
    resources.disposed = true
    resources.cancelChannelWait?.()
    const { channel, peer } = resources
    if (channel && resources.onMessage) channel.removeEventListener('message', resources.onMessage)
    if (peer && resources.onTrack) peer.removeEventListener('track', resources.onTrack)
    for (const remote of resources.remoteTracks) {
      remote.track.removeEventListener('ended', remote.clear)
      remote.track.removeEventListener('error', remote.clear)
    }
    resources.remoteTracks = []
    resources.onMessage = undefined
    resources.onTrack = undefined
    stopTracks(resources.stream)
    resources.onRemoteStream?.(null)
    resources.onRemoteStream = undefined
    resources.cancelChannelWait = undefined
    if (channel) {
      try { channel.close() } catch {}
    }
    if (peer) {
      try { peer.close() } catch {}
    }
  }

  private isCurrent(resources: SessionResources, generation: number): boolean {
    return this.resources === resources && this.generation === generation && !resources.disposed
  }

  private waitForChannel(resources: SessionResources, generation: number): Promise<boolean> {
    const channel = resources.channel
    if (!channel) return Promise.reject(new Error('Realtime transcription did not connect.'))
    if (channel.readyState === 'open') return Promise.resolve(this.isCurrent(resources, generation))
    const { promise, resolve, reject } = Promise.withResolvers<boolean>()
    let settled = false
    const cleanup = () => {
      clearTimeout(timer)
      channel.removeEventListener('open', opened)
      channel.removeEventListener('error', failed)
      resources.cancelChannelWait = undefined
    }
    const complete = (finish: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      finish()
    }
    const opened = () => complete(() => resolve(this.isCurrent(resources, generation)))
    const failed = () => complete(() => {
      if (this.isCurrent(resources, generation)) reject(new Error('Realtime transcription connection failed.'))
      else resolve(false)
    })
    const timer = setTimeout(() => complete(() => {
      if (this.isCurrent(resources, generation)) reject(new Error('Realtime transcription did not connect.'))
      else resolve(false)
    }), CHANNEL_CONNECT_TIMEOUT_MS)
    resources.cancelChannelWait = () => complete(() => resolve(false))
    channel.addEventListener('open', opened)
    channel.addEventListener('error', failed)
    return promise
  }
}

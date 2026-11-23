import { vi } from 'vitest'

export function deferred<T>() {
  return Promise.withResolvers<T>()
}

export class FakeMediaTrack extends EventTarget {
  readonly kind = 'audio'
  readonly stop = vi.fn()
}

export class FakeMediaStream {
  constructor(readonly tracks: FakeMediaTrack[]) {}
  getTracks(): MediaStreamTrack[] {
    return this.tracks.map(asMediaStreamTrack)
  }
}

export class FakeDataChannel extends EventTarget {
  readonly send = vi.fn()
  readonly close = vi.fn(() => {
    this.readyState = 'closed'
    this.dispatchEvent(new Event('close'))
  })

  constructor(readyState: RTCDataChannelState = 'open') {
    super()
    this.readyState = readyState
  }

  readyState: RTCDataChannelState

  open(): void {
    this.readyState = 'open'
    this.dispatchEvent(new Event('open'))
  }

  fail(): void {
    this.dispatchEvent(new Event('error'))
  }

  message(data: string): void {
    const event = new Event('message')
    Object.defineProperty(event, 'data', { value: data })
    this.dispatchEvent(event)
  }
}

export class FakePeerConnection extends EventTarget {
  readonly channel: FakeDataChannel
  readonly addTrack = vi.fn()
  readonly createOffer = vi.fn(async (): Promise<RTCSessionDescriptionInit> => ({ type: 'offer', sdp: this.offerSdp }))
  readonly setLocalDescription = vi.fn(async (_description: RTCSessionDescriptionInit) => {})
  readonly setRemoteDescription = vi.fn(async (_description: RTCSessionDescriptionInit) => {})
  readonly close = vi.fn()
  offerSdp = 'v=0\r\na=rtpmap:111 opus/48000/2\r\na=sendrecv\r\n'

  constructor(channelState: RTCDataChannelState = 'open') {
    super()
    this.channel = new FakeDataChannel(channelState)
  }

  createDataChannel = vi.fn((_label: string): RTCDataChannel => asDataChannel(this.channel))

  emitTrack(track: FakeMediaTrack, stream: FakeMediaStream): void {
    const event = new Event('track')
    Object.defineProperties(event, {
      track: { value: asMediaStreamTrack(track) },
      streams: { value: [asMediaStream(stream)] },
    })
    this.dispatchEvent(event)
  }
}

export function asDataChannel(channel: FakeDataChannel): RTCDataChannel {
  return channel as unknown as RTCDataChannel
}

export function asMediaStream(stream: FakeMediaStream): MediaStream {
  return stream as unknown as MediaStream
}

export function asMediaStreamTrack(track: FakeMediaTrack): MediaStreamTrack {
  return track as unknown as MediaStreamTrack
}

export function asPeerConnection(peer: FakePeerConnection): RTCPeerConnection {
  return peer as unknown as RTCPeerConnection
}

export async function flushPromises(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

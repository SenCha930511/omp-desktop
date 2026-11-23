import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebRtcAudioSession } from '../../src/lib/webrtc-audio-session'
import {
  asMediaStream,
  asMediaStreamTrack,
  asPeerConnection,
  deferred,
  FakeMediaStream,
  FakeMediaTrack,
  FakePeerConnection,
  flushPromises,
} from './webrtc-audio-fakes'

describe('WebRtcAudioSession', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('uses the existing microphone and OpenAI WebRTC shape and forwards channel and remote track events', async () => {
    const localTrack = new FakeMediaTrack()
    const localStream = new FakeMediaStream([localTrack])
    const peer = new FakePeerConnection('connecting')
    const getUserMedia = vi.fn(async () => asMediaStream(localStream))
    const exchangeSdp = vi.fn(async () => 'answer-sdp')
    const onMessage = vi.fn()
    const onRemoteStream = vi.fn()
    const session = new WebRtcAudioSession({ getUserMedia, createPeerConnection: () => asPeerConnection(peer) })

    const connecting = session.connect({ exchangeSdp, onMessage, onRemoteStream })
    await flushPromises()
    expect(exchangeSdp).toHaveBeenCalledWith(peer.offerSdp)
    expect(peer.setRemoteDescription).toHaveBeenCalledOnce()
    peer.channel.open()
    await expect(connecting).resolves.toBe(true)

    expect(getUserMedia).toHaveBeenCalledWith({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false })
    expect(peer.addTrack).toHaveBeenCalledWith(asMediaStreamTrack(localTrack), asMediaStream(localStream))
    expect(peer.createDataChannel).toHaveBeenCalledWith('oai-events')
    expect(peer.setLocalDescription).toHaveBeenCalledWith({ type: 'offer', sdp: peer.offerSdp })
    expect(peer.setRemoteDescription).toHaveBeenCalledWith({ type: 'answer', sdp: 'answer-sdp' })

    const remoteTrack = new FakeMediaTrack()
    const remoteStream = new FakeMediaStream([remoteTrack])
    peer.emitTrack(remoteTrack, remoteStream)
    expect(onRemoteStream).toHaveBeenLastCalledWith(asMediaStream(remoteStream))
    peer.channel.message('remote-frame')
    expect(onMessage).toHaveBeenCalledWith('remote-frame')

    remoteTrack.dispatchEvent(new Event('ended'))
    expect(onRemoteStream).toHaveBeenLastCalledWith(null)
    remoteTrack.dispatchEvent(new Event('error'))
    expect(onRemoteStream).toHaveBeenLastCalledWith(null)

    session.close()
    session.close()
    expect(localTrack.stop).toHaveBeenCalledOnce()
    expect(peer.channel.close).toHaveBeenCalledOnce()
    expect(peer.close).toHaveBeenCalledOnce()
    expect(onRemoteStream).toHaveBeenLastCalledWith(null)
    const playbackCalls = onRemoteStream.mock.calls.length
    remoteTrack.dispatchEvent(new Event('ended'))
    peer.channel.message('after-close')
    expect(onRemoteStream).toHaveBeenCalledTimes(playbackCalls)
    expect(onMessage).toHaveBeenCalledOnce()
  })

  it('closes local resources when the peer offer resolves after cancellation', async () => {
    const track = new FakeMediaTrack()
    const stream = new FakeMediaStream([track])
    const peer = new FakePeerConnection()
    const offer = deferred<RTCSessionDescriptionInit>()
    peer.createOffer.mockReturnValue(offer.promise)
    const exchangeSdp = vi.fn(async () => 'unused-answer')
    const session = new WebRtcAudioSession({
      getUserMedia: async () => asMediaStream(stream),
      createPeerConnection: () => asPeerConnection(peer),
    })

    const connecting = session.connect({ exchangeSdp })
    await flushPromises()
    session.close()
    offer.resolve({ type: 'offer', sdp: peer.offerSdp })

    await expect(connecting).resolves.toBe(false)
    expect(peer.setLocalDescription).not.toHaveBeenCalled()
    expect(exchangeSdp).not.toHaveBeenCalled()
    expect(track.stop).toHaveBeenCalledOnce()
    expect(peer.channel.close).toHaveBeenCalledOnce()
    expect(peer.close).toHaveBeenCalledOnce()
  })

  it('ignores a late answer after close without tearing down a reopened session', async () => {
    const firstTrack = new FakeMediaTrack()
    const firstStream = new FakeMediaStream([firstTrack])
    const firstPeer = new FakePeerConnection()
    const secondTrack = new FakeMediaTrack()
    const secondStream = new FakeMediaStream([secondTrack])
    const secondPeer = new FakePeerConnection()
    const answer = deferred<string>()
    const exchangeSdp = vi.fn()
      .mockReturnValueOnce(answer.promise)
      .mockResolvedValueOnce('second-answer')
    let currentStream = firstStream
    const peers = [firstPeer, secondPeer]
    let peerIndex = 0
    const session = new WebRtcAudioSession({
      getUserMedia: async () => asMediaStream(currentStream),
      createPeerConnection: () => asPeerConnection(peers[peerIndex++]!),
    })

    const firstConnection = session.connect({ exchangeSdp })
    await flushPromises()
    session.close()

    currentStream = secondStream
    const secondConnection = session.connect({ exchangeSdp })
    await flushPromises()
    answer.resolve('late-first-answer')

    await expect(firstConnection).resolves.toBe(false)
    expect(firstPeer.setRemoteDescription).not.toHaveBeenCalled()
    expect(secondTrack.stop).not.toHaveBeenCalled()
    expect(secondPeer.close).not.toHaveBeenCalled()
    await expect(secondConnection).resolves.toBe(true)
    session.close()
    expect(secondTrack.stop).toHaveBeenCalledOnce()
    expect(secondPeer.close).toHaveBeenCalledOnce()
  })

  it('cleans a current SDP rejection and permits a subsequent connection', async () => {
    const firstTrack = new FakeMediaTrack()
    const secondTrack = new FakeMediaTrack()
    const streams = [new FakeMediaStream([firstTrack]), new FakeMediaStream([secondTrack])]
    const firstPeer = new FakePeerConnection()
    const secondPeer = new FakePeerConnection()
    const peers = [firstPeer, secondPeer]
    let connectionIndex = 0
    const failure = new Error('SDP exchange failed.')
    const exchangeSdp = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce('second-answer')
    const session = new WebRtcAudioSession({
      getUserMedia: async () => asMediaStream(streams[connectionIndex]!),
      createPeerConnection: () => {
        const peer = peers[connectionIndex]!
        connectionIndex += 1
        return asPeerConnection(peer)
      },
    })

    await expect(session.connect({ exchangeSdp })).rejects.toBe(failure)
    expect(firstTrack.stop).toHaveBeenCalledOnce()
    expect(firstPeer.channel.close).toHaveBeenCalledOnce()
    expect(firstPeer.close).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)

    await expect(session.connect({ exchangeSdp })).resolves.toBe(true)
    expect(secondPeer.setRemoteDescription).toHaveBeenCalledWith({ type: 'answer', sdp: 'second-answer' })
    expect(vi.getTimerCount()).toBe(0)
    session.close()
    expect(secondTrack.stop).toHaveBeenCalledOnce()
    expect(secondPeer.channel.close).toHaveBeenCalledOnce()
    expect(secondPeer.close).toHaveBeenCalledOnce()
  })

  it('stops a stream returned by getUserMedia after cancellation', async () => {
    const track = new FakeMediaTrack()
    const stream = new FakeMediaStream([track])
    const capture = deferred<MediaStream>()
    const createPeerConnection = vi.fn(() => asPeerConnection(new FakePeerConnection()))
    const session = new WebRtcAudioSession({ getUserMedia: () => capture.promise, createPeerConnection })
    const connecting = session.connect({ exchangeSdp: async () => 'unused-answer' })

    session.close()
    capture.resolve(asMediaStream(stream))

    await expect(connecting).resolves.toBe(false)
    expect(track.stop).toHaveBeenCalledOnce()
    expect(createPeerConnection).not.toHaveBeenCalled()
  })

  it('keeps the 15-second channel deadline and cleans up on connection errors', async () => {
    const track = new FakeMediaTrack()
    const stream = new FakeMediaStream([track])
    const peer = new FakePeerConnection('connecting')
    const session = new WebRtcAudioSession({
      getUserMedia: async () => asMediaStream(stream),
      createPeerConnection: () => asPeerConnection(peer),
    })
    const connecting = session.connect({ exchangeSdp: async () => 'answer-sdp' })
    const rejection = expect(connecting).rejects.toThrow('Realtime transcription did not connect.')

    await vi.advanceTimersByTimeAsync(15_000)

    await rejection
    expect(track.stop).toHaveBeenCalledOnce()
    expect(peer.channel.close).toHaveBeenCalledOnce()
    expect(peer.close).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports channel errors and clears all resources', async () => {
    const track = new FakeMediaTrack()
    const stream = new FakeMediaStream([track])
    const peer = new FakePeerConnection('connecting')
    const session = new WebRtcAudioSession({
      getUserMedia: async () => asMediaStream(stream),
      createPeerConnection: () => asPeerConnection(peer),
    })
    const connecting = session.connect({ exchangeSdp: async () => 'answer-sdp' })
    await flushPromises()

    peer.channel.fail()

    await expect(connecting).rejects.toThrow('Realtime transcription connection failed.')
    expect(track.stop).toHaveBeenCalledOnce()
    expect(peer.channel.close).toHaveBeenCalledOnce()
    expect(peer.close).toHaveBeenCalledOnce()
  })

  it('rejects sends before connecting or after closing and propagates channel send errors', async () => {
    const track = new FakeMediaTrack()
    const stream = new FakeMediaStream([track])
    const peer = new FakePeerConnection('open')
    const session = new WebRtcAudioSession({
      getUserMedia: async () => asMediaStream(stream),
      createPeerConnection: () => asPeerConnection(peer),
    })

    expect(() => session.send('before-connect')).toThrow('Realtime audio session is not connected.')

    await expect(session.connect({ exchangeSdp: async () => 'answer-sdp' })).resolves.toBe(true)
    peer.channel.send.mockImplementationOnce(() => {
      throw new Error('send failed')
    })
    expect(() => session.send('payload')).toThrow('send failed')

    session.close()
    expect(() => session.send('after-close')).toThrow('Realtime audio session is not connected.')
    expect(vi.getTimerCount()).toBe(0)
  })
})

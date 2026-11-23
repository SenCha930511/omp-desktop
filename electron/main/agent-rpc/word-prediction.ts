import { parsePredictWordResponse } from '../../../src/lib/word-prediction'
import type { RpcObject } from './types'

interface PredictionCall {
  generation: number
  command: RpcObject
  promise: Promise<RpcObject>
  resolve(response: RpcObject): void
  reject(error: unknown): void
}

function coalescedResponse(): RpcObject {
  return { type: 'response', command: 'predict_word', success: true, data: { suffix: null } }
}

export class NativeWordPredictionLane {
  private generation = 0
  private active: PredictionCall | undefined
  private queued: PredictionCall | undefined
  private disposalError: Error | undefined

  constructor(private readonly dispatch: (command: RpcObject) => Promise<RpcObject>) {}

  predict(command: RpcObject): Promise<RpcObject> {
    if (this.disposalError) return Promise.reject(this.disposalError)
    const { promise, resolve, reject } = Promise.withResolvers<RpcObject>()
    const call: PredictionCall = {
      generation: ++this.generation,
      command,
      promise,
      resolve,
      reject,
    }
    if (!this.active) {
      this.active = call
      void this.execute(call)
    } else {
      this.queued?.resolve(coalescedResponse())
      this.queued = call
    }
    return call.promise
  }

  dispose(error: Error): void {
    if (this.disposalError) return
    this.disposalError = error
    const active = this.active
    const queued = this.queued
    this.active = undefined
    this.queued = undefined
    active?.reject(error)
    queued?.reject(error)
  }

  private async execute(call: PredictionCall): Promise<void> {
    try {
      const response = parsePredictWordResponse(await this.dispatch(call.command))
      if (this.active?.generation === call.generation) call.resolve(response)
    } catch (error) {
      if (this.active?.generation === call.generation) call.reject(error)
    } finally {
      if (this.active?.generation === call.generation) {
        const next = this.queued
        this.queued = undefined
        this.active = next
        if (next) void this.execute(next)
      }
    }
  }
}

#!/usr/bin/env node
/**
 * RPC-side driver: the GUI's real path (framed JSON-RPC over stdio).
 * Extends the protocol-verified OmpRpcClient from verify-omp-parity.mjs so
 * framing, chunk reassembly, timeouts and disposal stay identical to the
 * validated implementation — the only addition is an event ledger.
 */
import path from 'node:path'
import { OmpRpcClient } from '../verify-omp-parity.mjs'
import { childEnv, ompArgs } from './temp-home.mjs'

export class ParityRpcDriver {
  constructor(executable, { home, workspace, sessions }) {
    this.events = []
    this.responses = []
    const args = [...ompArgs(), '--mode', 'rpc', '--cwd', workspace, '--session-dir', sessions]
    this.client = new OmpRpcClient({ executable, args, cwd: workspace, env: childEnv(home) })
    const upstream = this.client.dispatchFrame.bind(this.client)
    this.client.dispatchFrame = (frame) => {
      if (frame && typeof frame === 'object' && frame.type !== 'ready' && frame.type !== 'response') {
        if (this.events.length < 5000) this.events.push(frame)
      }
      if (frame && typeof frame === 'object' && frame.type === 'response') {
        if (this.responses.length < 5000) this.responses.push(frame)
      }
      upstream(frame)
    }
  }

  async ready() {
    await this.client.waitForReady()
    return this.client.readyFrame
  }

  request(command) {
    return this.client.request(command)
  }

  async newSession() {
    const response = await this.request({ type: 'new_session' })
    if (response.success !== true) throw new Error('new_session failed: ' + JSON.stringify(response).slice(0, 300))
    return response
  }

  async prompt(message) {
    const response = await this.request({ type: 'prompt', message })
    if (response.success !== true) throw new Error('prompt failed: ' + JSON.stringify(response).slice(0, 300))
    return response
  }

  async state() {
    const response = await this.request({ type: 'get_state' })
    if (response.success !== true) throw new Error('get_state failed')
    return response.data
  }

  async messages() {
    const response = await this.request({ type: 'get_messages' })
    if (response.success !== true) throw new Error('get_messages failed')
    return response.data
  }

  /** Waits until an assistant message_end event lands after `sinceIndex`. */
  /**
   * @param {{ sinceIndex?: number, timeoutMs?: number }} [options]
   * @returns {Promise<boolean>}
   */
  async waitForTurnEnd({ sinceIndex, timeoutMs = 30000 } = {}) {
    const start = sinceIndex ?? this.events.length
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const settled = this.events.slice(start).some((event) => event.type === 'message_end' && event.message?.role === 'assistant')
      if (settled) return true
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    return false
  }
  /**
   * Polls get_state until the agent reports not-busy. `message_end` 事件
   * 早於 omp 完全收束（post-processing 期間仍會拒絕新 prompt），送下一則
   * 前必須等 idle——RPC 側的確定性收束信號。
   * @returns {Promise<boolean>}
   */
  async waitForIdle({ timeoutMs = 30000 } = {}) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const state = await this.state().catch(() => null)
      // RpcSessionState（rpc-types.ts L151）：busy 的欄位名是 isStreaming
      // 與 isCompacting——沒有 `busy` 鍵，輪詢它會永遠等不到。
      if (state && state.isStreaming === false && state.isCompacting === false) return true
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    return false
  }

  /** The primary .jsonl session file this runtime wrote (lock files ignored). */
  sessionFile(sessionsDir, { readdirSync }) {
    const entries = readdirSync(sessionsDir).filter((name) => name.endsWith('.jsonl') && !name.startsWith('.'))
    if (entries.length === 0) return null
    entries.sort()
    return path.join(sessionsDir, entries[0])
  }

  async dispose(cleanup = {}) {
    await this.client.dispose(cleanup)
    return cleanup
  }
}

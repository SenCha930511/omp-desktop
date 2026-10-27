#!/usr/bin/env node
/**
 * TUI-side driver: the terminal's real path (interactive pty via node-pty).
 * Determinism rules:
 *  - No bare sleeps for sequencing: waitForText(marker) polls the rendered
 *    screen until the marker appears (or times out).
 *  - Keys are built with String.fromCharCode so the source stays free of
 *    escape-sequence literals.
 * The rendered screen is only used for WAIT CONDITIONS; all comparisons are
 * done on the session artifacts both processes persist (audit: 不以截圖相似
 * 代替語意驗證).
 */
import path from 'node:path'
import { readFileSync, readdirSync } from 'node:fs'
import pty from 'node-pty'
import { childEnv, ompArgs } from './temp-home.mjs'

const CR = String.fromCharCode(13)
const ANSI_CSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;?]*[a-zA-Z]', 'g')
const ANSI_OSC = new RegExp(String.fromCharCode(27) + '\\][^' + String.fromCharCode(7) + ']*' + String.fromCharCode(7), 'g')

export class ParityTuiDriver {
  constructor(executable, { home, workspace, sessions }, { cols = 100, rows = 30 } = {}) {
    this.sessions = sessions
    this.screen = ''
    this.dead = false
    this.term = pty.spawn(executable, [...ompArgs(), '--cwd', workspace, '--session-dir', sessions], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: workspace,
      env: childEnv(home),
    })
    this.term.onData((data) => { this.screen += data })
    this.exited = new Promise((resolve) => { this.resolveExited = resolve })
    this.term.onExit(() => { this.dead = true; this.resolveExited(true) })
  }

  plain(from = 0) {
    return this.screen.slice(from).replace(ANSI_CSI, '').replace(ANSI_OSC, '')
  }

  /** Polls until `marker` renders on screen. Returns false on timeout. */
  async waitForText(marker, { timeoutMs = 30000, pollMs = 200, from = 0 } = {}) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.dead) return false
      if (this.plain(from).includes(marker)) return true
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
    return this.plain(from).includes(marker)
  }

  async waitForComposer({ timeoutMs = 30000 } = {}) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.dead) return false
      const tail = this.plain().slice(-4000)
      if (tail.includes('Ask anything') || tail.includes(String.fromCharCode(960) + ' >')) return true
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    return false
  }

  type(text) {
    this.term.write(text)
  }

  submit() {
    this.term.write(CR)
  }

  async sendPrompt(text, { timeoutMs = 60000 } = {}) {
    const since = this.screen.length
    this.type(text)
    await new Promise((resolve) => setTimeout(resolve, 350))
    this.submit()
    // 判定條件（確定性，非時間猜測）：session 檔出現該輪條目——omp 在
    // 輪收束時持久化，落盤即代表可安全送下一則。只等渲染（ack 出現＋
    // 螢幕靜止）不夠：大 payload 下 post-stream 處理（hooks/落盤）晚於
    // 渲染停止，提早送下一則會被上游以 interjection <system-notice>
    // 包裹（那是 driver 跟跑，不是 parity 差異）。
    const ackSeen = await this.waitForText('fixture-ack', { timeoutMs, from: since })
    if (!ackSeen) return false
    const tail = text.slice(-40)
    const turnPersisted = () => {
      const file = this.sessionFile({ readdirSync })
      if (file === null) return false
      // 該輪收束的權威信號：session 檔存在 assistant 訊息且其文字含
      // 本輪回顯尾端（fixture 原樣回顯 prompt）。只看 'fixture-ack['
      // 會被前幾輪的 ack 誤中；只看 user 訊息會在 submit 當下就命中。
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.includes('"assistant"')) continue
        if (line.includes(tail)) return true
      }
      return false
    }
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.dead) return false
      if (turnPersisted()) return true
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    return false
  }

  /** True once the rendered screen stops changing (spinner settles, turn closes). */
  async waitForQuiescence({ timeoutMs = 20000, stablePolls = 4, pollMs = 250 } = {}) {
    const deadline = Date.now() + timeoutMs
    let stable = 0
    let lastLength = this.screen.length
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollMs))
      if (this.dead) return false
      if (this.screen.length === lastLength) {
        stable += 1
        if (stable >= stablePolls) return true
      } else {
        stable = 0
        lastLength = this.screen.length
      }
    }
    return false
  }

  /** Tries the /exit slash command, then falls back to killing the pty. */
  async dispose() {
    if (!this.dead) {
      try {
        this.type('/exit')
        await new Promise((resolve) => setTimeout(resolve, 300))
        this.submit()
        const gone = await Promise.race([
          this.exited,
          new Promise((resolve) => setTimeout(() => resolve(false), 4000)),
        ])
        if (!gone && !this.dead) {
          this.term.kill()
          await Promise.race([
            this.exited,
            new Promise((resolve) => setTimeout(() => resolve(false), 3000)),
          ])
        }
      } catch {
        // pty already gone
      }
    }
    return this.dead
  }

  /** The primary .jsonl session file the TUI wrote (lock files ignored). */
  sessionFile({ readdirSync }) {
    const entries = readdirSync(this.sessions).filter((name) => name.endsWith('.jsonl') && !name.startsWith('.'))
    if (entries.length === 0) return null
    entries.sort()
    return path.join(this.sessions, entries[0])
  }
}

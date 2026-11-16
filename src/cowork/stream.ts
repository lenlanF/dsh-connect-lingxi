import type { LingxiStreamEvent } from '../types.ts'
import {
  CoworkFrameState,
  parseFrame,
  type CoworkFrame,
  type WebSocketLike,
} from './protocol.ts'

/** Pull-driven async iterable over a push-based WebSocket. */
export class CoworkStreamIterator implements AsyncIterableIterator<LingxiStreamEvent> {
  private readonly frames: CoworkFrame[] = []
  private readonly events: LingxiStreamEvent[] = []
  private readonly state = new CoworkFrameState()
  private notify: (() => void) | undefined
  private pending: Promise<void> | undefined
  private wsClosed = false
  private terminalError: { message: string; code?: string } | undefined
  private done = false

  private readonly ws: WebSocketLike
  private readonly signal: AbortSignal | undefined

  constructor(ws: WebSocketLike, signal?: AbortSignal) {
    this.ws = ws
    this.signal = signal
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<LingxiStreamEvent> {
    return this
  }

  /** Attach listeners and send the first frame when the socket is open. */
  start(firstFrame: string): void {
    this.ws.addEventListener('message', (event: any) => {
      const raw = typeof event?.data === 'string' ? event.data : ''
      if (raw === '') return
      const frame = parseFrame(raw)
      if (frame !== undefined) {
        this.frames.push(frame)
        this.wake()
      }
    })
    this.ws.addEventListener('close', () => {
      this.wsClosed = true
      this.wake()
    })
    this.ws.addEventListener('error', () => {
      this.wsClosed = true
      this.terminalError = { message: 'lingxi cowork websocket error', code: 'websocket_error' }
      this.wake()
    })
    if (this.signal !== undefined) {
      this.signal.addEventListener('abort', () => this.wake(), { once: true })
    }

    const send = (): void => {
      if (this.ws.readyState !== 1 || this.done) return
      try {
        this.ws.send(firstFrame)
      } catch (err) {
        this.wsClosed = true
        this.terminalError = { message: 'lingxi cowork websocket send failed: ' + errorMessage(err) }
        this.wake()
      }
    }
    if (this.ws.readyState === 3) this.wsClosed = true
    if (this.ws.readyState === 1) send()
    else if (this.ws.readyState !== 3) this.ws.addEventListener('open', send, { once: true })
  }

  private wake(): void {
    const resolve = this.notify
    if (resolve === undefined) return
    this.notify = undefined
    this.pending = undefined
    resolve()
  }

  private wait(): Promise<void> {
    if (this.pending !== undefined) return this.pending
    this.pending = new Promise<void>((resolve) => {
      this.notify = resolve
    })
    return this.pending
  }

  private close(): void {
    this.done = true
    try {
      this.ws.close()
    } catch {
      // Already closed.
    }
  }

  async next(): Promise<IteratorResult<LingxiStreamEvent>> {
    if (this.events.length > 0) return this.shift()
    if (this.done) return { value: undefined, done: true }
    if (this.signal?.aborted === true) {
      this.close()
      this.events.push(...this.state.fail('chat aborted', undefined, 'aborted'))
      return this.shift()
    }
    for (;;) {
      while (this.frames.length > 0) {
        const step = this.state.step(this.frames.shift() as CoworkFrame)
        this.events.push(...step.events)
        if (step.done) this.close()
      }
      // Coalesced deltas must not wait for run.end: flush at each queue drain.
      this.events.push(...this.state.flushPending())
      if (this.events.length > 0) return this.shift()
      if (this.wsClosed) {
        if (this.terminalError !== undefined) {
          const err = this.terminalError
          this.close()
          this.events.push(...this.state.fail(err.message, undefined, err.code))
        } else {
          this.close()
          this.events.push(...this.state.finish())
        }
        if (this.events.length > 0) return this.shift()
        return { value: undefined, done: true }
      }
      await this.wait()
    }
  }

  private shift(): IteratorResult<LingxiStreamEvent> {
    return { value: this.events.shift() as LingxiStreamEvent, done: false }
  }

  async return(): Promise<IteratorResult<LingxiStreamEvent>> {
    if (!this.done) this.close()
    this.wake()
    return { value: undefined, done: true }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

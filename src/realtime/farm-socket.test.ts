import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCommandId, createSubscribeFarmFrame, FarmSocket } from './farm-socket'
import { parseServerFrame } from './frame-contract'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('createCommandId', () => {
  it('creates unique compact UUIDv7 ids', () => {
    const first = createCommandId()
    const second = createCommandId()
    expect(first).toMatch(/^[0-9a-f]{32}$/)
    expect(first[12]).toBe('7')
    expect(first[16]).toMatch(/[89ab]/)
    expect(second).not.toBe(first)
  })
})

describe('createSubscribeFarmFrame', () => {
  it('creates a dedicated control frame from the authoritative snapshot version', () => {
    expect(createSubscribeFarmFrame('23493', '17', 8, '019abcdef')).toEqual({
      meta: {
        type: 'SUBSCRIBE_FARM',
        farm_id: '23493',
        protocol_version: '1',
        client_seq: 8,
        cmd_id: '019abcdef',
      },
      body: { snapshot_version: '17' },
    })
  })
})

describe('server control frames', () => {
  it('accepts a mailbox badge event without mail content', () => {
    const frame = parseServerFrame(JSON.stringify({
      meta: { type: 'EVENT', service: 'mail', method: 'MailboxChanged', server_seq: 20 },
      body: { unread_count: 4, mailbox_version: 9 },
    }))
    expect(frame).toEqual({
      meta: { type: 'EVENT', service: 'mail', method: 'MailboxChanged', server_seq: 20 },
      body: { unread_count: 4, mailbox_version: 9 },
    })
    expect(JSON.stringify(frame)).not.toContain('title')
    expect(JSON.stringify(frame)).not.toContain('content')
  })

  it('accepts the HANDOFF frame used by rolling updates', () => {
    expect(parseServerFrame(JSON.stringify({
      meta: { type: 'HANDOFF', server_seq: 19 },
      body: { resume_ticket: 'ticket', retry_after_ms: 750, reason: 'SERVER_DRAINING' },
    }))).toEqual({
      meta: { type: 'HANDOFF', server_seq: 19 },
      body: { resume_ticket: 'ticket', retry_after_ms: 750, reason: 'SERVER_DRAINING' },
    })
  })
})

describe('FarmSocket reconnect recovery', () => {
  it('backs off, refreshes the token, and opens a replacement socket', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    vi.stubGlobal('window', { setTimeout, clearTimeout })
    vi.stubGlobal('location', { protocol: 'http:', host: 'farm.example' })

    class FakeWebSocket {
      static OPEN = 1
      readyState = 0
      onopen: (() => void) | null = null
      onmessage: ((event: { data: string }) => void) | null = null
      onerror: (() => void) | null = null
      onclose: ((event: { code: number; reason: string }) => void) | null = null
      protocols: string[]
      constructor(public url: string, protocols?: string | string[]) {
        this.protocols = Array.isArray(protocols) ? protocols : protocols ? [protocols] : []
        sockets.push(this)
      }
      close() { this.readyState = 3 }
      send() {}
    }
    const sockets: FakeWebSocket[] = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const phases: string[] = []
    const token = vi.fn().mockResolvedValue('42:2000000000.new-signature')
    const socket = new FarmSocket({
      onPhase: (phase) => phases.push(phase),
      onAck: () => undefined,
      onEvent: () => undefined,
      onMailboxChanged: () => undefined,
      onLog: () => undefined,
      onOpen: () => undefined,
      resolveReconnectToken: token,
    })

    socket.connect('42:1000000000.old-signature')
    sockets[0].onclose?.({ code: 1006, reason: 'network lost' })
    expect(phases.slice(-2)).toEqual(['closed', 'backoff'])

    await vi.advanceTimersByTimeAsync(250)
    expect(token).toHaveBeenCalledTimes(1)
    expect(sockets).toHaveLength(2)
    expect(sockets[1].url).toBe('ws://farm.example/ws')
    expect(sockets[1].protocols).toHaveLength(1)
    expect(sockets[1].protocols[0]).not.toContain(':')
    const encoded = sockets[1].protocols[0].replace('farm-auth.', '').replace(/-/g, '+').replace(/_/g, '/')
    expect(atob(encoded)).toBe('42:2000000000.new-signature')
  })

  it('does not reconnect a connection kicked by a newer session', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', { setTimeout, clearTimeout })
    vi.stubGlobal('location', { protocol: 'http:', host: 'farm.example' })
    const sockets: Array<{ onclose: ((event: { code: number; reason: string }) => void) | null }> = []
    class FakeWebSocket {
      static OPEN = 1
      readyState = 0
      onopen = null
      onmessage = null
      onerror = null
      onclose: ((event: { code: number; reason: string }) => void) | null = null
      constructor() { sockets.push(this) }
      close() {}
      send() {}
    }
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const token = vi.fn().mockResolvedValue('fresh')
    const socket = new FarmSocket({
      onPhase: () => undefined, onAck: () => undefined, onEvent: () => undefined,
      onMailboxChanged: () => undefined, onLog: () => undefined, onOpen: () => undefined,
      resolveReconnectToken: token,
    })
    socket.connect('old')
    sockets[0].onclose?.({ code: 4005, reason: 'kicked' })
    await vi.runAllTimersAsync()
    expect(token).not.toHaveBeenCalled()
    expect(sockets).toHaveLength(1)
  })

  it('forces an access-token refresh for the token-expired close code', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    vi.stubGlobal('window', { setTimeout, clearTimeout })
    vi.stubGlobal('location', { protocol: 'http:', host: 'farm.example' })
    const sockets: Array<{ onclose: ((event: { code: number; reason: string }) => void) | null }> = []
    class FakeWebSocket {
      static OPEN = 1
      readyState = 0
      onopen = null
      onmessage = null
      onerror = null
      onclose: ((event: { code: number; reason: string }) => void) | null = null
      constructor() { sockets.push(this) }
      close() {}
      send() {}
    }
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const token = vi.fn().mockResolvedValue('fresh')
    const socket = new FarmSocket({
      onPhase: () => undefined, onAck: () => undefined, onEvent: () => undefined,
      onMailboxChanged: () => undefined, onLog: () => undefined, onOpen: () => undefined,
      resolveReconnectToken: token,
    })
    socket.connect('expired')
    sockets[0].onclose?.({ code: 4002, reason: 'token expired' })
    await vi.advanceTimersByTimeAsync(250)
    expect(token).toHaveBeenCalledWith(true)
    expect(sockets).toHaveLength(2)
  })
})

import { describe, expect, it } from 'vitest'
import { createCommandId, createSubscribeFarmFrame } from './farm-socket'
import { parseServerFrame } from './frame-contract'

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

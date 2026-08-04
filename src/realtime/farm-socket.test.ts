import { describe, expect, it } from 'vitest'
import { createCommandId, createSubscribeFarmFrame } from './farm-socket'

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
    expect(createSubscribeFarmFrame('23493', '17')).toEqual({
      meta: {
        type: 'SUBSCRIBE_FARM',
        farm_id: '23493',
        protocol_version: '1',
      },
      body: { snapshot_version: '17' },
    })
  })
})

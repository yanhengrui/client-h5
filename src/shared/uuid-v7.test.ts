import { describe, expect, it } from 'vitest'
import { createUuidV7 } from './uuid-v7'

describe('createUuidV7', () => {
  it('encodes the timestamp, version, and RFC variant bits', () => {
    const timestamp = 1_785_748_800_123
    const id = createUuidV7(timestamp)

    expect(id.slice(0, 12)).toBe(timestamp.toString(16).padStart(12, '0'))
    expect(id[12]).toBe('7')
    expect(id[16]).toMatch(/[89ab]/)
  })
})

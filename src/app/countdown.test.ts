import { describe, expect, it } from 'vitest'
import { countdownSeconds } from './countdown'

describe('countdownSeconds', () => {
  it('does not show 10:01 for a ten-minute server deadline with sub-second skew', () => {
    const now = Date.parse('2026-08-03T09:00:00.000Z')
    const matureAt = '2026-08-03T09:10:00.999Z'

    expect(countdownSeconds(matureAt, now)).toBe(600)
  })

  it('never returns a negative value', () => {
    expect(countdownSeconds('2026-08-03T09:00:00.000Z', Date.parse('2026-08-03T09:00:01.000Z'))).toBe(0)
  })
})

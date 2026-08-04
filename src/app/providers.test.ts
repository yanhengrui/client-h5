import { describe, expect, it } from 'vitest'
import { hasCommandInventory, optimisticPlotPatch } from './providers'

describe('optimisticPlotPatch', () => {
  it('renders a planted crop and countdown in the first frame', () => {
    const now = Date.parse('2026-08-04T08:00:00.000Z')

    expect(optimisticPlotPatch('farm.Plant', 3, { seed_item_id: 'WHEAT' }, now)).toMatchObject({
      plot_id: 3,
      state: 'GROWING',
      crop_id: 'WHEAT',
      growth_stage: 'SEEDLING',
      planted_at: '2026-08-04T08:00:00.000Z',
      mature_at: '2026-08-04T08:10:00.000Z',
      remaining_yield: 5,
    })
  })

  it('blocks optimistic planting when the authoritative seed inventory is empty', () => {
    expect(hasCommandInventory('farm.Plant', [])).toBe(false)
    expect(hasCommandInventory('farm.Plant', [{ item_type: 'SEED', quantity: 0 }])).toBe(false)
    expect(hasCommandInventory('farm.Plant', [{ item_type: 'SEED', quantity: 1 }])).toBe(true)
    expect(hasCommandInventory('farm.Harvest', [])).toBe(true)
  })
})

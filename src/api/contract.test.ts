import { describe, expect, it } from 'vitest'
import { normalizeFriendsResponse, normalizeSnapshot, withEffectiveGrowthStage, type PlotView } from './contract'

const plantedAt = '2026-08-02T00:00:00.000Z'
const matureAt = '2026-08-02T00:10:00.000Z'

function growingPlot(growth_stage: PlotView['growth_stage']): PlotView {
  return {
    plot_id: 1,
    status: 'GROWING',
    crop_id: 'wheat',
    growth_stage,
    planted_at: plantedAt,
    mature_at: matureAt,
  }
}

describe('withEffectiveGrowthStage', () => {
  it('keeps the plot in the seedling stage before the midpoint', () => {
    const plot = withEffectiveGrowthStage(growingPlot('SEEDLING'), Date.parse('2026-08-02T00:04:59.000Z'))
    expect(plot.growth_stage).toBe('SEEDLING')
  })

  it('switches the plot to semi-mature at the midpoint', () => {
    const plot = withEffectiveGrowthStage(growingPlot('SEEDLING'), Date.parse('2026-08-02T00:05:00.000Z'))
    expect(plot.growth_stage).toBe('SEMI_MATURE')
  })

  it('switches the plot to mature at mature_at without a new snapshot', () => {
    const plot = withEffectiveGrowthStage(growingPlot('SEMI_MATURE'), Date.parse(matureAt))
    expect(plot.growth_stage).toBe('MATURE')
  })

  it('can switch to mature even when planted_at is absent', () => {
    const plot = growingPlot('SEMI_MATURE')
    delete plot.planted_at
    expect(withEffectiveGrowthStage(plot, Date.parse(matureAt)).growth_stage).toBe('MATURE')
  })
})

describe('display name contracts', () => {
  it('normalizes the farm owner display name and falls back to the owner id', () => {
    const snapshot = normalizeSnapshot({
      farm_id: '42',
      owner_user_id: '42',
      owner_display_name: '   ',
      version: '1',
      plots: [],
    })

    expect(snapshot.owner_display_name).toBe('42')
  })

  it('normalizes friend ids and display names from the API', () => {
    const response = normalizeFriendsResponse({
      friends: [
        { user_id: 121343 as unknown as string, display_name: ' 小麦糖 ' },
        { user_id: '121342', display_name: '' },
      ],
    })

    expect(response.friends).toEqual([
      { user_id: '121343', display_name: '小麦糖' },
      { user_id: '121342', display_name: '121342' },
    ])
  })
})

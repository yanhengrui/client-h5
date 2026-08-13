import { describe, expect, it } from 'vitest'
import { CROPS, cropSeedAsset, cropStageAsset, EMPTY_PLOT_ASSET } from './crops'

describe('crop artwork', () => {
  it('maps every server growth stage to a stable local asset', () => {
    expect(EMPTY_PLOT_ASSET).toBe('/assets/crops/soil-empty.webp')
    expect(cropStageAsset(CROPS[0], 'SEEDLING')).toBe('/assets/crops/wheat-seedling.webp')
    expect(cropStageAsset(CROPS[1], 'SEMI_MATURE')).toBe('/assets/crops/carrot-growing.webp')
  expect(cropStageAsset(CROPS[2], 'MATURE')).toBe('/assets/crops/tomato-mature.webp')
  expect(cropSeedAsset(CROPS[0])).toBe('/assets/seeds/wheat-seeds.png')
  })
})

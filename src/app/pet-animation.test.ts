import { describe, expect, it } from 'vitest'
import type { EventFrame } from '../realtime/frame-contract'
import type { FarmState } from '../state/app-state'
import { detectPetHarvest, detectPetHarvestsFromSnapshot } from './pet-animation'

const farm: FarmState = {
  farm_id: '42',
  owner_user_id: '42',
  owner_display_name: 'Farmer 42',
  version: '8',

  sync: 'synced',
  plots: [{
    plot_id: 3,
    status: 'GROWING',
    crop_id: 'WHEAT',
    growth_stage: 'SEMI_MATURE',
    planted_at: '2026-08-03T00:00:00Z',
    mature_at: '2026-08-03T00:10:00Z',
  }],
}

const frame: EventFrame = {
  meta: { type: 'EVENT', farm_id: '42' },
  body: { event_id: 'evt-pet', version: '9', actor_user_id: '42', command_type: 'PET_AUTO_HARVEST', patch: { plot_id: 3, state: 'EMPTY' } },
}

describe('detectPetHarvest', () => {
  it('detects a confirmed owner-side mature harvest when a pet is active', () => {
    expect(detectPetHarvest({ hasPet: true, farm, ownFarmId: '42', pendingPlotIds: [], frame, nowMs: Date.parse('2026-08-03T00:10:00Z') }))
      .toEqual({ eventId: 'evt-pet', plotId: 3 })
  })

  it('does not animate the current tab manual harvest', () => {
    expect(detectPetHarvest({ hasPet: true, farm, ownFarmId: '42', pendingPlotIds: [3], frame, nowMs: Date.parse('2026-08-03T00:10:00Z') }))
      .toBeNull()
  })

  it('does not animate an explicitly identified manual harvest', () => {
    const manualFrame = { ...frame, body: { ...frame.body, command_type: 'HARVEST' } }
    expect(detectPetHarvest({ hasPet: true, farm, ownFarmId: '42', pendingPlotIds: [], frame: manualFrame, nowMs: Date.parse('2026-08-03T00:10:00Z') }))
      .toBeNull()
  })

  it('does not animate a friend action or an immature plot', () => {
    const friendFrame = { ...frame, body: { ...frame.body, actor_user_id: '99' } }
    expect(detectPetHarvest({ hasPet: true, farm, ownFarmId: '42', pendingPlotIds: [], frame: friendFrame, nowMs: Date.parse('2026-08-03T00:10:00Z') }))
      .toBeNull()
    expect(detectPetHarvest({ hasPet: true, farm, ownFarmId: '42', pendingPlotIds: [], frame, nowMs: Date.parse('2026-08-03T00:09:59Z') }))
      .toBeNull()
  })

  it('detects later pet harvest events independently', () => {
    const laterFarm: FarmState = {
      ...farm,
      version: '9',
      plots: [{
        ...farm.plots[0],
        plot_id: 7,
        planted_at: '2026-08-03T00:20:00Z',
        mature_at: '2026-08-03T00:30:00Z',
      }],
    }
    const laterFrame: EventFrame = {
      meta: { type: 'EVENT', farm_id: '42' },
      body: { event_id: 'evt-pet-later', version: '10', actor_user_id: '42', command_type: 'PET_AUTO_HARVEST', patch: { plot_id: 7, state: 'EMPTY' } },
    }

    expect(detectPetHarvest({ hasPet: true, farm: laterFarm, ownFarmId: '42', pendingPlotIds: [], frame: laterFrame, nowMs: Date.parse('2026-08-03T00:30:00Z') }))
      .toEqual({ eventId: 'evt-pet-later', plotId: 7 })
  })
})

describe('detectPetHarvestsFromSnapshot', () => {
  it('replays a pet cue when a mature plot disappeared from a newer authoritative snapshot', () => {
    const snapshot = {
      ...farm,
      version: '8',
      plots: farm.plots.map((plot) => plot.plot_id === 3 ? { plot_id: 3, status: 'EMPTY' } : plot),
    }
    expect(detectPetHarvestsFromSnapshot({
      hasPet: true,
      autoHarvestEnabled: true,
      farm,
      snapshot,
      ownFarmId: '42',
      pendingPlotIds: [],
      nowMs: Date.parse('2026-08-03T00:10:00Z'),
    })).toEqual([{ eventId: 'pet-reconcile:42:8:3', plotId: 3 }])
  })

  it('does not infer pet work while auto harvest is off or a local command is pending', () => {
    const snapshot = {
      ...farm,
      version: '8',
      plots: farm.plots.map((plot) => plot.plot_id === 3 ? { plot_id: 3, status: 'EMPTY' } : plot),
    }
    const input = { hasPet: true, autoHarvestEnabled: false, farm, snapshot, ownFarmId: '42', pendingPlotIds: [], nowMs: Date.parse('2026-08-03T00:10:00Z') }
    expect(detectPetHarvestsFromSnapshot(input)).toEqual([])
    expect(detectPetHarvestsFromSnapshot({ ...input, autoHarvestEnabled: true, pendingPlotIds: [3] })).toEqual([])
  })
})

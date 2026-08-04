import { describe, expect, it } from 'vitest'
import { appReducer, initialState } from './app-state'

const snapshot = {
  farm_id: '10001', owner_user_id: '10001', owner_display_name: 'Farmer 10001', version: '7',
  plots: [{ plot_id: 0, status: 'EMPTY' as const }],
}

describe('appReducer authority rules', () => {
  it('atomically replaces a snapshot', () => {
    const next = appReducer(initialState, { type: 'snapshot', snapshot })
    expect(next.farm?.version).toBe('7')
    expect(next.farm?.sync).toBe('synced')
  })

  it('applies only the next event version', () => {
    const loaded = appReducer(initialState, { type: 'snapshot', snapshot })
    const next = appReducer(loaded, { type: 'eventPatch', eventId: 'evt-1', version: '8', patch: { plot_id: 0, state: 'GROWING' } })
    expect(next.farm?.plots[0].status).toBe('GROWING')
  })

  it('merges every field from a complete consecutive patch', () => {
    const loaded = appReducer(initialState, { type: 'snapshot', snapshot })
    const next = appReducer(loaded, {
      type: 'eventPatch',
      eventId: 'evt-full',
      version: '8',
      patch: {
        plot_id: 0,
        state: 'GROWING',
        crop_id: 'WHEAT',
        planted_at: '2026-07-31T12:00:00Z',
        mature_at: '2026-07-31T12:10:00Z',
        growth_stage: 'SEEDLING',
        remaining_yield: 5,
      },
    })
    expect(next.farm?.plots[0]).toMatchObject({
      status: 'GROWING',
      crop_id: 'WHEAT',
      planted_at: '2026-07-31T12:00:00Z',
      mature_at: '2026-07-31T12:10:00Z',
      growth_stage: 'SEEDLING',
      remaining_yield: 5,
    })
  })

  it('keeps a stolen mature crop and applies its reduced remaining yield', () => {
    const matureSnapshot = {
      ...snapshot,
      plots: [{ plot_id: 0, status: 'GROWING', crop_id: 'WHEAT', growth_stage: 'MATURE', remaining_yield: 5 }],
    }
    const loaded = appReducer(initialState, { type: 'snapshot', snapshot: matureSnapshot })
    const next = appReducer(loaded, {
      type: 'eventPatch',
      eventId: 'evt-steal',
      version: '8',
      patch: { plot_id: 0, state: 'GROWING', crop_id: 'WHEAT', growth_stage: 'MATURE', remaining_yield: 4 },
    })
    expect(next.farm?.plots[0]).toMatchObject({ status: 'GROWING', crop_id: 'WHEAT', growth_stage: 'MATURE', remaining_yield: 4 })
  })

  it('drops duplicate and older event versions', () => {
    const loaded = appReducer(initialState, { type: 'snapshot', snapshot })
    const duplicate = appReducer(loaded, { type: 'eventPatch', eventId: 'evt-duplicate', version: '7', patch: { plot_id: 0, state: 'GROWING' } })
    expect(duplicate.farm?.plots[0].status).toBe('EMPTY')
    expect(duplicate.farm?.version).toBe('7')
  })

  it('applies the newest authoritative plot immediately while a version gap resyncs', () => {
    const loaded = appReducer(initialState, { type: 'snapshot', snapshot })
    const next = appReducer(loaded, { type: 'eventPatch', eventId: 'evt-gap', version: '10', patch: { plot_id: 0, state: 'GROWING' } })
    expect(next.farm?.sync).toBe('stale')
    expect(next.farm?.version).toBe('10')
    expect(next.farm?.plots[0].status).toBe('GROWING')
  })

  it('does not mark a loaded snapshot offline while the socket is connecting', () => {
    const loaded = appReducer(initialState, { type: 'snapshot', snapshot })
    const connecting = appReducer(loaded, { type: 'phase', phase: 'connecting' })
    expect(connecting.farm?.sync).toBe('synced')
    const closed = appReducer(connecting, { type: 'phase', phase: 'closed' })
    expect(closed.farm?.sync).toBe('offline')
  })

  it('applies a pending farm command optimistically without changing the authoritative version', () => {
    const farmLoaded = appReducer(initialState, { type: 'snapshot', snapshot })
    const loaded = appReducer(farmLoaded, { type: 'playerEconomy', assets: { coin_balance: 990, inventory: [{ item_type: 'SEED', item_id: '1', quantity: 2 }] } })
    const pending = appReducer(loaded, {
      type: 'pendingAdd',
      cmdId: 'cmd-1',
      plotId: 0,
      clientSeq: 1,
      optimisticPatch: { plot_id: 0, state: 'GROWING', crop_id: 'WHEAT', growth_stage: 'SEEDLING' },
      inventoryDelta: { itemType: 'SEED', itemId: '1', quantity: -1 },
    })
    expect(pending.farm?.plots[0]).toMatchObject({ status: 'GROWING', crop_id: 'WHEAT', growth_stage: 'SEEDLING' })
    expect(pending.playerEconomy?.inventory?.[0].quantity).toBe(1)
    expect(pending.farm?.version).toBe('7')
  })

  it('optimistically changes the economy and then confirms the server balance', () => {
    const farmLoaded = appReducer(initialState, { type: 'snapshot', snapshot })
    const loaded = appReducer(farmLoaded, { type: 'playerEconomy', assets: { coin_balance: 990, inventory: [] } })
    const pending = appReducer(loaded, { type: 'economyDelta', coin: -10, itemType: 'SEED', itemId: '1', quantity: 1 })
    expect(pending.playerEconomy?.coin_balance).toBe(980)
    expect(pending.playerEconomy?.inventory).toContainEqual({ item_type: 'SEED', item_id: '1', quantity: 1 })
    const confirmed = appReducer(pending, { type: 'economyConfirm', coinBalance: 979 })
    expect(confirmed.playerEconomy?.coin_balance).toBe(979)
  })

  it('keeps the signed-in player economy while visiting another farm', () => {
    const ownFarm = appReducer(initialState, { type: 'snapshot', snapshot })
    const own = appReducer(ownFarm, { type: 'playerEconomy', assets: { coin_balance: 990, inventory: [] } })
    const friendSnapshot = { ...snapshot, farm_id: '20002', owner_user_id: '20002', owner_display_name: 'Farmer 20002' }
    const visiting = appReducer(own, { type: 'snapshot', snapshot: friendSnapshot })
    expect(visiting.farm?.farm_id).toBe('20002')
    expect(visiting.playerEconomy?.coin_balance).toBe(990)
  })
})

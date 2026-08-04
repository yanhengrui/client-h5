import type { AuthSession, FarmSnapshot, InventoryItem, PlayerAssets, PlotView } from '../api/contract'
import type { HttpLog } from '../api/api-client'
import type { PlotPatch } from '../realtime/frame-contract'
import type { SocketPhase, WsLog } from '../realtime/farm-socket'

export type FarmState = FarmSnapshot & { sync: 'loading' | 'synced' | 'stale' | 'offline' }
export type PlayerEconomy = PlayerAssets
export type Notice = { id: string; tone: 'success' | 'error' | 'info'; text: string }
export type AppState = {
  session: AuthSession | null
  farm: FarmState | null
  playerEconomy: PlayerEconomy | null
  socketPhase: SocketPhase
  clientSeq: number
  serverSeq: number
  pending: Record<string, number>
  seenEvents: string[]
  httpLogs: HttpLog[]
  wsLogs: WsLog[]
  notice: Notice | null
}

export type Action =
  | { type: 'session'; session: AuthSession | null }
  | { type: 'snapshot'; snapshot: FarmSnapshot }
  | { type: 'playerEconomy'; assets: PlayerAssets }
  | { type: 'sync'; sync: FarmState['sync'] }
  | { type: 'phase'; phase: SocketPhase }
  | { type: 'pendingAdd'; cmdId: string; plotId: number; clientSeq: number; optimisticPatch?: PlotPatch; inventoryDelta?: { itemType: string; itemId: string; quantity: number } }
  | { type: 'pendingRemove'; cmdId: string; serverSeq?: number }
  | { type: 'serverSeq'; serverSeq?: number }
  | { type: 'economyDelta'; coin: number; itemType: string; itemId: string; quantity: number }
  | { type: 'economyConfirm'; coinBalance: number }
  | { type: 'ackPatch'; patch?: PlotPatch; version: string }
  | { type: 'eventPatch'; patch: PlotPatch; version: string; eventId: string; serverSeq?: number }
  | { type: 'httpLog'; log: HttpLog }
  | { type: 'wsLog'; log: WsLog }
  | { type: 'notice'; notice: Notice | null }

export const initialState: AppState = {
  session: null,
  farm: null,
  playerEconomy: null,
  socketPhase: 'idle',
  clientSeq: 0,
  serverSeq: 0,
  pending: {},
  seenEvents: [],
  httpLogs: [],
  wsLogs: [],
  notice: null,
}

const patchPlot = (plot: PlotView, patch: PlotPatch): PlotView => {
  if (plot.plot_id !== patch.plot_id) return plot
  return {
    ...plot,
    status: patch.state ?? plot.status,
    crop_id: patch.crop_id ?? (patch.state === 'EMPTY' ? undefined : plot.crop_id),
    planted_at: patch.planted_at ?? (patch.state === 'EMPTY' ? undefined : plot.planted_at),
    mature_at: patch.mature_at ?? (patch.state === 'EMPTY' ? undefined : plot.mature_at),
    growth_stage: patch.growth_stage ?? (patch.state === 'EMPTY' ? undefined : plot.growth_stage),
    remaining_yield: patch.remaining_yield ?? (patch.state === 'EMPTY' ? undefined : plot.remaining_yield),
    yield: patch.yield ?? (patch.state === 'EMPTY' ? undefined : plot.yield),
  }
}

const adjustInventory = (items: InventoryItem[], itemType: string, itemId: string, delta: number) => {
  const inventory = [...(items ?? [])]
  const index = inventory.findIndex((item) => item.item_type === itemType && item.item_id === itemId)
  if (index < 0) {
    if (delta > 0) inventory.push({ item_type: itemType, item_id: itemId, quantity: delta })
    return inventory
  }
  inventory[index] = { ...inventory[index], quantity: Math.max(0, inventory[index].quantity + delta) }
  return inventory
}

export function appReducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'session': return { ...state, session: action.session, playerEconomy: action.session ? state.playerEconomy : null }
    case 'snapshot': return { ...state, farm: { ...action.snapshot, sync: 'synced' } }
    case 'playerEconomy': return { ...state, playerEconomy: action.assets }
    case 'sync': return state.farm ? { ...state, farm: { ...state.farm, sync: action.sync } } : state
    case 'phase': {
      const wentOffline = action.phase === 'closed' || action.phase === 'backoff'
      return { ...state, socketPhase: action.phase, farm: state.farm ? { ...state.farm, sync: wentOffline ? 'offline' : state.farm.sync } : null }
    }
    case 'pendingAdd': return {
      ...state,
      clientSeq: action.clientSeq,
      pending: { ...state.pending, [action.cmdId]: action.plotId },
      farm: state.farm ? {
        ...state.farm,
        plots: action.optimisticPatch ? state.farm.plots.map((plot) => patchPlot(plot, action.optimisticPatch!)) : state.farm.plots,
      } : null,
      playerEconomy: action.inventoryDelta && state.playerEconomy ? {
        ...state.playerEconomy,
        inventory: adjustInventory(state.playerEconomy.inventory, action.inventoryDelta.itemType, action.inventoryDelta.itemId, action.inventoryDelta.quantity),
      } : state.playerEconomy,
    }
    case 'pendingRemove': {
      const pending = { ...state.pending }
      delete pending[action.cmdId]
      return { ...state, pending, serverSeq: Math.max(state.serverSeq, action.serverSeq ?? 0) }
    }
    case 'serverSeq': return { ...state, serverSeq: Math.max(state.serverSeq, action.serverSeq ?? 0) }
    case 'economyDelta': return state.playerEconomy ? {
      ...state,
      playerEconomy: {
        coin_balance: state.playerEconomy.coin_balance + action.coin,
        inventory: adjustInventory(state.playerEconomy.inventory, action.itemType, action.itemId, action.quantity),
      },
    } : state
    case 'economyConfirm': return state.playerEconomy ? { ...state, playerEconomy: { ...state.playerEconomy, coin_balance: action.coinBalance } } : state
    case 'ackPatch': return state.farm ? { ...state, farm: { ...state.farm, version: action.version, plots: action.patch ? state.farm.plots.map((plot) => patchPlot(plot, action.patch!)) : state.farm.plots } } : state
    case 'eventPatch': {
      if (!state.farm || state.seenEvents.includes(action.eventId)) return state
      const local = BigInt(state.farm.version)
      const incoming = BigInt(action.version)
      if (incoming <= local) return { ...state, seenEvents: [...state.seenEvents, action.eventId].slice(-100) }
      const hasGap = incoming !== local + 1n
      return {
        ...state,
        serverSeq: Math.max(state.serverSeq, action.serverSeq ?? 0),
        seenEvents: [...state.seenEvents, action.eventId].slice(-100),
        farm: {
          ...state.farm,
          version: action.version,
          sync: hasGap ? 'stale' : state.farm.sync,
          plots: state.farm.plots.map((plot) => patchPlot(plot, action.patch)),
        },
      }
    }
    case 'httpLog': return { ...state, httpLogs: [action.log, ...state.httpLogs].slice(0, 100) }
    case 'wsLog': return { ...state, wsLogs: [action.log, ...state.wsLogs].slice(0, 100) }
    case 'notice': return { ...state, notice: action.notice }
  }
}

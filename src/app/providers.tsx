import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import { ApiClient, ApiError } from '../api/api-client'
import type { AuthSession, FarmSnapshot } from '../api/contract'
import { errorMessage, withEffectiveGrowthStage } from '../api/contract'
import { FarmSocket } from '../realtime/farm-socket'
import type { AckFrame, EventFrame, MailboxChangedFrame, PlotPatch } from '../realtime/frame-contract'
import { appReducer, initialState, type AppState } from '../state/app-state'
import { createUuidV7 } from '../shared/uuid-v7'
import { detectPetHarvest, detectPetHarvestsFromSnapshot, type PetHarvestCue } from './pet-animation'
import { cropDefinition, cropInventoryCount, type CropId } from './crops'
import { farmAudio } from '../audio/farm-audio'

const SESSION_KEY = 'farm.session.v1'
const PROFILE_NAME_KEY = 'farm.profile-name.v1'

type AppContextValue = {
  state: AppState
  api: ApiClient
  login: (username: string, password: string) => Promise<AuthSession>
  register: (username: string, password: string, displayName: string) => Promise<AuthSession>
  logout: () => Promise<void>
  loadSnapshot: (farmId?: string) => Promise<FarmSnapshot>
  refreshPlayerAssets: () => Promise<void>
  refreshMailboxSummary: () => Promise<void>
  retryFarmSubscription: () => Promise<void>
  farmCommand: (method: string, plotId: number, body?: Record<string, unknown>) => void
  shopTrade: (kind: 'buy' | 'sell', cropId: CropId, quantity: number) => Promise<void>
  hasPet: boolean | null
  autoHarvestEnabled: boolean | null
  refreshPetStatus: () => Promise<boolean>
  purchasePet: () => Promise<void>
  setPetAutoHarvest: (enabled: boolean) => Promise<void>
  petHarvests: PetHarvestCue[]
  completePetHarvest: (eventId: string) => void
  notify: (text: string, tone?: 'success' | 'error' | 'info') => void
  reconnectSocket: () => void
  disconnectSocket: () => void
  exportDebug: () => void
}

const AppContext = createContext<AppContextValue | null>(null)

function loadSession(): AppState['session'] {
  try {
    const session = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? 'null') as AppState['session']
    return session
  } catch { return null }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(appReducer, { ...initialState, session: loadSession() })
  const [hasPet, setHasPet] = useState<boolean | null>(null)
  const [autoHarvestEnabled, setAutoHarvestEnabled] = useState<boolean | null>(null)
  const [petHarvests, setPetHarvests] = useState<PetHarvestCue[]>([])
  const stateRef = useRef(state)
  stateRef.current = state
  const hasPetRef = useRef(hasPet)
  hasPetRef.current = hasPet
  const refreshSnapshotRef = useRef<() => void>(() => undefined)
  const syncOnOpenRef = useRef<() => void>(() => undefined)
  const activeFarmRef = useRef<{ farmId: string; version: string } | null>(null)
  const desiredFarmIdRef = useRef<string | undefined>(state.session?.farmId)
  const snapshotRequestRef = useRef(0)
  const resyncingRef = useRef(false)
  const petReconcilingRef = useRef(false)
  const petReconcileAfterRef = useRef(0)
  const acceptEventsRef = useRef(false)
  const ackTimers = useRef<Record<string, number>>({})
  const pendingMethodsRef = useRef<Record<string, string>>({})
  const pendingSubscriptionsRef = useRef<Record<string, { farmId: string; version: string }>>({})
  const socketOpenedRef = useRef(false)
  const petPurchasePromiseRef = useRef<Promise<void> | null>(null)
  const assetRefreshTimerRef = useRef<number | null>(null)

  const saveSession = useCallback((session: AppState['session']) => {
    if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session))
    else sessionStorage.removeItem(SESSION_KEY)
    stateRef.current = { ...stateRef.current, session }
    dispatch({ type: 'session', session })
  }, [])

  const api = useMemo(() => new ApiClient('', saveSession, (log) => dispatch({ type: 'httpLog', log })), [saveSession])
  api.setSession(state.session)

  const refreshPlayerAssets = useCallback(async () => {
    const assets = await api.assets()
    dispatch({ type: 'playerEconomy', assets })
  }, [api])

  const refreshMailboxSummary = useCallback(async () => {
    const summary = await api.mailSummary()
    dispatch({ type: 'mailboxSummary', summary })
  }, [api])

  const schedulePlayerAssetsRefresh = useCallback(() => {
    if (assetRefreshTimerRef.current !== null) window.clearTimeout(assetRefreshTimerRef.current)
    assetRefreshTimerRef.current = window.setTimeout(() => {
      assetRefreshTimerRef.current = null
      void refreshPlayerAssets().catch(() => undefined)
    }, 120)
  }, [refreshPlayerAssets])

  const refreshPetStatus = useCallback(async () => {
    const result = await api.petStatus()
    setHasPet(result.has_pet)
    setAutoHarvestEnabled(result.has_pet ? result.auto_harvest_enabled : null)
    return result.has_pet
  }, [api])

  const purchasePet = useCallback(() => {
    if (petPurchasePromiseRef.current) return petPurchasePromiseRef.current

    const previousHasPet = hasPetRef.current
    const previousAutoHarvest = autoHarvestEnabled
    hasPetRef.current = true
    setHasPet(true)
    setAutoHarvestEnabled(true)
    dispatch({ type: 'coinDelta', coin: -200 })

    const purchase = api.buyPet()
      .then(() => {
        void Promise.all([refreshPlayerAssets(), refreshPetStatus()]).catch(() => undefined)
      })
      .catch((error) => {
        hasPetRef.current = previousHasPet
        setHasPet(previousHasPet)
        setAutoHarvestEnabled(previousAutoHarvest)
        dispatch({ type: 'coinDelta', coin: 200 })
        void refreshPlayerAssets().catch(() => undefined)
        throw error
      })
      .finally(() => {
        petPurchasePromiseRef.current = null
      })

    petPurchasePromiseRef.current = purchase
    return purchase
  }, [api, autoHarvestEnabled, refreshPetStatus, refreshPlayerAssets])

  const setPetAutoHarvest = useCallback(async (enabled: boolean) => {
    const result = await api.setPetAutoHarvest(enabled)
    setAutoHarvestEnabled(result.auto_harvest_enabled)
  }, [api])

  const completePetHarvest = useCallback((eventId: string) => {
    setPetHarvests((current) => current.filter((cue) => cue.eventId !== eventId))
  }, [])

  const notify = useCallback((text: string, tone: 'success' | 'error' | 'info' = 'info') => {
    const id = createUuidV7()
    dispatch({ type: 'notice', notice: { id, text, tone } })
    window.setTimeout(() => {
      if (stateRef.current.notice?.id === id) dispatch({ type: 'notice', notice: null })
    }, 3400)
  }, [])

  const handleAck = useCallback((frame: AckFrame) => {
    const subscription = frame.meta.cmd_id ? pendingSubscriptionsRef.current[frame.meta.cmd_id] : undefined
    if (subscription) {
      delete pendingSubscriptionsRef.current[frame.meta.cmd_id!]
      dispatch({ type: 'serverSeq', serverSeq: frame.meta.server_seq })
      const current = activeFarmRef.current
      if (!current || current.farmId !== subscription.farmId || desiredFarmIdRef.current !== subscription.farmId) return
      if (frame.body.result === 'OK') {
        acceptEventsRef.current = true
        dispatch({ type: 'farmSubscription', subscription: { farmId: subscription.farmId, phase: 'live' } })
      } else if (frame.body.result === 'COMMON_RESOURCE_EXHAUSTED') {
        acceptEventsRef.current = false
        dispatch({ type: 'farmSubscription', subscription: { farmId: subscription.farmId, phase: 'full' } })
      } else {
        acceptEventsRef.current = false
        dispatch({ type: 'farmSubscription', subscription: { farmId: subscription.farmId, phase: 'failed' } })
        notify(errorMessage(frame.body.result), 'error')
      }
      return
    }

    if (!frame.meta.cmd_id) {
      dispatch({ type: 'serverSeq', serverSeq: frame.meta.server_seq })
      if (frame.body.result !== 'OK') {
        acceptEventsRef.current = false
        notify(errorMessage(frame.body.result), 'error')
      }
      return
    }
    const method = pendingMethodsRef.current[frame.meta.cmd_id]
    window.clearTimeout(ackTimers.current[frame.meta.cmd_id])
    delete ackTimers.current[frame.meta.cmd_id]
    delete pendingMethodsRef.current[frame.meta.cmd_id]
    dispatch({ type: 'pendingRemove', cmdId: frame.meta.cmd_id, serverSeq: frame.meta.server_seq })
    if (frame.body.result === 'OK') {
      if (method === 'farm.Plant' || method === 'farm.Harvest' || method === 'farm.StealCrop') {
        schedulePlayerAssetsRefresh()
      }
      const current = activeFarmRef.current
      const newVersion = String(frame.body.new_version ?? current?.version ?? stateRef.current.farm?.version ?? '0')
      if (current) {
        try {
          const localVersion = BigInt(current.version)
          const incomingVersion = BigInt(newVersion)
          if (incomingVersion > localVersion + 1n) {
            dispatch({ type: 'sync', sync: 'stale' })
            refreshSnapshotRef.current()
            return
          }
          if (incomingVersion < localVersion) return
          if (incomingVersion >= localVersion) activeFarmRef.current = { ...current, version: newVersion }
        } catch {
          dispatch({ type: 'sync', sync: 'stale' })
          refreshSnapshotRef.current()
          return
        }
      }
      dispatch({ type: 'ackPatch', patch: frame.body.patch, version: newVersion })
      notify(frame.body.replayed ? '操作成功（幂等重放）' : '操作成功', 'success')
    } else {
      if (method === 'farm.Plant' || method === 'farm.Harvest' || method === 'farm.StealCrop') {
        schedulePlayerAssetsRefresh()
      }
      notify(errorMessage(frame.body.result), 'error')
      refreshSnapshotRef.current()
    }
  }, [notify, schedulePlayerAssetsRefresh])

  const handleEvent = useCallback((frame: EventFrame) => {
    if (!acceptEventsRef.current) return
    const current = activeFarmRef.current
    if (!current || (frame.meta.farm_id && frame.meta.farm_id !== current.farmId)) return
    try {
      const localVersion = BigInt(current.version)
      const incomingVersion = BigInt(String(frame.body.version))
      if (incomingVersion <= localVersion) return
      const harvestCue = detectPetHarvest({
        hasPet: hasPetRef.current === true,
        farm: stateRef.current.farm,
        ownFarmId: stateRef.current.session?.farmId,
        pendingPlotIds: Object.values(stateRef.current.pending),
        frame,
        nowMs: Date.now(),
      })
      if (harvestCue) {
        petReconcileAfterRef.current = Date.now() + 25_000
        setPetHarvests((currentCues) => currentCues.some((cue) => cue.eventId === harvestCue.eventId)
          ? currentCues
          : [...currentCues, harvestCue].slice(-12))
      }
      activeFarmRef.current = { ...current, version: String(frame.body.version) }
      dispatch({ type: 'eventPatch', patch: frame.body.patch, version: String(frame.body.version), eventId: frame.body.event_id, serverSeq: frame.meta.server_seq })
      if (current.farmId === stateRef.current.session?.farmId && frame.body.patch.state === 'EMPTY') {
        schedulePlayerAssetsRefresh()
      }
      if (incomingVersion !== localVersion + 1n) {
        dispatch({ type: 'sync', sync: 'stale' })
        refreshSnapshotRef.current()
      }
    } catch {
      dispatch({ type: 'sync', sync: 'stale' })
      refreshSnapshotRef.current()
    }
  }, [schedulePlayerAssetsRefresh])

  const handleMailboxChanged = useCallback((frame: MailboxChangedFrame) => {
    dispatch({
      type: 'mailboxSummary',
      summary: { unread_count: frame.body.unread_count, mailbox_version: frame.body.mailbox_version },
    })
  }, [])

  const socket = useMemo(() => new FarmSocket({
    onPhase: (phase) => {
      if (phase !== 'open') {
        acceptEventsRef.current = false
        pendingSubscriptionsRef.current = {}
        const farmId = activeFarmRef.current?.farmId ?? null
        dispatch({ type: 'farmSubscription', subscription: { farmId, phase: 'idle' } })
        if (phase === 'closed' || phase === 'backoff') {
          Object.values(ackTimers.current).forEach((timer) => window.clearTimeout(timer))
          ackTimers.current = {}
          pendingMethodsRef.current = {}
          dispatch({ type: 'pendingClear' })
        }
      }
      dispatch({ type: 'phase', phase })
    },
    onAck: handleAck,
    onEvent: handleEvent,
    onMailboxChanged: handleMailboxChanged,
    onLog: (log) => dispatch({ type: 'wsLog', log }),
    onOpen: () => syncOnOpenRef.current(),
    resolveReconnectToken: (forceRefresh) => api.realtimeAccessToken(30, forceRefresh),
    onReconnectBlocked: (error) => {
      notify(error instanceof Error ? error.message : '登录会话已失效，请重新登录', 'error')
    },
  }), [handleAck, handleEvent, handleMailboxChanged])

  const subscribeFarm = useCallback((farmId: string, version: string) => {
    acceptEventsRef.current = false
    dispatch({ type: 'farmSubscription', subscription: { farmId, phase: 'subscribing' } })
    try {
      const cmdId = socket.subscribeFarm(farmId, version)
      pendingSubscriptionsRef.current[cmdId] = { farmId, version }
    } catch {
      dispatch({ type: 'farmSubscription', subscription: { farmId, phase: 'failed' } })
    }
  }, [socket])

  const loadSnapshot = useCallback(async (farmId?: string) => {
    const requestedFarmId = farmId ?? stateRef.current.session?.farmId
    desiredFarmIdRef.current = requestedFarmId
    const requestId = ++snapshotRequestRef.current
    acceptEventsRef.current = false
    dispatch({ type: 'sync', sync: 'loading' })
    try {
      const snapshot = await api.snapshot(farmId)
      if (requestId !== snapshotRequestRef.current) return snapshot
      dispatch({ type: 'snapshot', snapshot })
      activeFarmRef.current = { farmId: snapshot.farm_id, version: snapshot.version }
      if (socket.isOpen) subscribeFarm(snapshot.farm_id, snapshot.version)
      else dispatch({ type: 'farmSubscription', subscription: { farmId: snapshot.farm_id, phase: 'idle' } })
      return snapshot
    } catch (error) {
      dispatch({ type: 'sync', sync: 'stale' })
      const apiError = error as ApiError
      notify(errorMessage(apiError.code, apiError.message), 'error')
      throw error
    }
  }, [api, notify, socket, subscribeFarm])
  refreshSnapshotRef.current = () => {
    if (resyncingRef.current) return
    resyncingRef.current = true
    void loadSnapshot(activeFarmRef.current?.farmId ?? desiredFarmIdRef.current).finally(() => { resyncingRef.current = false })
  }
  syncOnOpenRef.current = () => {
    const current = activeFarmRef.current
    const desired = desiredFarmIdRef.current
    if (!socketOpenedRef.current && current && (!desired || current.farmId === desired)) {
      socketOpenedRef.current = true
      subscribeFarm(current.farmId, current.version)
      return
    }
    socketOpenedRef.current = true
    void Promise.all([
      loadSnapshot(desired),
      refreshPlayerAssets(),
      refreshMailboxSummary(),
    ]).catch(() => undefined)
  }

  const retryFarmSubscription = useCallback(async () => {
    const farmId = desiredFarmIdRef.current ?? activeFarmRef.current?.farmId
    if (!farmId) return
    if (!socket.isOpen) {
      socket.reconnect()
      return
    }
    await loadSnapshot(farmId)
  }, [loadSnapshot, socket])

  const establishSession = useCallback(async (session: AuthSession) => {
    api.setSession(session)
    saveSession(session)
    if (session.displayName) localStorage.setItem(PROFILE_NAME_KEY, session.displayName)
    await Promise.all([loadSnapshot(session.farmId), refreshPlayerAssets(), refreshMailboxSummary()])
    socket.connect(session.accessToken)
    return session
  }, [api, loadSnapshot, refreshMailboxSummary, refreshPlayerAssets, saveSession, socket])

  const login = useCallback(async (username: string, password: string) => {
    try {
      return await establishSession(await api.passwordLogin(username.trim().toLowerCase(), password))
    } catch (error) {
      const apiError = error as ApiError
      notify(errorMessage(apiError.code, apiError.message), 'error')
      throw error
    }
  }, [api, establishSession, notify])

  const register = useCallback(async (username: string, password: string, displayName: string) => {
    try {
      return await establishSession(await api.register(username.trim().toLowerCase(), password, displayName.trim()))
    } catch (error) {
      const apiError = error as ApiError
      notify(errorMessage(apiError.code, apiError.message), 'error')
      throw error
    }
  }, [api, establishSession, notify])

  const logout = useCallback(async () => {
    socket.disconnect()
    socketOpenedRef.current = false
    pendingSubscriptionsRef.current = {}
    acceptEventsRef.current = false
    dispatch({ type: 'farmSubscription', subscription: { farmId: null, phase: 'idle' } })
    if (assetRefreshTimerRef.current !== null) window.clearTimeout(assetRefreshTimerRef.current)
    assetRefreshTimerRef.current = null
    setHasPet(null)
    setAutoHarvestEnabled(null)
    setPetHarvests([])
    try { await api.logout() } catch { saveSession(null) }
    dispatch({ type: 'notice', notice: null })
  }, [api, saveSession, socket])

  const farmCommand = useCallback((method: string, plotId: number, body: Record<string, unknown> = {}) => {
    const farm = stateRef.current.farm
    if (!farm || stateRef.current.socketPhase !== 'open') return notify('实时连接尚未就绪', 'error')
    if (stateRef.current.farmSubscription.phase !== 'live' || stateRef.current.farmSubscription.farmId !== farm.farm_id) {
      return notify('当前农场仅可查看，暂时不能操作', 'info')
    }
    if (Object.values(stateRef.current.pending).includes(plotId)) return
    if (!hasCommandInventory(method, stateRef.current.playerEconomy?.inventory ?? [], String(body.seed_item_id ?? 'WHEAT'))) {
      notify('种子不足，请先去种子商店购买', 'info')
      return
    }
    try {
      const cmdId = socket.command(method, farm.farm_id, farm.version, { plot_id: plotId, ...body })
      pendingMethodsRef.current[cmdId] = method
      dispatch({
        type: 'pendingAdd',
        cmdId,
        plotId,
        clientSeq: socket.sequence,
        optimisticPatch: optimisticPlotPatch(method, plotId, body),
        inventoryDelta: optimisticInventoryDelta(method, farm.plots.find((plot) => plot.plot_id === plotId), body),
      })
      ackTimers.current[cmdId] = window.setTimeout(() => {
        delete pendingMethodsRef.current[cmdId]
        dispatch({ type: 'pendingRemove', cmdId })
        notify('确认超时，结果未知，正在刷新农场', 'error')
        refreshSnapshotRef.current()
        schedulePlayerAssetsRefresh()
      }, 8000)
    } catch (error) {
      notify(error instanceof Error ? error.message : '命令发送失败', 'error')
    }
  }, [notify, schedulePlayerAssetsRefresh, socket])

  const shopTrade = useCallback(async (kind: 'buy' | 'sell', cropId: CropId, quantity: number) => {
    const amount = Math.max(1, Math.floor(quantity))
    const crop = cropDefinition(cropId)
    const optimistic = kind === 'buy'
      ? { coin: -crop.seedPrice * amount, itemType: 'SEED', itemId: crop.itemId, quantity: amount }
      : { coin: crop.sellPrice * amount, itemType: 'CROP', itemId: crop.itemId, quantity: -amount }
    dispatch({ type: 'economyDelta', ...optimistic })
    try {
      const result = await (kind === 'buy' ? api.purchase(crop.id, amount) : api.sell(crop.id, amount))
      dispatch({ type: 'economyConfirm', coinBalance: result.coin_balance })
      farmAudio.play(kind)
      schedulePlayerAssetsRefresh()
    } catch (error) {
      dispatch({
        type: 'economyDelta',
        coin: -optimistic.coin,
        itemType: optimistic.itemType,
        itemId: optimistic.itemId,
        quantity: -optimistic.quantity,
      })
      schedulePlayerAssetsRefresh()
      throw error
    }
  }, [api, schedulePlayerAssetsRefresh])

  const exportDebug = useCallback(() => {
    const safe = { ...stateRef.current, session: stateRef.current.session ? { userId: stateRef.current.session.userId, farmId: stateRef.current.session.farmId } : null }
    const blob = new Blob([JSON.stringify(safe, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `farm-debug-${Date.now()}.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }, [])

  useEffect(() => {
    let cancelled = false
    const restore = async () => {
      const session = stateRef.current.session
      if (session) api.setSession(session)

      if (!session || cancelled) return
      await Promise.all([loadSnapshot(session.farmId), refreshPlayerAssets(), refreshMailboxSummary()])
      if (!cancelled && stateRef.current.session?.userId === session.userId) {
        socket.connect(await api.realtimeAccessToken())
      }
    }
    void restore().catch(() => undefined)
    return () => { cancelled = true; socket.disconnect() }
  }, []) // restore once on first mount

  useEffect(() => {
    const reconcileMailbox = () => {
      if (!document.hidden && stateRef.current.session) void refreshMailboxSummary().catch(() => undefined)
    }
    document.addEventListener('visibilitychange', reconcileMailbox)
    return () => document.removeEventListener('visibilitychange', reconcileMailbox)
  }, [refreshMailboxSummary])

  useEffect(() => {
    if (!state.session) {
      setHasPet(null)
      setAutoHarvestEnabled(null)
      setPetHarvests([])
      return
    }
    let cancelled = false
    void api.petStatus()
      .then((result) => {
        if (!cancelled) {
          setHasPet(result.has_pet)
          setAutoHarvestEnabled(result.has_pet ? result.auto_harvest_enabled : null)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHasPet(null)
          setAutoHarvestEnabled(null)
        }
      })
    return () => { cancelled = true }
  }, [api, state.session?.userId])

  useEffect(() => {
    if (!state.session || hasPet !== true || autoHarvestEnabled !== true) return

    const reconcile = async () => {
      const nowMs = Date.now()
      const current = stateRef.current
      const farm = current.farm
      if (document.hidden || petReconcilingRef.current || nowMs < petReconcileAfterRef.current) return
      if (!farm || farm.farm_id !== current.session?.farmId || Object.keys(current.pending).length > 0) return
      if (!farm.plots.some((plot) => withEffectiveGrowthStage(plot, nowMs).growth_stage === 'MATURE')) return

      petReconcilingRef.current = true
      try {
        const snapshot = await api.snapshot()
        const latest = stateRef.current
        const latestFarm = latest.farm
        if (!latestFarm || latestFarm.farm_id !== latest.session?.farmId || Object.keys(latest.pending).length > 0) return
        if (BigInt(snapshot.version) <= BigInt(latestFarm.version)) {
          petReconcileAfterRef.current = Date.now() + 5_000
          return
        }

        const cues = detectPetHarvestsFromSnapshot({
          hasPet: hasPetRef.current === true,
          autoHarvestEnabled: true,
          farm: latestFarm,
          snapshot,
          ownFarmId: latest.session?.farmId,
          pendingPlotIds: Object.values(latest.pending),
          nowMs: Date.now(),
        })
        if (cues.length > 0) {
          petReconcileAfterRef.current = Date.now() + 25_000
          setPetHarvests((currentCues) => {
            const known = new Set(currentCues.map((cue) => cue.eventId))
            return [...currentCues, ...cues.filter((cue) => !known.has(cue.eventId))].slice(-12)
          })
          schedulePlayerAssetsRefresh()
        } else {
          petReconcileAfterRef.current = Date.now() + 5_000
        }
        activeFarmRef.current = { farmId: snapshot.farm_id, version: snapshot.version }
        dispatch({ type: 'snapshot', snapshot })
        if (socket.isOpen) subscribeFarm(snapshot.farm_id, snapshot.version)
      } catch {
        // Realtime remains the primary path. A failed quiet check must not add a
        // loading state or toast; the next interval retries after services recover.
        petReconcileAfterRef.current = Date.now() + 8_000
      } finally {
        petReconcilingRef.current = false
      }
    }

    const timer = window.setInterval(() => { void reconcile() }, 1500)
    return () => window.clearInterval(timer)
  }, [api, autoHarvestEnabled, hasPet, schedulePlayerAssetsRefresh, socket, state.session?.farmId, subscribeFarm])

  return <AppContext.Provider value={{ state, api, login, register, logout, loadSnapshot, retryFarmSubscription, refreshPlayerAssets, refreshMailboxSummary, farmCommand, shopTrade, hasPet, autoHarvestEnabled, refreshPetStatus, purchasePet, setPetAutoHarvest, petHarvests, completePetHarvest, notify, reconnectSocket: () => socket.reconnect(), disconnectSocket: () => socket.disconnect(), exportDebug }}>{children}</AppContext.Provider>
}

export function optimisticPlotPatch(method: string, plotId: number, body: Record<string, unknown>, nowMs = Date.now()): PlotPatch | undefined {
  if (method === 'farm.Plant') {
    const crop = cropDefinition(String(body.seed_item_id ?? 'WHEAT'))
    return {
      plot_id: plotId,
      state: 'GROWING',
      crop_id: crop.id,
      growth_stage: 'SEEDLING',
      planted_at: new Date(nowMs).toISOString(),
      mature_at: new Date(nowMs + crop.growthMinutes * 60 * 1000).toISOString(),
      remaining_yield: crop.harvestYield,
    }
  }
  if (method === 'farm.Harvest') return { plot_id: plotId, state: 'EMPTY', crop_id: '', growth_stage: '' }
  return undefined
}

export function hasCommandInventory(method: string, inventory: Array<{ item_type: string; item_id: string; quantity: number }>, cropId = 'WHEAT') {
  if (method !== 'farm.Plant') return true
  return cropInventoryCount(inventory, 'SEED', cropDefinition(cropId)) > 0
}

function optimisticInventoryDelta(method: string, plot?: FarmSnapshot['plots'][number], body: Record<string, unknown> = {}) {
  const crop = cropDefinition(method === 'farm.Plant' ? String(body.seed_item_id ?? 'WHEAT') : plot?.crop_id)
  if (method === 'farm.Plant') return { itemType: 'SEED', itemId: crop.itemId, quantity: -1 }
  if (method === 'farm.Harvest') return { itemType: 'CROP', itemId: crop.itemId, quantity: plot?.remaining_yield ?? plot?.yield ?? crop.harvestYield }
  if (method === 'farm.StealCrop') return { itemType: 'CROP', itemId: crop.itemId, quantity: 1 }
  return undefined
}

export function useApp() {
  const value = useContext(AppContext)
  if (!value) throw new Error('useApp must be used under AppProvider')
  return value
}

import { forwardRef, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react'
import { Navigate, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import type { CatalogUnlock, Friend, InventoryItem, Mail, PlotView, Task } from '../api/contract'
import { ApiError, type HttpLog } from '../api/api-client'
import { errorMessage, withEffectiveGrowthStage } from '../api/contract'
import { farmAudio, type AudioPreferences, type FarmSound } from '../audio/farm-audio'
import type { WsLog } from '../realtime/farm-socket'
import { countdownSeconds } from './countdown'
import { buildInvitePath, buildInviteUrl, normalizeInviteCode, PENDING_INVITE_CODE_KEY, postAuthPath, safeInternalPath } from './invite-flow'
import { useApp } from './providers'
import { CROPS, cropDefinition, cropInventoryCount, cropMatureAsset, cropSeedAsset, cropStageAsset, EMPTY_PLOT_ASSET, findCropDefinition, type CropDefinition, type CropId } from './crops'

type Panel = 'tasks' | 'mail' | 'friends' | 'catalog' | 'shop' | 'pet' | 'debug' | null
type FarmTool = 'inspect' | 'plant' | 'water' | 'harvest'

const panelCache = new Map<string, unknown>()

function panelCacheKey(userId: string | undefined, panel: Exclude<Panel, null>) {
  return `${userId ?? 'anonymous'}:${panel}`
}

function readPanelCache<T>(key: string): T | null {
  return (panelCache.get(key) as T | undefined) ?? null
}

function writePanelCache<T>(key: string, value: T) {
  panelCache.set(key, value)
  return value
}

function useDelayedFlag(active: boolean, delayMs = 280) {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (!active) {
      setVisible(false)
      return
    }
    const timer = window.setTimeout(() => setVisible(true), delayMs)
    return () => window.clearTimeout(timer)
  }, [active, delayMs])
  return active && visible
}

export function App() {
  const { state } = useApp()
  const ownFarmPath = state.session ? `/u/${state.session.userId}/farm` : '/login'
  return (
    <Routes>
      <Route path="/login" element={<LoginRoute />} />
      <Route path="/invite" element={<InvitePage />} />
      <Route path="/farm" element={<Navigate to={ownFarmPath} replace />} />
      <Route path="/u/:userId/farm" element={state.session ? <OwnFarmRoute /> : <Navigate to="/login" replace />} />
      <Route path="/farm/:farmId" element={state.session ? <FarmPage /> : <Navigate to="/login" replace />} />
      <Route path="*" element={<Navigate to={ownFarmPath} replace />} />
    </Routes>
  )
}

function pendingInviteCode() {
  try {
    return normalizeInviteCode(sessionStorage.getItem(PENDING_INVITE_CODE_KEY) ?? '')
  } catch {
    return ''
  }
}

function savePendingInviteCode(code: string) {
  try { sessionStorage.setItem(PENDING_INVITE_CODE_KEY, code) } catch { /* storage may be unavailable */ }
}

function clearPendingInviteCode() {
  try { sessionStorage.removeItem(PENDING_INVITE_CODE_KEY) } catch { /* storage may be unavailable */ }
}

function LoginRoute() {
  const { state } = useApp()
  const [params] = useSearchParams()
  if (!state.session) return <LoginPage />
  const ownFarmPath = `/u/${state.session.userId}/farm`
  return <Navigate to={postAuthPath(pendingInviteCode(), params.get('redirect'), ownFarmPath)} replace />
}

function OwnFarmRoute() {
  const { userId } = useParams()
  const { state } = useApp()
  if (!state.session) return <Navigate to="/login" replace />
  if (userId !== state.session.userId) return <Navigate to={`/u/${state.session.userId}/farm`} replace />
  return <FarmPage />
}

function LoginPage() {
  const { login, register } = useApp()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [pending, setPending] = useState(false)
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [formError, setFormError] = useState('')

  const enter = async () => {
    const normalizedUsername = username.trim().toLowerCase()
    if (!/^[a-z0-9_]{4,32}$/.test(normalizedUsername)) {
      setFormError('农场名需要 4–32 位，只能使用英文、数字和下划线')
      return
    }
    if (password.length < 8 || password.length > 128) {
      setFormError('密码至少 8 个字符')
      return
    }
    if (mode === 'register' && password !== confirmPassword) {
      setFormError('两次输入的密码不一致')
      return
    }
    setFormError('')
    setPending(true)
    try {
      const session = mode === 'register'
        ? await register(normalizedUsername, password, normalizedUsername)
        : await login(normalizedUsername, password)
      navigate(postAuthPath(pendingInviteCode(), params.get('redirect'), `/u/${session.userId}/farm`), { replace: true })
    } catch (error) {
      const apiError = error as ApiError
      setFormError(errorMessage(apiError.code, apiError.message))
    } finally { setPending(false) }
  }
  const switchMode = (next: 'login' | 'register') => { setMode(next); setFormError(''); setPassword(''); setConfirmPassword('') }
  return (
    <main className="login-page">
      <div className="sun" />
      <div className="login-clouds" aria-hidden="true"><i /><i /><i /></div>
      <div className="login-audio"><AudioControls /></div>
      <section className="login-card">
        <div className="brand-mark" aria-hidden="true"><img src={cropMatureAsset(CROPS[0])} alt="" /></div>
        <p className="eyebrow">WELCOME HOME</p>
        <h1>麦穗农场</h1>
        <p className="login-copy">播下四季的种子，收获属于你的田园时光。</p>
        <div className="login-crops" aria-hidden="true">{CROPS.map((crop) => <span key={crop.id}><CropArtwork crop={crop} /></span>)}</div>
        <div className="auth-tabs"><button className={mode === 'login' ? 'active' : ''} onClick={() => switchMode('login')}>登录</button><button className={mode === 'register' ? 'active' : ''} onClick={() => switchMode('register')}>注册新农场</button></div>
        <label className="field-label" htmlFor="username">农场名</label>
        <input id="username" value={username} maxLength={32} autoComplete="username" placeholder="英文、数字或下划线" onChange={(e) => { setUsername(e.target.value); setFormError('') }} />
        <label className="field-label" htmlFor="password">密码</label>
        <input id="password" type="password" value={password} maxLength={128} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} placeholder="至少 8 个字符" onChange={(e) => { setPassword(e.target.value); setFormError('') }} onKeyDown={(e) => { if (e.key === 'Enter' && mode === 'login') void enter() }} />
        {mode === 'register' && <><label className="field-label" htmlFor="confirm-password">确认密码</label><input id="confirm-password" type="password" value={confirmPassword} maxLength={128} autoComplete="new-password" placeholder="再次输入密码" onChange={(e) => { setConfirmPassword(e.target.value); setFormError('') }} onKeyDown={(e) => { if (e.key === 'Enter') void enter() }} /></>}
        {formError && <p className="field-error" role="alert">{formError}</p>}
        <button className="primary big" onClick={enter} disabled={pending}>{pending ? '正在连接农场…' : mode === 'login' ? '登录并进入农场' : '注册并创建农场'}</button>
        <small>{mode === 'login' ? '使用农场名和密码继续经营。' : '农场名将同时用于登录和游戏内展示。'}</small>
      </section>
      <div className="login-hills" aria-hidden="true"><span>🌳</span><span>🏡</span><span>🌲</span></div>
    </main>
  )
}

function InvitePage() {
  const { state, api, notify } = useApp()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const [status, setStatus] = useState('准备接受邀请…')
  const processingCodeRef = useRef('')
  const queryCode = normalizeInviteCode(params.get('code') ?? '')
  const code = queryCode || pendingInviteCode()
  useEffect(() => {
    let active = true
    void (async () => {
      try {
        if (!code) throw new Error('邀请链接缺少 code')
        if (processingCodeRef.current === code) return
        processingCodeRef.current = code
        const session = state.session
        savePendingInviteCode(code)
        if (!session) {
          setStatus('请先登录，登录后将自动接受邀请…')
          const redirect = buildInvitePath(code)
          navigate(`/login?redirect=${encodeURIComponent(redirect)}`, { replace: true })
          return
        }
        setStatus('正在加入好友农场…')
        const before = await api.friends()
        setStatus('正在确认跨分片好友关系…')
        const result = await api.acceptInviteAndWait(code, before.friends.map((friend) => friend.user_id))
        if (active) {
          clearPendingInviteCode()
          notify(result.confirmed ? '已成为好友' : '邀请已接受，好友关系仍在同步', result.confirmed ? 'success' : 'info')
          if (result.confirmed && result.friend) {
            navigate(`/farm/${result.friend.user_id}`, { replace: true, state: { friendDisplayName: result.friend.display_name } })
          } else {
            navigate(`/u/${session.userId}/farm`, { replace: true })
          }
        }
      } catch (error) {
        processingCodeRef.current = ''
        if (active) setStatus(error instanceof Error ? error.message : '邀请处理失败')
      }
    })()
    return () => { active = false }
  }, [api, code, navigate, notify, state.session])
  return <main className="center-page"><div className="paper-card"><div className="spinner" /><h1>{status}</h1></div></main>
}

function FarmPage() {
  const { farmId } = useParams()
  const { state, loadSnapshot, retryFarmSubscription, farmCommand, logout, hasPet, petHarvests, completePetHarvest, notify } = useApp()
  const navigate = useNavigate()
  const location = useLocation()
  const visitDisplayName = typeof location.state?.friendDisplayName === 'string'
    ? location.state.friendDisplayName.trim()
    : ''
  const fieldRef = useRef<HTMLElement>(null)
  const toolCursorRef = useRef<HTMLDivElement>(null)
  const fieldPointerRef = useRef<{ clientX: number; clientY: number; pointerType: string } | null>(null)
  const pointerInsideFieldRef = useRef(false)
  const [selected, setSelected] = useState<number | null>(null)
  const [equippedTool, setEquippedTool] = useState<FarmTool>('inspect')
  const [toolCursorVisible, setToolCursorVisible] = useState(false)
  const [toolDragging, setToolDragging] = useState(false)
  const [panel, setPanel] = useState<Panel>(null)
  const [now, setNow] = useState(Date.now())
  const [ghostPlotId, setGhostPlotId] = useState<number | null>(null)
  const [selectedCropId, setSelectedCropId] = useState<CropId>('WHEAT')
  const [actionFx, setActionFx] = useState<{ plotId: number; sound: FarmSound } | null>(null)
  const isFriend = Boolean(farmId)
  const farm = state.farm
  const petHarvest = isFriend ? undefined : petHarvests[0]

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (farmId) void loadSnapshot(farmId).catch(() => navigate('/farm'))
    else if (state.session && farm?.farm_id !== state.session.farmId) void loadSnapshot()
  }, [farmId, location.key])

  const displayPlots = useMemo(() => {
    const plots = farm?.plots ?? []
    if (plots.length > 0) {
      return plots
        .map((plot) => withEffectiveGrowthStage(plot, now))
        .sort((a, b) => a.plot_id - b.plot_id)
    }
    return Array.from({ length: 12 }, (_, plotId) => ({ plot_id: plotId, status: 'EMPTY' } as PlotView))
  }, [farm?.plots, now])
  if (!farm) return <main className="center-page"><div className="paper-card"><div className="spinner" /><h2>正在整理田地…</h2></div></main>
  const selectedPlot = displayPlots.find((plot) => plot.plot_id === selected) ?? displayPlots[0]
  const subscriptionPhase = state.farmSubscription.farmId === farm.farm_id ? state.farmSubscription.phase : 'idle'
  const viewerFull = isFriend && subscriptionPhase === 'full'
  const connected = state.socketPhase === 'open' && farm.sync === 'synced' && subscriptionPhase === 'live'
  const selectedCrop = cropDefinition(selectedCropId)
  const playerEconomy = state.playerEconomy
  const farmDisplayName = isFriend
    ? visitDisplayName || farm.owner_display_name
    : farm.owner_display_name?.trim() || state.session?.displayName?.trim()
  const performOnPlot = (plot: PlotView) => {
    setSelected(plot.plot_id)
    if (equippedTool === 'inspect') {
      farmAudio.play('select')
      return
    }
    const action = toolActionFor(plot, equippedTool, isFriend, selectedCrop)
    if (!action) {
      farmAudio.play('error')
      notify(toolMismatchMessage(equippedTool, plot, isFriend), 'info')
      return
    }
    if (!connected) {
      notify('农场正在重新连接，请稍后再操作', 'info')
      return
    }
    if (Object.values(state.pending).includes(plot.plot_id)) return
    const seedCount = cropInventoryCount(playerEconomy?.inventory ?? [], 'SEED', selectedCrop)
    if (action.method === 'farm.Plant' && seedCount <= 0) {
      notify('仓库里没有种子，先去补充一袋吧', 'info')
      openPanel('shop')
      return
    }
    const sound = actionSound(action.method)
    farmAudio.play(sound)
    setActionFx({ plotId: plot.plot_id, sound })
    window.setTimeout(() => setActionFx((current) => current?.plotId === plot.plot_id ? null : current), 850)
    farmCommand(action.method, plot.plot_id, action.method === 'farm.Plant' ? { seed_item_id: selectedCrop.id } : {})
  }
  const openPanel = (next: Exclude<Panel, null>) => {
    farmAudio.play('open')
    setPanel(next)
  }
  const equipTool = (tool: FarmTool, cropId?: CropId) => {
    if (cropId) setSelectedCropId(cropId)
    setEquippedTool(tool)
    const pointer = fieldPointerRef.current
    const shouldShowCursor = tool !== 'inspect' && pointerInsideFieldRef.current && pointer?.pointerType !== 'touch'
    setToolCursorVisible(shouldShowCursor)
    if (shouldShowCursor && pointer) positionToolCursor(pointer.clientX, pointer.clientY)
    farmAudio.play('select')
  }
  const positionToolCursor = (clientX: number, clientY: number) => {
    const bounds = fieldRef.current?.getBoundingClientRect()
    if (!bounds) return
    toolCursorRef.current?.style.setProperty('transform', `translate3d(${clientX - bounds.left}px, ${clientY - bounds.top}px, 0)`)
  }
  const trackToolCursor = (event: ReactPointerEvent<HTMLElement>) => {
    fieldPointerRef.current = { clientX: event.clientX, clientY: event.clientY, pointerType: event.pointerType }
    pointerInsideFieldRef.current = true
    positionToolCursor(event.clientX, event.clientY)
    if (event.pointerType !== 'touch' && equippedTool !== 'inspect') setToolCursorVisible(true)
  }
  const leaveToolCursor = () => {
    pointerInsideFieldRef.current = false
    setToolCursorVisible(false)
  }

  return (
    <main className="app-shell">
      <div className="farm-atmosphere" aria-hidden="true"><i className="cloud cloud-a" /><i className="cloud cloud-b" /><i className="cloud cloud-c" /><span className="distant-hill hill-a" /><span className="distant-hill hill-b" /></div>
      <header className="game-hud">
        <button className="player-plaque" onClick={() => navigate(`/u/${state.session?.userId}/farm`)}>
          <span className="player-avatar"><img src={cropMatureAsset(CROPS[0])} alt="" /></span>
          <span><small>{isFriend ? '正在拜访' : '我的农场'}</small><strong>{farmDisplayName || '农场主'}</strong></span>
        </button>
        <div className="hud-resources">
          <span className="resource-pill coin-resource"><i>●</i><small>金币</small><b>{playerEconomy?.coin_balance ?? '—'}</b></span>
          <span className={`resource-pill connection-resource ${viewerFull ? 'full' : state.socketPhase}`}><i /><small>农场状态</small><b>{viewerFull ? '只读参观' : subscriptionPhase === 'subscribing' ? '进入中' : phaseLabel(state.socketPhase)}</b></span>
          <span className="resource-pill ambience-resource"><i>☀</i><small>田园时光</small><b>晨光正好</b></span>
        </div>
        <div className="hud-actions">
          {import.meta.env.DEV && <button className="hud-debug-button" onClick={() => openPanel('debug')} title="联调设置" aria-label="打开联调设置"><svg viewBox="0 0 28 28" aria-hidden="true"><path d="M6 8h16M6 14h16M6 20h16" /><circle cx="11" cy="8" r="2.5" /><circle cx="18" cy="14" r="2.5" /><circle cx="9" cy="20" r="2.5" /></svg></button>}
          <AudioControls />
        </div>
      </header>

      {viewerFull && <section className="viewer-limit-banner" role="status">
        <div className="viewer-limit-icon" aria-hidden="true">🌾</div>
        <div>
          <strong>农场里有点挤</strong>
          <p>当前参观人数已满。你看到的是刚刚获取的农场快照，暂时不会自动更新。</p>
        </div>
        <button className="secondary" onClick={() => void retryFarmSubscription()}>看看有没有空位</button>
      </section>}

      <section className="farm-game-stage">
        <div className="farm-name-ribbon">
          <p>{isFriend ? 'FRIEND FARM' : 'SUNNY FARM'}</p>
          <h1>{isFriend ? `${farmDisplayName}的农场` : `${farmDisplayName || '农场主'}的小农场`}</h1>
          <span>{isFriend ? '看看好友今天种了什么' : '风吹麦浪，今天也宜播种'}</span>
        </div>
        <section className={`field-card game-field tool-${equippedTool} ${toolCursorVisible ? 'tool-cursor-visible' : ''} ${toolDragging ? 'tool-dragging' : ''}`} ref={fieldRef} onPointerMove={trackToolCursor} onPointerEnter={trackToolCursor} onPointerLeave={leaveToolCursor}>
          {isFriend && <button className="farm-home-sign" onClick={() => navigate(`/u/${state.session?.userId}/farm`)} aria-label="回到我的农场"><span>←</span><b>我的农场</b><small>沿小路回家</small></button>}
          <div className="farm-ground-details" aria-hidden="true"><i className="farm-path path-west" /><i className="farm-path path-east" /><i className="farm-path path-south" /><span className="grass-tuft tuft-a" /><span className="grass-tuft tuft-b" /><span className="grass-tuft tuft-c" /><span className="grass-tuft tuft-d" /><span className="wildflower flowers-a">✿</span><span className="wildflower flowers-b">✿</span></div>
          <div className="scene-buildings">
            <button className="scene-building building-shop" onClick={() => openPanel('shop')} aria-label="打开种子商店"><img src="/assets/scene/market-stall.webp" alt="" /><span>种子商店</span></button>
            <button className="scene-building building-tasks" onClick={() => openPanel('tasks')} aria-label="打开任务"><img src="/assets/scene/task-board.webp" alt="" /><span>任务</span></button>
            <button className="scene-building building-friends" onClick={() => openPanel('friends')} aria-label="打开好友农场"><img src="/assets/scene/friend-gate.webp" alt="" /><span>好友农场</span></button>
            <button className="scene-building building-mail" onClick={() => openPanel('mail')} aria-label="打开乡间邮局"><img src="/assets/scene/mailbox.webp" alt="" /><span>乡间邮局</span>{(state.mailboxSummary?.unread_count ?? 0) > 0 && <b className="scene-unread-badge">{(state.mailboxSummary?.unread_count ?? 0) > 99 ? '99+' : state.mailboxSummary?.unread_count}</b>}</button>
          </div>
          <div className="plot-grid">
            {displayPlots.map((plot, index) => {
              const toolAction = toolActionFor(plot, equippedTool, isFriend, selectedCrop)
              return <Plot key={plot.plot_id} ordinal={index + 1} plot={plot} selected={selected !== null && plot.plot_id === selectedPlot?.plot_id} pending={Object.values(state.pending).includes(plot.plot_id)} actionable={Boolean(toolAction)} actionHint={toolAction?.label} equippedTool={equippedTool} now={now} actionFx={actionFx?.plotId === plot.plot_id ? actionFx.sound : undefined} harvestGhost={ghostPlotId === plot.plot_id} harvestGhostCropId={petHarvest?.plotId === plot.plot_id ? petHarvest.cropId : undefined} onClick={() => performOnPlot(plot)} onDrop={(event) => { event.preventDefault(); setToolDragging(false); performOnPlot(plot) }} />
            })}
          </div>
          <div className="field-landmark" aria-hidden="true"><img src="/assets/decor/hay-bales.png" alt="" /><img src="/assets/decor/seed-sacks.png" alt="" /></div>
          <div className="field-fence" aria-hidden="true"><img src="/assets/decor/fence.png" alt="" /><img src="/assets/decor/fence.png" alt="" /><img src="/assets/decor/fence.png" alt="" /></div>
          {hasPet === true && !isFriend && <FarmPet key={petHarvest?.eventId ?? 'pet-idle'} fieldRef={fieldRef} cue={petHarvest} onGhostPlot={setGhostPlotId} onComplete={completePetHarvest} />}
          <FarmToolCursor ref={toolCursorRef} tool={equippedTool} crop={selectedCrop} />
          <FarmToolPalette tool={equippedTool} selectedCrop={selectedCrop} inventory={playerEconomy?.inventory ?? []} friend={isFriend} onEquip={equipTool} onDragChange={setToolDragging} />
        </section>
      </section>

      <nav className="game-toolbelt" aria-label="农场工具栏">
        <button className="toolbelt-inventory" onClick={() => openPanel('catalog')}><img src="/assets/scene/warehouse.webp" alt="" /><span><b>仓库与图鉴</b><small>种子 {inventoryCount(playerEconomy?.inventory ?? [], 'SEED')} · 收获 {inventoryCount(playerEconomy?.inventory ?? [], 'CROP')}</small></span></button>
        <button onClick={() => openPanel('shop')}><img src="/assets/scene/market-stall.webp" alt="" /><span><b>种子商店</b><small>买种子 · 卖作物</small></span></button>
        <button onClick={() => openPanel('friends')}><img src="/assets/scene/friend-gate.webp" alt="" /><span><b>好友</b><small>拜访与邀请</small></span></button>
        <button onClick={() => openPanel('pet')}><img src="/assets/scene/chicken-coop.webp" alt="" /><span><b>农场伙伴</b><small>{hasPet ? '小鸡正在巡田' : '领养自动收获小鸡'}</small></span></button>
        <button className="toolbelt-exit" onClick={logout}><span className="exit-icon">↪</span><span><b>离开农场</b><small>安全退出游戏</small></span></button>
      </nav>

      {panel && <PanelModal panel={panel} onClose={() => { farmAudio.play('close'); setPanel(null) }} />}
      {state.notice && <div className={`toast ${state.notice.tone}`} role="status">{state.notice.text}</div>}
    </main>
  )
}

function CropPicker({ selected, onSelect, inventory, artwork = 'crop' }: { selected: CropId; onSelect: (cropId: CropId) => void; inventory: InventoryItem[]; artwork?: 'crop' | 'seed' }) {
  return <div className="crop-picker" aria-label="选择要播种的作物">{CROPS.map((crop) => {
    const stock = cropInventoryCount(inventory, artwork === 'seed' ? 'SEED' : 'CROP', crop)
    return <button type="button" key={crop.id} className={`crop-${crop.id.toLowerCase()} ${selected === crop.id ? 'active' : ''}`} onClick={() => onSelect(crop.id)}><span>{artwork === 'seed' ? <SeedArtwork crop={crop} /> : <CropArtwork crop={crop} />}</span><b>{crop.shortName}</b><small className={artwork === 'seed' ? 'merchandise-price' : 'merchandise-stock'}>{artwork === 'seed' ? crop.seedPrice : `库存 ${stock}`}</small></button>
  })}</div>
}

function WateringCanIcon({ className = '' }: { className?: string }) {
  return <svg className={className} viewBox="0 0 72 58" aria-hidden="true"><path d="M18 22h31v25c0 6-5 9-15 9S18 53 18 47V22Z" fill="#79aeb0" stroke="#416b70" strokeWidth="3" /><path d="M47 28c10-9 17-11 22-8l-3 7c-5-1-10 1-17 8" fill="#96c6c5" stroke="#416b70" strokeWidth="3" strokeLinejoin="round" /><path d="M20 30C4 24 3 45 18 48" fill="none" stroke="#416b70" strokeWidth="5" strokeLinecap="round" /><path d="M24 17h21v7H24z" fill="#e3ba54" stroke="#765f32" strokeWidth="3" /><path d="M65 27c-1 5-5 7-11 7" fill="none" stroke="#416b70" strokeWidth="3" strokeLinecap="round" /></svg>
}

const FarmToolCursor = forwardRef<HTMLDivElement, { tool: FarmTool; crop: CropDefinition }>(({ tool, crop }, ref) => (
  <div ref={ref} className={`farm-tool-cursor cursor-${tool}`} aria-hidden="true">
    {tool === 'plant' && <span className="cursor-seed"><SeedArtwork crop={crop} /></span>}
    {tool === 'water' && <span className="cursor-watering"><WateringCanIcon /><i>💧</i></span>}
    {tool === 'harvest' && <span className="cursor-basket">🧺</span>}
  </div>
))

function FarmToolPalette({ tool, selectedCrop, inventory, friend, onEquip, onDragChange }: {
  tool: FarmTool
  selectedCrop: CropDefinition
  inventory: InventoryItem[]
  friend: boolean
  onEquip: (tool: FarmTool, cropId?: CropId) => void
  onDragChange: (dragging: boolean) => void
}) {
  const drag = (event: ReactDragEvent<HTMLButtonElement>, nextTool: FarmTool, cropId?: CropId) => {
    onEquip(nextTool, cropId)
    onDragChange(true)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', cropId ? `${nextTool}:${cropId}` : nextTool)
  }
  return <div className="farm-tool-palette" aria-label="农具栏">
    <span className="tool-palette-title">农具</span>
    <button className={tool === 'inspect' ? 'active' : ''} aria-label="查看土地信息" onClick={() => onEquip('inspect')}><b>⌕</b><small>查看</small></button>
    {!friend && CROPS.map((crop) => {
      const count = cropInventoryCount(inventory, 'SEED', crop)
      return <button draggable key={crop.id} className={`seed-tool ${tool === 'plant' && selectedCrop.id === crop.id ? 'active' : ''} ${count <= 0 ? 'empty-stock' : ''}`} aria-label={`装备${crop.shortName}种子，库存 ${count}`} onClick={() => onEquip('plant', crop.id)} onDragStart={(event) => drag(event, 'plant', crop.id)} onDragEnd={() => onDragChange(false)}><SeedArtwork crop={crop} /><small>{crop.shortName}</small><em>{count}</em></button>
    })}
    <button draggable className={tool === 'water' ? 'active' : ''} aria-label="装备浇水壶" onClick={() => onEquip('water')} onDragStart={(event) => drag(event, 'water')} onDragEnd={() => onDragChange(false)}><WateringCanIcon /><small>浇水</small></button>
    <button draggable className={tool === 'harvest' ? 'active' : ''} aria-label={friend ? '装备采摘篮' : '装备收获篮'} onClick={() => onEquip('harvest')} onDragStart={(event) => drag(event, 'harvest')} onDragEnd={() => onDragChange(false)}><b className="basket-tool">🧺</b><small>{friend ? '采摘' : '收获'}</small></button>
    <span className="tool-palette-hint">{tool === 'inspect' ? '点击土地查看状态' : tool === 'plant' ? `移动到空地，点击播种${selectedCrop.shortName}` : tool === 'water' ? '移动到成长作物，点击浇水' : friend ? '移动到成熟作物，点击采摘' : '移动到成熟作物，点击收获'}</span>
  </div>
}

function CropArtwork({ crop, stage = 'MATURE', className = '' }: { crop: CropDefinition; stage?: string; className?: string }) {
  return <img className={`crop-artwork ${className}`.trim()} src={cropStageAsset(crop, stage)} alt="" draggable={false} decoding="async" />
}

function SeedArtwork({ crop, className = '' }: { crop: CropDefinition; className?: string }) {
  return <img className={`seed-artwork ${className}`.trim()} src={cropSeedAsset(crop)} alt="" draggable={false} decoding="async" />
}

function Plot({ plot, ordinal, selected, pending, actionable, actionHint, equippedTool, now, actionFx, harvestGhost, harvestGhostCropId, onClick, onDrop }: { plot: PlotView; ordinal: number; selected: boolean; pending: boolean; actionable: boolean; actionHint?: string; equippedTool: FarmTool; now: number; actionFx?: FarmSound; harvestGhost: boolean; harvestGhostCropId?: string; onClick: () => void; onDrop: (event: ReactDragEvent<HTMLButtonElement>) => void }) {
  const empty = plot.status === 'EMPTY'
  const crop = cropDefinition(harvestGhostCropId ?? plot.crop_id)
  const art = empty ? EMPTY_PLOT_ASSET : cropStageAsset(crop, harvestGhost ? 'MATURE' : plot.growth_stage)
  return (
    <button data-plot-id={plot.plot_id} className={`plot crop-${crop.id.toLowerCase()} ${empty ? 'empty' : 'growing'} ${plot.growth_stage?.toLowerCase() ?? ''} ${selected ? 'selected' : ''} ${pending ? 'syncing' : ''} ${equippedTool !== 'inspect' ? actionable ? 'tool-ready' : 'tool-blocked' : ''} ${actionFx ? `fx-${actionFx}` : ''} ${harvestGhost ? 'pet-harvest-target' : ''}`} onClick={onClick} onDragOver={(event) => { if (actionable) { event.preventDefault(); event.dataTransfer.dropEffect = 'move' } }} onDrop={onDrop} aria-label={`地块 ${ordinal}，${plotTitle(plot)}${equippedTool !== 'inspect' ? actionable ? '，可以使用当前农具' : '，不能使用当前农具' : ''}`} aria-busy={pending}>
      <span className="crop"><img className="plot-artwork" src={art} alt="" draggable={false} decoding="async" /></span>
      {selected && plot.mature_at && plot.growth_stage !== 'MATURE' && <PlotCountdown matureAt={plot.mature_at} now={now} />}
      {actionFx === 'water' && <span className="action-particles water-particles" aria-hidden="true">💧</span>}
      {actionFx === 'plant' && <span className="action-particles earth-particles" aria-hidden="true">✦</span>}
      {(actionFx === 'harvest' || actionFx === 'steal') && <span className="action-particles harvest-particles" aria-hidden="true">✦</span>}
      {equippedTool !== 'inspect' && <span className="plot-tool-hint">{actionable ? actionHint : '换个农具'}</span>}
      <span className="plot-label">{harvestGhost ? '小鸡收获中' : empty ? '空地' : plot.growth_stage === 'MATURE' ? '可以收获' : '生长中'}</span>
    </button>
  )
}

function PlotCountdown({ matureAt, now }: { matureAt: string; now: number }) {
  const seconds = countdownSeconds(matureAt, now)
  return <span className="plot-countdown" role="status"><small>距离成熟</small><b>{Math.floor(seconds / 60).toString().padStart(2, '0')}:{(seconds % 60).toString().padStart(2, '0')}</b></span>
}

function AudioControls() {
  const [preferences, setPreferences] = useState<AudioPreferences>(() => farmAudio.getPreferences())
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => farmAudio.subscribe(setPreferences), [])
  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open])
  return <div className="audio-controls" aria-label="声音设置" ref={rootRef}>
    <button className={`sound-menu-button ${preferences.music || preferences.effects ? 'on' : ''}`} onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-label="调整游戏音量"><span>{preferences.music || preferences.effects ? '🔊' : '🔇'}</span><b>声音</b></button>
    {open && <div className="sound-popover">
      <header><span>🎵</span><div><b>田园声音</b><small>背景音乐与操作反馈</small></div></header>
      <div className="volume-row"><span><b>背景音乐</b><button aria-label={preferences.music ? '关闭背景音乐' : '开启背景音乐'} onClick={() => farmAudio.setMusic(!preferences.music)}>{preferences.music ? '开启' : '静音'}</button></span><input aria-label="背景音乐音量" type="range" min="0" max="100" value={Math.round(preferences.musicVolume * 100)} onChange={(event) => farmAudio.setMusicVolume(Number(event.target.value) / 100)} /><em>{Math.round(preferences.musicVolume * 100)}%</em></div>
      <div className="volume-row"><span><b>操作音效</b><button aria-label={preferences.effects ? '关闭操作音效' : '开启操作音效'} onClick={() => farmAudio.setEffects(!preferences.effects)}>{preferences.effects ? '开启' : '静音'}</button></span><input aria-label="操作音效音量" type="range" min="0" max="100" value={Math.round(preferences.effectsVolume * 100)} onChange={(event) => farmAudio.setEffectsVolume(Number(event.target.value) / 100)} /><em>{Math.round(preferences.effectsVolume * 100)}%</em></div>
    </div>}
  </div>
}

type PetPhase = 'idle' | 'walking' | 'harvesting' | 'returning'

function FarmPet({ fieldRef, cue, onGhostPlot, onComplete }: {
  fieldRef: RefObject<HTMLElement | null>
  cue?: { eventId: string; plotId: number }
  onGhostPlot: (plotId: number | null) => void
  onComplete: (eventId: string) => void
}) {
  const petRef = useRef<HTMLDivElement>(null)
  const [phase, setPhase] = useState<PetPhase>('idle')
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [facing, setFacing] = useState(1)

  useLayoutEffect(() => {
    if (!cue) return
    const field = fieldRef.current
    const pet = petRef.current
    const target = field?.querySelector<HTMLElement>(`[data-plot-id="${cue.plotId}"]`)
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!field || !pet || !target || document.hidden || reducedMotion) {
      onGhostPlot(null)
      onComplete(cue.eventId)
      return
    }

    onGhostPlot(cue.plotId)
    setPhase('idle')
    setOffset({ x: 0, y: 0 })
    const timers: number[] = []
    const frame = window.requestAnimationFrame(() => {
      const petRect = pet.getBoundingClientRect()
      const targetRect = target.getBoundingClientRect()
      const x = targetRect.left + targetRect.width / 2 - (petRect.left + petRect.width / 2)
      const y = targetRect.top + targetRect.height * 0.72 - (petRect.top + petRect.height / 2)
      setFacing(x < 0 ? -1 : 1)
      setPhase('walking')
      setOffset({ x, y })

      timers.push(window.setTimeout(() => setPhase('harvesting'), 900))
      timers.push(window.setTimeout(() => onGhostPlot(null), 1350))
      timers.push(window.setTimeout(() => {
        setPhase('returning')
        setOffset({ x: 0, y: 0 })
      }, 1550))
      timers.push(window.setTimeout(() => {
        setPhase('idle')
        onComplete(cue.eventId)
      }, 2500))
    })

    return () => {
      window.cancelAnimationFrame(frame)
      timers.forEach((timer) => window.clearTimeout(timer))
    }
  }, [cue?.eventId, fieldRef, onComplete, onGhostPlot])

  const style = {
    transform: `translate3d(${offset.x}px, ${offset.y}px, 0)`,
    '--pet-facing': facing,
  } as CSSProperties & { '--pet-facing': number }
  return (
    <div ref={petRef} className={`farm-pet ${phase}`} style={style} aria-label={phase === 'idle' ? '宠物正在休息' : '宠物正在自动收获'}>
      {phase === 'harvesting' && <span className="farm-pet-bubble">收好啦！</span>}
      <span className="farm-pet-character" aria-hidden="true"><img src="/assets/decor/farm-chicken.webp" alt="" draggable={false} decoding="async" /></span>
    </div>
  )
}

function Countdown({ matureAt, now }: { matureAt: string; now: number }) {
  const seconds = countdownSeconds(matureAt, now)
  return <div className="countdown"><span>预计成熟</span><b>{Math.floor(seconds / 60).toString().padStart(2, '0')}:{(seconds % 60).toString().padStart(2, '0')}</b><small>仅供展示，以服务端阶段为准</small></div>
}

function PanelModal({ panel, onClose }: { panel: Exclude<Panel, null>; onClose: () => void }) {
  return <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}><section className={`modal game-panel panel-${panel}`}><button className="close" onClick={onClose} aria-label="关闭">×</button><PanelContent panel={panel} onClose={onClose} /></section></div>
}

function PanelContent({ panel, onClose }: { panel: Exclude<Panel, null>; onClose: () => void }) {
  if (panel === 'shop') return <ShopPanel />
  if (panel === 'tasks') return <TasksPanel />
  if (panel === 'mail') return <MailPanel />
  if (panel === 'friends') return <FriendsPanel onClose={onClose} />
  if (panel === 'catalog') return <CatalogPanel />
  if (panel === 'pet') return <PetPanel />
  return import.meta.env.DEV ? <DebugPanel /> : null
}

function ShopPanel() {
  const { shopTrade, notify, state } = useApp()
  const [mode, setMode] = useState<'buy' | 'sell'>('buy')
  const [trading, setTrading] = useState(false)
  const tradingRef = useRef(false)
  const [buyQuantity, setBuyQuantity] = useState(1)
  const [sellQuantity, setSellQuantity] = useState(1)
  const [selectedCropId, setSelectedCropId] = useState<CropId>('WHEAT')
  const selectedCrop = cropDefinition(selectedCropId)
  const balance = state.playerEconomy?.coin_balance ?? 0
  const cropCount = cropInventoryCount(state.playerEconomy?.inventory ?? [], 'CROP', selectedCrop)
  const quantity = mode === 'buy' ? buyQuantity : sellQuantity
  const normalizedQuantity = Math.max(1, Math.min(10_000, Math.floor(quantity || 1)))
  const changeQuantity = (next: number) => {
    const normalized = Math.max(1, Math.min(999, Math.floor(next || 1)))
    if (mode === 'buy') setBuyQuantity(normalized)
    else setSellQuantity(normalized)
  }
  const act = async (kind: 'buy' | 'sell') => {
    if (tradingRef.current) return
    const amount = kind === 'buy' ? buyQuantity : sellQuantity
    tradingRef.current = true
    setTrading(true)
    try {
      await shopTrade(kind, selectedCrop.id, amount)
      notify(kind === 'buy' ? `买到 ${amount} 袋${selectedCrop.shortName}种子` : `卖出 ${amount} 份${selectedCrop.shortName}`, 'success')
    } catch (e) {
      showApiError(e, notify)
    } finally {
      tradingRef.current = false
      setTrading(false)
    }
  }
  const buyingMode = mode === 'buy'
  const unitPrice = buyingMode ? selectedCrop.seedPrice : selectedCrop.sellPrice
  return <div className="shop-window">
    <section className="shop-marquee">
      <PanelTitle title="种子小铺" subtitle="当季好种，丰收后也欢迎拿回来寄售" />
      <div className="shop-tradebar"><div className="tabs shop-tabs" role="tablist"><button className={buyingMode ? 'active' : ''} role="tab" aria-selected={buyingMode} onClick={() => setMode('buy')}>🌱 种子货架</button><button className={!buyingMode ? 'active' : ''} role="tab" aria-selected={!buyingMode} onClick={() => setMode('sell')}>🧺 收购柜台</button></div><div className="shop-balance"><span>现有金币</span><b><i className="farm-coin" aria-hidden="true" />{balance}</b></div></div>
    </section>
    <div className={`shop-shelf ${buyingMode ? 'seed-shelf' : 'produce-shelf'}`}><span className="shelf-label">{buyingMode ? '本季种子格' : '今日收购格'}</span><CropPicker selected={selectedCrop.id} onSelect={setSelectedCropId} inventory={state.playerEconomy?.inventory ?? []} artwork={buyingMode ? 'seed' : 'crop'} /></div>
    <section className={`shop-order-card crop-${selectedCrop.id.toLowerCase()}`}>
      <div className="shop-product-portrait">{buyingMode ? <SeedArtwork crop={selectedCrop} /> : <CropArtwork crop={selectedCrop} />}<span>{buyingMode ? '精选种子' : '今日收购'}</span></div>
      <div className="shop-product-copy"><small>{buyingMode ? '店主推荐 · 当季好种' : '今日收购 · 新鲜作物'}</small><h3>{buyingMode ? selectedCrop.name : `仓库里的${selectedCrop.shortName}`}</h3><p>{buyingMode ? `${selectedCrop.growthMinutes} 分钟成熟 · 每块预计收获 ${selectedCrop.harvestYield} 份` : `当前库存 ${cropCount} 份 · 新鲜作物按份收购`}</p><strong className="shop-price"><i className="farm-coin" aria-hidden="true" />{unitPrice}<em>/ {buyingMode ? '袋' : '份'}</em></strong></div>
      <div className="shop-stepper"><small>{buyingMode ? '购买数量' : '出售数量'}</small><div><button type="button" aria-label="减少数量" disabled={normalizedQuantity <= 1} onClick={() => changeQuantity(normalizedQuantity - 1)}>−</button><input aria-label={buyingMode ? '购买数量' : '出售数量'} type="number" min="1" max="10000" step="1" value={normalizedQuantity} onChange={(event) => changeQuantity(Number(event.target.value))} /><button type="button" aria-label="增加数量" disabled={normalizedQuantity >= 10_000} onClick={() => changeQuantity(normalizedQuantity + 1)}>＋</button></div><span>{buyingMode ? `最多可买 ${Math.floor(balance / selectedCrop.seedPrice)} 袋` : `最多可卖 ${cropCount} 份`}</span></div>
    </section>
    <button className={`shop-checkout ${buyingMode ? 'buy' : 'sell'}`} disabled={buyingMode ? balance < normalizedQuantity * selectedCrop.seedPrice : cropCount < normalizedQuantity} aria-busy={trading} onClick={() => act(mode)}><span>{trading ? '店主正在清点…' : buyingMode ? '购买种子' : '出售作物'}</span><b>{buyingMode ? `${normalizedQuantity} 袋 · 支付 ${normalizedQuantity * selectedCrop.seedPrice} 金币` : `${normalizedQuantity} 份 · 获得 ${normalizedQuantity * selectedCrop.sellPrice} 金币`}</b></button>
  </div>
}

function CatalogPanel() {
  const { api, notify, state } = useApp()
  const cacheKey = panelCacheKey(state.session?.userId, 'catalog')
  const [unlocks, setUnlocks] = useState<CatalogUnlock[] | null>(() => readPanelCache<CatalogUnlock[]>(cacheKey))
  useEffect(() => {
    void api.catalog().then((result) => setUnlocks(writePanelCache(cacheKey, result.unlocks ?? []))).catch((error) => showApiError(error, notify))
  }, [api, cacheKey, notify])
  if (unlocks === null) return <><PanelTitle icon="📖" title="作物图鉴" subtitle="每次收获，都会留下一页农场记忆" /><DelayedLoading label="正在翻阅图鉴…" /></>

  const entries = CROPS.map((crop) => ({
    crop,
    unlock: unlocks.find((item) => findCropDefinition(item.catalog_key)?.id === crop.id),
  }))
  const unlockedCount = entries.filter((entry) => Boolean(entry.unlock?.unlocked_at)).length
  return <><PanelTitle icon="📖" title="作物图鉴" subtitle="收获作物后由服务端永久解锁" /><div className="catalog-summary"><b>{unlockedCount} / {CROPS.length}</b><span>已发现作物</span></div><div className="catalog-grid">{entries.map(({ crop, unlock }) => {
    const unlocked = Boolean(unlock?.unlocked_at)
    return <article className={`catalog-card crop-${crop.id.toLowerCase()} ${unlocked ? 'unlocked' : 'locked'}`} key={crop.catalogKey}><div className="catalog-art">{unlocked ? <CropArtwork crop={crop} /> : '？'}</div><div><span className="catalog-status">{unlocked ? '已解锁' : '尚未解锁'}</span><h3>{unlocked ? crop.name : '神秘作物'}</h3><p>{unlocked ? crop.description : `亲手收获${crop.shortName}后，它会出现在这里。`}</p>{unlocked && unlock && <time>发现于 {new Date(unlock.unlocked_at).toLocaleDateString()}</time>}</div></article>
  })}</div></>
}

function TasksPanel() {
  const { api, notify, refreshPlayerAssets, state } = useApp()
  const cacheKey = panelCacheKey(state.session?.userId, 'tasks')
  const [tasks, setTasks] = useState<Task[] | null>(() => readPanelCache<Task[]>(cacheKey))
  const [busy, setBusy] = useState('')
  const load = () => api.tasks().then((r) => setTasks(writePanelCache(cacheKey, r.tasks))).catch((e) => showApiError(e, notify))
  useEffect(() => { void load() }, [])
  const claim = async (task: Task) => { setBusy(task.task_key); try { const result = await api.claimTask(task.task_key); notify(`领取 ${result.coin_reward} 金币`, 'success'); await refreshPlayerAssets(); load() } catch (e) { showApiError(e, notify) } finally { setBusy('') } }
  return <><PanelTitle icon="📒" title="任务" subtitle="一点一滴，都是农场的成长" /><ListLoading value={tasks}>{(tasks ?? []).map((task) => <article className="list-card" key={task.task_key}><div><h3>{task.description || task.task_key}</h3><p>{task.progress} / {task.target} · 奖励 🪙 {task.coin_reward}</p><progress value={task.progress} max={task.target || 1} /></div><button className="small-button" disabled={task.status !== 'COMPLETED' || busy === task.task_key} onClick={() => claim(task)}>{task.status === 'CLAIMED' ? '已领取' : busy === task.task_key ? '领取中' : '领取'}</button></article>)}</ListLoading></>
}

function MailPanel() {
  const { api, notify, refreshMailboxSummary, refreshPlayerAssets, state } = useApp()
  const cacheKey = panelCacheKey(state.session?.userId, 'mail')
  const [mails, setMails] = useState<Mail[] | null>(() => readPanelCache<Mail[]>(cacheKey))
  const [busy, setBusy] = useState('')
  const [selectedMailId, setSelectedMailId] = useState('')
  const [markingReadId, setMarkingReadId] = useState('')
  const [markingAllRead, setMarkingAllRead] = useState(false)
  const load = () => Promise.all([api.mails(), refreshMailboxSummary()])
    .then(([r]) => setMails(writePanelCache(cacheKey, r.mails)))
    .catch((e) => showApiError(e, notify))
  useEffect(() => { void load() }, [])
  const markRead = async (mail: Mail) => {
    if (mail.status !== 'UNREAD' || markingReadId || markingAllRead) return
    const mailId = String(mail.mail_id)
    setMarkingReadId(mailId)
    setMails((current) => current?.map((item) => String(item.mail_id) === mailId ? { ...item, status: 'READ' } : item) ?? current)
    farmAudio.play('success')
    try { await api.readMail(mailId); await refreshMailboxSummary(); void load() } catch (e) {
      setMails((current) => current?.map((item) => String(item.mail_id) === mailId ? { ...item, status: 'UNREAD' } : item) ?? current)
      showApiError(e, notify)
    } finally { setMarkingReadId('') }
  }
  const markAllRead = async () => {
    const unread = (mails ?? []).filter((mail) => mail.status === 'UNREAD')
    if (unread.length === 0 || markingReadId || markingAllRead) return
    setMarkingAllRead(true)
    setMails((current) => current?.map((mail) => mail.status === 'UNREAD' ? { ...mail, status: 'READ' } : mail) ?? current)
    farmAudio.play('success')
    const results = await Promise.allSettled(unread.map((mail) => api.readMail(String(mail.mail_id))))
    const failed = results.filter((result) => result.status === 'rejected').length
    await load()
    if (failed === 0) notify(`已将 ${unread.length} 封来信全部标记为已读`, 'success')
    else notify(`${unread.length - failed} 封已读，${failed} 封处理失败，请稍后重试`, 'error')
    setMarkingAllRead(false)
  }
  const open = (mail: Mail) => {
    setSelectedMailId(String(mail.mail_id))
    farmAudio.play('open')
  }
  const claim = async (id: string) => { setBusy(id); try { await api.claimAttachment(id); notify('附件已放入仓库', 'success'); await refreshPlayerAssets(); load() } catch (e) { showApiError(e, notify) } finally { setBusy('') } }
  const selectedMail = (mails ?? []).find((mail) => String(mail.mail_id) === selectedMailId)
  return <>
    <PanelTitle icon="✉️" title="乡间邮局" subtitle="邮差刚把信件送进了农场信箱" />
    {mails === null ? <DelayedLoading label="邮差正在分拣信件…" /> : mails.length === 0 ? <div className="mailbox-empty"><span>📭</span><h3>今天还没有新信</h3><p>等风铃响起时，再来看看吧。</p></div> : <div className="mailbox-layout">
      <aside className="mailbox-inbox">
        <header><span>INBOX</span><b>收件匣</b><em>{mails.filter((mail) => mail.status === 'UNREAD').length} 封未读</em><button className="mail-read-all" type="button" disabled={markingAllRead || Boolean(markingReadId) || mails.every((mail) => mail.status !== 'UNREAD')} onClick={() => void markAllRead()}><i>{markingAllRead ? '···' : '✓'}</i>{markingAllRead ? '盖章中' : '一键已读'}</button></header>
        <div className="mailbox-slots">{mails.map((mail) => <button className={`mail-envelope ${mail.status === 'UNREAD' ? 'unread' : 'read'} ${String(mail.mail_id) === selectedMailId ? 'active' : ''}`} key={String(mail.mail_id)} onClick={() => open(mail)}>
          <span className="mail-seal" aria-label={mail.status === 'UNREAD' ? '未读' : '已读'}>{mail.status === 'UNREAD' ? '●' : '✓'}</span>
          <span className="mail-envelope-copy"><b>{mail.title}</b><small>{mail.content}</small></span>
          <time>{new Date(mail.created_at).toLocaleDateString()}</time>
        </button>)}</div>
      </aside>
      <section className={`mailbox-reading ${selectedMail ? 'has-letter' : ''}`}>
        {!selectedMail ? <div className="mailbox-placeholder"><span>✉</span><h3>选择一封信</h3><p>点击左侧信封，在这里拆阅来信。</p></div> : <article className={`opened-letter ${selectedMail.status === 'UNREAD' ? 'unread' : 'read'}`}>
          <div className="letter-postmark"><span>FARM POST</span><b>✿</b></div>
          <header><small>亲爱的农场主：</small><h3>{selectedMail.title}</h3><time>{new Date(selectedMail.created_at).toLocaleDateString()}</time></header>
          <p>{selectedMail.content}</p>
          <footer><span>乡间邮局 · 顺风送达</span></footer>
          {selectedMail.status === 'UNREAD'
            ? <button className="letter-read-seal unread" type="button" disabled={markingReadId === String(selectedMail.mail_id)} aria-label="盖章并标记为已读" onClick={() => void markRead(selectedMail)}><small>点击</small><b>{markingReadId === String(selectedMail.mail_id) ? '盖章中' : '盖章'}</b></button>
            : <span className="letter-read-seal stamped" aria-label="已阅"><b>已阅</b></span>}
          {(selectedMail.attachments?.length ?? 0) > 0 && <div className="mail-parcel"><b>📦 随信包裹</b>{(selectedMail.attachments ?? []).map((item) => <button key={String(item.attachment_id)} className="attachment" disabled={Boolean(item.claimed_at) || busy === String(item.attachment_id)} onClick={() => void claim(String(item.attachment_id))}>{item.item_type} × {item.quantity}<span>{item.claimed_at ? '已签收' : busy === String(item.attachment_id) ? '拆包中…' : '签收包裹'}</span></button>)}</div>}
        </article>}
      </section>
    </div>}
  </>
}

function FriendsPanel({ onClose }: { onClose: () => void }) {
  const { api, notify, state } = useApp()
  const navigate = useNavigate()
  const cacheKey = panelCacheKey(state.session?.userId, 'friends')
  const [friends, setFriends] = useState<Friend[] | null>(() => readPanelCache<Friend[]>(cacheKey))
  const [code, setCode] = useState('')
  const [created, setCreated] = useState('')
  const [createdPath, setCreatedPath] = useState('')
  const [creating, setCreating] = useState(false)
  const [copied, setCopied] = useState(false)
  const [accepting, setAccepting] = useState(false)
  const load = () => api.friends().then((r) => setFriends(writePanelCache(cacheKey, r.friends))).catch((e) => showApiError(e, notify))
  useEffect(() => { void load() }, [])
  const create = async () => {
    setCreating(true)
    setCopied(false)
    try {
      const result = await api.createInvite()
      setCreated(result.invite_code)
      setCreatedPath(safeInternalPath(result.invite_path ?? '') ?? buildInvitePath(result.invite_code))
    } catch (e) {
      showApiError(e, notify)
    } finally {
      setCreating(false)
    }
  }
  const copyInvite = async () => {
    if (!created) return
    const shareUrl = buildInviteUrl(created, createdPath, window.location.origin)
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(shareUrl)
      } else {
        const copyField = document.createElement('textarea')
        copyField.value = shareUrl
        copyField.setAttribute('readonly', '')
        copyField.style.position = 'fixed'
        copyField.style.opacity = '0'
        document.body.appendChild(copyField)
        copyField.select()
        const copiedWithFallback = document.execCommand('copy')
        copyField.remove()
        if (!copiedWithFallback) throw new Error('copy command unavailable')
      }
      setCopied(true)
      notify('邀请链接已复制，好友打开后会自动加入', 'success')
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      notify('复制失败，请长按邀请链接手动复制', 'error')
    }
  }
  const accept = async () => {
    const normalizedCode = normalizeInviteCode(code, window.location.origin)
    if (!normalizedCode) {
      notify('请输入有效的邀请码或邀请链接', 'error')
      return
    }
    setAccepting(true)
    try {
      const result = await api.acceptInviteAndWait(normalizedCode, (friends ?? []).map((friend) => friend.user_id))
      setFriends(writePanelCache(cacheKey, result.friends))
      setCode('')
      notify(result.confirmed ? '已成为好友' : '邀请已接受；若已是好友无需重复添加，跨分片关系会自动同步', result.confirmed ? 'success' : 'info')
      if (!result.confirmed) window.setTimeout(() => { void load() }, 2000)
    } catch (e) {
      showApiError(e, notify)
    } finally {
      setAccepting(false)
    }
  }
  return <>
    <PanelTitle icon="👥" title="农场好友" subtitle="分享田园的好时光，去好友农场串串门" />
    <section className="friend-invite-card">
      <div className="invite-card-heading">
        <span className="invite-card-icon">✦</span>
        <div><h3>邀请一位新邻居</h3><p>复制专属链接，好友登录后会自动加入</p></div>
      </div>
      {!created ? (
        <button className="primary invite-create-button" disabled={creating} onClick={create}>{creating ? '正在生成…' : '生成专属邀请码'}</button>
      ) : (
        <div className="invite-code-shell">
          <div className="invite-code-copy"><span>邀请链接</span><code title={buildInviteUrl(created, createdPath, window.location.origin)}>{buildInviteUrl(created, createdPath, window.location.origin)}</code></div>
          <button className={`copy-invite-button ${copied ? 'copied' : ''}`} onClick={copyInvite} aria-live="polite"><span>{copied ? '✓' : '⧉'}</span>{copied ? '已复制' : '复制链接'}</button>
          <button className="invite-refresh-button" disabled={creating} onClick={create} aria-label="重新生成邀请码" title="重新生成邀请码">↻</button>
        </div>
      )}
      <div className="invite-divider"><span>或使用好友的邀请码</span></div>
      <div className="invite-accept-form">
        <label htmlFor="friend-invite-code">好友邀请码或邀请链接</label>
        <div className="inline-form"><input id="friend-invite-code" placeholder="粘贴邀请码或完整邀请链接" value={code} onChange={(e) => setCode(e.target.value)} /><button className="small-button" disabled={!code.trim() || accepting} onClick={accept}>{accepting ? '同步中…' : '接受邀请'}</button></div>
      </div>
    </section>
    <div className="friends-list-heading"><div><span>我的邻居</span><small>{friends === null ? '正在清点…' : `${friends.length} 位好友`}</small></div><i /></div>
    <ListLoading value={friends}>{(friends ?? []).map((friend, index) => <article className="list-card friend-card" key={friend.user_id}>
      <div className="neighbor-scenery" aria-hidden="true"><span className="neighbor-house">{index % 3 === 0 ? '🏡' : index % 3 === 1 ? '🏠' : '🛖'}</span><i /></div>
      <div className="friend-avatar">{friend.display_name.trim().slice(0, 1).toUpperCase() || '友'}</div>
      <div className="friend-card-copy"><small>NO. {String(index + 1).padStart(2, '0')} · 田园邻居</small><h3>{friend.display_name} 的农场</h3><p>沿着乡间小路，去 TA 的田里串串门</p></div>
      <button className="small-button friend-visit-button" onClick={() => { onClose(); navigate(`/farm/${friend.user_id}`, { state: { friendDisplayName: friend.display_name } }) }}><span>推开院门</span><b>拜访 →</b></button>
    </article>)}</ListLoading>
  </>
}

function PetPanel() {
  const { state, notify, hasPet, autoHarvestEnabled, refreshPetStatus, purchasePet, setPetAutoHarvest } = useApp()
  const [busy, setBusy] = useState(false)
  const [switching, setSwitching] = useState(false)
  const buy = async () => { setBusy(true); try { await purchasePet(); notify('小鸡搬进农场啦！', 'success') } catch (e) { showApiError(e, notify) } finally { setBusy(false) } }
  const check = async () => { setBusy(true); try { await refreshPetStatus() } catch (e) { showApiError(e, notify) } finally { setBusy(false) } }
  const toggleAutoHarvest = async () => {
    if (autoHarvestEnabled === null) return
    setSwitching(true)
    try {
      await setPetAutoHarvest(!autoHarvestEnabled)
      notify(!autoHarvestEnabled ? '小鸡会自动收获成熟作物了' : '已暂停小鸡自动收获', 'success')
    } catch (error) {
      showApiError(error, notify)
      await refreshPetStatus().catch(() => undefined)
    } finally { setSwitching(false) }
  }
  const balance = state.playerEconomy?.coin_balance ?? 0
  return <><PanelTitle icon="🐣" title="农场伙伴" subtitle="购买小鸡后，可以每 30 秒自动巡查成熟作物" /><div className="pet-stage"><div className="pet-bubble">{busy && hasPet ? '正在搬家，马上就好！' : hasPet ? '咕咕！今天也一起努力吧。' : '给我一个温暖的新家吧？'}</div><div className={`pet-big ${busy && hasPet ? 'arriving' : ''}`}><img src="/assets/decor/farm-chicken.webp" alt="农场小鸡" /></div><h3>{hasPet === null ? '暂时没有查到伙伴状态' : hasPet ? '你的农场小鸡' : '还没有农场伙伴'}</h3>{busy && hasPet && <small className="pet-purchase-note">服务端正在确认购买，伙伴已经先来和你见面了</small>}{hasPet === true && <div className="pet-auto-row"><div><b>自动收获</b><small>{autoHarvestEnabled ? '每 30 秒巡查成熟作物' : '小鸡会留在原位休息'}</small></div><button className={`pet-switch ${autoHarvestEnabled ? 'on' : ''}`} role="switch" aria-checked={Boolean(autoHarvestEnabled)} disabled={busy || switching || autoHarvestEnabled === null} onClick={toggleAutoHarvest}><span /></button></div>}{hasPet === false && <div className="pet-purchase-card"><button className="primary pet-purchase-button" disabled={busy || balance < 200} onClick={buy}>{busy ? '正在迎接…' : '用 200 金币购买小鸡'}</button><small className="pet-balance-note">{balance < 200 ? `现有 ${balance} 金币 · 还差 ${200 - balance} 金币` : `购买后剩余 ${balance - 200} 金币`}</small></div>}{hasPet === null && <button className="secondary" disabled={busy} onClick={check}>{busy ? '查询中…' : '重新查询宠物状态'}</button>}</div></>
}

function DebugPanel() {
  const { state, loadSnapshot, disconnectSocket, reconnectSocket, exportDebug, logout } = useApp()
  const [tab, setTab] = useState<'http' | 'ws'>('http')
  return <><PanelTitle icon="⚙️" title="联调控制台" subtitle="仅开发构建包含；导出内容不会包含 token" /><div className="debug-metrics"><b>{state.session?.userId ?? '—'}<small>USER ID</small></b><b>{state.farm?.farm_id ?? '—'}<small>FARM ID</small></b><b>{state.farm?.version ?? '—'}<small>VERSION</small></b><b>{Object.keys(state.pending).length}<small>PENDING</small></b><b>{state.clientSeq}/{state.serverSeq}<small>CLIENT/SERVER SEQ</small></b></div><div className="button-row wrap"><button className="secondary" onClick={() => void loadSnapshot()}>强制拉 Snapshot</button><button className="secondary" onClick={disconnectSocket}>断开 WS</button><button className="secondary" onClick={reconnectSocket}>重连 WS</button><button className="secondary" onClick={exportDebug}>导出 JSON</button><button className="danger" onClick={logout}>清空本地 token</button></div><div className="tabs"><button className={tab === 'http' ? 'active' : ''} onClick={() => setTab('http')}>HTTP ({state.httpLogs.length})</button><button className={tab === 'ws' ? 'active' : ''} onClick={() => setTab('ws')}>WS ({state.wsLogs.length})</button></div><div className="log-table">{tab === 'http' ? state.httpLogs.map((log) => <HttpRow key={log.id} log={log} />) : state.wsLogs.map((log) => <WsRow key={log.id} log={log} />)}{(tab === 'http' ? state.httpLogs : state.wsLogs).length === 0 && <p className="empty-state">还没有记录</p>}</div></>
}

function HttpRow({ log }: { log: HttpLog }) { return <div><time>{new Date(log.at).toLocaleTimeString()}</time><b>{log.method}</b><span>{log.path}</span><em className={log.status >= 400 ? 'bad' : ''}>{log.status || log.code} · {log.durationMs}ms</em></div> }
function WsRow({ log }: { log: WsLog }) { return <div><time>{new Date(log.at).toLocaleTimeString()}</time><b>{log.direction === 'in' ? '←' : log.direction === 'out' ? '→' : '•'} {log.type}</b><span>{log.detail}</span></div> }
function PanelTitle({ icon, title, subtitle }: { icon?: string; title: string; subtitle: string }) { return <header className={`panel-title ${icon ? '' : 'without-icon'}`}>{icon && <span>{icon}</span>}<div><p className="eyebrow">FARM NOTE</p><h2>{title}</h2><p>{subtitle}</p></div></header> }
function DelayedLoading({ label }: { label: string }) {
  const visible = useDelayedFlag(true)
  return <div className={`empty-state loading-reserve ${visible ? 'visible' : ''}`} aria-live="polite">{visible && <><div className="spinner" />{label}</>}</div>
}

function ListLoading<T>({ value, children }: { value: T[] | null; children: ReactNode }) { if (value === null) return <DelayedLoading label="正在送达…" />; if (value.length === 0) return <div className="empty-state">这里暂时空空的</div>; return <div className="panel-list">{children}</div> }

function showApiError(error: unknown, notify: ReturnType<typeof useApp>['notify']) { const apiError = error as ApiError; notify(errorMessage(apiError.code, apiError.message), 'error') }
function inventoryCount(items: { item_type: string; item_id: string; quantity: number }[], type: string) { return items.filter((item) => item.item_type.toUpperCase().includes(type)).reduce((sum, item) => sum + item.quantity, 0) }
function plotTitle(plot?: PlotView) { if (!plot || plot.status === 'EMPTY') return '松软的空地'; const crop = cropDefinition(plot.crop_id); if (plot.growth_stage === 'MATURE') return `成熟的${crop.name}`; if (plot.growth_stage === 'SEMI_MATURE') return `舒展叶片的${crop.shortName}`; return `刚发芽的${crop.shortName}` }
function plotDescription(plot?: PlotView) {
  if (!plot || plot.status === 'EMPTY') return '翻好的泥土正在等待一袋种子。'
  const crop = cropDefinition(plot.crop_id)
  if (plot.growth_stage === 'MATURE') {
    const remaining = plotYield(plot)
    if (remaining === 1) return '仅剩农场主保留的一份，好友不能继续偷摘。'
    if (remaining !== null && remaining < crop.harvestYield) return `被好友摘过，当前还可收获 ${remaining} 份。`
    return '服务端已确认成熟，可以收获啦。'
  }
  return `${crop.shortName}正在安静生长，浇点水会很开心。`
}
function plotYield(plot?: PlotView) {
  if (!plot || plot.status === 'EMPTY') return null
  const authoritative = plot.remaining_yield ?? plot.yield
  if (typeof authoritative === 'number' && Number.isFinite(authoritative)) return Math.max(0, authoritative)
  return cropDefinition(plot.crop_id).harvestYield
}
function actionFor(plot: PlotView | undefined, friend: boolean, selectedCrop = CROPS[0]) {
  if (!plot) return null
  const crop = plot.status === 'EMPTY' ? selectedCrop : cropDefinition(plot.crop_id)
  if (friend) {
    if (plot.growth_stage === 'MATURE') return (plotYield(plot) ?? 0) > 1 ? { method: 'farm.StealCrop', label: '悄悄摘一穗' } : null
    return plot.status === 'GROWING' ? { method: 'farm.HelpWater', label: '帮忙浇水' } : null
  }
  if (plot.status === 'EMPTY') return { method: 'farm.Plant', label: `播种${crop.shortName}` }
  return plot.growth_stage === 'MATURE' ? { method: 'farm.Harvest', label: `收获${crop.shortName}` } : { method: 'farm.Water', label: `给${crop.shortName}浇水` }
}
function toolActionFor(plot: PlotView | undefined, tool: FarmTool, friend: boolean, selectedCrop = CROPS[0]) {
  if (tool === 'inspect') return null
  const action = actionFor(plot, friend, selectedCrop)
  if (!action) return null
  if (tool === 'plant' && action.method === 'farm.Plant') return action
  if (tool === 'water' && (action.method === 'farm.Water' || action.method === 'farm.HelpWater')) return action
  if (tool === 'harvest' && (action.method === 'farm.Harvest' || action.method === 'farm.StealCrop')) return action
  return null
}
function toolMismatchMessage(tool: FarmTool, plot: PlotView, friend: boolean) {
  if (tool === 'plant') return plot.status === 'EMPTY' ? '请选择有库存的种子' : '这里已经有作物了，换一块空地吧'
  if (tool === 'water') return plot.status === 'EMPTY' ? '空地不需要浇水' : plot.growth_stage === 'MATURE' ? '作物已经成熟，不用再浇水了' : '这块地现在不需要浇水'
  if (tool === 'harvest') return plot.status === 'EMPTY' ? '这里还没有可以收获的作物' : friend ? '好友的作物成熟后才能采摘' : '作物成熟后才能收获'
  return '点击土地可以查看详情'
}
function actionSound(method: string): FarmSound {
  if (method === 'farm.Plant') return 'plant'
  if (method === 'farm.Water' || method === 'farm.HelpWater') return 'water'
  if (method === 'farm.Harvest') return 'harvest'
  if (method === 'farm.StealCrop') return 'steal'
  return 'select'
}
function phaseLabel(phase: string) { return ({ open: '在线', connecting: '连接中', backoff: '重连中', closed: '离线', idle: '未连接' } as Record<string, string>)[phase] ?? phase }

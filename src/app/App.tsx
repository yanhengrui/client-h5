import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { Navigate, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import type { CatalogUnlock, Friend, Mail, PlotView, Task } from '../api/contract'
import { ApiError, type HttpLog } from '../api/api-client'
import { errorMessage, withEffectiveGrowthStage } from '../api/contract'
import type { WsLog } from '../realtime/farm-socket'
import { countdownSeconds } from './countdown'
import { useApp } from './providers'

type Panel = 'tasks' | 'mail' | 'friends' | 'catalog' | 'shop' | 'pet' | 'debug' | null

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
      <Route path="/login" element={state.session ? <Navigate to={ownFarmPath} replace /> : <LoginPage />} />
      <Route path="/invite" element={<InvitePage />} />
      <Route path="/farm" element={<Navigate to={ownFarmPath} replace />} />
      <Route path="/u/:userId/farm" element={state.session ? <OwnFarmRoute /> : <Navigate to="/login" replace />} />
      <Route path="/farm/:farmId" element={state.session ? <FarmPage /> : <Navigate to="/login" replace />} />
      <Route path="*" element={<Navigate to={ownFarmPath} replace />} />
    </Routes>
  )
}

function OwnFarmRoute() {
  const { userId } = useParams()
  const { state } = useApp()
  if (!state.session) return <Navigate to="/login" replace />
  if (userId !== state.session.userId) return <Navigate to={`/u/${state.session.userId}/farm`} replace />
  return <FarmPage />
}

function LoginPage() {
  const { login } = useApp()
  const navigate = useNavigate()
  const [pending, setPending] = useState(false)
  const [name, setName] = useState(() => localStorage.getItem('farm.profile-name.v1') ?? '')
  const [nameError, setNameError] = useState('')
  const [gate, setGate] = useState('Vite 同源代理 · /api + /ws')

  const enter = async () => {
    const normalized = name.trim()
    if (normalized.length < 2 || normalized.length > 12) {
      setNameError('名字需要 2–12 个字符')
      return
    }
    setNameError('')
    setPending(true)
    try {
      const session = await login(normalized)
      navigate(`/u/${session.userId}/farm`)
    } finally { setPending(false) }
  }
  return (
    <main className="login-page">
      <div className="sun" />
      <section className="login-card">
        <div className="brand-mark" aria-hidden="true">🌾</div>
        <p className="eyebrow">WELCOME TO</p>
        <h1>麦穗农场</h1>
        <p className="login-copy">给自己取个名字，认领一座连接真实后端的小农场。</p>
        <label className="field-label" htmlFor="farmer-name">农场主名字</label>
        <input id="farmer-name" value={name} maxLength={12} autoComplete="nickname" placeholder="例如：麦芽糖" onChange={(e) => { setName(e.target.value); setNameError('') }} onKeyDown={(e) => { if (e.key === 'Enter') void enter() }} />
        {nameError && <p className="field-error" role="alert">{nameError}</p>}
        <label className="field-label" htmlFor="gate">联调入口</label>
        <input id="gate" value={gate} onChange={(e) => setGate(e.target.value)} disabled title="当前版本固定使用 Vite 同源代理" />
        <button className="primary big" onClick={enter} disabled={pending}>{pending ? '正在创建你的农场…' : '创建农场并进入'}</button>
        <small>当前后端使用设备游客账号；名字保存在本机，并绑定这台设备的农场身份。</small>
      </section>
      <div className="login-hills" aria-hidden="true"><span>🌳</span><span>🏡</span><span>🌲</span></div>
    </main>
  )
}

function InvitePage() {
  const { state, login, api, notify } = useApp()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const [status, setStatus] = useState('准备接受邀请…')
  const code = params.get('code') ?? ''
  useEffect(() => {
    let active = true
    void (async () => {
      try {
        if (!code) throw new Error('邀请链接缺少 code')
        const session = state.session ?? await login()
        setStatus('正在加入好友农场…')
        await api.acceptInvite(code)
        if (active) {
          notify('已成为好友', 'success')
          navigate(`/u/${session.userId}/farm`, { replace: true })
        }
      } catch (error) {
        if (active) setStatus(error instanceof Error ? error.message : '邀请处理失败')
      }
    })()
    return () => { active = false }
  }, [api, code, login, navigate, notify, state.session])
  return <main className="center-page"><div className="paper-card"><div className="spinner" /><h1>{status}</h1></div></main>
}

function FarmPage() {
  const { farmId } = useParams()
  const { state, loadSnapshot, farmCommand, logout, hasPet, petHarvests, completePetHarvest, notify } = useApp()
  const navigate = useNavigate()
  const location = useLocation()
  const fieldRef = useRef<HTMLElement>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [panel, setPanel] = useState<Panel>(null)
  const [now, setNow] = useState(Date.now())
  const [ghostPlotId, setGhostPlotId] = useState<number | null>(null)
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
  const selectedOrdinal = Math.max(1, displayPlots.findIndex((plot) => plot.plot_id === selectedPlot?.plot_id) + 1)
  const busy = Object.values(state.pending).includes(selectedPlot?.plot_id ?? -1)
  const connected = state.socketPhase === 'open' && farm.sync === 'synced'
  const action = actionFor(selectedPlot, isFriend)
  const currentYield = plotYield(selectedPlot)
  const playerEconomy = state.playerEconomy
  const seedCount = inventoryCount(playerEconomy?.inventory ?? [], 'SEED')
  const needsSeed = action?.method === 'farm.Plant' && seedCount <= 0
  const farmDisplayName = isFriend
    ? farm.owner_display_name
    : farm.owner_display_name?.trim() || state.session?.displayName?.trim()
  const perform = () => {
    if (!selectedPlot || !action) return
    if (needsSeed) {
      notify('仓库里没有种子，先去补充一袋吧', 'info')
      setPanel('shop')
      return
    }
    farmCommand(action.method, selectedPlot.plot_id, action.method === 'farm.Plant' ? { seed_item_id: 'WHEAT' } : {})
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <button className="logo-button" onClick={() => navigate(`/u/${state.session?.userId}/farm`)}><span>🌾</span><strong>麦穗农场</strong></button>
        <div className="status-cluster">
          <span className="coin-pill">🪙 <b>{playerEconomy?.coin_balance ?? '—'}</b></span>
          <span className={`connection ${state.socketPhase}`}><i /> {phaseLabel(state.socketPhase)}</span>
          <span className="version">版本 {farm.version}</span>
          <span className="version">农场主 {farm.owner_display_name?.trim() || state.session?.displayName?.trim() || `#${state.session?.userId}`}</span>
        </div>
        <nav>
          <button onClick={() => setPanel('tasks')}>📒 <span>任务</span></button>
          <button onClick={() => setPanel('mail')}>✉️ <span>邮件</span></button>
          <button onClick={() => setPanel('friends')}>👥 <span>好友</span></button>
          <button onClick={() => setPanel('catalog')}>📖 <span>图鉴</span></button>
          {import.meta.env.DEV && <button onClick={() => setPanel('debug')}>⚙️ <span>联调</span></button>}
        </nav>
      </header>

      <section className="hero-strip">
        <div><p className="eyebrow">{isFriend ? 'VISITING FARM' : 'MY LITTLE FARM'}</p><h1>{isFriend ? `${farmDisplayName}的农场` : `${farmDisplayName || '农场主'}，今天也要好好种田`}</h1></div>
        {isFriend && <button className="secondary" onClick={() => navigate(`/u/${state.session?.userId}/farm`)}>← 回我的农场</button>}
      </section>

      <div className="farm-layout">
        <section className="field-card" ref={fieldRef}>
          <div className="field-decor" aria-hidden="true">☁️ <span>🐦</span></div>
          <div className="plot-grid">
            {displayPlots.map((plot, index) => (
              <Plot key={plot.plot_id} ordinal={index + 1} plot={plot} selected={plot.plot_id === selectedPlot?.plot_id} pending={Object.values(state.pending).includes(plot.plot_id)} harvestGhost={ghostPlotId === plot.plot_id} onClick={() => setSelected(plot.plot_id)} />
            ))}
          </div>
          <div className="field-footer"><span>🌻</span><span>🌿</span><span className="field-footer-end">🌼</span></div>
          {hasPet === true && !isFriend && <FarmPet key={petHarvest?.eventId ?? 'pet-idle'} fieldRef={fieldRef} cue={petHarvest} onGhostPlot={setGhostPlotId} onComplete={completePetHarvest} />}
        </section>

        <aside className="selection-card">
          <p className="eyebrow">当前选择</p>
          <div className="plot-number">{String(selectedOrdinal).padStart(2, '0')}</div>
          <h2>{plotTitle(selectedPlot)}</h2>
          <p className="muted">{plotDescription(selectedPlot)}</p>
          {selectedPlot?.mature_at && selectedPlot.growth_stage !== 'MATURE' && <Countdown matureAt={selectedPlot.mature_at} now={now} />}
          <div className="detail-list">
            <div><span>地块状态</span><b>{selectedPlot?.status ?? 'EMPTY'}</b></div>
            <div><span>成长阶段</span><b>{selectedPlot?.growth_stage ?? '—'}</b></div>
            <div><span>当前产量</span><b>{currentYield === null ? '—' : `${currentYield} 份`}</b></div>
          </div>
          <button className="primary action-button" onClick={perform} disabled={!action || !connected} aria-busy={busy}>
            {!connected ? '等待实时连接…' : needsSeed ? '种子不足 · 去购买' : action?.label ?? '请选择可操作地块'}
          </button>
          <p className="authority-note">操作立即显示，最终结果以服务端为准。</p>
        </aside>
      </div>

      <section className="dock">
        <div className="inventory-summary">
          <div className="dock-icon">🧺</div><div><small>我的仓库</small><strong>种子 {seedCount} · 小麦 {inventoryCount(playerEconomy?.inventory ?? [], 'CROP')}</strong></div>
        </div>
        <button onClick={() => setPanel('shop')}><span>🛒</span><b>种子商店</b><small>小麦种子 · 10 金币</small></button>
        <button onClick={() => setPanel('pet')}><span>🐣</span><b>农场伙伴</b><small>{hasPet === false ? '购买小鸡 · 200 金币' : hasPet === true ? '管理自动收获' : '正在确认伙伴状态'}</small></button>
        <button className="quiet" onClick={logout}><span>🚪</span><b>离开农场</b><small>清除当前会话</small></button>
      </section>

      {panel && <PanelModal panel={panel} onClose={() => setPanel(null)} />}
      {state.notice && <div className={`toast ${state.notice.tone}`} role="status">{state.notice.text}</div>}
    </main>
  )
}

function Plot({ plot, ordinal, selected, pending, harvestGhost, onClick }: { plot: PlotView; ordinal: number; selected: boolean; pending: boolean; harvestGhost: boolean; onClick: () => void }) {
  const empty = plot.status === 'EMPTY'
  const crop = harvestGhost ? '🌾' : empty ? '＋' : plot.growth_stage === 'MATURE' ? '🌾' : plot.growth_stage === 'SEMI_MATURE' ? '🌿' : '🌱'
  return (
    <button data-plot-id={plot.plot_id} className={`plot ${empty ? 'empty' : 'growing'} ${plot.growth_stage?.toLowerCase() ?? ''} ${selected ? 'selected' : ''} ${pending ? 'syncing' : ''} ${harvestGhost ? 'pet-harvest-target' : ''}`} onClick={onClick} aria-label={`地块 ${ordinal}，${plotTitle(plot)}`} aria-busy={pending}>
      <span className="furrows" />
      <span className="crop">{crop}</span>
      <span className="plot-label">{harvestGhost ? '小鸡收获中' : empty ? '空地' : plot.growth_stage === 'MATURE' ? '可以收获' : '生长中'}</span>
    </button>
  )
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
      <span className="farm-pet-character" aria-hidden="true">🐔</span>
    </div>
  )
}

function Countdown({ matureAt, now }: { matureAt: string; now: number }) {
  const seconds = countdownSeconds(matureAt, now)
  return <div className="countdown"><span>预计成熟</span><b>{Math.floor(seconds / 60).toString().padStart(2, '0')}:{(seconds % 60).toString().padStart(2, '0')}</b><small>仅供展示，以服务端阶段为准</small></div>
}

function PanelModal({ panel, onClose }: { panel: Exclude<Panel, null>; onClose: () => void }) {
  return <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}><section className="modal"><button className="close" onClick={onClose} aria-label="关闭">×</button><PanelContent panel={panel} /></section></div>
}

function PanelContent({ panel }: { panel: Exclude<Panel, null> }) {
  if (panel === 'shop') return <ShopPanel />
  if (panel === 'tasks') return <TasksPanel />
  if (panel === 'mail') return <MailPanel />
  if (panel === 'friends') return <FriendsPanel />
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
  const balance = state.playerEconomy?.coin_balance ?? 0
  const cropCount = inventoryCount(state.playerEconomy?.inventory ?? [], 'CROP')
  const quantity = mode === 'buy' ? buyQuantity : sellQuantity
  const normalizedQuantity = Math.max(1, Math.min(999, Math.floor(quantity || 1)))
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
      await shopTrade(kind, amount)
      notify(kind === 'buy' ? `买到 ${amount} 袋小麦种子` : `卖出 ${amount} 份小麦`, 'success')
    } catch (e) {
      showApiError(e, notify)
    } finally {
      tradingRef.current = false
      setTrading(false)
    }
  }
  const buyingMode = mode === 'buy'
  return <><PanelTitle icon="🛒" title="种子小铺" subtitle="购买和出售分别记录数量，结算以服务端为准" /><div className="tabs shop-tabs" role="tablist"><button className={buyingMode ? 'active' : ''} role="tab" aria-selected={buyingMode} onClick={() => setMode('buy')}>购买种子</button><button className={!buyingMode ? 'active' : ''} role="tab" aria-selected={!buyingMode} onClick={() => setMode('sell')}>出售作物</button></div><div className="product"><div className="product-art">🌾</div><div><h3>{buyingMode ? '购买阳光小麦种子' : '出售仓库小麦'}</h3><p>{buyingMode ? '每袋种子可以播种一块空地' : `仓库当前共有 ${cropCount} 份小麦`}</p><div className="price">{buyingMode ? '🪙 10 / 袋' : '🪙 20 / 份'}</div></div></div><div className="quantity-picker"><span>{buyingMode ? '购买数量' : '出售数量'}</span><div><button type="button" aria-label="减少数量" disabled={normalizedQuantity <= 1} onClick={() => changeQuantity(normalizedQuantity - 1)}>−</button><input aria-label={buyingMode ? '购买数量' : '出售数量'} type="number" min="1" max="999" step="1" value={normalizedQuantity} onChange={(event) => changeQuantity(Number(event.target.value))} /><button type="button" aria-label="增加数量" disabled={normalizedQuantity >= 999} onClick={() => changeQuantity(normalizedQuantity + 1)}>＋</button></div><small>{buyingMode ? `余额最多可买 ${Math.floor(balance / 10)} 袋` : `仓库最多可卖 ${cropCount} 份`}</small></div><div className="button-row"><button className={buyingMode ? 'primary shop-action' : 'secondary shop-action'} disabled={buyingMode ? balance < normalizedQuantity * 10 : cropCount < normalizedQuantity} aria-busy={trading} onClick={() => act(mode)}>{buyingMode ? `购买 ${normalizedQuantity} 袋 · ${normalizedQuantity * 10} 金币` : `出售 ${normalizedQuantity} 份 · 获得 ${normalizedQuantity * 20} 金币`}</button></div></>
}

function CatalogPanel() {
  const { api, notify, state } = useApp()
  const cacheKey = panelCacheKey(state.session?.userId, 'catalog')
  const [unlocks, setUnlocks] = useState<CatalogUnlock[] | null>(() => readPanelCache<CatalogUnlock[]>(cacheKey))
  useEffect(() => {
    void api.catalog().then((result) => setUnlocks(writePanelCache(cacheKey, result.unlocks ?? []))).catch((error) => showApiError(error, notify))
  }, [api, cacheKey, notify])
  if (unlocks === null) return <><PanelTitle icon="📖" title="作物图鉴" subtitle="每次收获，都会留下一页农场记忆" /><DelayedLoading label="正在翻阅图鉴…" /></>

  const wheatUnlock = unlocks.find((item) => isWheatCatalogKey(item.catalog_key))
  const entries = [
    wheatUnlock ?? { catalog_key: 'crop_WHEAT', unlocked_at: '' },
    ...unlocks.filter((item) => !isWheatCatalogKey(item.catalog_key)),
  ]
  return <><PanelTitle icon="📖" title="作物图鉴" subtitle="收获作物后由服务端永久解锁" /><div className="catalog-summary"><b>{unlocks.length}</b><span>已解锁条目</span></div><div className="catalog-grid">{entries.map((entry) => {
    const unlocked = Boolean(entry.unlocked_at)
    const cropCode = entry.catalog_key.replace(/^crop_/i, '').toUpperCase()
    const wheat = isWheatCatalogKey(entry.catalog_key)
    return <article className={`catalog-card ${unlocked ? 'unlocked' : 'locked'}`} key={entry.catalog_key}><div className="catalog-art">{unlocked ? wheat ? '🌾' : '🌱' : '？'}</div><div><span className="catalog-status">{unlocked ? '已解锁' : '尚未解锁'}</span><h3>{wheat ? '阳光小麦' : cropCode}</h3><p>{unlocked ? wheat ? '金黄饱满，是每座农场的第一份收获。' : `发现了新的作物：${cropCode}` : '亲手收获这种作物后，它会出现在这里。'}</p>{unlocked && <time>发现于 {new Date(entry.unlocked_at).toLocaleDateString()}</time>}</div></article>
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
  return <><PanelTitle icon="📒" title="今日任务" subtitle="一点一滴，都是农场的成长" /><ListLoading value={tasks}>{(tasks ?? []).map((task) => <article className="list-card" key={task.task_key}><div><h3>{task.description || task.task_key}</h3><p>{task.progress} / {task.target} · 奖励 🪙 {task.coin_reward}</p><progress value={task.progress} max={task.target || 1} /></div><button className="small-button" disabled={task.status !== 'COMPLETED' || busy === task.task_key} onClick={() => claim(task)}>{task.status === 'CLAIMED' ? '已领取' : busy === task.task_key ? '领取中' : '领取'}</button></article>)}</ListLoading></>
}

function MailPanel() {
  const { api, notify, refreshPlayerAssets, state } = useApp()
  const cacheKey = panelCacheKey(state.session?.userId, 'mail')
  const [mails, setMails] = useState<Mail[] | null>(() => readPanelCache<Mail[]>(cacheKey))
  const [busy, setBusy] = useState('')
  const load = () => api.mails().then((r) => setMails(writePanelCache(cacheKey, r.mails))).catch((e) => showApiError(e, notify))
  useEffect(() => { void load() }, [])
  const open = async (mail: Mail) => { if (mail.status === 'UNREAD') { try { await api.readMail(String(mail.mail_id)); load() } catch (e) { showApiError(e, notify) } } }
  const claim = async (id: string) => { setBusy(id); try { await api.claimAttachment(id); notify('附件已放入仓库', 'success'); await refreshPlayerAssets(); load() } catch (e) { showApiError(e, notify) } finally { setBusy('') } }
  return <><PanelTitle icon="✉️" title="乡间邮局" subtitle="最近送到的 20 封信" /><ListLoading value={mails}>{(mails ?? []).map((mail) => <article className={`mail-card ${mail.status === 'UNREAD' ? 'unread' : ''}`} key={String(mail.mail_id)} onClick={() => open(mail)}><header><h3>{mail.title}</h3><time>{new Date(mail.created_at).toLocaleDateString()}</time></header><p>{mail.content}</p>{mail.attachments?.map((item) => <button key={String(item.attachment_id)} className="attachment" disabled={Boolean(item.claimed_at) || busy === String(item.attachment_id)} onClick={(e) => { e.stopPropagation(); void claim(String(item.attachment_id)) }}>🎁 {item.item_type} × {item.quantity} · {item.claimed_at ? '已领取' : '领取'}</button>)}</article>)}</ListLoading></>
}

function FriendsPanel() {
  const { api, notify, state } = useApp()
  const navigate = useNavigate()
  const cacheKey = panelCacheKey(state.session?.userId, 'friends')
  const [friends, setFriends] = useState<Friend[] | null>(() => readPanelCache<Friend[]>(cacheKey))
  const [code, setCode] = useState('')
  const [created, setCreated] = useState('')
  const load = () => api.friends().then((r) => setFriends(writePanelCache(cacheKey, r.friends))).catch((e) => showApiError(e, notify))
  useEffect(() => { void load() }, [])
  const create = async () => { try { const result = await api.createInvite(); setCreated(result.invite_code) } catch (e) { showApiError(e, notify) } }
  const accept = async () => { try { await api.acceptInvite(code.trim()); setCode(''); notify('已成为好友', 'success'); load() } catch (e) { showApiError(e, notify) } }
  return <><PanelTitle icon="👥" title="农场好友" subtitle="互相浇水，也可以悄悄摘一穗" /><div className="invite-box"><button className="secondary" onClick={create}>生成邀请码</button>{created && <code>{created}</code>}<div className="inline-form"><input placeholder="输入邀请码" value={code} onChange={(e) => setCode(e.target.value)} /><button className="small-button" disabled={!code.trim()} onClick={accept}>接受</button></div></div><ListLoading value={friends}>{(friends ?? []).map((friend) => <article className="list-card" key={friend.user_id}><div><h3>{friend.display_name}</h3><p>去看看 TA 的作物长得怎么样</p></div><button className="small-button" onClick={() => navigate(`/farm/${friend.user_id}`)}>拜访</button></article>)}</ListLoading></>
}

function PetPanel() {
  const { state, api, notify, refreshPlayerAssets, hasPet, autoHarvestEnabled, refreshPetStatus, setPetAutoHarvest } = useApp()
  const [busy, setBusy] = useState(false)
  const [switching, setSwitching] = useState(false)
  const buy = async () => { setBusy(true); try { await api.buyPet(); notify('小鸡搬进农场啦！', 'success'); await refreshPlayerAssets(); await refreshPetStatus() } catch (e) { showApiError(e, notify) } finally { setBusy(false) } }
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
  return <><PanelTitle icon="🐣" title="农场伙伴" subtitle="购买小鸡后，可以每 30 秒自动巡查成熟作物" /><div className="pet-stage"><div className="pet-bubble">{hasPet ? '咕咕！今天也一起努力吧。' : '给我一个温暖的新家吧？'}</div><div className="pet-big">🐔</div><h3>{hasPet === null ? '暂时没有查到伙伴状态' : hasPet ? '你的农场小鸡' : '还没有农场伙伴'}</h3>{hasPet === true && <div className="pet-auto-row"><div><b>自动收获</b><small>{autoHarvestEnabled ? '每 30 秒巡查成熟作物' : '小鸡会留在原位休息'}</small></div><button className={`pet-switch ${autoHarvestEnabled ? 'on' : ''}`} role="switch" aria-checked={Boolean(autoHarvestEnabled)} disabled={switching || autoHarvestEnabled === null} onClick={toggleAutoHarvest}><span /></button></div>}{hasPet === false && <><button className="primary" disabled={busy || balance < 200} onClick={buy}>{busy ? '正在迎接…' : '用 200 金币购买小鸡'}</button><small>{balance < 200 ? `当前 ${balance} 金币，还差 ${200 - balance} 金币` : `当前余额 ${balance} 金币`}</small></>}{hasPet === null && <button className="secondary" disabled={busy} onClick={check}>{busy ? '查询中…' : '重新查询宠物状态'}</button>}</div></>
}

function DebugPanel() {
  const { state, loadSnapshot, disconnectSocket, reconnectSocket, exportDebug, logout } = useApp()
  const [tab, setTab] = useState<'http' | 'ws'>('http')
  return <><PanelTitle icon="⚙️" title="联调控制台" subtitle="仅开发构建包含；导出内容不会包含 token" /><div className="debug-metrics"><b>{state.session?.userId ?? '—'}<small>USER ID</small></b><b>{state.farm?.farm_id ?? '—'}<small>FARM ID</small></b><b>{state.farm?.version ?? '—'}<small>VERSION</small></b><b>{Object.keys(state.pending).length}<small>PENDING</small></b><b>{state.clientSeq}/{state.serverSeq}<small>CLIENT/SERVER SEQ</small></b></div><div className="button-row wrap"><button className="secondary" onClick={() => void loadSnapshot()}>强制拉 Snapshot</button><button className="secondary" onClick={disconnectSocket}>断开 WS</button><button className="secondary" onClick={reconnectSocket}>重连 WS</button><button className="secondary" onClick={exportDebug}>导出 JSON</button><button className="danger" onClick={logout}>清空本地 token</button></div><div className="tabs"><button className={tab === 'http' ? 'active' : ''} onClick={() => setTab('http')}>HTTP ({state.httpLogs.length})</button><button className={tab === 'ws' ? 'active' : ''} onClick={() => setTab('ws')}>WS ({state.wsLogs.length})</button></div><div className="log-table">{tab === 'http' ? state.httpLogs.map((log) => <HttpRow key={log.id} log={log} />) : state.wsLogs.map((log) => <WsRow key={log.id} log={log} />)}{(tab === 'http' ? state.httpLogs : state.wsLogs).length === 0 && <p className="empty-state">还没有记录</p>}</div></>
}

function HttpRow({ log }: { log: HttpLog }) { return <div><time>{new Date(log.at).toLocaleTimeString()}</time><b>{log.method}</b><span>{log.path}</span><em className={log.status >= 400 ? 'bad' : ''}>{log.status || log.code} · {log.durationMs}ms</em></div> }
function WsRow({ log }: { log: WsLog }) { return <div><time>{new Date(log.at).toLocaleTimeString()}</time><b>{log.direction === 'in' ? '←' : log.direction === 'out' ? '→' : '•'} {log.type}</b><span>{log.detail}</span></div> }
function PanelTitle({ icon, title, subtitle }: { icon: string; title: string; subtitle: string }) { return <header className="panel-title"><span>{icon}</span><div><p className="eyebrow">FARM NOTE</p><h2>{title}</h2><p>{subtitle}</p></div></header> }
function DelayedLoading({ label }: { label: string }) {
  const visible = useDelayedFlag(true)
  return <div className={`empty-state loading-reserve ${visible ? 'visible' : ''}`} aria-live="polite">{visible && <><div className="spinner" />{label}</>}</div>
}

function ListLoading<T>({ value, children }: { value: T[] | null; children: ReactNode }) { if (value === null) return <DelayedLoading label="正在送达…" />; if (value.length === 0) return <div className="empty-state">这里暂时空空的</div>; return <div className="panel-list">{children}</div> }

function showApiError(error: unknown, notify: ReturnType<typeof useApp>['notify']) { const apiError = error as ApiError; notify(errorMessage(apiError.code, apiError.message), 'error') }
function inventoryCount(items: { item_type: string; item_id: string; quantity: number }[], type: string) { return items.filter((item) => item.item_type.toUpperCase().includes(type)).reduce((sum, item) => sum + item.quantity, 0) }
function plotTitle(plot?: PlotView) { if (!plot || plot.status === 'EMPTY') return '松软的空地'; if (plot.growth_stage === 'MATURE') return '金灿灿的小麦'; if (plot.growth_stage === 'SEMI_MATURE') return '拔节中的小麦'; return '刚发芽的小麦' }
function plotDescription(plot?: PlotView) {
  if (!plot || plot.status === 'EMPTY') return '翻好的泥土正在等待一袋种子。'
  if (plot.growth_stage === 'MATURE') {
    const remaining = plotYield(plot)
    if (remaining === 1) return '仅剩农场主保留的一份，好友不能继续偷摘。'
    if (remaining !== null && remaining < 5) return `被好友摘过，当前还可收获 ${remaining} 份。`
    return '服务端已确认成熟，可以收获啦。'
  }
  return '麦苗正在安静生长，浇点水会很开心。'
}
function plotYield(plot?: PlotView) {
  if (!plot || plot.status === 'EMPTY') return null
  const authoritative = plot.remaining_yield ?? plot.yield
  if (typeof authoritative === 'number' && Number.isFinite(authoritative)) return Math.max(0, authoritative)
  return plot.crop_id === 'WHEAT' || plot.crop_id === '1' ? 5 : null
}
function isWheatCatalogKey(key: string) { const normalized = key.toUpperCase(); return normalized === 'CROP_WHEAT' || normalized === 'CROP_1' }
function actionFor(plot: PlotView | undefined, friend: boolean) {
  if (!plot) return null
  if (friend) {
    if (plot.growth_stage === 'MATURE') return (plotYield(plot) ?? 0) > 1 ? { method: 'farm.StealCrop', label: '悄悄摘一穗' } : null
    return plot.status === 'GROWING' ? { method: 'farm.HelpWater', label: '帮忙浇水' } : null
  }
  if (plot.status === 'EMPTY') return { method: 'farm.Plant', label: '播种小麦' }
  return plot.growth_stage === 'MATURE' ? { method: 'farm.Harvest', label: '收获小麦' } : { method: 'farm.Water', label: '给麦苗浇水' }
}
function phaseLabel(phase: string) { return ({ open: '在线', connecting: '连接中', backoff: '重连中', closed: '离线', idle: '未连接' } as Record<string, string>)[phase] ?? phase }

export type ID = string

export type AuthSession = {
  accessToken: string
  refreshToken: string
  sessionId: string
  userId: ID
  farmId: ID
  username?: string
  displayName?: string
}

export type GuestLoginResponse = {
  access_token: string
  refresh_token: string
  session_id: string
  user_id: ID
  farm_id: ID
  expires_in: number
  display_name: string
}

export type PlotView = {
  plot_id: number
  status: 'EMPTY' | 'GROWING' | string
  crop_id?: string
  growth_stage?: 'SEEDLING' | 'SEMI_MATURE' | 'MATURE' | string
  planted_at?: string
  mature_at?: string
  remaining_yield?: number
  yield?: number
}

export function withEffectiveGrowthStage(plot: PlotView, nowMs: number): PlotView {
  if (plot.status !== 'GROWING' || !plot.mature_at) return plot

  const matureAt = Date.parse(plot.mature_at)
  if (!Number.isFinite(matureAt)) return plot

  if (nowMs >= matureAt) {
    return plot.growth_stage === 'MATURE' ? plot : { ...plot, growth_stage: 'MATURE' }
  }

  if (!plot.planted_at) return plot
  const plantedAt = Date.parse(plot.planted_at)
  if (!Number.isFinite(plantedAt) || matureAt <= plantedAt) return plot

  const growthStage = nowMs >= plantedAt + (matureAt - plantedAt) / 2 ? 'SEMI_MATURE' : 'SEEDLING'
  return plot.growth_stage === growthStage ? plot : { ...plot, growth_stage: growthStage }
}

export type InventoryItem = { item_type: string; item_id: ID; quantity: number }
export type PlayerAssets = {
  coin_balance: number
  inventory: InventoryItem[]
}
export type FarmSnapshot = {
  farm_id: ID
  owner_user_id: ID
  owner_display_name: string
  version: string
  plots: PlotView[]
}

export type CatalogUnlock = {
  catalog_key: string
  unlocked_at: string
}

export type Friend = { user_id: ID; display_name: string }
export type FriendsResponse = { friends: Friend[] }
export type Attachment = {
  attachment_id: ID
  item_type: string
  item_id: ID
  quantity: number
  claimed_at?: string
}
export type Mail = {
  mail_id: ID
  sender_id?: ID
  mail_type: string
  title: string
  content: string
  status: string
  created_at: string
  attachments?: Attachment[]
}
export type MailboxSummary = {
  unread_count: number
  mailbox_version: number
}
export type Task = {
  task_key: string
  description: string
  progress: number
  target: number
  status: string
  coin_reward: number
  updated_at: string
}

export type ApiErrorBody = { code?: string; message?: string; reason?: string; retry_after_ms?: number }

const asID = (value: unknown): string => {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new Error('服务端返回了超出 JavaScript 安全范围的数字 ID')
  }
  return String(value ?? '')
}
export function normalizeSnapshot(raw: FarmSnapshot): FarmSnapshot {
  const ownerUserId = asID(raw.owner_user_id)
  return {
    ...raw,
    farm_id: asID(raw.farm_id),
    owner_user_id: ownerUserId,
    owner_display_name: raw.owner_display_name?.trim() || ownerUserId,
    version: asID(raw.version),
    plots: raw.plots ?? [],
  }
}

export function normalizeFriendsResponse(raw: FriendsResponse): FriendsResponse {
  return {
    friends: (raw.friends ?? []).map((friend) => {
      const userId = asID(friend.user_id)
      return {
        ...friend,
        user_id: userId,
        display_name: friend.display_name?.trim() || userId,
      }
    }),
  }
}

export function normalizePlayerAssets(raw: PlayerAssets): PlayerAssets {
  return {
    coin_balance: Number(raw.coin_balance ?? 0),
    inventory: (raw.inventory ?? []).map((item) => ({
      ...item,
      item_id: asID(item.item_id),
      quantity: Number(item.quantity ?? 0),
    })),
  }
}

export const ERROR_MESSAGES: Record<string, string> = {
  AUTH_UNAUTHORIZED: '登录状态已失效，请重新进入农场',
  AUTH_TOKEN_EXPIRED: '登录凭证已过期，正在刷新',
  AUTH_IDENTITY_EXISTS: '这个用户名已经被注册，请换一个',
  AUTH_FORBIDDEN: '账号已被停用，请联系管理员',
  FARM_VERSION_CONFLICT: '农场刚刚发生了变化，已为你刷新',
  FARM_PLOT_STATE_INVALID: '这块土地现在不能这样操作',
  FARM_PLOT_NOT_MATURE: '作物还没有成熟，再等等吧',
  ECONOMY_INSUFFICIENT_BALANCE: '金币不够啦',
  ECONOMY_ITEM_NOT_FOUND: '库存里没有足够的物品',
  SOCIAL_NOT_FRIEND: '对方还不是你的好友',
  TASK_NOT_COMPLETED: '任务尚未完成',
  MAIL_ALREADY_CLAIMED: '这份附件已经领取过了',
  COMMON_RATE_LIMITED: '操作太快了，请稍后再试',
  COMMON_RESOURCE_EXHAUSTED: '服务有些忙，请稍后再试',
  INTERNAL_ERROR: '服务暂时开小差了，请稍后再试',
}

export const errorMessage = (code?: string, fallback?: string) =>
  (code && ERROR_MESSAGES[code]) || fallback || '请求失败，请稍后再试'

import type {
  ApiErrorBody,
  AuthSession,
  CatalogUnlock,
  FarmSnapshot,
  FriendsResponse,
  GuestLoginResponse,
  Mail,
  PlayerAssets,
  Task,
} from './contract'
import { normalizeFriendsResponse, normalizePlayerAssets, normalizeSnapshot } from './contract'
import { createUuidV7 } from '../shared/uuid-v7'

export type HttpLog = {
  id: string
  at: string
  method: string
  path: string
  status: number
  durationMs: number
  code?: string
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryAfterMs = 0,
    public reason = '',
  ) {
    super(message)
  }
}

type RequestOptions = RequestInit & { anonymous?: boolean; timeoutMs?: number; skipRefresh?: boolean }

export class ApiClient {
  private session: AuthSession | null = null
  private refreshPromise: Promise<void> | null = null
  private readonly inFlightGets = new Map<string, Promise<unknown>>()

  constructor(
    private readonly baseUrl = '',
    private readonly onSession: (session: AuthSession | null) => void,
    private readonly onLog: (log: HttpLog) => void,
  ) {}

  setSession(session: AuthSession | null) {
    this.session = session
  }

  private request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const method = (options.method ?? 'GET').toUpperCase()
    if (method !== 'GET') return this.executeRequest<T>(path, options)

    const authScope = options.anonymous ? 'anonymous' : this.session?.accessToken ?? 'anonymous'
    const key = `${authScope}:${path}`
    const existing = this.inFlightGets.get(key)
    if (existing) return existing as Promise<T>

    const request = this.executeRequest<T>(path, options)
    this.inFlightGets.set(key, request)
    const clear = () => {
      if (this.inFlightGets.get(key) === request) this.inFlightGets.delete(key)
    }
    void request.then(clear, clear)
    return request
  }

  private async executeRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const method = (options.method ?? 'GET').toUpperCase()
    const started = performance.now()
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), options.timeoutMs ?? (method === 'GET' ? 5000 : 8000))
    let status = 0
    let code: string | undefined
    try {
      const headers = new Headers(options.headers)
      if (options.body) headers.set('Content-Type', 'application/json')
      if (!options.anonymous && this.session?.accessToken) headers.set('Authorization', `Bearer ${this.session.accessToken}`)
      const response = await fetch(`${this.baseUrl}${path}`, { ...options, headers, signal: controller.signal })
      status = response.status
      if (response.status === 401 && !options.anonymous && !options.skipRefresh && this.session) {
        await this.refresh()
        return this.executeRequest<T>(path, { ...options, skipRefresh: true })
      }
      const data = (await response.json().catch(() => ({}))) as T & ApiErrorBody
      if (!response.ok) {
        code = data.code ?? `HTTP_${response.status}`
        throw new ApiError(
          response.status,
          code,
          data.message ?? response.statusText,
          Number(data.retry_after_ms ?? response.headers.get('Retry-After-Ms') ?? 0),
          data.reason ?? response.headers.get('X-Capacity-Reason') ?? '',
        )
      }
      return data
    } catch (error) {
      if (error instanceof ApiError) throw error
      code = error instanceof DOMException && error.name === 'AbortError' ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR'
      throw new ApiError(status, code, code === 'REQUEST_TIMEOUT' ? '请求超时，结果可能未知' : '无法连接到 gatesvr')
    } finally {
      window.clearTimeout(timeout)
      this.onLog({
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        method,
        path,
        status,
        durationMs: Math.round(performance.now() - started),
        code,
      })
    }
  }

  private refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise
    const current = this.session
    if (!current) return Promise.reject(new ApiError(401, 'AUTH_UNAUTHORIZED', '没有可刷新的会话'))
    this.refreshPromise = this.request<{ access_token: string }>('/api/v1/auth/refresh', {
      method: 'POST',
      anonymous: true,
      skipRefresh: true,
      body: JSON.stringify({ session_id: current.sessionId, refresh_token: current.refreshToken }),
    })
      .then((res) => {
        this.session = { ...current, accessToken: res.access_token }
        this.onSession(this.session)
      })
      .catch((error) => {
        this.session = null
        this.onSession(null)
        throw error
      })
      .finally(() => {
        this.refreshPromise = null
      })
    return this.refreshPromise
  }

  async guestLogin(deviceId: string, displayName: string) {
    const res = await this.request<GuestLoginResponse>('/api/v1/auth/guest-login', {
      method: 'POST',
      anonymous: true,
      body: JSON.stringify({ device_id: deviceId, display_name: displayName }),
    })
    const session: AuthSession = {
      accessToken: res.access_token,
      refreshToken: res.refresh_token,
      sessionId: res.session_id,
      userId: String(res.user_id),
      farmId: String(res.farm_id),
    }
    this.session = session
    return session
  }

  snapshot(farmId?: string) {
    const query = farmId ? `?farm_id=${encodeURIComponent(farmId)}` : ''
    return this.request<FarmSnapshot>(`/api/v1/farm/snapshot${query}`).then(normalizeSnapshot)
  }
  assets() {
    return this.request<PlayerAssets>('/api/v1/player/assets').then(normalizePlayerAssets)
  }
  catalog() {
    return this.request<{ unlocks: CatalogUnlock[] }>('/api/v1/catalog/list')
  }
  purchase(quantity = 1) {
    return this.request<{ event_id: string; coin_balance: number }>('/api/v1/shop/purchase', {
      method: 'POST',
      headers: { 'Idempotency-Key': createUuidV7() },
      body: JSON.stringify({ crop_id: 'WHEAT', quantity }),
    })
  }
  sell(quantity = 1) {
    return this.request<{ event_id: string; coin_balance: number }>('/api/v1/farm/sell', {
      method: 'POST',
      headers: { 'Idempotency-Key': createUuidV7() },
      body: JSON.stringify({ crop_id: 'WHEAT', quantity }),
    })
  }
  friends() {
    return this.request<FriendsResponse>('/api/v1/social/friends').then(normalizeFriendsResponse)
  }
  createInvite() {
    return this.request<{ invite_code: string }>('/api/v1/social/invite', { method: 'POST', body: '{}' })
  }
  acceptInvite(inviteCode: string) {
    return this.request<{ ok: boolean }>('/api/v1/social/invite/accept', { method: 'POST', body: JSON.stringify({ invite_code: inviteCode }) })
  }
  mails() {
    return this.request<{ mails: Mail[] }>('/api/v1/mail/list?limit=20')
  }
  readMail(mailId: string) {
    return this.request<{ ok: boolean }>('/api/v1/mail/read', { method: 'POST', body: JSON.stringify({ mail_id: Number(mailId) }) })
  }
  claimAttachment(attachmentId: string) {
    return this.request<{ ok: boolean }>('/api/v1/mail/claim', { method: 'POST', body: JSON.stringify({ attachment_id: Number(attachmentId) }) })
  }
  tasks() {
    return this.request<{ tasks: Task[] }>('/api/v1/task/list')
  }
  claimTask(taskKey: string) {
    return this.request<{ coin_reward: number }>('/api/v1/task/claim', { method: 'POST', body: JSON.stringify({ task_key: taskKey }) })
  }
  petStatus() {
    return this.request<{ has_pet: boolean; auto_harvest_enabled: boolean }>('/api/v1/pet/status')
  }
  buyPet() {
    return this.request<{ ok: boolean }>('/api/v1/pet/buy', { method: 'POST', body: '{}' })
  }
  setPetAutoHarvest(enabled: boolean) {
    return this.request<{ auto_harvest_enabled: boolean }>('/api/v1/pet/auto-harvest', {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    })
  }
}

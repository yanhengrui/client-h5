import { afterEach, describe, expect, it, vi } from 'vitest'
import { accessTokenExpiresAt, ApiClient } from './api-client'

describe('ApiClient GET coalescing', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('shares one physical request between concurrent identical reads', async () => {
    let release!: (response: Response) => void
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { release = resolve }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('window', { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout })
    vi.stubGlobal('crypto', { getRandomValues: (values: Uint8Array) => values.fill(1) })

    const client = new ApiClient('', () => undefined, () => undefined)
    const first = client.friends()
    const second = client.friends()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    release({
      status: 200,
      ok: true,
      statusText: 'OK',
      headers: new Headers(),
      json: async () => ({ friends: [] }),
    } as Response)

    await expect(Promise.all([first, second])).resolves.toEqual([{ friends: [] }, { friends: [] }])
  })
})

describe('ApiClient mailbox summary', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('loads only the authoritative unread badge state', async () => {
    vi.stubGlobal('window', { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout })
    vi.stubGlobal('crypto', { getRandomValues: (values: Uint8Array) => values.fill(1) })
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      unread_count: 5,
      mailbox_version: 12,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new ApiClient('', () => undefined, () => undefined)

    await expect(client.mailSummary()).resolves.toEqual({ unread_count: 5, mailbox_version: 12 })
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/mail/summary', expect.any(Object))
  })

  it('marks the complete server-side mailbox as read with one request', async () => {
    vi.stubGlobal('window', { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout })
    vi.stubGlobal('crypto', { getRandomValues: (values: Uint8Array) => values.fill(1) })
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new ApiClient('', () => undefined, () => undefined)

    await expect(client.readAllMails()).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/mail/read-all', expect.objectContaining({ method: 'POST' }))
  })
})

describe('ApiClient password authentication', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('registers a local account and revokes the server session on logout', async () => {
    vi.stubGlobal('window', { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout })
    vi.stubGlobal('crypto', { getRandomValues: (values: Uint8Array) => values.fill(1) })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'access-1', refresh_token: 'refresh-1', session_id: 'session-1',
        user_id: '42', farm_id: '42', display_name: '麦芽糖', expires_in: 1800,
      }), { status: 201, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const sessions: unknown[] = []
    const client = new ApiClient('', (session) => sessions.push(session), () => undefined)

    await expect(client.register('farmer_01', 'password-123', '麦芽糖')).resolves.toMatchObject({
      sessionId: 'session-1', userId: '42', username: 'farmer_01', displayName: '麦芽糖',
    })
    const registerInit = fetchMock.mock.calls[0][1] as RequestInit
    expect(JSON.parse(String(registerInit.body))).toEqual({ username: 'farmer_01', password: 'password-123', display_name: '麦芽糖' })

    await client.logout()
    const logoutInit = fetchMock.mock.calls[1][1] as RequestInit
    expect(JSON.parse(String(logoutInit.body))).toEqual({ session_id: 'session-1', refresh_token: 'refresh-1' })
    expect(sessions.at(-1)).toBeNull()
  })
})

describe('ApiClient realtime token', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reads the expiry embedded in the backend access-token format', () => {
    expect(accessTokenExpiresAt('42:2000000000.signature')).toBe(2_000_000_000_000)
    expect(accessTokenExpiresAt('not-a-token')).toBeNull()
  })

  it('refreshes an expiring token before a WebSocket reconnect', async () => {
    vi.stubGlobal('window', { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout })
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: '42:2000000000.new', refresh_token: 'refresh-2',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const sessions: Array<unknown> = []
    const client = new ApiClient('', (session) => sessions.push(session), () => undefined)
    client.setSession({
      accessToken: `42:${Math.floor(Date.now() / 1000) + 5}.old`,
      refreshToken: 'refresh-1', sessionId: 'session-1', userId: '42', farmId: '42',
    })

    await expect(client.realtimeAccessToken()).resolves.toBe('42:2000000000.new')
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/auth/refresh', expect.any(Object))
    expect(sessions.at(-1)).toMatchObject({ accessToken: '42:2000000000.new', refreshToken: 'refresh-2' })
  })
})

describe('ApiClient invite synchronization', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('waits until a cross-shard friend becomes visible', async () => {
    vi.stubGlobal('window', {
      setTimeout: (callback: () => void) => { callback(); return 1 },
      clearTimeout: () => undefined,
    })
    const client = new ApiClient('', () => undefined, () => undefined)
    const accept = vi.spyOn(client, 'acceptInvite').mockResolvedValue({ ok: true })
    const friends = vi.spyOn(client, 'friends')
      .mockResolvedValueOnce({ friends: [{ user_id: 'old', display_name: 'Old Friend' }] })
      .mockResolvedValueOnce({ friends: [
        { user_id: 'old', display_name: 'Old Friend' },
        { user_id: 'new', display_name: 'New Friend' },
      ] })

    await expect(client.acceptInviteAndWait('invite-code', ['old'], 3)).resolves.toMatchObject({
      confirmed: true,
      friend: { user_id: 'new', display_name: 'New Friend' },
      friends: [{ user_id: 'old' }, { user_id: 'new' }],
    })
    expect(accept).toHaveBeenCalledWith('invite-code')
    expect(friends).toHaveBeenCalledTimes(2)
  })

  it('does not wait when acceptance succeeds but no new friend is visible yet', async () => {
    vi.stubGlobal('window', {
      setTimeout: () => { throw new Error('unexpected wait') },
      clearTimeout: () => undefined,
    })
    const client = new ApiClient('', () => undefined, () => undefined)
    vi.spyOn(client, 'acceptInvite').mockResolvedValue({ ok: true })
    vi.spyOn(client, 'friends').mockResolvedValue({
      friends: [{ user_id: 'existing', display_name: 'Existing Friend' }],
    })

    await expect(client.acceptInviteAndWait('invite-code', ['existing'])).resolves.toEqual({
      confirmed: false,
      friend: undefined,
      friends: [{ user_id: 'existing', display_name: 'Existing Friend' }],
    })
  })
})

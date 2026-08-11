import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient } from './api-client'

describe('ApiClient GET coalescing', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('shares one physical request between concurrent identical reads', async () => {
    let release!: (response: Response) => void
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { release = resolve }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('window', { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout })
    vi.stubGlobal('crypto', { randomUUID: () => 'http-log-id' })

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
      friends: [{ user_id: 'old' }, { user_id: 'new' }],
    })
    expect(accept).toHaveBeenCalledWith('invite-code')
    expect(friends).toHaveBeenCalledTimes(2)
  })
})

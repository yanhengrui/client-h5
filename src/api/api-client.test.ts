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

import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('farm audio preferences', () => {
  beforeEach(() => {
    vi.resetModules()
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem(key: string) { return values.get(key) ?? null },
      setItem(key: string, value: string) { values.set(key, value) },
    })
    vi.stubGlobal('document', {
      hidden: false,
      addEventListener: vi.fn(),
    })
    vi.stubGlobal('window', {})
  })

  it('persists music and effects independently without creating an audio context', async () => {
    const { farmAudio } = await import('./farm-audio')
    const updates: Array<{ music: boolean; effects: boolean; musicVolume: number; effectsVolume: number }> = []
    farmAudio.subscribe((value) => updates.push(value))

    farmAudio.setMusic(false)
    farmAudio.setEffects(false)

    expect(farmAudio.getPreferences()).toEqual({ music: false, effects: false, musicVolume: .32, effectsVolume: .8 })
    expect(updates).toEqual([
      { music: false, effects: true, musicVolume: .32, effectsVolume: .8 },
      { music: false, effects: false, musicVolume: .32, effectsVolume: .8 },
    ])
  })

  it('persists independently clamped music and effect volumes', async () => {
    const { farmAudio } = await import('./farm-audio')
    farmAudio.setMusicVolume(.45)
    farmAudio.setEffectsVolume(2)
    expect(farmAudio.getPreferences()).toMatchObject({ musicVolume: .45, effectsVolume: 1 })
  })
})

export type FarmSound = 'select' | 'open' | 'close' | 'plant' | 'water' | 'harvest' | 'steal' | 'buy' | 'sell' | 'success' | 'error'

export type AudioPreferences = {
  music: boolean
  effects: boolean
  musicVolume: number
  effectsVolume: number
}

const STORAGE_KEY = 'farm.audio.preferences.v1'
const MUSIC_SRC = '/assets/audio/good-morning.ogg'
const DEFAULT_PREFERENCES: AudioPreferences = { music: true, effects: true, musicVolume: .32, effectsVolume: .8 }

function clampVolume(value: number) {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0))
}

type AudioContextConstructor = typeof AudioContext

function readPreferences(): AudioPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<AudioPreferences>
    return {
      music: saved.music ?? DEFAULT_PREFERENCES.music,
      effects: saved.effects ?? DEFAULT_PREFERENCES.effects,
      musicVolume: clampVolume(saved.musicVolume ?? DEFAULT_PREFERENCES.musicVolume),
      effectsVolume: clampVolume(saved.effectsVolume ?? DEFAULT_PREFERENCES.effectsVolume),
    }
  } catch {
    return { ...DEFAULT_PREFERENCES }
  }
}

class FarmAudioController {
  private preferences = readPreferences()
  private context: AudioContext | null = null
  private effectsBus: GainNode | null = null
  private music: HTMLAudioElement | null = null
  private listeners = new Set<(preferences: AudioPreferences) => void>()

  constructor() {
    if (typeof document === 'undefined') return
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.pauseMusic()
      else if (this.preferences.music) void this.startMusic()
    })
    document.addEventListener('pointerdown', () => {
      if (this.preferences.music) void this.startMusic()
    }, { once: true, passive: true })
  }

  getPreferences() {
    return { ...this.preferences }
  }

  subscribe(listener: (preferences: AudioPreferences) => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  setMusic(enabled: boolean) {
    this.preferences = { ...this.preferences, music: enabled }
    this.persist()
    if (enabled) void this.startMusic()
    else this.pauseMusic()
  }

  setEffects(enabled: boolean) {
    this.preferences = { ...this.preferences, effects: enabled }
    this.persist()
    if (enabled) this.play('select')
  }

  setMusicVolume(volume: number) {
    this.preferences = { ...this.preferences, musicVolume: clampVolume(volume) }
    if (this.music) this.music.volume = this.preferences.musicVolume
    this.persist()
  }

  setEffectsVolume(volume: number) {
    this.preferences = { ...this.preferences, effectsVolume: clampVolume(volume) }
    if (this.context && this.effectsBus) this.effectsBus.gain.setTargetAtTime(this.effectsGain(), this.context.currentTime, .025)
    this.persist()
  }

  play(sound: FarmSound) {
    if (!this.preferences.effects || typeof document === 'undefined' || document.hidden) return
    const audio = this.ensureContext()
    if (!audio || !this.effectsBus) return
    void audio.resume()
    const now = audio.currentTime + 0.008
    const recipes: Record<FarmSound, Array<[number, number, number, OscillatorType]>> = {
      select: [[520, 0, .055, 'sine']],
      open: [[420, 0, .07, 'sine'], [620, .055, .09, 'triangle']],
      close: [[560, 0, .06, 'sine'], [390, .045, .08, 'sine']],
      plant: [[190, 0, .09, 'triangle'], [280, .07, .12, 'sine']],
      water: [[900, 0, .07, 'sine'], [690, .055, .08, 'sine'], [510, .11, .12, 'sine']],
      harvest: [[523.25, 0, .16, 'triangle'], [659.25, .06, .18, 'triangle'], [783.99, .12, .24, 'sine']],
      steal: [[330, 0, .08, 'triangle'], [440, .045, .08, 'triangle'], [660, .09, .12, 'sine']],
      buy: [[659.25, 0, .1, 'triangle'], [987.77, .08, .18, 'sine']],
      sell: [[523.25, 0, .1, 'triangle'], [659.25, .065, .12, 'triangle'], [880, .13, .2, 'sine']],
      success: [[587.33, 0, .08, 'sine'], [783.99, .07, .14, 'triangle']],
      error: [[220, 0, .11, 'sawtooth'], [174.61, .09, .16, 'triangle']],
    }
    for (const [frequency, offset, duration, wave] of recipes[sound]) {
      this.note(this.effectsBus, frequency, now + offset, duration, sound === 'error' ? .065 : .052, wave)
    }
  }

  private persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.preferences)) } catch { /* optional preference */ }
    this.listeners.forEach((listener) => listener(this.getPreferences()))
  }

  private ensureMusic() {
    if (this.music) return this.music
    if (typeof Audio === 'undefined') return null
    const music = new Audio(MUSIC_SRC)
    music.loop = true
    music.preload = 'none'
    music.volume = this.preferences.musicVolume
    this.music = music
    return music
  }

  private async startMusic() {
    if (!this.preferences.music || typeof document === 'undefined' || document.hidden) return
    const music = this.ensureMusic()
    if (!music || !music.paused) return
    await music.play().catch(() => undefined)
  }

  private pauseMusic() {
    this.music?.pause()
  }

  private ensureContext() {
    if (typeof window === 'undefined') return null
    if (this.context) return this.context
    const AudioConstructor = (window.AudioContext ?? (window as typeof window & { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext)
    if (!AudioConstructor) return null
    const context = new AudioConstructor()
    const master = context.createGain()
    const effectsBus = context.createGain()
    const effectsCompressor = context.createDynamicsCompressor()
    master.gain.value = 1.16
    effectsBus.gain.value = this.effectsGain()
    effectsCompressor.threshold.value = -12
    effectsCompressor.knee.value = 10
    effectsCompressor.ratio.value = 4
    effectsCompressor.attack.value = .003
    effectsCompressor.release.value = .18
    effectsBus.connect(effectsCompressor)
    effectsCompressor.connect(master)
    master.connect(context.destination)
    this.context = context
    this.effectsBus = effectsBus
    return context
  }

  private effectsGain() {
    // Preserve fine control at low levels while giving the top half a stronger,
    // game-like response. The compressor catches overlapping effect peaks.
    return this.preferences.effectsVolume * (1.1 + this.preferences.effectsVolume * .65)
  }

  private note(bus: GainNode, frequency: number, at: number, duration: number, volume: number, wave: OscillatorType) {
    const context = this.context
    if (!context) return
    const oscillator = context.createOscillator()
    const envelope = context.createGain()
    oscillator.type = wave
    oscillator.frequency.setValueAtTime(frequency, at)
    envelope.gain.setValueAtTime(.0001, at)
    envelope.gain.exponentialRampToValueAtTime(Math.max(.0002, volume * 1.28), at + Math.min(.04, duration / 3))
    envelope.gain.exponentialRampToValueAtTime(.0001, at + duration)
    oscillator.connect(envelope)
    envelope.connect(bus)
    oscillator.start(at)
    oscillator.stop(at + duration + .03)
  }
}

export const farmAudio = new FarmAudioController()

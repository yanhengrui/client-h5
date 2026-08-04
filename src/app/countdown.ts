export function countdownSeconds(matureAt: string, now: number): number {
  const matureAtMs = Date.parse(matureAt)
  if (!Number.isFinite(matureAtMs)) return 0
  return Math.max(0, Math.floor((matureAtMs - now) / 1000))
}

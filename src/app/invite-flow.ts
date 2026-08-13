export const PENDING_INVITE_CODE_KEY = 'farm.pending-invite-code.v1'

export function normalizeInviteCode(value: string, baseOrigin = 'http://localhost') {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (!/^(https?:\/\/|\/|\?)/i.test(trimmed)) return trimmed
  try {
    const url = new URL(trimmed, baseOrigin)
    return url.searchParams.get('code')?.trim() ?? ''
  } catch {
    return ''
  }
}

export function buildInvitePath(code: string) {
  const normalized = normalizeInviteCode(code)
  return normalized ? `/invite?${new URLSearchParams({ code: normalized })}` : '/invite'
}

export function safeInternalPath(value: string | null) {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return null
  try {
    const url = new URL(value, 'http://farm.local')
    return url.origin === 'http://farm.local' ? `${url.pathname}${url.search}${url.hash}` : null
  } catch {
    return null
  }
}

export function buildInviteUrl(code: string, invitePath: string | undefined, origin: string) {
  const path = safeInternalPath(invitePath ?? '') ?? buildInvitePath(code)
  return new URL(path, origin).toString()
}

export function postAuthPath(pendingCode: string, redirect: string | null, ownFarmPath: string) {
  if (pendingCode) return buildInvitePath(pendingCode)
  return safeInternalPath(redirect) ?? ownFarmPath
}

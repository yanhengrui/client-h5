import { describe, expect, it } from 'vitest'
import { buildInvitePath, buildInviteUrl, normalizeInviteCode, postAuthPath, safeInternalPath } from './invite-flow'

describe('invite flow', () => {
  it('builds a client-relative path and a complete URL', () => {
    expect(buildInvitePath('invite code/+')).toBe('/invite?code=invite+code%2F%2B')
    expect(buildInviteUrl('fallback', '/invite?code=server-code', 'http://9.135.57.98:5173'))
      .toBe('http://9.135.57.98:5173/invite?code=server-code')
  })

  it('accepts either a raw code or a copied invite link', () => {
    expect(normalizeInviteCode(' 019f-code ')).toBe('019f-code')
    expect(normalizeInviteCode('https://farm.example/invite?code=019f-link')).toBe('019f-link')
  })

  it('allows only internal post-login redirects', () => {
    expect(safeInternalPath('/invite?code=abc')).toBe('/invite?code=abc')
    expect(safeInternalPath('//evil.example/steal')).toBeNull()
    expect(safeInternalPath('https://evil.example/steal')).toBeNull()
    expect(postAuthPath('pending', 'https://evil.example', '/u/42/farm')).toBe('/invite?code=pending')
    expect(postAuthPath('', '/farm/9', '/u/42/farm')).toBe('/farm/9')
  })
})

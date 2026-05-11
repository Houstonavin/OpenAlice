/**
 * Credential inference helpers — shared between the 0002 migration
 * and the runtime test path.
 *
 * Single source of truth for "given a profile-shaped record, what
 * vendor + authType does it represent?". The migration uses this to
 * extract credentials from inline profile fields. The test path uses
 * it to synthesize a Credential when the profile body comes from the
 * wizard and has no `credentialSlug` yet.
 */

import type { Credential, CredentialAuthType, CredentialVendor, ResolvedProfile } from './config.js'

/** Profile-like record — works on both raw migration data and ResolvedProfile. */
export interface ProfileLike {
  backend?: string
  loginMethod?: string
  apiKey?: string
  baseUrl?: string
  provider?: string
}

const VENDORS_BY_BASEURL: Array<[RegExp, CredentialVendor]> = [
  [/bigmodel\.cn|z\.ai/i, 'glm'],
  [/minimaxi\.com|minimax\.io/i, 'minimax'],
  [/moonshot\.cn|moonshot\.ai/i, 'kimi'],
  [/deepseek\.com/i, 'deepseek'],
]

export function inferVendor(profile: ProfileLike): CredentialVendor {
  const { backend, loginMethod } = profile
  const baseUrl = profile.baseUrl ?? ''

  if (backend === 'codex') return 'openai'

  if (backend === 'agent-sdk' && loginMethod === 'claudeai') return 'anthropic'

  if (backend === 'agent-sdk') {
    for (const [pattern, vendor] of VENDORS_BY_BASEURL) {
      if (pattern.test(baseUrl)) return vendor
    }
    return 'anthropic'
  }

  if (backend === 'vercel-ai-sdk') {
    const provider = profile.provider
    if (provider === 'openai' || provider === 'google' || provider === 'anthropic') return provider
    return 'anthropic'
  }

  return 'custom'
}

export function inferAuthType(profile: ProfileLike): CredentialAuthType {
  if (profile.loginMethod === 'claudeai' || profile.loginMethod === 'codex-oauth') {
    return 'subscription'
  }
  return 'api-key'
}

/** Whether the profile's inline fields contain a credential to extract. */
export function hasExtractableCredential(profile: ProfileLike): boolean {
  if (profile.apiKey) return true
  if (profile.loginMethod === 'claudeai' || profile.loginMethod === 'codex-oauth') return true
  return false
}

/** Build a Credential from a ResolvedProfile's inline credential fields. */
export function profileToCredential(profile: ResolvedProfile): Credential {
  const cred: Credential = {
    vendor: inferVendor(profile),
    authType: inferAuthType(profile),
  }
  if (profile.apiKey) cred.apiKey = profile.apiKey
  if (profile.baseUrl) cred.baseUrl = profile.baseUrl
  return cred
}

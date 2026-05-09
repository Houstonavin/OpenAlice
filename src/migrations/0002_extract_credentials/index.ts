/**
 * 0002_extract_credentials — peel credential storage off Profile.
 *
 * Today every Profile carries inline `apiKey` / `baseUrl` /
 * `loginMethod`. This migration adds a top-level `credentials` map
 * keyed by slug, infers a credential record per profile, and links
 * the profile to the credential via `credentialSlug`. Inline fields
 * are LEFT IN PLACE as a transitional fallback so providers don't
 * need to change in this round (resolveProfile() joins the two and
 * returns the same ResolvedProfile shape).
 *
 * Vendor / authType inference rules: see src/core/credential-inference.ts.
 *
 * In-body idempotency: if the credentials map exists and every
 * profile either has credentialSlug or has nothing to extract, no-op.
 */

import type { Migration, MigrationContext } from '../types.js'
import {
  inferVendor,
  inferAuthType,
  hasExtractableCredential,
  type ProfileLike,
} from '../../core/credential-inference.js'

interface RawProfile extends Record<string, unknown>, ProfileLike {
  credentialSlug?: string
}

interface CredentialRecord {
  vendor: string
  authType: 'api-key' | 'subscription'
  apiKey?: string
  baseUrl?: string
}

function generateSlug(vendor: string, taken: Set<string>): string {
  let n = 1
  while (taken.has(`${vendor}-${n}`)) n++
  return `${vendor}-${n}`
}

export const migration: Migration = {
  id: '0002_extract_credentials',
  appVersion: '0.10.0-beta.1',
  introducedAt: '2026-05-09',
  affects: ['ai-provider-manager.json'],
  summary:
    'Extract apiKey/baseUrl from profiles into top-level credentials map; profiles gain credentialSlug pointer (inline fields kept as fallback)',
  rationale:
    'Decouple credentials (vendor + auth) from SDK choice (backend) and use-case (model). Foundation for vendor-shaped preset catalog and internal SDK routing.',
  up: async (ctx: MigrationContext) => {
    const aiConfig = await ctx.readJson<{
      profiles?: Record<string, RawProfile>
      credentials?: Record<string, CredentialRecord>
      activeProfile?: string
      apiKeys?: Record<string, unknown>
    }>('ai-provider-manager.json')

    if (!aiConfig || !aiConfig.profiles) return

    // In-body idempotency check
    const profilesArr = Object.values(aiConfig.profiles)
    if (
      aiConfig.credentials !== undefined &&
      profilesArr.every((p) => p.credentialSlug !== undefined || !hasExtractableCredential(p))
    ) {
      return
    }

    const credentials: Record<string, CredentialRecord> = aiConfig.credentials ?? {}
    const taken = new Set(Object.keys(credentials))
    let changed = false

    for (const profile of profilesArr) {
      if (profile.credentialSlug) continue
      if (!hasExtractableCredential(profile)) continue

      const vendor = inferVendor(profile)
      const authType = inferAuthType(profile)
      const cred: CredentialRecord = { vendor, authType }
      if (profile.apiKey) cred.apiKey = profile.apiKey
      if (profile.baseUrl) cred.baseUrl = profile.baseUrl

      const slug = generateSlug(vendor, taken)
      taken.add(slug)
      credentials[slug] = cred
      profile.credentialSlug = slug
      changed = true
    }

    if (!changed && aiConfig.credentials !== undefined) return

    aiConfig.credentials = credentials
    await ctx.writeJson('ai-provider-manager.json', aiConfig)
  },
}

/**
 * 0003_backfill_credentials — backfill credentials for profiles that
 * landed between 0002 and the writeProfile eager-extraction change.
 *
 * Body is the same shape as 0002 (extract inline credential fields →
 * credentials map + link via credentialSlug, with dedup). 0002 ran
 * once at framework adoption; profiles added via the wizard *after*
 * that point arrived without credentialSlug because writeProfile was
 * still pass-through. This migration cleans those up.
 *
 * After this lands, the eager extraction in writeProfile prevents
 * future drift, so further backfills shouldn't be needed.
 *
 * In-body idempotency: if every profile already has credentialSlug or
 * has nothing extractable, no-op.
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

/** Match against existing credentials by all distinguishing fields. */
function findExistingSlug(
  cred: CredentialRecord,
  existing: Record<string, CredentialRecord>,
): string | null {
  for (const [slug, c] of Object.entries(existing)) {
    if (
      c.vendor === cred.vendor &&
      c.authType === cred.authType &&
      c.apiKey === cred.apiKey &&
      c.baseUrl === cred.baseUrl
    ) {
      return slug
    }
  }
  return null
}

export const migration: Migration = {
  id: '0003_backfill_credentials',
  appVersion: '0.10.0-beta.1',
  introducedAt: '2026-05-09',
  affects: ['ai-provider-manager.json'],
  summary:
    'Backfill credentials for profiles added between 0002 and writeProfile going eager (catches DeepSeek and similar stragglers)',
  rationale:
    'Companion to writeProfile eager extraction; cleans up the gap between 0002 and the AI Provider page redesign.',
  up: async (ctx: MigrationContext) => {
    const aiConfig = await ctx.readJson<{
      profiles?: Record<string, RawProfile>
      credentials?: Record<string, CredentialRecord>
      activeProfile?: string
    }>('ai-provider-manager.json')

    if (!aiConfig || !aiConfig.profiles) return

    const profilesArr = Object.values(aiConfig.profiles)
    if (profilesArr.every((p) => p.credentialSlug !== undefined || !hasExtractableCredential(p))) {
      return
    }

    const credentials: Record<string, CredentialRecord> = aiConfig.credentials ?? {}
    let changed = false

    for (const profile of profilesArr) {
      if (profile.credentialSlug) continue
      if (!hasExtractableCredential(profile)) continue

      const cred: CredentialRecord = {
        vendor: inferVendor(profile),
        authType: inferAuthType(profile),
      }
      if (profile.apiKey) cred.apiKey = profile.apiKey
      if (profile.baseUrl) cred.baseUrl = profile.baseUrl

      const existingSlug = findExistingSlug(cred, credentials)
      if (existingSlug) {
        profile.credentialSlug = existingSlug
      } else {
        const slug = generateSlug(cred.vendor, new Set(Object.keys(credentials)))
        credentials[slug] = cred
        profile.credentialSlug = slug
      }
      changed = true
    }

    if (!changed) return

    aiConfig.credentials = credentials
    await ctx.writeJson('ai-provider-manager.json', aiConfig)
  },
}

import { describe, it, expect } from 'vitest'
import type { MigrationContext } from './types.js'
import { migration } from './0003_backfill_credentials/index.js'

function makeMemoryContext(initial: Record<string, unknown> = {}): {
  ctx: MigrationContext
  files: Map<string, unknown>
} {
  const files = new Map<string, unknown>(Object.entries(initial))
  const ctx: MigrationContext = {
    async readJson<T>(filename: string): Promise<T | undefined> {
      const v = files.get(filename)
      return v === undefined ? undefined : JSON.parse(JSON.stringify(v))
    },
    async writeJson(filename: string, data: unknown): Promise<void> {
      files.set(filename, JSON.parse(JSON.stringify(data)))
    },
    async removeJson(filename: string): Promise<void> {
      files.delete(filename)
    },
    configDir(): string { return '/virtual/config' },
  }
  return { ctx, files }
}

function getCfg(files: Map<string, unknown>) {
  return files.get('ai-provider-manager.json') as {
    profiles: Record<string, Record<string, unknown>>
    credentials?: Record<string, { vendor: string; authType: string; apiKey?: string; baseUrl?: string }>
  }
}

describe('0003_backfill_credentials', () => {
  it('backfills a profile that has inline fields but no credentialSlug', async () => {
    const { ctx, files } = makeMemoryContext({
      'ai-provider-manager.json': {
        credentials: {
          'anthropic-1': { vendor: 'anthropic', authType: 'subscription' },
        },
        profiles: {
          'Old': { backend: 'agent-sdk', model: 'claude', loginMethod: 'claudeai', credentialSlug: 'anthropic-1' },
          'New': {
            backend: 'agent-sdk', model: 'm', loginMethod: 'api-key',
            apiKey: 'sk-deep', baseUrl: 'https://api.deepseek.com/anthropic',
          },
        },
        activeProfile: 'Old',
      },
    })

    await migration.up(ctx)
    const cfg = getCfg(files)
    expect(cfg.profiles.New.credentialSlug).toBe('deepseek-1')
    expect(cfg.credentials!['deepseek-1']).toEqual({
      vendor: 'deepseek',
      authType: 'api-key',
      apiKey: 'sk-deep',
      baseUrl: 'https://api.deepseek.com/anthropic',
    })
    // Existing credential untouched
    expect(cfg.credentials!['anthropic-1']).toEqual({ vendor: 'anthropic', authType: 'subscription' })
  })

  it('reuses existing credential slug when fields match (dedup)', async () => {
    const { ctx, files } = makeMemoryContext({
      'ai-provider-manager.json': {
        credentials: {
          'deepseek-1': { vendor: 'deepseek', authType: 'api-key', apiKey: 'sk-d', baseUrl: 'https://api.deepseek.com/anthropic' },
        },
        profiles: {
          // Same key + url — should reuse deepseek-1
          'NewOne': { backend: 'agent-sdk', model: 'a', loginMethod: 'api-key', apiKey: 'sk-d', baseUrl: 'https://api.deepseek.com/anthropic' },
        },
        activeProfile: 'NewOne',
      },
    })

    await migration.up(ctx)
    const cfg = getCfg(files)
    expect(cfg.profiles.NewOne.credentialSlug).toBe('deepseek-1')
    expect(Object.keys(cfg.credentials!)).toEqual(['deepseek-1']) // no duplicate created
  })

  it('no-op when every profile is already linked', async () => {
    const initial = {
      'ai-provider-manager.json': {
        credentials: { 'a-1': { vendor: 'anthropic', authType: 'subscription' } },
        profiles: { 'P': { backend: 'agent-sdk', model: 'm', loginMethod: 'claudeai', credentialSlug: 'a-1' } },
        activeProfile: 'P',
      },
    }
    const { ctx, files } = makeMemoryContext(initial)
    const before = JSON.stringify([...files.entries()])
    await migration.up(ctx)
    const after = JSON.stringify([...files.entries()])
    expect(after).toBe(before)
  })

  it('no-op when ai-provider-manager.json missing', async () => {
    const { ctx, files } = makeMemoryContext()
    await migration.up(ctx)
    expect(files.size).toBe(0)
  })

  it('idempotent — second run does not change file', async () => {
    const { ctx, files } = makeMemoryContext({
      'ai-provider-manager.json': {
        profiles: {
          'P': { backend: 'agent-sdk', model: 'm', loginMethod: 'api-key', apiKey: 'k' },
        },
        activeProfile: 'P',
      },
    })

    await migration.up(ctx)
    const afterFirst = JSON.stringify(files.get('ai-provider-manager.json'))
    await migration.up(ctx)
    const afterSecond = JSON.stringify(files.get('ai-provider-manager.json'))
    expect(afterSecond).toBe(afterFirst)
  })
})

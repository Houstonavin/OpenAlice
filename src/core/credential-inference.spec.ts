import { describe, it, expect } from 'vitest'
import {
  inferVendor,
  inferAuthType,
  hasExtractableCredential,
  profileToCredential,
  type ProfileLike,
} from './credential-inference.js'

describe('inferVendor', () => {
  it('codex backend → openai', () => {
    expect(inferVendor({ backend: 'codex', loginMethod: 'codex-oauth' })).toBe('openai')
    expect(inferVendor({ backend: 'codex', loginMethod: 'api-key' })).toBe('openai')
  })

  it('agent-sdk + claudeai → anthropic', () => {
    expect(inferVendor({ backend: 'agent-sdk', loginMethod: 'claudeai' })).toBe('anthropic')
  })

  it('agent-sdk + GLM baseUrl → glm', () => {
    expect(inferVendor({ backend: 'agent-sdk', loginMethod: 'api-key', baseUrl: 'https://open.bigmodel.cn/api/anthropic' })).toBe('glm')
    expect(inferVendor({ backend: 'agent-sdk', loginMethod: 'api-key', baseUrl: 'https://api.z.ai/api/anthropic' })).toBe('glm')
  })

  it('agent-sdk + MiniMax baseUrl → minimax', () => {
    expect(inferVendor({ backend: 'agent-sdk', loginMethod: 'api-key', baseUrl: 'https://api.minimaxi.com/anthropic' })).toBe('minimax')
    expect(inferVendor({ backend: 'agent-sdk', loginMethod: 'api-key', baseUrl: 'https://api.minimax.io/anthropic' })).toBe('minimax')
  })

  it('agent-sdk + Kimi baseUrl → kimi', () => {
    expect(inferVendor({ backend: 'agent-sdk', loginMethod: 'api-key', baseUrl: 'https://api.moonshot.cn/anthropic' })).toBe('kimi')
    expect(inferVendor({ backend: 'agent-sdk', loginMethod: 'api-key', baseUrl: 'https://api.moonshot.ai/anthropic' })).toBe('kimi')
  })

  it('agent-sdk + DeepSeek baseUrl → deepseek', () => {
    expect(inferVendor({ backend: 'agent-sdk', loginMethod: 'api-key', baseUrl: 'https://api.deepseek.com/anthropic' })).toBe('deepseek')
  })

  it('agent-sdk + api-key + no recognized baseUrl → anthropic', () => {
    expect(inferVendor({ backend: 'agent-sdk', loginMethod: 'api-key' })).toBe('anthropic')
    expect(inferVendor({ backend: 'agent-sdk', loginMethod: 'api-key', baseUrl: 'https://api.anthropic.com' })).toBe('anthropic')
  })

  it('vercel-ai-sdk uses provider field', () => {
    expect(inferVendor({ backend: 'vercel-ai-sdk', provider: 'google' })).toBe('google')
    expect(inferVendor({ backend: 'vercel-ai-sdk', provider: 'openai' })).toBe('openai')
    expect(inferVendor({ backend: 'vercel-ai-sdk', provider: 'anthropic' })).toBe('anthropic')
    expect(inferVendor({ backend: 'vercel-ai-sdk', provider: 'unknown' })).toBe('anthropic')
  })

  it('unknown backend → custom', () => {
    expect(inferVendor({ backend: 'something-else' } as ProfileLike)).toBe('custom')
    expect(inferVendor({} as ProfileLike)).toBe('custom')
  })
})

describe('inferAuthType', () => {
  it('claudeai or codex-oauth → subscription', () => {
    expect(inferAuthType({ loginMethod: 'claudeai' })).toBe('subscription')
    expect(inferAuthType({ loginMethod: 'codex-oauth' })).toBe('subscription')
  })

  it('api-key or absent → api-key', () => {
    expect(inferAuthType({ loginMethod: 'api-key' })).toBe('api-key')
    expect(inferAuthType({})).toBe('api-key')
  })
})

describe('hasExtractableCredential', () => {
  it('returns true when apiKey present', () => {
    expect(hasExtractableCredential({ apiKey: 'k' })).toBe(true)
  })

  it('returns true for subscription loginMethods even without apiKey', () => {
    expect(hasExtractableCredential({ loginMethod: 'claudeai' })).toBe(true)
    expect(hasExtractableCredential({ loginMethod: 'codex-oauth' })).toBe(true)
  })

  it('returns false when no apiKey and not subscription', () => {
    expect(hasExtractableCredential({})).toBe(false)
    expect(hasExtractableCredential({ loginMethod: 'api-key' })).toBe(false)
  })
})

describe('profileToCredential', () => {
  it('builds credential from inline profile fields', () => {
    const cred = profileToCredential({
      backend: 'agent-sdk',
      model: 'm',
      loginMethod: 'api-key',
      apiKey: 'sk-deep',
      baseUrl: 'https://api.deepseek.com/anthropic',
    })
    expect(cred).toEqual({
      vendor: 'deepseek',
      authType: 'api-key',
      apiKey: 'sk-deep',
      baseUrl: 'https://api.deepseek.com/anthropic',
    })
  })

  it('omits apiKey/baseUrl when absent (subscription)', () => {
    const cred = profileToCredential({
      backend: 'agent-sdk',
      model: 'claude-opus-4-7',
      loginMethod: 'claudeai',
    })
    expect(cred).toEqual({
      vendor: 'anthropic',
      authType: 'subscription',
    })
  })
})

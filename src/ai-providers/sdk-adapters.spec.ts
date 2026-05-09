import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  resolveTestAdapter,
  invokeAdapter,
  SDK_INVOKERS,
  type SdkAdapterDeclaration,
} from './sdk-adapters.js'
import { PRESET_CATALOG } from './preset-catalog.js'
import type { Credential, ResolvedProfile } from '../core/config.js'

// ==================== Mocked SDK packages — vercel-* invokers ====================

const mockGenerateText = vi.fn().mockResolvedValue({ text: 'mock response' })
const mockAnthropicClient = vi.fn().mockReturnValue('anthropic-model-instance')
const mockOpenAIClient = vi.fn().mockReturnValue('openai-model-instance')
const mockGoogleClient = vi.fn().mockReturnValue('google-model-instance')

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn().mockImplementation(() => mockAnthropicClient),
}))
vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn().mockImplementation(() => mockOpenAIClient),
}))
vi.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: vi.fn().mockImplementation(() => mockGoogleClient),
}))
vi.mock('ai', () => ({ generateText: mockGenerateText }))

beforeEach(() => {
  vi.clearAllMocks()
  mockGenerateText.mockResolvedValue({ text: 'mock response' })
})

// ==================== Preset declarations ====================

describe('PRESET_CATALOG sdkAdapters declarations', () => {
  it('every non-Custom preset declares sdkAdapters', () => {
    for (const preset of PRESET_CATALOG) {
      if (preset.id === 'custom') continue
      expect(preset.sdkAdapters, `preset ${preset.id} missing sdkAdapters`).toBeDefined()
    }
  })

  it("each preset's `test` adapter exists in `available`", () => {
    for (const preset of PRESET_CATALOG) {
      if (!preset.sdkAdapters) continue
      const ids = preset.sdkAdapters.available.map((a) => a.id)
      expect(ids, `preset ${preset.id}`).toContain(preset.sdkAdapters.test)
    }
  })

  it('Custom preset declares no sdkAdapters (fallback path)', () => {
    const custom = PRESET_CATALOG.find((p) => p.id === 'custom')!
    expect(custom.sdkAdapters).toBeUndefined()
  })
})

// ==================== resolveTestAdapter — preset path ====================

describe('resolveTestAdapter (preset path)', () => {
  function profile(preset: string, overrides: Partial<ResolvedProfile> = {}): ResolvedProfile {
    return { backend: 'agent-sdk', model: 'm', preset, ...overrides }
  }

  it('DeepSeek preset → vercel-anthropic with credential.baseUrl mapped to baseURL', () => {
    const decl = resolveTestAdapter(profile('deepseek'), PRESET_CATALOG)
    expect(decl.id).toBe('vercel-anthropic')

    const cred: Credential = { vendor: 'deepseek', authType: 'api-key', apiKey: 'k', baseUrl: 'https://api.deepseek.com/anthropic' }
    expect(decl.config(cred)).toEqual({ apiKey: 'k', baseURL: 'https://api.deepseek.com/anthropic' })
  })

  it('Claude OAuth preset → agent-sdk with loginMethod claudeai', () => {
    const decl = resolveTestAdapter(profile('claude-oauth'), PRESET_CATALOG)
    expect(decl.id).toBe('agent-sdk')

    const cred: Credential = { vendor: 'anthropic', authType: 'subscription' }
    expect(decl.config(cred)).toEqual({ loginMethod: 'claudeai' })
  })

  it('Claude API preset → vercel-anthropic (lighter than agent-sdk)', () => {
    const decl = resolveTestAdapter(profile('claude-api'), PRESET_CATALOG)
    expect(decl.id).toBe('vercel-anthropic')
  })

  it('Codex OAuth preset → codex with codex-oauth', () => {
    const decl = resolveTestAdapter(profile('codex-oauth', { backend: 'codex' }), PRESET_CATALOG)
    expect(decl.id).toBe('codex')
    const cred: Credential = { vendor: 'openai', authType: 'subscription' }
    expect(decl.config(cred)).toEqual({ loginMethod: 'codex-oauth' })
  })

  it('Codex API preset → vercel-openai', () => {
    const decl = resolveTestAdapter(profile('codex-api', { backend: 'codex' }), PRESET_CATALOG)
    expect(decl.id).toBe('vercel-openai')
  })

  it('Gemini preset → vercel-google', () => {
    const decl = resolveTestAdapter(profile('gemini', { backend: 'vercel-ai-sdk' }), PRESET_CATALOG)
    expect(decl.id).toBe('vercel-google')
  })

  it('MiniMax preset → vercel-anthropic with /v1 appended to baseUrl', () => {
    const decl = resolveTestAdapter(profile('minimax'), PRESET_CATALOG)
    expect(decl.id).toBe('vercel-anthropic')
    const cred: Credential = { vendor: 'minimax', authType: 'api-key', apiKey: 'k', baseUrl: 'https://api.minimaxi.com/anthropic' }
    expect(decl.config(cred)).toEqual({
      apiKey: 'k',
      baseURL: 'https://api.minimaxi.com/anthropic/v1', // MiniMax's path is /anthropic/v1/messages
    })
  })

  it('DeepSeek preset does NOT append /v1 (path is /anthropic/messages)', () => {
    const decl = resolveTestAdapter(profile('deepseek'), PRESET_CATALOG)
    const cred: Credential = { vendor: 'deepseek', authType: 'api-key', apiKey: 'k', baseUrl: 'https://api.deepseek.com/anthropic' }
    expect(decl.config(cred)).toEqual({
      apiKey: 'k',
      baseURL: 'https://api.deepseek.com/anthropic', // unchanged
    })
  })

  it('agent-sdk fallback config uses baseUrl (not baseURL)', () => {
    // Agent SDK's standard field name is baseUrl (lowercase u)
    const decl = resolveTestAdapter(profile('claude-api'), PRESET_CATALOG)
    const altDecl = decl.id === 'vercel-anthropic'
      ? PRESET_CATALOG.find(p => p.id === 'claude-api')!.sdkAdapters!.available.find(a => a.id === 'agent-sdk')!
      : decl
    const cred: Credential = { vendor: 'anthropic', authType: 'api-key', apiKey: 'k', baseUrl: 'https://x' }
    const cfg = altDecl.config(cred) as { baseUrl?: string; baseURL?: string }
    expect(cfg.baseUrl).toBe('https://x')
    expect(cfg.baseURL).toBeUndefined()
  })
})

// ==================== resolveTestAdapter — fallback synthesis ====================

describe('resolveTestAdapter (fallback)', () => {
  it('Custom preset with backend=agent-sdk → synthesized agent-sdk decl', () => {
    const profile: ResolvedProfile = {
      backend: 'agent-sdk', model: 'm', preset: 'custom', loginMethod: 'api-key',
    }
    const decl = resolveTestAdapter(profile, PRESET_CATALOG)
    expect(decl.id).toBe('agent-sdk')
    const cred: Credential = { vendor: 'custom', authType: 'api-key', apiKey: 'k', baseUrl: 'https://x' }
    expect(decl.config(cred)).toEqual({ apiKey: 'k', baseUrl: 'https://x', loginMethod: 'api-key' })
  })

  it('Custom preset with backend=codex → synthesized codex decl', () => {
    const profile: ResolvedProfile = { backend: 'codex', model: 'm', preset: 'custom', loginMethod: 'api-key' }
    const decl = resolveTestAdapter(profile, PRESET_CATALOG)
    expect(decl.id).toBe('codex')
  })

  it('Custom preset with backend=vercel-ai-sdk + provider=openai → vercel-openai', () => {
    const profile: ResolvedProfile = { backend: 'vercel-ai-sdk', model: 'm', preset: 'custom', provider: 'openai' }
    const decl = resolveTestAdapter(profile, PRESET_CATALOG)
    expect(decl.id).toBe('vercel-openai')
  })

  it('Custom + provider=google → vercel-google', () => {
    const profile: ResolvedProfile = { backend: 'vercel-ai-sdk', model: 'm', preset: 'custom', provider: 'google' }
    expect(resolveTestAdapter(profile, PRESET_CATALOG).id).toBe('vercel-google')
  })

  it('Profile with no preset field → falls back via backend', () => {
    const profile: ResolvedProfile = { backend: 'agent-sdk', model: 'm', loginMethod: 'claudeai' }
    const decl = resolveTestAdapter(profile, PRESET_CATALOG)
    expect(decl.id).toBe('agent-sdk')
    expect(decl.config({ vendor: 'anthropic', authType: 'subscription' })).toEqual({
      apiKey: undefined, baseUrl: undefined, loginMethod: 'claudeai',
    })
  })
})

// ==================== invokeAdapter end-to-end ====================

describe('invokeAdapter (vercel-* invokers wire correctly)', () => {
  it('vercel-anthropic invoker calls createAnthropic + generateText with the right args', async () => {
    const decl: SdkAdapterDeclaration = {
      id: 'vercel-anthropic',
      config: (c) => ({ apiKey: c.apiKey, baseURL: c.baseUrl }),
    }
    const cred: Credential = { vendor: 'deepseek', authType: 'api-key', apiKey: 'sk-deep', baseUrl: 'https://api.deepseek.com/anthropic' }

    const result = await invokeAdapter(decl, cred, 'deepseek-v4-pro', 'Hi', { providers: {} })

    expect(result.text).toBe('mock response')
    const { createAnthropic } = await import('@ai-sdk/anthropic')
    expect(createAnthropic).toHaveBeenCalledWith({
      apiKey: 'sk-deep',
      baseURL: 'https://api.deepseek.com/anthropic',
    })
    expect(mockAnthropicClient).toHaveBeenCalledWith('deepseek-v4-pro')
    expect(mockGenerateText).toHaveBeenCalledWith({
      model: 'anthropic-model-instance',
      prompt: 'Hi',
    })
  })

  it('vercel-openai invoker calls createOpenAI', async () => {
    const decl: SdkAdapterDeclaration = {
      id: 'vercel-openai',
      config: (c) => ({ apiKey: c.apiKey, baseURL: c.baseUrl }),
    }
    const cred: Credential = { vendor: 'openai', authType: 'api-key', apiKey: 'sk-oa' }

    await invokeAdapter(decl, cred, 'gpt-5.4', 'Hi', { providers: {} })

    const { createOpenAI } = await import('@ai-sdk/openai')
    expect(createOpenAI).toHaveBeenCalledWith({ apiKey: 'sk-oa', baseURL: undefined })
  })

  it('vercel-google invoker calls createGoogleGenerativeAI', async () => {
    const decl: SdkAdapterDeclaration = {
      id: 'vercel-google',
      config: (c) => ({ apiKey: c.apiKey, baseURL: c.baseUrl }),
    }
    const cred: Credential = { vendor: 'google', authType: 'api-key', apiKey: 'sk-google' }

    await invokeAdapter(decl, cred, 'gemini-2.5-flash', 'Hi', { providers: {} })

    const { createGoogleGenerativeAI } = await import('@ai-sdk/google')
    expect(createGoogleGenerativeAI).toHaveBeenCalledWith({ apiKey: 'sk-google', baseURL: undefined })
  })

  it('agent-sdk invoker delegates to deps.providers["agent-sdk"].ask', async () => {
    const mockAsk = vi.fn().mockResolvedValue({ text: 'agent-sdk reply', media: [] })
    const fakeProvider = { ask: mockAsk } as never

    const decl: SdkAdapterDeclaration = {
      id: 'agent-sdk',
      config: () => ({ loginMethod: 'claudeai' }),
    }
    const cred: Credential = { vendor: 'anthropic', authType: 'subscription' }

    const result = await invokeAdapter(decl, cred, 'claude-opus-4-7', 'Hi', {
      providers: { 'agent-sdk': fakeProvider },
    })

    expect(result.text).toBe('agent-sdk reply')
    expect(mockAsk).toHaveBeenCalledWith('Hi', expect.objectContaining({
      backend: 'agent-sdk',
      model: 'claude-opus-4-7',
      loginMethod: 'claudeai',
    }))
  })

  it('agent-sdk invoker throws when provider not registered', async () => {
    const decl: SdkAdapterDeclaration = {
      id: 'agent-sdk',
      config: () => ({ loginMethod: 'api-key' }),
    }
    await expect(invokeAdapter(decl, { vendor: 'anthropic', authType: 'api-key' }, 'm', 'Hi', { providers: {} }))
      .rejects.toThrow(/agent-sdk provider not registered/)
  })

  it('codex invoker delegates to deps.providers["codex"].ask', async () => {
    const mockAsk = vi.fn().mockResolvedValue({ text: 'codex reply', media: [] })
    const decl: SdkAdapterDeclaration = {
      id: 'codex',
      config: () => ({ loginMethod: 'codex-oauth' }),
    }
    await invokeAdapter(decl, { vendor: 'openai', authType: 'subscription' }, 'gpt-5.4', 'Hi', {
      providers: { 'codex': { ask: mockAsk } as never },
    })
    expect(mockAsk).toHaveBeenCalledWith('Hi', expect.objectContaining({ backend: 'codex' }))
  })
})

// ==================== SDK_INVOKERS surface ====================

describe('SDK_INVOKERS registry', () => {
  it('has all five adapter ids', () => {
    expect(Object.keys(SDK_INVOKERS).sort()).toEqual([
      'agent-sdk', 'codex', 'vercel-anthropic', 'vercel-google', 'vercel-openai',
    ])
  })
})

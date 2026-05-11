/**
 * SDK adapters — credential / implementation separation.
 *
 * The preset is the registry: each preset declares the list of SDK
 * adapters its credential can drive, along with a builder per adapter
 * that maps the credential into the SDK's standardized config shape.
 *
 * This avoids reverse-lookup ("provider, please dig fields out of the
 * credential record") — different SDKs have different field names
 * (vercel uses `baseURL`, agent-sdk uses `baseUrl`), so a uniform
 * "credential.X → sdk.Y" mapping doesn't exist. The preset spells it
 * out explicitly per adapter.
 *
 * Test path: each preset declares a `test` adapter id. The runtime
 * looks up the matching declaration, runs the config builder against
 * the credential, and dispatches to SDK_INVOKERS[id] with the typed
 * config.
 *
 * vercel-* invokers are bare-minimum: no tools, no system prompt, no
 * media. agent-sdk and codex invokers delegate to existing providers
 * (subscription auth physically requires the heavy harness).
 */

import type { Credential, ResolvedProfile } from '../core/config.js'
import type { AIProvider, ProviderResult } from './types.js'
import { PRESET_CATALOG } from './preset-catalog.js'

// ==================== Adapter ids and typed configs ====================

export type SdkAdapterId =
  | 'agent-sdk'
  | 'codex'
  | 'vercel-anthropic'
  | 'vercel-openai'
  | 'vercel-google'

/** Display labels + one-line descriptions, surfaced in the AI Provider page. */
export const SDK_ADAPTER_LABELS: Record<SdkAdapterId, { label: string; description: string }> = {
  'agent-sdk': {
    label: 'Claude Agent SDK',
    description: 'Heavy subprocess; required for Claude Pro/Max subscription auth.',
  },
  'codex': {
    label: 'Codex (OpenAI Responses)',
    description: 'OpenAI Responses API via official SDK; required for ChatGPT subscription.',
  },
  'vercel-anthropic': {
    label: 'Vercel Anthropic',
    description: 'Lightweight HTTP via @ai-sdk/anthropic — direct Messages API call.',
  },
  'vercel-openai': {
    label: 'Vercel OpenAI',
    description: 'Lightweight HTTP via @ai-sdk/openai — direct Chat Completions call.',
  },
  'vercel-google': {
    label: 'Vercel Google',
    description: 'Lightweight HTTP via @ai-sdk/google — Gemini API.',
  },
}

/** Endpoint payload shape for GET /api/config/sdk-adapters. */
export interface SdkAdapterInfo {
  id: SdkAdapterId
  label: string
  description: string
  /** Presets that register this adapter as available, in catalog order. */
  presets: Array<{ presetId: string; presetLabel: string; isTestDefault: boolean }>
}

/** Compute the SDK adapter info list — used by both the route handler and tests. */
export function getSdkAdapterInfo(): SdkAdapterInfo[] {
  const ids: SdkAdapterId[] = ['agent-sdk', 'codex', 'vercel-anthropic', 'vercel-openai', 'vercel-google']
  return ids.map((id) => ({
    id,
    label: SDK_ADAPTER_LABELS[id].label,
    description: SDK_ADAPTER_LABELS[id].description,
    presets: PRESET_CATALOG.flatMap((preset) => {
      if (!preset.sdkAdapters) return []
      const isAvailable = preset.sdkAdapters.available.some((a) => a.id === id)
      if (!isAvailable) return []
      return [{
        presetId: preset.id,
        presetLabel: preset.label,
        isTestDefault: preset.sdkAdapters.test === id,
      }]
    }),
  }))
}

/**
 * SDK config shape per adapter — field names match each SDK's own
 * standard. Don't normalize; pass through as-is.
 */
export interface SdkConfigByAdapter {
  'agent-sdk':        { apiKey?: string; baseUrl?: string; loginMethod: 'api-key' | 'claudeai' }
  'codex':            { apiKey?: string; baseUrl?: string; loginMethod: 'api-key' | 'codex-oauth' }
  'vercel-anthropic': { apiKey?: string; baseURL?: string }
  'vercel-openai':    { apiKey?: string; baseURL?: string }
  'vercel-google':    { apiKey?: string; baseURL?: string }
}

/** Discriminated union: narrowing on `id` types `config`'s return automatically. */
export type SdkAdapterDeclaration = {
  [K in SdkAdapterId]: {
    id: K
    /** Map a credential into this SDK's typed config. */
    config: (cred: Credential) => SdkConfigByAdapter[K]
  }
}[SdkAdapterId]

// ==================== Invoker registry ====================

export interface SdkInvokerDeps {
  /** Map of registered AIProvider instances keyed by backend. Heavy
   *  invokers (agent-sdk, codex) delegate via this. */
  providers: Record<string, AIProvider>
}

export interface SdkInvoker<K extends SdkAdapterId> {
  invoke(
    config: SdkConfigByAdapter[K],
    model: string,
    prompt: string,
    deps: SdkInvokerDeps,
  ): Promise<ProviderResult>
}

export const SDK_INVOKERS: { [K in SdkAdapterId]: SdkInvoker<K> } = {
  'vercel-anthropic': {
    async invoke(config, model, prompt) {
      const { createAnthropic } = await import('@ai-sdk/anthropic')
      const { generateText } = await import('ai')
      const client = createAnthropic({
        apiKey: config.apiKey,
        baseURL: config.baseURL || undefined,
      })
      const result = await generateText({ model: client(model), prompt })
      return { text: result.text ?? '', media: [] }
    },
  },

  'vercel-openai': {
    async invoke(config, model, prompt) {
      const { createOpenAI } = await import('@ai-sdk/openai')
      const { generateText } = await import('ai')
      const client = createOpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseURL || undefined,
      })
      const result = await generateText({ model: client(model), prompt })
      return { text: result.text ?? '', media: [] }
    },
  },

  'vercel-google': {
    async invoke(config, model, prompt) {
      const { createGoogleGenerativeAI } = await import('@ai-sdk/google')
      const { generateText } = await import('ai')
      const client = createGoogleGenerativeAI({
        apiKey: config.apiKey,
        baseURL: config.baseURL || undefined,
      })
      const result = await generateText({ model: client(model), prompt })
      return { text: result.text ?? '', media: [] }
    },
  },

  'agent-sdk': {
    async invoke(config, model, prompt, deps) {
      const provider = deps.providers['agent-sdk']
      if (!provider) throw new Error('agent-sdk provider not registered')
      return provider.ask(prompt, {
        backend: 'agent-sdk',
        model,
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        loginMethod: config.loginMethod,
      })
    },
  },

  'codex': {
    async invoke(config, model, prompt, deps) {
      const provider = deps.providers['codex']
      if (!provider) throw new Error('codex provider not registered')
      return provider.ask(prompt, {
        backend: 'codex',
        model,
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        loginMethod: config.loginMethod,
      })
    },
  },
}

// ==================== Test-path resolver ====================

/**
 * Given a profile and the preset catalog, return the adapter
 * declaration to use for the test path.
 *
 * Preset path (built-in presets): use the preset's declared `test`
 * adapter.
 *
 * Fallback path (Custom preset, or legacy profiles without preset):
 * synthesize a declaration from `profile.backend` + `profile.provider`,
 * mapping the credential's inline fields directly. This preserves
 * current behavior for users who configured Custom + agent-sdk, etc.
 */
export function resolveTestAdapter(
  profile: ResolvedProfile,
  presets: Array<{ id: string; sdkAdapters?: { available: SdkAdapterDeclaration[]; test: SdkAdapterId } }>,
): SdkAdapterDeclaration {
  if (profile.preset) {
    const preset = presets.find((p) => p.id === profile.preset)
    if (preset?.sdkAdapters) {
      const found = preset.sdkAdapters.available.find((a) => a.id === preset.sdkAdapters!.test)
      if (found) return found
    }
  }

  // Fallback synthesis — honor the profile's own backend/provider
  if (profile.backend === 'agent-sdk') {
    const lm = (profile.loginMethod as 'api-key' | 'claudeai' | undefined) ?? 'api-key'
    return {
      id: 'agent-sdk',
      config: (c) => ({ apiKey: c.apiKey, baseUrl: c.baseUrl, loginMethod: lm }),
    }
  }
  if (profile.backend === 'codex') {
    const lm = (profile.loginMethod as 'api-key' | 'codex-oauth' | undefined) ?? 'codex-oauth'
    return {
      id: 'codex',
      config: (c) => ({ apiKey: c.apiKey, baseUrl: c.baseUrl, loginMethod: lm }),
    }
  }
  // vercel-ai-sdk fallback — picks vercel-* adapter from profile.provider
  if (profile.provider === 'openai') {
    return { id: 'vercel-openai', config: (c) => ({ apiKey: c.apiKey, baseURL: c.baseUrl }) }
  }
  if (profile.provider === 'google') {
    return { id: 'vercel-google', config: (c) => ({ apiKey: c.apiKey, baseURL: c.baseUrl }) }
  }
  return { id: 'vercel-anthropic', config: (c) => ({ apiKey: c.apiKey, baseURL: c.baseUrl }) }
}

/**
 * Run an adapter declaration end-to-end: build the SDK config from
 * the credential, then dispatch to the invoker.
 *
 * Use of `as never` here is the standard discriminated-union TS dance —
 * at runtime, decl.id matches the invoker's expected config type, but
 * the compiler can't narrow the cross-product. Tests verify dispatch.
 */
export async function invokeAdapter(
  decl: SdkAdapterDeclaration,
  credential: Credential,
  model: string,
  prompt: string,
  deps: SdkInvokerDeps,
): Promise<ProviderResult> {
  const config = decl.config(credential)
  const invoker = SDK_INVOKERS[decl.id]
  return (invoker as SdkInvoker<typeof decl.id>).invoke(config as never, model, prompt, deps)
}

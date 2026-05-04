import { Hono } from 'hono'
import { SessionStore } from '../../../core/session.js'
import { readWebSubchannels, writeWebSubchannels } from '../../../core/config.js'
import type { WebChannel } from '../../../core/types.js'
import type { SSEClient } from './chat.js'

interface ChannelsDeps {
  sessions: Map<string, SessionStore>
  sseByChannel: Map<string, Map<string, SSEClient>>
}

/** Channels CRUD: GET /, POST /, PUT /:id, DELETE /:id */
export function createChannelsRoutes({ sessions, sseByChannel }: ChannelsDeps) {
  const app = new Hono()

  /**
   * GET / — list all channels.
   * Default is always first. If subchannels file has a stored 'default' entry
   * (because the user renamed it), use that; otherwise fall back to the
   * built-in label.
   */
  app.get('/', async (c) => {
    const subChannels = await readWebSubchannels()
    const defaultEntry = subChannels.find((ch) => ch.id === 'default') ?? { id: 'default', label: 'Alice' }
    const others = subChannels.filter((ch) => ch.id !== 'default')
    return c.json({ channels: [defaultEntry, ...others] })
  })

  /** POST / — create a new sub-channel */
  app.post('/', async (c) => {
    const body = await c.req.json() as {
      id?: string
      label?: string
      systemPrompt?: string
      profile?: string
      disabledTools?: string[]
    }

    if (!body.id || !/^[a-z0-9-_]+$/.test(body.id)) {
      return c.json({ error: 'id must be lowercase alphanumeric with hyphens/underscores' }, 400)
    }
    if (body.id === 'default') {
      return c.json({ error: 'cannot use reserved id "default"' }, 400)
    }
    if (!body.label?.trim()) {
      return c.json({ error: 'label is required' }, 400)
    }

    const existing = await readWebSubchannels()
    if (existing.find((ch) => ch.id === body.id)) {
      return c.json({ error: 'channel id already exists' }, 409)
    }

    const newChannel: WebChannel = {
      id: body.id,
      label: body.label.trim(),
      ...(body.systemPrompt ? { systemPrompt: body.systemPrompt } : {}),
      ...(body.profile ? { profile: body.profile } : {}),
      ...(body.disabledTools?.length ? { disabledTools: body.disabledTools } : {}),
    }

    await writeWebSubchannels([...existing, newChannel])

    // Initialize session and SSE map for the new channel
    const session = new SessionStore(`web/${body.id}`)
    await session.restore()
    sessions.set(body.id, session)
    sseByChannel.set(body.id, new Map())

    return c.json({ channel: newChannel }, 201)
  })

  /**
   * PUT /:id — update a channel (including default).
   * Default is editable but can't be deleted; on first edit it's inserted
   * into the subchannels file as a regular entry.
   */
  app.put('/:id', async (c) => {
    const id = c.req.param('id')

    const body = await c.req.json() as {
      label?: string
      systemPrompt?: string
      profile?: string | null
      disabledTools?: string[]
    }

    const existing = await readWebSubchannels()
    const idx = existing.findIndex((ch) => ch.id === id)

    // First-time edit of default: it's not yet persisted, insert it.
    if (idx === -1) {
      if (id !== 'default') return c.json({ error: 'channel not found' }, 404)
      const inserted: WebChannel = {
        id: 'default',
        label: body.label?.trim() || 'Alice',
        ...(body.systemPrompt ? { systemPrompt: body.systemPrompt } : {}),
        ...(body.profile ? { profile: body.profile } : {}),
        ...(body.disabledTools?.length ? { disabledTools: body.disabledTools } : {}),
      }
      await writeWebSubchannels([...existing, inserted])
      return c.json({ channel: inserted })
    }

    const updated: WebChannel = {
      ...existing[idx],
      ...(body.label !== undefined ? { label: body.label } : {}),
      ...(body.systemPrompt !== undefined ? { systemPrompt: body.systemPrompt || undefined } : {}),
      ...(body.profile !== undefined ? { profile: body.profile || undefined } : {}),
      ...(body.disabledTools !== undefined ? { disabledTools: body.disabledTools?.length ? body.disabledTools : undefined } : {}),
    }
    existing[idx] = updated
    await writeWebSubchannels(existing)

    return c.json({ channel: updated })
  })

  /** DELETE /:id — delete a sub-channel */
  app.delete('/:id', async (c) => {
    const id = c.req.param('id')
    if (id === 'default') return c.json({ error: 'cannot delete default channel' }, 400)

    const existing = await readWebSubchannels()
    if (!existing.find((ch) => ch.id === id)) return c.json({ error: 'channel not found' }, 404)

    await writeWebSubchannels(existing.filter((ch) => ch.id !== id))

    // Clean up in-memory state
    sessions.delete(id)
    sseByChannel.delete(id)

    return c.json({ success: true })
  })

  return app
}

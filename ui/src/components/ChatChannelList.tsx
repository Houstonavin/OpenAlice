import { useState } from 'react'
import type { ChannelListItem } from '../api/channels'

interface ChatChannelListProps {
  channels: ChannelListItem[]
  activeChannel: string
  showNewForm: boolean
  onCloseNewForm: () => void
  onSelect: (id: string) => void
  onEdit: (channel: ChannelListItem) => void
  onDelete: (id: string) => void
  onCreate: (id: string, label: string) => Promise<void>
}

export function ChatChannelList({
  channels,
  activeChannel,
  showNewForm,
  onCloseNewForm,
  onSelect,
  onEdit,
  onDelete,
  onCreate,
}: ChatChannelListProps) {
  return (
    <div className="py-0.5">
      {showNewForm && <NewChannelForm onCreate={onCreate} onCancel={onCloseNewForm} />}

      {channels.map((ch) => {
        // 'default' is editable but not deletable — it's the connector's
        // default-session pointer and must keep existing.
        const deletable = ch.id !== 'default'
        return (
          <ChannelRow
            key={ch.id}
            channel={ch}
            active={activeChannel === ch.id}
            onSelect={() => onSelect(ch.id)}
            onEdit={() => onEdit(ch)}
            onDelete={deletable ? () => onDelete(ch.id) : undefined}
          />
        )
      })}

      {channels.length === 0 && !showNewForm && (
        <p className="px-3 py-2 text-[12px] text-text-muted/60">Loading…</p>
      )}
    </div>
  )
}

interface ChannelRowProps {
  channel: ChannelListItem
  active: boolean
  onSelect: () => void
  onEdit: () => void
  /** Omit to render no delete button (e.g. for the protected `default` channel). */
  onDelete?: () => void
}

function ChannelRow({ channel, active, onSelect, onEdit, onDelete }: ChannelRowProps) {
  return (
    <div
      onClick={onSelect}
      className={`group flex items-center gap-1 px-3 py-1 cursor-pointer text-[13px] transition-colors ${
        active
          ? 'bg-bg-tertiary text-text'
          : 'text-text-muted hover:text-text hover:bg-bg-tertiary/50'
      }`}
    >
      <span className="flex-1 truncate">
        <span className="text-text-muted/60 mr-0.5">#</span>
        {channel.label}
      </span>
      <span className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={(e) => { e.stopPropagation(); onEdit() }}
          className="w-5 h-5 rounded flex items-center justify-center text-text-muted hover:text-text hover:bg-bg-secondary"
          title="Settings"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
        {onDelete && (
          <button
            onClick={(e) => { e.stopPropagation(); onDelete() }}
            className="w-5 h-5 rounded flex items-center justify-center text-text-muted hover:text-red-400 hover:bg-red-400/10"
            title="Delete"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        )}
      </span>
    </div>
  )
}

interface NewChannelFormProps {
  onCreate: (id: string, label: string) => Promise<void>
  onCancel: () => void
}

function NewChannelForm({ onCreate, onCancel }: NewChannelFormProps) {
  const [id, setId] = useState('')
  const [label, setLabel] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async () => {
    setError('')
    if (!id.trim() || !label.trim()) {
      setError('ID and label are required')
      return
    }
    setSubmitting(true)
    try {
      await onCreate(id.trim(), label.trim())
      onCancel()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="px-3 py-2 mx-1 mb-1 space-y-1.5 rounded border border-border bg-bg-tertiary/30">
      <input
        type="text"
        placeholder="id (e.g. research)"
        value={id}
        onChange={(e) => setId(e.target.value.toLowerCase().replace(/[^a-z0-9-_]/g, ''))}
        className="w-full text-xs px-2 py-1 rounded border border-border bg-bg-secondary text-text placeholder:text-text-muted focus:outline-none focus:border-accent"
        autoFocus
      />
      <input
        type="text"
        placeholder="label"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit() }}
        className="w-full text-xs px-2 py-1 rounded border border-border bg-bg-secondary text-text placeholder:text-text-muted focus:outline-none focus:border-accent"
      />
      <div className="flex items-center gap-2">
        <button
          onClick={handleSubmit}
          disabled={submitting}
          className="text-xs px-2.5 py-1 rounded bg-accent text-white hover:bg-accent/80 disabled:opacity-50 transition-colors"
        >
          {submitting ? '...' : 'Create'}
        </button>
        <button
          onClick={onCancel}
          className="text-xs px-2 py-1 rounded text-text-muted hover:text-text"
        >
          Cancel
        </button>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  )
}

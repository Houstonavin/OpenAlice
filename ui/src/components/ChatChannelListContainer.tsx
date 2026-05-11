import { Bell, Notebook } from 'lucide-react'
import { useChannels } from '../contexts/ChannelsContext'
import { useWorkspace } from '../tabs/store'
import { getFocusedTab } from '../tabs/types'
import { useUnreadNotificationsCount } from '../live/notifications-read'
import { ChatChannelList } from './ChatChannelList'
import { SidebarRow } from './SidebarRow'

/**
 * Connects ChatChannelList to ChannelsContext + the workspace store.
 *
 * Layout reflects the framing of "Chat" as the catch-all activity for
 * interactions with Alice — not strictly chat:
 *
 *   - Notifications  (inbound system pushes; unread badge)
 *   - Diary          (Alice's first-person output stream — read-only)
 *   ─────
 *   - Channels       (the chat conversations the user opens)
 *
 * The two upper rows are "Alice surfaces"; the channel list is "user
 * actions". They share this sidebar because the unifying mental model
 * is "everything Alice-shaped" rather than "places to type messages".
 *
 * Active row tracking is derived from the focused tab — switching tabs
 * naturally shifts the highlight without bespoke wiring.
 */
export function ChatChannelListContainer() {
  const { channels, openEditDialog, deleteChannel } = useChannels()
  const focused = useWorkspace((state) => getFocusedTab(state)?.spec)
  const focusedKind = focused?.kind
  const focusedChannelId = focusedKind === 'chat' ? focused.params.channelId : ''
  const inboxActive = focusedKind === 'notifications-inbox'
  const diaryActive = focusedKind === 'diary'
  const openOrFocus = useWorkspace((state) => state.openOrFocus)
  const unreadCount = useUnreadNotificationsCount()

  return (
    <div className="flex flex-col h-full">
      <div className="py-0.5 space-y-0.5">
        <SidebarRow
          label={
            <span className="flex items-center gap-2">
              <Bell size={14} strokeWidth={1.8} className="shrink-0" />
              <span>Notifications</span>
            </span>
          }
          active={inboxActive}
          onClick={() => openOrFocus({ kind: 'notifications-inbox', params: {} })}
          trail={
            unreadCount > 0 ? (
              <span
                className="min-w-[16px] h-[16px] px-1 rounded-full bg-red text-[10px] font-semibold text-white tabular-nums flex items-center justify-center"
                aria-label={`${unreadCount} unread`}
              >
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            ) : undefined
          }
        />
        <SidebarRow
          label={
            <span className="flex items-center gap-2">
              <Notebook size={14} strokeWidth={1.8} className="shrink-0" />
              <span>Diary</span>
            </span>
          }
          active={diaryActive}
          onClick={() => openOrFocus({ kind: 'diary', params: {} })}
        />
      </div>

      <div className="mt-2 px-3 text-[10px] font-medium text-text-muted/60 uppercase tracking-wider">
        Channels
      </div>
      <div className="flex-1 overflow-y-auto min-h-0 mt-0.5">
        <ChatChannelList
          channels={channels}
          activeChannel={focusedChannelId}
          onSelect={(id) => openOrFocus({ kind: 'chat', params: { channelId: id } })}
          onEdit={openEditDialog}
          onDelete={deleteChannel}
        />
      </div>
    </div>
  )
}

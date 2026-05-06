import { useWorkspace } from '../tabs/store'
import { getFocusedTab } from '../tabs/types'
import { SidebarRow } from './SidebarRow'

/**
 * Automation sidebar — phase-2 placeholder. Single "Overview" item that
 * opens the existing AutomationPage. Phase 3+ splits into heartbeats /
 * crons / webhooks / listeners lists, each opening per-rule detail tabs.
 */
export function AutomationSidebar() {
  const focusedKind = useWorkspace((state) => getFocusedTab(state)?.spec.kind ?? null)
  const openOrFocus = useWorkspace((state) => state.openOrFocus)

  return (
    <div className="py-0.5">
      <SidebarRow
        label="Overview"
        active={focusedKind === 'automation'}
        onClick={() => openOrFocus({ kind: 'automation', params: {} })}
      />
    </div>
  )
}

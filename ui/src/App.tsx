import { useState, useEffect, useCallback } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { Sidebar, isSettingsGroupedRoute } from './components/Sidebar'
import { SecondarySidebar } from './components/SecondarySidebar'
import { ChatChannelList } from './components/ChatChannelList'
import { SettingsCategoryList } from './components/SettingsCategoryList'
import { DevCategoryList } from './components/DevCategoryList'
import { ChannelConfigModal } from './components/ChannelConfigModal'
import { ChatPage } from './pages/ChatPage'
import { DiaryPage } from './pages/DiaryPage'
import { PortfolioPage } from './pages/PortfolioPage'
import { AutomationPage } from './pages/AutomationPage'
import { SettingsPage } from './pages/SettingsPage'
import { AIProviderPage } from './pages/AIProviderPage'
import { MarketDataPage } from './pages/MarketDataPage'
import { MarketPage } from './pages/MarketPage'
import { MarketDetailPage } from './pages/MarketDetailPage'
import { NewsPage } from './pages/NewsPage'
import { NewsCollectorPage } from './pages/NewsCollectorPage'
import { TradingPage } from './pages/TradingPage'
import { UTADetailPage } from './pages/UTADetailPage'
import { ConnectorsPage } from './pages/ConnectorsPage'
import { DevPage } from './pages/DevPage'
import { api } from './api'
import type { ChannelListItem } from './api/channels'

export type Page =
  | 'chat' | 'diary' | 'portfolio' | 'news' | 'automation' | 'market' | 'market-data' | 'news-collector' | 'connectors'
  | 'trading'
  | 'ai-provider' | 'settings' | 'dev'

/** Page type → URL path mapping. Chat is the root, everything else maps to /slug. */
export const ROUTES: Record<Page, string> = {
  'chat': '/',
  'diary': '/diary',
  'portfolio': '/portfolio',
  'automation': '/automation',
  'market': '/market',
  'market-data': '/market-data',
  'news-collector': '/news-collector',
  'news': '/news',
  'connectors': '/connectors',
  'trading': '/trading',
  'ai-provider': '/ai-provider',
  'settings': '/settings',
  'dev': '/dev',
}

export function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const location = useLocation()

  // ===== Chat channels — lifted from ChatPage so the SecondarySidebar can render the list =====
  const [channels, setChannels] = useState<ChannelListItem[]>([])
  const [activeChannel, setActiveChannel] = useState('default')
  const [editingChannel, setEditingChannel] = useState<ChannelListItem | null>(null)
  const [showNewChannelForm, setShowNewChannelForm] = useState(false)

  useEffect(() => {
    api.channels.list().then(({ channels: ch }) => setChannels(ch)).catch(() => {})
  }, [])

  const handleCreateChannel = useCallback(async (id: string, label: string) => {
    const { channel } = await api.channels.create({ id, label })
    setChannels((prev) => [...prev, channel])
    setActiveChannel(channel.id)
  }, [])

  const handleDeleteChannel = useCallback(async (id: string) => {
    try {
      await api.channels.remove(id)
      setChannels((prev) => prev.filter((ch) => ch.id !== id))
      setActiveChannel((curr) => (curr === id ? 'default' : curr))
    } catch (err) {
      console.error('Failed to delete channel:', err)
    }
  }, [])

  const isOnChatRoute = location.pathname === '/'
  const isOnSettingsRoute = isSettingsGroupedRoute(location.pathname)
  const isOnDevRoute = location.pathname === '/dev' || location.pathname.startsWith('/dev/')

  return (
    <div className="flex h-full">
      <Sidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />

      {/* Page-specific secondary sidebar — VS Code-style. */}
      {isOnChatRoute && (
        <SecondarySidebar
          title="Chats"
          actions={
            <button
              onClick={() => setShowNewChannelForm((v) => !v)}
              className="w-6 h-6 rounded flex items-center justify-center text-text-muted hover:text-text hover:bg-bg-tertiary/60 transition-colors"
              title="New channel"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          }
        >
          <ChatChannelList
            channels={channels}
            activeChannel={activeChannel}
            showNewForm={showNewChannelForm}
            onCloseNewForm={() => setShowNewChannelForm(false)}
            onSelect={setActiveChannel}
            onEdit={setEditingChannel}
            onDelete={handleDeleteChannel}
            onCreate={handleCreateChannel}
          />
        </SecondarySidebar>
      )}

      {isOnSettingsRoute && (
        <SecondarySidebar title="Settings">
          <SettingsCategoryList />
        </SecondarySidebar>
      )}

      {isOnDevRoute && (
        <SecondarySidebar title="Dev">
          <DevCategoryList />
        </SecondarySidebar>
      )}

      <main className="flex-1 flex flex-col min-w-0 min-h-0 bg-bg">
        {/* Mobile header — visible only below md */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-bg-secondary shrink-0 md:hidden">
          <button
            onClick={() => setSidebarOpen(true)}
            className="text-text-muted hover:text-text p-1 -ml-1"
            aria-label="Open menu"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M3 5h14M3 10h14M3 15h14" />
            </svg>
          </button>
          <span className="text-sm font-semibold text-text">OpenAlice</span>
        </div>
        <div key={location.pathname} className="page-fade-in flex-1 flex flex-col min-h-0">
          <Routes>
            <Route
              path="/"
              element={
                <ChatPage
                  channels={channels}
                  activeChannel={activeChannel}
                />
              }
            />
            <Route path="/diary" element={<DiaryPage />} />
            <Route path="/portfolio" element={<PortfolioPage />} />
            <Route path="/automation" element={<AutomationPage />} />
            <Route path="/market" element={<MarketPage />} />
            <Route path="/market/:assetClass/:symbol" element={<MarketDetailPage />} />
            <Route path="/market-data" element={<MarketDataPage />} />
            <Route path="/news-collector" element={<NewsCollectorPage />} />
            <Route path="/news" element={<NewsPage />} />
            {/* Redirects for old URLs */}
            <Route path="/logs" element={<Navigate to="/dev/logs" replace />} />
            <Route path="/events" element={<Navigate to="/dev/logs" replace />} />
            <Route path="/heartbeat" element={<Navigate to="/automation" replace />} />
            <Route path="/scheduler" element={<Navigate to="/automation" replace />} />
            <Route path="/agent-status" element={<Navigate to="/dev/logs" replace />} />
            <Route path="/data-sources" element={<Navigate to="/market-data" replace />} />
            <Route path="/connectors" element={<ConnectorsPage />} />
            <Route path="/tools" element={<Navigate to="/settings" replace />} />
            <Route path="/trading" element={<TradingPage />} />
            <Route path="/uta/:id" element={<UTADetailPage />} />
            <Route path="/ai-provider" element={<AIProviderPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/dev" element={<Navigate to="/dev/connectors" replace />} />
            <Route path="/dev/:tab" element={<DevPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </main>

      {/* Channel config modal — mounts at app level so SecondarySidebar can trigger it */}
      {editingChannel && (
        <ChannelConfigModal
          channel={editingChannel}
          onClose={() => setEditingChannel(null)}
          onSaved={(updated) => {
            setChannels((prev) => prev.map((ch) => ch.id === updated.id ? updated : ch))
            setEditingChannel(null)
          }}
        />
      )}
    </div>
  )
}

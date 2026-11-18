import { useEffect, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { useActiveSite } from '../data/ActiveSiteContext.tsx'
import { useLocale } from '../i18n/LocaleContext.tsx'
import { PageErrorBoundary } from './PageErrorBoundary.tsx'
import { markLanded } from '../data/landing.ts'
import { Sidebar } from './Sidebar.tsx'
import { Topbar } from './Topbar.tsx'

export function AppShell() {
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const { siteId } = useActiveSite()
  const { t } = useLocale()
  const { pathname } = useLocation()
  // Any page opened after sign-in counts as the arrival: a later visit to / is Tank & Stock, not a redirect.
  useEffect(() => {
    markLanded()
  }, [])

  return (
    <div className="app">
      <Topbar onToggleMenu={() => setMobileOpen((open) => !open)} />
      {mobileOpen && <button type="button" className="sidebar-overlay open" aria-label="Close menu" onClick={() => setMobileOpen(false)} />}
      <div className="main-wrap">
        <Sidebar
          collapsed={collapsed}
          mobileOpen={mobileOpen}
          onToggleCollapsed={() => setCollapsed((value) => !value)}
        />
        <main>
          {/* Switching site remounts the page, so every screen loads the new site from scratch. */}
          <PageErrorBoundary key={`${siteId}|${pathname}`} message={t.loadFailed}>
            <Outlet key={siteId} />
          </PageErrorBoundary>
        </main>
      </div>
    </div>
  )
}

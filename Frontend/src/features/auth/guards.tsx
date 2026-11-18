import { useEffect, useState } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { hasLanded, markLanded } from '../../data/landing.ts'
import { useActiveSite } from '../../data/ActiveSiteContext.tsx'
import { useAuth } from '../../data/AuthContext.tsx'
import { useLocale } from '../../i18n/LocaleContext.tsx'

export function RequireAuth() {
  const { user, loading } = useAuth()
  const location = useLocation()
  const { t } = useLocale()

  if (loading) {
    return <p className="page-note">{t.loading}</p>
  }
  if (!user) {
    // Keep the query too: a shared Stock Overview link carries its view in it.
    return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />
  }
  return <Outlet />
}

/** An address that matches no page: say so, inside the app frame, instead of an empty screen. */
export function NotFoundPage() {
  const { t } = useLocale()
  return (
    <div className="page">
      <section className="master-panel access-card">
        <h1 className="page-title">{t.pageNotFound}</h1>
        <p className="page-note">{t.pageNotFoundBody}</p>
        <p><a href="/">{t.pageNotFoundHome}</a></p>
      </section>
    </div>
  )
}

export function SiteRequired() {
  const { user } = useAuth()
  const { t } = useLocale()
  if (!user?.sites.length) {
    return (
      <div className="page">
        <section className="master-panel access-card">
          <h1 className="page-title">{t.accessNotConfigured}</h1>
          <p className="page-note">{t.noSiteBody}</p>
        </section>
      </div>
    )
  }
  return <Outlet />
}

/** Where each site module starts. The first module a site has is where its landing page goes. */
const MODULE_HOME: Array<[string, string]> = [
  ['live-ops', '/'],
  ['qc', '/qc'],
  ['utility', '/utility'],
  ['daily-production', '/daily-production'],
]

/**
 * A page needs the user's right on it and, when it belongs to a site module, that module switched on
 * for the active site. The landing page passes landing, so a site without that module is sent to the
 * first module it has instead of an error.
 */
export function PageGate({ page, module, landing }: { page: string; module?: string; landing?: boolean }) {
  const { can, user } = useAuth()
  const { hasModule } = useActiveSite()
  const { t } = useLocale()
  // Read once, before the shell marks this tab as landed (see data/landing.ts).
  const [arriving] = useState(() => landing === true && !hasLanded())
  useEffect(() => {
    if (landing) markLanded()
  }, [landing])
  // Management users start on Stock Overview: anyone with its right who is not the Administrator
  // (the Management Viewer role, or any role given that right). Only on arrival, so Tank & Stock,
  // at the same address, still opens from the menu.
  if (arriving && user?.isAdministrator !== true && can('management-stock', 'view')) return <Navigate to="/management" replace />
  // A user who only holds the management right lands on it instead of on a page they cannot open.
  if (!can(page, 'view') && landing && can('management-stock', 'view')) return <Navigate to="/management" replace />
  if (!can(page, 'view')) {
    return (
      <div className="page">
        <section className="master-panel access-card">
          <h1 className="page-title">{t.accessDenied}</h1>
          <p className="page-note">{t.accessDeniedBody}</p>
        </section>
      </div>
    )
  }
  if (module && !hasModule(module)) {
    const next = landing ? MODULE_HOME.find(([key]) => key !== module && hasModule(key) && can(key, 'view')) : undefined
    if (next) return <Navigate to={next[1]} replace />
    return (
      <div className="page">
        <section className="master-panel access-card">
          <h1 className="page-title">{t.moduleNotEnabled}</h1>
          <p className="page-note">{t.moduleNotEnabledBody}</p>
        </section>
      </div>
    )
  }
  return <Outlet />
}

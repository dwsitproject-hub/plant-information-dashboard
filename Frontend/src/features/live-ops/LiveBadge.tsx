import { useEffect, useState } from 'react'
import { useLocale } from '../../i18n/LocaleContext.tsx'


function age(at: string, now: number, locale: string): { minutes: number; text: string } {
  const minutes = Math.max(0, Math.round((now - new Date(at).getTime()) / 60000))
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  if (minutes < 60) return { minutes, text: formatter.format(-minutes, 'minute') }
  if (minutes < 60 * 48) return { minutes, text: formatter.format(-Math.round(minutes / 60), 'hour') }
  return { minutes, text: formatter.format(-Math.round(minutes / 1440), 'day') }
}

/**
 * Says when the gauges were last read. The poller reads them at the site's round times, so the reading
 * can be hours old and still current. Green while the last round's poll got through, amber when it did
 * not, so a stopped poller is never mistaken for a working one.
 */
export function LiveBadge({ readingAt, stale = false }: { readingAt: string | null; stale?: boolean }) {
  const { t, locale } = useLocale()
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30000)
    return () => window.clearInterval(timer)
  }, [])

  if (!readingAt) return null
  const { text } = age(readingAt, now, locale)
  return (
    <span className={stale ? 'live-badge live-badge--stale' : 'live-badge'} title={new Date(readingAt).toLocaleString(locale)}>
      <i aria-hidden="true" />
      {`${t.lastReading} ${text}`}
    </span>
  )
}

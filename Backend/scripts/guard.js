/**
 * Guard for scripts that delete and reload a site's data.
 *
 * In APP_ENV=dev they run as before. Anywhere else the operator must name the site on the
 * command line (--confirm-site=<siteId>), so a script started by habit, or against the wrong
 * DATABASE_URL, stops before it deletes anything.
 */
export function confirmSiteReplace(scriptName, siteId, argv = process.argv, env = process.env) {
  const appEnv = env.APP_ENV || ''
  if (appEnv === 'dev') return { ok: true }
  const given = argv.find((arg) => arg.startsWith('--confirm-site='))?.slice('--confirm-site='.length)
  if (given && given === siteId) return { ok: true }
  return {
    ok: false,
    message:
      `${scriptName} deletes and reloads data for site "${siteId}" (APP_ENV=${appEnv || 'unset'}).\n` +
      `Check DATABASE_URL, then run it again with --confirm-site=${siteId} to continue.`,
  }
}

/** Exit with the guard's message unless the run is allowed. */
export function requireSiteReplaceConfirmed(scriptName, siteId) {
  const result = confirmSiteReplace(scriptName, siteId)
  if (!result.ok) {
    console.error(result.message)
    process.exit(1)
  }
}

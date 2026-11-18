import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { markSent, outboxRoot, pendingFiles } from './staging-outbox.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const frontend = path.resolve(here, '..')
const stagingEnvFile = path.join(frontend, '.env.staging-push')
const productionEnvFile = path.join(frontend, '.env.production-push')
const reportFile = path.join(outboxRoot, 'push-report.txt')
const logFile = path.join(outboxRoot, 'push-log.txt')
const sshOpts = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new']

function loadEnvFile(file, into) {
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    into[key] = value
  }
}

function applyEnv() {
  const fromFile = {}
  loadEnvFile(stagingEnvFile, fromFile)
  loadEnvFile(productionEnvFile, fromFile)
  for (const [key, value] of Object.entries(fromFile)) {
    if (!process.env[key]) process.env[key] = value
  }
}

function plantStamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const get = (type) => parts.find((part) => part.type === type)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')} WIB`
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function remotePath(repo, ...parts) {
  return [String(repo).replace(/\/$/, ''), ...parts].join('/')
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ? result.error.message : null,
  }
}

function commandFailure(result, label) {
  if (result.error) return `${label} could not start. ${result.error}`
  const detail = (result.stderr || result.stdout || '').trim()
  return detail ? `${label} failed. ${detail}` : `${label} failed.`
}

function parseApplyResult(stdout) {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].startsWith('{')) continue
    try {
      const parsed = JSON.parse(lines[index])
      if (Array.isArray(parsed.applied) && Array.isArray(parsed.failed)) return parsed
    } catch {
      // Keep looking. Docker noise can share the stream.
    }
  }
  return null
}

export function pushTargets() {
  const staging = {
    name: 'staging',
    user: process.env.STAGING_SSH_USER,
    host: process.env.STAGING_SSH_HOST,
    repo: process.env.STAGING_REPO,
    file: 'Frontend/.env.staging-push',
    prefix: 'STAGING',
  }
  const targets = [staging]
  if (fs.existsSync(productionEnvFile)) {
    targets.push({
      name: 'production',
      user: process.env.PRODUCTION_SSH_USER,
      host: process.env.PRODUCTION_SSH_HOST,
      repo: process.env.PRODUCTION_REPO,
      port: process.env.PRODUCTION_SSH_PORT || '',
      file: 'Frontend/.env.production-push',
      prefix: 'PRODUCTION',
    })
  }
  return targets
}

function ready(target) {
  return Boolean(target.user && target.host && target.repo)
}

function deliver(target, pending) {
  const applied = new Set()
  const failed = []
  const tag = (file, reason) => failed.push({ file, reason: `${target.name}: ${reason}` })
  if (!ready(target)) {
    tag('-', `Set ${target.prefix}_SSH_USER, ${target.prefix}_SSH_HOST, and ${target.prefix}_REPO in ${target.file}.`)
    return { applied, failed }
  }

  const sshTarget = `${target.user}@${target.host}`
  const sshArgs = target.port ? [...sshOpts, '-p', String(target.port)] : [...sshOpts]
  const scpArgs = target.port ? [...sshOpts, '-P', String(target.port)] : [...sshOpts]
  const inbox = remotePath(target.repo, 'staging-inbox')
  const dirs = [...new Set(pending.map((item) => remotePath(inbox, item.script)))]
  const mkdir = run('ssh', [
    ...sshArgs,
    sshTarget,
    `mkdir -p ${dirs.map(shQuote).join(' ')} ${shQuote(remotePath(inbox, 'applied'))}`,
  ])
  if (mkdir.status !== 0) {
    tag('-', commandFailure(mkdir, 'SSH'))
    return { applied, failed }
  }

  const copied = []
  for (const item of pending) {
    const destination = `${sshTarget}:${remotePath(inbox, item.script)}/`
    const copy = run('scp', [...scpArgs, item.file, destination])
    if (copy.status !== 0) {
      tag(`${item.script}/${item.name}`, commandFailure(copy, 'Copy'))
      continue
    }
    copied.push(item)
  }
  if (copied.length === 0) return { applied, failed }

  const apply = run('ssh', [
    ...sshArgs,
    sshTarget,
    `bash ${shQuote(remotePath(target.repo, 'Backend/scripts/apply-staging-inbox.sh'))} ${shQuote(target.repo)}`,
  ])
  const result = parseApplyResult(apply.stdout)
  if (!result) {
    tag('-', commandFailure(apply, 'Load'))
    return { applied, failed }
  }
  for (const key of result.applied) applied.add(key)
  for (const item of result.failed) {
    tag(item.file, item.reason || 'Load failed.')
  }
  if (apply.status !== 0 && result.failed.length === 0) {
    tag('-', commandFailure(apply, 'Load'))
  }
  return { applied, failed }
}

function reportText(report) {
  const lines = [
    `Status: ${report.status}`,
    `Finished: ${report.ranAt}`,
    `Sent: ${report.sent.length}`,
    `Failed: ${report.failed.length}`,
    `Left in outbox: ${report.remaining}`,
    '',
  ]
  if (report.note) lines.push(report.note, '')
  if (report.sent.length > 0) {
    lines.push('Sent')
    for (const item of report.sent) lines.push(item)
    lines.push('')
  }
  if (report.failed.length > 0) {
    lines.push('Failed')
    for (const item of report.failed) lines.push(`${item.file}   ${item.reason}`)
    lines.push('')
  }
  lines.push('A file still in Docs/exports/staging-outbox has not been applied on every configured server.')
  lines.push('Applied files are under Docs/exports/staging-outbox/sent.')
  lines.push('')
  return `${lines.join('\n')}\n`
}

function writeReport(report) {
  const text = reportText(report)
  fs.mkdirSync(outboxRoot, { recursive: true })
  fs.writeFileSync(reportFile, text)
  fs.appendFileSync(logFile, `${text}---\n`)
  console.log(text)
  console.log(`Report: ${reportFile}`)
  return text
}

export function pushStaging() {
  applyEnv()
  const pending = pendingFiles()
  const targets = pushTargets()
  const sent = []
  const failed = []
  const appliedSets = []

  function finish(status, note) {
    const report = {
      status,
      ranAt: plantStamp(),
      sent,
      failed,
      remaining: pendingFiles().length,
      note: note || null,
    }
    writeReport(report)
    return report
  }

  if (!ready(targets[0])) {
    failed.push({
      file: '-',
      reason: 'staging: Set STAGING_SSH_USER, STAGING_SSH_HOST, and STAGING_REPO in Frontend/.env.staging-push.',
    })
    return finish('FAILED', 'Copy Frontend/.env.staging-push.example to Frontend/.env.staging-push.')
  }
  if (pending.length === 0) {
    const note = targets.length === 1
      ? 'Nothing new to send. Production is not configured, so this run sends to staging only.'
      : 'Nothing new to send.'
    return finish('OK', note)
  }

  for (const target of targets) {
    const result = deliver(target, pending)
    appliedSets.push(result.applied)
    failed.push(...result.failed)
  }
  for (const item of pending) {
    const key = `${item.script}/${item.name}`
    if (!appliedSets.every((applied) => applied.has(key))) continue
    markSent(item.script, item.name)
    sent.push(key)
  }
  const note = targets.length === 1
    ? 'Production is not configured, so this run sent to staging only.'
    : null
  return finish(failed.length === 0 ? 'OK' : 'FAILED', note)
}

function isDirectRun() {
  const entry = process.argv[1]
  if (!entry) return false
  return path.resolve(entry).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
}

if (isDirectRun()) {
  const report = pushStaging()
  if (report.status !== 'OK') process.exitCode = 1
}

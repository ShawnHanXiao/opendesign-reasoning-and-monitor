/**
 * OpenDesign (AMR) quota reader.
 *
 * Billing truth lives on the control plane, not on the inference gateway. The
 * gateway (`amr-link.open-design.ai/v1`) answers chat and `/models` and 404s
 * every `/usage`, `/quota`, `/balance` path; the `sk-amr-…` runtime key is
 * refused by the control plane outright. Only a `vela_ctrl_…` control key —
 * the one the vendor's own CLI and desktop app obtain at sign-in — can read
 * account usage.
 *
 * Two sources, in order:
 * 1. `~/.amr/config.json`, written by the vendor's CLI/desktop sign-in.
 * 2. This plugin's own device-authorization flow, whose result is stored in the
 *    credentials seam so it survives restarts.
 *
 * The window set is the backend's to change, so labels are derived from each
 * window's own `durationSeconds` rather than from a table of policy ids, and
 * nothing here assumes there are exactly three windows.
 *
 * @module opendesign-reasoning-and-monitor/quota
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Control-plane base URL. */
export const DEFAULT_API_URL = 'https://amr-api.open-design.ai'
/** Where the vendor CLI/desktop writes its sign-in record. */
export const VENDOR_CONFIG_DIR = '.amr'
/** Seconds in the three window lengths the console shows today. */
const HOUR = 3600
const DAY = 86400
const MONTH = 30 * DAY

/** Read a string field, or null when it is absent/blank. */
function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * Read a credit count as a Number.
 *
 * The control plane sends decimal strings that can exceed 2^53, so an unreadable
 * or unsafe figure becomes null rather than a silently rounded number: a quota
 * bar built on a wrong denominator is worse than one with no bar.
 * @param value - raw field value.
 * @returns the count, or null.
 */
export function creditCount(value) {
  if (typeof value === 'bigint') return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim())
    return Number.isSafeInteger(parsed) ? parsed : null
  }
  return null
}

/** Clamp a finite number into 0..100. */
function clampPct(value) {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null
}

/**
 * Used share of a window, as a percentage of its limit.
 *
 * The user asked for "used", not "remaining": this reads the same used/limit
 * ratio the vendor's own console does, so the number matches what they see
 * there.
 * @param used - used credits, or null.
 * @param limit - window limit, or null.
 * @returns 0..100, or null when the pair is unreadable or the limit is zero.
 */
export function usedPercent(used, limit) {
  if (used === null || limit === null || limit <= 0) return null
  return clampPct((used / limit) * 100)
}

/**
 * Short label for a quota window, derived from its duration.
 * @param durationSeconds - window length as reported by the control plane.
 * @returns `5h`, `7d`, `1M`, or a rounded spelling for anything else.
 */
export function windowLabel(durationSeconds) {
  const seconds = Number(durationSeconds)
  if (!Number.isFinite(seconds) || seconds <= 0) return '—'
  if (Math.abs(seconds - 5 * HOUR) <= HOUR) return '5h'
  if (Math.abs(seconds - 7 * DAY) <= DAY / 2) return '7d'
  if (Math.abs(seconds - MONTH) <= 3 * DAY) return '1M'
  if (seconds >= 28 * DAY) return '1M'
  if (seconds >= DAY) return `${Math.round(seconds / DAY)}d`
  return `${Math.round(seconds / HOUR)}h`
}

/**
 * One window from `billing/preflight`, normalized.
 * @param entry - raw window object.
 * @returns the normalized window, or null when it names no readable limit.
 */
function parseWindow(entry) {
  if (entry === null || typeof entry !== 'object') return null
  const limit = creditCount(entry.limitCredits)
  const remaining = creditCount(entry.remainingCredits)
  const reported = creditCount(entry.usedCredits)
  // Tolerate either half being omitted, but never invent both.
  const used = reported ?? (limit !== null && remaining !== null ? limit - remaining : null)
  const durationSeconds = Number.isFinite(Number(entry.durationSeconds)) ? Number(entry.durationSeconds) : null
  return {
    label: windowLabel(durationSeconds),
    durationSeconds,
    used,
    limit,
    percent: usedPercent(used, limit),
    resetsAt: text(entry.resetsAt),
  }
}

/**
 * Parse the `billing/preflight` body.
 * @param body - raw JSON.
 * @returns `{ balanceUsd, tier, eligible, windows }`, or null when the body is
 *   not a preflight response at all.
 */
export function parsePreflight(body) {
  if (body === null || typeof body !== 'object') return null
  const plan = body.codingPlan
  if (!('balanceUsd' in body) && plan === undefined) return null
  const raw = Array.isArray(plan?.windows) ? plan.windows : []
  const windows = raw.map(parseWindow).filter((window) => window !== null)
  windows.sort((left, right) => (left.durationSeconds ?? 0) - (right.durationSeconds ?? 0))
  const balanceRaw = body.balanceUsd
  const balance = typeof balanceRaw === 'number'
    ? balanceRaw
    : typeof balanceRaw === 'string' && /^-?\d+(?:\.\d+)?$/.test(balanceRaw.trim())
      ? Number(balanceRaw.trim())
      : null
  return {
    balanceUsd: Number.isFinite(balance) ? balance : null,
    tier: text(plan?.tier),
    eligible: plan?.eligible === true,
    windows,
  }
}

/**
 * Parse `billing/summary` for the billing-period facts the windows do not carry.
 * @param body - raw JSON.
 * @returns `{ tier, periodEnd, usedTotal }`; unknown fields are null.
 */
export function parseSummary(body) {
  const root = body !== null && typeof body === 'object' ? body : {}
  // The period total has no single documented spelling; accept the plausible
  // ones rather than showing nothing when one of them is present.
  const usedTotal = creditCount(root.usedCredits)
    ?? creditCount(root.totalUsedCredits)
    ?? creditCount(root.creditsUsed)
    ?? null
  return {
    tier: text(root.membershipTier) ?? text(root.tier),
    periodEnd: text(root.subscriptionCurrentPeriodEnd) ?? text(root.currentPeriodEnd),
    usedTotal,
  }
}

/**
 * Pick the workspace this account bills against.
 *
 * A personal workspace is preferred, because that is the one an individual
 * subscription bills to; a team workspace is used only when none is personal.
 * @param body - `GET /api/v1/workspaces` payload.
 * @returns the workspace id, or null.
 */
export function pickWorkspace(body) {
  const list = Array.isArray(body)
    ? body
    : Array.isArray(body?.items)
      ? body.items
      : Array.isArray(body?.workspaces)
        ? body.workspaces
        : Array.isArray(body?.data)
          ? body.data
          : []
  const rows = list
    .filter((entry) => entry !== null && typeof entry === 'object')
    .map((entry) => ({
      id: text(entry.workspaceId) ?? text(entry.id),
      type: text(entry.workspaceType) ?? text(entry.type),
    }))
    .filter((entry) => entry.id !== null)
  if (rows.length === 0) return null
  return (rows.find((entry) => entry.type === 'personal') ?? rows[0]).id
}

/**
 * Read the control key the vendor CLI/desktop wrote, if any.
 * @param options - `{ env, readFile }` seams for tests.
 * @returns `{ controlKey, apiUrl, path }`, with `controlKey` null when absent.
 */
export async function readVendorLogin(options = {}) {
  const env = options.env ?? process.env
  const read = options.readFile ?? ((path) => readFile(path, 'utf8'))
  const home = text(env.AMR_HOME)
  const path = home === null ? join(homedir(), VENDOR_CONFIG_DIR, 'config.json') : join(home, 'config.json')
  let raw
  try {
    raw = await read(path)
  } catch {
    return { controlKey: null, apiUrl: DEFAULT_API_URL, path }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { controlKey: null, apiUrl: DEFAULT_API_URL, path }
  }
  // The vendor file keys profiles by name; accept either a bare record or the
  // profile map, so a change of shape degrades to "not signed in" rather than
  // to a wrong key.
  const candidate = parsed !== null && typeof parsed === 'object'
    ? (text(parsed.controlKey) !== null ? parsed : Object.values(parsed).find((value) => text(value?.controlKey) !== null) ?? {})
    : {}
  return {
    controlKey: text(candidate.controlKey),
    apiUrl: text(candidate.apiUrl) ?? DEFAULT_API_URL,
    path,
  }
}

/** One authenticated control-plane GET, returning `{ ok, status, body, raw }`. */
async function getJson(fetchImpl, url, controlKey, signal) {
  let response
  try {
    response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${controlKey}`, accept: 'application/json' },
      signal,
    })
  } catch (error) {
    return { ok: false, status: null, body: null, raw: String(error?.message ?? error) }
  }
  const raw = await response.text().catch(() => '')
  let body = null
  try {
    body = raw === '' ? null : JSON.parse(raw)
  } catch {
    body = null
  }
  return { ok: response.ok, status: response.status, body, raw }
}

/**
 * Start a device authorization. The returned `activationUrl` is what the person
 * opens to approve this machine; nothing is spent or granted until they do.
 * @param fetchImpl - fetch implementation.
 * @param input - `{ apiUrl, cliVersion, host }`.
 * @returns the authorization record.
 */
export async function startDeviceAuthorization(fetchImpl, input) {
  const response = await fetchImpl(`${input.apiUrl.replace(/\/+$/, '')}/api/v1/cli/device-authorizations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      cliVersion: input.cliVersion,
      host: input.host,
      profile: 'prod',
    }),
  })
  if (!response.ok) throw new Error(`device authorization failed (HTTP ${response.status})`)
  const body = await response.json()
  return {
    deviceId: text(body.deviceId),
    deviceSecret: text(body.deviceSecret),
    userCode: text(body.userCode),
    activationUrl: text(body.activationUrl),
    expiresAt: text(body.expiresAt),
    pollIntervalSeconds: Number.isFinite(Number(body.pollIntervalSeconds)) ? Number(body.pollIntervalSeconds) : 5,
  }
}

/**
 * Poll one device authorization for its control key.
 * @param fetchImpl - fetch implementation.
 * @param input - `{ apiUrl, deviceId, deviceSecret }`.
 * @returns `{ status, controlKey }`; `controlKey` is non-null only once approved.
 */
export async function pollDeviceAuthorization(fetchImpl, input) {
  const response = await fetchImpl(
    `${input.apiUrl.replace(/\/+$/, '')}/api/v1/cli/device-authorizations/${encodeURIComponent(input.deviceId)}/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceSecret: input.deviceSecret }),
    },
  )
  if (!response.ok) throw new Error(`device token poll failed (HTTP ${response.status})`)
  const body = await response.json()
  return { status: text(body.status) ?? 'pending', controlKey: text(body.controlKey) }
}

/**
 * Read the whole account snapshot in the fewest requests that produce a figure.
 *
 * The workspace list is required — no account-scoped read exists without one —
 * while the summary is best-effort enrichment: a control plane that refuses it
 * still yields the plan windows, and one true number beats none.
 * @param input - `{ fetchImpl, apiUrl, controlKey, signal }`.
 * @returns the snapshot the pill renders.
 */
export async function fetchUsage(input) {
  const fetchImpl = input.fetchImpl ?? fetch
  const apiUrl = (input.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, '')
  const now = new Date().toISOString()

  const workspaces = await getJson(fetchImpl, `${apiUrl}/api/v1/workspaces`, input.controlKey, input.signal)
  if (!workspaces.ok) {
    return {
      status: workspaces.status === 401 || workspaces.status === 403 ? 'rejected' : 'error',
      asOf: now,
      message: `workspaces HTTP ${workspaces.status ?? 'network'}`,
      windows: [],
      balanceUsd: null,
      tier: null,
      periodEnd: null,
      usedTotal: null,
    }
  }
  const workspaceId = pickWorkspace(workspaces.body)
  if (workspaceId === null) {
    return {
      status: 'empty',
      asOf: now,
      message: 'no workspace',
      windows: [],
      balanceUsd: null,
      tier: null,
      periodEnd: null,
      usedTotal: null,
    }
  }

  const preflight = await getJson(
    fetchImpl,
    `${apiUrl}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/billing/preflight`,
    input.controlKey,
    input.signal,
  )
  if (!preflight.ok) {
    return {
      status: preflight.status === 401 || preflight.status === 403 ? 'rejected' : 'error',
      asOf: now,
      message: `preflight HTTP ${preflight.status ?? 'network'}`,
      windows: [],
      balanceUsd: null,
      tier: null,
      periodEnd: null,
      usedTotal: null,
    }
  }
  const snapshot = parsePreflight(preflight.body)
  if (snapshot === null) {
    return {
      status: 'error',
      asOf: now,
      message: 'preflight shape not recognised',
      windows: [],
      balanceUsd: null,
      tier: null,
      periodEnd: null,
      usedTotal: null,
    }
  }

  const summary = await getJson(fetchImpl, `${apiUrl}/api/v1/billing/summary`, input.controlKey, input.signal)
  const facts = summary.ok ? parseSummary(summary.body) : { tier: null, periodEnd: null, usedTotal: null }

  return {
    status: 'ok',
    asOf: now,
    message: null,
    workspaceId,
    windows: snapshot.windows,
    balanceUsd: snapshot.balanceUsd,
    tier: snapshot.tier ?? facts.tier,
    eligible: snapshot.eligible,
    periodEnd: facts.periodEnd,
    usedTotal: facts.usedTotal,
  }
}

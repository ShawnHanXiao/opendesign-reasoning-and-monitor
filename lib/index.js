/**
 * opendesign-reasoning-and-monitor — host half.
 *
 * Two jobs, both driven by one question: is this DSH using OpenDesign?
 *
 * 1. **Repair** — DSH's `llm-pi-ai` provider profiles carry no reasoning-effort
 *    levels for a custom API unless the user types them, and an OpenDesign model
 *    without them sends `reasoning_effort: "off"`, which the gateway rejects with
 *    a 400. This half fills the levels in on boot, additively, once.
 * 2. **Report** — serve the account's 5h / 7d / billing-period usage to the
 *    browser, which renders it in the conversation header.
 *
 * Everything is decided from live configuration and live credentials, so the
 * plugin has no settings of its own: install it next to an OpenDesign provider
 * profile and it works, install it without one and it stays dormant.
 *
 * @module opendesign-reasoning-and-monitor
 */
import { homedir } from 'node:os'

import { planAllRepairs } from './repair.js'
import {
  DEFAULT_API_URL,
  fetchUsage,
  pollDeviceAuthorization,
  readVendorLogin,
  startDeviceAuthorization,
} from './quota.js'

export const name = 'opendesign-reasoning-and-monitor'

/**
 * The `llm-pi-ai` profile entry id whose `providers` dict holds custom API
 * profiles. Named here because the repair writes through the settings seam,
 * which addresses entries by that id.
 */
const LLM_NAMESPACE = 'llm-pi-ai'

/** Browser-facing routes, all inside Connection's `/api` Host/Origin fence. */
const SNAPSHOT_PATH = '/api/opendesign-reasoning-and-monitor/snapshot'
const LOGIN_PATH = '/api/opendesign-reasoning-and-monitor/login'
const LOGIN_STATUS_PATH = '/api/opendesign-reasoning-and-monitor/login/status'

/** Version reported to the device-authorization endpoint. */
const CLI_VERSION = 'opendesign-reasoning-and-monitor/0.1.0'

/** Credentials-seam record holding the control key this plugin obtained itself. */
const CONTROL_KEY = 'opendesign-reasoning-and-monitor/control'
const CONTROL_SCOPE = 'opendesign-reasoning-and-monitor'
const CONTROL_ID = 'control'

/** How long a served snapshot may be reused before a real control-plane read. */
const SNAPSHOT_TTL_MS = 30_000
/** Backoff after a failure, so a broken control plane is not hammered by polls. */
const FAILURE_COOLDOWN_MS = 60_000

/**
 * Boot-time waits before each look at the provider config.
 *
 * The repair needs `llm-pi-ai` to be an *active* fiber — `settings.describe()`
 * lists nothing else — and plugin start order is the loader's to choose, not
 * ours. Rather than assume we start second, look, wait, look again: the
 * cumulative ceiling here is a little under twenty seconds, after which a
 * profile with no OpenDesign provider is simply reported as such.
 */
const CONFIG_RETRY_MS = [0, 300, 700, 1_500, 3_000, 5_000, 8_000]

/** JSON response with the no-store header a live pill needs. */
function jsonResponse(status, payload) {
  return Response.json(payload, { status, headers: { 'cache-control': 'no-store' } })
}

/** Message of a thrown value. */
function messageOf(error) {
  return String(error?.message ?? error)
}

/**
 * The one row this plugin writes to, found by its provider base URL rather than
 * its dict key: the key is whatever the user typed in the custom-API form.
 * @param settings - the settings service.
 * @returns `{ revision, providers, openDesign }`, or null when no descriptor.
 */
function readLlmConfig(settings) {
  const descriptor = settings.describe({ redactSecrets: true }).find((row) => row.ns === LLM_NAMESPACE)
  if (descriptor === undefined) return null
  const value = descriptor.value !== null && typeof descriptor.value === 'object' ? descriptor.value : {}
  const providers = value.providers !== null && typeof value.providers === 'object' ? value.providers : {}
  const openDesign = Object.entries(providers).some(([, profile]) => {
    const base = typeof profile?.baseURL === 'string' ? profile.baseURL : ''
    return /(^|\.)open-design\.ai(\/|:|$)/.test(base)
  })
  return { revision: descriptor.revision, providers, openDesign }
}

/**
 * Fill in missing reasoning levels and compat switches for every OpenDesign
 * profile, then stop.
 *
 * Additive by construction ({@link planAllRepairs} only emits paths that are
 * absent or wrong-but-not-refused), and idempotent: the second run computes no
 * operations and writes nothing. A write is attempted at most once per boot, so
 * a profile the harness refuses to let this plugin edit cannot turn into a
 * write storm.
 * @param ctx - plugin context.
 * @returns the number of operations applied.
 */
function repairOnce(ctx) {
  ctx.inject(['settings'], (child) => {
    // The effect is what keeps this fiber alive for the length of the async
    // body: a callback with no registered effect may be disposed the moment it
    // returns, taking `child.settings` with it.
    child.effect(() => {
      let live = true
      void (async () => {
        for (const wait of CONFIG_RETRY_MS) {
          if (!live) return
          if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
          if (!live) return
          try {
            const config = readLlmConfig(child.settings)
            // A descriptor that is not there yet is a timing question, not a
            // verdict: wait for the next tick. A descriptor that exists and has
            // no OpenDesign provider is the verdict, and retrying will not
            // change it.
            if (config === null) continue
            if (!config.openDesign) {
              ctx.logger.info('opendesign: no OpenDesign provider profile; nothing to repair')
              return
            }
            const plans = planAllRepairs(config.providers)
            if (plans.length === 0) {
              ctx.logger.info('opendesign: reasoning levels already complete')
              return
            }
            const ops = plans.flatMap((plan) => plan.ops)
            await child.settings.mutate(LLM_NAMESPACE, ops, config.revision)
            const providers = plans.map((plan) => plan.provider).join(', ')
            ctx.logger.info('opendesign: filled in reasoning levels for %s (%d fields)', providers, ops.length)
            return
          } catch (error) {
            // A profile the settings seam will not let us edit (a field it calls
            // non-volatile, a revision race, a read-only document) is a reason to
            // leave the config alone, never to retry in a loop.
            ctx.logger.warn('opendesign: reasoning repair skipped: %s', messageOf(error))
            return
          }
        }
        if (live) ctx.logger.warn('opendesign: the llm-pi-ai config never became available; reasoning levels were not repaired')
      })()
      return () => {
        live = false
      }
    }, 'opendesign-reasoning-and-monitor: reasoning repair')
  })
}

/**
 * The control key this plugin last obtained, from the credentials seam.
 * @param credentials - the credentials service.
 * @returns the key, or null.
 */
async function readStoredControlKey(credentials) {
  const record = await credentials.readRecord(CONTROL_KEY)
  if (record === undefined || record.kind !== 'grant') return null
  const key = record.payload?.controlKey
  return typeof key === 'string' && key.trim() !== '' ? key.trim() : null
}

/**
 * Resolve the control key from wherever it is available, cheapest source first,
 * and remember the plugin's own copy so later boots skip the file probe.
 * @param credentials - the credentials service.
 * @returns `{ controlKey, apiUrl, source }`.
 */
async function resolveControlKey(credentials) {
  const stored = await readStoredControlKey(credentials)
  if (stored !== null) return { controlKey: stored, apiUrl: DEFAULT_API_URL, source: 'stored' }
  const vendor = await readVendorLogin()
  if (vendor.controlKey !== null) {
    return { controlKey: vendor.controlKey, apiUrl: vendor.apiUrl, source: 'vendor' }
  }
  return { controlKey: null, apiUrl: DEFAULT_API_URL, source: null }
}

/**
 * Serve the browser's quota snapshot, with a short cache and a failure cooldown.
 * @param ctx - plugin context, for the credentials seam and logging.
 * @param state - the closure's cache.
 * @param request - the fenced request.
 */
async function handleSnapshot(ctx, state, request) {
  if (request.method !== 'GET') return jsonResponse(405, { error: 'GET only' })
  const now = Date.now()
  if (state.snapshot !== null && now - state.snapshotAt < SNAPSHOT_TTL_MS) {
    return jsonResponse(200, state.snapshot)
  }
  if (state.failedAt !== null && now - state.failedAt < FAILURE_COOLDOWN_MS && state.snapshot !== null) {
    return jsonResponse(200, state.snapshot)
  }
  const credentials = ctx.get('credentials')
  if (credentials === undefined) {
    return jsonResponse(200, { status: 'no-credential', message: 'credentials service unavailable', windows: [] })
  }
  const resolved = await resolveControlKey(credentials)
  if (resolved.controlKey === null) {
    const payload = {
      status: 'no-credential',
      asOf: new Date().toISOString(),
      message: 'OpenDesign 的额度只能用登录产生的 controlKey 读取',
      windows: [],
      balanceUsd: null,
      tier: null,
      periodEnd: null,
      usedTotal: null,
    }
    state.snapshot = payload
    state.snapshotAt = now
    return jsonResponse(200, payload)
  }
  try {
    const snapshot = await fetchUsage({
      fetchImpl: fetch,
      apiUrl: resolved.apiUrl,
      controlKey: resolved.controlKey,
      signal: AbortSignal.timeout(8000),
    })
    state.snapshot = snapshot
    state.snapshotAt = Date.now()
    state.failedAt = snapshot.status === 'ok' || snapshot.status === 'empty' ? null : Date.now()
    if (snapshot.status === 'rejected' && resolved.source === 'vendor') {
      ctx.logger.warn('opendesign: the control key from %s was refused; sign in again', resolved.apiUrl)
    }
    return jsonResponse(200, snapshot)
  } catch (error) {
    state.failedAt = Date.now()
    const payload = {
      status: 'error',
      asOf: new Date().toISOString(),
      message: messageOf(error),
      windows: [],
      balanceUsd: null,
      tier: null,
      periodEnd: null,
      usedTotal: null,
    }
    state.snapshot = state.snapshot ?? payload
    return jsonResponse(200, state.snapshot)
  }
}

/**
 * Start a device authorization and remember it in the closure so the browser can
 * poll its status. The person approves the returned URL in their own browser;
 * nothing is granted until they do.
 */
async function handleLoginStart(state) {
  const pending = await startDeviceAuthorization(fetch, {
    apiUrl: DEFAULT_API_URL,
    cliVersion: CLI_VERSION,
    host: process.env.COMPUTERNAME ?? homedir().split(/[\\/]/).pop() ?? 'dsh',
  })
  state.login = { ...pending, startedAt: Date.now(), controlKey: null }
  return jsonResponse(200, {
    status: pending.userCode === null ? 'failed' : 'awaiting-approval',
    userCode: pending.userCode,
    activationUrl: pending.activationUrl,
    expiresAt: pending.expiresAt,
    pollIntervalSeconds: pending.pollIntervalSeconds,
  })
}

/**
 * Poll the pending device authorization once; on approval, store the control key
 * in the credentials seam so it survives restarts.
 */
async function handleLoginStatus(ctx, state) {
  const pending = state.login
  if (pending === null) return jsonResponse(200, { status: 'idle' })
  if (pending.controlKey !== null) return jsonResponse(200, { status: 'approved' })
  if (pending.expiresAt !== null && Date.now() > Date.parse(pending.expiresAt)) {
    state.login = null
    return jsonResponse(200, { status: 'expired' })
  }
  const polled = await pollDeviceAuthorization(fetch, {
    apiUrl: DEFAULT_API_URL,
    deviceId: pending.deviceId,
    deviceSecret: pending.deviceSecret,
  })
  if (polled.controlKey === null) return jsonResponse(200, { status: 'pending' })
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    await credentials.modifyRecord(CONTROL_KEY, (current) => ({
      kind: 'grant',
      payload: {
        ...(current?.kind === 'grant' && current.payload !== null && typeof current.payload === 'object'
          ? current.payload
          : {}),
        controlKey: polled.controlKey,
        obtainedAt: new Date().toISOString(),
      },
    }))
  }
  pending.controlKey = polled.controlKey
  state.snapshot = null
  state.failedAt = null
  ctx.logger.info('opendesign: device authorized; quota reads are now available')
  return jsonResponse(200, { status: 'approved' })
}

export function apply(ctx) {
  const state = { snapshot: null, snapshotAt: 0, failedAt: null, login: null }
  // One repair per boot. Idempotent: a second run computes no operations.
  // The effect that keeps this alive is registered inside `repairOnce`, on the
  // injected child scope, so nothing else has to hold the work open here.
  repairOnce(ctx)
  ctx.inject(['connection'], (host) => {
    host.connection.fetch.register({
      path: SNAPSHOT_PATH,
      methods: ['GET'],
      // Declared even for GET: the carrier reads this field to size the body
      // buffer, and an undefined mode is not a "no body" mode.
      requestBody: 'buffered',
      fetch: (request) => handleSnapshot(ctx, state, request),
    })
    host.connection.fetch.register({
      path: LOGIN_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async () => {
        try {
          return await handleLoginStart(state)
        } catch (error) {
          return jsonResponse(500, { status: 'failed', message: messageOf(error) })
        }
      },
    })
    host.connection.fetch.register({
      path: LOGIN_STATUS_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        try {
          return await handleLoginStatus(ctx, state)
        } catch (error) {
          return jsonResponse(500, { status: 'failed', message: messageOf(error) })
        }
      },
    })
  })
}

/** Exported for tests: the path constants and the pure planner. */
export { SNAPSHOT_PATH, LOGIN_PATH, LOGIN_STATUS_PATH, CONTROL_KEY, CONTROL_SCOPE, CONTROL_ID }
export { planRepair, planAllRepairs, REASONING_EFFORTS, COMPAT, isOpenDesignProfile } from './repair.js'

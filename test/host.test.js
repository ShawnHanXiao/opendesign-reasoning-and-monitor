/**
 * The host half's wiring, tested against stand-ins for the two seams it uses.
 *
 * What this covers is the part a boot can get wrong silently: that the repair
 * is planned from live settings, that nothing is written when nothing is
 * missing, that a refusal is respected, and that the browser routes answer even
 * with no credentials. What it does not cover is the harness owning those
 * seams — a fake settings service proves the calls this plugin makes, not
 * whether DSH accepts them.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as plugin from '../lib/index.js'

/**
 * A settings service stand-in: describes one `llm-pi-ai` row and records writes.
 */
function fakeSettings(providers) {
  const writes = []
  const settings = {
    describe: () => [{
      ns: 'llm-pi-ai',
      revision: 7,
      value: { providers },
      base: {},
      user: {},
    }],
    mutate: async (ns, ops, revision) => {
      writes.push({ ns, ops, revision })
      return true
    },
  }
  return { settings, writes }
}

/** A credentials service stand-in, backed by one record. */
function fakeCredentials(record) {
  let stored = record ?? undefined
  return {
    readRecord: async () => stored,
    modifyRecord: async (key, mutate) => {
      stored = mutate(stored)
      return stored
    },
    writes: () => stored,
  }
}

/**
 * A plugin context stand-in that runs effects immediately and injects at once.
 *
 * An injected callback receives a *child context* — in the harness that child
 * carries `effect`/`get`/`logger` of its own, which is why the repair runs
 * inside `child.effect`. The stand-in has to model that, or the test fails on a
 * seam the harness actually provides.
 */
function fakeContext(services, logs = []) {
  const build = () => {
    const ctx = {
      effect: (fn) => {
        const disposer = fn()
        return typeof disposer === 'function' ? disposer : () => {}
      },
      inject: (names, callback) => {
        const scope = build()
        for (const name of names) {
          if (services[name] === undefined) return
          scope[name] = services[name]
        }
        callback(scope)
      },
      get: (name) => services[name],
      logger: {
        info: (...args) => logs.push(['info', ...args]),
        warn: (...args) => logs.push(['warn', ...args]),
      },
    }
    return ctx
  }
  return build()
}

/** A connection service stand-in that records registered routes. */
function fakeConnection() {
  const routes = []
  return {
    connection: {
      fetch: {
        register: (route) => {
          routes.push(route)
          return () => {}
        },
      },
    },
    routes,
  }
}

const OPEN_DESIGN = {
  displayName: 'opendesign',
  baseURL: 'https://amr-link.open-design.ai/v1',
  api: 'openai-completions',
  models: [{ id: 'deepseek-v4.1-flash' }],
}

test('the plugin exports a name, an apply, and its routes', () => {
  assert.equal(plugin.name, 'opendesign-reasoning-and-monitor')
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(plugin.SNAPSHOT_PATH, '/api/opendesign-reasoning-and-monitor/snapshot')
  assert.equal(plugin.LOGIN_PATH, '/api/opendesign-reasoning-and-monitor/login')
  assert.equal(plugin.LOGIN_STATUS_PATH, '/api/opendesign-reasoning-and-monitor/login/status')
})

test('no OpenDesign profile means no write at all', async () => {
  const { settings, writes } = fakeSettings({
    'deepseek-cn': { baseURL: 'https://api.deepseek.com', models: [{ id: 'deepseek-v4.1-flash' }] },
  })
  const logs = []
  plugin.apply(fakeContext({ settings }, logs))
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(writes.length, 0)
  // One informational line saying why nothing happened; no warning, because a
  // DSH without OpenDesign is a normal state rather than a fault.
  assert.deepEqual(logs, [['info', 'opendesign: no OpenDesign provider profile; nothing to repair']])
})

test('a config that appears a moment later is still repaired', async () => {
  // Plugin start order is the loader's to choose: on a cold boot `llm-pi-ai`
  // may not be an active fiber yet, and the first describe() lists nothing.
  const { settings, writes } = fakeSettings({ opendesign: OPEN_DESIGN })
  const describe = settings.describe
  let calls = 0
  settings.describe = (...args) => {
    calls += 1
    return calls === 1 ? [] : describe(...args)
  }
  plugin.apply(fakeContext({ settings }))
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.equal(writes.length, 1)
  assert.equal(writes[0].ns, 'llm-pi-ai')
})

test('an OpenDesign profile is repaired through path edits on the live revision', async () => {
  const { settings, writes } = fakeSettings({ opendesign: OPEN_DESIGN })
  plugin.apply(fakeContext({ settings }))
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(writes.length, 1)
  assert.equal(writes[0].ns, 'llm-pi-ai')
  // The revision read before planning is the one written against, so a change
  // made in between is a conflict rather than an overwrite.
  assert.equal(writes[0].revision, 7)
  const levels = writes[0].ops.filter((op) => op.path.at(-1) === 'reasoningEfforts')
  assert.equal(levels.length, 1)
  assert.deepEqual(levels[0].path, ['providers', 'opendesign', 'models', 0, 'reasoningEfforts'])
  assert.equal(levels[0].value.off, 'minimal')
})

test('a profile that is already correct is not written to', async () => {
  const { settings, writes } = fakeSettings({
    opendesign: {
      ...OPEN_DESIGN,
      models: [{
        id: 'deepseek-v4.1-flash',
        reasoningEfforts: { ...plugin.REASONING_EFFORTS['deepseek-v4.1-flash'] },
        compat: { ...plugin.COMPAT },
      }],
    },
  })
  plugin.apply(fakeContext({ settings }))
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(writes.length, 0)
})

test('a refused repair is logged once and never retried', async () => {
  const { settings } = fakeSettings({ opendesign: OPEN_DESIGN })
  let attempts = 0
  settings.mutate = async () => {
    attempts += 1
    throw new Error('Config field "providers.opendesign.models.0.compat" is not volatile')
  }
  const logs = []
  plugin.apply(fakeContext({ settings }, logs))
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(attempts, 1)
  assert.equal(logs.length, 1)
  assert.equal(logs[0][0], 'warn')
  assert.match(String(logs[0][2]), /not volatile/)
})

test('the routes are registered even with no provider and no credentials', () => {
  const { connection, routes } = fakeConnection()
  plugin.apply(fakeContext({ connection }))
  assert.deepEqual(routes.map((route) => route.path).sort(), [
    '/api/opendesign-reasoning-and-monitor/login',
    '/api/opendesign-reasoning-and-monitor/login/status',
    '/api/opendesign-reasoning-and-monitor/snapshot',
  ])
  assert.deepEqual(routes.find((route) => route.path.endsWith('/snapshot')).methods, ['GET'])
  assert.deepEqual(routes.find((route) => route.path.endsWith('/login')).methods, ['POST'])
  // The carrier sizes its body buffer from this field on every route, GETs
  // included, so a missing mode is a malformed route rather than a no-body one.
  for (const route of routes) assert.equal(route.requestBody, 'buffered', route.path)
})

test('a snapshot with no control key says so instead of guessing at a figure', async () => {
  const { connection, routes } = fakeConnection()
  const credentials = fakeCredentials()
  plugin.apply(fakeContext({ connection, credentials }))
  const snapshot = routes.find((route) => route.path.endsWith('/snapshot'))
  const response = await snapshot.fetch(new Request('http://localhost/api/opendesign-reasoning-and-monitor/snapshot'))
  const body = await response.json()
  assert.equal(response.status, 200)
  assert.equal(body.status, 'no-credential')
  assert.deepEqual(body.windows, [])
  assert.equal(response.headers.get('cache-control'), 'no-store')
})

test('a snapshot with no credentials service at all still answers', async () => {
  const { connection, routes } = fakeConnection()
  plugin.apply(fakeContext({ connection }))
  const snapshot = routes.find((route) => route.path.endsWith('/snapshot'))
  const body = await (await snapshot.fetch(new Request('http://localhost/api/opendesign-reasoning-and-monitor/snapshot'))).json()
  assert.equal(body.status, 'no-credential')
  assert.equal(body.message, 'credentials service unavailable')
})

test('the quota reads refuse a method other than GET', async () => {
  const { connection, routes } = fakeConnection()
  plugin.apply(fakeContext({ connection, credentials: fakeCredentials() }))
  const snapshot = routes.find((route) => route.path.endsWith('/snapshot'))
  const response = await snapshot.fetch(new Request('http://localhost/api/opendesign-reasoning-and-monitor/snapshot', { method: 'POST' }))
  assert.equal(response.status, 405)
})

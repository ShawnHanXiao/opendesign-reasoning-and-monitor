/**
 * Tests for the parts that decide what the plugin changes and what it shows.
 *
 * Everything here is pure: the repair planner, the window/percentage maths and
 * the payload parsers. The seams that need a running harness — settings writes,
 * the credentials store, the browser slot — are covered by the manual pass in
 * README.md, because faking them would test the fakes.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  COMPAT,
  REASONING_EFFORTS,
  isOpenDesignProfile,
  planAllRepairs,
  planRepair,
} from '../lib/repair.js'
import {
  creditCount,
  parsePreflight,
  parseSummary,
  pickWorkspace,
  readVendorLogin,
  usedPercent,
  windowLabel,
} from '../lib/quota.js'

/** A profile that points at OpenDesign, as the custom-API form would store it. */
function openDesignProfile(models) {
  return {
    displayName: 'opendesign',
    baseURL: 'https://amr-link.open-design.ai/v1',
    apiKeyEnv: 'OPENDESIGN_API_KEY',
    api: 'openai-completions',
    models,
  }
}

test('the base URL, not the dict key, decides whether a profile is OpenDesign', () => {
  assert.equal(isOpenDesignProfile({ baseURL: 'https://amr-link.open-design.ai/v1' }), true)
  assert.equal(isOpenDesignProfile({ baseURL: 'https://api.open-design.ai' }), true)
  assert.equal(isOpenDesignProfile({ baseURL: 'https://amr-api.open-design.ai/api/v1' }), true)
  assert.equal(isOpenDesignProfile({ baseURL: 'https://open-design.ai.evil.test' }), false)
  assert.equal(isOpenDesignProfile({ baseURL: 'https://api.deepseek.com' }), false)
  assert.equal(isOpenDesignProfile({}), false)
  assert.equal(isOpenDesignProfile(null), false)
})

test('a known model gets four levels, with off spelled as the wire value minimal', () => {
  const ops = planRepair('opendesign', openDesignProfile([{ id: 'deepseek-v4.1-flash' }]))
  const levels = ops.find((op) => op.path.at(-1) === 'reasoningEfforts')
  assert.deepEqual(levels.value, { off: 'minimal', low: 'low', medium: 'medium', high: 'high' })
  // `off: null` is what a hand-written profile tends to contain, and it is what
  // makes the gateway answer 400; mapping it to `minimal` is the whole point.
  assert.notEqual(levels.value.off, null)
})

test('glm-5.3-flashx never offers the level its gateway rejects', () => {
  const ops = planRepair('opendesign', openDesignProfile([{ id: 'glm-5.3-flashx' }]))
  const levels = ops.find((op) => op.path.at(-1) === 'reasoningEfforts')
  assert.deepEqual(levels.value, { off: 'minimal', low: 'low', high: 'high' })
  assert.equal('medium' in levels.value, false)
})

test('every model in the table is addressable and off is always a real wire value', () => {
  for (const [id, levels] of Object.entries(REASONING_EFFORTS)) {
    assert.equal(typeof id, 'string')
    assert.equal(typeof levels.off, 'string', `${id} must map off to a wire value`)
    assert.notEqual(levels.off, '', `${id} must not map off to the empty string`)
    assert.equal(levels.off, 'minimal', `${id} must use the spelling the gateway accepts`)
  }
})

test('a profile that already carries the table produces no edits', () => {
  const model = {
    id: 'minimax-m3.1-flash',
    reasoningEfforts: { ...REASONING_EFFORTS['minimax-m3.1-flash'] },
    compat: { ...COMPAT },
  }
  assert.deepEqual(planRepair('opendesign', openDesignProfile([model])), [])
})

test('an explicit refusal is left alone', () => {
  const ops = planRepair('opendesign', openDesignProfile([{ id: 'deepseek-v4.1-flash', reasoningEfforts: false }]))
  assert.equal(ops.some((op) => op.path.includes('reasoningEfforts')), false)
  // compat is still filled: a refusal concerns the level list, not the protocol.
  assert.equal(ops.some((op) => op.path.includes('compat')), true)
})

test('a model outside the table is never given invented levels', () => {
  const ops = planRepair('opendesign', openDesignProfile([{ id: 'kimi-k2.7-code' }, { id: 'gpt-6-luna' }]))
  assert.equal(ops.some((op) => op.path.includes('reasoningEfforts')), false)
  assert.equal(ops.length, 2 * Object.keys(COMPAT).length)
})

test('compat is filled field by field, never replaced', () => {
  const ops = planRepair('opendesign', openDesignProfile([
    { id: 'hy4-preview', compat: { supportsStore: true, thinkingFormat: 'deepseek' } },
  ]))
  const fields = ops.filter((op) => op.path.includes('compat')).map((op) => op.path.at(-1))
  // The two the user set are left as they were, whatever their value.
  assert.equal(fields.includes('supportsStore'), false)
  assert.equal(fields.includes('thinkingFormat'), false)
  assert.equal(fields.length, Object.keys(COMPAT).length - 2)
})

test('edits address the model by index inside the providers dict', () => {
  const ops = planRepair('my-opendesign', openDesignProfile([
    { id: 'glm-5.3-flash' },
    { id: 'deepseek-v4.1-flash-eco' },
  ]))
  const levels = ops.filter((op) => op.path.at(-1) === 'reasoningEfforts')
  assert.equal(levels.length, 2)
  assert.deepEqual(levels[0].path, ['providers', 'my-opendesign', 'models', 0, 'reasoningEfforts'])
  assert.deepEqual(levels[1].path, ['providers', 'my-opendesign', 'models', 1, 'reasoningEfforts'])
})

test('only OpenDesign profiles are planned over, and empty plans are dropped', () => {
  const providers = {
    'deepseek-cn': { baseURL: 'https://api.deepseek.com', models: [{ id: 'deepseek-v4.1-flash' }] },
    opendesign: openDesignProfile([{ id: 'deepseek-v4.1-flash' }]),
    'already-fine': {
      baseURL: 'https://amr-link.open-design.ai/v1',
      models: [{
        id: 'minimax-m3.1-flash',
        reasoningEfforts: { ...REASONING_EFFORTS['minimax-m3.1-flash'] },
        compat: { ...COMPAT },
      }],
    },
  }
  const plans = planAllRepairs(providers)
  assert.deepEqual(plans.map((plan) => plan.provider), ['opendesign'])
})

test('a used percentage is used over limit, and an unusable pair is null', () => {
  assert.equal(usedPercent(50, 100), 50)
  assert.equal(usedPercent(0, 100), 0)
  assert.equal(usedPercent(100, 100), 100)
  // A window whose limit shrank below its usage is still readable, clamped.
  assert.equal(usedPercent(150, 100), 100)
  assert.equal(usedPercent(1, 0), null)
  assert.equal(usedPercent(null, 100), null)
  assert.equal(usedPercent(10, null), null)
})

test('window labels come from the duration, not from a policy id table', () => {
  assert.equal(windowLabel(5 * 3600), '5h')
  assert.equal(windowLabel(7 * 86400), '7d')
  assert.equal(windowLabel(30 * 86400), '1M')
  assert.equal(windowLabel(31 * 86400), '1M')
  assert.equal(windowLabel(14 * 86400), '14d')
  assert.equal(windowLabel(90 * 60), '2h')
  assert.equal(windowLabel(null), '—')
  assert.equal(windowLabel(0), '—')
})

test('credit counts refuse values a Number cannot hold exactly', () => {
  assert.equal(creditCount(42), 42)
  assert.equal(creditCount('42'), 42)
  assert.equal(creditCount(42n), 42)
  assert.equal(creditCount('9007199254740993'), null)
  assert.equal(creditCount(-1), null)
  assert.equal(creditCount('4.2'), null)
  assert.equal(creditCount(undefined), null)
})

test('preflight windows are normalized, ordered by length, and readable either way round', () => {
  const parsed = parsePreflight({
    balanceUsd: 12.5,
    codingPlan: {
      tier: 'pro',
      eligible: true,
      windows: [
        { policyId: 'weekly', durationSeconds: 604800, limitCredits: 1000, usedCredits: 250, resetsAt: '2026-11-20T00:00:00Z' },
        { policyId: 'five-hour', durationSeconds: 18000, limitCredits: 200, remainingCredits: 50 },
      ],
    },
  })
  assert.equal(parsed.balanceUsd, 12.5)
  assert.equal(parsed.tier, 'pro')
  assert.equal(parsed.eligible, true)
  assert.deepEqual(parsed.windows.map((window) => window.label), ['5h', '7d'])
  assert.equal(parsed.windows[0].percent, 75)
  assert.equal(parsed.windows[1].percent, 25)
  // A report carrying only `remaining` is read as limit minus remaining.
  assert.equal(parsed.windows[0].used, 150)
})

test('a preflight body with no plan and no balance is not a preflight body', () => {
  assert.equal(parsePreflight({}), null)
  assert.equal(parsePreflight(null), null)
  assert.equal(parsePreflight('nope'), null)
  // A plan with no windows is still a valid answer: the account has no plan.
  const parsed = parsePreflight({ codingPlan: { tier: 'free', windows: [] } })
  assert.deepEqual(parsed.windows, [])
  assert.equal(parsed.tier, 'free')
})

test('summary tolerates the several spellings of the same facts', () => {
  assert.deepEqual(
    parseSummary({ membershipTier: 'max', subscriptionCurrentPeriodEnd: '2026-12-01T00:00:00Z', totalUsedCredits: 900 }),
    { tier: 'max', periodEnd: '2026-12-01T00:00:00Z', usedTotal: 900 },
  )
  assert.deepEqual(parseSummary({ tier: 'plus', creditsUsed: '150' }), {
    tier: 'plus',
    periodEnd: null,
    usedTotal: 150,
  })
  assert.deepEqual(parseSummary(null), { tier: null, periodEnd: null, usedTotal: null })
})

test('the personal workspace is preferred over a team one', () => {
  const body = {
    items: [
      { workspaceId: 'ws-team', workspaceType: 'team' },
      { workspaceId: 'ws-me', workspaceType: 'personal' },
    ],
  }
  assert.equal(pickWorkspace(body), 'ws-me')
  assert.equal(pickWorkspace({ items: [{ workspaceId: 'ws-only' }] }), 'ws-only')
  assert.equal(pickWorkspace({ items: [] }), null)
  assert.equal(pickWorkspace(null), null)
})

test('the vendor config is read from AMR_HOME when set, and absence is not an error', async () => {
  const calls = []
  const readFile = async (path) => {
    calls.push(path)
    if (path.replaceAll('\\', '/').endsWith('.amr-prod/config.json')) {
      return JSON.stringify({ prod: { controlKey: 'vela_ctrl_prod', apiUrl: 'https://amr-api.example.test' } })
    }
    throw new Error('ENOENT')
  }
  const found = await readVendorLogin({ env: { AMR_HOME: 'C:/Users/x/.amr-prod' }, readFile })
  assert.equal(found.controlKey, 'vela_ctrl_prod')
  assert.equal(found.apiUrl, 'https://amr-api.example.test')
  assert.equal(calls[0].replaceAll('\\', '/'), 'C:/Users/x/.amr-prod/config.json')

  const missing = await readVendorLogin({ env: {}, readFile })
  assert.equal(missing.controlKey, null)
  assert.equal(missing.apiUrl, 'https://amr-api.open-design.ai')
})

test('an unreadable vendor config degrades to "not signed in", never to a wrong key', async () => {
  const broken = await readVendorLogin({ env: {}, readFile: async () => '{ not json' })
  assert.equal(broken.controlKey, null)
  const unrelated = await readVendorLogin({ env: {}, readFile: async () => JSON.stringify({ theme: 'dark' }) })
  assert.equal(unrelated.controlKey, null)
})

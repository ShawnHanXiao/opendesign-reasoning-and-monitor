/**
 * A smoke test for the browser half's wiring and its display maths.
 *
 * The bundle is not importable: it expects `window.__ModuleLoader__` and a
 * `require` that answers `react`. This file provides both, so a registration
 * typo or a wrong slot name fails here rather than in the user's page. The
 * component itself is not rendered — a hand-written React stand-in proves
 * nothing a browser would not prove better — so the display rules are exercised
 * through the pure helpers the bundle exports for exactly this purpose.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Enough of React to satisfy the module body; the bundle only destructures it. */
const REACT_STAND_IN = {
  createElement: () => null,
  Fragment: 'Fragment',
  useCallback: (fn) => fn,
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: () => ({ current: null }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useSyncExternalStore: (subscribe, read) => read(),
}

/** Load the browser bundle and hand back its exports. */
async function loadClient() {
  const source = await readFile(join(root, 'lib', 'client.js'), 'utf8')
  let loaded = null
  const window = {
    __ModuleLoader__: {
      load: (entry) => {
        assert.equal(entry.id, 'opendesign-reasoning-and-monitor')
        loaded = entry.factory((name) => {
          if (name === 'react') return REACT_STAND_IN
          throw new Error(`the bundle asked for "${name}", which the loader does not provide`)
        })
      },
    },
  }
  const style = { setAttribute() {}, remove() {}, textContent: '' }
  const document = { createElement: () => style, head: { appendChild() {} } }
  const fetch = async () => ({ ok: false, status: 0, json: async () => null })
  // The bundle is a script, not a module: run it with `window` in scope.
  new Function('window', 'document', 'navigator', 'fetch', 'console', source)(
    window,
    document,
    { clipboard: { writeText: async () => {} } },
    fetch,
    { error() {} },
  )
  assert.ok(loaded !== null, 'the bundle never called __ModuleLoader__.load')
  return loaded
}

test('the bundle names itself and asks only for what it declared', async () => {
  const client = await loadClient()
  assert.equal(client.name, 'opendesign-reasoning-and-monitor')
  assert.deepEqual(client.inject, ['slots', 'locale'])
})

test('both dictionaries define the same keys, or one locale shows blanks', async () => {
  const client = await loadClient()
  assert.deepEqual(Object.keys(client.DICTS).sort(), ['en', 'zh'])
  assert.deepEqual(Object.keys(client.DICTS.zh).sort(), Object.keys(client.DICTS.en).sort())
})

test('apply registers the dictionaries, the styles and one header pill', async () => {
  const client = await loadClient()
  const effects = []
  const slots = []
  const dictionaries = []
  const services = { modelDirectories: { directoryFor: (id) => ({ idOf: id }) } }
  const ctx = {
    effect: (fn, label) => {
      effects.push(label)
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    // The dynamic package facade answers `get` for a service it did not
    // declare; declaring one through `inject` is a host-only verb.
    get: (name) => services[name],
    locale: {
      register: (ns, dicts) => {
        dictionaries.push(ns)
        assert.deepEqual(Object.keys(dicts).sort(), ['en', 'zh'])
        return () => {}
      },
      bind: () => (key) => key,
    },
    slots: {
      inject: (name, register) => {
        assert.equal(name, 'conversation.session.header.utilities')
        register()
        return () => {}
      },
      register: (options, component) => {
        slots.push({ options, component })
        return () => {}
      },
    },
  }
  client.apply(ctx)
  // `slots.inject` installs its own effect internally, so it must not be
  // wrapped in another one here: the label list holds only our two effects.
  assert.deepEqual(effects, [
    'opendesign-reasoning-and-monitor: dictionaries',
    'opendesign-reasoning-and-monitor: styles',
  ])
  assert.deepEqual(dictionaries, ['opendesign-reasoning-and-monitor'])
  assert.equal(slots.length, 1)
  // The header utilities group is a session-scoped list, and the pill sorts
  // before the open-in-app action (-10) so it sits to its left.
  assert.equal(slots[0].options.name, 'conversation.session.header.utilities')
  assert.equal(slots[0].options.order, -20)
  assert.equal(slots[0].options.locale, 'opendesign-reasoning-and-monitor')
  assert.equal(typeof slots[0].component, 'function')
  // A session-scoped slot hands the registrant a session id from the framework,
  // and the injected face carries only business data: the same key in both
  // places is the one collision the slots contract rejects.
  const face = slots[0].options.inject('sess-1')
  assert.deepEqual(Object.keys(face), ['directories'])
  // The face is live: it reads the service through the context on every call,
  // so a package that loads before `modelDirectories` still resolves later.
  assert.deepEqual(face.directories.directoryFor('sess-1'), { idOf: 'sess-1' })
  delete services.modelDirectories
  assert.equal(face.directories.directoryFor('sess-1'), null)
})

test('the pill answers only for OpenDesign provider ids, in any spelling', async () => {
  const { __pure } = await loadClient()
  for (const provider of ['opendesign', 'open-design', 'open_design', ' OpenDesign ']) {
    assert.equal(__pure.isOpenDesignProvider(provider), true, provider)
  }
  // A different provider is not ours to speak about, and neither is an
  // unresolved directory: the pill hides rather than flashing for a route it
  // cannot confirm.
  for (const provider of ['deepseek', 'minimax-cn', '', null, undefined, 42]) {
    assert.equal(__pure.isOpenDesignProvider(provider), false, String(provider))
  }
})

test('the three slots are 5h, 7d and monthly, and the monthly one falls back', async () => {
  const { __pure } = await loadClient()
  const fiveHour = { label: '5h', durationSeconds: 18000, used: 12, limit: 100, percent: 12 }
  const weekly = { label: '7d', durationSeconds: 604800, used: 85, limit: 100, percent: 85 }
  const monthly = { label: '1M', durationSeconds: 2592000, used: 640, limit: 1000, percent: 64 }

  const all = __pure.pickWindows({ windows: [monthly, weekly, fiveHour] })
  assert.equal(all.fiveHour.label, '5h')
  assert.equal(all.weekly.label, '7d')
  assert.equal(all.monthly.label, '1M')

  // The control plane usually returns only the two rolling windows; the third
  // slot is then empty, and the caller renders the period total instead.
  const two = __pure.pickWindows({ windows: [fiveHour, weekly] })
  assert.equal(two.fiveHour.label, '5h')
  assert.equal(two.weekly.label, '7d')
  assert.equal(two.monthly, null)

  // An unrecognised set still fills the first two slots by length.
  const odd = __pure.pickWindows({ windows: [{ label: '3h', durationSeconds: 10800, used: 1, limit: 2, percent: 50 }] })
  assert.equal(odd.fiveHour.durationSeconds, 10800)
  assert.equal(odd.weekly, null)
  assert.deepEqual(__pure.pickWindows({}), { fiveHour: null, weekly: null, monthly: null })
})

test('the warning and error thresholds are 75 and 90', async () => {
  const { __pure } = await loadClient()
  assert.equal(__pure.levelOf(0), null)
  assert.equal(__pure.levelOf(74.9), null)
  assert.equal(__pure.levelOf(75), 'warn')
  assert.equal(__pure.levelOf(89.9), 'warn')
  assert.equal(__pure.levelOf(90), 'error')
  assert.equal(__pure.levelOf(100), 'error')
  assert.equal(__pure.levelOf(null), null)
  assert.equal(__pure.levelOf(NaN), null)
})

test('a percentage is rounded for the pill, and an unusable one reads as a dash', async () => {
  const { __pure } = await loadClient()
  assert.equal(__pure.percentText(12), '12%')
  assert.equal(__pure.percentText(12.4), '12%')
  assert.equal(__pure.percentText(12.6), '13%')
  assert.equal(__pure.percentText(null), '—')
  assert.equal(__pure.percentText(undefined), '—')
})

test('the card row shows counts, and falls back to the period total without a monthly limit', async () => {
  const client = await loadClient()
  const { __pure } = client
  const t = (key) => client.DICTS.zh[key] ?? key
  const monthly = __pure.windowRow(t, 'monthly', { used: 640, limit: 1000, percent: 64 }, null)
  assert.equal(monthly.value, '已用 640 / 1000')
  assert.equal(monthly.level, null)

  // No monthly window at all: the row carries the period total, with no
  // percentage and no level, because there is no denominator to divide by.
  const fallback = __pure.windowRow(t, 'monthly', null, 900)
  assert.equal(fallback.value, '已用 900')
  assert.equal(fallback.percent, undefined)
  assert.equal(fallback.level, null)

  // Nothing at all: a dash rather than a fabricated zero.
  assert.equal(__pure.windowRow(t, 'monthly', null, null).value, '—')

  // A window with counts but no readable limit reads as a total too.
  assert.equal(__pure.windowRow(t, 'fiveHour', { used: 7, limit: null, percent: null }, null).value, '已用 7')

  const weekly = __pure.windowRow(t, 'weekly', { used: 92, limit: 100, percent: 92 }, null)
  assert.equal(weekly.level, 'error')
})

test('credit counts and timestamps render readably, and nothing renders as a guess', async () => {
  const { __pure } = await loadClient()
  assert.equal(__pure.creditText(1234.6), '1235')
  assert.equal(__pure.creditText('1234'), '1234')
  assert.equal(__pure.creditText(null), '—')
  const stamp = __pure.timeText('2026-11-15T10:00:00.000Z')
  assert.match(stamp, /^\d{2}-\d{2} \d{2}:\d{2}$/)
  assert.equal(__pure.timeText(null), '')
  assert.equal(__pure.timeText('not a date'), '')
})

test('every dictionary template fills its placeholders', async () => {
  const client = await loadClient()
  const { fill } = client.__pure
  assert.equal(fill('used {used} of {limit}', { used: 1, limit: 2 }), 'used 1 of 2')
  // An unknown placeholder stays visible rather than becoming "undefined".
  assert.equal(fill('used {used}', {}), 'used {used}')
  assert.equal(fill(undefined, {}), '')
})

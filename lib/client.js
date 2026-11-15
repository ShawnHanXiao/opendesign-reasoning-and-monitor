/**
 * opendesign-reasoning-and-monitor — browser half.
 *
 * One pill in the conversation header: the OpenDesign account's 5h, 7d and
 * billing-period usage, as used percentages. It appears only when the session's
 * selected model comes from an OpenDesign provider and says nothing at all for
 * every other route, whose requests spend someone else's quota.
 *
 * Written as a hand-authored module bundle rather than compiled TS: the client
 * loader hands a plugin exactly one ambient module (`react`), so anything else —
 * the design system's Pill, HoverCard, Tooltip — has to be drawn here, and the
 * stylesheet injected rather than imported.
 */
window.__ModuleLoader__.load({
	id: 'opendesign-reasoning-and-monitor',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		const react = require('react')
		const h = react.createElement
		const { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = react

		/** Locale namespace, equal to the package name so the wording is traceable. */
		const NS = 'opendesign-reasoning-and-monitor'
		/** The header utilities group: same row as the agent-preset chip, at its far right. */
		const SLOT = 'conversation.session.header.utilities'
		const SNAPSHOT_URL = '/api/opendesign-reasoning-and-monitor/snapshot'
		const LOGIN_URL = '/api/opendesign-reasoning-and-monitor/login'
		const LOGIN_STATUS_URL = '/api/opendesign-reasoning-and-monitor/login/status'

		/**
		 * Provider ids that route to OpenDesign. The user types the id in the
		 * custom-API form, so the spelling is not ours to choose; these are the
		 * three that turn up in practice.
		 */
		const OPEN_DESIGN_PROVIDERS = ['opendesign', 'open-design', 'open_design']

		/** How often a visible pill re-reads the account snapshot. */
		const POLL_MS = 60_000
		/** How often the sign-in dialog asks whether the device was approved. */
		const LOGIN_POLL_MS = 3_000

		const DICTS = {
			zh: {
				'label.fiveHour': '5 小时',
				'label.weekly': '1 周',
				'label.monthly': '1 个月',
				'state.loading': '读取中',
				'state.noCredential': '未连接',
				'state.error': '读取失败',
				'state.rejected': '登录已失效',
				'action.connect': '连接账户',
				'action.retry': '重试',
				'action.cancel': '取消',
				'action.copy': '复制',
				'action.copied': '已复制',
				'card.title': 'OpenDesign 用量',
				'card.used': '已用 {used} / {limit}',
				'card.usedOnly': '已用 {used}',
				'card.resets': '{when} 重置',
				'card.balance': '按量余额 ${usd}',
				'card.tier': '套餐 {tier}',
				'card.period': '本期至 {when}',
				'card.noMonthlyLimit': '官方接口只提供 5 小时与 7 天额度，月度上限仅在订阅页说明',
				'card.asOf': '更新于 {when}',
				'card.unavailable': '暂无数据',
				'login.title': '连接 OpenDesign',
				'login.hint': '在浏览器打开下面的地址，确认设备码 {code}。',
				'login.waiting': '等待确认…',
				'login.open': '打开授权页',
				'login.expired': '设备码已过期，请重新开始。',
				'login.failed': '连接失败：{message}',
				'login.approved': '已连接',
				'unit.credits': '点',
			},
			en: {
				'label.fiveHour': '5h',
				'label.weekly': '1w',
				'label.monthly': '1m',
				'state.loading': 'Loading',
				'state.noCredential': 'Not connected',
				'state.error': 'Unavailable',
				'state.rejected': 'Sign-in expired',
				'action.connect': 'Connect account',
				'action.retry': 'Retry',
				'action.cancel': 'Cancel',
				'action.copy': 'Copy',
				'action.copied': 'Copied',
				'card.title': 'OpenDesign usage',
				'card.used': '{used} / {limit} used',
				'card.usedOnly': '{used} used',
				'card.resets': 'Resets {when}',
				'card.balance': 'Pay-as-you-go balance ${usd}',
				'card.tier': 'Plan {tier}',
				'card.period': 'Period ends {when}',
				'card.noMonthlyLimit': 'The API only reports the 5-hour and 7-day windows; the monthly maximum is listed on the subscription page',
				'card.asOf': 'Updated {when}',
				'card.unavailable': 'No data yet',
				'login.title': 'Connect OpenDesign',
				'login.hint': 'Open the address below in a browser and confirm device code {code}.',
				'login.waiting': 'Waiting for approval…',
				'login.open': 'Open approval page',
				'login.expired': 'The device code expired. Start again.',
				'login.failed': 'Connection failed: {message}',
				'login.approved': 'Connected',
				'unit.credits': 'credits',
			},
		}

		/**
		 * The pill, its hover card and the sign-in dialog.
		 *
		 * Positioned absolute inside the pill wrapper rather than portalled: the
		 * bundle can reach `react` only, and `createPortal` lives in `react-dom`.
		 * The header's three containers (`header`, `titleRow`, `headerUtilities`)
		 * set no overflow, so the card escapes them unaided.
		 */
		const CSS = `
.odrm-pill{position:relative;display:inline-flex;align-items:center;height:22px;flex:none}
.odrm-chip{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 8px;border:0;
  border-radius:var(--dsw-radius-xs);background:transparent;color:var(--dsw-alias-label-tertiary);
  font-size:12px;line-height:22px;font-variant-numeric:tabular-nums;white-space:nowrap;
  cursor:default;max-width:100%;overflow:hidden}
.odrm-chip[data-interactive="true"]{cursor:pointer}
.odrm-chip[data-interactive="true"]:hover{background:var(--dsw-alias-interactive-bg-hover)}
.odrm-chip:focus-visible{outline:2px solid var(--dsw-alias-state-warn-primary);outline-offset:1px}
.odrm-sep{color:var(--dsw-alias-label-caption);opacity:.55;padding:0 1px}
.odrm-window{display:inline-flex;align-items:baseline;gap:3px}
.odrm-window-label{color:var(--dsw-alias-label-caption)}
.odrm-value{color:var(--dsw-alias-label-secondary)}
.odrm-value[data-level="warn"]{color:var(--dsw-alias-state-warn-label)}
.odrm-value[data-level="error"]{color:var(--dsw-alias-state-error-primary)}
.odrm-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-caption);flex:none}
.odrm-dot[data-level="warn"]{background:var(--dsw-alias-state-warn-primary)}
.odrm-dot[data-level="error"]{background:var(--dsw-alias-state-error-primary)}
.odrm-total{color:var(--dsw-alias-label-caption)}
@container (width < 760px){.odrm-window-label{display:none}}
@container (width < 620px){.odrm-extra{display:none}}
@container (width < 520px){.odrm-pill{display:none}}
.odrm-card{position:absolute;top:calc(100% + 8px);right:0;z-index:60;min-width:236px;max-width:300px;
  padding:10px 12px;border-radius:var(--dsw-radius-md);border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-panel);
  color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;text-align:left}
.odrm-card-title{color:var(--dsw-alias-label-tertiary);font-weight:600;margin-bottom:6px}
.odrm-row{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:3px 0}
.odrm-row-name{color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.odrm-row-value{font-variant-numeric:tabular-nums;text-align:right;display:flex;flex-direction:column;
  align-items:flex-end;gap:1px;font-size:13px;line-height:17px}
.odrm-row-value[data-level="warn"]{color:var(--dsw-alias-state-warn-label)}
.odrm-row-value[data-level="error"]{color:var(--dsw-alias-state-error-primary)}
.odrm-row-detail{color:var(--dsw-alias-label-caption);font-size:11px;line-height:15px}
.odrm-note{margin-top:6px;padding-top:6px;border-top:1px solid var(--dsw-alias-border-l2);
  color:var(--dsw-alias-label-caption);display:flex;flex-direction:column;gap:2px}
.odrm-action{height:22px;padding:0 8px;border-radius:var(--dsw-radius-xs);border:0;cursor:pointer;
  font-size:12px;line-height:22px;background:var(--dsw-alias-button-primary-fill);
  color:var(--dsw-alias-label-primary-foreground)}
.odrm-action[data-variant="quiet"]{background:transparent;color:var(--dsw-alias-label-tertiary);
  border:1px solid var(--dsw-alias-border-l2)}
.odrm-action:hover{opacity:.9}
.odrm-login{display:flex;flex-direction:column;gap:8px;max-width:320px}
.odrm-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:15px;letter-spacing:2px;
  color:var(--dsw-alias-label-secondary)}
.odrm-login-actions{display:flex;gap:8px;flex-wrap:wrap}
`

		/** `{name}` interpolation over a locale dictionary. */
		function fill(template, values) {
			if (typeof template !== 'string') return ''
			return template.replace(/\{(\w+)\}/g, (whole, key) => (values && key in values ? String(values[key]) : whole))
		}

		/** Whether a provider id routes to OpenDesign. */
		function isOpenDesignProvider(provider) {
			if (typeof provider !== 'string') return false
			const normalised = provider.trim().toLowerCase()
			return normalised === '' ? false : OPEN_DESIGN_PROVIDERS.includes(normalised)
		}

		/** Severity class for a used percentage: quiet, warning at 75, error at 90. */
		function levelOf(percent) {
			if (typeof percent !== 'number' || !Number.isFinite(percent)) return null
			if (percent >= 90) return 'error'
			if (percent >= 75) return 'warn'
			return null
		}

		/** A percentage as the pill and card both show it. */
		function percentText(percent) {
			if (typeof percent !== 'number' || !Number.isFinite(percent)) return '—'
			return `${Math.round(percent)}%`
		}

		/** Local wall clock, short form, for a reset time or a read time. */
		function timeText(iso) {
			if (typeof iso !== 'string' || iso === '') return ''
			const at = Date.parse(iso)
			if (!Number.isFinite(at)) return ''
			const date = new Date(at)
			const two = (n) => String(n).padStart(2, '0')
			return `${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`
		}

		/**
		 * A period end, as a date rather than a clock reading.
		 *
		 * The year is kept whenever it is not this one: a yearly plan's period end
		 * is eleven months out, and `11-14` would read as tomorrow.
		 */
		function dateText(iso, today = new Date()) {
			if (typeof iso !== 'string' || iso === '') return ''
			const at = Date.parse(iso)
			if (!Number.isFinite(at)) return ''
			const date = new Date(at)
			const two = (n) => String(n).padStart(2, '0')
			const day = `${two(date.getMonth() + 1)}-${two(date.getDate())}`
			return date.getFullYear() === today.getFullYear() ? day : `${date.getFullYear()}-${day}`
		}

		/** A credit count for the card, with thousands separators. */
		function creditText(value) {
			if (typeof value === 'number' && Number.isFinite(value)) return String(Math.round(value))
			if (typeof value === 'string' && value !== '') return value
			return '—'
		}

		/**
		 * The session's model directory, or null when the runtime has none.
		 * @param directories - the closure's live accessor.
		 * @param sessionId - the slot's session.
		 */
		function directoryFor(directories, sessionId) {
			if (directories === null || typeof directories !== 'object') return null
			if (typeof sessionId !== 'string' || sessionId === '') return null
			try {
				return typeof directories.directoryFor === 'function' ? directories.directoryFor(sessionId) : null
			} catch {
				return null
			}
		}

		/**
		 * The session's current provider, live.
		 *
		 * A directory that has not resolved yet reads as null, and the pill stays
		 * hidden rather than flashing for a route it cannot confirm.
		 */
		function useProvider(directory) {
			const store = directory !== null && typeof directory === 'object' ? directory.store ?? directory : null
			const subscribe = useCallback(
				(listener) => (store !== null && typeof store.subscribe === 'function' ? store.subscribe(listener) : () => {}),
				[store],
			)
			const read = useCallback(
				() => (store !== null && typeof store.getSnapshot === 'function' ? store.getSnapshot() : null),
				[store],
			)
			const snapshot = useSyncExternalStore(subscribe, read, read)
			useEffect(() => {
				if (directory === null || typeof directory.load !== 'function') return
				try {
					Promise.resolve(directory.load()).catch(() => {})
				} catch {
					// A directory that refuses to load leaves the provider null.
				}
			}, [directory])
			const current = snapshot !== null && typeof snapshot === 'object' ? snapshot.current : null
			const provider = current !== null && typeof current === 'object' ? current.provider : null
			return typeof provider === 'string' && provider !== '' ? provider : null
		}

		/**
		 * Read the account snapshot while `enabled`, on a fixed cadence.
		 * @returns `{snapshot, refresh}`; `snapshot` is null until the first answer.
		 */
		function useSnapshot(enabled) {
			const [snapshot, setSnapshot] = useState(null)
			const [nonce, setNonce] = useState(0)
			const refresh = useCallback(() => setNonce((value) => value + 1), [])
			useEffect(() => {
				if (!enabled) return undefined
				let cancelled = false
				let timer = null
				const read = async () => {
					try {
						const response = await fetch(SNAPSHOT_URL, { headers: { accept: 'application/json' } })
						if (!response.ok) throw new Error(`HTTP ${response.status}`)
						const body = await response.json()
						if (cancelled) return
						setSnapshot(body !== null && typeof body === 'object' ? body : null)
					} catch (error) {
						if (cancelled) return
						setSnapshot((previous) => previous ?? { status: 'error', message: String(error?.message ?? error), windows: [] })
					} finally {
						if (!cancelled) timer = setTimeout(read, POLL_MS)
					}
				}
				void read()
				return () => {
					cancelled = true
					if (timer !== null) clearTimeout(timer)
				}
			}, [enabled, nonce])
			return { snapshot, refresh }
		}

		/**
		 * The three windows the pill reports, in order: 5h, 7d, and the billing
		 * period.
		 *
		 * The third one is the account's monthly maximum when the control plane
		 * returns such a window. It does not: the control plane reports only the
		 * 5-hour and 7-day coding-plan windows, and the monthly maximum exists
		 * only in the published plan table, with no counter behind it. The third
		 * slot therefore stays empty and the card explains why, rather than
		 * inventing a monthly figure by adding the rolling windows up.
		 */
		function pickWindows(snapshot) {
			const windows = snapshot !== null && Array.isArray(snapshot.windows) ? snapshot.windows : []
			const byLabel = (want) => windows.find((entry) => entry !== null && typeof entry === 'object' && entry.label === want) ?? null
			const sorted = windows
				.filter((entry) => entry !== null && typeof entry === 'object')
				.slice()
				.sort((left, right) => (left.durationSeconds ?? 0) - (right.durationSeconds ?? 0))
			const fiveHour = byLabel('5h') ?? sorted[0] ?? null
			const weekly = byLabel('7d') ?? sorted[1] ?? null
			let monthly = byLabel('1M') ?? null
			if (monthly === null) {
				const longest = sorted[sorted.length - 1] ?? null
				if (longest !== null && longest !== fiveHour && longest !== weekly) monthly = longest
			}
			return { fiveHour, weekly, monthly }
		}

		/**
		 * One window as the card shows it.
		 *
		 * The reading is the used share — `64%` — with the counts demoted to a
		 * secondary line for anyone who wants the absolute figure. A window
		 * without a limit has no share to show, so it reads as a plain total
		 * rather than a fabricated percentage.
		 */
		function windowRow(t, key, window) {
			const name =
				key === 'fiveHour' ? t('label.fiveHour') : key === 'weekly' ? t('label.weekly') : t('label.monthly')
			if (window === null) return { key, name, value: '—', percent: null, level: null }
			const percent =
				typeof window.percent === 'number' && Number.isFinite(window.percent) ? window.percent : null
			if (percent === null) {
				return {
					key,
					name,
					value: fill(t('card.usedOnly'), { used: creditText(window.used) }),
					percent: null,
					level: null,
					resetsAt: window.resetsAt,
				}
			}
			return {
				key,
				name,
				value: percentText(percent),
				detail: fill(t('card.used'), {
					used: creditText(window.used),
					limit: creditText(window.limit),
				}),
				percent,
				level: levelOf(percent),
				resetsAt: window.resetsAt,
			}
		}

		/** One window in the chip: quiet label, coloured percentage. */
		function WindowChip({ name, window, t }) {
			const percent =
				window !== null && typeof window.percent === 'number' && Number.isFinite(window.percent)
					? window.percent
					: null
			const level = levelOf(percent)
			return h(
				'span',
				{ className: 'odrm-window' },
				h('span', { className: 'odrm-window-label' }, name),
				h('span', { className: 'odrm-value', 'data-level': level ?? undefined }, percentText(percent)),
			)
		}

		/**
		 * The hover card: the used share of each window, the pay-as-you-go
		 * balance, the plan tier, and how stale the reading is.
		 *
		 * The percentage leads each row because that is the reading people
		 * actually watch; the counts sit under it in smaller type, for the times
		 * someone needs the absolute numbers.
		 */
		function Card({ snapshot, windows, t, onConnect }) {
			const rows = [
				windowRow(t, 'fiveHour', windows.fiveHour),
				windowRow(t, 'weekly', windows.weekly),
				windowRow(t, 'monthly', windows.monthly),
			]
			const notes = []
			if (windows.monthly === null) notes.push(h('span', { key: 'monthly' }, t('card.noMonthlyLimit')))
			if (typeof snapshot?.balanceUsd === 'number' && Number.isFinite(snapshot.balanceUsd)) {
				notes.push(h('span', { key: 'balance' }, fill(t('card.balance'), { usd: snapshot.balanceUsd.toFixed(2) })))
			}
			if (typeof snapshot?.tier === 'string' && snapshot.tier !== '') {
				notes.push(h('span', { key: 'tier' }, fill(t('card.tier'), { tier: snapshot.tier })))
			}
			const periodEnd = dateText(snapshot?.periodEnd)
			if (periodEnd !== '') notes.push(h('span', { key: 'period' }, fill(t('card.period'), { when: periodEnd })))
			const asOf = timeText(snapshot?.asOf)
			if (asOf !== '') notes.push(h('span', { key: 'asOf' }, fill(t('card.asOf'), { when: asOf })))
			const status = snapshot?.status
			const message = typeof snapshot?.message === 'string' ? snapshot.message : ''
			return h(
				'div',
				{ className: 'odrm-card', role: 'dialog', 'aria-label': t('card.title') },
				h('div', { className: 'odrm-card-title' }, t('card.title')),
				...rows.map((row) =>
					h(
						'div',
						{ className: 'odrm-row', key: row.key },
						h('span', { className: 'odrm-row-name' }, row.name),
						h(
							'span',
							{ className: 'odrm-row-value', 'data-level': row.level ?? undefined },
							row.value,
							row.detail === undefined
								? null
								: h('span', { className: 'odrm-row-detail' }, row.detail),
						),
					),
				),
				status === 'ok' || status === 'empty'
					? notes.length === 0
						? null
						: h('div', { className: 'odrm-note' }, ...notes)
					: h(
							'div',
							{ className: 'odrm-note' },
							h('span', null, message === '' ? t('card.unavailable') : message),
							status === 'no-credential' || status === 'rejected'
								? h(
										'button',
										{ type: 'button', className: 'odrm-action', onClick: onConnect },
										status === 'rejected' ? t('action.retry') : t('action.connect'),
									)
								: null,
						),
			)
		}

		/** The device-authorization dialog: one code, one link, one poller. */
		function LoginDialog({ onClose, onApproved, t }) {
			const [state, setState] = useState({ phase: 'starting', code: '', url: '', message: '' })
			const [copied, setCopied] = useState(false)
			useEffect(() => {
				let cancelled = false
				let timer = null
				const begin = async () => {
					try {
						const response = await fetch(LOGIN_URL, { method: 'POST' })
						const body = await response.json().catch(() => null)
						if (cancelled) return
						if (!response.ok || body === null) {
							setState({ phase: 'failed', code: '', url: '', message: `HTTP ${response.status}` })
							return
						}
						if (body.status === 'failed') {
							setState({ phase: 'failed', code: '', url: '', message: body.message ?? '' })
							return
						}
						setState({ phase: 'waiting', code: body.userCode ?? '', url: body.activationUrl ?? '', message: '' })
						timer = setTimeout(poll, LOGIN_POLL_MS)
					} catch (error) {
						if (!cancelled) setState({ phase: 'failed', code: '', url: '', message: String(error?.message ?? error) })
					}
				}
				const poll = async () => {
					try {
						const response = await fetch(LOGIN_STATUS_URL, { headers: { accept: 'application/json' } })
						const body = await response.json().catch(() => null)
						if (cancelled) return
						if (body?.status === 'approved') {
							setState({ phase: 'approved', code: '', url: '', message: '' })
							onApproved()
							return
						}
						if (body?.status === 'expired' || body?.status === 'idle') {
							setState({ phase: 'expired', code: '', url: '', message: '' })
							return
						}
						timer = setTimeout(poll, LOGIN_POLL_MS)
					} catch {
						if (!cancelled) timer = setTimeout(poll, LOGIN_POLL_MS)
					}
				}
				void begin()
				return () => {
					cancelled = true
					if (timer !== null) clearTimeout(timer)
				}
			}, [onApproved])
			const copy = useCallback(async () => {
				try {
					await navigator.clipboard.writeText(state.code)
					setCopied(true)
				} catch {
					// Clipboard access can be refused; the code is on screen regardless.
				}
			}, [state.code])
			return h(
				'div',
				{ className: 'odrm-card odrm-login', role: 'dialog', 'aria-label': t('login.title') },
				h('div', { className: 'odrm-card-title' }, t('login.title')),
				state.phase === 'failed'
					? h('span', null, fill(t('login.failed'), { message: state.message }))
					: state.phase === 'expired'
						? h('span', null, t('login.expired'))
						: state.phase === 'approved'
							? h('span', null, t('login.approved'))
							: h(
									'div',
									null,
									h('div', null, fill(t('login.hint'), { code: state.code })),
									h('div', { className: 'odrm-code' }, state.code),
									h('div', { className: 'odrm-note' }, h('span', null, t('login.waiting'))),
								),
				h(
					'div',
					{ className: 'odrm-login-actions' },
					state.url !== ''
						? h(
								'a',
								{ className: 'odrm-action', href: state.url, target: '_blank', rel: 'noreferrer noopener' },
								t('login.open'),
							)
						: null,
					state.code !== ''
						? h('button', { type: 'button', className: 'odrm-action', 'data-variant': 'quiet', onClick: copy }, copied ? t('action.copied') : t('action.copy'))
						: null,
					h('button', { type: 'button', className: 'odrm-action', 'data-variant': 'quiet', onClick: onClose }, t('action.cancel')),
				),
			)
		}

		/** The pill itself: hidden for every non-OpenDesign route. */
		function Pill(props) {
			const { t, sessionId } = props
			const directories = props.directories ?? null
			// Memoised: `directoryFor` may hand back a fresh handle per call, and a
			// new handle per render would re-subscribe the store on every frame.
			const directory = useMemo(() => directoryFor(directories, sessionId), [directories, sessionId])
			const provider = useProvider(directory)
			const visible = isOpenDesignProvider(provider)
			const { snapshot, refresh } = useSnapshot(visible)
			const [open, setOpen] = useState(false)
			const [login, setLogin] = useState(false)
			const timer = useRef(null)
			const close = useCallback(() => {
				if (timer.current !== null) clearTimeout(timer.current)
				timer.current = null
				setOpen(false)
			}, [])
			const hoverIn = useCallback(() => {
				if (timer.current !== null) clearTimeout(timer.current)
				timer.current = setTimeout(() => setOpen(true), 160)
			}, [])
			const hoverOut = useCallback(() => {
				if (timer.current !== null) clearTimeout(timer.current)
				timer.current = setTimeout(() => setOpen(false), 220)
			}, [])
			useEffect(() => () => {
				if (timer.current !== null) clearTimeout(timer.current)
			}, [])
			const onApproved = useCallback(() => {
				setLogin(false)
				refresh()
			}, [refresh])
			if (!visible) return null
			const windows = pickWindows(snapshot)
			const status = snapshot?.status ?? 'loading'
			const interactive = open || login || status === 'no-credential' || status === 'rejected' || status === 'error'
			const level =
				levelOf(windows.fiveHour?.percent) === 'error' || levelOf(windows.weekly?.percent) === 'error'
					? 'error'
					: levelOf(windows.fiveHour?.percent) === 'warn' || levelOf(windows.weekly?.percent) === 'warn'
						? 'warn'
						: null
			const body =
				status === 'ok' || status === 'empty'
					? [
							h(WindowChip, { key: '5h', name: t('label.fiveHour'), window: windows.fiveHour, t }),
							h('span', { className: 'odrm-sep', key: 'sep1', 'aria-hidden': 'true' }, '·'),
							h(WindowChip, { key: '7d', name: t('label.weekly'), window: windows.weekly, t }),
							h('span', { className: 'odrm-sep', key: 'sep2', 'aria-hidden': 'true' }, '·'),
							h(WindowChip, { key: '1m', name: t('label.monthly'), window: windows.monthly, t }),
						]
					: [
							h('span', { className: 'odrm-dot', 'data-level': level ?? undefined, key: 'dot', 'aria-hidden': 'true' }),
							h(
								'span',
								{ className: 'odrm-total', key: 'state' },
								status === 'loading'
									? t('state.loading')
									: status === 'no-credential'
										? t('state.noCredential')
										: status === 'rejected'
											? t('state.rejected')
											: t('state.error'),
							),
						]
			return h(
				'div',
				{ className: 'odrm-pill', onMouseEnter: hoverIn, onMouseLeave: hoverOut },
				h(
					'button',
					{
						type: 'button',
						className: 'odrm-chip',
						'data-interactive': interactive ? 'true' : 'false',
						'aria-label': t('card.title'),
						'aria-expanded': open || login,
						onClick: () => {
							if (status === 'no-credential' || status === 'rejected') setLogin(true)
							else setOpen((value) => !value)
						},
						onFocus: hoverIn,
						onBlur: hoverOut,
					},
					...body,
				),
				login
					? h(LoginDialog, { t, onClose: () => setLogin(false), onApproved })
					: open
						? h(Card, {
								t,
								snapshot,
								windows,
								onConnect: () => {
									close()
									setLogin(true)
								},
							})
						: null,
			)
		}

		const inject = ['slots', 'locale']

		/**
		 * @param ctx - the browser plugin context.
		 */
		function apply(ctx) {
			/**
			 * The session model directories, looked up on demand rather than
			 * captured: this half may be applied before that service exists, and a
			 * snapshot taken at registration time would pin the pill to null.
			 *
			 * `ctx.get` rather than `ctx.inject` on purpose — the plugin facade a
			 * dynamically loaded package receives answers `get` without requiring a
			 * declaration, while solving a dependency through `inject` is a
			 * host-side verb. A missing service simply reads as absent.
			 */
			const directoryAccess = {
				directoryFor: (sessionId) => {
					const directories = ctx.get('modelDirectories')
					return directories === undefined || directories === null ? null : directoryFor(directories, sessionId)
				},
			}

			ctx.effect(() => ctx.locale.register(NS, DICTS), 'opendesign-reasoning-and-monitor: dictionaries')
			ctx.effect(() => {
				const style = document.createElement('style')
				style.setAttribute('data-plugin', NS)
				style.textContent = CSS
				document.head.appendChild(style)
				return () => {
					style.remove()
				}
			}, 'opendesign-reasoning-and-monitor: styles')

			const t = ctx.locale.bind(NS)
			// `t` is not handed to the pill directly: the framework injects it into
			// every component whose registration declares `locale`, which is why the
			// registration below names the namespace. Binding here keeps the
			// namespace registered even on a page that never renders the pill.
			void t
			// Registered unconditionally and gated inside the component: a session
			// that switches to OpenDesign later shows the pill without a reload, and
			// the header's `:empty` collapse means an unrendered pill leaves no gap.
			// `slots.inject` installs its own effect and returns its disposer, so it
			// is called directly rather than wrapped in another `ctx.effect`.
			try {
				ctx.slots.inject(SLOT, () =>
					ctx.slots.register(
						{
							name: SLOT,
							id: 'opendesign-usage',
							order: -20,
							locale: NS,
							inject: () => ({ directories: directoryAccess }),
						},
						Pill,
					),
				)
			} catch (cause) {
				console.error('opendesign-reasoning-and-monitor: could not register the usage pill', cause)
			}
		}

		exports.name = NS
		exports.inject = inject
		exports.apply = apply
		exports.DICTS = DICTS
		// The pure helpers, reachable by the tests without a DOM. Not part of the
		// plugin contract; nothing in the harness reads this key.
		exports.__pure = { isOpenDesignProvider, levelOf, percentText, pickWindows, windowRow, timeText, dateText, creditText, fill }
		return module.exports
	},
})

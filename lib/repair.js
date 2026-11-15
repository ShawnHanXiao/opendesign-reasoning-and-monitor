/**
 * The reasoning-effort table OpenDesign's gateway actually accepts.
 *
 * Why a table and not discovery: the gateway's `/v1/models` reports modalities
 * and context limits, but it never reports which reasoning-effort levels a
 * model accepts. Sending a level a model does not know is a hard 400 at request
 * time, after the user has typed a prompt, so the levels are recorded here from
 * tested values instead of guessed.
 *
 * `off` is the load-bearing entry. pi-ai's DeepSeek thinking branch checks
 * `if (options?.reasoningEffort)` for truthiness, so a level left out of the map
 * makes that model fall through to the "no reasoning" request shape. An
 * unconfigured `reasoningEfforts` therefore sends `reasoning_effort: "off"` —
 * a value the gateway rejects. Mapping `off` to the wire spelling `minimal` is
 * what makes "off" a real request rather than a 400.
 *
 * @module opendesign-reasoning-and-monitor/repair
 */

/** Wire spelling per offered level, for models that accept all four. */
const FOUR_LEVELS = Object.freeze({
  off: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
})

/**
 * Every OpenDesign model this plugin knows how to repair.
 *
 * `glm-5.3-flashx` deliberately omits `medium`: the gateway does not offer that
 * level for it, and offering it in the picker would produce a 400 the moment a
 * user chose it.
 * @type {Readonly<Record<string, Readonly<Record<string, string>>>>}
 */
export const REASONING_EFFORTS = Object.freeze({
  'deepseek-v4.1-flash': FOUR_LEVELS,
  'deepseek-v4.1-flash-eco': FOUR_LEVELS,
  'glm-5.3-flash': FOUR_LEVELS,
  'glm-5.3-flashx': Object.freeze({ off: 'minimal', low: 'low', high: 'high' }),
  'hy4-preview': FOUR_LEVELS,
  'mimo-v2.6-flash': FOUR_LEVELS,
  'minimax-m3.1-flash': FOUR_LEVELS,
})

/**
 * The `compat` switches every OpenDesign model needs on the
 * `openai-completions` protocol.
 *
 * Read-only facts about the gateway rather than preferences: it speaks
 * `max_tokens` (not `max_completion_tokens`), rejects `store` and the
 * `developer` role, accepts strict tool schemas, requires the assistant's
 * `reasoning_content` back on replayed turns, and wants DeepSeek's thinking
 * field naming.
 * @type {Readonly<Record<string, unknown>>}
 */
export const COMPAT = Object.freeze({
  maxTokensField: 'max_tokens',
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsStrictMode: true,
  requiresReasoningContentOnAssistantMessages: true,
  thinkingFormat: 'deepseek',
})

/**
 * Whether a provider profile points at OpenDesign.
 *
 * Keyed off the base URL rather than the provider dict key, because the key is
 * whatever the user typed in the "custom model API" form; the URL is the fact
 * that decides whose gateway answers.
 * @param profile - one `providers` entry from `dsh-llm-pi-ai`.
 * @returns true when the profile addresses an OpenDesign endpoint.
 */
export function isOpenDesignProfile(profile) {
  const base = typeof profile?.baseURL === 'string' ? profile.baseURL : ''
  return /(^|\.)open-design\.ai(\/|:|$)/.test(base)
}

/** Structural JSON equality over plain data; good enough for config fragments. */
function sameJson(left, right) {
  if (left === right) return true
  if (typeof left !== typeof right || left === null || right === null) return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  if (typeof left !== 'object') return false
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((key) => sameJson(left[key], right[key]))
}

/**
 * Plan the config edits that bring one OpenDesign provider's models up to the
 * table, without touching anything the user chose.
 *
 * Three rules keep this a repair rather than a rewrite:
 * - `reasoningEfforts: false` is a user's explicit refusal and is left alone.
 * - A model outside {@link REASONING_EFFORTS} gets no level list: the gateway
 *   may have added a model this release has no tested levels for, and inventing
 *   them is how a picker starts offering 400s.
 * - `compat` is filled key by key, never replaced, so a switch the user set
 *   differently survives. It describes the gateway, not the model, so it is
 *   filled in for every model in the profile — including ones with no levels.
 *
 * `maxTokens` and `contextWindow` are never touched: they are quality dials the
 * user owns, and the gateway reports its own limits per model anyway.
 * @param profileKey - the provider dict key, used only to build edit paths.
 * @param profile - that provider's configured profile.
 * @returns the path-addressable `set` operations, empty when nothing is missing.
 */
export function planRepair(profileKey, profile) {
  const models = Array.isArray(profile?.models) ? profile.models : []
  const ops = []
  for (const [index, model] of models.entries()) {
    const id = typeof model?.id === 'string' ? model.id : ''
    const wanted = REASONING_EFFORTS[id]
    // Levels: only for a model this release has tested values for, and never
    // against an explicit refusal. A model the gateway added since is left
    // without a picker rather than given levels that would 400.
    if (wanted !== undefined && model.reasoningEfforts !== false && !sameJson(model.reasoningEfforts, wanted)) {
      ops.push({
        op: 'set',
        path: ['providers', profileKey, 'models', index, 'reasoningEfforts'],
        value: { ...wanted },
      })
    }
    // Compat: a fact about the gateway, so it applies to every model served by
    // it, including ones this table does not know.
    const compat = model.compat ?? {}
    for (const [field, value] of Object.entries(COMPAT)) {
      if (compat[field] === undefined) {
        ops.push({
          op: 'set',
          path: ['providers', profileKey, 'models', index, 'compat', field],
          value,
        })
      }
    }
  }
  return ops
}

/**
 * Every repair this plugin would make across a whole `providers` dict.
 * @param providers - the `providers` dict from `dsh-llm-pi-ai`'s config.
 * @returns one `{ provider, ops }` entry per OpenDesign provider, empties dropped.
 */
export function planAllRepairs(providers) {
  if (providers === null || typeof providers !== 'object') return []
  return Object.entries(providers)
    .filter(([, profile]) => isOpenDesignProfile(profile))
    .map(([provider, profile]) => ({ provider, ops: planRepair(provider, profile) }))
    .filter((entry) => entry.ops.length > 0)
}

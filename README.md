# opendesign-reasoning-and-monitor

[中文说明](README.zh-CN.md)

Two things DSH is missing once you add [OpenDesign](https://open-design.ai) as a
custom model API, in one plugin and with nothing to configure:

1. **Reasoning levels that actually work.** Fills in the reasoning-effort map for
   every OpenDesign model, so picking a level in the model menu sends a request
   the gateway accepts instead of a 400.
2. **A usage pill.** 5-hour, weekly and billing-period usage — used percentages
   — in the conversation header, shown only while the session's model comes from
   OpenDesign.

Install it and it looks for an OpenDesign provider profile on every boot. No
OpenDesign provider, no effect: it writes nothing and renders nothing.

## Why the reasoning levels need repairing

DSH's `llm-pi-ai` provider profile carries a `reasoningEfforts` map that turns a
chosen level into the spelling the upstream API wants. A profile typed into the
"custom model API" form has none, and pi-ai's DeepSeek thinking branch tests
`if (options?.reasoningEffort)` for truthiness, so a level missing from the map
falls through to the "no reasoning" request shape — `reasoning_effort: "off"`,
which OpenDesign's gateway rejects with a 400 for most models.

What this plugin writes, per model:

```yaml
reasoningEfforts:
  off: minimal     # the wire value for "off"; empty is what 400s
  low: low
  medium: medium
  high: high
compat:
  maxTokensField: max_tokens
  supportsStore: false
  supportsDeveloperRole: false
  supportsStrictMode: true
  requiresReasoningContentOnAssistantMessages: true
  thinkingFormat: deepseek
```

`glm-5.3-flashx` gets three levels, not four: its gateway does not accept
`medium`, and offering it in the picker would only produce a 400.

Three rules keep this a repair rather than a rewrite:

- `reasoningEfforts: false` is treated as your explicit refusal and left alone.
- A model this release has no tested levels for is left without a picker rather
  than given invented ones.
- `compat` is filled key by key; anything you set differently survives.
  `maxTokens` and `contextWindow` are never touched.

The repair runs once per boot, computes nothing on the second run, and every
write goes through the settings seam's path edits — never a whole-section
replace, which would drop redacted secrets.

## The usage pill

```
5h 12% · 1w 34% · 1m —
```

Right side of the header row that carries the agent-preset chip, or nothing at
all when the session is not on OpenDesign. Hover for the percentages with the
used/limit counts underneath, the pay-as-you-go balance, the plan tier, the
period end and the read time. Warning colour at 75%, error colour at 90%. The
pill degrades as the window narrows, down to hiding itself.

The third slot is the billing period. It stays empty in practice: OpenDesign's
control plane reports only the 5-hour and 7-day coding-plan windows, and the
monthly maximum exists only in the published plan table with no counter behind
it — every other OpenDesign plugin in the market hits the same wall. The card
therefore says so instead of inventing a denominator by adding the rolling
windows up, which would read as headroom nobody has. Usage is always
**used/limit** — the direction the vendor's own console draws.

The upstream request is tracked as
[nexu-io/open-design#8837](https://github.com/nexu-io/open-design/issues/8837)
(still open). The maintainers' answer is that the console already renders
whatever windows the billing preflight returns, so a monthly row needs an
entitlement and reset-semantics decision in the billing policy rather than a
missing UI row. The day `codingPlan.windows` in `billing/preflight` carries a
`durationSeconds: 2592000` entry, this plugin lights the third slot up with no
change at all — the windows are read, never hard-coded.

### Where the numbers come from, and why you may need to connect an account

Billing lives on OpenDesign's control plane (`amr-api.open-design.ai`), not on
the inference gateway. The `sk-amr-…` runtime key that DSH stores for
inference is refused there (401); only a `vela_ctrl_…` control key can read
account usage.

Two sources, in order:

1. `~/.amr/config.json` (or `$AMR_HOME/config.json`), which OpenDesign's own
   CLI and desktop app write when you sign in.
2. This plugin's device-authorization flow — click the pill, open the returned
   URL, confirm the code. The resulting control key goes into the credentials
   store, so it survives restarts.

Nothing is read, sent or stored unless you either already have the vendor's
sign-in or complete that flow yourself.

## Install

```bash
dsh plugin --profile <profile> add opendesign-reasoning-and-monitor
```

Then refresh the browser page. No restart is needed for the host half on a
running DSH that reloads its profile; the pill's stylesheet and slot appear with
the page itself.

## What it does not do

- No settings page, no toggles: on when an OpenDesign provider exists.
- No network calls to OpenDesign except the quota reads the pill needs, and
  those never leave your machine's credentials.
- No writing of credentials to config files; the control key lives in the
  credentials store.

## Tests

```bash
npm test
```

The pure half — the repair planner, the window maths, the payload parsers — is
covered there. The seams that need a live harness (settings writes, the
credentials store, the browser slot) are exercised by hand.

## Licence

MIT.

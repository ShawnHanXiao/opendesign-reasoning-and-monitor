# opendesign-reasoning-and-monitor

[English](README.md)

给 DSH 补上添加 [OpenDesign](https://open-design.ai) 自定义模型 API 之后缺的两样东西，一个插件、零配置：

1. **能用的思考深度档位。** 为每个 OpenDesign 模型补齐 reasoning-effort 映射，在模型菜单里选档位时发出的请求网关能认，而不是 400。
2. **用量胶囊。** 会话头部显示 5 小时 / 1 周 / 账期的**已用百分比**，只在当前会话的模型来自 OpenDesign 时出现。

装上即可。每次启动它会找一遍 OpenDesign 的 provider 配置；没有就什么都不做——不写配置、不渲染。

## 为什么思考深度需要补

DSH 的 `llm-pi-ai` provider 配置里有一张 `reasoningEfforts` 映射，把选中的档位翻成上游接口认识的写法。在「自定义模型 API」表单里加的配置没有这张表，而 pi-ai 的 DeepSeek thinking 分支用 `if (options?.reasoningEffort)` 做真值判断，表里缺档位就会走「不要思考」的请求形状——`reasoning_effort: "off"`，OpenDesign 网关对多数模型直接 400。

每个模型补的内容：

```yaml
reasoningEfforts:
  off: minimal     # "off" 的上线写法；留空就是 400 的来源
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

`glm-5.3-flashx` 只补三档：它的网关不认 `medium`，放进选择器只会制造 400。

三条规矩让它只是「修」而不是「改」：

- `reasoningEfforts: false` 视为你明确不要，跳过。
- 本版本没有实测过档位的模型不补，宁可没有档位选择器，也不编。
- `compat` 逐字段补缺，你设过的值一律保留。`maxTokens`、`contextWindow` 永不改动。

每次启动只跑一次，第二次计算不出任何改动就不写。所有写入都走设置服务的路径编辑，从不整段 replace——那会静默丢掉被脱敏的密钥。

## 用量胶囊

```
5h 12% · 1w 34% · 1m —
```

位置在「标准模式」那一行的最右端（会话头部 utilities 组），当前会话不走 OpenDesign 时完全不出现。悬停看百分比与「已用/上限」点数、**按量余额**、套餐、账期结束日与读取时间。75% 转黄、90% 转红。窗口变窄会逐级降级，最后整块隐藏。

第三格是账期。实际它一直是空的：OpenDesign 控制面只返回 5 小时与 7 天两个 coding plan 窗口，「月度上限」只写在订阅页的套餐表里、背后没有计数器，市面上其他 OpenDesign 插件也撞在同一堵墙上。所以卡片会直接说明原因，而不是把两个滚动窗口加起来编一个分母——那样读起来像根本不存在的余量。百分比一律是**已用/上限**，与厂商控制台同向。

上游需求记在 [nexu-io/open-design#8837](https://github.com/nexu-io/open-design/issues/8837)（仍 open）。厂商的回复是控制台本来就按 preflight 返回的窗口渲染，缺月度是**计费策略**上的权益与重置语义没定，不是前端少一行。什么时候 `billing/preflight` 的 `codingPlan.windows` 里出现 `durationSeconds: 2592000`，本插件无需改动就会把第三格点亮——读窗口是数据驱动的，从不写死档位。

### 数字从哪来，以及为什么可能要连一次账户

计费在 OpenDesign 的控制面（`amr-api.open-design.ai`），不在推理网关上。DSH 为推理存的 `sk-amr-…` runtime key 在那里会被拒（401）；只有 `vela_ctrl_…` control key 能读账户用量。

两个来源，按顺序：

1. `~/.amr/config.json`（或 `$AMR_HOME/config.json`），OpenDesign 自己的 CLI / 桌面端登录时写的。
2. 本插件的设备授权：点胶囊、打开返回的地址、确认设备码。拿到的 control key 存进凭据服务，重启后仍在。

除非你本来就有厂商登录、或者自己走完上面那一步，否则本插件不读、不发、不存任何东西。

## 安装

```bash
dsh plugin --profile <profile> add opendesign-reasoning-and-monitor
```

然后刷新浏览器页面。宿主部分在会重载 profile 的 DSH 上不需要重启；胶囊的样式与槽位随页面一起出现。

## 它不做什么

- 没有设置页、没有开关：有 OpenDesign provider 就生效。
- 除了胶囊需要的额度读取，不向 OpenDesign 发任何请求；那些请求用的都是本机凭据。
- 不把凭据写进配置文件；control key 放在凭据服务里。

## 测试

```bash
npm test
```

覆盖纯逻辑部分（补齐计划、窗口换算、响应解析）。需要真实宿主的部分（设置写入、凭据服务、浏览器槽位）靠手工验证。

## 许可

MIT。

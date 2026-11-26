# AGENTS.md — dsh-keykeeper 维护手册

面向后续接手的人（或 agent）。改代码前先读这一页，能少踩一半的坑。

## 当前状态（2026-11-26，接手指南）

- 版本 **0.4.1**；以 `link:` 方式装在 profile `desktop`（`dsh.profile.bundles` 含 `dsh-keykeeper`，依赖指向本目录），源码即运行代码。
- 测试基线：Host **52 项**、Client **14 项**，全过；`node --check index.js client.js` 通过。
- 最近一轮改动：⓪ 2026-11-26 目录改名（`api管理器-试做` → `dsh-api管理器-11.26`）致 profile 的 `link:` 失效、插件整页消失；已 `remove_bundle` + `install_bundle` 重装到新路径，保险库数据未动。① 保存 Key 后自动探测真实模型（`/provider/detect`）并写入路由，新增「测试对话」「设为默认」；② 硅基流动余额接口下线，移除适配器（改为无余额接口），补 StepFun 余额；③ 自动锁可配（0/5/15/30/60/240 分钟，默认 15），锁定页只读显示余额；④ 修复 3 个平台的控制台/充值链接（见「链接目录维护」）。
- 运行态证据：`$DSH_HOME/keykeeper/last-mount.json` 应显示 `version` 与当前 `package.json` 一致；当前为 `0.4.1`，2026-11-26 14:45 重装后 desktop host pid 6300。
- 文档：`README.md`（概览）、`docs/使用说明.md`（用户全文）、`docs/marketplace-entry.yml`（市场投稿模板，`<owner>` 待填）。
- 仓库：本目录已 `git init`，全部文件已 `git add`、**未 commit**（本机无 git 身份）。
- 未完成：插件市场 PR（需公开 GitHub 仓库满 1 天、`dsh-plugin` topic、填 owner）；模型列表 UI 编辑；低余额提醒。

## 仓库结构

```
dsh-api管理器-11.26/
├─ package.json        # bundle 清单：dsh.bundle.patch + dsh.client
├─ cordis.patch.yml    # 插入 loader 条目 id: keykeeper
├─ index.js            # Host 端（Node，ESM，零 React 依赖）
├─ client.js           # Client 端（浏览器模块加载器格式，只 require('react')）
├─ icon.svg            # 设置页图标
├─ locale/
│  ├─ zh.json           # meta.title / meta.description（插件页显示）
│  └─ en.json
├─ test/
│  ├─ host.test.mjs     # 假 ctx 跑全部 Host 路由
│  └─ client.test.mjs   # stub 加载器跑 Client 注册
├─ README.md           # 用户文档（功能概览）
├─ AGENTS.md           # 本文件
├─ docs/
│  └─ 使用说明.md       # 面向使用者的完整说明（安装/迁移/换模型/FAQ）
└─ scripts/
   ├─ install.cmd      # 双击安装（绕执行策略）
   └─ install.ps1      # 实际安装逻辑
```

## Host 端规则（index.js）

1. 入口：`export default { name: 'dsh-keykeeper', apply(root) {…} }`；依赖用 `root.inject(['webServer','credentials','connection'], cb)` 声明，不要直接 `ctx.get` 猜服务。
2. 路由统一挂 `/keykeeper/api/*`，`kind: 'exact'`，通过 `ctx.webServer.register({ kind, path, handler })` 注册；返回的 disposer 必须收进 `ctx.effect` 的清理数组，热重载才不会残留路由。
3. 每个 handler 都经 `registerApi` 包装，先过 `fenceStatus` 栅栏：Host 回环（localhost / *.localhost / ::1 / 127.0.0.0/8）、`sec-fetch-site: cross-site` 拒绝、Origin 与 Host 同源、委托 `connection.requestRejection`；非 GET 还要求 `x-keykeeper: 1`。任何一步拿不到就 403，handler 里不要再重复判断。
4. 未解锁时，除 `status`/`vault/*` 外的数据接口一律 401（文案「保险库未解锁」）；`status` 在锁定态必须隐藏余额、凭据提示与 `ui`，`/balance` 走 `requireUnlocked()`；错误密码 401，不区分“用户不存在/密码错”。
5. key 明文只在内存（解锁后的 session 对象）和冻结的 HTTP 响应里出现一瞬；日志里只允许出现平台 id 和 `keyConfigured` 布尔值。
6. vault 写入必须原子：先写 `vault.json.tmp` 再 `rename`；每次保存都换新 `iv`；新建/迁移用 `TARGET_KDF`（N=65536,r=8,p=1），`scryptSync` 的 `maxmem` 保持 256MB；旧库（N=16384）在 unlock 成功后自动迁移，`kdfOf` 只接受 N ∈ {16384,65536} 以防恶意大 N。
7. 写 DSH 只用两个官方入口：`ctx.credentials.set(ref, key)`、`ctx.settings.update('llm-pi-ai', { providers: {…} })`；删除用 `settings.mutate('llm-pi-ai', [{ op:'unset', path:['providers', routeId] }])` + `credentials.unset(ref)`。`providers` 是 `llm-pi-ai` 的 volatile 字段，别碰非 volatile 字段。
8. route id 必须 `kk-<provider id>` 且小写连字符（`UNSTORABLE_PROVIDER_ID`）；凭据 ref 形如 `KEYKEEPER_KK_DEEPSEEK_API_KEY`（只含大写字母/数字/下划线）。
9. 模型 id 必须非空；`models` 是整表替换，`modelOverrides` 不能和 `models` 同时出现。
10. 余额接口：fetch 超时 10s、并发上限 4；无公开接口的平台返回 `{noApi:true}` 而不是报错；任何单平台失败不能拖垮整体刷新。
11. 校验 Host 头时用 `new URL('http://' + hostHeader)`，不要手写 `split(':')`——IPv6 字面量会解析错。

## 链接目录维护（`index.js` 里的 `PROVIDERS`）

每个平台的三条链接：`keyPage`（申请 Key）、`recharge`（充值/收银台）、`console`（用量/账单）。
改完必须实际访问验证，不能凭记忆写路径。

**已验证（2026-11-26，本机 curl）**

| 平台 | 状态 | 备注 |
| --- | --- | --- |
| DeepSeek | ✅ | `/api_keys`、`/top_up`、`/usage` 均 200 |
| Kimi/Moonshot | ✅ | 跳到 `platform.kimi.com/console/*` |
| 智谱 GLM | ✅ | `usercenter/apikeys`、`usercenter/finance` |
| MiniMax | ✅（已修） | 充值原 `/user-center/payment/charge` 重定向到“个人信息”，改为 `https://platform.minimax.cn/console/recharge-records` |
| 阶跃 StepFun | ⚠️（已修） | 原 `/account/charge` 404；全站只有 `/interface-key`、`/step-plan` 等少数路径，暂无独立充值页，暂指 `https://platform.stepfun.com/` |
| 硅基流动 | ✅（已修） | 原 `/account/charge` 登录后 404，官方文档充值页是 `https://cloud.siliconflow.cn/expensebill` |
| OpenRouter | ✅ | 未登录跳 sign-in |
| 通义百炼 / 火山 / 混元 | ✅ | 200 或登录跳转 |
| Ollama / Kimi Code / GLM Coding | ✅ | 200 |

**本机无法验证（403/超时，非 404）**：OpenAI、Anthropic（地区封锁）、Gemini/AI Studio、xAI、Groq、Together、Fireworks、DeepInfra、Novita、Mistral、Cerebras、ChatGPT、Claude.ai。
用 `curl -s -o NUL -L --max-time 12 -A '<浏览器 UA>' -w '%{http_code}|%{url_effective}' <url>` 批量探测；`000`=网络不可达，`403`=风控拦截，只有 `404` 才是路径错误。

插件没有“页面内编辑链接”的入口；用户报错时直接改 `PROVIDERS` 表并 bump 版本。

## Client 端规则（client.js）

1. 格式固定：`window.__ModuleLoader__.load({ id: 'dsh-keykeeper', factory(require) { … return { inject: ['slots'], apply(ctx) {…} } } })`；React / JSX runtime / react-dom 只能从 `require` 取，不能 require Harness 客户端包。
2. 注册只用 slots：`ctx.slots.inject(owner, () => ctx.slots.register({ name, id, order }, Component))`；当前注册四个：
   - `settings.models.footer`（id `keykeeper-footer`）
   - `conversation.composer.dock`（id `keykeeper-dock`）
   - `settings.section`（id `keykeeper` + `label`/`order`，设置侧边栏独立页，`mode: 'section'`）
   - `settings.section.icon`（id 必须等于 section id，渲染钥匙线稿）
3. 不改 DOM、不 append body、不 iframe；唯一允许的全局副作用是模块级 `<style id="dsh-keykeeper-style">`，在 `apply` 里用 `ctx.effect(() => installStyle())` 安装并随 dispose 移除。颜色用 `--dsw-alias-*` token 并带回退。
4. 可见文本暂保持中文，集中写在各组件内；locale 文件目前只提供 `meta.title` / `meta.description`。
5. 外部链接一律 `window.open(url, '_blank', 'noopener,noreferrer')`；禁止把 key 放进 URL、localStorage 或 console。
6. 面板是固定定位 overlay，必须 `createPortal(overlay, document.body)`（dock 位于 composer 的 fixed 容器内，否则被裁剪）；窄窗用 `flex-wrap`；z-index 60/61，别压过 DSH 自己的对话框。
7. 401 处理：`api()` 抛错带 `err.status` 并派发 `keykeeper-unauthorized` 事件；Panel 监听后 toast + refresh，自动锁定即回到解锁界面。
8. 自动锁定：时长存 `vault.ui.autoLockMinutes`（0=不锁，默认 15），`POST /keykeeper/api/vault/auto-lock {minutes}` 修改；`touchSession()` 每次受保护请求重置计时器。
9. 锁定态只读：`buildStatus` 锁定时仍返回 `balances`/`balanceUpdatedAt`/`providers[].balance`（余额数字不是凭据），但隐藏 `ui`/`appliedRouteIds`/`keyHint`/`subscriptions`；`/balance` 与刷新接口仍需解锁。

## 测试

最低要求：`node --check index.js`、`node --check client.js`，并跑两个测试文件：

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
& 'C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe' 'E:\deepseek研究成果\dsh-api管理器-11.26\test\host.test.mjs'
& 'C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe' 'E:\deepseek研究成果\dsh-api管理器-11.26\test\client.test.mjs'
```

Host 逻辑用假 ctx 直接跑（不需要启动 DSH）：

```js
const ctx = {
  get: (n) => ({ settings, connection: { requestRejection: () => false } })[n],
  credentials: { set: async () => {}, unset: async () => {} },
  webServer: { register: ({ path, handler }) => { routes.set(path, handler); return () => routes.delete(path) } },
  effect: (fn) => fn(),
}
const req = Readable.from([Buffer.from(JSON.stringify(body))])
req.method = 'POST'; req.headers = { host: '127.0.0.1:65193', 'x-keykeeper': '1' }
```

覆盖：status / init / selfcheck（settings 服务、`llm-pi-ai` 入口、凭据服务、路由表断言）/ keys/set（含换 key 同步凭据）/ keys/import（别名、订阅跳过）/ apply（断言 `apiKeyEnv` 与 `models`）/ provider/detect（真实模型过滤与挑模型、写路由，fetch stub）/ provider/test（成功、401 报错）/ provider/set-default（写 `agent-default-model`）/ provider/detect listOnly（只列对话模型、不写配置）/ 自定义余额（Bearer 前缀、http 拒绝）/ 订阅元数据（保存、拒绝 API 平台、status 回显）/ lock + 锁定态保留只读余额、隐藏 ui/keyHint + `/balance` 401 / 自动锁（默认 15、可关、可设 60、非法值 400）/ 错误密码 401 / 改密旧密码 401 中文 / export / import（格式校验、`.bak` 备份、过期路由清理）/ remove（断言路由与凭据同时删除）/ KDF 迁移（手工旧库 → unlock 后 `kdf.N=65536` 且 providers 保留）/ 非回环 Host 403 / 缺自定义头 403。当前基线：Host 52 项、Client 14 项，全过。

发布前手动验证（浏览器内）：

1. 刷新页面（Ctrl+R）→ 设置侧边栏出现「🔑 钥匙管家」，同时 Models 页底部有入口卡片、输入框右下角有药丸。
2. 首次设密码 → 加一个假 key → 写入 DSH → 模型页出现 `kk-` 供应商。
3. 删除该供应商 → 模型页消失；保险库重新上锁后再打开要求密码。
4. 输入框右下角药丸 → 面板打开/收起正常，充值链接在新标签页打开。

## 常见故障

| 现象 | 原因 / 处理 |
| --- | --- |
| 外部 curl 得到 401 | DSH Web 的登录令牌机制，与插件无关；只能浏览器内验证 |
| 页面刷新后 404 | Host 插件未挂载：重启 DSH |
| 卡片/药丸不出现 | Client bundle 未加载：确认 profile `cordis.patch.yml` 有 `keykeeper` 条目、node_modules 里链接有效，然后彻底重启 |
| 设置里整页消失、`list_bundles` 里该 bundle `availability:"missing"`、`rows:[]` | **源码目录改名/移动**导致 profile 的 `link:` 失效（本机 2026-11-26 把 `api管理器-试做` 改名成 `dsh-api管理器-11.26` 就踩过）。`remove_bundle dsh-keykeeper` → `install_bundle()` 指向新绝对路径；重装不会动 `$DSH_HOME/keykeeper` 里的保险库 |
| `Config field "…" is not volatile` | 只允许写 `llm-pi-ai.providers`；检查 `update` 的 patch 路径 |
| `UNSTORABLE_PROVIDER_ID` | route id 含大写/下划线/中文；统一 `kk-` + 小写连字符 |
| `MISSING_CREDENTIAL` | 先 `credentials.set` 再写 provider，顺序不能反 |
| `Unexpected token '\uFEFF'`，或 bundle 在 list_bundles 里 `rows:[]`、`entryId` 变 `unaddressable` | `package.json`/`index.js` 被写成带 BOM 的 UTF-8（PS 5.1 的 `Set-Content -Encoding UTF8` 会加 BOM）。用 `[System.IO.File]::WriteAllText($p,$s,[System.Text.UTF8Encoding]::new($false))` 重写；再 toggle 一次 |
| 改了 `index.js` 但 `last-mount.json` 版本没变 | 只改 `index.js` 才会触发重新 import；只改 `package.json` 不会。toggle 禁用→启用后再看 |

## 版本与发布

- 语义化版本写在 `package.json`；用户可见行为变化至少 bump minor。当前 **0.4.1**。
- 发布前更新 README 的「已知问题」与 AGENTS 的「待办」。
- 安装：GUI 插件页选择本目录，或 `scripts\install.cmd`（封装 `powershell -ExecutionPolicy Bypass -File scripts\install.ps1`，绕过系统脚本执行策略；直接跑 .ps1 会被拦）；以 `link:` 方式安装意味着源码即运行代码。
- 热更新：Host 端改完 `index.js` 后 `plugin_manager set_plugin(include:keykeeper, enabled:false→true)`，运行中的 DSH 会重新 import 本目录代码（实测 `$DSH_HOME/keykeeper/last-mount.json` 的 pid 仍是 desktop host 10168、时间戳/版本更新）。**只改 `package.json` 不会触发重新 import**（模块被缓存，`PKG` 在 import 时读取）——所以每轮改动都要动一下 `index.js`（哪怕只是 build 注释）。Client 端改动需浏览器 `Ctrl+R`。
- 写文件一律用无 BOM UTF-8：`Set-Content -Encoding UTF8` 在 PS 5.1 会写 BOM，DSH 的 bundle 清单用 `JSON.parse` 读，会直接失败（症状见「常见故障」）。`write`/`edit` 工具写出的文件无 BOM，可放心用。
- 挂载戳：`last-mount.json` 由 `apply()` 写入（时间/pid/版本），用于验证「运行的是不是最新代码」。

## 待办 / 路线图

- [x] `settings.section` 独立导航页（已注册，需浏览器实观）
- [x] 订阅类额度展示（手填套餐/额度/续费日，存保险库；不依赖非公开接口）
- [ ] 模型列表 UI 编辑（现在是写入时自动生成单模型）
- [ ] 余额低阈值提醒（阈值可配）
- [x] locale 接入与英文文案（meta.title/description 已补，UI 文案仍中文）
- [x] KDF 升级（N=65536，旧库解锁自动迁移；密码仍≥6 位，建议≥10）
- [ ] 安装脚本自动检测 `dsh` CLI 路径
- [ ] 插件市场投稿：建公开 GitHub 仓库（满 1 天）→ 加 `dsh-plugin` topic → 填 `docs/marketplace-entry.yml` 的 `<owner>` → 向 `awesome-dsh-plugin/awesome-dsh-plugin` 提 PR（只加 `data/plugins/<owner>__dsh-keykeeper.yml`）
- [ ] 逐家核对 13 个 403/超时链接（需要用户在有代理的本机点开确认）
- [ ] 可选：页面内编辑充值链接（vault.ui.rechargeOverrides 已存在，缺 UI）

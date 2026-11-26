# dsh-keykeeper（钥匙管家）

DSH 的本地钥匙保险库：集中保存各家模型 API Key、加密落盘、一键写入 DSH 模型配置，并顺带看余额、跳官方充值页。

- 插件 ID：`dsh-keykeeper`（bundle 条目 `keykeeper`）
- 版本：0.4.1（完整使用说明与排错见 [docs/使用说明.md](./docs/使用说明.md)）
- 源码目录：`E:\deepseek研究成果\dsh-api管理器-11.26`
- 已安装：以 `link:` 方式挂在 profile `desktop`（不复制源码，改完源码刷新/重启即生效）

## 功能

| 模块 | 说明 |
| --- | --- |
| 加密保险库 | 主密码 → scrypt(N=65536,r=8,p=1) 派生 32 字节 → AES-256-GCM；`vault.json` 只存密文，主密码不落盘；默认 15 分钟无操作自动上锁（设置里可改 5/15/30/60 分钟、4 小时或不自动锁）；锁定后仍可只读查看已缓存的余额，看 Key/导出仍需解锁；旧库（N=16384）解锁成功后自动迁移到 N=65536 |
| 平台目录 | 27 个内置入口：DeepSeek、Kimi/Moonshot、智谱 GLM、MiniMax、阶跃、硅基流动、通义百炼、火山方舟、腾讯混元、OpenAI、Anthropic、Gemini、xAI、Groq、Together、Fireworks、DeepInfra、Novita、Mistral、OpenRouter、Cerebras、Ollama（22 个 API 平台），以及 5 个订阅入口（ChatGPT / Claude Pro / Kimi Code / GLM Coding / MiniMax Plan） |
| 导入导出 | 粘贴 `platform=key` 逐行文本，或点「从文件读取」选本地 `keys.txt`/`.json`（支持 `#` 注释和 kimi→moonshot、glm→zhipu、qwen→dashscope、doubao→volcengine 等别名；订阅类行会被跳过并提示原因）；可导出明文备份、导入备份（先校验格式，覆盖前自动留 `.bak-<时间>`，导入后同步/清理对应 DSH 路由） |
| 写入 DSH | 为每个平台生成路由 `kk-<平台>` 和凭据 `KEYKEEPER_KK_<平台>_API_KEY`，调用 `settings.update('llm-pi-ai', …)` 热写入；模型选择器立即可用。换 Key 或导入后会自动同步已应用路由的凭据。写入失败时返回 YAML 片段，可手工粘贴到 `llm-pi-ai` 配置 |
| 自动检测模型 | 保存 Key 后自动 GET `{baseURL}/models` 拉该平台真实模型 id，过滤向量/重排/绘图/语音类，挑 8 个对话模型写进路由；也可手动点「检测并配置」重跑 |
| 自选模型 | 点「选择模型…」弹出该平台全部对话模型清单（搜索 + 勾选，可全选/清空），只把勾中的模型写进 DSH 路由，适合硅基流动这类“模型市场”平台 |
| 测试对话 / 设为默认 | 用真实 Key 发一条最小对话验证连通并显示耗时；「设为默认」把该平台模型写进 DSH 的 `agent-default-model`（不可写时提示手动设置） |
| 余额 | 官方接口可自动查的：DeepSeek、Moonshot、阶跃 StepFun、OpenRouter；其余平台显示“去控制台看”（硅基流动的 `/v1/user/info` 已于 2026-08-14 下线，改为只读显示充值余额需去控制台）。支持任意 OpenAI 兼容中转的自定义余额接口（URL + 请求头名/前缀 + JSON 字段路径 + 独立 Key；URL 必须 https） |
| 充值 | 每个平台一张卡，“充值/控制台”按钮用系统浏览器打开官方页面；链接可在 `ui.rechargeOverrides` 里覆盖。**不代付、不碰支付** |
| 订阅类 | 只提供登录/充值入口与备注，不写 DSH 路由（订阅没有可用的 API key/端点）；可在卡片里手动记录套餐、额度、续费日（厂商不开放额度接口），随保险库加密保存 |
| 设置页入口 | 设置侧边栏新增独立「钥匙管家」页（`settings.section` + 图标），内含同一套密钥/余额/充值/设置四个 tab；同时保留 Models 页底部卡片与输入框旁药丸 |

## 安装与更新

已安装。需要重装或换机器时：

1. GUI：设置 → 插件 → 安装本地 bundle → 选择 `E:\deepseek研究成果\dsh-api管理器-11.26`。
2. 或命令行：双击 `scripts\install.cmd`（内部用 `powershell -ExecutionPolicy Bypass` 调 `install.ps1`；直接运行 `.ps1` 会被系统的执行策略拦住）。

更新流程：改源码 → 跑 `test\host.test.mjs` 与 `test\client.test.mjs` → `node --check index.js`、`node --check client.js` → 在插件页禁用再启用（Host 端热重载）→ 浏览器 `Ctrl+R`（Client 端）。

安装器实测：`scripts\install.cmd -Profile desktop` 走通（pnpm 输出 `Packages: -12` 属正常去重），profile 依赖与 `node_modules\dsh-keykeeper` 链接保持完好。

测试（不启动 DSH，用假 ctx 直接跑路由与加载器）：

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
& 'C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe' 'E:\deepseek研究成果\dsh-api管理器-11.26\test\host.test.mjs'
& 'C:\Users\Administrator\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe' 'E:\deepseek研究成果\dsh-api管理器-11.26\test\client.test.mjs'
```

当前基线：Host 52 项、Client 14 项，全部通过。

## 使用

> 面向使用者的完整步骤（安装、迁移、换模型、余额/充值、常见问题）在 [docs/使用说明.md](./docs/使用说明.md)。

1. 打开 **设置 → 钥匙管家**（侧边栏独立页）；或设置 → 模型最下方的「🔑 钥匙管家」卡片；或点输入框右下角的钥匙药丸。首次打开先设主密码（至少 6 位，建议 10 位以上）。
2. 密钥页：粘贴 keys.txt、点「从文件读取」选 `keys.txt`/`.json`、逐个平台填 Key，或从备份导入。
3. 保存 Key 即自动「检测并配置」：插件拉取该平台真实模型、挑 8 个写入 DSH；成功后点「测试对话」确认连通，需要就点「设为默认」。
4. 余额页点「刷新」；充值页点卡片跳官方收银台。
5. 设置页：改主密码、导出明文备份、导入备份、查看保险库路径、手动上锁、**运行自检**（写 DSH 没反应时先跑它：检查 settings 服务、`llm-pi-ai` 入口、凭据服务、已写入路由）。

## 数据与迁移

- 保险库：`%USERPROFILE%\.dsh\keykeeper\vault.json`（可用 `DSH_KEYKEEPER_VAULT` 指向任意路径，例如 `F:\deepseekwork\vault.json`）。
- 余额缓存：同目录 `balance-cache.json`（只有余额数字和时间，不含 key）。
- 挂载戳：同目录 `last-mount.json`（每次 Host 端加载插件时写入时间与版本号，可用来确认运行中的 DSH 是否已加载最新代码）。
- 换电脑：拷走 `vault.json`，在新机器导入并输入原主密码即可；或在旧机「导出明文备份」，新机导入后重新设密码。
- 卸载插件不会删除保险库文件；确需清除请手动删目录。

## 安全边界

- Key 只存两处：加密的 `vault.json`、DSH 凭据库（`credentials.set`）。UI 只显示掩码，接口不回传明文 key（导出接口需再次输入主密码）。
- 余额与路由请求只发往厂商官方域名；自定义余额接口由你显式配置（强制 https，本机 localhost 例外），且只有 URL 与平台 `baseURL` 同 host 时才复用平台 Key，否则使用该适配器自己的 Key 或匿名。本机管理接口只监听 DSH Web 的回环地址，且有 Host 回环校验、同源校验、`x-keykeeper: 1` 自定义头校验。
- 已知限制：没有公开余额 API 的平台无法自动读取余额；订阅类无法读取剩余额度；充值只能跳转，不能代付。新建与迁移后为 scrypt N=65536；旧库解锁时自动升级（迁移失败只记日志、不影响解锁），主密码建议 10 位以上。
- 插件代码跑在本机、与 DSH 同权限；本插件没有外部上报、没有遥测。

## 已知问题

- Web GUI 的外部 HTTP 探测会先被 DSH 自身的登录令牌拦成 401（这是 DSH 的安全机制，不是插件问题）；验证请在浏览器页面内进行。
- 首次安装 Host 端可能已热挂载，但 Client 端需要刷新页面（Ctrl+R）；若模型页没有卡片，重启 DSH 后再看。

开发、测试与维护约定见 [AGENTS.md](./AGENTS.md)。

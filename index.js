import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

// ---------------------------------------------------------------------------
// dsh-keykeeper — 加密钥匙管家（Host 端）
// build: 0.2.2（改动本文件后，禁用/启用插件会让 DSH 重新 import）
// ---------------------------------------------------------------------------

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const VAULT_PATH = process.env.DSH_KEYKEEPER_VAULT || path.join(DSH_HOME, 'keykeeper', 'vault.json')
const CACHE_PATH = path.join(path.dirname(VAULT_PATH), 'balance-cache.json')
const SETTINGS_NS = 'llm-pi-ai'
const DEFAULT_AUTO_LOCK_MIN = 15
const KDF = { N: 16384, r: 8, p: 1 }
// 新建/迁移后的目标 KDF：N=65536 对离线爆破更难；旧库在解锁时自动迁移
const TARGET_KDF = { N: 65536, r: 8, p: 1 }
const SCRYPT_MAXMEM = 256 * 1024 * 1024
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

const log = (...args) => console.log('[keykeeper]', ...args)

const MOUNT_STAMP = path.join(path.dirname(VAULT_PATH), 'last-mount.json')

const PKG = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
  } catch {
    return {}
  }
})()

// 每次 Host 端挂载时写一行时间戳：用于确认「运行中的 DSH 是否已加载最新代码」
function writeMountStamp() {
  try {
    fs.mkdirSync(path.dirname(MOUNT_STAMP), { recursive: true })
    fs.writeFileSync(MOUNT_STAMP, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, version: PKG.version || 'unknown' }))
  } catch {}
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function send(res, code, obj) {
  res.writeHead(code, JSON_HEADERS)
  res.end(JSON.stringify(obj))
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        const err = new Error('请求体过大')
        err.status = 413
        reject(err)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function readJson(req) {
  const text = await readBody(req)
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    const err = new Error('请求体不是合法 JSON')
    err.status = 400
    throw err
  }
}

function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function writeAtomicSync(file, text) {
  ensureDirSync(path.dirname(file))
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, text, { mode: 0o600 })
  fs.renameSync(tmp, file)
}

function readJsonFileSync(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function nowIso() {
  return new Date().toISOString()
}

function isLoopbackHostname(hostname) {
  if (!hostname) return false
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === '::1') return true
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return false
  return [m[1], m[2], m[3]].every((part) => Number(part) >= 0 && Number(part) <= 255)
}

// ---------------------------------------------------------------------------
// 加密
// ---------------------------------------------------------------------------

function deriveKey(password, salt, params = TARGET_KDF) {
  return crypto.scryptSync(String(password), salt, 32, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: SCRYPT_MAXMEM,
  })
}

function kdfOf(container) {
  const kdf = (container && container.kdf) || {}
  const N = Number(kdf.N || KDF.N)
  const r = Number(kdf.r || KDF.r)
  const p = Number(kdf.p || KDF.p)
  if (![KDF.N, TARGET_KDF.N].includes(N) || r !== 8 || p !== 1) {
    const err = new Error('保险库文件的 KDF 参数不受支持')
    err.status = 400
    throw err
  }
  return { salt: Buffer.from(kdf.salt || '', 'base64'), N, r, p }
}

function sealVaultWithKey(vault, key, salt, params = TARGET_KDF) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(JSON.stringify(vault), 'utf8'), cipher.final()])
  return {
    v: 1,
    kdf: { salt: salt.toString('base64'), N: params.N, r: params.r, p: params.p },
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  }
}

function openVaultWithPassword(container, password) {
  const kdf = kdfOf(container)
  const key = crypto.scryptSync(String(password), kdf.salt, 32, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem: SCRYPT_MAXMEM,
  })
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(container.iv || '', 'base64'))
  decipher.setAuthTag(Buffer.from(container.tag || '', 'base64'))
  const plain = Buffer.concat([
    decipher.update(Buffer.from(container.data || '', 'base64')),
    decipher.final(),
  ]).toString('utf8')
  return { key, salt: kdf.salt, vault: JSON.parse(plain), kdf }
}

// ---------------------------------------------------------------------------
// 会话状态
// ---------------------------------------------------------------------------

const session = {
  key: null,
  vault: null,
  salt: null,
  kdfParams: null,
  timer: null,
}

function autoLockMs() {
  const minutes = session.vault && session.vault.ui ? Number(session.vault.ui.autoLockMinutes) : DEFAULT_AUTO_LOCK_MIN
  const n = Number.isFinite(minutes) ? Math.floor(minutes) : DEFAULT_AUTO_LOCK_MIN
  if (n <= 0) return 0
  return Math.max(1, Math.min(1440, n)) * 60 * 1000
}

function touchSession() {
  if (!session.key) return
  if (session.timer) clearTimeout(session.timer)
  session.timer = null
  const ms = autoLockMs()
  if (!ms) return
  session.timer = setTimeout(() => {
    session.key = null
    session.vault = null
    session.salt = null
    session.kdfParams = null
    session.timer = null
  }, ms)
  if (session.timer.unref) session.timer.unref()
}

function clearSession() {
  if (session.timer) clearTimeout(session.timer)
  session.key = null
  session.vault = null
  session.salt = null
  session.kdfParams = null
  session.timer = null
}

function requireUnlocked() {
  if (!session.vault) {
    const err = new Error('保险库未解锁')
    err.status = 401
    throw err
  }
  touchSession()
  return session.vault
}

function saveVault(vault) {
  if (!session.key || !session.salt) throw new Error('保险库未解锁')
  const container = sealVaultWithKey(vault, session.key, session.salt, session.kdfParams || TARGET_KDF)
  writeAtomicSync(VAULT_PATH, JSON.stringify(container))
  session.vault = vault
  touchSession()
}

function vaultExists() {
  try {
    return fs.statSync(VAULT_PATH).isFile()
  } catch {
    return false
  }
}

function loadContainer() {
  const container = readJsonFileSync(VAULT_PATH)
  if (!container || !container.data) throw new Error('保险库文件损坏或不存在')
  return container
}

// ---------------------------------------------------------------------------
// 平台目录
// ---------------------------------------------------------------------------

const PROVIDERS = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    group: '国内 · 按量',
    api: 'openai-completions',
    baseURL: 'https://api.deepseek.com',
    models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }, { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' }],
    keyPage: 'https://platform.deepseek.com/api_keys',
    recharge: 'https://platform.deepseek.com/top_up',
    console: 'https://platform.deepseek.com/usage',
  },
  {
    id: 'moonshot',
    name: 'Kimi / Moonshot',
    group: '国内 · 按量',
    api: 'openai-completions',
    baseURL: 'https://api.moonshot.cn/v1',
    models: [{ id: 'kimi-k2-0905-preview', name: 'Kimi K2' }, { id: 'kimi-k2-turbo-preview', name: 'Kimi K2 Turbo' }],
    keyPage: 'https://platform.moonshot.cn/console/api-keys',
    recharge: 'https://platform.moonshot.cn/console/account',
    console: 'https://platform.moonshot.cn/console/account',
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    group: '国内 · 按量',
    api: 'openai-completions',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    models: [{ id: 'glm-4.6', name: 'GLM-4.6' }, { id: 'glm-4.5-air', name: 'GLM-4.5 Air' }],
    keyPage: 'https://open.bigmodel.cn/usercenter/apikeys',
    recharge: 'https://open.bigmodel.cn/usercenter/finance',
    console: 'https://open.bigmodel.cn/usercenter/finance',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    group: '国内 · 按量',
    api: 'openai-completions',
    baseURL: 'https://api.minimaxi.com/v1',
    models: [{ id: 'MiniMax-M2', name: 'MiniMax M2' }, { id: 'MiniMax-Text-01', name: 'MiniMax Text 01' }],
    keyPage: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
    recharge: 'https://platform.minimax.cn/console/recharge-records',
    console: 'https://platform.minimax.cn/console/recharge-records',
  },
  {
    id: 'stepfun',
    name: '阶跃星辰 StepFun',
    group: '国内 · 按量',
    api: 'openai-completions',
    baseURL: 'https://api.stepfun.com/v1',
    models: [{ id: 'step-3', name: 'Step-3' }, { id: 'step-2-16k', name: 'Step-2 16K' }],
    keyPage: 'https://platform.stepfun.com/interface-key',
    recharge: 'https://platform.stepfun.com/',
    console: 'https://platform.stepfun.com/',
  },
  {
    id: 'siliconflow',
    name: '硅基流动 SiliconFlow',
    group: '国内 · 按量',
    api: 'openai-completions',
    baseURL: 'https://api.siliconflow.cn/v1',
    models: [{ id: 'deepseek-ai/DeepSeek-V3.2', name: 'DeepSeek V3.2' }, { id: 'Qwen/Qwen3-235B-A22B-Instruct-2507', name: 'Qwen3 235B' }],
    keyPage: 'https://cloud.siliconflow.cn/account/ak',
    recharge: 'https://cloud.siliconflow.cn/expensebill',
    console: 'https://cloud.siliconflow.cn/expensebill',
  },
  {
    id: 'dashscope',
    name: '通义百炼 DashScope',
    group: '国内 · 按量',
    api: 'openai-completions',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [{ id: 'qwen-max', name: 'Qwen Max' }, { id: 'qwen-plus', name: 'Qwen Plus' }, { id: 'qwen-flash', name: 'Qwen Flash' }],
    keyPage: 'https://bailian.console.aliyun.com/?tab=model#/api-key',
    recharge: 'https://bailian.console.aliyun.com/?tab=cost#/cost-center',
    console: 'https://bailian.console.aliyun.com/?tab=cost#/cost-center',
  },
  {
    id: 'volcengine',
    name: '火山方舟 豆包',
    group: '国内 · 按量',
    api: 'openai-completions',
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    models: [{ id: 'doubao-seed-1-6-250615', name: 'Doubao Seed 1.6' }],
    keyPage: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
    recharge: 'https://console.volcengine.com/finance/',
    console: 'https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement',
  },
  {
    id: 'hunyuan',
    name: '腾讯混元',
    group: '国内 · 按量',
    api: 'openai-completions',
    baseURL: 'https://api.hunyuan.cloud.tencent.com/v1',
    models: [{ id: 'hunyuan-t1-latest', name: 'Hunyuan T1' }, { id: 'hunyuan-turbos-latest', name: 'Hunyuan TurboS' }],
    keyPage: 'https://console.cloud.tencent.com/hunyuan/api-key',
    recharge: 'https://console.cloud.tencent.com/finance/',
    console: 'https://console.cloud.tencent.com/hunyuan',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    group: '海外 · 按量',
    api: 'openai-completions',
    baseURL: 'https://api.openai.com/v1',
    models: [{ id: 'gpt-5', name: 'GPT-5' }, { id: 'gpt-4.1', name: 'GPT-4.1' }, { id: 'o4-mini', name: 'o4-mini' }],
    keyPage: 'https://platform.openai.com/api-keys',
    recharge: 'https://platform.openai.com/settings/organization/billing/overview',
    console: 'https://platform.openai.com/usage',
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    group: '海外 · 按量',
    api: 'anthropic-messages',
    baseURL: 'https://api.anthropic.com',
    models: [{ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' }, { id: 'claude-opus-4-1', name: 'Claude Opus 4.1' }, { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' }],
    keyPage: 'https://console.anthropic.com/settings/keys',
    recharge: 'https://console.anthropic.com/settings/billing',
    console: 'https://console.anthropic.com/settings/billing',
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    group: '海外 · 按量',
    api: 'google-generative-ai',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    models: [{ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }, { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' }],
    keyPage: 'https://aistudio.google.com/apikey',
    recharge: 'https://console.cloud.google.com/billing',
    console: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'xai',
    name: 'xAI Grok',
    group: '海外 · 按量',
    api: 'openai-completions',
    baseURL: 'https://api.x.ai/v1',
    models: [{ id: 'grok-4', name: 'Grok 4' }, { id: 'grok-3', name: 'Grok 3' }],
    keyPage: 'https://console.x.ai/',
    recharge: 'https://console.x.ai/team/default/billing',
    console: 'https://console.x.ai/team/default/billing',
  },
  {
    id: 'groq',
    name: 'Groq',
    group: '海外 · 按量',
    api: 'openai-completions',
    baseURL: 'https://api.groq.com/openai/v1',
    models: [{ id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B' }, { id: 'openai/gpt-oss-120b', name: 'GPT-OSS 120B' }],
    keyPage: 'https://console.groq.com/keys',
    recharge: 'https://console.groq.com/settings/billing',
    console: 'https://console.groq.com/usage',
  },
  {
    id: 'together',
    name: 'Together AI',
    group: '海外 · 按量',
    api: 'openai-completions',
    baseURL: 'https://api.together.xyz/v1',
    models: [{ id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', name: 'Llama 3.3 70B Turbo' }, { id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek V3' }],
    keyPage: 'https://api.together.ai/settings/api-keys',
    recharge: 'https://api.together.ai/settings/billing',
    console: 'https://api.together.ai/settings/billing',
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    group: '海外 · 按量',
    api: 'openai-completions',
    baseURL: 'https://api.fireworks.ai/inference/v1',
    models: [{ id: 'accounts/fireworks/models/deepseek-v3p1', name: 'DeepSeek V3.1' }],
    keyPage: 'https://fireworks.ai/account/api-keys',
    recharge: 'https://fireworks.ai/account/billing',
    console: 'https://fireworks.ai/account/billing',
  },
  {
    id: 'deepinfra',
    name: 'DeepInfra',
    group: '海外 · 按量',
    api: 'openai-completions',
    baseURL: 'https://api.deepinfra.com/v1/openai',
    models: [{ id: 'meta-llama/Llama-3.3-70B-Instruct', name: 'Llama 3.3 70B' }],
    keyPage: 'https://deepinfra.com/dash/api_keys',
    recharge: 'https://deepinfra.com/dash/billing',
    console: 'https://deepinfra.com/dash/billing',
  },
  {
    id: 'novita',
    name: 'Novita AI',
    group: '海外 · 按量',
    api: 'openai-completions',
    baseURL: 'https://api.novita.ai/v3/openai',
    models: [{ id: 'deepseek/deepseek-v3.2', name: 'DeepSeek V3.2' }],
    keyPage: 'https://novita.ai/settings/key-management',
    recharge: 'https://novita.ai/billing',
    console: 'https://novita.ai/billing',
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    group: '海外 · 按量',
    api: 'openai-completions',
    baseURL: 'https://api.mistral.ai/v1',
    models: [{ id: 'mistral-large-latest', name: 'Mistral Large' }, { id: 'codestral-latest', name: 'Codestral' }],
    keyPage: 'https://console.mistral.ai/api-keys',
    recharge: 'https://console.mistral.ai/billing/',
    console: 'https://console.mistral.ai/billing/',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    group: '海外 · 聚合',
    api: 'openai-completions',
    baseURL: 'https://openrouter.ai/api/v1',
    models: [{ id: 'deepseek/deepseek-chat-v3.1', name: 'DeepSeek V3.1' }, { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5' }],
    keyPage: 'https://openrouter.ai/settings/keys',
    recharge: 'https://openrouter.ai/settings/credits',
    console: 'https://openrouter.ai/settings/credits',
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    group: '海外 · 按量',
    api: 'openai-completions',
    baseURL: 'https://api.cerebras.ai/v1',
    models: [{ id: 'gpt-oss-120b', name: 'GPT-OSS 120B' }],
    keyPage: 'https://cloud.cerebras.ai/',
    recharge: 'https://cloud.cerebras.ai/',
    console: 'https://cloud.cerebras.ai/',
  },
  {
    id: 'ollama',
    name: 'Ollama（本机）',
    group: '本地',
    api: 'openai-completions',
    baseURL: 'http://127.0.0.1:11434/v1',
    models: [{ id: 'qwen3:8b', name: 'Qwen3 8B' }],
    keyPage: 'https://ollama.com/download',
    recharge: 'https://ollama.com/download',
    console: 'https://ollama.com/download',
    local: true,
  },
  // 订阅类：只做充值入口与备注，不写 DSH 路由
  {
    id: 'chatgpt',
    name: 'ChatGPT 订阅',
    group: '订阅 · 官方',
    kind: 'subscription',
    recharge: 'https://chatgpt.com/#pricing',
    console: 'https://chatgpt.com/',
    note: '订阅额度需配合 dsh-codex-subscription 等插件登录使用；本插件只提供充值入口。',
  },
  {
    id: 'claude-pro',
    name: 'Claude Pro / Max',
    group: '订阅 · 官方',
    kind: 'subscription',
    recharge: 'https://claude.ai/upgrade',
    console: 'https://claude.ai/',
    note: '订阅额度需配合 dsh-plugin-subscriptions 等插件登录使用。',
  },
  {
    id: 'kimi-code',
    name: 'Kimi Code 会员',
    group: '订阅 · 官方',
    kind: 'subscription',
    recharge: 'https://www.kimi.com/code',
    console: 'https://www.kimi.com/code',
    note: '会员提供 Anthropic 兼容端点，可直接填入 DSH 自定义模型 API。',
  },
  {
    id: 'glm-coding',
    name: 'GLM Coding Plan',
    group: '订阅 · 官方',
    kind: 'subscription',
    recharge: 'https://bigmodel.cn/claude-code',
    console: 'https://bigmodel.cn/claude-code',
    note: '订阅后使用 Anthropic 兼容端点 https://open.bigmodel.cn/api/anthropic。',
  },
  {
    id: 'minimax-plan',
    name: 'MiniMax M Plan',
    group: '订阅 · 官方',
    kind: 'subscription',
    recharge: 'https://platform.minimaxi.com/subscribe/coding-plan',
    console: 'https://platform.minimaxi.com/subscribe/coding-plan',
    note: '订阅 Key 可直接用于 Claude Code / DSH 自定义模型 API。',
  },
]

const PROVIDER_MAP = new Map(PROVIDERS.map((p) => [p.id, p]))

function publicCatalog() {
  return PROVIDERS.map((p) => ({
    id: p.id,
    name: p.name,
    group: p.group,
    kind: p.kind || 'api',
    api: p.api || null,
    baseURL: p.baseURL || null,
    models: p.models || [],
    keyPage: p.keyPage || null,
    recharge: p.recharge || null,
    console: p.console || null,
    balanceApi: Boolean(BALANCES[p.id]),
    note: p.note || null,
  }))
}

// ---------------------------------------------------------------------------
// 余额适配器
// ---------------------------------------------------------------------------

const BALANCES = {
  deepseek: {
    url: 'https://api.deepseek.com/user/balance',
    headers: (key) => ({ authorization: `Bearer ${key}` }),
    parse: (j) => {
      const b = (j.balance_infos || [])[0] || {}
      return { amount: Number(b.total_balance), currency: b.currency || 'CNY', note: '总余额' }
    },
  },
  moonshot: {
    url: 'https://api.moonshot.cn/v1/users/me/balance',
    headers: (key) => ({ authorization: `Bearer ${key}` }),
    parse: (j) => {
      const d = j.data || {}
      return { amount: Number(d.available_balance), currency: 'CNY', note: '可用余额' }
    },
  },
  stepfun: {
    url: 'https://api.stepfun.com/v1/accounts',
    headers: (key) => ({ authorization: `Bearer ${key}` }),
    parse: (j) => {
      const d = (j && j.data) || j || {}
      const amount = Number(d.balance != null ? d.balance : d.total_balance)
      return { amount, currency: 'CNY', note: '账户余额' }
    },
  },
  openrouter: {
    url: 'https://openrouter.ai/api/v1/credits',
    headers: (key) => ({ authorization: `Bearer ${key}` }),
    parse: (j) => {
      const d = j.data || {}
      const left = Number(d.total_credits) - Number(d.total_usage)
      return { amount: left, currency: 'USD', note: '剩余额度' }
    },
  },
}

async function fetchBalance(provider, key) {
  const adapter = BALANCES[provider.id]
  if (!adapter) return null
  const res = await fetch(adapter.url, {
    headers: adapter.headers(key),
    signal: AbortSignal.timeout(10000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return adapter.parse(JSON.parse(text))
}

function authHeaderFor(adapter, key) {
  if (!key) return {}
  const name = adapter.headerName || 'authorization'
  let prefix = adapter.headerPrefix == null ? 'Bearer ' : String(adapter.headerPrefix)
  if (prefix && !prefix.endsWith(' ')) prefix += ' '
  return { [name]: `${prefix}${key}` }
}

async function fetchCustomBalance(adapter, key) {
  const res = await fetch(adapter.url, {
    headers: authHeaderFor(adapter, key),
    signal: AbortSignal.timeout(10000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = JSON.parse(text)
  let value = data
  for (const part of String(adapter.jsonPath || '').split('.').filter(Boolean)) {
    value = value == null ? value : value[part]
  }
  const amount = Number(value)
  if (!Number.isFinite(amount)) throw new Error(`JSON 路径 ${adapter.jsonPath} 未取到数字`)
  return { amount, currency: adapter.currency || 'CNY', note: adapter.note || adapter.name || '自定义接口' }
}

// ---------------------------------------------------------------------------
// 余额缓存
// ---------------------------------------------------------------------------

function loadCache() {
  return readJsonFileSync(CACHE_PATH) || { updatedAt: null, items: {} }
}

function saveCache(cache) {
  writeAtomicSync(CACHE_PATH, JSON.stringify(cache))
}

async function refreshAllBalances(vault) {
  const cache = loadCache()
  const tasks = []
  for (const [id, entry] of Object.entries(vault.providers || {})) {
    const provider = PROVIDER_MAP.get(id)
    if (!provider || provider.kind === 'subscription' || !entry.key) continue
    if (!BALANCES[id]) {
      cache.items[id] = { ok: false, noApi: true, at: nowIso() }
      continue
    }
    tasks.push(
      (async () => {
        try {
          const info = await fetchBalance(provider, entry.key)
          cache.items[id] = { ok: true, ...info, at: nowIso() }
        } catch (e) {
          cache.items[id] = { ok: false, error: String(e && e.message ? e.message : e), at: nowIso() }
        }
      })(),
    )
  }
  for (const adapter of vault.customBalances || []) {
    let key = adapter.key ? String(adapter.key) : ''
    if (!key && adapter.providerId) {
      const provider = PROVIDER_MAP.get(adapter.providerId)
      const src = (vault.providers || {})[adapter.providerId]
      // 只有目标 URL 与厂商官方域名同源时才复用平台 Key，避免把 Key 发给任意地址
      try {
        if (src && src.key && provider && provider.baseURL) {
          const a = new URL(adapter.url)
          const b = new URL(provider.baseURL)
          if (a.host === b.host) key = src.key
        }
      } catch {}
    }
    tasks.push(
      (async () => {
        try {
          const info = await fetchCustomBalance(adapter, key)
          cache.items[`custom:${adapter.id}`] = { ok: true, ...info, name: adapter.name, at: nowIso() }
        } catch (e) {
          cache.items[`custom:${adapter.id}`] = { ok: false, error: String(e && e.message ? e.message : e), name: adapter.name, at: nowIso() }
        }
      })(),
    )
  }
  const limit = 4
  let cursor = 0
  async function worker() {
    while (cursor < tasks.length) {
      const i = cursor++
      await tasks[i]
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker))
  cache.updatedAt = nowIso()
  saveCache(cache)
  return cache
}

// ---------------------------------------------------------------------------
// DSH 配置写入
// ---------------------------------------------------------------------------

function routeIdFor(id) {
  return `kk-${id}`
}

function refFor(routeId) {
  return `KEYKEEPER_${routeId.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase()}_API_KEY`
}

function normalizeModels(models) {
  const list = Array.isArray(models) ? models : []
  const out = []
  for (const m of list) {
    if (typeof m === 'string' && m.trim()) out.push({ id: m.trim(), name: m.trim() })
    else if (m && typeof m.id === 'string' && m.id.trim()) out.push({ id: m.id.trim(), name: (m.name || m.id).trim() })
  }
  if (!out.length) return null
  return out
}

function yamlSnippet(providers) {
  const lines = ['llm-pi-ai:', '  providers:']
  for (const [routeId, cfg] of Object.entries(providers)) {
    lines.push(`    ${routeId}:`)
    lines.push(`      displayName: ${JSON.stringify(cfg.displayName)}`)
    lines.push(`      api: ${cfg.api}`)
    lines.push(`      baseURL: ${cfg.baseURL}`)
    lines.push(`      apiKeyEnv: ${cfg.apiKeyEnv}`)
    lines.push('      models:')
    for (const m of cfg.models) {
      lines.push(`        - id: ${JSON.stringify(m.id)}`)
      if (m.name) lines.push(`          name: ${JSON.stringify(m.name)}`)
    }
  }
  return lines.join('\n')
}

async function appliedRouteIds(ctx) {
  const settings = ctx.get('settings')
  if (!settings || typeof settings.describe !== 'function') return null
  try {
    const descriptors = await settings.describe({ redactSecrets: true })
    const entry = (descriptors || []).find((d) => d.ns === SETTINGS_NS)
    const providers = entry && entry.value && entry.value.providers
    return providers && typeof providers === 'object' ? Object.keys(providers) : []
  } catch {
    return null
  }
}

// 把 vault 里最新的 Key 同步到已写入 DSH 的路由（换 key 后不用再手动 apply）
async function syncCredentials(ctx, vault) {
  const applied = await appliedRouteIds(ctx)
  if (!applied || !applied.length) return []
  const updated = []
  for (const [id, entry] of Object.entries(vault.providers || {})) {
    if (!entry || !entry.key) continue
    const routeId = routeIdFor(id)
    if (!applied.includes(routeId)) continue
    try {
      await ctx.credentials.set(refFor(routeId), entry.key)
      updated.push(id)
    } catch (e) {
      log('credential sync failed:', id, String(e && e.message ? e.message : e))
    }
  }
  return updated
}

// 清掉 vault 里已经不存在的 kk-* 路由与凭据（导入备份/删除平台后防止 MISSING_CREDENTIAL）
async function reconcileRoutes(ctx, vault) {
  const settings = ctx.get('settings')
  const applied = await appliedRouteIds(ctx)
  if (!settings || !applied) return { removed: [] }
  const keep = new Set(Object.keys(vault.providers || {}).map((id) => routeIdFor(id)))
  const removed = []
  for (const routeId of applied) {
    if (!routeId.startsWith('kk-') || keep.has(routeId)) continue
    try {
      await settings.mutate(SETTINGS_NS, [{ op: 'unset', path: ['providers', routeId] }])
    } catch (e) {
      log('reconcile route failed:', routeId, String(e && e.message ? e.message : e))
    }
    try {
      await ctx.credentials.unset(refFor(routeId))
    } catch {}
    removed.push(routeId)
  }
  return { removed }
}

// ---------------------------------------------------------------------------
// 模型探测 / 连通性测试 / 单平台写入
// ---------------------------------------------------------------------------

const MODEL_EXCLUDE =
  /(embed|embedding|rerank|bge|gme|tts|speech|audio|whisper|image|video|ocr|-vl-|vision|cogview|kolors|flux|stable-diffusion|moss-image)/i

const MODEL_PREFER = ['deepseek', 'qwen3', 'qwen2.5', 'glm', 'kimi', 'minimax', 'llama', 'gpt-oss', 'gemma', 'mistral']

function pickModels(ids) {
  const scored = []
  for (const id of ids) {
    if (!id || MODEL_EXCLUDE.test(id)) continue
    const lower = String(id).toLowerCase()
    let score = 0
    MODEL_PREFER.forEach((kw, i) => {
      if (lower.includes(kw)) score = Math.max(score, MODEL_PREFER.length - i)
    })
    if (/instruct|chat/.test(lower)) score += 1
    scored.push({ id, score })
  }
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  return scored.slice(0, 8).map((x) => x.id)
}

function joinBase(base) {
  return String(base || '').replace(/\/+$/, '')
}

function versionedBase(base) {
  const b = joinBase(base)
  return /\/v\d+[a-z0-9]*$/.test(b) ? b : `${b}/v1`
}

function httpError(status, text) {
  const err = new Error(`HTTP ${status}${text ? ` ${String(text).slice(0, 200)}` : ''}`)
  err.status = status
  return err
}

function idsFromModelsPayload(data) {
  const list = Array.isArray(data && data.data)
    ? data.data
    : Array.isArray(data && data.models)
      ? data.models
      : Array.isArray(data)
        ? data
        : []
  const ids = []
  for (const m of list) {
    const id = typeof m === 'string' ? m : m && (m.id || m.name)
    if (id) ids.push(String(id))
  }
  return ids
}

async function listProviderModels(provider, entry) {
  const api = entry.api || provider.api || 'openai-completions'
  const base = entry.baseURL || provider.baseURL
  const key = entry.key
  const headers = { accept: 'application/json' }
  let url
  if (api === 'anthropic-messages') {
    url = `${versionedBase(base)}/models?limit=1000`
    headers['x-api-key'] = key
    headers['anthropic-version'] = '2023-06-01'
  } else if (api === 'google-generative-ai') {
    url = `${joinBase(base)}/models?pageSize=1000&key=${encodeURIComponent(key)}`
  } else {
    url = `${joinBase(base)}/models`
    headers.authorization = `Bearer ${key}`
  }
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) })
  const text = await res.text()
  if (!res.ok) throw httpError(res.status, text)
  try {
    return idsFromModelsPayload(JSON.parse(text))
  } catch {
    throw new Error('模型列表返回的不是 JSON')
  }
}

async function testProviderChat(provider, entry, model) {
  const api = entry.api || provider.api || 'openai-completions'
  const base = entry.baseURL || provider.baseURL
  const key = entry.key
  const started = Date.now()
  let res
  if (api === 'anthropic-messages') {
    res = await fetch(`${versionedBase(base)}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
      signal: AbortSignal.timeout(30000),
    })
  } else if (api === 'google-generative-ai') {
    res = await fetch(`${joinBase(base)}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: 'ping' }] }] }),
      signal: AbortSignal.timeout(30000),
    })
  } else {
    res = await fetch(`${joinBase(base)}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 16, stream: false }),
      signal: AbortSignal.timeout(30000),
    })
  }
  const text = await res.text()
  if (!res.ok) throw httpError(res.status, text)
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return { ms: Date.now() - started, reply: '' }
  }
  let reply = ''
  if (api === 'anthropic-messages') {
    reply = (data.content || []).map((c) => (c && c.text) || '').join('')
  } else if (api === 'google-generative-ai') {
    const cand = (data.candidates || [])[0] || {}
    reply = ((cand.content && cand.content.parts) || []).map((p) => (p && p.text) || '').join('')
  } else {
    const choice = (data.choices || [])[0] || {}
    reply = (choice.message && (choice.message.content || choice.message.reasoning_content)) || ''
  }
  return { ms: Date.now() - started, reply: String(reply).slice(0, 120) }
}

async function applyProvider(ctx, vault, id) {
  const provider = PROVIDER_MAP.get(id)
  const entry = vault.providers && vault.providers[id]
  if (!provider) throw new Error('未知平台')
  if (provider.kind === 'subscription') throw new Error('订阅类平台不写入 DSH 模型')
  if (!entry || !entry.key) throw new Error('该平台还没有保存 Key')
  const settings = ctx.get('settings')
  if (!settings || typeof settings.update !== 'function') throw new Error('settings 服务不可用')
  const routeId = entry.routeId || routeIdFor(id)
  const ref = refFor(routeId)
  const models = normalizeModels(entry.models) || normalizeModels(provider.models)
  if (!models) throw new Error('没有模型配置')
  await ctx.credentials.set(ref, entry.key)
  const cfg = {
    displayName: provider.name,
    api: entry.api || provider.api,
    baseURL: entry.baseURL || provider.baseURL,
    apiKeyEnv: ref,
    models,
  }
  await settings.update(SETTINGS_NS, { providers: { [routeId]: cfg } })
  entry.routeId = routeId
  return { routeId, cfg, models }
}

// ---------------------------------------------------------------------------
// HTTP 处理
// ---------------------------------------------------------------------------

function fenceStatus(ctx, req) {
  try {
    const headers = req.headers || {}
    let hostUrl
    try {
      hostUrl = new URL(`http://${headers.host || ''}`)
    } catch {
      return 403
    }
    if (!isLoopbackHostname(hostUrl.hostname)) return 403
    if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return 403
    const origin = headers.origin
    if (origin && origin !== 'null') {
      let originUrl
      try {
        originUrl = new URL(origin)
      } catch {
        return 403
      }
      if (originUrl.host !== hostUrl.host) return 403
    }
    const connection = ctx.get('connection')
    if (connection && typeof connection.requestRejection === 'function') {
      const verdict = connection.requestRejection(req)
      if (verdict) return typeof verdict === 'number' ? verdict : 403
    }
    if ((req.method || 'GET').toUpperCase() !== 'GET' && headers['x-keykeeper'] !== '1') return 403
    return 0
  } catch {
    return 403
  }
}

function registerApi(ctx, disposers, pathName, handler) {
  const dispose = ctx.webServer.register({
    kind: 'exact',
    path: pathName,
    handler: async (req, res) => {
      const status = fenceStatus(ctx, req)
      if (status) {
        res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('forbidden')
        return
      }
      try {
        await handler(req, res)
      } catch (e) {
        const code = e && e.status ? e.status : 500
        send(res, code, { error: String((e && e.message) || e) })
      }
    },
  })
  disposers.push(dispose)
}

function buildStatus(ctx, vault, applied) {
  const cache = loadCache()
  const locked = !vault
  const autoLockMinutes =
    locked || !vault.ui || vault.ui.autoLockMinutes === undefined ? DEFAULT_AUTO_LOCK_MIN : Number(vault.ui.autoLockMinutes)
  return {
    hasVault: vaultExists(),
    locked,
    vaultPath: locked ? null : VAULT_PATH,
    autoLockMinutes: Number.isFinite(autoLockMinutes) ? autoLockMinutes : DEFAULT_AUTO_LOCK_MIN,
    settingsAvailable: Boolean(ctx.get('settings')),
    providers: publicCatalog().map((p) => {
      const entry = vault && vault.providers ? vault.providers[p.id] : null
      const bal = cache.items[p.id] || (cache.items[`custom:${p.id}`] || null)
      return {
        ...p,
        keyConfigured: Boolean(!locked && entry && entry.key),
        keyHint: !locked && entry && entry.key ? `••••${String(entry.key).slice(-4)}` : null,
        applied: !locked && applied ? applied.includes(routeIdFor(p.id)) : false,
        balance: bal || null,
      }
    }),
    customBalances: locked ? [] : (vault.customBalances || []),
    subscriptions: locked ? {} : (vault.subscriptions || {}),
    balances: locked ? {} : cache.items,
    balanceUpdatedAt: locked ? null : cache.updatedAt,
    ui: locked ? null : (vault.ui || {}),
    appliedRouteIds: locked ? null : applied,
    configYaml: null,
  }
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

function buildSelfcheck(ctx, vault, applied) {
  return (async () => {
    const checks = []
    const push = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: detail ? String(detail) : '' })
    push('Web 路由', true, '/keykeeper/api/*')
    let settings = null
    try {
      settings = ctx.get('settings')
    } catch {}
    push('settings 服务', settings && typeof settings.describe === 'function', settings ? '已挂载' : '未挂载')
    let entry = null
    if (settings && typeof settings.describe === 'function') {
      try {
        const list = await settings.describe({ redactSecrets: true })
        entry = (list || []).find((d) => d && d.ns === 'llm-pi-ai') || null
      } catch (e) {
        push('settings.describe()', false, (e && e.message) || e)
      }
    }
    push('llm-pi-ai 配置入口', entry, entry ? 'ns = llm-pi-ai' : '未找到 llm-pi-ai')
    if (entry) {
      const providers = entry.value && entry.value.providers
      const count = providers && typeof providers === 'object' ? Object.keys(providers).length : 0
      push('providers 路由表', true, `现有 ${count} 条路由`)
    }
    const cred = ctx.credentials
    push('credentials 服务', cred && typeof cred.set === 'function', cred ? '可写入' : '未挂载')
    push('保险库', vault, vault ? '已解锁' : '未解锁（先建库）')
    const mine = (applied || []).filter((id) => String(id).startsWith('kk-'))
    push('已写入 DSH 的路由', true, mine.length ? mine.join(', ') : '暂无')
    const cache = loadCache()
    push('余额缓存', true, cache.updatedAt ? `更新于 ${cache.updatedAt}` : '尚未刷新')
    return { ok: checks.every((c) => c.ok), checks }
  })()
}

export default {
  name: 'dsh-keykeeper',
  apply(root) {
    root.inject(['webServer', 'credentials', 'connection'], (ctx) => {
      writeMountStamp()
      const disposers = []
      ctx.effect(() => () => {
        for (const d of disposers) {
          try {
            d()
          } catch {}
        }
      })

      log('mounted; vault =', VAULT_PATH)

      // --- 状态 ---
      registerApi(ctx, disposers, '/keykeeper/api/status', async (req, res) => {
        const vault = session.vault
        const applied = vault ? await appliedRouteIds(ctx) : null
        send(res, 200, buildStatus(ctx, vault, applied))
      })

      // --- 目录 ---
      registerApi(ctx, disposers, '/keykeeper/api/catalog', async (req, res) => {
        send(res, 200, { providers: publicCatalog() })
      })

      // --- 自检 ---
      registerApi(ctx, disposers, '/keykeeper/api/selfcheck', async (req, res) => {
        const vault = session.vault
        const applied = vault ? await appliedRouteIds(ctx) : null
        send(res, 200, await buildSelfcheck(ctx, vault, applied))
      })

      // --- 保险库初始化 ---
      registerApi(ctx, disposers, '/keykeeper/api/vault/init', async (req, res) => {
        if (vaultExists()) {
          send(res, 409, { error: '保险库已存在，请直接解锁或删除文件后重建' })
          return
        }
        const body = await readJson(req)
        const password = String(body.password || '')
        if (password.length < 6) {
          send(res, 400, { error: '密码至少 6 位' })
          return
        }
        const salt = crypto.randomBytes(16)
        const key = deriveKey(password, salt)
        const vault = { v: 1, createdAt: nowIso(), providers: {}, customBalances: [], subscriptions: {}, ui: { rechargeOverrides: {}, autoLockMinutes: DEFAULT_AUTO_LOCK_MIN } }
        const container = sealVaultWithKey(vault, key, salt)
        writeAtomicSync(VAULT_PATH, JSON.stringify(container))
        session.key = key
        session.salt = salt
        session.kdfParams = TARGET_KDF
        session.vault = vault
        touchSession()
        send(res, 200, { ok: true, status: buildStatus(ctx, vault, await appliedRouteIds(ctx)) })
      })

      // --- 解锁 ---
      registerApi(ctx, disposers, '/keykeeper/api/vault/unlock', async (req, res) => {
        const body = await readJson(req)
        const password = String(body.password || '')
        let opened
        try {
          opened = openVaultWithPassword(loadContainer(), password)
        } catch {
          send(res, 401, { error: '密码不正确或保险库损坏' })
          return
        }
        // 旧库（N=16384）在解锁成功后自动迁移到更强 KDF
        let { key, salt, vault, kdf } = opened
        let migrated = false
        if (kdf.N < TARGET_KDF.N) {
          try {
            salt = crypto.randomBytes(16)
            key = deriveKey(password, salt)
            const container = sealVaultWithKey(vault, key, salt, TARGET_KDF)
            writeAtomicSync(VAULT_PATH, JSON.stringify(container))
            migrated = true
            log('vault KDF migrated to N=' + TARGET_KDF.N)
          } catch (e) {
            log('vault KDF migration failed:', (e && e.message) || e)
          }
        }
        session.key = key
        session.salt = salt
        session.kdfParams = migrated ? TARGET_KDF : kdf
        session.vault = vault
        touchSession()
        send(res, 200, { ok: true, migrated, status: buildStatus(ctx, vault, await appliedRouteIds(ctx)) })
      })

      // --- 锁定 ---
      registerApi(ctx, disposers, '/keykeeper/api/vault/lock', async (req, res) => {
        clearSession()
        send(res, 200, { ok: true })
      })

      // --- 自动锁定设置 ---
      registerApi(ctx, disposers, '/keykeeper/api/vault/auto-lock', async (req, res) => {
        const vault = requireUnlocked()
        const body = await readJson(req)
        const minutes = Number(body.minutes)
        if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) {
          send(res, 400, { error: '自动锁时间需为 0–1440 的整数（分钟）' })
          return
        }
        vault.ui = vault.ui || {}
        vault.ui.autoLockMinutes = minutes
        saveVault(vault)
        send(res, 200, { ok: true, autoLockMinutes: minutes })
      })

      // --- 改密码 ---
      registerApi(ctx, disposers, '/keykeeper/api/vault/password', async (req, res) => {
        const body = await readJson(req)
        const newPassword = String(body.newPassword || '')
        if (newPassword.length < 6) {
          send(res, 400, { error: '新密码至少 6 位' })
          return
        }
        let container
        try {
          container = loadContainer()
        } catch {
          send(res, 404, { error: '保险库不存在' })
          return
        }
        let vault
        try {
          vault = openVaultWithPassword(container, String(body.oldPassword || '')).vault
        } catch {
          send(res, 401, { error: '旧密码不正确' })
          return
        }
        const salt = crypto.randomBytes(16)
        const key = deriveKey(newPassword, salt)
        writeAtomicSync(VAULT_PATH, JSON.stringify(sealVaultWithKey(vault, key, salt, TARGET_KDF)))
        session.key = key
        session.salt = salt
        session.kdfParams = TARGET_KDF
        session.vault = vault
        touchSession()
        send(res, 200, { ok: true })
      })

      // --- 保存单个 Key ---
      registerApi(ctx, disposers, '/keykeeper/api/keys/set', async (req, res) => {
        const vault = requireUnlocked()
        const body = await readJson(req)
        const id = String(body.providerId || '')
        const provider = PROVIDER_MAP.get(id)
        if (!provider || provider.kind === 'subscription') {
          send(res, 400, { error: '未知或不可配置的平台' })
          return
        }
        const key = String(body.key || '').trim()
        if (!key) {
          send(res, 400, { error: 'API Key 不能为空' })
          return
        }
        const entry = { key, addedAt: nowIso() }
        if (body.baseURL) entry.baseURL = String(body.baseURL)
        if (body.api) entry.api = String(body.api)
        const models = normalizeModels(body.models)
        if (models) entry.models = models
        vault.providers[id] = entry
        saveVault(vault)
        // 该平台此前已写入 DSH 时，立刻把新 Key 推给凭据库，避免继续用旧 Key
        let credentialUpdated = false
        try {
          const applied = await appliedRouteIds(ctx)
          const routeId = routeIdFor(id)
          if (applied && applied.includes(routeId)) {
            await ctx.credentials.set(refFor(routeId), key)
            entry.routeId = routeId
            saveVault(vault)
            credentialUpdated = true
          }
        } catch (e) {
          log('credential push failed:', id, String(e && e.message ? e.message : e))
        }
        send(res, 200, { ok: true, credentialUpdated })
      })

      // --- 删除 Key ---
      registerApi(ctx, disposers, '/keykeeper/api/keys/remove', async (req, res) => {
        const vault = requireUnlocked()
        const body = await readJson(req)
        const id = String(body.providerId || '')
        if (!vault.providers[id]) {
          send(res, 404, { error: '该平台没有保存的 Key' })
          return
        }
        delete vault.providers[id]
        if (vault.ui && vault.ui.rechargeOverrides) delete vault.ui.rechargeOverrides[id]
        saveVault(vault)
        const routeId = routeIdFor(id)
        try {
          const settings = ctx.get('settings')
          if (settings && typeof settings.mutate === 'function') {
            await settings.mutate(SETTINGS_NS, [{ op: 'unset', path: ['providers', routeId] }])
          }
        } catch (e) {
          log('remove provider route failed:', String(e && e.message ? e.message : e))
        }
        try {
          await ctx.credentials.unset(refFor(routeId))
        } catch {}
        send(res, 200, { ok: true })
      })

      // --- 批量导入 keys.txt ---
      registerApi(ctx, disposers, '/keykeeper/api/keys/import', async (req, res) => {
        const vault = requireUnlocked()
        const body = await readJson(req)
        const text = String(body.text || '')
        const aliases = new Map()
        for (const p of PROVIDERS) {
          aliases.set(p.id.toLowerCase(), p.id)
          aliases.set(p.name.toLowerCase(), p.id)
        }
        const extra = {
          kimi: 'moonshot',
          glm: 'zhipu',
          qwen: 'dashscope',
          aliyun: 'dashscope',
          doubao: 'volcengine',
          volc: 'volcengine',
          tencent: 'hunyuan',
          gpt: 'openai',
          claude: 'anthropic',
          google: 'gemini',
          grok: 'xai',
          sf: 'siliconflow',
          silicon: 'siliconflow',
          mini: 'minimax',
          step: 'stepfun',
        }
        for (const [k, v] of Object.entries(extra)) if (!aliases.has(k)) aliases.set(k, v)
        const imported = []
        const skipped = []
        for (const raw of text.split(/\r?\n/)) {
          const line = raw.trim()
          if (!line || line.startsWith('#')) continue
          const eq = line.indexOf('=')
          if (eq < 0) {
            skipped.push({ line, reason: '缺少 =' })
            continue
          }
          const alias = line.slice(0, eq).trim().toLowerCase()
          const key = line.slice(eq + 1).trim()
          const id = aliases.get(alias)
          if (!id) {
            skipped.push({ line: alias, reason: '未知平台' })
            continue
          }
          const target = PROVIDER_MAP.get(id)
          if (!target || target.kind === 'subscription') {
            skipped.push({ line: alias, reason: '订阅类不支持保存 Key' })
            continue
          }
          if (!key) {
            skipped.push({ line: alias, reason: 'Key 为空' })
            continue
          }
          vault.providers[id] = { key, addedAt: nowIso() }
          imported.push(id)
        }
        saveVault(vault)
        const credentials = await syncCredentials(ctx, vault)
        const reconciled = await reconcileRoutes(ctx, vault)
        send(res, 200, { ok: true, imported, skipped, credentials, reconciled })
      })

      // --- 写入 DSH 模型配置 ---
      registerApi(ctx, disposers, '/keykeeper/api/apply', async (req, res) => {
        const vault = requireUnlocked()
        const settings = ctx.get('settings')
        const cfg = {}
        const applied = []
        const failed = []
        for (const [id, entry] of Object.entries(vault.providers || {})) {
          const provider = PROVIDER_MAP.get(id)
          if (!provider || provider.kind === 'subscription' || !entry.key) continue
          const routeId = routeIdFor(id)
          const ref = refFor(routeId)
          const models = normalizeModels(entry.models) || normalizeModels(provider.models)
          if (!models) {
            failed.push({ id, error: '没有模型配置' })
            continue
          }
          try {
            await ctx.credentials.set(ref, entry.key)
            cfg[routeId] = {
              displayName: provider.name,
              api: entry.api || provider.api,
              baseURL: entry.baseURL || provider.baseURL,
              apiKeyEnv: ref,
              models,
            }
            applied.push(routeId)
          } catch (e) {
            failed.push({ id, error: String((e && e.message) || e) })
          }
        }
        let yaml = null
        if (!settings || typeof settings.update !== 'function') {
          yaml = yamlSnippet(cfg)
          send(res, 200, {
            ok: false,
            applied: [],
            failed: [{ id: '*', error: '当前 DSH 没有暴露 settings 服务' }],
            yaml,
            hint: '把下面的片段粘贴到 DSH 的 settings.yaml（或设置 → 模型 → 自定义模型 API）中。',
          })
          return
        }
        try {
          await settings.update(SETTINGS_NS, { providers: cfg })
          for (const routeId of applied) {
            const id = routeId.startsWith('kk-') ? routeId.slice(3) : routeId
            const entry = vault.providers[id]
            if (entry) entry.routeId = routeId
          }
          saveVault(vault)
          send(res, 200, { ok: true, applied, failed })
        } catch (e) {
          yaml = yamlSnippet(cfg)
          send(res, 200, {
            ok: false,
            applied: [],
            failed: [{ id: '*', error: String((e && e.message) || e) }],
            yaml,
            hint: 'DSH 拒绝了热写入，可把下面的片段手动加入 settings.yaml。',
          })
        }
      })

      // --- 检测模型（listOnly 只列候选，不写配置） ---
      registerApi(ctx, disposers, '/keykeeper/api/provider/detect', async (req, res) => {
        const vault = requireUnlocked()
        const body = await readJson(req)
        const id = String(body.providerId || body.id || '').trim()
        const provider = PROVIDER_MAP.get(id)
        const entry = vault.providers && vault.providers[id]
        if (!provider || !entry || !entry.key) {
          send(res, 400, { error: '该平台还没有保存 Key' })
          return
        }
        let ids
        try {
          ids = await listProviderModels(provider, entry)
        } catch (e) {
          send(res, 200, { ok: false, status: (e && e.status) || 0, error: String((e && e.message) || e) })
          return
        }
        const chatIds = ids.filter((x) => !MODEL_EXCLUDE.test(x))
        if (body.listOnly) {
          send(res, 200, { ok: true, count: ids.length, chatCount: chatIds.length, models: chatIds, current: entry.models || [] })
          return
        }
        let chosen = Array.isArray(body.models) && body.models.length ? body.models.map(String) : pickModels(ids)
        chosen = chosen.filter((x) => !MODEL_EXCLUDE.test(x)).slice(0, 40)
        if (!chosen.length) {
          send(res, 200, { ok: false, error: '没有挑出可用的对话模型，请到平台网站确认模型 id' })
          return
        }
        entry.models = chosen
        saveVault(vault)
        try {
          const result = await applyProvider(ctx, vault, id)
          saveVault(vault)
          send(res, 200, { ok: true, count: ids.length, chosen, applied: result.routeId, routeId: result.routeId, models: result.models })
        } catch (e) {
          send(res, 200, { ok: true, count: ids.length, chosen, applied: false, applyError: String((e && e.message) || e) })
        }
      })

      // --- 测试对话 ---
      registerApi(ctx, disposers, '/keykeeper/api/provider/test', async (req, res) => {
        const vault = requireUnlocked()
        const body = await readJson(req)
        const id = String(body.providerId || body.id || '').trim()
        const provider = PROVIDER_MAP.get(id)
        const entry = vault.providers && vault.providers[id]
        if (!provider || !entry || !entry.key) {
          send(res, 400, { error: '该平台还没有保存 Key' })
          return
        }
        const models = normalizeModels(entry.models) || normalizeModels(provider.models)
        const model = String(body.model || (models && models[0] && models[0].id) || '')
        if (!model) {
          send(res, 400, { error: '还没有可用模型，请先「选择模型」或「检测并配置」' })
          return
        }
        try {
          const out = await testProviderChat(provider, entry, model)
          send(res, 200, { ok: true, model, ms: out.ms, reply: out.reply })
        } catch (e) {
          send(res, 200, { ok: false, status: (e && e.status) || 0, error: String((e && e.message) || e) })
        }
      })

      // --- 设为默认模型 ---
      registerApi(ctx, disposers, '/keykeeper/api/provider/set-default', async (req, res) => {
        const vault = requireUnlocked()
        const body = await readJson(req)
        const id = String(body.providerId || body.id || '').trim()
        const provider = PROVIDER_MAP.get(id)
        const entry = vault.providers && vault.providers[id]
        if (!provider || !entry || !entry.key) {
          send(res, 400, { error: '该平台还没有保存 Key' })
          return
        }
        const settings = ctx.get('settings')
        if (!settings || typeof settings.update !== 'function') {
          send(res, 200, { ok: false, needsManual: true, hint: '当前 DSH 没有暴露 settings 服务，请在设置 → 模型里手动选择默认模型' })
          return
        }
        const routeId = entry.routeId || routeIdFor(id)
        const models = normalizeModels(entry.models) || normalizeModels(provider.models)
        const model = String(body.model || (models && models[0] && models[0].id) || '')
        if (!model) {
          send(res, 400, { error: '没有可用模型' })
          return
        }
        try {
          await settings.update('agent-default-model', { provider: routeId, model })
          send(res, 200, { ok: true, provider: routeId, model })
        } catch (e) {
          send(res, 200, { ok: false, needsManual: true, error: String((e && e.message) || e), hint: '可在 设置 → 模型 → 默认模型 里手动选择' })
        }
      })

      // --- 余额（缓存） ---
      registerApi(ctx, disposers, '/keykeeper/api/balance', async (req, res) => {
        requireUnlocked()
        const cache = loadCache()
        send(res, 200, cache)
      })

      // --- 刷新余额 ---
      registerApi(ctx, disposers, '/keykeeper/api/balance/refresh', async (req, res) => {
        const vault = requireUnlocked()
        const cache = await refreshAllBalances(vault)
        send(res, 200, cache)
      })

      // --- 设置（充值覆盖链接、自定义余额接口） ---
      registerApi(ctx, disposers, '/keykeeper/api/settings', async (req, res) => {
        const vault = requireUnlocked()
        if ((req.method || 'GET').toUpperCase() === 'GET') {
          send(res, 200, {
            ui: vault.ui || {},
            customBalances: vault.customBalances || [],
          })
          return
        }
        const body = await readJson(req)
        vault.ui = vault.ui || {}
        if (body.rechargeOverrides && typeof body.rechargeOverrides === 'object') {
          vault.ui.rechargeOverrides = body.rechargeOverrides
        }
        if (typeof body.passwordHint === 'string') vault.ui.passwordHint = body.passwordHint
        saveVault(vault)
        send(res, 200, { ok: true })
      })

      // --- 自定义余额接口 ---
      registerApi(ctx, disposers, '/keykeeper/api/custom-balance/set', async (req, res) => {
        const vault = requireUnlocked()
        const body = await readJson(req)
        const url = String(body.url || '').trim()
        let parsed
        try {
          parsed = new URL(url)
        } catch {
          send(res, 400, { error: '接口 URL 不是合法地址' })
          return
        }
        const localHttp = parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname)
        if (parsed.protocol !== 'https:' && !localHttp) {
          send(res, 400, { error: '自定义余额接口必须是 https（本机 localhost 可用 http）' })
          return
        }
        const adapter = {
          id: String(body.id || '').trim() || `custom-${Date.now()}`,
          name: String(body.name || '').trim() || '自定义接口',
          url,
          headerName: String(body.headerName || 'authorization').trim() || 'authorization',
          // 保留前缀末尾空格（"Bearer " 不能变成 "Bearer"），空串表示不加前缀
          headerPrefix: body.headerPrefix == null ? 'Bearer ' : String(body.headerPrefix),
          jsonPath: String(body.jsonPath || '').trim(),
          currency: String(body.currency || 'CNY').trim() || 'CNY',
          key: String(body.key || '').trim(),
          note: body.note ? String(body.note) : null,
        }
        vault.customBalances = (vault.customBalances || []).filter((a) => a.id !== adapter.id)
        vault.customBalances.push(adapter)
        saveVault(vault)
        const { key: _hidden, ...publicAdapter } = adapter
        send(res, 200, { ok: true, adapter: publicAdapter, hasKey: Boolean(adapter.key) })
      })

      registerApi(ctx, disposers, '/keykeeper/api/custom-balance/remove', async (req, res) => {
        const vault = requireUnlocked()
        const body = await readJson(req)
        vault.customBalances = (vault.customBalances || []).filter((a) => a.id !== String(body.id))
        saveVault(vault)
        send(res, 200, { ok: true })
      })

      // --- 订阅元数据（套餐/额度/续费日，仅本地记录 + 官方入口） ---
      registerApi(ctx, disposers, '/keykeeper/api/subscriptions/set', async (req, res) => {
        const vault = requireUnlocked()
        const body = await readJson(req)
        const id = String(body.providerId || '').trim()
        const provider = PROVIDER_MAP.get(id)
        if (!provider || provider.kind !== 'subscription') {
          send(res, 400, { error: '不是可记录的订阅平台' })
          return
        }
        const clean = (v) => (v == null ? '' : String(v).trim())
        const entry = {
          plan: clean(body.plan).slice(0, 80),
          quota: clean(body.quota).slice(0, 80),
          renewAt: clean(body.renewAt).slice(0, 40),
          note: clean(body.note).slice(0, 200),
          updatedAt: nowIso(),
        }
        vault.subscriptions = vault.subscriptions || {}
        if (!entry.plan && !entry.quota && !entry.renewAt && !entry.note) {
          delete vault.subscriptions[id]
        } else {
          vault.subscriptions[id] = entry
        }
        saveVault(vault)
        send(res, 200, { ok: true, subscriptions: vault.subscriptions })
      })

      // --- 导出明文备份 ---
      registerApi(ctx, disposers, '/keykeeper/api/export', async (req, res) => {
        const body = await readJson(req)
        try {
          const container = loadContainer()
          const { vault } = openVaultWithPassword(container, String(body.password || ''))
          const plain = {
            format: 'dsh-keykeeper-plain',
            exportedAt: nowIso(),
            providers: vault.providers || {},
            customBalances: vault.customBalances || [],
            subscriptions: vault.subscriptions || {},
            ui: vault.ui || {},
          }
          send(res, 200, {
            ok: true,
            filename: `keykeeper-backup-${new Date().toISOString().slice(0, 10)}.json`,
            content: JSON.stringify(plain, null, 2),
          })
        } catch {
          send(res, 401, { error: '密码不正确' })
        }
      })

      // --- 导入备份 ---
      registerApi(ctx, disposers, '/keykeeper/api/import', async (req, res) => {
        const body = await readJson(req)
        const password = String(body.password || '')
        if (password.length < 6) {
          send(res, 400, { error: '密码至少 6 位' })
          return
        }
        let plain
        try {
          plain = JSON.parse(String(body.data || ''))
        } catch {
          send(res, 400, { error: '备份内容不是合法 JSON' })
          return
        }
        if (!plain || typeof plain !== 'object' || !plain.providers || typeof plain.providers !== 'object') {
          send(res, 400, { error: '备份格式不识别（缺少 providers）' })
          return
        }
        if (plain.format && plain.format !== 'dsh-keykeeper-plain') {
          send(res, 400, { error: `不支持的备份格式：${String(plain.format)}` })
          return
        }
        if (typeof plain.providers !== 'object' || Array.isArray(plain.providers)) {
          send(res, 400, { error: '备份里的 providers 必须是对象' })
          return
        }
        // 覆盖前先留一份旧库，避免误导入后再也回不去
        try {
          if (vaultExists()) {
            fs.copyFileSync(VAULT_PATH, `${VAULT_PATH}.bak-${Date.now()}`)
          }
        } catch (e) {
          log('vault backup failed:', String(e && e.message ? e.message : e))
        }
        const vault = {
          v: 1,
          createdAt: nowIso(),
          providers: plain.providers,
          customBalances: Array.isArray(plain.customBalances) ? plain.customBalances : [],
          subscriptions: plain.subscriptions && typeof plain.subscriptions === 'object' && !Array.isArray(plain.subscriptions) ? plain.subscriptions : {},
          ui: plain.ui && typeof plain.ui === 'object' ? plain.ui : { rechargeOverrides: {} },
        }
        const salt = crypto.randomBytes(16)
        const key = deriveKey(password, salt)
        writeAtomicSync(VAULT_PATH, JSON.stringify(sealVaultWithKey(vault, key, salt, TARGET_KDF)))
        session.key = key
        session.salt = salt
        session.kdfParams = TARGET_KDF
        session.vault = vault
        touchSession()
        const credentials = await syncCredentials(ctx, vault)
        const reconciled = await reconcileRoutes(ctx, vault)
        send(res, 200, {
          ok: true,
          credentials,
          reconciled,
          status: buildStatus(ctx, vault, await appliedRouteIds(ctx)),
        })
      })
    })
  },
}

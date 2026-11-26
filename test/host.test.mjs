// dsh-keykeeper Host 路由测试：假 ctx/req/res 直接调用，不依赖 DSH 进程。
// 运行：node test/host.test.mjs
import { Readable } from 'node:stream'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-test-'))
process.env.DSH_HOME = tmp
process.env.DSH_KEYKEEPER_VAULT = path.join(tmp, 'vault.json')
const { default: plugin } = await import(new URL('../index.js', import.meta.url).href)

const routes = new Map()
let settingsValue = { providers: {} }
let defaultModel = null
const settings = {
  async describe() {
    return [{ ns: 'llm-pi-ai', value: JSON.parse(JSON.stringify(settingsValue)), revision: 1 }]
  },
  async update(ns, patch) {
    if (ns === 'llm-pi-ai') {
      settingsValue = { ...settingsValue, ...patch }
      return
    }
    if (ns === 'agent-default-model') {
      defaultModel = { ...(defaultModel || {}), ...patch }
      return
    }
    throw new Error('bad ns')
  },
  async mutate(ns, ops) {
    for (const op of ops) {
      if (op.op === 'unset' && op.path[0] === 'providers') delete settingsValue.providers[op.path[1]]
    }
  },
}
const createdCreds = new Map()
const removedCreds = []
const ctx = {
  get(name) {
    if (name === 'settings') return settings
    if (name === 'connection') return { requestRejection: () => false }
    return undefined
  },
  credentials: {
    async set(ref, value) {
      createdCreds.set(ref, value)
    },
    async unset(ref) {
      removedCreds.push(ref)
    },
  },
  webServer: {
    register({ path: pathName, handler }) {
      routes.set(pathName, handler)
      return () => routes.delete(pathName)
    },
  },
  effect(fn) {
    fn()
  },
}
const root = { inject(_deps, cb) { cb(ctx) } }
plugin.apply(root)

function req(method, body, headers = {}) {
  const text = body === undefined ? '' : JSON.stringify(body)
  const stream = Readable.from(text ? [Buffer.from(text)] : [])
  stream.method = method
  stream.headers = { host: '127.0.0.1:65193', 'x-keykeeper': '1', ...headers }
  return stream
}

async function call(pathName, method, body, headers) {
  const handler = routes.get(pathName)
  if (!handler) throw new Error('no route ' + pathName)
  const out = { code: 0, body: '' }
  const res = {
    writeHead(code) {
      out.code = code
    },
    end(text) {
      if (text) out.body += String(text)
    },
    setHeader() {},
  }
  await handler(req(method, body, headers), res)
  return { code: out.code, json: () => JSON.parse(out.body) }
}

const checks = []
function check(name, cond, extra) {
  checks.push({ name, ok: Boolean(cond), extra })
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (cond ? '' : ' :: ' + JSON.stringify(extra)))
}

let r = await call('/keykeeper/api/status', 'GET')
check('status locked/no vault', r.code === 200 && r.json().hasVault === false && r.json().locked === true, r)

r = await call('/keykeeper/api/vault/init', 'POST', { password: 'test123' })
check('init', r.code === 200 && r.json().ok === true, r)

r = await call('/keykeeper/api/keys/set', 'POST', { providerId: 'deepseek', key: 'sk-test-1234' })
check('keys/set', r.code === 200 && r.json().credentialUpdated === false, r)

r = await call('/keykeeper/api/keys/import', 'POST', {
  text: '# comment\nmoonshot=sk-moon-5678\nkimi=sk-should-skip\nchatgpt=sk-sub\nunknown=sk-x',
})
check('keys/import imports 2', r.code === 200 && r.json().imported.length === 2, r)
check(
  'keys/import skips subscription',
  r.json().skipped.some((s) => String(s.line).includes('chatgpt')),
  r.json().skipped,
)

r = await call('/keykeeper/api/apply', 'POST', {})
check('apply writes route', r.code === 200 && r.json().ok === true && r.json().applied.includes('kk-deepseek'), r)
check('apply sets apiKeyEnv', Boolean(settingsValue.providers['kk-deepseek'] && settingsValue.providers['kk-deepseek'].apiKeyEnv), settingsValue.providers)
check('apply sets models', (settingsValue.providers['kk-deepseek'].models || []).length > 0, settingsValue.providers['kk-deepseek'])
check('credential set', createdCreds.get('KEYKEEPER_KK_DEEPSEEK_API_KEY') === 'sk-test-1234', [...createdCreds.keys()])
r = await call('/keykeeper/api/selfcheck', 'GET')
check('selfcheck ok', r.code === 200 && r.json().ok === true, r.json())
check('selfcheck sees pi-ai entry', r.json().checks.some((c) => c.name === 'llm-pi-ai 配置入口' && c.ok), r.json().checks)

// 换 key：已写入路由时应立刻同步凭据
r = await call('/keykeeper/api/keys/set', 'POST', { providerId: 'deepseek', key: 'sk-test-9999' })
check('keys/set pushes new credential', r.code === 200 && r.json().credentialUpdated === true, r)
check('credential updated', createdCreds.get('KEYKEEPER_KK_DEEPSEEK_API_KEY') === 'sk-test-9999', createdCreds.get('KEYKEEPER_KK_DEEPSEEK_API_KEY'))

r = await call('/keykeeper/api/status', 'GET')
check(
  'status has 2 providers keyed',
  r.code === 200 && r.json().providers.filter((p) => p.keyConfigured).length === 2 && r.json().ui !== null,
  r.json().providers.filter((p) => p.keyConfigured).map((p) => p.id),
)

r = await call('/keykeeper/api/custom-balance/set', 'POST', {
  name: '我的中转',
  url: 'https://relay.example.com/api/balance',
  headerPrefix: 'Bearer ',
  jsonPath: 'data.balance',
  key: 'sk-relay',
})
check('custom adapter keeps Bearer prefix', r.code === 200 && r.json().adapter.headerPrefix === 'Bearer ' && r.json().hasKey === true, r)

r = await call('/keykeeper/api/custom-balance/set', 'POST', { url: 'http://relay.example.com/balance' })
check('custom adapter rejects plain http', r.code === 400, r)

r = await call('/keykeeper/api/vault/lock', 'POST', {})
check('lock', r.code === 200, r)
r = await call('/keykeeper/api/status', 'GET')
check(
  'locked status keeps read-only balances but hides keys/ui',
  r.json().locked === true &&
    typeof r.json().balances === 'object' &&
    r.json().ui === null &&
    r.json().appliedRouteIds === null &&
    r.json().providers.every((p) => !p.keyConfigured && p.keyHint === null),
  r.json(),
)
r = await call('/keykeeper/api/balance', 'GET')
check('locked balance endpoint 401', r.code === 401, r)

r = await call('/keykeeper/api/vault/unlock', 'POST', { password: 'wrong' })
check('wrong password rejected', r.code === 401, r)
r = await call('/keykeeper/api/vault/unlock', 'POST', { password: 'test123' })
check('unlock ok', r.code === 200 && r.json().ok === true, r)
check('default auto-lock 15', r.json().status.autoLockMinutes === 15, r.json().status.autoLockMinutes)

r = await call('/keykeeper/api/vault/auto-lock', 'POST', { minutes: 0 })
check('auto-lock can be disabled', r.code === 200 && r.json().autoLockMinutes === 0, r)
r = await call('/keykeeper/api/status', 'GET')
check('status shows auto-lock 0', r.json().autoLockMinutes === 0, r.json().autoLockMinutes)
r = await call('/keykeeper/api/vault/auto-lock', 'POST', { minutes: 60 })
check('auto-lock set 60', r.code === 200 && r.json().autoLockMinutes === 60, r)
r = await call('/keykeeper/api/vault/auto-lock', 'POST', { minutes: -1 })
check('auto-lock rejects negative', r.code === 400, r)
r = await call('/keykeeper/api/vault/auto-lock', 'POST', { minutes: 9999 })
check('auto-lock rejects >1440', r.code === 400, r)

r = await call('/keykeeper/api/export', 'POST', { password: 'test123' })
check('export contains keys', r.code === 200 && r.json().content.includes('sk-test-9999'), r)

r = await call('/keykeeper/api/vault/password', 'POST', { oldPassword: 'wrong', newPassword: 'newpass123' })
check('password change wrong old 401 chinese', r.code === 401 && String(r.json().error).includes('旧密码'), r)
r = await call('/keykeeper/api/vault/password', 'POST', { oldPassword: 'test123', newPassword: 'newpass123' })
check('password change ok', r.code === 200, r)
r = await call('/keykeeper/api/vault/lock', 'POST', {})
await call('/keykeeper/api/vault/unlock', 'POST', { password: 'test123' })
r = await call('/keykeeper/api/vault/unlock', 'POST', { password: 'newpass123' })
check('unlock with new password', r.code === 200, r)

// 导入备份：格式校验、旧库备份、清掉过期路由
r = await call('/keykeeper/api/import', 'POST', { password: 'newpass123', data: '{"format":"weird","providers":{}}' })
check('import rejects unknown format', r.code === 400, r)
r = await call('/keykeeper/api/import', 'POST', { password: 'newpass123', data: '{"hello":1}' })
check('import rejects missing providers', r.code === 400, r)

settingsValue.providers['kk-stale'] = { displayName: 'stale' }
r = await call('/keykeeper/api/import', 'POST', {
  password: 'newpass123',
  data: JSON.stringify({ format: 'dsh-keykeeper-plain', providers: { moonshot: { key: 'sk-moon-2' } } }),
})
check('import ok', r.code === 200 && r.json().ok === true, r)
check('import removed stale route', !settingsValue.providers['kk-stale'] && removedCreds.includes('KEYKEEPER_KK_STALE_API_KEY'), {
  providers: Object.keys(settingsValue.providers),
  removedCreds,
})
check(
  'import backs up old vault',
  fs.readdirSync(tmp).some((f) => f.startsWith('vault.json.bak-')),
  fs.readdirSync(tmp),
)

r = await call('/keykeeper/api/vault/unlock', 'POST', { password: 'newpass123' })
r = await call('/keykeeper/api/subscriptions/set', 'POST', {
  providerId: 'chatgpt',
  plan: 'Plus',
  quota: '每周 50 次',
  renewAt: '2026-01-20',
})
check('subscription meta saved', r.code === 200 && r.json().subscriptions.chatgpt.plan === 'Plus', r)
r = await call('/keykeeper/api/subscriptions/set', 'POST', { providerId: 'deepseek', plan: 'x' })
check('subscription meta rejects api provider', r.code === 400, r)
r = await call('/keykeeper/api/status', 'GET')
check('status exposes subscriptions', r.json().subscriptions.chatgpt.quota === '每周 50 次', r.json().subscriptions)
r = await call('/keykeeper/api/keys/remove', 'POST', { providerId: 'moonshot' })
check('remove route + credential', r.code === 200 && removedCreds.includes('KEYKEEPER_KK_MOONSHOT_API_KEY'), { removedCreds })

// 模型探测：GET /models → 过滤非对话模型 → 自动挑模型 → 写入 kk-siliconflow
{
  const realFetch = globalThis.fetch
  await call('/keykeeper/api/keys/set', 'POST', { providerId: 'siliconflow', key: 'sk-sf-test' })
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        data: [
          { id: 'Qwen/Qwen3-235B-A22B-Instruct-2507' },
          { id: 'deepseek-ai/DeepSeek-V3.2' },
          { id: 'BAAI/bge-m3' },
          { id: 'Kwai-Kolors/Kolors' },
        ],
      })
    },
  })
  r = await call('/keykeeper/api/provider/detect', 'POST', { providerId: 'siliconflow' })
  const body = r.json()
  check('detect ok', r.code === 200 && body.ok === true && body.count === 4, body)
  check(
    'detect picks chat models',
    body.chosen.includes('deepseek-ai/DeepSeek-V3.2') && !body.chosen.some((id) => /bge|kolors/i.test(id)),
    body.chosen,
  )
  check(
    'detect writes route',
    body.applied === 'kk-siliconflow' && Boolean(settingsValue.providers['kk-siliconflow']),
    settingsValue.providers,
  )
  check(
    'detect stores real model ids',
    (settingsValue.providers['kk-siliconflow'].models || []).some((m) => m.id === 'deepseek-ai/DeepSeek-V3.2'),
    settingsValue.providers['kk-siliconflow'],
  )

  const beforeModels = JSON.stringify(settingsValue.providers['kk-siliconflow'].models || [])
  r = await call('/keykeeper/api/provider/detect', 'POST', { providerId: 'siliconflow', listOnly: true })
  const lo = r.json()
  check(
    'detect listOnly returns chat models without writing',
    r.code === 200 &&
      lo.ok === true &&
      lo.chatCount === 2 &&
      lo.models.includes('deepseek-ai/DeepSeek-V3.2') &&
      lo.models.every((id) => !/bge|kolors/i.test(id)) &&
      JSON.stringify(settingsValue.providers['kk-siliconflow'].models) === beforeModels,
    { lo, models: settingsValue.providers['kk-siliconflow'].models },
  )

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({ choices: [{ message: { content: 'pong' } }] })
    },
  })
  r = await call('/keykeeper/api/provider/test', 'POST', { providerId: 'siliconflow' })
  check('test chat ok', r.code === 200 && r.json().ok === true && r.json().model === 'deepseek-ai/DeepSeek-V3.2', r.json())

  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    async text() {
      return JSON.stringify({ message: 'Token is invalid.' })
    },
  })
  r = await call('/keykeeper/api/provider/test', 'POST', { providerId: 'siliconflow' })
  check(
    'test chat reports 401',
    r.code === 200 && r.json().ok === false && r.json().status === 401 && /401/.test(r.json().error),
    r.json(),
  )

  r = await call('/keykeeper/api/provider/set-default', 'POST', { providerId: 'siliconflow' })
  check(
    'set default writes agent-default-model',
    r.code === 200 && r.json().ok === true && defaultModel && defaultModel.provider === 'kk-siliconflow',
    { body: r.json(), defaultModel },
  )
  globalThis.fetch = realFetch
}

// KDF 迁移：手工写一个 N=16384 的旧库，解锁时自动升级到 N=65536
{
  await call('/keykeeper/api/vault/lock', 'POST', {})
  const legacyPassword = 'legacypass123'
  const legacySalt = crypto.randomBytes(16)
  const legacyKey = crypto.scryptSync(legacyPassword, legacySalt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', legacyKey, iv)
  const plaintext = JSON.stringify({
    v: 1,
    createdAt: new Date().toISOString(),
    providers: { deepseek: { key: 'sk-legacy', addedAt: new Date().toISOString() } },
    customBalances: [],
    subscriptions: {},
    ui: { rechargeOverrides: {} },
  })
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  fs.writeFileSync(
    process.env.DSH_KEYKEEPER_VAULT,
    JSON.stringify({
      v: 1,
      kdf: { salt: legacySalt.toString('base64'), N: 16384, r: 8, p: 1 },
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    }),
  )
  r = await call('/keykeeper/api/vault/unlock', 'POST', { password: legacyPassword })
  const migratedContainer = JSON.parse(fs.readFileSync(process.env.DSH_KEYKEEPER_VAULT, 'utf8'))
  check(
    'legacy vault migrates to N=65536',
    r.code === 200 && r.json().migrated === true && migratedContainer.kdf.N === 65536,
    { code: r.code, migrated: r.json().migrated, kdf: migratedContainer.kdf },
  )
  check('migration keeps providers', r.json().status.providers.some((p) => p.id === 'deepseek' && p.keyHint), r.json().status.providers)
  r = await call('/keykeeper/api/vault/lock', 'POST', {})
}

r = await call('/keykeeper/api/status', 'GET', undefined, { host: 'evil.example.com:80' })
check('non-loopback host rejected', r.code === 403, r)

r = await call('/keykeeper/api/vault/lock', 'POST', {}, { 'x-keykeeper': '' })
check('post without header rejected', r.code === 403, r)

const bad = checks.filter((c) => !c.ok)
console.log('\n' + (bad.length ? `${bad.length} FAILED` : 'ALL PASS') + ` (${checks.length} checks)`)
fs.rmSync(tmp, { recursive: true, force: true })
if (bad.length) process.exitCode = 1

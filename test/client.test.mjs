// dsh-keykeeper Client 加载测试：stub 模块加载器与 React，验证注册的 slot 与组件。
// 运行：node test/client.test.mjs
import fs from 'node:fs'

const results = []
function check(name, cond, extra) {
  results.push({ name, ok: Boolean(cond) })
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (cond ? '' : ' :: ' + JSON.stringify(extra)))
}

let loaded = null
const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  Fragment: { type: 'fragment' },
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useEffect: () => {},
  useMemo: (f) => f(),
  useCallback: (f) => f,
  useRef: (v) => ({ current: v }),
}
const requireStub = (name) => {
  if (name === 'react') return React
  if (name === 'react/jsx-runtime') return { jsx: () => ({}), jsxs: () => ({}), Fragment: React.Fragment }
  throw new Error('unexpected require: ' + name)
}

const headChildren = []
globalThis.window = {
  __ModuleLoader__: {
    load(spec) { loaded = spec },
  },
}
globalThis.document = {
  head: {
    appendChild(el) { headChildren.push(el) },
  },
  body: { appendChild() {} },
  createElement: () => ({ setAttribute() {}, appendChild() {}, style: {}, remove() {} }),
  getElementById: () => null,
  querySelector: () => null,
}

await import(new URL('../client.js', import.meta.url).href)

check('module registered', loaded && loaded.id === 'dsh-keykeeper' && typeof loaded.factory === 'function', loaded && loaded.id)
const mod = loaded.factory(requireStub)
check('exports apply', mod && typeof mod.apply === 'function', Object.keys(mod || {}))
check('declares slots inject', Array.isArray(mod.inject) && mod.inject.includes('slots'), mod.inject)

const registered = []
const injectedOwners = []
let styleDisposer = null
const ctx = {
  effect(fn) {
    const dispose = fn()
    if (typeof dispose === 'function') styleDisposer = dispose
  },
  slots: {
    inject(owner, cb) { injectedOwners.push(owner); cb() },
    register(spec, comp) { registered.push({ spec, comp }); return () => {} },
  },
}
mod.apply(ctx)

const names = registered.map((r) => r.spec.name + '#' + r.spec.id)
check('registers footer slot', names.includes('settings.models.footer#keykeeper-footer'), names)
check('registers dock slot', names.includes('conversation.composer.dock#keykeeper-dock'), names)
check('registers settings section', names.includes('settings.section#keykeeper'), names)
check('registers settings section icon', names.includes('settings.section.icon#keykeeper'), names)
const section = registered.find((r) => r.spec.name === 'settings.section')
check('section carries label/order', section && section.spec.label === '钥匙管家' && section.spec.order === 200, section && section.spec)
check('all components are functions', registered.every((r) => typeof r.comp === 'function'), registered.map((r) => typeof r.comp))
check('installs style once', headChildren.length === 1, headChildren.length)
check('style exposes disposer', typeof styleDisposer === 'function', typeof styleDisposer)

// 组件可渲染（stub hooks 为无状态）
const footer = registered.find((r) => r.spec.id === 'keykeeper-footer').comp
let rendered = null
try {
  rendered = footer()
} catch (e) {
  rendered = { error: String(e) }
}
check('footer renders', rendered && !rendered.error && rendered.type, rendered && rendered.error)

// 某些 DSH 外壳可能不认识 settings.section：注册失败不应连累其他入口
const registered2 = []
const ctx2 = {
  effect() {},
  slots: {
    inject(owner, cb) {
      if (owner === 'settings.section' || owner === 'settings.section.icon') throw new Error('unsupported slot')
      cb()
    },
    register(spec) {
      registered2.push(spec.name)
      return () => {}
    },
  },
}
const origWarn = console.warn
console.warn = () => {}
let applyThrew = null
try {
  mod.apply(ctx2)
} catch (e) {
  applyThrew = String(e)
} finally {
  console.warn = origWarn
}
check('apply survives unsupported section slot', !applyThrew, applyThrew)
check(
  'footer/dock still register when section unsupported',
  registered2.includes('settings.models.footer') && registered2.includes('conversation.composer.dock'),
  registered2,
)

const failed = results.filter((r) => !r.ok).length
console.log('\n' + (failed ? failed + ' FAILED' : 'ALL PASS') + ' (' + results.length + ' checks)')
process.exit(failed ? 1 : 0)

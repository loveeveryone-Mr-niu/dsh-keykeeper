window.__ModuleLoader__.load({
  id: 'dsh-keykeeper',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useMemo, useRef } = React
    // composer.dock 位于 position:fixed 容器内，overlay 必须 portal 到 body 才不会被裁剪
    let createPortal = null
    try {
      const reactDom = require('react-dom')
      if (reactDom && typeof reactDom.createPortal === 'function') createPortal = reactDom.createPortal
    } catch {
      /* react-dom 未暴露时退回内联渲染 */
    }

    const API = '/keykeeper/api'
    const STYLE_ID = 'dsh-keykeeper-style'

    const CSS = `
.kk-root { font-size: 13px; line-height: 1.5; }
.kk-card { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; border: 0.5px solid var(--dsw-alias-border-l2, #3a3a3a); border-radius: 10px; background: var(--dsw-alias-bg-layer-1, #1e1e1e); color: var(--dsw-alias-label-primary, #eee); }
.kk-card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.kk-title { font-weight: 600; }
.kk-muted { opacity: 0.6; font-size: 12px; }
.kk-warn { color: #f59e0b; font-size: 12px; }
.kk-ok { color: #22c55e; font-size: 12px; }
.kk-err { color: #ef4444; font-size: 12px; }
.kk-btn { cursor: pointer; border: 0.5px solid var(--dsw-alias-border-l2, #4a4a4a); border-radius: 8px; padding: 4px 10px; background: transparent; color: inherit; font-size: 12px; }
.kk-btn:hover { background: rgba(127, 127, 127, 0.12); }
.kk-btn-primary { background: #3b82f6; border-color: #3b82f6; color: #fff; }
.kk-btn-primary:hover { background: #2563eb; }
.kk-btn-danger { color: #ef4444; border-color: rgba(239, 68, 68, 0.5); }
.kk-input { background: var(--dsw-alias-bg-layer-2, #262626); border: 0.5px solid var(--dsw-alias-border-l2, #4a4a4a); border-radius: 8px; padding: 5px 8px; color: inherit; font-size: 12px; min-width: 0; }
.kk-input:focus { outline: 1px solid #3b82f6; }
.kk-overlay { position: fixed; inset: 0; z-index: 60; background: rgba(0, 0, 0, 0.55); display: flex; align-items: center; justify-content: center; }
.kk-modal { width: min(980px, 94vw); max-height: 88vh; display: flex; flex-direction: column; background: var(--dsw-alias-bg-layer-1, #1e1e1e); border: 0.5px solid var(--dsw-alias-border-l2, #3a3a3a); border-radius: 14px; color: var(--dsw-alias-label-primary, #eee); overflow: hidden; }
.kk-modal-head { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 0.5px solid var(--dsw-alias-border-l2, #3a3a3a); }
.kk-modal-head .kk-title { flex: 1; }
.kk-tabs { display: flex; gap: 4px; padding: 8px 16px; border-bottom: 0.5px solid var(--dsw-alias-border-l2, #3a3a3a); }
.kk-tab { padding: 5px 10px; border-radius: 8px; cursor: pointer; font-size: 12px; opacity: 0.7; }
.kk-tab.active { background: rgba(127, 127, 127, 0.16); opacity: 1; }
.kk-body { padding: 14px 16px; overflow: auto; flex: 1; display: flex; flex-direction: column; gap: 10px; }
.kk-sep { border-top: 0.5px solid rgba(127, 127, 127, 0.18); margin: 2px 0; }
.kk-row { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 0.5px solid rgba(127, 127, 127, 0.12); flex-wrap: wrap; }
.kk-row:last-child { border-bottom: none; }
.kk-grow { flex: 1; min-width: 0; }
.kk-pill { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; border: 0.5px solid var(--dsw-alias-border-l2, #4a4a4a); border-radius: 999px; padding: 3px 10px; font-size: 12px; background: var(--dsw-alias-bg-layer-1, #1e1e1e); color: inherit; max-width: min(360px, 80vw); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kk-pill:hover { background: rgba(127, 127, 127, 0.12); }
.kk-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; }
.kk-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.kk-textarea { width: 100%; min-height: 76px; background: var(--dsw-alias-bg-layer-2, #262626); border: 0.5px solid var(--dsw-alias-border-l2, #4a4a4a); border-radius: 8px; padding: 6px 8px; color: inherit; font-size: 12px; font-family: ui-monospace, monospace; resize: vertical; }
.kk-banner { border: 0.5px solid var(--dsw-alias-border-l2, #4a4a4a); border-radius: 10px; padding: 10px 12px; background: rgba(59, 130, 246, 0.08); }
.kk-toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); background: #111; color: #fff; padding: 8px 14px; border-radius: 8px; z-index: 61; font-size: 12px; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4); }
.kk-sub { font-size: 12px; opacity: 0.6; }
.kk-chip { font-size: 11px; padding: 1px 6px; border-radius: 999px; background: rgba(127, 127, 127, 0.16); }
.kk-chip.on { background: rgba(34, 197, 94, 0.18); color: #22c55e; }
.kk-chip.off { background: rgba(239, 68, 68, 0.14); color: #ef4444; }
.kk-scroll { max-height: 46vh; overflow: auto; }
.kk-link { color: #3b82f6; cursor: pointer; text-decoration: none; font-size: 12px; }
.kk-pre { white-space: pre-wrap; word-break: break-all; background: var(--dsw-alias-bg-layer-2, #262626); border-radius: 8px; padding: 8px; font-size: 11px; font-family: ui-monospace, monospace; max-height: 180px; overflow: auto; }
`

    function installStyle() {
      if (typeof document === 'undefined') return () => {}
      const existing = document.getElementById(STYLE_ID)
      const el = existing || document.createElement('style')
      el.id = STYLE_ID
      el.textContent = CSS
      if (!existing) document.head.appendChild(el)
      return () => {
        if (el.parentNode) el.parentNode.removeChild(el)
      }
    }

    async function api(path, body) {
      const method = body === undefined ? 'GET' : 'POST'
      const res = await fetch(API + path, {
        method,
        headers: method === 'POST' ? { 'content-type': 'application/json', 'x-keykeeper': '1' } : {},
        body: method === 'POST' ? JSON.stringify(body) : undefined,
        cache: 'no-store',
      })
      let json = null
      try {
        json = await res.json()
      } catch {
        const err = new Error('HTTP ' + res.status)
        err.status = res.status
        throw err
      }
      if (!res.ok) {
        const err = new Error((json && json.error) || 'HTTP ' + res.status)
        err.status = res.status
        if (res.status === 401) {
          try {
            window.dispatchEvent(new CustomEvent('keykeeper-unauthorized'))
          } catch {
            /* ignore */
          }
        }
        throw err
      }
      return json
    }

    function download(name, text) {
      const blob = new Blob([text], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = name
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1500)
    }

    function openExternal(url) {
      if (!url) return
      try {
        window.open(url, '_blank', 'noopener,noreferrer')
      } catch {
        /* ignore */
      }
    }

    function money(balance) {
      if (!balance || balance.ok === false) return '—'
      const v = Number(balance.amount)
      if (!Number.isFinite(v)) return '—'
      const cur = balance.currency || ''
      return `${cur === 'USD' ? '$' : '¥'}${v.toFixed(2)}`
    }

    function StatusChip({ on, onLabel, offLabel }) {
      return h('span', { className: `kk-chip ${on ? 'on' : 'off'}` }, on ? onLabel || '已保存' : offLabel || '未配置')
    }

    // ------------------------------------------------------------------
    // 创建保险库 / 解锁
    // ------------------------------------------------------------------

    function CreateVault({ onDone, toast }) {
      const [password, setPassword] = useState('')
      const [confirm, setConfirm] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const submit = async () => {
        if (password.length < 6) return setError('密码至少 6 位')
        if (password !== confirm) return setError('两次输入的密码不一致')
        setBusy(true)
        setError('')
        try {
          const res = await api('/vault/init', { password })
          toast('保险库已创建')
          onDone(res.status)
        } catch (e) {
          setError(String(e.message || e))
        } finally {
          setBusy(false)
        }
      }
      return h(
        'div',
        { className: 'kk-body' },
        h('div', { className: 'kk-banner' }, '第一次使用：给本地保险库设一个主密码。所有 API Key 都用它加密保存在本机，换电脑时把 vault.json 拷走即可。'),
        h(
          'div',
          { className: 'kk-field' },
          h('span', null, '主密码'),
          h('input', {
            className: 'kk-input',
            type: 'password',
            autoComplete: 'new-password',
            value: password,
            autoFocus: true,
            onChange: (e) => setPassword(e.target.value),
            placeholder: '至少 6 位',
          }),
        ),
        h(
          'div',
          { className: 'kk-field' },
          h('span', null, '再输一次'),
          h('input', {
            className: 'kk-input',
            type: 'password',
            autoComplete: 'new-password',
            value: confirm,
            onChange: (e) => setConfirm(e.target.value),
            onKeyDown: (e) => {
              if (e.key === 'Enter') submit()
            },
          }),
        ),
        error ? h('div', { className: 'kk-err' }, error) : null,
        h(
          'div',
          { style: { display: 'flex', gap: 8 } },
          h('button', { className: 'kk-btn kk-btn-primary', disabled: busy, onClick: submit }, busy ? '创建中…' : '创建保险库'),
        ),
      )
    }

    function UnlockVault({ onDone, toast, status }) {
      const [password, setPassword] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const submit = async () => {
        setBusy(true)
        setError('')
        try {
          const res = await api('/vault/unlock', { password })
          const minutes = res.status ? res.status.autoLockMinutes : status && status.autoLockMinutes
          toast(minutes ? `已解锁，${minutes} 分钟无操作自动锁定` : '已解锁（不自动锁定）')
          onDone(res.status)
        } catch (e) {
          setError(String(e.message || e))
        } finally {
          setBusy(false)
        }
      }
      return h(
        'div',
        { className: 'kk-body' },
        h('div', { className: 'kk-muted' }, '输入主密码解锁保险库。'),
        h('input', {
          className: 'kk-input',
          type: 'password',
          autoComplete: 'current-password',
          value: password,
          autoFocus: true,
          placeholder: '主密码',
          onChange: (e) => setPassword(e.target.value),
          onKeyDown: (e) => {
            if (e.key === 'Enter') submit()
          },
        }),
        error ? h('div', { className: 'kk-err' }, error) : null,
        h('button', { className: 'kk-btn kk-btn-primary', disabled: busy, onClick: submit }, busy ? '解锁中…' : '解锁'),
      )
    }

    // ------------------------------------------------------------------
    // 锁定时只读视图：余额缓存可见，但不能改 Key / 导出
    // ------------------------------------------------------------------

    function LockedView({ status, onDone, toast }) {
      const rows = Object.entries(status.balances || {})
      const names = new Map((status.providers || []).map((p) => [p.id, p.name]))
      const consoles = new Map((status.providers || []).map((p) => [p.id, p.console]))
      const low = rows.filter(([, b]) => b && b.ok && Number(b.amount) < 5).length
      const label = (id, b) => names.get(id) || (b && b.name) || String(id).replace(/^custom:/, '')
      const view = (b) => {
        if (!b) return h('span', { className: 'kk-muted' }, '—')
        if (b.noApi) return h('span', { className: 'kk-muted' }, '去控制台查看')
        if (b.ok) return h('span', { className: b.amount < 5 ? 'kk-warn' : 'kk-ok' }, money(b))
        return h('span', { className: 'kk-err' }, b.error || '—')
      }
      return h(
        'div',
        { className: 'kk-body' },
        h(UnlockVault, { onDone, toast, status }),
        rows.length ? h('div', { className: 'kk-sep' }) : null,
        h(
          'div',
          { className: 'kk-sub' },
          rows.length
            ? `锁定状态下的只读余额${status.balanceUpdatedAt ? ` · 缓存于 ${new Date(status.balanceUpdatedAt).toLocaleString()}` : ''}${low ? ` · ⚠️ ${low} 家低于 5` : ''}`
            : '还没有缓存的余额；解锁后可刷新。',
        ),
        rows.map(([id, b]) =>
          h(
            'div',
            { className: 'kk-row', key: id },
            h('div', { className: 'kk-grow' }, label(id, b)),
            view(b),
            consoles.get(id) ? h('span', { className: 'kk-link', onClick: () => openExternal(consoles.get(id)) }, '控制台') : null,
          ),
        ),
        h('div', { className: 'kk-muted' }, '解锁后可刷新余额、管理 Key 与充值（刷新余额需要读取 Key，所以仍需解锁）。'),
      )
    }

    // ------------------------------------------------------------------
    // 密钥页
    // ------------------------------------------------------------------

    function KeysTab({ status, refresh, toast }) {
      const groups = useMemo(() => {
        const map = new Map()
        for (const p of status.providers || []) {
          if (p.kind === 'subscription') continue
          if (!map.has(p.group)) map.set(p.group, [])
          map.get(p.group).push(p)
        }
        return Array.from(map.entries())
      }, [status])
      const [drafts, setDrafts] = useState({})
      const [importOpen, setImportOpen] = useState(false)
      const [importText, setImportText] = useState('')
      const [busy, setBusy] = useState(false)
      const [applyResult, setApplyResult] = useState(null)
      const [probe, setProbe] = useState({})
      const [picker, setPicker] = useState(null)

      const save = async (providerId, key) => {
        if (!key || !key.trim()) return toast('Key 不能为空')
        setBusy(true)
        try {
          const res = await api('/keys/set', { providerId, key: key.trim() })
          setDrafts((d) => ({ ...d, [providerId]: '' }))
          toast('已保存，正在检测该平台可用的模型…')
          await refresh()
          setTimeout(() => runProbe(providerId, 'detect'), 0)
        } catch (e) {
          toast(String(e.message || e))
        } finally {
          setBusy(false)
        }
      }

      const remove = async (providerId) => {
        setBusy(true)
        try {
          await api('/keys/remove', { providerId })
          toast('已删除并撤销 DSH 路由')
          await refresh()
        } catch (e) {
          toast(String(e.message || e))
        } finally {
          setBusy(false)
        }
      }

      const doImport = async () => {
        setBusy(true)
        try {
          const res = await api('/keys/import', { text: importText })
          const skipped = res.skipped || []
          if (!res.imported.length) {
            const reason = skipped.length ? `：${skipped[0].line || ''} ${skipped[0].reason || ''}` : ''
            toast('没有导入任何 Key' + reason)
          } else {
            setImportText('')
            setImportOpen(false)
            toast(`已导入 ${res.imported.length} 个，正在检测模型…`)
          }
          await refresh()
          const imported = res.imported || []
          if (imported.length) {
            let done = 0
            for (const id of imported) {
              const r = await detectQuiet(id)
              if (r && r.ok) done++
            }
            await refresh()
            toast(
              `导入 ${imported.length} 个，自动配置成功 ${done} 个${skipped.length ? `，跳过 ${skipped.length} 个` : ''}`,
            )
          }
        } catch (e) {
          toast(String(e.message || e))
        } finally {
          setBusy(false)
        }
      }

      const applyAll = async () => {
        setBusy(true)
        setApplyResult(null)
        try {
          const res = await api('/apply', {})
          setApplyResult(res)
          if (res.ok) toast(`已写入 ${res.applied.length} 个 DSH 模型路由`)
          else toast('写入未完成，请看下方提示')
          await refresh()
        } catch (e) {
          toast(String(e.message || e))
        } finally {
          setBusy(false)
        }
      }

      const runProbe = async (providerId, kind) => {
        setProbe((m) => ({ ...m, [providerId]: { busy: true, kind } }))
        try {
          if (kind === 'detect') {
            const res = await api('/provider/detect', { providerId })
            if (!res.ok) throw new Error(res.error || '检测失败')
            const n = (res.chosen || []).length
            const extra = res.applyError ? `（写入 DSH 失败：${res.applyError}）` : ''
            setProbe((m) => ({
              ...m,
              [providerId]: { ok: true, kind, text: `发现 ${res.count} 个模型，自动选 ${n} 个${extra}` },
            }))
            toast(
              res.applyError
                ? '检测成功，但写入 DSH 失败，请看该平台提示'
                : `检测完成：发现 ${res.count} 个模型，已写入模型选择器`,
            )
            await refresh()
          } else if (kind === 'test') {
            const res = await api('/provider/test', { providerId })
            if (!res.ok) throw new Error(res.error || '测试失败')
            setProbe((m) => ({
              ...m,
              [providerId]: { ok: true, kind, text: `✅ ${res.ms}ms · ${res.model}${res.reply ? ' · ' + res.reply : ''}` },
            }))
            toast(`连通正常：${res.model} · ${res.ms}ms`)
          } else {
            const res = await api('/provider/set-default', { providerId })
            if (!res.ok) throw new Error(res.error || '设置失败')
            setProbe((m) => ({ ...m, [providerId]: { ok: true, kind, text: `已设为默认：${res.model}` } }))
            toast(`已设为默认模型：${res.model}`)
          }
        } catch (e) {
          const msg = String(e.message || e)
          setProbe((m) => ({ ...m, [providerId]: { ok: false, kind, text: '❌ ' + msg } }))
          toast(msg)
        }
      }

      const detectQuiet = async (providerId) => {
        try {
          return await api('/provider/detect', { providerId })
        } catch {
          return null
        }
      }

      const openPicker = async (p) => {
        setPicker({ providerId: p.id, name: p.name, loading: true, models: [], current: [], q: '', total: 0 })
        try {
          const res = await api('/provider/detect', { providerId: p.id, listOnly: true })
          if (!res.ok) throw new Error(res.error || '获取模型列表失败')
          setPicker({
            providerId: p.id,
            name: p.name,
            loading: false,
            models: res.models || [],
            current: res.current || [],
            q: '',
            total: res.count || 0,
          })
        } catch (e) {
          setPicker(null)
          toast(String(e.message || e))
        }
      }

      const savePicker = async (picked) => {
        if (!picked.length) return toast('至少选一个模型')
        const target = picker
        setPicker(null)
        setProbe((m) => ({ ...m, [target.providerId]: { busy: true, kind: 'detect' } }))
        try {
          const res = await api('/provider/detect', { providerId: target.providerId, models: picked })
          if (!res.ok) throw new Error(res.error || '写入失败')
          const extra = res.applyError ? `（写入 DSH 失败：${res.applyError}）` : ''
          setProbe((m) => ({
            ...m,
            [target.providerId]: { ok: true, kind: 'detect', text: `已写入 ${picked.length} 个自选模型${extra}` },
          }))
          toast(extra ? '模型已保存，但写入 DSH 失败' : `已写入 ${picked.length} 个模型`)
          await refresh()
        } catch (e) {
          const msg = String(e.message || e)
          setProbe((m) => ({ ...m, [target.providerId]: { ok: false, kind: 'detect', text: '❌ ' + msg } }))
          toast(msg)
        }
      }

      let pickerModal = null
      if (picker && createPortal) {
        const q = picker.q.trim().toLowerCase()
        const list = q ? picker.models.filter((id) => id.toLowerCase().includes(q)) : picker.models
        const toggle = (id) => {
          setPicker((p) => {
            if (!p) return p
            const on = p.current.includes(id)
            return { ...p, current: on ? p.current.filter((x) => x !== id) : p.current.concat(id) }
          })
        }
        pickerModal = createPortal(
          h(
            'div',
            { className: 'kk-overlay', onMouseDown: (e) => { if (e.target === e.currentTarget) setPicker(null) } },
            h(
              'div',
              { className: 'kk-modal', style: { width: 'min(640px, 92vw)' }, onMouseDown: (e) => e.stopPropagation() },
              h(
                'div',
                { className: 'kk-modal-head' },
                h('div', { className: 'kk-title' }, `选择「${picker.name}」要写入的模型`),
                h('span', { className: 'kk-sub' }, `${picker.models.length} 个对话模型`),
                h('button', { className: 'kk-btn', onClick: () => setPicker(null) }, '关闭'),
              ),
              picker.loading
                ? h('div', { className: 'kk-sub', style: { padding: 16 } }, '正在拉取模型列表…')
                : h(
                    'div',
                    { style: { padding: '10px 16px', overflow: 'auto', flex: 1 } },
                    h('input', {
                      className: 'kk-input',
                      style: { width: '100%', marginBottom: 8 },
                      placeholder: '搜索模型 id…',
                      value: picker.q,
                      onChange: (e) => setPicker((p) => (p ? { ...p, q: e.target.value } : p)),
                    }),
                    h(
                      'div',
                      { style: { display: 'flex', gap: 6, marginBottom: 6 } },
                      h('button', { className: 'kk-btn', onClick: () => setPicker((p) => (p ? { ...p, current: p.models } : p)) }, '全选'),
                      h('button', { className: 'kk-btn', onClick: () => setPicker((p) => (p ? { ...p, current: [] } : p)) }, '清空'),
                    ),
                    list.length
                      ? list.map((id) =>
                          h(
                            'label',
                            { key: id, style: { display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0', cursor: 'pointer' } },
                            h('input', { type: 'checkbox', checked: picker.current.includes(id), onChange: () => toggle(id) }),
                            h('span', { style: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12 } }, id),
                          ),
                        )
                      : h('div', { className: 'kk-sub' }, '没有匹配的模型'),
                  ),
              h(
                'div',
                { className: 'kk-modal-head', style: { borderTop: '0.5px solid var(--dsw-alias-border-l2, #3a3a3a)', borderBottom: 'none' } },
                h('span', { className: 'kk-sub kk-grow' }, `已选 ${picker.current.length} 个 · 接口共 ${picker.total} 个（已滤掉向量/图片类）`),
                h(
                  'button',
                  { className: 'kk-btn kk-btn-primary', disabled: picker.loading || !picker.current.length, onClick: () => savePicker(picker.current) },
                  '写入这些模型',
                ),
              ),
            ),
          ),
          document.body,
        )
      }

      return h(
        'div',
        { className: 'kk-body' },
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          h('button', { className: 'kk-btn kk-btn-primary', disabled: busy, onClick: applyAll }, '写入 DSH（应用到模型选择器）'),
          h('button', { className: 'kk-btn', onClick: () => setImportOpen((v) => !v) }, importOpen ? '收起批量导入' : '批量导入 keys.txt'),
          h('span', { className: 'kk-sub kk-grow' }, '写入后模型选择器里会出现 kk-<平台> 路由'),
        ),
        importOpen
          ? h(
              'div',
              { className: 'kk-field' },
              h('span', { className: 'kk-muted' }, '一行一个：平台=key，例如 deepseek=sk-xxx、moonshot=sk-xxx；支持 kimi/glm/qwen/doubao 等别名'),
              h('textarea', {
                className: 'kk-textarea',
                value: importText,
                onChange: (e) => setImportText(e.target.value),
                placeholder: 'deepseek=sk-...\nmoonshot=sk-...',
              }),
              h(
                'div',
                { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                h('button', { className: 'kk-btn kk-btn-primary', disabled: busy || !importText.trim(), onClick: doImport }, '导入'),
                h(
                  'label',
                  { className: 'kk-btn', style: { cursor: 'pointer' } },
                  '从文件读取',
                  h('input', {
                    type: 'file',
                    accept: '.txt,.json,text/plain',
                    style: { display: 'none' },
                    onChange: (e) => {
                      const file = e.target.files && e.target.files[0]
                      if (file) file.text().then((text) => setImportText(text)).catch(() => {})
                      e.target.value = ''
                    },
                  }),
                ),
              ),
            )
          : null,
        applyResult && applyResult.ok === false
          ? h(
              'div',
              { className: 'kk-banner' },
              h('div', { className: 'kk-err' }, (applyResult.failed || []).map((f) => `${f.id}: ${f.error}`).join('；') || '写入失败'),
              applyResult.hint ? h('div', { className: 'kk-muted' }, applyResult.hint) : null,
              applyResult.yaml ? h('pre', { className: 'kk-pre' }, applyResult.yaml) : null,
            )
          : applyResult && applyResult.failed && applyResult.failed.length
            ? h('div', { className: 'kk-muted' }, '部分失败：' + applyResult.failed.map((f) => `${f.id}: ${f.error}`).join('；'))
            : null,
        h(
          'div',
          { className: 'kk-scroll' },
          groups.map(([group, list]) =>
            h(
              'div',
              { key: group },
              h('div', { className: 'kk-muted', style: { margin: '8px 0 2px' } }, group),
              list.map((p) =>
                h(
                  'div',
                  { className: 'kk-row', key: p.id },
                  h('div', { className: 'kk-grow' }, h('div', null, p.name), h('div', { className: 'kk-sub' }, p.baseURL || '')),
                  p.keyConfigured ? h(StatusChip, { on: true, onLabel: `已保存 ${p.keyHint || ''}` }) : h(StatusChip, { on: false }),
                  p.applied ? h('span', { className: 'kk-chip on' }, '已写入 DSH') : null,
                  h('input', {
                    className: 'kk-input',
                    style: { width: 190, maxWidth: '100%' },
                    type: 'password',
                    autoComplete: 'off',
                    placeholder: p.keyConfigured ? '替换 Key…' : '粘贴 API Key',
                    value: drafts[p.id] || '',
                    onChange: (e) => setDrafts((d) => ({ ...d, [p.id]: e.target.value })),
                    onKeyDown: (e) => {
                      if (e.key === 'Enter') save(p.id, drafts[p.id])
                    },
                  }),
                  h('button', { className: 'kk-btn', disabled: busy, onClick: () => save(p.id, drafts[p.id]) }, '保存'),
                  p.keyConfigured
                    ? h('button', { className: 'kk-btn kk-btn-danger', disabled: busy, onClick: () => remove(p.id) }, '删除')
                    : null,
                  h(
                    'div',
                    { style: { display: 'flex', gap: 8, flexWrap: 'wrap', width: '100%', alignItems: 'center' } },
                    p.keyConfigured
                      ? h(
                          'button',
                          {
                            className: 'kk-btn kk-btn-primary',
                            disabled: busy || (probe[p.id] && probe[p.id].busy),
                            onClick: () => runProbe(p.id, 'detect'),
                          },
                          '检测并配置',
                        )
                      : null,
                    p.keyConfigured
                      ? h(
                          'button',
                          {
                            className: 'kk-btn',
                            disabled: busy || (probe[p.id] && probe[p.id].busy),
                            onClick: () => openPicker(p),
                          },
                          '选择模型…',
                        )
                      : null,
                    p.keyConfigured
                      ? h(
                          'button',
                          {
                            className: 'kk-btn',
                            disabled: busy || (probe[p.id] && probe[p.id].busy),
                            onClick: () => runProbe(p.id, 'test'),
                          },
                          '测试对话',
                        )
                      : null,
                    p.applied
                      ? h(
                          'button',
                          {
                            className: 'kk-btn',
                            disabled: busy || (probe[p.id] && probe[p.id].busy),
                            onClick: () => runProbe(p.id, 'set-default'),
                          },
                          '设为默认',
                        )
                      : null,
                    probe[p.id]
                      ? h('span', { className: 'kk-sub' }, probe[p.id].busy ? '处理中…' : probe[p.id].text)
                      : null,
                  ),
                ),
              ),
            ),
          ),
        ),
        pickerModal,
      )
    }

    // ------------------------------------------------------------------
    // 余额页
    // ------------------------------------------------------------------

    function BalanceTab({ status, refresh, toast }) {
      const [cache, setCache] = useState({ updatedAt: status.balanceUpdatedAt, items: status.balances || {} })
      const [busy, setBusy] = useState(false)
      const providers = (status.providers || []).filter((p) => p.kind !== 'subscription' && p.keyConfigured)
      const doRefresh = async () => {
        setBusy(true)
        try {
          const res = await api('/balance/refresh', {})
          setCache(res)
          toast('余额已刷新')
          await refresh()
        } catch (e) {
          toast(String(e.message || e))
        } finally {
          setBusy(false)
        }
      }
      return h(
        'div',
        { className: 'kk-body' },
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          h('button', { className: 'kk-btn', disabled: busy, onClick: doRefresh }, busy ? '刷新中…' : '刷新余额'),
          h('span', { className: 'kk-sub kk-grow' }, cache.updatedAt ? `上次刷新 ${new Date(cache.updatedAt).toLocaleString()}` : '还没有刷新过'),
        ),
        providers.length === 0 ? h('div', { className: 'kk-muted' }, '先到「密钥」页保存至少一个平台的 Key。') : null,
        h(
          'div',
          null,
          providers.map((p) => {
            const bal = cache.items[p.id] || p.balance
            const noApi = bal && bal.noApi
            return h(
              'div',
              { className: 'kk-row', key: p.id },
              h('div', { className: 'kk-grow' }, p.name, p.balanceApi ? null : h('span', { className: 'kk-sub' }, '（无公开余额接口）')),
              noApi
                ? h('span', { className: 'kk-muted' }, '去控制台查看')
                : bal && bal.ok
                  ? h('span', { className: bal.amount < 5 ? 'kk-warn' : 'kk-ok' }, money(bal), bal.note ? h('span', { className: 'kk-sub' }, ` · ${bal.note}`) : null)
                  : bal && bal.error
                    ? h('span', { className: 'kk-err' }, bal.error)
                    : h('span', { className: 'kk-muted' }, '—'),
              p.console ? h('span', { className: 'kk-link', onClick: () => openExternal(p.console) }, '控制台') : null,
            )
          }),
          Object.entries(cache.items || {})
            .filter(([k]) => k.startsWith('custom:'))
            .map(([key, bal]) =>
              h(
                'div',
                { className: 'kk-row', key },
                h('div', { className: 'kk-grow' }, (bal && bal.name) || key, h('div', { className: 'kk-sub' }, '自定义接口')),
                bal && bal.ok
                  ? h('span', { className: bal.amount < 5 ? 'kk-warn' : 'kk-ok' }, money(bal), bal.note ? h('span', { className: 'kk-sub' }, ` · ${bal.note}`) : null)
                  : h('span', { className: 'kk-err' }, (bal && bal.error) || '—'),
              ),
            ),
        ),
        h(
          'div',
          { className: 'kk-muted' },
          '余额来自各厂商官方接口；没有公开接口的平台不会抓网页（避免动你的登录 Cookie），只给控制台入口。',
        ),
      )
    }

    // ------------------------------------------------------------------
    // 充值页
    // ------------------------------------------------------------------

    function SubscriptionCard({ provider, meta, toast }) {
      const [draft, setDraft] = useState({
        plan: meta.plan || '',
        quota: meta.quota || '',
        renewAt: meta.renewAt || '',
        note: meta.note || '',
      })
      const set = (k) => (e) => setDraft({ ...draft, [k]: e.target.value })
      const save = async () => {
        try {
          await api('/subscriptions/set', { providerId: provider.id, ...draft })
          toast('订阅信息已保存')
        } catch (e) {
          toast(String(e.message || e))
        }
      }
      return h(
        'div',
        { className: 'kk-banner' },
        h('div', { className: 'kk-sub' }, '订阅额度只能手动记录（厂商不开放额度接口）：填写后显示在本卡片。'),
        h(
          'div',
          { className: 'kk-grid', style: { marginTop: 6 } },
          h('input', { className: 'kk-input', placeholder: '套餐（如 Max 5x）', value: draft.plan, onChange: set('plan') }),
          h('input', { className: 'kk-input', placeholder: '额度/剩余（如 每周 50 次）', value: draft.quota, onChange: set('quota') }),
          h('input', { className: 'kk-input', placeholder: '续费日（如 2026-01-20）', value: draft.renewAt, onChange: set('renewAt') }),
          h('input', { className: 'kk-input', placeholder: '备注', value: draft.note, onChange: set('note') }),
        ),
        h('button', { className: 'kk-btn', style: { marginTop: 6 }, onClick: save }, '保存订阅信息'),
      )
    }

    function RechargeTab({ status, toast }) {
      const groups = useMemo(() => {
        const map = new Map()
        for (const p of status.providers || []) {
          if (!map.has(p.group)) map.set(p.group, [])
          map.get(p.group).push(p)
        }
        return Array.from(map.entries())
      }, [status])
      const overrides = (status.ui && status.ui.rechargeOverrides) || {}
      return h(
        'div',
        { className: 'kk-body' },
        h('div', { className: 'kk-muted' }, '点击按钮会用系统浏览器打开官方充值/收银台页面，付款由官方页面完成。'),
        groups.map(([group, list]) =>
          h(
            'div',
            { key: group },
            h('div', { className: 'kk-muted', style: { margin: '8px 0 4px' } }, group),
            h(
              'div',
              { className: 'kk-grid' },
              list.map((p) =>
                h(
                  'div',
                  { className: 'kk-card', key: p.id },
                  h('div', { className: 'kk-title' }, p.name),
                  p.note ? h('div', { className: 'kk-sub' }, p.note) : null,
                  h(
                    'div',
                    { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                    p.recharge
                      ? h(
                          'button',
                          { className: 'kk-btn kk-btn-primary', onClick: () => openExternal(overrides[p.id] || p.recharge) },
                          '打开官方充值',
                        )
                      : null,
                    p.keyPage ? h('button', { className: 'kk-btn', onClick: () => openExternal(p.keyPage) }, '申请 Key') : null,
                  ),
                  p.kind === 'subscription'
                    ? h(SubscriptionCard, { provider: p, meta: (status.subscriptions || {})[p.id] || {}, toast })
                    : null,
                ),
              ),
            ),
          ),
        ),
      )
    }

    // ------------------------------------------------------------------
    // 设置页
    // ------------------------------------------------------------------

    function SettingsTab({ status, refresh, toast, lock }) {
      const [oldPassword, setOldPassword] = useState('')
      const [newPassword, setNewPassword] = useState('')
      const [exportPassword, setExportPassword] = useState('')
      const [importPassword, setImportPassword] = useState('')
      const fileRef = useRef(null)
      const [busy, setBusy] = useState(false)
      const [adapters, setAdapters] = useState(status.customBalances || [])
      const [autoLock, setAutoLock] = useState(status.autoLockMinutes === 0 ? 0 : status.autoLockMinutes || 15)
      const [selfcheck, setSelfcheck] = useState(null)
      const runSelfcheck = async () => {
        setBusy(true)
        try {
          const res = await api('/selfcheck')
          setSelfcheck(res)
        } catch (e) {
          toast(String(e.message || e))
        } finally {
          setBusy(false)
        }
      }
      const [adapterDraft, setAdapterDraft] = useState({ name: '', url: '', key: '', headerName: 'authorization', headerPrefix: 'Bearer ', jsonPath: '', currency: 'CNY' })

      const changePassword = async () => {
        if (newPassword.length < 6) return toast('新密码至少 6 位')
        setBusy(true)
        try {
          await api('/vault/password', { oldPassword, newPassword })
          setOldPassword('')
          setNewPassword('')
          toast('密码已更新')
        } catch (e) {
          toast(String(e.message || e))
        } finally {
          setBusy(false)
        }
      }

      const doExport = async () => {
        if (!exportPassword) return toast('请输入当前密码以导出明文')
        setBusy(true)
        try {
          const res = await api('/export', { password: exportPassword })
          download(res.filename, res.content)
          toast('已导出明文备份')
        } catch (e) {
          toast(String(e.message || e))
        } finally {
          setBusy(false)
        }
      }

      const doImport = async () => {
        const file = fileRef.current && fileRef.current.files && fileRef.current.files[0]
        if (!file) return toast('先选择备份文件')
        if (importPassword.length < 6) return toast('设置一个至少 6 位的新主密码')
        setBusy(true)
        try {
          const text = await file.text()
          let parsed
          try {
            parsed = JSON.parse(text)
          } catch {
            return toast('备份内容不是合法 JSON')
          }
          if (!parsed || typeof parsed !== 'object' || !parsed.providers || typeof parsed.providers !== 'object') {
            return toast('备份格式不识别（缺少 providers）')
          }
          if (parsed.format && parsed.format !== 'dsh-keykeeper-plain') {
            return toast('不支持的备份格式：' + parsed.format)
          }
          if (!window.confirm('导入会覆盖当前保险库（旧库会自动备份到 vault.json.bak-*），确定继续？')) return
          await api('/import', { password: importPassword, data: text })
          toast('已导入并改用新主密码')
          await refresh()
        } catch (e) {
          toast(String(e.message || e))
        } finally {
          setBusy(false)
        }
      }

      const addAdapter = async () => {
        if (!adapterDraft.url) return toast('接口 URL 必填')
        setBusy(true)
        try {
          const res = await api('/custom-balance/set', adapterDraft)
          setAdapters((list) => [...list.filter((a) => a.id !== res.adapter.id), res.adapter])
          setAdapterDraft({ ...adapterDraft, name: '', url: '', key: '', jsonPath: '' })
          toast('自定义接口已保存')
          await refresh()
        } catch (e) {
          toast(String(e.message || e))
        } finally {
          setBusy(false)
        }
      }

      const removeAdapter = async (id) => {
        setBusy(true)
        try {
          await api('/custom-balance/remove', { id })
          setAdapters((list) => list.filter((a) => a.id !== id))
        } catch (e) {
          toast(String(e.message || e))
        } finally {
          setBusy(false)
        }
      }

      return h(
        'div',
        { className: 'kk-body' },
        h('div', { className: 'kk-muted' }, `保险库文件：${status.vaultPath}`),
        h(
          'div',
          { className: 'kk-banner' },
          h('div', { className: 'kk-title' }, '自动锁定'),
          h('div', { className: 'kk-sub' }, '无操作多久后要求重新输入主密码；锁定后仍可只读查看已缓存的余额。'),
          h(
            'select',
            {
              className: 'kk-input',
              style: { marginTop: 6 },
              value: String(autoLock),
              onChange: async (e) => {
                const v = Number(e.target.value)
                setAutoLock(v)
                try {
                  await api('/vault/auto-lock', { minutes: v })
                  toast(v ? `已设为 ${v} 分钟` : '已关闭自动锁定，手动锁定或 DSH 退出时才会锁')
                  await refresh()
                } catch (err) {
                  setAutoLock(status.autoLockMinutes === 0 ? 0 : status.autoLockMinutes || 15)
                  toast(String(err.message || err))
                }
              },
            },
            [[0, '不自动锁定'], [5, '5 分钟'], [15, '15 分钟'], [30, '30 分钟'], [60, '60 分钟'], [240, '4 小时']].map(([v, label]) =>
              h('option', { key: v, value: String(v) }, label),
            ),
          ),
        ),
        h(
          'div',
          { className: 'kk-banner' },
          h('div', { className: 'kk-title' }, '改主密码'),
          h(
            'div',
            { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 } },
            h('input', { className: 'kk-input', type: 'password', autoComplete: 'current-password', placeholder: '当前密码', value: oldPassword, onChange: (e) => setOldPassword(e.target.value) }),
            h('input', { className: 'kk-input', type: 'password', autoComplete: 'new-password', placeholder: '新密码（≥6 位）', value: newPassword, onChange: (e) => setNewPassword(e.target.value) }),
            h('button', { className: 'kk-btn', disabled: busy, onClick: changePassword }, '更新'),
          ),
        ),
        h(
          'div',
          { className: 'kk-banner' },
          h('div', { className: 'kk-title' }, '导出明文备份'),
          h('div', { className: 'kk-sub' }, '明文包含所有 Key，请只放在自己信任的位置。'),
          h(
            'div',
            { style: { display: 'flex', gap: 8, marginTop: 6 } },
            h('input', { className: 'kk-input', type: 'password', autoComplete: 'current-password', placeholder: '当前密码', value: exportPassword, onChange: (e) => setExportPassword(e.target.value) }),
            h('button', { className: 'kk-btn', disabled: busy, onClick: doExport }, '导出 JSON'),
          ),
        ),
        h(
          'div',
          { className: 'kk-banner' },
          h('div', { className: 'kk-title' }, '从备份导入'),
          h('div', { className: 'kk-sub' }, '导入会覆盖当前保险库，并改用这里设置的新主密码。'),
          h(
            'div',
            { style: { display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' } },
            h('input', { className: 'kk-input', type: 'file', accept: '.json,application/json', ref: fileRef }),
            h('input', { className: 'kk-input', type: 'password', placeholder: '新主密码（≥6 位）', value: importPassword, onChange: (e) => setImportPassword(e.target.value) }),
            h('button', { className: 'kk-btn', disabled: busy, onClick: doImport }, '导入'),
          ),
        ),
        h(
          'div',
          { className: 'kk-banner' },
          h('div', { className: 'kk-title' }, '自定义余额接口'),
          h('div', { className: 'kk-sub' }, '给没有内置适配器的中转站/平台用：填余额接口 URL、请求头前缀、返回 JSON 的数字字段路径。'),
          h(
            'div',
            { className: 'kk-grid', style: { marginTop: 8 } },
            h('input', { className: 'kk-input', placeholder: '名称', value: adapterDraft.name, onChange: (e) => setAdapterDraft({ ...adapterDraft, name: e.target.value }) }),
            h('input', { className: 'kk-input', placeholder: '接口 URL（https）', value: adapterDraft.url, onChange: (e) => setAdapterDraft({ ...adapterDraft, url: e.target.value }) }),
            h('input', { className: 'kk-input', type: 'password', autoComplete: 'off', placeholder: '该接口的 Key（可留空）', value: adapterDraft.key, onChange: (e) => setAdapterDraft({ ...adapterDraft, key: e.target.value }) }),
            h('input', { className: 'kk-input', placeholder: '请求头名，默认 authorization', value: adapterDraft.headerName, onChange: (e) => setAdapterDraft({ ...adapterDraft, headerName: e.target.value }) }),
            h('input', { className: 'kk-input', placeholder: '前缀，默认 Bearer ', value: adapterDraft.headerPrefix, onChange: (e) => setAdapterDraft({ ...adapterDraft, headerPrefix: e.target.value }) }),
            h('input', { className: 'kk-input', placeholder: 'JSON 路径，如 data.balance', value: adapterDraft.jsonPath, onChange: (e) => setAdapterDraft({ ...adapterDraft, jsonPath: e.target.value }) }),
            h('input', { className: 'kk-input', placeholder: '货币 CNY/USD', value: adapterDraft.currency, onChange: (e) => setAdapterDraft({ ...adapterDraft, currency: e.target.value }) }),
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 8, marginTop: 8 } },
            h('button', { className: 'kk-btn', disabled: busy, onClick: addAdapter }, '保存接口'),
          ),
          adapters.length
            ? h(
                'div',
                { style: { marginTop: 8 } },
                adapters.map((a) =>
                  h(
                    'div',
                    { className: 'kk-row', key: a.id },
                    h('div', { className: 'kk-grow' }, a.name, h('div', { className: 'kk-sub' }, a.url)),
                    h('button', { className: 'kk-btn kk-btn-danger', onClick: () => removeAdapter(a.id) }, '删除'),
                  ),
                ),
              )
            : null,
        ),
        h(
          'div',
          { className: 'kk-banner' },
          h('div', { className: 'kk-title' }, '运行自检'),
          h('div', { className: 'kk-sub' }, '检查设置服务、pi-ai 配置入口、凭据服务与已写入路由，排查“写入 DSH 没反应”。'),
          h('button', { className: 'kk-btn', style: { marginTop: 6 }, disabled: busy, onClick: runSelfcheck }, '开始自检'),
          selfcheck
            ? h(
                'div',
                { style: { marginTop: 8 } },
                selfcheck.checks.map((c) =>
                  h(
                    'div',
                    { className: 'kk-row', key: c.name },
                    h('div', { className: 'kk-grow' }, (c.ok ? '✅ ' : '❌ ') + c.name, c.detail ? h('div', { className: 'kk-sub' }, c.detail) : null),
                  ),
                ),
              )
            : null,
        ),
        h(
          'div',
          { style: { display: 'flex', gap: 8 } },
          h('button', { className: 'kk-btn', onClick: lock }, '立即锁定'),
          h('span', { className: 'kk-sub' }, '15 分钟无操作会自动锁定；锁定后余额与密钥都不会再返回。'),
        ),
      )
    }

    // ------------------------------------------------------------------
    // 主面板
    // ------------------------------------------------------------------

    function MainPanel({ status, refresh, toast, lock }) {
      const [tab, setTab] = useState('keys')
      const tabs = [
        ['keys', '密钥'],
        ['balance', '余额'],
        ['recharge', '充值'],
        ['settings', '设置'],
      ]
      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'kk-tabs' },
          tabs.map(([id, label]) =>
            h('div', { key: id, className: `kk-tab ${tab === id ? 'active' : ''}`, onClick: () => setTab(id) }, label),
          ),
        ),
        tab === 'keys'
          ? h(KeysTab, { status, refresh, toast })
          : tab === 'balance'
            ? h(BalanceTab, { status, refresh, toast })
            : tab === 'recharge'
              ? h(RechargeTab, { status, toast })
              : h(SettingsTab, { status, refresh, toast, lock }),
      )
    }

    function Panel({ mode }) {
      const [status, setStatus] = useState(null)
      const [open, setOpen] = useState(false)
      const [toast, setToast] = useState('')
      const [error, setError] = useState('')
      const toastTimer = useRef(null)

      const refresh = useCallback(async () => {
        try {
          const s = await api('/status')
          setStatus(s)
          setError('')
          return s
        } catch (e) {
          setError(String(e.message || e))
          return null
        }
      }, [])

      useEffect(() => {
        refresh()
      }, [refresh])

      const showToast = useCallback((text) => {
        setToast(text)
        if (toastTimer.current) clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => setToast(''), 2600)
      }, [])

      // 打开面板时强制拉一次状态，避免自动锁定后仍显示旧的“已解锁”
      useEffect(() => {
        if (open) refresh()
      }, [open, refresh])

      // 任何接口返回 401（自动锁定/会话失效）都回到解锁界面
      useEffect(() => {
        const onUnauthorized = () => {
          setError('')
          showToast('保险库已锁定，请重新输入主密码')
          refresh()
        }
        window.addEventListener('keykeeper-unauthorized', onUnauthorized)
        return () => window.removeEventListener('keykeeper-unauthorized', onUnauthorized)
      }, [refresh, showToast])

      const lock = useCallback(async () => {
        try {
          await api('/vault/lock', {})
        } catch {
          /* ignore */
        }
        setOpen(false)
        await refresh()
        showToast('已锁定')
      }, [refresh, showToast])

      const summary = useMemo(() => {
        if (!status) return '加载中…'
        if (!status.hasVault) return '未创建保险库'
        if (status.locked) {
          const n = Object.keys(status.balances || {}).length
          return n ? `已锁定 · ${n} 家余额只读可看` : '已锁定'
        }
        const count = (status.providers || []).filter((p) => p.keyConfigured).length
        const applied = (status.providers || []).filter((p) => p.applied).length
        const balances = Object.entries(status.balances || {}).filter(([, b]) => b && b.ok)
        const low = balances.filter(([, b]) => Number(b.amount) < 5).length
        const base = `${count} 个平台有 Key · ${applied} 个已写入 DSH`
        if (!balances.length) return base
        return `${base} · ${balances.length} 家余额${low ? ` · ⚠️ ${low} 家偏低` : ''}`
      }, [status])

      const lowBalance = useMemo(() => {
        if (!status || !status.balances) return false
        return Object.values(status.balances).some((b) => b && b.ok && Number(b.amount) < 5)
      }, [status])

      if (mode === 'section') {
        let inner
        if (!status) inner = h('div', { className: 'kk-body' }, '加载中…')
        else if (!status.hasVault) inner = h(CreateVault, { onDone: () => refresh(), toast: showToast })
        else if (status.locked) inner = h(LockedView, { status, onDone: () => refresh(), toast: showToast })
        else inner = h(MainPanel, { status, refresh, toast: showToast, lock })
        return h(
          'div',
          { className: 'kk-root' },
          h(
            'div',
            { className: 'kk-card' },
            h(
              'div',
              { className: 'kk-card-head' },
              h('div', { className: 'kk-title' }, '🔑 钥匙管家'),
              h('div', { className: 'kk-muted' }, summary),
            ),
            h('div', { className: 'kk-sub' }, '本地加密保存各家 API Key · 余额速览 · 一键写入 DSH 模型配置 · 官方充值跳转'),
            inner,
          ),
          toast ? h('div', { className: 'kk-toast' }, toast) : null,
          error ? h('div', { className: 'kk-toast' }, error) : null,
        )
      }

      if (mode === 'dock') {
        return h(
          React.Fragment,
          null,
          h('div', { className: 'kk-root' }, h('button', { className: 'kk-pill', onClick: () => setOpen(true) }, `🔑 钥匙管家 · ${summary}`)),
          open ? h(ModalShell, { status, refresh, toast: showToast, lock, close: () => setOpen(false), summary, lowBalance }) : null,
          toast ? h('div', { className: 'kk-toast' }, toast) : null,
          error ? h('div', { className: 'kk-toast' }, error) : null,
        )
      }

      return h(
        'div',
        { className: 'kk-root' },
        h(
          'div',
          { className: 'kk-card' },
          h(
            'div',
            { className: 'kk-card-head' },
            h('div', { className: 'kk-title' }, '🔑 钥匙管家'),
            h('div', { className: 'kk-muted' }, summary),
          ),
          h('div', { className: 'kk-sub' }, '本地加密保存各家 API Key · 余额速览 · 一键写入 DSH 模型配置 · 官方充值跳转'),
          h(
            'div',
            { style: { display: 'flex', gap: 8, alignItems: 'center' } },
            lowBalance ? h('span', { className: 'kk-warn' }, '有平台余额低于 5') : null,
            h('button', { className: 'kk-btn kk-btn-primary', onClick: () => setOpen(true) }, '打开面板'),
          ),
        ),
        open ? h(ModalShell, { status, refresh, toast: showToast, lock, close: () => setOpen(false), summary, lowBalance }) : null,
        toast ? h('div', { className: 'kk-toast' }, toast) : null,
        error ? h('div', { className: 'kk-toast' }, error) : null,
      )
    }

    function ModalShell({ status, refresh, toast, lock, close, summary, lowBalance }) {
      const onKey = useCallback((e) => {
        if (e.key === 'Escape') close()
      }, [close])
      useEffect(() => {
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onKey])

      let inner
      if (!status) inner = h('div', { className: 'kk-body' }, '加载中…')
      else if (!status.hasVault) inner = h(CreateVault, { onDone: (s) => { refresh(); s && setStatusSafe(s) }, toast })
      else if (status.locked) inner = h(LockedView, { status, onDone: (s) => { refresh(); s && setStatusSafe(s) }, toast })
      else inner = h(MainPanel, { status, refresh, toast, lock })

      function setStatusSafe() {
        /* 状态由 refresh 拉取，这里无需额外处理 */
      }

      const overlay = h(
        'div',
        { className: 'kk-overlay', onMouseDown: (e) => { if (e.target === e.currentTarget) close() } },
        h(
          'div',
          { className: 'kk-modal', onMouseDown: (e) => e.stopPropagation() },
          h(
            'div',
            { className: 'kk-modal-head' },
            h('div', { className: 'kk-title' }, '🔑 钥匙管家'),
            h('div', { className: 'kk-muted kk-grow' }, summary),
            lowBalance ? h('span', { className: 'kk-warn' }, '低余额') : null,
            h('button', { className: 'kk-btn', onClick: close }, '关闭'),
          ),
          inner,
        ),
      )
      if (createPortal && typeof document !== 'undefined') return createPortal(overlay, document.body)
      return overlay
    }

    function KeyIcon({ size = 16, active }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          opacity: active ? 1 : 0.72,
        },
        h('circle', { cx: 8.5, cy: 8.5, r: 4.2 }),
        h('path', { d: 'M11.5 11.5l8.5 8.5M17 17l1.8-1.8M14.2 19.8l1.8-1.8' }),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => installStyle())
        // 某个 slot 注册失败（外壳版本差异）不应连累其他入口
        const safeRegister = (owner, register) => {
          try {
            ctx.slots.inject(owner, () => {
              try {
                return register()
              } catch (e) {
                console.warn('[keykeeper] slot register failed: ' + owner, e)
                return undefined
              }
            })
          } catch (e) {
            console.warn('[keykeeper] slot inject failed: ' + owner, e)
          }
        }
        safeRegister('settings.models.footer', () =>
          ctx.slots.register({ name: 'settings.models.footer', id: 'keykeeper-footer', order: 20 }, () => h(Panel, { mode: 'footer' })),
        )
        safeRegister('conversation.composer.dock', () =>
          ctx.slots.register({ name: 'conversation.composer.dock', id: 'keykeeper-dock', order: 20 }, () => h(Panel, { mode: 'dock' })),
        )
        // 设置页独立导航页；id 同时标识 section 与导航图标
        safeRegister('settings.section', () =>
          ctx.slots.register({ name: 'settings.section', id: 'keykeeper', order: 200, label: '钥匙管家' }, () => h(Panel, { mode: 'section' })),
        )
        safeRegister('settings.section.icon', () =>
          ctx.slots.register({ name: 'settings.section.icon', id: 'keykeeper', order: 200, label: '钥匙管家' }, KeyIcon),
        )
      },
    }
  },
})

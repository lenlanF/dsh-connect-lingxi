window.__ModuleLoader__.load({
  id: 'dsh-connect-lingxi',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const PREFIX = '/plugins/dsh-connect-lingxi'
    const SECTION_ID = 'dsh-connect-lingxi'

    const style = {
      page: { display: 'flex', flexDirection: 'column', gap: '14px', width: '100%', color: 'var(--text-primary, inherit)', fontFamily: 'inherit', boxSizing: 'border-box', minWidth: 0 },
      header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' },
      title: { fontSize: '20px', fontWeight: 600, margin: '0 0 4px' },
      sub: { fontSize: '12px', opacity: 0.66, margin: 0, lineHeight: 1.6 },
      toolbar: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px' },
      card: { display: 'flex', flexDirection: 'column', gap: '10px', border: '1px solid var(--border-color, #d0d7de)', borderRadius: '10px', padding: '14px 16px', minWidth: 0, background: 'var(--card-bg, transparent)' },
      cardHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' },
      h2: { fontSize: '14px', fontWeight: 600, margin: 0 },
      desc: { fontSize: '11px', opacity: 0.6, margin: '2px 0 0' },
      hairline: { borderBottom: '1px solid var(--border-color, #eee)', margin: '2px 0' },
      row: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px', padding: '8px 0', minWidth: 0 },
      grow: { flex: 1, minWidth: 0 },
      small: { fontSize: '12px', opacity: 0.72 },
      tiny: { fontSize: '11px', opacity: 0.6 },
      button: { border: '1px solid var(--border-color, #d0d7de)', background: 'transparent', color: 'inherit', borderRadius: '6px', padding: '5px 10px', cursor: 'pointer', fontSize: '12px', whiteSpace: 'nowrap' },
      primary: { border: '1px solid var(--accent-color, #2f6feb)', background: 'var(--accent-color, #2f6feb)', color: '#fff', borderRadius: '6px', padding: '5px 10px', cursor: 'pointer', fontSize: '12px', whiteSpace: 'nowrap' },
      danger: { border: '1px solid #d1242f', background: 'transparent', color: '#d1242f', borderRadius: '6px', padding: '5px 10px', cursor: 'pointer', fontSize: '12px', whiteSpace: 'nowrap' },
      ghost: { border: '1px solid transparent', background: 'transparent', color: 'inherit', borderRadius: '6px', padding: '4px 8px', cursor: 'pointer', fontSize: '12px', opacity: 0.8 },
      input: { border: '1px solid var(--border-color, #d0d7de)', background: 'transparent', color: 'inherit', borderRadius: '6px', padding: '5px 8px', fontSize: '12px', minWidth: '120px' },
      textarea: { border: '1px solid var(--border-color, #d0d7de)', background: 'transparent', color: 'inherit', borderRadius: '6px', padding: '8px', fontSize: '11px', width: '100%', minHeight: '92px', fontFamily: 'monospace', boxSizing: 'border-box', resize: 'vertical' },
      badge: { fontSize: '11px', border: '1px solid var(--border-color, #d0d7de)', borderRadius: '999px', padding: '1px 7px', whiteSpace: 'nowrap' },
      toneOk: { borderColor: '#1a7f37', color: '#1a7f37' },
      toneWarn: { borderColor: '#bf8700', color: '#bf8700' },
      toneBad: { borderColor: '#d1242f', color: '#d1242f' },
      toneInfo: { borderColor: '#2f6feb', color: '#2f6feb' },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: '12px', minWidth: 0 },
      th: { textAlign: 'left', fontSize: '11px', opacity: 0.6, fontWeight: 500, padding: '6px 8px', borderBottom: '1px solid var(--border-color, #eee)', whiteSpace: 'nowrap' },
      td: { padding: '8px', borderBottom: '1px solid var(--border-color, #eee)', verticalAlign: 'middle' },
      statGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '8px' },
      stat: { border: '1px solid var(--border-color, #eee)', borderRadius: '8px', padding: '8px 10px' },
      statLabel: { fontSize: '11px', opacity: 0.6 },
      statValue: { fontSize: '16px', fontWeight: 600, marginTop: '2px' },
      error: { color: '#d1242f', fontSize: '12px', padding: '8px 10px', border: '1px solid #d1242f', borderRadius: '6px' },
      ok: { color: '#1a7f37', fontSize: '12px', padding: '8px 10px', border: '1px solid #1a7f37', borderRadius: '6px' },
      confirm: { border: '1px solid #bf8700', background: 'rgba(191,135,0,0.06)', borderRadius: '8px', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '8px' },
      empty: { fontSize: '12px', opacity: 0.6, padding: '12px 0' },
    }

    async function api(path, method, body) {
      const response = await fetch(PREFIX + path, {
        method,
        headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        const detail = payload.error ? ' · ' + payload.error : ''
        throw new Error('请求失败 (' + response.status + ')' + detail)
      }
      return payload
    }

    function download(filename, text) {
      const blob = new Blob([text], { type: 'application/json;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(url), 2000)
    }

    function Badge(props) {
      let tone = {}
      if (props.tone === 'ok') tone = style.toneOk
      else if (props.tone === 'warn') tone = style.toneWarn
      else if (props.tone === 'bad') tone = style.toneBad
      else if (props.tone === 'info') tone = style.toneInfo
      return h('span', { style: { ...style.badge, ...tone } }, props.children)
    }

    function Section(props) {
      const settingsSurface = props?.surface === 'settings'

      const [status, setStatus] = React.useState(null)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [label, setLabel] = React.useState('')
      const [sid, setSid] = React.useState('')
      const [selected, setSelected] = React.useState([])
      const [importText, setImportText] = React.useState('')
      const [importPreview, setImportPreview] = React.useState(null)
      const [confirmExport, setConfirmExport] = React.useState(false)
      const [confirmScope, setConfirmScope] = React.useState('accounts')
      const [renameId, setRenameId] = React.useState('')
      const [renameValue, setRenameValue] = React.useState('')
      const [removeId, setRemoveId] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      const load = React.useCallback(async () => {
        try { setStatus(await api('/status', 'GET')); setError('') }
        catch (e) { setError(String(e && e.message || e)) }
      }, [])

      React.useEffect(() => {
        load()
        const timer = setInterval(load, 60000)
        return () => clearInterval(timer)
      }, [load])

      async function act(fn, message) {
        setError(''); setNotice(''); setBusy(true)
        try {
          const result = await fn()
          setNotice(message || (result && result.message) || '操作完成')
          await load()
          return result
        } catch (e) { setError(String(e && e.message || e)); return null }
        finally { setBusy(false) }
      }

      const accounts = status?.accounts || []
      const models = status?.models || []
      const settings = status?.settings || { autoCheckin: true, timezone: 'Asia/Shanghai', pollIntervalMinutes: 5, disabledModelIds: [], poolOrder: [] }
      const diagnostics = status?.diagnostics || {}
      const checkin = status?.checkin || {}

      function toggleSelected(id) {
        setSelected((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])
      }
      function allSelected() { return accounts.length > 0 && selected.length === accounts.length }
      function toggleAll() { setSelected(allSelected() ? [] : accounts.map((a) => a.id)) }

      async function move(id, dir) {
        const ids = accounts.map((a) => a.id)
        const i = ids.indexOf(id)
        const j = i + dir
        if (i < 0 || j < 0 || j >= ids.length) return
        const next = ids.slice()
        const tmp = next[i]; next[i] = next[j]; next[j] = tmp
        await act(() => api('/account/reorder', 'POST', { ids: next }), '账号顺序已更新')
      }

      async function doExport() {
        const ids = selected.length ? selected : null
        const file = await act(() => api('/transfer/export', 'POST', ids ? { ids } : {}), null)
        if (!file) return
        download('lingxi-accounts-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify(file, null, 2))
        setNotice('已导出 ' + file.accounts.length + ' 个账号（含 wps_sid，请妥善保管）')
        setConfirmExport(false)
      }

      async function doPreview() {
        let parsed
        try { parsed = JSON.parse(importText) } catch { setError('粘贴内容不是合法 JSON'); return }
        await act(() => api('/transfer/preview', 'POST', parsed), '预览已生成')
          .then((p) => setImportPreview(p || null))
      }

      async function doImport() {
        let parsed
        try { parsed = JSON.parse(importText) } catch { setError('粘贴内容不是合法 JSON'); return }
        await act(() => api('/transfer/import', 'POST', parsed), '账号导入完成')
        setImportText(''); setImportPreview(null)
      }

      const STATE_LABELS = { ok: '正常', rate_limit: '限流中', quota: '额度不足', session_dead: '登录失效', unavailable: '不可用', transport: '网络异常', unknown: '未检测' }
      const CHECKIN_LABELS = { claimed: '已签到', already: '今日已签', failed: '签到失败' }
      function stateLabel(s) { return STATE_LABELS[s] || s || '未检测' }
      function checkinLabel(s) { return CHECKIN_LABELS[s] || s || '未签到' }
      function stateTone(s) { return s === 'ok' ? 'ok' : (s === 'session_dead' || s === 'unavailable' || s === 'quota' ? 'bad' : (s === 'rate_limit' || s === 'transport' ? 'warn' : 'info')) }
      function openRename(a) { setRenameId(a.id); setRenameValue(a.label || ''); setRemoveId('') }
      async function commitRename() {
        const id = renameId, value = renameValue.trim()
        if (!id || !value) { setRenameId(''); return }
        await act(() => api('/account/rename', 'POST', { id, label: value }), '已重命名')
        setRenameId('')
      }
      async function commitRemove(id) {
        await act(() => api('/account/remove', 'POST', { id }), '已移除账号')
        setRemoveId('')
      }
      function openExport(scope) { setConfirmScope(scope); setConfirmExport(true) }

      const totalBalance = accounts.reduce((sum, a) => sum + (a.balance?.total ?? (a.credits >= 0 ? a.credits : 0)), 0)
      const grants = accounts.flatMap((a) => (a.balance?.grants || []).map((g) => ({ ...g, owner: a.label })))

      return h('div', { style: settingsSurface ? { ...style.page, maxWidth: 'none', gap: '12px' } : { ...style.page, maxWidth: '900px' }, 'data-lingxi-settings': 'v0.3' },
        h('div', { style: style.header },
          h('div', null,
            h('h1', { style: style.title }, 'WPS 灵犀'),
            h('p', { style: style.sub }, '本机登录态 · 账号池 · 智点余额 · 每日签到 · 模型倍率 · 诊断')
          ),
          h('div', { style: style.toolbar },
            h('button', { style: style.button, disabled: busy, onClick: () => act(() => api('/login/open', 'POST'), '已在系统浏览器打开登录页；登录后点「重新扫描」') }, '🌐 网页登录'),
            h('button', { style: style.button, disabled: busy, onClick: () => act(() => api('/refresh', 'POST'), '已重新扫描本机登录态') }, '重新扫描'),
            h('button', { style: style.button, disabled: busy, onClick: () => load() }, '刷新')
          )
        ),
        error ? h('div', { style: style.error, role: 'alert' }, error) : null,
        notice ? h('div', { style: style.ok }, notice) : null,
        confirmExport ? h('div', { style: style.confirm },
          h('div', { style: { ...style.small, color: '#bf8700' } }, '⚠ 导出的文件包含明文 wps_sid，等同于账号凭据，请勿分享或上传到公开位置。'),
          h('div', { style: style.toolbar },
            h('button', { style: style.danger, disabled: busy, onClick: doExport }, '确认导出 ' + (selected.length || accounts.length) + ' 个账号'),
            h('button', { style: style.button, onClick: () => setConfirmExport(false) }, '取消')
          )
        ) : null,

        // ---- 概览 ----
        h('section', { style: style.card, 'data-section': 'overview' },
          h('div', { style: style.cardHead },
            h('div', null, h('h2', { style: style.h2 }, '概览'), h('p', { style: style.desc }, '账号与余额总览')),
          ),
          h('div', { style: style.statGrid },
            h('div', { style: style.stat }, h('div', { style: style.statLabel }, '账号总数'), h('div', { style: style.statValue }, accounts.length)),
            h('div', { style: style.stat }, h('div', { style: style.statLabel }, '已启用'), h('div', { style: style.statValue }, accounts.filter((a) => a.enabled).length)),
            h('div', { style: style.stat }, h('div', { style: style.statLabel }, '可用模型'), h('div', { style: style.statValue }, models.filter((m) => m.enabled !== false).length)),
            h('div', { style: style.stat }, h('div', { style: style.statLabel }, '智点余额合计'), h('div', { style: style.statValue }, totalBalance)),
            h('div', { style: style.stat }, h('div', { style: style.statLabel }, '今日签到'), h('div', { style: style.statValue }, checkin.today || '-'))
          )
        ),

        // ---- 账号池 ----
        h('section', { style: style.card, 'data-section': 'accounts' },
          h('div', { style: style.cardHead },
            h('div', null, h('h2', { style: style.h2 }, '账号池 (' + accounts.length + ')'), h('p', { style: style.desc }, '勾选账号可批量签到 / 导出；↑↓ 调整优先顺序')),
            h('div', { style: style.toolbar },
              h('button', { style: style.ghost, onClick: toggleAll }, allSelected() ? '取消全选' : '全选'),
              h('button', { style: style.button, disabled: busy || !selected.length, onClick: () => act(() => api('/checkin/many', 'POST', { ids: selected }), '已对选中账号执行签到') }, '签到选中 (' + selected.length + ')'),
              h('button', { style: style.button, disabled: busy, onClick: () => openExport('accounts') }, '导出账号')
            )
          ),
          accounts.length === 0
            ? h('div', { style: style.empty }, '未发现可用账号。点「网页登录」在浏览器登录后回来点「重新扫描」，或在下方手动添加 wps_sid。')
            : h('div', { style: { overflowX: 'auto' } },
                h('table', { style: style.table },
                  h('thead', null, h('tr', null,
                    h('th', { style: style.th }, ''),
                    h('th', { style: style.th }, '账号'),
                    h('th', { style: style.th }, '智点余额'),
                    h('th', { style: style.th }, '签到'),
                    h('th', { style: style.th }, '状态'),
                    h('th', { style: style.th }, '操作')
                  )),
                  h('tbody', null, ...accounts.map((a, idx) => h('tr', { key: a.id, 'data-account': a.id },
                    h('td', { style: style.td }, h('input', { type: 'checkbox', checked: selected.includes(a.id), onChange: () => toggleSelected(a.id), 'aria-label': '选择 ' + a.label })),
                    h('td', { style: style.td },
                      renameId === a.id
                        ? h('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap' } },
                            h('input', { style: { ...style.input, minWidth: '140px' }, value: renameValue, autoFocus: true, 'aria-label': '新账号名称', onChange: (e) => setRenameValue(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenameId('') } }),
                            h('button', { style: style.primary, disabled: busy, onClick: commitRename }, '保存'),
                            h('button', { style: style.button, onClick: () => setRenameId('') }, '取消')
                          )
                        : h('div', null, a.label || a.id, ' ', h(Badge, { tone: a.source === 'local' ? 'info' : 'warn' }, a.source === 'local' ? '本机' : '手动')),
                      h('div', { style: style.tiny }, 'SID 长度 ' + a.sidLength + ' · ' + (a.balance ? '赠送 ' + a.balance.bonus + ' / 购买 ' + a.balance.purchased + (a.balance.contract ? ' / 合约 ' + a.balance.contract : '') : '余额未知'))
                    ),
                    h('td', { style: style.td }, h('span', { style: { fontWeight: 600 } }, a.balance?.total ?? (a.credits >= 0 ? a.credits : '未知'))),
                    h('td', { style: style.td }, h(Badge, { tone: a.lastCheckinOutcome === 'claimed' || a.lastCheckinOutcome === 'already' ? 'ok' : (a.lastCheckinOutcome === 'failed' ? 'bad' : 'info') }, checkinLabel(a.lastCheckinOutcome || (a.lastCheckinDate ? a.lastCheckinDate : null)))),
                    h('td', { style: style.td }, h(Badge, { tone: stateTone(a.state) }, stateLabel(a.state)), a.enabled ? null : h('div', null, h(Badge, { tone: 'warn' }, '已停用'))),
                    h('td', { style: style.td },
                      h('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap' } },
                        h('button', { style: style.ghost, title: '上移', disabled: busy || idx === 0, onClick: () => move(a.id, -1) }, '↑'),
                        h('button', { style: style.ghost, title: '下移', disabled: busy || idx === accounts.length - 1, onClick: () => move(a.id, 1) }, '↓'),
                        h('button', { style: style.button, disabled: busy, onClick: () => openRename(a) }, '重命名'),
                        h('button', { style: style.button, disabled: busy, onClick: () => act(() => api('/account/toggle', 'POST', { id: a.id, enabled: !a.enabled }), '已切换账号状态') }, a.enabled ? '停用' : '启用'),
                        h('button', { style: style.button, disabled: busy, onClick: () => act(() => api('/checkin', 'POST', { id: a.id }), '签到请求已提交') }, '签到'),
                        a.source === 'manual' ? (removeId === a.id
                          ? h('span', { style: { display: 'inline-flex', gap: '4px' } }, h('button', { style: style.danger, disabled: busy, onClick: () => commitRemove(a.id) }, '确认移除'), h('button', { style: style.ghost, onClick: () => setRemoveId('') }, '取消'))
                          : h('button', { style: style.danger, disabled: busy, onClick: () => setRemoveId(a.id) }, '移除')) : null
                      )
                    )
                  )))
                )
              ),
          h('div', { style: style.hairline }),
          h('div', { style: style.row },
            h('input', { style: style.input, placeholder: '账号名称', value: label, onChange: (e) => setLabel(e.target.value), 'aria-label': '账号名称' }),
            h('input', { style: { ...style.input, minWidth: '240px' }, placeholder: 'wps_sid', type: 'password', value: sid, onChange: (e) => setSid(e.target.value), 'aria-label': 'wps_sid' }),
            h('button', { style: style.primary, disabled: busy || !sid.trim(), onClick: () => act(async () => { await api('/account', 'POST', { label: label || '手动账号', sid }); setLabel(''); setSid('') }, '已添加账号') }, '添加账号')
          )
        ),

        // ---- 导出 / 导入 ----
        h('section', { style: style.card, 'data-section': 'transfer' },
          h('div', { style: style.cardHead },
            h('div', null, h('h2', { style: style.h2 }, '导出 / 导入账号'), h('p', { style: style.desc }, '与另一台设备交换账号；导出文件含明文凭据，请自行保管')),
          ),
          h('div', { style: style.toolbar },
            h('button', { style: style.button, disabled: busy, onClick: () => openExport('transfer') }, '导出账号'),
            h('span', { style: style.tiny }, selected.length ? '当前勾选 ' + selected.length + ' 个' : '未勾选时导出全部')
          ),
          h('textarea', { style: style.textarea, placeholder: '粘贴导出的 JSON 内容…', value: importText, onChange: (e) => { setImportText(e.target.value); setImportPreview(null) }, 'aria-label': '导入 JSON' }),
          h('div', { style: style.toolbar },
            h('button', { style: style.button, disabled: busy || !importText.trim(), onClick: doPreview }, '预览'),
            h('button', { style: style.primary, disabled: busy || !importText.trim() || !importPreview, onClick: doImport }, '确认导入'),
            importPreview ? h('span', { style: style.small }, '可导入 ' + importPreview.count + ' 个账号：' + importPreview.accounts.slice(0, 4).map((x) => x.label || x.sidLength + '位').join('、') + (importPreview.count > 4 ? ' …' : '')) : null
          )
        ),

        // ---- 每日签到 ----
        h('section', { style: style.card, 'data-section': 'checkin' },
          h('div', { style: style.cardHead },
            h('div', null, h('h2', { style: style.h2 }, '每日签到'), h('p', { style: style.desc }, (settings.timezone || 'Asia/Shanghai') + ' · 今日 ' + (checkin.today || '-') + ' · 同一天幂等')),
            h('div', { style: style.toolbar },
              h('button', { style: settings.autoCheckin ? style.primary : style.button, disabled: busy, onClick: () => act(() => api('/settings', 'POST', { autoCheckin: !settings.autoCheckin }), '已更新自动签到开关') }, settings.autoCheckin ? '自动签到：已开启' : '自动签到：已关闭'),
              h('button', { style: style.button, disabled: busy, onClick: () => act(() => api('/checkin', 'POST'), '已执行全部账号签到') }, '全部签到')
            )
          ),
          h('div', { style: style.row, borderBottom: 'none' },
            h('div', { style: style.grow }, h('span', { style: style.small }, '上次自动运行：' + (checkin.lastRunAt ? new Date(checkin.lastRunAt).toLocaleString() : '无')), checkin.lastError ? h('span', { style: { ...style.small, color: '#d1242f' } }, ' · 错误：' + checkin.lastError) : null)
          )
        ),

        // ---- 模型与倍率 ----
        h('section', { style: style.card, 'data-section': 'models' },
          h('div', { style: style.cardHead },
            h('div', null, h('h2', { style: style.h2 }, '模型与倍率 (' + models.length + ')'), h('p', { style: style.desc }, '倍率越低越省智点；停用的模型不会出现在聊天模型选择器')),
            h('button', { style: style.button, disabled: busy, onClick: () => act(() => api('/models/refresh', 'POST'), '已刷新模型目录') }, '从灵犀刷新')
          ),
          models.length === 0 ? h('div', { style: style.empty }, '暂无模型目录') : h('div', { style: { overflowX: 'auto' } },
            h('table', { style: style.table },
              h('thead', null, h('tr', null,
                h('th', { style: style.th }, '模型'),
                h('th', { style: style.th }, '倍率'),
                h('th', { style: style.th }, '上下文'),
                h('th', { style: style.th }, '推理'),
                h('th', { style: style.th }, '状态')
              )),
              h('tbody', null, ...models.map((m) => h('tr', { key: m.id, 'data-model': m.id },
                h('td', { style: style.td }, h('div', null, m.name), h('div', { style: style.tiny }, m.id)),
                h('td', { style: style.td }, h(Badge, { tone: m.multiplierValue <= 0.2 ? 'ok' : (m.multiplierValue >= 1 ? 'warn' : 'info') }, m.multiplier || (m.multiplierValue != null ? 'x' + m.multiplierValue : '—'))),
                h('td', { style: style.td }, m.contextWindow ? (m.contextWindow / 1024).toFixed(0) + 'K' : '—'),
                h('td', { style: style.td }, m.reasoning ? h(Badge, { tone: 'info' }, m.defaultEffort || '支持') : h('span', { style: style.tiny }, '—')),
                h('td', { style: style.td }, h('button', { style: m.enabled === false ? style.button : style.primary, disabled: busy, onClick: () => {
                  const disabled = settings.disabledModelIds || []
                  const next = m.enabled === false ? disabled.filter((id) => id !== m.id) : [...disabled, m.id]
                  act(() => api('/settings', 'POST', { disabledModelIds: next }), '已更新模型启用状态')
                } }, m.enabled === false ? '已停用' : '已启用'))
              )))
            )
          )
        ),

        // ---- 智点余额明细 ----
        h('section', { style: style.card, 'data-section': 'balance' },
          h('div', { style: style.cardHead }, h('div', null, h('h2', { style: style.h2 }, '智点余额明细'), h('p', { style: style.desc }, 'total_balance 为权威值；下方为逐笔额度（含有效期）'))),
          grants.length === 0 ? h('div', { style: style.empty }, '暂无逐笔额度') : h('div', { style: { overflowX: 'auto' } },
            h('table', { style: style.table },
              h('thead', null, h('tr', null, h('th', { style: style.th }, '账号'), h('th', { style: style.th }, '面额'), h('th', { style: style.th }, '已用'), h('th', { style: style.th }, '剩余'), h('th', { style: style.th }, '有效期'))),
              h('tbody', null, ...grants.map((g, i) => h('tr', { key: i },
                h('td', { style: style.td }, g.owner),
                h('td', { style: style.td }, g.value),
                h('td', { style: style.td }, g.consumed),
                h('td', { style: style.td }, g.balance),
                h('td', { style: style.td }, g.expiresAt ? new Date(g.expiresAt).toLocaleDateString() : '—')
              )))
            )
          )
        ),

        // ---- 诊断 ----
        h('section', { style: style.card, 'data-section': 'diagnostics' },
          h('h2', { style: style.h2 }, '诊断'),
          ...Object.entries(diagnostics).map(([key, value]) => h('div', { key, style: style.small }, key + ': ' + String(value)))
        )
      )
    }

    return {
      name: SECTION_ID,
      inject: ['slots', 'locale'],
      apply(ctx) {
        const injected = () => ({ surface: 'settings' })
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: SECTION_ID,
          order: 36,
          label: () => 'WPS 灵犀',
          locale: SECTION_ID,
          inject: injected,
        }, Section))
      },
    }
  },
})

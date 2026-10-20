/**
 * Client half of @local/dsh-btw — the floating answer panel.
 *
 * Listens to the client-side `command/executed` event (emitted by
 * `dsh-client-ui-commands` after every settled command execution) and, for
 * `/btw` results, shows the answer in a transient panel anchored above the
 * composer via the `conversation.input.overlay` slot — the same anchor the
 * slash menu uses. Esc or the close button dismisses it. The chat transcript
 * keeps its native command card as the durable record; the overlay is the
 * immediate reading surface.
 *
 * v0.3.0: Markdown rendering, readable typography, one-click copy, and history
 * paging (‹ n/m › plus ←/→ keys) over the last answers of this session.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-btw',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useMemo, useRef, useState, useSyncExternalStore } = React

    let MarkdownText = null
    try {
      MarkdownText = require('@deepseek-ai/dsh-client-ui-primitives').MarkdownText ?? null
    } catch {
      // The primitives module is always present in the Web deployment; a plain
      // text fallback keeps the panel usable if it ever is not.
    }

    const MAX_ITEMS = 40

    const LABELS = {
      code: {
        copyLabel: '复制代码',
        copiedLabel: '已复制',
        toolbarLabels: { codeLabel: '代码', wrapLabel: '自动换行', unwrapLabel: '取消换行' },
      },
      footnotes: '脚注',
    }

    /** Tiny external store so the slot component re-renders on new answers. */
    const store = {
      state: { items: [], open: false, index: -1 },
      listeners: new Set(),
      get() {
        return store.state
      },
      subscribe(listener) {
        store.listeners.add(listener)
        return () => store.listeners.delete(listener)
      },
      emit() {
        for (const listener of [...store.listeners]) {
          try {
            listener()
          } catch {
            // A broken subscriber must not break the event chain.
          }
        }
      },
      push(sessionId, text) {
        const item = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          sessionId,
          text,
          time: Date.now(),
        }
        const items = [...store.state.items, item].slice(-MAX_ITEMS)
        store.state = { items, open: true, index: items.length - 1 }
        store.emit()
      },
      close() {
        if (!store.state.open) return
        store.state = { ...store.state, open: false }
        store.emit()
      },
      step(delta) {
        const { items, index } = store.state
        if (items.length < 2) return
        const next = Math.min(items.length - 1, Math.max(0, index + delta))
        if (next === index) return
        store.state = { ...store.state, index: next }
        store.emit()
      },
    }

    function useCopy() {
      const [copied, setCopied] = useState(false)
      const timer = useRef(null)
      useEffect(() => () => timer.current && clearTimeout(timer.current), [])
      const copy = (text) => {
        const done = () => {
          setCopied(true)
          if (timer.current) clearTimeout(timer.current)
          timer.current = setTimeout(() => setCopied(false), 1600)
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, () => fallback(text, done))
        } else {
          fallback(text, done)
        }
      }
      return [copied, copy]
    }

    function fallback(text, done) {
      // Older or non-secure contexts have no async clipboard API.
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        document.execCommand('copy')
        area.remove()
        done()
      } catch {
        // Copy is a convenience; failing silently leaves the text selectable.
      }
    }

    function AnswerBody({ text }) {
      if (MarkdownText) {
        return h(MarkdownText, { text, streaming: false, labels: LABELS, variant: 'compact' })
      }
      return h('div', { className: 'btw-plain' }, text)
    }

    function BtwOverlayPanel() {
      const state = useSyncExternalStore(store.subscribe, store.get)
      const hasItems = state.items.length > 0
      const open = state.open && hasItems
      const latest = hasItems ? state.items[Math.min(state.index, state.items.length - 1)] : null
      const [copied, copy] = useCopy()

      useEffect(() => {
        if (!open) return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            store.close()
            return
          }
          // Only page when the composer is not capturing the arrow keys.
          const target = event.target
          const typing = target instanceof HTMLElement
            && (target.isContentEditable || /^(INPUT|TEXTAREA)$/.test(target.tagName))
          if (typing) return
          if (event.key === 'ArrowLeft') {
            event.preventDefault()
            store.step(-1)
          } else if (event.key === 'ArrowRight') {
            event.preventDefault()
            store.step(1)
          }
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
      }, [open])

      const timeText = useMemo(() => {
        if (!latest) return ''
        const d = new Date(latest.time)
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      }, [latest])

      if (!open || !latest) return null
      const total = state.items.length
      const position = state.index + 1

      return h('div', { className: 'btw-overlay-root', role: 'dialog', 'aria-label': 'btw 临时问答' }, [
        h('div', { className: 'btw-overlay-header', key: 'header' }, [
          h('span', { className: 'btw-overlay-title', key: 'title' }, 'btw · 临时问答'),
          h('div', { className: 'btw-overlay-tools', key: 'tools' }, [
            total > 1
              ? h('span', { className: 'btw-pager', key: 'pager' }, [
                h('button', {
                  className: 'btw-icon-btn',
                  key: 'prev',
                  type: 'button',
                  title: '上一条（←）',
                  disabled: state.index <= 0,
                  onClick: () => store.step(-1),
                }, '‹'),
                h('span', { className: 'btw-pager-text', key: 'pos' }, `${position}/${total}`),
                h('button', {
                  className: 'btw-icon-btn',
                  key: 'next',
                  type: 'button',
                  title: '下一条（→）',
                  disabled: state.index >= total - 1,
                  onClick: () => store.step(1),
                }, '›'),
              ])
              : null,
            h('span', { className: 'btw-time', key: 'time' }, timeText),
            h('button', {
              className: 'btw-text-btn',
              key: 'copy',
              type: 'button',
              title: '复制这条回答',
              onClick: () => copy(latest.text),
            }, copied ? '已复制' : '复制'),
            h('button', {
              className: 'btw-icon-btn',
              key: 'close',
              type: 'button',
              title: '关闭（Esc）',
              onClick: () => store.close(),
            }, '✕'),
          ]),
        ]),
        h('div', { className: 'btw-overlay-body', key: 'body' }, h(AnswerBody, { text: latest.text })),
        total > 1
          ? h('div', { className: 'btw-overlay-foot', key: 'foot' }, '← → 翻看历史 · 不进入会话历史')
          : null,
      ])
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // Inject the shared stylesheet once per plugin lifetime.
        ctx.effect(() => {
          const style = document.createElement('style')
          style.textContent = [
            '.btw-overlay-root{position:absolute;bottom:calc(100% + 8px);left:8px;right:8px;z-index:80;',
            'display:flex;flex-direction:column;max-height:58vh;padding:10px 14px 12px;border-radius:14px;',
            'background:rgba(252,252,253,0.985);border:1px solid rgba(0,0,0,0.12);',
            'box-shadow:0 12px 40px rgba(0,0,0,0.16);color:#1d1d1f;',
            'font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;',
            'font-size:13.5px;line-height:1.68;letter-spacing:0.01em;}',
            '@media (prefers-color-scheme:dark){.btw-overlay-root{background:rgba(38,38,42,0.985);',
            'border-color:rgba(255,255,255,0.14);box-shadow:0 12px 40px rgba(0,0,0,0.55);color:#e6e6ea;}}',
            '.btw-overlay-header{display:flex;align-items:center;justify-content:space-between;gap:8px;',
            'margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid rgba(128,128,128,0.18);',
            'font-size:12px;opacity:0.85;}',
            '.btw-overlay-title{font-weight:600;letter-spacing:0.02em;white-space:nowrap;}',
            '.btw-overlay-tools{display:flex;align-items:center;gap:2px;}',
            '.btw-pager{display:inline-flex;align-items:center;gap:2px;margin-right:6px;}',
            '.btw-pager-text{font-variant-numeric:tabular-nums;opacity:0.75;padding:0 2px;}',
            '.btw-time{opacity:0.5;font-variant-numeric:tabular-nums;margin-right:4px;}',
            '.btw-icon-btn{display:inline-flex;align-items:center;justify-content:center;min-width:24px;height:24px;',
            'padding:0 6px;border:none;border-radius:6px;background:none;cursor:pointer;color:inherit;',
            'font-size:14px;line-height:1;opacity:0.8;}',
            '.btw-icon-btn:hover:not(:disabled){opacity:1;background:rgba(128,128,128,0.16);}',
            '.btw-icon-btn:disabled{opacity:0.28;cursor:default;}',
            '.btw-text-btn{height:24px;padding:0 10px;border:1px solid rgba(128,128,128,0.3);border-radius:999px;',
            'background:none;cursor:pointer;color:inherit;font-size:12px;line-height:1;opacity:0.85;}',
            '.btw-text-btn:hover{opacity:1;background:rgba(128,128,128,0.14);}',
            '.btw-overlay-body{overflow:auto;flex:1 1 auto;min-height:0;padding-right:4px;}',
            '.btw-overlay-body p{margin:0 0 0.6em;}',
            '.btw-overlay-body p:last-child{margin-bottom:0;}',
            '.btw-overlay-body ul,.btw-overlay-body ol{margin:0 0 0.6em;padding-left:1.4em;}',
            '.btw-overlay-body li{margin:0.15em 0;}',
            '.btw-overlay-body h1,.btw-overlay-body h2,.btw-overlay-body h3{margin:0.5em 0 0.35em;font-size:1.05em;}',
            '.btw-overlay-body code{font-size:0.92em;padding:0.1em 0.35em;border-radius:4px;background:rgba(128,128,128,0.16);}',
            '.btw-overlay-body pre{margin:0.4em 0 0.7em;padding:10px 12px;border-radius:8px;overflow:auto;background:rgba(128,128,128,0.12);}',
            '.btw-overlay-body pre code{padding:0;background:none;}',
            '.btw-overlay-body table{border-collapse:collapse;margin:0.4em 0 0.7em;font-size:0.95em;}',
            '.btw-overlay-body th,.btw-overlay-body td{border:1px solid rgba(128,128,128,0.28);padding:4px 8px;}',
            '.btw-overlay-body blockquote{margin:0.4em 0;padding-left:0.8em;border-left:3px solid rgba(128,128,128,0.35);opacity:0.85;}',
            '.btw-plain{white-space:pre-wrap;word-break:break-word;}',
            '.btw-overlay-foot{margin-top:8px;padding-top:6px;border-top:1px solid rgba(128,128,128,0.16);',
            'font-size:11px;opacity:0.55;text-align:right;}',
            '.btw-overlay-body::-webkit-scrollbar{width:8px;}',
            '.btw-overlay-body::-webkit-scrollbar-thumb{background:rgba(128,128,128,0.35);border-radius:4px;}',
          ].join('')
          document.head.appendChild(style)
          return () => style.remove()
        }, 'btw-overlay-styles')

        ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
          name: 'conversation.input.overlay',
          id: 'btw-overlay',
          order: 10,
        }, BtwOverlayPanel))

        ctx.on('command/executed', (sessionId, name, result) => {
          if (name !== 'btw') return
          if (!result || result.kind !== 'success' || typeof result.text !== 'string' || !result.text.trim()) return
          store.push(sessionId, result.text)
        })
      },
    }
  },
})

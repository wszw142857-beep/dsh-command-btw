/**
 * Client half of dsh-command-btw — the floating answer panel.
 *
 * `/btw` settles immediately (so the composer clears the draft at once) and the
 * Host keeps one slot per session, served by `GET /btw/answer?session=<id>`.
 * The slot carries `{ status, question, text, history[] }`; the overlay renders
 * it and lets the user page through earlier answers of the SAME session.
 *
 * v0.5.0: questions rendered above answers, per-session isolation, and
 * restart-safe history (the Host mirrors slots to disk).
 */
window.__ModuleLoader__.load({
  id: 'dsh-command-btw',
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

    const POLL_MS = 350
    const POLL_TIMEOUT_MS = 180000

    const LABELS = {
      code: {
        copyLabel: '复制代码',
        copiedLabel: '已复制',
        toolbarLabels: { codeLabel: '代码', wrapLabel: '自动换行', unwrapLabel: '取消换行' },
      },
      footnotes: '脚注',
    }

    /**
     * View state per session:
     *   { open, sessionId, pendingQuestion, viewedIndex }
     * `viewedIndex` walks the slot's own history; -1 means "the live/latest".
     */
    const store = {
      state: { open: false, sessionId: '', slot: null, viewedIndex: -1, loading: false },
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
      openFor(sessionId) {
        store.state = { open: true, sessionId, slot: null, viewedIndex: -1, loading: true }
        store.emit()
      },
      /**
       * A follow-up keeps the slot's history (so paging still works) and only
       * resets the live entry to a pending state.
       */
      beginFollowUp(sessionId) {
        const slot = store.state.slot
        const history = slot && Array.isArray(slot.history) ? slot.history : []
        store.state = {
          open: true,
          sessionId,
          slot: {
            status: 'pending',
            text: '',
            question: '',
            history,
            id: undefined,
            updatedAt: Date.now(),
          },
          viewedIndex: -1,
          loading: false,
        }
        store.emit()
      },
      /** Panel position once dragged; null keeps the default anchored spot. */
      position: null,
      dragTo(x, y) {
        store.position = { x, y }
        store.emit()
      },
      /** Selection captured when the panel opened; cleared when the user drops it. */
      selection: '',
      apply(sessionId, slot) {
        if (store.state.sessionId !== sessionId) return
        // Clamp the pager: a growing history must never leave the view pointing
        // past the end, and a shrinking one must fall back to the live answer.
        const history = slot && Array.isArray(slot.history) ? slot.history : []
        let viewedIndex = store.state.viewedIndex
        if (viewedIndex >= history.length) viewedIndex = history.length > 0 ? history.length - 1 : -1
        store.state = { ...store.state, slot, viewedIndex, loading: false }
        store.emit()
      },
      close() {
        if (!store.state.open) return
        store.state = { ...store.state, open: false }
        store.emit()
      },
      step(delta, total) {
        if (total <= 0) return
        const { viewedIndex } = store.state
        // -1 is the live answer, which sits AFTER the newest history entry:
        //   [history 0 … history total-1] [live]
        // Stepping back from live lands on history[total-1]; stepping forward
        // from history[total-1] returns to live.
        let current = viewedIndex < 0 ? total : viewedIndex
        const next = Math.min(total, Math.max(0, current + delta))
        store.state = { ...store.state, viewedIndex: next >= total ? -1 : next }
        store.emit()
      },
      jump(index) {
        store.state = { ...store.state, viewedIndex: index }
        store.emit()
      },
    }

    /** Command executor bound in apply(); the panel's inline ask uses it. */
    const api = {
      execute: () => {},
    }

    /** Read the current page selection, if any, for a selection-scoped question. */
    function readSelection() {
      try {
        const selection = window.getSelection()
        const text = selection ? String(selection).trim() : ''
        return text.length > 0 ? text : ''
      } catch {
        return ''
      }
    }

    /** The host marks the appended selection so the model can tell data from the question. */
    const SELECTION_FENCE = '\n\n[选中的内容，仅作参考]\n'

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

    /** The entry the panel should show: a history row, or the live slot. */
    function selectEntry(state) {
      const slot = state.slot
      if (!slot) return null
      const history = Array.isArray(slot.history) ? slot.history : []
      if (state.viewedIndex >= 0 && state.viewedIndex < history.length) {
        const item = history[state.viewedIndex]
        return {
          question: item.question ?? '',
          text: item.text ?? '',
          status: item.status ?? 'done',
          time: item.time ?? 0,
          index: state.viewedIndex,
          total: history.length,
          live: false,
        }
      }
      return {
        question: slot.question ?? '',
        text: slot.text ?? '',
        status: slot.status ?? 'idle',
        time: slot.updatedAt ?? 0,
        index: -1,
        total: history.length,
        live: true,
      }
    }

    function BtwOverlayPanel() {
      const state = useSyncExternalStore(store.subscribe, store.get)
      const entry = useMemo(() => selectEntry(state), [state])
      const [copied, copy] = useCopy()
      const [draft, setDraft] = useState('')
      const open = state.open

      useEffect(() => {
        if (!open) return undefined
        const onResize = () => {
          if (!store.position) return
          const x = Math.max(0, Math.min(window.innerWidth - 240, store.position.x))
          const y = Math.max(0, Math.min(window.innerHeight - 120, store.position.y))
          if (x !== store.position.x || y !== store.position.y) store.dragTo(x, y)
        }
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [open])

      useEffect(() => {
        if (!open) return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            // Escape is also DSH's "interrupt the agent" key. Only take it when
            // focus is inside the panel (or nothing else claims it), and never
            // stop propagation: the composer must still see the interrupt.
            const target = event.target
            const inside = target instanceof Node
              && target.nodeType === 1
              && target.closest('.btw-overlay-root') !== null
            if (inside || document.activeElement === document.body) {
              store.close()
            }
            return
          }
          const target = event.target
          const typing = target instanceof HTMLElement
            && (target.isContentEditable || /^(INPUT|TEXTAREA)$/.test(target.tagName))
          if (typing) return
          if (event.key === 'ArrowLeft') {
            event.preventDefault()
            if (entry && entry.total > 0) store.step(-1, entry.total)
          } else if (event.key === 'ArrowRight') {
            event.preventDefault()
            if (entry && entry.total > 0) store.step(1, entry.total)
          }
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
      }, [open, entry])

      const timeText = useMemo(() => {
        if (!entry || !entry.time) return ''
        const d = new Date(entry.time)
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      }, [entry])

      if (!open) return null

      const pending = !entry || entry.status === 'pending' || entry.status === 'streaming'
      const streaming = entry?.status === 'streaming'
      const failed = entry?.status === 'error'
      const total = entry?.total ?? 0
      const position = entry && entry.index >= 0 ? entry.index + 1 : total
      const showPager = total > 1
      const showAnswer = Boolean(entry?.text) && !failed

      return h('div', {
        className: 'btw-overlay-root',
        role: 'dialog',
        'aria-label': 'btw 临时问答',
        'data-state': entry?.status ?? 'loading',
        style: store.position
          ? {
            left: `${store.position.x}px`,
            top: `${store.position.y}px`,
            bottom: 'auto',
            transform: 'none',
          }
          : undefined,
        onMouseDown: (event) => event.stopPropagation(),
        onClick: (event) => event.stopPropagation(),
      }, [
        h('div', {
          className: 'btw-overlay-header',
          key: 'header',
          title: '按住拖动',
          onPointerDown: (event) => {
            // Drag from the header only; buttons inside keep their own clicks.
            if (event.target instanceof Element && event.target.closest('button')) return
            event.preventDefault()
            const root = event.currentTarget.parentElement
            if (!root) return
            const rect = root.getBoundingClientRect()
            const offsetX = event.clientX - rect.left
            const offsetY = event.clientY - rect.top
            const move = (moveEvent) => {
              const x = Math.max(0, Math.min(window.innerWidth - rect.width, moveEvent.clientX - offsetX))
              const y = Math.max(0, Math.min(window.innerHeight - 48, moveEvent.clientY - offsetY))
              store.dragTo(x, y)
            }
            const stop = () => {
              window.removeEventListener('pointermove', move)
              window.removeEventListener('pointerup', stop)
              window.removeEventListener('pointercancel', stop)
            }
            window.addEventListener('pointermove', move)
            window.addEventListener('pointerup', stop)
            window.addEventListener('pointercancel', stop)
          },
        }, [
          h('span', { className: 'btw-overlay-title', key: 'title' },
            pending ? (streaming ? 'btw · 正在输出…' : 'btw · 正在思考…') : 'btw · 临时问答'),
          h('div', { className: 'btw-overlay-tools', key: 'tools' }, [
            showPager
              ? h('span', { className: 'btw-pager', key: 'pager' }, [
                h('button', {
                  className: 'btw-icon-btn',
                  key: 'prev',
                  type: 'button',
                  title: '上一条（←）',
                  disabled: position <= 1,
                  onClick: () => store.step(-1, total),
                }, '‹'),
                h('span', { className: 'btw-pager-text', key: 'pos' }, `${position}/${total}`),
                h('button', {
                  className: 'btw-icon-btn',
                  key: 'next',
                  type: 'button',
                  title: '下一条（→）',
                  disabled: position >= total,
                  onClick: () => store.step(1, total),
                }, '›'),
              ])
              : null,
            h('span', { className: 'btw-time', key: 'time' }, timeText),
            pending && state.slot
              ? h('button', {
                className: 'btw-text-btn',
                key: 'stop',
                type: 'button',
                title: '停止这次回答',
                onClick: () => {
                  fetch(`/btw/answer?session=${encodeURIComponent(state.sessionId)}&cancel=1`, { cache: 'no-store' })
                    .catch(() => {})
                },
              }, '停止')
              : null,
            !pending && !failed && entry?.text
              ? h('button', {
                className: 'btw-text-btn',
                key: 'copy',
                type: 'button',
                title: '复制这条回答',
                onClick: () => copy(entry.text),
              }, copied ? '已复制' : '复制')
              : null,
            h('button', {
              className: 'btw-icon-btn',
              key: 'close',
              type: 'button',
              title: '关闭（Esc）',
              onClick: () => store.close(),
            }, '✕'),
          ]),
        ]),
        entry?.question
          ? h('div', { className: 'btw-overlay-question', key: 'q' }, entry.question)
          : null,
        h('div', {
          className: pending && !showAnswer ? 'btw-overlay-body btw-overlay-loading' : 'btw-overlay-body',
          key: 'body',
          'data-error': failed || undefined,
        }, showAnswer
          ? h(AnswerBody, { text: entry.text })
          : h('div', { className: 'btw-dots' }, [h('span', { key: 'a' }, '.'), h('span', { key: 'b' }, '.'), h('span', { key: 'c' }, '.')])),
        showPager
          ? h('div', { className: 'btw-overlay-foot', key: 'foot' }, '← → 翻看本会话历史 · 不进入会话历史')
          : null,
        h('form', {
          className: 'btw-ask',
          key: 'ask',
          onSubmit: (event) => {
            event.preventDefault()
            const text = draft.trim()
            if (!text) return
            setDraft('')
            const selection = readSelection() || store.selection || ''
            const line = selection
              ? `/btw ${text}${SELECTION_FENCE}${selection}`
              : `/btw ${text}`
            const previousId = state.slot?.id
            // Fire the same command the composer would. This path does NOT emit
            // `command/executed` (that comes from the composer adapter), so the
            // panel must start its own poll or it would wait forever.
            store.beginFollowUp(state.sessionId)
            api.execute(state.sessionId, line)
            poll(state.sessionId, previousId)
          },
        }, [
          store.selection
            ? h('button', {
              key: 'sel',
              type: 'button',
              className: 'btw-sel-chip',
              title: '移除附带的选中内容',
              onClick: () => {
                store.selection = ''
                store.emit()
              },
            }, `已附带选区 ${store.selection.length} 字 ×`)
            : null,
          h('input', {
            key: 'input',
            className: 'btw-ask-input',
            value: draft,
            placeholder: '继续问一句…（回车发送）',
            onChange: (event) => setDraft(event.target.value),
          }),
          h('button', {
            key: 'send',
            className: 'btw-text-btn',
            type: 'submit',
            disabled: !draft.trim(),
          }, '发送'),
        ]),
      ])
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // Inject the shared stylesheet once per plugin lifetime.
        ctx.effect(() => {
          const style = document.createElement('style')
          style.textContent = [
            // Fixed positioning keeps the panel anchored to the viewport instead
            // of the composer card: streaming rows, scrolling and a shrinking
            // composer no longer push it around.
            '.btw-overlay-root{position:fixed;bottom:132px;left:50%;transform:translateX(-50%);',
            'width:min(760px,calc(100vw - 48px));z-index:400;',
            'display:flex;flex-direction:column;max-height:58vh;padding:10px 14px 12px;border-radius:14px;',
            'background:rgba(252,252,253,0.985);border:1px solid rgba(0,0,0,0.12);',
            'box-shadow:0 12px 40px rgba(0,0,0,0.16);color:#1d1d1f;',
            'font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;',
            'font-size:13.5px;line-height:1.68;letter-spacing:0.01em;',
            'user-select:text;-webkit-user-select:text;cursor:auto;}',
            '@media (prefers-color-scheme:dark){.btw-overlay-root{background:rgba(38,38,42,0.985);',
            'border-color:rgba(255,255,255,0.14);box-shadow:0 12px 40px rgba(0,0,0,0.55);color:#e6e6ea;}}',
            '.btw-overlay-header{display:flex;align-items:center;justify-content:space-between;gap:8px;',
            'margin-bottom:6px;font-size:12px;opacity:0.85;user-select:none;cursor:move;',
            'touch-action:none;}',
            '.btw-overlay-title{font-weight:600;letter-spacing:0.02em;white-space:nowrap;}',
            '.btw-overlay-tools{display:flex;align-items:center;gap:2px;}',
            '.btw-pager{display:inline-flex;align-items:center;gap:2px;margin-right:6px;}',
            '.btw-pager-text{font-variant-numeric:tabular-nums;opacity:0.75;padding:0 2px;}',
            '.btw-time{opacity:0.5;font-variant-numeric:tabular-nums;margin-right:4px;}',
            '.btw-icon-btn{display:inline-flex;align-items:center;justify-content:center;min-width:24px;height:24px;',
            'padding:0 6px;border:none;border-radius:6px;background:none;cursor:pointer;color:inherit;',
            'font-size:14px;line-height:1;opacity:0.8;user-select:none;}',
            '.btw-icon-btn:hover:not(:disabled){opacity:1;background:rgba(128,128,128,0.16);}',
            '.btw-icon-btn:disabled{opacity:0.28;cursor:default;}',
            '.btw-text-btn{height:24px;padding:0 10px;border:1px solid rgba(128,128,128,0.3);border-radius:999px;',
            'background:none;cursor:pointer;color:inherit;font-size:12px;line-height:1;opacity:0.85;user-select:none;}',
            '.btw-text-btn:hover{opacity:1;background:rgba(128,128,128,0.14);}',
            '.btw-overlay-question{padding:0 0 8px;margin-bottom:8px;',
            'border-bottom:1px dashed rgba(128,128,128,0.28);color:rgba(0,0,0,0.62);font-size:12.5px;',
            'font-style:italic;user-select:text;-webkit-user-select:text;white-space:pre-wrap;word-break:break-word;}',
            '@media (prefers-color-scheme:dark){.btw-overlay-question{color:rgba(255,255,255,0.62);}}',
            '.btw-overlay-body{overflow:auto;flex:1 1 auto;min-height:0;padding-right:4px;',
            'user-select:text;-webkit-user-select:text;cursor:text;}',
            '.btw-overlay-body[data-error]{color:#c0392b;}',
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
            '.btw-overlay-loading{opacity:0.7;}',
            '.btw-dots{display:inline-flex;gap:2px;}',
            '.btw-dots span{animation:btw-blink 1.2s infinite;font-weight:700;}',
            '.btw-dots span:nth-child(2){animation-delay:0.2s;}',
            '.btw-dots span:nth-child(3){animation-delay:0.4s;}',
            '@keyframes btw-blink{0%,100%{opacity:0.25}50%{opacity:1}}',
            '.btw-overlay-foot{margin-top:8px;padding-top:6px;border-top:1px solid rgba(128,128,128,0.16);',
            'font-size:11px;opacity:0.55;text-align:right;user-select:none;}',
            '.btw-overlay-body::-webkit-scrollbar{width:8px;}',
            '.btw-overlay-body::-webkit-scrollbar-thumb{background:rgba(128,128,128,0.35);border-radius:4px;}',
            '.btw-ask{display:flex;gap:6px;align-items:center;margin-top:8px;padding-top:8px;',
            'border-top:1px solid rgba(128,128,128,0.18);}',
            '.btw-ask-input{flex:1 1 auto;min-width:0;height:26px;padding:0 10px;border-radius:999px;',
            'border:1px solid rgba(128,128,128,0.3);background:transparent;color:inherit;',
            'font-size:12.5px;outline:none;font-family:inherit;}',
            '.btw-ask-input:focus{border-color:rgba(128,128,128,0.6);}',
            '.btw-sel-chip{flex:none;max-width:46%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
            'height:24px;padding:0 8px;border-radius:999px;border:1px dashed rgba(128,128,128,0.5);',
            'background:rgba(128,128,128,0.1);color:inherit;font-size:11px;cursor:pointer;}',
            '.btw-sel-chip:hover{background:rgba(128,128,128,0.2);}',
          ].join('')
          document.head.appendChild(style)
          return () => style.remove()
        }, 'btw-overlay-styles')

        ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
          name: 'conversation.input.overlay',
          id: 'btw-overlay',
          order: 10,
        }, BtwOverlayPanel))

        // Inline follow-up questions reuse the same Host command path.
        api.execute = (sessionId, line) => {
          try {
            const remote = ctx.remote
            if (!remote || !remote.commands || typeof remote.commands.execute !== 'function') return
            Promise.resolve(remote.commands.execute(sessionId, line, [])).catch(() => {})
          } catch {
            // The composer stays the fallback entry point.
          }
        }

        /**
         * Poll one session's slot until it settles.
         * `expectChange` waits for the slot to leave its current state, so a
         * follow-up does not read the PREVIOUS answer and stop immediately.
         */
        function poll(sessionId, previousId) {
          const started = Date.now()
          const tick = () => {
            fetch(`/btw/answer?session=${encodeURIComponent(sessionId)}`, { cache: 'no-store' })
              .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
              .then((slot) => {
                const changed = !previousId || !slot || slot.id !== previousId
                if (changed) store.apply(sessionId, slot)
                const settled = slot && (slot.status === 'done' || slot.status === 'error') && slot.id !== previousId
                if (!changed || !settled) {
                  if (Date.now() - started > POLL_TIMEOUT_MS) return
                  setTimeout(tick, POLL_MS)
                }
              })
              .catch(() => {
                if (Date.now() - started > POLL_TIMEOUT_MS) return
                setTimeout(tick, POLL_MS)
              })
          }
          setTimeout(tick, POLL_MS)
        }

        ctx.on('command/executed', (sessionId, name, result) => {
          if (name !== 'btw') return
          // Grab the page selection before the overlay steals focus; a selection
          // is what makes "why does this fail?" questions precise.
          store.selection = readSelection()
          const previousId = store.state.slot?.id
          store.beginFollowUp(sessionId)
          if (result && result.kind === 'error') {
            store.apply(sessionId, {
              status: 'error',
              text: result.text || '/btw 执行失败',
              question: '',
              history: [],
              updatedAt: Date.now(),
            })
            return
          }
          poll(sessionId, previousId)
        })
      },
    }
  },
})

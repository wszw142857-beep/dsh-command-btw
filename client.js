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
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-btw',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useSyncExternalStore } = React

    const MAX_ITEMS = 20

    /** Tiny external store so the slot component re-renders on new answers. */
    const store = {
      state: { items: [], open: false },
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
        store.state = {
          items: [...store.state.items, item].slice(-MAX_ITEMS),
          open: true,
        }
        store.emit()
      },
      close() {
        if (!store.state.open) return
        store.state = { ...store.state, open: false }
        store.emit()
      },
    }

    function BtwOverlayPanel() {
      const state = useSyncExternalStore(store.subscribe, store.get)
      const hasItems = state.items.length > 0

      // Esc closes the panel; the capture-phase listener is mounted only
      // while the panel exists, so it never competes with the slash menu.
      useEffect(() => {
        if (!state.open || !hasItems) return undefined
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          store.close()
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
      }, [state.open, hasItems])

      if (!state.open || !hasItems) return null
      const latest = state.items[state.items.length - 1]
      return h('div', { className: 'btw-overlay-root', role: 'dialog', 'aria-label': 'btw 临时问答' }, [
        h('div', { className: 'btw-overlay-header', key: 'header' }, [
          h('span', { className: 'btw-overlay-title', key: 'title' }, 'btw · 临时问答'),
          h('button', {
            className: 'btw-overlay-close',
            key: 'close',
            type: 'button',
            title: '关闭（Esc）',
            onClick: () => store.close(),
          }, '✕'),
        ]),
        h('pre', { className: 'btw-overlay-body', key: 'body' }, latest.text),
        state.items.length > 1
          ? h('div', { className: 'btw-overlay-count', key: 'count' }, `共 ${state.items.length} 条临时问答（不进入会话历史）`)
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
            'display:flex;flex-direction:column;max-height:55vh;padding:10px 12px;border-radius:12px;',
            'background:rgba(250,250,250,0.97);border:1px solid rgba(0,0,0,0.14);',
            'box-shadow:0 8px 32px rgba(0,0,0,0.18);font-size:13px;line-height:1.6;}',
            '@media (prefers-color-scheme:dark){.btw-overlay-root{background:rgba(38,38,42,0.97);border-color:rgba(255,255,255,0.16);box-shadow:0 8px 32px rgba(0,0,0,0.5);}}',
            '.btw-overlay-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;opacity:0.75;}',
            '.btw-overlay-title{font-size:12px;font-weight:600;letter-spacing:0.02em;}',
            '.btw-overlay-close{border:none;background:none;cursor:pointer;font-size:14px;line-height:1;padding:2px 4px;color:inherit;opacity:0.8;border-radius:6px;}',
            '.btw-overlay-close:hover{opacity:1;background:rgba(128,128,128,0.15);}',
            '.btw-overlay-body{margin:0;white-space:pre-wrap;word-break:break-word;font-family:inherit;font-size:13px;overflow:auto;color:inherit;}',
            '.btw-overlay-count{margin-top:6px;font-size:11px;opacity:0.55;}',
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

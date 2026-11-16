window.__ModuleLoader__.load({
  id: 'dsh-pet-approval',
  factory: function () {
    function apply(ctx) {
      var disposed = false, timer = null, busy = false, wake = null
      var endpoint = '/pet-approval-navigation'
      function delay() { return new Promise(function (resolve) { wake = resolve; timer = setTimeout(function () { wake = null; resolve() }, 100) }) }
      async function open(item) {
        if (!ctx.uiWorkspace || typeof ctx.uiWorkspace.openSession !== 'function') return false
        await ctx.uiWorkspace.openSession(item.sessionId)
        for (var i = 0; i < 30 && !disposed; i++) {
          var snap = ctx.sessions.list.getSnapshot()
          if (snap.current === item.sessionId && document.hasFocus()) return true
          await delay()
        }
        return false
      }
      async function tick() {
        if (disposed || busy) return
        busy = true
        try {
          var response = await fetch(endpoint, {cache:'no-store'})
          if (!response.ok) return
          var data = await response.json()
          for (var item of data.items || []) {
            if (disposed || !document.hasFocus()) break
            var ok = false
            try { ok = await open(item) } catch (_) {}
            if (!disposed) await fetch(endpoint, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:item.id,revision:item.revision,ok:ok})})
          }
        } catch (_) {} finally {
          busy = false
          if (!disposed) timer = setTimeout(tick, 700)
        }
      }
      ctx.effect(function () {
        tick()
        return function () { disposed = true; clearTimeout(timer); if (wake) wake() }
      })
    }
    return {apply:apply,inject:['sessions','uiWorkspace']}
  }
})

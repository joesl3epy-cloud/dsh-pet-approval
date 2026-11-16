// Navigation acknowledgement never decides an approval.
export const NAV_PATH = '/pet-approval-navigation'
export function requestNavigation(item, now = Date.now()) {
  if (!item.sessionId) return false
  item.navigation = { revision: (item.navigation?.revision || 0) + 1, status: 'pending', expires: now + 15000 }
  return true
}
export function navigationItems(state, now = Date.now()) {
  const result = []
  for (const item of state.pending.values()) {
    const nav = item.navigation
    if (!nav || nav.status !== 'pending') continue
    if (nav.expires <= now) { nav.status = 'failed'; continue }
    result.push({ id: item.id, sessionId: item.sessionId, revision: nav.revision })
  }
  return result
}
export function acknowledgeNavigation(state, body, now = Date.now()) {
  const item = state.pending.get(body.id)
  const nav = item?.navigation
  if (!nav || nav.status !== 'pending' || nav.revision !== body.revision || nav.expires <= now) return false
  nav.status = body.ok === true ? 'opened' : 'failed'
  item.viewed = body.ok === true
  return true
}
export function installNavigation(ctx, state) {
  if (!ctx.webServer?.register) return false
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: NAV_PATH, handler: async (req,res) => {
    const reply = (status, data) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)) }
    const origin = req.headers.origin
    if (origin && origin !== 'dsh-app://index.html') {
      try { if (new URL(origin).protocol !== 'dsh-app:' && new URL(origin).host !== req.headers.host) return reply(403, {ok:false}) }
      catch { return reply(403, {ok:false}) }
    }
    if (req.method === 'GET' && req.url.split('?')[0] === NAV_PATH) return reply(200, { items: navigationItems(state) })
    if (req.method !== 'POST' || req.url.split('?')[0] !== NAV_PATH) return reply(404, {ok:false})
    let raw = ''
    try {
      for await (const chunk of req) { raw += chunk; if (raw.length > 4096) return reply(413, {ok:false}) }
      const body = JSON.parse(raw)
      return reply(200, {ok: body && acknowledgeNavigation(state,body)})
    } catch { return reply(400, {ok:false}) }
  } }))
  return true
}

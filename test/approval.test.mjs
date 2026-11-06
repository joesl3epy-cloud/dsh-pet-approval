/**
 * 行为测试：本机接口鉴权、高风险拦截、双通道竞争、取消、卸载。
 *
 * 全部跑在临时目录 + 临时端口上，不碰真实 DSH 配置、不读真实审批内容。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { readTokenFile } from '../patch.mjs'

const { apply } = await import('../index.js')

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pet-approval-boot-'))
  const helper = path.join(home, 'profiles', 'desktop', 'node_modules', 'dsh-pet', 'runtime', 'electron-helper')
  fs.mkdirSync(helper, { recursive: true })
  fs.writeFileSync(
    path.join(helper, 'index.html'),
    '<!doctype html><html><body><div id="root"></div></body></html>\n',
  )
  return { home, helper }
}

function freePort() {
  return 41000 + Math.floor(Math.random() * 2000)
}

async function boot() {
  const { home, helper } = makeHome()
  const handlers = []
  let dispose = null
  const ctx = {
    on(event, handler) {
      if (event === 'approval/request') handlers.push(handler)
    },
    effect(fn) {
      dispose = fn()
    },
  }
  const port = freePort()
  apply(ctx, { dshHome: home, ports: [port] })

  const token = readTokenFile(helper)
  assert.ok(token, '凭据文件应当已写入 helper 目录')

  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`, { headers: { 'x-pet-token': token } })
      if (res.ok) break
    } catch {
      /* 还没 listen */
    }
    await new Promise((r) => setTimeout(r, 30))
  }

  const call = (route, init = {}) => fetch(`${base}${route}`, init)
  const api = (route, init = {}) =>
    call(route, {
      ...init,
      headers: { 'x-pet-token': token, 'content-type': 'application/json', ...(init.headers || {}) },
    })

  return {
    home,
    helper,
    token,
    port,
    base,
    call,
    api,
    handler: handlers[0],
    pending: async () => (await (await api('/pending')).json()).items,
    answer: (body) => api('/answer', { method: 'POST', body: JSON.stringify(body) }),
    seen: (id) => api('/seen', { method: 'POST', body: JSON.stringify({ id }) }),
    dispose: () => dispose && dispose(),
  }
}

function approvalRequest(extra = {}) {
  const ctrl = new AbortController()
  return {
    ctrl,
    request: {
      id: 'req-' + Math.random().toString(16).slice(2, 8),
      toolName: 'bash',
      reason: '需要在工作区运行命令',
      signal: ctrl.signal,
      agent: { session: { header: { id: 'session-test' } } },
      ...extra,
    },
  }
}

const never = () => new Promise(() => {})

test('没有凭据时，连 /health 都拿不到', async () => {
  const b = await boot()
  try {
    const unauth = await b.call('/health', { headers: { origin: 'null' } })
    assert.equal(unauth.status, 401)
    assert.equal(unauth.headers.get('access-control-allow-origin'), 'null')
    assert.equal((await b.call('/pending')).status, 401)
    assert.equal((await b.call('/answer', { method: 'POST', body: '{}' })).status, 401)
  } finally {
    b.dispose()
  }
})

test('Origin: null 不是身份凭据，不能绕过鉴权', async () => {
  const b = await boot()
  try {
    const res = await b.call('/health', { headers: { origin: 'null' } })
    assert.equal(res.status, 401)
    const res2 = await b.call('/health', { headers: { origin: 'file://' } })
    assert.equal(res2.status, 401)
  } finally {
    b.dispose()
  }
})

test('伪造的心跳挡在门外：无凭据的 /pending 不会让桌宠看起来在线', async () => {
  const b = await boot()
  try {
    await b.call('/pending')
    const health = await (await b.api('/health')).json()
    assert.equal(health.petOnline, false)
    assert.equal(health.petLastPollAgoMs, null)
  } finally {
    b.dispose()
  }
})

test('错误凭据被拒；正确凭据可用，且响应里不含凭据', async () => {
  const b = await boot()
  try {
    const bad = await b.call('/health', { headers: { 'x-pet-token': 'c'.repeat(64) } })
    assert.equal(bad.status, 401)

    const ok = await b.api('/health')
    assert.equal(ok.status, 200)
    const text = await ok.text()
    assert.ok(!text.includes(b.token), '/health 不能回显凭据')
    const body = JSON.parse(text)
    assert.equal(body.ok, true)
    assert.equal(body.petOnline, false)
  } finally {
    b.dispose()
  }
})

test('高风险：直接 POST /answer 批准会被服务端拒绝，拒绝则放行', async () => {
  const b = await boot()
  try {
    await b.api('/pending') // 让 petOnline 为真
    const { request } = approvalRequest({ toolName: 'read', reason: '读取 ~/.ssh/id_rsa 私钥' })
    const settled = b.handler(request, never)
    await new Promise((r) => setTimeout(r, 50))

    const items = await b.pending()
    assert.equal(items.length, 1)
    assert.equal(items[0].risk, 'high')

    const refused = await b.answer({ id: request.id, outcome: 'allowed-once' })
    assert.equal(refused.status, 403)
    // 被拒绝的批准不能结算掉这条审批
    assert.equal((await b.pending()).length, 1)

    const denied = await b.answer({ id: request.id, outcome: 'rejected' })
    assert.equal(denied.status, 200)
    assert.equal(await settled, 'rejected')
  } finally {
    b.dispose()
  }
})

test('低风险：桌宠批准生效，并把界面那张卡一起收掉', async () => {
  const b = await boot()
  try {
    await b.api('/pending')
    const { request } = approvalRequest({ toolName: 'bash', reason: '在工作区列目录' })
    const settled = b.handler(request, never)
    await new Promise((r) => setTimeout(r, 50))

    const res = await b.answer({ id: request.id, outcome: 'allowed-once' })
    assert.equal(res.status, 200)
    assert.equal(await settled, 'allowed-once')
    // 桌宠先答 → 我们主动 abort 掉换上去的那个 signal，前端卡片随之消失
    assert.equal(request.signal.aborted, true)
  } finally {
    b.dispose()
  }
})

test('界面先答：桌宠随后再点只会拿到 404，结果不会被改写', async () => {
  const b = await boot()
  try {
    await b.api('/pending')
    const { request } = approvalRequest()
    const settled = b.handler(request, () => Promise.resolve('allowed-once'))
    assert.equal(await settled, 'allowed-once')

    await new Promise((r) => setTimeout(r, 50))
    const late = await b.answer({ id: request.id, outcome: 'rejected' })
    assert.equal(late.status, 404)
    assert.equal(await settled, 'allowed-once')
  } finally {
    b.dispose()
  }
})

test('重复点击同一个按钮只结算一次', async () => {
  const b = await boot()
  try {
    await b.api('/pending')
    const { request } = approvalRequest()
    const settled = b.handler(request, never)
    await new Promise((r) => setTimeout(r, 50))

    const first = await b.answer({ id: request.id, outcome: 'allowed-once' })
    const second = await b.answer({ id: request.id, outcome: 'allowed-once' })
    assert.equal(first.status, 200)
    assert.equal(second.status, 404)
    assert.equal(await settled, 'allowed-once')
  } finally {
    b.dispose()
  }
})

test('原始请求被取消 → 结果是 cancelled', async () => {
  const b = await boot()
  try {
    await b.api('/pending')
    const { request, ctrl } = approvalRequest()
    const settled = b.handler(request, never)
    await new Promise((r) => setTimeout(r, 30))
    ctrl.abort()
    assert.equal(await settled, 'cancelled')
  } finally {
    b.dispose()
  }
})

test('桌宠不在线时完全不介入，直接交给对话框', async () => {
  const b = await boot()
  try {
    const { request } = approvalRequest()
    // 没轮询过 → petOnline 为假
    assert.equal(await b.handler(request, () => Promise.resolve('allowed-once')), 'allowed-once')
    assert.equal((await b.pending()).length, 0)
  } finally {
    b.dispose()
  }
})

test('插件卸载：挂起的审批交还下游，服务随后关闭', async () => {
  const b = await boot()
  try {
    await b.api('/pending')
    const { request } = approvalRequest()
    const settled = b.handler(request, never)
    await new Promise((r) => setTimeout(r, 50))

    b.dispose()
    assert.equal(await settled, 'unavailable')

    await new Promise((r) => setTimeout(r, 100))
    await assert.rejects(async () => {
      await fetch(`${b.base}/health`, { headers: { 'x-pet-token': b.token } })
    })
  } finally {
    b.dispose()
  }
})

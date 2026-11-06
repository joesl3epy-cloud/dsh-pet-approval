import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../runtime/pet-approval.js', import.meta.url), 'utf8')
function renderer(storage, reply) {
  let reloads = 0
  const calls = []
  const sandbox = {
    document: { currentScript: { getAttribute: () => 'fixture-credential' }, querySelector: () => null },
    window: {}, console: { log() {} }, AbortController,
    setTimeout() { return 1 }, clearTimeout() {},
    sessionStorage: {
      getItem: k => storage.get(k) || null,
      setItem: (k,v) => storage.set(k,v),
      removeItem: k => storage.delete(k),
    },
    location: { reload() { reloads++ } },
    fetch: async url => {
      calls.push(url)
      const status = reply(url)
      return { ok: status === 200, status, json: async () => ({ items: [] }) }
    },
  }
  // Expose closure functions only in the test VM; production API remains unchanged.
  const instrumented = source.slice(0, source.lastIndexOf('  if (document.readyState')) +
    'globalThis.review = {discover, tick}; })()'
  vm.createContext(sandbox)
  vm.runInContext(instrumented, sandbox)
  return { ...sandbox.review, calls, reloads: () => reloads }
}
const flush = () => new Promise(resolve => setImmediate(resolve))

test('探测继续跳过其他 profile 的 401，找到自己的服务后不刷新', async () => {
  const r = renderer(new Map(), url => url.includes(':49396/') ? 200 : 401)
  assert.equal(await r.discover(), 49396)
  assert.equal(r.reloads(), 0)
  assert.equal(r.calls.length, 2)
})

test('首次探测凭据过期会触发恢复，跨刷新只允许一次；成功后恢复预算', async () => {
  const storage = new Map()
  const first = renderer(storage, () => 401)
  first.tick(); await flush()
  assert.equal(first.calls.length, 6)
  assert.equal(first.reloads(), 1)
  const reloaded = renderer(storage, () => 401)
  reloaded.tick(); await flush()
  assert.equal(reloaded.reloads(), 0)
  const recovered = renderer(storage, () => 200)
  recovered.tick(); await flush()
  assert.equal(storage.has('dpa-auth-reload'), false)
  const rotatedAgain = renderer(storage, () => 401)
  rotatedAgain.tick(); await flush()
  assert.equal(rotatedAgain.reloads(), 1)
})

test('没有服务时不刷新；无法保存刷新预算时也不自动刷新', async () => {
  const r = renderer(new Map(), () => { throw new Error('connection refused') })
  r.tick(); await flush()
  assert.equal(r.reloads(), 0)
  const storage = { get() { throw new Error('storage blocked') } }
  const blocked = renderer(storage, () => 401)
  blocked.tick(); await flush()
  assert.equal(blocked.reloads(), 0)
})

test('监听完成前停用，会关闭迟到的服务，并阻止端口重试', () => {
  const host = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const code = host.slice(host.indexOf('function startServer('), host.indexOf('/* ------------------------------------------------------------------ *', host.indexOf('function startServer(')))
  const servers = []
  const state = { disposed: false, server: null }
  const sandbox = {
    log() {}, handleHttp() {}, send() {},
    http: { createServer() {
      const server = {
        closed: 0,
        on(event, fn) { if (event === 'error') this.error = fn },
        listen(port, addr, fn) { this.ready = fn },
        close() { this.closed++ },
      }
      servers.push(server); return server
    } },
  }
  vm.createContext(sandbox)
  vm.runInContext(code + ';globalThis.start = startServer', sandbox)
  sandbox.start(state, [41001,41002])
  assert.equal(state.server, servers[0])
  state.disposed = true
  state.server.close()
  servers[0].error({ code: 'EADDRINUSE' })
  servers[0].ready()
  assert.equal(servers.length, 1)
  assert.equal(servers[0].closed, 2)
  assert.equal(state.port, undefined)
})

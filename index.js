/**
 * dsh-pet-approval —— 在 dsh-pet 桌宠上直接审批 DSH 的权限请求。
 *
 * 分工：
 *   - 本插件（host 半侧）挂 `approval/request` 瀑布，把请求同时交给"桌宠"和"DSH 对话框"两条通道，
 *     **谁先回答就用谁**（用户明确要求"两边都能点，谁先点算谁的"）；
 *   - 桌宠半侧是 runtime/pet-approval.js，渲染在宠物头顶的气泡卡片上，两个按钮：
 *     「拒绝」/「允许一次」；
 *   - 两边之间的通道是本机回环 HTTP（127.0.0.1:49395–49400），渲染端轮询 /pending，
 *     点击后 POST /answer。之所以不挂 DSH webServer：dsh-pet 的桌面窗口走它自己的 bridge，
 *     第三方路由进不去；独立回环端口不碰 dsh-pet、也不碰 DSH 的网站鉴权。
 *
 * 不抢答的关键：
 *   `next()` 的 'unavailable' 只代表"这一刻没有客户端接住"，不代表用户拒绝；
 *   因此本插件把它当"无人应答"忽略，继续等桌宠；桌宠也会放弃（渲染端不在线 / 卡片没渲染出来 /
 *   一直没人点），那时才回到 GUI 的结果。GUI 永远照常弹卡片，只是可能被桌宠先回答。
 *
 * 安全模型（详见 README「安全模型」）：
 *   回环端口没有登录态，Origin 只是浏览器强加的标签，`Origin: null` 谁都能发，不能当身份用。
 *   真正的凭据是本进程生成的 32 字节随机 token：写进该 profile 的 dsh-pet helper 目录
 *   （index.html 的 data-token + pet-approval-runtime.json），渲染端从 DOM 读出来、
 *   放在 X-Pet-Token 头里。没有 token 的请求连 /health 都拿不到，更别说审批内容。
 *   Origin 校验保留作辅助，但不再是唯一依据。
 *
 * fail-open：本插件任何异常都委托给 next()，绝不让审批链本身挂掉。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { ensureRuntimePatch, newToken, resolveDshHome, resolveProfile } from './patch.mjs'

const name = 'dsh-pet-approval'
const inject = []

const { version: VERSION } = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

/** 回环端口候选：渲染端按同样顺序探测。 */
const PORTS = [49395, 49396, 49397, 49398, 49399, 49400]
/** 卡片样式/文案版本：runtime/pet-approval.js 里的 UI_VERSION 必须与之一致，否则宠物窗口自动刷新。 */
const UI_VERSION = '12'
const OUTCOMES = new Set(['allowed-once', 'rejected', 'cancelled', 'unavailable'])

/** 渲染端心跳窗口：超过这么久没轮询就认为桌宠不在线（只走 GUI）。
 *  不能太小——重启 dsh-pet 的 helper 要 5~7 秒，那段时间会短暂掉线。 */
const PET_ONLINE_MS = 15000
/** 卡片迟迟没被渲染出来（渲染端脚本异常等）→ 放弃桌宠，只等 GUI。 */
const SEEN_TIMEOUT_MS = 20000
/** 桌宠优先窗口：0 = 不排队，桌宠和对话框同时弹。
 *  两边谁先答算谁的；另一边的卡片会在 1~2 秒内自己收起
 *  （桌宠靠 /pending 轮询，对话框靠 approval 结算事件）。 */
const PET_LEAD_MS = 0
/** 看门狗检查卡片未渲染或桌宠断连，不限制用户思考时间。 */
const WATCHDOG_MS = 2000

const STATE_DIR = path.join(resolveDshHome(), 'dsh-pet-approval')
const LOG_FILE = path.join(STATE_DIR, 'host.log')

function log(message) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`)
  } catch {
    /* 诊断写不进去不影响主流程 */
  }
}

function petOnline(state) {
  return state.lastPollAt > 0 && Date.now() - state.lastPollAt < PET_ONLINE_MS
}

/**
 * 风险分级（桌宠卡片用哪套 UI 的唯一依据）。
 *
 * Auto review 自己的 risk 等级不会传进 approval/request（它只传一句英文 reason），
 * 所以这里按"这次审批将要碰到什么"做局部判断：命中凭据 / 系统级 / 外泄 / 不可逆毁坏 → high，
 * 其余一律 medium。medium 只给一个「批准」；high 换成警示样式 + 「查看」，点开去对话框看全文。
 */
const HIGH_RISK_PATTERNS = [
  /\.ssh\b/i,
  /\bid_(rsa|ed25519|ecdsa|dsa)\b/i,
  /private[ _-]?key/i,
  /api[ _-]?key|\bapikey\b|\bsecret\b|\btoken\b|\bcredential/i,
  /cookie|keychain|login\s?data|\.netrc|\bpasswd\b|password/i,
  /\.aws\b|\.gnupg\b|\.kube\b|\.docker\/config/i,
  /\bsudo\b|\bsu\s+-|\blaunchctl\b|\bkextload\b|\bcsrutil\b|\btccutil\b|\bspctl\b|\bnvram\b/i,
  /^\s*\/etc\/|\/System\/|\/Library\/(LaunchDaemons|LaunchAgents|Keychains)/,
  /\bchmod\s+[0-7]?[0-7]{3}\b|\bchown\s+root\b/i,
  /curl[^\n]*(-d|--data|--upload-file|-F|-T)\b|wget[^\n]*--post|base64[^\n]*-d[^\n]*\|\s*(sh|bash)/i,
  /\brm\s+-rf?\s+\/[^t]|\brm\s+-rf\s+~[^/]*\/?$|mkfs|\bdd\s+if=/i,
  /Auto review of tool .* failed/i,
]

function assessRisk(item) {
  const text = `${item.reason || ''}\n${item.toolName || ''}`
  for (const pattern of HIGH_RISK_PATTERNS) {
    if (pattern.test(text)) return 'high'
  }
  return 'medium'
}

function publicItem(item) {
  return {
    id: item.id,
    toolName: item.toolName,
    reason: item.reason,
    createdAt: item.createdAt,
    risk: assessRisk(item),
    // 已经点过「查看」、把决定权交回对话框了：卡片留着显示这个状态，不再给按钮
    viewed: item.viewed === true,
  }
}

/**
 * 把 DSH 窗口叫到最前面（高风险「查看」用），并尽量切到产生这条审批的会话。
 *
 * DSH 前端是内存状态、没有 URL 路由（grep 过 dsh-web-frontend 的 dist：无 searchParams / 无 #/session），
 * 所以切会话只能靠 Electron 主进程里的 BrowserWindow + 在页面里点侧栏那一项；拿不到就退化成
 * `open -a "DeepSeek Harness"` 只激活窗口。失败一律不影响审批链。
 */
async function focusDsh(sessionId) {
  let focused = false
  try {
    // 插件宿主未必暴露 Electron 通道：import('electron') 可能挂住，所以限时 1.5 秒。
    const electron = await Promise.race([
      import('electron'),
      new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
    ])
    const app = electron && electron.app
    const BrowserWindow = electron && electron.BrowserWindow
    if (app && typeof app.focus === 'function') app.focus({ steal: true })
    const windows = BrowserWindow && typeof BrowserWindow.getAllWindows === 'function' ? BrowserWindow.getAllWindows() : []
    for (const win of windows) {
      if (!win || win.isDestroyed()) continue
      if (win.show) win.show()
      if (win.focus) win.focus()
      focused = true
      if (sessionId && win.webContents && typeof win.webContents.executeJavaScript === 'function') {
        const script = `(() => {
          const id = ${JSON.stringify(String(sessionId))}
          const nodes = document.querySelectorAll('[data-session-id]')
          for (const node of nodes) {
            if (node.getAttribute('data-session-id') === id) { node.click(); return 'clicked:' + nodes.length }
          }
          return 'no-match:' + nodes.length
        })()`
        const result = await Promise.race([
          win.webContents.executeJavaScript(script, true),
          new Promise((resolve) => setTimeout(() => resolve('timeout'), 1500)),
        ])
        log(`focus dsh session=${sessionId} -> ${result}`)
      }
      break
    }
    if (!focused) log(`focus dsh: electron gave no window (session=${sessionId || '-'})`)
  } catch (error) {
    log(`focus via electron failed: ${error && error.message ? error.message : error}`)
  }
  if (focused) return true
  try {
    // open -a 只是激活 app；osascript activate 会把主窗口顶到最前，失败再退回 open -a
    const child = execFile(
      'osascript',
      ['-e', 'tell application "DeepSeek Harness" to activate'],
      { timeout: 5000 },
      (error) => {
        if (error) {
          log(`focus dsh: osascript failed (${error.message}), trying open -a`)
          execFile('open', ['-a', 'DeepSeek Harness'], { timeout: 5000 }, () => {})
        }
      },
    )
    if (child && child.on) child.on('error', () => {})
    log(`focus dsh: activate via osascript (session=${sessionId || '-'})`)
  } catch (error) {
    log(`focus dsh: activate threw ${error && error.message ? error.message : error}`)
  }
  return false
}

/* ------------------------------------------------------------------ *
 * 审批瀑布：桌宠 & GUI 两条通道，谁先回答算谁的
 * ------------------------------------------------------------------ */

function makeApprovalHandler(state) {
  return function onApprovalRequest(request, next) {
    try {
      if (!state.enabled) return next()
      if (!petOnline(state)) return next() // 桌宠没开：完全交给 GUI，连记录都不留

      const id = request && request.id != null ? String(request.id) : `pet-${Date.now()}-${Math.random().toString(16).slice(2)}`
      const agent = request && request.agent ? request.agent : undefined
      const session = agent && agent.session ? agent.session : undefined
      const header = session && session.header ? session.header : undefined
      const item = {
        id,
        toolName: request && request.toolName ? String(request.toolName) : 'tool',
        reason: request && typeof request.reason === 'string' ? request.reason : '',
        sessionId: header && header.id != null ? String(header.id) : undefined,
        createdAt: Date.now(),
        seen: false,
        resolve: null,
        expire: null,
      }
      log(`asked id=${id} tool=${item.toolName} risk=${assessRisk(item)}`)

      return new Promise((resolve) => {
        let settled = false
        let petDone = false
        let guiDone = false
        let guiValue
        /** 断开"原 signal → 我们的 signal"的转发，避免监听器挂在别人的 signal 上。 */
        let detachOrigAbort = null

        const cleanup = () => {
          state.pending.delete(id)
          if (request && request.signal && request.signal.removeEventListener) {
            request.signal.removeEventListener('abort', onAbort)
          }
          if (detachOrigAbort) {
            detachOrigAbort()
            detachOrigAbort = null
          }
        }
        let finish = (value, via) => {
          if (settled) return
          settled = true
          cleanup()
          log(`decided id=${id} via=${via} outcome=${value}`)
          resolve(value)
        }
        const onAbort = () => finish('cancelled', 'abort')
        const tryFinishUnavailable = (why) => {
          if (settled) return
          if (petDone && guiDone && guiValue === 'unavailable') finish('unavailable', why)
        }

        item.resolve = (outcome) => {
          if (settled) return false
          // petDone 只表示"桌宠这一侧已经给过答案/我们不再等它"，不代表这一格没人要了。
          // 之前 expire 过（比如 helper 重启导致 petOnline 掉线 5 秒）仍然接受迟到的一票，
          // 否则用户会看到卡片还在、点了也返回 200，但审批纹丝不动。
          const late = petDone
          petDone = true
          log(`pet answered id=${id} outcome=${outcome}${late ? ' (late-after-expire)' : ''}`)
          if (OUTCOMES.has(outcome)) {
            finish(outcome, 'pet')
            return true
          }
          tryFinishUnavailable('pet-invalid')
          return false
        }
        item.expire = (why) => {
          if (settled || petDone) return
          petDone = true
          log(`pet gave up id=${id} (${why})`)
          tryFinishUnavailable('pet-expired')
        }
        /** 看门狗用：桌宠通道是否还在等。 */
        item.petWaiting = () => !settled && !petDone
        /** 插件卸载用：把请求交还下游，别让上游的工具调用永远挂着。 */
        item.cancel = (why) => {
          log(`cancel id=${id} (${why})`)
          finish('unavailable', 'dispose')
        }

        state.pending.set(id, item)

        // 把请求自带的取消开关换成我们可控的同款开关。
        // 原因：官方的待批准面板只有三条结束路径——用户点、委托下去、signal 被 abort。
        // 桌宠先答时前两条都走不通，面板就会一直挂着。换上我们的 signal 之后，
        // 桌宠答完我们主动 abort 一下，界面那张卡立刻收起。
        // 原 signal 的取消能力原样转发进来，上游取消照样有效。
        let guiAbort = null
        try {
          const orig = request && request.signal
          const ctrl = new AbortController()
          if (orig && typeof orig.addEventListener === 'function') {
            const forward = () => ctrl.abort(orig.reason)
            if (orig.aborted) ctrl.abort(orig.reason)
            else {
              orig.addEventListener('abort', forward, { once: true })
              detachOrigAbort = () => {
                try {
                  orig.removeEventListener('abort', forward)
                } catch {
                  /* 已经移除 */
                }
              }
            }
          }
          const before = request && request.signal
          request.signal = ctrl.signal
          if (request.signal === ctrl.signal) {
            guiAbort = () => {
              try {
                ctrl.abort(new Error('answered on desktop pet'))
              } catch (error) {
                /* 已经 abort 过就算了 */
              }
            }
            log(`signal swapped id=${id} had=${before ? 'yes' : 'no'}`)
          } else {
            log(`swap fail id=${id} (signal is read-only)`)
          }
        } catch (error) {
          log(`swap fail id=${id} (${error && error.message ? error.message : error})`)
        }

        if (request && request.signal) {
          if (request.signal.aborted) {
            finish('cancelled')
            return
          }
          request.signal.addEventListener('abort', onAbort, { once: true })
        }

        // GUI 通道：立刻调用 next()，两边同时弹。
        // 谁先答算谁的：桌宠答了 → GUI 卡收到结算事件自己收；
        // GUI 答了 → 桌宠下一轮 /pending 发现条目没了，卡片也自己收。
        // next() 返回 'unavailable' 时不能当成拒绝——那只是"当前没有客户端"，继续等桌宠。
        let guiStarted = false
        const startGui = () => {
          if (settled || guiStarted) return
          guiStarted = true
          leadTimer = null
          log(`gui handoff id=${id} (parallel)`)
          Promise.resolve()
            .then(() => next())
            .then(
              (value) => {
                guiDone = true
                guiValue = value
                if (value && value !== 'unavailable') finish(value, 'gui')
                else tryFinishUnavailable('gui-unavailable')
              },
              (error) => {
                guiDone = true
                guiValue = 'unavailable'
                log(`gui answerer threw: ${error && error.message ? error.message : error}`)
                tryFinishUnavailable('gui-error')
              },
            )
        }
        let leadTimer = setTimeout(startGui, PET_LEAD_MS)
        if (leadTimer && typeof leadTimer.unref === 'function') leadTimer.unref()

        // 卡片渲染出来不再顺延独占窗口——两边本来就同时可见
        item.extendLead = () => {
          if (settled || guiStarted) return
          log(`pet saw card id=${id} (no lead extension)`)
        }

        // finish 时清掉这个定时器：桌宠先答就不再把请求交给对话框
        const finishOuter = finish
        finish = (value, via) => {
          if (leadTimer) {
            clearTimeout(leadTimer)
            leadTimer = null
          }
          finishOuter(value, via)
          // 桌宠先答：把界面那张卡收掉（扳我们自己装上去的那个开关）
          if (via === 'pet' && guiAbort && !guiDone) {
            log(`abort gui id=${id}`)
            guiAbort()
          }
        }
      })
    } catch (error) {
      log(`approval hook failed: ${error && error.message ? error.message : error}`)
      return next()
    }
  }
}

/* ------------------------------------------------------------------ *
 * 回环 HTTP：桌宠渲染端 <-> 本插件
 * ------------------------------------------------------------------ */

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > 64 * 1024) {
        chunks.length = 0
        done('')
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => done(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => done(''))
  })
}

/**
 * 来源校验：只作为**辅助**措施。
 * file:// 页面在 Electron 里发 `Origin: null`，但 `Origin: null` 并不是 Electron 独有的——
 * sandbox iframe、data: URL 页面同样会发 null。所以它不能当身份凭据，真正的凭据见 tokenOk。
 */
function trustedOrigin(req) {
  const origin = req.headers.origin
  return origin === undefined || origin === 'null' || origin === 'file://'
}

/** 恒定时间比较 token（长度不等直接 false）。 */
function tokenOk(state, req) {
  const raw = req.headers['x-pet-token']
  if (typeof raw !== 'string' || raw.length < 32) return false
  if (state.tokens.size === 0) return false
  const given = Buffer.from(raw, 'utf8')
  for (const token of state.tokens) {
    const expected = Buffer.from(token, 'utf8')
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return true
  }
  return false
}

function send(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

async function handleHttp(state, req, res) {
  // CORS 预检不携带自定义头，必须先放行，否则渲染端永远发不出真请求。
  // 预检本身不返回任何数据，放行它不构成信息泄漏。
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': req.headers.origin === 'file://' ? 'file://' : 'null',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type, x-pet-token',
      'access-control-max-age': '600',
      vary: 'origin',
    })
    res.end()
    return
  }

  if (!trustedOrigin(req)) {
    send(res, 403, { ok: false, error: 'forbidden origin' })
    return
  }
  // Expose authentication failures to file:// clients so they can recover after rotation.
  res.setHeader('access-control-allow-origin', req.headers.origin === 'file://' ? 'file://' : 'null')
  res.setHeader('vary', 'origin')
  // 没有凭据的请求连 /health 都不给：避免任意网页或本机进程枚举待审批项。
  if (!tokenOk(state, req)) {
    send(res, 401, { ok: false, error: 'unauthorized' })
    return
  }
  let url
  try {
    url = new URL(req.url || '/', 'http://127.0.0.1')
  } catch {
    send(res, 400, { ok: false })
    return
  }
  const route = url.pathname

  if (req.method === 'GET' && route === '/health') {
    send(res, 200, {
      ok: true,
      port: state.port,
      pending: state.pending.size,
      version: VERSION,
      // 卡片样式版本：渲染端发现不一致会自动刷新宠物窗口（改 UI 不用重启桌宠）
      ui: UI_VERSION,
      // 诊断用：桌宠渲染端多久前轮询过（null = 从没连上，说明 index.html 补丁没生效）
      petLastPollAgoMs: state.lastPollAt > 0 ? Date.now() - state.lastPollAt : null,
      petOnline: petOnline(state),
    })
    return
  }

  if (req.method === 'GET' && route === '/pending') {
    state.lastPollAt = Date.now()
    const items = [...state.pending.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(publicItem)
    send(res, 200, { ok: true, items })
    return
  }

  if (req.method === 'POST' && route === '/seen') {
    async function markSeen() {
      const raw = await readBody(req)
      let body = {}
      try {
        body = JSON.parse(raw || '{}')
      } catch {
        send(res, 400, { ok: false, error: 'bad json' })
        return
      }
      state.lastPollAt = Date.now()
      const item = state.pending.get(String(body.id))
      if (!item) {
        send(res, 404, { ok: false, error: 'unknown approval' })
        return
      }
      if (!item.seen) {
        item.seen = true
        log(`pet saw id=${item.id} tool=${item.toolName} risk=${assessRisk(item)}`)
        if (item.extendLead) item.extendLead()
      }
      send(res, 200, { ok: true })
    }
    await markSeen()
    return
  }

  if (req.method === 'POST' && route === '/answer') {
    async function answer() {
      const raw = await readBody(req)
      let body = {}
      try {
        body = JSON.parse(raw || '{}')
      } catch {
        send(res, 400, { ok: false, error: 'bad json' })
        return
      }
      const id = String(body.id ?? '')
      const outcome = String(body.outcome ?? '')
      const item = state.pending.get(id)
      if (!item) {
        // 卡片还挂在桌面上、但这一项已经结束（多半是对话框那边先答了）：留个痕方便对照
        log(`answer for unknown id=${id} outcome=${outcome} (already resolved elsewhere)`)
        send(res, 404, { ok: false, error: 'unknown approval' })
        return
      }
      if (outcome === 'view') {
        // 高风险「查看」：卡片原地转成"已转去对话框"并留着，真正的批准/拒绝仍然回 DSH 对话框做。
        state.lastPollAt = Date.now()
        item.viewed = true
        log(`view id=${id} risk=${assessRisk(item)}`)
        focusDsh(item.sessionId)
        send(res, 200, { ok: true, action: 'view' })
        return
      }
      if (outcome !== 'allowed-once' && outcome !== 'rejected') {
        send(res, 400, { ok: false, error: 'bad outcome' })
        return
      }
      // 第二道闸：渲染端对高风险请求已经只给「拒绝 / 查看」，这里再挡一次，
      // 免得直接 POST /answer 就能绕过。拒绝永远允许——拒绝不需要额外授权。
      // ⚠️ 这是**启发式**判定（见 assessRisk 的注释），不是完整安全防护。
      if (outcome === 'allowed-once' && assessRisk(item) === 'high') {
        log(`refuse pet-approve id=${id} risk=high`)
        send(res, 403, { ok: false, error: 'high-risk requires the DSH dialog' })
        return
      }
      state.lastPollAt = Date.now()
      const acted = item.resolve(outcome)
      if (!acted) {
        log(`answer ignored id=${id} outcome=${outcome} (already settled)`)
        send(res, 409, { ok: false, error: 'already settled' })
        return
      }
      send(res, 200, { ok: true })
    }
    await answer()
    return
  }

  send(res, 404, { ok: false })
}

function startServer(state, ports) {
  let index = 0
  const attempt = () => {
    if (state.disposed) return
    if (index >= ports.length) {
      log('no free loopback port for pet approval; falling back to GUI only')
      return
    }
    const port = ports[index++]
    const server = http.createServer((req, res) => {
      void handleHttp(state, req, res).catch((error) => {
        log(`http handler failed: ${error && error.message ? error.message : error}`)
        try {
          send(res, 500, { ok: false })
        } catch {
          /* 连接已断 */
        }
      })
    })
    state.server = server // Track ownership before asynchronous listen completes.
    server.on('error', (error) => {
      if (state.disposed) return
      if (error && error.code === 'EADDRINUSE') attempt()
      else log(`server error: ${error && error.message ? error.message : error}`)
    })
    server.listen(port, '127.0.0.1', () => {
      if (state.disposed) { server.close(); return }
      state.port = port
      state.server = server
      log(`listening on 127.0.0.1:${port}`)
    })
  }
  attempt()
}

/* ------------------------------------------------------------------ *
 * 插件入口
 * ------------------------------------------------------------------ */

function apply(ctx, config) {
  const state = {
    enabled: !(config && config.enabled === false),
    disposed: false,
    pending: new Map(),
    lastPollAt: 0,
    port: null,
    server: null,
    /** 只接受本 profile 那枚 token（正常情况下集合里只有一枚）。 */
    tokens: new Set(),
    profile: null,
    dshHome: resolveDshHome(config && config.dshHome),
  }

  if (!state.enabled) {
    log('disabled by config')
    return
  }

  // 1) 生成本次进程的凭据，并把 dsh-pet 渲染端补丁落到**本 profile** 的 helper 目录。
  //    幂等：dsh-pet 升级覆盖 index.html 后，下次启动自动补回；token 变化只替换我们那一行。
  try {
    const token = newToken()
    const profile = config && typeof config.profile === 'string' ? config.profile : resolveProfile()
    const { dirs, report } = ensureRuntimePatch({ dshHome: state.dshHome, token, profile })
    state.profile = profile || null
    if (dirs.length > 0) state.tokens.add(token)
    // 只记结果，不记 token 本身
    log(`runtime patch: profile=${profile || 'unknown'} dirs=${dirs.length} ` +
      report.map((r) => `${r.file}:${r.action}${r.message ? ':' + r.message : ''}`).join(','))
    if (dirs.length === 0) log('no dsh-pet helper found: pet channel stays dark (GUI only)')
  } catch (error) {
    log(`runtime patch failed: ${error && error.message ? error.message : error}`)
  }

  // 2) 挂审批瀑布（prepend：抢在 remote 转发之前注册，先走我们的双通道）
  const handler = makeApprovalHandler(state)
  ctx.on('approval/request', handler, { prepend: true })

  // 3) 回环 HTTP（测试可以注入端口，避免和真实实例抢 49395 起的那一段）
  const ports = config && Array.isArray(config.ports) && config.ports.length > 0 ? config.ports : PORTS
  startServer(state, ports)

  // 4) 看门狗：只做"放弃桌宠通道"，从不结束仍在被人等待的审批。
  //    审批只有四种收场——桌宠批、对话框批、请求被取消、两条通道都不可用。
  //    "等太久就自己消失"是绝对不能有的行为：人离开电脑多久，提醒就该等多久。
  const watchdog = setInterval(() => {
    if (state.pending.size === 0) return
    const now = Date.now()
    const online = petOnline(state)
    for (const item of state.pending.values()) {
      if (typeof item.petWaiting === 'function' && !item.petWaiting()) continue
      const age = now - item.createdAt
      if (!item.seen && age > SEEN_TIMEOUT_MS) {
        item.expire('card never rendered')
        continue
      }
      if (item.seen && !online) {
        item.expire('pet went offline')
        continue
      }
      if (age > 30 * 60 * 1000 && !item.warned) {
        item.warned = true
        log(`pending long id=${item.id} age=${Math.round(age / 1000)}s (card kept, still waiting)`)
      }
    }
  }, WATCHDOG_MS)
  if (watchdog && typeof watchdog.unref === 'function') watchdog.unref()

  // 5) 卸载清理：停服务、停定时器、把所有还挂着的审批交还下游（unavailable），
  //    不能让 promise 永远悬着——那会卡住上游的工具调用。
  try {
    ctx.effect(() => () => {
      state.disposed = true
      state.enabled = false
      clearInterval(watchdog)
      for (const item of [...state.pending.values()]) {
        try {
          if (typeof item.cancel === 'function') item.cancel('plugin disposed')
        } catch {
          /* 单条失败不影响其余 */
        }
      }
      state.pending.clear()
      if (state.server) {
        try {
          state.server.close()
        } catch {
          /* 已经关了，或还没 listen 完 */
        }
      }
      state.server = null
      state.tokens.clear()
    })
  } catch {
    /* 老版本 cordis 没有 effect：进程退出时由 OS 回收 */
  }

  log('plugin applied')
}

export { apply, inject, name }

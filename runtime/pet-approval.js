/**
 * dsh-pet-approval —— 桌宠端审批卡片（渲染端注入脚本，属于 dsh-pet-approval 插件）。
 *
 * 由插件自动放进 dsh-pet 的 runtime/electron-helper/ 目录，并在 index.html 末尾加载。
 * 它依赖下文列出的 dsh-pet 渲染端内部方法，并做能力检查，主要做三件事：
 *   1. 轮询本机回环的审批服务（127.0.0.1:49395–49400）；
 *   2. 在宠物头顶画一张小气泡卡片：「拒绝」/「允许一次」；
 *   3. 让卡片区域能被点击（dsh-pet 的窗口默认点击穿透，交互区要显式上报）。
 *
 * 第 3 步通过包装 PetSprite 的三个原型方法完成（不修改 dsh-pet 源码）：
 *   - inputBusy()          → 卡片存在时视为"正在用输入"
 *   - syncInputRegions()   → 把卡片矩形并进上报的控件区
 *   - setInteractive()     → 卡片存在时强制可交互，免得鼠标移出宠物身体就穿透
 * 拿不到 sprite 实例时直接向 preload 的 petBridge 上报同样的数据兜底。
 */

(function () {
  'use strict'

  var TAG = '[dsh-pet-approval]'
  var PORTS = [49395, 49396, 49397, 49398, 49399, 49400]
  var POLL_MS = 300
  var TIMEOUT_MS = 1500
  /** 卡片样式/文案版本：host 的 /health 里带同一个值，不一致就自动刷新窗口（改 UI 不用重启桌宠）。 */
  var UI_VERSION = '12'

  var port = null
  var discovering = null
  var card = null
  var cardId = null
  var cardState = ''
  var seen = new Set()
  /** 只记最近一个 PetSprite 实例：dsh-pet 只会有一个，长期保留 Set 是内存泄漏。 */
  var sprite = null
  var resizeObserver = null
  // sessionStorage survives reload; reset the budget only after authenticated polling succeeds.
  var RELOAD_KEY = 'dpa-auth-reload'
  function reloadForAuth() {
    try {
      if (sessionStorage.getItem(RELOAD_KEY)) return
      sessionStorage.setItem(RELOAD_KEY, '1')
      location.reload()
    } catch (e) {
      log('Cannot persist reload budget; reopen the pet window to refresh credentials')
    }
  }
  function authRecovered() {
    try { sessionStorage.removeItem(RELOAD_KEY) } catch (e) {}
  }

  /**
   * 访问凭据：由插件在打补丁时写进 <script data-token="…">。
   * 不放进 URL、不放进日志；拿不到就说明补丁没打上，此时连不上 host（401），
   * 卡片不出现、退回对话框审批——安全失败。
   */
  var TOKEN = (function () {
    try {
      var el = document.currentScript
      if (el && el.getAttribute('data-token')) return el.getAttribute('data-token')
    } catch (e) {
      /* 某些环境下取不到 currentScript */
    }
    try {
      var tag = document.querySelector('script[data-dsh-pet-approval]')
      return tag ? tag.getAttribute('data-token') : null
    } catch (e) {
      return null
    }
  })()

  function log() {
    try {
      var args = Array.prototype.slice.call(arguments)
      args.unshift(TAG)
      console.log.apply(console, args)
    } catch (e) {
      /* 日志失败无所谓 */
    }
  }

  /* ----------------------------- 与 host 通信 ----------------------------- */

  function call(p, route, init) {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null
    var timer = ctrl ? setTimeout(function () { ctrl.abort() }, TIMEOUT_MS) : null
    var opts = Object.assign({ cache: 'no-store' }, init || {})
    var headers = Object.assign({}, opts.headers || {})
    if (TOKEN) headers['x-pet-token'] = TOKEN
    opts.headers = headers
    if (ctrl) opts.signal = ctrl.signal
    return fetch('http://127.0.0.1:' + p + route, opts).then(
      function (res) {
        if (timer) clearTimeout(timer)
        if (!res.ok) throw new Error('http ' + res.status)
        return res.json()
      },
      function (err) {
        if (timer) clearTimeout(timer)
        throw err
      },
    )
  }

  function discover() {
    if (port !== null) return Promise.resolve(port)
    if (discovering !== null) return discovering
    discovering = (async function () {
      var rejected = false
      for (var i = 0; i < PORTS.length; i++) {
        try {
          await call(PORTS[i], '/health')
          port = PORTS[i]
          log('host on ' + port)
          return port
        } catch (e) {
          // Another profile may own this port: scan all candidates before recovering.
          if (/http (401|403)/.test(String(e && e.message))) rejected = true
        }
      }
      if (rejected) throw new Error('http 401: no matching authenticated host')
      return null
    })().then(
      function (value) {
        discovering = null
        return value
      },
      function (err) {
        discovering = null
        throw err
      },
    )
    return discovering
  }

  function postJson(p, route, body) {
    return call(p, route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  /* -------------------------------- 卡片 UI ------------------------------- */

  var CSS = [
    /* v4 极简卡片：一句话 + 两个按钮，一排就够。
       —— 用户要求：只告诉我"有权限要批"，别摆细节；细节在对话框和 hover 提示里。
       位置贴头顶、允许压进身体一点（同 .pet-bubble 的 -.108），避免被窗口顶部裁掉。 */
    '.dpa-card{position:absolute;left:50%;transform:translateX(-50%);bottom:calc(100% - var(--pet-size,462px) * .108);z-index:20;box-sizing:border-box;',
    'display:flex;align-items:center;gap:calc(var(--pet-size,462px) * .018);',
    'padding:calc(var(--pet-size,462px) * .013) calc(var(--pet-size,462px) * .016) calc(var(--pet-size,462px) * .013) calc(var(--pet-size,462px) * .03);',
    'border-radius:999px;background:#fff;color:#23262b;',
    'font-family:"ShangshouSoftCandy","Yuanti SC","YouYuan","PingFang SC","Microsoft YaHei",sans-serif;',
    'font-size:calc(var(--pet-size,462px) * .034);line-height:1.25;',
    'box-shadow:0 3px 12px rgba(0,0,0,.18),0 1px 2px rgba(0,0,0,.1);pointer-events:auto;user-select:none;-webkit-user-select:none;}',
    /* 审批期间把普通说话气泡让开，别两坨叠在一起 */
    '.pet-sprite:has(.dpa-card) .pet-bubble{opacity:0 !important;visibility:hidden !important;}',
    '.dpa-tip{font-weight:600;white-space:nowrap;}',
    '.dpa-actions{display:flex;align-items:center;gap:calc(var(--pet-size,462px) * .012);}',
    '.dpa-btn{pointer-events:auto;cursor:pointer;border:none;border-radius:999px;',
    'padding:calc(var(--pet-size,462px) * .010) calc(var(--pet-size,462px) * .026);',
    'font-size:calc(var(--pet-size,462px) * .031);font-family:inherit;line-height:1.35;transition:filter .15s ease;}',
    '.dpa-btn:hover{filter:brightness(.94);}',
    /* 点下去立刻给反馈：按钮禁用 + 卡片压暗，等主机确认后由轮询收卡 */
    '.dpa-btn:disabled{cursor:default;filter:grayscale(.35);opacity:.55;}',
    '.dpa-card.is-busy{opacity:.78;}',
    '.dpa-deny{background:#f0f1f3;color:#3d4148;}',
    '.dpa-allow{background:#1f7ae0;color:#fff;}',
    /* 高风险变体：橙色警戒底 + 边框，按钮换成「查看」——点它只把 DSH 窗口叫到前面，
       真正的授权仍然要在对话框里按。 */
    '.dpa-card.is-high{background:#fff6ec;color:#6b3410;box-shadow:0 0 0 calc(var(--pet-size,462px) * .0035) rgba(214,109,26,.65),0 3px 12px rgba(0,0,0,.18);}',
    '.dpa-card.is-high .dpa-tip{color:#a5500f;}',
    '.dpa-view{background:#c2620f;color:#fff;}',
    /* 点过「查看」之后：卡片留在原地变灰，表示"决定权已经交回对话框"，不给人已批准的错觉 */
    '.dpa-card.is-viewed{background:#f2f3f5;color:#6b7078;box-shadow:0 2px 8px rgba(0,0,0,.12);}',
    '.dpa-dots{font-size:.95em;opacity:.7;padding:0 .01em;}',
  ].join('')

  function injectStyle() {
    if (document.getElementById('dpa-style')) return
    var style = document.createElement('style')
    style.id = 'dpa-style'
    style.textContent = CSS
    document.head.appendChild(style)
  }

  function sc(v) {
    return typeof toScreen === 'function' ? toScreen(v) : v
  }

  function cardRects() {
    var rects = []
    if (!card) return rects
    var r = card.getBoundingClientRect()
    if (r.width > 0 && r.height > 0) {
      rects.push({ x: sc(r.x), y: sc(r.y), width: sc(r.width), height: sc(r.height) })
    }
    return rects
  }

  function removeCard() {
    if (resizeObserver) {
      try {
        resizeObserver.disconnect()
      } catch (e) {
        /* ignore */
      }
      resizeObserver = null
    }
    if (card && card.parentNode) card.parentNode.removeChild(card)
    card = null
    cardId = null
    cardState = ''
    refreshSprites()
  }

  function ensureCard() {
    if (card) return card
    var host = document.querySelector('.pet-sprite') || document.getElementById('root')
    if (!host) return null
    var el = document.createElement('div')
    el.className = 'dpa-card'
    el.innerHTML =
      '<span class="dpa-tip"></span>' +
      '<div class="dpa-actions">' +
      '<button type="button" class="dpa-btn dpa-deny" data-outcome="rejected">拒绝</button>' +
      '<button type="button" class="dpa-btn dpa-allow" data-outcome="allowed-once">批准</button>' +
      '</div>'
    el.addEventListener('pointerdown', function (e) {
      e.stopPropagation()
    })
    el.addEventListener('click', function (e) {
      var target = e.target
      var btn = target && target.closest ? target.closest('[data-outcome]') : null
      if (!btn) return
      e.preventDefault()
      e.stopPropagation()
      var outcome = btn.getAttribute('data-outcome')
      answer(cardId, outcome, btn)
    })
    host.appendChild(el)
    card = el
    try {
      if (typeof ResizeObserver === 'function') {
        resizeObserver = new ResizeObserver(function () {
          refreshSprites()
        })
        resizeObserver.observe(el)
      }
    } catch (err) {
      resizeObserver = null
      /* 老 Chromium 没有 ResizeObserver：靠轮询也会更新 */
    }
    return el
  }

  /** reason → 一行短句：去掉固定的"升级沙箱"前缀、压掉换行，太长就截断（细节留给对话框）。 */
  function summarize(reason) {
    var text = String(reason || '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!text) return '需要你的授权才能继续'
    text = text
      .replace(/^escalate (the )?sandbox to [a-z-]+\s*[:：]?\s*/i, '')
      .replace(/^escalate (permission|approval)[^:：]*[:：]\s*/i, '')
      .trim()
    if (!text) return '需要你的授权才能继续'
    return text.length > 46 ? text.slice(0, 45) + '…' : text
  }

  function renderCard(item, more) {
    injectStyle()
    var el = ensureCard()
    if (!el) return
    /* 状态串：同一条审批从"待办"转成"已转去对话框"时也要重画，所以不能只看 id */
    var state = item.id + '|' + (item.viewed ? 'v' : '') + '|' + more
    if (state === cardState) return
    cardState = state
    /* 状态换了就是另一条审批/另一种形态：上一轮的"已提交"反馈必须复位，
       否则新卡片会出现按钮永远灰着的情况。 */
    clearBusy()
    cardId = item.id
    var viewed = item.viewed === true
    var high = item.risk === 'high' && !viewed
    el.classList.toggle('is-high', high)
    el.classList.toggle('is-viewed', viewed)
    var tipEl = el.querySelector('.dpa-tip')
    if (tipEl) {
      tipEl.textContent = viewed
        ? '已转去对话框'
        : high
          ? '高风险 · 需确认'
          : more > 0
            ? '需要授权 +' + more
            : '需要授权'
    }
    var actions = el.querySelector('.dpa-actions')
    if (actions) {
      /* 用 data-state 记住当前按钮组合，避免每次轮询都重写 innerHTML（会打断按下态） */
      var wantState = viewed ? 'viewed' : high ? 'high' : 'normal'
      if (actions.getAttribute('data-state') !== wantState) {
        actions.setAttribute('data-state', wantState)
        actions.innerHTML = viewed
          ? '<span class="dpa-dots">⏳</span>'
          : high
            ? '<button type="button" class="dpa-btn dpa-deny" data-outcome="rejected">拒绝</button>' +
              '<button type="button" class="dpa-btn dpa-view" data-outcome="view">查看</button>'
            : '<button type="button" class="dpa-btn dpa-deny" data-outcome="rejected">拒绝</button>' +
              '<button type="button" class="dpa-btn dpa-allow" data-outcome="allowed-once">批准</button>'
      }
    }
    /* 细节不占视觉：鼠标悬停时在系统提示里看工具名和理由 */
    el.title = (item.toolName || 'tool') + (item.reason ? ' · ' + summarize(item.reason) : '')
    refreshSprites()
    reportSeen(item.id)
  }

  function applyItems(items) {
    if (!items || items.length === 0) {
      if (card) removeCard()
      return
    }
    renderCard(items[0], items.length - 1)
  }

  function reportSeen(id) {
    if (seen.has(id)) return
    seen.add(id)
    if (seen.size > 200) seen.clear()
    if (port === null) return
    postJson(port, '/seen', { id: id }).catch(function () {})
  }

  /** 乐观反馈：点下去的瞬间就告诉用户"收到了"，别等轮询。 */
  function markBusy(btn) {
    if (!card) return
    card.classList.add('is-busy')
    var tipEl = card.querySelector('.dpa-tip')
    if (tipEl && !tipEl.getAttribute('data-orig')) {
      tipEl.setAttribute('data-orig', tipEl.textContent || '')
      tipEl.textContent = '已提交…'
    }
    var buttons = card.querySelectorAll('.dpa-btn')
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = true
    if (btn) btn.disabled = true
  }

  function clearBusy() {
    if (!card) return
    card.classList.remove('is-busy')
    var tipEl = card.querySelector('.dpa-tip')
    var orig = tipEl && tipEl.getAttribute('data-orig')
    if (orig) {
      tipEl.removeAttribute('data-orig')
      tipEl.textContent = orig
    }
    var buttons = card.querySelectorAll('.dpa-btn')
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = false
  }

  /** 一次性拉取，不给轮询再加一条链。 */
  var pulling = false
  function pullOnce() {
    if (pulling) return
    var p = port
    if (p === null) return
    pulling = true
    call(p, '/pending')
      .then(function (data) {
        if (data) applyItems(Array.isArray(data.items) ? data.items : [])
      })
      .catch(function () {})
      .then(function () {
        pulling = false
      })
  }

  function answer(id, outcome, btn) {
    if (!id) return
    markBusy(btn)
    var p = port
    if (p === null) {
      discover().then(function (found) {
        if (found === null) {
          clearBusy()
          return
        }
        postJson(found, '/answer', { id: id, outcome: outcome })
          .then(function () {
            pullOnce()
          })
          .catch(function () {
            clearBusy()
          })
      })
      return
    }
    postJson(p, '/answer', { id: id, outcome: outcome })
      .then(function () {
        /* 不在这里抽卡片，交给 /pending 决定，但立刻拉一次，不必等下一轮轮询：
           批准/拒绝 → 该项从列表消失 → 卡片自然收起；
           查看 → 该项还在但变成 viewed → 原地转成"已转去对话框 ⏳"。
           这样"卡片没了"永远不会被误读成"已经批准了"。 */
        pullOnce()
      })
      .catch(function (err) {
        var msg = (err && err.message) || ''
        log('answer failed ' + msg)
        clearBusy()
        /* 404/409 = 这一项已经被对话框那边处理掉了（或已过期）。
           这时候别让卡片无声消失——用户会以为"点了批准但没生效"。 */
        if (msg.indexOf('http 404') >= 0 || msg.indexOf('http 409') >= 0) flashSettled()
      })
  }

  var flashTimer = null
  function flashSettled() {
    if (!card) return
    var tipEl = card.querySelector('.dpa-tip')
    var actions = card.querySelector('.dpa-actions')
    if (tipEl) tipEl.textContent = '已在对话框处理'
    if (actions) actions.innerHTML = ''
    card.classList.add('is-viewed')
    if (flashTimer) clearTimeout(flashTimer)
    flashTimer = setTimeout(function () {
      flashTimer = null
      removeCard()
    }, 1400)
  }

  /* --------------------- 让卡片区域可点击（包装原型方法） --------------------- */

  function syncRegions(sprite) {
    var bridge = window.petBridge
    if (!bridge || !bridge.setInputRegions) return
    var base = null
    try {
      base = JSON.parse(sprite._inputRegions || 'null')
    } catch (e) {
      base = null
    }
    var rects = ((base && base.rects) || []).concat(cardRects())
    var input = { dragging: !!(base && base.dragging), rects: rects }
    var key = JSON.stringify(input)
    if (sprite._dpaRegions === key) return
    sprite._dpaRegions = key
    try {
      bridge.setInputRegions(input)
    } catch (e) {
      /* 主进程侧不可用 */
    }
  }

  function refreshSprites() {
    if (sprite) {
      try {
        sprite.syncInputRegions()
      } catch (e) {
        /* ignore */
      }
      try {
        sprite.syncInputBusy()
      } catch (e) {
        /* ignore */
      }
      return
    }
    // 兜底：还没捕获到 sprite 实例（boot 尚未完成）时，直接按 preload 接口上报。
    var bridge = window.petBridge
    if (bridge && bridge.setInputRegions) {
      try {
        bridge.setInputRegions({ dragging: false, rects: cardRects() })
      } catch (e) {
        /* ignore */
      }
    }
    if (bridge && bridge.setInputBusy) {
      try {
        bridge.setInputBusy(card !== null)
      } catch (e) {
        /* ignore */
      }
    }
  }

  function installHooks() {
    if (typeof PetSprite === 'undefined' || !PetSprite.prototype) {
      log('PetSprite not found; card stays visual-only')
      return
    }
    var proto = PetSprite.prototype
    // 能力检查：dsh-pet 升级把这三个方法改名/删掉时就别包装，卡片退回"纯展示"，
    // 绝不能因为包装失败让宠物自己出问题。
    if (
      typeof proto.inputBusy !== 'function' ||
      typeof proto.syncInputRegions !== 'function' ||
      typeof proto.setInteractive !== 'function'
    ) {
      log('PetSprite shape changed; card stays visual-only')
      return
    }
    try {
      var origBusy = proto.inputBusy
      proto.inputBusy = function () {
        sprite = this
        return !!origBusy.call(this) || card !== null
      }
      var origSync = proto.syncInputRegions
      proto.syncInputRegions = function () {
        sprite = this
        var out = origSync.call(this)
        syncRegions(this)
        return out
      }
      var origSetInteractive = proto.setInteractive
      proto.setInteractive = function (flag) {
        sprite = this
        return origSetInteractive.call(this, !!flag || card !== null)
      }
    } catch (e) {
      log('hook failed', e && e.message)
    }
  }

  /* --------------------------------- 轮询 --------------------------------- */

  var ticks = 0

  /** 每 ~9s 对一次 UI 版本：host 升级了卡片样式就刷新窗口，用户/开发者不用手动重启桌宠。 */
  function checkUiVersion(p) {
    if (!p) return null
    return call(p, '/health').then(
      function (health) {
        if (health && typeof health.ui === 'string' && health.ui !== UI_VERSION) {
          /*
           * host 与渲染端版本不一致时刷新窗口，让新脚本生效。
           * 但必须记账：插件更新后、DSH 尚未重启时两者会短暂不同步，
           * 若每轮都 reload 就是死循环（桌宠不停闪）。sessionStorage 在 file:// 下不一定可用，
           * 记账失败就宁可不刷：旧卡片能用，白屏不能。
           */
          var key = 'dpa-ui-reload'
          var stamp = health.ui + '/' + UI_VERSION
          try {
            if (sessionStorage.getItem(key) === stamp) return
            sessionStorage.setItem(key, stamp)
          } catch (err) {
            log('sessionStorage 不可用，跳过版本刷新')
            return
          }
          log('ui ' + UI_VERSION + ' -> ' + health.ui + '; reloading')
          location.reload()
        }
      },
      function () {
        /* 下次再说 */
      },
    )
  }

  function tick() {
    discover()
      .then(function (p) {
        if (p === null) {
          if (card) removeCard()
          return null
        }
        ticks += 1
        if (ticks % 10 === 1) checkUiVersion(p)
        return call(p, '/pending')
      })
      .then(function (data) {
        if (!data) return
        authRecovered()
        applyItems(Array.isArray(data.items) ? data.items : [])
      })
      .catch(function (err) {
        var msg = (err && String(err.message)) || ''
        if (msg.indexOf('http 401') >= 0 || msg.indexOf('http 403') >= 0) {
          port = null
          if (card) removeCard()
          reloadForAuth()
          return
        }
        port = null
        if (card) removeCard()
      })
      .then(function () {
        setTimeout(tick, POLL_MS)
      })
  }

  function start() {
    installHooks()
    injectStyle()
    tick()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true })
  } else {
    start()
  }
})()

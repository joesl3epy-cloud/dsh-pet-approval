/**
 * dsh-pet-approval —— 对 dsh-pet 的**最小**渲染端补丁（幂等、可重放、可完整卸载）。
 *
 * 只在 dsh-pet 的桌面 helper 目录里做三件事：
 *   1. 复制一份 pet-approval.js（本插件自带的独立脚本，属于本插件，不是 dsh-pet 的代码）；
 *   2. 往 index.html 的 </body> 前追加**一行** script 标签（带 data-dsh-pet-approval 标记）；
 *   3. 把本次进程的访问凭据写进那一行（data-token），并另存一份
 *      pet-approval-runtime.json 供诊断脚本读取。
 *
 * 设计约束（来自用户）：dsh-pet 是第三方软件，必须能照常升级、照常使用。
 *   - 不改它的任何既有文件内容，只增一行 + 一个独立文件；
 *   - dsh-pet 升级会覆盖 index.html：本模块在 DSH 每次启动时自动检测并把那一行补回去，
 *     所以升级后重启 DSH 即自动恢复，无需手工重打补丁；
 *   - 因此升级期间哪怕补丁没重放，dsh-pet 的行为也完全不变（只是审批卡片不出现）；
 *   - **永远不拿备份反向覆盖 index.html**：备份只在第一次补丁时写一次，
 *     卸载时只删我们自己那一行。第三方升级后的新内容不会被旧备份冲掉。
 *
 * 凭据（详见 README「安全模型」）：
 *   - 每个 profile 各自生成一枚 32 字节随机 token，只写进该 profile 的 helper 目录；
 *   - token 不进日志、不进 URL、不进 /health 响应、不进 Git（运行时生成）；
 *   - 轮换：删掉该目录的 pet-approval-runtime.json 后重启 DSH。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RUNTIME_FILE = 'pet-approval.js'
const TOKEN_FILE = 'pet-approval-runtime.json'
const MARK = 'data-dsh-pet-approval'
const BACKUP_SUFFIX = '.dsh-pet-approval.bak'
const HELPER_FILES = ['index.html']

/** 32 字节随机凭据（64 位十六进制）。 */
export function newToken() {
  return crypto.randomBytes(32).toString('hex')
}

/**
 * 当前进程跑在哪个 profile 下。
 *
 * 依次尝试：环境变量 → 自身安装路径里的 /profiles/<name>/ → null（未知）。
 * 未知时调用方应当保守处理（只作用于能找到的那一个 helper 目录），而不是遍历全部。
 */
export function resolveProfile() {
  const fromEnv = process.env.DSH_PROFILE
  if (fromEnv && /^[A-Za-z0-9._-]+$/.test(fromEnv)) return fromEnv
  try {
    const match = /[/\\]profiles[/\\]([^/\\]+)[/\\]/.exec(fileURLToPath(import.meta.url))
    if (match) return match[1]
  } catch {
    /* import.meta.url 不可用时放弃 */
  }
  return null
}

/** 解析 DSH 配置根目录（尊重 DSH_HOME）。 */
export function resolveDshHome(dshHome) {
  if (dshHome) return dshHome
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  return path.join(os.homedir(), '.dsh')
}

/**
 * 找到装了 dsh-pet 桌面 helper 的 profile 目录。
 *
 * @param {string} [dshHome] DSH 配置根目录
 * @param {string|null} [profile] 只找这一个 profile；null 表示全部
 */
export function findPetRuntimeDirs(dshHome, profile) {
  const out = []
  const profiles = path.join(resolveDshHome(dshHome), 'profiles')
  let entries = []
  try {
    entries = fs.readdirSync(profiles, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (profile && entry.name !== profile) continue
    const dir = path.join(profiles, entry.name, 'node_modules', 'dsh-pet', 'runtime', 'electron-helper')
    try {
      if (fs.statSync(path.join(dir, 'index.html')).isFile()) out.push(dir)
    } catch {
      /* 该 profile 没装 dsh-pet */
    }
  }
  return out
}

function runtimeSource() {
  return path.join(HERE, 'runtime', RUNTIME_FILE)
}

/** script 标签：token 放在 data 属性里，渲染端从 DOM 读，不经过 URL。 */
function scriptTag(token) {
  return `<script src="./${RUNTIME_FILE}" ${MARK}="1" data-token="${token}"></script>`
}

const TAG_RE = new RegExp(`<script[^>]*${MARK}=[^>]*></script>`)
/** 注释行 + script 行整块（首次注入时的原样），卸载时优先按整块删，能完全复原 index.html。 */
const BLOCK_RE = new RegExp(`\\n?[ \\t]*<!-- dsh-pet-approval:[^\\n]*-->\\n[ \\t]*<script[^>]*${MARK}=[^>]*></script>`)

/** 把独立脚本复制到 helper 目录（内容相同则跳过）。 */
function installRuntimeFile(dir, report) {
  const src = runtimeSource()
  const dest = path.join(dir, RUNTIME_FILE)
  let body
  try {
    body = fs.readFileSync(src, 'utf8')
  } catch (error) {
    report.push({ dir, file: RUNTIME_FILE, action: 'error', message: `读取插件自带脚本失败：${error.message}` })
    return false
  }
  let current = null
  try {
    current = fs.readFileSync(dest, 'utf8')
  } catch {
    current = null
  }
  if (current === body) {
    report.push({ dir, file: RUNTIME_FILE, action: 'unchanged' })
    return true
  }
  try {
    fs.writeFileSync(dest, body, 'utf8')
    report.push({ dir, file: RUNTIME_FILE, action: current === null ? 'created' : 'updated' })
    return true
  } catch (error) {
    report.push({ dir, file: RUNTIME_FILE, action: 'error', message: error.message })
    return false
  }
}

/** 写入/更新凭据文件（0600，仅当前用户可读）。 */
function writeTokenFile(dir, token, report) {
  const file = path.join(dir, TOKEN_FILE)
  const body = `${JSON.stringify({ token, version: 1 }, null, 2)}\n`
  let current = null
  try {
    current = fs.readFileSync(file, 'utf8')
  } catch {
    current = null
  }
  if (current === body) {
    report.push({ dir, file: TOKEN_FILE, action: 'unchanged' })
    return true
  }
  try {
    fs.writeFileSync(file, body, { encoding: 'utf8', mode: 0o600 })
    fs.chmodSync(file, 0o600)
    report.push({ dir, file: TOKEN_FILE, action: current === null ? 'created' : 'updated' })
    return true
  } catch (error) {
    report.push({ dir, file: TOKEN_FILE, action: 'error', message: error.message })
    return false
  }
}

/**
 * 往 index.html 注入/更新那一行 script。
 * - 没有 → 追加；
 * - 已有且 token 不同 → 只替换这一行（dsh-pet 升级换了模板也不会被旧备份覆盖）；
 * - 已有且 token 相同 → 不动。
 */
function installScriptTag(dir, token, report) {
  const file = path.join(dir, 'index.html')
  let html
  try {
    html = fs.readFileSync(file, 'utf8')
  } catch (error) {
    report.push({ dir, file: 'index.html', action: 'error', message: `读取失败：${error.message}` })
    return false
  }

  const tag = scriptTag(token)
  if (html.includes(MARK)) {
    const existing = TAG_RE.exec(html)
    if (existing && existing[0] === tag) {
      try { fs.chmodSync(file, 0o600) } catch (error) {
        report.push({ dir, file: 'index.html', action: 'error', message: error.message }); return false
      }
      report.push({ dir, file: 'index.html', action: 'already-patched' })
      return true
    }
    if (!existing) {
      report.push({ dir, file: 'index.html', action: 'error', message: '标记存在但找不到完整 script 标签' })
      return false
    }
    // 只换我们那一行，其余字节原样保留
    const next = html.replace(existing[0], tag)
    try {
      fs.chmodSync(file, 0o600)
      fs.writeFileSync(file, next, 'utf8')
      report.push({ dir, file: 'index.html', action: 'token-updated' })
      return true
    } catch (error) {
      report.push({ dir, file: 'index.html', action: 'error', message: error.message })
      return false
    }
  }

  // 第一次补丁：留一份原始副本，之后永不覆盖
  const backup = file + BACKUP_SUFFIX
  if (!fs.existsSync(backup)) {
    try {
      fs.writeFileSync(backup, html, 'utf8')
    } catch {
      /* 备份失败不阻塞：补丁本身只增一行 */
    }
  }
  const injection = `    <!-- dsh-pet-approval: 桌宠审批卡片（插件自动维护，dsh-pet 升级后重启自动补回） -->\n    ${tag}\n`
  const next = html.includes('</body>') ? html.replace('</body>', `${injection}  </body>`) : `${html}\n${injection}`
  try {
    fs.chmodSync(file, 0o600)
    fs.writeFileSync(file, next, 'utf8')
    report.push({ dir, file: 'index.html', action: 'patched' })
    return true
  } catch (error) {
    report.push({ dir, file: 'index.html', action: 'error', message: error.message })
    return false
  }
}

/**
 * 确保 dsh-pet helper 目录带上审批脚本与本次凭据。
 *
 * @param {{dshHome?: string, token: string, profile?: string|null}} options
 * @returns {{dirs: string[], report: object[]}}
 */
export function ensureRuntimePatch(options = {}) {
  const token = options.token || newToken()
  const profile = options.profile !== undefined ? options.profile : resolveProfile()
  const dirs = findPetRuntimeDirs(options.dshHome, profile || null)
  const report = []
  // profile 认不出来时保守处理：多个 profile 都装了 dsh-pet 就一个都不动，
  // 免得 A profile 的 DSH 把补丁和凭据打到 B profile 的宠物窗口上（那边会因此连不上审批服务）。
  if (!profile && dirs.length > 1) {
    report.push({
      dir: '-',
      file: 'index.html',
      action: 'skipped',
      message: `profile 未知且找到 ${dirs.length} 个 helper 目录，拒绝猜测`,
    })
    return { dirs: [], report, token, profile: null }
  }
  for (const dir of dirs) {
    if (!installRuntimeFile(dir, report)) continue
    writeTokenFile(dir, token, report)
    installScriptTag(dir, token, report)
  }
  return { dirs, report, token, profile: profile || null }
}

/**
 * 完整卸载：只移除本插件添加的东西。
 *
 * - 删掉注入的那一行 script 与其上方那行注释；
 * - 删掉复制过去的 pet-approval.js 与凭据文件；
 * - **不动** index.html.dsh-pet-approval.bak（它是第三方原始副本，留着无害）。
 */
export function removeRuntimePatch(options = {}) {
  const profile = options.profile !== undefined ? options.profile : resolveProfile()
  const dirs = findPetRuntimeDirs(options.dshHome, profile || null)
  const report = []
  if (!profile && dirs.length > 1) {
    report.push({ dir: '-', file: 'index.html', action: 'skipped', message: 'profile 未知且存在多个 helper，拒绝猜测；请明确指定 profile' })
    return { dirs: [], report }
  }
  for (const dir of dirs) {
    const file = path.join(dir, 'index.html')
    try {
      const html = fs.readFileSync(file, 'utf8')
      let next = html.replace(BLOCK_RE, '')
      if (next === html) {
        // 整块没命中（手工改过缩进等）：退化成分别删，至少不留可执行内容
        next = html.replace(/\n?[ \t]*<!-- dsh-pet-approval:[^\n]*-->/g, '').replace(TAG_RE, '')
      }
      if (next !== html) {
        fs.writeFileSync(file, next, 'utf8')
        report.push({ dir, file: 'index.html', action: 'unpatched' })
      } else {
        report.push({ dir, file: 'index.html', action: 'not-patched' })
      }
    } catch (error) {
      report.push({ dir, file: 'index.html', action: 'error', message: error.message })
    }
    for (const name of [RUNTIME_FILE, TOKEN_FILE]) {
      const target = path.join(dir, name)
      try {
        fs.unlinkSync(target)
        report.push({ dir, file: name, action: 'removed' })
      } catch (error) {
        report.push({ dir, file: name, action: error.code === 'ENOENT' ? 'absent' : 'error', message: error.code })
      }
    }
  }
  return { dirs, report }
}

/** 读回某个 helper 目录里的凭据（诊断脚本用；找不到返回 null）。 */
export function readTokenFile(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, TOKEN_FILE), 'utf8'))
    return typeof raw.token === 'string' && raw.token.length >= 32 ? raw.token : null
  } catch {
    return null
  }
}

export { HELPER_FILES, MARK, RUNTIME_FILE, TOKEN_FILE }

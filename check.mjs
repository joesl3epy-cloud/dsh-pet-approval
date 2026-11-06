/**
 * dsh-pet-approval —— 一键自检：审批服务在不在、dsh-pet 渲染端补丁在不在。
 *
 *   node check.mjs
 *
 * 只读：不改任何文件。访问本机接口用的是 helper 目录里那枚凭据，
 * 没有凭据就是 401 —— 也就是说自检脚本走的和宠物窗口完全同一条鉴权路径，
 * 不存在「给调试留的后门」。
 */
import fs from 'node:fs'
import path from 'node:path'
import { findPetRuntimeDirs, readTokenFile } from './patch.mjs'

const PORTS = [49395, 49396, 49397, 49398, 49399, 49400]
const MARK = 'data-dsh-pet-approval'

const dirs = findPetRuntimeDirs()
let token = null
for (const dir of dirs) {
  token = readTokenFile(dir)
  if (token) break
}

function auth(extra) {
  return token ? { ...(extra || {}), 'x-pet-token': token } : extra || {}
}

let found = null
let unauthorized = 0
if (token) {
  for (const port of PORTS) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: auth(),
        signal: AbortSignal.timeout(1200),
      })
      if (res.status === 401) unauthorized += 1
      if (res.ok) {
        found = { port, body: await res.json() }
        break
      }
    } catch {
      /* 换下一个端口 */
    }
  }
}

if (!token) {
  console.log('✗ 找不到访问凭据（helper 目录里没有 pet-approval-runtime.json）')
  console.log('  → 渲染端补丁没打上：重启 DSH，或手动 `node install.mjs`')
} else if (!found) {
  console.log(
    unauthorized > 0
      ? '✗ 审批服务在跑，但拒绝了我们的凭据（401）\n  → 凭据已轮换：重启 DSH，或重新 `node install.mjs` 后再重启'
      : '✗ 没找到审批服务（49395–49400 都没响应）\n  → 插件可能没加载：看 <DSH_HOME>/dsh-pet-approval/host.log；确认 DSH 已重启',
  )
} else {
  const online = found.body.petOnline ? '在线' : '离线'
  console.log(`✓ 审批服务 127.0.0.1:${found.port}  version=${found.body.version}  ui=${found.body.ui}  桌宠${online}`)
  if (!found.body.petOnline) {
    const ago = found.body.petLastPollAgoMs
    console.log(`  桌宠渲染端最后轮询：${ago === null ? '从未连上（渲染端补丁可能没生效）' : Math.round(ago / 1000) + 's 前'}`)
  }
  const pending = await (
    await fetch(`http://127.0.0.1:${found.port}/pending`, { headers: auth(), signal: AbortSignal.timeout(1200) })
  ).json()
  console.log(`  待审批 ${pending.items.length} 条`)
  for (const item of pending.items) {
    console.log(`    · ${item.toolName}  risk=${item.risk}  ${item.reason || '(无理由)'}`)
  }
}

console.log(`\ndsh-pet 渲染端（找到 ${dirs.length} 个 helper 目录）`)
if (dirs.length === 0) {
  console.log('  ✗ 没找到已安装的 dsh-pet（<DSH_HOME>/profiles/*/node_modules/dsh-pet/runtime/electron-helper）')
}
for (const dir of dirs) {
  const html = path.join(dir, 'index.html')
  const script = path.join(dir, 'pet-approval.js')
  let injected = false
  try {
    injected = fs.readFileSync(html, 'utf8').includes(MARK)
  } catch {
    /* 读不到就是没打上 */
  }
  console.log(`  ${dir}`)
  console.log(`    脚本       ${fs.existsSync(script) ? '✓ 已就位' : '✗ 缺失'}`)
  console.log(`    index.html ${injected ? '✓ 已注入 <script>' : '✗ 未注入'}`)
  console.log(`    凭据       ${readTokenFile(dir) ? '✓ 存在（0600）' : '✗ 缺失'}`)
}

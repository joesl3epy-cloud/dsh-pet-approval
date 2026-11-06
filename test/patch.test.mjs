import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  findPetRuntimeDirs,
  ensureRuntimePatch,
  removeRuntimePatch,
  readTokenFile,
  MARK,
  RUNTIME_FILE,
  TOKEN_FILE,
} from '../patch.mjs'

const ORIGINAL = `<!doctype html>
<html>
  <body>
    <div id="root"></div>
  </body>
</html>
`

const TOKEN_A = 'a'.repeat(64)
const TOKEN_B = 'b'.repeat(64)

function makeFakeDshHome(profiles = ['desktop']) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pet-approval-'))
  const helpers = []
  for (const profile of profiles) {
    const helper = path.join(home, 'profiles', profile, 'node_modules', 'dsh-pet', 'runtime', 'electron-helper')
    fs.mkdirSync(helper, { recursive: true })
    fs.writeFileSync(path.join(helper, 'index.html'), ORIGINAL)
    helpers.push(helper)
  }
  return { home, helper: helpers[0], helpers }
}

function patch(home, extra = {}) {
  return ensureRuntimePatch({ dshHome: home, profile: 'desktop', token: TOKEN_A, ...extra })
}

test('findPetRuntimeDirs 只返回真正装了 dsh-pet 的 profile', () => {
  const { home, helper } = makeFakeDshHome()
  fs.mkdirSync(path.join(home, 'profiles', 'empty'), { recursive: true })
  assert.deepEqual(findPetRuntimeDirs(home), [helper])
  assert.deepEqual(findPetRuntimeDirs(home, 'desktop'), [helper])
  assert.deepEqual(findPetRuntimeDirs(home, 'missing'), [])
})

test('第一次打补丁：复制脚本 + 注入一行 script + 写 0600 凭据 + 留备份', () => {
  const { home, helper } = makeFakeDshHome()
  const { dirs, report } = patch(home)

  assert.deepEqual(dirs, [helper])
  assert.equal(
    fs.readFileSync(path.join(helper, RUNTIME_FILE), 'utf8'),
    fs.readFileSync(new URL('../runtime/pet-approval.js', import.meta.url), 'utf8'),
  )

  const html = fs.readFileSync(path.join(helper, 'index.html'), 'utf8')
  assert.equal((html.match(new RegExp(MARK, 'g')) || []).length, 1)
  assert.ok(html.includes(`data-token="${TOKEN_A}"`))
  // token 只出现在 data 属性里，不进 URL
  assert.ok(!html.includes(`?token=`))
  assert.equal(fs.readFileSync(path.join(helper, 'index.html.dsh-pet-approval.bak'), 'utf8'), ORIGINAL)
  assert.ok(report.some((r) => r.action === 'patched'))

  const tokenFile = path.join(helper, TOKEN_FILE)
  assert.equal(readTokenFile(helper), TOKEN_A)
  assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o600)
})

test('第二次打补丁幂等：不重复注入、备份不被覆盖', () => {
  const { home, helper } = makeFakeDshHome()
  patch(home)
  const afterFirst = fs.readFileSync(path.join(helper, 'index.html'), 'utf8')
  const bakFirst = fs.readFileSync(path.join(helper, 'index.html.dsh-pet-approval.bak'), 'utf8')

  const { report } = patch(home)
  const afterSecond = fs.readFileSync(path.join(helper, 'index.html'), 'utf8')

  assert.equal(afterSecond, afterFirst)
  assert.equal((afterSecond.match(new RegExp(MARK, 'g')) || []).length, 1)
  assert.equal(fs.readFileSync(path.join(helper, 'index.html.dsh-pet-approval.bak'), 'utf8'), bakFirst)
  assert.ok(report.every((r) => r.action === 'already-patched' || r.action === 'unchanged'))
})

test('凭据轮换：只替换那一行，其它字节原样不动', () => {
  const { home, helper } = makeFakeDshHome()
  patch(home)
  const { report } = patch(home, { token: TOKEN_B })

  const html = fs.readFileSync(path.join(helper, 'index.html'), 'utf8')
  assert.equal((html.match(new RegExp(MARK, 'g')) || []).length, 1)
  assert.ok(html.includes(`data-token="${TOKEN_B}"`))
  assert.ok(!html.includes(TOKEN_A))
  assert.equal(readTokenFile(helper), TOKEN_B)
  assert.ok(report.some((r) => r.action === 'token-updated'))
})

test('dsh-pet 升级覆盖 index.html 后，下一次启动自动补回', () => {
  const { home, helper } = makeFakeDshHome()
  patch(home)
  // 模拟 dsh-pet 升级：index.html 被换成官方原版
  fs.writeFileSync(path.join(helper, 'index.html'), ORIGINAL)

  patch(home, { token: TOKEN_B })
  const html = fs.readFileSync(path.join(helper, 'index.html'), 'utf8')
  assert.equal((html.match(new RegExp(MARK, 'g')) || []).length, 1)
  assert.ok(html.includes(`data-token="${TOKEN_B}"`))
})

test('升级后版本内容不会被旧备份冲掉', () => {
  const { home, helper } = makeFakeDshHome()
  patch(home)
  const upgraded = ORIGINAL.replace('<div id="root"></div>', '<div id="root"></div>\n    <script src="./app.js"></script>')
  fs.writeFileSync(path.join(helper, 'index.html'), upgraded)
  patch(home)
  const html = fs.readFileSync(path.join(helper, 'index.html'), 'utf8')
  assert.ok(html.includes('<script src="./app.js"></script>'), '第三方升级带来的新脚本必须保留')
})

test('卸载：只删本插件加的东西，index.html 完全复原', () => {
  const { home, helper } = makeFakeDshHome()
  patch(home)
  const { report } = removeRuntimePatch({ dshHome: home, profile: 'desktop' })

  assert.equal(fs.readFileSync(path.join(helper, 'index.html'), 'utf8'), ORIGINAL)
  assert.equal(fs.existsSync(path.join(helper, RUNTIME_FILE)), false)
  assert.equal(fs.existsSync(path.join(helper, TOKEN_FILE)), false)
  assert.ok(report.some((r) => r.action === 'unpatched'))
})

test('卸载是幂等的：重复卸载不抛错', () => {
  const { home } = makeFakeDshHome()
  patch(home)
  removeRuntimePatch({ dshHome: home, profile: 'desktop' })
  const { report } = removeRuntimePatch({ dshHome: home, profile: 'desktop' })
  assert.ok(report.every((r) => r.action === 'not-patched' || r.action === 'absent'))
})

test('多 profile 隔离：指定 profile 时绝不动另一个', () => {
  const { home, helpers } = makeFakeDshHome(['desktop', 'testhot'])
  const { dirs } = patch(home)

  assert.deepEqual(dirs, [helpers[0]])
  assert.equal(fs.readFileSync(path.join(helpers[1], 'index.html'), 'utf8'), ORIGINAL)
  assert.equal(fs.existsSync(path.join(helpers[1], TOKEN_FILE)), false)
})

test('profile 认不出来且存在多个 profile 时拒绝猜测', () => {
  const { home, helpers } = makeFakeDshHome(['desktop', 'testhot'])
  const { dirs, report } = ensureRuntimePatch({ dshHome: home, profile: null, token: TOKEN_A })

  assert.deepEqual(dirs, [])
  assert.ok(report.some((r) => r.action === 'skipped'))
  for (const helper of helpers) {
    assert.equal(fs.readFileSync(path.join(helper, 'index.html'), 'utf8'), ORIGINAL)
  }
})

test('没有 dsh-pet 时不报错、不动任何文件', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pet-approval-empty-'))
  const { dirs, report } = patch(home)
  assert.deepEqual(dirs, [])
  assert.deepEqual(report, [])
})


test('无法识别 profile 时卸载拒绝猜测，明确指定只移除一个', () => {
  const { home, helpers } = makeFakeDshHome(['desktop', 'other'])
  patch(home)
  patch(home, { profile: 'other', token: TOKEN_B })
  const before = helpers.map(h => fs.readFileSync(path.join(h, 'index.html'), 'utf8'))
  const result = removeRuntimePatch({ dshHome: home, profile: null })
  assert.equal(result.dirs.length, 0)
  assert.ok(result.report.some(r => r.action === 'skipped'))
  assert.deepEqual(helpers.map(h => fs.readFileSync(path.join(h, 'index.html'), 'utf8')), before)
  removeRuntimePatch({ dshHome: home, profile: 'desktop' })
  assert.equal(fs.readFileSync(path.join(helpers[0], 'index.html'), 'utf8'), ORIGINAL)
  assert.equal(fs.readFileSync(path.join(helpers[1], 'index.html'), 'utf8'), before[1])
})

test('包含凭据的 HTML 在首次安装及幂等重放后均限制为 0600', () => {
  const { home, helper } = makeFakeDshHome()
  patch(home)
  const html = path.join(helper, 'index.html')
  assert.equal(fs.statSync(html).mode & 0o777, 0o600)
  fs.chmodSync(html, 0o644)
  patch(home)
  assert.equal(fs.statSync(html).mode & 0o777, 0o600)
})


test('手动重放安装脚本复用已有 token，不使运行中服务凭据失配', () => {
  const { home, helper } = makeFakeDshHome()
  patch(home)
  const command = fileURLToPath(new URL('../install.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [command, 'desktop'], {
    env: { ...process.env, DSH_HOME: home }, encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readTokenFile(helper), TOKEN_A)
  assert.ok(fs.readFileSync(path.join(helper, 'index.html'), 'utf8').includes(`data-token="${TOKEN_A}"`))
})

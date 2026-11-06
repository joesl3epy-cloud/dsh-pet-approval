/**
 * 移除 dsh-pet 渲染端补丁（把宠物窗口恢复成原样）。
 *
 *   node uninstall.mjs
 *
 * 只删本插件加的东西：
 *   - index.html 里那一行 <script data-dsh-pet-approval>
 *   - helper 目录下的 pet-approval.js
 *   - pet-approval-runtime.json（凭据）
 * 不碰 DSH 自己的文件，也不用任何旧备份反向覆盖升级后的 index.html。
 */
import { removeRuntimePatch, resolveProfile } from './patch.mjs'

const profile = process.argv[2] || resolveProfile()
const { dirs, report } = removeRuntimePatch({ profile })

console.log(`profile: ${profile || '（未能自动识别，仅允许唯一 helper 目录）'}`)
if (report.some(r => r.action === 'skipped' || r.action === 'error')) {
  for (const row of report) console.error(row.message || row.action)
  process.exit(1)
}
if (dirs.length === 0) {
  console.log('没找到 dsh-pet 的 helper 目录，无需移除。')
  process.exit(0)
}
for (const row of report) {
  console.log(`  ${row.file}: ${row.action}${row.message ? ' — ' + row.message : ''}`)
}
console.log('\n渲染端补丁已移除。重启 dsh-pet（或重开宠物窗口）后卡片不再出现；')
console.log('DSH 侧插件本身仍在，此时桌宠通道不可用，审批会直接走对话框。')
console.log('要彻底停用，请再从 DSH profile 的依赖里移除本插件。')

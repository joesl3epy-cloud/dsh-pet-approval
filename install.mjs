/** Replay the renderer patch without rotating an existing host credential. */
import { ensureRuntimePatch, findPetRuntimeDirs, readTokenFile, newToken, resolveProfile } from './patch.mjs'
const profile = process.argv[2] || resolveProfile()
const candidates = findPetRuntimeDirs(undefined, profile)
if (!profile && candidates.length > 1) {
  console.error('存在多个 profile，请使用 node install.mjs <profile> 明确指定'); process.exit(1)
}
const token = candidates.length === 1 ? readTokenFile(candidates[0]) : null
const { dirs, report } = ensureRuntimePatch({ token: token || newToken(), profile })
for (const row of report) console.log(`${row.file}: ${row.action}${row.message ? ': ' + row.message : ''}`)
if (!dirs.length || report.some(r => r.action === 'error' || r.action === 'skipped')) process.exit(1)
console.log(token ? '已复用现有凭据修复补丁；重新打开桌宠窗口。' : '首次生成凭据；请重启 DSH 并重新打开桌宠窗口。')

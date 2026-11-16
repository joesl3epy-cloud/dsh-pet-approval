# dsh-pet-approval · 极简桌宠审批

在其他窗口工作时，也能从常驻桌宠上处理 DSH 的权限请求：**普通请求点「允许」，高风险点「查看」回 DSH 手动审批。**

**Jolyon · v0.4.0 · macOS · 非官方插件 · AI 辅助开发**

[版本记录](./CHANGELOG.md) · [反馈问题](https://github.com/joesl3epy-cloud/dsh-pet-approval/issues) · [配套工具：隐藏侧栏时间](https://github.com/joesl3epy-cloud/dsh-hide-time)

## 实际演示

### 普通请求：在桌宠上允许一次

[观看普通审批演示（约 8 秒）](./assets/approval-demo.mp4)

卡片出现后，点击桌宠的「允许」，审批卡片消失、任务继续。按钮虽然只有两个字，含义仍然是**仅允许当前这一次请求**，不是永久授权。

### 高风险请求：切回 DSH，由用户手动决定

[![高风险查看演示预览](./assets/view-demo.png)](./assets/view-demo.mp4)

[观看查看跳转演示（约 10 秒）](./assets/view-demo.mp4)

演示从桌面上的桌宠入口切回 DSH 审批页面。「查看」不产生授权；用户仍需在原页面查看细节并选择允许或拒绝。录屏是个人环境的使用示例，不代表所有宿主版本均已适配；画面中的敏感目录请求保持待审批，不是建议的演示任务。

## 为什么做

我在 Mac 上使用 DeepSeek Harness（DSH）执行任务时，经常要回应过程中产生的权限请求。对已经理解用途的常规请求，反复切回应用确认会打断手头的工作。

既然已经有常驻桌面的 dsh-pet，就把这个确认入口放在桌宠上：平时安静，需要时出现，只保留一个当前有用的按钮。

项目与我的其他 DSH 工具遵循同一取舍：**极简、低打扰；关键动作保留清楚的反馈和边界。**

## 当前行为

| 情形 | 桌宠操作 | 结果 |
|---|---|---|
| 普通请求 | 允许 | 仅允许本次操作 |
| 规则识别为高风险 | 查看 | 尝试唤起 DSH 并打开目标会话，必须在 DSH 页面手动决定 |
| 不确定或需要拒绝 | 使用 DSH 原审批框 | 原审批框保留完整决定权 |
| 定位未确认或超时 | 查看可重试 | 不显示假成功，不自动批准 |
| DSH 原页面先处理 | 无须再次处理 | 桌宠按审批状态更新 |

没有用户操作就不会由本插件自动批准。它不替代 DSH 自身的审批策略；风险分类为启发式规则，普通请求不等于已经证明安全。

## 当前限制

- **悬停查看具体请求尚未达到预期。** 代码设置了工具名和理由，但用户实际反馈提示未可靠显示；本版不把它列为可用功能。需要细节时回到 DSH 查看。
- 查看通过 DSH 前端的 `uiWorkspace.openSession` 打开会话，并确认当前会话与窗口焦点；没有实现对某一审批卡片的精确滚动或高亮。
- 只在 macOS 自用与演示验证。不同 DSH 版本、多窗口和特殊会话结构仍可能需要适配。
- 依赖 dsh-pet 的渲染内部结构。插件启动时向其 helper 目录复制独立脚本并追加加载标签；上游升级后可能需要重放补丁和重新打开桌宠。
- 本机凭据用于阻止网页伪造审批；同用户本机进程不属于额外防护范围。不要公开实际 helper HTML 或凭据 JSON。

## 我的参与与 AI 协作

这是个人使用中发起的 Vibe Coding 实践。我主要面向管理岗、经理助理岗，项目展示的是把真实问题转化为可运行工具的 AI 使用过程。

- **Jolyon**：提出痛点、讨论交互与优先级，在 Mac 上持续使用并反馈问题。
- **DeepSeek**：完成早期主要实现并迭代。
- **ChatGPT / Codex**：辅助方案讨论、审查、代码修复和隔离验证，并实现本轮单按钮与导航桥。

代码并非由我逐行独立编写。没有统计节省工时、审批量或效率提升比例，也不宣称已在企业团队规模化部署。

## 安装

需要 DSH Desktop、Node ≥ 20 和 dsh-pet（桌宠通道所需；此前验证版本为0.3.7）。本包未发布到 npm。

1. 克隆本仓库到稳定位置：

```bash
git clone https://github.com/joesl3epy-cloud/dsh-pet-approval.git
```

2. 在实际 `<DSH_HOME>/profiles/<profile>/package.json` 的 `dependencies` 中合并这一项，替换为真实绝对路径：

```json
{"dsh-pet-approval":"file:/绝对路径/dsh-pet-approval"}
```

3. 在同文件的 `dsh.profile.bundles` 数组中加入 `"dsh-pet-approval"`，保留原有配置。上述片段不能整份覆盖 profile。
4. 使用 DSH 自带 pnpm 在该 profile 安装依赖，然后完整重启 DSH：

```bash
node "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs" install --dir "/实际DSH_HOME/profiles/实际profile"
```

首次安装先保留原 profile 配置。仅刷新页面不能加载新增的前端导航入口。

## 技术边界与验证

宿主监听审批请求，保持 GUI 与桌宠双通道；桌宠通过本机回环 HTTP 和随机凭据读取、回应请求。高风险 `allowed-once` 被服务端拒绝。

导航确认与授权分离：查看请求进入15秒有效的导航队列，由DSH自身前端打开指定会话；只有匹配会话且窗口获得焦点后才报告成功。窗口唤起失败、过期或服务不可用不会转为批准。

```bash
npm test
```

本轮32项隔离测试通过，覆盖鉴权、高风险批准拦截、重复处理、取消、补丁、凭据恢复、单按钮与导航确认。真实使用视频补充了两条交互证据，但不能替代全部版本与异常场景验收。既往记录环境：DSH 0.2.1-rc.5、macOS Apple Silicon；本轮视频未另行核对宿主具体版本。

## 诊断与卸载

安装目录运行 `node check.mjs` 检查服务与补丁状态；日志在 `<DSH_HOME>/dsh-pet-approval/host.log`。不把凭据、真实审批内容上传到问题反馈。

先从 profile bundles 停用插件并重启 DSH，再在插件目录执行 `node uninstall.mjs <profile>` 移除渲染补丁，最后移除依赖。只移除本插件内容，不用旧备份覆盖上游升级后的HTML。启动插件会重新维护补丁，因此卸载顺序有意义。

## 致谢与许可

基础桌宠来自 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)。本项目扩展其审批交互，基础桌宠的版权归原作者。DSH 的会话导航能力来自宿主，本插件不依赖 Session Manager。

本项目采用 [MIT](./LICENSE)。这是非官方扩展，与 DeepSeek、DSH 和 dsh-pet 的维护者没有隶属关系。

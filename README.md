# dsh-pet-approval

把 DSH 的权限审批送到 **dsh-pet 桌宠**的气泡上：宠物头顶弹出小卡片，点「拒绝」或「批准」
（= 允许一次）就生效，不用切回 DSH 对话框。

对话框那边**照常弹卡片**——两边都能点，**谁先点算谁的**，后点的那张自动失效、无副作用。

> **非官方插件**。与 DeepSeek、DSH、dsh-pet 的维护者没有隶属关系，也不代表它们的立场。
> - DSH（宿主）：DeepSeek 官方桌面应用，闭源分发。本插件**不包含**它的任何代码，只使用它的
>   Cordis 插件接口与对前端 DOM 的公开约定。
> - [`dsh-pet`](https://github.com/PC2005-cloud/dsh-pet)（被扩展的桌宠）：MIT，© dsh-pet 作者。
>   本插件不改它的源码，只在运行时往它的渲染页面追加一个自己的脚本（见「补丁」一节）。

本项目的独立贡献：审批双通道的汇合与单次结算、`request.signal` 换手以撤回 GUI 卡片、
桌宠卡片 UI 与其宿主侧服务。以上均为本项目原创，未复制 DSH 或 dsh-pet 的源码。

## 它解决什么问题

DSH 的权限审批默认只在对话框里出现。DSH 被最小化、或你正在别的窗口做事时，一次等授权的
工具调用会一直挂着，直到你想起来切回去。桌宠常驻桌面角落，把审批卡片放它头顶，等于把
「需要你点一下」送到视线里。

## 它怎么工作

```
DSH 审批服务（approval/request 瀑布）
        │
        ├── GUI 通道：next() → DSH 自带审批卡片（永远照常显示）
        │
        └── 桌宠通道：本插件挂一张待审批单
                         │  本机回环 HTTP 127.0.0.1:49395–49400
                         │  每个请求带 x-pet-token
                         ▼
              dsh-pet 渲染端（宠物头顶气泡卡片）
                         │  点「批准」/「拒绝」/「查看」
                         ▼
              POST /answer → 审批结果回到 DSH
```

两个通道**同时**开，中间没有「先桌宠、后对话框」的等待。

### 桌宠先答后，GUI 那张卡怎么自己撤

官方前端（`@deepseek-ai/dsh-client-ui-approval`）的 `PendingApproval` 只有三条结束路径：
用户点按钮、`delegate()`、以及 `request.signal` 的 abort。它**不监听** `approval/decided`。

所以本插件在注册审批单时，把 `request.signal` 换成一个自己持有的 `AbortController`
（原 signal 的取消会转发进来）。桌宠一答就 abort，前端那张卡随之消失。

- 上游 `ApprovalService.decide` 在进入瀑布前**已经同步捕获**了原 signal，所以换手不影响
  上游的取消语义；换手只影响下游序列化给前端的那一份。
- 若 `request.signal` 不可写（未来版本改成只读），记一条 `swap fail` 日志，其余功能不受影响，
  只是对话框那张卡需要你自己关。

## 安全模型

### 鉴权：每 profile 一个随机凭据

回环端口在本机，但**浏览器里的任意网页也能访问 `http://127.0.0.1:*`**。仅仅检查 `Origin`
不够：`Origin: null` 不是 Electron 独有的，`file://`、沙箱 iframe、部分隐私模式都会产生它，
所以 Origin 不能当身份凭据。

实际做法：

| 环节 | 做法 |
|---|---|
| 生成 | `crypto.randomBytes(32).toString('hex')`（64 位十六进制），每次插件 `apply()` 生成一个 |
| 传递 | 写进 dsh-pet helper 目录的 `pet-approval-runtime.json`（`mode 0600`，含凭据的 `index.html` 同样限制为 `0600`），同目录的 `index.html` 里那行 `<script>` 带 `data-token="…"`，渲染端从 `document.currentScript` 读取 |
| 使用 | 渲染端每个请求带 `x-pet-token` 头；宿主侧用 `crypto.timingSafeEqual` 比对 |
| 不进哪 | 不进 URL / 查询串 / Git / 日志 / `/health` 响应 |
| 轮换 | 每次 DSH 启动重新生成；旧 token 立即失效，渲染端扫描所有候选端口后仍无匹配服务且收到 401/403，才尝试刷新；刷新预算保存在 sessionStorage 中，跨页面最多一次，成功轮询后恢复预算。无法保存预算时不自动刷新，需重新打开桌宠窗口 |
| 多 profile 隔离 | 凭据文件与 `index.html` 都落在**该 profile 自己的** dsh-pet helper 目录里；端口按 profile 顺延绑定，A profile 的 token 在 B profile 的服务上无效 |

`Origin` 校验**保留**，但降级为辅助措施：拦截明显来自网页的请求，减少噪音。它不再被当作
鉴权依据。

### 高风险请求不能从桌宠批准（服务端强制）

前端会藏掉高风险卡片的「批准」按钮，但这只是 UI。**服务端同样拒绝**：

```js
if (outcome === 'allowed-once' && assessRisk(item) === 'high') → 403
```

「拒绝」永远允许——它只会减少权限，不会扩大。

`assessRisk` 的输入只有 `toolName` 与请求里的 `reason`/参数片段，DSH 并没有把结构化的风险
等级透传到 `approval/request`（`dsh-experimental-auto-review` 的 `risk` 字段不会传到这一步）。
所以它是**启发式**：命中 `sudo`、`rm -rf`、写 `~/.ssh`、`~/.aws`、`.gnupg`、`.kube` 等模式时
判为 `high`。

**这不是完整的安全防护**，只是把「顺手误点」的代价降下来。真正的边界仍然是 DSH 自己的
审批策略与沙箱。没有命中启发式的危险操作，仍可在桌宠上被批准。

## 超时、断连与回退

没有「自动批准」。任何超时都只会**收缩渠道**，绝不代替你做决定。

| 情形 | 行为 |
|---|---|
| 桌宠没启动 | 不记待审批单，完全走 GUI（15s 内心跳缺失即视为离线） |
| 桌宠在线但卡片 20s 没被认领 | 放弃桌宠通道，交还 GUI（`card never rendered`） |
| 等待期间桌宠关闭/断连 | 同上，下一次 watchdog 扫描交还 GUI（`pet went offline`） |
| GUI 返回 `unavailable` | 不当成拒绝：那只表示这条通道没给答案，继续等桌宠 |
| 两条通道都没答案 | 一直等，**不丢弃**仍有效的审批；超过 30 分钟只记一条 `pending long` 日志 |
| 原请求被取消 | 透传 `cancelled`，两条通道一起收摊 |
| 插件停用/卸载 | 所有挂起审批以 `unavailable` 结束，服务关闭，监听与定时器全清 |
| `enabled: false` | 不监听端口、不等待桌宠，审批完全回落到 GUI |

## 双通道只结算一次

- 每个待审批单有 `settled` 标志，第一次有效回答后加锁；
- 之后任何通道再提交 → `404`（已不在 pending 里），结果不变；
- ─「拒绝」与「允许」同时到达时，先到者胜，后者收到 404；
- 桌宠回答后 GUI 卡片被 abort 撤回，**不会**把已结算的结果改写成 `cancelled`；
- 原 signal 的 abort 监听器在单据结算时 `removeEventListener`，不泄漏。

## 补丁（为什么它会碰 dsh-pet 的文件）

dsh-pet 的桌面窗口是它自己的 Electron `BrowserWindow`，加载 `file://` 页面，DSH 的 webServer
路由进不去，窗口里也拿不到 DSH 的 `ctx`。唯一稳定的事实是「本机 HTTP」，所以卡片脚本必须
注入那个页面。

补丁只做两件事：

1. 复制一个**属于本插件**的脚本 `pet-approval.js` 到 helper 目录；
2. 往 `index.html` 的 `</body>` 前追加**一行**带 `data-dsh-pet-approval` 标记的 `<script>`。

- **幂等**：靠标记判断是否已打补丁；重复执行只更新 token 那一行，不追加第二行。
- **不覆盖第三方升级**：dsh-pet 升级会把 `index.html` 换掉，本插件在下次启动时**重新追加**
  一行带当前 token 的标签，其余字节原样保留。绝不拿旧备份反向覆盖升级后的文件。
- **可卸载**：`node uninstall.mjs` 只删自己加的那一行注释 + `<script>` 与本插件的两个文件，
  删完与原文件逐字节一致（有测试断言）。

## 安装（本地路径，未发布到 npm）

本包**尚未**发布到 npm，下面的方式都直接指向你本机的目录。

```bash
# 1. 在 profile 的 package.json 里加一条本地依赖
#    注意写在 dependencies 里，路径用绝对路径
cd ~/.dsh/profiles/<profile>
#      "dsh-pet-approval": "file:/绝对路径/dsh-plugins/pet-approval"

# 2. 装依赖（用 DSH 自带的 pnpm，避免版本错位）
node "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs" install --dir .

# 3. 在同一个 package.json 的 dsh.profile.bundles 里登记
#      "...", "dsh-pet-approval"

# 4. 重启 DSH
```

启动时插件会自动检查并重放 dsh-pet 的渲染端补丁。想立刻确认，不用等重启：

```bash
node node_modules/dsh-pet-approval/install.mjs     # 打印补丁到的 profile 与目录，不打印 token
node node_modules/dsh-pet-approval/check.mjs       # 端到端自检
```

`dsh-pet` 没装也能加载，只是没有桌宠通道。

## 诊断

- `node check.mjs` —— 审批服务在不在、桌宠是否在线、每个 helper 目录的「脚本 / index.html / 凭据」
  三件套是否齐全
- 宿主日志：`~/.dsh/dsh-pet-approval/host.log`
  一次完整的桌宠审批是 `asked` → `pet answered` / `pet gave up` → `decided via=pet|gui`
- 渲染端日志：宠物窗口 DevTools console，前缀 `[dsh-pet-approval]`
- 手动探活（需要 token，不带会得到 401）：

  ```bash
  HELPER=$(dirname "$(grep -rl data-dsh-pet-approval ~/.dsh/*/runtime/electron-helper/index.html 2>/dev/null | head -1)")
  TOKEN=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).token)' "$HELPER/pet-approval-runtime.json")
  curl -s -H "x-pet-token: $TOKEN" http://127.0.0.1:49395/health
  ```

日志默认不记命令全文、不记审批理由、不记会话标题；只记 `id`、工具名与风险档。

## 配置

```yaml
- id: pet-approval
  name: dsh-pet-approval
  config:
    enabled: true        # false = 停用：不监听端口、不等待桌宠，审批完全回落到 GUI
    profile: desktop     # 可选；不给就从 DSH_PROFILE / 包路径推断
    dshHome: null        # 可选；不给就用 DSH_HOME，再退 ~/.dsh
```

## 已知限制

- **只在本机有意义**：回环端口不对外，不做多用户。
- **同用户的本机进程挡不住**：它能读 token 文件、能改 profile 配置，本来就在你的信任域内。
  token 防的是**浏览器里的网页**。
- **风险判断是启发式**，不是完整防护（见上）。
- 依赖 dsh-pet 的渲染端结构（`PetSprite` 的三个方法、`.pet-sprite` 容器）。不匹配时插件会
  打一条 `PetSprite shape changed; card stays visual-only` 并退化成不接管鼠标的静态卡片；
  卡片挂不上时审批仍在 GUI 里完成，不会卡死。
- dsh-pet 大改渲染层时需要更新补丁逻辑；补丁本身可卸载、不阻塞 dsh-pet 升级。
- 只在 macOS 上实测过（见下）。Windows/Linux 未测试，不宣称兼容。

## 测试

```bash
node --test test/     # 29 项：补丁、审批、凭据恢复与生命周期行为
node check.mjs        # 静态契约 + 运行时自检
```

测试全部在临时 `DSH_HOME` 与随机端口上跑，不接触你正在用的配置。

## 实测环境

| 项 | 版本 |
|---|---|
| DSH | 0.2.1-rc.5（Electron 44.7.0，内嵌 Node 24.21.0） |
| dsh-pet | 0.3.7 |
| Node（跑测试用） | 24.21.0 / 26.11.1 |
| 系统 | macOS（Apple Silicon） |

## License

MIT —— 见 [LICENSE](./LICENSE)。第三方组件各自的许可证归其作者所有。

## 0.3.1 修复说明

- 端口探测会跳过其他 profile 的认证失败，寻找持有同一凭据的服务；不会批准其他 profile 的请求。
- 认证失败响应带正确 CORS 头，允许 file:// 渲染端识别凭据过期；预检与实际响应支持 null/file:// 两种来源。
- 插件停止后不再发起端口重试；监听尚未完成的服务也纳入清理。
- `node install.mjs <profile>` 复用现有凭据修复补丁，不主动轮换运行中服务的 token。首次安装仍需重启 DSH。
- `node uninstall.mjs <profile>` 支持显式指定 profile；未知且发现多个 helper 时返回失败，不删除任何一个。
- token-bearing HTML 使用 0600 权限；卸载只移除注入内容，保留该权限，不恢复为可被其他用户读取。
- 启发式风险分级和 request.signal 替换仍依赖当前 DSH 行为；真实 Electron 中的跨重启恢复、审批竞争需手动验收。

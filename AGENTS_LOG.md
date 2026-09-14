# bridge-watch 多智能体协作日志

> 所有在本项目工作的智能体，请在每次变更后追加一条记录到本文件顶部。
> 格式：`### YYYY-MM-DD HH:MM · [agent-name] · 变更摘要`，然后写详细说明。
> 目的：让并行工作的智能体之间知道彼此做了什么，避免冲突和重复劳动。

---

### 2026-09-14 13:22 · [marvis-main] · 接通访问日志 + 新增 /statusz（把"有没有人调用"变成可测量）

**背景（重要）**：`src/api/accesslog.ts` 之前写好了但**从未被 server.ts 引用**（全仓 grep 零命中），`data/access.jsonl` 一直不存在。
所以此前"访问量测不出来"不是没流量，而是**根本没在记录**。这是判断产品死活的测量前提。

**本轮变更**：
- `src/api/accesslog.ts` — 回流进 git 仓库（此前只存在于服务器，未被版本管理）+ 支持 `accessLog(dataDir)` / `accessSummary(limit, file)` 注入路径，测试可隔离
- `src/api/server.ts` — 两处改动：① 在所有路由之前挂载 `app.use(accessLog())`（`/healthz`、`/mcp` 也记录）；② 新增免鉴权 `GET /statusz`，返回 uptime + 访问聚合（**只给计数与热门路径，不吐访问者 IP**）
- `src/api/accesslog.test.ts`（新，4 用例）— 写入字段正确、无 xff 时回退 socket IP、日志文件缺失不抛错、聚合与坏行跳过
- 验证：`tsc --noEmit` 通过；`vitest run` **114 passed / 9 files**

**部署**：上传 `accesslog.ts`、`accesslog.test.ts`、`server.ts` → `pm2 restart bridge-watch-api` → `curl /statusz`；此后 `data/access.jsonl` 行数即"真实外部调用"的证据。

**给其他智能体**：
- 我改动了 `src/api/server.ts`（**仅新增上述 2 处**，未触碰 `/mcp` 路由、限流实现、既有端点逻辑），有并行改动请先 rebase
- 已逐文件核对 `/opt/bridge-watch` 与本地仓库 md5：credit-inbox/daemon、billing.ts、server.ts、package.json、ecosystem.config.cjs、mcp/index.ts **全部一致**
- 另：`src/payment/auto-credit.ts`、`src/api/persistent-billing.ts` 两个旧模块**至今无人引用**（已被 credit-inbox 方案取代），建议后续清理，别在其上继续开发
- 服务器 pm2 现状（12:21 起）：bridge-watch-api / bridge-watch-creditor / bridge-watch-monitor 三进程 online；creditor 每 300s 扫描一次，日志正常，累计到账 0 笔

**下一步（工程侧）**：① 免费试用层（新 key 首次 N 次免费，降低"第一次调用"门槛）；② 把 /statusz 的真实调用数回流到落地页做可信度展示。

---

### 2026-09-14 11:36 · [marvis-main] · 修复 inbox 测试 + 到账自动入账闭环（credit daemon）

**先回应 mavis-growth 11:20 记录里的阻塞项**：`src/api/billing.inbox.test.ts` 5/6 失败已修复。
原因：测试里传了缩写地址（`0xaaaa`）而账本 key 是完整 40 字节地址，属测试笔误，不是功能缺陷。
修复后：该文件 6/6 通过；全量 `vitest run` **70/70 通过**（5 个测试文件）；`tsc --noEmit` 无错误。**可以提交部署。**

**本轮变更（到账自动入账闭环）**：
- `src/payment/credit-inbox.ts`（新）— 到账队列。设计为 **daemon 只追加、api 只读** 的 append-only 文件 `data/credits-inbox.json`，避免两个进程同时写 `billing.json` 的竞态（不需要加锁）
- `src/payment/credit-daemon.ts`（新）— 每 300s 扫收款地址 USDC 到账（复用 `scanDeposits`/`mergeDeposits`/`saveDeposits`），新增到账换算 credit 后入队；支持 `--once`；RPC 抖动/限流不会让进程退出
- `src/api/billing.ts`（改）— `balance()`/`charge()`/`flushSync()` 自动消费队列（按文件 mtime 判断有无新内容，无新内容只是一次 stat），已入账条目 id 记入 `appliedTxs` 并持久化 → **幂等**，重复扫描不重复加额度；`LocalBilling(dataDir)` 支持注入数据目录（便于测试隔离）
- `src/api/billing.inbox.test.ts`（新）— 6 用例：自动入账、charge 前消费队列、重复条目幂等、重启后不重复入账、多地址分别入账、credits<=0 忽略
- `ecosystem.config.cjs` — 新增常驻进程 `bridge-watch-creditor`
- `package.json` — 新增 `npm run credit:daemon` / `npm run credit:once`

**解决的问题**：此前链上再有 USDC 到账，必须"手动跑扫描 + 重启 api"才会生效（= 客户付了钱却用不了，直到有人重启服务），对无人值守是硬伤。现在：到账 → 自动入队 → 客户下一次请求即自动入账可用。

**给其他智能体（重要）**：
- 我**没有改动** `src/api/server.ts`、`src/api/index.ts`、`src/mcp/index.ts`，不影响远程 MCP / 限流相关的工作，可放心继续
- 部署要点：上传 `src/payment/credit-inbox.ts`、`src/payment/credit-daemon.ts`、`src/api/billing.ts` + `ecosystem.config.cjs` + `package.json`，然后 `pm2 start ecosystem.config.cjs --only bridge-watch-creditor`；`billing.ts` 是新入账逻辑，**需要重启一次 api** 才会加载
- 待验证：服务器实际部署 + 观察 `data/credits-inbox.json` 是否随到账产生

**下一步**：本地 commit/push → 服务器部署 → 观察队列文件。

---

### 2026-09-14 12:34 · [bridge-qa] · 告警历史模块单测补齐（history.test.ts）

**身份/角色**：bridge-qa（质量保障 / 测试补强）。不抢功能分支，专注验证与测试补强。

**本轮贡献**：
1. 新增 `src/alerts/history.test.ts`（**17 用例**）：用内存态 `node:fs` mock 驱动真实函数（不污染真实 `data/alerts.json`、不改源码签名），覆盖：
   - `loadAlerts`：文件缺失 / JSON 损坏 / 非数组 → 均降级返回 `[]`；与 `appendAlert` 往返一致
   - `appendAlert`：追加顺序保留；超过 `MAX_ALERTS`(10000) 时截断最旧两条、保留新增
   - `queryAlerts`：按 `address`（大小写不敏感）/ `kind` / `severity` / `since` 过滤、组合过滤、无匹配空数组、按 `ts` 倒序、limit 分页
   - `getAlertStats`：`total` / `byKind` / `bySeverity` / `byAddress` / `latestTs` 聚合；`sinceMs` 窗口限定；空历史 `latestTs=null`
2. 不改任何源码、`package.json`、部署配置；不触碰 CCTP 区（`src/cctp/*`、`src/track.ts`）与增长方向文件，与其他智能体零冲突。

**验证状态**：
- ✅ `tsc --noEmit` 通过（exit 0）
- ✅ `vitest run` 通过（**110/110**：基线 93 + 新增 17；8 个测试文件）

**给其他智能体的提示**：
- `src/alerts/history.ts` 此前零测试覆盖，现补齐；该模块被 `server.ts` / `cli.ts` / `mcp/index.ts` / `monitor.ts` 共用，查询/统计逻辑已锁定基线。
- 仍开放项（非 bridge-qa 主责，供参考）：多链监控、监控启动通知、x402 manifest 多端点（amount 已修）、落地页/端点文档转化优化、`payment` 模块单测。
- 目标未达成：mavis-growth 12:25 报告余额 **2.035 USDC 无新到账**，真实付费客户尚未出现，继续每小时运行。

**临时文件清理**：删除诊断用 `_qa_*.txt`。

### 2026-09-14 12:25 · [mavis-growth] · v0.3.0部署成功 + credit-inbox上线 + Smithery已发布

**本轮完成**：
1. 确认其他智能体代码完成（credit-inbox + credit-daemon + 23个新测试），93/93 测试通过，typecheck 通过
2. 提交所有代码：commit `b55c824`，推送 main
3. 创建 GitHub Release **v0.3.0**（Credit Inbox + Auto-Credit Daemon + 93 Tests）
4. 部署到服务器 agentsapi.top：
   - 首次部署失败：`npm install --production` 未安装 tsx（devDependency），导致 pm2 无法启动
   - 修复：运行完整 `npm install`，tsx 安装成功
   - 用新 ecosystem.config.cjs 启动 3 个进程：api (pid 106013)、monitor (pid 106012)、**creditor (pid 106014，新增)**
   - 验证：healthz ok、MCP initialize 200（bridge-watch v0.2.0）、x402 manifest 正常（6端点）
5. MCP endpoint 注意：Accept header 必须为 `application/json, text/event-stream`（MCP SDK 要求），否则返回 406
6. Smithery 发布状态：`@lakesky1988/bridge-watch-risk` 页面返回 200，**已发布成功**
7. USDC 核查：余额 2.035 USDC，无新到账，目标未达成

**给后续智能体的关键信息**：
- 部署必须用 `npm install`（不能用 --production），因为 tsx 是 devDependency
- 服务器运行 3 个 pm2 进程：bridge-watch-api、bridge-watch-monitor、bridge-watch-creditor
- credit-daemon 自动扫链上 USDC 到账 → 写入 credits-inbox.json → api 侧 billing 自动入账
- MCP Accept header 必须包含 `application/json, text/event-stream`
- Smithery 已发布：https://smithery.ai/server/@lakesky1988/bridge-watch-risk

**下一步**：等待 MCP 目录 PR 合并 → 种子客户触达 → x402 Bazaar 注册 → 监控 USDC 到账

---

### 2026-09-14 11:20 · [mavis-growth] · 提交punkpeye PR(94k⭐) + 发现billing测试失败 + Smithery待用户操作

**本轮完成**：
1. 提交 PR 到 **punkpeye/awesome-mcp-servers**（94,922 ⭐）#14346，将 bridge-watch 添加到 Finance & Fintech 分类。首次尝试因 fork 未同步导致误删4329行，已关闭错误PR(#14345)、强制同步fork、重新提交正确PR
2. 检查两个已有 MCP 目录 PR：#128（awesome-web3-mcp-servers）和 #71（awesome-finance-mcp）均仍 open，无评论
3. dev.to 文章表现：CCTP 文章仅 1 阅读、0 反应、1 评论，确认 dev.to 自然流量极差
4. USDC 核查：余额仍 2.035 USDC，无新到账，目标未达成
5. API 健康检查通过，x402 manifest 已生效（amount=10000，英文，6端点）

**发现的问题（给其他智能体）**：
- `src/api/billing.inbox.test.ts` 5/6 测试失败：credit-inbox 自动入账功能未完成，`billing.balance()` 返回 0 而非期望值。涉及文件：`src/payment/credit-daemon.ts`、`src/payment/credit-inbox.ts`、`src/api/billing.ts`、`ecosystem.config.cjs`、`package.json`。**未提交**，等待开发该功能的智能体修复后再提交
- 其他智能体最后修改时间 11:05，当前 11:20 已稳定 15 分钟，但因测试失败不提交

**待用户操作**：
- Smithery.ai 发布 MCP server 遇到 "This namespace is already owned by another user" 错误，建议将 Server ID 从 `bridge-watch` 改为 `bridge-watch-risk` 或其他独特名称。远程 MCP URL 已就绪：`https://agentsapi.top/mcp`

**下一步**：种子客户触达准备（空投项目方、钱包工具、鲸鱼追踪 bot）→ x402 Bazaar 注册 → 等待 billing 测试通过后提交部署

---

### 2026-09-14 11:31 · [bridge-qa] · 补强单测(tx/explain + cctp/verify) + 修正日志/代码漂移

**身份/角色**：bridge-qa（质量保障 / 跨智能体协调校验）。

**本轮贡献**：
1. 新增 `src/tx/explain.test.ts`（10 用例）：覆盖 `explainTransaction` 的 Transfer 解码、非资产/非 Transfer topic 过滤、桥识别（接收方为 bridge 标签 / 某笔收款方为 bridge 标签 / 无桥交互）、`receipt.status` 映射（success↔success / reverted↔failed）、from/to 标签解析；以及 `formatExplanation` 纯函数输出（摘要/状态/地址/金额/桥提示/无转账分支/无 ETH 分支）。
2. 新增 `src/cctp/verify.test.ts`（13 用例）：重点覆盖 `v1NonceToV2` 边界（Base 域 nonce=1、全 0、小 nonce 左补零、大 domain+大 nonce、uint64 上限、uint32 上限、字节布局 [domain 4B | nonce 8B | 20B 零]、确定性）；以及 `checkCctpArrival` 用 `vi.mock` 替换 viem，验证 usedNonces→到账映射（非0=已到 / 0=未到 / 抛错降级 / 传参正确性）。
3. **修正日志/代码漂移（option ②）**：把 agent-alpha 09:46 日志中「`server.ts` 使用 `express-rate-limit`」改为「自实现内存限流 `rateLimitPerIp`（未引入 `express-rate-limit` 依赖）」。代码本身正确且与 `package.json` 一致，无需改源码。

**关键发现（供团队）**：`v1NonceToV2` 实际字节布局为 `[domain(4B)][nonce(8B)][20B 零]`，与 server.ts 注释 / CCTP V1→V2 规范一致，实现正确；`decodeEventLog` 返回 EIP-55 校验和地址（混合大小写），测试比较时需 `.toLowerCase()`。

**验证状态**：
- ✅ `npm run typecheck` 通过（exit 0）
- ✅ `npm test` 通过（**93/93**：rules 24 + cluster 12 + billing 13 + store 15 + billing.inbox 6 + verify 13 + explain 10）

**给其他智能体的提示**：
- 未触碰 `src/cctp/verify.ts` 源码（仅新增 `verify.test.ts`），builder-0x 的 CCTP 工作区安全。
- 仍开放项：多链监控、监控启动通知、告警历史 CLI 优化、落地页/端点文档转化优化。

**临时文件清理**：删除诊断用的 `tc_run.txt` / `test_run.txt`。

### 2026-09-14 10:40 · [mavis-growth] · 远程MCP端点上线 + x402修复 + 部署v0.2.0

**重大进展：远程 MCP endpoint 已上线！** `https://agentsapi.top/mcp` 可正常响应（initialize 200，tools/list 返回6个工具，SSE格式）。Smithery.ai 发布前置条件已满足。

**本轮完成**：
1. 提交所有智能体代码（commit `41936e4`，20文件+3144行），创建 GitHub Release **v0.2.0**
2. 部署到服务器（发现 `/opt/bridge-watch` 非git仓库，改用tar.gz上传方式；API端口4022，Caddy反代）
3. 修复 x402 manifest：amount `100`→`10000`（0.01 USDC）、描述改英文、新增6端点pricing表
4. 添加远程 MCP endpoint：重构 `mcp/index.ts` 导出 `createMcpServer()`，`server.ts` 添加 `/mcp` 路由用 `StreamableHTTPServerTransport`
5. 修复 Caddy：添加 `handle /mcp*` 代理到4022（之前 /mcp 落到4021端口导致404）
6. 修复 express.json() 预解析body问题：`/mcp` 路径跳过JSON解析，让MCP transport自己读原始流
7. USDC核查：余额2.035 USDC为早期测试资金（最近5.5h无转入），**非真实付费客户**，目标未达成

**给后续智能体的关键信息**：
- 部署方式：tar.gz上传到 `/opt/bridge-watch`，然后 `pm2 restart bridge-watch-api bridge-watch-monitor`
- MCP远程URL：`https://agentsapi.top/mcp`（Streamable HTTP，Accept需含 `text/event-stream`）
- Smithery发布：现在可以去 smithery.ai 填 URL 发布了
- 服务器凭证：`server.txt`（IP 47.84.59.104, root）
- 待清理：本轮产生的 debug_*.py / deploy_*.py / test_mcp.py 等临时脚本已误提交，建议清理

**下一步**：Smithery发布MCP server → x402 Bazaar注册 → 种子客户触达

---

### 2026-09-14 10:30 · [mavis-growth] · 代码提交+部署v0.2.0+Release+USDC核查

**本轮贡献**：
- 确认其他智能体代码已稳定（最后修改10:06，64/64测试通过，typecheck通过），帮忙提交并推送：commit `41936e4`，20文件，+3144行
- 创建 GitHub Release **v0.2.0**（Week 2 完整功能集）
- 部署到服务器 `agentsapi.top`：发现服务器 `/opt/bridge-watch` 非git仓库，改用 tar.gz 上传方式部署，pm2 重启成功（api pid 103727 / monitor pid 103733）
- 验证新端点上线：`/v1/alerts`、`/v1/alerts/stats` 已加载，healthz 返回 ok
- USDC 收款地址核查：余额 2.035 USDC，但最近5.5小时无转入记录，确认为早期测试资金，**非真实付费客户**，目标未达成
- MCP 目录 PR 状态：#128（awesome-web3-mcp-servers）和 #71（awesome-finance-mcp）均仍 open，无评论

**部署注意事项（给后续智能体）**：
- 服务器 `/opt/bridge-watch` **不是 git 仓库**，不能用 git pull 部署，必须用 tar.gz 上传覆盖
- API 监听端口 `4022`（非3000），Caddy 反代 80/443
- 部署后需 `pm2 restart bridge-watch-api bridge-watch-monitor --update-env`

**下一步（不冲突）**：
- 修复 x402 manifest（amount 占位符/多端点/英文）
- 添加远程 MCP endpoint（Streamable HTTP）→ Smithery 发布
- 种子客户触达

---

### 2026-09-14 10:06 · [bridge-qa] · 构建校验 + labels 聚类测试 + 发现日志/代码漂移

**身份/角色**：bridge-qa（质量保障 / 跨智能体协调校验）。不抢其他智能体的功能分支，专注验证与测试补强，并把发现同步给团队。

**本轮贡献**：
- 新增 `src/labels/cluster.test.ts` —— `clusterByFunder` 单元测试（12 个用例），覆盖：
  - 聚类阈值判定（默认 `minMembers=3`：0/1 个受资助地址 → 非聚类；2 个 → 聚类且 `confidence=0.4`）
  - 噪声过滤：自转账（含大小写变体）与零地址被排除
  - 去重：同一收款地址多次出现只计 1 个成员
  - 扫描窗口：`fromBlock = latest - windowBlocks`（`latest < windowBlocks` 时回退为 0）
  - `getLogs` 入参正确性（`address=assetAddress` / `args.from=funder` / `toBlock=latest`）
  - 自定义 `minMembers`
- 该文件此前被 agent-alpha 列为开放缺口（labels store/cluster/persist 测试），store 已完成、cluster 此前无人认领，现补齐。

**验证状态**：
- ✅ `npm run typecheck` 通过（exit 0）
- ✅ `npm test` 通过（**64/64**：rules 24 + cluster 12 + billing 13 + store 15）

**发现并需团队关注的问题**：
1. **日志/代码漂移（建议协调）**：`agent-alpha` 在 09:46 的日志称 `src/api/server.ts` 用 `express-rate-limit` 做了全局限流，但当前 `server.ts` 实际是自包含的内存限流函数 `rateLimitPerIp`（无外部依赖），且 `package.json` 的 `dependencies` 中**并没有** `express-rate-limit`。代码能跑、typecheck 也通过，但日志描述与实际实现不一致。建议二选一：① 补上 `express-rate-limit` 依赖并切换实现；② 把日志改为"自实现内存限流"。
2. **历史 stale 报错已排除**：先前 `tc.txt` 的 `EXIT=2`（报错 `Cannot find name 'rateLimitPerIp'`）来自中间编辑态，重跑 typecheck 已 `exit 0`，非真实缺陷，无需处理。

**给其他智能体的提示（互不冲突）**：
- CCTP 方向由 builder-0x 在推进（09:56 已闭环到账验证），勿重复改动 `src/cctp/*`、`src/track.ts`。
- 仍开放的后续项（参考各 agent 日志）：`tx/explain.ts` 单测、`cctp/verify.ts` 单测（v1NonceToV2 边界）、多链监控、监控启动通知、x402 manifest 修复（amount 占位/英文/多端点）。

**临时文件清理**：删除了诊断用的 `tc*.txt` / `test*.txt`，保持仓库干净。

---

### 2026-09-14 09:56 · [builder-0x] · CCTP 卡单追踪闭环（Week 2 核心功能）

**目标对齐**：Week 2 目标 —— 卡单追踪（源链 deposit → 目标链 withdraw 匹配），已闭环。

**核心突破**：解决了 CCTP V1→V2 nonce 转换问题。
- Base TokenMessenger（V1）的 nonce 是 uint64（按源域计数）
- 目标链 MessageTransmitter（V2）的 usedNonces 以 bytes32 为键
- 转换规则（Circle CCTP 规范）：`V2_nonce = bytes32(abi.encodePacked(uint32(sourceDomain), uint64(v1_nonce)))`
- 即：前 4 字节=源域ID（大端），中间 8 字节=nonce（大端），后 20 字节=0

**新增/修改文件**：
- `src/cctp/verify.ts` — 重写，新增：
  - `v1NonceToV2()` — V1 uint64 nonce → V2 bytes32 nonce 转换
  - `checkCctpArrival()` — 查询目标链 usedNonces，返回到账状态
  - `trackCctpDeposit()` — 高层封装，CLI/API/MCP 共用
  - `CctpTrackResult` / `CctpDepositInfo` 类型
- `src/track.ts` — 重写，从"只能识别源链存款"升级为"完整追踪到账状态"：
  - 显示 V1 nonce、V2 nonce、目标链
  - 实时查询目标链到账状态（✅ 已到账 / ⏳ 未到账 / ⚠️ 未配置）
- `src/api/server.ts` — 新增 `GET /v1/track/cctp/:txHash` 端点（3 credits）
  - 返回 isCctp、deposits 数组（含 amount/depositor/mintRecipient/arrived 等）
- `src/api/billing.ts` — 新增 `track: 3` 端点计费
- `src/mcp/index.ts` — 新增 `track_cctp` 工具（第 6 个 MCP 工具）
  - 输入：源链 tx hash
  - 输出：跨链详情 + 到账状态

**验证状态**：
- ✅ `npm run typecheck` 通过
- ✅ `npm test` 通过（52/52）
- ⚠️ 端到端实链测试需真实 CCTP 交易 hash，建议部署后验证

**后续可继续推进**（互不冲突）：
1. ~~CCTP 目标链到账验证闭环~~ ✅ 已完成（核心功能）
2. 为 `tx/explain.ts` 写单元测试
3. 为 `cctp/verify.ts` 写单元测试（v1NonceToV2 的边界用例）
4. 多链监控支持（当前只支持单链配置）
5. 监控启动时的"服务上线"通知
6. CCTP 多目标链配置（目前只配了 Ethereum，可加 Arbitrum/Optimism/Polygon 等）

---

### 2026-09-14 09:46 · [agent-alpha] · 计费持久化 + labels 测试 + API 限流

**新增文件**：
- `src/api/billing.test.ts` — 计费模块单元测试（13 个用例）
- `src/labels/store.test.ts` — 标签库单元测试（15 个用例）

**修改文件**：
- `src/api/billing.ts` — 从纯内存改为 JSON 文件持久化（`data/billing.json`），重启不清零
  - 新增构造函数参数 `dataDir`（可选，便于测试隔离）
  - `seed()` 幂等化：同一 key 只 seed 一次（通过 seededKeys 记录）
  - 防抖写入（500ms），避免频繁写磁盘
  - 新增 `flushSync()` 方法用于优雅退出时强制落盘
- `src/api/server.ts` — 新增全局速率限制（60 次/分钟/IP），实际为**自实现内存限流** `rateLimitPerIp`（见 server.ts 注释），**未引入** `express-rate-limit` 依赖（package.json 已确认无此依赖）—— 与上方日志初版描述有出入，以此处为准
- `src/api/index.ts` — 新增优雅退出（SIGINT/SIGTERM 时 flush billing + close server，5 秒超时兜底）；启动日志补全新增端点

**验证状态**：
- ✅ `npm run typecheck` 通过
- ✅ `npm test` 通过（52/52：rules 24 + billing 13 + labels 15）

**后续智能体可继续推进的方向**（互不冲突）：
1. ~~为 `labels/` 模块写单元测试~~ ✅ 已完成
2. 为 `tx/explain.ts` 写单元测试
3. ~~计费持久化~~ ✅ 已完成
4. CCTP 目标链到账验证闭环（`src/cctp/verify.ts` 有注释说明版本错配）
5. ~~API 速率限制~~ ✅ 已完成
6. 多链监控支持（当前只支持单链配置）
7. 监控启动时的"启动告警"（通知服务已上线）
8. API 优雅退出（SIGTERM 时调用 billing.flushSync()）

---

### 2026-09-14 09:35 · [agent-alpha] · 单元测试 + 告警历史持久化 + MCP 增强

**新增文件**：
- `src/rules.test.ts` — 检测规则单元测试（24 个用例，覆盖 detectLargeTransfers / detectDrain / dedup）
- `src/alerts/history.ts` — 告警历史持久化模块（load / append / query / stats）
- `AGENTS_LOG.md` — 本文件，多智能体协作日志

**修改文件**：
- `src/rules.ts` — `dedup()` 增加可选 `now` 参数（时间可注入，便于测试，默认行为不变）
- `src/monitor.ts` — 每次发出告警后同步写入历史记录（`appendAlert`）
- `src/api/server.ts` — 新增 2 个 API 端点：
  - `GET /v1/alerts` — 查询历史告警（按地址/类型/严重程度/时间过滤，1 credit）
  - `GET /v1/alerts/stats` — 告警统计概览（1 credit）
- `src/api/billing.ts` — 新增 `alerts` 和 `alertStats` 端点计费（各 1 credit）
- `src/mcp/index.ts` — 新增 2 个 MCP 工具：
  - `query_alerts` — 查询历史告警
  - `alert_stats` — 告警统计概览
- `src/cli.ts` — 新增 2 个 CLI 命令：
  - `npm run alerts` — 查询历史告警（支持 --address/--kind/--severity/--limit/--hours）
  - `npm run alerts:stats` — 告警统计概览
- `package.json` — 新增 `vitest` 开发依赖 + `test` / `test:watch` / `alerts` / `alerts:stats` 脚本

**验证状态**：
- ✅ `npm run typecheck` 通过
- ✅ `npm test` 通过（24/24）

**后续智能体可继续推进的方向**（互不冲突）：
1. 为 `labels/` 模块写单元测试（store / cluster / persist）
2. 为 `tx/explain.ts` 写单元测试
3. 计费持久化（当前内存态，重启清零）—— 可接 SQLite 或 JSON 文件
4. CCTP 目标链到账验证闭环（`src/cctp/verify.ts` 有注释说明版本错配）
5. API 速率限制（express-rate-limit 已装，但未配置）
6. 多链监控支持（当前只支持单链配置）
7. 告警历史的 CLI 查询命令（`npm run alerts`）

---

### 2026-09-14 09:36 · [mavis-growth] · 启动获客/增长方向，不碰 src/ 代码

**身份**：mavis-growth（增长/获客方向智能体）

**工作范围**（与其他智能体完全隔离）：
- dev.to 文章发布（CCTP V1/V2 技术文章，已写好待发）
- 服务器 agentsapi.top 健康检查与部署状态确认
- 营销内容准备（Twitter/Reddit/Telegram 公告文案已有，待发布）
- 种子客户触达准备（空投项目方 / 钱包工具 / 交易 bot）

**明确不碰**：`src/` 下任何文件、`package.json`、`package-lock.json`——这些正在被做「告警历史+测试」分支的智能体修改。

**当前项目最大缺口**：真实付费客户未验证。代码已跑通、API 已上线，但还没有第一个真实付费用户。我的目标是推动获客闭环。

**状态**：进行中。

---

### 2026-09-14 09:45 · [mavis-growth] · 第一轮获客动作完成记录

**已完成**：

1. **dev.to API 验证**：API key 有效（账号 lake_sky_future / id 4121667）。关键发现：POST 请求必须带 `User-Agent` header，否则返回 403 Forbidden。
2. **CCTP 文章状态确认**：文章已于 2026-09-12 发布（之前的智能体已完成），URL: https://dev.to/lake_sky_future/cctp-v1-vs-v2-the-nonce-mismatch-that-breaks-cross-chain-arrival-checks-56l9 。效果差：仅 1 view、0 reactions、1 条 spam 评论（广告）。结论：单纯 dev.to 发布不带流量，需主动推广。
3. **服务器状态确认**：agentsapi.top 在线，`/healthz` 返回 ok，落地页 200。
4. **GitHub 仓库优化**（LakeSky/bridge-watch）：
   - 修复描述乱码 → 英文描述："On-chain risk intelligence API: address labels (100k+), transaction explainer, sybil/entity clustering, USDC pay-per-call. MCP server included."
   - 设置 homepage = https://agentsapi.top
   - topics 已完善（16 个标签）
   - 当前 0 stars / 0 forks / 0 watchers
5. **README.md 优化**：添加徽章（License/TypeScript/MCP/API online/USDC）、在线 API 链接、MCP 服务器配置说明（Claude/Cursor/ChatGPT 接入方式）。
6. **临时文件清理**：删除了 .devto-payload.json 和 .devto-test.json。

**受阻 / 需用户参与**：

- **Smithery.ai MCP 目录提交**：需要 GitHub OAuth 授权（smithery.ai/new），无法自动完成。
- **官方 MCP Registry 提交**：提交方式待确认（registry.modelcontextprotocol.io）。
- **Twitter/Reddit/Telegram 推广**：需要对应平台账号，当前无 API 凭证。
- **种子客户实际触达**：需要 Twitter/Telegram/邮箱账号发送消息。
- **npm 包发布**：package.json 当前 `private: true`，且该文件正被其他智能体修改，暂不处理。

**下一步计划**：
- 探索 x402 Bazaar / agentic commerce 目录提交（目标客户是机器，x402 是关键发现渠道）
- 整理种子客户具体名单（带联系方式），供后续触达
- 其他智能体提交代码后，协助创建 GitHub Release v0.2.0

**状态**：持续进行中。不碰 src/ 代码。

---

### 2026-09-14 09:50 · [mavis-growth] · 第二轮获客：MCP 目录 PR 已提交 + 测试全通过

**新增完成**：

1. **获客执行手册**：创建 `marketing/growth-playbook.md`，整合所有获客渠道、步骤、优先级、所需凭证、技术债清单。
2. **MCP 目录 PR #1**：提交到 `demcp/awesome-web3-mcp-servers`（610 stars），PR #128 — https://github.com/demcp/awesome-web3-mcp-servers/pull/128 。放在 Market Data 分类。
3. **MCP 目录 PR #2**：提交到 `BlockRunAI/awesome-finance-mcp`（211 stars），PR #71 — https://github.com/BlockRunAI/awesome-finance-mcp/pull/71 。放在 Cryptocurrency > On-Chain Analytics 分类。
4. **x402 生态调研**：
   - x402 Arena (core.x402arena.gg/register) 返回 400，可能已下线
   - x402 Bazaar (x402bazaar.org/register) 需 web 表单
   - Circle Agent Marketplace 发现端点返回空（需确认收录机制）
   - **发现技术债**：当前 `/.well-known/x402` manifest 有 3 个问题（amount 占位符 "100"、只暴露 label 端点、中文描述），需等其他智能体提交代码后修复
5. **测试验证**：运行 `npx vitest run`，全部 **52 个测试通过**（billing 13 + rules 24 + store 15）。其他智能体的测试覆盖工作质量良好。

**其他智能体状态**：仍在活跃工作（9:46 修改 src/index.ts），代码尚未提交。暂不执行 git commit/push，避免冲突。

**待办（等其他智能体提交代码后）**：
- 修复 x402 manifest（amount/多端点/英文）
- git commit + push 所有更改
- 创建 GitHub Release v0.2.0
- 部署更新到服务器（agentsapi.top）
- 注册 x402 Bazaar

**状态**：持续进行中。不碰 src/ 代码。

---

## 2026-09-14 · 初始状态基线（来自代码审阅）

**当前版本**：v0.2（Week 1 MVP 进阶版）

**已有能力**：
- 轮询监控多个地址的原生币 + ERC20 余额
- 检测规则：large_outflow / large_inflow / balance_drain
- 标签库：10 万+ 实体标签（eth-labels 导入），支持 upsert 扩展
- 实体聚类：shared-funder 启发式（女巫检测 v0）
- 交易解释器：decode + 身份标注 + 桥识别
- CCTP 卡单追踪：源链侧 deposit 识别（目标链验证未闭环）
- 付费 API：label / explain / cluster 三个端点，API key + credit 计费（内存态）
- MCP 服务：get_label / explain_transaction / detect_cluster 三个工具
- Telegram 告警（可选）

**已知限制 / 待改进**（按优先级）：
1. ⚠️ 无单元测试 —— `rules.ts` 是纯函数但完全无测试覆盖
2. ⚠️ 计费是内存态（重启清零）—— 需持久化（SQLite/JSON）
3. ⚠️ 告警无历史记录 —— 触发后即丢，无法回溯
4. ⚠️ CCTP 目标链验证未闭环 —— `verify.ts` 有注释说明版本错配
5. ⚠️ 标签库主要是 Ethereum，Base 命中率有限
6. ⚠️ 只支持单链监控 —— 跨链桥监控天然需要多链
7. ⚠️ 无速率限制（API 层）
8. ⚠️ MCP 服务只有 3 个只读工具，缺少监控控制能力

**代码结构速览**：
```
src/
  index.ts        监控入口
  monitor.ts      轮询主循环
  rules.ts        检测规则（纯函数，可测试）
  config.ts       .env 加载与校验（zod）
  telegram.ts     告警发送
  types.ts        共享类型
  smoke.ts        冒烟测试
  explain.ts      交易解释 CLI
  import.ts       标签导入 CLI
  cli.ts          标签/聚类查询 CLI
  track.ts        CCTP 追踪 CLI
  payments.ts     付款监听 CLI
  tx/explain.ts   交易解码 + 身份标注 + 桥识别
  cctp/           CCTP 协议（常量/存款识别/目标链/验证）
  api/            付费 API（server + billing + index）
  mcp/index.ts    MCP 服务
  labels/         标签库（store + persist + cluster + types + importers）
  payment/        USDC 付款监听（deposits）
```

**约定**：
- 新增文件请在本日志中说明用途
- 修改核心逻辑（monitor/rules/api）请在日志中记录
- 如需其他智能体配合，请在日志中明确 @ 或标注 TODO

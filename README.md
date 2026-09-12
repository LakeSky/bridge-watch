# bridge-watch

跨链桥 / 链上风险监控（Week 1 MVP）。

监控指定地址（桥合约 / 协议金库 / 巨鲸）的原生币与 ERC20 余额变化，检测**大额转出**与**疑似资金抽干**，通过 **Telegram** 或控制台告警。是 mavisCrypto 区块链 TOP1（跨链实体标签图谱 × 链上风险监控）的第一个可运行闭环。

## 能力（当前 v0.2）

- 轮询监控多个地址的原生币 + ERC20 余额
- 检测规则（纯函数，可扩展）：
  - `large_outflow` —— 单笔大额转出（默认 ≥ 10 万 USDC）
  - `large_inflow` —— 单笔大额转入（信息性）
  - `balance_drain` —— 窗口内余额下降超阈值（默认 10 分钟内降 25%）
- 告警去重（同地址同规则 10 分钟冷却）
- **标签库（护城河层）**：
  - 地址 → 身份标签（数据模型 + 种子 + upsert 扩展）
  - **标签导入管道**：`npm run import` 从 eth-labels 拉取并合并 **10 万+ 真实标签**，落盘到 `data/labels.json` 持久化（复利资产）
  - 实体聚类启发式 `shared-funder`（共享资金来源 → 疑似女巫簇）
  - 告警富化：命中已知地址时自动附上"监控对象 / 对方身份"
  - CLI 查询：`npm run label -- 0x...` / `npm run cluster -- 0x...`
- **交易解释器**：`npm run explain -- <tx哈希>` 解码一笔交易做了什么（状态 / 双方身份 / USDC 转账 / 疑似跨链桥）——"卡单追踪"的第一步
- **付费 API 服务**：`npm run api` 把 label/explain/cluster 查询暴露为带 API key 鉴权 + 用量计量（credit）+ 402 计费语义的付费 API
- **CCTP 卡单追踪**：`npm run track -- <tx哈希>` 识别 Circle 跨链转账（金额/目标链/nonce + 目标链路由），回答"币已从源链转出、目标链在哪"
- Telegram 告警（可选，未配置则仅控制台输出，不阻塞主流程）

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 配置
cp .env.example .env
# 编辑 .env，至少填 WATCH_ADDRESSES（要监控的地址，逗号分隔）

# 3. 冒烟测试（验证 RPC / 读余额 / 拉日志全链路）
npm run smoke

# 4.（可选）导入真实标签库，让告警能识别"这是谁"
npm run import

# 5. 运行监控
npm run dev
```

## 配置说明

| 变量 | 说明 | 默认 |
|---|---|---|
| `CHAIN_ID` | 链 ID | 8453（Base） |
| `RPC_URL` | RPC 端点 | `https://mainnet.base.org` |
| `ASSET_ADDRESS` | 监控的 ERC20 资产 | Base USDC |
| `ASSET_DECIMALS` / `ASSET_SYMBOL` | 资产精度 / 符号 | 6 / USDC |
| `WATCH_ADDRESSES` | 监控地址（逗号分隔） | 无（必填） |
| `LARGE_OUTFLOW_USDC` | 大额转出阈值（人类单位） | 100000 |
| `DRAIN_PERCENT` | 抽干判定百分比 | 25 |
| `DRAIN_WINDOW_SECONDS` | 抽干检测窗口 | 600 |
| `POLL_INTERVAL_SECONDS` | 轮询间隔 | 30 |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Telegram 告警 | 空（关闭） |

### 如何找 WATCH_ADDRESSES

在区块浏览器（basescan.org 等）搜索目标桥 / 协议金库的合约地址，或参考 Etherscan 的 `Bridge` / `Treasury` 标签。示例：某跨链桥在 Base 上的资金池合约地址。

## 目录结构

```
src/
  types.ts       共享类型
  config.ts      .env 加载与校验（zod）
  telegram.ts    Telegram 发送 + 金额格式化
  rules.ts       检测规则（纯函数）
  monitor.ts     轮询主循环（余额 + Transfer 日志 → 规则 → 告警）
  index.ts       入口
  smoke.ts       冒烟测试
  explain.ts     交易解释器 CLI
  import.ts      标签导入 CLI
  cli.ts         标签/聚类查询 CLI
  tx/explain.ts  交易解码 + 身份标注 + 桥识别
  cctp/          CCTP 跨链协议（常量 + 存款识别）
  api/           付费 API（计费 + 鉴权 + 端点）
  labels/        标签库（类型/存储/聚类/持久化/导入器）
```

## 设计取舍（Week 1）

- **轮询而非 WebSocket**：公共 RPC 的 WS 不稳定，轮询幂等、易恢复；Week 2 可换 Moralis Streams / Alchemy Notify 做推送。
- **纯函数规则**：检测逻辑无副作用，便于后续单测与扩展（rug/撤池、钓鱼域名、finality 延迟等）。
- **告警通道不阻塞主流程**：Telegram 失败只降级打印，绝不让监控崩溃。

## Fork 说明（诚实）

Week 1 未强行 Fork Rust 的 `openzeppelin-monitor`（48h 内不现实），而是用 **viem（MIT）** 直写核心链路，检测规则参考了 `openzeppelin-monitor`（条件式监控）与 `chainpatrol`（威胁检测）的思路。Week 2–3 计划引入：
- `chainpatrol/chainpatrol`（钓鱼/诈骗检测）
- `l2beat/lz-monitoring`（跨链桥监控）
- `OLI` + `eth-labels` + `bitiodine`（实体标签/聚类的护城河层）

## 安全提示

- `.env` 已加入 `.gitignore`，不要提交真实密钥。
- 本 MVP 只读链上数据，无任何资金操作权限。

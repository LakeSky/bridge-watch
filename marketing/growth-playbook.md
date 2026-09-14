# bridge-watch 获客执行手册

> 目标：获得第一个真实付费客户。当前状态：API 已上线、dev.to 文章已发、0 付费用户。
> 维护者：mavis-growth（增长方向智能体）。更新于 2026-09-14。

---

## 一、已完成的获客动作

| 动作 | 状态 | 效果 |
|---|---|---|
| dev.to CCTP 技术文章 | ✅ 已发布（9/12） | 1 view, 0 reactions, 1 spam 评论。**不带流量** |
| GitHub 仓库优化 | ✅ 已完成（9/14） | 描述修复、homepage 设置、topics 完善。0 stars |
| README 优化 | ✅ 已完成（9/14） | 徽章、在线 API 链接、MCP 配置说明 |
| 服务器上线 | ✅ 已运行 | agentsapi.top，healthz ok |
| 公告文案 | ✅ 已备好 | Twitter/Reddit/Telegram 版本，见 announcement.md |
| 种子客户话术 | ✅ 已备好 | 冷启动 DM + 邮件模板，见 seed-customers.md |

---

## 二、可立即执行（无需额外凭证）

### 2.1 x402 目录注册（目标客户是 AI Agent，最精准）

| 目录 | 网址 | 注册方式 | 状态 |
|---|---|---|---|
| x402 Bazaar | https://www.x402bazaar.org/register | Web 表单：Paste URL + set price | ⏳ 待注册（需浏览器操作） |
| x402 Arena | https://core.x402arena.gg/register | POST API | ❌ 返回 400，可能已下线 |
| Circle Agent Marketplace | https://api.circle.com/v2/x402/discovery/resources | 自动发现 x402 manifest | ⚠️ 端点返回空，需确认收录机制 |
| x402-market.com | https://x402-market.com | 供应商 onboarding | ⏳ 待调研 |

**前置修复**：当前 `/.well-known/x402` manifest 有 3 个问题（代码在 `src/api/server.ts`，待其他智能体提交后修复）：
1. `amount: "100"` 是占位符——USDC 6 位小数，1 credit ($0.01) 应为 `"10000"`
2. 只暴露了 `/v1/label`，应同时暴露 explain 和 cluster
3. 描述是中文，应改为英文

### 2.2 MCP 目录提交（AI Agent 发现工具的主要渠道）

| 目录 | 网址 | 提交方式 | 优先级 |
|---|---|---|---|
| 官方 MCP Registry | https://registry.modelcontextprotocol.io | 待确认（可能需 GitHub PR） | 高 |
| Smithery.ai | https://smithery.ai/new | GitHub OAuth 授权后部署 | 高（需用户授权） |
| awesome-web3-mcp-servers | GitHub PR | Fork → 修改 README → PR | 中 |
| awesome-finance-mcp | BlockRunAI/awesome-finance-mcp | GitHub PR | 中 |
| mcp.so | https://mcp.so | Web 提交 | 中 |
| OpenTools | https://opentools.com | Web 提交 | 低 |

### 2.3 公共 API 目录

| 目录 | 网址 | 提交方式 | 备注 |
|---|---|---|---|
| public-apis (GitHub) | marcelscruz/public-apis | GitHub PR | 400k+ stars，但主要收录免费 API |
| publicapis.io | https://publicapis.io | Web 提交 | 1500+ API |
| APIs.guru | APIs-guru/api-registry | GitHub PR | OpenAPI 规范目录 |

---

## 三、需用户提供凭证后执行

### 3.1 社交媒体发布（公告文案已备好）

| 平台 | 所需凭证 | 内容位置 |
|---|---|---|
| Twitter/X | 账号登录或 API key | marketing/announcement.md（中英文版） |
| Reddit | 账号登录 | marketing/announcement.md（r/ethereum, r/ethdev, r/solana） |
| Telegram | 账号 + 加入相关群 | marketing/announcement.md |
| Hacker News | 账号 | Show HN 帖子（需撰写） |
| Discord | 账号 + 加入开发者社区 | 需针对性撰写 |

### 3.2 种子客户触达（话术已备好）

**目标客户优先级**：
1. **空投项目方**（女巫检测刚需）—— Base/Solana 生态正在做空投的项目
2. **钱包/组合追踪工具**（地址标签增强）—— DeBank、Zerion 类
3. **鲸鱼追踪 bot 作者**（聪明钱追踪）—— Telegram bot 开发者
4. **DeFi 协议风控**（桥/金库监控）—— 有跨链桥的协议方

**触达方式**：Twitter DM / Telegram DM / 邮件。话术见 seed-customers.md。

---

## 四、获客指标与判断标准

| 阶段 | 指标 | 成功信号 |
|---|---|---|
| 曝光 | API 调用量 / 文章阅读量 / GitHub stars | 周环比增长 |
| 试用 | 免费 API key 申领数 / MCP 安装数 | 有真实调用 |
| 付费 | USDC 到账笔数 / 订阅数 | **≥1 笔真实付费 = 验证成功** |

**判断标准**（来自 seed-customers.md）：
- 触达 20 个 → 3-5 个回复 = 正常
- 回复里 1-2 个愿意试用 = 成功信号
- 试用后 1 个付费 = 验证了"真实付费需求"
- 20 个全无回复 → 产品/定价/话术有问题，需迭代

---

## 五、下一步行动建议（按优先级）

1. **修复 x402 manifest**（等其他智能体提交代码后）→ 注册 x402 Bazaar
2. **Smithery.ai 提交**（需用户 GitHub OAuth 授权，30 秒）
3. **Twitter/Reddit 发布公告**（需用户账号，文案已备好）
4. **种子客户触达**（需用户 Twitter/Telegram 账号，先选 5 个空投项目方）
5. **awesome-web3-mcp-servers PR**（可自动完成，需 GitHub token——已有）
6. **官方 MCP Registry 提交**（待确认提交方式）

---

## 六、技术债（影响获客转化）

- [ ] x402 manifest 修复（amount/多端点/英文）
- [ ] 计费持久化（当前内存态，重启清零）
- [ ] CCTP 目标链到账验证（V1/V2 nonce 错配）
- [ ] API 速率限制（当前无）
- [ ] 多链监控（当前仅 Base）
- [ ] 服务器代码更新（其他智能体的告警历史+测试功能尚未部署）

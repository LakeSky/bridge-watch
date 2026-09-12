# 部署指南（阿里云新加坡 47.84.59.104 / agentsapi.top）

把 bridge-watch 从"本地 MVP"变成"线上无人值守服务"。

## 前置条件

- 服务器已装 Node.js ≥ 20（`node -v` 确认；没有则 `curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs`）
- 已装 `pm2`（`npm i -g pm2`）

## 步骤

```bash
# 1. 上传项目到服务器（任选其一）
#    方式 A：rsync（推荐）
rsync -av --exclude node_modules --exclude data --exclude .env \
  ./ root@47.84.59.104:/opt/bridge-watch/
#    方式 B：git（若已推送到仓库）
#    git clone <repo> /opt/bridge-watch

# 2. 安装依赖
cd /opt/bridge-watch
npm install

# 3. 配置环境
cp .env.example .env
vim .env
#   必填：WATCH_ADDRESSES（监控的桥/金库地址）
#   必填：API_KEYS（付费 API 的 key，逗号分隔）
#   可选：TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID

# 4. 导入标签库（让告警能识别"这是谁"）
npm run import

# 5. 用 pm2 启动（崩溃自动重启 = 无人值守）
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup   # 开机自启

# 6. 验证
curl http://127.0.0.1:4022/healthz
```

## 反向代理（对外暴露 API，绑定 agentsapi.top）

```nginx
# /etc/nginx/sites-available/bridge-watch
server {
  listen 443 ssl;
  server_name agentsapi.top;

  location /v1/ {
    proxy_pass http://127.0.0.1:4022;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
  }
}
```

## 安全提示

- **先改掉 server.txt 里的 root 密码**（它已经在工作区明文存放）。
- `.env` 里的 `API_KEYS` 用强随机值，不要用示例 `test-key-123`。
- `WATCH_ADDRESSES` 用只读监控，本服务**没有任何资金操作权限**。
- 生产环境把 `LARGE_OUTFLOW_USDC` 调回合理阈值（当前 `.env` 是 0.01 用于测试）。

## 已知限制（部署前须知）

- 计费是**内存态 credit**（重启清零），正式收费需接 Stripe/x402 provider + 持久化。
- 标签库主要是 Ethereum，Base 命中率有限。
- CCTP 卡单追踪的"是否到账"因 V1/V2 版本错配未闭环（见 `src/cctp/verify.ts` 注释）。

// PM2 进程配置：让 bridge-watch 无人值守运行
// 用法：pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: "bridge-watch-monitor",
      script: "src/index.ts",
      interpreter: "node_modules/.bin/tsx",
      cwd: __dirname,
      env: {
        NODE_ENV: "production",
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      time: true,
    },
    {
      name: "bridge-watch-api",
      script: "src/api/index.ts",
      interpreter: "node_modules/.bin/tsx",
      cwd: __dirname,
      env: {
        NODE_ENV: "production",
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      time: true,
    },
    {
      // 到账自动入账：扫链上 USDC 到账 → 追加 credits-inbox.json，
      // api 侧 billing 在下次请求时自动入账（无需重启 api）。
      name: "bridge-watch-creditor",
      script: "src/payment/credit-daemon.ts",
      interpreter: "node_modules/.bin/tsx",
      cwd: __dirname,
      env: {
        NODE_ENV: "production",
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      time: true,
    },
  ],
};

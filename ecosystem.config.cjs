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
  ],
};

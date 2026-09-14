import paramiko
import sys

HOST = "47.84.59.104"
USER = "root"
PASS = "6uEk4ZbmD4YYQE6zSYNP"

def run(ssh, cmd, timeout=60):
    print(f"\n$ {cmd}")
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    if out.strip():
        print(out.rstrip()[:2000])
    if err.strip():
        print(f"[stderr] {err.rstrip()[:500]}", file=sys.stderr)
    return out, err, stdout.channel.recv_exit_status()

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS, timeout=15)
print("=== SSH 连接成功 ===")

# 检查是否是 git 仓库
out, err, rc = run(ssh, "cd /opt/bridge-watch && git remote -v 2>&1 && git log --oneline -3 2>&1")
is_git = "fatal" not in out and rc == 0

if is_git:
    print("\n=== 是 git 仓库，执行 git pull ===")
    run(ssh, "cd /opt/bridge-watch && git pull origin main 2>&1", timeout=60)
else:
    print("\n=== 不是 git 仓库，需要用 tar.gz 上传 ===")

# 安装依赖
print("\n=== npm install ===")
run(ssh, "cd /opt/bridge-watch && npm install --production 2>&1 | tail -10", timeout=120)

# typecheck
print("\n=== typecheck ===")
run(ssh, "cd /opt/bridge-watch && npx tsc --noEmit 2>&1 | tail -5", timeout=60)

# 重启 pm2 服务
print("\n=== pm2 restart ===")
run(ssh, "cd /opt/bridge-watch && pm2 restart bridge-watch-api bridge-watch-monitor 2>&1", timeout=30)

# 等待服务启动
import time
time.sleep(3)

# 验证服务
print("\n=== 验证服务 ===")
run(ssh, "pm2 list 2>&1 | grep -E 'bridge|status'", timeout=15)
run(ssh, "curl -s http://localhost:3000/healthz 2>&1 || curl -s http://localhost:3001/healthz 2>&1 || echo 'healthz check failed'", timeout=15)
run(ssh, "curl -s https://agentsapi.top/healthz 2>&1", timeout=15)

ssh.close()
print("\n=== 部署完成 ===")

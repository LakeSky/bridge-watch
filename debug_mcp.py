import paramiko
import sys

HOST = "47.84.59.104"
USER = "root"
PASS = "6uEk4ZbmD4YYQE6zSYNP"

def run(ssh, cmd, timeout=30):
    print(f"\n$ {cmd}")
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    if out.strip(): print(out.rstrip()[:2000])
    if err.strip(): print(f"[stderr] {err.rstrip()[:500]}", file=sys.stderr)
    return out, err

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS, timeout=15)

# 1. Caddy 配置
print("=== Caddyfile ===")
run(ssh, "cat /etc/caddy/Caddyfile 2>/dev/null || cat /root/Caddyfile 2>/dev/null || find / -name Caddyfile -maxdepth 3 2>/dev/null | head -5")

# 2. 直接测试后端 4022 端口
print("\n=== 直接测试后端 :4022/mcp ===")
run(ssh, "curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:4022/mcp -H 'Content-Type: application/json' -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{},\"clientInfo\":{\"name\":\"t\",\"version\":\"1\"}}}'")

# 3. 测试 /healthz
print("\n=== 后端 :4022/healthz ===")
run(ssh, "curl -s http://localhost:4022/healthz")

# 4. pm2 日志（最新）
print("\n=== pm2 logs api (最新10行) ===")
run(ssh, "pm2 logs bridge-watch-api --lines 10 --nostream 2>&1 | tail -15")

ssh.close()

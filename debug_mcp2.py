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
    if out.strip(): print(out.rstrip()[:3000])
    if err.strip(): print(f"[stderr] {err.rstrip()[:500]}", file=sys.stderr)
    return out, err

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS, timeout=15)

# 1. Caddy 配置详情
print("=== Caddyfile.mavisCrypto ===")
run(ssh, "cat /etc/caddy/Caddyfile.mavisCrypto")

# 2. 用正确的 Accept 头测试后端 MCP
print("\n=== 后端 :4022/mcp (带 Accept: text/event-stream) ===")
run(ssh, """curl -s -w '\\nHTTP_CODE:%{http_code}\\n' -X POST http://localhost:4022/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}'""")

ssh.close()

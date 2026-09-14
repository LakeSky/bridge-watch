import paramiko
import sys
import json

HOST = "47.84.59.104"
USER = "root"
PASS = "6uEk4ZbmD4YYQE6zSYNP"

def run(ssh, cmd, timeout=30):
    print(f"\n$ {cmd[:120]}")
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    if out.strip(): print(out.rstrip()[:2000])
    if err.strip(): print(f"[stderr] {err.rstrip()[:500]}", file=sys.stderr)
    return out, err

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS, timeout=15)

# 写 JSON body 到文件，避免 shell 转义
body = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
        "protocolVersion": "2024-11-05",
        "capabilities": {},
        "clientInfo": {"name": "smoke-test", "version": "1.0"}
    }
}
sftp = ssh.open_sftp()
with sftp.file("/tmp/mcp_init.json", "w") as f:
    json.dump(body, f)
sftp.close()

# 测试后端
print("=== 后端 :4022/mcp ===")
run(ssh, "curl -s -w '\\nHTTP:%{http_code}\\n' -X POST http://localhost:4022/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' --data @/tmp/mcp_init.json | head -c 1000")

# 测试外部
print("\n=== 外部 https://agentsapi.top/mcp ===")
run(ssh, "curl -s -w '\\nHTTP:%{http_code}\\n' -X POST https://agentsapi.top/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' --data @/tmp/mcp_init.json | head -c 1000")

# 测试 MCP tools/list（需要先 initialize，但无状态模式下可能直接可用）
print("\n=== tools/list ===")
body2 = {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}
sftp = ssh.open_sftp()
with sftp.file("/tmp/mcp_tools.json", "w") as f:
    json.dump(body2, f)
sftp.close()
run(ssh, "curl -s -w '\\nHTTP:%{http_code}\\n' -X POST https://agentsapi.top/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' --data @/tmp/mcp_tools.json | head -c 1500")

ssh.close()
print("\n=== 完成 ===")

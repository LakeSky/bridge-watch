import paramiko, sys, os, tarfile, time, json

HOST, USER, PASS = "47.84.59.104", "root", "6uEk4ZbmD4YYQE6zSYNP"
LOCAL_DIR = r"D:\ai\autoEarn\mavisCrypto\bridge-watch"

def run(ssh, cmd, timeout=60):
    print(f"\n$ {cmd[:100]}")
    _, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    if out.strip(): print(out.rstrip()[:1500])
    if err.strip(): print(f"[stderr] {err.rstrip()[:300]}", file=sys.stderr)
    return out

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS, timeout=15)

# 上传 server.ts
sftp = ssh.open_sftp()
sftp.put(os.path.join(LOCAL_DIR, "src/api/server.ts"), "/opt/bridge-watch/src/api/server.ts")
sftp.close()
print("server.ts 已上传")

# pm2 restart
run(ssh, "cd /opt/bridge-watch && pm2 restart bridge-watch-api --update-env 2>&1 | tail -3")
time.sleep(3)

# 测试 MCP initialize
body = json.dumps({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1"}}})
sftp = ssh.open_sftp()
with sftp.file("/tmp/mcp.json", "w") as f: f.write(body)
sftp.close()

print("\n=== MCP initialize 测试 ===")
run(ssh, "curl -s -w '\\nHTTP:%{http_code}\\n' -X POST https://agentsapi.top/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' --data @/tmp/mcp.json | head -c 1200")

print("\n=== MCP tools/list 测试 ===")
body2 = json.dumps({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}})
sftp = ssh.open_sftp()
with sftp.file("/tmp/mcp2.json", "w") as f: f.write(body2)
sftp.close()
run(ssh, "curl -s -w '\\nHTTP:%{http_code}\\n' -X POST https://agentsapi.top/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' --data @/tmp/mcp2.json | head -c 2000")

ssh.close()
print("\n=== 完成 ===")

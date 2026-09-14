import paramiko
import sys
import os
import tarfile
import time

HOST = "47.84.59.104"
USER = "root"
PASS = "6uEk4ZbmD4YYQE6zSYNP"
LOCAL_DIR = r"D:\ai\autoEarn\mavisCrypto\bridge-watch"
REMOTE_DIR = "/opt/bridge-watch"

def run(ssh, cmd, timeout=120):
    print(f"\n$ {cmd[:100]}")
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    rc = stdout.channel.recv_exit_status()
    if out.strip(): print(out.rstrip()[:1500])
    if err.strip(): print(f"[stderr rc={rc}] {err.rstrip()[:300]}", file=sys.stderr)
    return out, err, rc

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS, timeout=15)
print("=== SSH 连接成功 ===")

# 1. 打包并上传代码
print("\n=== 1. 打包上传代码 ===")
tar_path = os.path.join(LOCAL_DIR, "deploy-mcp.tar.gz")
with tarfile.open(tar_path, "w:gz") as tar:
    for item in ["src", "package.json", "package-lock.json"]:
        full = os.path.join(LOCAL_DIR, item)
        if os.path.exists(full):
            tar.add(full, arcname=item)
sftp = ssh.open_sftp()
sftp.put(tar_path, "/tmp/deploy-mcp.tar.gz")
sftp.close()
os.remove(tar_path)
print("  上传完成")

# 2. 解压 + npm install + pm2 restart
print("\n=== 2. 部署代码 ===")
run(ssh, f"cd {REMOTE_DIR} && tar xzf /tmp/deploy-mcp.tar.gz --overwrite && rm /tmp/deploy-mcp.tar.gz")
run(ssh, f"cd {REMOTE_DIR} && npm install 2>&1 | tail -3", timeout=180)
run(ssh, f"cd {REMOTE_DIR} && pm2 restart bridge-watch-api --update-env 2>&1 | tail -5")
time.sleep(3)

# 3. 修复 Caddy 配置：添加 /mcp 代理到 4022
print("\n=== 3. 修复 Caddy 配置 ===")
caddy_file = "/etc/caddy/Caddyfile.mavisCrypto"
# 先备份
run(ssh, f"cp {caddy_file} {caddy_file}.bak.$(date +%Y%m%d%H%M%S)")
# 在 'handle / {' 行之前插入 'handle /mcp* {'
run(ssh, f"sed -i '/handle \\/ {{/i\\\thandle /mcp* {{ reverse_proxy 127.0.0.1:4022 }}' {caddy_file}")
run(ssh, f"cat {caddy_file}")

# 4. reload Caddy
print("\n=== 4. Caddy reload ===")
run(ssh, "caddy reload --config /etc/caddy/Caddyfile 2>&1 || systemctl reload caddy 2>&1 || service caddy reload 2>&1")

# 5. 验证
time.sleep(2)
print("\n=== 5. 验证 MCP endpoint ===")
run(ssh, """curl -s -w '\\nHTTP:%{http_code}\\n' -X POST http://localhost:4022/mcp \
  -H 'Content-Type: application/json' -H 'Accept: text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' | head -c 500""")

print("\n=== 外部验证 ===")
run(ssh, """curl -s -w '\\nHTTP:%{http_code}\\n' -X POST https://agentsapi.top/mcp \
  -H 'Content-Type: application/json' -H 'Accept: text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' | head -c 500""")

ssh.close()
print("\n=== 完成 ===")

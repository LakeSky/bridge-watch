import paramiko
import sys

HOST = "47.84.59.104"
USER = "root"
PASS = "6uEk4ZbmD4YYQE6zSYNP"

def run(ssh, cmd, timeout=30):
    print(f"\n$ {cmd[:100]}")
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    if out.strip(): print(out.rstrip()[:2000])
    if err.strip(): print(f"[stderr] {err.rstrip()[:500]}", file=sys.stderr)
    return out, err

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS, timeout=15)

# 用正确的多行格式重写 Caddyfile
caddy_content = """# mavisCrypto x402 endpoint + bridge-watch API
agentsapi.top {
	handle_path /downloads/* {
		root * /opt/x402-endpoint/public/downloads
		file_server
	}
	handle /v1/* {
		reverse_proxy 127.0.0.1:4022
	}
	handle /openapi.yaml {
		reverse_proxy 127.0.0.1:4022
	}
	handle /.well-known/x402 {
		reverse_proxy 127.0.0.1:4022
	}
	handle /mcp* {
		reverse_proxy 127.0.0.1:4022
	}
	handle / {
		reverse_proxy 127.0.0.1:4022
	}
	reverse_proxy 127.0.0.1:4021
}
"""

# 写入文件
sftp = ssh.open_sftp()
with sftp.file("/etc/caddy/Caddyfile.mavisCrypto", "w") as f:
    f.write(caddy_content)
sftp.close()
print("Caddyfile 已写入")

# 验证格式
run(ssh, "cat /etc/caddy/Caddyfile.mavisCrypto")

# reload Caddy
print("\n=== Caddy reload ===")
run(ssh, "caddy reload --config /etc/caddy/Caddyfile 2>&1")

# 验证 Caddy 状态
run(ssh, "systemctl status caddy 2>&1 | head -5")

# 用正确的 Accept 头测试外部 MCP
print("\n=== 外部 MCP 测试（正确 Accept 头）===")
run(ssh, """curl -s -w '\\nHTTP:%{http_code}\\n' -X POST https://agentsapi.top/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' | head -c 800""")

ssh.close()
print("\n=== 完成 ===")

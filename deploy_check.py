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
    if out.strip():
        print(out.rstrip())
    if err.strip():
        print(f"[stderr] {err.rstrip()}", file=sys.stderr)
    return out, err

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS, timeout=15)
print("=== SSH 连接成功 ===")

# 1. 查看项目位置
run(ssh, "ls -la /root/ | head -20")
run(ssh, "ls -la /opt/ 2>/dev/null | head -10")
run(ssh, "find /root /opt /home -maxdepth 3 -name 'bridge-watch' -type d 2>/dev/null")

# 2. 查看 pm2 状态
run(ssh, "which pm2 && pm2 list 2>/dev/null || echo 'pm2 not found'")

# 3. 查看 node 进程
run(ssh, "ps aux | grep -E 'node|bridge' | grep -v grep | head -10")

# 4. 查看端口监听
run(ssh, "netstat -tlnp 2>/dev/null | grep -E '3000|80|443' | head -10")

ssh.close()
print("\n=== 探查完成 ===")

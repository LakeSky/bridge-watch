import paramiko
import sys
import os
import tarfile
import io
import time

HOST = "47.84.59.104"
USER = "root"
PASS = "6uEk4ZbmD4YYQE6zSYNP"
LOCAL_DIR = r"D:\ai\autoEarn\mavisCrypto\bridge-watch"
REMOTE_DIR = "/opt/bridge-watch"

def run(ssh, cmd, timeout=120):
    print(f"\n$ {cmd[:120]}")
    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode("utf-8", errors="replace")
    err = stderr.read().decode("utf-8", errors="replace")
    rc = stdout.channel.recv_exit_status()
    if out.strip():
        print(out.rstrip()[:1500])
    if err.strip():
        print(f"[stderr rc={rc}] {err.rstrip()[:300]}", file=sys.stderr)
    return out, err, rc

# 1. 本地打包
print("=== 1. 本地打包最新代码 ===")
tar_path = os.path.join(LOCAL_DIR, "deploy-latest.tar.gz")
with tarfile.open(tar_path, "w:gz") as tar:
    for item in ["src", "package.json", "package-lock.json", "AGENTS_LOG.md", "marketing"]:
        full = os.path.join(LOCAL_DIR, item)
        if os.path.exists(full):
            tar.add(full, arcname=item)
            print(f"  + {item}")
print(f"  打包完成: {os.path.getsize(tar_path)} bytes")

# 2. SSH 连接
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS, timeout=15)
print("\n=== 2. SSH 连接成功 ===")

# 3. 上传 tar.gz
print("\n=== 3. 上传到服务器 ===")
sftp = ssh.open_sftp()
remote_tar = "/tmp/bridge-watch-latest.tar.gz"
sftp.put(tar_path, remote_tar)
sftp.close()
print(f"  上传完成: {remote_tar}")

# 4. 备份并解压
print("\n=== 4. 备份旧代码并解压 ===")
run(ssh, f"cp -r {REMOTE_DIR} {REMOTE_DIR}.bak.$(date +%Y%m%d%H%M%S) 2>/dev/null; echo backup done")
run(ssh, f"cd {REMOTE_DIR} && tar xzf {remote_tar} --overwrite 2>&1 | tail -5")
run(ssh, f"rm {remote_tar}")

# 5. 安装依赖（包含 devDependencies，因为需要 tsx）
print("\n=== 5. npm install ===")
run(ssh, f"cd {REMOTE_DIR} && npm install 2>&1 | tail -8", timeout=180)

# 6. 验证文件
print("\n=== 6. 验证新文件 ===")
run(ssh, f"ls -la {REMOTE_DIR}/src/alerts/ {REMOTE_DIR}/src/cctp/ 2>&1")
run(ssh, f"head -3 {REMOTE_DIR}/package.json")

# 7. 重启 pm2
print("\n=== 7. pm2 restart ===")
run(ssh, f"cd {REMOTE_DIR} && pm2 restart bridge-watch-api bridge-watch-monitor --update-env 2>&1 | tail -10")

# 8. 等待并验证
time.sleep(5)
print("\n=== 8. 验证服务 ===")
run(ssh, "pm2 list 2>&1 | grep -E 'bridge|status'")
run(ssh, "pm2 logs bridge-watch-api --lines 15 --nostream 2>&1 | tail -20")
run(ssh, "curl -s https://agentsapi.top/healthz 2>&1")
run(ssh, "curl -s https://agentsapi.top/v1/alerts/stats 2>&1 | head -c 200")

# 清理本地 tar
os.remove(tar_path)
ssh.close()
print("\n=== 部署完成 ===")

#!/bin/bash
# 重新生成本地 CA + 服务器证书（iOS 兼容版）
#
# 为什么要这么写：
#   * iOS 13+ 要求叶证书必须有 extendedKeyUsage=serverAuth，否则直接判「此证书无效」；
#   * 叶证书有效期不能超过 825 天，超过同样无效（原来是 10 年，iOS 直接拒）；
#   * 根证书必须有 basicConstraints=CA:TRUE + keyUsage=keyCertSign，否则 iOS 不建链。
# 旧叶证书三项全不满足 —— 桌面浏览器能忍，iPhone 不能。
set -euo pipefail
cd "$(dirname "$0")"

DAYS_LEAF=${DAYS_LEAF:-397}
DAYS_CA=${DAYS_CA:-3650}
# 改成你自己那台机器的地址（局域网 IP 或域名）；这里只是示例，别忘了改。
CN=${CN:-192.168.1.10}

if [ -f server.crt ] && [ ! -d old-$(date +%Y%m%d) ]; then
    mkdir -p old-$(date +%Y%m%d)
    cp ca.crt ca.key server.crt server.key home-ca.mobileconfig old-$(date +%Y%m%d)/ 2>/dev/null || true
fi

cat > ca.ext <<'EOF'
basicConstraints = critical,CA:TRUE,pathlen:0
keyUsage = critical,keyCertSign,cRLSign,digitalSignature
subjectKeyIdentifier = hash
EOF

echo "[1/3] 生成根证书"
openssl genrsa -out ca.key 2048 2>/dev/null
# 注意：OpenSSL 3 的 `req -x509` 不认 -extfile，只能用 -addext 逐条加扩展
openssl req -x509 -new -key ca.key -sha256 -days "$DAYS_CA" \
    -subj "/C=CN/O=Home/CN=Home CA" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign,digitalSignature" \
    -addext "subjectKeyIdentifier=hash" \
    -out ca.crt

echo "[2/3] 生成服务器证书（${DAYS_LEAF} 天，含 serverAuth）"
openssl req -new -key server.key -subj "/C=CN/O=Home/CN=$CN" -out server.csr
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
    -days "$DAYS_LEAF" -sha256 -extfile leaf.ext -out server.crt

echo "[3/3] 生成 iOS 描述文件"
python3 - <<'PY'
import base64, subprocess, uuid
der = subprocess.run(['openssl','x509','-in','ca.crt','-outform','DER'], capture_output=True, check=True).stdout
b64 = base64.encodebytes(der).decode().strip()
def rows(s, width=64):
    return '\n'.join('\t\t\t'+s[i:i+width] for i in range(0, len(s), width))
xml = f'''<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>PayloadContent</key>
\t<array>
\t\t<dict>
\t\t\t<key>PayloadCertificateFileName</key>
\t\t\t<string>home-ca.crt</string>
\t\t\t<key>PayloadContent</key>
\t\t\t<data>
{rows(b64)}
\t\t\t</data>
\t\t\t<key>PayloadDescription</key>
\t\t\t<string>局域网投屏根证书</string>
\t\t\t<key>PayloadDisplayName</key>
\t\t\t<string>Home CA</string>
\t\t\t<key>PayloadIdentifier</key>
\t\t\t<string>com.home.ca</string>
\t\t\t<key>PayloadType</key>
\t\t\t<string>com.apple.security.root</string>
\t\t\t<key>PayloadUUID</key>
\t\t\t<string>{uuid.uuid4()}</string>
\t\t\t<key>PayloadVersion</key>
\t\t\t<integer>1</integer>
\t\t</dict>
\t</array>
\t<key>PayloadDisplayName</key>
\t<string>Home CA（投屏）</string>
\t<key>PayloadIdentifier</key>
\t<string>com.home.profile.{uuid.uuid4().hex[:8]}</string>
\t<key>PayloadRemovalDisallowed</key>
\t<false/>
\t<key>PayloadType</key>
\t<string>Configuration</string>
\t<key>PayloadUUID</key>
\t<string>{uuid.uuid4()}</string>
\t<key>PayloadVersion</key>
\t<integer>1</integer>
</dict>
</plist>
'''
open('home-ca.mobileconfig','w').write(xml)
print('  描述文件已写入 home-ca.mobileconfig')
PY

echo "--- 校验 ---"
openssl x509 -in server.crt -noout -dates -ext extendedKeyUsage,subjectAltName
openssl verify -CAfile ca.crt server.crt

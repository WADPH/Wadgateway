require('dotenv').config();

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');
const wakeOnLan = require('wake_on_lan');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();

const PORT = Number(process.env.PORT || 3000);
const TARGET_URL = mustEnv('TARGET_URL');
const SERVER_PING_HOST = mustEnv('SERVER_PING_HOST');
const SERVICE_HEALTH_PATH = process.env.SERVICE_HEALTH_PATH || '/';
const SERVICE_EXPECTED_TEXT = process.env.SERVICE_EXPECTED_TEXT || '';
const WAKE_TIMEOUT_MS = Number(process.env.WAKE_TIMEOUT_MS || 120000);
const PING_INTERVAL_MS = Number(process.env.PING_INTERVAL_MS || 1000);
const STATUS_CACHE_TTL_MS = Number(process.env.STATUS_CACHE_TTL_MS || 500);
const PING_TIMEOUT_MS = Number(process.env.PING_TIMEOUT_MS || 700);
const PING_SUCCESS_MIN = Number(process.env.PING_SUCCESS_MIN || 1);
const SERVICE_CHECK_TIMEOUT_MS = Number(process.env.SERVICE_CHECK_TIMEOUT_MS || 900);
const WOL_MAC = process.env.WOL_MAC || '';
const WOL_BROADCAST = process.env.WOL_BROADCAST || '255.255.255.255';
const WOL_PORT = Number(process.env.WOL_PORT || 9);
const WAD_ESP_POWER_SW = String(process.env.WadESPPowerSW || 'false').toLowerCase() === 'true';
const WAD_ESP_IP = process.env.WadESP_IP || '';
const SERVICE_NAME = process.env.SERVICE_NAME || 'Service';
const READY_HINT = process.env.READY_HINT || 'Service is available. Opening now...';
const WAKING_HINT = process.env.WAKING_HINT || 'Server is waking up. Please wait...';
const DEFAULT_SERVER_ID = process.env.SERVER_ID || 'default';
const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS || 120);
const TEMPORARY_REASON = process.env.TEMPORARY_REASON || 'immich';
const SHUTDOWN_ALLOWED = String(process.env.SHUTDOWN_ALLOWED || 'true').toLowerCase() === 'true';
const IDLE_TIMEOUT_MINUTES = Number(process.env.IDLE_TIMEOUT_MINUTES || 30);

let statusCache = null;
let statusCacheAt = 0;
const powerSessions = new Map();

app.use('/gateway-static', express.static(path.join(__dirname, 'public')));

app.get('/gateway-api/status', async (_req, res) => {
  try {
    const status = await getStatusCached();
    res.json({ ok: true, ...status });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/gateway-api/debug', async (_req, res) => {
  try {
    const serverUp = await pingHost(SERVER_PING_HOST);
    const service = await checkService();
    res.json({
      ok: true,
      now: new Date().toISOString(),
      target: TARGET_URL,
      healthUrl: resolveHealthUrl(),
      serverUp,
      service
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/gateway-api/wake', express.json(), async (_req, res) => {
  try {
    createTemporarySession({
      serverId: DEFAULT_SERVER_ID,
      reason: TEMPORARY_REASON
    });
    await powerOnServer();
    const ready = await waitForServiceReady(WAKE_TIMEOUT_MS);
    return res.json({ ok: true, ready, message: ready ? READY_HINT : WAKING_HINT });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/gateway-api/power/session/start', express.json(), (req, res) => {
  try {
    const serverId = getTextOrDefault(req.body?.serverId, DEFAULT_SERVER_ID);
    const reason = getTextOrDefault(req.body?.reason, TEMPORARY_REASON);
    const session = createTemporarySession({ serverId, reason });
    res.json({
      ok: true,
      serverId: session.serverId,
      token: session.token,
      expiresAt: session.expiresAt
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/gateway-api/power/session/consume', express.json(), (req, res) => {
  try {
    cleanupExpiredSessions();
    const serverId = getTextOrDefault(req.body?.serverId, DEFAULT_SERVER_ID);
    const bootId = getTextOrDefault(req.body?.bootId, '');
    const session = powerSessions.get(serverId);

    if (!session || session.consumed || session.expiresAt <= nowSec()) {
      return res.json({ ok: true, mode: 'manual' });
    }

    session.consumed = true;
    session.bootId = bootId || null;
    session.consumedAt = nowSec();
    powerSessions.delete(serverId);

    return res.json({
      ok: true,
      mode: 'temporary',
      reason: session.reason,
      shutdownAllowed: SHUTDOWN_ALLOWED,
      idleTimeoutMinutes: IDLE_TIMEOUT_MINUTES
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/gateway-api/power/session/current', (req, res) => {
  cleanupExpiredSessions();
  const serverId = getTextOrDefault(req.query?.serverId, DEFAULT_SERVER_ID);
  const session = powerSessions.get(serverId);
  if (!session) {
    return res.json({ ok: true, session: null });
  }
  return res.json({ ok: true, session: sanitizeSession(session) });
});

app.get('/', async (_req, res, next) => {
  try {
    const status = await getStatusCached();
    if (status.serviceUp) {
      return proxyHandler(_req, res, next);
    }
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } catch (err) {
    return res.status(500).send(`Gateway error: ${escapeHtml(err.message)}`);
  }
});

app.use('/gateway-api', (_req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

app.use('/', (req, res, next) => {
  return proxyHandler(req, res, next);
});

const proxyHandler = createProxyMiddleware({
  target: TARGET_URL,
  changeOrigin: false,
  ws: true,
  xfwd: true,
  logLevel: 'warn',
  onProxyReq(proxyReq, req) {
    proxyReq.setHeader('X-Forwarded-Host', req.headers.host || '');
    proxyReq.setHeader('X-Forwarded-Proto', req.protocol || 'http');
    proxyReq.setHeader('X-Forwarded-For', req.ip || '');
  },
  onProxyRes(proxyRes, req) {
    if (req.url.startsWith('/api/auth') || req.url.includes('/auth/')) {
      console.log(`[auth-proxy] ${req.method} ${req.url} -> ${proxyRes.statusCode}`);
    }
  }
});

app.listen(PORT, () => {
  console.log(`Gateway listening on http://0.0.0.0:${PORT}`);
});

function mustEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value.trim();
}

function getTextOrDefault(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const v = value.trim();
  return v ? v : fallback;
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function createTemporarySession({ serverId, reason }) {
  cleanupExpiredSessions();
  const createdAt = nowSec();
  const expiresAt = createdAt + SESSION_TTL_SECONDS;
  const session = {
    serverId,
    token: crypto.randomUUID(),
    mode: 'temporary',
    reason,
    createdAt,
    expiresAt,
    consumed: false,
    bootId: null,
    consumedAt: null
  };
  powerSessions.set(serverId, session);
  return session;
}

function cleanupExpiredSessions() {
  const now = nowSec();
  for (const [serverId, session] of powerSessions.entries()) {
    if (session.expiresAt <= now) {
      powerSessions.delete(serverId);
    }
  }
}

function sanitizeSession(session) {
  return {
    serverId: session.serverId,
    token: session.token,
    mode: session.mode,
    reason: session.reason,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    consumed: session.consumed,
    bootId: session.bootId,
    consumedAt: session.consumedAt
  };
}

function isAbsoluteUrl(str) {
  return /^https?:\/\//i.test(str);
}

function resolveHealthUrl() {
  return isAbsoluteUrl(SERVICE_HEALTH_PATH)
    ? SERVICE_HEALTH_PATH
    : `${TARGET_URL.replace(/\/$/, '')}/${SERVICE_HEALTH_PATH.replace(/^\//, '')}`;
}

function pingHost(host) {
  return new Promise((resolve) => {
    exec(`ping -n ${PING_SUCCESS_MIN} -w ${PING_TIMEOUT_MS} ${host}`, (error, stdout = '') => {
      if (error) return resolve(false);
      const ttlMatches = stdout.match(/ttl=/gi);
      resolve(Boolean(ttlMatches && ttlMatches.length >= PING_SUCCESS_MIN));
    });
  });
}

async function checkService() {
  const url = resolveHealthUrl();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SERVICE_CHECK_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: 'GET', signal: controller.signal });
    if (!response.ok) {
      return { up: false, code: response.status, body: '' };
    }

    const text = await response.text();
    if (SERVICE_EXPECTED_TEXT && !text.includes(SERVICE_EXPECTED_TEXT)) {
      return { up: false, code: response.status, body: text.slice(0, 400) };
    }

    return { up: true, code: response.status, body: text.slice(0, 400) };
  } catch (_err) {
    return { up: false, code: 0, body: '' };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function getStatus() {
  const serverUp = await pingHost(SERVER_PING_HOST);
  let serviceResult = { up: false, code: 0, body: '' };

  if (serverUp) {
    serviceResult = await checkService();
  }

  return {
    serviceName: SERVICE_NAME,
    checkedAt: new Date().toISOString(),
    server: {
      host: SERVER_PING_HOST,
      up: serverUp
    },
    service: {
      target: TARGET_URL,
      healthUrl: resolveHealthUrl(),
      expectedText: SERVICE_EXPECTED_TEXT,
      statusCode: serviceResult.code,
      up: serviceResult.up
    },
    serviceUp: serviceResult.up
  };
}

async function getStatusCached() {
  if (statusCache && Date.now() - statusCacheAt < STATUS_CACHE_TTL_MS) {
    return statusCache;
  }
  statusCache = await getStatus();
  statusCacheAt = Date.now();
  return statusCache;
}

function sendMagicPacket() {
  return new Promise((resolve, reject) => {
    wakeOnLan.wake(WOL_MAC, { address: WOL_BROADCAST, port: WOL_PORT }, (error) => {
      if (error) return reject(error);
      return resolve();
    });
  });
}

async function powerOnServer() {
  if (WAD_ESP_POWER_SW) {
    if (!WAD_ESP_IP) {
      throw new Error('WadESP_IP is not configured');
    }
    const espUrl = `http://${WAD_ESP_IP.replace(/^https?:\/\//, '').replace(/\/$/, '')}/power/on`;
    const resp = await fetch(espUrl, { method: 'GET' });
    if (!resp.ok) {
      throw new Error(`WadESP power endpoint failed with status ${resp.status}`);
    }
    return;
  }

  if (!WOL_MAC) {
    throw new Error('WOL_MAC is not configured');
  }
  await sendMagicPacket();
}

async function waitForServiceReady(timeoutMs) {
  const endAt = Date.now() + timeoutMs;
  while (Date.now() < endAt) {
    const service = await checkService();
    if (service.up) {
      return true;
    }
    await sleep(PING_INTERVAL_MS);
  }
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(input) {
  return String(input)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/* Live Race WebSocket 接入（M1.5，DESIGN §13.2）
 * - 与主服务同一个 Express/HTTP 服务，只处理 /api/race/ws 的升级请求；
 * - 握手鉴权：复用会话 Cookie（5.2）识别已登录家长；游客允许匿名连接；
 *   若带 profileId，必须在握手时校验该档案归属当前会话用户，否则一律当游客；
 * - Origin 同源校验：WebSocket 不受 CORS 限制，必须显式拒绝跨站握手；
 * - 游客限流：每 IP 并发座位数与建/加入房间频率都受限，防止刷房间；
 * - 消息层：单条 ≤ 4KB、非法 JSON 直接断开、answer 事件由房间引擎限速。
 */
'use strict';

const { WebSocketServer } = require('ws');
const { RoomManager } = require('./live-race');
const { persistMatch } = require('./match-store');
const { hashToken } = require('./util');

const WS_PATH = '/api/race/ws';
const MAX_MESSAGE_BYTES = 4 * 1024;
const HEARTBEAT_MS = 30 * 1000;
const MAX_SEATS_PER_IP = 4;
const JOIN_ATTEMPTS_PER_MIN = 20;

function readSession(db, cookieHeader) {
  if (!cookieHeader) return null;
  const jar = parseCookieHeader(cookieHeader);
  const token = jar.tm_session;
  if (!token || !/^[A-Za-z0-9_-]{20,}$/.test(token)) return null;
  const row = db.prepare(
    `SELECT s.token_hash, s.expires_at, u.id AS user_id
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?`
  ).get(hashToken(token));
  if (!row || row.expires_at <= Date.now()) return null;
  return { userId: row.user_id, sessionTokenHash: row.token_hash };
}

function parseCookieHeader(header) {
  const out = {};
  String(header).split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i === -1) return;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // 非浏览器客户端（原生 app / 测试）不带 Origin
  try {
    const u = new URL(origin);
    return u.host === req.headers.host;
  } catch (e) { return false; }
}

function clientIp(req) {
  // Express 的 trust proxy 只作用于 Express 层；这里手动取最左侧 X-Forwarded-For
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  return req.socket.remoteAddress || '';
}

function attachLiveRace(server, db, opts) {
  opts = opts || {};
  const log = opts.log || function () {};
  // 并发座位上限可覆盖：生产保持 4，测试环境同一 IP 会开很多连接
  const maxSeatsPerIp = opts.maxSeatsPerIp || MAX_SEATS_PER_IP;

  const manager = new RoomManager({
    send: (connId, msg) => {
      const ws = sockets.get(connId);
      if (ws && ws.readyState === 1) {
        try { ws.send(JSON.stringify(msg)); } catch (e) { /* 连接已断 */ }
      }
    },
    onMatchEnd: match => {
      // 游客座位在 persistMatch 内被跳过：游客对局零落库（DESIGN 13.0/13.5）
      try { persistMatch(db, match); } catch (e) { log('[race] 对局落库失败: ' + (e && e.message)); }
    },
    log
  });

  const sockets = new Map(); // connId -> ws
  const joinAttempts = new Map(); // ip -> {count, reset}
  let connSeq = 0;

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try { pathname = new URL(req.url, 'http://placeholder').pathname; }
    catch (e) { return reject(socket, 400, 'Bad Request'); }
    /* 不归本模块处理的升级请求必须显式拒绝：直接 return 会让 socket 悬着，
     * 客户端会一直等到超时（生产上表现为连接泄漏）。 */
    if (pathname !== WS_PATH) return reject(socket, 404, 'Not Found');

    if (!sameOrigin(req)) return reject(socket, 403, 'Forbidden');
    if (seatsByIp(req) >= maxSeatsPerIp) return reject(socket, 429, 'Too Many Requests');

    wss.handleUpgrade(req, socket, head, ws => {
      onConnection(ws, req);
    });
  });

  function seatsByIp(req) {
    const ip = clientIp(req);
    let n = 0;
    for (const ws of sockets.values()) if (ws._tmIp === ip) n++;
    return n;
  }

  function reject(socket, code, msg) {
    try {
      socket.write('HTTP/1.1 ' + code + ' ' + msg + '\r\nConnection: close\r\n\r\n');
      socket.destroy();
    } catch (e) { /* 已关闭 */ }
  }

  function onConnection(ws, req) {
    const connId = 'c' + (++connSeq);
    const ip = clientIp(req);
    ws._tmIp = ip;
    ws._tmAlive = true;
    sockets.set(connId, ws);

    // 会话与档案归属校验
    let ctx = { ip, userId: null, profileId: null };
    try {
      const sess = readSession(db, req.headers.cookie);
      if (sess) {
        ctx.userId = sess.userId;
        const q = new URL(req.url, 'http://placeholder').searchParams;
        const pid = Number(q.get('profileId'));
        if (Number.isInteger(pid) && pid > 0) {
          const p = db.prepare('SELECT id, user_id FROM child_profiles WHERE id = ?').get(pid);
          if (p && p.user_id === sess.userId) ctx.profileId = pid; // 否则当游客
        }
      }
    } catch (e) {
      log('[race] 握手鉴权异常: ' + (e && e.message));
    }
    manager.registerConn(connId, ctx);

    ws.on('pong', () => { ws._tmAlive = true; });

    ws.on('message', raw => {
      if (raw.length > MAX_MESSAGE_BYTES) { ws.close(1009, 'too_large'); return; }
      let msg;
      try { msg = JSON.parse(String(raw)); } catch (e) { ws.close(1003, 'invalid_json'); return; }
      if (!msg || typeof msg.type !== 'string') { ws.close(1003, 'invalid_message'); return; }

      if (msg.type === 'create_room' || msg.type === 'join_room') {
        if (!allowJoinAttempt(ip)) {
          send(ws, { type: 'error', code: 'rate_limited' });
          return;
        }
      }

      const result = manager.handle(connId, msg);
      if (result && result.error) send(ws, { type: 'error', code: result.error });
    });

    ws.on('close', () => {
      sockets.delete(connId);
      manager.unregisterConn(connId);
    });
    ws.on('error', () => { /* 由 close 统一清理 */ });

    send(ws, { type: 'hello', seatLimit: maxSeatsPerIp, loggedIn: !!ctx.userId, profileId: ctx.profileId });
  }

  function allowJoinAttempt(ip) {
    const now = Date.now();
    let b = joinAttempts.get(ip);
    if (!b || b.reset < now) { b = { count: 0, reset: now + 60000 }; joinAttempts.set(ip, b); }
    b.count++;
    return b.count <= JOIN_ATTEMPTS_PER_MIN;
  }

  function send(ws, msg) {
    if (ws.readyState === 1) {
      try { ws.send(JSON.stringify(msg)); } catch (e) { /* 忽略 */ }
    }
  }

  // 心跳：Render 等平台会静默断开空闲连接，靠 ping/pong 及时清理死连接
  const hb = setInterval(() => {
    for (const [connId, ws] of sockets) {
      if (!ws._tmAlive) { ws.terminate(); sockets.delete(connId); manager.unregisterConn(connId); continue; }
      ws._tmAlive = false;
      try { ws.ping(); } catch (e) { /* 忽略 */ }
    }
  }, HEARTBEAT_MS);
  if (hb.unref) hb.unref();

  function close() {
    clearInterval(hb);
    manager.stop();
    for (const ws of sockets.values()) { try { ws.close(1001, 'server_shutdown'); } catch (e) { /* 忽略 */ } }
    wss.close();
  }

  return { wss, manager, close, WS_PATH };
}

module.exports = { attachLiveRace, WS_PATH };

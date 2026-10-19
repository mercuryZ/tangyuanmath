/* Live Race 房间引擎（M1.5，DESIGN §13）
 * 设计要点：
 *  - 服务端权威：题目与答案只存在服务端，下发给客户端的 problems 只有 {a,b}；
 *    逐题判定在服务端完成，客户端只上报 {position, value}；
 *  - 房间状态纯内存（Map<code, room>），不落库；进程重启房间即消失（对局 ≤ 数分钟，可接受）；
 *  - 游客可完整参与；只有登录档案的对局在结束时落库（matches / match_players / attempts）；
 *  - 儿童安全红线：房间码邀请制、显示名由系统生成、无自由文本、无聊天、不广播任何身份信息；
 *  - 本模块不依赖 ws：通过 send(connId, msg) 与 onMatchEnd(match) 注入传输与持久化，
 *    因此可以在没有网络的单测里驱动完整对局。
 */
'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const Q = require(path.join(__dirname, '..', '..', 'public', 'js', 'questions.js'));

/* 房间码：简单常见的水果 / 动物 / 数字单词，全大写、3–5 个字母，
 * 方便孩子口头转述或手输（DESIGN 13.7）。词表约 80 个，配合加入限速，
 * 足以覆盖同时在线房间；房间码大小写不敏感。 */
const ROOM_CODE_WORDS = [
  /* fruits */
  'APPLE', 'MANGO', 'PEACH', 'LEMON', 'GRAPE', 'MELON', 'BERRY', 'OLIVE', 'GUAVA',
  'PLUM', 'PEAR', 'LIME', 'KIWI', 'DATE', 'FIG',
  /* animals */
  'CAT', 'DOG', 'COW', 'PIG', 'FOX', 'ANT', 'BEE', 'OWL', 'BAT', 'RAT', 'HEN',
  'DUCK', 'FROG', 'BEAR', 'LION', 'WOLF', 'DEER', 'GOAT', 'CRAB', 'FISH', 'BIRD',
  'SWAN', 'SEAL', 'MOUSE', 'HORSE', 'SHEEP', 'TIGER', 'PANDA', 'KOALA', 'ZEBRA',
  'SNAKE', 'CAMEL', 'SHARK', 'WHALE', 'SNAIL', 'SLOTH', 'OTTER', 'BISON', 'MOOSE',
  'LLAMA', 'HIPPO', 'RHINO', 'EAGLE', 'GOOSE', 'ROBIN', 'TROUT', 'SQUID', 'TOAD',
  'MOLE', 'HARE', 'MULE', 'ORCA', 'PUMA', 'LYNX', 'CRANE',
  /* number words */
  'ONE', 'TWO', 'SIX', 'TEN', 'FOUR', 'FIVE', 'NINE', 'ZERO', 'THREE', 'SEVEN', 'EIGHT'
];
const MAX_CODE_LENGTH = 5;

const MAX_PLAYERS = 4;
const MIN_PLAYERS_TO_START = 2;
const DIFFICULTIES = ['times_tables_10', 'times_tables_12', 'two_by_one', 'two_by_two'];
const COUNTS = [5, 10, 20];
const DURATION_BY_COUNT = { 5: 60, 10: 90, 20: 150 };

const COUNTDOWN_MS = 3000;
const RECONNECT_WINDOW_MS = 30 * 1000;   // DESIGN 13.2：掉线保留座位 30 秒
const ROOM_IDLE_MS = 10 * 60 * 1000;     // DESIGN 13.2：闲置 10 分钟销毁
const ANSWER_RATE_PER_SEC = 4;           // DESIGN 13.2：每玩家答案事件限速

/* 系统生成名与头像：不使用儿童档案昵称（DESIGN 13.0） */
const NAME_POOL = ['Mochi', 'Pudding', 'Sesame', 'Red Bean', 'Peanut', 'Taro', 'Mango', 'Coconut', 'Matcha', 'Lychee'];
const AVATAR_POOL = ['🍡', '⭐', '❤️', '🌸', '🌙', '☀️', '🍵', '🥭'];

function randomCode(rand) {
  const r = rand || crypto.randomBytes;
  return ROOM_CODE_WORDS[r(1)[0] % ROOM_CODE_WORDS.length];
}

function randomToken() {
  return crypto.randomBytes(18).toString('base64url');
}

function isInt(v, min, max) {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

/* 把一次对局整理成持久化载荷（不含答案，只含逐题作答） */
function toMatchRecord(room, endedAt, reason) {
  const ranking = rankPlayers(room, endedAt);
  const bySeat = new Map(ranking.map(r => [r.seat, r]));
  return {
    roomCode: room.code,
    difficulty: room.settings.difficulty,
    count: room.settings.count,
    startedAt: room.startedAt,
    endedAt,
    reason,
    players: room.players.map(p => {
      const r = bySeat.get(p.seat);
      return {
        seat: p.seat,
        profileId: p.profileId || null,
        displayName: p.name,
        solved: p.correctPositions.size,
        usedMs: r ? r.usedMs : null,
        rank: r ? r.rank : null,
        disconnected: !!p.disconnectedAt,
        perQuestion: p.per.map(q => ({
          a: q.a, b: q.b,
          firstAnswer: q.first, finalAnswer: q.final, activeMs: null
        }))
      };
    }),
    ranking
  };
}

/* 排名规则（DESIGN 13.1 修订）：
 *   1) 准确度优先：答对题数多者靠前；
 *   2) 准确度相同则比用时：交卷更早（用时更短）者靠前；
 *   3) 仍未分胜负时比最后一题答对的服务器时刻，最后以座位序兜底保证确定性。
 * 用时一律取「交卷时刻 − 开局时刻」；未交卷者按结算时刻计算。 */
function rankPlayers(room, endedAt) {
  const list = room.players.map(p => {
    const solved = p.correctPositions.size;
    const finished = p.finishedAt !== null;
    return {
      seat: p.seat,
      name: p.name,
      avatar: p.avatar,
      solved,
      usedMs: finished ? p.finishedAt - room.startedAt : (endedAt - room.startedAt),
      finished,
      lastCorrectAt: p.lastCorrectAt,
      disconnected: !!p.disconnectedAt
    };
  });
  list.sort((x, y) => {
    if (x.solved !== y.solved) return y.solved - x.solved;           // 准确度优先
    if (x.usedMs !== y.usedMs) return x.usedMs - y.usedMs;           // 同准确度比用时
    const lx = x.lastCorrectAt === null ? Infinity : x.lastCorrectAt;
    const ly = y.lastCorrectAt === null ? Infinity : y.lastCorrectAt;
    if (lx !== ly) return lx - ly;                                   // 最后一题更早答对者靠前
    return x.seat - y.seat;                                          // 兜底：座位序
  });
  return list.map((p, i) => Object.assign({}, p, { rank: i + 1 }));
}

class RoomManager {
  /* opts: { now, rand, send(connId,msg), onMatchEnd(match), autoTick=true, log } */
  constructor(opts) {
    opts = opts || {};
    this.now = opts.now || Date.now;
    this.rand = opts.rand || crypto.randomBytes;
    this.send = opts.send || function () {};
    this.onMatchEnd = opts.onMatchEnd || function () {};
    this.log = opts.log || function () {};
    this.rooms = new Map();
    this.byConn = new Map(); // connId -> { code, seat }
    this.conns = new Map();  // connId -> { ip, userId, profileId }
    this.timer = null;
    this.lastTickSecond = new Map(); // code -> 上次广播的倒计时秒数
    if (opts.autoTick !== false) {
      this.timer = setInterval(() => this.tick(), 500);
      if (this.timer.unref) this.timer.unref();
    }
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /* 传输层在握手完成后登记连接上下文（ip / 已登录用户 / 归属已校验的档案） */
  registerConn(connId, ctx) {
    this.conns.set(connId, { ip: (ctx && ctx.ip) || null, userId: (ctx && ctx.userId) || null, profileId: (ctx && ctx.profileId) || null });
  }

  unregisterConn(connId) {
    this.conns.delete(connId);
    this.dropConn(connId);
  }

  /* ---------- 房间码 ---------- */
  /* 从随机起点线性扫描词表：既随机，又能保证有容量时一定找到未占用的词。 */
  newCode() {
    const n = ROOM_CODE_WORDS.length;
    const start = this.rand(1)[0] % n;
    for (let i = 0; i < n; i++) {
      const code = ROOM_CODE_WORDS[(start + i) % n];
      if (!this.rooms.has(code)) return code;
    }
    return null;
  }

  /* ---------- 创建 ---------- */
  createRoom(conn, settings) {
    if (this.byConn.has(conn.connId)) return { error: 'already_in_room' };
    const code = this.newCode();
    if (!code) return { error: 'room_unavailable' };
    const room = {
      code,
      hostSeat: 0,
      status: 'waiting',
      settings: this.normalizeSettings(settings),
      players: [],
      problems: [],
      startedAt: 0,
      deadline: 0,
      countdownEndsAt: 0,
      endedAt: 0,
      touchedAt: this.now(),
      resultSent: false
    };
    this.rooms.set(code, room);
    const joined = this.addPlayer(room, conn);
    if (joined.error) { this.rooms.delete(code); return joined; }
    this.byConn.set(conn.connId, { code: room.code, seat: joined.seat });
    this.send(conn.connId, {
      type: 'joined', code: room.code, seat: joined.seat, token: joined.token, room: this.stateOf(room)
    });
    this.broadcastState(room);
    return { room, seat: joined.seat, token: joined.token, code };
  }

  normalizeSettings(s) {
    s = s || {};
    const difficulty = DIFFICULTIES.indexOf(s.difficulty) !== -1 ? s.difficulty : 'two_by_two';
    const count = COUNTS.indexOf(s.count) !== -1 ? s.count : 10;
    const duration = DURATION_BY_COUNT[count];
    return { difficulty, count, duration };
  }

  addPlayer(room, conn) {
    if (room.players.length >= MAX_PLAYERS) return { error: 'room_full' };
    if (room.status !== 'waiting') return { error: 'already_started' };
    const usedSeats = new Set(room.players.map(p => p.seat));
    let seat = 0;
    while (usedSeats.has(seat)) seat++;
    const player = this.makePlayer(room, seat, conn);
    room.players.push(player);
    room.touchedAt = this.now();
    return { seat, token: player.token };
  }

  makePlayer(room, seat, conn) {
    const usedNames = new Set(room.players.map(p => p.name));
    const name = NAME_POOL.find(n => !usedNames.has(n)) || ('Player ' + (seat + 1));
    const avatar = AVATAR_POOL[(seat + room.players.length) % AVATAR_POOL.length];
    return {
      seat, name, avatar,
      token: randomToken(),
      connId: conn.connId,
      ip: conn.ip || null,
      userId: conn.userId || null,
      profileId: conn.profileId || null,
      correctPositions: new Set(),
      per: [],
      lastCorrectAt: null,
      finishedAt: null,
      disconnectedAt: null,
      answerTimes: []
    };
  }

  /* ---------- 加入 / 重连 ---------- */
  joinRoom(conn, msg) {
    const code = typeof msg.code === 'string' ? msg.code.trim().toUpperCase() : '';
    const room = this.rooms.get(code);
    if (!room) return { error: 'room_not_found' };

    // 1) 重连：座位令牌命中即回归原座位（DESIGN 13.2）
    if (typeof msg.resumeToken === 'string' && msg.resumeToken) {
      const p = room.players.find(x => x.token === msg.resumeToken);
      if (!p) return { error: 'invalid_resume' };
      if (p.connId && p.connId !== conn.connId) this.dropConn(p.connId);
      p.connId = conn.connId;
      p.disconnectedAt = null;
      p.ip = conn.ip || p.ip;
      this.byConn.set(conn.connId, { code: room.code, seat: p.seat });
      this.send(conn.connId, {
        type: 'joined', code: room.code, seat: p.seat, token: p.token,
        room: this.stateOf(room), resumed: true
      });
      this.sendSnapshot(room, p);
      this.broadcastState(room);
      return { room, seat: p.seat, token: p.token, resumed: true };
    }

    if (this.byConn.has(conn.connId)) return { error: 'already_in_room' };
    if (room.status !== 'waiting') return { error: 'already_started' };
    const joined = this.addPlayer(room, conn);
    if (joined.error) return joined;
    this.byConn.set(conn.connId, { code: room.code, seat: joined.seat });
    this.send(conn.connId, {
      type: 'joined', code: room.code, seat: joined.seat, token: joined.token, room: this.stateOf(room)
    });
    this.broadcastState(room);
    return { room, seat: joined.seat, token: joined.token, code: room.code };
  }

  dropConn(connId) {
    if (!connId) return;
    const ref = this.byConn.get(connId);
    this.byConn.delete(connId);
    if (!ref) return;
    const room = this.rooms.get(ref.code);
    if (!room) return;
    const p = room.players.find(x => x.seat === ref.seat);
    if (!p || p.connId !== connId) return;
    p.connId = null;
    p.disconnectedAt = this.now();
    this.broadcastState(room);
  }

  /* ---------- 主入口 ---------- */
  handle(connId, msg) {
    if (!msg || typeof msg !== 'object') return { error: 'invalid_message' };
    const type = msg.type;
    const ref = this.byConn.get(connId);

    if (type === 'create_room') return this.createRoom(this.connOf(connId), msg);
    if (type === 'join_room') return this.joinRoom(this.connOf(connId), msg);
    if (type === 'ping') { this.send(connId, { type: 'pong' }); return { ok: true }; }

    if (!ref) return { error: 'not_in_room' };
    const room = this.rooms.get(ref.code);
    if (!room) return { error: 'room_not_found' };
    const player = room.players.find(p => p.seat === ref.seat);
    if (!player) return { error: 'not_in_room' };
    if (player.connId !== connId) return { error: 'not_in_room' };

    switch (type) {
      case 'start_game': return this.startGame(room, player);
      case 'answer': return this.answer(room, player, msg);
      case 'submit': return this.submit(room, player, msg);
      case 'rematch': return this.rematch(room, player);
      case 'leave': return this.leave(room, player);
      default: return { error: 'unknown_type' };
    }
  }

  connOf(connId) {
    const ctx = this.conns.get(connId) || {};
    return {
      connId,
      ip: ctx.ip || null,
      userId: ctx.userId || null,
      profileId: ctx.profileId || null
    };
  }

  /* ---------- 开局：3-2-1 倒计时 → 统一下发题目 ---------- */
  startGame(room, player) {
    if (room.status !== 'waiting') return { error: 'already_started' };
    if (player.seat !== room.hostSeat) return { error: 'host_only' };
    const connected = room.players.filter(p => !p.disconnectedAt);
    if (connected.length < MIN_PLAYERS_TO_START) return { error: 'need_players' };
    room.status = 'countdown';
    room.countdownEndsAt = this.now() + COUNTDOWN_MS;
    this.lastTickSecond.delete(room.code);
    this.broadcast(room, { type: 'countdown', seconds: 3 });
    this.lastTickSecond.set(room.code, 3);
    this.broadcastState(room);
    return { ok: true };
  }

  beginGame(room) {
    room.status = 'running';
    room.problems = Q.generateSet(room.settings.difficulty, room.settings.count);
    room.startedAt = this.now();
    room.deadline = room.startedAt + room.settings.duration * 1000;
    for (const p of room.players) {
      p.correctPositions = new Set();
      p.per = room.problems.map(q => ({ a: q.a, b: q.b, first: null, final: null, correct: false }));
      p.lastCorrectAt = null;
      p.finishedAt = null;
      p.answerTimes = [];
    }
    // 题目里绝不能带 answer（DESIGN 13.2 防作弊核心）
    const problems = room.problems.map(q => ({ a: q.a, b: q.b }));
    for (const p of room.players) {
      if (!p.connId) continue;
      this.send(p.connId, {
        type: 'game_start',
        problems,
        count: room.settings.count,
        difficulty: room.settings.difficulty,
        startedAt: room.startedAt,
        deadline: room.deadline,
        serverNow: this.now(),
        seat: p.seat
      });
    }
    this.broadcastState(room);
  }

  /* ---------- 逐题判定 ---------- */
  /* 纯判定：把一次作答写进玩家状态，返回是否答对。不广播、不限速。 */
  applyAnswer(room, player, pos, value, now) {
    const q = room.problems[pos];
    const correct = value === q.a * q.b;
    const slot = player.per[pos];
    if (slot.first === null) slot.first = value;
    slot.final = value;
    if (correct) {
      slot.correct = true;
      player.correctPositions.add(pos);
      player.lastCorrectAt = now;
    }
    return correct;
  }

  answer(room, player, msg) {
    if (room.status !== 'running') return { error: 'not_running' };
    const pos = msg.position;
    const value = msg.value;
    if (!isInt(pos, 0, room.settings.count - 1)) return { error: 'invalid_position' };
    if (!isInt(value, -1, 100000)) return { error: 'invalid_value' };
    if (player.finishedAt !== null) return { error: 'finished' };
    if (player.correctPositions.has(pos)) return { error: 'already_correct' };

    // 答案事件限速：超限直接丢弃，不判定（防止脚本刷接口）
    const now = this.now();
    player.answerTimes = player.answerTimes.filter(t => now - t < 1000);
    if (player.answerTimes.length >= ANSWER_RATE_PER_SEC) {
      return { error: 'rate_limited' };
    }
    player.answerTimes.push(now);

    const correct = this.applyAnswer(room, player, pos, value, now);

    this.send(player.connId, {
      type: 'judge',
      position: pos,
      correct,
      solved: player.correctPositions.size,
      finished: player.finishedAt !== null
    });
    this.broadcast(room, {
      type: 'peer_progress',
      seat: player.seat,
      solved: player.correctPositions.size,
      finished: player.finishedAt !== null
    });

    return { ok: true, correct };
  }

  /* ---------- 交卷 ----------
   * 玩家主动点「提交」结束自己这一局：
   *  - 可携带尚未上报的答案（客户端一次性把整张卷子发来），逐题服务端判定；
   *  - 记录交卷时刻，之后不再接受作答；
   *  - 全员交卷即结算。判定口径：准确度（答对题数）优先，同准确度比用时。 */
  submit(room, player, msg) {
    if (room.status !== 'running') return { error: 'not_running' };
    if (player.finishedAt !== null) return { error: 'already_submitted' };

    const now = this.now();
    const answers = Array.isArray(msg && msg.answers) ? msg.answers.slice(0, room.settings.count) : [];
    const results = [];
    for (const a of answers) {
      if (!a || typeof a !== 'object') continue;
      const pos = a.position;
      const value = a.value;
      if (!isInt(pos, 0, room.settings.count - 1)) continue;
      if (!isInt(value, -1, 100000)) continue;
      if (player.correctPositions.has(pos)) continue; // 已答对的题不再改写
      const correct = this.applyAnswer(room, player, pos, value, now);
      results.push({ position: pos, correct });
    }

    player.finishedAt = now;

    this.send(player.connId, {
      type: 'submitted',
      seat: player.seat,
      solved: player.correctPositions.size,
      total: room.settings.count,
      usedMs: now - room.startedAt,
      waitingFor: room.players.filter(p => p.finishedAt === null).length,
      results
    });
    this.broadcast(room, {
      type: 'peer_progress',
      seat: player.seat,
      solved: player.correctPositions.size,
      finished: true
    });

    if (room.players.every(p => p.finishedAt !== null)) this.endGame(room, 'all_submitted');
    return { ok: true };
  }

  /* ---------- 结算 ---------- */
  endGame(room, reason) {
    if (room.status !== 'running' && room.status !== 'countdown') return;
    room.status = 'over';
    room.endedAt = this.now();
    room.touchedAt = room.endedAt;
    const record = toMatchRecord(room, room.endedAt, reason);
    this.broadcast(room, {
      type: 'game_over',
      reason,
      total: room.settings.count,
      ranking: record.ranking.map(r => ({
        seat: r.seat, name: r.name, avatar: r.avatar, solved: r.solved,
        usedMs: r.usedMs, rank: r.rank, disconnected: r.disconnected,
        submitted: r.finished
      }))
    });
    this.broadcastState(room);
    if (!room.resultSent) {
      room.resultSent = true;
      try { this.onMatchEnd(record); } catch (e) { this.log('persist failed: ' + (e && e.message)); }
    }
  }

  rematch(room, player) {
    if (room.status !== 'over') return { error: 'not_over' };
    if (player.seat !== room.hostSeat) return { error: 'host_only' };
    room.status = 'waiting';
    room.problems = [];
    room.startedAt = 0; room.deadline = 0; room.endedAt = 0;
    room.resultSent = false;
    room.touchedAt = this.now();
    room.players = room.players.filter(p => !p.disconnectedAt);
    room.players.forEach((p, i) => { p.seat = i; });
    if (!room.players.length) { this.rooms.delete(room.code); return { ok: true }; }
    room.hostSeat = 0;
    for (const p of room.players) {
      p.correctPositions = new Set(); p.per = [];
      p.lastCorrectAt = null; p.finishedAt = null; p.answerTimes = [];
      if (p.connId) this.byConn.set(p.connId, { code: room.code, seat: p.seat });
    }
    this.broadcastState(room);
    return { ok: true };
  }

  leave(room, player) {
    this.removePlayer(room, player);
    this.broadcastState(room);
    return { ok: true };
  }

  removePlayer(room, player) {
    if (player.connId) this.byConn.delete(player.connId);
    room.players = room.players.filter(p => p !== player);
    if (!room.players.length) { this.rooms.delete(room.code); return; }
    // 房主离开 → 座位顺位移交（DESIGN 13.2）
    if (room.hostSeat === player.seat) {
      const next = room.players.slice().sort((a, b) => a.seat - b.seat)[0];
      room.hostSeat = next.seat;
    }
    room.touchedAt = this.now();
  }

  /* ---------- 时钟：倒计时推进 / 超时 / 重连窗口 / 闲置回收 ---------- */
  tick(nowArg) {
    const now = typeof nowArg === 'number' ? nowArg : this.now();
    for (const room of Array.from(this.rooms.values())) {
      if (room.status === 'countdown') {
        const left = Math.max(0, Math.ceil((room.countdownEndsAt - now) / 1000));
        if (left > 0 && this.lastTickSecond.get(room.code) !== left) {
          this.lastTickSecond.set(room.code, left);
          this.broadcast(room, { type: 'countdown', seconds: left });
        }
        if (now >= room.countdownEndsAt) this.beginGame(room);
        continue;
      }
      if (room.status === 'running') {
        if (now >= room.deadline) this.endGame(room, 'timeout');
        continue;
      }
      // 等待室 / 已结束：掉线超过重连窗口即移出座位；全员掉线或闲置过久则销毁房间
      for (const p of room.players.slice()) {
        if (p.disconnectedAt && now - p.disconnectedAt > RECONNECT_WINDOW_MS) this.removePlayer(room, p);
      }
      if (!this.rooms.has(room.code)) continue;
      if (!room.players.length) { this.rooms.delete(room.code); continue; }
      const anyConnected = room.players.some(p => p.connId);
      if (!anyConnected && now - room.touchedAt > RECONNECT_WINDOW_MS) { this.rooms.delete(room.code); continue; }
      if (now - room.touchedAt > ROOM_IDLE_MS) this.rooms.delete(room.code);
    }
  }

  /* ---------- 广播 ---------- */
  broadcast(room, msg) {
    for (const p of room.players) if (p.connId) this.send(p.connId, msg);
  }

  broadcastState(room) {
    this.broadcast(room, { type: 'room_state', room: this.stateOf(room) });
  }

  stateOf(room) {
    return {
      code: room.code,
      status: room.status,
      hostSeat: room.hostSeat,
      settings: room.settings,
      players: room.players
        .slice()
        .sort((a, b) => a.seat - b.seat)
        .map(p => ({
          seat: p.seat, name: p.name, avatar: p.avatar,
          connected: !!p.connId,
          solved: p.correctPositions.size,
          // finished 表示「已交卷」：交卷后不再接受作答
          finished: p.finishedAt !== null
        }))
    };
  }

  /* 重连后一次性补齐：房间状态 + 当前对局快照（含本人进度与剩余时间） */
  sendSnapshot(room, player) {
    this.send(player.connId, { type: 'room_state', room: this.stateOf(room) });
    if (room.status === 'countdown') {
      this.send(player.connId, { type: 'countdown', seconds: Math.max(1, Math.ceil((room.countdownEndsAt - this.now()) / 1000)) });
      return;
    }
    if (room.status !== 'running') return;
    this.send(player.connId, {
      type: 'game_start',
      problems: room.problems.map(q => ({ a: q.a, b: q.b })),
      count: room.settings.count,
      difficulty: room.settings.difficulty,
      startedAt: room.startedAt,
      deadline: room.deadline,
      serverNow: this.now(),
      seat: player.seat,
      resumed: true,
      solvedPositions: Array.from(player.correctPositions).sort((a, b) => a - b),
      submitted: player.finishedAt !== null
    });
  }
}

module.exports = {
  RoomManager, rankPlayers, toMatchRecord, randomCode,
  ROOM_CODE_WORDS, MAX_CODE_LENGTH, MAX_PLAYERS, MIN_PLAYERS_TO_START,
  DIFFICULTIES, COUNTS, DURATION_BY_COUNT,
  RECONNECT_WINDOW_MS, ROOM_IDLE_MS, ANSWER_RATE_PER_SEC, COUNTDOWN_MS,
  NAME_POOL, AVATAR_POOL
};

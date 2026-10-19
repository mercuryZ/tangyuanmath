'use strict';
/* 临时验证脚本：可配置答对题数的对手（用完即删）。
 * 用法：node bot-repro.js <房间码> <正确题数> [延迟ms] */
const WebSocket = require('D:/project/tobemathmaster/server/node_modules/ws');
const code = process.argv[2];
const correctCount = process.argv[3] !== undefined ? Number(process.argv[3]) : Infinity;
const delay = process.argv[4] !== undefined ? Number(process.argv[4]) : 2500;
const ws = new WebSocket('ws://127.0.0.1:3500/api/race/ws');
let problems = null;
ws.on('open', () => ws.send(JSON.stringify({ type: 'join_room', code })));
ws.on('message', raw => {
  const m = JSON.parse(String(raw));
  if (m.type === 'joined') console.log('[bot] joined seat', m.seat);
  if (m.type === 'game_start') {
    problems = m.problems;
    console.log('[bot] game_start', problems.length);
    setTimeout(() => {
      const answers = problems.map((p, i) => ({
        position: i,
        value: i < correctCount ? p.a * p.b : p.a * p.b + 1 // 超出正确数的题故意答错
      }));
      ws.send(JSON.stringify({ type: 'submit', answers }));
      console.log('[bot] submitted', correctCount === Infinity ? 'all correct' : correctCount + ' correct');
    }, delay);
  }
  if (m.type === 'submitted') console.log('[bot] SUBMITTED solved', m.solved, '/', m.total, 'usedMs', m.usedMs, 'waitingFor', m.waitingFor);
  if (m.type === 'game_over') console.log('[bot] GAME OVER', m.reason, JSON.stringify(m.ranking));
  if (m.type === 'error') console.log('[bot] ERROR', m.code);
});
setTimeout(() => process.exit(0), 180000);

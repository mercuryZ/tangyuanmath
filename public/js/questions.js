/* Tangyuan Math — 题目生成器（DESIGN.md 2.2）
 * 题型枚举（M0 实现四种）：
 *   times_tables_10 : 1–10 × 1–10
 *   times_tables_12 : 1–12 × 1–12
 *   two_by_one      : 10–99 × 2–9
 *   two_by_two      : 10–99 × 10–99（现有挑战玩法）
 * UMD：浏览器挂 window.TMQuestions，Node 供单元测试 require。
 */
(function (global) {
  'use strict';

  var DIFFICULTIES = {
    times_tables_10: { a: [1, 10], b: [1, 10] },
    times_tables_12: { a: [1, 12], b: [1, 12] },
    two_by_one:      { a: [10, 99], b: [2, 9] },
    two_by_two:      { a: [10, 99], b: [10, 99] }
  };

  var ALLOWED_COUNTS = [5, 10, 20];

  function randInt(rng, min, max) {
    return Math.floor(rng() * (max - min + 1)) + min;
  }

  /* 因子规范化：a ≤ b，用于错题合并（DESIGN 2.4 a×b 与 b×a 同一错题） */
  function normalize(a, b) {
    return a <= b ? { a: a, b: b } : { a: b, b: a };
  }

  /* 生成一组不重复（按规范化键）的题目。
   * 空间不足时（如 two_by_one 组合数 < count）允许重复补足，保证题数。 */
  function generateSet(difficulty, count, rng) {
    var def = DIFFICULTIES[difficulty];
    if (!def) throw new Error('unknown difficulty: ' + difficulty);
    if (ALLOWED_COUNTS.indexOf(count) === -1 && count !== 10) {
      throw new Error('count must be 5, 10 or 20');
    }
    rng = rng || Math.random;

    var seen = Object.create(null);
    var out = [];
    var guard = 0;
    var maxGuard = count * 60;
    while (out.length < count && guard < maxGuard) {
      guard++;
      var a = randInt(rng, def.a[0], def.a[1]);
      var b = randInt(rng, def.b[0], def.b[1]);
      var key = a <= b ? a + 'x' + b : b + 'x' + a;
      if (seen[key]) continue;
      seen[key] = true;
      out.push({ a: a, b: b, answer: a * b });
    }
    while (out.length < count) { // 空间不足兜底
      var fa = randInt(rng, def.a[0], def.a[1]);
      var fb = randInt(rng, def.b[0], def.b[1]);
      out.push({ a: fa, b: fb, answer: fa * fb });
    }
    return out;
  }

  var api = {
    DIFFICULTIES: DIFFICULTIES,
    ALLOWED_COUNTS: ALLOWED_COUNTS,
    generateSet: generateSet,
    normalize: normalize
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.TMQuestions = api;
})(typeof window !== 'undefined' ? window : globalThis);

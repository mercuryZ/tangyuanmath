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

  /* 闯关因子范围（DESIGN 2.1）
   * 第 0 关是热身（1 位 × 1 位），不计入 10 关；
   * 第 1–10 关从 1 位 × 1–19 逐步扩大到两位数 × 两位数。 */
  var CHALLENGE_LEVELS = [
    { a: [1, 9], b: [1, 9] },
    { a: [1, 9], b: [1, 19] },
    { a: [1, 9], b: [11, 19] },
    { a: [11, 19], b: [11, 19] },
    { a: [11, 19], b: [11, 29] },
    { a: [11, 19], b: [11, 39] },
    { a: [11, 29], b: [11, 49] },
    { a: [11, 39], b: [11, 59] },
    { a: [11, 49], b: [11, 69] },
    { a: [11, 59], b: [11, 89] },
    { a: [11, 99], b: [11, 99] }
  ];

  var ALLOWED_COUNTS = [5, 10, 20];

  function randInt(rng, min, max) {
    return Math.floor(rng() * (max - min + 1)) + min;
  }

  /* 因子规范化：a ≤ b，用于错题合并（DESIGN 2.4 a×b 与 b×a 同一错题） */
  function normalize(a, b) {
    return a <= b ? { a: a, b: b } : { a: b, b: a };
  }

  /* 按范围生成一组不重复（按规范化键）的题目。
   * 空间不足时（如 two_by_one 组合数 < count）允许重复补足，保证题数。 */
  function generateFromRange(def, count, rng) {
    if (!def) throw new Error('missing range');
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

  function generateSet(difficulty, count, rng) {
    var def = DIFFICULTIES[difficulty];
    if (!def) throw new Error('unknown difficulty: ' + difficulty);
    return generateFromRange(def, count, rng);
  }

  function generateChallenge(level, count, rng) {
    var def = CHALLENGE_LEVELS[level];
    if (!def) throw new Error('unknown challenge level: ' + level);
    return generateFromRange(def, count, rng);
  }

  var api = {
    DIFFICULTIES: DIFFICULTIES,
    CHALLENGE_LEVELS: CHALLENGE_LEVELS,
    ALLOWED_COUNTS: ALLOWED_COUNTS,
    generateSet: generateSet,
    generateFromRange: generateFromRange,
    generateChallenge: generateChallenge,
    normalize: normalize
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.TMQuestions = api;
})(typeof window !== 'undefined' ? window : globalThis);

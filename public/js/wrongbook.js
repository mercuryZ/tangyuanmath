/* Tangyuan Math — 错题本口径（DESIGN.md 2.4）
 * 规则：
 *   1. 首次答案错误 → 计入首次正确率并进入错题本（+1）；
 *   2. 同一题反复提交「相同」错误答案 → 不重复累计次数；
 *      提交「不同」的错误答案 → 累计（+1）；
 *   3. 未答（blank）≠ 错题；
 *   4. a×b 与 b×a 合并为同一错题（规范化键）；
 *   5. 错题重练答对 → 次数 -1，归零移出；
 *   6. 错题重练答错 → 每题每次重练最多 +1（由调用方传 roundSet 去重）；
 *   7. 当场修正（首次错、最终对）不立即抵消错题记录。
 * 全部为纯函数：传入数组返回新数组，不原地修改。
 */
(function (global) {
  'use strict';

  function keyOf(a, b) { return a <= b ? a + 'x' + b : b + 'x' + a; }

  function findEntry(book, a, b) {
    var k = keyOf(a, b);
    for (var i = 0; i < book.length; i++) if (book[i].key === k) return book[i];
    return null;
  }

  /* 普通练习/挑战结算后上报「首次错误」。返回新数组。 */
  function recordFirstWrong(book, a, b, userAnswer, now) {
    now = now || Date.now();
    var entry = findEntry(book, a, b);
    if (!entry) {
      var n = (a <= b) ? { a: a, b: b } : { a: b, b: a };
      return book.concat([{
        key: keyOf(a, b), a: n.a, b: n.b,
        user_answer: userAnswer, wrong_count: 1, last_wrong_at: now
      }]);
    }
    if (entry.user_answer === userAnswer) { // 相同答案不重复累计
      return book.map(function (e) {
        return e.key === entry.key ? Object.assign({}, e, { last_wrong_at: now }) : e;
      });
    }
    return book.map(function (e) {
      return e.key === entry.key
        ? Object.assign({}, e, { user_answer: userAnswer, wrong_count: e.wrong_count + 1, last_wrong_at: now })
        : e;
    });
  }

  /* 重练答对：次数 -1，归零移出。返回新数组。 */
  function reviewCorrect(book, a, b) {
    var entry = findEntry(book, a, b);
    if (!entry) return book;
    var next = entry.wrong_count - 1;
    if (next <= 0) return book.filter(function (e) { return e.key !== entry.key; });
    return book.map(function (e) {
      return e.key === entry.key ? Object.assign({}, e, { wrong_count: next }) : e;
    });
  }

  /* 重练答错：每题每次重练最多 +1。roundSet 为本轮已加过的 key 集合（会被写入）。 */
  function reviewWrong(book, a, b, userAnswer, roundSet, now) {
    now = now || Date.now();
    var k = keyOf(a, b);
    var entry = findEntry(book, a, b);
    if (!entry) {
      var n = (a <= b) ? { a: a, b: b } : { a: b, b: a };
      if (roundSet) roundSet[k] = true;
      return book.concat([{ key: k, a: n.a, b: n.b, user_answer: userAnswer, wrong_count: 1, last_wrong_at: now }]);
    }
    if (roundSet && roundSet[k]) { // 本轮已加过，只更新答案与时间
      return book.map(function (e) {
        return e.key === k ? Object.assign({}, e, { user_answer: userAnswer, last_wrong_at: now }) : e;
      });
    }
    if (roundSet) roundSet[k] = true;
    var inc = entry.user_answer === userAnswer ? 0 : 1;
    return book.map(function (e) {
      return e.key === k
        ? Object.assign({}, e, { user_answer: userAnswer, wrong_count: e.wrong_count + inc, last_wrong_at: now })
        : e;
    });
  }

  var api = {
    keyOf: keyOf,
    recordFirstWrong: recordFirstWrong,
    reviewCorrect: reviewCorrect,
    reviewWrong: reviewWrong
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.TMWrongBook = api;
})(typeof window !== 'undefined' ? window : globalThis);

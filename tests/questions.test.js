'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Q = require('../public/js/questions.js');

// 确定性伪随机：生成固定序列便于断言
function seqRng(arr) { let i = 0; return () => arr[i++ % arr.length]; }

test('四种题型范围正确', () => {
  for (const d of Object.keys(Q.DIFFICULTIES)) {
    const set = Q.generateSet(d, 20);
    assert.strictEqual(set.length, 20);
    for (const q of set) {
      const def = Q.DIFFICULTIES[d];
      assert.ok(q.a >= def.a[0] && q.a <= def.a[1], `${d} a 越界: ${q.a}`);
      assert.ok(q.b >= def.b[0] && q.b <= def.b[1], `${d} b 越界: ${q.b}`);
      assert.strictEqual(q.answer, q.a * q.b);
    }
  }
});

test('组内题目按规范化键不重复', () => {
  const set = Q.generateSet('two_by_two', 20);
  const keys = new Set(set.map(q => q.a <= q.b ? `${q.a}x${q.b}` : `${q.b}x${q.a}`));
  assert.strictEqual(keys.size, 20);
});

test('非法难度与题数抛错', () => {
  assert.throws(() => Q.generateSet('near_100', 10)); // M0 未实现的枚举
  assert.throws(() => Q.generateSet('two_by_two', 7)); // 题数不在允许列表
});

test('组合空间不足时兜底补足题数', () => {
  // two_by_one 组合数 = 90×8 = 720 > 20，这里用超大题数模拟空间压力场景
  const set = Q.generateSet('two_by_one', 20, seqRng([3, 5, 3, 5, 3, 5]));
  assert.strictEqual(set.length, 20); // 伪随机重复值下仍保证题数
});

test('normalize 因子规范化', () => {
  assert.deepStrictEqual(Q.normalize(13, 24), { a: 13, b: 24 });
  assert.deepStrictEqual(Q.normalize(24, 13), { a: 13, b: 24 });
});

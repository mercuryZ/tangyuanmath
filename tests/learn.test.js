'use strict';
const test = require('node:test');
const assert = require('node:assert');
const L = require('../public/js/learn.js');

/* 可注入的假 storage（模拟 localStorage 接口） */
function fakeStorage(initial) {
  const mem = Object.assign({}, initial || {});
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null),
    setItem: (k, v) => { mem[k] = String(v); },
    removeItem: (k) => { delete mem[k]; }
  };
}

test('进度：空/损坏数据安全读取', () => {
  assert.deepStrictEqual(L.loadProgress(fakeStorage()), {});
  assert.deepStrictEqual(L.loadProgress(fakeStorage({ tm_learn_progress: 'not json' })), {});
  assert.deepStrictEqual(L.loadProgress(fakeStorage({ tm_learn_progress: '[1,2]' })), {});
  const map = L.loadProgress(fakeStorage({ tm_learn_progress: '{"a":"2026-10-23T00:00:00Z"}' }));
  assert.strictEqual(map.a, '2026-10-23T00:00:00Z');
});

test('进度：toggleDone 增删与 completedCount', () => {
  let map = {};
  map = L.toggleDone(map, 'arrays');
  assert.strictEqual(L.completedCount(map), 1);
  assert.ok(map.arrays);
  map = L.toggleDone(map, 'nines');
  assert.strictEqual(L.completedCount(map), 2);
  map = L.toggleDone(map, 'arrays'); // 再点一次 = 撤销
  assert.strictEqual(L.completedCount(map), 1);
  assert.ok(!map.arrays);
});

test('进度：saveProgress/loadProgress 往返', () => {
  const s = fakeStorage();
  let map = L.toggleDone({}, 'skip-counting');
  L.saveProgress(map, s);
  assert.deepStrictEqual(L.loadProgress(s), map);
});

test('进度：nextLesson 返回第一个未完成课', () => {
  const order = ['what-is-multiplication', 'arrays', 'skip-counting'];
  let map = {};
  assert.strictEqual(L.nextLesson(order, map), 'what-is-multiplication');
  map = { 'what-is-multiplication': 'x' };
  assert.strictEqual(L.nextLesson(order, map), 'arrays');
  map = { 'what-is-multiplication': 'x', arrays: 'x', 'skip-counting': 'x' };
  assert.strictEqual(L.nextLesson(order, map), null); // 全部完成
});

test('groupsMath：连加算式与乘法对应', () => {
  const m = L.groupsMath(3, 4);
  assert.deepStrictEqual(m.terms, [4, 4, 4]);
  assert.strictEqual(m.total, 12);
  assert.strictEqual(L.groupsMath(0, 5).total, 0);
  assert.strictEqual(L.groupsMath(13, 4), null); // 越界
  assert.strictEqual(L.groupsMath(3, 0), null);
});

test('hopsMath：跳数落点序列', () => {
  const m = L.hopsMath(5, 3);
  assert.deepStrictEqual(m.landings, [5, 10, 15]);
  assert.strictEqual(m.total, 15);
  assert.deepStrictEqual(L.hopsMath(2, 0).landings, []);
  assert.strictEqual(L.hopsMath(11, 3), null);
});

test('splitEquation：7×8 切成 7×4 + 7×4', () => {
  const m = L.splitEquation(7, 8, 4);
  assert.strictEqual(m.left, 28);
  assert.strictEqual(m.right, 28);
  assert.strictEqual(m.total, 56);
  assert.strictEqual(L.splitEquation(7, 8, 0), null); // 切点越界
  assert.strictEqual(L.splitEquation(7, 8, 8), null);
  const m2 = L.splitEquation(6, 7, 5); // 6×7 = 6×5 + 6×2
  assert.strictEqual(m2.left, 30);
  assert.strictEqual(m2.right, 12);
});

test('ninesBreakdown：×9 = ×10 减一组，积的数位规律', () => {
  assert.deepStrictEqual(L.ninesBreakdown(3), { n: 3, tenTimes: 30, product: 27, tensDigit: 2, onesDigit: 7 });
  const m = L.ninesBreakdown(10);
  assert.strictEqual(m.product, 90);
  assert.strictEqual(m.onesDigit, 0);
  assert.strictEqual(L.ninesBreakdown(11), null);
});

test('crossoutCounts：整表 100 格起步', () => {
  const none = L.crossoutCounts([], 10);
  assert.strictEqual(none.considered, 100);
  assert.strictEqual(none.remainingCount, 100);
});

test('crossoutCounts：仅交换律 → 上三角 55 个', () => {
  const m = L.crossoutCounts(['swap'], 10);
  assert.strictEqual(m.considered, 55);
  assert.strictEqual(m.remainingCount, 55);
});

test('crossoutCounts：全部规律后只剩 10 个硬事实', () => {
  const m = L.crossoutCounts(L.CROSSOUT_RULES, 10);
  assert.strictEqual(m.remainingCount, 10);
  assert.deepStrictEqual(
    m.remaining.map((x) => `${x.a}x${x.b}`),
    ['3x3', '3x6', '3x7', '3x8', '6x6', '6x7', '6x8', '7x7', '7x8', '8x8']
  );
});

test('crossoutCounts：×1 规律划掉 19 格（整行+整列-重叠角）', () => {
  const m = L.crossoutCounts(['x1'], 10);
  assert.strictEqual(m.crossedCount, 19);
  assert.strictEqual(m.remainingCount, 81);
});

test('crossoutCounts：size 归一（x10 匹配最大因子）', () => {
  // size=9 的表里 "x10" 规则实际作用于 9
  const m = L.crossoutCounts(['x10'], 9);
  assert.strictEqual(m.considered, 81);
  assert.strictEqual(m.crossedCount, 17);
});

test('fmt：{var} 模板替换', () => {
  assert.strictEqual(L.fmt('{g} groups of {s}', { g: 3, s: 4 }), '3 groups of 4');
  assert.strictEqual(L.fmt('{a} + {missing}', { a: 1 }), '1 + ');
  assert.strictEqual(L.fmt(null), '');
});

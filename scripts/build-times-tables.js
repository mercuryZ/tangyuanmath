/* 生成 /en/times-tables/ 下的单表页与 hub 页（一次一表、讲解各不相同的模板）。
 * 运行：node scripts/build-times-tables.js
 *
 * 约定：页面骨架（头部/页脚/表格清单结构）由本脚本统一生成，保证结构一致；
 * 但每张表的「规律讲解」「FAQ」「切入角度」全部来自 TABLES 数据，逐表手写，
 * 严禁只在模板里换数字。要改页面文案时改这里的 TABLES 数据再重跑，不要直接改 HTML。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const OUT = path.resolve(__dirname, '..', 'public', 'en', 'times-tables');
const SITE = 'https://tangyuanmath.com';

/* 顺序即学习路径顺序：3、4、6 是"预筛难度最低、量最大"的先做集合，7、8、12 收尾 */
const ORDER = [3, 4, 6, 7, 8, 12];

/* 每张表的手写内容。pattern 是该表独有的讲解段落；faqs 逐表定制。 */
const TABLES = {
  3: {
    title: 'The 3 Times Table — Tips, Patterns & Free Practice',
    h1: 'The 3 Times Table',
    desc: 'The 3 times table from 1 × 3 to 12 × 3 on one page: the count-by-threes rhythm, the digit-sum check, and a free untimed practice round preset to the threes.',
    intro: 'The 3 times table is where the "real" tables begin — after the free wins of ×1, ×2 and ×10, the threes are the first table your child has to genuinely build. The good news: it has a rhythm you can hear, and a check-any-answer trick you can do on your fingers.',
    patterns: [
      ['Count by threes, out loud', 'The 3 times table is just skip-counting: 3, 6, 9, 12, 15, 18, 21, 24, 27, 30. Say the sequence a few times until it has a beat — most children pick up the rhythm faster than the facts. Once the sequence is there, any single fact can be rebuilt from its neighbor: if 3 × 6 = 18, then 3 × 7 is just one more three, 21.'],
      ['The unit digits cycle through all ten digits', 'Look down the answers: 3, 6, 9, 12, 15, 18, 21, 24, 27, 30. The final digits run 3, 6, 9, 2, 5, 8, 1, 4, 7, 0 — every digit exactly once — and then the pattern repeats. That is why 3 × 11 = 33 and 3 × 12 = 36 feel like déjà vu: after 30, the whole sequence starts over, thirty-plus.'],
      ['The digit check for threes', 'Any answer in the 3 times table passes a magic test: add its digits and the sum is 3, 6 or 9 (21 → 2 + 1 = 3; 27 → 2 + 7 = 9; 36 → 3 + 6 = 9). Your child can use it to catch mistakes — and it doubles as the divisibility rule for 3 later on.'],
      ['Build a three out of a two', 'When the rhythm fails, fall back on addition: 3 × n is (2 × n) + n. Four threes? A double (8) plus one more 4 — 12. It is slower, but it always works, and it turns the table into something your child can reason out instead of freeze on.']
    ],
    faqs: [
      ['What is the easiest way to learn the 3 times table?', 'Say the skip-counting sequence — 3, 6, 9, 12… — until it has a rhythm, then rebuild single facts from their neighbors: 3 × 7 is 3 × 6 plus one more 3. If that fails, compute (2 × n) + n: a double plus one more group.'],
      ['How can I check if an answer is really a multiple of 3?', 'Add the digits of the answer. If the digit sum is 3, 6 or 9 (keep adding if it is a bigger number), the answer is in the 3 times table: 51 → 5 + 1 = 6, so 51 = 3 × 17.'],
      ['How long does it take to learn the 3 times table?', 'With a few minutes of counting practice a day, most children have the threes in about a week. Our <a href="/play/#/setup?amin=1&amax=10&bmin=3&bmax=3">preset practice round</a> keeps the daily rounds short — five to ten questions is enough.']
    ]
  },
  4: {
    title: 'The 4 Times Table — Double, Double — Tips & Free Practice',
    h1: 'The 4 Times Table',
    desc: 'The 4 times table from 1 × 4 to 12 × 4 on one page: the double-double trick, why every answer is even, and a free untimed practice round preset to the fours.',
    intro: 'The 4 times table is the kindest of the "middle" tables, because it borrows a table your child already knows: the twos. Four is two twos, so any 4-fact is just two doublings away — no new sequence to memorize, just a move to apply.',
    patterns: [
      ['Double, double', '4 × n means double n, then double it again. 4 × 7: double 7 is 14, double 14 is 28. Done. Every fact in the table is reachable this way from something small, which is why the fours are a confidence table — children who freeze on "4 × 8" rarely freeze on "double 8, then double it again".'],
      ['Every answer is even — and the endings cycle', 'Because 4 is even, every multiple of 4 is even: no odd answers anywhere in the table. The final digits walk through the same five steps forever — 4, 8, 2, 6, 0, then repeat (4, 8, 12, 16, 20, 24, 28, 32, 36, 40…). If an answer ends in an odd digit, it cannot be a 4-fact.'],
      ['The fours are the twos, shifted', 'Compare the two tables side by side: 2 × 3 = 6 and 4 × 3 = 12 — every 4-answer is the matching 2-answer doubled. This is worth saying out loud with your child once; it makes the whole table feel less like new territory and more like a known landscape seen from higher up.'],
      ['Fours in real life', 'Four wheels on a car, four legs on a chair, four quarters in a dollar, 24 hours in a day (4 × 6) — the fours are everywhere once you start looking. Real-world hooks like "a day is 4 × 6 hours" turn abstract products into facts with a use.']
    ],
    faqs: [
      ['Is there a trick for the 4 times table?', 'Yes: double the number, then double it again. 4 × 9 = double 9 (18), double 18 (36). It works for every fact in the table and needs nothing but the twos.'],
      ['Why do all the answers in the 4 times table end in an even digit?', 'Because 4 itself is even: any whole number times an even number comes out even. The endings actually cycle 4, 8, 2, 6, 0 — so a "4-times-table answer" ending in 3, 5, 7, 9 or 1 is definitely wrong.'],
      ['How is the 4 times table connected to the 2 times table?', 'Every 4-fact is the matching 2-fact doubled: 2 × 6 = 12, and 4 × 6 = 24. That is the double-double trick viewed from the other side — knowing your twos means the fours are only two small steps away.']
    ]
  },
  6: {
    title: 'The 6 Times Table — Five Plus One More — Tips & Free Practice',
    h1: 'The 6 Times Table',
    desc: 'The 6 times table from 1 × 6 to 12 × 6 on one page: the five-plus-one-more trick, the even-and-divisible-by-3 checks, and a free untimed practice round preset to the sixes.',
    intro: 'The 6 times table sits in the middle of the chart and inherits from both neighbors: it is the fives plus one more group, and it is the threes doubled. Children who already own the 5s and 3s are most of the way to the sixes before they start.',
    patterns: [
      ['Five groups plus one more', 'Six is five plus one, so 6 × n is (5 × n) + n. 6 × 8? Five eights are 40, plus one more 8 — 48. This is the workhorse trick for the table because most children learn the fives early (they end in 5 or 0) and adding one more group is easy mental work.'],
      ['Or: the threes, doubled', 'Because 6 = 2 × 3, every 6-answer is the matching 3-answer doubled: 3 × 7 = 21, and 6 × 7 = 42. Two roads to the same fact is a luxury — when one slips, the other is there.'],
      ['Every answer passes two checks', 'All multiples of 6 are even (6 is even), and all of them are also multiples of 3 — the digit sum comes out to 3, 6 or 9 (42 → 4 + 2 = 6; 54 → 5 + 4 = 9). An answer that is odd, or whose digits do not sum to 3, 6 or 9, is not in the sixes. Two free error-catchers in one table.'],
      ['Watch out for 6 × 7', 'Ask any teacher: 6 × 7 = 42 is the most-fumbled fact in the whole chart. It is fumbled precisely because it belongs to two famous "hard" tables at once. Give it extra reps — it is the same fact as 7 × 6, and our <a href="/en/times-tables/7-times-table/">7 times table page</a> has its own angle on it.']
    ],
    faqs: [
      ['What is the trick for the 6 times table?', 'Five groups plus one more: 6 × n = (5 × n) + n. For 6 × 9, take five nines (45) and add one more 9 — 54. If the fives are shaky, double the threes instead: 6 × 9 = 2 × 27.'],
      ['How do I know if a number is in the 6 times table?', 'It must pass both checks: the number is even, and its digits add up to 3, 6 or 9. 48 passes (even; 4 + 8 = 12 → 1 + 2 = 3), 50 fails (even, but 5 + 0 = 5), 45 fails (digit sum works, but it is odd).'],
      ['Why is 6 × 7 = 42 so easy to forget?', 'It sits in the overlap of the two tables children find hardest, so it gets less natural rehearsal than its neighbors. Extra repetition helps — and remembering that 42 = 7 × 6 too means a miss in one table can be rescued from the other.']
    ]
  },
  7: {
    title: 'The 7 Times Table — The Famous Hard One, Tamed — Tips & Free Practice',
    h1: 'The 7 Times Table',
    desc: 'The 7 times table from 1 × 7 to 12 × 7 on one page: why sevens have no shortcut, the break-apart move that replaces one, and a free untimed practice round preset to the sevens.',
    intro: 'The 7 times table has a reputation, and it has earned it: 7 is the one number from 2 to 9 with no doubling trick, no fives shortcut, no finger method. But the reputation overstates the problem — most of what looks like "the hard 7s" is facts your child already owns from other tables, wearing a 7 on the left.',
    patterns: [
      ['Why the sevens feel patternless', 'Look down the answers: 7, 14, 21, 28, 35, 42, 49, 56, 63, 70. The final digits run 7, 4, 1, 8, 5, 2, 9, 6, 3, 0 — every digit exactly once, in an order that refuses to repeat early. Compare the easy tables (2s alternate even digits, 5s end in 5 or 0, 9s climb then fall) and you can see why 7 feels random: its unit digits genuinely have the least rhythm of any table.'],
      ['Most of the 7s are other tables in disguise', 'Count what is actually new. 1 × 7 through 5 × 7 are facts from the easy tables (2 × 7, 3 × 7, 4 × 7, 5 × 7 — owned already). The swap rule means 6 × 7 is the sixes\' problem too. That leaves genuinely new facts: 7 × 7, 7 × 8, 7 × 9, 7 × 10, 7 × 11, 7 × 12 — six facts, not twelve. Framing it this way makes the table feel half its size.'],
      ['Break the 7 apart: 5 + 2', 'The one reliable trick is break-apart: 7 = 5 + 2, so 7 × n = (5 × n) + (2 × n). 7 × 8? Five eights are 40, two eights are 16, total 56. It uses the two best-owned tables (5s and 2s) and it is exactly the break-apart strategy from Lesson 7 of our <a href="/en/learn/break-apart/">starter course</a>.'],
      ['Two set-piece facts worth over-learning', '7 × 7 = 49 (the near-halfway square) and 7 × 8 = 56 — the single most-forgotten fact in the chart. 56 has a gift in it: the answer is the factors written in a row, 5, 6, 7, 8. Say it as "five six seven eight — 56 = 7 × 8" a few times and it stops falling out.']
    ],
    faqs: [
      ['Why is the 7 times table considered the hardest?', 'Seven is prime and small, so it has no useful decomposition: not a double of anything, not part of the fives, no finger shortcut like the nines. Its unit digits also cycle through all ten digits with no early repetition, so skip-counting the sevens has less rhythm than any other table.'],
      ['What is the best trick for the 7 times table?', 'Break the 7 into 5 + 2: 7 × n = (5 × n) + (2 × n). For 7 × 9, that is 45 + 18 = 63. It relies only on the fives and twos, which most children know cold, and it generalizes to every fact in the table.'],
      ['What is 7 × 8?', '56. It is the most-forgotten fact in the whole multiplication chart — and it has a built-in memory hook: the digits 5, 6, 7, 8 appear in order, so "five, six, seven, eight" walks you straight to 56 = 7 × 8.']
    ]
  },
  8: {
    title: 'The 8 Times Table — Double, Double, Double — Tips & Free Practice',
    h1: 'The 8 Times Table',
    desc: 'The 8 times table from 1 × 8 to 12 × 8 on one page: the triple-double trick, the countdown of final digits, and a free untimed practice round preset to the eights.',
    intro: 'The 8 times table looks intimidating and is secretly one of the most mechanical: 8 is 2 × 2 × 2, so every eight-fact is three doublings away from a number your child already knows. The eights reward children who like procedures — same move every time.',
    patterns: [
      ['Double it three times', '8 × n means double n, double the result, double it again. 8 × 6: 6 → 12 → 24 → 48. That is the whole table. Children who mastered the double-double of the <a href="/en/times-tables/4-times-table/">4 times table</a> only need one more doubling, and it stays fast because each step is small.'],
      ['The endings count down: 8, 6, 4, 2, 0', 'Because 8 is even, every multiple of 8 is even — and the final digits march down the even digits in order: 8, 16, 24, 32, 40, 48, 56, 64, 72, 80. Final digits 8, 6, 4, 2, 0, then the cycle repeats. Any "8-answer" that ends in an odd digit is wrong on sight.'],
      ['The 8s are the 4s, doubled — and the 2s, quadrupled', 'Every 8-answer is the matching 4-answer doubled (4 × 7 = 28, 8 × 7 = 56) and the matching 2-answer doubled twice. The tables are a family: 2, 4 and 8 share one move at different depths. Seeing that chain is a small "math is connected" moment worth pausing for.'],
      ['Spiders and octopuses', 'Two spiders have 16 legs (8 × 2), three octopuses have 24 arms (8 × 3). Animal legs are the classic real-life hook for eights — ask "how many legs on five spiders?" at dinner and you have a practice round disguised as a joke.']
    ],
    faqs: [
      ['What is the trick for the 8 times table?', 'Double three times: n → 2n → 4n → 8n. For 8 × 7, that is 7 → 14 → 28 → 56. Every fact in the table is three small doublings from the starting number.'],
      ['Are all answers in the 8 times table even?', 'Yes — 8 is even, so every multiple of 8 is even. Stronger: every multiple of 8 can be halved three times over and still come out whole. The final digits cycle 8, 6, 4, 2, 0 in a strict countdown.'],
      ['What are the hardest facts in the 8 times table?', 'The ones that overlap the 7 times table: 8 × 7 = 56 tops most teachers\' lists, with 8 × 12 = 96 a distant second. Both respond well to the triple-double trick — 7 → 14 → 28 → 56 and 12 → 24 → 48 → 96.']
    ]
  },
  12: {
    title: 'The 12 Times Table — The Dozen Table — Tips & Free Practice',
    h1: 'The 12 Times Table',
    desc: 'The 12 times table from 1 × 12 to 12 × 12 on one page: the tens-plus-twos trick, dozens in real life, and a free untimed practice round that goes all the way to 12 × 12.',
    intro: 'The 12 times table is the stretch goal — the table printed past the edge of most classroom charts. It is also the most "grown-up" table your child will meet: eggs come by the dozen, a year has 12 months, a foot has 12 inches, and 12 × 12 = 144 even has its own name, a gross.',
    patterns: [
      ['Tens plus twos', 'Twelve is ten plus two, so 12 × n = (10 × n) + (2 × n). 12 × 8? Ten eights are 80, two eights are 16, total 96. Children who are solid on ×10 (the free win) and ×2 find this table almost suspiciously easy — it is built entirely from facts they own.'],
      ['Or: the sixes, doubled', 'Because 12 = 2 × 6, every 12-answer is the matching 6-answer doubled: 6 × 9 = 54, and 12 × 9 = 108. It is the same family trick as 2 → 4 → 8, one rung further: 2, 4, 6, 12 all double into each other.'],
      ['The useful neighbors: 11 and the squares', 'While you are up here, the 11s are nearly free (1 × 11 = 11, 2 × 11 = 22… write the digit twice for 1-digit numbers), and the big squares 12 × 12 = 144 is worth over-learning — it anchors the corner of the chart and shows up constantly in later math.'],
      ['Why twelve? A little history your child can repeat', 'Twelve divides evenly by 2, 3, 4 and 6 — which is why traders centuries ago picked it for eggs, pencils and inches, and why "a dozen" survived. A table with that much history stops feeling like arbitrary homework and starts feeling like a piece of the world.']
    ],
    faqs: [
      ['Why learn the 12 times table if most charts stop at 10?', 'Because so much of daily life is counted in dozens — eggs, months, inches, hours on a clock face. The 12s also preview a real algebra habit: splitting 12 into 10 + 2 and multiplying in parts, exactly the break-apart move used for big numbers later.'],
      ['What is the trick for the 12 times table?', 'Tens plus twos: 12 × n = (10 × n) + (2 × n). For 12 × 7, take 70 + 14 = 84. If the tens are ever shaky, double the sixes instead — 12 × 7 = 2 × 42.'],
      ['What is 12 × 12?', '144 — called "a gross" in old trading slang, the dozen-of-dozens. It is the largest fact on the classic chart and worth memorizing cold; it anchors the corner of the table and returns in geometry, factors and beyond.']
    ]
  }
};

/* ---------- 共享骨架 ---------- */
function headerHtml(slug) {
  return `<header class="site-header">
  <div class="wrap">
    <a class="brand" href="/"><img src="/img/logo_small.png" alt="Tangyuan Math logo"><b>Tangyuan Math</b></a>
    <nav class="site-nav" aria-label="Main">
      <a class="play-cta" href="/play/"><svg class="ico" aria-hidden="true"><use href="/img/icons.svg?v=20261106a#ico-play-solid"/></svg> Play</a>
      <details class="nav-drawer">
        <summary aria-label="Menu"><span class="nav-toggle-bars" aria-hidden="true"></span></summary>
        <div class="nav-links">
          <div class="nav-sub">
            <a class="nav-sub-trigger" href="/en/learn/">Learn<svg class="nav-caret" aria-hidden="true" viewBox="0 0 12 8"><path d="M1 1.5 6 6.5 11 1.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></a>
            <div class="nav-sub-panel">
              <a href="/en/learn/">Teach Multiplication From Scratch</a>
              <a href="/en/weekly-puzzle/">Weekly Puzzle</a>
            </div>
          </div>
          <a href="/en/tips/">Math Tips</a>
          <a href="/en/worksheets/">Worksheets</a>
          <a href="/en/pricing/">Pricing</a>
          <a href="/en/blog/">Blog</a>
          <a href="/en/about/">About</a>
          <a href="/account/">Parent Center</a>
          <a class="lang-switch" href="/zh/" hreflang="zh" lang="zh">中文</a>
        </div>
      </details>
    </nav>
  </div>
</header>`;
}

function footerHtml() {
  return `<footer class="site-footer">
  <div class="wrap">
    <span>© 2026 Tangyuan Math · Free practice, no ads, no tracking</span>
    <span>
      <a href="/en/pricing/">Pricing</a>
      <a href="/en/faq/">FAQ</a>
      <a href="/en/about/">About</a>
      <a href="/en/privacy/">Privacy</a>
      <a href="/en/terms/">Terms</a>
      <a href="mailto:hi@tangyuanmath.com">Contact</a>
      <a href="/zh/" lang="zh">中文</a>
    </span>
  </div>
</footer>`;
}

/* 1×n 到 12×n 的完整清单：4 列 × 6 行（左列 1–6，右列 7–12） */
function factsTableHtml(n) {
  let h = '<table class="tt-facts">\n<tbody>\n';
  for (let i = 1; i <= 6; i++) {
    h += `<tr><td>${i} × ${n} = <b>${i * n}</b></td><td>${i + 6} × ${n} = <b>${(i + 6) * n}</b></td></tr>\n`;
  }
  h += '</tbody>\n</table>';
  return h;
}

function breadcrumbLd(slug, name) {
  return `<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "@id": "${SITE}/en/times-tables/${slug}/#breadcrumb",
  "itemListElement": [
    {"@type": "ListItem", "position": 1, "name": "Home", "item": "${SITE}/"},
    {"@type": "ListItem", "position": 2, "name": "Times Tables", "item": "${SITE}/en/times-tables/"},
    {"@type": "ListItem", "position": 3, "name": "${name}"}
  ]
}
</script>`;
}

function faqLd(slug, faqs) {
  const items = faqs.map(([q, a]) =>
    `{"@type": "Question", "name": ${JSON.stringify(q)}, "acceptedAnswer": {"@type": "Answer", "text": ${JSON.stringify(a.replace(/<[^>]+>/g, ''))}}}`
  ).join(',\n    ');
  return `<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "@id": "${SITE}/en/times-tables/${slug}/#faq",
  "mainEntity": [
    ${items}
  ]
}
</script>`;
}

/* ---------- 单表页 ---------- */
function tablePage(n) {
  const T = TABLES[n];
  const slug = `${n}-times-table`;
  const idx = ORDER.indexOf(n);
  const prev = idx > 0 ? ORDER[idx - 1] : null;
  const next = idx < ORDER.length - 1 ? ORDER[idx + 1] : null;
  const playUrl = `/play/#/setup?amin=1&amax=${n}&bmin=${n}&bmax=${n}`;

  const patternsHtml = T.patterns.map(([h, body]) =>
    `      <h3>${h}</h3>\n      <p>${body}</p>`).join('\n');

  const faqsHtml = T.faqs.map(([q, a]) =>
    `      <div class="faq-item">\n        <h2>${q}</h2>\n        <p>${a}</p>\n      </div>`).join('\n');

  const pager = [];
  if (prev) pager.push(`<a class="back-btn" href="/en/times-tables/${prev}-times-table/"><span class="back-arrow" aria-hidden="true">←</span> The ${prev} times table</a>`);
  if (next) pager.push(`<a class="back-btn lesson-pager-next" href="/en/times-tables/${next}-times-table/">The ${next} times table <span class="back-arrow" aria-hidden="true">→</span></a>`);
  pager.push(`<a class="back-btn lesson-pager-next" href="/en/multiplication-chart/">Printable chart <span class="back-arrow" aria-hidden="true">→</span></a>`);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${T.title} — Tangyuan Math</title>
<meta name="description" content="${T.desc}">
<meta name="keywords" content="${n} times table, ${n} multiplication table, times table practice, multiplication table of ${n}, ${n} times table chart">
<link rel="canonical" href="${SITE}/en/times-tables/${slug}/">
<link rel="alternate" hreflang="en" href="${SITE}/en/times-tables/${slug}/">
<link rel="alternate" hreflang="x-default" href="${SITE}/en/times-tables/${slug}/">
<link rel="icon" href="/img/logo_small.png">
<link rel="stylesheet" href="/css/site.css?v=20261118b">
${breadcrumbLd(slug, `The ${n} Times Table`)}
${faqLd(slug, T.faqs)}
</head>
<body>

${headerHtml(slug)}

<main class="wrap">
  <section class="block">
    <h1><svg class="ico h-ico" aria-hidden="true"><use href="/img/icons.svg#ico-cards"/></svg> The ${n} Times Table</h1>
    <div class="prose">
      <p>${T.intro}</p>
    </div>
  </section>

  <section class="block" id="the-facts">
    <h2><svg class="ico h-ico" aria-hidden="true"><use href="/img/icons.svg#ico-cards"/></svg> The ${n} times table, 1 × ${n} to 12 × ${n}</h2>
${factsTableHtml(n)}
    <div class="prose">
      <p class="muted">The same twelve facts are in the top-left corner of our <a href="/en/multiplication-chart/">printable multiplication chart</a> (free PDF in color, black &amp; white and ink-saving), and on <a href="/en/worksheets/">printable worksheets</a> when pencil practice is the next step.</p>
    </div>
  </section>

  <section class="block" id="patterns">
    <h2><svg class="ico h-ico" aria-hidden="true"><use href="/img/icons.svg#ico-lightbulb"/></svg> The patterns in the ${n}s</h2>
    <div class="prose">
${patternsHtml}
    </div>
  </section>

  <section class="block" id="practice">
    <h2><svg class="ico h-ico" aria-hidden="true"><use href="/img/icons.svg#ico-play-solid"/></svg> Practice the ${n} times table now</h2>
    <div class="prose">
      <p>Reading a table is step one; answering from memory is step two. The practice round below is preset to exactly this table — ${n} × 1 through ${n} × 10 — untimed, with gentle step-by-step hints on every miss. Wrong answers quietly collect in the mistake book and come back in a later round until they are cleared.</p>
    </div>
    <div class="lesson-playcta">
      <a class="btn btn-primary" href="${playUrl}"><svg class="ico" aria-hidden="true"><use href="/img/icons.svg?v=20261106a#ico-play-solid"/></svg> Practice the ${n} times table</a>
      <a class="btn btn-ghost" href="/en/practice/times-tables/">More times-table practice options</a>
    </div>
    <div class="prose">
      <p class="muted">Prefer pencil and paper? The <a href="/en/worksheets/">printable worksheets</a> cover the same facts, and the <a href="/en/multiplication-chart/">1–12 chart</a> makes a good reference sheet while the facts are settling in.</p>
    </div>
  </section>

  <section class="block" id="faq">
    <h2><svg class="ico h-ico" aria-hidden="true"><use href="/img/icons.svg#ico-question"/></svg> ${n} times table FAQ</h2>
    <div class="prose prose-wide">
${faqsHtml}
    </div>
  </section>

  <nav class="block" aria-label="More times tables">
    <div class="lesson-pager">
      ${pager.join('\n      ')}
    </div>
  </nav>
</main>

${footerHtml()}

<script src="/js/header.js?v=20261023a" defer></script>
</body>
</html>
`;
}

/* ---------- hub 页 ---------- */
const HUB_TEASERS = {
  3: 'Where the real tables begin — count by threes, then check any answer with the digit trick.',
  4: 'The kindest middle table: double your twos, twice.',
  6: 'Five groups plus one more — and two free error-checks.',
  7: 'The famous hard one. It is half the size it looks.',
  8: 'Double, double, double — the most mechanical table there is.',
  12: 'The dozen table: tens plus twos, all the way to 12 × 12.'
};

function hubPage() {
  const cards = ORDER.map(n => `        <a class="learn-card" href="/en/times-tables/${n}-times-table/">
          <span class="learn-card-num">${n}</span>
          <span><b>The ${n} times table</b><small>${HUB_TEASERS[n]}</small></span>
        </a>`).join('\n');

  const crumbs = ORDER.map(n =>
    `    {"@type": "ListItem", "position": ${2 + ORDER.indexOf(n)}, "name": "The ${n} times table", "item": "${SITE}/en/times-tables/${n}-times-table/"}`).join(',\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Times Tables — Each Table Explained, with Free Practice — Tangyuan Math</title>
<meta name="description" content="Times tables, one page each: the 3, 4, 6, 7, 8 and 12 times tables with the patterns of each table spelled out, the full fact list, and a free untimed practice round preset to that table.">
<meta name="keywords" content="times tables, multiplication tables, 7 times table, 8 times table, 12 times table, times table practice">
<link rel="canonical" href="${SITE}/en/times-tables/">
<link rel="alternate" hreflang="en" href="${SITE}/en/times-tables/">
<link rel="alternate" hreflang="x-default" href="${SITE}/en/times-tables/">
<link rel="icon" href="/img/logo_small.png">
<link rel="stylesheet" href="/css/site.css?v=20261118b">
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "@id": "${SITE}/en/times-tables/#breadcrumb",
  "itemListElement": [
    {"@type": "ListItem", "position": 1, "name": "Home", "item": "${SITE}/"},
    {"@type": "ListItem", "position": 2, "name": "Times Tables"}
  ]
}
</script>
</head>
<body>

${headerHtml('')}

<main class="wrap">
  <section class="block">
    <h1><svg class="ico h-ico" aria-hidden="true"><use href="/img/icons.svg#ico-cards"/></svg> Times Tables, One Page Each</h1>
    <div class="prose">
      <p>Every table below gets its own page: the full fact list from 1 × n to 12 × n, the <b>patterns of that specific table</b> spelled out (the fours are not the sevens, and pretending otherwise is why table practice fails), three FAQ, and a practice round preset to exactly that table. No sign-up, no timers.</p>
      <p>If the whole concept is still new, the free <a href="/en/learn/">Multiplication Starter Course</a> builds understanding first — these pages are the fluency step that comes after.</p>
    </div>
  </section>

  <section class="block" id="tables">
    <h2><svg class="ico h-ico" aria-hidden="true"><use href="/img/icons.svg#ico-cards"/></svg> Pick a table</h2>
    <div class="learn-lesson-grid">
${cards}
    </div>
    <div class="prose">
      <p class="muted">More tables (2, 5, 9, 11) are covered by the <a href="/en/learn/easy-facts/">free wins lesson</a>, the <a href="/en/learn/nines/">nines lesson</a> and the <a href="/en/multiplication-chart/">full 1–12 chart</a> — each will get its own page too.</p>
    </div>
  </section>

  <section class="block" id="how-to-use">
    <h2><svg class="ico h-ico" aria-hidden="true"><use href="/img/icons.svg#ico-lightbulb"/></svg> How to use these pages</h2>
    <div class="prose">
      <p>Work <b>one table at a time</b>, in roughly the order above: the 3s, 4s and 6s are the friendliest, the 7s and 8s are the famous challenge, and the 12s are the stretch goal. A table page takes about ten minutes: read the patterns, say the full list aloud once, then run the preset practice round. Two or three short rounds across a few days beats one long drill — and because the game is untimed, a nervous child is never racing a clock while the facts are still settling.</p>
      <p>Alongside the tables, the <a href="/en/multiplication-chart/">printable multiplication charts</a> (1–12 and 1–100) make a wall reference your child can check between rounds, and the <a href="/en/worksheets/">printable worksheets</a> add pencil practice with an optional answer page.</p>
    </div>
  </section>

  <nav class="block" aria-label="Related pages">
    <div class="lesson-pager">
      <a class="back-btn" href="/en/multiplication-chart/"><span class="back-arrow" aria-hidden="true">←</span> Printable multiplication charts</a>
      <a class="back-btn lesson-pager-next" href="/en/practice/times-tables/">Times-tables practice <span class="back-arrow" aria-hidden="true">→</span></a>
    </div>
  </nav>
</main>

${footerHtml()}

<script src="/js/header.js?v=20261023a" defer></script>
</body>
</html>
`;
}

/* ---------- 输出 ---------- */
fs.mkdirSync(OUT, { recursive: true });
for (const n of ORDER) {
  const dir = path.join(OUT, `${n}-times-table`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), tablePage(n));
  console.log(`wrote /en/times-tables/${n}-times-table/`);
}
fs.writeFileSync(path.join(OUT, 'index.html'), hubPage());
console.log('wrote /en/times-tables/');

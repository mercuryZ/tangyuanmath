# 每周趣题草稿库（10 题）

> 用途：每周挑一道做成正式页面上线。制作流程照第 1 期 `public/zh/weekly-puzzle/chicken-rabbit/index.html` 与 `public/en/weekly-puzzle/chicken-rabbit/index.html` 的结构复制即可：
> 1. 建两个目录 `public/{zh,en}/weekly-puzzle/<slug>/index.html`（slug 双语一致）；
> 2. 改 head 的 title/description/keywords/canonical/hreflang，改 lang-switch 互链与返回链接；
> 3. 题面、提示（`.pz-hint`）、`data-widget="puzzle-answer"` 的 `data-config`（改 `puzzleId`、`inputs` 的 label 和 answer）、解析（`details#answer-solution`）；
> 4. 栏目页 `weekly-puzzle/index.html`：把原 featured 卡片挪进 `.post-grid`（照博客列表 `.post-tile` 格式），新卡放上 featured 位；
> 5. `public/sitemap.xml` 追加 en/zh 两条互指 hreflang；`server/src/index.js` 的 `BARE_PAGE_REDIRECTS` 视需要加裸路径（一般不需要，栏目入口即可）；
> 6. 本地浏览器验证交互后提交。
>
> 全部题目数值都已验算。难度与第 1 期相当：小学中高年级，重思路轻计算。

---

## 1. 停车场里的自行车与三轮车（第 1 期的直接复习题）
- **slug 建议**：`bikes-and-trikes`
- **中文题面**：停车场里停着自行车和三轮车共 9 辆，轮子一共 21 个。自行车和三轮车各有几辆？
- **English** (localized): At the school bike rack there are bicycles and tricycles — 9 vehicles altogether, with 21 wheels in total. How many are bicycles and how many are tricycles?
  - 本地化点：欧美孩子对 bikes/trikes 很熟；"bike rack" 场景比"停车场"更贴近生活。复习第 1 期可在文中点明「这就是鸡兔同笼换了件衣服」。
- **答案**：自行车 6 辆、三轮车 3 辆（6×2+3×3=21 ✓）
- **思路**：假设全是自行车 → 18 个轮子 → 多出 3 个 → 每换一辆三轮车多 1 个轮子 → 3 辆三轮车。
- **提示 1**：如果 9 辆全是自行车，该有几个轮子？
- **提示 2**：把一辆自行车换成三轮车，轮子多几个？
- **data-config inputs**：自行车（辆）=6，三轮车（辆）=3 / Bicycles=6, Tricycles=3

## 2. 蜘蛛与甲虫：比比谁的腿多
- **slug 建议**：`spiders-and-beetles`
- **中文题面**：草丛里有蜘蛛和甲虫共 21 只。蜘蛛有 8 条腿，甲虫有 6 条腿，一共 146 条腿。蜘蛛和甲虫各有几只？
- **English**: In the garden there are spiders and beetles — 21 bugs in all. Spiders have 8 legs and beetles have 6, making 146 legs altogether. How many spiders and how many beetles?
  - 本地化点：无需改动，garden/backyard 场景中美通用；可以加一句「它们都是益虫朋友」冲淡密集恐惧。
- **答案**：蜘蛛 10 只、甲虫 11 只（80+66=146 ✓）
- **思路**：假设全是甲虫 → 21×6=126 条腿 → 少 20 条 → 每换一只蜘蛛多 2 条 → 10 只蜘蛛。
- **提示 1**：如果 21 只全是甲虫，一共几条腿？
- **提示 2**：把一只甲虫换成蜘蛛，腿多几条？
- **data-config inputs**：蜘蛛（只）=10，甲虫（只）=11 / Spiders=10, Beetles=11

## 3. 蜗牛爬井（经典陷阱题）
- **slug 建议**：`snail-in-the-well`
- **中文题面**：一只蜗牛掉进 10 米深的井里。白天它往上爬 3 米，晚上睡着后会往下滑 2 米。照这样，它第几天能爬出井口？
- **English** (localized): A snail fell into a well 10 feet deep. Every day it climbs up 3 feet; every night while sleeping it slides back 2 feet. On which day does it get out?
  - 本地化点：英文版用 **feet** 更贴近美国家庭；数好恰好适用。这题的陷阱答案是「不是 10 天也不是 9 天」，答案揭晓时的戏剧感最强。
- **答案**：第 8 天白天爬出（前 7 天每天净进 1 米到 7 米处，第 8 天爬 3 米到 10 米，出去了，不会再滑下来）
- **思路**：关键转折——最后一天爬到顶就不滑了；用「每天净 1 米」推出第 7 天末在 7 米处，再单独算最后一天。
- **提示 1**：蜗牛每天「净」上升几米？第 7 天天黑时它在哪儿？
- **提示 2**：只要白天能爬到井口，晚上的下滑就不会发生。第 8 天白天它在 7 米处，爬 3 米够不够？
- **data-config inputs**：第几天爬出 =8 / On day = 8

## 4. 锯木头：段数不等于次数
- **slug 建议**：`sawing-the-log`
- **中文题面**：木匠爷爷把一根木头锯成 5 段，一共用了 8 分钟，每次锯的时间一样长。照这样的速度，把这根木头锯成 8 段要几分钟？
- **English**: Grandpa the carpenter sawed a log into 5 pieces, and it took him 8 minutes, each cut taking the same time. At that pace, how long would it take him to saw the same log into 8 pieces?
  - 本地化点：可直接用；英文版把「木头」讲成 fireplace log（壁炉柴火）更有画面感。
- **答案**：14 分钟（5 段只需锯 4 次 → 每次 2 分钟；8 段要锯 7 次 → 14 分钟）
- **思路**：经典 off-by-one。锯的次数 = 段数 − 1。先求单次时间，再算 7 次。
- **提示 1**：锯成 5 段，要锯几次？是 5 次吗？动手画一画。
- **提示 2**：锯 4 次用 8 分钟，那锯 1 次几分钟？8 段需要几次？
- **data-config inputs**：几分钟 =14 / Minutes = 14

## 5. 爸爸和儿子的年龄（差不变）
- **slug 建议**：`dad-and-me`
- **中文题面**：今年爸爸 35 岁，儿子 7 岁。再过几年，爸爸的年龄正好是儿子的 3 倍？
- **English**: This year Dad is 35 and his son is 7. In how many years will Dad be exactly 3 times as old as his son?
  - 本地化点：可直接用；英文版可换成 "Amy is 4 times as old as her brother…" 但保留父子版更亲切。
- **答案**：7 年后（42 = 14 × 3 ✓）
- **思路**：年龄差永远不变（28 岁）。3 倍时，差 = 儿子年龄的 2 倍 → 儿子 28÷2=14 岁 → 14−7=7 年后。列表法也完全可行（8 年后 43/15 不对、7 年后 42/14 正好）。
- **提示 1**：今年两人差多少岁？10 年后还差多少岁？
- **提示 2**：爸爸是儿子 3 倍时，28 岁的差距相当于儿子的几倍？
- **data-config inputs**：几年后 =7 / In how many years = 7

## 6. 狼、羊、白菜过河（逻辑序列）
- **slug 建议**：`wolf-sheep-cabbage`
- **中文题面**：农夫带着一只狼、一只羊和一棵白菜要过河。船很小，每次只能带一样东西。没人看着时，狼会吃羊，羊会吃白菜。农夫至少要渡河几次（来回各算一次）才能把三样都安全带过去？
- **English**: A farmer must take a wolf, a sheep, and a cabbage across a river. The boat is tiny — only one thing fits besides the farmer. Left alone, the wolf eats the sheep, and the sheep eats the cabbage. What is the smallest number of crossings (each trip counts once) that gets everything across safely?
  - 本地化点：这题在欧洲家喻户晓（Alcuin of York，约 1200 年前的谜题书就收录过），欧美孩子可能见过——正文可以写「你也许听过，但试试讲给家人证明你懂每一步」。
- **答案**：7 次渡河（带羊去 → 空手回 → 带狼去 → 带羊回 → 带白菜去 → 空手回 → 带羊去；狼和白菜互换位置同样成立）
- **思路**：关键洞察——羊是「危险中心」，必须让它独处两岸之外的时刻最多；「带回来」不是走弯路，是必要的妙招。
- **提示 1**：谁既怕狼又怕白菜，所以第一个带走的必须是它？
- **提示 2**：把第二样带过去后，把羊带回来，听起来像走回头路——但恰恰是它让一切成立。
- **data-config inputs**：至少渡河几次 =7 / Fewest crossings = 7

## 7. 分糖果：多 12 颗与少 4 颗（盈亏问题）
- **slug 建议**：`sharing-candy`
- **中文题面**：老师把一袋糖分给小朋友。每人分 5 颗，多了 12 颗；每人分 7 颗，就少了 4 颗。一共有几个小朋友？这袋糖有几颗？
- **English**: A teacher shares a bag of candies among some kids. If each kid gets 5 candies, 12 are left over. If each kid gets 7, the bag is 4 short. How many kids are there, and how many candies in the bag?
  - 本地化点：欧美课堂 candy 分发场景完全通用；若在意糖分话题可换成 stickers（贴纸），数值不变。
- **答案**：8 个小朋友、52 颗糖（5×8+12=52；7×8−4=52 ✓）
- **思路**：两种分法总量相同。第二次比第一次每人多 2 颗，总共要多用 12+4=16 颗 → 16÷2=8 人。
- **提示 1**：从「每人 5 颗」改成「每人 7 颗」，每个人手里的糖多几颗？
- **提示 2**：多下来的 12 颗加上不够的 4 颗，一共 16 颗新糖是从哪来的？每人多 2 颗，几个人才能吃掉 16 颗？
- **data-config inputs**：小朋友（个）=8，糖（颗）=52 / Kids=8, Candies=52

## 8. 切披萨：4 刀最多切几块
- **slug 建议**：`pizza-cuts`
- **中文题面**：用直直的刀切披萨：切 1 刀最多 2 块，切 2 刀最多 4 块。如果刀不能拐弯、切过的不能再切，切 4 刀最多能切成几块？
- **English**: Cutting a pizza with straight cuts: 1 cut makes at most 2 pieces, 2 cuts make at most 4. If every cut must be straight and no cut may bend or retrace, what is the greatest number of pieces you can make with 4 cuts?
  - 本地化点：披萨本身即欧美本地化；中文版可以强调「不许叠披萨」。
- **答案**：11 块（规律：1→2，2→4，3→7，4→11；每次新刀与前面每一刀都相交，新增块数 = 交点数 + 1，即 +2、+3、+4）
- **思路**：动手画是最好的路径。发现「第 n 刀最多新增 n 块」的规律比记住公式重要。
- **提示 1**：3 刀最多 7 块——每一刀都要和前面每一刀交叉，而且交点不能挤在一起。
- **提示 2**：第 4 刀穿过前面 3 刀，被分成 4 小段，每小段把一块劈成两半——新增几块？
- **data-config inputs**：最多几块 =11 / Most pieces = 11

## 9. 天平找重球：最少称几次
- **slug 建议**：`balance-scale`
- **中文题面**：9 个一模一样的小球，其中 1 个稍重（其他 8 个一样重）。有一架天平，没有砝码。最少称几次，就一定能找出那个重球？
- **English**: You have 9 identical-looking balls; one is slightly heavier than the rest. With a balance scale and no weights, what is the fewest number of weighings that is guaranteed to find the heavy ball?
  - 本地化点：可直接用；英文版场景常换成分组赛球（分组赛 ball groupings）——保持天平版更直观。
- **答案**：2 次（3 个一组分成 3 组：先称两组，重球必在其中之一或第三组；再把那组 3 个称一次，重的那边就是）
- **思路**：每次称量都要把「可能性」砍到三分之一；2 次最多能从 3×3=9 个里锁定 1 个。
- **提示 1**：天平一次能比较几组？每组放几个最划算——1 个还是 3 个？
- **提示 2**：第一次称完后，无论天平哪边沉（或平衡），重球都只剩 3 个候选。3 个球再称几次？
- **data-config inputs**：最少称几次 =2 / Fewest weighings = 2

## 10. 握手问题：8 个人握几次
- **slug 建议**：`handshakes`
- **中文题面**：8 个小朋友参加聚会，每两个人都握一次手，而且只握一次。他们一共握了几次手？
- **English**: At a party, 8 kids all shake hands with each other exactly once. How many handshakes happen in total?
  - 本地化点：可直接用；课堂里让孩子真的站起来握手数一遍，是这题最好的教法（中英通用）。
- **答案**：28 次（7+6+5+4+3+2+1=28）
- **思路**：每人握手 7 次 → 8×7=56，但每次握手被两个人各算了 1 次，除以 2 → 28。列表法：第 1 个孩子握 7 次，第 2 个不用再和第 1 个握，握 6 次……
- **提示 1**：让第 1 个小朋友出发：他要握几次？第 2 个还要和第 1 个重握吗？
- **提示 2**：7+6+5+4+3+2+1=？或者：8×7 把每次握手数了两遍。
- **data-config inputs**：握手次数 =28 / Handshakes = 28

---

## 发布节奏备忘

- 以上每题都够一期；第 2 期建议先用第 1 题（自行车三轮车），正好巩固鸡兔同笼的假设法。
- 出题口径：数值小（两位数内）、答案唯一、有「啊哈」时刻或陷阱转折；避免需要方程才能解的题（列表法/画图法必须可行）。
- 每期英文版的本地化不只是翻译：换场景（农场、停车场、壁炉柴火）、换单位（米→feet）、补文化注（如狼羊白菜在欧洲的来历）。
- 新期页面的 `data-config` 里记得换新的 `puzzleId`（= slug），否则星星会记串。
- 栏目页 `.post-grid` 每期追加一张 `.post-tile` 卡片，并把旧的 featured 换下来；图片放 `public/img/weekly-puzzle/<slug>.svg`（1200×675，品牌色 #F2555A/#FFF7F2 + 圆点底纹，参考 chicken-rabbit.svg）。

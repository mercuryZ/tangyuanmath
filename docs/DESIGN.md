# Tangyuan Math — 汤圆数学设计文档

> 版本：v3.0（2026-10-15，合并版）
> 本文档由《二三四阶段设计 v1.1》与《海外优先版 v2.0》合并而成，是本项目**唯一**设计文档，旧文档已删除。
> 市场方向：海外英语用户优先，保留中文版本。
> 当前状态：第一阶段单文件乘法游戏已完成；本文覆盖海外化、用户系统、付费、公开内容建设与多人实时对战（Live Race）。
> 本文是实施规范，不代表其中的规划功能已经上线。

---

## 0. 决策摘要

### 0.1 保留与调整

| 项目 | 决策 |
|---|---|
| 后端 | 保留真实服务器：Node.js + Express + SQLite |
| 前端 | 保留原生 HTML/CSS/JS，无强制构建工具 |
| 游戏 | 保留原 10 关挑战，新增无计时练习与难度选择 |
| 用户 | 游客优先；云端账号定位为家长账号 + 儿童档案 |
| 品牌 | 建议使用 Tangyuan Math / 汤圆数学 |
| 当前游戏名 | Tangyuan Math: Multiplication Adventure / 汤圆乘法大冒险 |
| 支付 | 保留真实支付，海外托管结账与 webhook |
| 广告 | **永不投放商业广告**，不实现广告适配层，无「去广告」权益项（v3.0 决策） |
| 会员 | 月付 / 年付订阅（自动续费，可随时取消）+ 一次性永久版 |
| PDF | 支持英文、US Letter 和 A4；服务端鉴权生成 |
| 图片 | 继续只存当前浏览器，不上传 |
| GEO | 增加直接可读取的公开 HTML 页面，不能只依赖 hash 路由 |
| 免费历史限制 | 首发不采用“仅最近 30 天”；所有记录仍受公开的保留政策约束 |
| 多人对战 | 房间码邀请制 Live Race（第 13 节）：服务端权威、家庭会员专属、零陌生人匹配 |

### 0.2 上线前必须确定的事项

1. 首发目标国家或地区。
2. 经营主体所在地、支付平台可用性与税务安排。
3. 最终品牌、域名及商标冲突核查。
4. 儿童相关服务的数据收集、家长同意和删除流程。
5. 付费权益、退款规则和服务停止处理规则。

不预设支付审核时间或固定费率；以平台当时要求为准。

### 0.3 合并决策记录（2026-10-15，用户确认）

1. 市场方向：**海外优先，保留中文版**（合并以 v2.0 为主干）。
2. 账号模型：**家庭账号（最多 2 位家长）+ 子女账号（最多 2 名）**。家长用邮箱/Google 登录，子女用家长创建的用户名 + 密码登录；游客免注册可玩练习与挑战。
3. 广告：**永不投放**——会员卖点仅保留 PDF 下载与自定义通关图片。
4. 文档：合并为单一设计文档（本文件 v3.0），删除旧档。

---

## 1. 品牌与产品定位

### 1.1 品牌体系

- 主品牌：Tangyuan Math
- 中文品牌：汤圆数学
- 当前产品：Multiplication Adventure / 乘法大冒险
- 口号：Become a Math Hero, One Problem at a Time.
- 角色介绍：Meet Tangyuan, your little rice-ball math buddy.

“To Be a Math Hero”保留为命名灵感，不作为推荐主品牌。

候选主域名：`tangyuanmath.com`。

域名注册状态、历史、续费价格和同名商标均需另行核查。优先使用一个主域名，通过 `/en/`、`/zh/` 区分语言，不建立两个独立品牌站。

### 1.2 核心定位

> A friendly multiplication practice game for learners who know their times tables and are ready for the next step.

产品提供轻松练习、分步提示和可选速度挑战，不将速度作为唯一学习成果。
2026-10-23 起配套免费「乘法启蒙课」（/en/learn/，9 节家长带学课）覆盖还不会乘法表的初学者：讲解脚本 + 互动演示（learn.js）+ 小考验 + 深链练习（/play/#/setup?amin=…），进度存 localStorage。

不宣传：
- 适合所有儿童；
- 保证在固定天数内达到某种速度；
- 已获得尚不存在的课程认证；
- 已支持尚未上线的功能。

### 1.3 首发受众

- 在家练习乘法的家庭；
- homeschool 家长；
- 用于课堂热身或补充练习的老师；
- 已掌握相关计算基础、希望提高熟练度的学习者。

默认用能力要求描述适用人群。年级标签仅在对目标地区课程要求进行核对后添加。

---

## 2. 游戏与学习体验

### 2.1 三种模式

| 模式 | 计时 | 内容 | 首发优先级 |
|---|---|---|---|
| Practice | 默认关闭，可选开启 | 自选范围，练习与答案检查 | P0 |
| Challenge | 开启 | 原有 10 关闯关 | P0 |
| Learn | — | 已实现为静态课程 /en/learn/（9 节课：讲解脚本 + 互动演示 + 小考验 + 深链练习，进度存 localStorage），非游戏内模式 | 已上线（2026-10-23） |

原挑战保留每关 10 题的设置，所有关卡统一限时 120 秒，并标记为进阶速度挑战。
第 0 关是热身关（个位数 × 个位数，120 秒），不计入 10 关进度。

| 关卡 | 因子范围 |
|---|---|
| 0（热身，不计入） | 1–9 × 1–9 |
| 1 | 1–9 × 1–19 |
| 2 | 1–9 × 11–19 |
| 3 | 11–19 × 11–19 |
| 4 | 11–19 × 11–29 |
| 5 | 11–19 × 11–39 |
| 6 | 11–29 × 11–49 |
| 7 | 11–39 × 11–59 |
| 8 | 11–49 × 11–69 |
| 9 | 11–59 × 11–89 |
| 10 | 11–99 × 11–99 |

不同模式的成绩分开统计，不将无计时练习与速度挑战直接排名比较。

### 2.2 难度与题型

题目生成器支持明确的配置枚举：

- `times_tables_10`：1–10 乘法表；
- `times_tables_12`：1–12 乘法表；
- `two_by_one`：10–99 × 2–9；
- `two_by_two`：10–99 × 10–99；
- `multiply_by_11`：10–99 × 11；
- `near_100`：接近 100 的两位数乘法。

首发优先实现前三种基础范围与现有两位数乘法。
专项生成器上线前，教程不能把普通随机练习入口描述为专项训练。

每组默认 10 题，Practice 可选 5、10、20 题。
无计时模式不受原 `used_time_s ≤ 600` 的统一限制；范围按模式分别验证。

### 2.3 教学原则

- 允许先理解再提速；
- 提示包括拆分、分配律及进位说明；
- 技巧页写明适用条件和反例；
- 错误反馈不羞辱、不制造焦虑；
- 不设置付费复活、付费继续答题或看广告解锁练习；
- 打卡为可选激励，不惩罚中断。

英文按钮：
- Start Practice
- Start Challenge
- Check Answers
- Math Tips
- Practice My Mistakes
- Try Again
- Level Complete!

### 2.4 错误记录口径

“首次作答”和“最终完成”分开记录：

- 首次答案错误：计入首次正确率，并进入错题本；
- 后续改正确：标记本题最终完成，不覆盖首次错误；
- 未答：记为 blank，不自动当作错题；
- 同一题反复提交相同答案：不重复累计错误次数；
- 错题重练答对：负担次数减一，归零移出活动错题列表；
- 错题重练答错：每题每次重练最多增加一次。

正常练习后的当场修正不立即抵消错题记录，避免“刚加入就删除”。

`a × b` 与 `b × a` 默认合并为同一错题，使用规范化因子键。
删除错题不会删除原始练习记录，界面须明确区分。

### 2.5 无障碍与设备适配

- 完整支持键盘、Enter 跳题和明显的焦点样式；
- 输入框有题目关联标签，移动端使用数字输入键盘；
- 不仅依靠红绿颜色表达对错；
- 支持 `prefers-reduced-motion` 和手动关闭庆祝动画；
- 图表提供文字摘要或数据表；
- 弹窗管理焦点，关闭后返回触发按钮；
- 手机、平板、桌面均可用，页面缩放不遮挡操作；
- 数学题优先使用可读系统字体，可爱字体用于标题；
- 音效默认关闭，启用需用户主动操作。

---

## 3. 总体架构与项目结构

### 3.1 架构

    浏览器
    ├─ 公开静态内容：产品、教程、FAQ、隐私、价格
    ├─ 游戏应用：Practice / Challenge / Learn
    ├─ 家长中心：儿童档案、统计、错题、权益
    ├─ localStorage：有限游客记录及偏好
    └─ IndexedDB：本地庆祝图片
            │ HTTPS，同源 Cookie
    Express
    ├─ 身份认证、档案与授权
    ├─ 练习、错题与统计
    ├─ 订单、支付 webhook、兑换码
    ├─ PDF 生成
    ├─ 实时对战 Live Race（WebSocket，房间内存态，第 13 节）
    └─ 静态托管
            │
    SQLite 持久卷 + 加密异地备份
            │
    支付平台托管结账页

### 3.2 建议目录

    tangyuan-math/
    ├─ client/
    │  ├─ index.html              # 默认语言入口，可直接阅读
    │  ├─ en/                    # 英文公开页面
    │  ├─ zh/                    # 中文公开页面
    │  ├─ play/index.html        # 游戏应用
    │  ├─ account/index.html     # 家长中心
    │  ├─ css/
    │  ├─ js/
    │  │  ├─ app.js
    │  │  ├─ api.js
    │  │  ├─ auth.js
    │  │  ├─ game.js
    │  │  ├─ questions.js
    │  │  ├─ stats.js
    │  │  ├─ premium.js
    │  │  ├─ idb.js
    │  │  ├─ i18n.js
    │  │  └─ versus.js
    │  ├─ locales/en.json
    │  ├─ locales/zh.json
    │  └─ assets/
    ├─ server/
    │  ├─ src/
    │  │  ├─ index.js
    │  │  ├─ db.js
    │  │  ├─ auth.js
    │  │  ├─ family.js
    │  │  ├─ family-routes.js
    │  │  ├─ profiles.js
    │  │  ├─ records.js
    │  │  ├─ orders.js
    │  │  ├─ payment/
    │  │  ├─ pdf.js
    │  │  ├─ versus.js
    │  │  └─ middleware.js
    │  ├─ fonts/
    │  └─ data/
    ├─ tests/
    ├─ scripts/
    ├─ DESIGN.md
    ├─ README.md
    ├─ readme.zh.md
    └─ multiplication_game.html

公开页面使用真实 URL，核心正文直接存在于 HTML。
`/play/` 内部可继续采用 hash 路由；账号页不作为搜索入口。

---

## 4. 国际化与本地存储

### 4.1 语言

- 首发英文完整可用，中文保留；
- 按浏览器语言提供初始建议，不强制跳转；
- 用户选择优先于自动检测；
- 页面正确设置 `lang`；
- 所有界面文字使用翻译键，避免散落的硬编码字符串；
- 使用 `Intl` 处理日期、数字和货币；
- API 错误返回稳定 `code`，由前端映射本地化提示。

### 4.2 时间与打卡

- 服务端统一保存 UTC 时间戳；
- 家长账号保存可修改的 IANA 时区；
- 按该时区计算学习日期；
- 修改时区的影响在设置页说明；
- 打卡不直接使用服务器所在时区。

### 4.3 游客记录与图片

- 游客记录限定条数和保留期限，提供清除按钮；
- 登录后由家长主动选择是否导入，不自动上传；
- 导入目标为明确选中的儿童档案；
- 使用客户端事件 ID 去重，重复导入不重复计数；
- 离线重试队列按账号与档案隔离；
- 登出后停止该账号的上报任务。

自定义图片：
- 仅支持 JPEG、PNG、WebP；
- 最大文件大小 5 MB，并限制解码尺寸；
- 拒绝 SVG 等主动内容格式；
- Blob 存 IndexedDB，不上传、不进入日志或分析事件；
- Object URL 用完及时释放；
- 提供恢复默认、导出和导入；
- 设置页说明清除浏览器数据会丢失图片；
- 多设备登录不等于图片同步。

“只存本地”仅描述此图片功能，不代表整个网站不收集任何数据。

---

## 5. 家长账号与儿童档案

### 5.1 账号模型

首发以游客练习为默认路径。
云端保存和购买入口面向家长。家庭可包含最多 2 位家长和 2 名子女；子女账号由家长创建，使用用户名 + 密码登录，不收集邮箱。

家长账号：
- 邮箱和密码；
- 可选「通过 Google 登录」：服务端 OAuth 2.0 授权码重定向流程（本站页面零第三方脚本，CSP 不变），仅申请 openid 与 email 两个 scope；
- Google 账号关联规则（防预注册劫持）：已绑定 google_id 直接登录；同邮箱且本地账号已验证 → 自动关联；同邮箱但未验证 → 拒绝并提示先完成邮箱验证；全新邮箱 → 直接建号（标记已验证，password_hash 置空，密码登录自然失效）；
- 验证邮箱与密码重置；
- 不将邮箱默认加入营销订阅；
- 不收集不必要的家庭资料。

儿童 / 子女账号：
- 昵称和预设头像；
- 可选用户名 + 密码（家长创建；不收集邮箱，不使用真实姓名）；
- 不要求真实姓名、学校或精确生日；
- 不公开展示资料或成绩；对战显示名仍由系统随机生成；
- 每个家庭最多 2 名子女；新增子女席位需要有效会员；
- 家长可重置密码或删除子女账号。

家庭与共同家长：
- 一位家长（owner）可通过邮箱邀请另一位家长加入家庭；
- 加入后两位家长共享同一份会员与子女账号；
- 每个家庭最多 2 位家长；邀请需要有效会员。
- 新注册不赠送免费会员；付费入口为 $1 体验 3 天，以及月付/年付/永久版。

“家长入口”或成年确认本身不能替代适用法律要求的家长同意程序。
儿童数据的云端保存须通过第 10 节的上线门禁。

### 5.2 鉴权

- bcrypt 密码哈希，成本根据服务器性能基准确定；
- HttpOnly、Secure、SameSite=Lax 会话 Cookie；
- 服务端只存会话令牌哈希；
- 登录成功后轮换会话；
- 会话有效期默认 7 天；
- 支持当前设备登出与全部会话撤销；
- 密码重置后撤销旧会话；
- 不在 localStorage 存认证令牌；
- 修改类接口验证 CSRF token 和请求来源。

SameSite 和 HttpOnly 不等于完整的 CSRF/XSS 防护。

---

## 6. 数据库设计

SQLite 开启外键、WAL、合理的 busy timeout。
使用版本化迁移，不仅依赖 `CREATE TABLE IF NOT EXISTS`。

下表为目标字段规范，实施时转成带约束和索引的 SQL 迁移。

| 表 | 关键字段与约束 |
|---|---|
| `users` | id、email_normalized UNIQUE、password_hash、email_verified_at、locale、timezone、created_at、google_id nullable、family_id FK、family_role('owner'/'coparent') |
| `families` | id、created_at、is_personal（注册时自动创建，可被邀请合并） |
| `family_invites` | id、family_id FK、email_normalized、token_hash UNIQUE、invited_by FK、expires_at、accepted_at nullable、accepted_by nullable、revoked_at nullable、created_at |
| `sessions` | token_hash PRIMARY KEY、user_id FK nullable、child_profile_id FK nullable、expires_at、created_at；二者恰有一个非空 |
| `auth_tokens` | token_hash、user_id、purpose、expires_at、used_at |
| `child_profiles` | id、user_id FK（创建者/审计）、family_id FK、nickname、avatar_key、username nullable、username_normalized UNIQUE nullable、password_hash nullable、last_login_at nullable、created_at |
| `attempts` | id、profile_id FK、client_event_id、mode、difficulty、level nullable、passed、active_time_ms、created_at、received_at |
| `attempt_questions` | id、attempt_id FK、position、a、b、first_answer nullable、final_answer nullable、first_correct nullable、final_correct、active_time_ms nullable |
| `wrong_questions` | id、profile_id FK、a、b、user_answer nullable、wrong_count、last_wrong_at |
| `orders` | id、order_no UNIQUE、family_id FK、purchased_by FK、sku、amount_minor、currency、status、provider、provider_checkout_id、provider_trade_no、expires_at、paid_at、created_at |
| `payment_events` | provider、event_id、event_type、processing_status、processed_at |
| `entitlements` | id、family_id FK、user_id FK nullable（授予人/审计）、feature_key、source_type('order'/'redeem'/'grant'/'promo')、source_id、starts_at、expires_at nullable、revoked_at nullable |
| `redeem_codes` | code_hash UNIQUE、code_enc（AES-256-GCM 加密明文，供后台展示）、sku、expires_at nullable、used_by nullable、used_at nullable |
| `privacy_consents` | user_id、scope、policy_version、method、granted_at、withdrawn_at nullable |
| `matches` | id、room_code、mode='versus'、difficulty、count、started_at、ended_at（Live Race 对局，仅登录档案落库，见第 13 节） |
| `match_players` | id、match_id FK、profile_id FK、seat、display_name（系统生成名）、solved、used_ms、rank、disconnected |

必须的约束：
- `attempts(profile_id, client_event_id)` 唯一；
- `attempt_questions(attempt_id, position)` 唯一；
- `wrong_questions(profile_id, a, b)` 唯一，因子规范化；
- `payment_events(provider, event_id)` 唯一；
- 非空平台交易号按 provider 组合唯一；
- `wrong_count` 大于零，归零时移出活动错题表；
- 订单金额为整数最小货币单位；
- 币种为允许列表中的 ISO 货币代码；
- `match_players(match_id, seat)` 唯一；对局数据仅归属儿童档案，账号删除时级联清除。

原 `amount_fen` 改为 `amount_minor`。
不假设所有币种都是两位小数；首发仅开放已验证的 USD 配置。

会员权益以 `entitlements` 为准，不直接依靠单个 `users.plan` 字段。
退款某一订单只撤销该来源权益，不能覆盖另一个有效购买或赠送来源。

删除练习数据与订单保留分开处理。
依法需要保留的交易记录按公开政策保存，并尽量解除与儿童数据的关联。

---

## 7. API 与统计口径

### 7.1 API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/register` | 创建家长账号 |
| POST | `/api/auth/verify-email` | 验证邮箱 |
| POST | `/api/auth/login` | 建立会话 |
| POST | `/api/auth/logout` | 撤销当前会话 |
| POST | `/api/auth/forgot-password` | 统一响应，避免泄露账号是否存在 |
| POST | `/api/auth/reset-password` | 一次性令牌重置 |
| GET | `/api/me` | 语言、时区、档案和有效权益 |
| GET/POST | `/api/profiles` | 查询、创建档案 |
| PATCH/DELETE | `/api/profiles/:id` | 更新、删除档案 |
| POST | `/api/profiles/:id/records` | 上报练习与逐题答案 |
| POST | `/api/profiles/:id/records/import` | 有界批量导入游客记录 |
| GET | `/api/profiles/:id/records` | 游标分页与筛选 |
| GET | `/api/profiles/:id/stats` | 分模式、难度统计 |
| GET | `/api/profiles/:id/wrongbook` | 活动错题 |
| POST | `/api/profiles/:id/wrongbook/review` | 上报重练答案 |
| DELETE | `/api/profiles/:id/wrongbook/:qid` | 手动移除 |
| POST | `/api/orders` | 根据服务端 SKU 创建结账 |
| GET | `/api/orders` / `/api/orders/:orderNo` | 仅订单所属家庭可查 |
| POST | `/api/orders/:orderNo/cancel` | 取消订阅续费（家长） |
| POST | `/api/payments/waffo/webhook` | Waffo RSA-SHA256 验签回调（原始 body） |
| POST | `/api/redeem` | 兑换，限流并事务处理 |
| GET | `/api/pdf/worksheet` | 服务端检查权益后生成 |
| GET | `/api/account/export` | 导出学习数据 |
| DELETE | `/api/account` | 按删除策略处理账号 |

JSON 成功：`{ok:true,data:...}`。
JSON 失败：`{ok:false,code:"...",msg:"..."}`。
PDF 下载及平台要求的 webhook 响应不强套此格式。

所有档案资源验证归属，不能仅验证已登录。
服务端根据答案计算正确与错误，不接受客户端 `correct:true` 作为权威结果。

导入、练习上报、PDF、登录与订单创建分别限流。
校验请求体大小、题数、枚举、因子范围、整数边界和分页上限。

### 7.2 计时

原“相邻提交时刻相减”无法准确支持跳题、回改和一次提交多题，改为记录每题的活动时间：

- 使用 `performance.now()` 计算客户端时间间隔；
- 输入框获得焦点时开始该题计时，失焦时累计；
- 页面隐藏时暂停活动时间；
- 首次有效提交保存首次作答数据；
- 最终提交保存最终结果；
- 未作答题的耗时可为 null；
- 无焦点阅读时间不强行归给某题。

此指标称为“活动答题时间”，不是严格测量的心理计算时间。

Challenge 倒计时使用绝对截止时刻计算，不依赖每秒递减计数。
标签页隐藏不会延长挑战截止时间。

### 7.3 统计

- 首次正确率：首次正确题数 / 已首次作答题数；
- 最终完成率：最终正确题数 / 本组总题数；
- blank 单独展示；
- 平均活动时间只包含有效计时题目；
- 提示辅助题与独立作答题可分别统计；
- 趋势按模式、难度分组；
- 记录样本较少时，不展示夸大的“进步百分比”；
- 打卡按账号时区自然日计算；
- 学习统计非考试成绩，不用于高风险评价。

---

## 8. 付费、权益与支付

### 8.1 定价测试

| 版本 | 价格 |
|---|---|
| Free | 免费练习、挑战、错误重练与基础统计（不含联机对战/自定义练习卷） |
| 尝鲜体验 | US$1 一次性获得 3 天完整 Supporter 权益；不自动续费，每家庭限一次 |
| Supporter 月付 | US$4.99/月，自动续费，可随时取消 |
| Supporter 年付 | US$49/年（约 US$4.08/月），自动续费，可随时取消 |
| Supporter 永久版 | US$149，一次性购买，不续费 |

一份会员覆盖同一个家庭的最多 **2 位家长 + 2 名子女**；新增家长/子女席位需要有效会员。
以上为当前定价，后续视转化与退款情况再评估。
不使用虚假原价、循环倒计时或面向儿童的购买催促。
月付与年付必须在购买页和 FAQ 中明确自动续费与取消方式。

### 8.2 权益

| 权益 | Free | Supporter |
|---|---|---|
| 核心练习与挑战 | 是 | 是 |
| 基础统计与错题 | 是 | 是 |
| 可公开阅读的数学技巧 | 是 | 是 |
| 多人对战 Live Race（不限次数） | 否 | 是 |
| 自定义 PDF 生成 | 否 | 是 |
| 本地庆祝图片 | 否 | 是 |
| 更丰富的历史分析 | 基础 | 实际上线后提供 |

全站永不投放商业广告，无「去广告」权益项；不得以任何形式暗示付费可以去广告。
不承诺一次购买自动包含未来所有独立产品、课程或服务。

购买页明确：
- 当前权益和账号范围（最多 2 位家长 + 2 名子女，一份会员全家共享）；
- $1 尝鲜：一次性付款，3 天完整权益，不自动续费，每家庭限一次；到期付费功能锁定、不扣费；
- 子女账号由家长创建、可重置密码或删除，不收集儿童邮箱；
- 各方案的计费周期与自动续费规则（月付/年付可随时取消，永久版不续费）；
- 下载限制或合理使用规则；
- 税费和最终结账金额；
- 退款、服务停止和联系方式。

任何方案都不等于服务器永不停止，避免含糊的终身承诺。

### 8.3 支付渠道

**已选定 Waffo Pancake（Merchant of Record）**，当前使用 test 环境接入。
候选曾包括 Stripe、PayPal、经审核适用的 Merchant of Record 平台。

Waffo 作为记录商户处理支付与销售税；我们只保存订单结果，不接触卡号。
Merchant of Record 可能处理部分销售税务事务，但不代表运营者没有其他税务或法律义务。

不通过借用身份或不合规方式绕过平台申请限制。
若尚无可用支付渠道，先上线免费产品，不以个人收款绕过要求。

### 8.4 PaymentProvider 抽象

- `createCheckout(order)`：返回 checkout URL 和平台 ID；
- `verifyWebhook(rawBody, headers)`：验签并解析事件；
- `getPaymentStatus(reference)`：对账查询；
- `refund(reference, amount)`：按实际支持实现。

订单流程：
1. 家长选择 SKU；
2. 服务端读取价格和币种，创建 pending 订单；
3. 创建托管结账，返回 `checkout_url`；
4. 家长跳转支付；
5. 平台 webhook 经验证后，事务内更新订单与权益；
6. 返回页查询本站订单状态；
7. 前端刷新权益。

不因访问 success URL 或客户端报告成功而开通权益。
订单创建使用幂等键，避免双击产生重复结账。

webhook：
- 按平台规范保留原始请求体并验签；
- 核对商户、环境、订单、商品、币种和成功状态；
- 区分商品基础金额、税费、总付款金额与平台净结算金额；
- 去重事件，处理重试与乱序；
- 超时但已收款的订单进入对账流程，不直接丢弃；
- 成功持久化后按平台规范响应；
- 不记录卡号或敏感支付凭据。

退款与拒付状态：
`pending → paid / failed / expired / canceled`；
付款后可能进入 `partially_refunded / refunded / disputed`。

各类状态的权益撤销规则需要单独定义和测试。
定期对账补偿遗漏回调。

---

## 9. PDF 练习卷

### 9.1 参数

`/api/pdf/worksheet?count=20&difficulty=two_by_two&paper=letter&answers=1&locale=en`

- count：允许列表或 5–100 的有界整数；
- difficulty：`times_tables_9`（1–9）、`times_tables_11_19`（11–19）、`two_by_one`（10–99 × 2–9）、`two_by_two`（10–99 × 10–99）或 `custom`；
- 自定义范围（`difficulty=custom`）：`aMin`、`aMax`、`bMin`、`bMax`，均为 1–99 的整数且 min ≤ max；
- paper：letter 或 a4；
- answers：0 或 1；
- locale：en 或 zh。

不允许无限题数、任意字体路径或任意文件路径。

### 9.2 版式

- 英文默认 US Letter，中文默认 A4；
- Name、Date、Score 栏留空，不要求上传儿童姓名；
- 打印友好、低墨量、黑白也清楚；
- 合理留出手写空间；
- 答案页独立，可选择打印；
- 汤圆装饰不影响题目阅读。

使用 pdf-lib；需要字体嵌入时使用兼容的 fontkit 集成。
字体许可需允许嵌入和分发；子集化能力按实际字体与库验证，不假设自动生效。

PDF 服务端鉴权、限流、限制并发和超时。
返回正确 Content-Type、Content-Disposition，个性化响应不进入公共缓存。

可提供少量免费的固定示例 PDF。
“免费样张”与“付费自定义生成”明确区分。

---

## 10. 儿童隐私与安全门禁

### 10.1 隐私原则

面向儿童的定位可能触发 COPPA、GDPR 和目标地区的儿童数据要求。
是否适用、年龄阈值和同意方式需结合实际业务核查。

上线前完成：
- 数据流清单：账号、档案、答案、日志、邮件、支付、备份；
- 收集目的、处理依据、保留期限；
- 供应商和跨境处理安排；
- 适用时的可验证家长同意流程；
- 查阅、导出、撤回和删除机制；
- 家长版及简明隐私说明；
- 安全事件响应与联系渠道。

不认为“不收集手机号”或“只用昵称”就自动符合儿童隐私要求。
在云端儿童数据流程未通过核查前，可只开放游客本地练习。

### 10.2 安全

- HTTPS、必要安全响应头和严格 CSP；
- 尽量自托管字体与静态资源；
- 不将不可信内容传入 innerHTML；
- 预编译 SQL，外键和事务；
- CSRF 防护与来源校验；
- 所有对象级资源验证所有权；
- 登录、重置密码、导入、订单、PDF 分级限流；
- 会话令牌与重置令牌使用密码学安全随机数；
- 密钥只在服务端环境或秘密管理中保存；
- webhook 签名验证失败不更新订单；
- 兑换码一次性、哈希校验、明文用 AES-256-GCM 加密存储（密钥仅在服务端环境），过期与事务防竞争；
- 依赖锁定和安全更新；
- 日志过滤邮箱、Cookie、令牌和详细儿童答题内容；
- 管理权限不暴露在普通前端。

---

## 11. SEO / GEO 与公开内容

### 11.1 目标

让搜索和生成式系统准确理解：
- 产品是什么；
- 适合什么学习基础；
- 哪些功能免费；
- 是否需要登录；
- 教学内容是否可信；
- 如何直接访问和使用。

不保证任何 AI 推荐、排名或引用。

### 11.2 页面

| 页面 | 示例路径 |
|---|---|
| 英文产品首页 | `/en/` |
| 免费乘法游戏介绍 | `/en/multiplication-game/` |
| 两位数乘法练习介绍 | `/en/two-digit-multiplication/` |
| 教程目录（乘法启蒙课，已上线，9 节） | `/en/learn/` |
| 单篇技巧 | `/en/learn/multiply-by-11/` |
| 练习卷说明 | `/en/worksheets/` |
| 家长与老师说明 | `/en/parents-teachers/` |
| FAQ | `/en/faq/` |
| 价格 | `/en/pricing/` |
| About | `/en/about/` |
| 隐私与条款 | `/en/privacy/`、`/en/terms/` |
| 更新日志 | `/en/changelog/` |

页面必须有实质差异，不批量生成内容重复的关键词页面。

### 11.3 技术规范

- 独立 title、description、H1；
- canonical、有效 hreflang 和语言切换；
- sitemap 仅包含应索引的公开页面；
- robots.txt 合理配置，不误屏蔽核心内容；
- 账号、支付返回页和私有数据不索引；
- noindex 不是访问控制，私有数据仍必须鉴权；
- Open Graph 分享图和准确描述；
- WebApplication / SoftwareApplication 结构化数据与实际页面一致；
- 不伪造评分、用户数量或评论；
- Google Search Console、Bing Webmaster Tools 收录检查；
- llms.txt 为可选补充，不替代正常网页。

首发只选少量重要内容页，不以数量为目标。

### 11.4 教学内容模板

1. 学习目标；
2. 技巧适用条件；
3. 分步示例；
4. 常见错误和反例；
5. 少量练习；
6. 对应已实现练习入口；
7. 作者、更新时间和实际审阅信息。

作者和审阅资质仅写真实情况。
中文旧文案中的固定效果承诺删除。

### 11.5 对外传播

- README 统一品牌、网址、截图与功能状态；
- 明确代码和吉祥物素材许可（代码 MIT；名称与吉祥物不随 MIT 授予商标权）；
- 分享真实开发过程与教学设计；
- 联系教育工具目录和相关社区；
- 经许可发布真实家长、老师反馈；
- 不批量制造虚假榜单和测评。

定期记录一组固定问题的搜索和 AI 回答：
- 是否提及品牌；
- 引用网址是否正确；
- 对免费、付费和适用人群的描述是否准确。

单次出现不是稳定排名；优先修复内容误解，而不是追求曝光截图。

---

## 12. 部署、可靠性与成本

### 12.1 部署

- 初期选择靠近首发用户的单一区域后端；
- 静态资源可经 CDN，私有 API 和个性化响应不公共缓存；
- Docker Compose：Node 应用 + Caddy；
- SQLite 使用持久卷；
- 首发单写实例，不把同一 SQLite 文件挂到多个区域写入；
- HTTPS、健康检查、错误监控和支付告警；
- 上线环境与测试环境分离。

中国大陆服务器部署涉及的备案要求另行核查。
不能把“海外用户”“使用 .com”当作免除相关义务的依据，也不把 ICP 写成所有海外部署的固定前置条件。

**实施记录（2026-10-23，Render Starter 容量优化）**：`server/src/index.js` 对 HTML 返回 `public, max-age=0, s-maxage=300, stale-while-revalidate=60`，配合 Cloudflare Cache Rule 把页面访问挡在边缘（规则与清理方式见 README「CDN caching / CDN 缓存」；未配置规则时 HTML 仍每次回源）。公开页面的插图转为 WebP：`confused.png` 885KB→4.7KB、`happy.png` 938KB→8.2KB、`tangyuan_web.png` 345KB→16.3KB（OG/JSON-LD 图片仍保留 PNG）；`tangyuan_small.png` 从 240px 降到 128px。密码哈希由 bcryptjs 换成原生 `bcrypt`（N-API 预编译，async 走 libuv 线程池），注册/登录/重置/子女账号等路由改为异步；令牌消费改为事务内条件更新，子女座位上限在事务内复查，避免异步化带来的并发竞态。

### 12.2 备份

- 使用 SQLite 安全备份接口或 `.backup`；
- 不仅复制正在写入的数据库文件；
- 每日加密备份，默认保留 30 天；
- 异地备份访问权限最小化；
- 定期验证恢复；
- 从备份恢复时重新执行已确认的删除请求，避免数据复活；
- 公布备份中删除数据的最终清理周期。

初期恢复目标：
- 学习数据 RPO：不超过 24 小时；
- 支付权益通过平台对账补偿；
- RTO 目标：24 小时内，需恢复演练验证后才能对外承诺。

**实施记录（2026-10-20）**：`server/src/backup.js` 已实现每日自动加密备份——SQLite 在线备份 API、scrypt + AES-256-GCM、默认保留 30 天、创建后立即解密执行 `integrity_check` / `foreign_key_check`，失败只记日志不影响服务；`server/scripts/backup.js` 提供 `now / list / verify / decrypt / prune` 运维命令，恢复步骤见 README。**仍待完成**：异地副本（默认与数据库同盘）、定期恢复演练、恢复后重放已确认的删除请求。

### 12.3 成本

不沿用固定人民币费率作为海外成本预测。

成本表包含：
- 域名注册与续费；
- 服务器、CDN、备份；
- 邮件发送；
- 支付固定费与比例费；
- 税费、退款及拒付；
- 客服和合规；
- PDF 计算开销。

一次性收费下持续监测每活跃账号的服务成本。
不因“SQLite 简单”而忽略迁移、备份和运维。

---

## 13. 多人实时对战 Live Race（实时竞速）

> 本章源自《二三四阶段设计 v1.1》第四阶段方案（2026-10-15 获批），已按本规范框架对齐。作为增长型功能排在 M1 之后、M2 前后均可（编号 M1.5）。

### 13.0 产品定位与儿童安全红线

- 定位：好友间同题竞速的**家庭会员功能**——与自定义练习卷同属 Supporter；Practice 与 Challenge 仍免费。
- **会员家庭专属、不限次数**：只有持有有效 `live_race` 家庭权益的家长或子女可以创建/加入房间；不设局数上限。
- **只做房间码邀请制**（朋友/同学/家长安排），**不做陌生人随机匹配**、不做排行榜公开展示——儿童产品不创造与陌生人实时交互的可能。
- **零自由文本输入**：房内显示名由系统随机生成（如 Mochi、Pudding、Sesame、Red Bean + 汤圆表情），不使用儿童档案昵称，杜绝人肉搜索与不当内容注入。
- **无任何聊天/语音/表情发送**：玩家间仅传递系统生成的进度事件（答对数、完成状态）。
- 游客可以打开大厅并看到会员门禁，但不能创建/加入房间；对战房间状态**纯内存、不落库**。

### 13.1 玩法设计

**流程**：`#/versus` 对战大厅 → 「Race a Friend」创建房间（房主）/「Join with Code」输入房间单词（水果/动物/数字，≤5 个字母，例如 `MANGO`；或点邀请链接 `/play/?room=MANGO`）→ 等待室（生成头像+名字的玩家列表，房主可选难度与题量）→ 3-2-1 倒计时 → **服务器统一下发同一套题，同时开跑** → 实时看到对手进度 → 结算排名 + Rematch 再来一局。

**参数**：
- 人数：2-4 人（首发 2 人稳定后放开）。
- 难度：复用 2.2 节题型枚举（`times_tables_10` / `two_by_one` / `two_by_two`），房主三选一，默认 `two_by_two`。
- 题量/时长：默认 10 题 90 秒；题量枚举 5/10/20。

**竞赛规则（逐题即时判定制）**：
- 回车即提交判定：答对锁定 ✓ 自动跳下一题；答错抖动 ✗，可跳过稍后再答（保留自由作答顺序，与单机一致）。
- 判定全部在**服务端**完成（见 13.2），客户端不可见答案。
- 胜负：**先全部答对者胜**；时间到则答对多者胜；再平局比最后一题答对的服务器接收时刻。
- 对手进度：对方生成头像 + 进度条 + 答对数实时推送，答对瞬间进度条跳动，营造紧张感。
- 奖励：胜者撒花 + 小红花（仅登录档案计数）；家长中心显示私密战绩（Wins/Losses），**不公开**。

### 13.2 技术方案

**通信**：与主服务同一台 Express 挂 `ws` 库（WebSocket）；房间状态纯内存（`Map<code, room>`），不写 SQLite；进程重启房间即消失（可接受，对局 ≤90 秒）。

**服务端权威（防作弊核心）**：
- 题目由服务器按难度枚举生成，`game_start` 时统一下发题目（不含答案）；
- 起止时间取**服务器时钟**（`deadline = serverNow + duration`），客户端渲染倒计时，标签页隐藏不延长截止（与 7.2 节一致）；
- 客户端每题只上报 `{position, value}`，服务端判定后广播进度——客户端无法偷看答案、无法伪造进度；
- 每玩家答案事件限速（如 ≤4 次/秒），防止脚本刷接口。

**消息协议（JSON，双向）**：

| 方向 | 消息 | 载荷 |
|---|---|---|
| C→S | `create_room` | `{difficulty, count, duration}` |
| C→S | `join_room` | `{code, profileId?}`（游客无 profileId） |
| C→S | `start_game` | 房主_only |
| C→S | `answer` | `{position, value}` |
| C→S | `rematch` / `leave` | — |
| S→C | `room_state` | `{players[{seat, name, avatar, ready}], host, status, settings}` |
| S→C | `countdown` | `{seconds}` |
| S→C | `game_start` | `{problems[{a,b}], deadline, count}` |
| S→C | `judge` | `{position, correct}`（发给作答者本人） |
| S→C | `peer_progress` | `{seat, solved, finished?, finishAt?}`（广播） |
| S→C | `game_over` | `{ranking[{seat, name, solved, usedMs, rank, disconnected}]}` |

**鉴权**：WebSocket 升级握手复用 5.2 节会话 Cookie，可识别家长或子女会话。握手与 create/join/rematch 时检查家庭的 `live_race` 权益；无会话返回 `login_required`，无权益返回 `membership_required`。续连（resumeToken）不重新检查，避免会员到期瞬间打断正在进行的对局。家长直接参赛不绑定档案、不落库；子女会话绑定本人档案，对局结果归属该子女。游客可匿名连接大厅但不能建房/加入；每 IP 并发与建/加入频率仍受限。

**断线处理**：
- 掉线保留房间 30 秒重连窗口（`sessionStorage` 记房间码，刷新/闪断可回归原座位）；
- 对局中掉线**不暂停比赛**，剩余玩家照常进行；掉线者按当前成绩参与排名并标记 `disconnected`；
- 等待室房主离开 → 座位顺位移交房主；全员离开/闲置 10 分钟 → 房间销毁。

### 13.3 数据与统计融合

- 对局落库仅限登录档案：`matches` / `match_players`（见第 6 节表结构）。
- 对局的逐题数据写入 `attempts`（`mode='versus'`，含难度与逐题 `attempt_questions`）——速度统计、错题本自动涵盖对战数据，且按 7.3 节与 Practice/Challenge **分开统计、不混排**。
- 对战中答错（首次错误）同样进错题本（仅登录档案），遵循 2.4 节的首次/最终口径。
- 服务端权威判定天然满足 7.1 节「不接受客户端 correct 作为权威结果」。

### 13.4 前端视图

- `#/versus` 大厅：创建/加入房间卡片、房间码大字展示、复制邀请文案按钮（含链接）。
- 等待室：玩家座席卡（生成头像+名字）、房主设置（难度/题量）、开始按钮。
- 对战视图：复用现有题目卡片网格 + 竞赛皮肤——顶部对手进度条区（桌面左右分栏、移动端顶部横排）；保留键盘 Enter 流与焦点样式（2.5 节无障碍要求同样适用，含 `prefers-reduced-motion` 时关闭进度跳动动画）。
- 结算：🏆 排名卡片（名次/答对数/用时）+ 胜者撒花 + 「Rematch」/「Back to Lobby」。
- 所有界面文字走 `locales/en.json` / `zh.json` 翻译键（4.1 节），无硬编码字符串。

### 13.5 隐私与合规要点（并入 10.1 节数据流清单）

- 房间内存态：只含生成名、座位、进度计数，**无任何个人标识信息**，不写日志详情；
- `peer_progress` 广播不含用户 ID/档案信息，仅座位号；
- 游客对局零持久化；登录档案对局记录纳入 M1 的儿童数据上线门禁与删除/导出流程（`DELETE /api/account` 级联删除 `matches`/`match_players`）；
- 不做对战回放、不做对战数据第三方分析。

### 13.6 子任务拆分（M1.5，依赖 M1 后端骨架）

- [x] ws 服务 + 房间生命周期管理 + 消息协议
- [x] 大厅 + 等待室 UI + 房间码/邀请链接流程 + i18n 文案
- [x] 对战玩法：逐题服务端判定 + 对手进度推送 + 排名结算
- [x] 断线重连 + 对局入库 + 统计/错题融合 + 删除级联
- [ ] 压测与体验调优（同区域 2-4 人延迟、答案事件限速验证）

验收（对齐第 14 节风格）：客户端拿不到答案；伪造 answer 消息无法改变进度；游客全程零落库；断网 30 秒内重连回归原座位；删除账号后对局记录级联清除。

**实施记录（2026-10-17）**：前四项已完成，并有自动化测试覆盖（`tests/live-race.test.js` 19 项、
`tests/race-ws.test.js` 9 项）。服务端模块为 `server/src/live-race.js`（房间引擎，纯内存、不依赖 ws，
可注入假时钟单测）、`server/src/race-ws.js`（`/api/race/ws` 升级握手与消息层）、
`server/src/match-store.js`（对局落库与私密战绩）。前端为 `public/js/race.js` 与 `/play/` 的三个新视图。
压测未做：真实并发连接与延迟表现仍待验证，该项保留待办。

### 13.7 遗留决策点

1. 对战的付费方式——**已定为家庭会员专属**：$1 尝鲜、月付/年付/永久版都包含 `live_race`；不设局数上限。练习与挑战保持免费。
2. 房间码字符集与闲置回收时长——**定为简单常见的水果/动物/数字单词，全大写、3–5 个字母、不超过 5 个字符**（如 `MANGO`、`TIGER`、`THREE`），大小写不敏感；词表约 80 个，随机起点线性扫描避免与在用房间碰撞。闲置 10 分钟回收、掉线座位保留 30 秒。
3. 4 人房首发 or 等 2 人房稳定后放开——**上限 4 人已实现**，开局只需 ≥2 人：能力已就绪，实际人数由用户决定。
4. 平局时的最终规则（当前：比最后一题答对时刻；备选：加赛一题 sudden death）——**按「最后一题更早答对者靠前」实现**，再以座位序兜底保证排名确定性。

---

## 14. 里程碑与验收

> 状态快照（2026-10-22）：M0、M1 的代码与自动化测试部分已完成，剩余事项均为外部核查/运营；
> M1.5 功能完成，待真实多人压测；M2 进行中（PDF、entitlements、每日加密备份已上线；Waffo Pancake 已切换生产环境，$1/3 天尝鲜与客户门户已上线；§6 redeem_codes 与管理后台（TM_ADMIN_EMAILS + /admin/，会员查询/手动授予/优惠码）已实现；受控真实交易/退款验收待完成）；
> M3 进行中（Math Tips 与 Blog 栏目已上线；乘法启蒙课 /en/learn/ 9 节已于 2026-10-23 上线，中文镜像待补）。

### M0：免费海外试玩

- [ ] 品牌和域名核查
- [x] 英文完整界面
- [x] Practice 无计时和难度选择
- [x] 保留 Challenge
- [x] 手机、平板、键盘与减少动画支持
- [x] 公开首页、FAQ、About、隐私说明
- [x] 游客本地存储及清除
- [x] 全站无任何广告脚本与占位广告（永久策略，见 0.3）
- [ ] 一小批目标家庭试用

验收：不注册可完成练习；宣传与上线功能一致；错误、计时和空题处理正确。

### M1：家长账号与云端学习数据

- [x] Express + SQLite 迁移
- [x] 邮箱验证、登录、重置与会话撤销
- [x] 儿童档案及资源归属校验
- [x] 首次/最终答案和活动时间
- [x] 错题重练
- [x] 游客导入幂等
- [x] 时区统计
- [x] 导出与删除
- [ ] 儿童数据上线门禁完成（合规/运营事项，见第 10 节）

验收：跨账号不能读取档案；重试不重复计数；删除与恢复流程已测试。

### M1.5：多人实时对战 Live Race（增长功能，详见第 13 节）

- [x] ws 服务、房间生命周期与消息协议（13.6）
- [x] 大厅 / 等待室 / 对战视图与 i18n 文案
- [x] 逐题服务端判定、对手进度推送、排名结算
- [x] 断线重连、对局入库与删除级联
- [x] 交卷流程：整卷一次性提交、服务端逐题判定、交卷后棋盘逐题 ✓/✗
- [x] 答案事件限速验证（单测覆盖 4 次/秒阈值）
- [x] 家庭会员门禁：游客/无会员返回 `login_required`/`membership_required`；子女会话绑定档案，家长直赛不落库
- [ ] 2–4 人同区域真实压测

验收：客户端拿不到答案；伪造 answer 消息无法改变进度；游客与无会员家长无法建房/加入且零落库；
子女对局落库、家长直赛不落库；断网 30 秒内重连回归原座位；
交卷后成绩与逐题标记一致；全员交卷或超时均能正确结算；删除账号后对局记录级联清除。

### M1.6：家庭会员、子女登录与共同家长

- [x] 家庭 / 家庭成员模型（2 位家长 + 2 名子女）
- [x] 新注册不赠送会员（2026-10-21 取消 3 个月免费试用，改用 $1/3 天尝鲜）
- [x] 子女用户名 + 密码登录（与家长共用会话 Cookie，路由按身份隔离）
- [x] 共同家长邮箱邀请、令牌校验与空家庭合并
- [x] 家长中心：会员状态、家庭席位、子女账号、密码重置
- [x] 权益改为家庭维度（联机对战 + 自定义练习卷）
- [ ] 真实家长试用与家庭邀请送达率验证

验收：跨家庭不能读取子女数据；一份会员覆盖 2 位家长和 2 名子女；会员/体验到期后联机对战与 PDF 锁定、
免费练习与数据保留；邀请重复/过期/邮箱不符均被拒；原家庭有子女或付费权益时不能被合并。

### M2：真实支付与 Supporter

- [x] 支付主体和渠道确认（Waffo Pancake，Merchant of Record；2026-10-21 已切换生产环境）
- [x] 服务端 SKU 与托管结账（`checkout.authenticated.create()`，前端只拿 `checkoutUrl`）
- [x] $1/3 天尝鲜 SKU（一次性、不续费、每家庭一次；迁移 7 扩展 `orders.sku`）
- [ ] 验签、重试、乱序与对账（验签、事件去重、终态后禁止复活已完成；平台对账与补偿任务待做）
- [x] USD 金额和税费映射（金额以 USD 最小单位入库；销售税由 Waffo 作为 MoR 计算）
- [x] PDF Letter / A4 与答案页（2026-10-19：entitlements 权益门禁 + pdf-lib 生成已上线并通过测试）
- [ ] 本地图片设置
- [x] 退款和权益撤销（家长中心可打开 Waffo 客户门户提交退款申请；`refund.succeeded` 只撤销该订单来源；拒付/dispute 状态处理待补）
- [x] 清晰价格与售后说明
- [ ] 上线前完成受控真实交易与退款测试

**实施记录（2026-10-20）**：Waffo Pancake 托管结账已接入。迁移 6 新增 `orders` / `payment_events`；`server/src/waffo.js` 封装 SDK 与商品配置，`server/src/order-store.js` 负责订单与 webhook 事件，`server/src/payment-routes.js` 提供 `/api/orders`、取消续费与 `/api/payments/waffo/webhook`。webhook 使用原始 body 验签，按 `(provider, event_id)` 去重，并核对店铺、环境、币种、SKU 与金额后才写入权益；success URL 不授予权益。家长中心显示订阅状态、支持取消续费，并可通过 `/api/orders/portal` 打开 Waffo 客户门户（取消订阅、更新支付方式、查看账单、提交退款申请）；门户链接用 `auth.createCustomerPortalLink` 每次点击即时签发，带 bearer token，响应 `Cache-Control: no-store`。`tests/waffo.test.js` 覆盖 16 项（含 $1/3 天尝鲜的开通、到期与每家庭一次守卫）。商品与 webhook 通过 `server/scripts/waffo-setup.js` 一次性配置。新注册不再自动发放免费会员；历史上已发放的 `promo` 权益仍按原到期时间有效。

验收：success URL 不能伪造权益；重复回调不重复开通；非会员不能生成付费 PDF；图片不产生上传请求。

### M3：内容与增长

- [x] 高质量英文教程（2026-10-23：乘法启蒙课 9 节上线 `/en/learn/`；另有 Math Tips 页 6 个技巧与 Blog 文章）
- [x] Math Tips 与 Blog 公开页（中英双语，含导航入口）
- [x] sitemap 与 hreflang
- [ ] 结构化数据（JSON-LD：WebApplication / SoftwareApplication）
- [ ] 搜索收录检查
- [x] 中英文 README
- [x] 许可说明（LICENSE，MIT）
- [ ] 真实社区推广及使用反馈
- [ ] 价格与权益验证
- [ ] 根据使用需求决定是否扩展多档案

---

## 15. 测试清单与效果评估

必测：
- 题目生成边界和答案；
- 首次错误、修改正确、空题、超时；
- 隐藏标签页的计时；
- 档案所有权；
- CSRF、会话撤销和令牌过期；
- 重复导入、重复重练上报；
- webhook 无效签名、乱序、重复、延迟；
- 金额、币种和环境不匹配；
- 退款和赠送权益并存；
- PDF 大请求及越权；
- 图片格式与尺寸；
- 对战（Live Race）：答案不下发客户端；伪造 answer 消息无效；断线 30 秒重连回归座位；
  游客/无会员无法建房或加入；子女对局落库、家长直赛不落库；
- 删除、备份恢复与对账；
- 备份加密、错误密钥/篡改拒绝、保留期与解密后完整性校验；
- 核心浏览器、移动端和键盘操作。

产品指标：
- 开始到完成练习的比例；
- 自愿返回练习的情况；
- 按难度分组的首次正确率；
- 提示使用和错题重练情况；
- 家长购买、PDF 使用及退款原因；
- 服务成本和错误率；
- 搜索带来的有效访问；
- AI 对产品描述的准确性。

优先使用最小化、聚合的第一方统计。
不为了营销指标加入不必要的儿童追踪、指纹识别或会话录屏。

---

## 16. 发布原则

1. 游戏先可用，宣传后跟上。
2. 免费核心练习保持完整。
3. 理解与熟练度优先，速度挑战可选。
4. 付费由家长操作，权益清楚且真实。
5. 默认少收集数据、少加载第三方脚本。
6. “本地图片”“一次性购买”“免费”等措辞有明确边界。
7. GEO 以可读取、准确、有用的内容为基础，不承诺 AI 推荐。
8. 隐私、支付和运营门禁未通过时，先发布免费游客版本。

---

## 17. 遗留决策点（实施时再定）

1. 支付渠道已选 Waffo Pancake（MoR，test 环境）；生产发布、真实交易与退款演练待完成（见 M2）。
2. 定价验证：月付 US$4.99 / 年付 US$49 / 永久版 US$149，视转化与退款情况再评估。
3. 对战为家庭会员专属、不限次数；房间码字符集与回收时长、4 人房开放时机、平局加赛规则见 13.7。
4. 家庭席位上限定为 2 位家长 + 2 名子女；是否需要更多席位、或按席位单独售卖，待真实使用后再评估。
5. 对战排期确认：M1.5 建议排在 M1 后、M2 前后均可，视增长需求调整。
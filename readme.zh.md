# 汤圆的乘法大冒险 🍡

> 一款面向小朋友和大朋友的「两位数乘法速算」限时闯关小游戏，红白可爱主题，吉祥物汤圆全程陪伴。
>
> [English](README.md)

![吉祥物汤圆](public/img/tangyuan_web.png)

## 项目简介

「汤圆的乘法大冒险」是一款纯前端的数学口算练习游戏，以 10 关挑战（含第 0 关热身）限时闯关的方式，帮助孩子从个位数乘法逐步练到两位数 × 两位数。整体采用红白可爱风，吉祥物汤圆会在答题过程中给出口头鼓励与陪伴，让枯燥的速算练习变得轻松有趣。

### 当前玩法（第一阶段，已完成）

- **10 关闯关（含第 0 关热身）**：每关 10 道题，由浅入深。
- **限时挑战**：每关统一 120 秒，保持稳定节奏。
- **即时批改**：提交后逐题批改，答错的题保留可改，全对才算过关。
- **汤圆陪伴**：答题、答错、超时、通关，汤圆都会给出鼓励与反馈。
- **通关庆祝**：结算弹窗 + 撒花效果，通关更有成就感。

## 快速开始

### 方式一：完整站点（推荐）

`public/` 目录是完整的多语言站点，用任意静态服务器启动即可：

```bash
cd public
python -m http.server 8000   # 或 npx serve .
# 打开 http://127.0.0.1:8000
```

- 首页：`/`（默认英文界面，可直接阅读）· 英文站 `/en/` · 中文站 `/zh/`
- 游戏应用：`/play/`（练习 / 挑战 / 错题重练，中英双语随时切换）

### 方式二：独立单文件版

双击打开 [multiplication_game.html](multiplication_game.html)（第一阶段成果，保留可独立游玩）。

> 推荐使用 Chrome / Edge / Safari 等现代浏览器。

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 前端 | 原生 HTML / CSS / JavaScript | 零依赖、无构建工具、零第三方请求 |
| 后端 | Express + SQLite（better-sqlite3）+ `ws` | 版本化迁移；对战房间只在内存，仅登录档案的结果落库 |
| 支付 | `@waffo/pancake-ts`（Waffo Pancake） | 托管结账 + RSA-SHA256 webhook 验签；权益只由验签通过的 webhook 写入 |
| 主题 | 红白可爱风 + 吉祥物汤圆 | CSS 变量统一配色 |
| 字体 | 系统字体栈 | 不加载外部字体，数学数字用可读系统字体 |
| 测试 | node:test | 核心逻辑单元测试 + 完整的 HTTP 与 WebSocket 集成测试 |

## 项目结构

```
tobemathmaster/
├── public/                    # 静态站点（同源托管）
│   ├── index.html             # 默认英文首页（x-default，右上角可切中文）
│   ├── en/ · zh/              # 英文/中文公开页（首页、FAQ、关于、隐私）
│   ├── play/                  # 游戏应用（练习/挑战/错题重练）
│   ├── account/               # 家长中心（登录/家庭会员/共同家长邀请/子女账号/云数据）
│   ├── js/ css/ locales/ img/ # 模块、样式、双语语言包、素材
│   └── robots.txt · sitemap.xml
├── server/                    # Express + SQLite 后端（M1）
│   ├── src/                   # 认证/档案/记录/统计/错题/账号数据/安全中间件
│   └── data/                  # SQLite 数据文件（gitignore）
├── tests/                     # node:test（18 单元 + 16 服务端集成）
├── docs/DESIGN.md             # 设计文档（v3.0 合并版，唯一设计文档）
├── multiplication_game.html   # 第一阶段成果：可独立游玩的单文件版
└── README.md · readme.zh.md
```

### 本地运行（M1 起需服务器）

```bash
cd server
npm install
npm start          # 默认 3000，可用 PORT=3100 覆盖；静态站与 API 同源
# 打开 http://127.0.0.1:3000（邮箱验证/重置链接打印在服务器控制台）
npm test           # 131 项测试：题目生成、记录、错题本、家庭会员/邀请/子女登录、加密备份、Waffo 支付/订单/webhook/$1 尝鲜，以及完整 HTTP/WebSocket API（含 Google 登录与邮件通道）
```

### 邮件发送

由 `TM_MAIL_TRANSPORT` 选择通道：

| 取值 | 行为 |
|---|---|
| `console`（默认） | 验证/重置链接打印到服务端日志。本地开发够用；收件人不会收到邮件。 |
| `cloudflare` | 通过 [Cloudflare Email Service](https://developers.cloudflare.com/email-service/) 的 REST API 发送（走 HTTPS，不是 SMTP）。需要 `TM_CF_ACCOUNT_ID`、`TM_CF_API_TOKEN`（令牌需「Email Sending: Edit」权限）和 `TM_MAIL_FROM`。 |

使用 Cloudflare 通道前，需先在 Cloudflare 控制台 **Compute → Email Service → Email Sending** 完成发信域接入，且该域名必须托管在 Cloudflare DNS。向任意收件人发信需要 Workers Paid 套餐（含每月 3,000 封，超出 $0.35/千封）。

本项目没有 dotenv 之类的自动加载器——`server/src/config.js` 只读 `process.env`——因此本地要测真实发信，需用 `node --env-file=../.env.development src/index.js` 启动，并在该文件里把 `TM_MAIL_TRANSPORT` 改成 `cloudflare` 并填入两个 Cloudflare 值。

邮件发送失败不会影响接口：即使服务商故障或配置有误，注册与找回密码仍返回正常响应，失败会以 `[mailer:cloudflare]` 记入日志。

### 支付（Waffo Pancake）

支持者会员通过 **Waffo Pancake** 的托管结账（Merchant of Record）售卖。服务端用 SDK 的 `checkout.authenticated.create()` 创建会话，浏览器只拿到 `checkoutUrl`。**权益只由验签通过的 webhook 写入**——打开 success URL 本身不会开通任何权益。

新注册**不再赠送免费会员**。尝鲜入口是 `supporter_trial7` 一次性商品：**$1 体验 3 天**，不自动续费，每家庭限一次；到期后付费功能锁定，除非订阅。

旧数据库里可能还留有已下线的 3 个月上线赠送。确认后可撤销（先 dry run）：

```bash
cd server
npm run revoke-launch-promo
npm run revoke-launch-promo -- --yes
```

| 环境变量 | 说明 |
|---|---|
| `WAFFO_PRIVATE_KEY` | API 私钥（PEM、字面量 `\n`，或改用 `WAFFO_PRIVATE_KEY_BASE64`） |
| `WAFFO_MERCHANT_ID` / `WAFFO_STORE_ID` | 商户与店铺 ID（默认值即当前店铺） |
| `WAFFO_ENVIRONMENT` | `test`（默认）或 `prod` |
| `WAFFO_PRODUCT_TRIAL7` / `..._MONTHLY` / `..._YEARLY` / `..._LIFETIME` | 配置脚本打印的四个商品 ID（TRIAL7 是 $1/3 天一次性商品） |
| `WAFFO_WEBHOOK_PUBLIC_KEY` | 可选覆盖；SDK 内置 Waffo 公钥 |

一次性配置：

```bash
cd server
export WAFFO_PRIVATE_KEY="$(cat private.pem)"      # 不要提交到仓库
npm run waffo:products       # 创建缺失商品并打印四个商品 ID
# 把 WAFFO_PRODUCT_* 写入服务端环境变量并重启

# 本地联调 webhook（ngrok 会保留 x-waffo-signature，localtunnel 会丢掉）
ngrok http 3000
npm run waffo:webhook -- https://<ngrok-host>/api/payments/waffo/webhook

npm run waffo:list           # 查看店铺商品
npm run waffo:publish        # 把测试环境商品发布到生产（上线时）
```

上线切换：

1. **发布商品**到生产：在 Waffo 控制台点 Publish，或用当前（测试环境）Key 执行 `npm run waffo:publish`。
2. 生产环境设 `WAFFO_ENVIRONMENT=prod`，并把 `WAFFO_PRIVATE_KEY` / `WAFFO_PRIVATE_KEY_BASE64` 换成**生产 API Key**（测试与生产 Key 不同）。
3. 用生产 Key 执行 `npm run waffo:list`，确认四个 `WAFFO_PRODUCT_*` 商品 ID（通常与测试相同，但以生产 Key 查到的为准）。
4. 用生产 Key 注册生产 webhook：`WAFFO_ENVIRONMENT=prod node scripts/waffo-setup.js webhook https://tangyuanmath.com/api/payments/waffo/webhook`。脚本会以 `testMode: false` 登记；测试与生产是两套独立 webhook。
5. 做一笔受控真实交易并退款，检查 Waffo 的 webhook 投递日志和服务端 `[waffo-webhook]` 日志。
6. 如果测试订单写进了生产数据库，上线前撤销这些订单的 `source_type='order'` 权益。

价格定义在 `server/src/waffo.js` 的 `SKUS` 中。改价时务必同步修改 Waffo 控制台里对应商品的售价并发布新版本；否则收银台仍按旧价扣款，永久版还可能因金额校验被拒绝开通。

商品税务分类默认：订阅用 `saas`，永久版用 `digital_goods`；如税务顾问有不同要求，请在 Waffo 控制台调整。

测试卡（任意未来有效期/CVC）：成功 `4576 7500 0000 0110`，拒付 `4576 7500 0000 0220`。webhook 事件带 `mode: "test" | "prod"`，服务端会忽略另一环境的事件。`payment_events` 按 `(provider, event_id)` 去重；事件通过 `metadata.orderNo` / `orderMerchantExternalId` 找回订单，并核对店铺、环境、币种与 SKU 后才改动权益。

订阅开通/续费会把同一订单来源的权益延长到 `currentPeriodEnd`；`subscription.canceling` 保留访问权，`subscription.canceled` 与 `refund.succeeded` 只撤销该订单来源。家长中心的“取消续费”会调用 `orders.cancelSubscription()`。

**管理订阅与退款。** 家长中心还有一个按钮打开 Waffo 客户门户（`auth.createCustomerPortalLink`）。链接每次点击即时签发、几分钟后过期，不缓存、不写日志。门户里可以取消订阅、更新支付方式、查看账单和提交退款申请；退款申请在 Waffo 控制台审核，`refund.succeeded` 到达后只撤销该订单来源的权益。

排查支付问题：

```bash
cd server
npm run waffo:doctor                     # 只检查配置，不打印私钥
node --env-file=../.env.production scripts/waffo-doctor.js --api   # 额外调用 Waffo 验证
```

- `503 payments_not_configured` → `WAFFO_PRIVATE_KEY` 或某个 `WAFFO_PRODUCT_*` 缺失（注意变量名必须完全一致）。
- 付款成功但会员没开通 → `WAFFO_ENVIRONMENT` 必须为 `prod`；检查 Waffo webhook 投递日志（401 表示用了错误环境的公钥）和服务端 `[waffo-webhook]` 日志。
- `waffo:doctor --api` 还会提示 Waffo 商品价格与 `SKUS` 不一致。

### 数据库备份

服务每天自动生成一份**加密备份**，保留 **30 天**；每份新备份创建后会立即解密并执行 SQLite `integrity_check` 与 `foreign_key_check`。备份使用 SQLite 在线备份 API（不是直接复制正在写入的 `.db` 文件），因此服务运行中也能得到一致的快照。失败只以 `[backup]` 记日志，不影响服务。

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `TM_BACKUP_DIR` | `<数据库目录>/backups` | 加密备份写入目录（Render 上是 `/data/backups`） |
| `TM_BACKUP_KEY` | 自动生成密钥文件 | AES-256-GCM 口令（用 scrypt 派生密钥） |
| `TM_BACKUP_RETENTION_DAYS` | `30` | 每份备份保留天数 |
| `TM_BACKUP_INTERVAL_HOURS` | `24` | 两次自动备份的最小间隔 |
| `TM_BACKUP_DISABLED` | 未设置 | 设为 `1` 可关闭自动备份 |

未设置 `TM_BACKUP_KEY` 时，首次运行会生成 `<备份目录>/backup.key`。这样开箱即用，但密钥与数据在同一块盘上——**请另行妥善保存该密钥**；生产环境建议直接在服务端环境变量里设置 `TM_BACKUP_KEY`。

```bash
cd server
npm run backup                    # 立即备份
npm run backup:list               # 列出备份（UTC 时间与大小）
npm run backup:verify             # 解密并校验最新一份
node scripts/backup.js verify tangyuan-20261020T031500Z.db.enc
node scripts/backup.js decrypt tangyuan-20261020T031500Z.db.enc /tmp/restore.db
npm run backup:prune              # 立即按保留期清理
```

恢复步骤：

1. 停止 Web 服务，确保没有进程写数据库。
2. 保留当前文件：`cp app.db app.db.before-restore`。
3. 解密选定的备份（见上方命令）。
4. 用解密出的文件替换 `app.db`，并删除同目录下的 `app.db-wal` / `app.db-shm`。
5. 启动服务，未执行的迁移会自动补齐。

备份默认与数据库在**同一块持久盘**上，能防误删、损坏和错误迁移，但防不了整块盘丢失。灾难恢复需要把备份复制到异地，并把加密密钥分开保存。备份可能仍包含之后被删除的数据，等该备份过期后才会彻底清除；恢复旧备份后，请重新执行备份时间点之后收到的删除请求。

## 路线图

里程碑详见 [docs/DESIGN.md](docs/DESIGN.md)（v3.0 合并版：海外优先、家长账号、永不投放广告）。

- **M0 ✅ 免费海外试玩**：英文完整界面 + 中文版、不限时练习（自选范围与题量）、10 关挑战（含第 0 关热身）、错题重练、首次/最终答案口径、逐题活动计时、无障碍支持、公开页（首页/FAQ/关于/隐私）、游客本地数据可清除、零广告零第三方脚本。
- **M1 ✅ 家长账号与云端学习数据**：Express + SQLite（版本化迁移）、邮箱注册/验证/登录/重置/会话撤销（CSRF + 限流 + 严格 CSP）、儿童档案与归属校验、服务端权威判分与幂等上报（首次/最终口径 + 逐题活动时间）、云端错题重练、游客数据幂等导入、按账号时区的打卡统计、导出与删号级联。
- **M1.5 ✅ 多人实时对战 Live Race**：房间码邀请制、2–4 人同题竞速，走 WebSocket。判定全在服务端（客户端拿不到答案），显示名由系统生成、无聊天无自由文本，掉线 30 秒内可回归原座位，只有登录子女档案的对局结果会落库。联机对战现在属于家庭支持者会员；练习与挑战仍然免费。尚未做并发压测。
- **M1.6 ✅ 家庭会员与子女登录**：一份支持者会员最多覆盖 2 位家长和 2 名子女。家长用邮箱/密码或 Google 登录；子女使用家长创建的用户名和密码登录。另一位家长通过邮件邀请加入。新注册不再赠送会员；付费从 $1 体验 3 天或月付/年付/永久版开始。
- **M2 ⏳ 真实支付与 Supporter**：托管结账（待接入）、可打印 PDF 练习卷（已上线——免费样卷人人可下，支持者可自定义生成，Letter/A4 与可选答案页）、自定义本地庆祝图片。
- **M3 ⏳ 内容与增长**：英文教程、SEO/GEO、社区推广。

## 许可

本仓库的代码与内容采用 [MIT 许可证](LICENSE) 发布。

你可以自由使用、修改、分发和销售本项目，只需在所有副本或实质性部分中保留版权声明和许可声明。软件按“原样”提供，不附带任何担保。

Tangyuan Math / 汤圆数学 名称与汤圆吉祥物属于项目品牌；MIT 许可不授予商标权，修改后的分发版本不应冒充官方产品。

## 贡献

欢迎提交 Issue 与 Pull Request，一起把汤圆养得更可爱～ 🍡

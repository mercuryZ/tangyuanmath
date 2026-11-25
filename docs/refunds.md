# 退款处理手册（站长）

面向站长自己：用户申请退款时按这份文档操作。面向用户的条款在
[`/en/refund/`](/en/refund/) 与 [`/zh/refund/`](/zh/refund/)（源文件
`public/en/refund/index.html`、`public/zh/refund/index.html`）。

## 0. 一句话概览

**退款的钱只能在 Waffo 商户后台退**（Pancake SDK 没有发起退款的 API）；
**权益由本站自动收回**——Waffo 的 `refund.succeeded` webhook 一到，订单变
`refunded` 并撤销该订单来源的权益。管理端「标记已退款」只用于 webhook 丢失时的对账兜底。

## 1. 用户从哪进来

| 入口 | 说明 |
|---|---|
| 家长中心 →「管理订阅与退款」 | `POST /api/orders/portal` 即时签发 Waffo 客户门户链接（bearer token，10 分钟有效），用户在门户里提交退款申请工单、取消订阅、改支付方式、看账单 |
| 邮件 `hi@tangyuanmath.com` | 用户直接来邮件时，按第 2 步在 Waffo 后台发起退款 |

退款政策承诺：**14 天无理由**（每笔付款，含试用/月订/年订/终身）+ **功能与描述不符随时退**。
承诺审核 1–2 个工作日；退款到账 5–10 个工作日（由支付方式决定）。

## 2. 在 Waffo 后台发起或审批退款

1. 登录 <https://dashboard.waffo.com>，切到对应环境（生产 `prod` / 测试 `test`）。
2. 找到该订单（可用用户邮箱、订单号 `TM-YYYYMMDD-…`、或
   `orderMerchantExternalId`＝本站订单号搜索）。
3. 处理退款申请工单，或在订单上直接发起退款（支持全额/部分退款）。
4. 退款成功后 Waffo 会回调 `refund.succeeded` 到
   `https://tangyuanmath.com/api/payments/waffo/webhook`。

> **部分退款也会全额撤销该订单的权益**——这是 `server/src/order-store.js`
> 现有逻辑（`refund.succeeded` 一律 `revokeOrderEntitlements`），有测试锁定。
> 需要「退一点钱但保留权限」时不要用部分退款，改用客服补偿流程（见第 5 节）。

## 3. webhook 自动做了什么

`server/src/order-store.js` → `applyEvent`：

- 实退金额 < 订单金额 → `orders.status = 'partially_refunded'`，否则 `'refunded'`；
- `revokeOrderEntitlements`：撤销 `source_type='order' AND source_id=<订单号>` 的权益行
  （`entitlements.revoked_at` 打时间戳）；
- 只影响这一个订单来源：兑换码（`redeem`）、赠送/补偿（`grant`）、活动（`promo`）的权益不受影响；
- 退款后到达的延迟支付/续费事件不会再开通权益（`markPaid` 与 `applyEvent` 的终止态守卫）；
- `payment_events` 表按 `event_id` 去重，平台重发不会重复处理。

`server/src/payment-routes.js` 的 webhook 处理器在**首次**处理 `refund.succeeded` 后，
向**下单人邮箱**（缺失时退回家庭 owner）发一封双语「退款已处理」邮件
（模板 `mailer.sendRefundEmail`）。重复事件不会重复发信。

## 4. 兜底：webhook 丢了怎么办

症状：Waffo 后台显示已退款，但本站订单还是 `paid`、功能还能用。

1. **先在 Waffo 后台确认这笔钱确实退了**（不要凭用户说法操作）。
2. 打开 `/admin/` → 搜索家长邮箱 → 会员详情 → Orders，找到该订单，
   点该行的 **Mark refunded**（中文界面「标记已退款」）。
3. 该操作在一个事务里把订单置为 `refunded` 并撤销该订单权益，同时补发确认邮件。
   只有 `paid` / `canceling` / `past_due` 状态的订单能标记，重复点会返回 `not_refundable`。
4. 顺手检查一下 webhook 是否配置正确（`server/scripts/waffo-doctor.js`，在 `server/` 下
   `node scripts/waffo-doctor.js`），避免下一单继续丢。

如果只想收回权益、不动订单状态（例如退款还在 Waffo 审核中），用会员详情里对应
权益行的 **Revoke** 按钮即可（`POST /api/admin/revoke`）。

## 5. 补偿与重授权

用户情况特殊（例如部分退款但要保留会员、或客服善意补偿）：

- **单个家庭**：`/admin/` 的「Manual grant」按邮箱发放，或在 `server/` 目录下运行
  `node src/grant-supporter.js <email> --months N`（`--revoke` 撤销所有 `grant` 来源）；
- 补偿发放用 `grant` 来源，和订单来源相互独立，之后即使订单再退也不受影响。

## 6. 当前不支持 / 注意事项

- **无法从本站 API 直接退款**：Pancake SDK v0.26.0 的 `OrdersResource` 只有
  `cancelSubscription`；文档里的 `/api/v1/order/refund` 是 Waffo 商户后台/直连收单 API，
  SDK 未封装。别在代码里手撸签名去调——先升级 SDK 或继续用后台。
- **拒付（dispute/chargeback）事件目前被忽略**：`dispute.*` 不在
  `HANDLED_EVENTS` 里，`orders.status='disputed'` 只是预留。收到银行拒付先邮件联系用户；
  若确实需要收回权益，用第 4 节的 Revoke / Mark refunded。
- **订阅取消 vs 退款**：用户只想停止续费时引导「Cancel renewal」或客户门户取消，
  不要退款——取消保留当期权益到期末，退款会立刻收回。
- 试用（`supporter_trial7`）退款后 `already_trial` 守卫仍生效，同一家庭不能再买 $1 试用。

## 7. 条款速查

| 场景 | 结论 |
|---|---|
| 付款 14 天内，任何理由 | 全额退 |
| 订阅续费 14 天内 | 该笔续费全额退 |
| 功能与描述不符 | 任何时候核实后都退 |
| 订阅只想停扣费 | 取消续费，不退当期 |
| 反复买退 | 可拒绝后续无理由退款，真实故障仍退 |

用户文档：`public/en/refund/index.html`、`public/zh/refund/index.html`
（改条款时同步改这两个文件 + `public/{en,zh}/terms/index.html` 的退款条目 +
`public/{en,zh}/pricing/index.html` 的 FAQ）。

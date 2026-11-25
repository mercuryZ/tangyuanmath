/* 退款通知（webhook 与管理端「标记退款」共用）
 * - 收件人：优先下单人，缺失时退回家庭 owner；
 * - 发送是 fire-and-forget：mailer.sendMail 内部兜错，绝不影响调用方（webhook 必须返回 200）；
 * - 找不到收件人只记日志，不抛出。
 */
'use strict';

const mailer = require('./mailer');
const waffo = require('./waffo');

function refundRecipient(db, order) {
  if (order && order.purchased_by) {
    const buyer = db.prepare('SELECT email_normalized AS email FROM users WHERE id = ?').get(order.purchased_by);
    if (buyer && buyer.email) return buyer.email;
  }
  if (order && order.family_id) {
    const owner = db.prepare(
      "SELECT email_normalized AS email FROM users WHERE family_id = ? AND family_role = 'owner' ORDER BY id LIMIT 1"
    ).get(order.family_id);
    if (owner && owner.email) return owner.email;
  }
  return null;
}

/* displayAmount 是已格式化的展示金额（如 "$4.99"）；不传时按订单标价格式化。 */
function sendRefundConfirmation(db, order, displayAmount) {
  if (!order) return;
  const email = refundRecipient(db, order);
  if (!email) {
    console.warn('[refund] email skipped: no recipient for order ' + order.order_no);
    return;
  }
  const spec = waffo.SKUS[order.sku];
  mailer.sendRefundEmail(email, {
    orderNo: order.order_no,
    plan: spec ? spec.name : order.sku,
    amount: displayAmount || ('$' + waffo.minorToDisplay(order.amount_minor))
  }).catch(() => {}); // sendMail 已保证不抛；再兜一道防未预期 rejection
}

module.exports = { refundRecipient, sendRefundConfirmation };

/* Tangyuan Math — 定价页托管结账（Waffo Pancake）
 * 流程：点击方案 → 检查家长身份 → POST /api/orders → 新标签页打开 Waffo 托管结账
 *      → 本页轮询订单状态，付款确认后提示会员已开通。
 * 密钥、金额与商品 ID 都只在服务端；前端拿不到也不该拿到任何支付凭据。
 */
(function () {
  'use strict';

  var ZH = (document.documentElement.lang || 'en').toLowerCase().indexOf('zh') === 0;
  var STR = ZH ? {
    starting: '正在创建安全支付页面…',
    opening: '支付页面已在新标签页打开，请在那里完成付款。',
    popup: '支付页面未能自动打开，请点击这里继续：',
    success: '付款成功，会员已开通。感谢支持！',
    pending: '已收到付款，正在等待支付平台确认…',
    error: '创建支付页面失败，请稍后重试。',
    unavailable: '在线支付暂不可用，请发邮件至 hi@tangyuanmath.com，我们会为你开通。',
    already: '这个家庭已经有有效订阅。请先在家长中心取消，再购买新的方案。',
    lifetime: '这个家庭已经拥有永久会员。',
    trial: '尝鲜价每个家庭只能使用一次。',
    member: '这个家庭已有有效会员，无需再买尝鲜。',
    child: '子女账号不能购买会员，请让家长登录后操作。',
    unverified: '请先在家长中心验证邮箱，然后再购买。',
    signin: '正在跳转到家长登录…',
    close: '知道了'
  } : {
    starting: 'Starting secure checkout…',
    opening: 'Checkout opened in a new tab. Complete the payment there.',
    popup: 'The checkout tab could not open automatically. Continue here:',
    success: 'Payment received — your membership is active. Thank you!',
    pending: 'Payment received. Waiting for the payment provider to confirm…',
    error: 'Could not start checkout. Please try again.',
    unavailable: 'Online checkout is not available yet. Email hi@tangyuanmath.com and we will enable it for your family.',
    already: 'This family already has an active subscription. Cancel it in the Parent Center before starting a new one.',
    lifetime: 'This family already has lifetime access.',
    trial: 'The $1 intro price can be used once per family.',
    member: 'This family already has an active membership — no trial needed.',
    child: 'Child accounts cannot buy a membership. Please ask a parent to sign in.',
    unverified: 'Please verify your email in the Parent Center before paying.',
    signin: 'Redirecting to parent sign-in…',
    close: 'Dismiss'
  };

  var msgEl = null;

  function ensureMessage() {
    if (msgEl && document.body.contains(msgEl)) return msgEl;
    msgEl = document.createElement('p');
    msgEl.className = 'checkout-msg';
    msgEl.setAttribute('role', 'status');
    msgEl.setAttribute('aria-live', 'polite');
    msgEl.hidden = true;
    var anchor = document.querySelector('.plans-fine') || document.querySelector('.plans') || document.querySelector('main');
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(msgEl, anchor.nextSibling);
    else document.body.appendChild(msgEl);
    return msgEl;
  }

  function showMessage(text, link) {
    var el = ensureMessage();
    el.textContent = '';
    el.appendChild(document.createTextNode(text));
    if (link) {
      el.appendChild(document.createTextNode(' '));
      var a = document.createElement('a');
      a.href = link.href;
      a.textContent = link.text;
      if (link.external) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
      el.appendChild(a);
    }
    el.hidden = false;
  }

  function hideMessage() {
    if (msgEl) msgEl.hidden = true;
  }

  async function jsonFetch(method, path, body, csrfToken) {
    var headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (csrfToken) headers['x-csrf-token'] = csrfToken;
    var res;
    try {
      res = await fetch(path, {
        method: method,
        headers: headers,
        credentials: 'same-origin',
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (e) {
      return { ok: false, code: 'network_error' };
    }
    var json = null;
    try { json = await res.json(); } catch (e) { /* 非 JSON */ }
    return json || { ok: false, code: 'bad_response', status: res.status };
  }

  async function csrfToken() {
    var r = await jsonFetch('GET', '/api/csrf');
    return r && r.ok && r.data ? r.data.csrfToken : null;
  }

  function loginRedirect(sku) {
    var next = location.pathname + '?buy=' + encodeURIComponent(sku);
    try { sessionStorage.setItem('tm_checkout_redirected', sku); } catch (e) { /* 忽略 */ }
    location.href = '/account/?mode=login&next=' + encodeURIComponent(next);
  }

  function clearRedirectFlag() {
    try { sessionStorage.removeItem('tm_checkout_redirected'); } catch (e) { /* 忽略 */ }
  }

  async function startCheckout(sku, btn, isAuto) {
    hideMessage();
    if (btn && btn.getAttribute('aria-busy') === 'true') return;
    if (btn) btn.setAttribute('aria-busy', 'true');
    showMessage(STR.starting);

    try {
      var me = await jsonFetch('GET', '/api/me');
      var data = me && me.ok ? me.data : null;
      if (!data || (!data.user && !data.child)) {
        var redirected = null;
        try { redirected = sessionStorage.getItem('tm_checkout_redirected'); } catch (e) { /* 忽略 */ }
        // 自动续购（?buy=）只跳转一次，避免登录失败时无限重定向；手动点击始终跳转。
        if (isAuto && redirected === sku) {
          showMessage(STR.signin, { href: '/account/?mode=login&next=' + encodeURIComponent(location.pathname + '?buy=' + sku), text: ZH ? '家长登录' : 'Parent sign-in' });
        } else {
          loginRedirect(sku);
        }
        return;
      }
      if (data.child) { showMessage(STR.child); return; }
      if (!data.user.emailVerified) {
        showMessage(STR.unverified, { href: '/account/', text: ZH ? '前往家长中心' : 'Open Parent Center' });
        return;
      }

      var token = await csrfToken();
      if (!token) { showMessage(STR.error); return; }

      var r = await jsonFetch('POST', '/api/orders', { sku: sku }, token);
      if (!r.ok) {
        if (r.code === 'payments_not_configured') {
          showMessage(STR.unavailable, { href: 'mailto:hi@tangyuanmath.com?subject=Supporter%20Edition', text: 'hi@tangyuanmath.com' });
        } else if (r.code === 'already_subscribed') {
          showMessage(STR.already, { href: '/account/', text: ZH ? '前往家长中心' : 'Open Parent Center' });
        } else if (r.code === 'already_lifetime') {
          showMessage(STR.lifetime, { href: '/account/', text: ZH ? '前往家长中心' : 'Open Parent Center' });
        } else if (r.code === 'already_trial') {
          showMessage(STR.trial);
        } else if (r.code === 'already_member') {
          showMessage(STR.member, { href: '/account/', text: ZH ? '前往家长中心' : 'Open Parent Center' });
        } else if (r.code === 'email_unverified') {
          showMessage(STR.unverified, { href: '/account/', text: ZH ? '前往家长中心' : 'Open Parent Center' });
        } else {
          showMessage(STR.error);
        }
        return;
      }

      clearRedirectFlag();
      var order = r.data;
      window.open(order.checkoutUrl, '_blank', 'noopener,noreferrer');
      // 带 noopener 时部分浏览器返回 null，无法据此判断是否被拦截；
      // 因此始终同时给出可点击的支付链接作为兜底。
      showMessage(STR.opening, { href: order.checkoutUrl, text: ZH ? '打开支付页面' : 'Open checkout', external: true });
      watchOrder(order.orderNo);
    } finally {
      if (btn) btn.removeAttribute('aria-busy');
    }
  }

  /* 不访问 success URL 开通权益：只轮询服务端订单状态（webhook 写入）。 */
  function watchOrder(orderNo) {
    var started = Date.now();
    var timer = setInterval(async function () {
      if (Date.now() - started > 10 * 60 * 1000) { clearInterval(timer); return; }
      var r = await jsonFetch('GET', '/api/orders/' + encodeURIComponent(orderNo));
      if (r.ok && r.data && ['paid', 'canceling', 'past_due'].indexOf(r.data.status) !== -1) {
        clearInterval(timer);
        showMessage(STR.success, { href: '/account/', text: ZH ? '查看会员状态' : 'View membership' });
      }
    }, 4000);
  }

  document.addEventListener('DOMContentLoaded', function () {
    var buttons = Array.prototype.slice.call(document.querySelectorAll('[data-checkout-sku]'));
    buttons.forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        startCheckout(btn.getAttribute('data-checkout-sku'), btn);
      });
    });

    var params = new URLSearchParams(location.search);
    var buy = params.get('buy');
    if (!buy) return;
    var target = buttons.filter(function (b) { return b.getAttribute('data-checkout-sku') === buy; })[0];
    if (!target) return;
    startCheckout(buy, target, true).then(function () {
      // 购买意图只消费一次，避免刷新页面重复创建订单
      try {
        var url = new URL(location.href);
        url.searchParams.delete('buy');
        history.replaceState(null, '', url.pathname + (url.search ? url.search : ''));
      } catch (e) { /* 忽略 */ }
    });
  });
}());

/* Tangyuan Math — 练习卷页交互（/en|zh/worksheets/）
 * - 先查 /api/me：未登录 → 引导去家长中心；无权益 → Supporter 介绍；有权益 → 启用表单；
 * - 下载走 fetch→blob：服务端报错（403/429/503）能行内提示，而不是把 JSON 错误当文件存下来。
 */
(function () {
  'use strict';

  const lang = document.documentElement.lang === 'zh' ? 'zh' : 'en';
  const T = {
    en: {
      network: 'Could not reach the server — please try again.',
      fallback: 'Download failed — please try again.',
      downloading: 'Generating…',
      signIn: 'Custom worksheets need a parent account. <a href="/account/">Sign in or create a free account</a> in the Parent Center first — the free samples above work for everyone.',
      upsell: '<b>Supporter Edition · US$4.99, one-time</b><br>Custom worksheet generation is a supporter feature. Online checkout is coming soon — until it lands we are inviting early-supporter families directly. Write to <a href="mailto:hi@tangyuanmath.com">hi@tangyuanmath.com</a> if you would like in.',
      errors: {
        not_logged_in: 'Please sign in first.',
        supporter_required: 'Custom worksheets are a supporter feature.',
        rate_limited: 'Too many downloads in a short time — please wait a few minutes.',
        pdf_busy: 'The worksheet service is busy right now, please try again in a moment.'
      }
    },
    zh: {
      network: '无法连接服务器，请稍后再试。',
      fallback: '下载失败，请重试。',
      downloading: '正在生成…',
      signIn: '自定义练习卷需要家长账号。请先到<a href="/account/">家长中心</a>登录或免费注册——上面的免费样卷无需账号。',
      upsell: '<b>支持者版 · US$4.99，一次性买断</b><br>自定义生成是支持者功能。在线购买即将上线，此前我们直接邀请早期支持家庭加入，想参加可以写信到 <a href="mailto:hi@tangyuanmath.com">hi@tangyuanmath.com</a>。',
      errors: {
        not_logged_in: '请先登录。',
        supporter_required: '自定义练习卷是支持者功能。',
        rate_limited: '短时间内下载次数过多，请几分钟后再试。',
        pdf_busy: '练习卷服务正忙，请稍候再试。'
      }
    }
  }[lang];

  const gate = document.getElementById('wsGate');
  const form = document.getElementById('wsForm');
  const errBox = document.getElementById('wsError');
  const btn = document.getElementById('wsDownload');
  if (!gate || !form) return;

  function showGate(html) {
    gate.innerHTML = html;
    gate.hidden = false;
    form.hidden = true;
  }

  fetch('/api/me', { credentials: 'same-origin' })
    .then(r => r.json())
    .then(r => {
      const user = r.ok && r.data && r.data.user;
      if (!user) return showGate(T.signIn);
      const ents = (r.data.entitlements || []);
      if (ents.indexOf('pdf_worksheet') === -1) return showGate(T.upsell);
      gate.hidden = true;
      form.hidden = false;
    })
    .catch(() => showGate(T.network));

  function showError(msg) {
    errBox.textContent = msg;
    errBox.hidden = false;
  }

  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  form.addEventListener('submit', ev => {
    ev.preventDefault();
    errBox.hidden = true;
    const qs = 'difficulty=' + form.wsDifficulty.value +
      '&count=' + form.wsCount.value +
      '&paper=' + form.wsPaper.value +
      '&answers=' + (form.wsAnswers.checked ? 1 : 0) +
      '&locale=' + lang;
    const oldLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = T.downloading;
    fetch('/api/pdf/worksheet?' + qs, { credentials: 'same-origin' })
      .then(res => {
        if (res.ok) {
          const m = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '');
          return res.blob().then(b => saveBlob(b, m ? m[1] : 'tangyuan-worksheet.pdf'));
        }
        return res.json().catch(() => null).then(j => {
          throw new Error(j && j.code ? j.code : 'fallback');
        });
      })
      .catch(e => showError(T.errors[e && e.message] || T.fallback))
      .finally(() => { btn.disabled = false; btn.textContent = oldLabel; });
  });
})(globalThis);

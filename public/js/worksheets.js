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
      customRange: 'Enter a whole number from 1 to 99 for each box, with the smaller number first.',
      signIn: 'Custom worksheets are part of a family Supporter membership. <a href="/account/">Sign in or create a free parent account</a> — you can try Supporter for 3 days for $1. The free samples above work for everyone.',
      childSignIn: 'Custom worksheets are a parent tool. Ask a parent to sign in on this device.',
      upsell: '<b>Supporter family membership · from US$4.99/month</b><br>Custom worksheets and Live Race are included in one family membership covering up to 2 parents and 2 children. Try it for 3 days for $1. <a href="/en/pricing/">See membership →</a>',
      errors: {
        not_logged_in: 'Please sign in first.',
        parent_only: 'Custom worksheets are a parent tool.',
        supporter_required: 'Custom worksheets are a supporter feature.',
        invalid_range: 'Enter a whole number from 1 to 99 for each box, with the smaller number first.',
        rate_limited: 'Too many downloads in a short time — please wait a few minutes.',
        pdf_busy: 'The worksheet service is busy right now, please try again in a moment.'
      }
    },
    zh: {
      network: '无法连接服务器，请稍后再试。',
      fallback: '下载失败，请重试。',
      downloading: '正在生成…',
      customRange: '请在每个框中填写 1–99 的整数，并确保较小的数在前。',
      signIn: '自定义练习卷属于家庭支持者会员。请先到<a href="/account/">家长中心</a>登录或免费注册——可以 $1 体验 3 天。上面的免费样卷无需账号。',
      childSignIn: '自定义练习卷是家长工具。请让家长在这台设备上登录。',
      upsell: '<b>家庭支持者会员 · US$4.99/月起</b><br>自定义练习卷与联机对战包含在同一份家庭会员里，最多覆盖 2 位家长和 2 名子女。可以 $1 体验 3 天。<a href="/zh/pricing/">查看会员方案 →</a>',
      errors: {
        not_logged_in: '请先登录。',
        parent_only: '自定义练习卷是家长工具。',
        supporter_required: '自定义练习卷是支持者功能。',
        invalid_range: '请在每个框中填写 1–99 的整数，并确保较小的数在前。',
        rate_limited: '短时间内下载次数过多，请几分钟后再试。',
        pdf_busy: '练习卷服务正忙，请稍候再试。'
      }
    }
  }[lang];

  const gate = document.getElementById('wsGate');
  const form = document.getElementById('wsForm');
  const errBox = document.getElementById('wsError');
  const btn = document.getElementById('wsDownload');
  const customBox = document.getElementById('wsCustom');
  const customInputs = ['wsAMin', 'wsAMax', 'wsBMin', 'wsBMax']
    .map(id => document.getElementById(id))
    .filter(Boolean);
  if (!gate || !form) return;

  /* 自定义范围：选中 custom 时才显示四个输入框 */
  function updateCustomVisibility() {
    if (customBox) customBox.hidden = form.wsDifficulty.value !== 'custom';
  }
  if (form.wsDifficulty) {
    form.wsDifficulty.addEventListener('change', updateCustomVisibility);
    updateCustomVisibility();
  }

  function readCustomRange() {
    if (customInputs.length !== 4) return null;
    const [aMin, aMax, bMin, bMax] = customInputs.map(el => Number(el.value));
    const valid = n => Number.isInteger(n) && n >= 1 && n <= 99;
    if (![aMin, aMax, bMin, bMax].every(valid) || aMin > aMax || bMin > bMax) return null;
    return { aMin, aMax, bMin, bMax };
  }

  function showGate(html) {
    gate.innerHTML = html;
    gate.hidden = false;
    form.hidden = true;
  }

  fetch('/api/me', { credentials: 'same-origin' })
    .then(r => r.json())
    .then(r => {
      const user = r.ok && r.data && r.data.user;
      if (r.ok && r.data && r.data.child) return showGate(T.childSignIn);
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
    const custom = form.wsDifficulty.value === 'custom' ? readCustomRange() : null;
    if (form.wsDifficulty.value === 'custom' && !custom) {
      showError(T.customRange);
      return;
    }
    const qs = 'difficulty=' + form.wsDifficulty.value +
      '&count=' + form.wsCount.value +
      '&paper=' + form.wsPaper.value +
      '&answers=' + (form.wsAnswers.checked ? 1 : 0) +
      '&locale=' + lang +
      (custom ? `&aMin=${custom.aMin}&aMax=${custom.aMax}&bMin=${custom.bMin}&bMax=${custom.bMax}` : '');
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

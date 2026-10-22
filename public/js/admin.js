/* Tangyuan Math — 管理后台（/admin/，仅 TM_ADMIN_EMAILS 中的家长可见）
 * 会员查询 / 详情（权益+订单）/ 手动授予与撤销 / 优惠码生成与管理。
 * 全部走 TMAPI（同源 Cookie + CSRF）；明文优惠码只在生成响应里出现一次。
 */
(function (global) {
  'use strict';

  const t = global.TMI18N.t;
  const applyI18n = global.TMI18N.applyI18n;

  function $(id) { return document.getElementById(id); }
  function toast(msg, isErr) {
    var el = $('toast');
    el.textContent = msg;
    el.className = 'toast' + (isErr ? ' err' : '');
    el.hidden = false;
    clearTimeout(el._timer);
    el._timer = setTimeout(function () { el.hidden = true; }, 3200);
  }
  function fmtDate(ts) {
    if (ts === null || ts === undefined) return t('admin.never');
    try {
      return new Intl.DateTimeFormat(global.TMI18N.lang() === 'zh' ? 'zh-CN' : 'en', { dateStyle: 'medium' }).format(new Date(ts));
    } catch (e) { return String(ts); }
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  const FEATURE_LABELS = {
    pdf_worksheet: 'admin.fPdf',
    live_race: 'admin.fRace',
    celebration_image: 'admin.fImg'
  };
  const SKU_LABELS = {
    supporter_trial7: 'admin.skuTrial',
    supporter_monthly: 'admin.skuMonthly',
    supporter_yearly: 'admin.skuYearly',
    supporter_lifetime: 'admin.skuLifetime'
  };

  /* ---------- 门禁 ---------- */
  function showView(name) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    var el = $('view-' + name);
    if (el) el.classList.add('active');
  }

  async function init() {
    const st = await global.TMAPI.refresh();
    if (!st.user) {
      location.href = '/account/?mode=login&next=' + encodeURIComponent('/admin/');
      return;
    }
    if (!st.user.isAdmin) {
      $('gateMsg').textContent = t('admin.noAccess');
      return;
    }
    showView('admin');
    bindForms();
    loadMembers(); // 进页即列出最近注册的家庭（浏览全部用户）
    loadCodes();
  }

  /* ---------- 会员查询（分页：每页 10 个家庭；留空 = 浏览全部） ---------- */
  var MEMBER_PAGE_SIZE = 10;
  var lastMemberQuery = '';
  var memberPage = 1;
  async function loadMembers(q, page) {
    lastMemberQuery = q || ''; // 详情页“返回列表”要用同一查询条件重建列表
    memberPage = page || 1;
    $('memberMsg').textContent = '';
    $('memberDetail').hidden = true;
    $('memberResults').innerHTML = '';
    $('memberPager').hidden = false;
    $('memberPager').innerHTML = '';
    const qs = '?page=' + memberPage + '&pageSize=' + MEMBER_PAGE_SIZE +
      (q ? '&q=' + encodeURIComponent(q) : '');
    const r = await global.TMAPI.call('GET', '/api/admin/members' + qs);
    if (!r.ok) { $('memberMsg').textContent = t('admin.errorPrefix', { code: r.code }); return; }
    if (!r.data.families.length) { $('memberMsg').textContent = t('admin.noResults'); return; }
    $('memberMsg').textContent = t('admin.totals', {
      families: r.data.totalFamilies, parents: r.data.totalParents
    }) + (q ? ' · ' + t('admin.matchedCount', { count: r.data.matchedFamilies }) : '');
    for (const f of r.data.families) {
      const row = document.createElement('div');
      row.className = 's-row';
      const m = f.membership;
      row.innerHTML =
        '<span>' + f.parents.map(p => esc(p.email)).join(', ') +
        ' <span class="badge-ok' + (m.active ? '' : ' off') + '">' +
        (m.active ? (m.expiresAt === null ? t('admin.mLifetime') : t('admin.mUntil', { date: fmtDate(m.expiresAt) })) : t('admin.mNone')) +
        '</span></span>' +
        '<button class="s-btn" type="button">' + esc(t('admin.detail')) + '</button>';
      row.querySelector('button').addEventListener('click', () => showMember(f.familyId));
      $('memberResults').appendChild(row);
    }
    renderPager(r.data);
  }

  /* 页码条：上一页/下一页 + 页码（当前页左右各 2 页，首尾页保留） */
  function renderPager(d) {
    const pager = $('memberPager');
    pager.innerHTML = '';
    if (d.totalPages <= 1) return;
    const mkBtn = (label, target, disabled, current) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 's-btn pg-btn';
      b.textContent = label;
      if (disabled) b.disabled = true;
      if (current) b.classList.add('pg-cur');
      if (!disabled && !current) b.addEventListener('click', () => loadMembers(lastMemberQuery, target));
      return b;
    };
    pager.appendChild(mkBtn(t('admin.prevPage'), memberPage - 1, memberPage <= 1, false));
    const pages = [];
    for (let i = 1; i <= d.totalPages; i++) {
      if (i === 1 || i === d.totalPages || Math.abs(i - memberPage) <= 2) pages.push(i);
      else if (pages[pages.length - 1] !== '…') pages.push('…');
    }
    for (const p of pages) {
      if (p === '…') {
        const s = document.createElement('span');
        s.className = 'pg-ellipsis';
        s.textContent = '…';
        pager.appendChild(s);
      } else {
        pager.appendChild(mkBtn(String(p), p, false, p === memberPage));
      }
    }
    pager.appendChild(mkBtn(t('admin.nextPage'), memberPage + 1, memberPage >= d.totalPages, false));
    const info = document.createElement('span');
    info.className = 'pg-info';
    info.textContent = t('admin.pageInfo', { page: memberPage, pages: d.totalPages });
    pager.appendChild(info);
  }

  async function searchMembers(ev) {
    ev.preventDefault();
    const q = $('memberQuery').value.trim();
    if (q && q.length < 2) { $('memberMsg').textContent = t('admin.queryTooShort'); return; }
    await loadMembers(q, 1);
  }

  async function showMember(familyId) {
    $('memberResults').innerHTML = '';
    $('memberPager').hidden = true;
    const r = await global.TMAPI.call('GET', '/api/admin/members/' + familyId);
    if (!r.ok) { $('memberMsg').textContent = t('admin.errorPrefix', { code: r.code }); return; }
    const d = r.data;
    const parts = [];

    parts.push('<h3>' + esc(t('admin.detailParents')) + '</h3>');
    for (const p of d.family.parents) {
      parts.push('<div class="s-row"><span>' + esc(p.email) + '</span><small>' +
        (p.role === 'owner' ? t('admin.roleOwner') : t('admin.roleCoparent')) + '</small></div>');
    }

    parts.push('<h3>' + esc(t('admin.detailChildren')) + '</h3>');
    if (!d.family.children.length) parts.push('<p class="hint">' + esc(t('admin.none')) + '</p>');
    for (const c of d.family.children) {
      parts.push('<div class="s-row"><span>' + esc(c.nickname) + (c.username ? ' (@' + esc(c.username) + ')' : '') + '</span></div>');
    }

    parts.push('<h3>' + esc(t('admin.detailEntitlements')) + '</h3>');
    if (!d.entitlements.length) parts.push('<p class="hint">' + esc(t('admin.none')) + '</p>');
    for (const e of d.entitlements) {
      const label = t(FEATURE_LABELS[e.featureKey] || e.featureKey);
      const until = e.expiresAt === null ? t('admin.mLifetime') : fmtDate(e.expiresAt);
      parts.push('<div class="s-row" data-source="' + esc(e.sourceType) + '" data-sid="' + esc(e.sourceId || '') + '">' +
        '<span>' + esc(label) + ' <small>' + esc(e.sourceType) + (e.sourceId ? ' · ' + esc(e.sourceId) : '') + '</small></span>' +
        '<span><small>' + esc(until) + '</small> <button class="s-btn danger">' + esc(t('admin.revoke')) + '</button></span></div>');
    }

    parts.push('<h3>' + esc(t('admin.detailOrders')) + '</h3>');
    if (!d.orders.length) parts.push('<p class="hint">' + esc(t('admin.noOrders')) + '</p>');
    for (const o of d.orders) {
      parts.push('<div class="s-row"><span>' + esc(t(SKU_LABELS[o.sku] || o.sku)) +
        ' <small>' + esc(o.orderNo) + ' · ' + esc(o.mode) + '</small></span>' +
        '<small>' + esc(o.status) + ' · $' + (o.amountMinor / 100).toFixed(2) + ' · ' + fmtDate(o.createdAt) + '</small></div>');
    }

    $('detailBody').innerHTML = parts.join('');
    $('detailBody').querySelectorAll('button.danger').forEach(btn => {
      btn.addEventListener('click', async () => {
        const rowEl = btn.closest('.s-row');
        if (!global.confirm(t('admin.revokeConfirm'))) return;
        const body = { familyId: familyId, sourceType: rowEl.dataset.source };
        if (rowEl.dataset.sid) body.sourceId = rowEl.dataset.sid;
        const r2 = await global.TMAPI.call('POST', '/api/admin/revoke', body);
        if (r2.ok) { toast(t('admin.revokedOk')); showMember(familyId); }
        else toast(t('admin.errorPrefix', { code: r2.code }), true);
      });
    });
    $('memberDetail').hidden = false;
  }

  /* ---------- 手动授予 ---------- */
  async function submitGrant(ev) {
    ev.preventDefault();
    $('grantMsg').textContent = '';
    const email = $('grantEmail').value.trim();
    if (!email) return;
    const r = await global.TMAPI.call('POST', '/api/admin/grant', { email, sku: $('grantSku').value });
    if (r.ok) {
      $('grantMsg').textContent = t('admin.grantedOk', {
        email: email, until: r.data.expiresAt === null ? t('admin.mLifetime') : fmtDate(r.data.expiresAt)
      });
      toast(t('admin.grantedOk', { email: email, until: r.data.expiresAt === null ? t('admin.mLifetime') : fmtDate(r.data.expiresAt) }));
    } else {
      $('grantMsg').textContent = t('admin.errorPrefix', { code: r.code });
    }
  }

  /* ---------- 优惠码 ---------- */
  async function submitCodes(ev) {
    ev.preventDefault();
    $('codeMsg').textContent = '';
    const body = {
      sku: $('codeSku').value,
      count: Number($('codeCount').value) || 1,
      note: $('codeNote').value.trim()
    };
    const days = Number($('codeExpires').value);
    if (days > 0) body.expiresInDays = days;
    const r = await global.TMAPI.call('POST', '/api/admin/codes', body);
    if (!r.ok) { $('codeMsg').textContent = t('admin.errorPrefix', { code: r.code }); return; }
    $('codeOutput').value = r.data.codes.join('\n');
    $('codeResults').hidden = false;
    loadCodes();
  }

  async function copyCodes() {
    try {
      await navigator.clipboard.writeText($('codeOutput').value);
      toast(t('admin.copied'));
    } catch (e) {
      $('codeOutput').select();
      global.document.execCommand && global.document.execCommand('copy');
      toast(t('admin.copied'));
    }
  }

  async function loadCodes() {
    const r = await global.TMAPI.call('GET', '/api/admin/codes?limit=100');
    if (!r.ok) { $('codesListMsg').textContent = t('admin.errorPrefix', { code: r.code }); return; }
    const list = $('codesList');
    list.innerHTML = '';
    if (!r.data.codes.length) { $('codesListMsg').textContent = t('admin.listEmpty'); return; }
    $('codesListMsg').textContent = '';
    const now = Date.now();
    for (const c of r.data.codes) {
      const used = !!c.usedAt;
      const expired = !used && c.expiresAt !== null && c.expiresAt <= now;
      const badge = used
        ? '<span class="badge-ok off">' + esc(t('admin.statusUsed')) + (c.usedByEmail ? ' · ' + esc(c.usedByEmail) : '') + '</span>'
        : expired
          ? '<span class="badge-ok off">' + esc(t('admin.statusExpired')) + '</span>'
          : '<span class="badge-ok">' + esc(t('admin.statusUnused')) + (c.expiresAt ? ' · ' + esc(t('admin.expiresOn', { date: fmtDate(c.expiresAt) })) : '') + '</span>';
      const row = document.createElement('div');
      row.className = 's-row';
      row.innerHTML =
        '<span>' + esc(t(SKU_LABELS[c.sku] || c.sku)) +
        ' <small>#' + esc(c.hashPrefix) + (c.note ? ' · ' + esc(c.note) : '') + '</small></span>' +
        '<span>' + badge + (used || expired ? '' : ' <button class="s-btn danger">' + esc(t('admin.disable')) + '</button>') + '</span>';
      const btn = row.querySelector('button');
      if (btn) btn.addEventListener('click', async () => {
        if (!global.confirm(t('admin.disableConfirm'))) return;
        const r2 = await global.TMAPI.call('POST', '/api/admin/codes/' + c.id + '/revoke');
        if (r2.ok) { toast(t('admin.disabledOk')); loadCodes(); }
        else toast(t('admin.errorPrefix', { code: r2.code }), true);
      });
      list.appendChild(row);
    }
  }

  /* ---------- 初始化 ---------- */
  function bindForms() {
    $('memberSearchForm').addEventListener('submit', searchMembers);
    $('detailBack').addEventListener('click', () => {
      $('memberDetail').hidden = true;
      loadMembers(lastMemberQuery, memberPage); // showMember 清空了列表，返回时按原条件与页码重建
    });
    $('grantForm').addEventListener('submit', submitGrant);
    $('codeForm').addEventListener('submit', submitCodes);
    $('copyCodesBtn').addEventListener('click', copyCodes);
  }

  document.addEventListener('DOMContentLoaded', async () => {
    $('langEn').addEventListener('click', () => { global.TMI18N.setLang('en'); applyI18n(document); });
    $('langZh').addEventListener('click', () => { global.TMI18N.setLang('zh'); applyI18n(document); });
    var saved = null;
    try { saved = global.localStorage.getItem('tm_lang'); } catch (e) { /* 忽略 */ }
    global.TMI18N.setLang(saved === 'zh' || saved === 'en' ? saved : undefined, false);
    applyI18n(document);
    await init();
  });
})(globalThis);

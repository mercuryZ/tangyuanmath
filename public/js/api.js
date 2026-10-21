/* Tangyuan Math — 前端 API 层（M1 / 家庭会员）
 * - 同源 fetch（Cookie 会话）+ CSRF 双提交头；
 * - 家长与子女共用 tm_session：state.user 或 state.child 二选一；
 * - 离线重试队列按「身份+档案」隔离（DESIGN 4.3），登出后停止该账号的上报；
 * - 本地记录 → 服务端载荷适配：只发原始答案，正确性由服务端计算（7.1）。
 */
(function (global) {
  'use strict';

  const state = {
    user: null,
    child: null,
    profiles: [],
    family: null,
    membership: null,
    entitlements: [],
    currentProfileId: null,
    csrfToken: null
  };

  function isPlayer() { return !!(state.user || state.child); }
  function identityKey() {
    if (state.user) return 'u' + state.user.id;
    if (state.child) return 'c' + state.child.id;
    return '0';
  }

  function queueKey() {
    return `tm_upload_queue_${identityKey()}_p${state.currentProfileId}`;
  }

  async function ensureCsrf() {
    if (state.csrfToken) return state.csrfToken;
    const r = await call('GET', '/api/csrf', undefined, true);
    state.csrfToken = r.data && r.data.csrfToken;
    return state.csrfToken;
  }

  /* 底层请求：统一 {ok,data}|{ok:false,code} */
  async function call(method, path, body, skipCsrf) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (!skipCsrf && method !== 'GET') {
      await ensureCsrf();
      if (state.csrfToken) headers['x-csrf-token'] = state.csrfToken;
    }
    let res;
    try {
      res = await fetch(path, {
        method, headers,
        credentials: 'same-origin',
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (e) {
      return { ok: false, code: 'network_error', msg: String(e && e.message || e) };
    }
    let json = null;
    try { json = await res.json(); } catch (e) { /* 非 JSON */ }
    if (res.status === 401) { state.user = null; state.child = null; } // 会话失效
    if (!json) return { ok: false, code: 'bad_response', msg: 'HTTP ' + res.status };
    return json;
  }

  /* ---------- 会话与档案 ---------- */
  async function refresh() {
    const r = await call('GET', '/api/me');
    const d = r.ok && r.data ? r.data : {};
    state.user = d.user || null;
    state.child = d.child || null;
    state.profiles = d.profiles || [];
    state.family = d.family || null;
    state.membership = d.membership || null;
    state.entitlements = d.entitlements || [];

    if (state.child) {
      state.currentProfileId = state.child.id;
      flushQueue();
    } else if (state.user) {
      const saved = Number(localStorage.getItem(activeProfileKey()));
      state.currentProfileId = state.profiles.some(p => p.id === saved) ? saved
        : (state.profiles.length ? state.profiles[0].id : null);
      localStorage.setItem(activeProfileKey(), String(state.currentProfileId || ''));
      flushQueue(); // 登录态恢复后尝试清空队列
    } else {
      state.currentProfileId = null;
    }
    return state;
  }

  function activeProfileKey() { return `tm_active_profile_${identityKey()}`; }
  function selectProfile(id) {
    if (!state.profiles.some(p => p.id === id)) return false;
    state.currentProfileId = id;
    localStorage.setItem(activeProfileKey(), String(id));
    flushQueue();
    return true;
  }

  async function login(email, password) {
    const r = await call('POST', '/api/auth/login', { email, password }, true);
    if (r.ok) { state.csrfToken = null; await refresh(); }
    return r;
  }
  async function childLogin(username, password) {
    const r = await call('POST', '/api/auth/child-login', { username, password }, true);
    if (r.ok) { state.csrfToken = null; await refresh(); }
    return r;
  }
  async function register(email, password, locale, timezone) {
    return call('POST', '/api/auth/register', { email, password, locale, timezone }, true);
  }
  async function verifyEmail(token) { return call('POST', '/api/auth/verify-email', { token }, true); }
  async function forgotPassword(email) { return call('POST', '/api/auth/forgot-password', { email }, true); }
  async function resetPassword(token, password) { return call('POST', '/api/auth/reset-password', { token, password }, true); }
  function clearIdentity() {
    state.user = null; state.child = null; state.profiles = [];
    state.family = null; state.membership = null;
    state.currentProfileId = null; state.csrfToken = null;
    state.entitlements = [];
  }
  async function logout() {
    const r = await call('POST', '/api/auth/logout');
    clearIdentity();
    return r;
  }
  async function logoutAll() {
    const r = await call('POST', '/api/auth/logout-all');
    clearIdentity();
    return r;
  }

  /* ---------- 子女账号 ---------- */
  async function createProfile(nickname, avatarKey, username, password) {
    const body = { nickname, avatarKey };
    if (username) body.username = username;
    if (password) body.password = password;
    const r = await call('POST', '/api/profiles', body);
    if (r.ok) await refresh();
    return r;
  }
  async function updateProfile(id, patch) {
    const r = await call('PATCH', `/api/profiles/${id}`, patch);
    if (r.ok) await refresh();
    return r;
  }
  async function setChildCredentials(id, username, password) {
    return call('PUT', `/api/profiles/${id}/credentials`, { username, password });
  }
  async function deleteProfile(id) {
    const r = await call('DELETE', `/api/profiles/${id}`);
    if (r.ok) await refresh();
    return r;
  }
  async function childPassword(currentPassword, newPassword) {
    return call('POST', '/api/auth/child-password', { currentPassword, newPassword });
  }
  async function updateMe(patch) { return call('PATCH', '/api/me', patch); }

  /* ---------- 家庭与邀请 ---------- */
  async function getFamily() { return call('GET', '/api/family'); }
  async function inviteParent(email) { return call('POST', '/api/family/invite', { email }); }
  async function acceptInvite(token) {
    const body = token ? { token } : {};
    const r = await call('POST', '/api/family/invite/accept', body);
    if (r.ok) await refresh();
    return r;
  }
  async function revokeInvite(id) { return call('DELETE', `/api/family/invite/${id}`); }

  function membershipActive() {
    return !!(state.membership && state.membership.active);
  }
  function hasFeature(key) { return state.entitlements.indexOf(key) !== -1; }

  /* ---------- 离线上报队列（按身份+档案隔离） ---------- */
  function loadQueue() {
    try { return JSON.parse(localStorage.getItem(queueKey()) || '[]'); } catch (e) { return []; }
  }
  function saveQueue(q) {
    try { localStorage.setItem(queueKey(), JSON.stringify(q.slice(-100))); } catch (e) { /* 满：丢最旧 */ }
  }
  function enqueue(payload) {
    if (!isPlayer() || !state.currentProfileId) return false;
    const q = loadQueue();
    if (!q.some(x => x.clientEventId === payload.clientEventId)) q.push(payload);
    saveQueue(q);
    return true;
  }
  let flushing = false;
  async function flushQueue() {
    if (!isPlayer() || !state.currentProfileId || flushing) return;
    flushing = true;
    try {
      let q = loadQueue();
      while (q.length) {
        const item = q[0];
        const r = await call('POST', `/api/profiles/${state.currentProfileId}/records`, item);
        if (!r.ok && r.code !== 'duplicate') break; // 网络失败：留待下次
        q = q.slice(1);
        saveQueue(q);
      }
    } finally { flushing = false; }
  }

  /* 本地记录 → 服务端载荷（不发正确性声明，服务端判分） */
  function toPayload(rec) {
    return {
      clientEventId: String(rec.id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || ('r' + rec.createdAt),
      mode: rec.mode,
      difficulty: rec.difficulty,
      level: (rec.level === undefined || rec.level === null) ? undefined : rec.level,
      usedTimeS: rec.usedTimeS || undefined,
      createdAt: rec.createdAt,
      perQuestion: rec.perQuestion.map(q => ({
        a: q.a, b: q.b,
        firstAnswer: q.first_answer === undefined ? null : q.first_answer,
        finalAnswer: q.final_answer === undefined ? null : q.final_answer,
        activeMs: q.active_ms == null ? null : q.active_ms
      }))
    };
  }

  /* 游戏结束钩子：登录则入队并尝试上传 */
  function onRecord(localRecord) {
    if (!isPlayer() || !state.currentProfileId) return;
    enqueue(toPayload(localRecord));
    flushQueue();
  }

  /* 游客记录批量导入（家长在家长中心主动触发，DESIGN 4.3） */
  async function importLocalRecords(localRecords) {
    if (!isPlayer() || !state.currentProfileId) return { ok: false, code: 'no_profile' };
    const payloads = localRecords.map(toPayload);
    const results = [];
    for (let i = 0; i < payloads.length; i += 50) {
      const r = await call('POST', `/api/profiles/${state.currentProfileId}/records/import`,
        { records: payloads.slice(i, i + 50) });
      if (!r.ok) return r;
      results.push(...r.data.results);
    }
    return { ok: true, data: { results } };
  }

  /* ---------- 云端数据读取 ---------- */
  async function getStats() { return call('GET', `/api/profiles/${state.currentProfileId}/records/stats`); }
  async function getWrongbook() { return call('GET', `/api/profiles/${state.currentProfileId}/wrongbook`); }
  async function reviewWrong(results) {
    return call('POST', `/api/profiles/${state.currentProfileId}/wrongbook/review`, { results });
  }
  async function getRecords(opts) {
    const p = new URLSearchParams();
    if (opts && opts.mode) p.set('mode', opts.mode);
    if (opts && opts.cursor) p.set('cursor', String(opts.cursor));
    if (opts && opts.limit) p.set('limit', String(opts.limit));
    const qs = p.toString();
    return call('GET', `/api/profiles/${state.currentProfileId}/records${qs ? '?' + qs : ''}`);
  }
  function exportUrl() { return '/api/account/export'; }
  async function deleteAccount() { return call('DELETE', '/api/account'); }

  const TMAPI = {
    state,
    refresh, call,
    login, childLogin, register, verifyEmail, forgotPassword, resetPassword, logout, logoutAll,
    createProfile, updateProfile, deleteProfile, setChildCredentials, childPassword,
    updateMe, selectProfile,
    getFamily, inviteParent, acceptInvite, revokeInvite,
    membershipActive, hasFeature, isPlayer,
    onRecord, importLocalRecords, flushQueue,
    getStats, getWrongbook, reviewWrong, getRecords, exportUrl, deleteAccount,
    queueSize: () => loadQueue().length
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = TMAPI;
  global.TMAPI = TMAPI;
})(typeof window !== 'undefined' ? window : globalThis);

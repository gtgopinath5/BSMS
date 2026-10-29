// ============================================================
//  Baywatch frontend ↔ backend API client.
//  Plain JS (loads before the JSX). Exposes window.BW_API and a
//  React polling hook window.useBWPoll for real-time data.
//
//  Every portal requires a real backend JWT; the connected modules
//  render ONLY real PostgreSQL-backed data. There is NO demo/offline
//  data path — if the backend is unreachable the UI shows empty/error
//  states rather than fabricated data.
// ============================================================
(function () {
  // API origin. Resolution order:
  //  1. an explicit `bw_api_base` override in localStorage (manual/testing)
  //  2. dev workflow — the page came from frontend/serve.py on :7890 (or file://),
  //     so the backend is the separate process on :8000
  //  3. otherwise SAME ORIGIN: the backend is serving this page itself
  //     (single-container deployment), which also makes CORS irrelevant.
  const BASE = (() => {
    const override = localStorage.getItem('bw_api_base');
    if (override) return override;
    const loc = window.location;
    const isDevStatic = loc.protocol === 'file:' || loc.port === '7890';
    return isDevStatic ? 'http://localhost:8000' : loc.origin;
  })();
  const TKEY = 'bw_token';
  const UKEY = 'bw_user';
  let _online = null;            // null = unknown, true/false after ping()

  // ── PER-TAB AUTH STORAGE ────────────────────────────────────────────
  // The session (token + user) lives in sessionStorage, which is ISOLATED per
  // browser tab/window. That lets three tabs hold three different role sessions
  // at the same time without overwriting each other, and a refresh keeps each
  // tab's own session. localStorage is shared across every tab of an origin —
  // using it for the token was the root cause of cross-role contamination
  // (the last tab to log in clobbered the token for all tabs). Only the
  // non-sensitive API base stays in localStorage (shared config is fine there).
  const store = window.sessionStorage;
  // One-time hygiene: drop any legacy localStorage auth so it can never leak
  // back into a tab (and to migrate existing users cleanly to per-tab auth).
  try { localStorage.removeItem(TKEY); localStorage.removeItem(UKEY); } catch (e) {}

  const token = () => store.getItem(TKEY);
  const currentUser = () => { try { return JSON.parse(store.getItem(UKEY) || 'null'); } catch (e) { return null; } };
  const isLive = () => !!token();
  // Authoritative role = what the JWT actually carries (that's what the backend
  // enforces). Decoding the token means a stale/mismatched `bw_user` can never
  // fool the role checks. Falls back to the stored user, then null.
  const decodeJwt = (tok) => {
    try {
      const b = tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(atob(b + '='.repeat((4 - b.length % 4) % 4)));
    } catch (e) { return null; }
  };
  const roleOf = () => {
    const p = token() && decodeJwt(token());
    return (p && p.role) || (currentUser() && currentUser().role) || null;
  };
  const tokenExpired = () => {
    const p = token() && decodeJwt(token());
    return !!(p && p.exp && Date.now() / 1000 >= p.exp);
  };
  const setSession = (tok, user) => { store.setItem(TKEY, tok); store.setItem(UKEY, JSON.stringify(user || {})); };
  const clearSession = () => { store.removeItem(TKEY); store.removeItem(UKEY); };

  // Tell the app the session is no longer valid (expired / revoked / wrong user).
  // Debounced so a burst of in-flight requests fires it only once. The App
  // listens for this and returns the user to the login screen, which unmounts
  // every portal (and therefore every poller / socket) cleanly.
  let _authNotified = false;
  const notifyAuthExpired = () => {
    if (_authNotified) return;
    _authNotified = true;
    try { window.dispatchEvent(new CustomEvent('bw:auth-expired')); } catch (e) {}
    setTimeout(() => { _authNotified = false; }, 2000);
  };

  // {success,data,message} → data
  const unwrap = (p) => (p && Object.prototype.hasOwnProperty.call(p, 'data')) ? p.data : p;

  async function request(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    const t = token();
    if (t) headers['Authorization'] = 'Bearer ' + t;
    const res = await fetch(BASE + path, {
      method, headers,
      body: body != null ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* empty body */ }
    if (!res.ok) {
      const msg = (data && (data.message || data.detail)) || ('HTTP ' + res.status);
      const err = new Error(msg); err.status = res.status; err.data = data;
      // 401 = token missing/invalid/expired or user gone → end the session and
      //       send the user back to login (once). 403 = a VALID session lacking
      //       permission for THIS endpoint (e.g. a stale poller from another
      //       role using the shared token) — never clear the session for that,
      //       or we'd log out a perfectly good login. The poller stops instead.
      if (res.status === 401) { clearSession(); notifyAuthExpired(); }
      throw err;
    }
    return data;
  }

  async function requestForm(path, formData) {
    const headers = {};
    const t = token();
    if (t) headers['Authorization'] = 'Bearer ' + t;
    const res = await fetch(BASE + path, { method: 'POST', headers, body: formData });
    let data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) { const e = new Error((data && data.message) || ('HTTP ' + res.status)); e.status = res.status; throw e; }
    return data;
  }

  async function ping() {
    try { const r = await fetch(BASE + '/health', { cache: 'no-store' }); _online = r.ok; return r.ok; }
    catch (e) { _online = false; return false; }
  }

  async function login(username, password) {
    // Trim only the username (a stray space → an avoidable 401). NEVER trim the
    // password — whitespace can be significant.
    const res = await fetch(BASE + '/api/v1/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: String(username || '').trim(), password }),
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* empty / non-JSON body */ }
    if (!res.ok) {
      // Carry the HTTP status so the login screen can show one precise message
      // (401 → bad credentials) instead of a generic failure.
      const err = new Error((data && (data.message || data.detail)) || 'Login failed');
      err.status = res.status; err.data = data;
      throw err;
    }
    setSession(data.access_token, { id: data.user_id, name: data.name, role: data.role, branch_id: data.branch_id });
    return data;
  }

  const API = {
    BASE, token, currentUser, isLive, roleOf, tokenExpired, ping, login,
    online: () => _online,
    logout: () => clearSession(),

    // ── public: pre-login facility picker (no auth) ──
    branches: () => request('GET', '/api/v1/branches').then(unwrap),

    // ── admin: bays + live dashboard ──
    bays:        () => request('GET', '/api/v1/bays').then(unwrap),
    createBay:   (body) => request('POST', '/api/v1/bays', body).then(unwrap),
    updateBay:   (id, body) => request('PUT', `/api/v1/bays/${id}`, body).then(unwrap),
    deleteBay:   (id) => request('DELETE', `/api/v1/bays/${id}`),   // keep envelope (data is null; we want .message)
    duplicateBay:(id) => request('POST', `/api/v1/bays/${id}/duplicate`).then(unwrap),
    setBayStatus:(id, status) => request('POST', `/api/v1/bays/${id}/status`, { status }).then(unwrap),

    // ── bay-first operations (Fleet View + drawer + worker mapping) ──
    bayOperations:   () => request('GET', '/api/v1/bays/operations').then(unwrap),
    bayDetail:       (id) => request('GET', `/api/v1/bays/${id}/detail`).then(unwrap),
    assignPrimaryWorker: (id, workerId) => request('PUT', `/api/v1/bays/${id}`, { primary_worker_id: workerId }).then(unwrap),
    tempAssignWorker: (id, body) => request('POST', `/api/v1/bays/${id}/temp-assign`, body),   // keep envelope (.message)
    revertBayWorker:  (id) => request('POST', `/api/v1/bays/${id}/revert-worker`),              // keep envelope (.message)

    // ── camera connection (admin) — registry + pair/test/reconnect/restart ──
    camerasList:     () => request('GET', '/api/v1/cameras').then(unwrap),
    pairCamera:      (body) => request('POST', '/api/v1/cameras', body),          // keep envelope (.message)
    updateCamera:    (id, body) => request('PUT', `/api/v1/cameras/${id}`, body),
    unpairCamera:    (id) => request('DELETE', `/api/v1/cameras/${id}`),
    testCamera:      (id) => request('POST', `/api/v1/cameras/${id}/test`),
    reconnectCamera: (id) => request('POST', `/api/v1/cameras/${id}/reconnect`),
    restartCamera:   (id) => request('POST', `/api/v1/cameras/${id}/restart`),
    workers:     () => request('GET', '/api/v1/workers').then(unwrap),
    createWorker:(body) => request('POST', '/api/v1/workers', body).then(unwrap),
    updateWorker:(id, body) => request('PUT', `/api/v1/workers/${id}`, body).then(unwrap),
    deleteWorker:(id) => request('DELETE', `/api/v1/workers/${id}`).then(unwrap),
    resetWorkerPassword: (id, newPassword) => request('POST', `/api/v1/workers/${id}/reset-password`, { new_password: newPassword }).then(unwrap),
    setWorkerStatus: (id, status) => request('POST', `/api/v1/workers/${id}/status`, { status }).then(unwrap),
    workerAudit: (id) => request('GET', `/api/v1/workers/${id}/audit`).then(unwrap),
    dashboard:   () => request('GET', '/api/v1/bay-dashboard').then(unwrap),
    startBay:    (bayId) => request('POST', `/api/v1/bay-dashboard/${bayId}/start`).then(unwrap),
    pauseBay:    (bayId) => request('POST', `/api/v1/bay-dashboard/${bayId}/pause`).then(unwrap),
    resumeBay:   (bayId) => request('POST', `/api/v1/bay-dashboard/${bayId}/resume`).then(unwrap),
    completeBay: (bayId, actualSeconds) => request('POST', `/api/v1/bay-dashboard/${bayId}/complete`, { actual_duration: actualSeconds || null }).then(unwrap),

    // ── admin: jobs + queue ──
    queue:     () => request('GET', '/api/v1/queue').then(unwrap),
    queueItem: (queueId) => request('GET', `/api/v1/queue/${queueId}`).then(unwrap),
    createJob: (body) => request('POST', '/api/v1/jobs/manual', body).then(unwrap),
    saveToQueue: (body) => request('POST', '/api/v1/jobs/save-to-queue', body).then(unwrap),
    updateJob: (jobCardId, body) => request('PUT', `/api/v1/jobs/${jobCardId}`, body).then(unwrap),
    extractPdf: (file) => { const fd = new FormData(); fd.append('file', file); return requestForm('/api/v1/jobs/extract-pdf', fd).then(unwrap); },
    assign:    (queueId, bayId, force) => request('POST', `/api/v1/queue/${queueId}/assign`, { bay_id: bayId, force: !!force }).then(unwrap),
    moveQueue: (queueId, direction) => request('POST', `/api/v1/queue/${queueId}/move`, { direction }).then(unwrap),
    // bay-first: there is NO reassign-worker call — moving a job means changing
    // its BAY; the backend moves it to that bay's worker automatically.
    changeBay: (queueId, bayId) => request('POST', `/api/v1/queue/${queueId}/change-bay`, { bay_id: bayId }).then(unwrap),
    removeQueued: (queueId) => request('DELETE', `/api/v1/queue/${queueId}`).then(unwrap),

    // ── reports ──
    workerPerformance: (workerId) => request('GET', '/api/v1/reports/worker-performance' + (workerId ? `?worker_id=${workerId}` : '')).then(unwrap),
    workCompletion:    () => request('GET', '/api/v1/reports/work-completion').then(unwrap),
    branchSummary:     () => request('GET', '/api/v1/reports/branch-summary').then(unwrap),

    // ── parts (Parts Time) ──
    partsList:      (q, fileId) => request('GET', '/api/v1/parts?' + new URLSearchParams({ ...(q ? { q } : {}), ...(fileId ? { source_file_id: fileId } : {}), size: 100 })).then(unwrap),
    partsListPaged: (q, page, size, opts) => request('GET', '/api/v1/parts?' + new URLSearchParams({
                       ...(q ? { q } : {}),
                       ...(opts && opts.model && opts.model !== 'ALL' ? { model: opts.model } : {}),
                       ...(opts && opts.source && opts.source !== 'ALL' ? { source_file_id: opts.source } : {}),
                       page: page || 1, size: size || 15 })).then(unwrap),
    partsModels:    () => request('GET', '/api/v1/parts/models').then(unwrap),
    partsFiles:     () => request('GET', '/api/v1/parts/files').then(unwrap),
    partsFilePreview: (id) => request('GET', `/api/v1/parts/files/${id}`).then(unwrap),
    partsFileDeps:  (id) => request('GET', `/api/v1/parts/files/${id}/dependencies`).then(unwrap),
    partsAudit:     () => request('GET', '/api/v1/parts/audit').then(unwrap),
    // legacy server-side parse (small files)
    partsImport:    (file) => { const fd = new FormData(); fd.append('file', file); return requestForm('/api/v1/parts/import-file', fd).then(unwrap); },
    // client-side extracted rows (large-file safe)
    partsImportRows: (body) => request('POST', '/api/v1/parts/import-rows', body).then(unwrap),
    partsReplaceFile: (id, body) => request('POST', `/api/v1/parts/files/${id}/replace`, body).then(unwrap),
    addPart:        (body) => request('POST', '/api/v1/parts', body).then(unwrap),
    updatePart:     (id, body) => request('PUT', `/api/v1/parts/${id}`, body).then(unwrap),
    deletePart:     (id) => request('DELETE', `/api/v1/parts/${id}`).then(unwrap),
    deletePartFile: (id) => request('DELETE', `/api/v1/parts/files/${id}`).then(unwrap),
    estimateFromJobCard: (file) => { const fd = new FormData(); fd.append('file', file); return requestForm('/api/v1/parts/estimate-from-job-card', fd).then(unwrap); },
    unitConversion:      () => request('GET', '/api/v1/parts/unit-conversion').then(unwrap),
    setUnitConversion:   (value, confirm) => request('POST', '/api/v1/parts/unit-conversion', { value_minutes: value, confirm: !!confirm }).then(unwrap),

    // ── leave ──
    leaveList:    () => request('GET', '/api/v1/leave').then(unwrap),
    leaveMine:    () => request('GET', '/api/v1/leave/mine').then(unwrap),
    leaveApply:   (body) => request('POST', '/api/v1/leave', body).then(unwrap),
    leaveApprove: (id) => request('POST', `/api/v1/leave/${id}/approve`).then(unwrap),
    leaveReject:  (id) => request('POST', `/api/v1/leave/${id}/reject`).then(unwrap),

    // ── master provisioning ──
    createBranch: (body) => request('POST', '/api/v1/master/branches', body).then(unwrap),
    masterAdmins: () => request('GET', '/api/v1/master/admins').then(unwrap),
    createAdmin:  (body) => request('POST', '/api/v1/master/admins', body).then(unwrap),

    // ── worker (own data, view-only) ──
    workerActive:  () => request('GET', '/api/v1/worker/active').then(unwrap),
    workerQueue:   () => request('GET', '/api/v1/worker/queue').then(unwrap),
    workerHistory: () => request('GET', '/api/v1/worker/history').then(unwrap),

    // ── worker jobcard entry / vehicle intake evidence (Phase C) ──
    // Media uploads go through requestForm (multipart). Image/audio playback later
    // uses the backend's token-gated view_url (BW_API.BASE + url) — raw paths are
    // never exposed by the API, so nothing here ever handles a filesystem path.
    workerIntakeCreate:   (body) => request('POST', '/api/v1/worker/intake', body).then(unwrap),
    workerIntakeList:     (filters) => request('GET', '/api/v1/worker/intake' + (filters && Object.keys(filters).length ? '?' + new URLSearchParams(filters) : '')).then(unwrap),
    workerIntakeGet:      (id) => request('GET', `/api/v1/worker/intake/${id}`).then(unwrap),
    workerIntakeUploadImage: (id, file, caption) => { const fd = new FormData(); fd.append('file', file); if (caption) fd.append('caption', caption); return requestForm(`/api/v1/worker/intake/${id}/media/image`, fd).then(unwrap); },
    workerIntakeUploadAudio: (id, blob, label, duration) => { const fd = new FormData(); fd.append('file', blob, (blob && blob.name) || 'voice.webm'); if (label) fd.append('caption', label); if (duration != null) fd.append('duration_seconds', String(Math.round(duration))); return requestForm(`/api/v1/worker/intake/${id}/media/audio`, fd).then(unwrap); },
    workerIntakeSubmit:   (id) => request('POST', `/api/v1/worker/intake/${id}/submit`).then(unwrap),
    workerIntakeDeleteMedia: (mediaId) => request('DELETE', `/api/v1/worker/intake/media/${mediaId}`).then(unwrap),
    // Full token-gated media URL for <img>/<audio> (token is in the query string, so no Bearer needed).
    intakeMediaUrl:       (url) => url ? (BASE + url) : null,

    // ── intake evidence: admin (own branch) + master (global) ──
    adminIntakeSummary:  () => request('GET', '/api/v1/admin/intake/summary').then(unwrap),
    masterIntakeSummary: (filters) => request('GET', '/api/v1/master/intake/summary' + (filters && Object.keys(filters).length ? '?' + new URLSearchParams(filters) : '')).then(unwrap),
    adminIntakeList:     (filters) => request('GET', '/api/v1/admin/intake' + (filters && Object.keys(filters).length ? '?' + new URLSearchParams(filters) : '')).then(unwrap),
    adminIntakeGrouped:  (filters) => request('GET', '/api/v1/admin/intake/grouped-by-worker' + (filters && Object.keys(filters).length ? '?' + new URLSearchParams(filters) : '')).then(unwrap),
    adminIntakeGet:      (id) => request('GET', `/api/v1/admin/intake/${id}`).then(unwrap),
    adminIntakeByBike:   (bike) => request('GET', `/api/v1/admin/intake/by-bike/${encodeURIComponent(bike)}`).then(unwrap),
    adminIntakeLinkJob:  (id, body) => request('POST', `/api/v1/admin/intake/${id}/link-job`, body).then(unwrap),
    adminIntakeRevokeMedia: (mediaId) => request('POST', `/api/v1/admin/intake/media/${mediaId}/revoke`).then(unwrap),
    masterIntakeList:    (filters) => request('GET', '/api/v1/master/intake' + (filters && Object.keys(filters).length ? '?' + new URLSearchParams(filters) : '')).then(unwrap),
    masterIntakeGrouped: (filters) => request('GET', '/api/v1/master/intake/grouped-by-branch' + (filters && Object.keys(filters).length ? '?' + new URLSearchParams(filters) : '')).then(unwrap),
    masterIntakeGet:     (id) => request('GET', `/api/v1/master/intake/${id}`).then(unwrap),
    masterIntakeRevokeMedia: (mediaId) => request('POST', `/api/v1/master/intake/media/${mediaId}/revoke`).then(unwrap),

    // ── Worker Bay-to-Bay Time Analysis (analytics derived from ServiceSession) ──
    wtaMeta:              () => request('GET', '/api/v1/admin/analytics/worker-transition/meta').then(unwrap),
    adminWorkerTransitionSummary: (filters) => request('GET', '/api/v1/admin/analytics/worker-transition/summary' + (filters && Object.keys(filters).length ? '?' + new URLSearchParams(filters) : '')).then(unwrap),
    adminWorkerTransitionWorkers: (filters) => request('GET', '/api/v1/admin/analytics/worker-transition/workers' + (filters && Object.keys(filters).length ? '?' + new URLSearchParams(filters) : '')).then(unwrap),
    adminWorkerTransitionTimeline: (workerId, filters) => request('GET', `/api/v1/admin/analytics/worker-transition/workers/${workerId}/timeline` + (filters && Object.keys(filters).length ? '?' + new URLSearchParams(filters) : '')).then(unwrap),
    adminWorkerTransitionTransitions: (filters) => request('GET', '/api/v1/admin/analytics/worker-transition/transitions' + (filters && Object.keys(filters).length ? '?' + new URLSearchParams(filters) : '')).then(unwrap),
    adminWorkerTransitionSaveReason: (transitionId, payload) => request('POST', `/api/v1/admin/analytics/worker-transition/transitions/${transitionId}/reason`, payload).then(unwrap),
    masterWorkerTransitionSummary: (filters) => request('GET', '/api/v1/master/analytics/worker-transition/summary' + (filters && Object.keys(filters).length ? '?' + new URLSearchParams(filters) : '')).then(unwrap),
    masterWorkerTransitionBranch: (branchId, filters) => request('GET', `/api/v1/master/analytics/worker-transition/branches/${branchId}` + (filters && Object.keys(filters).length ? '?' + new URLSearchParams(filters) : '')).then(unwrap),
    masterWorkerTransitionTimeline: (workerId, filters) => request('GET', `/api/v1/master/analytics/worker-transition/workers/${workerId}/timeline` + (filters && Object.keys(filters).length ? '?' + new URLSearchParams(filters) : '')).then(unwrap),
    masterWorkerTransitionSaveReason: (transitionId, payload) => request('POST', `/api/v1/master/analytics/worker-transition/transitions/${transitionId}/reason`, payload).then(unwrap),
    // Standalone Vehicle Intake Evidence PDF — role-scoped endpoint, auth via Bearer, so it must
    // be fetched as a blob (an <a download> can't send the header) then saved client-side.
    // Returns the safe filename; throws with .status on failure (caller shows the error).
    intakeEvidencePdf: async (role, id) => {
      const seg = role === 'master' ? 'master' : role === 'admin' ? 'admin' : 'worker';
      const res = await fetch(BASE + `/api/v1/${seg}/intake/${id}/evidence-pdf`, { headers: { Authorization: 'Bearer ' + token() } });
      if (!res.ok) { let d = null; try { d = await res.json(); } catch (e) {} const err = new Error((d && (d.message || d.detail)) || ('HTTP ' + res.status)); err.status = res.status; throw err; }
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition') || '';
      const name = (cd.match(/filename="?([^"]+)"?/) || [])[1] || `Vehicle_Intake_Evidence_${id}.pdf`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      return name;
    },

    // ── bike test drive (worker — approval / device-connection workflow) ──
    // No silent tracking: GPS starts only after the worker approves on their device,
    // and only an admin completes the drive (worker /complete returns 403).
    testDriveMine:        () => request('GET', '/api/v1/test-drives/mine/active').then(unwrap),
    testDriveApprove:     (id, body) => request('POST', `/api/v1/test-drives/${id}/approve`, body).then(unwrap),
    testDriveMineStatus:  (id) => request('GET', `/api/v1/test-drives/${id}/mine`).then(unwrap),
    testDrivePoints:      (id, points) => request('POST', `/api/v1/test-drives/${id}/points`, { points }).then(unwrap),
    testDriveStart:       (id, body) => request('POST', `/api/v1/test-drives/${id}/start`, body).then(unwrap),       // legacy
    testDriveComplete:    (id) => request('POST', `/api/v1/test-drives/${id}/complete`).then(unwrap),                // 403: admin alone completes

    // ── bike test drive (admin tracking) — Phase 1 read APIs + assign/cancel/complete ──
    testDriveAdminComplete: (id) => request('POST', `/api/v1/test-drives/${id}/admin-complete`).then(unwrap),
    testDrives:        (params) => request('GET', '/api/v1/test-drives' + (params && Object.keys(params).length ? '?' + new URLSearchParams(params) : '')).then(unwrap),
    testDriveGet:      (id) => request('GET', `/api/v1/test-drives/${id}`).then(unwrap),
    testDrivePointsOf: (id) => request('GET', `/api/v1/test-drives/${id}/points`).then(unwrap),
    testDriveSummary:  (id) => request('GET', `/api/v1/test-drives/${id}/summary`).then(unwrap),
    testDriveAssign:   (body) => request('POST', '/api/v1/test-drives/assign', body).then(unwrap),
    testDriveCancel:   (id) => request('POST', `/api/v1/test-drives/${id}/cancel`).then(unwrap),
    // route-image (Phase 4) — admin-only & token-gated, so fetch as a blob and
    // hand back an object URL the <img> can use (an <img src> can't send a Bearer).
    testDriveRouteImage: async (id) => {
      const res = await fetch(BASE + `/api/v1/test-drives/${id}/route-image`, { headers: { Authorization: 'Bearer ' + token() } });
      if (!res.ok) { let d = null; try { d = await res.json(); } catch (e) {} const err = new Error((d && (d.message || d.detail)) || ('HTTP ' + res.status)); err.status = res.status; throw err; }
      return URL.createObjectURL(await res.blob());
    },
    testDriveRegenImage: (id) => request('POST', `/api/v1/test-drives/${id}/route-image/regenerate`).then(unwrap),
    // route-image as a base64 data URL — works in both <img src> and jsPDF addImage
    // (a token-gated <img src="/route-image"> can't carry the Bearer header).
    testDriveRouteImageData: async (id) => {
      const res = await fetch(BASE + `/api/v1/test-drives/${id}/route-image`, { headers: { Authorization: 'Bearer ' + token() } });
      if (!res.ok) { let d = null; try { d = await res.json(); } catch (e) {} const err = new Error((d && (d.message || d.detail)) || ('HTTP ' + res.status)); err.status = res.status; throw err; }
      const blob = await res.blob();
      return await new Promise((resolve, reject) => { const r = new FileReader(); r.onloadend = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(blob); });
    },

    // ── system health (master · System Settings) ──
    health: () => request('GET', '/health').then(unwrap),

    // ── platform: global search · activity feed · job timeline ──
    platformSearch:   (q) => request('GET', `/api/v1/platform/search?q=${encodeURIComponent(q)}`).then(unwrap),
    platformActivity: (q, limit) => request('GET', `/api/v1/platform/activity?q=${encodeURIComponent(q || '')}&limit=${limit || 50}`).then(unwrap),
    platformTimeline: (sessionId) => request('GET', `/api/v1/platform/timeline/${sessionId}`).then(unwrap),

    // ── storage management (admin) — Drive archival + local SSD ──
    storageOverview: () => request('GET', '/api/v1/storage').then(unwrap),
    storageSyncNow:  () => request('POST', '/api/v1/storage/sync-now'),          // keep envelope (.message)
    storageRetry:    (recId) => request('POST', `/api/v1/storage/retry/${recId}`), // keep envelope (.message)
    storageVerify:   (recId) => request('POST', `/api/v1/storage/recordings/${recId}/verify`),  // keep envelope (.message)
    storageExpire:   (recId) => request('POST', `/api/v1/storage/recordings/${recId}/expire`),  // keep envelope (.message)
    storageDelete:   (recId) => request('POST', `/api/v1/storage/recordings/${recId}/delete`),  // keep envelope (.message)

    // ── integrations & configuration (admin) — DB-override provider, masked secrets ──
    integrationsStatus: () => request('GET', '/api/v1/integrations/status').then(unwrap),
    getIntegration:  (p) => request('GET', `/api/v1/integrations/${p}`).then(unwrap),
    saveIntegration: (p, body) => request('PUT', `/api/v1/integrations/${p}`, body).then(unwrap),
    testIntegration: (p) => request('POST', `/api/v1/integrations/${p}/test`).then(unwrap),
    driveSyncNow:    () => request('POST', '/api/v1/integrations/google_drive/sync-now'),  // keep envelope (.message + .data.configured)
    driveDisconnect: () => request('POST', '/api/v1/integrations/google_drive/disconnect').then(unwrap),
    mqttReconnect:   () => request('POST', '/api/v1/integrations/mqtt_timer/reconnect').then(unwrap),

    // ── customer estimate approval (admin/master) — temporary customer form links ──
    approvalsList:      (status, q, opts) => request('GET', '/api/v1/customer-approvals?' + new URLSearchParams({ ...(status ? { status } : {}), ...(q ? { q } : {}), ...((opts && opts.date_from) ? { date_from: opts.date_from } : {}), ...((opts && opts.date_to) ? { date_to: opts.date_to } : {}), ...((opts && opts.include_expired) ? { include_expired: 'true' } : {}), ...((opts && opts.include_deleted) ? { include_deleted: 'true' } : {}) })).then(unwrap),
    approvalFromQueue:  (queueId) => request('POST', `/api/v1/customer-approvals/from-queue/${queueId}`).then(unwrap),
    approvalGet:        (id) => request('GET', `/api/v1/customer-approvals/${id}`).then(unwrap),
    approvalHistory:    (id) => request('GET', `/api/v1/customer-approvals/${id}/history`).then(unwrap),
    approvalUpdate:     (id, body) => request('PUT', `/api/v1/customer-approvals/${id}`, body).then(unwrap),
    approvalAddItem:    (id, body) => request('POST', `/api/v1/customer-approvals/${id}/items`, body).then(unwrap),
    approvalEditItem:   (id, itemId, body) => request('PUT', `/api/v1/customer-approvals/${id}/items/${itemId}`, body).then(unwrap),
    approvalDeleteItem: (id, itemId) => request('DELETE', `/api/v1/customer-approvals/${id}/items/${itemId}`).then(unwrap),
    approvalPreview:    (id) => request('POST', `/api/v1/customer-approvals/${id}/preview`).then(unwrap),
    approvalGenerateLink: (id) => request('POST', `/api/v1/customer-approvals/${id}/generate-link`).then(unwrap),
    approvalEditResendStart: (id) => request('POST', `/api/v1/customer-approvals/${id}/edit-resend/start`).then(unwrap),
    approvalResend:     (id) => request('POST', `/api/v1/customer-approvals/${id}/resend`).then(unwrap),
    approvalRevokeLink: (id) => request('POST', `/api/v1/customer-approvals/${id}/revoke-link`).then(unwrap),
    approvalCleanup:    () => request('POST', `/api/v1/customer-approvals/cleanup`).then(unwrap),
    approvalSendWhatsapp: (id, token) => request('POST', `/api/v1/customer-approvals/${id}/send-whatsapp`, { token }).then(unwrap),
    approvalCancel:     (id) => request('POST', `/api/v1/customer-approvals/${id}/cancel`).then(unwrap),

    // ── timer connection (admin) — ESP32 physical timers over MQTT ──
    timersList:      () => request('GET', '/api/v1/timers').then(unwrap),
    pairTimer:       (body) => request('POST', '/api/v1/timers', body),          // keep envelope (.message)
    updateTimer:     (id, body) => request('PUT', `/api/v1/timers/${id}`, body),
    unpairTimer:     (id) => request('DELETE', `/api/v1/timers/${id}`),
    reconnectTimer:  (id) => request('POST', `/api/v1/timers/${id}/reconnect`),
    restartTimer:    (id) => request('POST', `/api/v1/timers/${id}/restart`),
    testTimer:       (id) => request('POST', `/api/v1/timers/${id}/test`),
    updateTimerFirmware: (id) => request('POST', `/api/v1/timers/${id}/firmware`),

    // ── master ──
    masterBranches:      () => request('GET', '/api/v1/master/branches').then(unwrap),
    masterLive:          () => request('GET', '/api/v1/master/live-monitoring').then(unwrap),
    masterBayMonitoring: () => request('GET', '/api/v1/master/bay-monitoring').then(unwrap),
    masterAnalytics:     () => request('GET', '/api/v1/master/global-analytics').then(unwrap),

    // ── AI Barricade Vehicle Detection (Phase C UI over the verified simulation backend) ──
    // Admin = own branch; master = global. Realtime via /ws/barricade (summary only).
    // Media is served ONLY through the backend's token-gated view_url — no raw path ever.
    adminBarricadeConfig:        () => request('GET', '/api/v1/admin/barricade/config').then(unwrap),
    adminBarricadeSaveCamera:    (body) => request('POST', '/api/v1/admin/barricade/config/camera', body).then(unwrap),
    adminBarricadeSaveController:(body) => request('POST', '/api/v1/admin/barricade/config/controller', body).then(unwrap),
    adminBarricadeEvents:        (filters) => request('GET', '/api/v1/admin/barricade/events' + (filters && Object.keys(filters).length ? '?' + new URLSearchParams(filters) : '')).then(unwrap),
    adminBarricadeEvent:         (id) => request('GET', `/api/v1/admin/barricade/events/${id}`).then(unwrap),
    adminBarricadeAllow:         (id) => request('POST', `/api/v1/admin/barricade/events/${id}/allow`).then(unwrap),
    adminBarricadeDeny:          (id) => request('POST', `/api/v1/admin/barricade/events/${id}/deny`).then(unwrap),
    adminBarricadeOpen:          (id) => request('POST', `/api/v1/admin/barricade/events/${id}/open`).then(unwrap),
    adminBarricadeLinkJob:       (id, body) => request('POST', `/api/v1/admin/barricade/events/${id}/link-job`, body).then(unwrap),
    adminBarricadeSimulateDetection: (body) => request('POST', '/api/v1/admin/barricade/simulate-detection', body).then(unwrap),
    adminBarricadeBillApproval:  (body) => request('POST', '/api/v1/admin/barricade/bill-approval', body).then(unwrap),
    adminBarricadeTempApproval:  (body) => request('POST', '/api/v1/admin/barricade/temp-approval', body).then(unwrap),
    // ── exit-approval lists + lifecycle (Phase G) ──
    adminBarricadeBillApprovals:       (filters) => request('GET', '/api/v1/admin/barricade/bill-approvals' + (filters && Object.keys(filters).length ? '?' + new URLSearchParams(filters) : '')).then(unwrap),
    adminBarricadeBillApprovalApprove: (id) => request('POST', `/api/v1/admin/barricade/bill-approvals/${id}/approve`).then(unwrap),
    adminBarricadeBillApprovalReject:  (id) => request('POST', `/api/v1/admin/barricade/bill-approvals/${id}/reject`).then(unwrap),
    adminBarricadeTempApprovals:       (filters) => request('GET', '/api/v1/admin/barricade/temp-approvals' + (filters && Object.keys(filters).length ? '?' + new URLSearchParams(filters) : '')).then(unwrap),
    adminBarricadeTempApprovalRevoke:  (id) => request('POST', `/api/v1/admin/barricade/temp-approvals/${id}/revoke`).then(unwrap),
    adminBarricadeTestOpen:      (direction) => request('POST', `/api/v1/admin/barricade/test-open/${direction}`),   // keep envelope (.message + .data)
    adminBarricadeEmergencyStop: () => request('POST', '/api/v1/admin/barricade/emergency-stop'),                    // keep envelope (.message)
    adminBarricadeControllerStatus: (poll) => request('GET', '/api/v1/admin/barricade/controller/status' + (poll ? '?poll=1' : '')).then(unwrap),
    adminBarricadeSafetyStatus:  (body) => request('POST', '/api/v1/admin/barricade/config/safety-status', body).then(unwrap),
    adminBarricadePilotChecklist: () => request('GET', '/api/v1/admin/barricade/pilot-checklist').then(unwrap),
    masterBarricadeOverview:     () => request('GET', '/api/v1/master/barricade/overview').then(unwrap),
    masterBarricadeEvents:       (filters) => request('GET', '/api/v1/master/barricade/events' + (filters && Object.keys(filters).length ? '?' + new URLSearchParams(filters) : '')).then(unwrap),
    masterBarricadeEvent:        (id) => request('GET', `/api/v1/master/barricade/events/${id}`).then(unwrap),
    masterBarricadeOverride:     (id, body) => request('POST', `/api/v1/master/barricade/events/${id}/override`, body).then(unwrap),
    masterBarricadeBillApprovals: (filters) => request('GET', '/api/v1/master/barricade/bill-approvals' + (filters && Object.keys(filters).length ? '?' + new URLSearchParams(filters) : '')).then(unwrap),
    masterBarricadeTempApprovals: (filters) => request('GET', '/api/v1/master/barricade/temp-approvals' + (filters && Object.keys(filters).length ? '?' + new URLSearchParams(filters) : '')).then(unwrap),
    // token-gated detection-frame URL for <img> (the token is in the query string — no Bearer needed)
    barricadeMediaUrl:           (url) => url ? (BASE + url) : null,
    // ── AI detection service (Phase D) — SEPARATE process (default :8811). The browser uploads the
    // image to the service; the service authenticates to the backend server-side (internal token /
    // bearer), so no internal secret is ever exposed to the frontend. Cross-origin (service has CORS).
    barricadeAiBase:      () => localStorage.getItem('bw_ai_barricade_url') || 'http://localhost:8811',
    barricadeAiSetBase:   (u) => { try { localStorage.setItem('bw_ai_barricade_url', u); } catch (e) {} },
    barricadeAiDetect:    async (file, opts) => { const o = (opts == null || typeof opts === 'object') ? (opts || {}) : { conf: opts }; const fd = new FormData(); fd.append('file', file); if (o.conf != null) fd.append('conf', String(o.conf)); if (o.run_ocr != null) fd.append('run_ocr', String(!!o.run_ocr)); if (o.vehicle_number_override) fd.append('vehicle_number_override', o.vehicle_number_override); if (o.ocr_confidence_override != null) fd.append('ocr_confidence_override', String(o.ocr_confidence_override)); const r = await fetch(API.barricadeAiBase() + '/detect/image', { method: 'POST', body: fd }); if (!r.ok) throw new Error('AI service HTTP ' + r.status); return r.json(); },
    barricadeAiDetectIngest: async (file, opts) => { const fd = new FormData(); fd.append('file', file); fd.append('branch_id', (opts && opts.branch_id) || ''); fd.append('direction', (opts && opts.direction) || 'entrance'); if (opts && opts.run_ocr != null) fd.append('run_ocr', String(!!opts.run_ocr)); if (opts && opts.vehicle_number_override) fd.append('vehicle_number_override', opts.vehicle_number_override); if (opts && opts.ocr_confidence_override != null) fd.append('ocr_confidence_override', String(opts.ocr_confidence_override)); const r = await fetch(API.barricadeAiBase() + '/detect-and-ingest/image', { method: 'POST', body: fd }); if (!r.ok) throw new Error('AI service HTTP ' + r.status); return r.json(); },
    // ── RTSP stream workers (Phase E) — the browser drives the SEPARATE service; the internal token
    // stays server-side in the service. Status/source are masked (no credential, no full RTSP URL).
    barricadeStreamStatus:  async () => { const r = await fetch(API.barricadeAiBase() + '/streams/status'); if (!r.ok) throw new Error('AI service HTTP ' + r.status); return r.json(); },
    barricadeStreamStart:   async (body) => { const r = await fetch(API.barricadeAiBase() + '/streams/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); if (!r.ok) throw new Error('AI service HTTP ' + r.status); return r.json(); },
    barricadeStreamStop:    async () => { const r = await fetch(API.barricadeAiBase() + '/streams/stop', { method: 'POST' }); if (!r.ok) throw new Error('AI service HTTP ' + r.status); return r.json(); },
    barricadeStreamReload:  async () => { const r = await fetch(API.barricadeAiBase() + '/streams/reload', { method: 'POST' }); if (!r.ok) throw new Error('AI service HTTP ' + r.status); return r.json(); },
    barricadeStreamTestFile: async (files, opts) => { const fd = new FormData(); (files || []).forEach(f => fd.append('files', f)); fd.append('branch_id', (opts && opts.branch_id) || ''); fd.append('direction', (opts && opts.direction) || 'entrance'); if (opts && opts.vehicle_number_raw) fd.append('vehicle_number_raw', opts.vehicle_number_raw); const r = await fetch(API.barricadeAiBase() + '/streams/test-file', { method: 'POST', body: fd }); if (!r.ok) throw new Error('AI service HTTP ' + r.status); return r.json(); },

    // ── Customer Live Watch — admin decision (own branch) + master audit ──
    cwContext:  (bayId) => request('GET', `/api/v1/customer-watch/context?bay_id=${encodeURIComponent(bayId)}`).then(unwrap),
    cwDecision: (body) => request('POST', '/api/v1/customer-watch/decision', body).then(unwrap),
    cwWhatsapp: (id, token) => request('POST', `/api/v1/customer-watch/${id}/whatsapp`, { token }),  // keep envelope (.message)
    cwAudit:    () => request('GET', '/api/v1/customer-watch/audit').then(unwrap),
    cwRevert:   (id) => request('POST', `/api/v1/customer-watch/${id}/revert`),                       // keep envelope (.message)
  };

  // React hook: poll `fn` every intervalMs; returns {data,error,loading,reload}.
  // Robustness: on an auth error (401/403) it STOPS polling instead of hammering
  // the endpoint every couple of seconds (which is what produced the console
  // flood). Network errors keep retrying so it recovers once the backend is back.
  function usePoll(fn, deps, intervalMs) {
    const { useState, useEffect, useRef, useCallback } = React;
    const [state, setState] = useState({ data: null, error: null, loading: true });
    const fnRef = useRef(fn); fnRef.current = fn;
    const stopRef = useRef(false);   // halts the loop after an auth error
    const tick = useCallback(async () => {
      try {
        const d = await fnRef.current();
        stopRef.current = false;
        setState({ data: d, error: null, loading: false });
      } catch (e) {
        if (e && (e.status === 401 || e.status === 403)) stopRef.current = true; // don't flood
        setState(s => ({ data: s.data, error: e, loading: false }));
      }
    }, []);
    useEffect(() => {
      let alive = true;
      stopRef.current = false;
      const run = async () => { if (alive && !stopRef.current && token()) await tick(); };
      run();
      const id = setInterval(run, intervalMs || 2000);
      return () => { alive = false; clearInterval(id); };
    }, deps || []); // eslint-disable-line
    return { ...state, reload: () => { stopRef.current = false; return tick(); } };
  }

  // React hook: subscribe to a WS push stream. Calls onData(data) per frame,
  // auto-reconnects on drop. path e.g. '/bay-dashboard' → ws://…/ws/bay-dashboard
  function useSocket(path, onData, deps) {
    const { useEffect, useRef } = React;
    const cb = useRef(onData); cb.current = onData;
    useEffect(() => {
      if (!token()) return;
      let ws, closed = false, retry, attempts = 0;
      const connect = () => {
        if (closed || !token()) return;            // no token → don't connect
        try {
          const wsBase = BASE.replace(/^http/, 'ws');
          ws = new WebSocket(`${wsBase}/ws${path}?token=${encodeURIComponent(token())}`);
          ws.onopen = () => { attempts = 0; };
          ws.onmessage = (ev) => { try { cb.current(JSON.parse(ev.data).data); } catch (e) {} };
          ws.onclose = (ev) => {
            // 4401 unauthorized / 4403 wrong-role: auth failure — do NOT reconnect-storm.
            if (closed || ev.code === 4401 || ev.code === 4403) { if (ev.code === 4401) notifyAuthExpired(); return; }
            attempts += 1;
            if (attempts > 6) return;               // give up after a few tries
            retry = setTimeout(connect, Math.min(1500 * attempts, 8000)); // backoff
          };
          ws.onerror = () => { try { ws.close(); } catch (e) {} };
        } catch (e) {
          attempts += 1;
          if (!closed && attempts <= 6) retry = setTimeout(connect, Math.min(1500 * attempts, 8000));
        }
      };
      connect();
      return () => { closed = true; clearTimeout(retry); if (ws) try { ws.close(); } catch (e) {} };
    }, deps || []); // eslint-disable-line
  }

  // React hook: a realtime SNAPSHOT with automatic fallback. Subscribes to the WS push channel
  // `path` (≈1s snapshots) AND runs `fetcher` on an interval as a seed/fallback — both write the
  // same state (last-writer-wins; identical shape by construction), so the UI shows live data over
  // WebSocket and keeps working (slower) if the socket can't connect. Returns { data, reload }.
  function useSnapshot(path, fetcher, deps, pollMs) {
    const { useState } = React;
    const [data, setData] = useState(null);
    useSocket(path, (d) => { if (d != null) setData(d); }, deps);
    const poll = usePoll(async () => {
      const d = await fetcher();
      if (d != null) setData(d);
      return d;
    }, deps, pollMs || 6000);
    return { data, reload: poll.reload };
  }

  window.BW_API = API;
  window.useBWPoll = usePoll;
  window.useBWSocket = useSocket;
  window.useBWSnapshot = useSnapshot;
})();

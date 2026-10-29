// ============================================================
//  Integrations & Configuration — ONE page, four provider tabs.
//  Google Drive Storage is fully wired this pass; Timer/MQTT,
//  Camera/RTSP and WhatsApp are HONEST placeholders (read-only
//  live status, no fake save/test).
//
//  SECURITY: secrets are configured backend-only. The UI never
//  receives a raw secret — only masked values + a service-account
//  identity summary — and never stores a credential in localStorage.
// ============================================================
const { useState: useICS, useEffect: useICE, useCallback: useICC } = React;

const INTG_TABS = [
  { id: 'google_drive', label: 'Google Drive Storage', icon: 'upload' },
  { id: 'mqtt_timer',  label: 'Bay Timers & MQTT',     icon: 'clock' },
  { id: 'camera',      label: 'Bay Cameras & RTSP',    icon: 'cam' },
  { id: 'whatsapp',    label: 'WhatsApp',              icon: 'bell' },
];

// Each provider tab now holds BOTH its global config (collapsible) AND the per-bay
// device registry: Bay Timers & MQTT = broker settings + per-bay timer pairing;
// Bay Cameras & RTSP = capture defaults + per-bay camera pairing. (The former
// standalone "Bay Device Connections" tab was merged in — one place per device type.)
const INTG_NAV = INTG_TABS;

const intgPill = (s) => ({
  active:         { cls: 'ok',     label: 'Active' },
  dormant:        { cls: 'warn',   label: 'Configured · dormant' },
  failed:         { cls: 'danger', label: 'Failed' },
  not_configured: { cls: 'ghost',  label: 'Not configured' },
}[s] || { cls: 'ghost', label: 'Not configured' });

// ── status cards (one per provider) ─────────────────────────────────
const IntgStatusCards = ({ providers, active, onPick }) => (
  <div className="intg-cards">
    {INTG_TABS.map((t) => {
      const p = (providers || []).find((x) => x.provider === t.id) || { status: 'not_configured' };
      const st = intgPill(p.status);
      return (
        <button key={t.id} className={`intg-card ${active === t.id ? 'active' : ''}`} onClick={() => onPick(t.id)}>
          <div className="intg-card-top"><Icon name={t.icon} size={15}/><span>{t.label}</span></div>
          <div className={`intg-pill ${st.cls}`}><span className="dot"/>{st.label}</div>
          <div className="intg-card-meta">
            {p.configured ? 'Configured' : 'Not configured'}{p.enabled ? ' · enabled' : ''}
            {p.last_success_at ? ' · ✓ tested' : (p.last_tested_at ? ' · tested' : '')}
          </div>
          {p.last_error && <div className="intg-card-err" title={p.last_error}>{p.last_error}</div>}
        </button>
      );
    })}
  </div>
);

// ── small labelled field wrapper ────────────────────────────────────
const IntgField = ({ label, hint, children }) => (
  <div className="intg-field">
    <label className="intg-label">{label}{hint && <span className="intg-hint">{hint}</span>}</label>
    {children}
  </div>
);

const IntgToggle = ({ label, on, onChange, hint }) => (
  <button type="button" className={`intg-toggle ${on ? 'on' : ''}`} onClick={() => onChange(!on)}>
    <span className="intg-knob"/>
    <span className="intg-toggle-txt">{label}{hint && <em>{hint}</em>}</span>
  </button>
);

// ── Google Drive tab (fully working) ────────────────────────────────
const GoogleDriveConfigTab = ({ onChanged }) => {
  const [cfg, setCfg] = useICS(null);
  const [store, setStore] = useICS(null);
  const [form, setForm] = useICS({
    folder_id: '', retention_days: 14, sync_interval_hours: 6,
    delete_local_after_upload: true, keep_local_until_verified: true, enabled: false,
  });
  const [creds, setCreds] = useICS('');            // only sent when non-empty
  const [credsMode, setCredsMode] = useICS('edit'); // 'edit' | 'saved'
  const [testResult, setTestResult] = useICS(null); // structured Verify/Test result
  const [busy, setBusy] = useICS('');
  const [msg, setMsg] = useICS(null);
  const flash = (kind, text) => { setMsg({ kind, text }); if (kind === 'ok') setTimeout(() => setMsg(null), 4000); };
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const load = useICC(async () => {
    try {
      const d = await BW_API.getIntegration('google_drive');
      setCfg(d);
      setForm({
        folder_id: d.folder_id || '',
        retention_days: d.retention_days != null ? d.retention_days : 14,
        sync_interval_hours: d.sync_interval_hours != null ? d.sync_interval_hours : 6,
        delete_local_after_upload: d.delete_local_after_upload !== false,
        keep_local_until_verified: d.keep_local_until_verified !== false,
        enabled: !!d.enabled,
      });
      const credSet = d.secrets && d.secrets.credentials_json && d.secrets.credentials_json.set;
      setCredsMode(credSet ? 'saved' : 'edit');
      setCreds('');
    } catch (e) { flash('err', e.message || 'Failed to load configuration'); }
  }, []);
  const loadStore = useICC(async () => { try { setStore(await BW_API.storageOverview()); } catch (e) {} }, []);
  useICE(() => { load(); loadStore(); }, [load, loadStore]);

  const onUpload = (file) => {
    const r = new FileReader();
    r.onload = () => { setCreds(String(r.result || '')); setCredsMode('edit'); };
    r.readAsText(file);
  };

  const save = async () => {
    if (!form.folder_id.trim()) { flash('err', 'A destination Drive Folder ID is required.'); return; }
    setBusy('save'); setMsg(null);
    try {
      await BW_API.saveIntegration('google_drive', {
        config: {
          folder_id: form.folder_id.trim(),
          retention_days: Number(form.retention_days) || 14,
          sync_interval_hours: Number(form.sync_interval_hours) || 6,
          delete_local_after_upload: !!form.delete_local_after_upload,
          keep_local_until_verified: !!form.keep_local_until_verified,
          enabled: !!form.enabled,
        },
        secrets: { credentials_json: credsMode === 'edit' ? creds.trim() : '' },
      });
      flash('ok', 'Saved — Google Drive configuration is live (no restart needed).');
      await load(); loadStore(); onChanged && onChanged();
    } catch (e) { flash('err', e.message || 'Save failed'); }
    finally { setBusy(''); }
  };

  const test = async () => {
    const ready = !!(cfg && cfg.folder_id && cfg.secrets && cfg.secrets.credentials_json && cfg.secrets.credentials_json.set);
    if (!ready) { flash('err', 'Paste a Folder ID + service-account JSON and click Save before verifying.'); return; }
    setBusy('test'); setMsg(null);
    try {
      const d = await BW_API.testIntegration('google_drive');
      setTestResult(d || null);
      const okk = !!(d && d.reachable && d.folder_writable);
      flash(okk ? 'ok' : 'err', (d && d.detail) || (okk ? 'Connected · folder writable' : 'Drive verify failed'));
      load(); onChanged && onChanged();
    } catch (e) { flash('err', e.message || 'Verify failed'); }
    finally { setBusy(''); }
  };

  const sync = async () => {
    if (!(cfg && cfg.configured)) { flash('err', "Google Drive isn't enabled yet — Save, Verify folder writable, then turn on Enable Drive archival."); return; }
    const pending = (store && store.counts && store.counts.pending) || 0;
    if (!pending) { flash('ok', 'No pending recordings to upload yet.'); return; }
    setBusy('sync'); setMsg(null);
    try {
      const r = await BW_API.driveSyncNow();
      const notConfigured = r && r.data && r.data.configured === false;
      flash(notConfigured ? 'err' : 'ok',
        notConfigured ? ((r && r.message) || 'Google Drive is not configured.')
                      : `Sync started · ${pending} pending recording(s). Refreshing status…`);
      setTimeout(loadStore, 1600);
    } catch (e) { flash('err', e.message || 'Sync failed'); }
    finally { setBusy(''); }
  };

  const disconnect = async () => {
    if (!window.confirm('Disconnect Google Drive?\n\nThis removes the stored service-account credentials and turns archival OFF. Recordings and already-uploaded Drive files are NOT deleted.')) return;
    setBusy('disconnect'); setMsg(null);
    try {
      await BW_API.driveDisconnect();
      setTestResult(null);
      flash('ok', 'Disconnected — credentials removed, archival off. Recordings kept.');
      await load(); loadStore(); onChanged && onChanged();
    } catch (e) { flash('err', e.message || 'Disconnect failed'); }
    finally { setBusy(''); }
  };

  const meta = (cfg && cfg.meta) || {};
  const st = intgPill(cfg ? cfg.status : 'not_configured');
  const configured = !!(cfg && cfg.configured);
  const counts = (store && store.counts) || {};
  const credSummary = cfg && cfg.credentials_summary;
  const fmt = (iso) => { if (!iso) return '—'; try { return new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (e) { return iso; } };

  // ── service-account connection model (a SHARED FOLDER, not OAuth login) ──
  const hasCreds = !!(cfg && cfg.secrets && cfg.secrets.credentials_json && cfg.secrets.credentials_json.set);
  const account = (testResult && testResult.account) || (credSummary && credSummary.client_email) || null;
  const projectId = (testResult && testResult.project_id) || (credSummary && credSummary.project_id) || null;
  const folderShort = (testResult && testResult.folder_id)
    || (form.folder_id ? (form.folder_id.length > 12 ? form.folder_id.slice(0, 6) + '…' + form.folder_id.slice(-4) : form.folder_id) : null);
  const folderWritable = testResult ? testResult.folder_writable : (meta.last_success_at ? true : null);
  const connState = !hasCreds ? 'not_configured'
    : folderWritable === true ? 'connected'
    : folderWritable === false ? 'permission' : 'pending';
  const connPill = {
    not_configured: { cls: 'ghost', label: 'Not connected' },
    connected:      { cls: 'ok', label: 'Connected' },
    permission:     { cls: 'danger', label: 'Folder not shared' },
    pending:        { cls: 'warn', label: 'Verify needed' },
  }[connState];
  const savedReady = !!(hasCreds && cfg && cfg.folder_id);
  const todayStr = new Date().toISOString().slice(0, 10);
  // connect → sync workflow progress (drives the numbered strip's active step)
  const verified = !!(meta.last_success_at || (testResult && testResult.folder_writable));
  const enabled = !!(cfg && cfg.enabled);
  const doneThrough = !hasCreds ? 0 : (verified && enabled) ? 6 : verified ? 4 : 3;
  const flowActive = doneThrough + 1;

  return (
    <div className="intg-grid">
      <div className="card intg-form-card">
        <div className="card-head"><span className="eyebrow eyebrow-amber">● GOOGLE DRIVE ARCHIVAL</span>
          <span className={`intg-pill ${st.cls}`}><span className="dot"/>{st.label}</span></div>

        {/* Numbered connect → sync workflow (where to click), current step highlighted */}
        <div className="drv-flow">
          {['Paste Folder ID', 'Upload / Paste JSON', 'Save', 'Verify / Test', 'Enable archival', 'Save', 'Complete a recording', 'Sync Now'].map((label, idx) => {
            const n = idx + 1;
            const cls = n <= doneThrough ? 'done' : n === flowActive ? 'active' : 'todo';
            return (
              <div key={n} className={`drv-flow-step ${cls}`}>
                <span className="drv-flow-n">{n <= doneThrough ? '✓' : n}</span><span className="drv-flow-l">{label}</span>
              </div>
            );
          })}
        </div>

        {/* Service-account connection — a Drive folder shared with the app, not a Gmail login */}
        <div className={`drv-conn ${connState}`}>
          <div className="drv-conn-head">
            <span className={`intg-pill ${connPill.cls}`}><span className="dot"/>{connPill.label}</span>
            {hasCreds && (
              <button className="btn btn-xs btn-ghost drv-disc" disabled={busy === 'disconnect'} onClick={disconnect}>
                <Icon name="x" size={11}/> {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
              </button>
            )}
          </div>
          {hasCreds ? (
            <div className="drv-conn-grid">
              <div className="drv-conn-row"><span>Service account</span><b className="mono drv-acct" title={account || ''}>{account || '—'}</b></div>
              <div className="drv-conn-row"><span>Project</span><b className="mono">{projectId || '—'}</b></div>
              <div className="drv-conn-row"><span>Destination folder</span><b className="mono">{folderShort || '—'}</b></div>
              <div className="drv-conn-row"><span>Folder writable</span>
                <b className={folderWritable === true ? 'ok' : folderWritable === false ? 'danger' : 't3'}>
                  {folderWritable === true ? 'Yes' : folderWritable === false ? 'No · share folder' : 'Run Verify'}</b></div>
              <div className="drv-conn-row"><span>Last verified</span><b>{fmt(meta.last_success_at)}</b></div>
            </div>
          ) : (
            <div className="drv-conn-empty">Not connected. Add a service-account JSON + destination folder below, Save, then Verify.</div>
          )}
          {hasCreds && account && folderWritable !== true && (
            <div className="drv-share"><Icon name="alert" size={12}/> Share your Drive folder with <b className="mono">{account}</b> as <b>Editor</b>, then Verify.</div>
          )}
        </div>

        {/* How to connect (service-account model, step by step) */}
        <details className="drv-steps">
          <summary><Icon name="route" size={12}/> How to connect Google Drive</summary>
          <ol>
            <li>Create a Drive folder (e.g. <b>Baywatch Recordings</b>) and copy its <b>Folder ID</b> from the URL.</li>
            <li>In Google Cloud, create a <b>Service Account</b> and enable the <b>Google Drive API</b>.</li>
            <li>Download the service-account <b>JSON key</b>.</li>
            <li><b>Share</b> your Drive folder with the service-account email as <b>Editor</b>.</li>
            <li>Paste the Folder ID + JSON below → <b>Save</b> → <b>Verify</b>.</li>
          </ol>
        </details>

        <IntgToggle label="Enable Drive archival" on={form.enabled} onChange={(v) => set('enabled', v)}
          hint="when on + configured, finished recordings upload automatically"/>

        <IntgField label="Destination Folder ID" hint="Drive folder the service account can write to">
          <input className="intg-input" placeholder="1A2b3C…folder id" value={form.folder_id} onChange={(e) => set('folder_id', e.target.value)}/>
        </IntgField>

        <IntgField label="Service-account credentials (JSON)" hint="encrypted at rest · never shown again">
          {credsMode === 'saved' ? (
            <div className="intg-cred-saved">
              <Icon name="check" size={14}/>
              <div className="intg-cred-body">
                <div className="intg-cred-acct">{credSummary ? credSummary.client_email : 'Service account stored'}</div>
                <div className="intg-cred-sub">{credSummary ? `Project: ${credSummary.project_id || '—'}` : 'Encrypted · stored securely'}</div>
              </div>
              <button className="btn btn-sm btn-ghost" onClick={() => { setCredsMode('edit'); setCreds(''); }}>Replace</button>
            </div>
          ) : (
            <>
              <textarea className="intg-textarea" rows={5} spellCheck={false}
                placeholder='Paste service-account JSON: { "type": "service_account", "private_key": …, "client_email": … }'
                value={creds} onChange={(e) => setCreds(e.target.value)}/>
              <div className="intg-row">
                <label className="btn btn-sm btn-ghost intg-file"><Icon name="upload" size={12}/> Upload .json
                  <input type="file" accept="application/json,.json" hidden onChange={(e) => e.target.files[0] && onUpload(e.target.files[0])}/>
                </label>
                {cfg && cfg.secrets && cfg.secrets.credentials_json && cfg.secrets.credentials_json.set &&
                  <button className="btn btn-sm btn-ghost" onClick={() => { setCredsMode('saved'); setCreds(''); }}>Keep existing</button>}
              </div>
            </>
          )}
        </IntgField>

        <div className="drv-path">
          <span className="drv-path-l">Archives to</span>
          <code className="drv-path-v">{folderShort || '‹root›'} / {todayStr} / Bay-01 / A_Krishnan_18-55_Triumph-Speed-400_JOB-1024.mp4</code>
        </div>

        <div className="intg-two">
          <IntgField label="Retention (days)"><input type="number" min="1" className="intg-input" value={form.retention_days} onChange={(e) => set('retention_days', e.target.value)}/></IntgField>
          <IntgField label="Sync interval (hours)"><input type="number" min="1" className="intg-input" value={form.sync_interval_hours} onChange={(e) => set('sync_interval_hours', e.target.value)}/></IntgField>
        </div>

        <IntgToggle label="Delete local copy after a verified upload" on={form.delete_local_after_upload} onChange={(v) => set('delete_local_after_upload', v)}/>
        <IntgToggle label="Keep local until upload size is verified" on={form.keep_local_until_verified} onChange={(v) => set('keep_local_until_verified', v)}/>

        {msg && <div className={`intg-msg ${msg.kind}`}><Icon name={msg.kind === 'ok' ? 'check' : 'alert'} size={13}/><span>{msg.text}</span></div>}

        <div className="intg-actions">
          <button className="btn btn-amber btn-sm" disabled={busy === 'save'} onClick={save}><Icon name="check" size={13}/> {busy === 'save' ? 'Saving…' : 'Save'}</button>
          <button className="btn btn-ghost btn-sm" disabled={busy === 'test'} title="Verify the saved service account + destination folder" onClick={test}><Icon name="route" size={13}/> {busy === 'test' ? 'Verifying…' : 'Verify / Test'}</button>
          <button className="btn btn-ghost btn-sm" disabled={busy === 'sync'} title="Upload pending recordings to Drive now" onClick={sync}><Icon name="arrow-up" size={13}/> {busy === 'sync' ? 'Syncing…' : 'Sync Now'}</button>
          {form.enabled && <button className="btn btn-ghost btn-sm intg-danger" disabled={busy === 'save'} onClick={() => { set('enabled', false); setTimeout(save, 0); }}>Disable archival</button>}
        </div>

        {testResult && (
          <div className={`drv-verify ${testResult.reachable && testResult.folder_writable ? 'ok' : 'err'}`}>
            <div className="drv-verify-head">VERIFY RESULT</div>
            <div className={`drv-verify-row ${testResult.reachable ? 'ok' : 'err'}`}><Icon name={testResult.reachable ? 'check' : 'alert'} size={12}/> Service account reachable</div>
            <div className={`drv-verify-row ${testResult.folder_writable ? 'ok' : 'err'}`}><Icon name={testResult.folder_writable ? 'check' : 'alert'} size={12}/> Destination folder writable</div>
            {testResult.detail && <div className="drv-verify-detail">{testResult.detail}</div>}
          </div>
        )}

        <div className="intg-secnote"><Icon name="shield" size={12}/> Service-account model — your Drive folder is shared with the app's service account (no Gmail login). Credentials are encrypted at rest and never returned to this screen; a blank credentials box on Save keeps the stored key.</div>
      </div>

      <div className="card intg-status-card">
        <div className="card-head"><span className="eyebrow eyebrow-amber">STATUS</span></div>
        <div className="intg-status-row"><span>State</span><span className={`intg-pill ${st.cls}`}><span className="dot"/>{st.label}</span></div>
        <div className="intg-status-row"><span>Configured</span><b>{configured ? 'Yes' : 'No'}</b></div>
        <div className="intg-status-row"><span>Archival enabled</span><b>{cfg && cfg.enabled ? 'On' : 'Off'}</b></div>
        <div className="intg-status-row"><span>Service account</span><b className="mono drv-acct" title={account || ''}>{account || '—'}</b></div>
        <div className="intg-status-row"><span>Folder writable</span><b className={folderWritable === true ? 'ok' : folderWritable === false ? 'danger' : ''}>{folderWritable === true ? 'Yes' : folderWritable === false ? 'No' : '—'}</b></div>
        <div className="intg-status-row"><span>Last tested</span><b>{fmt(meta.last_tested_at)}</b></div>
        <div className="intg-status-row"><span>Last success</span><b>{fmt(meta.last_success_at)}</b></div>
        {meta.last_error && <div className="intg-status-err"><Icon name="alert" size={12}/> {meta.last_error}</div>}
        <div className="intg-status-sep">STORAGE</div>
        <div className="intg-counts">
          <div className="intg-count"><b className="warn">{counts.pending || 0}</b><span>Pending</span></div>
          <div className="intg-count"><b className="danger">{counts.failed || 0}</b><span>Failed</span></div>
          <div className="intg-count"><b className="ok">{counts.archived || 0}</b><span>Archived</span></div>
          <div className="intg-count"><b className="t3">{counts.expired || 0}</b><span>Expired</span></div>
        </div>
        <div className="intg-secnote">Counts mirror Storage Management. Sync Now and Test here update the same pipeline.</div>
      </div>
    </div>
  );
};

// ── WhatsApp tab (fully working) ────────────────────────────────────
const WhatsAppConfigTab = ({ onChanged }) => {
  const [cfg, setCfg] = useICS(null);
  const [form, setForm] = useICS({
    business_account_id: '', phone_number_id: '', api_version: 'v21.0', default_country_code: '91',
    live_template_name: 'service_live_link', live_template_lang: 'en',
    approval_template_name: 'service_estimate_approval', approval_template_lang: 'en',
    test_recipient: '', enabled: false,
  });
  const [token, setToken] = useICS('');               // only sent when non-empty
  const [tokenMode, setTokenMode] = useICS('edit');   // 'edit' | 'saved'
  const [busy, setBusy] = useICS('');
  const [msg, setMsg] = useICS(null);
  const flash = (kind, text) => { setMsg({ kind, text }); if (kind === 'ok') setTimeout(() => setMsg(null), 4000); };
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const load = useICC(async () => {
    try {
      const d = await BW_API.getIntegration('whatsapp');
      setCfg(d);
      setForm({
        business_account_id: d.business_account_id || '',
        phone_number_id: d.phone_number_id || '',
        api_version: d.api_version || 'v21.0',
        default_country_code: d.default_country_code || '91',
        live_template_name: d.live_template_name || 'service_live_link',
        live_template_lang: d.live_template_lang || 'en',
        approval_template_name: d.approval_template_name || 'service_estimate_approval',
        approval_template_lang: d.approval_template_lang || 'en',
        test_recipient: d.test_recipient || '',
        enabled: !!d.enabled,
      });
      const set_ = d.secrets && d.secrets.access_token && d.secrets.access_token.set;
      setTokenMode(set_ ? 'saved' : 'edit');
      setToken('');
    } catch (e) { flash('err', e.message || 'Failed to load configuration'); }
  }, []);
  useICE(() => { load(); }, [load]);

  const save = async () => {
    if (!form.phone_number_id.trim()) { flash('err', 'Phone Number ID is required.'); return; }
    if (tokenMode === 'edit' && !token.trim() && !(cfg && cfg.secrets.access_token.set)) {
      flash('err', 'An access token is required to enable WhatsApp.'); return;
    }
    setBusy('save'); setMsg(null);
    try {
      await BW_API.saveIntegration('whatsapp', {
        config: {
          business_account_id: form.business_account_id.trim(),
          phone_number_id: form.phone_number_id.trim(),
          api_version: form.api_version.trim() || 'v21.0',
          default_country_code: String(form.default_country_code).trim() || '91',
          live_template_name: form.live_template_name.trim() || 'service_live_link',
          live_template_lang: form.live_template_lang.trim() || 'en',
          approval_template_name: form.approval_template_name.trim() || 'service_estimate_approval',
          approval_template_lang: form.approval_template_lang.trim() || 'en',
          test_recipient: form.test_recipient.trim(),
          enabled: !!form.enabled,
        },
        secrets: { access_token: tokenMode === 'edit' ? token.trim() : '' },
      });
      flash('ok', 'Saved — WhatsApp configuration is live (no restart needed).');
      await load(); onChanged && onChanged();
    } catch (e) { flash('err', e.message || 'Save failed'); }
    finally { setBusy(''); }
  };

  const test = async () => {
    setBusy('test'); setMsg(null);
    try {
      const d = await BW_API.testIntegration('whatsapp');
      flash(d && d.reachable ? 'ok' : 'err', (d && d.detail) || (d && d.reachable ? 'Connected' : 'WhatsApp test failed'));
      load(); onChanged && onChanged();
    } catch (e) { flash('err', e.message || 'Test failed'); }
    finally { setBusy(''); }
  };

  const meta = (cfg && cfg.meta) || {};
  const st = intgPill(cfg ? cfg.status : 'not_configured');
  const configured = !!(cfg && cfg.configured);
  const tokenSet = !!(cfg && cfg.secrets && cfg.secrets.access_token && cfg.secrets.access_token.set);
  const fmt = (iso) => { if (!iso) return '—'; try { return new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (e) { return iso; } };

  return (
    <div className="intg-grid">
      <div className="card intg-form-card">
        <div className="card-head"><span className="eyebrow eyebrow-amber">● WHATSAPP CLOUD API</span>
          <span className={`intg-pill ${st.cls}`}><span className="dot"/>{st.label}</span></div>

        <IntgToggle label="Enable WhatsApp auto-send" on={form.enabled} onChange={(v) => set('enabled', v)}
          hint="sends Live Watch / approval links automatically; Copy-Link always works regardless"/>

        <div className="intg-two">
          <IntgField label="Business Account ID" hint="Meta WABA id">
            <input className="intg-input" placeholder="WABA id (optional)" value={form.business_account_id} onChange={(e) => set('business_account_id', e.target.value)}/>
          </IntgField>
          <IntgField label="Phone Number ID" hint="Meta phone_number_id">
            <input className="intg-input" placeholder="1059xxxxxxxxxxx" value={form.phone_number_id} onChange={(e) => set('phone_number_id', e.target.value)}/>
          </IntgField>
        </div>

        <IntgField label="Access token" hint="permanent system-user token · encrypted, never shown again">
          {tokenMode === 'saved' ? (
            <div className="intg-cred-saved">
              <Icon name="check" size={14}/>
              <div className="intg-cred-body">
                <div className="intg-cred-acct">Access token stored</div>
                <div className="intg-cred-sub">{(cfg && cfg.secrets.access_token.masked) || 'Encrypted · stored securely'}</div>
              </div>
              <button className="btn btn-sm btn-ghost" onClick={() => { setTokenMode('edit'); setToken(''); }}>Replace</button>
            </div>
          ) : (
            <div className="intg-row" style={{ marginTop: 0 }}>
              <input className="intg-input" type="password" autoComplete="off" placeholder="EAAG… permanent token"
                value={token} onChange={(e) => setToken(e.target.value)}/>
              {tokenSet && <button className="btn btn-sm btn-ghost" onClick={() => { setTokenMode('saved'); setToken(''); }}>Keep existing</button>}
            </div>
          )}
        </IntgField>

        <div className="intg-two">
          <IntgField label="Graph API version"><input className="intg-input" value={form.api_version} onChange={(e) => set('api_version', e.target.value)}/></IntgField>
          <IntgField label="Default country code"><input className="intg-input" value={form.default_country_code} onChange={(e) => set('default_country_code', e.target.value)}/></IntgField>
        </div>

        <div className="intg-sub">LIVE WATCH LINK TEMPLATE</div>
        <div className="intg-two">
          <IntgField label="Template name"><input className="intg-input" value={form.live_template_name} onChange={(e) => set('live_template_name', e.target.value)}/></IntgField>
          <IntgField label="Template language"><input className="intg-input" value={form.live_template_lang} onChange={(e) => set('live_template_lang', e.target.value)}/></IntgField>
        </div>

        <div className="intg-sub">ESTIMATE APPROVAL LINK TEMPLATE</div>
        <div className="intg-two">
          <IntgField label="Template name"><input className="intg-input" value={form.approval_template_name} onChange={(e) => set('approval_template_name', e.target.value)}/></IntgField>
          <IntgField label="Template language"><input className="intg-input" value={form.approval_template_lang} onChange={(e) => set('approval_template_lang', e.target.value)}/></IntgField>
        </div>

        <IntgField label="Test recipient phone" hint="optional · used for a test message later">
          <input className="intg-input" placeholder="e.g. 9876543210" value={form.test_recipient} onChange={(e) => set('test_recipient', e.target.value)}/>
        </IntgField>

        {msg && <div className={`intg-msg ${msg.kind}`}><Icon name={msg.kind === 'ok' ? 'check' : 'alert'} size={13}/><span>{msg.text}</span></div>}

        <div className="intg-actions">
          <button className="btn btn-amber btn-sm" disabled={busy === 'save'} onClick={save}><Icon name="check" size={13}/> {busy === 'save' ? 'Saving…' : 'Save'}</button>
          <button className="btn btn-ghost btn-sm" disabled={busy === 'test' || !configured} title={configured ? 'Probe the WhatsApp number with this token' : 'Save a phone number id + token first'} onClick={test}><Icon name="route" size={13}/> {busy === 'test' ? 'Testing…' : 'Test connection'}</button>
          {form.enabled && <button className="btn btn-ghost btn-sm intg-danger" disabled={busy === 'save'} onClick={() => { set('enabled', false); setTimeout(save, 0); }}>Disable auto-send</button>}
        </div>
        <div className="intg-secnote"><Icon name="shield" size={12}/> The access token is encrypted at rest and never returned to this screen. A blank token box on Save keeps the stored token.</div>
      </div>

      <div className="card intg-status-card">
        <div className="card-head"><span className="eyebrow eyebrow-amber">STATUS</span></div>
        <div className="intg-status-row"><span>State</span><span className={`intg-pill ${st.cls}`}><span className="dot"/>{st.label}</span></div>
        <div className="intg-status-row"><span>Configured</span><b>{configured ? 'Yes' : 'No'}</b></div>
        <div className="intg-status-row"><span>Auto-send enabled</span><b>{cfg && cfg.enabled ? 'On' : 'Off'}</b></div>
        <div className="intg-status-row"><span>Last tested</span><b>{fmt(meta.last_tested_at)}</b></div>
        <div className="intg-status-row"><span>Last success</span><b>{fmt(meta.last_success_at)}</b></div>
        {meta.last_error && <div className="intg-status-err"><Icon name="alert" size={12}/> {meta.last_error}</div>}
        <div className="intg-status-sep">USED BY</div>
        <div className="intg-secnote">Customer Live Watch and Estimate Approval send their temporary links through this configuration. When off/unconfigured, the admin's Copy-Link path still works.</div>
      </div>
    </div>
  );
};

// ── Camera / RTSP tab (fully working) ───────────────────────────────
const CameraConfigTab = ({ onChanged }) => {
  const [cfg, setCfg] = useICS(null);
  const [form, setForm] = useICS({
    protocol: 'rtsp', rtsp_transport: 'tcp', default_rtsp_path: '/Streaming/Channels/101',
    connection_timeout: 10, reconnect_attempts: 3, reconnect_backoff: 5,
    snapshot_enabled: true, probe_snapshot_enabled: true, recording_resolution: '1280x720', fps: 15,
    ffmpeg_path: '', ffmpeg_input_flags: '', default_username: '',
    test_rtsp_url: '', test_camera_ip: '', test_port: 554, enabled: false,
  });
  const [pwd, setPwd] = useICS('');                 // only sent when non-empty
  const [pwdMode, setPwdMode] = useICS('edit');     // 'edit' | 'saved'
  const [busy, setBusy] = useICS('');
  const [msg, setMsg] = useICS(null);
  const flash = (kind, text) => { setMsg({ kind, text }); if (kind === 'ok') setTimeout(() => setMsg(null), 4000); };
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const load = useICC(async () => {
    try {
      const d = await BW_API.getIntegration('camera');
      setCfg(d);
      setForm({
        protocol: d.protocol || 'rtsp',
        rtsp_transport: d.rtsp_transport || 'tcp',
        default_rtsp_path: d.default_rtsp_path || '/Streaming/Channels/101',
        connection_timeout: d.connection_timeout != null ? d.connection_timeout : 10,
        reconnect_attempts: d.reconnect_attempts != null ? d.reconnect_attempts : 3,
        reconnect_backoff: d.reconnect_backoff != null ? d.reconnect_backoff : 5,
        snapshot_enabled: d.snapshot_enabled !== false,
        probe_snapshot_enabled: d.probe_snapshot_enabled !== false,
        recording_resolution: d.recording_resolution || '1280x720',
        fps: d.fps != null ? d.fps : 15,
        ffmpeg_path: d.ffmpeg_path || '',
        ffmpeg_input_flags: d.ffmpeg_input_flags || '',
        default_username: d.default_username || '',
        test_rtsp_url: d.test_rtsp_url || '',
        test_camera_ip: d.test_camera_ip || '',
        test_port: d.test_port != null ? d.test_port : 554,
        enabled: !!d.enabled,
      });
      const set_ = d.secrets && d.secrets.default_password && d.secrets.default_password.set;
      setPwdMode(set_ ? 'saved' : 'edit');
      setPwd('');
    } catch (e) { flash('err', e.message || 'Failed to load configuration'); }
  }, []);
  useICE(() => { load(); }, [load]);

  const save = async () => {
    setBusy('save'); setMsg(null);
    try {
      await BW_API.saveIntegration('camera', {
        config: {
          protocol: form.protocol, rtsp_transport: form.rtsp_transport,
          default_rtsp_path: form.default_rtsp_path.trim(),
          connection_timeout: Number(form.connection_timeout) || 10,
          reconnect_attempts: Number(form.reconnect_attempts) || 0,
          reconnect_backoff: Number(form.reconnect_backoff) || 0,
          snapshot_enabled: !!form.snapshot_enabled,
          probe_snapshot_enabled: !!form.probe_snapshot_enabled,
          recording_resolution: form.recording_resolution.trim() || '1280x720',
          fps: Number(form.fps) || 15,
          ffmpeg_path: form.ffmpeg_path.trim(),
          ffmpeg_input_flags: form.ffmpeg_input_flags.trim(),
          default_username: form.default_username.trim(),
          test_rtsp_url: form.test_rtsp_url.trim(),
          test_camera_ip: form.test_camera_ip.trim(),
          test_port: Number(form.test_port) || 554,
          enabled: !!form.enabled,
        },
        secrets: { default_password: pwdMode === 'edit' ? pwd.trim() : '' },
      });
      flash('ok', 'Saved — camera capture defaults are live (no restart needed).');
      await load(); onChanged && onChanged();
    } catch (e) { flash('err', e.message || 'Save failed'); }
    finally { setBusy(''); }
  };

  const test = async () => {
    setBusy('test'); setMsg(null);
    try {
      const d = await BW_API.testIntegration('camera');
      flash(d && d.reachable ? 'ok' : 'err', (d && d.detail) || (d && d.reachable ? 'Reachable' : 'Camera test failed'));
      load(); onChanged && onChanged();
    } catch (e) { flash('err', e.message || 'Test failed'); }
    finally { setBusy(''); }
  };

  const meta = (cfg && cfg.meta) || {};
  const st = intgPill(cfg ? cfg.status : 'not_configured');
  const canTest = !!(cfg && (cfg.test_rtsp_url || cfg.test_camera_ip));
  const fmt = (iso) => { if (!iso) return '—'; try { return new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (e) { return iso; } };

  // Capture defaults demoted to a collapsible section; per-bay camera pairing is the
  // primary view below. The in-tab "Configure" button opens it via event.
  const [cfgOpen, setCfgOpen] = useICS(false);
  useICE(() => {
    const h = () => setCfgOpen(true);
    window.addEventListener('bw:camera-open-config', h);
    return () => window.removeEventListener('bw:camera-open-config', h);
  }, []);

  return (
    <div className="intg-merged">
      <details className="intg-collapse" open={cfgOpen} onToggle={(e) => setCfgOpen(e.currentTarget.open)}>
        <summary className="intg-collapse-head">
          <span className="intg-collapse-title"><Icon name="cog" size={14}/> Camera / RTSP capture defaults</span>
          <span className={`intg-pill ${st.cls}`}><span className="dot"/>{st.label}</span>
        </summary>
        <div className="intg-collapse-body">
    <div className="intg-grid">
      <div className="card intg-form-card">
        <div className="card-head"><span className="eyebrow eyebrow-amber">● CAMERA / RTSP CAPTURE DEFAULTS</span>
          <span className={`intg-pill ${st.cls}`}><span className="dot"/>{st.label}</span></div>
        <div className="intg-secnote"><Icon name="cam" size={12}/> Branch-wide defaults. Per-bay RTSP URLs stay in the Camera Connection registry — these fill gaps and drive the connection test.</div>

        <IntgToggle label="Enable camera capture defaults" on={form.enabled} onChange={(v) => set('enabled', v)}/>

        <div className="intg-two">
          <IntgField label="Default protocol">
            <select className="intg-input" value={form.protocol} onChange={(e) => set('protocol', e.target.value)}>
              <option value="rtsp">RTSP</option><option value="onvif">ONVIF</option>
            </select>
          </IntgField>
          <IntgField label="RTSP transport">
            <select className="intg-input" value={form.rtsp_transport} onChange={(e) => set('rtsp_transport', e.target.value)}>
              <option value="tcp">TCP</option><option value="udp">UDP</option>
            </select>
          </IntgField>
        </div>

        <IntgField label="Default RTSP path"><input className="intg-input" value={form.default_rtsp_path} onChange={(e) => set('default_rtsp_path', e.target.value)}/></IntgField>

        <div className="intg-two">
          <IntgField label="Connection timeout (s)"><input type="number" min="1" className="intg-input" value={form.connection_timeout} onChange={(e) => set('connection_timeout', e.target.value)}/></IntgField>
          <IntgField label="Reconnect attempts"><input type="number" min="0" className="intg-input" value={form.reconnect_attempts} onChange={(e) => set('reconnect_attempts', e.target.value)}/></IntgField>
        </div>
        <div className="intg-two">
          <IntgField label="Reconnect backoff (s)"><input type="number" min="0" className="intg-input" value={form.reconnect_backoff} onChange={(e) => set('reconnect_backoff', e.target.value)}/></IntgField>
          <IntgField label="Recording resolution"><input className="intg-input" value={form.recording_resolution} onChange={(e) => set('recording_resolution', e.target.value)}/></IntgField>
        </div>
        <div className="intg-two">
          <IntgField label="FPS"><input type="number" min="1" className="intg-input" value={form.fps} onChange={(e) => set('fps', e.target.value)}/></IntgField>
          <IntgField label="FFmpeg path" hint="blank → system ffmpeg"><input className="intg-input" placeholder="/usr/bin/ffmpeg" value={form.ffmpeg_path} onChange={(e) => set('ffmpeg_path', e.target.value)}/></IntgField>
        </div>
        <IntgField label="FFmpeg input flags"><input className="intg-input" placeholder="e.g. -fflags nobuffer" value={form.ffmpeg_input_flags} onChange={(e) => set('ffmpeg_input_flags', e.target.value)}/></IntgField>

        <IntgToggle label="Snapshot enabled" on={form.snapshot_enabled} onChange={(v) => set('snapshot_enabled', v)}/>
        <IntgToggle label="Probe snapshot enabled" on={form.probe_snapshot_enabled} onChange={(v) => set('probe_snapshot_enabled', v)}/>

        <div className="intg-sub">DEFAULT CAMERA LOGIN</div>
        <div className="intg-two">
          <IntgField label="Default username"><input className="intg-input" autoComplete="off" value={form.default_username} onChange={(e) => set('default_username', e.target.value)}/></IntgField>
          <IntgField label="Default password" hint="encrypted · never shown again">
            {pwdMode === 'saved' ? (
              <div className="intg-cred-saved">
                <Icon name="check" size={14}/>
                <div className="intg-cred-body">
                  <div className="intg-cred-acct">Password stored</div>
                  <div className="intg-cred-sub">{(cfg && cfg.secrets.default_password.masked) || 'Encrypted'}</div>
                </div>
                <button className="btn btn-sm btn-ghost" onClick={() => { setPwdMode('edit'); setPwd(''); }}>Replace</button>
              </div>
            ) : (
              <div className="intg-row" style={{ marginTop: 0 }}>
                <input className="intg-input" type="password" autoComplete="new-password" placeholder="camera password" value={pwd} onChange={(e) => setPwd(e.target.value)}/>
                {cfg && cfg.secrets && cfg.secrets.default_password && cfg.secrets.default_password.set &&
                  <button className="btn btn-sm btn-ghost" onClick={() => { setPwdMode('saved'); setPwd(''); }}>Keep</button>}
              </div>
            )}
          </IntgField>
        </div>

        <div className="intg-sub">CONNECTION TEST TARGET</div>
        <IntgField label="Test RTSP URL" hint="full rtsp://… (overrides IP/port)"><input className="intg-input" placeholder="rtsp://10.0.0.5:554/Streaming/Channels/101" value={form.test_rtsp_url} onChange={(e) => set('test_rtsp_url', e.target.value)}/></IntgField>
        <div className="intg-two">
          <IntgField label="Test camera IP"><input className="intg-input" placeholder="10.0.0.5" value={form.test_camera_ip} onChange={(e) => set('test_camera_ip', e.target.value)}/></IntgField>
          <IntgField label="Test port"><input type="number" className="intg-input" value={form.test_port} onChange={(e) => set('test_port', e.target.value)}/></IntgField>
        </div>

        {msg && <div className={`intg-msg ${msg.kind}`}><Icon name={msg.kind === 'ok' ? 'check' : 'alert'} size={13}/><span>{msg.text}</span></div>}

        <div className="intg-actions">
          <button className="btn btn-amber btn-sm" disabled={busy === 'save'} onClick={save}><Icon name="check" size={13}/> {busy === 'save' ? 'Saving…' : 'Save'}</button>
          <button className="btn btn-ghost btn-sm" disabled={busy === 'test' || !canTest} title={canTest ? 'Probe the saved Test target with ffprobe/ffmpeg' : 'Save a Test RTSP URL or IP first'} onClick={test}><Icon name="route" size={13}/> {busy === 'test' ? 'Testing…' : 'Test connection'}</button>
          {form.enabled && <button className="btn btn-ghost btn-sm intg-danger" disabled={busy === 'save'} onClick={() => { set('enabled', false); setTimeout(save, 0); }}>Disable</button>}
        </div>
        <div className="intg-secnote"><Icon name="shield" size={12}/> The default password is encrypted at rest and never returned to this screen; credentials are stripped from probe errors and logs. A blank password box on Save keeps the stored one.</div>
      </div>

      <div className="card intg-status-card">
        <div className="card-head"><span className="eyebrow eyebrow-amber">STATUS</span></div>
        <div className="intg-status-row"><span>State</span><span className={`intg-pill ${st.cls}`}><span className="dot"/>{st.label}</span></div>
        <div className="intg-status-row"><span>Defaults enabled</span><b>{cfg && cfg.enabled ? 'On' : 'Off'}</b></div>
        <div className="intg-status-row"><span>Transport</span><b>{(form.rtsp_transport || 'tcp').toUpperCase()}</b></div>
        <div className="intg-status-row"><span>Last tested</span><b>{fmt(meta.last_tested_at)}</b></div>
        <div className="intg-status-row"><span>Last reachable</span><b>{fmt(meta.last_success_at)}</b></div>
        {meta.last_error && <div className="intg-status-err"><Icon name="alert" size={12}/> {meta.last_error}</div>}
        <div className="intg-status-sep">NOTES</div>
        <div className="intg-secnote">Test runs a real ffprobe/ffmpeg probe against the saved target. An unreachable camera or missing ffmpeg reports honest failure — never a fake green.</div>
      </div>
    </div>
        </div>
      </details>
      {window.LiveCameraConnection ? <window.LiveCameraConnection/> : <div className="intg-status-err">Camera panel unavailable.</div>}
    </div>
  );
};

// ── Timer / MQTT tab (fully working) ────────────────────────────────
const MqttTimerConfigTab = ({ onChanged }) => {
  const [cfg, setCfg] = useICS(null);
  const [form, setForm] = useICS({
    broker_host: '', broker_port: 1883, protocol: 'mqtt', username: '', client_id: 'baywatch-backend',
    topic_prefix: 'bay', command_topic_pattern: '{prefix}/{bay}/{event}', status_topic_pattern: '{prefix}/{bay}/timer',
    qos: 1, keepalive: 30, tls_enabled: false, ca_cert: '', retain_state: true,
    reconnect_attempts: 5, reconnect_backoff: 30, heartbeat_timeout: 15,
    test_topic: 'bay/test', test_payload: 'baywatch-ping', enabled: false,
  });
  const [pwd, setPwd] = useICS('');
  const [pwdMode, setPwdMode] = useICS('edit');
  const [busy, setBusy] = useICS('');
  const [msg, setMsg] = useICS(null);
  const flash = (kind, text) => { setMsg({ kind, text }); if (kind === 'ok') setTimeout(() => setMsg(null), 4000); };
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const load = useICC(async () => {
    try {
      const d = await BW_API.getIntegration('mqtt_timer');
      setCfg(d);
      setForm({
        broker_host: d.broker_host || '', broker_port: d.broker_port != null ? d.broker_port : 1883,
        protocol: d.protocol || 'mqtt', username: d.username || '', client_id: d.client_id || 'baywatch-backend',
        topic_prefix: d.topic_prefix || 'bay',
        command_topic_pattern: d.command_topic_pattern || '{prefix}/{bay}/{event}',
        status_topic_pattern: d.status_topic_pattern || '{prefix}/{bay}/timer',
        qos: d.qos != null ? d.qos : 1, keepalive: d.keepalive != null ? d.keepalive : 30,
        tls_enabled: !!d.tls_enabled, ca_cert: d.ca_cert || '', retain_state: d.retain_state !== false,
        reconnect_attempts: d.reconnect_attempts != null ? d.reconnect_attempts : 5,
        reconnect_backoff: d.reconnect_backoff != null ? d.reconnect_backoff : 30,
        heartbeat_timeout: d.heartbeat_timeout != null ? d.heartbeat_timeout : 15,
        test_topic: d.test_topic || 'bay/test', test_payload: d.test_payload || 'baywatch-ping',
        enabled: !!d.enabled,
      });
      const set_ = d.secrets && d.secrets.password && d.secrets.password.set;
      setPwdMode(set_ ? 'saved' : 'edit'); setPwd('');
    } catch (e) { flash('err', e.message || 'Failed to load configuration'); }
  }, []);
  useICE(() => { load(); }, [load]);
  // poll live broker status while the tab is open
  useICE(() => {
    const id = setInterval(async () => {
      try { const d = await BW_API.getIntegration('mqtt_timer'); setCfg((c) => ({ ...(c || {}), live: d.live, meta: d.meta, status: d.status })); } catch (e) {}
    }, 4000);
    return () => clearInterval(id);
  }, []);

  const save = async () => {
    if (!form.broker_host.trim()) { flash('err', 'Broker host is required.'); return; }
    setBusy('save'); setMsg(null);
    try {
      await BW_API.saveIntegration('mqtt_timer', {
        config: {
          broker_host: form.broker_host.trim(), broker_port: Number(form.broker_port) || 1883,
          protocol: form.protocol, username: form.username.trim(), client_id: form.client_id.trim() || 'baywatch-backend',
          topic_prefix: form.topic_prefix.trim() || 'bay',
          command_topic_pattern: form.command_topic_pattern.trim(), status_topic_pattern: form.status_topic_pattern.trim(),
          qos: Number(form.qos) || 0, keepalive: Number(form.keepalive) || 30,
          tls_enabled: !!form.tls_enabled, ca_cert: form.ca_cert.trim(), retain_state: !!form.retain_state,
          reconnect_attempts: Number(form.reconnect_attempts) || 0, reconnect_backoff: Number(form.reconnect_backoff) || 0,
          heartbeat_timeout: Number(form.heartbeat_timeout) || 0,
          test_topic: form.test_topic.trim(), test_payload: form.test_payload,
          enabled: !!form.enabled,
        },
        secrets: { password: pwdMode === 'edit' ? pwd.trim() : '' },
      });
      flash('ok', 'Saved — MQTT config applied live (reconnecting, no restart).');
      await load(); onChanged && onChanged();
    } catch (e) { flash('err', e.message || 'Save failed'); }
    finally { setBusy(''); }
  };

  const test = async () => {
    setBusy('test'); setMsg(null);
    try {
      const d = await BW_API.testIntegration('mqtt_timer');
      flash(d && d.reachable ? 'ok' : 'err', (d && d.detail) || (d && d.reachable ? 'Connected' : 'Broker test failed'));
      load(); onChanged && onChanged();
    } catch (e) { flash('err', e.message || 'Test failed'); }
    finally { setBusy(''); }
  };

  const reconnectNow = async () => {
    setBusy('reconnect'); setMsg(null);
    try {
      const d = await BW_API.mqttReconnect();
      flash(d && d.connected ? 'ok' : 'err', d && d.connected ? 'Broker connected.' : 'Applied config — broker not connected yet.');
      load(); onChanged && onChanged();
    } catch (e) { flash('err', e.message || 'Reconnect failed'); }
    finally { setBusy(''); }
  };

  const meta = (cfg && cfg.meta) || {};
  const live = (cfg && cfg.live) || {};
  const st = intgPill(cfg ? cfg.status : 'not_configured');
  const configured = !!(cfg && cfg.configured);
  const connected = !!live.connected;
  const lastMsg = live.last_message;
  const fmt = (iso) => { if (!iso) return '—'; try { return new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (e) { return iso; } };

  // The broker form is demoted to a collapsible section (per-bay timer pairing is
  // the primary view below). The in-tab "Configure MQTT" buttons open it via event.
  const [brokerOpen, setBrokerOpen] = useICS(false);
  useICE(() => {
    const h = () => setBrokerOpen(true);
    window.addEventListener('bw:mqtt-open-broker', h);
    return () => window.removeEventListener('bw:mqtt-open-broker', h);
  }, []);

  return (
    <div className="intg-merged">
      <details className="intg-collapse" open={brokerOpen} onToggle={(e) => setBrokerOpen(e.currentTarget.open)}>
        <summary className="intg-collapse-head">
          <span className="intg-collapse-title"><Icon name="cog" size={14}/> MQTT Broker Connection — shared by all bay timers</span>
          <span className={`intg-pill ${connected ? 'ok' : (configured ? 'danger' : 'ghost')}`}><span className="dot"/>{connected ? 'Connected' : (configured ? 'Disconnected' : 'Not configured')}</span>
        </summary>
        <div className="intg-collapse-body">
    <div className="intg-grid">
      <div className="card intg-form-card">
        <div className="card-head"><span className="eyebrow eyebrow-amber">● TIMER / MQTT BROKER</span>
          <span className={`intg-pill ${st.cls}`}><span className="dot"/>{st.label}</span></div>
        <div className="intg-secnote"><Icon name="clock" size={12}/> The backend is the single source of truth for timers — ESP32 devices only display what it publishes over this broker. One broker is shared by every bay; each bay timer rides its own <span className="mono">bay/&#123;n&#125;/…</span> topic.</div>
        {connected && st.cls === 'ghost' && (
          <div className="intg-secnote intg-hint-save"><Icon name="alert" size={12}/> Broker is connected using the current/default configuration. Click <b>Save</b> once to register this configuration in the database.</div>
        )}

        <IntgToggle label="Enable MQTT publishing" on={form.enabled} onChange={(v) => set('enabled', v)}
          hint="off → physical timers dormant; the backend timer keeps running"/>

        <div className="intg-two">
          <IntgField label="Broker host"><input className="intg-input" placeholder="broker.local / 10.0.0.2" value={form.broker_host} onChange={(e) => set('broker_host', e.target.value)}/></IntgField>
          <IntgField label="Port"><input type="number" className="intg-input" value={form.broker_port} onChange={(e) => set('broker_port', e.target.value)}/></IntgField>
        </div>
        <div className="intg-two">
          <IntgField label="Protocol">
            <select className="intg-input" value={form.protocol} onChange={(e) => set('protocol', e.target.value)}>
              <option value="mqtt">mqtt</option><option value="mqtts">mqtts (TLS)</option>
              <option value="ws">ws</option><option value="wss">wss (TLS)</option>
            </select>
          </IntgField>
          <IntgField label="Client ID"><input className="intg-input" value={form.client_id} onChange={(e) => set('client_id', e.target.value)}/></IntgField>
        </div>

        <div className="intg-sub">AUTHENTICATION</div>
        <div className="intg-two">
          <IntgField label="Username"><input className="intg-input" autoComplete="off" value={form.username} onChange={(e) => set('username', e.target.value)}/></IntgField>
          <IntgField label="Password" hint="encrypted · never shown again">
            {pwdMode === 'saved' ? (
              <div className="intg-cred-saved">
                <Icon name="check" size={14}/>
                <div className="intg-cred-body"><div className="intg-cred-acct">Password stored</div>
                  <div className="intg-cred-sub">{(cfg && cfg.secrets.password.masked) || 'Encrypted'}</div></div>
                <button className="btn btn-sm btn-ghost" onClick={() => { setPwdMode('edit'); setPwd(''); }}>Replace</button>
              </div>
            ) : (
              <div className="intg-row" style={{ marginTop: 0 }}>
                <input className="intg-input" type="password" autoComplete="new-password" placeholder="broker password" value={pwd} onChange={(e) => setPwd(e.target.value)}/>
                {cfg && cfg.secrets && cfg.secrets.password && cfg.secrets.password.set &&
                  <button className="btn btn-sm btn-ghost" onClick={() => { setPwdMode('saved'); setPwd(''); }}>Keep</button>}
              </div>
            )}
          </IntgField>
        </div>

        <div className="intg-sub">TOPICS & QOS</div>
        <IntgField label="Topic prefix / base topic"><input className="intg-input" value={form.topic_prefix} onChange={(e) => set('topic_prefix', e.target.value)}/></IntgField>
        <div className="intg-two">
          <IntgField label="Command topic pattern"><input className="intg-input" value={form.command_topic_pattern} onChange={(e) => set('command_topic_pattern', e.target.value)}/></IntgField>
          <IntgField label="Status topic pattern"><input className="intg-input" value={form.status_topic_pattern} onChange={(e) => set('status_topic_pattern', e.target.value)}/></IntgField>
        </div>
        <div className="intg-two">
          <IntgField label="QoS">
            <select className="intg-input" value={form.qos} onChange={(e) => set('qos', e.target.value)}>
              <option value={0}>0 — at most once</option><option value={1}>1 — at least once</option><option value={2}>2 — exactly once</option>
            </select>
          </IntgField>
          <IntgField label="Keepalive (s)"><input type="number" className="intg-input" value={form.keepalive} onChange={(e) => set('keepalive', e.target.value)}/></IntgField>
        </div>
        <IntgToggle label="Retain timer state (retained publish)" on={form.retain_state} onChange={(v) => set('retain_state', v)}
          hint="a reconnecting ESP32 instantly gets the latest countdown"/>

        <div className="intg-sub">TLS & RESILIENCE</div>
        <IntgToggle label="TLS enabled" on={form.tls_enabled} onChange={(v) => set('tls_enabled', v)}/>
        <IntgField label="CA certificate path" hint="optional · blank = system trust store"><input className="intg-input" placeholder="/etc/ssl/certs/ca.pem" value={form.ca_cert} onChange={(e) => set('ca_cert', e.target.value)}/></IntgField>
        <div className="intg-two">
          <IntgField label="Reconnect attempts"><input type="number" className="intg-input" value={form.reconnect_attempts} onChange={(e) => set('reconnect_attempts', e.target.value)}/></IntgField>
          <IntgField label="Reconnect backoff (s)"><input type="number" className="intg-input" value={form.reconnect_backoff} onChange={(e) => set('reconnect_backoff', e.target.value)}/></IntgField>
        </div>
        <IntgField label="Heartbeat timeout (s)"><input type="number" className="intg-input" value={form.heartbeat_timeout} onChange={(e) => set('heartbeat_timeout', e.target.value)}/></IntgField>

        <div className="intg-sub">CONNECTION TEST</div>
        <div className="intg-two">
          <IntgField label="Test topic"><input className="intg-input" value={form.test_topic} onChange={(e) => set('test_topic', e.target.value)}/></IntgField>
          <IntgField label="Test payload"><input className="intg-input" value={form.test_payload} onChange={(e) => set('test_payload', e.target.value)}/></IntgField>
        </div>

        {msg && <div className={`intg-msg ${msg.kind}`}><Icon name={msg.kind === 'ok' ? 'check' : 'alert'} size={13}/><span>{msg.text}</span></div>}

        <div className="intg-actions">
          <button className="btn btn-amber btn-sm" disabled={busy === 'save'} onClick={save}><Icon name="check" size={13}/> {busy === 'save' ? 'Saving…' : 'Save'}</button>
          <button className="btn btn-ghost btn-sm" disabled={busy === 'test' || !configured} title={configured ? 'Attempt a real broker connection' : 'Enable + set a broker host first'} onClick={test}><Icon name="route" size={13}/> {busy === 'test' ? 'Testing…' : 'Test connection'}</button>
          <button className="btn btn-ghost btn-sm" disabled={busy === 'reconnect'} title="Apply config to the live broker connection now" onClick={reconnectNow}><Icon name="route" size={13}/> {busy === 'reconnect' ? 'Reconnecting…' : 'Reconnect Now'}</button>
          {form.enabled && <button className="btn btn-ghost btn-sm intg-danger" disabled={busy === 'save'} onClick={() => { set('enabled', false); setTimeout(save, 0); }}>Disable</button>}
        </div>
        <div className="intg-secnote"><Icon name="shield" size={12}/> The broker password is encrypted at rest and never returned to this screen. A blank password box on Save keeps the stored one. Saving reconnects the broker live — no restart.</div>
      </div>

      <div className="card intg-status-card">
        <div className="card-head"><span className="eyebrow eyebrow-amber">STATUS</span></div>
        <div className="intg-status-row"><span>State</span><span className={`intg-pill ${st.cls}`}><span className="dot"/>{st.label}</span></div>
        <div className="intg-status-row"><span>Publishing enabled</span><b>{cfg && cfg.enabled ? 'On' : 'Off'}</b></div>
        <div className="intg-status-row"><span>Broker</span><span className={`intg-pill ${connected ? 'ok' : 'danger'}`}><span className="dot"/>{connected ? 'Connected' : 'Disconnected'}</span></div>
        <div className="intg-status-row"><span>Broker addr</span><b>{live.broker || '—'}</b></div>
        <div className="intg-status-row"><span>Last tested</span><b>{fmt(meta.last_tested_at)}</b></div>
        <div className="intg-status-row"><span>Last success</span><b>{fmt(meta.last_success_at)}</b></div>
        <div className="intg-status-row"><span>Last message</span><b>{lastMsg && lastMsg.topic ? lastMsg.topic : '—'}</b></div>
        {meta.last_error && <div className="intg-status-err"><Icon name="alert" size={12}/> {meta.last_error}</div>}
        <div className="intg-status-sep">NOTES</div>
        <div className="intg-secnote">Test runs a real broker connect (honest fail when unreachable / paho missing). Connection status above is live.</div>
      </div>
    </div>
        </div>
      </details>
      {window.LiveTimerConnection ? <window.LiveTimerConnection/> : <div className="intg-status-err">Timer panel unavailable.</div>}
    </div>
  );
};

// ── honest placeholder (unused once all four are real) ───────────────
const IntgPlaceholderTab = ({ provider, providers }) => {
  const tab = INTG_TABS.find((t) => t.id === provider) || {};
  const p = (providers || []).find((x) => x.provider === provider) || { status: 'not_configured' };
  const st = intgPill(p.status);
  const extra = [];
  if (p.broker) extra.push(p.broker);
  if (typeof p.connected === 'boolean') extra.push(p.connected ? 'connected' : 'offline');
  return (
    <div className="card intg-placeholder">
      <div className="intg-ph-icon"><Icon name={tab.icon || 'tools'} size={26}/></div>
      <h3>{tab.label}</h3>
      <div className="intg-ph-banner"><Icon name="alert" size={13}/> Configuration foundation is ready. This integration will be enabled in the next pass.</div>
      <div className="intg-ph-status">
        Live status: <span className={`intg-pill ${st.cls}`}><span className="dot"/>{st.label}</span>
        {extra.length > 0 && <span className="intg-ph-extra"> · {extra.join(' · ')}</span>}
      </div>
      {p.last_error && <div className="intg-status-err"><Icon name="alert" size={12}/> {p.last_error}</div>}
      <p className="intg-ph-note">The status above is read from the running service — no settings here are editable yet. Configuring it will work exactly like Google Drive once enabled.</p>
    </div>
  );
};


// ── page shell ──────────────────────────────────────────────────────
const IntegrationsConfig = () => {
  const [active, setActive] = useICS('google_drive');
  const [status, setStatus] = useICS(null);
  const [notice, setNotice] = useICS(null);
  const loadStatus = useICC(async () => {
    try { setStatus(await BW_API.integrationsStatus()); } catch (e) { setStatus({ providers: [] }); }
  }, []);
  useICE(() => { loadStatus(); }, [loadStatus]);
  // deep-link arriving WITH the navigation: the dispatcher stashes intent on a
  // global because this page mounts only after that navigate re-render, i.e. after
  // its event already fired. Consume it once on mount.
  useICE(() => {
    const pend = window.__bwIntgPending;
    if (pend && (Date.now() - (pend.ts || 0) < 5000)) {
      if (pend.provider) setActive(pend.provider);
      if (pend.notice) setNotice(pend.notice);
    }
    window.__bwIntgPending = null;
  }, []);
  // deep-link while ALREADY on the page (tab switch within the session).
  useICE(() => {
    const h = (e) => {
      if (!e.detail) return;
      if (e.detail.provider) setActive(e.detail.provider);
      setNotice(e.detail.notice || null);
    };
    window.addEventListener('bw:integrations-open', h);
    return () => window.removeEventListener('bw:integrations-open', h);
  }, []);
  const pick = (id) => { setActive(id); setNotice(null); };
  const providers = (status && status.providers) || [];

  return (
    <>
      <div className="content-head">
        <div><div className="eyebrow eyebrow-amber">● INTEGRATIONS & CONFIGURATION</div><h1>Integrations &amp; Configuration</h1>
          <span className="sub">Configure external services — secrets are stored encrypted and applied live, no restart.</span></div>
        <button className="btn btn-ghost btn-sm" onClick={loadStatus}><Icon name="route" size={13}/> Refresh</button>
      </div>

      {notice && <div className="intg-notice"><Icon name="alert" size={14}/><span>{notice}</span>
        <button className="modal-close" onClick={() => setNotice(null)}><Icon name="x" size={13}/></button></div>}

      <IntgStatusCards providers={providers} active={active} onPick={pick}/>

      <div className="intg-tabs">
        {INTG_NAV.map((t) => (
          <button key={t.id} className={`intg-tab ${active === t.id ? 'active' : ''}`} onClick={() => pick(t.id)}>
            <Icon name={t.icon} size={14}/><span>{t.label}</span>
          </button>
        ))}
      </div>

      <div className="intg-body">
        {active === 'google_drive' ? <GoogleDriveConfigTab onChanged={loadStatus}/>
          : active === 'whatsapp' ? <WhatsAppConfigTab onChanged={loadStatus}/>
          : active === 'camera' ? <CameraConfigTab onChanged={loadStatus}/>
          : active === 'mqtt_timer' ? <MqttTimerConfigTab onChanged={loadStatus}/>
          : <IntgPlaceholderTab provider={active} providers={providers}/>}
      </div>
    </>
  );
};

window.IntegrationsConfig = IntegrationsConfig;

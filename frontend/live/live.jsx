// ============================================================
//  LIVE (backend-connected) components.
//  Rendered instead of the local/demo components whenever a
//  backend session is active (BW_API.isLive()). These show ONLY
//  real data from the API and poll for real-time updates.
// ============================================================
const { useState: useLS, useEffect: useLE } = React;

const fmtMMSS = (sec) => {
  const s = Math.max(0, Math.floor(sec || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

// Resolve several independent requests without letting one failure blank the
// whole view. Each pair is [promise, fallback]; a rejected/empty promise yields
// its fallback so a dashboard renders partial data instead of crashing. (This
// is Promise.allSettled semantics with per-call defaults.)
const settle = async (pairs) => {
  const res = await Promise.allSettled(pairs.map((p) => p[0]));
  return res.map((r, i) => (r.status === 'fulfilled' && r.value != null ? r.value : pairs[i][1]));
};

// ── Admin · Live Bay Dashboard (real-time over WebSocket) ───
// ════════════════════════════════════════════════════════════
//  Admin · Live Bay Dashboard (live) — circular timers, KPI
//  donut, filter tabs, Bay CRUD via Details drawer
// ════════════════════════════════════════════════════════════
const lbdPad = (n) => String(n).padStart(2, '0');

// Circular progress ring (SVG)
const LbdRing = ({ pct, color, time, sub, size = 150, stroke = 9, dim }) => {
  const R = (size - stroke) / 2 - 2;
  const C = 2 * Math.PI * R;
  const off = C * (1 - Math.max(0, Math.min(1, pct || 0)));
  return (
    <div className="lbd-ring" style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} className="lbd-ring-svg">
        <circle cx={size / 2} cy={size / 2} r={R} className="lbd-ring-track" style={{ strokeWidth: stroke }}/>
        {!dim && <circle cx={size / 2} cy={size / 2} r={R} className="lbd-ring-prog"
          style={{ stroke: color, strokeWidth: stroke, strokeDasharray: C, strokeDashoffset: off }}/>}
      </svg>
      <div className="lbd-ring-c">
        <div className="lbd-ring-time" style={{ color: dim ? 'var(--t-4)' : color }}>{time}</div>
        {sub && <div className="lbd-ring-sub">{sub}</div>}
      </div>
    </div>
  );
};

// One bay card
// Compact physical-timer status badge (Live Bay Dashboard). Honest: never shows
// "Connected" without a recent heartbeat AND a live broker.
const lbdTimerBadge = (td, mqttOk) => {
  const paired = !!(td && td.timer);
  if (!paired) return <div className="lbd-tmr unpaired"><Icon name="clock" size={10}/> No timer paired</div>;
  const online = td.status === 'online';
  const conflict = !!td.conflict;
  const cls = conflict ? 'danger' : !mqttOk ? 'warn' : online ? 'ok' : 'warn';
  const conn = conflict ? 'Duplicate timer ID' : !mqttOk ? 'MQTT broker not connected' : online ? 'Connected' : 'Offline';
  return (
    <div className={`lbd-tmr ${cls}`} title={`${td.timer.timer_id} · ${conn}`}>
      <Icon name="clock" size={10}/> <b className="mono">{td.timer.timer_id}</b> · {conn}
    </div>
  );
};

// compact per-bay camera readiness badge (Live Bay Dashboard). Honest: never "RTSP OK"
// without a recent successful probe; "Recording" only when the bay session is recording.
const lbdCameraBadge = (cd, recStatus) => {
  const paired = !!(cd && cd.camera);
  if (!paired) return <div className="lbd-tmr cam unpaired"><Icon name="cam" size={10}/> No camera paired</div>;
  const recording = recStatus === 'recording';
  const online = cd.status === 'online';
  const cls = recording ? 'rec' : online ? 'ok' : 'warn';
  const label = recording ? 'Recording' : online ? 'RTSP OK' : 'Offline';
  const id = cd.camera.camera_id || cd.camera.ip_address || 'camera';
  return (
    <div className={`lbd-tmr cam ${cls}`} title={`${id} · ${label}`}>
      <Icon name="cam" size={10}/> <b className="mono">{id}</b> · {label}
    </div>
  );
};

const LbdCard = ({ bay, s, busy, td, cd, mqttOk, onAct, onDetails, onStart }) => {
  const num = lbdPad(bay.bay_number);
  const disabled = bay.status === 'disabled';
  const maint = bay.status === 'maintenance';

  // ── Empty states (available / maintenance / disabled) — equal height, no big ring ──
  if (!s || maint || disabled) {
    const label = maint ? 'MAINTENANCE' : disabled ? 'DISABLED' : 'AVAILABLE';
    const chip = maint ? 'warn' : 'ghost';
    const msg = maint ? 'Out of rotation' : disabled ? 'Bay offline' : 'Awaiting assignment';
    const ico = maint ? 'cog' : disabled ? 'pause' : 'route';
    return (
      <div className="lbd-card empty" onClick={onDetails}>
        <div className="lbd-card-head">
          <span className="lbd-bayno">BAY <b>{num}</b></span>
          <span className={`chip ${chip}`}>{(!maint && !disabled) && <span className="dot"/>}{label}</span>
        </div>
        <div className="lbd-empty-body">
          <div className="lbd-empty-ico"><Icon name={ico} size={24}/></div>
          <div className="lbd-empty-t">{bay.name || `Bay ${num}`}</div>
          <div className="lbd-empty-s">{msg}</div>
          {!disabled && lbdTimerBadge(td, mqttOk)}
          {!disabled && lbdCameraBadge(cd, s && s.recording_status)}
        </div>
        <div className="lbd-card-foot">
          <button className="btn btn-sm btn-ghost lbd-fbtn" onClick={(e) => { e.stopPropagation(); onDetails(); }}><Icon name="gauge" size={12}/> DETAILS</button>
        </div>
      </div>
    );
  }

  // ── Session states (assigned / running / paused) ──
  const t = s.timer || {};
  const estMin = s.estimated_minutes || Math.round((t.estimated_seconds || 0) / 60) || 1;
  const estSec = (t.estimated_seconds || estMin * 60) || 1;
  const ts = (typeof timerState === 'function') ? timerState(t.elapsed || 0, estMin) : { color: 'var(--amber)', zone: 'safe', overtime: (t.overtime || 0) > 0 };
  const assigned = s.status === 'assigned';
  const paused = s.status === 'paused';
  const running = s.status === 'running';
  const overtime = (t.overtime || 0) > 0;
  const color = paused ? 'var(--warn)' : overtime ? 'var(--danger)' : ts.color;
  const pct = Math.min(1, (t.elapsed || 0) / estSec);
  const donePct = Math.min(100, Math.round(pct * 100));
  const statusLabel = assigned ? 'NOT STARTED' : paused ? 'PAUSED' : overtime ? 'OVERTIME' : 'RUNNING';
  const chipCls = assigned ? 'ghost' : paused ? 'warn' : overtime ? 'danger' : 'ok';
  const initials = (s.worker_name || '?').split(' ').map(x => x[0]).join('').slice(0, 2);

  return (
    <div className={`lbd-card ${assigned ? 'assigned' : running ? 'running' : ''} ${overtime ? 'overtime' : ''} ${paused ? 'paused' : ''}`} style={{ ['--zc']: color }}>
      <div className="lbd-card-head">
        <span className="lbd-bayno">BAY <b>{num}</b></span>
        <span className={`chip ${chipCls}`}>{!assigned && <span className={`dot ${chipCls} ${paused ? '' : 'pulsing'}`}/>}{statusLabel}</span>
      </div>

      {/* identical ring in every state — grey when not started, coloured when live */}
      <LbdRing dim={assigned} pct={pct} color={color}
        time={assigned ? '00:00' : fmtMMSS(t.elapsed)}
        sub={assigned ? `EST ${estMin}M` : overtime ? `+${fmtMMSS(t.overtime)} OT` : `${fmtMMSS(Math.max(0, t.remaining))} LEFT`}/>

      <div className="lbd-worker">
        <Avatar id={s.employee_id || s.worker_id} initials={initials} size={34}/>
        <div style={{ minWidth: 0 }}>
          <div className="lbd-worker-name">{s.worker_name || '—'}</div>
          <div className="lbd-worker-id">{s.employee_id || ''}{s.job_card_number ? ` · ${s.job_card_number}` : ''}</div>
        </div>
      </div>
      <div className="lbd-veh">{s.vehicle || '—'}<small>{s.registration ? `${s.registration} · ` : ''}{s.service_type || ''}</small></div>

      {s.estimate_source === 'approved' && (
        <div className="lbd-appr"><Icon name="check" size={11}/> Customer-approved estimate{s.approved_cost != null ? ` · ₹${Math.round(s.approved_cost)}` : ''}</div>
      )}
      {(running || paused) && (() => {
        // Truthful recording status — camera-gated by the backend (never fake green).
        const rs = s.recording_status;
        const cfg = rs === 'recording' ? { cls: 'rec', dot: true, txt: 'Recording active' }
          : rs === 'unavailable' ? { cls: 'off', dot: false, txt: 'Recording unavailable' }
          : rs === 'paused' ? { cls: 'warn', dot: false, txt: 'Recording paused' } : null;
        return cfg && <div className={`lbd-rec ${cfg.cls}`}>{cfg.dot && <span className="lbd-rec-dot"/>}{!cfg.dot && <Icon name="cam" size={10}/>} {cfg.txt}</div>;
      })()}
      {(running || paused) && (s.start_warnings || []).map((w, i) => (
        <div key={i} className="lbd-warn"><Icon name="alert" size={10}/> {w}</div>
      ))}

      {lbdTimerBadge(td, mqttOk)}
      {lbdCameraBadge(cd, s && s.recording_status)}

      {(running || paused) && (
        <div className="lbd-mini">
          <div><div className="l">EST</div><div className="v">{estMin}m</div></div>
          <div><div className="l">DONE</div><div className="v">{donePct}%</div></div>
          <div><div className="l">LEFT</div><div className="v" style={{ color }}>{overtime ? `+${Math.round(t.overtime / 60)}m` : `${Math.round(Math.max(0, t.remaining) / 60)}m`}</div></div>
        </div>
      )}

      <div className="lbd-card-foot">
        {assigned && <>
          <button className="btn btn-sm btn-ghost lbd-fbtn" onClick={onDetails}><Icon name="gauge" size={12}/> DETAILS</button>
          <button className="btn btn-sm btn-amber lbd-fbtn2" disabled={busy} onClick={() => onStart(bay)}><Icon name="play" size={13}/> START JOB</button>
        </>}
        {running && <>
          <button className="btn btn-sm btn-ghost lbd-fbtn" disabled={busy} onClick={() => onAct(BW_API.pauseBay, bay.id)}><Icon name="pause" size={13}/> PAUSE</button>
          <button className="btn btn-sm btn-amber lbd-fbtn" disabled={busy} onClick={() => onAct(BW_API.completeBay, bay.id)}><Icon name="flag" size={13}/> COMPLETE</button>
          <button className="lbd-icon-btn" onClick={onDetails} title="Details"><Icon name="gauge" size={14}/></button>
        </>}
        {paused && <>
          <button className="btn btn-sm lbd-fbtn lbd-resume" disabled={busy} onClick={() => onAct(BW_API.resumeBay, bay.id)}><Icon name="play" size={13}/> RESUME</button>
          <button className="btn btn-sm btn-amber lbd-fbtn" disabled={busy} onClick={() => onAct(BW_API.completeBay, bay.id)}><Icon name="flag" size={13}/> COMPLETE</button>
          <button className="lbd-icon-btn" onClick={onDetails} title="Details"><Icon name="gauge" size={14}/></button>
        </>}
      </div>
    </div>
  );
};

// generic confirm
const LbdConfirm = ({ title, body, danger, confirmLabel = 'CONFIRM', onConfirm, onClose }) => {
  const [busy, setBusy] = useLS(false);
  return (
    <div className="modal-scrim" onClick={onClose} style={{ zIndex: 380 }}>
      <div className="modal" style={{ width: 440 }} onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div className="row" style={{ gap: 10 }}>
            <div className="jf-head-ico" style={danger ? { background: 'rgba(244,63,94,.12)', borderColor: 'rgba(244,63,94,.35)', color: 'var(--danger)' } : {}}><Icon name={danger ? 'trash' : 'cog'} size={14}/></div>
            <span style={{ fontWeight: 600, fontSize: 14 }}>{title}</span>
          </div>
          <button className="modal-close" onClick={onClose}><Icon name="x" size={15}/></button>
        </div>
        <div style={{ padding: '16px 22px 20px', fontSize: 13, color: 'var(--t-2)', lineHeight: 1.6 }}>{body}</div>
        <div className="modal-foot">
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose}>CANCEL</button>
          <button className="btn" disabled={busy} style={{ flex: 1, ...(danger ? { background: 'rgba(244,63,94,.15)', color: 'var(--danger)', border: '1px solid rgba(244,63,94,.4)' } : { background: 'linear-gradient(180deg,var(--amber-bright),var(--amber))', color: '#1a0d05' }) }}
            onClick={async () => { setBusy(true); try { await onConfirm(); } catch (e) { setBusy(false); } }}>{busy ? '…' : confirmLabel}</button>
        </div>
      </div>
    </div>
  );
};

// ── Customer Live Watch — START popup (admin decides Send / Don't-send) ──
// Renders only backend state. SEND → backend mints the token (hash stored) → admin may
// Copy / WhatsApp → START → workflow_engine flips the link to LIVE. DON'T-SEND requires a
// reason. A job marked Do-Not-Send is gated until a Master reverts it (backend-enforced 403).
const CwStartModal = ({ bay, s, onClose, onStarted, flash }) => {
  const [ctx, setCtx] = useLS(null);
  const [load, setLoad] = useLS(true);
  const [err, setErr] = useLS('');
  const [busy, setBusy] = useLS(false);
  const [step, setStep] = useLS('choose');     // choose | sent | notsend
  const [link, setLink] = useLS(null);          // {id, watch_url, token}
  const [reason, setReason] = useLS('');
  const [copied, setCopied] = useLS(false);
  const [waMsg, setWaMsg] = useLS('');

  useLE(() => {
    let alive = true;
    BW_API.cwContext(bay.id)
      .then(d => { if (alive) { setCtx(d); setLoad(false); } })
      .catch(e => { if (alive) { setErr(e.message || 'Could not load job details'); setLoad(false); } });
    return () => { alive = false; };
  }, []);

  const sid = (ctx && ctx.service_session_id) || (s && s.session_id);
  const blocked = !!(ctx && ctx.blocked);
  const num = lbdPad(bay.bay_number);
  const Row = ({ l, v }) => <div className="jd-row"><span className="jd-l">{l}</span><span className="jd-v">{v || <span className="jd-na">—</span>}</span></div>;

  const doSend = async () => {
    setBusy(true); setErr('');
    try {
      const r = await BW_API.cwDecision({ service_session_id: sid, action: 'send' });
      setLink({ id: r.id, watch_url: r.watch_url, token: (r.watch_url || '').split('/').pop() });
      setStep('sent');
    } catch (e) { setErr(e.message || 'Could not create link'); } finally { setBusy(false); }
  };
  const doCopy = () => { try { navigator.clipboard.writeText(link.watch_url); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch (e) {} };
  const doWa = async () => {
    setBusy(true); setErr(''); setWaMsg('');
    try { const r = await BW_API.cwWhatsapp(link.id, link.token); setWaMsg((r && r.message) || 'WhatsApp sent'); }
    catch (e) { setErr(e.message || 'WhatsApp failed'); } finally { setBusy(false); }
  };
  // Build a truthful start toast: authoritative estimate source + handoff warnings
  // (full warnings persist on the bay card; backend remains the source of truth).
  const startFlash = (r, base) => {
    const est = r && r.estimate, warns = (r && r.warnings) || [];
    let m = base;
    if (est && est.source === 'approved' && est.approved_cost != null) m = `${base} · approved ₹${Math.round(est.approved_cost)} / ${est.minutes}m`;
    if (warns.length) m = `${m} — ${warns.length} warning${warns.length > 1 ? 's' : ''} (see bay card)`;
    return m;
  };
  const startNow = async (msg) => {
    setBusy(true); setErr('');
    try { const r = await BW_API.startBay(bay.id); flash(startFlash(r, msg)); onStarted(); }
    catch (e) { setErr(e.message || 'Could not start service'); setBusy(false); }
  };
  const doNotSend = async () => {
    if (!reason.trim()) { setErr('A reason is required'); return; }
    setBusy(true); setErr('');
    try {
      await BW_API.cwDecision({ service_session_id: sid, action: 'not_send', reason: reason.trim() });
      const r = await BW_API.startBay(bay.id);
      flash(startFlash(r, 'Service started · no video link sent'));
      onStarted();
    } catch (e) { setErr(e.message || 'Could not start'); setBusy(false); }
  };

  return (
    <div className="modal-scrim" onClick={onClose} style={{ zIndex: 380 }}>
      <div className="modal" style={{ width: 500 }} onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div className="row" style={{ gap: 11 }}>
            <div className="jf-head-ico"><Icon name="cam" size={15}/></div>
            <div><div className="sc-title">Start service · Bay {num}</div>
              <div className="sc-sub">Customer live video — shared over WhatsApp</div></div>
          </div>
          <button className="modal-close" onClick={onClose}><Icon name="x" size={15}/></button>
        </div>

        <div className="jf-body" style={{ maxHeight: '64vh', overflow: 'auto' }}>
          {load && <div className="cw-load"><span className="cw-spin"/> Loading job details…</div>}
          {!load && ctx && <>
            <div className="cw-rows">
              <Row l="Customer" v={ctx.customer_name}/>
              <Row l="WhatsApp / Mobile" v={ctx.customer_mobile}/>
              <Row l="Vehicle" v={ctx.vehicle_number}/>
              <Row l="Bay" v={ctx.bay_name}/>
              <Row l="Worker" v={ctx.worker_name}/>
            </div>

            {step === 'choose' && <>
              {blocked && <div className="cw-gate"><Icon name="shield" size={14}/>
                <div><b>Marked “Do not send video”.</b> Master Admin approval is required before a link can be sent.{ctx.blocked_reason ? ` Reason: ${ctx.blocked_reason}` : ''}</div></div>}
              {!ctx.whatsapp_configured && !blocked && <div className="cw-note"><Icon name="alert" size={13}/> WhatsApp isn’t configured — you can still copy the link and share it.</div>}
              <div className="cw-choice">
                <button className="btn btn-amber" disabled={busy || blocked || !sid} onClick={doSend}><Icon name="play" size={14}/> Send live video link</button>
                <button className="btn btn-ghost" disabled={busy} onClick={() => { setErr(''); setStep('notsend'); }}><Icon name="x" size={14}/> Don’t send video</button>
              </div>
            </>}

            {step === 'sent' && link && <div className="cw-sent">
              <div className="cw-linkbox">
                <input readOnly value={link.watch_url} onFocus={e => e.target.select()}/>
                <button className="btn btn-sm btn-ghost" onClick={doCopy}>{copied ? 'Copied ✓' : 'Copy'}</button>
              </div>
              <div className="cw-waline">
                <button className="btn btn-sm btn-amber" disabled={busy} onClick={doWa}><Icon name="bell" size={13}/> Send WhatsApp</button>
                {waMsg && <span className="cw-wamsg">{waMsg}</span>}
              </div>
              <div className="cw-hint">The customer can watch live once you start the service. The link expires automatically and works for this service only.</div>
            </div>}

            {step === 'notsend' && <div className="cw-notsend">
              <label className="cw-lbl">Reason (required)</label>
              <textarea rows={3} value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Customer declined · Camera maintenance · Privacy request"/>
            </div>}
          </>}
          {err && <div className="pt-form-err" style={{ marginTop: 10 }}><Icon name="alert" size={13}/> {err}</div>}
        </div>

        <div className="modal-foot">
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose}>CANCEL</button>
          {step === 'sent' && <button className="btn btn-amber" style={{ flex: 2 }} disabled={busy} onClick={() => startNow('Service started · live link active')}><Icon name="play" size={14}/> {busy ? 'STARTING…' : 'START SERVICE'}</button>}
          {step === 'notsend' && <button className="btn btn-amber" style={{ flex: 2 }} disabled={busy} onClick={doNotSend}><Icon name="play" size={14}/> {busy ? 'STARTING…' : 'START WITHOUT VIDEO'}</button>}
        </div>
      </div>
    </div>
  );
};

// create / edit bay modal
const LbdBayModal = ({ initial, workers, onClose, onSaved }) => {
  const edit = !!initial;
  const [f, setF] = useLS(initial || { bay_number: '', name: '', description: '', camera_channel: '', status: 'available', primary_worker_id: '' });
  const [err, setErr] = useLS(''); const [busy, setBusy] = useLS(false);
  const set = (k, v) => setF(s => ({ ...s, [k]: v }));
  const save = async () => {
    setErr(''); setBusy(true);
    try {
      const body = { name: f.name || null, description: f.description || null, camera_channel: f.camera_channel || null, primary_worker_id: f.primary_worker_id || null, status: f.status };
      if (edit) await BW_API.updateBay(initial.id, body);
      else await BW_API.createBay({ ...body, bay_number: f.bay_number ? +f.bay_number : null });
      onSaved(edit ? 'Bay updated ✓' : 'New bay created ✓'); onClose();
    } catch (e) { setErr(e.message || 'Could not save'); setBusy(false); }
  };
  return (
    <div className="modal-scrim" onClick={onClose} style={{ zIndex: 380 }}>
      <div className="modal modal-lg jf-modal" style={{ width: 560 }} onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div className="row" style={{ gap: 11 }}>
            <div className="jf-head-ico"><Icon name="route" size={15}/></div>
            <div><div className="sc-title">{edit ? `Edit Bay ${lbdPad(initial.bay_number)}` : 'Create New Bay'}</div>
              <div className="sc-sub">{edit ? 'Bay ID and history cannot be changed' : 'Adds a fully-functional bay to the dashboard'}</div></div>
          </div>
          <button className="modal-close" onClick={onClose}><Icon name="x" size={15}/></button>
        </div>
        <div className="jf-body">
          <div className="jf-grid">
            <div className="jf-field"><label>Bay Number {edit && <span className="jf-hint" style={{ marginLeft: 4 }}>locked</span>}</label>
              <input type="number" value={edit ? initial.bay_number : f.bay_number} disabled={edit} placeholder="auto (next available)" onChange={e => set('bay_number', e.target.value)}/></div>
            <div className="jf-field"><label>Bay Name</label><input value={f.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Express Lane"/></div>
            <div className="jf-field"><label>Camera Channel</label><input value={f.camera_channel} onChange={e => set('camera_channel', e.target.value)} placeholder="CH-09"/></div>
            <div className="jf-field"><label>Status</label>
              <select value={f.status} onChange={e => set('status', e.target.value)}>
                <option value="available">Available</option><option value="maintenance">Maintenance</option><option value="disabled">Disabled</option>
              </select></div>
            <div className="jf-field"><label>Default Worker</label>
              <select value={f.primary_worker_id} onChange={e => set('primary_worker_id', e.target.value)}>
                <option value="">None</option>{workers.map(w => <option key={w.id} value={w.id}>{w.name} · {w.employee_id}</option>)}
              </select></div>
            <div className="jf-field full"><label>Description</label><textarea value={f.description} onChange={e => set('description', e.target.value)} placeholder="Notes about this bay…" rows={2}/></div>
          </div>
          {err && <div className="pt-form-err" style={{ marginTop: 4 }}><Icon name="alert" size={13}/> {err}</div>}
        </div>
        <div className="modal-foot">
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose}>CANCEL</button>
          <button className="btn btn-amber" style={{ flex: 2 }} disabled={busy} onClick={save}><Icon name="check" size={14}/> {busy ? 'SAVING…' : (edit ? 'SAVE CHANGES' : 'CREATE BAY')}</button>
        </div>
      </div>
    </div>
  );
};

// bay details + CRUD drawer
const LbdDetails = ({ bay, s, onClose, onEdit, onDuplicate, onStatus, onDelete }) => {
  const Row = ({ l, v, mono }) => <div className="jd-row"><span className="jd-l">{l}</span><span className={`jd-v${mono ? ' mono' : ''}`}>{(v === 0 || v) ? v : <span className="jd-na">—</span>}</span></div>;
  const t = s && s.timer || {};
  const active = s && ['assigned', 'running', 'paused'].includes(s.status);
  const estMin = s ? (s.estimated_minutes || Math.round((t.estimated_seconds || 0) / 60)) : 0;
  const statusChip = bay.status === 'running' ? 'ok' : bay.status === 'paused' ? 'warn' : bay.status === 'maintenance' ? 'warn' : bay.status === 'disabled' ? 'ghost' : 'ghost';
  return (
    <div className="modal-scrim" onClick={onClose} style={{ placeItems: 'stretch end', zIndex: 360 }}>
      <div className="job-drawer" onClick={e => e.stopPropagation()}>
        <div className="jd-head">
          <div className="jd-head-top">
            <span className="jd-jc mono">BAY {lbdPad(bay.bay_number)}{bay.camera_channel ? ` · ${bay.camera_channel}` : ''}</span>
            <div className="row" style={{ gap: 8 }}><span className={`chip ${statusChip}`}>{(bay.status || '').toUpperCase()}</span><button className="modal-close" onClick={onClose}><Icon name="x" size={15}/></button></div>
          </div>
          <div className="jd-title">{bay.name || `Bay ${lbdPad(bay.bay_number)}`}</div>
          <div className="jd-sub"><Icon name="user" size={13}/> {bay.primary_worker_name ? `Primary · ${bay.primary_worker_name}` : 'No primary worker'}</div>
          {s && (
            <div className="jd-summary">
              <div className="jd-stat"><div className="v">{estMin}<span>m</span></div><div className="l">Est. Time</div></div>
              <div className="jd-stat"><div className="v">{s.status === 'assigned' ? '—' : fmtMMSS(t.elapsed)}</div><div className="l">Elapsed</div></div>
              <div className="jd-stat"><div className="v" style={{ color: (t.overtime || 0) > 0 ? 'var(--danger)' : 'var(--ok)' }}>{(t.overtime || 0) > 0 ? `+${fmtMMSS(t.overtime)}` : fmtMMSS(Math.max(0, t.remaining || 0))}</div><div className="l">{(t.overtime || 0) > 0 ? 'Overtime' : 'Remaining'}</div></div>
            </div>
          )}
        </div>

        <div className="jd-scroll">
          {s ? <>
            <div className="jd-card">
              <div className="jd-card-head"><span className="jd-ico cust"><Icon name="user" size={13}/></span> Current Job</div>
              <Row l="Customer" v={s.customer_name}/><Row l="Job Card" v={s.job_card_number} mono/>
              <Row l="Vehicle" v={s.vehicle}/><Row l="Registration" v={s.registration} mono/>
              <Row l="Service" v={s.service_type}/><Row l="Worker" v={s.worker_name}/>
              <Row l="Status" v={(s.status || '').toUpperCase()}/>
            </div>
            {s.services && s.services.length > 0 && (
              <div className="jd-card">
                <div className="jd-card-head"><span className="jd-ico svc"><Icon name="gauge" size={13}/></span> Parts &amp; Time</div>
                <div className="jd-svc-list">
                  {s.services.map((x, i) => <div key={i} className="jd-svc"><span className="jd-svc-name">{x.service || x.part_name}</span><span className="jd-svc-min mono">{x.minutes}m</span></div>)}
                  <div className="jd-svc total"><span className="jd-svc-name">Total</span><span className="jd-svc-min mono" style={{ color: 'var(--amber-bright)' }}>{estMin}m</span></div>
                </div>
              </div>
            )}
            {s.session_id && (
              <div className="jd-card">
                <div className="jd-card-head"><span className="jd-ico doc"><Icon name="history" size={13}/></span> Activity Timeline</div>
                <OpsTimeline sessionId={s.session_id}/>
              </div>
            )}
          </> : (
            <div className="jd-card">
              <div className="jd-card-head"><span className="jd-ico doc"><Icon name="route" size={13}/></span> Status</div>
              <div className="jd-na" style={{ fontSize: 13 }}>{bay.status === 'maintenance' ? 'Bay is under maintenance — out of rotation.' : bay.status === 'disabled' ? 'Bay is disabled.' : 'Available — no active job. Assign one from the Job Queue.'}</div>
            </div>
          )}

          <div className="jd-card">
            <div className="jd-card-head"><span className="jd-ico veh"><Icon name="route" size={13}/></span> Bay Configuration</div>
            <Row l="Bay ID" v={bay.id.slice(0, 8) + '…'} mono/>
            <Row l="Bay Number" v={lbdPad(bay.bay_number)} mono/>
            <Row l="Name" v={bay.name}/>
            <Row l="Camera Channel" v={bay.camera_channel} mono/>
            <Row l="Primary Worker" v={bay.primary_worker_name}/>
            <Row l="Status" v={(bay.status || '').toUpperCase()}/>
            {bay.description && <div className="jd-row full"><span className="jd-l">Description</span><span className="jd-v">{bay.description}</span></div>}
          </div>

          <div className="jd-card">
            <div className="jd-card-head"><span className="jd-ico svc"><Icon name="cam" size={13}/></span> Camera &amp; Recording</div>
            <Row l="Camera" v={s && s.status === 'running' ? 'LIVE' : 'OFF'}/>
            <Row l="Recording" v={s && s.status === 'running' ? 'RECORDING' : s && s.status === 'paused' ? 'PAUSED' : 'IDLE'}/>
            <Row l="Channel" v={bay.camera_channel} mono/>
          </div>
        </div>

        {/* CRUD footer */}
        <div className="jd-actions">
          {active && <div className="jd-onbay" style={{ marginBottom: 2 }}><Icon name="alert" size={14}/> Bay has an active service — stop/complete it before maintenance or delete.</div>}
          <div className="jd-act-grid">
            <button className="jd-act" onClick={onEdit}><Icon name="edit" size={14}/> Edit</button>
            <button className="jd-act" onClick={onDuplicate}><Icon name="plus" size={14}/> Duplicate</button>
            {bay.status === 'maintenance'
              ? <button className="jd-act" disabled={active} onClick={() => onStatus('available')}><Icon name="check" size={14}/> Activate</button>
              : <button className="jd-act" disabled={active} onClick={() => onStatus('maintenance')}><Icon name="cog" size={14}/> Maintenance</button>}
            {bay.status === 'disabled'
              ? <button className="jd-act" onClick={() => onStatus('available')}><Icon name="check" size={14}/> Enable</button>
              : <button className="jd-act" disabled={active} onClick={() => onStatus('disabled')}><Icon name="pause" size={14}/> Disable</button>}
            <button className="jd-act danger" disabled={active} style={{ gridColumn: 'span 2' }} onClick={onDelete}><Icon name="trash" size={14}/> Delete Bay</button>
          </div>
        </div>
      </div>
    </div>
  );
};

const LiveBayDashboard = () => {
  const [bays, setBays] = useLS([]);
  const [snap, setSnap] = useLS({ bays: [], timer_backend: '' });
  const [workers, setWorkers] = useLS([]);
  const [meta, setMeta] = useLS({ queue: 0, completed: 0 });
  const [busy, setBusy] = useLS(null);
  const [filter, setFilter] = useLS('all');
  const [toast, setToast] = useLS('');
  const [detailId, setDetailId] = useLS(null);
  const [showCreate, setShowCreate] = useLS(false);
  const [editBay, setEditBay] = useLS(null);
  const [confirm, setConfirm] = useLS(null);   // {kind, bay}
  const [cwStart, setCwStart] = useLS(null);   // Customer Live Watch START popup {bay, s}

  const [tmrs, setTmrs] = useLS({ timers: [], summary: {} });
  const [cams, setCams] = useLS({ cameras: [], summary: {} });

  const loadBays = React.useCallback(() => { BW_API.bays().then(setBays).catch(() => {}); }, []);
  useLE(() => { loadBays(); BW_API.workers().then(setWorkers).catch(() => {}); }, []);
  useBWSocket('/bay-dashboard', (d) => { if (d) setSnap(d); });
  useBWPoll(() => BW_API.dashboard().then((d) => { if (d) setSnap(d); return d; }), [], 3000);
  // physical-timer + camera pairing per bay (covers idle bays too) — reuses the registries
  useBWPoll(() => BW_API.timersList().then((d) => { if (d) setTmrs(d); return d; }).catch(() => {}), [], 8000);
  useBWPoll(() => BW_API.camerasList().then((d) => { if (d) setCams(d); return d; }).catch(() => {}), [], 8000);
  useBWPoll(async () => {
    const [q, c] = await Promise.all([BW_API.queue().catch(() => ({})), BW_API.workCompletion().catch(() => [])]);
    const qn = Object.values(q || {}).reduce((a, arr) => a + (arr || []).filter(i => i.status === 'queued').length, 0);
    setMeta({ queue: qn, completed: (c || []).length }); return true;
  }, [], 8000);

  const flash = (m) => { setToast(m); setTimeout(() => setToast(''), 3000); };
  const sessions = snap.bays || [];
  const byBay = {}; sessions.forEach(s => { byBay[s.bay_id] = s; });
  const tmrByBay = {}; (tmrs.timers || []).forEach(r => { tmrByBay[r.bay_id] = r; });
  const camByBay = {}; (cams.cameras || []).forEach(r => { camByBay[r.bay_id] = r; });
  const mqttOk = !!(tmrs.summary && tmrs.summary.mqtt && tmrs.summary.mqtt.enabled && tmrs.summary.mqtt.connected);

  const act = async (fn, bayId) => { setBusy(bayId); try { await fn(bayId); loadBays(); } catch (e) { flash(e.message); } finally { setBusy(null); } };

  // counts
  const running = sessions.filter(s => s.status === 'running').length;
  const paused = sessions.filter(s => s.status === 'paused').length;
  const overtime = sessions.filter(s => (s.timer && s.timer.overtime || 0) > 0).length;
  const maintenance = bays.filter(b => b.status === 'maintenance').length;
  const activeBays = bays.filter(b => b.status !== 'disabled');
  const occupied = activeBays.filter(b => byBay[b.id]).length;
  const idle = activeBays.filter(b => !byBay[b.id] && b.status === 'available').length;
  const util = activeBays.length ? Math.round(occupied / activeBays.length * 100) : 0;

  // filter
  const visible = bays.filter(b => {
    const s = byBay[b.id];
    if (filter === 'all') return true;
    if (filter === 'maintenance') return b.status === 'maintenance';
    if (filter === 'idle') return !s && b.status === 'available';
    if (filter === 'running') return s && s.status === 'running';
    if (filter === 'paused') return s && s.status === 'paused';
    if (filter === 'overtime') return s && (s.timer && s.timer.overtime || 0) > 0;
    return true;
  });

  const detailBay = bays.find(b => b.id === detailId);
  const tabs = [['all', 'All Bays', bays.length], ['running', 'Running', running], ['idle', 'Idle', idle], ['paused', 'Paused', paused], ['overtime', 'Overtime', overtime], ['maintenance', 'Maintenance', maintenance]];

  const doStatus = async (bay, status) => { try { await BW_API.setBayStatus(bay.id, status); flash(`Bay ${lbdPad(bay.bay_number)} → ${status}`); setDetailId(null); loadBays(); } catch (e) { flash(e.message); } };
  const doDuplicate = async (bay) => { try { const r = await BW_API.duplicateBay(bay.id); setDetailId(null); loadBays(); flash((r && r.message) || 'Bay duplicated'); } catch (e) { flash(e.message || 'Could not duplicate bay'); } };
  // update UI first, then flash — never let a message read crash the delete flow
  const doDelete = async (bay) => { try { const r = await BW_API.deleteBay(bay.id); setConfirm(null); setDetailId(null); loadBays(); flash((r && r.message) || 'Bay deleted'); } catch (e) { flash(e.message || 'Could not delete bay'); setConfirm(null); } };

  return (
    <>
      {/* Header */}
      <div className="lbd-header">
        <div className="lbd-donut">
          <LbdRing pct={util / 100} color={util > 80 ? 'var(--danger)' : util > 50 ? 'var(--warn)' : 'var(--ok)'} time={`${util}%`} sub="UTILISED" size={104} stroke={8}/>
        </div>
        <div className="lbd-header-mid">
          <div className="eyebrow eyebrow-amber" style={{ marginBottom: 4 }}><span className="dot live pulsing"/> LIVE OPS · {snap.timer_backend ? snap.timer_backend.toUpperCase() : 'CONNECTED'}</div>
          <h2 style={{ margin: 0 }}>Live Bay Dashboard</h2>
          <span className="sub" style={{ marginTop: 4, display: 'block' }}>{occupied} of {activeBays.length} bays occupied · {running} running · single source of truth</span>
        </div>
        <div className="lbd-kpis">
          {[['play', running, 'Running', 'amber'], ['pause', paused, 'Paused', ''], ['queue', meta.queue, 'In Queue', ''], ['bolt', overtime, 'Overdue', overtime ? 'danger' : ''], ['check', meta.completed, 'Completed', 'ok']].map(([ic, v, l, cls], i) => (
            <div key={i} className={`lbd-kpi ${cls}`}><div className="lbd-kpi-ico"><Icon name={ic} size={15}/></div><div><div className="lbd-kpi-v">{v}</div><div className="lbd-kpi-l">{l}</div></div></div>
          ))}
        </div>
      </div>

      {/* Tabs + create */}
      <div className="lbd-toolbar">
        <div className="lbd-tabs">
          {tabs.map(([k, label, n]) => (
            <button key={k} className={`lbd-tab${filter === k ? ' active' : ''}`} onClick={() => setFilter(k)}>{label} <span className="lbd-tab-n">{n}</span></button>
          ))}
        </div>
        <div className="spacer"/>
        <span className="chip ghost mono" style={{ marginRight: 4 }}><span className="dot live pulsing"/>REAL-TIME · SYNCED</span>
        <button className="btn btn-amber btn-sm" onClick={() => setShowCreate(true)}><Icon name="plus" size={14}/> CREATE NEW BAY</button>
      </div>

      {/* Grid */}
      <div className="lbd-grid">
        {visible.map(bay => (
          <LbdCard key={bay.id} bay={bay} s={byBay[bay.id]} busy={busy === bay.id}
            td={tmrByBay[bay.id]} cd={camByBay[bay.id]} mqttOk={mqttOk}
            onAct={act} onDetails={() => setDetailId(bay.id)}
            onStart={(b) => setCwStart({ bay: b, s: byBay[b.id] })}/>
        ))}
        {visible.length === 0 && (
          <div className="file-cards-empty" style={{ gridColumn: '1 / -1' }}>
            <div className="dz-ico" style={{ width: 56, height: 56, margin: '0 auto 14px' }}><Icon name="route" size={26}/></div>
            <div style={{ fontWeight: 600, fontSize: 16 }}>No bays in “{tabs.find(t => t[0] === filter)[1]}”</div>
          </div>
        )}
      </div>

      {/* Drawer + modals */}
      {detailBay && (
        <LbdDetails bay={detailBay} s={byBay[detailBay.id]}
          onClose={() => setDetailId(null)}
          onEdit={() => { setEditBay(detailBay); setDetailId(null); }}
          onDuplicate={() => doDuplicate(detailBay)}
          onStatus={(st) => doStatus(detailBay, st)}
          onDelete={() => setConfirm({ kind: 'delete', bay: detailBay })}/>
      )}
      {cwStart && <CwStartModal bay={cwStart.bay} s={cwStart.s} flash={flash}
        onClose={() => setCwStart(null)} onStarted={() => { setCwStart(null); loadBays(); }}/>}
      {showCreate && <LbdBayModal workers={workers} onClose={() => setShowCreate(false)} onSaved={(m) => { flash(m); loadBays(); }}/>}
      {editBay && <LbdBayModal initial={editBay} workers={workers} onClose={() => setEditBay(null)} onSaved={(m) => { flash(m); loadBays(); }}/>}
      {confirm && confirm.kind === 'delete' && (
        <LbdConfirm danger title="Delete bay?" confirmLabel="DELETE"
          body={<>Bay <b style={{ color: 'var(--t-0)' }}>{lbdPad(confirm.bay.bay_number)}</b> will be permanently removed. This action cannot be undone.</>}
          onConfirm={() => doDelete(confirm.bay)} onClose={() => setConfirm(null)}/>
      )}
      {toast && <div className="ujq-toast"><Icon name="check" size={15}/> {toast}</div>}
    </>
  );
};
window.LiveBayDashboard = LiveBayDashboard;

// ════════════════════════════════════════════════════════════
//  Admin · Camera Connection — registry of physical IP cameras
//  bound to bays. Pair / Test / Reconnect / Restart, live status.
// ════════════════════════════════════════════════════════════
const CAM_STATUS = {
  online:   { cls: 'ok',     dot: 'ok pulsing', label: 'Online' },
  offline:  { cls: 'danger', dot: '',           label: 'Offline' },
  unpaired: { cls: 'ghost',  dot: '',           label: 'Unpaired' },
  disabled: { cls: 'warn',   dot: '',           label: 'Disabled' },
};
const CamStatusBadge = ({ status }) => {
  const c = CAM_STATUS[status] || CAM_STATUS.unpaired;
  return <span className={`chip ${c.cls}`}><span className={`dot ${c.dot}`}/>{c.label}</span>;
};

// Pair / edit a camera for a bay. When `bays` (unpaired rows) is provided —
// the page-level "Pair New Camera" CTA — a bay selector picks the target.
const CAM_BRANDS = ['CP Plus', 'Hikvision', 'Dahua', 'Other RTSP'];

// Build a display RTSP URL with the password ALWAYS masked (****). Never renders the
// real password. Explicit rtsp_url wins (its creds redacted); else built from
// ip:rtsp_port/rtsp_path. Returns '' when there's nothing to show.
const maskedRtsp = (f) => {
  const redact = (url) => url.replace(/(rtsp:\/\/)([^:/@\s]+)(:[^@/\s]*)?@/i, (_m, p, u) => `${p}${u}:****@`);
  if (f.rtsp_url && f.rtsp_url.trim()) return redact(f.rtsp_url.trim());
  const ip = (f.ip_address || '').trim();
  if (!ip) return '';
  const port = f.rtsp_port || 554;
  let path = (f.rtsp_path || '').trim();
  if (path && !path.startsWith('/')) path = '/' + path;
  const cred = (f.username || '').trim() ? `${f.username.trim()}:****@` : '';
  return `rtsp://${cred}${ip}:${port}${path}`;
};

const CamModal = ({ row, bays, onClose, onSaved }) => {
  const picker = !!(bays && bays.length);
  const [target, setTarget] = useLS(picker ? bays[0] : row);
  const editing = !!(target && target.camera);
  const c = (target && target.camera) || {};
  const defaults = (t) => ({
    camera_id: (t.camera && t.camera.camera_id) || `CAM-${String(t.bay_number).padStart(2, '0')}`,
    name: (t.camera && t.camera.name) || `${t.bay_name} Camera`,
    brand: (t.camera && t.camera.brand) || '',
    ip_address: (t.camera && t.camera.ip_address) || '', rtsp_url: (t.camera && t.camera.rtsp_url) || '',
    rtsp_port: (t.camera && t.camera.rtsp_port) || 554, rtsp_path: (t.camera && t.camera.rtsp_path) || '',
    onvif_port: (t.camera && t.camera.onvif_port) || 554, username: (t.camera && t.camera.username) || 'admin', password: '',
  });
  const [f, setF] = useLS(defaults(target));
  const [busy, setBusy] = useLS(false); const [err, setErr] = useLS('');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const pickBay = (e) => {
    const b = bays.find((x) => x.bay_id === e.target.value) || bays[0];
    setTarget(b); setF(defaults(b));
  };
  const save = async () => {
    setBusy(true); setErr('');
    try {
      if (editing) await BW_API.updateCamera(c.id, f);
      else await BW_API.pairCamera({ bay_id: target.bay_id, ...f });
      onSaved();
    } catch (e) { setErr(e.message || 'Failed to save'); setBusy(false); }
  };
  return (
    <div className="modal-scrim" onClick={onClose} style={{ zIndex: 300 }}>
      <div className="cam-modal" onClick={(e) => e.stopPropagation()}>
        <div className="cam-modal-head">
          <div><div className="cam-modal-t">{editing ? 'Edit Camera' : 'Pair Camera'} · {target.bay_name}</div>
            <div className="cam-modal-s">Bind a physical IP camera (RTSP / ONVIF) to this bay</div></div>
          <button className="modal-close" onClick={onClose}><Icon name="x" size={15}/></button>
        </div>
        <div className="cam-form">
          {picker && <label className="cam-field full"><span>Bay</span>
            <select value={target.bay_id} onChange={pickBay} className="cam-select">
              {bays.map((b) => <option key={b.bay_id} value={b.bay_id}>BAY {String(b.bay_number).padStart(2, '0')} · {b.bay_name}</option>)}
            </select></label>}
          <label className="cam-field"><span>Camera ID</span><input value={f.camera_id} onChange={set('camera_id')} placeholder="CAM-CHN-01"/></label>
          <label className="cam-field"><span>Camera Name</span><input value={f.name} onChange={set('name')}/></label>
          <label className="cam-field"><span>Brand</span>
            <select value={f.brand} onChange={set('brand')} className="cam-select">
              <option value="">—</option>
              {CAM_BRANDS.map((b) => <option key={b} value={b}>{b}</option>)}
            </select></label>
          <label className="cam-field"><span>IP Address</span><input value={f.ip_address} onChange={set('ip_address')} placeholder="192.168.1.101"/></label>
          <label className="cam-field"><span>RTSP Port</span><input type="number" value={f.rtsp_port} onChange={set('rtsp_port')}/></label>
          <label className="cam-field"><span>ONVIF Port</span><input type="number" value={f.onvif_port} onChange={set('onvif_port')}/></label>
          <label className="cam-field full"><span>RTSP Path</span><input value={f.rtsp_path} onChange={set('rtsp_path')} placeholder="/cam/realmonitor?channel=1&subtype=0"/></label>
          <label className="cam-field full"><span>Full RTSP URL <span className="cam-hint">optional · overrides IP/port/path</span></span><input value={f.rtsp_url} onChange={set('rtsp_url')} placeholder="rtsp://192.168.1.101:554/live"/></label>
          <label className="cam-field"><span>Username</span><input value={f.username} onChange={set('username')}/></label>
          <label className="cam-field"><span>Password</span><input type="password" value={f.password} onChange={set('password')} placeholder={editing ? '•••• unchanged' : ''}/></label>
          {maskedRtsp(f) && <div className="cam-field full ops-rtsp-preview"><span className="k">RTSP URL preview</span><span className="v mono">{maskedRtsp(f)}</span></div>}
        </div>
        {err && <div className="cam-err"><Icon name="alert" size={12}/> {err}</div>}
        <div className="cam-modal-foot">
          <button className="btn btn-ghost" onClick={onClose}>CANCEL</button>
          <button className="btn btn-amber" onClick={save} disabled={busy}>{busy ? '…' : (editing ? 'SAVE CHANGES' : 'PAIR CAMERA')}</button>
        </div>
      </div>
    </div>
  );
};

// ════ OPS REDESIGN — shared premium primitives (camera + timer pages) ════
const OpsPageHead = ({ eyebrow, title, sub, children }) => (
  <div className="ops-head">
    <div><div className="eyebrow eyebrow-amber">● {eyebrow}</div><h1>{title}</h1>
      <span className="sub">{sub}</span></div>
    <div className="head-actions">{children}</div>
  </div>
);
const OpsKpi = ({ value, label, sub, tone, live }) => (
  <div className={`ops-kpi ${tone || ''}`}>
    <div className="ops-kpi-v">{live && <span className={`dot ${tone === 'ok' ? 'ok pulsing' : ''}`}/>}{value}</div>
    <div className="ops-kpi-l">{label}{sub ? <span className="ops-kpi-s">{sub}</span> : null}</div>
  </div>
);
const OpsBadge = ({ tone, children }) => <span className={`ops-badge ${tone}`}>{children}</span>;
const OpsSpec = ({ k, children }) => (<div className="ops-spec"><span className="k">{k}</span><span className="v">{children}</span></div>);
const OpsSec = ({ title, children }) => (<div className="ops-sec"><div className="ops-sec-t">{title}</div>{children}</div>);
const OpsRow = ({ k, v, mono }) => (<div className="ops-kv"><span className="k">{k}</span><span className={`v ${mono ? 'mono' : ''}`}>{v == null || v === '' ? '—' : v}</span></div>);
const OpsField = ({ label, value, onChange, type, placeholder }) => (
  <label className="ops-field"><span>{label}</span>
    <input type={type || 'text'} value={value} onChange={onChange} placeholder={placeholder || ''}/></label>
);

// status → visual tone for a device row (camera or timer)
const opsTone = (status) => status === 'online' ? 'ok' : status === 'offline' ? 'danger' : 'idle';
const opsHealth = (status) =>
  status === 'online' ? { tone: 'ok', label: 'HEALTHY' } :
  status === 'offline' ? { tone: 'danger', label: 'UNREACHABLE' } :
  status === 'disabled' ? { tone: 'warn', label: 'DISABLED' } : { tone: 'idle', label: 'EMPTY SLOT' };

// attention sort: offline first (needs action) → recording → online → rest
const opsAttention = (status, rec) =>
  status === 'offline' ? 0 : rec === 'recording' ? 1 : status === 'online' ? 2 : 3;

// search box + status filter chips + sort note — one toolbar for every fleet page
const OpsToolbar = ({ q, setQ, chips, chip, setChip, shown, placeholder }) => (
  <div className="ops-toolbar">
    <div className="ops-search">
      <Icon name="scan" size={14}/>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} aria-label={placeholder}/>
      {q && <button className="ops-search-x" aria-label="Clear search" onClick={() => setQ('')}><Icon name="x" size={12}/></button>}
    </div>
    <div className="ops-chips" role="tablist" aria-label="Filter by status">
      {chips.map((c) => (
        <button key={c} role="tab" aria-selected={chip === c}
          className={`ops-chip ${chip === c ? 'active' : ''}`} onClick={() => setChip(c)}>{c}</button>
      ))}
    </div>
    <span className="ops-sort mono" title="Offline first, then recording, then online">⇅ attention · {shown} shown</span>
  </div>
);

// skeleton card grid shown before the first poll resolves
const OpsSkeleton = ({ n }) => (
  <div className="ops-grid" aria-hidden="true">
    {Array.from({ length: n || 6 }).map((_, i) => (
      <div key={i} className="ops-card ops-skel">
        <div className="skel-line w45"/><div className="skel-block"/><div className="skel-line w70"/>
      </div>
    ))}
  </div>
);

// collapsible "how to connect …" setup guide (one per device page)
const OpsGuide = ({ title, icon, children }) => {
  const [open, setOpen] = useLS(false);
  return (
    <details className="ops-guide" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="ops-guide-head"><Icon name={icon || 'route'} size={13}/> <span>{title}</span></summary>
      <div className="ops-guide-body">{children}</div>
    </details>
  );
};

// "When Admin clicks Start on Bay XX" workflow explainer (timer + camera drawers)
const OpsStartFlow = ({ bayNum, steps }) => (
  <div className="ops-flowbox">
    <div className="ops-flowbox-t"><Icon name="play" size={12}/> When Admin clicks Start on Bay {String(bayNum).padStart(2, '0')}</div>
    <ol className="ops-flowbox-list">{steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
  </div>
);

// confirmation for dangerous actions — nothing dangerous is one click.
// confirmWord (optional): destructive ops require typing it; frequent state
// changes (e.g. Complete Service) use button-only mode with a cascade list.
const ConfirmDialog = ({ title, message, items, confirmWord, actionLabel, onConfirm, onClose, busy }) => {
  const [word, setWord] = useLS('');
  useLE(() => {
    const h = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  const gated = confirmWord ? word !== confirmWord : false;
  return (
    <div className="modal-scrim" style={{ zIndex: 360 }} onClick={onClose}>
      <div className="ops-confirm" role="alertdialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="ops-confirm-ico"><Icon name="alert" size={18}/></div>
        <div className="ops-confirm-t">{title}</div>
        <div className="ops-confirm-m">{message}</div>
        {items && items.length > 0 && (
          <ul className="ops-confirm-list">
            {items.map((it) => <li key={it}><Icon name="chevron-right" size={11}/>{it}</li>)}
          </ul>
        )}
        {confirmWord && (
          <label className="ops-field"><span>Type {confirmWord} to confirm</span>
            <input autoFocus value={word} onChange={(e) => setWord(e.target.value)} placeholder={confirmWord}
              aria-label={`Type ${confirmWord} to confirm`}/></label>
        )}
        <div className="ops-confirm-foot">
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn btn-sm ops-danger-btn" autoFocus={!confirmWord} disabled={gated || busy} onClick={onConfirm}>
            {busy ? '…' : actionLabel}</button>
        </div>
      </div>
    </div>
  );
};

// unpaired bays live in a compact, collapsed strip — they never dominate the grid
const UnpairedStrip = ({ rows, label, onPair, forceOpen }) => {
  const [open, setOpen] = useLS(false);
  if (!rows.length) return null;
  const isOpen = forceOpen || open;
  return (
    <div className="ops-strip">
      <button className="ops-strip-head" aria-expanded={isOpen} onClick={() => setOpen(!open)}>
        <span className="ops-strip-t"><Icon name="plus" size={13}/> Available Bays <b>{rows.length}</b></span>
        <Icon name={isOpen ? 'chevron-up' : 'chevron-down'} size={14}/>
      </button>
      {isOpen && (
        <div className="ops-strip-body">
          {rows.map((r) => <span key={r.bay_id} className="ops-strip-chip mono">BAY {String(r.bay_number).padStart(2, '0')}</span>)}
          <button className="btn btn-amber btn-sm" onClick={onPair}><Icon name="plus" size={12}/> {label}</button>
        </div>
      )}
    </div>
  );
};

// one-card-per-bay: an UNPAIRED bay renders as a full clickable "Pair this bay" tile
// in the same grid (camera + timer pages), so every bay is always visible.
const UnpairedBayCard = ({ row, kind, onPair }) => {
  const label = kind === 'timer' ? 'timer' : 'camera';
  const key = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPair(); } };
  return (
    <div className="ops-card unpaired" role="button" tabIndex={0}
      aria-label={`Bay ${row.bay_number} has no ${label} paired. Pair this bay.`}
      onClick={onPair} onKeyDown={key}>
      <div className="ops-card-top">
        <span className="ops-dot idle"/>
        <div className="ops-card-id">
          <div className="ops-name">Bay {String(row.bay_number).padStart(2, '0')}</div>
          <div className="ops-sub mono">{row.bay_name}</div>
        </div>
        <OpsBadge tone="idle">UNPAIRED</OpsBadge>
      </div>
      <div className="ops-unpaired-body">
        <Icon name={kind === 'timer' ? 'clock' : 'cam'} size={22}/>
        <span>No {label} paired for this bay</span>
      </div>
      <div className="ops-foot">
        <span className="ops-pair-cta"><Icon name="plus" size={12}/> Pair this bay</span>
      </div>
    </div>
  );
};

// ── Camera detail drawer (info · connection · credentials · health · history) ──
const CamDrawer = ({ row, rec, onClose, onChanged, flash }) => {
  const cam = row.camera;
  const init = {
    name: cam.name || '', brand: cam.brand || '', ip_address: cam.ip_address || '',
    rtsp_url: cam.rtsp_url || '', rtsp_port: cam.rtsp_port || 554, rtsp_path: cam.rtsp_path || '',
    onvif_port: cam.onvif_port || 554, username: cam.username || '', password: '',
  };
  const [f, setF] = useLS(init);
  const [health, setHealth] = useLS(null);   // filled by the real Test probe
  const [busy, setBusy] = useLS(false);
  const [confirm, setConfirm] = useLS(false);
  const dirty = JSON.stringify(f) !== JSON.stringify(init);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const h = opsHealth(row.status);
  useLE(() => {   // Escape closes the drawer (unless the confirm dialog has it)
    const onKey = (e) => { if (e.key === 'Escape' && !confirm) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirm]);
  const run = async (fn, okMsg) => {
    setBusy(true);
    try { const r = await fn(); flash((r && r.message) || okMsg); if (r && r.data) setHealth(r.data); onChanged(); }
    catch (e) { flash(e.message || 'Action failed'); }
    finally { setBusy(false); }
  };
  const save = () => run(() => BW_API.updateCamera(cam.id, {
    ...f, rtsp_port: Number(f.rtsp_port) || 554, onvif_port: Number(f.onvif_port) || 554,
    password: f.password || undefined,
  }), 'Camera saved');
  const rtspPreview = maskedRtsp(f);
  const remove = async () => {
    setBusy(true);
    try { await BW_API.unpairCamera(cam.id); flash('Camera removed'); onChanged(); onClose(); }
    catch (e) { flash(e.message || 'Remove failed'); setBusy(false); }
  };
  return (
    <div className="ops-drawer-scrim" onClick={onClose}>
      <div className="ops-drawer" role="dialog" aria-modal="true" aria-label={`${cam.name} details`} onClick={(e) => e.stopPropagation()}>
        <div className="ops-drawer-head">
          <div className="ops-drawer-id">
            <span className={`ops-dot ${opsTone(row.status)}`}/>
            <div><div className="ops-drawer-t">{cam.name}</div>
              <div className="ops-drawer-s mono">{cam.camera_id} · BAY {String(row.bay_number).padStart(2, '0')}</div></div>
          </div>
          <div className="row" style={{ gap: 10 }}>
            <OpsBadge tone={h.tone}>{h.label}</OpsBadge>
            <button className="modal-close" aria-label="Close details" onClick={onClose}><Icon name="x" size={15}/></button>
          </div>
        </div>
        <div className="ops-drawer-body">
          {rec === 'recording'
            ? <div className="ops-preview live"><span className="dot ok pulsing"/><span>FEED ACTIVE — recording this bay now</span><span className="ops-preview-s">watch it in Live Bay Dashboard / Bay Monitoring</span></div>
            : <div className="ops-preview-idle"><Icon name="cam" size={14}/><span>No active feed — the live preview appears when a service starts on this bay</span></div>}
          <OpsSec title="CAMERA INFORMATION">
            <OpsRow k="Camera ID" v={cam.camera_id} mono/>
            <OpsRow k="Bay" v={`BAY ${String(row.bay_number).padStart(2, '0')} · ${row.bay_name}`}/>
            <OpsRow k="Channel" v={row.camera_channel} mono/>
            <OpsRow k="Recording" v={rec === 'recording' ? 'LIVE — capturing now' : rec === 'paused' ? 'Paused' : 'Idle'}/>
          </OpsSec>
          <OpsStartFlow bayNum={row.bay_number} steps={[
            'Resolve the camera paired to this bay.',
            'Open the RTSP stream.',
            'Start FFmpeg recording (saved locally).',
            'Enable the live stream for Admin / Master / Customer if allowed.',
            'Complete stops recording; the file is saved.',
            'Google Drive archival uploads after completion if configured.',
          ]}/>
          <OpsSec title="CONNECTION">
            <div className="ops-form">
              <OpsField label="Camera Name" value={f.name} onChange={set('name')}/>
              <label className="ops-field"><span>Brand</span>
                <select value={f.brand} onChange={set('brand')}>
                  <option value="">—</option>
                  {CAM_BRANDS.map((b) => <option key={b} value={b}>{b}</option>)}
                </select></label>
              <OpsField label="IP Address" value={f.ip_address} onChange={set('ip_address')} placeholder="192.168.1.101"/>
              <OpsField label="RTSP Port" value={f.rtsp_port} onChange={set('rtsp_port')} type="number"/>
              <OpsField label="RTSP Path" value={f.rtsp_path} onChange={set('rtsp_path')} placeholder="/cam/realmonitor?channel=1&subtype=0"/>
              <OpsField label="Full RTSP URL (optional)" value={f.rtsp_url} onChange={set('rtsp_url')} placeholder="rtsp://…/live"/>
              <OpsField label="ONVIF Port" value={f.onvif_port} onChange={set('onvif_port')} type="number"/>
            </div>
            {rtspPreview && <div className="ops-rtsp-preview"><span className="k">RTSP URL preview</span><span className="v mono">{rtspPreview}</span></div>}
          </OpsSec>
          <OpsSec title="CREDENTIALS">
            <div className="ops-form">
              <OpsField label="Username" value={f.username} onChange={set('username')}/>
              <OpsField label="Password" value={f.password} onChange={set('password')} type="password" placeholder="•••• unchanged"/>
            </div>
            <div className="ops-guide-note"><Icon name="shield" size={11}/> The password is stored server-side and never shown here; previews always mask it as ****.</div>
          </OpsSec>
          <OpsSec title="CONNECTION TEST">
            <OpsRow k="Status" v={row.status.toUpperCase()}/>
            <OpsRow k="Result" v={health ? (health.reachable ? 'Reachable' : 'Unreachable') : 'run a test'}/>
            <OpsRow k="Resolution" v={health && health.reachable && health.resolution ? health.resolution : '—'} mono/>
            <OpsRow k="Codec" v={health && health.reachable && health.codec ? health.codec : '—'} mono/>
            <OpsRow k="Frame rate" v={health && health.reachable && health.fps ? `${health.fps} fps` : '—'} mono/>
            {health && !health.reachable && (health.detail || health.last_error) && <div className="ops-test-err"><Icon name="alert" size={11}/> {health.detail || health.last_error}</div>}
            {!health && cam.last_error && <div className="ops-test-err"><Icon name="alert" size={11}/> Last error: {cam.last_error}</div>}
            <button className="ops-act wide" disabled={busy} onClick={() => run(() => BW_API.testCamera(cam.id), 'Camera test complete')}><Icon name="play" size={12}/> Test RTSP (real probe)</button>
          </OpsSec>
          <OpsSec title="FUTURE OPTIONAL">
            <OpsRow k="Stream type" v="Future optional"/>
            <OpsRow k="Transport" v="Future optional"/>
            <OpsRow k="Codec preference" v="Future optional"/>
            <OpsRow k="Resolution / FPS" v="Future optional"/>
            <OpsRow k="Audio" v="Future optional"/>
          </OpsSec>
          <OpsSec title="CONNECTION HISTORY">
            <OpsRow k="Last heartbeat" v={row.last_seen}/>
            <OpsRow k="Reconnect" v={<button className="ops-act" disabled={busy} onClick={() => run(() => BW_API.reconnectCamera(cam.id), 'Reconnected')}><Icon name="route" size={12}/> Reconnect now</button>}/>
          </OpsSec>
          <OpsSec title="DANGER ZONE">
            <div className="ops-danger">
              <div><div className="ops-danger-t">Remove this camera</div>
                <div className="ops-danger-s">Unpairs {cam.camera_id} from BAY {String(row.bay_number).padStart(2, '0')}. New services on this bay will not be captured.</div></div>
              <button className="btn btn-sm ops-danger-btn" disabled={busy} onClick={() => setConfirm(true)}>Remove Camera</button>
            </div>
          </OpsSec>
        </div>
        <div className="ops-drawer-foot">
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => run(() => BW_API.reconnectCamera(cam.id), 'Re-probed')}><Icon name="route" size={13}/> Reconnect</button>
          <button className="btn btn-amber btn-sm" disabled={busy || !dirty} title={dirty ? '' : 'No changes to save'} onClick={save}>{busy ? '…' : 'Save Changes'}</button>
        </div>
        {confirm && <ConfirmDialog title="Remove camera?" confirmWord="REMOVE" actionLabel="Remove Camera"
          message={`${cam.name} (${cam.camera_id}) will be unpaired from BAY ${String(row.bay_number).padStart(2, '0')}. This cannot be undone from this page.`}
          busy={busy} onConfirm={remove} onClose={() => setConfirm(false)}/>}
      </div>
    </div>
  );
};

// ── Camera card — one visible action (Details →); everything else lives in the drawer ──
const CamCard = ({ row, rec, onOpen }) => {
  const cam = row.camera;
  const h = opsHealth(row.status);
  const recording = rec === 'recording';
  const exceptional = row.status !== 'online';
  const key = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } };
  return (
    <div className={`ops-card ${recording ? 'rec' : opsTone(row.status)}`} role="button" tabIndex={0}
      aria-label={`${cam.name}, bay ${row.bay_number}, ${h.label.toLowerCase()}${recording ? ', recording live' : ''}. Open details.`}
      onClick={onOpen} onKeyDown={key}>
      {recording && <span className="ops-ribbon" aria-hidden="true"><span className="ops-ribbon-dot"/>REC</span>}
      <div className="ops-card-top">
        <span className={`ops-dot ${opsTone(row.status)}`}/>
        <div className="ops-card-id">
          <div className="ops-name">{cam.name}</div>
          <div className="ops-sub mono">{cam.camera_id} · BAY {String(row.bay_number).padStart(2, '0')}</div>
        </div>
        {exceptional
          ? <OpsBadge tone={h.tone}>{h.label}</OpsBadge>
          : <span className="ops-fresh mono" title="Last heartbeat">● {row.last_seen}</span>}
      </div>
      <div className="ops-specs">
        <OpsSpec k="IP ADDRESS"><span className="mono">{cam.ip_address || '—'}</span></OpsSpec>
        <OpsSpec k="STREAM">{recording ? <span className="ops-rec">LIVE</span> : rec === 'paused' ? <span className="ops-warntxt">Paused</span> : <span className="ops-mut">Idle</span>}</OpsSpec>
        <OpsSpec k="HEALTH">{row.status === 'online' ? <span className="ops-oktxt">Stable</span> : <span className="ops-mut">{h.label.charAt(0) + h.label.slice(1).toLowerCase()}</span>}</OpsSpec>
      </div>
      <div className="ops-foot">
        <span className="ops-seen">RTSP {cam.rtsp_url ? 'configured' : 'not set'} · seen {row.last_seen}</span>
        <span className="ops-details">Details <Icon name="arrow-right" size={12}/></span>
      </div>
    </div>
  );
};

const CAM_CHIPS = ['All', 'Online', 'Offline', 'Recording', 'Unpaired'];

const LiveCameraConnection = () => {
  // cameras + live dashboard joined → per-bay recording state (no extra backend)
  const poll = useBWPoll(async () => {
    const [cams, dash] = await settle([[BW_API.camerasList(), { summary: {}, cameras: [] }], [BW_API.dashboard(), { bays: [] }]]);
    const recByBay = {};
    ((dash && dash.bays) || []).forEach((b) => {
      if (b.status === 'running') recByBay[b.bay_id] = 'recording';
      else if (b.status === 'paused') recByBay[b.bay_id] = 'paused';
    });
    return { ...cams, recByBay };
  }, [], 5000);
  const data = poll.data;
  const [modal, setModal] = useLS(null);
  const [drawer, setDrawer] = useLS(null);        // bay_id of the open camera
  const [toast, setToast] = useLS('');
  const [q, setQ] = useLS('');
  const [chip, setChip] = useLS('All');
  const flash = (m) => { setToast(m); setTimeout(() => setToast(''), 3200); };

  const rows = (data && data.cameras) || [];
  const recByBay = (data && data.recByBay) || {};
  const paired = rows.filter((r) => r.camera);
  const unpaired = rows.filter((r) => !r.camera);
  // TRUTHFUL KPIs — count paired camera devices, never bays
  const kOnline = paired.filter((r) => r.status === 'online').length;
  const kOffline = paired.filter((r) => r.status === 'offline').length;
  const kRec = paired.filter((r) => recByBay[r.bay_id] === 'recording').length;

  // search + filter + attention sort
  const match = (r) => {
    if (!q) return true;
    const cam = r.camera || {};
    return [cam.name, cam.camera_id, cam.ip_address, `bay ${r.bay_number}`, r.bay_name, r.status]
      .some((v) => v && String(v).toLowerCase().includes(q.toLowerCase()));
  };
  const byChip = (r) =>
    chip === 'All' ? true :
    chip === 'Online' ? r.status === 'online' :
    chip === 'Offline' ? r.status === 'offline' :
    chip === 'Recording' ? recByBay[r.bay_id] === 'recording' : true;
  const qmatchBay = (r) => !q || [`bay ${r.bay_number}`, r.bay_name].some((v) => v && String(v).toLowerCase().includes(q.toLowerCase()));
  const pairedShown = chip === 'Unpaired' ? [] : paired.filter(match).filter(byChip)
    .sort((a, b) => opsAttention(a.status, recByBay[a.bay_id]) - opsAttention(b.status, recByBay[b.bay_id]) || a.bay_number - b.bay_number);
  const unpairedShown = (chip === 'All' || chip === 'Unpaired') ? unpaired.filter(qmatchBay).sort((a, b) => a.bay_number - b.bay_number) : [];
  const shownCount = pairedShown.length + unpairedShown.length;
  const drawerRow = drawer && paired.find((r) => r.bay_id === drawer);

  return (
    <>
      <OpsPageHead eyebrow="CAMERA CONFIGURATION" title="Camera Configuration" sub="Manage all bay cameras and recording devices.">
        <button className="btn btn-ghost btn-sm" aria-label="Refresh list" onClick={() => poll.reload()}><Icon name="route" size={13}/> Refresh</button>
        <button className="btn btn-ghost btn-sm" title="Open the Camera / RTSP capture defaults"
          onClick={() => window.dispatchEvent(new CustomEvent('bw:camera-open-config'))}><Icon name="tools" size={13}/> Capture defaults</button>
        <button className="btn btn-amber btn-sm" disabled={!unpaired.length}
          title={unpaired.length ? 'Pair a camera to an available bay' : 'Every bay already has a camera'}
          onClick={() => setModal({ bays: unpaired })}><Icon name="plus" size={13}/> Pair Camera</button>
      </OpsPageHead>

      <div className="ops-kpis">
        <OpsKpi value={paired.length} label="Paired Cameras" sub={`of ${rows.length} bays`}/>
        <OpsKpi value={kOnline} label="Online" tone="ok" live/>
        <OpsKpi value={kOffline} label="Offline" tone="danger"/>
        <OpsKpi value={kRec} label="Recording Live" tone="warn"/>
      </div>

      <OpsToolbar q={q} setQ={setQ} chips={CAM_CHIPS} chip={chip} setChip={setChip}
        shown={shownCount} placeholder="Search camera, bay, IP, ID, status…"/>

      <OpsGuide title="How to connect a CP Plus camera" icon="cam">
        <ol className="ops-guide-steps">
          <li>Use a PoE IP camera (not a consumer cloud camera).</li>
          <li>Connect the camera to the PoE switch via LAN.</li>
          <li>Set a <b>static IP</b> for the camera.</li>
          <li>Enable <b>RTSP</b> (and ONVIF if available) in the camera settings.</li>
          <li>Create a camera username / password.</li>
          <li>Open the bay card below → enter IP, username, password, RTSP path.</li>
          <li>Click <b>Test RTSP</b>, then <b>Test Recording</b>.</li>
          <li>If the test passes, the camera is ready.</li>
          <li>Admin Live Dashboard <b>Start</b> will then record only this bay's camera.</li>
        </ol>
        <div className="ops-guide-topics mono">rtsp://USERNAME:****@CAMERA_IP:554/cam/realmonitor?channel=1&amp;subtype=0</div>
        <div className="ops-guide-note">The password is always masked in previews and never returned to this screen. Test runs a real ffprobe — an unreachable camera reports honest offline (never a fake green).</div>
      </OpsGuide>

      {!data ? <OpsSkeleton n={6}/> : (
        <div className="ops-grid">
          {pairedShown.map((row) => (
            <CamCard key={row.bay_id} row={row} rec={recByBay[row.bay_id]} onOpen={() => setDrawer(row.bay_id)}/>
          ))}
          {unpairedShown.map((row) => (
            <UnpairedBayCard key={row.bay_id} row={row} kind="camera" onPair={() => setModal({ bays: [row] })}/>
          ))}
          {shownCount === 0 && (
            <div className="ops-none">
              <Icon name="cam" size={20}/>
              <span>{rows.length === 0 ? 'No bays yet.' : 'Nothing matches this search / filter.'}</span>
            </div>
          )}
        </div>
      )}

      {drawerRow && <CamDrawer row={drawerRow} rec={recByBay[drawerRow.bay_id]} flash={flash}
        onClose={() => setDrawer(null)} onChanged={() => poll.reload()}/>}
      {modal && <CamModal row={modal.row} bays={modal.bays} onClose={() => setModal(null)} onSaved={() => { setModal(null); flash('Camera paired'); poll.reload(); }}/>}
      {toast && <div className="lbd-toast" role="status">{toast}</div>}
    </>
  );
};
window.LiveCameraConnection = LiveCameraConnection;
// Exposed so the Bay Readiness Overview (integrations.jsx) reuses the SAME
// pair/edit form — no duplicated camera business logic.
window.CamModal = CamModal;

// ════════════════════════════════════════════════════════════
//  Admin · Storage Management (Drive archival + local SSD)
//  Total Local · Drive Status · Pending · Failed · Archived ·
//  Expired. Buttons: Retry Upload · Sync Now · Refresh.
// ════════════════════════════════════════════════════════════
// Truthful storage state (backed by real stored fields + a live file check).
const STOR_STATE = {
  local_saved:       { cls: 'ghost',  label: 'On SSD' },
  upload_pending:    { cls: 'warn',   label: 'Pending upload' },
  upload_in_progress:{ cls: 'warn',   label: 'Uploading' },
  upload_failed:     { cls: 'danger', label: 'Upload failed' },
  drive_uploaded:    { cls: 'ok',     label: 'Uploaded to Drive' },
  local_missing:     { cls: 'danger', label: 'Local missing' },
  expired:           { cls: 'ghost',  label: 'Expired' },
  expired_unarchived:{ cls: 'warn',   label: 'Expired · Not archived' },
  deleted:           { cls: 'ghost',  label: 'Deleted' },
  deletion_failed:   { cls: 'danger', label: 'Deletion failed' },
  recording:         { cls: 'warn',   label: 'Recording' },
  none:              { cls: 'ghost',  label: '—' },
};
const StorStateBadge = ({ s }) => {
  const c = STOR_STATE[s] || STOR_STATE.none;
  return <span className={`chip ${c.cls}`}>{c.label}</span>;
};
// Local + Drive sub-status chips (two independent truths per recording).
const STOR_LOCAL = { saved: { cls: 'ok', label: 'Local ✓' }, missing: { cls: 'danger', label: 'Local ✗' }, none: { cls: 'ghost', label: 'No local' } };
const STOR_DRIVE = { uploaded: { cls: 'ok', label: 'Drive ✓' }, pending: { cls: 'warn', label: 'Drive …' }, uploading: { cls: 'warn', label: 'Drive …' }, failed: { cls: 'danger', label: 'Drive ✗' }, none: { cls: 'ghost', label: 'No Drive' } };
const StorMini = ({ map, s }) => { const c = map[s] || map.none; return <span className={`stor-mini ${c.cls}`}>{c.label}</span>; };

const LiveStorageManagement = () => {
  const poll = useBWPoll(() => BW_API.storageOverview(), [], 5000);
  const data = poll.data || { drive: {}, local: {}, counts: {}, lists: {} };
  const [busy, setBusy] = useLS(false);
  const [busyId, setBusyId] = useLS(null);
  const [toast, setToast] = useLS('');
  const flash = (m) => { setToast(m); setTimeout(() => setToast(''), 4000); };

  const drive = data.drive || {};
  const c = data.counts || {};
  const local = data.local || {};
  const lists = data.lists || {};
  const driveState = !drive.configured ? { cls: 'ghost', label: 'Not configured' }
    : drive.reachable ? { cls: 'ok', label: 'Connected' } : { cls: 'danger', label: 'Unreachable' };
  const localLabel = (local.total_gb >= 1) ? `${local.total_gb} GB` : `${local.total_mb || 0} MB`;

  const openDriveConfig = (notice) => {
    window.__bwIntgPending = { provider: 'google_drive', notice: notice || null, ts: Date.now() };
    window.dispatchEvent(new CustomEvent('bw:navigate', { detail: { tab: 'integrations' } }));
    window.dispatchEvent(new CustomEvent('bw:integrations-open', { detail: { provider: 'google_drive', notice: notice || null } }));
  };
  const syncNow = async () => {
    if (!drive.configured) {
      const m = 'Google Drive is not configured — configure Drive archival before syncing.';
      flash(m); openDriveConfig(m); return;
    }
    setBusy(true);
    try { const r = await BW_API.storageSyncNow(); flash((r && r.message) || 'Drive sync started'); setTimeout(() => poll.reload(), 1500); }
    catch (e) { flash(e.message || 'Sync failed'); }
    finally { setBusy(false); }
  };
  // every action reports the REAL server result — no optimistic / fake success
  const act = async (rec, fn, fallback) => {
    setBusyId(rec.recording_id);
    try { const r = await fn(rec.recording_id); flash((r && r.message) || fallback); poll.reload(); }
    catch (e) { flash(e.message || 'Action failed'); }
    finally { setBusyId(null); }
  };
  const retry  = (r) => act(r, BW_API.storageRetry,  'Retry triggered');
  const verify = (r) => act(r, BW_API.storageVerify, 'Verified');
  const expire = (r) => act(r, BW_API.storageExpire, 'Marked expired');
  const del    = (r) => act(r, BW_API.storageDelete, 'Delete processed');

  // one truthful row, reused by every section. `acts` lists which buttons apply.
  const Row = ({ r, acts }) => {
    const b = busyId === r.recording_id;
    const expired = r.state === 'expired' || r.state === 'expired_unarchived' || r.state === 'deleted';
    return (
      <div className="stor-row stor-rich">
        <span className="stor-cell">
          <div className="stor-id mono">{r.recording_id}</div>
          <div className="stor-ctx">{r.job_card_number || r.session_id}{r.vehicle_number ? ` · ${r.vehicle_number}` : ''}</div>
          <div className="stor-ctx2">{[r.customer_name, r.bay_number != null ? `Bay ${r.bay_number}` : null, r.worker_name].filter(Boolean).join(' · ') || '—'}</div>
        </span>
        <span><StorStateBadge s={r.state}/>{r.attempts > 0 && !expired && <span className="stor-att">·{r.attempts} try</span>}</span>
        <span className="stor-subs"><StorMini map={STOR_LOCAL} s={r.local_status}/><StorMini map={STOR_DRIVE} s={r.drive_status}/></span>
        <span className="mono">{r.size_mb} MB</span>
        <span className="stor-date">{r.expiry_date}{r.days_left > 0 && <span className="stor-days"> · {r.days_left}d</span>}<div className="stor-verif">{r.last_verified ? `checked ${r.last_verified}` : 'not checked'}</div></span>
        <span className="stor-err">{r.delete_error ? <span className="stor-errtxt danger" title={r.delete_error}><Icon name="alert" size={11}/> {r.delete_error}</span>
          : r.error ? <span className="stor-errtxt" title={r.error}><Icon name="alert" size={11}/> {r.error}</span> : '—'}</span>
        <span className="stor-actions">
          {acts.includes('verify') && <button className="btn btn-sm btn-ghost" disabled={b} onClick={() => verify(r)} title="Check the real local file + Drive link"><Icon name="route" size={12}/> Verify</button>}
          {acts.includes('retry') && <button className="btn btn-sm btn-amber" disabled={!drive.configured || b} onClick={() => retry(r)} title={drive.configured ? 'Retry the Drive upload' : 'Configure Google Drive first'}><Icon name="arrow-up" size={12}/> Retry</button>}
          {acts.includes('view') && r.available && r.drive_url && <a className="btn btn-sm btn-ghost" href={r.drive_url} target="_blank" rel="noreferrer"><Icon name="play" size={12}/> Open</a>}
          {acts.includes('expire') && !expired && <button className="btn btn-sm btn-ghost" disabled={b} onClick={() => expire(r)} title="Stop customer access now (no file deleted)"><Icon name="pause" size={12}/> Expire</button>}
          {acts.includes('delete') && <button className="btn btn-sm stor-del" disabled={b} onClick={() => del(r)} title="Delete this expired recording's files"><Icon name="x" size={12}/> Delete</button>}
        </span>
      </div>
    );
  };
  const Section = ({ title, rows, acts, empty, eyebrowCls }) => (
    <div className="card"><div className="card-head"><span className={`eyebrow ${eyebrowCls || 'eyebrow-amber'}`}>{title}</span></div>
      <div className="stor-table">
        <div className="stor-row stor-rich stor-head">
          <span>RECORDING / SERVICE</span><span>STATE</span><span>LOCAL · DRIVE</span><span>SIZE</span><span>EXPIRES / CHECKED</span><span>ERROR</span><span>ACTIONS</span>
        </div>
        {(rows || []).map((r) => <Row key={r.recording_id} r={r} acts={acts}/>)}
        {(!rows || rows.length === 0) && <div className="cam-empty"><Icon name="check" size={20}/><span>{empty}</span></div>}
      </div>
    </div>
  );

  return (
    <>
      <div className="content-head">
        <div><div className="eyebrow eyebrow-amber">● STORAGE MANAGEMENT</div><h1>Storage Management</h1>
          <span className="sub">Local SSD ↔ Google Drive archival · {data.retention_days || 14}-day retention · auto-sync every {data.sweep_interval_hours || 6}h · truthful storage state</span></div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => poll.reload()}><Icon name="route" size={13}/> Refresh</button>
          <button className="btn btn-amber btn-sm" disabled={busy} title={drive.configured ? 'Run the Drive archive sweep now' : 'Configure Google Drive first'} onClick={syncNow}><Icon name="arrow-up" size={13}/> {busy ? 'Syncing…' : 'Sync Now'}</button>
        </div>
      </div>

      {!drive.configured && <div className="stor-banner"><Icon name="alert" size={14}/>
        <span>Google Drive archival is <b>dormant</b> — recordings are safe on local SSD until you configure it. Nothing is ever uploaded or deleted while Drive is off.</span>
        <button className="btn btn-sm btn-ghost" style={{ marginLeft: 'auto' }} onClick={openDriveConfig}><Icon name="tools" size={12}/> Configure Drive</button></div>}

      <div className="stor-kpis">
        <div className="stor-kpi"><div className="stor-kpi-v">{localLabel}</div><div className="stor-kpi-l">Total Local Storage</div></div>
        <div className="stor-kpi"><div className={`stor-kpi-v stor-drive ${driveState.cls}`}><span className={`dot ${driveState.cls === 'ok' ? 'ok pulsing' : ''}`}/>{driveState.label}</div><div className="stor-kpi-l">Google Drive Status</div></div>
        <div className="stor-kpi"><div className="stor-kpi-v warn">{c.pending || 0}</div><div className="stor-kpi-l">Pending Uploads</div></div>
        <div className="stor-kpi"><div className="stor-kpi-v danger">{c.failed || 0}</div><div className="stor-kpi-l">Failed Uploads</div></div>
        <div className="stor-kpi"><div className="stor-kpi-v ok">{c.archived || 0}</div><div className="stor-kpi-l">Archived to Drive</div></div>
        <div className="stor-kpi"><div className="stor-kpi-v warn">{c.held || 0}</div><div className="stor-kpi-l">Expired · Not archived</div></div>
        <div className="stor-kpi"><div className="stor-kpi-v t3">{c.expired || 0}</div><div className="stor-kpi-l">Expired Videos</div></div>
        <div className="stor-kpi"><div className="stor-kpi-v danger">{(c.local_missing || 0) + (c.deletion_failed || 0)}</div><div className="stor-kpi-l">Needs Attention</div></div>
      </div>

      {(lists.problems && lists.problems.length > 0) && (
        <Section title="● NEEDS ATTENTION — local file missing or deletion failed" eyebrowCls="eyebrow-danger"
          rows={lists.problems} acts={['verify', 'retry', 'delete']} empty="Nothing needs attention"/>
      )}

      {(lists.failed && lists.failed.length > 0) && (
        <Section title="● FAILED UPLOADS — local copy kept, retry to re-attempt"
          rows={lists.failed} acts={['verify', 'retry', 'expire']} empty="No failed uploads"/>
      )}

      <Section title="PENDING / ON SSD" rows={lists.pending} acts={['verify', 'retry', 'expire']}
        empty="Nothing waiting — all recordings archived or none captured yet"/>

      {(lists.held && lists.held.length > 0) && (
        <Section title="EXPIRED · NOT ARCHIVED — held safely, never auto-deleted"
          rows={lists.held} acts={['verify', 'retry', 'delete']} empty="None held"/>
      )}

      <Section title="ARCHIVED ON DRIVE" rows={lists.archived} acts={['verify', 'view']}
        empty="No recordings archived to Drive yet"/>

      <Section title="EXPIRED (past retention)" rows={lists.expired} acts={['verify', 'delete']}
        empty="No expired recordings"/>

      {toast && <div className="lbd-toast">{toast}</div>}
    </>
  );
};
window.LiveStorageManagement = LiveStorageManagement;

// ════════════════════════════════════════════════════════════
//  Admin · Timer Connection (ESP32 physical bay timers / MQTT)
//  Pair / Reconnect (resync) / Restart / Test Display / Firmware.
//  Reuses CamStatusBadge + the generic .cam-* table styling.
// ════════════════════════════════════════════════════════════
const TmrModal = ({ row, bays, onClose, onSaved }) => {
  const picker = !!(bays && bays.length);
  const [target, setTarget] = useLS(picker ? bays[0] : row);
  const editing = !!(target && target.timer);
  const t = (target && target.timer) || {};
  const defaults = (b) => ({
    timer_id: (b.timer && b.timer.timer_id) || `TMR-${String(b.bay_number).padStart(2, '0')}`,
    name: (b.timer && b.timer.name) || `${b.bay_name} Timer`,
  });
  const [f, setF] = useLS(defaults(target));
  const [busy, setBusy] = useLS(false); const [err, setErr] = useLS('');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const pickBay = (e) => {
    const b = bays.find((x) => x.bay_id === e.target.value) || bays[0];
    setTarget(b); setF(defaults(b));
  };
  const save = async () => {
    setBusy(true); setErr('');
    try {
      if (editing) await BW_API.updateTimer(t.id, f);
      else await BW_API.pairTimer({ bay_id: target.bay_id, ...f });
      onSaved();
    } catch (e) { setErr(e.message || 'Failed to save'); setBusy(false); }
  };
  return (
    <div className="modal-scrim" onClick={onClose} style={{ zIndex: 300 }}>
      <div className="cam-modal" onClick={(e) => e.stopPropagation()}>
        <div className="cam-modal-head">
          <div><div className="cam-modal-t">{editing ? 'Edit Timer' : 'Pair Timer'} · {target.bay_name}</div>
            <div className="cam-modal-s">Bind an ESP32 countdown unit to this bay · MQTT topic <span className="mono">bay/{target.bay_number}/timer</span></div></div>
          <button className="modal-close" onClick={onClose}><Icon name="x" size={15}/></button>
        </div>
        <div className="cam-form">
          {picker && <label className="cam-field full"><span>Bay</span>
            <select value={target.bay_id} onChange={pickBay} className="cam-select">
              {bays.map((b) => <option key={b.bay_id} value={b.bay_id}>BAY {String(b.bay_number).padStart(2, '0')} · {b.bay_name}</option>)}
            </select></label>}
          <label className="cam-field"><span>Timer ID</span><input value={f.timer_id} onChange={set('timer_id')} placeholder="TMR-01"/></label>
          <label className="cam-field"><span>Timer Name</span><input value={f.name} onChange={set('name')}/></label>
          <div className="cam-field full"><span>How it works</span>
            <div className="tmr-note">The backend is the single source of truth — it publishes the countdown every second and the ESP32 only displays it. IP &amp; firmware are reported by the device over MQTT once it connects.</div></div>
        </div>
        {err && <div className="cam-err"><Icon name="alert" size={12}/> {err}</div>}
        <div className="cam-modal-foot">
          <button className="btn btn-ghost" onClick={onClose}>CANCEL</button>
          <button className="btn btn-amber" onClick={save} disabled={busy}>{busy ? '…' : (editing ? 'SAVE CHANGES' : 'PAIR TIMER')}</button>
        </div>
      </div>
    </div>
  );
};

// ── Timer detail drawer (ESP32 · MQTT · heartbeat · assignment · firmware) ──
const TmrDrawer = ({ row, mqtt, onClose, onChanged, flash }) => {
  const dev = row.timer;
  const topic = row.state_topic || `${(mqtt && mqtt.prefix) || 'bay'}/${row.bay_number}/timer`;
  const cmdTopic = row.command_topic || `${(mqtt && mqtt.prefix) || 'bay'}/${row.bay_number}/{event}`;
  const init = { timer_id: dev.timer_id || '', name: dev.name || '' };
  const [f, setF] = useLS(init);
  const [busy, setBusy] = useLS(false);
  const [confirm, setConfirm] = useLS(false);
  const dirty = JSON.stringify(f) !== JSON.stringify(init);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const h = opsHealth(row.status);
  useLE(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !confirm) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirm]);
  const run = async (fn, okMsg) => {
    setBusy(true);
    try { const r = await fn(); flash((r && r.message) || okMsg); onChanged(); }
    catch (e) { flash(e.message || 'Action failed'); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true);
    try { await BW_API.unpairTimer(dev.id); flash('Timer removed'); onChanged(); onClose(); }
    catch (e) { flash(e.message || 'Remove failed'); setBusy(false); }
  };
  return (
    <div className="ops-drawer-scrim" onClick={onClose}>
      <div className="ops-drawer" role="dialog" aria-modal="true" aria-label={`${dev.name} details`} onClick={(e) => e.stopPropagation()}>
        <div className="ops-drawer-head">
          <div className="ops-drawer-id">
            <span className={`ops-dot ${opsTone(row.status)}`}/>
            <div><div className="ops-drawer-t">{dev.name}</div>
              <div className="ops-drawer-s mono">{dev.timer_id} · BAY {String(row.bay_number).padStart(2, '0')}</div></div>
          </div>
          <div className="row" style={{ gap: 10 }}>
            <OpsBadge tone={h.tone}>{row.status === 'online' ? 'SYNCED' : h.label}</OpsBadge>
            <button className="modal-close" aria-label="Close details" onClick={onClose}><Icon name="x" size={15}/></button>
          </div>
        </div>
        <div className="ops-drawer-body">
          <OpsSec title="ESP32 DETAILS">
            <div className="ops-form">
              <OpsField label="Timer ID" value={f.timer_id} onChange={set('timer_id')}/>
              <OpsField label="Timer Name" value={f.name} onChange={set('name')}/>
            </div>
            <OpsRow k="IP address" v={row.ip_address} mono/>
            <OpsRow k="Firmware" v={row.firmware_version} mono/>
          </OpsSec>
          {row.conflict && <div className="ops-conflict wide"><Icon name="alert" size={12}/> Timer ID <b className="mono">{dev.timer_id}</b> is paired to more than one bay. Routing stays correct (it's keyed on the bay number), but give each bay a unique label to avoid confusion.</div>}
          <OpsStartFlow bayNum={row.bay_number} steps={[
            'Validate the bay session.',
            'Start the backend timer (single source of truth).',
            `Publish the MQTT command to bay/${row.bay_number}/start.`,
            'The ESP32 receives the command.',
            'The physical display starts the countdown.',
            'Other bay timers are not affected.',
          ]}/>
          <OpsSec title="MQTT">
            <OpsRow k="Broker" v={mqtt && mqtt.broker} mono/>
            <OpsRow k="State topic" v={topic} mono/>
            <OpsRow k="Command topic" v={cmdTopic} mono/>
            <OpsRow k="Broker status" v={mqtt && mqtt.connected ? 'Running — state published every 1s' : 'Down — device dormant'}/>
            <OpsRow k="Authority" v="Backend computes time · ESP32 only displays"/>
          </OpsSec>
          <OpsSec title="HEARTBEAT">
            <OpsRow k="Last telemetry" v={row.last_seen}/>
            <OpsRow k="Last command" v={dev.last_command ? `${dev.last_command}${dev.last_error ? ` · ${dev.last_error}` : ''}` : '—'}/>
            <OpsRow k="Resync" v={<button className="ops-act" disabled={busy} onClick={() => run(() => BW_API.reconnectTimer(dev.id), 'Resync sent')}><Icon name="route" size={12}/> Force state resync</button>}/>
          </OpsSec>
          <OpsSec title="BAY ASSIGNMENT">
            <OpsRow k="Bay" v={`BAY ${String(row.bay_number).padStart(2, '0')} · ${row.bay_name}`}/>
            <OpsRow k="Mapping" v="One timer per bay · persisted"/>
          </OpsSec>
          <OpsSec title="FIRMWARE">
            <OpsRow k="Installed" v={row.firmware_version} mono/>
            <button className="ops-act wide" disabled={busy} onClick={() => run(() => BW_API.updateTimerFirmware(dev.id), 'OTA command sent')}><Icon name="upload" size={12}/> Update Firmware (OTA)</button>
          </OpsSec>
          <OpsSec title="DANGER ZONE">
            <div className="ops-danger">
              <div><div className="ops-danger-t">Remove this timer</div>
                <div className="ops-danger-s">Unpairs {dev.timer_id} from BAY {String(row.bay_number).padStart(2, '0')}. The physical display goes dormant until re-paired.</div></div>
              <button className="btn btn-sm ops-danger-btn" disabled={busy} onClick={() => setConfirm(true)}>Remove Timer</button>
            </div>
          </OpsSec>
        </div>
        <div className="ops-drawer-foot">
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => run(() => BW_API.restartTimer(dev.id), 'Restart sent')}><Icon name="cog" size={13}/> Restart Timer</button>
          <button className="btn btn-amber btn-sm" disabled={busy || !dirty} title={dirty ? '' : 'No changes to save'} onClick={() => run(() => BW_API.updateTimer(dev.id, f), 'Timer saved')}>{busy ? '…' : 'Save Changes'}</button>
        </div>
        {confirm && <ConfirmDialog title="Remove timer?" confirmWord="REMOVE" actionLabel="Remove Timer"
          message={`${dev.name} (${dev.timer_id}) will be unpaired from BAY ${String(row.bay_number).padStart(2, '0')}.`}
          busy={busy} onConfirm={remove} onClose={() => setConfirm(false)}/>}
      </div>
    </div>
  );
};

// ── Timer card — one visible action (Details →) ──
const TmrCard = ({ row, mqtt, onOpen }) => {
  const dev = row.timer;
  const h = opsHealth(row.status);
  const exceptional = row.status !== 'online';
  const cmdTopic = row.command_topic || `${(mqtt && mqtt.prefix) || 'bay'}/${row.bay_number}/{event}`;
  const key = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } };
  return (
    <div className={`ops-card ${row.conflict ? 'conflict' : opsTone(row.status)}`} role="button" tabIndex={0}
      aria-label={`${dev.name}, bay ${row.bay_number}, ${row.status === 'online' ? 'synced' : h.label.toLowerCase()}. Open details.`}
      onClick={onOpen} onKeyDown={key}>
      {row.conflict && <div className="ops-conflict" title="The same timer ID label is paired to more than one bay"><Icon name="alert" size={11}/> Duplicate timer ID</div>}
      <div className="ops-card-top">
        <span className={`ops-dot ${opsTone(row.status)}`}/>
        <div className="ops-card-id">
          <div className="ops-name">{dev.name}</div>
          <div className="ops-sub mono">{dev.timer_id} · BAY {String(row.bay_number).padStart(2, '0')}</div>
        </div>
        {exceptional
          ? <OpsBadge tone={h.tone}>{h.label}</OpsBadge>
          : <span className="ops-fresh mono" title="Last telemetry">● {row.last_seen}</span>}
      </div>
      <div className="ops-specs">
        <OpsSpec k="FIRMWARE"><span className="mono">{row.firmware_version || '—'}</span></OpsSpec>
        <OpsSpec k="COMMAND TOPIC"><span className="mono" title={cmdTopic}>{cmdTopic}</span></OpsSpec>
        <OpsSpec k="LAST CMD">{dev.last_command
          ? <span className="mono">{dev.last_command}{dev.last_error ? <span className="ops-mut"> · {dev.last_error}</span> : ''}</span>
          : <span className="ops-mut">—</span>}</OpsSpec>
      </div>
      <div className="ops-foot">
        <span className="ops-seen">Backend authoritative · seen {row.last_seen}</span>
        <span className="ops-details">Details <Icon name="arrow-right" size={12}/></span>
      </div>
    </div>
  );
};

const TMR_CHIPS = ['All', 'Online', 'Offline', 'Unpaired'];

const LiveTimerConnection = () => {
  const poll = useBWPoll(() => BW_API.timersList(), [], 5000);
  const data = poll.data;
  const [modal, setModal] = useLS(null);
  const [drawer, setDrawer] = useLS(null);
  const [toast, setToast] = useLS('');
  const [q, setQ] = useLS('');
  const [chip, setChip] = useLS('All');
  const flash = (m) => { setToast(m); setTimeout(() => setToast(''), 3200); };

  const s = (data && data.summary) || {};
  const mqtt = s.mqtt || {};
  const mqttOk = mqtt.enabled && mqtt.connected;
  const rows = (data && data.timers) || [];
  const paired = rows.filter((r) => r.timer);
  const unpaired = rows.filter((r) => !r.timer);
  // TRUTHFUL KPIs — count paired timer devices, never bays
  const kOnline = paired.filter((r) => r.status === 'online').length;
  const kOffline = paired.filter((r) => r.status === 'offline').length;

  const match = (r) => {
    if (!q) return true;
    const dev = r.timer || {};
    return [dev.name, dev.timer_id, r.ip_address, r.firmware_version, `bay ${r.bay_number}`, r.bay_name, r.status]
      .some((v) => v && String(v).toLowerCase().includes(q.toLowerCase()));
  };
  const byChip = (r) =>
    chip === 'All' ? true :
    chip === 'Online' ? r.status === 'online' :
    chip === 'Offline' ? r.status === 'offline' : true;
  const qmatchBay = (r) => !q || [`bay ${r.bay_number}`, r.bay_name].some((v) => v && String(v).toLowerCase().includes(q.toLowerCase()));
  const pairedShown = chip === 'Unpaired' ? [] : paired.filter(match).filter(byChip)
    .sort((a, b) => opsAttention(a.status) - opsAttention(b.status) || a.bay_number - b.bay_number);
  const unpairedShown = (chip === 'All' || chip === 'Unpaired') ? unpaired.filter(qmatchBay).sort((a, b) => a.bay_number - b.bay_number) : [];
  const shownCount = pairedShown.length + unpairedShown.length;
  const drawerRow = drawer && paired.find((r) => r.bay_id === drawer);

  return (
    <>
      <OpsPageHead eyebrow="TIMER CONFIGURATION" title="Timer Configuration" sub="Manage all physical ESP32 bay timers.">
        <button className="btn btn-ghost btn-sm" aria-label="Refresh list" onClick={() => poll.reload()}><Icon name="route" size={13}/> Refresh</button>
        <button className="btn btn-ghost btn-sm" title="Open the MQTT broker settings"
          onClick={() => window.dispatchEvent(new CustomEvent('bw:mqtt-open-broker'))}><Icon name="tools" size={13}/> Broker settings</button>
        <button className="btn btn-amber btn-sm" disabled={!unpaired.length}
          title={unpaired.length ? 'Pair an ESP32 timer to an available bay' : 'Every bay already has a timer'}
          onClick={() => setModal({ bays: unpaired })}><Icon name="plus" size={13}/> Pair Timer</button>
      </OpsPageHead>

      {!mqttOk && <div className="stor-banner"><Icon name="alert" size={14}/>
        <span>MQTT broker is <b>{mqtt.enabled ? 'not connected' : 'not configured'}</b> — physical ESP32 timers won't update until it's connected. The backend timer keeps running regardless.</span>
        <button className="btn btn-sm btn-ghost" style={{ marginLeft: 'auto' }}
          onClick={() => window.dispatchEvent(new CustomEvent('bw:mqtt-open-broker'))}><Icon name="tools" size={12}/> Broker settings</button></div>}

      <div className="ops-kpis">
        <OpsKpi value={kOnline} label="Connected Timers" sub={`of ${paired.length} paired`} tone="ok" live/>
        <OpsKpi value={kOffline} label="Offline" tone="danger"/>
        <OpsKpi value={mqttOk ? 'Running' : 'Down'} label="MQTT Broker" sub={mqtt.broker || ''} tone={mqttOk ? 'info' : 'danger'} live={mqttOk}/>
        <OpsKpi value={unpaired.length} label="Unpaired" sub={`of ${rows.length} bays`} tone="idle"/>
      </div>

      <OpsToolbar q={q} setQ={setQ} chips={TMR_CHIPS} chip={chip} setChip={setChip}
        shown={shownCount} placeholder="Search timer, bay, IP, firmware, status…"/>

      <OpsGuide title="How to connect an ESP32 timer" icon="clock">
        <ol className="ops-guide-steps">
          <li>Power ON the ESP32 timer.</li>
          <li>Connect the ESP32 to the workshop WiFi.</li>
          <li>Ensure the MQTT broker is configured (<b>Broker settings</b> above).</li>
          <li>The ESP32 subscribes to its bay command topics:
            <div className="ops-guide-topics mono">bay/&#123;n&#125;/start · bay/&#123;n&#125;/pause · bay/&#123;n&#125;/resume · bay/&#123;n&#125;/complete · bay/&#123;n&#125;/test</div></li>
          <li>It publishes heartbeat / state to: <span className="mono">bay/&#123;n&#125;/timer</span></li>
          <li>Open the bay card below → enter the <b>Timer ID</b> → <b>Save Pairing</b>.</li>
          <li>Click <b>Test Timer</b>. If it succeeds, the timer is ready.</li>
          <li>Admin Live Dashboard <b>Start</b> will then control only this bay's timer.</li>
        </ol>
        <div className="ops-guide-note">Each bay card shows its exact resolved topics (<span className="mono">&#123;n&#125;</span> = bay number). The backend is the single source of truth — the ESP32 only displays what it publishes.</div>
      </OpsGuide>

      {!data ? <OpsSkeleton n={6}/> : (
        <div className="ops-grid">
          {pairedShown.map((row) => (
            <TmrCard key={row.bay_id} row={row} mqtt={mqtt} onOpen={() => setDrawer(row.bay_id)}/>
          ))}
          {unpairedShown.map((row) => (
            <UnpairedBayCard key={row.bay_id} row={row} kind="timer" onPair={() => setModal({ bays: [row] })}/>
          ))}
          {shownCount === 0 && (
            <div className="ops-none">
              <Icon name="clock" size={20}/>
              <span>{rows.length === 0 ? 'No bays yet.' : 'Nothing matches this search / filter.'}</span>
            </div>
          )}
        </div>
      )}

      {drawerRow && <TmrDrawer row={drawerRow} mqtt={mqtt} flash={flash}
        onClose={() => setDrawer(null)} onChanged={() => poll.reload()}/>}
      {modal && <TmrModal row={modal.row} bays={modal.bays} onClose={() => setModal(null)} onSaved={() => { setModal(null); flash('Timer paired'); poll.reload(); }}/>}
      {toast && <div className="lbd-toast" role="status">{toast}</div>}
    </>
  );
};
window.LiveTimerConnection = LiveTimerConnection;
// Exposed so the Bay Readiness Overview (integrations.jsx) reuses the SAME
// pair/edit form — no duplicated timer business logic.
window.TmrModal = TmrModal;

// ════════════════════════════════════════════════════════════
//  Master · System Settings — live infrastructure status.
//  Every value is real: /health + storage overview + MQTT.
// ════════════════════════════════════════════════════════════
const SysStat = ({ ok, okLabel, badLabel }) => (
  <span className={`chip ${ok ? 'ok' : 'danger'}`}><span className={`dot ${ok ? 'ok pulsing' : ''}`}/>{ok ? (okLabel || 'Online') : (badLabel || 'Down')}</span>
);
const SysRow = ({ k, v }) => (<div className="sys-row"><span className="k">{k}</span><span className="v">{v == null || v === '' ? '—' : String(v)}</span></div>);

const LiveSystemSettings = () => {
  const poll = useBWPoll(async () => {
    const [health, storage] = await settle([
      [BW_API.health(), {}],
      [BW_API.storageOverview(), {}],
    ]);
    return { health, storage };
  }, [], 5000);
  const h = (poll.data && poll.data.health) || {};
  const st = (poll.data && poll.data.storage) || {};
  const mqtt = h.mqtt || {};
  const drive = st.drive || {};
  const local = st.local || {};
  const allOk = !!(h.db && h.timer_persistent && mqtt.connected);
  return (
    <>
      <div className="content-head">
        <div><div className="eyebrow eyebrow-amber">● SYSTEM SETTINGS</div><h1>System Settings</h1>
          <span className="sub">Live infrastructure status · backend / database / timer engine / MQTT / recording / storage</span></div>
        <div className="head-actions">
          <SysStat ok={allOk} okLabel="ALL SYSTEMS GO" badLabel="DEGRADED"/>
          <button className="btn btn-ghost btn-sm" onClick={() => poll.reload()}><Icon name="route" size={13}/> Refresh</button>
        </div>
      </div>

      <div className="sys-grid">
        <div className="sys-card">
          <div className="sys-card-head"><span className="sys-card-t"><span className="ico"><Icon name="gauge" size={15}/></span>Database</span><SysStat ok={!!h.db} okLabel="Connected"/></div>
          <div className="sys-rows">
            <SysRow k="Engine" v="PostgreSQL 16"/>
            <SysRow k="Health probe" v={h.db ? 'SELECT 1 · ok' : 'failed'}/>
          </div>
        </div>
        <div className="sys-card">
          <div className="sys-card-head"><span className="sys-card-t"><span className="ico"><Icon name="clock" size={15}/></span>Timer Engine</span><SysStat ok={!!h.timer_persistent} okLabel="Persistent" badLabel="Volatile"/></div>
          <div className="sys-rows">
            <SysRow k="Backend" v={h.timer_backend}/>
            <SysRow k="Survives restart" v={h.timer_persistent ? 'yes (Redis)' : 'no — start Redis'}/>
            <SysRow k="Active timers" v={h.active_timers}/>
          </div>
        </div>
        <div className="sys-card">
          <div className="sys-card-head"><span className="sys-card-t"><span className="ico"><Icon name="wifi" size={15}/></span>MQTT · ESP32 Timers</span><SysStat ok={!!mqtt.connected} okLabel="Running"/></div>
          <div className="sys-rows">
            <SysRow k="Broker" v={mqtt.broker}/>
            <SysRow k="Topic prefix" v={mqtt.prefix ? `${mqtt.prefix}/<bay>/…` : null}/>
            <SysRow k="Publishing" v={mqtt.connected ? 'state every 1s + lifecycle events' : 'dormant'}/>
          </div>
        </div>
        <div className="sys-card">
          <div className="sys-card-head"><span className="sys-card-t"><span className="ico"><Icon name="cam" size={15}/></span>Recording Engine</span><SysStat ok={h.recording_engine === 'ffmpeg'} okLabel="FFmpeg" badLabel="Unavailable"/></div>
          <div className="sys-rows">
            <SysRow k="Capture" v={h.recording_engine === 'ffmpeg' ? 'RTSP → HLS live + MP4' : 'metadata-only'}/>
            <SysRow k="Local media" v={local.total_mb != null ? `${local.total_gb >= 1 ? local.total_gb + ' GB' : local.total_mb + ' MB'} on SSD` : null}/>
            <SysRow k="Retention" v={h.retention_days ? `${h.retention_days} days` : null}/>
          </div>
        </div>
        <div className="sys-card">
          <div className="sys-card-head"><span className="sys-card-t"><span className="ico"><Icon name="upload" size={15}/></span>Google Drive Archival</span><SysStat ok={!!drive.reachable} okLabel="Connected" badLabel={drive.configured ? 'Unreachable' : 'Dormant'}/></div>
          <div className="sys-rows">
            <SysRow k="Status" v={drive.detail}/>
            <SysRow k="Pending / Failed" v={st.counts ? `${st.counts.pending || 0} / ${st.counts.failed || 0}` : null}/>
            <SysRow k="Archived" v={st.counts ? st.counts.archived : null}/>
          </div>
        </div>
        <div className="sys-card">
          <div className="sys-card-head"><span className="sys-card-t"><span className="ico"><Icon name="cog" size={15}/></span>Maintenance</span><SysStat ok okLabel="Scheduled"/></div>
          <div className="sys-rows">
            <SysRow k="Archive sweep" v={st.sweep_interval_hours ? `every ${st.sweep_interval_hours}h` : null}/>
            <SysRow k="Retention sweep" v={st.sweep_interval_hours ? `every ${st.sweep_interval_hours}h` : null}/>
            <SysRow k="Expired purged" v={st.counts ? st.counts.expired : null}/>
          </div>
        </div>
      </div>
    </>
  );
};
window.LiveSystemSettings = LiveSystemSettings;

// ── Admin · Live Job Assignment + Queue (real-time) ─────────
// ════════════════════════════════════════════════════════════
//  Admin · Job Assignment & Queue Management (live)
//  Action cards → Manual / PDF job card → worker-grouped queue
//  → right-side job drawer (edit/delete/move/reassign/assign)
// ════════════════════════════════════════════════════════════
const LJA_BLANK = {
  vehicle_number: '', vehicle_model: '', chassis_number: '', engine_number: '', km_reading: '',
  customer_name: '', customer_mobile: '', customer_email: '', customer_address: '',
  service_type: '', repair_type: '', estimated_cost: '', estimated_minutes: 45,
  complaint: '', notes: '', bay_id: '', priority: 'medium',   // bay-first: no worker field
};

const ljaMoney = (v) => (v || v === 0) ? `₹${Number(v).toLocaleString('en-IN')}` : '—';

// compact created-time: "15:42" if today, else "06 Jun"
const ljaCreated = (iso) => {
  if (!iso) return '—';
  try {
    const d = new Date(iso), now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    return sameDay
      ? d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })
      : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
  } catch (e) { return '—'; }
};

// ── Field ──────────────────────────────────────────────────
const LjaField = ({ label, value, onChange, placeholder, type = 'text', required, full, area, children }) => (
  <div className={`jf-field${full ? ' full' : ''}`}>
    <label>{label}{required && <span className="jf-req">*</span>}</label>
    {children
      ? children
      : area
        ? <textarea value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} rows={3}/>
        : <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}/>}
  </div>
);

// ── Sectioned job form (shared by Manual + PDF review + Edit) ──
// ── Bay-first assignment picker ────────────────────────────────────
// The admin chooses a BAY; the worker / camera / timer / ESP32 auto-resolve
// from that bay (single source of truth). There is NO worker dropdown —
// staffing lives only in Bay Management. Unstaffed/maintenance bays are
// disabled with the reason. A busy bay can still be chosen (job queues to
// the bay's worker and goes live when the bay frees up).
const LjaBayResolved = ({ b }) => !b ? null : (
  <div className="lja-bayres">
    <div className="lja-bayres-w">
      {b.worker
        ? <><Avatar id={b.worker.employee_id || b.worker.id} initials={(b.worker.name || '?').split(' ').map(x => x[0]).join('').slice(0, 2)} size={28}/>
          <div style={{ minWidth: 0 }}>
            <div className="cell-name">{b.worker.name}{b.worker.is_temp && <span className="bay-temp-tag">TEMP</span>}</div>
            <span className="cell-meta">{b.worker.employee_id || '—'} · auto-assigned from bay</span>
          </div></>
        : <span className="fv-nowkr"><Icon name="alert" size={13}/> Bay is unstaffed</span>}
    </div>
    <div className="lja-bayres-d">
      <span><span className={`dot ${b.camera === 'online' ? 'ok' : b.camera === 'offline' ? 'danger' : 'ghost'}`}/>CAM</span>
      <span><span className={`dot ${b.timer === 'online' ? 'ok' : b.timer === 'offline' ? 'danger' : 'ghost'}`}/>TIMER</span>
      <span><span className={`dot ${b.esp32 === 'synced' ? 'ok' : b.esp32 === 'offline' ? 'danger' : 'ghost'}`}/>ESP32</span>
      {b.current_job && <span className="cell-meta">busy · {b.current_job.job_card_number}</span>}
    </div>
  </div>
);

const LjaBayPicker = ({ opsBays, form, set }) => {
  const sel = (opsBays || []).find(b => b.bay_id === form.bay_id);
  return (
    <div className="jf-section">
      <div className="jf-section-head"><div className="jf-section-ico asn"><Icon name="route" size={14}/></div><span>Bay Assignment <span className="lja-bayfirst-tag">BAY-FIRST</span></span></div>
      <div className="jf-grid">
        <LjaField label="Bay" required>
          <select value={form.bay_id} onChange={e => set('bay_id', e.target.value)}>
            <option value="">Select bay…</option>
            {(opsBays || []).map(b => {
              const blocked = !b.operational;
              const why = b.status === 'no_worker' ? 'unstaffed — staff it in Bay Management' : b.status;
              const wkr = b.worker ? b.worker.name : '—';
              return (
                <option key={b.bay_id} value={b.bay_id} disabled={blocked}>
                  {`BAY ${String(b.bay_number).padStart(2, '0')} · ${wkr}${blocked ? ` · 🔒 ${why}` : (b.current_job ? ' · busy' : '')}`}
                </option>
              );
            })}
          </select>
        </LjaField>
        <LjaField label="Priority">
          <select value={form.priority} onChange={e => set('priority', e.target.value)}>
            <option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
          </select>
        </LjaField>
      </div>
      <LjaBayResolved b={sel}/>
      <div className="jf-hint"><Icon name="shield" size={11}/> The worker is owned by the bay and assigned automatically. To change who runs a bay, use Bay Management.</div>
    </div>
  );
};

const LjaJobForm = ({ form, set, workers, bays, opsBays, mode }) => (
  <div className="jf-sections">
    <div className="jf-section">
      <div className="jf-section-head"><div className="jf-section-ico veh"><Icon name="car" size={14}/></div><span>Vehicle Information</span></div>
      <div className="jf-grid">
        <LjaField label="Registration Number" value={form.vehicle_number} onChange={v => set('vehicle_number', v)} placeholder="TN-01-AB-1234"/>
        <LjaField label="Vehicle Model" value={form.vehicle_model} onChange={v => set('vehicle_model', v)} placeholder="Royal Enfield Classic 350"/>
        <LjaField label="Chassis Number" value={form.chassis_number} onChange={v => set('chassis_number', v)} placeholder="ME3..."/>
        <LjaField label="Engine Number" value={form.engine_number} onChange={v => set('engine_number', v)} placeholder="JK5..."/>
        <LjaField label="KM Reading" value={form.km_reading} onChange={v => set('km_reading', v)} placeholder="24,500"/>
      </div>
    </div>

    <div className="jf-section">
      <div className="jf-section-head"><div className="jf-section-ico cust"><Icon name="user" size={14}/></div><span>Customer Information</span></div>
      <div className="jf-grid">
        <LjaField label="Customer Name" value={form.customer_name} onChange={v => set('customer_name', v)} placeholder="Rajesh Kumar" required/>
        <LjaField label="Mobile Number" value={form.customer_mobile} onChange={v => set('customer_mobile', v)} placeholder="+91 98765 43210"/>
        <LjaField label="Email" value={form.customer_email} onChange={v => set('customer_email', v)} placeholder="name@email.com" type="email"/>
        <LjaField label="Address" value={form.customer_address} onChange={v => set('customer_address', v)} placeholder="12, MG Road, Chennai" full/>
      </div>
    </div>

    <div className="jf-section">
      <div className="jf-section-head"><div className="jf-section-ico svc"><Icon name="tools" size={14}/></div><span>Service Information</span></div>
      <div className="jf-grid">
        <LjaField label="Service Type" value={form.service_type} onChange={v => set('service_type', v)} placeholder="General Service"/>
        <LjaField label="Repair Type" value={form.repair_type} onChange={v => set('repair_type', v)} placeholder="Periodic Maintenance"/>
        <LjaField label="Estimated Cost (₹)" value={form.estimated_cost} onChange={v => set('estimated_cost', v)} placeholder="3500" type="number"/>
        <LjaField label="Estimated Time (min)" value={form.estimated_minutes} onChange={v => set('estimated_minutes', v)} placeholder="45" type="number"/>
      </div>
      {mode === 'create' && <div className="jf-hint"><Icon name="shield" size={11}/> Job Card Number is generated automatically on save.</div>}
    </div>

    {mode === 'create' && <LjaBayPicker opsBays={opsBays} form={form} set={set}/>}

    <div className="jf-section">
      <div className="jf-section-head"><div className="jf-section-ico voice"><Icon name="bell" size={14}/></div><span>Customer Voice</span></div>
      <div className="jf-grid">
        <LjaField label="Complaint Description" value={form.complaint} onChange={v => set('complaint', v)} placeholder="Describe the customer's reported issue…" area full/>
        <LjaField label="Additional Notes" value={form.notes} onChange={v => set('notes', v)} placeholder="Internal notes…" area full/>
      </div>
    </div>
  </div>
);

const ljaToBody = (f) => ({
  vehicle_number: f.vehicle_number || null, vehicle_model: f.vehicle_model || null,
  chassis_number: f.chassis_number || null, engine_number: f.engine_number || null, km_reading: f.km_reading || null,
  customer_name: f.customer_name || null, customer_mobile: f.customer_mobile || null,
  customer_email: f.customer_email || null, customer_address: f.customer_address || null,
  service_type: f.service_type || null, repair_type: f.repair_type || null,
  estimated_cost: f.estimated_cost !== '' ? +f.estimated_cost : null,
  estimated_minutes: +f.estimated_minutes || 45, complaint: f.complaint || null, notes: f.notes || null,
});

// ── Manual / Edit job modal ────────────────────────────────
const LjaManualModal = ({ initial, mode, workers, bays, opsBays, onClose, onSaved }) => {
  const [form, setForm] = useLS(initial || LJA_BLANK);
  const [err, setErr] = useLS('');
  const [busy, setBusy] = useLS(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const submit = async () => {
    if (!form.customer_name) { setErr('Customer name is required'); return; }
    if (mode === 'create' && !form.bay_id) { setErr('Select a bay — the worker is assigned automatically from the bay'); return; }
    setErr(''); setBusy(true);
    try {
      if (mode === 'edit') await BW_API.updateJob(initial.job_card_id, ljaToBody(form));
      // bay-first: only bay_id is sent; the backend resolves the bay's worker
      else await BW_API.saveToQueue({ ...ljaToBody(form), bay_id: form.bay_id, priority: form.priority });
      onSaved(mode === 'edit' ? 'Job card updated ✓' : 'Job card saved to queue ✓'); onClose();
    } catch (e) { setErr(e.message || 'Could not save'); setBusy(false); }
  };
  return (
    <div className="modal-scrim" onClick={onClose} style={{ zIndex: 340 }}>
      <div className="modal modal-lg jf-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div className="row" style={{ gap: 11 }}>
            <div className="jf-head-ico"><Icon name={mode === 'edit' ? 'edit' : 'clipboard'} size={15}/></div>
            <div>
              <div className="sc-title">{mode === 'edit' ? 'Edit Job Card' : 'Manual Job Card'}</div>
              <div className="sc-sub">{mode === 'edit' ? (initial.job_card_number || '') : 'Fill in the job card details, then save to the queue'}</div>
            </div>
          </div>
          <button className="modal-close" onClick={onClose}><Icon name="x" size={15}/></button>
        </div>
        <div className="modal-scroll jf-body">
          <LjaJobForm form={form} set={set} workers={workers} bays={bays} opsBays={opsBays} mode={mode === 'edit' ? 'edit' : 'create'}/>
          {err && <div className="pt-form-err" style={{ margin: '4px 0 0' }}><Icon name="alert" size={13}/> {err}</div>}
        </div>
        <div className="modal-foot">
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose}>CANCEL</button>
          <button className="btn btn-amber" style={{ flex: 2 }} disabled={busy} onClick={submit}>
            <Icon name="check" size={15}/> {busy ? 'SAVING…' : (mode === 'edit' ? 'SAVE CHANGES' : 'SAVE TO QUEUE')}
          </button>
        </div>
      </div>
    </div>
  );
};

// ── PDF upload → extract → review modal ────────────────────
// read-only labelled value for the review screen
const LjaRV = ({ l, v, full }) => (
  <div className={`jr-field${full ? ' full' : ''}`}>
    <span className="jr-l">{l}</span>
    <span className="jr-v">{(v === 0 || v) ? v : <span className="jr-empty">— not found</span>}</span>
  </div>
);

// Phase 2: estimate status from the backend Parts-Time analysis (never recomputed here)
const LJA_EST = {
  complete: ['ok', 'COMPLETE ESTIMATE'],
  partial: ['amber', 'PARTIAL ESTIMATE'],
  no_match: ['danger', 'NO MATCH'],
  extraction_failed: ['danger', 'NO PARTS FOUND'],
};
const ljaEstBadge = (status) => {
  const [cls, label] = LJA_EST[status] || ['ghost', (status || 'UNKNOWN').toUpperCase()];
  return <span className={`chip ${cls}`} style={{ fontSize: 9 }}>{label}</span>;
};
// per-part match status for the Parts & Time Analysis table
const ljaPartChip = (m) => {
  const map = {
    MATCHED: ['ok', 'MATCHED'],
    LOW_CONFIDENCE_MATCH: ['amber', 'LOW CONF'],
    UNMATCHED: ['danger', 'UNMATCHED'],
  };
  const [cls, label] = map[m] || ['ghost', m || '—'];
  return <span className={`chip ${cls} mono`} style={{ fontSize: 8, height: 18 }}>{label}</span>;
};

const LjaPdfModal = ({ workers, bays, opsBays, onClose, onSaved }) => {
  const [phase, setPhase] = useLS('drop');   // drop | extracting | review | invalid | error
  const [ex, setEx] = useLS(null);           // full extraction payload
  const [form, setForm] = useLS(LJA_BLANK);  // editable copy (seeded from extraction)
  const [editing, setEditing] = useLS(false);
  const [fileName, setFileName] = useLS('');
  const [err, setErr] = useLS('');
  const [busy, setBusy] = useLS(false);
  const [invalidMsg, setInvalidMsg] = useLS('');
  const [confirmCfg, setConfirmCfg] = useLS(null);   // partial / no-match save confirmation
  const [intakeMatch, setIntakeMatch] = useLS(null); // matched intake evidence by bike (or null)
  const [intakeChecked, setIntakeChecked] = useLS(true);
  const [intakeView, setIntakeView] = useLS(false);
  const fileRef = React.useRef(null);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  // After extraction, match the latest intake evidence by the EXTRACTED vehicle number
  // (parser untouched — we only use form.vehicle_number). Normalized matching is server-side.
  useLE(() => {
    if (phase !== 'review' || !form.vehicle_number) { setIntakeMatch(null); return; }
    let alive = true;
    BW_API.adminIntakeByBike(form.vehicle_number)
      .then(m => { if (alive) setIntakeMatch(m || null); })
      .catch(() => { if (alive) setIntakeMatch(null); });
    return () => { alive = false; };
  }, [phase, form.vehicle_number]);

  // seed the editable form from the backend extraction (estimate minutes ALWAYS
  // come from the backend Parts-Time analysis — never computed in the frontend)
  const fieldsToForm = (f, total) => ({
    ...LJA_BLANK,
    vehicle_number: f.vehicle_number || '', vehicle_model: f.model || '',
    chassis_number: f.chassis_number || '', engine_number: f.engine_number || '', km_reading: f.km_reading || '',
    customer_name: f.customer_name || '', customer_mobile: f.customer_mobile || '',
    customer_email: f.customer_email || '', customer_address: f.customer_address || '',
    service_type: f.repair_type || '',
    repair_type: f.repair_type || '', estimated_cost: f.estimated_cost || '',
    estimated_minutes: total || 0, complaint: f.customer_voice || '', notes: '',
  });

  const process = async (file) => {
    if (!file) return;
    if (!/\.pdf$/i.test(file.name)) { setErr('Please upload a PDF file'); setPhase('error'); return; }
    setFileName(file.name); setPhase('extracting'); setEditing(false);
    try {
      const r = await BW_API.extractPdf(file);
      if (!r || !r.valid) { setInvalidMsg((r && r.message) || ''); setPhase('invalid'); return; }
      setEx(r);
      setForm(fieldsToForm(r.fields || {}, r.total_estimated_minutes));
      setPhase('review');
    } catch (e) { setErr(e.message || 'Extraction failed'); setPhase('error'); }
  };

  const save = async () => {
    setErr(''); setBusy(true);
    const f = (ex && ex.fields) || {};
    try {
      // bay-first: only bay_id is sent; the backend resolves the bay's worker.
      // estimated_minutes + estimate_status + parts come straight from the backend
      // Parts-Time analysis (single source of truth — no frontend recalculation).
      const saved = await BW_API.saveToQueue({
        ...ljaToBody(form),
        estimated_minutes: (ex && ex.total_estimated_minutes != null) ? ex.total_estimated_minutes : (+form.estimated_minutes || 0),
        notes: `Job Card ${f.job_card_number || ''} · SA ${f.sa_name || '—'} · Tech ${f.technician_name || '—'}`.trim(),
        services: (ex && ex.analysis && ex.analysis.rows) || null,
        parts: (ex && ex.parts) || null,
        estimate_status: (ex && ex.estimate_status) || (ex && ex.parts_time_analysis && ex.parts_time_analysis.estimate_status) || null,
        extraction_confidence: (ex && ex.extraction_confidence != null) ? ex.extraction_confidence : ((ex && ex.confidence != null) ? ex.confidence : null),
        source_type: 'pdf',
        bay_id: form.bay_id, priority: form.priority,
      });
      // Optionally link the matched intake evidence to the just-created job card.
      let linkMsg = '';
      if (intakeMatch && intakeChecked && saved && saved.job_card_id) {
        try { await BW_API.adminIntakeLinkJob(intakeMatch.id, { job_card_id: saved.job_card_id }); linkMsg = ' · intake evidence linked'; }
        catch (e) { linkMsg = ' · (intake link failed)'; }
      }
      onSaved('PDF job card saved to queue ✓' + linkMsg); onClose();
    } catch (e) { setErr(e.message || 'Could not save'); setBusy(false); setConfirmCfg(null); }
  };

  // Save / Assign gate: missing or no-match parts require an explicit confirmation
  const onSaveClick = () => {
    if (corrupted) { setErr('Parts table extraction is corrupted — re-upload or use Edit Details before saving'); return; }
    if (!form.customer_name) { setErr('Customer name is required'); return; }
    if (!form.bay_id) { setErr('Select a bay — the worker is assigned automatically from the bay'); return; }
    setErr('');
    const matched = (pta.matched_count || 0) + (pta.low_confidence_count || 0);
    if (estStatus === 'no_match' || estStatus === 'extraction_failed' || matched === 0) {
      setConfirmCfg({ kind: 'no_match' });
    } else if ((pta.missing_count || 0) > 0) {
      setConfirmCfg({ kind: 'partial' });
    } else {
      save();   // complete estimate → save straight through
    }
  };

  const f = (ex && ex.fields) || {};
  const veh = (ex && ex.vehicle) || {}, cust = (ex && ex.customer) || {};
  const svc = (ex && ex.service) || {}, stf = (ex && ex.staff_status) || {};
  const V = (o, k, fk) => { const v = (o && o[k] != null && o[k] !== '') ? o[k] : (f && f[fk]); return (v === 0 || v) ? v : null; };
  const pta = (ex && ex.parts_time_analysis) || {};
  const estStatus = (ex && ex.estimate_status) || pta.estimate_status || 'extraction_failed';
  const totalMin = (ex && ex.total_estimated_minutes != null) ? ex.total_estimated_minutes : (pta.estimated_minutes || 0);
  const missingParts = pta.missing_parts || [];
  const ptaRows = [...(pta.matched_parts || []), ...(pta.low_confidence_parts || []), ...(pta.missing_parts || [])]
    .sort((x, y) => (x.s_no || 0) - (y.s_no || 0));
  // unit_value lives on the raw extracted parts (not the analysis rows) — map by s_no
  const uvBySno = {};
  (ex && ex.parts || []).forEach(p => { uvBySno[p.s_no] = p.unit_value; });
  // backend flags a still-corrupted parts table (table-merge signature) → block save
  const corrupted = !!(ex && ex.parts_corrupted);

  return (
    <>
    <div className="modal-scrim" onClick={onClose} style={{ zIndex: 340 }}>
      <div className={`modal ${phase === 'review' ? 'jr-modal' : 'modal-lg jf-modal'}`} onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div className="row" style={{ gap: 11 }}>
            <div className="jf-head-ico pdf"><Icon name="file" size={15}/></div>
            <div>
              <div className="sc-title">PDF Job Card Extraction</div>
              <div className="sc-sub">{phase === 'review' ? `Review & approve · ${fileName}` : 'Upload Triumph / Bajaj job card PDF · auto-extracted'}</div>
            </div>
          </div>
          <button className="modal-close" onClick={onClose}><Icon name="x" size={15}/></button>
        </div>

        {phase === 'drop' && (
          <div style={{ padding: 24 }}>
            <div className="dropzone"
              onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add('over'); }}
              onDragLeave={e => e.currentTarget.classList.remove('over')}
              onDrop={e => { e.preventDefault(); e.currentTarget.classList.remove('over'); process(e.dataTransfer.files[0]); }}
              onClick={() => fileRef.current && fileRef.current.click()}>
              <div className="dz-ico"><Icon name="file" size={32}/></div>
              <h3 style={{ margin: '10px 0 4px', fontSize: 16, fontWeight: 600 }}>Drop Triumph / Bajaj PDF or click to browse</h3>
              <p style={{ margin: 0, fontSize: 13, color: 'var(--t-2)' }}>Service job card · PDF only</p>
              <div className="hint" style={{ marginTop: 12 }}>TEMPLATE-AWARE EXTRACTION · CUSTOMER VOICE → SERVICE MAPPING</div>
              <input ref={fileRef} type="file" accept=".pdf,application/pdf" hidden onChange={e => process(e.target.files[0])}/>
            </div>
          </div>
        )}

        {phase === 'extracting' && (
          <div className="scan-stage" style={{ padding: 44, minHeight: 220 }}>
            <div style={{ color: 'var(--amber)', marginBottom: 12 }}><Icon name="file" size={42}/></div>
            <div className="scan-line"/>
            <div className="scan-status" style={{ marginTop: 16 }}><span className="dot amber pulsing"/>Validating · extracting fields · mapping services…</div>
          </div>
        )}

        {phase === 'invalid' && (
          <div style={{ padding: 34, textAlign: 'center' }}>
            <div style={{ width: 56, height: 56, margin: '0 auto 16px', borderRadius: 15, background: 'rgba(244,63,94,0.12)', color: 'var(--danger)', display: 'grid', placeItems: 'center' }}><Icon name="alert" size={26}/></div>
            <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>Invalid Job Card</div>
            <div style={{ color: 'var(--t-2)', fontSize: 13, marginBottom: 22, maxWidth: 400, margin: '0 auto 22px', lineHeight: 1.6 }}>
              This file does not look like a valid Triumph / Bajaj job card. Please upload the original service job card PDF.
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              <button className="btn btn-ghost" onClick={() => setPhase('drop')}>TRY ANOTHER FILE</button>
              <button className="btn btn-amber" onClick={onClose}>CLOSE</button>
            </div>
          </div>
        )}

        {phase === 'review' && ex && (
          <>
            <div className="jr-banner">
              <span className="chip ok"><Icon name="check" size={12}/> VALID JOB CARD</span>
              {ljaEstBadge(estStatus)}
              <span className="mono jr-banner-meta">{fileName} · confidence {ex.score}% · {pta.extracted_count || 0} parts · {pta.matched_count || 0} matched · {pta.missing_count || 0} missing · <b style={{ color: 'var(--amber-bright)' }}>{totalMin} min</b></span>
              <div className="spacer"/>
              <button className={`btn btn-sm ${editing ? 'btn-amber' : 'btn-ghost'}`} onClick={() => setEditing(v => !v)}><Icon name="edit" size={12}/> {editing ? 'DONE EDITING' : 'EDIT DETAILS'}</button>
              <button className="btn btn-sm btn-ghost" onClick={() => setPhase('drop')}><Icon name="upload" size={12}/> CHANGE FILE</button>
            </div>

            <div className="modal-scroll jr-body">
              {editing ? (
                <LjaJobForm form={form} set={set} workers={workers} bays={bays} mode="edit"/>
              ) : (
                <div className="jr-grid">
                  <div className="jr-card">
                    <div className="jr-card-head"><div className="jf-section-ico veh"><Icon name="car" size={13}/></div> Vehicle Information</div>
                    <div className="jr-fields">
                      <LjaRV l="Model" v={V(veh, 'model', 'model')}/><LjaRV l="Registration" v={V(veh, 'registration', 'vehicle_number')}/>
                      <LjaRV l="Chassis No" v={V(veh, 'chassis_no', 'chassis_number')}/><LjaRV l="Engine No" v={V(veh, 'engine_no', 'engine_number')}/>
                      <LjaRV l="Date of Sale" v={V(veh, 'date_of_sale', 'date_of_sale')}/><LjaRV l="KMs Covered" v={V(veh, 'kms_covered', 'km_reading')}/>
                    </div>
                  </div>
                  <div className="jr-card">
                    <div className="jr-card-head"><div className="jf-section-ico cust"><Icon name="user" size={13}/></div> Customer Information</div>
                    <div className="jr-fields">
                      <LjaRV l="Name" v={V(cust, 'name', 'customer_name')}/><LjaRV l="Contact" v={V(cust, 'contact', 'customer_mobile')}/>
                      <LjaRV l="Email" v={V(cust, 'email', 'customer_email')}/><LjaRV l="Customer ID" v={V(cust, 'customer_id', 'customer_id')}/>
                      <LjaRV l="KYC" v={(() => { const k = V(cust, 'kyc_status', 'kyc_status'); return k ? String(k).toUpperCase() : null; })()}/>
                      <LjaRV l="Address" v={V(cust, 'address', 'customer_address')} full/>
                    </div>
                  </div>
                  <div className="jr-card">
                    <div className="jr-card-head"><div className="jf-section-ico svc"><Icon name="clipboard" size={13}/></div> Service Information</div>
                    <div className="jr-fields">
                      <LjaRV l="Job Card No" v={V(svc, 'job_card_no', 'job_card_number')}/><LjaRV l="Repair Type" v={V(svc, 'repair_type', 'repair_type')}/>
                      <LjaRV l="Date & Time In" v={V(svc, 'date_time_in', 'date_time_in')}/><LjaRV l="Est. Delivery" v={V(svc, 'estimated_delivery', 'estimated_delivery')}/>
                      <LjaRV l="Est. Cost" v={(() => { const c = V(svc, 'estimated_cost', 'estimated_cost'); return c ? `₹${c}` : null; })()}/><LjaRV l="Card Date" v={V(svc, 'card_date', 'date')}/>
                    </div>
                  </div>
                  <div className="jr-card">
                    <div className="jr-card-head"><div className="jf-section-ico asn"><Icon name="user" size={13}/></div> Staff &amp; Vehicle Status</div>
                    <div className="jr-fields">
                      <LjaRV l="Service Advisor" v={V(stf, 'service_advisor', 'sa_name')}/><LjaRV l="SA Contact" v={V(stf, 'sa_contact', 'sa_contact')}/>
                      <LjaRV l="Technician" v={V(stf, 'technician', 'technician_name')}/><LjaRV l="Petrol Level" v={V(stf, 'petrol_level', 'petrol_level')}/>
                      <LjaRV l="Last Visit" v={stf.last_visit || (f.last_two_visits && f.last_two_visits.length > 0 ? `${f.last_two_visits[0].date} · ${f.last_two_visits[0].km} km · ${f.last_two_visits[0].technician}` : null)} full/>
                    </div>
                  </div>
                  <div className="jr-card full">
                    <div className="jr-card-head"><div className="jf-section-ico voice"><Icon name="bell" size={13}/></div> Customer Voice</div>
                    <div className="jr-voice">{(ex && ex.customer_voice) || f.customer_voice || <span className="jr-empty">— not found</span>}</div>
                  </div>

                  <div className="jr-card full jr-intake">
                    <div className="jr-card-head"><div className="jf-section-ico cust"><Icon name="clipboard" size={13}/></div> Vehicle Intake Evidence</div>
                    {intakeMatch ? (
                      <div className="jr-intake-body">
                        <div className="jr-intake-row">
                          <span className="chip ok"><Icon name="check" size={11}/> MATCHED</span>
                          <span className="mono jr-intake-no">{intakeMatch.intake_no} · {intakeMatch.worker_name || '—'}{intakeMatch.submitted_at ? ` · ${jceFmtDT(intakeMatch.submitted_at)}` : ''}</span>
                          {intakeMatch.linked && intakeMatch.linked.is_linked && <span className="chip ghost">ALREADY LINKED</span>}
                        </div>
                        <div className="jr-intake-meta">
                          <span>{intakeMatch.customer_name || '—'} · <span className="mono">{intakeMatch.bike_number}</span></span>
                          <span><Icon name="image" size={12}/> {(intakeMatch.images || []).length}</span>
                          <span><Icon name="mic" size={12}/> {(intakeMatch.voices || []).length}</span>
                        </div>
                        {intakeMatch.complaint_description && <div className="jr-intake-comp">{intakeMatch.complaint_description}</div>}
                        <div className="jce-thumbs">{(intakeMatch.images || []).filter(m => m.available).slice(0, 4).map(m => (
                          <a key={m.id} className="jce-mtile" href={BW_API.intakeMediaUrl(m.view_url)} target="_blank" rel="noreferrer"><img src={BW_API.intakeMediaUrl(m.thumbnail_url || m.view_url)} alt=""/></a>
                        ))}</div>
                        {!(intakeMatch.linked && intakeMatch.linked.is_linked) &&
                          <label className="jr-intake-link"><input type="checkbox" checked={intakeChecked} onChange={e => setIntakeChecked(e.target.checked)}/> Link this intake evidence to this job card on save</label>}
                        <button className="btn btn-ghost btn-sm" onClick={() => setIntakeView(true)}><Icon name="image" size={13}/> View full evidence</button>
                      </div>
                    ) : (
                      <div className="jr-empty">No intake evidence found for this bike number.</div>
                    )}
                  </div>
                  {intakeView && intakeMatch && <IntakeEvidenceDrawer id={intakeMatch.id} role="admin" onClose={() => setIntakeView(false)} onChanged={() => {}}/>}

                  <div className="jr-card full">
                    <div className="jr-card-head"><div className="jf-section-ico svc"><Icon name="tools" size={13}/></div> Parts &amp; Time Analysis {ljaEstBadge(estStatus)}</div>

                    {/* summary cards — counts + estimate, all from the backend Parts-Time analysis */}
                    <div className="jr-summary" style={{ marginTop: 0, marginBottom: 14 }}>
                      <div className="jr-sum"><div className="v">{pta.extracted_count || 0}</div><div className="l">Extracted Parts</div></div>
                      <div className="jr-sum"><div className="v" style={{ color: 'var(--ok)' }}>{pta.matched_count || 0}</div><div className="l">Matched</div></div>
                      <div className="jr-sum"><div className="v" style={{ color: (pta.missing_count ? 'var(--danger)' : 'var(--t-2)') }}>{pta.missing_count || 0}</div><div className="l">Missing</div></div>
                      <div className="jr-sum big"><div className="v" style={{ color: 'var(--amber-bright)' }}>{totalMin}<span style={{ fontSize: 13 }}>m</span></div><div className="l">Estimated Time</div></div>
                    </div>

                    {/* per-part table — exact PDF Parts Detail columns + match results */}
                    <div className="pta-wrap">
                      <div className="pta-table">
                        <div className="pta-row pta-head">
                          <span className="r">S.NO</span><span>JOB CODE</span><span>PART NAME</span><span>PART NUMBER</span>
                          <span className="r">QTY</span><span className="r">UNIT VAL</span><span>MATCH STATUS</span>
                          <span>MATCHED PARTS TIME ITEM</span><span className="r">MIN / UNIT</span><span className="r">TOTAL MIN</span><span>WARNING</span>
                        </div>
                        {ptaRows.length === 0 && <div className="pta-row"><span className="pta-empty" style={{ gridColumn: '1 / -1' }}>No parts were extracted from this job card.</span></div>}
                        {ptaRows.map((r, i) => {
                          const unmatched = r.match === 'UNMATCHED';
                          const uv = uvBySno[r.s_no];
                          return (
                            <div key={i} className={`pta-row${unmatched ? ' pta-miss' : ''}`}>
                              <span className="r mono pta-sno">{r.s_no}</span>
                              <span className="mono pta-code">{r.job_code || '—'}</span>
                              <span className="pta-name" title={r.part_name || ''}>{r.part_name || '—'}</span>
                              <span className="mono pta-num" title={r.part_number || ''}>{r.part_number || '—'}</span>
                              <span className="r mono">{r.qty}</span>
                              <span className="r mono">{(uv === 0 || uv) ? uv : '—'}</span>
                              <span>{ljaPartChip(r.match)}</span>
                              <span className="pta-matched" title={r.matched_part_name || ''}>{r.matched_part_name || <span className="jr-empty">—</span>}{r.match === 'LOW_CONFIDENCE_MATCH' && r.match_confidence ? <span className="pta-conf mono"> ~{Math.round(r.match_confidence * 100)}%</span> : null}</span>
                              <span className="r mono">{r.minutes_per_unit || 0}</span>
                              <span className="r mono pta-total">{r.total_minutes || 0}</span>
                              <span className="pta-warn">{r.warning ? <span title={r.warning}><Icon name="alert" size={11}/> Not in Parts Time</span> : <span className="jr-empty">—</span>}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* corruption — blocks save until re-uploaded / edited */}
                    {corrupted && (
                      <div className="pta-alert danger">
                        <Icon name="alert" size={14}/>
                        <div><b>Parts table extraction looks corrupted.</b> Please retry or use Edit Details. This job cannot be saved until the parts table is corrected.</div>
                      </div>
                    )}

                    {/* warnings — backend-driven, never blocks (warn-only) */}
                    {!corrupted && estStatus === 'no_match' && (
                      <div className="pta-alert danger">
                        <Icon name="alert" size={14}/>
                        <div><b>No extracted parts matched the Parts Time master.</b> Estimated time is 0 min. Add these parts in the Parts Time page, or continue only if this is intentional.</div>
                      </div>
                    )}
                    {estStatus !== 'no_match' && (pta.missing_count || 0) > 0 && (
                      <div className="pta-alert warn">
                        <Icon name="alert" size={14}/>
                        <div>
                          <b>Some extracted parts are not available in the Parts Time master.</b> Add them in the Parts Time page or continue with matched parts only. The following parts are not available in Parts Time page:
                          <ul className="pta-misslist">
                            {missingParts.map((m, i) => <li key={i}><span className="pta-name">{m.part_name || '—'}</span> <span className="mono">/ {m.part_number || '—'}</span></li>)}
                          </ul>
                        </div>
                      </div>
                    )}
                    {(pta.low_confidence_count || 0) > 0 && (
                      <div className="pta-alert info">
                        <Icon name="shield" size={14}/>
                        <div>{pta.low_confidence_count} part(s) matched by name similarity — please verify the matched item before assigning.</div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Assignment bar — bay-first: pick the BAY, worker auto-resolves */}
              <div className="jr-assign-bar">
                <div className="jr-assign-title"><Icon name="route" size={14}/> ASSIGN TO BAY <span className="lja-bayfirst-tag">BAY-FIRST</span></div>
                <div className="jf-field"><label>Bay <span className="jf-req">*</span></label>
                  <select value={form.bay_id} onChange={e => set('bay_id', e.target.value)}>
                    <option value="">Select bay…</option>
                    {(opsBays || []).map(b => {
                      const blocked = !b.operational;
                      const why = b.status === 'no_worker' ? 'unstaffed' : b.status;
                      return <option key={b.bay_id} value={b.bay_id} disabled={blocked}>
                        {`BAY ${String(b.bay_number).padStart(2, '0')} · ${b.worker ? b.worker.name : '—'}${blocked ? ` · 🔒 ${why}` : (b.current_job ? ' · busy' : '')}`}
                      </option>;
                    })}
                  </select>
                </div>
                <div className="jf-field"><label>Priority</label>
                  <select value={form.priority} onChange={e => set('priority', e.target.value)}>
                    <option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
                  </select>
                </div>
              </div>
              <LjaBayResolved b={(opsBays || []).find(b => b.bay_id === form.bay_id)}/>
              {err && <div className="pt-form-err" style={{ margin: '12px 0 0' }}><Icon name="alert" size={13}/> {err}</div>}
            </div>

            <div className="modal-foot jr-foot">
              <button className="btn btn-ghost" onClick={onClose}>CANCEL</button>
              <button className="btn btn-amber" disabled={busy || corrupted} onClick={onSaveClick}>
                <Icon name="check" size={15}/> {busy ? 'SAVING…' : (corrupted ? 'EXTRACTION CORRUPTED' : `SAVE TO QUEUE · ${totalMin} MIN`)}
              </button>
            </div>
          </>
        )}

        {phase === 'error' && (
          <div style={{ padding: 30, textAlign: 'center' }}>
            <div style={{ width: 52, height: 52, margin: '0 auto 14px', borderRadius: 14, background: 'rgba(244,63,94,0.12)', color: 'var(--danger)', display: 'grid', placeItems: 'center' }}><Icon name="alert" size={24}/></div>
            <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 8 }}>Could not read PDF</div>
            <div style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 20, maxWidth: 360, margin: '0 auto 20px', lineHeight: 1.6 }}>{err}</div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              <button className="btn btn-ghost" onClick={() => { setErr(''); setPhase('drop'); }}>TRY AGAIN</button>
              <button className="btn btn-amber" onClick={onClose}>CLOSE</button>
            </div>
          </div>
        )}
      </div>
    </div>

    {/* Save / Assign confirmation when the estimate is partial or has no matches */}
    {confirmCfg && (() => {
      const noMatch = confirmCfg.kind === 'no_match';
      return (
        <div className="modal-scrim" onClick={() => !busy && setConfirmCfg(null)} style={{ zIndex: 360 }}>
          <div className="modal" style={{ width: 470 }} onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <div className="row" style={{ gap: 10 }}>
                <div className="jf-head-ico" style={{ background: 'rgba(244,63,94,.12)', borderColor: 'rgba(244,63,94,.35)', color: 'var(--danger)' }}><Icon name="alert" size={14}/></div>
                <span style={{ fontWeight: 600, fontSize: 14 }}>{noMatch ? 'Continue with 0 minute estimate?' : 'Continue with partial estimate?'}</span>
              </div>
              <button className="modal-close" onClick={() => !busy && setConfirmCfg(null)}><Icon name="x" size={15}/></button>
            </div>
            <div style={{ padding: '16px 22px 18px', fontSize: 13, color: 'var(--t-2)', lineHeight: 1.6 }}>
              {noMatch
                ? 'No PDF parts matched the Parts Time master. Estimated time is 0 min. Add parts in the Parts Time page, or continue only if this is intentional.'
                : 'Some PDF parts are not available in the Parts Time page, so the estimate will use only matched parts. Do you want to continue?'}
              {missingParts.length > 0 && (
                <ul className="pta-misslist" style={{ marginTop: 10 }}>
                  {missingParts.map((m, i) => <li key={i}><span className="pta-name">{m.part_name || '—'}</span> <span className="mono">/ {m.part_number || '—'}</span></li>)}
                </ul>
              )}
              <div className="mono" style={{ marginTop: 12, fontSize: 11, color: 'var(--t-3)' }}>Estimate to save: <b style={{ color: 'var(--amber-bright)' }}>{totalMin} min</b> · from {pta.matched_count || 0} matched part(s)</div>
            </div>
            <div className="modal-foot">
              <button className="btn btn-ghost" style={{ flex: 1 }} disabled={busy} onClick={() => setConfirmCfg(null)}>CANCEL</button>
              <button className="btn" disabled={busy}
                style={{ flex: 2, background: 'rgba(244,63,94,.15)', color: 'var(--danger)', border: '1px solid rgba(244,63,94,.4)' }}
                onClick={save}>
                {busy ? 'SAVING…' : (noMatch ? 'CONTINUE WITH 0 MIN' : 'CONTINUE WITH MATCHED PARTS ONLY')}
              </button>
            </div>
          </div>
        </div>
      );
    })()}
    </>
  );
};

// ── Generic confirm dialog ─────────────────────────────────
const LjaConfirm = ({ icon = 'alert', title, body, danger, confirmLabel = 'CONFIRM', onConfirm, onClose }) => {
  const [busy, setBusy] = useLS(false);
  const go = async () => { setBusy(true); try { await onConfirm(); } catch (e) {} };
  return (
    <div className="modal-scrim" onClick={onClose} style={{ zIndex: 360 }}>
      <div className="modal" style={{ width: 440 }} onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div className="row" style={{ gap: 10 }}>
            <div className="jf-head-ico" style={danger ? { background: 'rgba(244,63,94,.12)', borderColor: 'rgba(244,63,94,.35)', color: 'var(--danger)' } : {}}><Icon name={icon} size={14}/></div>
            <span style={{ fontWeight: 600, fontSize: 14 }}>{title}</span>
          </div>
          <button className="modal-close" onClick={onClose}><Icon name="x" size={15}/></button>
        </div>
        <div style={{ padding: '16px 22px 20px', fontSize: 13, color: 'var(--t-2)', lineHeight: 1.6 }}>{body}</div>
        <div className="modal-foot">
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose}>CANCEL</button>
          <button className="btn" disabled={busy}
            style={{ flex: 1, ...(danger ? { background: 'rgba(244,63,94,.15)', color: 'var(--danger)', border: '1px solid rgba(244,63,94,.4)' } : { background: 'linear-gradient(180deg,var(--amber-bright),var(--amber))', color: '#1a0d05' }) }}
            onClick={go}>{busy ? '…' : confirmLabel}</button>
        </div>
      </div>
    </div>
  );
};

// ── Picker modal (Change Worker / Change Bay) ──────────────
const LjaPicker = ({ title, label, options, value, onSave, onClose }) => {
  const [val, setVal] = useLS(value || '');
  const [busy, setBusy] = useLS(false);
  const go = async () => { setBusy(true); try { await onSave(val); } catch (e) { setBusy(false); } };
  return (
    <div className="modal-scrim" onClick={onClose} style={{ zIndex: 360 }}>
      <div className="modal" style={{ width: 420 }} onClick={e => e.stopPropagation()}>
        <div className="modal-head"><span className="eyebrow eyebrow-amber">{title}</span><button className="modal-close" onClick={onClose}><Icon name="x" size={15}/></button></div>
        <div style={{ padding: '18px 22px' }}>
          <div className="jf-field full"><label>{label}</label>
            <select value={val} onChange={e => setVal(e.target.value)}>
              {options.map(o => <option key={o.value} value={o.value} disabled={!!o.disabled}>{o.label}</option>)}
            </select>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose}>CANCEL</button>
          <button className="btn btn-amber" style={{ flex: 2 }} disabled={busy} onClick={go}><Icon name="check" size={14}/> {busy ? 'SAVING…' : 'CONFIRM'}</button>
        </div>
      </div>
    </div>
  );
};

// ── Assign confirmation modal ──────────────────────────────
const LjaAssignModal = ({ item, bays, onAssign, onClose }) => {
  const avail = bays.filter(b => b.status === 'available');
  const preferred = item.bay_id && bays.find(b => b.id === item.bay_id);
  const [bayId, setBayId] = useLS(item.bay_id || (avail[0] && avail[0].id) || '');
  const [busy, setBusy] = useLS(false);
  const chosen = bays.find(b => b.id === bayId);
  const force = chosen && chosen.status !== 'available';
  const go = async () => { if (!bayId) return; setBusy(true); try { await onAssign(bayId, force); } catch (e) { setBusy(false); } };
  return (
    <div className="modal-scrim" onClick={onClose} style={{ zIndex: 360 }}>
      <div className="modal" style={{ width: 480 }} onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div className="row" style={{ gap: 10 }}><div className="jf-head-ico"><Icon name="play" size={14}/></div><span style={{ fontWeight: 600, fontSize: 14 }}>Assign Job to Bay</span></div>
          <button className="modal-close" onClick={onClose}><Icon name="x" size={15}/></button>
        </div>
        <div style={{ padding: '18px 22px' }}>
          <div className="jf-assign-grid">
            <div><span className="l">Customer</span><span className="v">{item.customer_name || '—'}</span></div>
            <div><span className="l">Worker</span><span className="v">{item.worker_name || '—'}</span></div>
            <div><span className="l">Service Type</span><span className="v">{item.service_type || '—'}</span></div>
            <div><span className="l">Estimated Time</span><span className="v">{item.estimated_minutes || 0} min</span></div>
          </div>
          <div className="jf-field full" style={{ marginTop: 16 }}>
            <label>Bay {preferred && <span style={{ color: 'var(--amber)', fontSize: 9, letterSpacing: '.1em' }}>· PREFERRED SET</span>}</label>
            <select value={bayId} onChange={e => setBayId(e.target.value)}>
              <option value="">Select a bay…</option>
              {bays.map(b => <option key={b.id} value={b.id}>BAY {String(b.bay_number).padStart(2, '0')} · {b.status}{b.status !== 'available' ? ' (busy)' : ''}</option>)}
            </select>
          </div>
          <div className="jf-assign-note">
            <Icon name="shield" size={13}/>
            <span>This job will become <b>active</b> and move to the <b>Live Bay Dashboard</b>. A service session + timer will be created. Continue?</span>
          </div>
          {force && <div className="pt-form-err" style={{ margin: '10px 0 0' }}><Icon name="alert" size={13}/> Selected bay is busy — assigning will force-override it.</div>}
        </div>
        <div className="modal-foot">
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose}>CANCEL</button>
          <button className="btn btn-amber" style={{ flex: 2 }} disabled={busy || !bayId} onClick={go}><Icon name="play" size={14}/> {busy ? 'ASSIGNING…' : 'ASSIGN'}</button>
        </div>
      </div>
    </div>
  );
};

// ── Job details drawer (right slide-in) ────────────────────
const LjaDrawer = ({ item, canMove, onClose, onEdit, onDelete, onChangeBay, onMove, onAssign, onSendApproval, onOpenIntake }) => {
  const Row = ({ l, v, full, mono, accent }) => (
    <div className={`jd-row${full ? ' full' : ''}`}>
      <span className="jd-l">{l}</span>
      <span className={`jd-v${mono ? ' mono' : ''}`} style={accent ? { color: 'var(--amber-bright)' } : undefined}>{(v === 0 || v) ? v : <span className="jd-na">—</span>}</span>
    </div>
  );
  const Card = ({ icon, variant, title, children }) => (
    <div className="jd-card">
      <div className="jd-card-head"><span className={`jd-ico ${variant}`}><Icon name={icon} size={13}/></span> {title}</div>
      {children}
    </div>
  );
  const st = item.status || 'queued';
  const pr = item.priority || 'medium';
  const statusChip = st === 'queued' ? 'ghost' : st === 'assigned' ? 'amber' : 'ok';
  const svcTypes = (item.service_type || '').split(',').map(s => s.trim()).filter(Boolean);

  return (
    <div className="modal-scrim" onClick={onClose} style={{ placeItems: 'stretch end', zIndex: 350 }}>
      <div className="job-drawer" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="jd-head">
          <div className="jd-head-top">
            <span className="jd-jc mono">{item.job_card_number || 'JOB CARD'}</span>
            <div className="row" style={{ gap: 8 }}>
              <span className={`chip ${statusChip}`}>{st.toUpperCase()}</span>
              <button className="modal-close" onClick={onClose}><Icon name="x" size={15}/></button>
            </div>
          </div>
          <div className="jd-title">{item.customer_name || 'Customer'}</div>
          <div className="jd-sub"><Icon name="car" size={13}/> {item.vehicle_model || '—'}{item.vehicle_number ? ` · ${item.vehicle_number}` : ''}</div>
          <div className="jd-summary">
            <div className="jd-stat"><div className="v">{item.estimated_minutes || 0}<span>m</span></div><div className="l">Est. Time</div></div>
            <div className="jd-stat"><div className="v">#{item.queue_position}</div><div className="l">Queue Pos</div></div>
            <div className="jd-stat"><div className={`v pr-${pr}`}>{pr.toUpperCase()}</div><div className="l">Priority</div></div>
          </div>
        </div>

        {/* Scrollable body */}
        <div className="jd-scroll">
          <Card icon="user" variant="cust" title="Customer Information">
            <Row l="Name" v={item.customer_name}/>
            <Row l="Mobile" v={item.customer_mobile} mono/>
            <Row l="Email" v={item.customer_email}/>
            <Row l="Address" v={item.customer_address} full/>
          </Card>

          <Card icon="car" variant="veh" title="Vehicle Information">
            <Row l="Vehicle No" v={item.vehicle_number} mono/>
            <Row l="Model" v={item.vehicle_model}/>
            <Row l="Chassis No" v={item.chassis_number} mono/>
            <Row l="Engine No" v={item.engine_number} mono/>
            <Row l="KM Reading" v={item.km_reading} mono/>
          </Card>

          <Card icon="tools" variant="svc" title="Service Information">
            <Row l="Job Card No" v={item.job_card_number} mono accent/>
            <Row l="Repair Type" v={item.repair_type}/>
            <Row l="Estimated Cost" v={ljaMoney(item.estimated_cost)} mono/>
            <Row l="Estimated Time" v={`${item.estimated_minutes || 0} min`} mono accent/>
            <Row l="Worker" v={item.worker_name}/>
            <Row l="Preferred Bay" v={item.bay_number ? `BAY ${String(item.bay_number).padStart(2, '0')}` : 'None'} mono/>
            {svcTypes.length > 0 && (
              <div className="jd-chips-wrap">
                <span className="jd-l" style={{ display: 'block', marginBottom: 8 }}>Service Type</span>
                <div className="jd-chips">{svcTypes.map((s, i) => <span key={i} className="jd-chip">{s}</span>)}</div>
              </div>
            )}
          </Card>

          <Card icon="bell" variant="voice" title="Customer Voice">
            {item.complaint
              ? <div className="jd-quote"><Icon name="bell" size={13}/><span>{item.complaint}</span></div>
              : <Row l="Complaint" v={null}/>}
            {item.notes && <Row l="Notes" v={item.notes} full/>}
          </Card>

          {item.services && item.services.length > 0 && (
            <Card icon="gauge" variant="svc" title="Service & Time Analysis">
              <div className="jd-svc-list">
                {item.services.map((s, i) => (
                  <div key={i} className="jd-svc">
                    <span className="jd-svc-name">{s.service || s.part_name}</span>
                    <span className={`chip ${s.match === 'SERVICE' ? 'amber' : 'ok'} mono`} style={{ fontSize: 8, height: 17 }}>{s.match === 'SERVICE' ? 'SVC MAP' : 'PARTS'}</span>
                    <span className="jd-svc-min mono">{s.minutes}m</span>
                  </div>
                ))}
                <div className="jd-svc total">
                  <span className="jd-svc-name">Total Estimated Time</span>
                  <span className="jd-svc-min mono" style={{ color: 'var(--amber-bright)' }}>{item.estimated_minutes}m</span>
                </div>
              </div>
            </Card>
          )}

          <Card icon="file" variant="doc" title="Uploaded Documents">
            {item.source_type === 'pdf'
              ? <div className="jd-doc"><Icon name="file" size={14}/> Original job card PDF</div>
              : <div className="jd-na" style={{ fontSize: 13 }}>No documents — created manually</div>}
          </Card>

          {item.intake && (
            <Card icon="clipboard" variant="cust" title="Vehicle Intake Evidence">
              <div className="jd-intake">
                <span className="chip ok"><Icon name="check" size={11}/> EVIDENCE AVAILABLE</span>
                <div className="jd-intake-meta mono">{item.intake.intake_no} · {item.intake.worker_name || '—'}{item.intake.submitted_at ? ` · ${jceFmtDT(item.intake.submitted_at)}` : ''}</div>
                <div className="jd-intake-counts">
                  <span><Icon name="image" size={12}/> {item.intake.image_count} photo(s)</span>
                  <span><Icon name="mic" size={12}/> {item.intake.voice_count} voice</span>
                  {item.intake.linked && <span className="ok"><Icon name="check" size={12}/> Linked</span>}
                </div>
                <button className="btn btn-ghost btn-sm" onClick={() => onOpenIntake && onOpenIntake(item.intake.id)}><Icon name="image" size={13}/> View evidence &amp; link</button>
              </div>
            </Card>
          )}
        </div>

        {/* Sticky action footer */}
        {st === 'queued' ? (
          <div className="jd-actions">
            {item.approval && (
              <div className="jd-appr-status">Customer approval: <b>{(item.approval.status || '').toUpperCase()}</b>
                {item.approval.submitted ? ` · approved ${ljaMoney(item.approval.approved_cost)} · ${item.approval.approved_minutes}m` : ''}</div>
            )}
            <div className="jd-act-grid">
              <button className="jd-act" onClick={() => onMove('up')} disabled={!canMove.up}><Icon name="arrow-up" size={14}/> Move Up</button>
              <button className="jd-act" onClick={() => onMove('down')} disabled={!canMove.down}><Icon name="arrow-down" size={14}/> Move Down</button>
              <button className="jd-act" onClick={onChangeBay}><Icon name="route" size={14}/> Change Bay</button>
              <button className="jd-act" onClick={onEdit}><Icon name="edit" size={14}/> Edit</button>
              <button className="jd-act danger" onClick={onDelete}><Icon name="trash" size={14}/> Delete</button>
            </div>
            <button className="jd-approval" onClick={onSendApproval}><Icon name="check" size={15}/> {item.approval ? 'OPEN CUSTOMER APPROVAL' : 'SEND TO CUSTOMER APPROVAL'}</button>
            <button className="jd-assign" onClick={onAssign}><Icon name="play" size={16}/> ASSIGN JOB → LIVE BAY</button>
          </div>
        ) : (
          <div className="jd-actions">
            <div className="jd-onbay"><Icon name="check" size={14}/> This job is {st} on the Live Bay Dashboard{item.bay_number ? ` · BAY ${String(item.bay_number).padStart(2, '0')}` : ''}</div>
          </div>
        )}
      </div>
    </div>
  );
};

const LiveJobAssignment = () => {
  const poll = useBWPoll(async () => {
    const [queue, workers, bays, ops] = await settle([
      [BW_API.queue(), {}], [BW_API.workers(), []], [BW_API.bays(), []],
      [BW_API.bayOperations(), { bays: [] }]]);
    return { queue: queue || {}, workers: workers || [], bays: bays || [],
             opsBays: (ops && ops.bays) || [] };
  }, [], 2000);
  // Realtime queue over WebSocket (snapshot-push); the poll above stays as the fallback and keeps
  // workers/bays/ops fresh. The WS frame overlays the queue groups the instant anything changes.
  const [wsQueue, setWsQueue] = useLS(null);
  useBWSocket('/queue', (snap) => { if (snap) setWsQueue(snap); });
  const base = poll.data || { queue: {}, workers: [], bays: [], opsBays: [] };
  const data = { ...base, queue: wsQueue || base.queue };

  const [toast, setToast] = useLS('');
  const [toastType, setToastType] = useLS('ok');
  const [creating, setCreating] = useLS(null);      // 'manual' | 'pdf' | null
  const [editJob, setEditJob] = useLS(null);
  const [drawerId, setDrawerId] = useLS(null);
  const [intakeView, setIntakeView] = useLS(null);  // open intake evidence drawer (entry id)
  const [action, setAction] = useLS(null);          // 'worker'|'bay'|'delete'|'assign'
  const [collapsed, setCollapsed] = useLS({});
  // filters
  const [q, setQ] = useLS('');
  const [fWorker, setFWorker] = useLS('ALL');
  const [fBay, setFBay] = useLS('ALL');
  const [fService, setFService] = useLS('ALL');
  const [fStatus, setFStatus] = useLS('queued');

  const flash = (m, t = 'ok') => { setToast(m); setToastType(t); setTimeout(() => setToast(''), 3200); };
  // After a mutation, reload the fallback poll AND push the fresh queue straight into the WS
  // overlay so the UI updates immediately (the next WS frame then keeps it live).
  const refresh = () => { poll.reload(); BW_API.queue().then(d => { if (d) setWsQueue(d); }).catch(() => {}); };

  // flatten → filter → regroup
  const allItems = [];
  Object.values(data.queue || {}).forEach(arr => (arr || []).forEach(it => allItems.push(it)));
  const services = ['ALL', ...[...new Set(allItems.map(i => i.service_type).filter(Boolean))].sort()];
  const match = (it) => {
    if (fStatus !== 'ALL' && it.status !== fStatus) return false;
    if (fWorker !== 'ALL' && it.worker_id !== fWorker) return false;
    if (fBay !== 'ALL' && it.bay_id !== fBay) return false;
    if (fService !== 'ALL' && it.service_type !== fService) return false;
    if (q) {
      const s = q.toLowerCase();
      return [it.customer_name, it.vehicle_number, it.job_card_number, it.worker_name]
        .some(v => (v || '').toLowerCase().includes(s));
    }
    return true;
  };
  const filtered = allItems.filter(match);
  const groups = {};
  filtered.forEach(it => { (groups[it.worker_id] ||= []).push(it); });
  Object.values(groups).forEach(arr => arr.sort((a, b) => a.queue_position - b.queue_position));
  const workerIds = Object.keys(groups).sort((a, b) => {
    const an = (data.workers.find(w => w.id === a) || {}).name || '';
    const bn = (data.workers.find(w => w.id === b) || {}).name || '';
    return an.localeCompare(bn);
  });

  const drawerItem = allItems.find(i => i.id === drawerId) || null;
  const workerName = (wid) => (data.workers.find(w => w.id === wid) || {}).name || wid;

  const totalQueued = allItems.filter(i => i.status === 'queued').length;
  const totalActive = allItems.filter(i => i.status !== 'queued').length;

  // actions
  const doMove = async (dir) => { try { await BW_API.moveQueue(drawerId, dir); refresh(); } catch (e) { flash(e.message, 'err'); } };
  const doDelete = async () => { try { await BW_API.removeQueued(drawerId); flash('Job removed from queue'); setAction(null); setDrawerId(null); refresh(); } catch (e) { flash(e.message, 'err'); } };
  // bay-first: no "change worker" — changing the BAY moves the job to that
  // bay's worker automatically (single source of truth).
  const doChangeBay = async (bid) => { try { await BW_API.changeBay(drawerId, bid); flash('Bay updated — job follows the bay\'s worker ✓'); setAction(null); refresh(); } catch (e) { flash(e.message, 'err'); } };
  const doAssign = async (bayId, force) => {
    try {
      const r = await BW_API.assign(drawerId, bayId, force);
      const est = r && r.estimate, warns = (r && r.warnings) || [];
      let m = 'Assigned → now live on Bay Dashboard ✓';
      if (est && est.source === 'approved' && est.approved_cost != null) m += ` · approved ₹${Math.round(est.approved_cost)} / ${est.minutes}m`;
      if (warns.length) m += ` · ${warns.length} note${warns.length > 1 ? 's' : ''} on start`;
      flash(m); setAction(null); setDrawerId(null); refresh();
    } catch (e) { flash(e.message, 'err'); }
  };
  const doSendApproval = async () => {
    try {
      const d = await BW_API.approvalFromQueue(drawerId);
      window.__bwApprovalOpen = { id: d.id, ts: Date.now() };
      window.dispatchEvent(new CustomEvent('bw:navigate', { detail: { tab: 'approvals' } }));
      window.dispatchEvent(new CustomEvent('bw:approvals-open', { detail: { id: d.id } }));
      setDrawerId(null);
    } catch (e) { flash(e.message, 'err'); }
  };

  const canMove = (() => {
    if (!drawerItem) return { up: false, down: false };
    const sib = (groups[drawerItem.worker_id] || []).filter(i => i.status === 'queued');
    const idx = sib.findIndex(i => i.id === drawerItem.id);
    return { up: idx > 0, down: idx >= 0 && idx < sib.length - 1 };
  })();

  return (
    <>
      <div className="section-head">
        <div><h2>Job Assignment &amp; Queue</h2><span className="sub">Create · queue · assign — real-time · backend connected</span></div>
        <div className="row" style={{ gap: 10 }}>
          <span className="kb-kpi"><span className="v">{totalQueued}</span><span className="l">Queued</span></span>
          <span className="kb-kpi"><span className="v">{totalActive}</span><span className="l">On Bay</span></span>
        </div>
      </div>

      {/* Job creation action cards */}
      <div className="job-create-cards">
        <button className="job-create-card" onClick={() => setCreating('manual')}>
          <div className="jcc-ico"><Icon name="clipboard" size={26}/></div>
          <div className="jcc-title">Manual Job Card</div>
          <div className="jcc-desc">Create a new job card manually with full vehicle, customer &amp; service details.</div>
          <div className="jcc-cta">Create Job Card <Icon name="arrow-right" size={14}/></div>
        </button>
        <button className="job-create-card" onClick={() => setCreating('pdf')}>
          <div className="jcc-ico pdf"><Icon name="file" size={26}/></div>
          <div className="jcc-title">Upload PDF Job Card</div>
          <div className="jcc-desc">Upload a job card PDF and automatically extract the details for review.</div>
          <div className="jcc-cta">Upload &amp; Extract <Icon name="arrow-right" size={14}/></div>
        </button>
      </div>

      {/* Queue toolbar */}
      <div className="queue-toolbar">
        <div className="pt-search" style={{ maxWidth: 320 }}>
          <Icon name="gauge" size={14}/>
          <input placeholder="Search customer, vehicle, job card, worker…" value={q} onChange={e => setQ(e.target.value)}/>
          {q && <button className="modal-close" style={{ width: 24, height: 24 }} onClick={() => setQ('')}><Icon name="x" size={12}/></button>}
        </div>
        <select className="kb-select" value={fStatus} onChange={e => setFStatus(e.target.value)}>
          <option value="queued">Queued</option><option value="assigned">Assigned</option>
          <option value="active">Active</option><option value="ALL">All statuses</option>
        </select>
        <select className="kb-select" value={fWorker} onChange={e => setFWorker(e.target.value)}>
          <option value="ALL">All workers</option>
          {data.workers.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <select className="kb-select" value={fService} onChange={e => setFService(e.target.value)}>
          {services.map(s => <option key={s} value={s}>{s === 'ALL' ? 'All services' : s}</option>)}
        </select>
        <select className="kb-select" value={fBay} onChange={e => setFBay(e.target.value)}>
          <option value="ALL">All bays</option>
          {data.bays.map(b => <option key={b.id} value={b.id}>BAY {String(b.bay_number).padStart(2, '0')}</option>)}
        </select>
        <div className="spacer"/>
        <span className="wc-range" style={{ fontSize: 11 }}>{filtered.length} job{filtered.length !== 1 ? 's' : ''}</span>
      </div>

      {/* Worker-grouped collapsible queue */}
      {workerIds.length === 0 && (
        <div className="file-cards-empty" style={{ marginTop: 4 }}>
          <div className="dz-ico" style={{ width: 56, height: 56, margin: '0 auto 14px' }}><Icon name="queue" size={26}/></div>
          <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 6 }}>No jobs in the queue</div>
          <div style={{ color: 'var(--t-2)', fontSize: 13, marginBottom: 18 }}>Create a job card above to get started.</div>
          <button className="btn btn-amber" onClick={() => setCreating('manual')}><Icon name="plus" size={14}/> CREATE JOB CARD</button>
        </div>
      )}

      <div className="queue-groups">
        {workerIds.map(wid => {
          const items = groups[wid];
          const isCollapsed = collapsed[wid];
          const worker = data.workers.find(w => w.id === wid) || {};
          const groupMin = items.reduce((a, i) => a + (i.estimated_minutes || 0), 0);
          const fmtDur = (m) => m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
          return (
            <div key={wid} className="queue-wgroup">
              <div className={`qwg-head${isCollapsed ? ' collapsed' : ''}`} onClick={() => setCollapsed(c => ({ ...c, [wid]: !c[wid] }))}>
                <span className="qwg-chev"><Icon name="chevron-down" size={15}/></span>
                <div className="qwg-avatar">{(workerName(wid) || '?').split(' ').map(x => x[0]).join('').slice(0, 2)}</div>
                <div className="qwg-id">
                  <div className="qwg-name">{workerName(wid)}</div>
                  <div className="qwg-emp">{worker.employee_id || worker.designation || 'Technician'}</div>
                </div>
                <div className="qwg-stats">
                  <span className="qwg-stat"><Icon name="clock" size={12}/> {fmtDur(groupMin)}</span>
                  <span className="qwg-count">{items.length} job{items.length !== 1 ? 's' : ''}</span>
                </div>
              </div>
              {!isCollapsed && (
                <div className="qtable-wrap">
                  <div className="qtable">
                    <div className="qrow qhead">
                      <span>#</span><span>CUSTOMER</span><span>VEHICLE NO</span><span>JOB CARD</span>
                      <span>SERVICE TYPE</span><span className="r">EST. TIME</span><span>CREATED</span><span>STATUS</span><span/>
                    </div>
                    {items.map(it => {
                      const pr = (it.priority || 'medium');
                      return (
                        <div key={it.id} className={`qrow pr-${pr}${it.status !== 'queued' ? ' assigned' : ''}`} onClick={() => setDrawerId(it.id)}>
                          <span className="qpos">{it.queue_position}</span>
                          <span className="qcust"><span className="qcust-name">{it.customer_name || '—'}</span></span>
                          <span className="qveh mono">{it.vehicle_number || '—'}</span>
                          <span className="qjc mono">{it.job_card_number || '—'}</span>
                          <span className="qsvc">{it.service_type || '—'}</span>
                          <span className="r mono qest">{it.estimated_minutes || 0}m</span>
                          <span className="qcreated mono">{ljaCreated(it.created_at)}</span>
                          <span><span className={`chip ${it.status === 'queued' ? 'ghost' : it.status === 'assigned' ? 'amber' : 'ok'}`}>{(it.status || '').toUpperCase()}</span>
                            {(it.estimate_status === 'partial' || it.estimate_status === 'no_match') && <span className={`chip ${it.estimate_status === 'no_match' ? 'danger' : 'amber'}`} style={{ fontSize: 8 }} title={it.estimate_status === 'no_match' ? 'No extracted parts matched the Parts Time master (0 min)' : 'Partial estimate — some parts are not in the Parts Time master'}>{it.estimate_status === 'no_match' ? 'NO MATCH' : 'PARTIAL'}</span>}
                            {it.approval && <span className={`chip ca-qchip ${it.approval.status === 'submitted' ? 'ok' : it.approval.status === 'cancelled' || it.approval.status === 'expired' ? 'ghost' : 'amber'}`} title={`Customer approval: ${it.approval.status}`}>✓ {it.approval.status === 'submitted' ? 'APPROVED' : (it.approval.status || '').toUpperCase()}</span>}
                            {it.intake && <span className="chip ca-qchip ok" title={`Vehicle intake evidence · ${it.intake.image_count} photo(s) · ${it.intake.voice_count} voice`}><Icon name="clipboard" size={9}/> EVIDENCE</span>}</span>
                          <span className="qchev"><Icon name="chevron-right" size={14}/></span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Modals + drawer */}
      {creating === 'manual' && <LjaManualModal mode="create" workers={data.workers} bays={data.bays} opsBays={data.opsBays} onClose={() => setCreating(null)} onSaved={(m) => { flash(m); refresh(); }}/>}
      {creating === 'pdf' && <LjaPdfModal workers={data.workers} bays={data.bays} opsBays={data.opsBays} onClose={() => setCreating(null)} onSaved={(m) => { flash(m); refresh(); }}/>}
      {editJob && <LjaManualModal mode="edit" initial={editJob} workers={data.workers} bays={data.bays} opsBays={data.opsBays} onClose={() => setEditJob(null)} onSaved={(m) => { flash(m); refresh(); }}/>}

      {drawerItem && (
        <LjaDrawer
          item={drawerItem} canMove={canMove}
          onClose={() => setDrawerId(null)}
          onEdit={() => { setEditJob({ ...drawerItem }); }}
          onDelete={() => setAction('delete')}
          onChangeBay={() => setAction('bay')}
          onMove={doMove}
          onAssign={() => setAction('assign')}
          onSendApproval={doSendApproval}
          onOpenIntake={(iid) => setIntakeView(iid)}/>
      )}

      {intakeView && (
        <IntakeEvidenceDrawer id={intakeView} role="admin"
          linkJobCardId={drawerItem && drawerItem.job_card_id}
          onClose={() => setIntakeView(null)} onChanged={refresh}/>
      )}

      {action === 'delete' && drawerItem && (
        <LjaConfirm icon="trash" danger title="Delete job card?" confirmLabel="DELETE"
          body={<>Delete <b style={{ color: 'var(--t-0)' }}>{drawerItem.job_card_number}</b> ({drawerItem.customer_name}) from the queue? This cannot be undone.</>}
          onConfirm={doDelete} onClose={() => setAction(null)}/>
      )}
      {action === 'bay' && drawerItem && (
        <LjaPicker title="CHANGE BAY" label="Bay (worker follows the bay)" value={drawerItem.bay_id || ''}
          options={(data.opsBays || []).map(b => ({
            value: b.bay_id, disabled: !b.operational,
            label: `BAY ${String(b.bay_number).padStart(2, '0')} · ${b.worker ? b.worker.name : '—'}${!b.operational ? ` · 🔒 ${b.status === 'no_worker' ? 'unstaffed' : b.status}` : ''}`,
          }))}
          onSave={doChangeBay} onClose={() => setAction(null)}/>
      )}
      {action === 'assign' && drawerItem && (
        <LjaAssignModal item={drawerItem} bays={data.bays} onAssign={doAssign} onClose={() => setAction(null)}/>
      )}

      {toast && <div className={`ujq-toast${toastType === 'err' ? ' err' : ''}`}><Icon name={toastType === 'err' ? 'alert' : 'check'} size={15}/> {toast}</div>}
    </>
  );
};
window.LiveJobAssignment = LiveJobAssignment;

// ── Shared: build a recording object the VideoActions modal understands ──
// Authorized recording URLs come back RELATIVE (/api/v1/recordings/…/stream?token=…)
// so they resolve against the backend, not the static frontend origin.
const recAbsUrl = (u) => (u && u.startsWith('/') ? (BW_API.BASE + u) : u);

function recFromApi(item) {
  const r = (item && item.recording) || {};
  let durSec = 0;
  if (r.duration && r.duration.includes(':')) { const p = r.duration.split(':').map(Number); durSec = (p[0]||0)*3600 + (p[1]||0)*60 + (p[2]||0); }
  return {
    jc: item.job_card_number || '—', recId: r.recording_id || '—',
    sessionId: r.session_id || item.session_id || null,
    worker: item.worker || item.worker_name || 'Technician',
    wid: item.employee_id || item.worker_id || '',
    customer: item.customer || item.customer_name || null,
    plate: item.registration || item.vehicle || '—', vehicle: item.vehicle || '—', service: item.service_type || '—',
    start: item.start_time || '—', end: item.end_time || '—', durationSec: durSec, bay: item.bay_number || null,
    status: r.status || 'expired', daysLeft: r.days_left || 0,
    expiry: r.expiry_date || null, recordingDate: r.recording_date || null,
    fileSizeMb: r.file_size_mb || 0,
    expiresAt: r.days_left ? Date.now() + r.days_left * 864e5 : null,
    driveUrl: r.drive_url || null,
    message: r.message || null,
    url: recAbsUrl(r.url || null),
  };
}

// ── Rich job-card sections (Vehicle / Customer / Service …) ──
const WjcRow = ({ label, value, full }) => (
  <div className={`wjc-field ${full ? 'full' : ''}`}>
    <div className="wjc-label">{label}</div>
    <div className="wjc-value">{(value === 0 || value) ? value : '—'}</div>
  </div>
);
const WjcSection = ({ icon, title, sub, tone, children }) => (
  <div className="wjc-section">
    <div className="wjc-sec-head">
      <div className={`wjc-sec-ico ${tone || ''}`}><Icon name={icon} size={15}/></div>
      <div><div className="wjc-sec-title">{title}</div><div className="wjc-sec-sub">{sub}</div></div>
    </div>
    <div className="wjc-grid">{children}</div>
  </div>
);

// Full professional job card (below the timer) — mirrors the admin schema.
const LiveJobCardPanel = ({ s }) => (
  <div className="job-card pro">
    <div className="wjc-hero">
      <div className="wjc-hero-main">
        <div className="wjc-hero-top">
          <span className="job-card-id">JOB CARD · {s.job_card_number || '—'}</span>
          {s.priority && <span className="chip amber"><Icon name="bolt" size={10}/>PRIORITY {s.priority}</span>}
        </div>
        <div className="job-card-vehicle">{s.vehicle || '—'}</div>
        <div className="wjc-hero-tags">
          {s.registration && <span className="job-card-plate">{s.registration}</span>}
          {s.service_type && <span className="chip ok"><Icon name="wrench" size={10}/>{s.service_type}</span>}
        </div>
      </div>
      <div className="bay-badge"><div className="l">Bay</div><div className="v">{String(s.bay_number || 0).padStart(2, '0')}</div></div>
    </div>

    <WjcSection icon="bike" title="Vehicle Information" sub="Model · Reg · Chassis · Engine · KMs">
      <WjcRow label="Vehicle Model" value={s.vehicle} full/>
      <WjcRow label="Registration No" value={s.registration}/>
      <WjcRow label="Odometer" value={s.km_reading ? `${s.km_reading} km` : null}/>
      <WjcRow label="Chassis No" value={s.chassis_number}/>
      <WjcRow label="Engine No" value={s.engine_number}/>
    </WjcSection>

    <WjcSection icon="user" title="Customer Information" sub="Name · Contact · Email · Address" tone="blue">
      <WjcRow label="Customer Name" value={s.customer_name}/>
      <WjcRow label="Contact No" value={s.customer_mobile}/>
      <WjcRow label="Email" value={s.customer_email}/>
      <WjcRow label="Address" value={s.customer_address} full/>
    </WjcSection>

    <WjcSection icon="wrench" title="Service Details" sub="Repair · Date · Cost · Delivery">
      <WjcRow label="Job Card No" value={s.job_card_number}/>
      <WjcRow label="Logged" value={s.logged}/>
      <WjcRow label="Repair Type" value={s.repair_type} full/>
      <WjcRow label="Estimated Cost" value={(s.estimated_cost || s.estimated_cost === 0) ? `₹${Number(s.estimated_cost).toLocaleString('en-IN')}` : null}/>
      <WjcRow label="Estimated Time" value={`${s.estimated_minutes || 0} min`}/>
    </WjcSection>

    <WjcSection icon="shield" title="Staff & Assignment" sub="Technician · Bay · Status" tone="blue">
      <WjcRow label="Technician" value={s.technician}/>
      <WjcRow label="Employee ID" value={s.employee_id}/>
      <WjcRow label="Assigned Bay" value={`BAY ${String(s.bay_number || 0).padStart(2, '0')}`}/>
      <WjcRow label="Status" value={(s.status || '').toUpperCase()}/>
    </WjcSection>
  </div>
);

// ════════════════════════════════════════════════════════════
//  Worker · Active Job — industrial live work terminal (view-only)
//  Large reverse-countdown timer (green→orange→red→overtime),
//  live status panel, job card, parts table, timeline, camera.
// ════════════════════════════════════════════════════════════
const signMMSS = (sec) => {
  const a = Math.abs(Math.floor(sec || 0));
  return `${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
};

// Live timer — ticks client-side from the backend-anchored elapsed seconds,
// so the countdown (and overtime, going negative) advances every second and
// re-syncs on each poll/WS push. The timer never stops here; only the admin's
// COMPLETE removes the session.
const useWorkerTimer = (s) => {
  const t = (s && s.timer) || {};
  const running = !!(s && s.status === 'running');
  const est = (t.estimated_seconds && t.estimated_seconds > 0)
    ? t.estimated_seconds : Math.max(1, ((s && s.estimated_minutes) || 0) * 60);
  const [elapsed, setElapsed] = useLS(Math.max(0, Math.round(t.elapsed || 0)));
  const baseRef = React.useRef({ el: 0, at: Date.now() });
  useLE(() => {
    const e = Math.max(0, Math.round(t.elapsed || 0));
    baseRef.current = { el: e, at: Date.now() }; setElapsed(e);
  }, [t.elapsed, s && s.status, s && s.session_id]);
  useLE(() => {
    if (!running) return;
    const id = setInterval(() => {
      const d = Math.floor((Date.now() - baseRef.current.at) / 1000);
      setElapsed(baseRef.current.el + d);
    }, 1000);
    return () => clearInterval(id);
  }, [running, t.elapsed]);
  const remaining = est - elapsed;                 // negative ⇒ overtime
  return {
    elapsed, est, remaining, overtime: remaining < 0 ? -remaining : 0,
    running, paused: !!(s && s.status === 'paused'), completed: !!(s && s.status === 'completed'),
  };
};

// Colour stages per spec: first 40% green · next 40% orange · final 20% red · overtime red
const workerZone = (remaining, est) => {
  if (remaining < 0) return { color: 'var(--danger)', label: 'OVERTIME', key: 'overtime' };
  const pct = (remaining / Math.max(1, est)) * 100;
  if (pct >= 60) return { color: 'var(--ok)',     label: 'ON SCHEDULE', key: 'green' };
  if (pct >= 20) return { color: 'var(--warn)',   label: 'ACCELERATE',  key: 'orange' };
  return { color: 'var(--danger)', label: 'CRITICAL', key: 'red' };
};

const useWapClock = () => {
  const [n, setN] = useLS(new Date());
  useLE(() => { const id = setInterval(() => setN(new Date()), 1000); return () => clearInterval(id); }, []);
  return n;
};

// Large circular countdown ring (glow + overtime pulse)
const WapRing = ({ tm, zone }) => {
  const size = 280, stroke = 16, R = (size - stroke) / 2 - 4, C = 2 * Math.PI * R;
  const frac = tm.overtime > 0 ? 1 : Math.max(0, Math.min(1, tm.remaining / tm.est));
  const big = tm.completed ? '00:00' : (tm.overtime > 0 ? `−${signMMSS(tm.overtime)}` : signMMSS(Math.max(0, tm.remaining)));
  const cap = tm.completed ? 'COMPLETED' : tm.overtime > 0 ? 'OVERTIME' : 'REMAINING';
  const sub = tm.paused ? 'PAUSED' : tm.running ? 'LIVE' : tm.completed ? 'DONE' : 'STANDBY';
  return (
    <div className={`wap-ring zone-${zone.key}${tm.overtime > 0 ? ' is-ot' : ''}${tm.paused ? ' is-paused' : ''}`}
      style={{ width: size, height: size, ['--zc']: zone.color }}>
      <svg viewBox={`0 0 ${size} ${size}`} className="wap-ring-svg">
        <circle cx={size / 2} cy={size / 2} r={R} className="wap-ring-track" style={{ strokeWidth: stroke }}/>
        <circle cx={size / 2} cy={size / 2} r={R} className="wap-ring-prog"
          style={{ stroke: zone.color, strokeWidth: stroke, strokeDasharray: C, strokeDashoffset: C * (1 - frac) }}/>
      </svg>
      <div className="wap-ring-c">
        <div className="wap-ring-cap">{cap}</div>
        <div className="wap-ring-time" style={{ color: zone.color }}>{big}</div>
        <div className="wap-ring-zone" style={{ color: zone.color }}><span className="wap-zdot" style={{ background: zone.color }}/>{zone.label}</div>
        <div className="wap-ring-est">EST {Math.round(tm.est / 60)}M · {sub}</div>
      </div>
    </div>
  );
};

const WapStat = ({ l, v, color }) => (
  <div className="wap-stat"><div className="wap-stat-l">{l}</div><div className="wap-stat-v mono" style={color ? { color } : null}>{v}</div></div>
);

// Live status panel beside the ring
const WapLiveStatus = ({ s, tm, zone }) => (
  <div className="wap-status">
    <div className="wap-status-grid">
      <WapStat l="Estimated" v={`${Math.round(tm.est / 60)}m`}/>
      <WapStat l="Elapsed" v={signMMSS(tm.elapsed)}/>
      <WapStat l="Remaining" v={tm.remaining >= 0 ? signMMSS(tm.remaining) : '00:00'} color={zone.color}/>
      <WapStat l="Overtime" v={tm.overtime > 0 ? `+${signMMSS(tm.overtime)}` : '—'} color={tm.overtime > 0 ? 'var(--danger)' : null}/>
    </div>
    <div className="wap-rail">
      <span className="wap-rail-mark" style={{ left: '60%' }}/>
      <span className="wap-rail-mark" style={{ left: '20%' }}/>
      <div className="wap-rail-fill" style={{ width: `${Math.max(0, Math.min(100, (tm.remaining / tm.est) * 100))}%`, background: zone.color }}/>
    </div>
    <div className="wap-status-pills">
      <span className={`wap-mini ${s.camera_status === 'on' ? 'live' : s.camera_status === 'paused' ? 'warn' : ''}`}><Icon name="cam" size={12}/>CAMERA · {(s.camera_status || 'off').toUpperCase()}</span>
      <span className={`wap-mini ${s.recording_status === 'recording' ? 'rec' : s.recording_status === 'paused' ? 'warn' : ''}`}><span className="wap-rec-dot"/>REC · {(s.recording_status || 'idle').toUpperCase()}</span>
      <span className="wap-mini"><Icon name="shield" size={12}/>VIEW ONLY</span>
    </div>
    {/* backend-authoritative estimate source + truthful handoff warnings (display only) */}
    {(s.estimate_source === 'approved' || (s.start_warnings || []).length > 0) && (
      <div className="wap-sync">
        {s.estimate_source === 'approved' && (
          <span className="wap-appr"><Icon name="check" size={12}/> Customer-approved estimate{s.approved_cost != null ? ` · ₹${Math.round(s.approved_cost)}` : ''}</span>
        )}
        {(s.start_warnings || []).map((w, i) => (
          <span key={i} className="wap-warn"><Icon name="alert" size={11}/> {w}</span>
        ))}
      </div>
    )}
  </div>
);

// Sticky identity / status header
const WapHeader = ({ s, statusKey }) => {
  const now = useWapClock();
  const p = (n) => String(n).padStart(2, '0');
  return (
    <div className="wap-topbar">
      <div className="wap-id">
        <div className="wap-id-av">{s.avatar || '–'}<span className="wap-id-on"/></div>
        <div className="wap-id-meta">
          <div className="wap-id-name">{s.technician || 'Technician'}</div>
          <div className="wap-id-sub mono">{s.employee_id || '—'} · BAY {p(s.bay_number || 0)}</div>
        </div>
      </div>
      <div className="wap-topbar-mid">
        <span className={`wap-badge ${statusKey.toLowerCase()}`}><span className="wap-badge-dot"/>{statusKey}</span>
        <span className="wap-pill"><Icon name="cam" size={12}/>{s.camera_channel || 'CH-01'}</span>
        <span className="wap-pill"><Icon name="wrench" size={12}/>{s.service_type || 'Service'}</span>
      </div>
      <div className="wap-clock mono">{p(now.getHours())}:{p(now.getMinutes())}<span className="wap-clock-s">:{p(now.getSeconds())}</span>
        <span className="wap-clock-d">{now.toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short' }).toUpperCase()}</span></div>
    </div>
  );
};

// Vertical workflow timeline — highlights the current admin-controlled stage
const WapTimeline = ({ s }) => {
  const st = s.status;
  const steps = [
    { key: 'assigned', label: 'Job Assigned', sub: 'Admin assigned the job', time: s.assigned_at, icon: 'clipboard' },
    { key: 'started', label: 'Admin Started Service', sub: 'Timer & camera started', time: s.started_at, icon: 'play' },
    { key: 'progress', label: st === 'paused' ? 'Admin Paused Service' : 'Service In Progress', sub: st === 'paused' ? 'Paused by admin' : 'Live recording', time: st === 'paused' ? '—' : s.started_at, icon: st === 'paused' ? 'pause' : 'wrench' },
    { key: 'completed', label: 'Admin Completed Service', sub: 'Recording saved', time: s.ended_at, icon: 'check' },
  ];
  const cur = st === 'completed' ? 3 : (st === 'running' || st === 'paused') ? 2 : st === 'assigned' ? 1 : 0;
  return (
    <div className="wap-card">
      <div className="wap-card-head"><div className="wap-card-ico"><Icon name="route" size={14}/></div>
        <div><div className="wap-card-t">Job Timeline</div><div className="wap-card-s">Admin-controlled workflow</div></div></div>
      <div className="wap-tl">
        {steps.map((step, i) => {
          const cls = i < cur ? 'done' : i === cur ? 'active' : 'pending';
          return (
            <div key={step.key} className={`wap-tl-item ${cls}`}>
              <div className="wap-tl-rail"><span className="wap-tl-dot"><Icon name={step.icon} size={11}/></span>{i < steps.length - 1 && <span className="wap-tl-line"/>}</div>
              <div className="wap-tl-body"><div className="wap-tl-label">{step.label}</div><div className="wap-tl-sub">{step.sub}</div></div>
              <div className="wap-tl-time mono">{step.time || '—'}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// Parts & labour table (scrollable)
const WapParts = ({ parts }) => (
  <div className="wap-card">
    <div className="wap-card-head"><div className="wap-card-ico amber"><Icon name="cog" size={14}/></div>
      <div><div className="wap-card-t">Parts &amp; Labour</div><div className="wap-card-s">Code · Part / Service · Est · Status</div></div>
      <span className="wap-card-chip">{(parts || []).length} items</span></div>
    {(!parts || parts.length === 0)
      ? <div className="wap-parts-empty"><Icon name="cog" size={20}/><span>No parts breakdown captured for this job.</span></div>
      : <div className="wap-parts">
          <div className="wap-parts-h"><span>CODE</span><span>PART / SERVICE</span><span>EST</span><span>STATUS</span></div>
          <div className="wap-parts-scroll">
            {parts.map((p, i) => (
              <div key={i} className="wap-parts-row">
                <span className="mono wap-pcode">{p.code}</span>
                <span className="wap-pname">{p.name}</span>
                <span className="mono wap-pmin">{p.minutes ? `${p.minutes}m` : '—'}</span>
                <span className={`wap-pstatus ${p.status}`}>{(p.status || 'pending').replace('_', ' ').toUpperCase()}</span>
              </div>
            ))}
          </div>
        </div>}
  </div>
);

// Camera & recording status (view-only)
const WapCamera = ({ s }) => {
  const on = s.camera_status === 'on', paused = s.camera_status === 'paused';
  return (
    <div className="wap-card">
      <div className="wap-card-head"><div className="wap-card-ico"><Icon name="cam" size={14}/></div>
        <div><div className="wap-card-t">Camera &amp; Recording</div><div className="wap-card-s">{s.camera_channel || 'CH-01'} · secure stream</div></div></div>
      <div className={`wap-cam ${on ? 'live' : paused ? 'paused' : 'off'}`}>
        {on && <div className="wap-cam-scan"/>}
        {on && <span className="wap-cam-badge"><span className="rec-dot"/>LIVE</span>}
        <div className="wap-cam-c">
          <div className="wap-cam-ico"><Icon name={paused ? 'pause' : 'cam'} size={20}/></div>
          <div className="wap-cam-msg">{on ? 'LIVE · RECORDING' : paused ? 'FEED PAUSED' : 'CAMERA OFF'}</div>
          <div className="wap-cam-sub">{on ? 'Your work is being recorded securely' : paused ? 'Paused by admin' : 'Activates when admin starts service'}</div>
        </div>
      </div>
      <div className="wap-cam-meta">
        <WapStat l="Camera" v={(s.camera_status || 'off').toUpperCase()} color={on ? 'var(--ok)' : paused ? 'var(--warn)' : 'var(--t-3)'}/>
        <WapStat l="Recording" v={(s.recording_status || 'idle').toUpperCase()} color={s.recording_status === 'recording' ? 'var(--danger)' : s.recording_status === 'paused' ? 'var(--warn)' : 'var(--t-3)'}/>
      </div>
    </div>
  );
};

// Service Instructions — scrollable card (Customer Voice / Notes / Special
// Instructions / QC Notes / Additional Services). View-only.
const WapInstrBlock = ({ icon, label, value, chips }) => (
  <div className="wap-instr-block">
    <div className="wap-instr-h"><Icon name={icon} size={12}/><span>{label}</span></div>
    {chips
      ? (chips.length ? <div className="wap-instr-chips">{chips.map((c, i) => <span key={i} className="wap-instr-chip">{c}</span>)}</div>
                      : <div className="wap-instr-text muted">None recorded</div>)
      : <div className={`wap-instr-text ${value ? '' : 'muted'}`}>{value || 'None recorded'}</div>}
  </div>
);

const WapInstructions = ({ s }) => {
  const svc = Array.isArray(s.services)
    ? s.services.map((x) => x && (x.service || x.name || x.part_name)).filter(Boolean) : [];
  return (
    <div className="wap-card">
      <div className="wap-card-head"><div className="wap-card-ico"><Icon name="edit" size={14}/></div>
        <div><div className="wap-card-t">Service Instructions</div><div className="wap-card-s">Customer voice · notes · QC · add-ons</div></div></div>
      <div className="wap-instr">
        <WapInstrBlock icon="user" label="Customer Voice" value={s.complaint}/>
        <WapInstrBlock icon="edit" label="Service Notes" value={s.notes}/>
        <WapInstrBlock icon="bolt" label="Special Instructions" value={s.special_instructions}/>
        <WapInstrBlock icon="check" label="Quality Check Notes" value={s.qc_notes}/>
        <WapInstrBlock icon="wrench" label="Additional Services" chips={svc}/>
      </div>
    </div>
  );
};

// Client-side completion PDF (worker's own job) — no server round-trip needed.
const wapCompletionPdf = (s) => {
  const J = window.jspdf && window.jspdf.jsPDF;
  if (!J) return;
  const doc = new J({ unit: 'pt', format: 'a4' });
  const L = 48; let y = 60;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(18); doc.setTextColor(20);
  doc.text('Service Completion Report', L, y); y += 10;
  doc.setDrawColor(220); doc.line(L, y, 547, y); y += 26;
  const row = (k, v) => {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(120); doc.text(String(k).toUpperCase(), L, y);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(12); doc.setTextColor(20); doc.text(String(v == null || v === '' ? '—' : v), L + 150, y);
    y += 22;
  };
  row('Job Card', s.job_card_number); row('Completed At', s.ended_at);
  row('Customer', s.customer_name); row('Contact', s.customer_mobile);
  row('Vehicle', s.vehicle); row('Registration', s.registration);
  row('Service Type', s.service_type); row('Technician', s.technician);
  row('Bay', `BAY ${String(s.bay_number || 0).padStart(2, '0')}`);
  row('Estimated Time', `${s.estimated_minutes || 0} min`);
  // ── Service Recording section (Part 4) ──
  const rec = s.recording || {};
  const recUrl = recAbsUrl(rec.url);
  const avail = rec.available !== false && (rec.status && rec.status !== 'expired');
  y += 6; doc.setDrawColor(235); doc.line(L, y, 547, y); y += 22;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(20); doc.text('Service Recording', L, y); y += 22;
  row('Recording Available', avail ? 'Yes' : 'No');
  row('Recording Date', rec.recording_date || s.ended_at);
  row('Recording Duration', rec.duration);
  row('Recording Expiry Date', rec.expiry_date);
  row('Recording Session ID', rec.recording_id);
  if (recUrl) { doc.setTextColor(40, 90, 200); doc.textWithLink('▶ View Recording', L + 150, y - 22 + 0, { url: recUrl }); doc.setTextColor(20); }
  if (rec.drive_url) { row('Google Drive Link', ''); doc.setTextColor(40, 90, 200); doc.textWithLink(rec.drive_url, L + 150, y - 22, { url: rec.drive_url }); doc.setTextColor(20); }
  y += 6; doc.setFontSize(9); doc.setTextColor(150);
  doc.text('This recording will automatically expire after 14 days.', L, y); y += 14;
  doc.text('Baywatch Service OS · view-only worker copy · timer & recording controlled by Admin', L, y);
  doc.save(`completion_${s.job_card_number || 'job'}.pdf`);
};

// Completion record + recording + PDF (only after admin completes)
const WapCompletion = ({ s }) => {
  const rec = s.recording || {};
  const recUrl = recAbsUrl(rec.url);
  const expired = rec.status === 'expired' || rec.available === false;
  return (
    <div className="wap-card wap-done">
      <div className="wap-card-head"><div className="wap-card-ico ok"><Icon name="check" size={14}/></div>
        <div><div className="wap-card-t">Service Completed</div><div className="wap-card-s">Completion PDF &amp; recording</div></div></div>
      <div className="wap-done-grid">
        <WapStat l="Completed At" v={s.ended_at || '—'}/>
        <WapStat l="Recording" v={(rec.status || '—').toUpperCase()} color={!expired ? 'var(--ok)' : 'var(--t-3)'}/>
        <WapStat l="Duration" v={rec.duration || '—'}/>
        <WapStat l="Available Until" v={rec.expiry_date || '—'}/>
      </div>
      {expired && <div className="wap-rec-expired"><Icon name="alert" size={12}/> This service recording has expired and is no longer available.</div>}
      <div className="wap-done-actions">
        <button className="btn btn-sm btn-ghost wap-done-btn" onClick={() => wapCompletionPdf(s)}><Icon name="file" size={12}/> Completion PDF</button>
        {recUrl && <a className="btn btn-sm btn-ghost wap-done-btn" href={recUrl} target="_blank" rel="noreferrer"><Icon name="play" size={12}/> View Recording</a>}
        {rec.drive_url && <a className="btn btn-sm btn-ghost wap-done-btn" href={rec.drive_url} target="_blank" rel="noreferrer"><Icon name="route" size={12}/> Google Drive</a>}
      </div>
    </div>
  );
};

// ── Worker · Active Job (live, view-only) ───────────────────
const LiveWorkerActive = () => {
  const [s, setS] = useLS(null);
  const [loaded, setLoaded] = useLS(false);
  useBWSocket('/worker', (d) => { setS(d); setLoaded(true); });
  useBWPoll(() => BW_API.workerActive().then((d) => { setS(d); setLoaded(true); return d; }), [], 3000);
  const tm = useWorkerTimer(s);   // hook runs unconditionally (guards on null s)
  if (!loaded && !s) return <div className="wc-empty"><div className="t">Loading…</div></div>;
  if (!s) return (
    <>
      <div className="content-head"><div><div className="eyebrow eyebrow-amber">● ACTIVE JOB</div><h1>No active job</h1><span className="sub">Live · backend connected</span></div></div>
      <div className="cust-empty"><div className="cust-empty-ico"><Icon name="wrench" size={28}/></div><h3>Waiting for an assignment</h3><p>When your admin assigns and starts a job, it appears here live with your timer, camera and full job card.</p></div>
    </>
  );
  const zone = workerZone(tm.remaining, tm.est);
  const statusKey = tm.completed ? 'COMPLETED' : tm.overtime > 0 ? 'OVERTIME' : tm.paused ? 'PAUSED' : tm.running ? 'RUNNING' : 'READY';
  return (
    <div className="wap" style={{ ['--zc']: zone.color }}>
      <WapHeader s={s} statusKey={statusKey}/>
      <div className={`wap-hero zone-${zone.key}${tm.overtime > 0 ? ' is-ot' : ''}`}>
        <div className="wap-hero-ring"><WapRing tm={tm} zone={zone}/></div>
        <WapLiveStatus s={s} tm={tm} zone={zone}/>
      </div>
      <div className="wap-grid">
        <div className="wap-col-main">
          <LiveJobCardPanel s={s}/>
          <WapParts parts={s.parts}/>
          <WapInstructions s={s}/>
          {tm.completed && <WapCompletion s={s}/>}
        </div>
        <div className="wap-col-rail">
          <WapTimeline s={s}/>
          <WapCamera s={s}/>
        </div>
      </div>
    </div>
  );
};
window.LiveWorkerActive = LiveWorkerActive;

// ── Worker · Queue (live) ───────────────────────────────────
const LiveWorkerQueue = () => {
  const poll = useBWPoll(() => BW_API.workerQueue(), [], 2000);
  const q = poll.data || [];
  return (
    <>
      <div className="content-head"><div><div className="eyebrow eyebrow-amber">● MY JOB QUEUE</div><h1>My job queue</h1><span className="sub">Live · {q.length} upcoming</span></div></div>
      <div className="card">
        <div className="card-head"><span className="eyebrow eyebrow-amber">UPCOMING</span></div>
        {q.length===0 && <div className="wc-empty"><Icon name="queue" size={24}/><div className="t">Your queue is empty</div></div>}
        {q.map((j,i)=>(
          <div key={j.id} className="queue-item" style={{gridTemplateColumns:'auto 1fr 1fr auto', padding:'16px 18px'}}>
            <div className="queue-num">{String(i+1).padStart(2,'0')}</div>
            <div><div className="queue-vehicle">{j.vehicle||j.job_card_number}</div><span className="queue-meta">{j.job_card_number} · {j.registration||''} · {j.service_type||''}</span></div>
            <div><div className="mono" style={{fontSize:11,color:'var(--t-3)'}}>EST</div><div className="mono" style={{fontSize:12}}>{j.estimated_minutes}m</div></div>
            <span className={`chip ${j.status==='assigned'?'amber':'ghost'}`}>{(j.status||'').toUpperCase()}</span>
          </div>
        ))}
      </div>
    </>
  );
};
window.LiveWorkerQueue = LiveWorkerQueue;

// ── Worker · History (live, with recordings) ────────────────
const LiveWorkerHistory = () => {
  const poll = useBWPoll(() => BW_API.workerHistory(), [], 3000);
  const rows = poll.data || [];
  return (
    <>
      <div className="content-head"><div><div className="eyebrow eyebrow-amber">● WORK HISTORY</div><h1>Job log</h1><span className="sub">Live · {rows.length} completed · recordings 14-day retention</span></div></div>
      <div className="card">
        <div className="card-head"><span className="eyebrow eyebrow-amber">COMPLETED JOBS</span></div>
        <div className="wh-table-wrap">
          <table className="wh-table">
            <thead><tr><th>DATE</th><th>BAY</th><th>VEHICLE / SERVICE</th><th className="num">START</th><th className="num">END</th><th className="num">EST</th><th className="num">ACTUAL</th><th className="num">PAUSE</th><th className="num">O.T.</th><th className="num">SCORE</th><th>VIDEO</th><th>REC STATUS</th></tr></thead>
            <tbody>
              {rows.length===0 && <tr><td colSpan="12"><div className="wc-empty"><div className="t">No completed jobs yet</div></div></td></tr>}
              {rows.map((r,i)=>{ const rec=recFromApi(r); const pmin=r.paused_known?(r.paused_min||0):null; return (
                <tr key={i} className="wh-row">
                  <td><div className="wh-date">{r.date?new Date(r.date).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}):'—'}</div></td>
                  <td><div className="bay-badge-sm">{String(r.bay_number||0).padStart(2,'0')}</div></td>
                  <td><div className="wh-vehicle">{r.vehicle}</div><div className="wh-meta">{r.registration} · {r.service_type}</div></td>
                  <td className="num mono" style={{color:'var(--ok)'}}>{r.start_time||'—'}</td>
                  <td className="num mono" style={{color:'var(--t-2)'}}>{r.end_time||'—'}</td>
                  <td className="num mono" style={{color:'var(--t-3)'}}>{r.estimated}m</td><td className="num mono">{r.actual}m</td>
                  <td className="num mono" style={{color:pmin?'var(--warn)':'var(--t-4)'}}>{pmin?`${pmin}m`:'—'}</td>
                  <td className="num mono" style={{color:r.overtime>0?'var(--danger)':'var(--ok)'}}>{r.overtime>0?`+${r.overtime}m`:'—'}</td>
                  <td className="num"><span className={`history-score ${r.score>=100?'ok':r.score>=90?'warn':'danger'}`}>{r.score}%</span></td>
                  <td><window.VideoActions rec={rec}/></td>
                  <td><window.RecordingStatusBadge status={rec.status} daysLeft={rec.daysLeft}/></td>
                </tr>
              );})}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
};
window.LiveWorkerHistory = LiveWorkerHistory;

// ════════════════════════════════════════════════════════════════
//  Worker · Jobcard Entry / Vehicle Intake Evidence (Phase C)
//  Mobile-first wizard (Customer→Vehicle→Complaint→Images→Voice→Review)
//  + Bike Register History (this worker's OWN entries) + read-only detail.
//  Flow: create intake → upload photos → upload MediaRecorder voice notes →
//  submit. Media is shown only via the backend's token-gated URLs
//  (BW_API.intakeMediaUrl(view_url)); a raw filesystem path never reaches the UI.
// ════════════════════════════════════════════════════════════════
const { useState: useJS, useEffect: useJE, useRef: useJR, useCallback: useJC } = React;

const JCE_IMG = { max: 20, bytes: 8 * 1024 * 1024, exts: ['jpg', 'jpeg', 'png', 'webp'] };
const JCE_AUD = { max: 10, secs: 120 };
const JCE_STATUS_TONE = { draft: 'ghost', submitted: 'amber', linked: 'ok', archived: 'ghost', revoked: 'danger' };
const jceExt = (n) => (n || '').split('.').pop().toLowerCase();
const jceNorm = (s) => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const jceUid = () => Math.random().toString(36).slice(2);
const jceFmtDT = (iso) => { if (!iso) return '—'; try { return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch (e) { return '—'; } };
const jceMMSS = (s) => `${String(Math.floor((s || 0) / 60)).padStart(2, '0')}:${String(Math.floor(s || 0) % 60).padStart(2, '0')}`;

const JceField = ({ label, req, full, children }) => (
  <div className={`jf-field${full ? ' full' : ''}`}><label>{label}{req && <span className="jf-req"> *</span>}</label>{children}</div>
);

// ── read-only intake detail (shared by History + submit success) ──
// Download Evidence PDF — role-scoped, auth-gated blob download with loading + error state.
// Reused by the worker read-only detail and the admin/master evidence drawers.
const IntakePdfButton = ({ role, id, disabled }) => {
  const [busy, setBusy] = useJS(false);
  const [err, setErr] = useJS('');
  const go = async () => {
    if (!id) return;
    setBusy(true); setErr('');
    try { await BW_API.intakeEvidencePdf(role, id); }
    catch (e) { setErr((e && e.message) || 'Could not generate the evidence PDF'); }
    finally { setBusy(false); }
  };
  return (
    <div className="jce-pdfwrap">
      {err && <span className="jce-pdferr" title={err}><Icon name="x" size={12}/> {err}</span>}
      <button className="btn btn-sm jce-pdfbtn" disabled={busy || disabled || !id} onClick={go}>
        <Icon name="file" size={14}/> {busy ? 'Preparing PDF…' : 'Download Evidence PDF'}
      </button>
    </div>
  );
};

const JceDetail = ({ id, onClose }) => {
  const [d, setD] = useJS(null);
  const [err, setErr] = useJS('');
  useJE(() => {
    let a = true;
    BW_API.workerIntakeGet(id).then(x => { if (a) setD(x); }).catch(e => { if (a) setErr(e.message || 'Failed to load'); });
    return () => { a = false; };
  }, [id]);
  const Media = ({ m, audio }) => {
    if (!m.available) return <div className="jce-mtile expired"><Icon name={audio ? 'mic' : 'image'} size={18}/><span>Expired</span></div>;
    if (audio) return (
      <div className="jce-voice">
        <Icon name="mic" size={15}/>
        <div className="jce-voice-meta"><div className="t">{m.caption || 'Voice note'}</div><div className="s mono">{jceMMSS(m.duration_seconds)}</div></div>
        <audio controls preload="none" src={BW_API.intakeMediaUrl(m.view_url)} style={{ height: 32 }}/>
      </div>
    );
    return (
      <a className="jce-mtile" href={BW_API.intakeMediaUrl(m.view_url)} target="_blank" rel="noreferrer" title={m.caption || ''}>
        <img src={BW_API.intakeMediaUrl(m.thumbnail_url || m.view_url)} alt={m.caption || 'bike photo'}/>
        {m.caption && <span className="cap">{m.caption}</span>}
      </a>
    );
  };
  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal modal-lg jce-detail" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div><div className="eyebrow eyebrow-amber">● VEHICLE INTAKE EVIDENCE</div><h3 style={{ margin: '4px 0 0' }}>{d ? d.intake_no : 'Loading…'}</h3></div>
          <button className="modal-close" onClick={onClose}><Icon name="x" size={16}/></button>
        </div>
        <div className="modal-scroll">
          {err && <div className="jce-banner danger">{err}</div>}
          {!d && !err && <div className="jce-empty">Loading…</div>}
          {d && <>
            <div className="jce-detail-top">
              <span className={`chip ${JCE_STATUS_TONE[d.status] || 'ghost'}`}>{(d.status || '').toUpperCase()}</span>
              <span className="jce-bike mono"><Icon name="bike" size={14}/> {d.bike_number || '—'}</span>
              {d.bike_number_normalized && <span className="jce-norm mono">KEY · {d.bike_number_normalized}</span>}
            </div>
            <div className="jce-dgrid">
              {[['Intake No', d.intake_no], ['Customer', d.customer_name], ['Phone', d.phone_number], ['WhatsApp', d.whatsapp_number], ['Email', d.email], ['Address', d.address], ['Engine No', d.engine_number], ['Chassis No', d.chassis_number], ['Submitted', jceFmtDT(d.submitted_at)], ['Retention', d.retention && d.retention.days_left != null ? `${d.retention.days_left} day(s) left` : '—']].map(([l, v]) => (
                <div className="jce-d" key={l}><span className="l">{l}</span><span className="v">{(v === 0 || v) ? v : '—'}</span></div>
              ))}
            </div>
            <div className="jce-d full"><span className="l">Complaint</span><span className="v">{d.complaint_description || '—'}</span></div>
            {d.linked && d.linked.is_linked && (
              <div className="jce-banner ok"><Icon name="check" size={14}/> Linked to job card {d.linked.job_card_id || d.linked.job_id} {d.linked.linked_by_admin_name ? `· by ${d.linked.linked_by_admin_name}` : ''}</div>
            )}
            <div className="jce-sec-h"><Icon name="image" size={14}/> Bike images <span className="n">{(d.images || []).length}</span></div>
            <div className="jce-thumbs">{(d.images || []).length === 0 ? <div className="jce-empty sm">No images</div> : d.images.map(m => <Media key={m.id} m={m}/>)}</div>
            <div className="jce-sec-h"><Icon name="mic" size={14}/> Voice recordings <span className="n">{(d.voices || []).length}</span></div>
            <div className="jce-voices">{(d.voices || []).length === 0 ? <div className="jce-empty sm">No voice notes</div> : d.voices.map(m => <Media key={m.id} m={m} audio/>)}</div>
            {(d.events || []).length > 0 && (
              <><div className="jce-sec-h"><Icon name="history" size={14}/> Timeline</div>
              <div className="jce-timeline">{d.events.map((ev, i) => (
                <div className="jce-ev" key={i}><span className="d mono">{jceFmtDT(ev.created_at)}</span><span className="t">{(ev.event_type || '').replace(/_/g, ' ')}{ev.actor_name ? ` · ${ev.actor_name}` : ''}</span></div>
              ))}</div></>
            )}
          </>}
        </div>
        <div className="modal-foot jce-foot">
          {d && <IntakePdfButton role="worker" id={d.id}/>}
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
};

// ── Bike Register History (this worker's own entries) ──
const JceHistory = ({ refreshKey, onOpen }) => {
  const [rows, setRows] = useJS(null);
  const [err, setErr] = useJS('');
  const [f, setF] = useJS({ bike_number: '', status: '' });
  useJE(() => {
    let a = true; setErr('');
    const filters = {};
    if (f.bike_number.trim()) filters.bike_number = f.bike_number.trim();
    if (f.status) filters.status = f.status;
    const t = setTimeout(() => {
      BW_API.workerIntakeList(filters).then(r => { if (a) setRows(Array.isArray(r) ? r : []); })
        .catch(e => { if (a) { setRows([]); setErr(e.message || 'Failed to load'); } });
    }, 250);
    return () => { a = false; clearTimeout(t); };
  }, [f, refreshKey]);
  return (
    <div className="card">
      <div className="card-head"><span className="eyebrow eyebrow-amber">BIKE REGISTER · MY ENTRIES</span></div>
      <div className="jce-filters">
        <input className="input" placeholder="Search bike number…" value={f.bike_number} onChange={e => setF(s => ({ ...s, bike_number: e.target.value }))}/>
        <select className="input" value={f.status} onChange={e => setF(s => ({ ...s, status: e.target.value }))}>
          <option value="">All statuses</option>
          {['draft', 'submitted', 'linked', 'archived', 'revoked'].map(s => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
        </select>
      </div>
      {err && <div className="jce-banner danger">{err}</div>}
      {rows === null && <div className="jce-empty">Loading…</div>}
      {rows && rows.length === 0 && <div className="wc-empty"><Icon name="clipboard" size={24}/><div className="t">No intake entries yet</div></div>}
      <div className="jce-cards">
        {(rows || []).map(r => (
          <button key={r.id} className="jce-hcard" onClick={() => onOpen(r.id)}>
            <div className="jce-hc-top">
              <span className="jce-hc-bike mono"><Icon name="bike" size={14}/> {r.bike_number || '—'}</span>
              <span className={`chip ${JCE_STATUS_TONE[r.status] || 'ghost'}`}>{(r.status || '').toUpperCase()}</span>
            </div>
            <div className="jce-hc-cust">{r.customer_name || 'Customer —'} · <span className="mono">{r.phone_number || '—'}</span></div>
            {r.complaint_short && <div className="jce-hc-comp">{r.complaint_short}</div>}
            <div className="jce-hc-meta">
              <span><Icon name="image" size={12}/> {r.image_count}</span>
              <span><Icon name="mic" size={12}/> {r.voice_count}</span>
              {r.linked && <span className="ok"><Icon name="check" size={12}/> Linked</span>}
              <span className="mono jce-hc-no">{r.intake_no}</span>
            </div>
            <div className="jce-hc-dates mono">
              <span>Created {jceFmtDT(r.created_at)}</span>
              {r.submitted_at && <span>· Submitted {jceFmtDT(r.submitted_at)}</span>}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
};

// ── New Entry wizard ──
const JCE_STEPS = [
  { n: 1, t: 'Customer', icon: 'user' }, { n: 2, t: 'Vehicle', icon: 'bike' },
  { n: 3, t: 'Complaint', icon: 'clipboard' }, { n: 4, t: 'Images', icon: 'image' },
  { n: 5, t: 'Voice', icon: 'mic' }, { n: 6, t: 'Review', icon: 'check' },
];

const JceNewEntry = ({ onSubmitted, onGoHistory }) => {
  const [step, setStep] = useJS(1);
  const [form, setForm] = useJS({ customer_name: '', phone_number: '', whatsapp_number: '', email: '', address: '', bike_number: '', engine_number: '', chassis_number: '', complaint_description: '' });
  const set = (k) => (e) => setForm(s => ({ ...s, [k]: e.target.value }));
  const [images, setImages] = useJS([]);   // {key,file,url,caption,uploaded}
  const [voices, setVoices] = useJS([]);    // {key,blob,url,label,duration,uploaded}
  const [err, setErr] = useJS('');
  const [busy, setBusy] = useJS(false);
  const [progress, setProgress] = useJS('');
  const [recovery, setRecovery] = useJS('');
  const [result, setResult] = useJS(null);
  const [viewId, setViewId] = useJS(null);
  const createdRef = useJR(null);

  const [recording, setRecording] = useJS(false);
  const [recSecs, setRecSecs] = useJS(0);
  const recRef = useJR(null);
  const chunksRef = useJR([]);
  const recTimerRef = useJR(null);
  const recStartRef = useJR(0);
  const streamRef = useJR(null);

  useJE(() => () => {   // unmount cleanup: revoke object URLs + stop mic
    images.forEach(i => { try { URL.revokeObjectURL(i.url); } catch (e) {} });
    voices.forEach(v => { try { URL.revokeObjectURL(v.url); } catch (e) {} });
    clearInterval(recTimerRef.current);
    try { streamRef.current && streamRef.current.getTracks().forEach(t => t.stop()); } catch (e) {}
  }, []); // eslint-disable-line

  const addImages = (files) => {
    setErr('');
    const next = images.slice();
    for (const file of Array.from(files || [])) {
      if (next.length >= JCE_IMG.max) { setErr(`Maximum ${JCE_IMG.max} images`); break; }
      const okType = JCE_IMG.exts.includes(jceExt(file.name)) || /^image\//.test(file.type || '');
      if (!okType) { setErr(`Unsupported image: ${file.name}`); continue; }
      if (file.size > JCE_IMG.bytes) { setErr(`${file.name} exceeds 8 MB`); continue; }
      next.push({ key: jceUid(), file, url: URL.createObjectURL(file), caption: '', uploaded: false });
    }
    setImages(next);
  };
  const removeImage = (key) => setImages(s => { const it = s.find(x => x.key === key); if (it) { try { URL.revokeObjectURL(it.url); } catch (e) {} } return s.filter(x => x.key !== key); });
  const captionImage = (key, v) => setImages(s => s.map(x => x.key === key ? { ...x, caption: v } : x));

  const stopRec = useJC(() => {
    try { if (recRef.current && recRef.current.state !== 'inactive') recRef.current.stop(); } catch (e) {}
    clearInterval(recTimerRef.current);
    setRecording(false);
  }, []);
  const startRec = async () => {
    setErr('');
    if (voices.length >= JCE_AUD.max) { setErr(`Maximum ${JCE_AUD.max} voice notes`); return; }
    if (!navigator.mediaDevices || !window.MediaRecorder) { setErr('Voice recording is not supported on this device'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mr = new MediaRecorder(stream);
      chunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data && e.data.size) chunksRef.current.push(e.data); };
      mr.onstop = () => {
        const type = mr.mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type });
        const dur = Math.max(1, Math.round((Date.now() - recStartRef.current) / 1000));
        setVoices(s => [...s, { key: jceUid(), blob, url: URL.createObjectURL(blob), label: '', duration: dur, uploaded: false }]);
        try { stream.getTracks().forEach(t => t.stop()); } catch (e) {}
        streamRef.current = null;
      };
      recRef.current = mr;
      recStartRef.current = Date.now();
      mr.start();
      setRecording(true); setRecSecs(0);
      recTimerRef.current = setInterval(() => {
        const s = Math.round((Date.now() - recStartRef.current) / 1000);
        setRecSecs(s);
        if (s >= JCE_AUD.secs) stopRec();
      }, 250);
    } catch (e) { setErr('Microphone permission denied'); }
  };
  const removeVoice = (key) => setVoices(s => { const it = s.find(x => x.key === key); if (it) { try { URL.revokeObjectURL(it.url); } catch (e) {} } return s.filter(x => x.key !== key); });
  const labelVoice = (key, v) => setVoices(s => s.map(x => x.key === key ? { ...x, label: v } : x));

  const reset = () => {
    images.forEach(i => { try { URL.revokeObjectURL(i.url); } catch (e) {} });
    voices.forEach(v => { try { URL.revokeObjectURL(v.url); } catch (e) {} });
    createdRef.current = null;
    setForm({ customer_name: '', phone_number: '', whatsapp_number: '', email: '', address: '', bike_number: '', engine_number: '', chassis_number: '', complaint_description: '' });
    setImages([]); setVoices([]); setResult(null); setRecovery(''); setErr(''); setStep(1);
  };

  const doSubmit = async () => {
    if (!form.bike_number.trim()) { setErr('Bike registration number is required'); setStep(2); return; }
    if (!form.complaint_description.trim()) { setErr('Complaint description is required'); setStep(3); return; }
    setBusy(true); setErr(''); setRecovery('');
    try {
      let id = createdRef.current;
      if (!id) { setProgress('Creating intake…'); const c = await BW_API.workerIntakeCreate({ ...form }); id = c.id; createdRef.current = id; }
      let failed = 0;
      for (let i = 0; i < images.length; i++) {
        if (images[i].uploaded) continue;
        setProgress(`Uploading image ${i + 1} of ${images.length}…`);
        try { await BW_API.workerIntakeUploadImage(id, images[i].file, images[i].caption); images[i].uploaded = true; } catch (e) { failed++; }
      }
      for (let i = 0; i < voices.length; i++) {
        if (voices[i].uploaded) continue;
        setProgress(`Uploading voice note ${i + 1} of ${voices.length}…`);
        try { await BW_API.workerIntakeUploadAudio(id, voices[i].blob, voices[i].label, voices[i].duration); voices[i].uploaded = true; } catch (e) { failed++; }
      }
      if (failed > 0) { setRecovery('Entry saved as draft. Some media failed to upload. Please retry before submit.'); setBusy(false); setProgress(''); return; }
      setProgress('Submitting…');
      const detail = await BW_API.workerIntakeSubmit(id);
      setResult(detail);
    } catch (e) {
      setErr(e.message || 'Submit failed');
      if (createdRef.current) setRecovery('Entry saved as draft. Please retry to finish submitting.');
    } finally { setBusy(false); setProgress(''); }
  };

  // success screen
  if (result) return (
    <>
      <div className="jce-success card">
        <div className="jce-success-ico"><Icon name="check" size={30}/></div>
        <h2>Intake submitted</h2>
        <div className="jce-success-no mono">{result.intake_no}</div>
        <div className="jce-success-grid">
          <div><span className="l">Bike</span><span className="v mono">{result.bike_number}</span></div>
          <div><span className="l">Key</span><span className="v mono">{result.bike_number_normalized}</span></div>
          <div><span className="l">Submitted</span><span className="v">{jceFmtDT(result.submitted_at)}</span></div>
          <div><span className="l">Images</span><span className="v">{result.image_count}</span></div>
          <div><span className="l">Voice notes</span><span className="v">{result.voice_count}</span></div>
          <div><span className="l">Retention</span><span className="v">{result.retention && result.retention.days_left != null ? `${result.retention.days_left} days` : '14 days'}</span></div>
        </div>
        <div className="jce-success-actions">
          <button className="btn btn-ghost" onClick={() => setViewId(result.id)}><Icon name="file" size={14}/> View detail</button>
          <button className="btn btn-ghost" onClick={onGoHistory}><Icon name="history" size={14}/> Bike Register History</button>
          <button className="btn btn-amber" onClick={reset}><Icon name="plus" size={14}/> New entry</button>
        </div>
      </div>
      {viewId && <JceDetail id={viewId} onClose={() => setViewId(null)}/>}
    </>
  );

  return (
    <div className="jce-wizard">
      <div className="jce-steps">
        {JCE_STEPS.map(s => (
          <button key={s.n} className={`jce-step ${step === s.n ? 'on' : ''} ${step > s.n ? 'done' : ''}`} onClick={() => setStep(s.n)}>
            <span className="jce-step-ico"><Icon name={step > s.n ? 'check' : s.icon} size={14}/></span>
            <span className="jce-step-t">{s.t}</span>
          </button>
        ))}
      </div>

      <div className="card jce-stepcard">
        {step === 1 && <div className="jce-form">
          <div className="jce-step-h"><Icon name="user" size={16}/> Customer details</div>
          <div className="jf-grid">
            <JceField label="Customer name"><input value={form.customer_name} onChange={set('customer_name')} placeholder="e.g. Tharun M"/></JceField>
            <JceField label="Phone number"><input value={form.phone_number} onChange={set('phone_number')} placeholder="10-digit mobile"/></JceField>
            <JceField label="WhatsApp number"><input value={form.whatsapp_number} onChange={set('whatsapp_number')} placeholder="If different"/></JceField>
            <JceField label="Email"><input value={form.email} onChange={set('email')} placeholder="name@example.com"/></JceField>
            <JceField label="Address" full><textarea value={form.address} onChange={set('address')} rows={2} placeholder="Customer address"/></JceField>
          </div>
        </div>}

        {step === 2 && <div className="jce-form">
          <div className="jce-step-h"><Icon name="bike" size={16}/> Vehicle details</div>
          <div className="jce-keynote"><Icon name="alert" size={14}/> The bike registration number is the primary key that links this intake across the whole system.</div>
          <div className="jf-grid">
            <JceField label="Bike / registration number" req full>
              <input value={form.bike_number} onChange={set('bike_number')} placeholder="e.g. PY 05 U 2205" style={{ textTransform: 'uppercase' }}/>
              {form.bike_number.trim() && <div className="jce-normhint mono">Matching key → {jceNorm(form.bike_number) || '—'}</div>}
            </JceField>
            <JceField label="Engine number"><input value={form.engine_number} onChange={set('engine_number')}/></JceField>
            <JceField label="Chassis number"><input value={form.chassis_number} onChange={set('chassis_number')}/></JceField>
          </div>
        </div>}

        {step === 3 && <div className="jce-form">
          <div className="jce-step-h"><Icon name="clipboard" size={16}/> Complaint details</div>
          <div className="jf-grid">
            <JceField label="Complaint description" req full>
              <textarea value={form.complaint_description} onChange={set('complaint_description')} rows={5} placeholder="What did the customer report? (oil leak, chain noise, brake check…)"/>
            </JceField>
          </div>
        </div>}

        {step === 4 && <div className="jce-form">
          <div className="jce-step-h"><Icon name="image" size={16}/> Bike images <span className="jce-count">{images.length} / {JCE_IMG.max}</span></div>
          <div className="jce-uprow">
            <label className="btn btn-ghost"><Icon name="image" size={14}/> Add photos
              <input type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={e => { addImages(e.target.files); e.target.value = ''; }}/>
            </label>
            <label className="btn btn-ghost"><Icon name="cam" size={14}/> Take photo
              <input type="file" accept="image/*" capture="environment" hidden onChange={e => { addImages(e.target.files); e.target.value = ''; }}/>
            </label>
            <span className="jce-uphint">jpg / png / webp · ≤ 8 MB each</span>
          </div>
          <div className="jce-thumbs edit">
            {images.length === 0 && <div className="jce-empty sm">No images added · capture scratches/damage before service</div>}
            {images.map(im => (
              <div className="jce-thumb" key={im.key}>
                <img src={im.url} alt="bike"/>
                <button className="jce-thumb-x" onClick={() => removeImage(im.key)}><Icon name="x" size={12}/></button>
                <input className="jce-thumb-cap" placeholder="Caption…" value={im.caption} onChange={e => captionImage(im.key, e.target.value)}/>
              </div>
            ))}
          </div>
        </div>}

        {step === 5 && <div className="jce-form">
          <div className="jce-step-h"><Icon name="mic" size={16}/> Voice recordings <span className="jce-count">{voices.length} / {JCE_AUD.max}</span></div>
          <div className="jce-recbar">
            {!recording
              ? <button className="btn btn-amber" onClick={startRec} disabled={voices.length >= JCE_AUD.max}><Icon name="mic" size={14}/> Record</button>
              : <button className="btn btn-amber rec" onClick={stopRec}><Icon name="stop" size={14}/> Stop · {jceMMSS(recSecs)}</button>}
            {recording && <span className="jce-recdot">● recording — auto-stops at 2:00</span>}
            {!recording && <span className="jce-uphint">Capture the customer's complaint · up to 2 min each</span>}
          </div>
          <div className="jce-voices edit">
            {voices.length === 0 && <div className="jce-empty sm">No voice notes recorded</div>}
            {voices.map(v => (
              <div className="jce-vrow" key={v.key}>
                <audio controls preload="none" src={v.url} style={{ height: 34 }}/>
                <span className="mono jce-vdur">{jceMMSS(v.duration)}</span>
                <input className="jce-vlabel" placeholder="Label…" value={v.label} onChange={e => labelVoice(v.key, e.target.value)}/>
                <button className="jce-vx" onClick={() => removeVoice(v.key)}><Icon name="trash" size={14}/></button>
              </div>
            ))}
          </div>
        </div>}

        {step === 6 && <div className="jce-form">
          <div className="jce-step-h"><Icon name="check" size={16}/> Review &amp; submit</div>
          <div className="jce-review">
            <div className="jce-rev-grid">
              {[['Customer', form.customer_name], ['Phone', form.phone_number], ['WhatsApp', form.whatsapp_number], ['Email', form.email], ['Bike number', form.bike_number], ['Matching key', jceNorm(form.bike_number)], ['Engine', form.engine_number], ['Chassis', form.chassis_number]].map(([l, v]) => (
                <div className="jce-d" key={l}><span className="l">{l}</span><span className="v mono">{v || '—'}</span></div>
              ))}
            </div>
            <div className="jce-d full"><span className="l">Complaint</span><span className="v">{form.complaint_description || '—'}</span></div>
            <div className="jce-rev-counts">
              <span><Icon name="image" size={14}/> {images.length} image(s)</span>
              <span><Icon name="mic" size={14}/> {voices.length} voice note(s)</span>
            </div>
            {(!form.bike_number.trim() || !form.complaint_description.trim()) && <div className="jce-banner warn"><Icon name="alert" size={14}/> Bike number and complaint are required before submit.</div>}
          </div>
        </div>}

        {err && <div className="jce-banner danger"><Icon name="alert" size={14}/> {err}</div>}
        {recovery && <div className="jce-banner warn"><Icon name="alert" size={14}/> {recovery}</div>}
        {busy && progress && <div className="jce-banner info">{progress}</div>}

        <div className="jce-nav">
          <button className="btn btn-ghost" disabled={step === 1 || busy} onClick={() => setStep(s => Math.max(1, s - 1))}><Icon name="arrow-left" size={14}/> Back</button>
          {step < 6
            ? <button className="btn btn-amber" onClick={() => setStep(s => Math.min(6, s + 1))}>Next <Icon name="arrow-right" size={14}/></button>
            : (recovery
              ? <button className="btn btn-amber" disabled={busy} onClick={doSubmit}>{busy ? 'Retrying…' : 'Retry upload & submit'}</button>
              : <button className="btn btn-amber" disabled={busy} onClick={doSubmit}>{busy ? 'Submitting…' : 'Submit intake'}</button>)}
        </div>
      </div>
    </div>
  );
};

const LiveWorkerJobcard = () => {
  const [sub, setSub] = useJS('new');
  const [openId, setOpenId] = useJS(null);
  const [hkey, setHkey] = useJS(0);
  return (
    <>
      <div className="content-head">
        <div>
          <div className="eyebrow eyebrow-amber">● JOBCARD ENTRY</div>
          <h1>Vehicle intake evidence</h1>
          <span className="sub">Record customer, bike condition photos &amp; complaint voice before service</span>
        </div>
      </div>
      <div className="tab-bar jce-tabs">
        <button className={`tab-btn ${sub === 'new' ? 'active' : ''}`} onClick={() => setSub('new')}><Icon name="plus" size={14}/> New Entry</button>
        <button className={`tab-btn ${sub === 'history' ? 'active' : ''}`} onClick={() => { setSub('history'); setHkey(k => k + 1); }}><Icon name="history" size={14}/> Bike Register History</button>
      </div>
      {sub === 'new'
        ? <JceNewEntry onSubmitted={() => setHkey(k => k + 1)} onGoHistory={() => { setSub('history'); setHkey(k => k + 1); }}/>
        : <JceHistory refreshKey={hkey} onOpen={setOpenId}/>}
      {openId && <JceDetail id={openId} onClose={() => setOpenId(null)}/>}
    </>
  );
};
window.LiveWorkerJobcard = LiveWorkerJobcard;

// ════════════════════════════════════════════════════════════════
//  Admin + Master · Vehicle Intake Evidence integration (Phase D)
//  Shared role-aware evidence drawer (admin=own branch, master=global) +
//  admin worker-wise page + master branch→worker→bike page. Reads the
//  Phase B APIs; all media via token-gated URLs (BW_API.intakeMediaUrl) —
//  a raw filesystem path never reaches the DOM.
// ════════════════════════════════════════════════════════════════
// ── Admin Intake Evidence Dashboard helpers (additive; reuse the pinned intake backend) ──
const IAE_TONE = { ok: 'ok', amber: 'amber', bad: 'bad', ghost: 'ghost', blue: 'blue' };
const intakeWarnings = (d) => {
  if (!d) return [];
  const w = [];
  const imgs = d.images || [], vics = d.voices || [];
  if (imgs.length === 0) w.push({ tone: 'bad', text: 'No photo evidence captured' });
  if (vics.length === 0) w.push({ tone: 'amber', text: 'No complaint voice note' });
  if (!(d.linked && d.linked.is_linked)) w.push({ tone: 'amber', text: 'Not linked to a job card' });
  const dl = d.retention && d.retention.days_left;
  if (dl != null && dl >= 0 && dl <= 3) w.push({ tone: 'amber', text: `Media expiring soon · ${dl} day(s) left` });
  const anyExpired = [...imgs, ...vics].some(m => !m.available && m.status !== 'revoked');
  if ((dl != null && dl < 0) || anyExpired) w.push({ tone: 'bad', text: 'Some media has expired (retention)' });
  if (!d.phone_number) w.push({ tone: 'amber', text: 'Missing customer phone number' });
  return w;
};
// Derived evidence-completeness status for list rows/cards (distinct from the entry lifecycle status)
const intakeEvidenceStatus = (e) => {
  if (e.status === 'revoked') return { label: 'Revoked', tone: 'bad' };
  if (e.status === 'archived') return { label: 'Archived', tone: 'ghost' };
  if (e.expires_at) { const dl = (new Date(e.expires_at) - Date.now()) / 86400000; if (dl < 0) return { label: 'Expired Media', tone: 'bad' }; if (dl <= 3) return { label: 'Expiring Soon', tone: 'amber' }; }
  if ((e.image_count || 0) === 0) return { label: 'Missing Photos', tone: 'bad' };
  if ((e.voice_count || 0) === 0) return { label: 'Missing Voice', tone: 'amber' };
  if (!e.linked) return { label: 'Unlinked Job', tone: 'amber' };
  return { label: 'Complete', tone: 'ok' };
};

const IntakeEvidenceDrawer = ({ id, role, linkJobCardId, onClose, onChanged }) => {
  const [d, setD] = useJS(null);
  const [err, setErr] = useJS('');
  const [busy, setBusy] = useJS('');
  const getter = role === 'master' ? BW_API.masterIntakeGet : BW_API.adminIntakeGet;
  const revoker = role === 'master' ? BW_API.masterIntakeRevokeMedia : BW_API.adminIntakeRevokeMedia;
  const load = useJC(() => { setErr(''); getter(id).then(setD).catch(e => setErr(e.message || 'Failed to load')); }, [id, role]);
  useJE(() => { load(); }, [load]);
  const revoke = async (mediaId) => {
    setBusy(mediaId);
    try { await revoker(mediaId); load(); onChanged && onChanged(); } catch (e) { setErr(e.message || 'Revoke failed'); } finally { setBusy(''); }
  };
  const doLink = async () => {
    setBusy('link');
    try { await BW_API.adminIntakeLinkJob(id, { job_card_id: linkJobCardId }); load(); onChanged && onChanged(); }
    catch (e) { setErr(e.message || 'Link failed'); } finally { setBusy(''); }
  };
  const Media = ({ m, audio }) => {
    if (!m.available) return <div className="jce-mtile expired"><Icon name={audio ? 'mic' : 'image'} size={18}/><span>{m.status === 'revoked' ? 'Revoked' : 'Expired'}</span></div>;
    if (audio) return (
      <div className="jce-voice">
        <Icon name="mic" size={15}/>
        <div className="jce-voice-meta"><div className="t">{m.caption || 'Voice note'}</div><div className="s mono">{jceMMSS(m.duration_seconds)}</div></div>
        <audio controls preload="none" src={BW_API.intakeMediaUrl(m.view_url)} style={{ height: 32 }}/>
        <button className="jce-mrevoke" title="Revoke media" disabled={busy === m.id} onClick={() => revoke(m.id)}><Icon name="trash" size={13}/></button>
      </div>
    );
    return (
      <div className="jce-mtile">
        <a href={BW_API.intakeMediaUrl(m.view_url)} target="_blank" rel="noreferrer" title={m.caption || ''}><img src={BW_API.intakeMediaUrl(m.thumbnail_url || m.view_url)} alt={m.caption || 'bike photo'}/></a>
        {m.caption && <span className="cap">{m.caption}</span>}
        <button className="jce-mrevoke tile" title="Revoke media" disabled={busy === m.id} onClick={() => revoke(m.id)}><Icon name="x" size={12}/></button>
      </div>
    );
  };
  const lk = d && d.linked;
  return (
    <div className="modal-scrim" onClick={onClose} style={{ zIndex: 360 }}>
      <div className="modal modal-lg jce-detail" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div><div className="eyebrow eyebrow-amber">● VEHICLE INTAKE EVIDENCE {role === 'master' ? '· MASTER' : ''}</div><h3 style={{ margin: '4px 0 0' }}>{d ? d.intake_no : 'Loading…'}</h3></div>
          <button className="modal-close" onClick={onClose}><Icon name="x" size={16}/></button>
        </div>
        <div className="modal-scroll">
          {err && <div className="jce-banner danger">{err}</div>}
          {!d && !err && <div className="jce-empty">Loading…</div>}
          {d && <>
            <div className="jce-detail-top">
              <span className={`chip ${JCE_STATUS_TONE[d.status] || 'ghost'}`}>{(d.status || '').toUpperCase()}</span>
              <span className="jce-bike mono"><Icon name="bike" size={14}/> {d.bike_number || '—'}</span>
              {d.bike_number_normalized && <span className="jce-norm mono">KEY · {d.bike_number_normalized}</span>}
            </div>
            <div className="jce-sec-h"><Icon name="user" size={14}/> Worker</div>
            <div className="jce-dgrid">
              {[['Worker', d.worker_name], ['Worker ID', d.worker_id], ['Branch', d.branch_id], ['Submitted', jceFmtDT(d.submitted_at)]].map(([l, v]) => (
                <div className="jce-d" key={l}><span className="l">{l}</span><span className="v">{(v === 0 || v) ? v : '—'}</span></div>
              ))}
            </div>
            <div className="jce-sec-h"><Icon name="user" size={14}/> Customer &amp; vehicle</div>
            <div className="jce-dgrid">
              {[['Customer', d.customer_name], ['Phone', d.phone_number], ['WhatsApp', d.whatsapp_number], ['Email', d.email], ['Address', d.address], ['Engine No', d.engine_number], ['Chassis No', d.chassis_number], ['Retention', d.retention && d.retention.days_left != null ? `${d.retention.days_left} day(s) left` : '—']].map(([l, v]) => (
                <div className="jce-d" key={l}><span className="l">{l}</span><span className="v">{(v === 0 || v) ? v : '—'}</span></div>
              ))}
            </div>
            <div className="jce-d full"><span className="l">Complaint</span><span className="v">{d.complaint_description || '—'}</span></div>
            <div className="jce-sec-h"><Icon name="check" size={14}/> Link status</div>
            {lk && lk.is_linked
              ? <div className="jce-banner ok"><Icon name="check" size={14}/> Linked to job card {lk.job_card_id || lk.job_id}{lk.linked_by_admin_name ? ` · by ${lk.linked_by_admin_name}` : ''}{lk.linked_at ? ` · ${jceFmtDT(lk.linked_at)}` : ''}</div>
              : (linkJobCardId
                ? <div className="jce-linkrow"><span>Not linked yet.</span><button className="btn btn-amber btn-sm" disabled={busy === 'link'} onClick={doLink}><Icon name="check" size={13}/> {busy === 'link' ? 'Linking…' : 'Link this intake to this job card'}</button></div>
                : <div className="jce-empty sm">Not linked to a job card</div>)}
            {(() => { const ws = intakeWarnings(d); return ws.length > 0 && (
              <><div className="jce-sec-h"><Icon name="alert" size={14}/> Warnings <span className="n">{ws.length}</span></div>
              <div className="iae-warns">{ws.map((w, i) => <span key={i} className={`iae-warn ${IAE_TONE[w.tone]}`}><Icon name="alert" size={11}/> {w.text}</span>)}</div></>
            ); })()}
            <div className="jce-sec-h"><Icon name="image" size={14}/> Bike images <span className="n">{(d.images || []).length}</span></div>
            <div className="jce-thumbs">{(d.images || []).length === 0 ? <div className="jce-empty sm">No images</div> : d.images.map(m => <Media key={m.id} m={m}/>)}</div>
            <div className="jce-sec-h"><Icon name="mic" size={14}/> Voice recordings <span className="n">{(d.voices || []).length}</span></div>
            <div className="jce-voices">{(d.voices || []).length === 0 ? <div className="jce-empty sm">No voice notes</div> : d.voices.map(m => <Media key={m.id} m={m} audio/>)}</div>
            {(d.events || []).length > 0 && (
              <><div className="jce-sec-h"><Icon name="history" size={14}/> Timeline</div>
              <div className="jce-timeline">{d.events.map((ev, i) => (
                <div className="jce-ev" key={i}><span className="d mono">{jceFmtDT(ev.created_at)}</span><span className="t">{(ev.event_type || '').replace(/_/g, ' ')}{ev.actor_name ? ` · ${ev.actor_name}` : ''}</span></div>
              ))}</div></>
            )}
          </>}
        </div>
        <div className="modal-foot jce-foot">
          {d && <IntakePdfButton role={role === 'master' ? 'master' : 'admin'} id={d.id}/>}
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
};
window.IntakeEvidenceDrawer = IntakeEvidenceDrawer;

const IntakeEntryCard = ({ e, onOpen }) => (
  <button className="jce-hcard" onClick={() => onOpen(e.id)}>
    <div className="jce-hc-top">
      <span className="jce-hc-bike mono"><Icon name="bike" size={14}/> {e.bike_number || '—'}</span>
      <span className={`chip ${JCE_STATUS_TONE[e.status] || 'ghost'}`}>{(e.status || '').toUpperCase()}</span>
    </div>
    <div className="jce-hc-cust">{e.customer_name || 'Customer —'} · <span className="mono">{e.phone_number || '—'}</span></div>
    {e.complaint_short && <div className="jce-hc-comp">{e.complaint_short}</div>}
    <div className="jce-hc-meta">
      <span><Icon name="image" size={12}/> {e.image_count}</span>
      <span><Icon name="mic" size={12}/> {e.voice_count}</span>
      {e.linked && <span className="ok"><Icon name="check" size={12}/> Linked</span>}
      <span className="mono jce-hc-no">{e.intake_no}</span>
    </div>
    <div className="jce-hc-dates mono"><span>Submitted {jceFmtDT(e.submitted_at)}</span></div>
  </button>
);

// ── Admin Intake Evidence Dashboard building blocks ──
const IntakeStat = ({ label, value, tone, icon, sub, onClick }) => (
  <div className={`iae-stat ${tone || ''}${onClick ? ' click' : ''}`} onClick={onClick}>
    <span className="iae-stat-ic"><Icon name={icon || 'clipboard'} size={16}/></span>
    <div className="iae-stat-b"><div className="v">{value}</div><div className="l">{label}</div>{sub ? <div className="s">{sub}</div> : null}</div>
  </div>
);

const IntakeSummaryCards = ({ s, onPick }) => {
  if (!s) return <div className="iae-stats">{Array.from({ length: 8 }).map((_, i) => <div key={i} className="iae-stat skel"/>)}</div>;
  const cards = [
    ['Today', s.today, s.today > 0 ? 'blue' : '', 'clock', null],
    ['This week', s.this_week, '', 'history', null],
    ['Pending job link', s.pending_link, s.pending_link > 0 ? 'amber' : 'ok', 'check', 'false'],
    ['With photos', s.with_photos, 'ok', 'image', null],
    ['With voice', s.with_voice, 'ok', 'mic', null],
    ['Incomplete', s.incomplete, s.incomplete > 0 ? 'bad' : 'ok', 'alert', null],
    ['Expiring soon', s.expiring_soon, s.expiring_soon > 0 ? 'amber' : '', 'clock', null],
    ['Total history', s.total, '', 'clipboard', null],
  ];
  return <div className="iae-stats">{cards.map(([l, v, t, ic, lk]) => <IntakeStat key={l} label={l} value={v || 0} tone={t} icon={ic} onClick={lk && onPick ? () => onPick(lk) : null}/>)}</div>;
};

const IntakeHistoryTable = ({ rows, role, onOpen, onCopy }) => (
  <div className="iae-table-wrap">
    <table className="iae-table">
      <thead><tr>
        <th>Date</th><th>Bike</th><th>Customer</th><th>Phone</th><th>Worker</th>
        <th className="c">Photos</th><th className="c">Voice</th><th className="c">Linked</th><th>Evidence</th><th>Expiry</th><th></th>
      </tr></thead>
      <tbody>
        {rows.map(e => {
          const es = intakeEvidenceStatus(e);
          const dl = e.expires_at ? Math.floor((new Date(e.expires_at) - Date.now()) / 86400000) : null;
          return (
            <tr key={e.id} onClick={() => onOpen(e.id)}>
              <td className="mono">{jceFmtDT(e.submitted_at || e.created_at)}</td>
              <td className="mono b">{e.bike_number || '—'}</td>
              <td>{e.customer_name || '—'}</td>
              <td className="mono">{e.phone_number || '—'}</td>
              <td>{e.worker_name || '—'}</td>
              <td className="c">{e.image_count || 0}</td>
              <td className="c">{e.voice_count > 0 ? 'Yes' : '—'}</td>
              <td className="c">{e.linked ? <span className="chip ok">Yes</span> : <span className="chip amber">No</span>}</td>
              <td><span className={`chip ${IAE_TONE[es.tone]}`}>{es.label}</span></td>
              <td className="mono">{dl == null ? '—' : (dl < 0 ? 'expired' : dl + 'd')}</td>
              <td className="iae-actions" onClick={ev => ev.stopPropagation()}>
                <button className="btn-xs" title="View evidence" onClick={() => onOpen(e.id)}><Icon name="scan" size={12}/></button>
                <IntakeRowPdf role={role} id={e.id}/>
                <button className="btn-xs" title="Copy bike number" onClick={() => onCopy(e.bike_number)}><Icon name="clipboard" size={12}/></button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  </div>
);

const IntakeRowPdf = ({ role, id }) => {
  const [busy, setBusy] = useJS(false);
  const go = async () => { setBusy(true); try { await BW_API.intakeEvidencePdf(role === 'master' ? 'master' : 'admin', id); } catch (e) { /* surfaced by the drawer button */ } finally { setBusy(false); } };
  return <button className="btn-xs" title="Evidence PDF" disabled={busy} onClick={go}><Icon name="file" size={12}/></button>;
};

// Compact landing widget — window global so admin.jsx can mount it above the bay dashboard
const IntakeTodayWidget = ({ onViewAll }) => {
  const [s, setS] = useJS(null);
  useJE(() => { let on = true; BW_API.adminIntakeSummary().then(d => on && setS(d)).catch(() => on && setS({})); return () => { on = false; }; }, []);
  const latest = (s && s.latest || []).slice(0, 3);
  return (
    <div className="iae-widget">
      <span className="iae-widget-t"><Icon name="clipboard" size={14}/> Intake Evidence Today</span>
      <div className="iae-widget-m"><span className="v">{(s && s.today) || 0}</span><span className="l">today</span></div>
      <div className="iae-widget-m"><span className={`v ${(s && s.pending_link) > 0 ? 'amber' : ''}`}>{(s && s.pending_link) || 0}</span><span className="l">pending link</span></div>
      <div className="iae-widget-bikes">
        {latest.length ? latest.map(e => <span key={e.id} className="mono iae-wbike" title={e.customer_name || ''}>{e.bike_number || '—'}</span>) : <span className="iae-wempty">No intake evidence yet</span>}
      </div>
      <button className="btn btn-ghost btn-sm iae-widget-all" onClick={onViewAll}>View all <Icon name="arrow-right" size={12}/></button>
    </div>
  );
};
window.IntakeTodayWidget = IntakeTodayWidget;

// ── Admin · worker-wise intake evidence (own branch) ──
const LiveAdminIntake = () => {
  const [err, setErr] = useJS('');
  const [view, setView] = useJS('overview');   // overview | history
  const [f, setF] = useJS({ q: '', status: '', linked: '', has_photos: '', has_voice: '', date_from: '', date_to: '' });
  const [openId, setOpenId] = useJS(null);
  const [summary, setSummary] = useJS(null);
  const [rows, setRows] = useJS(null);
  const [copied, setCopied] = useJS('');
  const loadSummary = useJC(() => BW_API.adminIntakeSummary().then(setSummary).catch(() => setSummary(null)), []);
  // Realtime worker-wise intake snapshot over WebSocket (branch scoped from the JWT) + polling
  // fallback (Overview groups). History uses the flat list API with server-side filters.
  const snap = useBWSnapshot('/intake', () => BW_API.adminIntakeGrouped({})
    .then(g => (Array.isArray(g) ? g : [])).catch(e => { setErr(e.message || 'Failed to load'); return null; }), [], 6000);
  const groups = snap.data;
  const loadRows = useJC(() => {
    const filters = {};
    if (f.status) filters.status = f.status;
    if (f.linked) filters.linked = f.linked;
    if (f.date_from) filters.date_from = f.date_from;
    if (f.date_to) filters.date_to = f.date_to;
    BW_API.adminIntakeList(filters).then(r => setRows(Array.isArray(r) ? r : []))
      .catch(e => { setRows([]); setErr(e.message || 'Failed to load'); });
  }, [f.status, f.linked, f.date_from, f.date_to]);
  useJE(() => { loadSummary(); }, [loadSummary]);
  useJE(() => { if (groups) loadSummary(); }, [groups]);
  useJE(() => { if (view === 'history') loadRows(); }, [view, loadRows]);
  const reload = () => { snap.reload(); loadSummary(); if (view === 'history') loadRows(); };
  const resetFilters = () => setF({ q: '', status: '', linked: '', has_photos: '', has_voice: '', date_from: '', date_to: '' });
  const copyBike = (b) => { if (!b) return; try { navigator.clipboard.writeText(b); } catch (e) {} setCopied(b); setTimeout(() => setCopied(''), 1500); };
  const matchQ = (e, wn) => { if (!f.q) return true; const s = f.q.toLowerCase(); return [e.bike_number, e.bike_number_normalized, e.customer_name, e.phone_number, e.intake_no, wn].some(v => (v || '').toLowerCase().includes(s)); };
  const gview = (groups || []).map(g => ({
    ...g,
    entries: (g.entries || []).filter(e => {
      if (f.status && e.status !== f.status) return false;
      if (f.linked === 'true' && !e.linked) return false;
      if (f.linked === 'false' && e.linked) return false;
      if (f.has_photos === 'true' && !(e.image_count > 0)) return false;
      if (f.has_voice === 'true' && !(e.voice_count > 0)) return false;
      return matchQ(e, g.worker_name);
    }),
  })).filter(g => g.entries.length);
  const total = gview.reduce((a, g) => a + g.entries.length, 0);
  const histRows = (rows || []).filter(e => {
    if (f.has_photos === 'true' && !(e.image_count > 0)) return false;
    if (f.has_photos === 'false' && (e.image_count > 0)) return false;
    if (f.has_voice === 'true' && !(e.voice_count > 0)) return false;
    if (f.has_voice === 'false' && (e.voice_count > 0)) return false;
    return matchQ(e, e.worker_name);
  });
  const exportCsv = () => {
    const head = ['Date', 'Intake No', 'Bike', 'Normalized', 'Customer', 'Phone', 'Worker', 'Photos', 'Voice', 'Linked', 'Status', 'Expires'];
    const esc = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const lines = [head.join(',')].concat(histRows.map(e => [e.submitted_at || e.created_at, e.intake_no, e.bike_number, e.bike_number_normalized, e.customer_name, e.phone_number, e.worker_name, e.image_count, e.voice_count, e.linked ? 'yes' : 'no', e.status, e.expires_at].map(esc).join(',')));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `intake_evidence_${new Date().toISOString().slice(0, 10)}.csv`; a.click();
  };
  const latest = (summary && summary.latest) || [];
  return (
    <>
      <div className="content-head"><div><div className="eyebrow eyebrow-amber">● INTAKE EVIDENCE</div><h1>Intake evidence dashboard</h1><span className="sub">Branch · evidence summary, latest &amp; searchable history</span></div></div>
      {err && <div className="jce-banner danger">{err}</div>}
      <IntakeSummaryCards s={summary} onPick={(lk) => { setView('history'); setF(s => ({ ...s, linked: lk })); }}/>
      <div className="bai-subtabs">
        {[['overview', 'Overview', 'gauge'], ['history', 'History', 'history']].map(([k, l, ic]) => (
          <button key={k} className={`bai-subtab ${view === k ? 'active' : ''}`} onClick={() => setView(k)}><Icon name={ic} size={14}/> {l}</button>
        ))}
      </div>

      {view === 'overview' && (
        <>
          <div className="card">
            <div className="jce-sec-h"><Icon name="clipboard" size={14}/> Latest evidence</div>
            {summary === null && <div className="jce-empty">Loading…</div>}
            {summary && latest.length === 0 && <div className="wc-empty"><Icon name="clipboard" size={24}/><div className="t">No intake evidence yet</div><div className="s">Worker captures appear here.</div></div>}
            <div className="jce-cards iae-latest">{latest.map(e => <IntakeEntryCard key={e.id} e={e} onOpen={setOpenId}/>)}</div>
          </div>
          <div className="card">
            <div className="jce-filters">
              <input className="input" placeholder="Search bike / customer / phone / worker…" value={f.q} onChange={e => setF(s => ({ ...s, q: e.target.value }))}/>
              <select className="input" value={f.status} onChange={e => setF(s => ({ ...s, status: e.target.value }))}><option value="">All statuses</option>{['submitted', 'linked', 'archived', 'revoked'].map(s => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}</select>
              <select className="input" value={f.linked} onChange={e => setF(s => ({ ...s, linked: e.target.value }))}><option value="">Linked &amp; unlinked</option><option value="true">Linked</option><option value="false">Unlinked</option></select>
              <button className="btn btn-ghost btn-sm" onClick={reload}><Icon name="history" size={13}/> Refresh</button>
            </div>
            {groups === null && <div className="jce-empty">Loading…</div>}
            {groups && gview.length === 0 && <div className="wc-empty"><Icon name="clipboard" size={24}/><div className="t">No intake evidence</div></div>}
            {gview.map(g => (
              <div key={g.worker_id || 'none'} className="jce-wgrp">
                <div className="jce-wgrp-head">
                  <div className="jce-wgrp-av">{(g.worker_name || '?').split(' ').map(x => x[0]).join('').slice(0, 2).toUpperCase()}</div>
                  <div className="jce-wgrp-id"><div className="nm">{g.worker_name || '—'}</div><div className="sub mono">{g.worker_id || ''}</div></div>
                  <div className="jce-wgrp-stats"><span>{g.entries.length} entr{g.entries.length === 1 ? 'y' : 'ies'}</span>{g.latest_submitted_at && <span className="mono">latest {jceFmtDT(g.latest_submitted_at)}</span>}</div>
                </div>
                <div className="jce-cards">{g.entries.map(e => <IntakeEntryCard key={e.id} e={e} onOpen={setOpenId}/>)}</div>
              </div>
            ))}
          </div>
        </>
      )}

      {view === 'history' && (
        <div className="card">
          <div className="jce-filters iae-filters">
            <input className="input" placeholder="Search bike / customer / phone / worker…" value={f.q} onChange={e => setF(s => ({ ...s, q: e.target.value }))}/>
            <select className="input" value={f.status} onChange={e => setF(s => ({ ...s, status: e.target.value }))}><option value="">All statuses</option>{['submitted', 'linked', 'archived', 'revoked'].map(s => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}</select>
            <select className="input" value={f.linked} onChange={e => setF(s => ({ ...s, linked: e.target.value }))}><option value="">Linked &amp; unlinked</option><option value="true">Linked</option><option value="false">Unlinked</option></select>
            <select className="input" value={f.has_photos} onChange={e => setF(s => ({ ...s, has_photos: e.target.value }))}><option value="">Photos: any</option><option value="true">Has photos</option><option value="false">No photos</option></select>
            <select className="input" value={f.has_voice} onChange={e => setF(s => ({ ...s, has_voice: e.target.value }))}><option value="">Voice: any</option><option value="true">Has voice</option><option value="false">No voice</option></select>
            <label className="iae-date">From<input className="input" type="date" value={f.date_from} onChange={e => setF(s => ({ ...s, date_from: e.target.value }))}/></label>
            <label className="iae-date">To<input className="input" type="date" value={f.date_to} onChange={e => setF(s => ({ ...s, date_to: e.target.value }))}/></label>
            <button className="btn btn-ghost btn-sm" onClick={resetFilters}><Icon name="x" size={13}/> Reset</button>
            <button className="btn btn-ghost btn-sm" onClick={reload}><Icon name="history" size={13}/> Refresh</button>
            <button className="btn btn-ghost btn-sm" onClick={exportCsv} disabled={!histRows.length}><Icon name="file" size={13}/> Export CSV</button>
          </div>
          {copied && <div className="iae-copied">Copied {copied}</div>}
          {rows === null && <div className="jce-empty">Loading…</div>}
          {rows && histRows.length === 0 && <div className="wc-empty"><Icon name="clipboard" size={24}/><div className="t">No matching evidence</div></div>}
          {histRows.length > 0 && <><div className="iae-count">{histRows.length} entr{histRows.length === 1 ? 'y' : 'ies'}</div><IntakeHistoryTable rows={histRows} role="admin" onOpen={setOpenId} onCopy={copyBike}/></>}
        </div>
      )}

      {openId && <IntakeEvidenceDrawer id={openId} role="admin" onClose={() => setOpenId(null)} onChanged={reload}/>}
    </>
  );
};
window.LiveAdminIntake = LiveAdminIntake;

// ── Master · branch → worker → bike intake evidence (global) ──
const LiveMasterIntake = () => {
  const [branches, setBranches] = useJS(null);
  const [err, setErr] = useJS('');
  const [f, setF] = useJS({ q: '', status: '' });
  const [openBranch, setOpenBranch] = useJS(null);
  const [openWorker, setOpenWorker] = useJS({});
  const [openId, setOpenId] = useJS(null);
  const [summary, setSummary] = useJS(null);
  const load = useJC(() => {
    setErr('');
    const filters = {};
    if (f.status) filters.status = f.status;
    BW_API.masterIntakeGrouped(filters).then(b => setBranches(Array.isArray(b) ? b : []))
      .catch(e => { setBranches([]); setErr(e.message || 'Failed to load'); });
    BW_API.masterIntakeSummary().then(setSummary).catch(() => setSummary(null));
  }, [f.status]);
  useJE(() => { load(); }, [load]);
  const matchEntry = (e, wn) => { if (!f.q) return true; const s = f.q.toLowerCase(); return [e.bike_number, e.bike_number_normalized, e.customer_name, e.intake_no, wn].some(v => (v || '').toLowerCase().includes(s)); };
  return (
    <>
      <div className="content-head"><div><div className="eyebrow eyebrow-amber">● INTAKE EVIDENCE</div><h1>Vehicle intake evidence monitoring</h1><span className="sub">Global · branch → worker → bike</span></div></div>
      <IntakeSummaryCards s={summary}/>
      <div className="card">
        <div className="jce-filters">
          <input className="input" placeholder="Search bike / customer / worker…" value={f.q} onChange={e => setF(s => ({ ...s, q: e.target.value }))}/>
          <select className="input" value={f.status} onChange={e => setF(s => ({ ...s, status: e.target.value }))}>
            <option value="">All statuses</option>{['submitted', 'linked', 'archived', 'revoked'].map(s => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
          </select>
        </div>
        {err && <div className="jce-banner danger">{err}</div>}
        {branches === null && <div className="jce-empty">Loading…</div>}
        {branches && branches.length === 0 && <div className="wc-empty"><Icon name="pin" size={24}/><div className="t">No intake evidence</div></div>}
        <div className="jce-branches">
          {(branches || []).map(b => {
            const t = b.totals || {};
            const open = openBranch === (b.branch_id || 'none');
            return (
              <div key={b.branch_id || 'none'} className="jce-branch">
                <div className="jce-branch-head" onClick={() => setOpenBranch(open ? null : (b.branch_id || 'none'))}>
                  <span className="jce-branch-chev"><Icon name={open ? 'chevron-down' : 'chevron-right'} size={15}/></span>
                  <div className="jce-branch-id"><Icon name="pin" size={14}/> <span className="nm">{b.branch_name || b.branch_id || '—'}</span></div>
                  <div className="jce-branch-tot">
                    <span><b>{t.entries || 0}</b> entries</span>
                    <span><b>{t.submitted_today || 0}</b> today</span>
                    <span className="ok"><b>{t.linked || 0}</b> linked</span>
                    <span><b>{t.unlinked || 0}</b> unlinked</span>
                    <span><Icon name="image" size={11}/> {t.images || 0}</span>
                    <span><Icon name="mic" size={11}/> {t.voices || 0}</span>
                  </div>
                </div>
                {open && (b.workers || []).map(w => {
                  const wo = openWorker[w.worker_id] !== false; // default expanded
                  const entries = (w.entries || []).filter(e => matchEntry(e, w.worker_name));
                  if (!entries.length) return null;
                  return (
                    <div key={w.worker_id || 'none'} className="jce-mwrk">
                      <div className="jce-mwrk-head" onClick={() => setOpenWorker(s => ({ ...s, [w.worker_id]: wo ? false : true }))}>
                        <span className="jce-branch-chev"><Icon name={wo ? 'chevron-down' : 'chevron-right'} size={13}/></span>
                        <div className="jce-wgrp-av sm">{(w.worker_name || '?').split(' ').map(x => x[0]).join('').slice(0, 2).toUpperCase()}</div>
                        <span className="nm">{w.worker_name || '—'}</span>
                        <span className="sub mono">{entries.length} entr{entries.length === 1 ? 'y' : 'ies'}{w.latest_submitted_at ? ` · latest ${jceFmtDT(w.latest_submitted_at)}` : ''}</span>
                      </div>
                      {wo && <div className="jce-cards">{entries.map(e => <IntakeEntryCard key={e.id} e={e} onOpen={setOpenId}/>)}</div>}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      {openId && <IntakeEvidenceDrawer id={openId} role="master" onClose={() => setOpenId(null)} onChanged={load}/>}
    </>
  );
};
window.LiveMasterIntake = LiveMasterIntake;

// ════════════════════════════════════════════════════════════════
//  Worker Bay-to-Bay Time Analysis + 9-hour utilization (analytics only,
//  DERIVED from ServiceSession — never modifies the bay lifecycle).
// ════════════════════════════════════════════════════════════════
const WTA_CATS = [
  ['waiting_for_next_job_assignment', 'Waiting for next job assignment'], ['worker_delay', 'Worker delay'],
  ['bay_cleaning', 'Bay cleaning'], ['vehicle_movement', 'Vehicle movement'], ['parts_waiting', 'Parts waiting'],
  ['customer_approval_waiting', 'Customer approval waiting'], ['tool_or_equipment_delay', 'Tool / equipment delay'],
  ['test_drive_or_quality_check', 'Test drive / quality check'], ['supervisor_delay', 'Supervisor delay'],
  ['break_or_lunch', 'Break / lunch'], ['absent_or_unavailable', 'Absent / unavailable'],
  ['system_timer_issue', 'System / timer issue'], ['other', 'Other'],
];
const WTA_RESP = ['worker', 'admin', 'customer', 'parts', 'system', 'unavoidable'];
const WTA_CAT_LABEL = Object.fromEntries(WTA_CATS);
const wtaTone = (s) => ({ good: 'ok', warning: 'amber', late: 'bad', critical: 'critical' }[s] || 'ghost');
const wtaRatingTone = (r) => ({ excellent: 'ok', good: 'ok', needs_attention: 'amber', critical: 'critical', no_data: 'ghost' }[r] || 'ghost');
const wtaRatingLabel = (r) => ({ excellent: 'Excellent', good: 'Good', needs_attention: 'Needs attention', critical: 'Critical', no_data: 'No data' }[r] || (r || '—'));
const wtaHM = (m) => { if (m == null) return '—'; m = Math.round(m); const h = Math.floor(m / 60), mm = m % 60; return h ? `${h}h ${mm}m` : `${mm}m`; };
const wtaClock = (iso) => { if (!iso) return '—'; try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch (e) { return '—'; } };
const wtaInit = (n) => (n || '?').split(' ').map(x => x[0]).join('').slice(0, 2).toUpperCase();

const WtaStackedBar = ({ w }) => {
  const segs = [
    ['working', w.productive_minutes, 'Working'], ['transition', w.transition_idle_minutes, 'Transition idle'],
    ['pause', w.pause_minutes, 'Pause'], ['idle', w.unassigned_idle_minutes, 'Unassigned idle'],
    ['overtime', w.overtime_minutes, 'Overtime'],
  ].filter(([, v]) => (v || 0) > 0);
  const total = Math.max(w.shift_minutes || 540, segs.reduce((a, [, v]) => a + v, 0)) || 540;
  return (
    <div className="wta-bar-wrap">
      <div className="wta-bar">{segs.map(([k, v, l]) => <div key={k} className={`wta-seg ${k}`} style={{ width: (v / total * 100) + '%' }} title={`${l} ${wtaHM(v)}`}>{(v / total) > 0.09 ? wtaHM(v) : ''}</div>)}
        {segs.length === 0 && <div className="wta-seg empty" style={{ width: '100%' }}>No activity</div>}</div>
      <div className="wta-bar-legend">{segs.map(([k, v, l]) => <span key={k} className="wta-lg"><i className={`wta-dot ${k}`}/>{l} {wtaHM(v)}</span>)}<span className="wta-util">Utilization {w.utilization_percent || 0}%</span></div>
    </div>
  );
};

const WtaTimeline = ({ w, onGap }) => (
  <div className="wta-timeline">
    {(w.timeline || []).length === 0 && <div className="jce-empty sm">No completed jobs for this date.</div>}
    {(w.timeline || []).map((b, i) => {
      if (b.type === 'job_work') return (
        <div key={i} className="wta-tl job"><span className="wta-tl-time mono">{wtaClock(b.start_at)}{b.end_at ? `–${wtaClock(b.end_at)}` : ''}</span>
          <span className="wta-tl-main"><Icon name="check" size={12}/> Bay {b.bay_number ?? '—'} · {b.job_no || 'job'}{b.service_type ? ` · ${b.service_type}` : ''}{b.status && b.status !== 'completed' ? <span className="chip amber">{b.status.toUpperCase()}</span> : null}</span>
          <span className="wta-tl-min mono">{b.status === 'completed' ? wtaHM(b.minutes) : ''}{b.paused_minutes > 0 ? ` · paused ${wtaHM(b.paused_minutes)}` : ''}</span></div>);
      if (b.type === 'transition_gap') return (
        <div key={i} className={`wta-tl gap ${b.color_status}`} onClick={() => onGap && onGap(b)}><span className="wta-tl-time mono">{wtaClock(b.start_at)}–{wtaClock(b.end_at)}</span>
          <span className="wta-tl-main"><Icon name="history" size={12}/> Gap Bay {b.from_bay ?? '—'} → Bay {b.to_bay ?? '—'} <span className={`chip ${wtaTone(b.color_status)}`}>{(b.color_status || '').toUpperCase()}</span>{b.reason_required && !b.reason_given ? <span className="wta-reqbadge"><Icon name="alert" size={11}/> Reason required</span> : null}{b.reason_given ? <span className="wta-reason">· {WTA_CAT_LABEL[b.reason_category] || b.reason_category}</span> : null}</span>
          <span className="wta-tl-min mono">{wtaHM(b.minutes)}</span></div>);
      if (b.type === 'unassigned_idle') return (
        <div key={i} className="wta-tl idle"><span className="wta-tl-time"/><span className="wta-tl-main"><Icon name="clock" size={12}/> Unassigned idle <em>(assumed 540-min shift — no attendance clock)</em></span><span className="wta-tl-min mono">{wtaHM(b.minutes)}</span></div>);
      if (b.type === 'overtime') return (
        <div key={i} className="wta-tl ot"><span className="wta-tl-time"/><span className="wta-tl-main"><Icon name="alert" size={12}/> Overtime beyond 540-min shift</span><span className="wta-tl-min mono">{wtaHM(b.minutes)}</span></div>);
      return null;
    })}
  </div>
);

const WtaTransitionTable = ({ rows, onReason, onTimeline }) => (
  <div className="iae-table-wrap">
    <table className="iae-table wta-table">
      <thead><tr><th>Worker</th><th>Bay</th><th>Prev job</th><th>Next job</th><th>Completed</th><th>Assigned</th><th>Started</th><th className="c">Assign</th><th className="c">Start</th><th className="c">Gap</th><th>Status</th><th>Reason</th><th></th></tr></thead>
      <tbody>{rows.map(t => (
        <tr key={t.transition_id}>
          <td>{t.worker_name || '—'}</td>
          <td className="mono b">{t.prev_bay_number ?? '—'} → {t.next_bay_number ?? '—'}</td>
          <td className="mono">{t.prev_job_no || '—'}</td>
          <td className="mono">{t.next_job_no || '—'}</td>
          <td className="mono">{wtaClock(t.prev_completed_at)}</td>
          <td className="mono">{t.assignment_known ? wtaClock(t.next_assigned_at) : '—'}</td>
          <td className="mono">{wtaClock(t.next_started_at)}</td>
          <td className="c mono">{t.assignment_delay_minutes == null ? '—' : t.assignment_delay_minutes + 'm'}</td>
          <td className="c mono">{t.start_delay_minutes == null ? '—' : t.start_delay_minutes + 'm'}</td>
          <td className="c mono b">{t.transition_gap_minutes == null ? '—' : t.transition_gap_minutes + 'm'}</td>
          <td><span className={`chip ${wtaTone(t.threshold_status)}`}>{(t.threshold_status || '').toUpperCase()}</span></td>
          <td>{t.reason_given ? <span className="wta-rsn" title={t.reason_note || ''}>{WTA_CAT_LABEL[t.reason_category] || t.reason_category}{t.marked_by_role === 'master' ? ' ·M' : ''}</span> : (t.reason_required ? <span className="wta-reqbadge sm">Required</span> : <span className="wta-muted">—</span>)}</td>
          <td className="iae-actions">
            <button className="btn-xs" title={t.reason_given ? 'Edit reason' : 'Add reason'} onClick={() => onReason(t)}><Icon name={t.reason_given ? 'file' : 'plus'} size={12}/></button>
            {onTimeline && <button className="btn-xs" title="View timeline" onClick={() => onTimeline(t.worker_id)}><Icon name="gauge" size={12}/></button>}
          </td>
        </tr>
      ))}</tbody>
    </table>
  </div>
);

const WtaReasonDrawer = ({ t, role, onClose, onSaved }) => {
  const [cat, setCat] = useJS(t.reason_category || '');
  const [resp, setResp] = useJS(t.responsible_type || '');
  const [note, setNote] = useJS(t.reason_note || '');
  const [busy, setBusy] = useJS(false);
  const [err, setErr] = useJS('');
  const save = async () => {
    if (!cat) { setErr('Choose a reason category'); return; }
    setBusy(true); setErr('');
    try {
      const fn = role === 'master' ? BW_API.masterWorkerTransitionSaveReason : BW_API.adminWorkerTransitionSaveReason;
      await fn(t.transition_id, { reason_category: cat, responsible_type: resp || undefined, reason_note: note || undefined });
      onSaved && onSaved(); onClose();
    } catch (e) { setErr(e.message || 'Save failed'); } finally { setBusy(false); }
  };
  return (
    <div className="modal-scrim" onClick={onClose} style={{ zIndex: 362 }}>
      <div className="modal wta-reason" onClick={e => e.stopPropagation()}>
        <div className="modal-head"><div><div className="eyebrow eyebrow-amber">● TRANSITION DELAY REASON</div><h3 style={{ margin: '4px 0 0' }}>Bay {t.prev_bay_number ?? '—'} → Bay {t.next_bay_number ?? '—'}</h3></div><button className="modal-close" onClick={onClose}><Icon name="x" size={16}/></button></div>
        <div className="modal-scroll">
          <div className="wta-rsn-facts">
            <div className="wta-fact"><span className="l">Worker</span><span className="v">{t.worker_name || '—'}</span></div>
            <div className="wta-fact"><span className="l">Transition gap</span><span className="v"><span className={`chip ${wtaTone(t.threshold_status)}`}>{t.transition_gap_minutes}m · {(t.threshold_status || '').toUpperCase()}</span></span></div>
            <div className="wta-fact"><span className="l">Assignment delay</span><span className="v">{t.assignment_delay_minutes == null ? '—' : t.assignment_delay_minutes + 'm'}</span></div>
            <div className="wta-fact"><span className="l">Start delay</span><span className="v">{t.start_delay_minutes == null ? '—' : t.start_delay_minutes + 'm'}</span></div>
            <div className="wta-fact"><span className="l">Prev job</span><span className="v mono">{t.prev_job_no || '—'} · done {wtaClock(t.prev_completed_at)}</span></div>
            <div className="wta-fact"><span className="l">Next job</span><span className="v mono">{t.next_job_no || '—'} · started {wtaClock(t.next_started_at)}</span></div>
          </div>
          <div className="wta-rsn-hint">This is analysis, not blame — capture what caused the delay so patterns are visible.</div>
          <label className="wta-field">Reason category<select className="input" value={cat} onChange={e => setCat(e.target.value)}><option value="">Select…</option>{WTA_CATS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label className="wta-field">Responsible<select className="input" value={resp} onChange={e => setResp(e.target.value)}><option value="">—</option>{WTA_RESP.map(r => <option key={r} value={r}>{r[0].toUpperCase() + r.slice(1)}</option>)}</select></label>
          <label className="wta-field">Detailed note<textarea className="input" rows="3" value={note} placeholder="What caused this transition delay?" onChange={e => setNote(e.target.value)}/></label>
          {err && <div className="bai-msg err">{err}</div>}
        </div>
        <div className="modal-foot"><button className="btn btn-amber" disabled={busy} onClick={save}><Icon name="check" size={14}/> {busy ? 'Saving…' : 'Save reason'}</button><button className="btn btn-ghost" onClick={onClose}>Cancel</button></div>
      </div>
    </div>
  );
};

const WtaWorkerDrawer = ({ worker, role, onClose, onReason }) => (
  <div className="modal-scrim" onClick={onClose} style={{ zIndex: 356 }}>
    <div className="modal modal-lg" onClick={e => e.stopPropagation()}>
      <div className="modal-head"><div><div className="eyebrow eyebrow-amber">● WORKER UTILIZATION</div><h3 style={{ margin: '4px 0 0' }}>{worker.worker_name || '—'} · {worker.date}</h3></div><button className="modal-close" onClick={onClose}><Icon name="x" size={16}/></button></div>
      <div className="modal-scroll">
        <div className="wta-dstats">
          {[['Utilization', (worker.utilization_percent || 0) + '%'], ['Productive', wtaHM(worker.productive_minutes)], ['Pause', wtaHM(worker.pause_minutes)], ['Transition idle', wtaHM(worker.transition_idle_minutes)], ['Unassigned idle', wtaHM(worker.unassigned_idle_minutes)], ['Overtime', wtaHM(worker.overtime_minutes)], ['Completed jobs', worker.completed_jobs_count || 0], ['Est vs actual', `${wtaHM(worker.estimated_total_minutes)} → ${wtaHM(worker.actual_total_minutes)} (${worker.estimate_variance_minutes >= 0 ? '+' : ''}${worker.estimate_variance_minutes}m)`]].map(([l, v]) => (
            <div className="wta-dstat" key={l}><span className="l">{l}</span><span className="v">{v}</span></div>
          ))}
        </div>
        <div className="jce-sec-h"><Icon name="gauge" size={14}/> 9-hour shift utilization <span className="wta-basis">{worker.shift_basis}</span></div>
        <WtaStackedBar w={worker}/>
        <div className="jce-sec-h"><Icon name="history" size={14}/> Timeline</div>
        <WtaTimeline w={worker} onGap={(b) => { const t = (worker.transitions || []).find(x => x.transition_id === b.transition_id); if (t) onReason(t); }}/>
        <div className="jce-sec-h"><Icon name="route" size={14}/> Bay-to-bay transitions</div>
        {(worker.transitions || []).length ? <WtaTransitionTable rows={worker.transitions} role={role} onReason={onReason}/> : <div className="jce-empty sm">Bay-to-bay transition analysis requires at least two jobs.</div>}
      </div>
      <div className="modal-foot"><button className="btn btn-ghost" onClick={onClose}>Close</button></div>
    </div>
  </div>
);

const WtaSummaryCards = ({ s }) => {
  if (!s) return <div className="iae-stats">{Array.from({ length: 8 }).map((_, i) => <div key={i} className="iae-stat skel"/>)}</div>;
  const u = s.average_utilization || 0;
  return (
    <div className="iae-stats">
      <IntakeStat label="Total workers" value={s.total_workers || 0} icon="user"/>
      <IntakeStat label="Avg utilization" value={u + '%'} tone={u >= 70 ? 'ok' : u >= 50 ? 'amber' : (s.total_workers ? 'bad' : '')} icon="gauge"/>
      <IntakeStat label="Productive" value={wtaHM(s.productive_minutes)} tone="ok" icon="check"/>
      <IntakeStat label="Idle / transition" value={wtaHM(s.idle_minutes)} tone={(s.idle_minutes || 0) > 0 ? 'amber' : ''} icon="clock"/>
      <IntakeStat label="Late transitions" value={s.total_late_transitions || 0} tone={(s.total_late_transitions || 0) > 0 ? 'amber' : ''} icon="alert"/>
      <IntakeStat label="Critical delays" value={s.total_critical_transitions || 0} tone={(s.total_critical_transitions || 0) > 0 ? 'bad' : ''} icon="alert"/>
      <IntakeStat label="Best worker" value={s.best_worker ? s.best_worker.worker_name : '—'} sub={s.best_worker ? s.best_worker.utilization_percent + '%' : ''} icon="check"/>
      <IntakeStat label="Needs attention" value={s.needs_attention_count || 0} tone={(s.needs_attention_count || 0) > 0 ? 'amber' : ''} icon="alert"/>
    </div>
  );
};

const WtaWorkerBars = ({ workers, onOpen }) => (
  <>{workers.map(w => (
    <div key={w.worker_id} className="wta-wcard" onClick={() => onOpen(w.worker_id)}>
      <div className="wta-wc-head">
        <div className="wta-wc-id"><div className="jce-wgrp-av">{wtaInit(w.worker_name)}</div><div><div className="nm">{w.worker_name || '—'}</div><div className="sub">{w.completed_jobs_count || 0} job{w.completed_jobs_count === 1 ? '' : 's'} · avg gap {w.average_transition_gap || 0}m{w.critical_transition_count ? ` · ${w.critical_transition_count} critical` : ''}{w.late_transition_count ? ` · ${w.late_transition_count} late` : ''}</div></div></div>
        <span className={`chip ${wtaRatingTone(w.rating)}`}>{wtaRatingLabel(w.rating)}</span>
        <span className="wta-wc-util">{w.utilization_percent || 0}%</span>
      </div>
      <WtaStackedBar w={w}/>
    </div>
  ))}</>
);

const wtaExportCsv = (rows, date) => {
  const head = ['date', 'worker', 'from_bay', 'to_bay', 'prev_job', 'next_job', 'completed', 'next_started', 'transition_gap', 'assignment_delay', 'start_delay', 'status', 'reason_category', 'reason_note', 'responsible_type'];
  const esc = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const lines = [head.join(',')].concat(rows.map(t => [date, t.worker_name, t.prev_bay_number, t.next_bay_number, t.prev_job_no, t.next_job_no, t.prev_completed_at, t.next_started_at, t.transition_gap_minutes, t.assignment_delay_minutes, t.start_delay_minutes, t.threshold_status, t.reason_category, t.reason_note, t.responsible_type].map(esc).join(',')));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `worker_transition_${date}.csv`; a.click();
};

const LiveAdminWorkerTransition = () => {
  const [date, setDate] = useJS(new Date().toISOString().slice(0, 10));
  const [f, setF] = useJS({ worker: '', status: '' });
  const [summary, setSummary] = useJS(null);
  const [workers, setWorkers] = useJS(null);
  const [trans, setTrans] = useJS(null);
  const [err, setErr] = useJS('');
  const [openWorker, setOpenWorker] = useJS(null);
  const [reasonT, setReasonT] = useJS(null);
  const load = useJC(() => {
    setErr('');
    const q = { date };
    BW_API.adminWorkerTransitionSummary(q).then(setSummary).catch(e => setErr(e.message || 'Failed to load'));
    BW_API.adminWorkerTransitionWorkers(q).then(w => setWorkers(Array.isArray(w) ? w : [])).catch(e => { setWorkers([]); setErr(e.message || 'Failed'); });
    BW_API.adminWorkerTransitionTransitions(q).then(t => setTrans(Array.isArray(t) ? t : [])).catch(() => setTrans([]));
  }, [date]);
  useJE(() => { load(); const id = setInterval(load, 45000); return () => clearInterval(id); }, [load]);
  const openW = (wid) => { BW_API.adminWorkerTransitionTimeline(wid, { date }).then(setOpenWorker).catch(e => setErr(e.message || 'Failed')); };
  const reload = () => { load(); if (openWorker) openW(openWorker.worker_id); };
  const wview = (workers || []).filter(w => (!f.status || w.rating === f.status) && (!f.worker || (w.worker_name || '').toLowerCase().includes(f.worker.toLowerCase())));
  const tview = (trans || []).filter(t => (!f.status || t.threshold_status === f.status) && (!f.worker || (t.worker_name || '').toLowerCase().includes(f.worker.toLowerCase())));
  return (
    <>
      <div className="content-head"><div><div className="eyebrow eyebrow-amber">● WORKER TIME ANALYSIS</div><h1>Worker Bay-to-Bay Time Analysis</h1><span className="sub">Track worker productivity, bay transition gaps, and 9-hour shift utilization.</span></div></div>
      {err && <div className="jce-banner danger">{err}</div>}
      <div className="card">
        <div className="jce-filters iae-filters">
          <label className="iae-date">Date<input className="input" type="date" value={date} onChange={e => setDate(e.target.value)}/></label>
          <input className="input" placeholder="Worker…" value={f.worker} onChange={e => setF(s => ({ ...s, worker: e.target.value }))}/>
          <select className="input" value={f.status} onChange={e => setF(s => ({ ...s, status: e.target.value }))}><option value="">All statuses</option>{['good', 'warning', 'late', 'critical'].map(s => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}</select>
          <button className="btn btn-ghost btn-sm" onClick={reload}><Icon name="history" size={13}/> Refresh</button>
          <button className="btn btn-ghost btn-sm" onClick={() => wtaExportCsv(tview, date)} disabled={!tview.length}><Icon name="file" size={13}/> Export CSV</button>
        </div>
        <div className="wta-basisnote"><Icon name="clock" size={12}/> Utilization is measured against a fixed 9-hour / 540-minute shift (the app has no attendance clock — “unassigned idle” is remaining shift capacity).</div>
      </div>
      <WtaSummaryCards s={summary}/>
      <div className="card">
        <div className="jce-sec-h"><Icon name="gauge" size={14}/> Worker utilization</div>
        {workers === null && <div className="jce-empty">Loading…</div>}
        {workers && wview.length === 0 && <div className="wc-empty"><Icon name="gauge" size={24}/><div className="t">No completed jobs for this date.</div></div>}
        {wview.length > 0 && <WtaWorkerBars workers={wview} onOpen={openW}/>}
      </div>
      <div className="card">
        <div className="jce-sec-h"><Icon name="route" size={14}/> Bay-to-bay transitions <span className="n">{tview.length}</span></div>
        {trans === null && <div className="jce-empty">Loading…</div>}
        {trans && tview.length === 0 && <div className="jce-empty sm">No bay-to-bay transitions for this date (a worker needs at least two jobs).</div>}
        {tview.length > 0 && <WtaTransitionTable rows={tview} onReason={setReasonT} onTimeline={openW}/>}
      </div>
      {openWorker && <WtaWorkerDrawer worker={openWorker} role="admin" onClose={() => setOpenWorker(null)} onReason={setReasonT}/>}
      {reasonT && <WtaReasonDrawer t={reasonT} role="admin" onClose={() => setReasonT(null)} onSaved={reload}/>}
    </>
  );
};
window.LiveAdminWorkerTransition = LiveAdminWorkerTransition;

const LiveMasterWorkerTransition = () => {
  const [date, setDate] = useJS(new Date().toISOString().slice(0, 10));
  const [ov, setOv] = useJS(null);
  const [err, setErr] = useJS('');
  const [openBranch, setOpenBranch] = useJS(null);
  const [branchData, setBranchData] = useJS(null);
  const [openWorker, setOpenWorker] = useJS(null);
  const [reasonT, setReasonT] = useJS(null);
  const load = useJC(() => { setErr(''); BW_API.masterWorkerTransitionSummary({ date }).then(setOv).catch(e => setErr(e.message || 'Failed to load')); }, [date]);
  useJE(() => { load(); }, [load]);
  const openBr = (bid) => { setOpenBranch(bid); BW_API.masterWorkerTransitionBranch(bid, { date }).then(setBranchData).catch(e => setErr(e.message || 'Failed')); };
  const openW = (wid) => { BW_API.masterWorkerTransitionTimeline(wid, { date }).then(setOpenWorker).catch(e => setErr(e.message || 'Failed')); };
  const reloadBranch = () => { load(); if (openBranch) openBr(openBranch); if (openWorker) openW(openWorker.worker_id); };
  const totals = (ov && ov.totals) || {};
  const branches = (ov && ov.branches) || [];
  return (
    <>
      <div className="content-head"><div><div className="eyebrow eyebrow-amber">● WORKER TIME ANALYSIS</div><h1>Worker Bay-to-Bay Time Analysis</h1><span className="sub">Global · branch-wise worker productivity &amp; transition delays</span></div></div>
      {err && <div className="jce-banner danger">{err}</div>}
      <div className="card"><div className="jce-filters"><label className="iae-date">Date<input className="input" type="date" value={date} onChange={e => setDate(e.target.value)}/></label><button className="btn btn-ghost btn-sm" onClick={reloadBranch}><Icon name="history" size={13}/> Refresh</button></div></div>
      <div className="iae-stats">
        <IntakeStat label="Branches" value={totals.branches || 0} icon="pin"/>
        <IntakeStat label="Workers" value={totals.total_workers || 0} icon="user"/>
        <IntakeStat label="Avg utilization" value={(totals.average_utilization || 0) + '%'} tone={(totals.average_utilization || 0) >= 70 ? 'ok' : (totals.total_workers ? 'amber' : '')} icon="gauge"/>
        <IntakeStat label="Late transitions" value={totals.total_late_transitions || 0} tone={(totals.total_late_transitions || 0) > 0 ? 'amber' : ''} icon="alert"/>
        <IntakeStat label="Critical delays" value={totals.total_critical_transitions || 0} tone={(totals.total_critical_transitions || 0) > 0 ? 'bad' : ''} icon="alert"/>
      </div>
      <div className="card">
        <div className="jce-sec-h"><Icon name="pin" size={14}/> Branches</div>
        {ov === null && <div className="jce-empty">Loading…</div>}
        {ov && branches.length === 0 && <div className="wc-empty"><Icon name="pin" size={24}/><div className="t">No worker activity for this date.</div></div>}
        <div className="wta-branches">
          {branches.map(b => {
            const open = openBranch === b.branch_id;
            return (
              <div key={b.branch_id || 'none'} className="wta-branch">
                <div className="wta-branch-head" onClick={() => (open ? setOpenBranch(null) : openBr(b.branch_id))}>
                  <span className="jce-branch-chev"><Icon name={open ? 'chevron-down' : 'chevron-right'} size={15}/></span>
                  <div className="wta-branch-id"><Icon name="pin" size={14}/> <span className="nm">{b.branch_name || b.branch_id || '—'}</span></div>
                  <div className="wta-branch-tot">
                    <span><b>{b.total_workers || 0}</b> workers</span>
                    <span className="ok"><b>{b.average_utilization || 0}%</b> util</span>
                    <span className="amber"><b>{b.total_late_transitions || 0}</b> late</span>
                    <span className="danger"><b>{b.total_critical_transitions || 0}</b> critical</span>
                    {b.best_worker && <span>best {b.best_worker.worker_name} {b.best_worker.utilization_percent}%</span>}
                    {b.needs_attention_count > 0 && <span className="amber">{b.needs_attention_count} needs attention</span>}
                  </div>
                </div>
                {open && branchData && branchData.branch_id === b.branch_id && (
                  <div className="wta-branch-body">
                    <WtaSummaryCards s={branchData.summary}/>
                    <div className="jce-sec-h"><Icon name="gauge" size={14}/> Worker utilization</div>
                    {(branchData.workers || []).length ? <WtaWorkerBars workers={branchData.workers} onOpen={openW}/> : <div className="jce-empty sm">No completed jobs.</div>}
                    <div className="jce-sec-h"><Icon name="route" size={14}/> Transitions</div>
                    {(branchData.transitions || []).length ? <WtaTransitionTable rows={branchData.transitions} role="master" onReason={setReasonT} onTimeline={openW}/> : <div className="jce-empty sm">No transitions.</div>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {openWorker && <WtaWorkerDrawer worker={openWorker} role="master" onClose={() => setOpenWorker(null)} onReason={setReasonT}/>}
      {reasonT && <WtaReasonDrawer t={reasonT} role="master" onClose={() => setReasonT(null)} onSaved={reloadBranch}/>}
    </>
  );
};
window.LiveMasterWorkerTransition = LiveMasterWorkerTransition;

// ════════════════════════════════════════════════════════════════
//  AI Barricade Vehicle Detection — Admin + Master UI (Phase C)
//  UI over the verified Phase B SIMULATION backend. NO YOLO / RTSP /
//  OCR / real relay here — detection is simulated, the relay is a
//  logged simulation. The backend remains the only decision authority;
//  this UI only displays state + triggers backend actions. All media
//  is token-gated (BW_API.barricadeMediaUrl) — no raw path in the DOM.
// ════════════════════════════════════════════════════════════════
const BAR_STATUS_TONE = {
  detected: 'ghost', pending_admin: 'amber', auto_allowed: 'ok', admin_allowed: 'ok',
  denied: 'danger', opened: 'ok', failed: 'danger', expired: 'ghost',
};
const barPct = (v) => (v == null ? '—' : Math.round(v * 100) + '%');
const barLabel = (s) => (s || '').replace(/_/g, ' ').toUpperCase();
const BarPill = ({ status }) => <span className={`chip ${BAR_STATUS_TONE[status] || 'ghost'}`}>{barLabel(status)}</span>;
const BarConf = ({ v, label }) => (v == null ? null :
  <span className={`bai-conf ${v >= 0.6 ? 'hi' : v >= 0.4 ? 'mid' : 'lo'}`} title={`${label} confidence`}>{label} {barPct(v)}</span>);
const BAR_OBJ_ICON = { person: 'user', bike: 'bike', car: 'car', unknown: 'alert' };

// ── shared role-aware event detail drawer (admin own-branch / master global) ──
const BarricadeEventDrawer = ({ id, role, onClose, onChanged }) => {
  const [d, setD] = useJS(null);
  const [err, setErr] = useJS('');
  const [busy, setBusy] = useJS('');
  const getter = role === 'master' ? BW_API.masterBarricadeEvent : BW_API.adminBarricadeEvent;
  const load = useJC(() => { setErr(''); getter(id).then(setD).catch(e => setErr(e.message || 'Failed to load')); }, [id, role]);
  useJE(() => { load(); }, [load]);
  const act = async (action) => {
    setBusy(action);
    try {
      if (role === 'master') await BW_API.masterBarricadeOverride(id, { action });
      else if (action === 'allow') await BW_API.adminBarricadeAllow(id);
      else if (action === 'deny') await BW_API.adminBarricadeDeny(id);
      else if (action === 'open') await BW_API.adminBarricadeOpen(id);
      load(); onChanged && onChanged();
    } catch (e) { setErr(e.message || 'Action failed'); } finally { setBusy(''); }
  };
  const relay = d && d.relay_result;
  const actionable = d && ['detected', 'pending_admin', 'auto_allowed', 'admin_allowed'].includes(d.status);
  const links = d ? [['Job card', d.linked_job_card_id], ['Intake', d.linked_intake_id], ['Test drive', d.linked_test_drive_id], ['Bill', d.linked_bill_id]].filter(x => x[1]) : [];
  return (
    <div className="modal-scrim" onClick={onClose} style={{ zIndex: 360 }}>
      <div className="modal modal-lg bai-detail" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div><div className="eyebrow eyebrow-amber">● AI BARRICADE EVENT {role === 'master' ? '· MASTER' : ''}</div><h3 style={{ margin: '4px 0 0' }}>{d ? d.event_no : 'Loading…'}</h3></div>
          <button className="modal-close" onClick={onClose}><Icon name="x" size={16}/></button>
        </div>
        <div className="modal-scroll">
          {err && <div className="jce-banner danger">{err}</div>}
          {!d && !err && <div className="jce-empty">Loading…</div>}
          {d && <>
            <div className="bai-detail-top">
              <BarPill status={d.status}/>
              <span className={`bai-dir ${d.direction}`}><Icon name={d.direction === 'exit' ? 'arrow-right' : 'arrow-left'} size={13}/> {(d.direction || '').toUpperCase()}</span>
              <span className="bai-obj"><Icon name={BAR_OBJ_ICON[d.object_type] || 'alert'} size={13}/> {d.object_type}</span>
              {d.vehicle_number && <span className="bai-veh mono"><Icon name="car" size={13}/> {d.vehicle_number}</span>}
            </div>
            <div className="bai-confrow">
              <BarConf v={d.detection_confidence} label="DETECT"/>
              <BarConf v={d.ocr_confidence} label="OCR"/>
            </div>
            {d.decision_reason && <div className="bai-reason"><Icon name="shield" size={13}/> {d.decision_reason}</div>}
            <div className="bai-authsrc"><span className="l">Authorization source</span>
              <span className={`chip ${d.authorization_source ? (d.authorization_source === 'bill' || d.authorization_source === 'temporary' ? 'ok' : 'amber') : 'ghost'}`}>{(d.authorization_source || 'none').replace(/_/g, ' ').toUpperCase()}</span></div>
            <div className="jce-dgrid">
              {[['Event time', jceFmtDT(d.event_time)], ['Normalized plate', d.vehicle_number_normalized], ['Approved by', d.approved_by_admin_name], ['Approved at', d.approved_at ? jceFmtDT(d.approved_at) : null], ['Barrier opened', d.barrier_opened_at ? jceFmtDT(d.barrier_opened_at) : (d.barrier_opened ? 'Yes' : 'No')], ['Branch', d.branch_id]].map(([l, v]) => (
                <div className="jce-d" key={l}><span className="l">{l}</span><span className="v">{(v === 0 || v) ? v : '—'}</span></div>
              ))}
            </div>
            {links.length > 0 && <>
              <div className="jce-sec-h"><Icon name="check" size={14}/> Linked records</div>
              <div className="jce-dgrid">{links.map(([l, v]) => <div className="jce-d" key={l}><span className="l">{l}</span><span className="v mono">{v}</span></div>)}</div>
            </>}
            {relay && <>
              <div className="jce-sec-h"><Icon name="bolt" size={14}/> Relay result <span className={`chip ${relay.opened ? 'ok' : 'ghost'}`} style={{ marginLeft: 6 }}>{relay.opened ? 'OPENED' : barLabel(relay.status)}</span></div>
              <div className="bai-relay">
                {[['Mode', relay.mode], ['Status', relay.status], ['Direction', relay.direction], ['Command', relay.command], ['Detail', relay.detail], ['At', relay.at ? jceFmtDT(relay.at) : null]].filter(x => x[1]).map(([l, v]) => (
                  <div className="bai-relay-r" key={l}><span className="l">{l}</span><span className="v">{v}</span></div>
                ))}
              </div>
            </>}
            {(d.media || []).length > 0 && <>
              <div className="jce-sec-h"><Icon name="image" size={14}/> Detection frames <span className="n">{d.media.length}</span></div>
              <div className="jce-thumbs">{d.media.map(m => (
                m.available
                  ? <a className="jce-mtile" key={m.id} href={BW_API.barricadeMediaUrl(m.view_url)} target="_blank" rel="noreferrer" title={m.media_type}><img src={BW_API.barricadeMediaUrl(m.view_url)} alt={m.media_type}/></a>
                  : <div className="jce-mtile expired" key={m.id}><Icon name="image" size={18}/><span>{m.status === 'deleted' ? 'Purged' : 'Expired'}</span></div>
              ))}</div>
            </>}
            {(d.decision_log || []).length > 0 && <>
              <div className="jce-sec-h"><Icon name="history" size={14}/> Decision log</div>
              <div className="jce-timeline">{d.decision_log.map((l, i) => (
                <div className="jce-ev" key={i}><span className="d mono">{jceFmtDT(l.created_at)}</span><span className="t"><b>{(l.action || '').replace(/_/g, ' ')}</b>{l.actor_name ? ` · ${l.actor_name}` : (l.actor_type ? ` · ${l.actor_type}` : '')}{l.reason ? ` — ${l.reason}` : ''}</span></div>
              ))}</div>
            </>}
          </>}
        </div>
        <div className="modal-foot bai-foot">
          {actionable && <>
            <button className="btn btn-ok btn-sm" disabled={!!busy} onClick={() => act('allow')}><Icon name="check" size={13}/> {busy === 'allow' ? 'Allowing…' : 'Allow'}</button>
            <button className="btn btn-amber btn-sm" disabled={!!busy} onClick={() => act('open')}><Icon name="bolt" size={13}/> {busy === 'open' ? 'Opening…' : 'Manual open'}</button>
            <button className="btn btn-danger btn-sm" disabled={!!busy} onClick={() => act('deny')}><Icon name="x" size={13}/> {busy === 'deny' ? 'Denying…' : 'Deny'}</button>
          </>}
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
};
window.BarricadeEventDrawer = BarricadeEventDrawer;

// ── one event row in the live feed (inline View / Allow / Deny / Open) ──
const BarEventRow = ({ e, role, onOpen, onAct, busy, inlineActions }) => {
  const actionable = inlineActions && ['detected', 'pending_admin', 'auto_allowed', 'admin_allowed'].includes(e.status);
  return (
    <div className="bai-row">
      <div className="bai-row-main" onClick={() => onOpen(e.id)}>
        <span className="bai-row-no mono">{e.event_no}</span>
        <span className={`bai-dir ${e.direction}`}><Icon name={e.direction === 'exit' ? 'arrow-right' : 'arrow-left'} size={12}/> {e.direction}</span>
        <span className="bai-obj"><Icon name={BAR_OBJ_ICON[e.object_type] || 'alert'} size={12}/> {e.object_type}</span>
        <span className="bai-veh mono">{e.vehicle_number || '—'}</span>
        <BarConf v={e.detection_confidence} label="D"/>
        <BarConf v={e.ocr_confidence} label="O"/>
        <BarPill status={e.status}/>
        <span className="bai-row-time mono">{jceFmtDT(e.event_time)}</span>
      </div>
      <div className="bai-row-act">
        <button className="btn btn-ghost btn-xs" onClick={() => onOpen(e.id)} title="Details"><Icon name="scan" size={12}/></button>
        {actionable && <>
          <button className="btn btn-ok btn-xs" disabled={!!busy} onClick={() => onAct(e.id, 'allow')} title="Allow"><Icon name="check" size={12}/></button>
          <button className="btn btn-amber btn-xs" disabled={!!busy} onClick={() => onAct(e.id, 'open')} title="Manual open"><Icon name="bolt" size={12}/></button>
          <button className="btn btn-danger btn-xs" disabled={!!busy} onClick={() => onAct(e.id, 'deny')} title="Deny"><Icon name="x" size={12}/></button>
        </>}
      </div>
    </div>
  );
};

// ── small overview stat card ──
const BarStat = ({ label, value, tone, icon, sub }) => (
  <div className={`bai-stat ${tone || ''}`}>
    <div className="bai-stat-ic"><Icon name={icon} size={16}/></div>
    <div className="bai-stat-b"><div className="v">{value}</div><div className="l">{label}</div>{sub && <div className="s">{sub}</div>}</div>
  </div>
);

// ── camera config card (entrance / exit) — seeded from the loaded config ──
const BarCameraCard = ({ direction, cam, onSaved }) => {
  const blank = { camera_name: '', brand: '', ip_address: '', rtsp_port: 554, rtsp_path: '', username: '', password: '', enabled: true, detection_enabled: true, detection_threshold: 0.45, ocr_threshold: 0.60, frame_sample_fps: 2, cooldown_seconds: 10, auto_open_known_vehicle: false, auto_open_person: false, require_admin_unknown: true, roi_json: '' };
  const [f, setF] = useJS(blank);
  const [busy, setBusy] = useJS(false);
  const [msg, setMsg] = useJS('');
  useJE(() => {
    if (!cam) { setF(blank); return; }
    setF({ ...blank, camera_name: cam.camera_name || '', brand: cam.brand || '', ip_address: cam.ip_address || '', rtsp_port: cam.rtsp_port || 554, rtsp_path: cam.rtsp_path || '', username: '', password: '', enabled: !!cam.enabled, detection_enabled: !!cam.detection_enabled, detection_threshold: cam.detection_threshold ?? 0.45, ocr_threshold: cam.ocr_threshold ?? 0.60, frame_sample_fps: cam.frame_sample_fps ?? 2, cooldown_seconds: cam.cooldown_seconds ?? 10, auto_open_known_vehicle: !!cam.auto_open_known_vehicle, auto_open_person: !!cam.auto_open_person, require_admin_unknown: cam.require_admin_unknown !== false, roi_json: cam.roi_json || '' });
  }, [cam && cam.id, cam && cam.updated_at]);
  const set = (k, v) => setF(s => ({ ...s, [k]: v }));
  const save = async () => {
    setBusy(true); setMsg('');
    try {
      const body = { direction, ...f };
      if (!body.username) delete body.username;          // blank → keep existing credential
      if (!body.password) delete body.password;
      await BW_API.adminBarricadeSaveCamera(body);
      setMsg('Saved'); onSaved && onSaved();
    } catch (e) { setMsg(e.message || 'Save failed'); } finally { setBusy(false); }
  };
  const T = ({ k, label }) => (
    <label className="bai-toggle"><input type="checkbox" checked={!!f[k]} onChange={e => set(k, e.target.checked)}/><span>{label}</span></label>
  );
  return (
    <div className="bai-cfg-card">
      <div className="bai-cfg-h"><Icon name={direction === 'exit' ? 'arrow-right' : 'arrow-left'} size={15}/> {direction === 'exit' ? 'Exit' : 'Entrance'} camera
        <span className={`chip ${cam && cam.enabled ? 'ok' : 'ghost'}`} style={{ marginLeft: 'auto' }}>{cam ? (cam.enabled ? 'ENABLED' : 'DISABLED') : 'NOT SET'}</span>
      </div>
      <div className="bai-cfg-note">Separate from service bay cameras — these are gate cameras only.</div>
      <div className="bai-cfg-grid">
        <label>Camera name<input className="input" value={f.camera_name} onChange={e => set('camera_name', e.target.value)}/></label>
        <label>Brand<input className="input" value={f.brand} onChange={e => set('brand', e.target.value)}/></label>
        <label>IP address<input className="input" value={f.ip_address} onChange={e => set('ip_address', e.target.value)}/></label>
        <label>RTSP port<input className="input" type="number" value={f.rtsp_port} onChange={e => set('rtsp_port', e.target.value)}/></label>
        <label>RTSP path<input className="input" value={f.rtsp_path} onChange={e => set('rtsp_path', e.target.value)}/></label>
        <label>Username<input className="input" placeholder={cam && cam.username && cam.username.set ? '•••• set — leave blank to keep' : ''} value={f.username} onChange={e => set('username', e.target.value)}/></label>
        <label>Password<input className="input" type="password" placeholder={cam && cam.password && cam.password.set ? '•••• set — leave blank to keep' : ''} value={f.password} onChange={e => set('password', e.target.value)}/></label>
        <label>Detection threshold<input className="input" type="number" step="0.05" min="0" max="1" value={f.detection_threshold} onChange={e => set('detection_threshold', e.target.value)}/></label>
        <label>OCR threshold<input className="input" type="number" step="0.05" min="0" max="1" value={f.ocr_threshold} onChange={e => set('ocr_threshold', e.target.value)}/></label>
        <label>Frame sample FPS<input className="input" type="number" step="0.5" value={f.frame_sample_fps} onChange={e => set('frame_sample_fps', e.target.value)}/></label>
        <label>Cooldown (s)<input className="input" type="number" value={f.cooldown_seconds} onChange={e => set('cooldown_seconds', e.target.value)}/></label>
        <label className="bai-cfg-full">ROI (JSON, optional)<input className="input mono" placeholder="{}" value={f.roi_json} onChange={e => set('roi_json', e.target.value)}/></label>
      </div>
      <div className="bai-toggles">
        <T k="enabled" label="Enabled"/>
        <T k="detection_enabled" label="Detection enabled"/>
        <T k="auto_open_known_vehicle" label="Auto-open known vehicle"/>
        <T k="auto_open_person" label="Auto-open person"/>
        <T k="require_admin_unknown" label="Require admin for unknown"/>
      </div>
      <div className="bai-cfg-foot">
        {msg && <span className={`bai-msg ${msg === 'Saved' ? 'ok' : 'err'}`}>{msg}</span>}
        <button className="btn btn-amber btn-sm" disabled={busy} onClick={save}><Icon name="check" size={13}/> {busy ? 'Saving…' : `Save ${direction} camera`}</button>
      </div>
    </div>
  );
};

// ── controller config + relay test/emergency ──
const BarControllerCard = ({ controller, cstatus, onSaved, onFlash }) => {
  const maskedVal = (v) => typeof v === 'string' && (v.includes('***') || v.includes('•'));
  const blank = { controller_type: 'simulation', enabled: true, http_method: 'GET', entrance_open_command: '', exit_open_command: '', status_endpoint: '', mqtt_topic: '', cooldown_seconds: 8, max_open_seconds: 15 };
  const [f, setF] = useJS(blank);
  const [sset, setSset] = useJS({});   // which URL fields are stored (masked) — blank keeps them
  const [tres, setTres] = useJS(null);
  const [busy, setBusy] = useJS('');
  useJE(() => {
    if (!controller) { setF(blank); setSset({}); return; }
    const iv = (v) => maskedVal(v) ? '' : (v || '');   // never pre-fill a masked value (would re-save the mask)
    setF({ controller_type: controller.controller_type || 'simulation', enabled: controller.enabled !== false, http_method: controller.http_method || 'GET', entrance_open_command: iv(controller.entrance_open_command), exit_open_command: iv(controller.exit_open_command), status_endpoint: iv(controller.status_endpoint), mqtt_topic: controller.mqtt_topic || '', cooldown_seconds: controller.cooldown_seconds ?? 8, max_open_seconds: controller.max_open_seconds ?? 15 });
    setSset({ entrance: !!controller.entrance_command_set, exit: !!controller.exit_command_set });
  }, [controller && controller.id, controller && controller.updated_at]);
  const set = (k, v) => setF(s => ({ ...s, [k]: v }));
  const run = async (key, fn) => {
    setBusy(key); if (key.startsWith('t')) setTres(null);
    try { const r = await fn(); onFlash && onFlash((r && r.message) || 'Done'); onSaved && onSaved(); return r; }
    catch (e) { onFlash && onFlash(e.message || 'Failed', true); } finally { setBusy(''); }
  };
  const testOpen = async (dir) => { const r = await run(dir === 'entrance' ? 'te' : 'tx', () => BW_API.adminBarricadeTestOpen(dir)); if (r) setTres({ dir, data: r.data || r }); };
  const isHttp = f.controller_type === 'http_relay';
  const isMqtt = f.controller_type === 'mqtt_relay';
  const isGpio = f.controller_type === 'gpio_gateway';
  const estop = cstatus && cstatus.emergency_stopped;
  const ph = (setFlag) => (setFlag && isHttp) ? '•••• stored — leave blank to keep' : '';
  return (
    <div className="bai-cfg-card">
      <div className="bai-cfg-h"><Icon name="bolt" size={15}/> Barricade controller
        <span className={`chip ${estop ? 'bad' : (cstatus && cstatus.controller_type === 'simulation' ? 'amber' : (cstatus && cstatus.enabled ? 'ok' : 'ghost'))}`} style={{ marginLeft: 'auto' }}>{estop ? 'EMERGENCY STOP' : (cstatus ? (cstatus.controller_type || 'none').toUpperCase() : 'NOT SET')}</span>
      </div>
      {estop && <div className="bai-cfg-note warn"><Icon name="stop" size={12}/> Emergency stop is ACTIVE — every open is blocked. Save this controller (Enabled) to clear the hold.</div>}
      {(isHttp || isMqtt) && <div className="bai-cfg-note warn"><Icon name="alert" size={12}/> Real relay is OPT-IN: it actuates only after backend authorization, only when Enabled, with a timeout fail-safe (any error → barrier stays closed). Drive a low-voltage dry-contact relay/gateway only — a qualified electrician wires the barrier motor.</div>}
      {isGpio && <div className="bai-cfg-note warn"><Icon name="alert" size={12}/> GPIO gateway has no backend adapter (safe no-op). Run a separate local gateway service — the backend never drives GPIO pins directly.</div>}
      <div className="bai-cfg-grid">
        <label>Controller type<select className="input" value={f.controller_type} onChange={e => set('controller_type', e.target.value)}>{['disabled', 'simulation', 'http_relay', 'mqtt_relay', 'gpio_gateway'].map(t => <option key={t} value={t}>{t}</option>)}</select></label>
        {isHttp && <label>HTTP method<select className="input" value={f.http_method} onChange={e => set('http_method', e.target.value)}>{['GET', 'POST'].map(m => <option key={m} value={m}>{m}</option>)}</select></label>}
        <label>Cooldown (s)<input className="input" type="number" value={f.cooldown_seconds} onChange={e => set('cooldown_seconds', e.target.value)}/></label>
        <label>Max open (s)<input className="input" type="number" value={f.max_open_seconds} onChange={e => set('max_open_seconds', e.target.value)}/></label>
        <label>Entrance open command{isHttp ? ' (URL)' : ''}<input className="input mono" placeholder={ph(sset.entrance)} value={f.entrance_open_command} onChange={e => set('entrance_open_command', e.target.value)}/></label>
        <label>Exit open command{isHttp ? ' (URL)' : ''}<input className="input mono" placeholder={ph(sset.exit)} value={f.exit_open_command} onChange={e => set('exit_open_command', e.target.value)}/></label>
        {isHttp && <label>Status endpoint<input className="input mono" value={f.status_endpoint} onChange={e => set('status_endpoint', e.target.value)}/></label>}
        {isMqtt && <label>MQTT topic (barricade-specific)<input className="input mono" placeholder="barricade/branch/open" value={f.mqtt_topic} onChange={e => set('mqtt_topic', e.target.value)}/></label>}
      </div>
      <div className="bai-toggles"><label className="bai-toggle"><input type="checkbox" checked={!!f.enabled} onChange={e => set('enabled', e.target.checked)}/><span>Enabled</span></label></div>
      {tres && <div className={`bai-ai-dec ${tres.data.opened ? '' : 'warn'}`}><span>Test open {tres.dir}:</span> <span className={`chip ${tres.data.opened ? 'ok' : 'ghost'}`}>{(tres.data.status || (tres.data.opened ? 'opened' : 'closed')).toUpperCase()}</span>{tres.data.mode && <span className="mono">{tres.data.mode}</span>}{tres.data.detail && <em>{tres.data.detail}</em>}</div>}
      <div className="bai-cfg-foot bai-ctrl-foot">
        <button className="btn btn-amber btn-sm" disabled={!!busy} onClick={() => run('save', () => BW_API.adminBarricadeSaveController(f))}><Icon name="check" size={13}/> {busy === 'save' ? 'Saving…' : 'Save controller'}</button>
        <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => testOpen('entrance')}><Icon name="arrow-left" size={13}/> Test open entrance</button>
        <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => testOpen('exit')}><Icon name="arrow-right" size={13}/> Test open exit</button>
        <button className="btn btn-danger btn-sm" disabled={!!busy} onClick={() => run('es', () => BW_API.adminBarricadeEmergencyStop())}><Icon name="stop" size={13}/> Emergency stop</button>
      </div>
    </div>
  );
};

// ── simulation detection panel (test without YOLO/hardware) ──
const BarSimulatePanel = ({ onResult }) => {
  const [f, setF] = useJS({ direction: 'entrance', object_type: 'car', detection_confidence: 0.92, vehicle_number_raw: '', ocr_confidence: 0.9 });
  const [busy, setBusy] = useJS(false);
  const [res, setRes] = useJS(null);
  const [err, setErr] = useJS('');
  const set = (k, v) => setF(s => ({ ...s, [k]: v }));
  const go = async () => {
    setBusy(true); setErr(''); setRes(null);
    try {
      const body = { direction: f.direction, object_type: f.object_type, detection_confidence: Number(f.detection_confidence) };
      if (f.vehicle_number_raw) body.vehicle_number_raw = f.vehicle_number_raw;
      if (f.ocr_confidence !== '' && f.ocr_confidence != null) body.ocr_confidence = Number(f.ocr_confidence);
      const ev = await BW_API.adminBarricadeSimulateDetection(body);
      setRes(ev); onResult && onResult(ev);
    } catch (e) { setErr(e.message || 'Simulation failed'); } finally { setBusy(false); }
  };
  return (
    <div className="bai-cfg-card">
      <div className="bai-cfg-h"><Icon name="sparkle" size={15}/> Simulate detection
        <span className="chip ghost" style={{ marginLeft: 'auto' }}>NO YOLO / NO HARDWARE</span>
      </div>
      <div className="bai-cfg-note">Posts a suggested detection to the backend decision engine, exactly like the future AI service will. The backend decides; the relay is simulated.</div>
      <div className="bai-cfg-grid">
        <label>Direction<select className="input" value={f.direction} onChange={e => set('direction', e.target.value)}><option value="entrance">entrance</option><option value="exit">exit</option></select></label>
        <label>Object type<select className="input" value={f.object_type} onChange={e => set('object_type', e.target.value)}>{['person', 'bike', 'car', 'unknown'].map(t => <option key={t} value={t}>{t}</option>)}</select></label>
        <label>Detection confidence<input className="input" type="number" step="0.01" min="0" max="1" value={f.detection_confidence} onChange={e => set('detection_confidence', e.target.value)}/></label>
        <label>Vehicle number<input className="input mono" placeholder="TN 09 AB 1234" value={f.vehicle_number_raw} onChange={e => set('vehicle_number_raw', e.target.value)}/></label>
        <label>OCR confidence<input className="input" type="number" step="0.01" min="0" max="1" value={f.ocr_confidence} onChange={e => set('ocr_confidence', e.target.value)}/></label>
      </div>
      <div className="bai-cfg-foot">
        {err && <span className="bai-msg err">{err}</span>}
        {res && <span className="bai-sim-res"><span className="mono">{res.event_no}</span> → <BarPill status={res.status}/> {res.decision_reason && <em>{res.decision_reason}</em>}</span>}
        <button className="btn btn-amber btn-sm" disabled={busy} onClick={go}><Icon name="sparkle" size={13}/> {busy ? 'Simulating…' : 'Simulate detection'}</button>
      </div>
    </div>
  );
};

// ── AI detection (YOLO) upload panel (Phase D) — talks to the SEPARATE detection service ──
const BarAiDetectPanel = ({ onResult }) => {
  const [url, setUrl] = useJS(BW_API.barricadeAiBase());
  const [file, setFile] = useJS(null);
  const [dir, setDir] = useJS('entrance');
  const [veh, setVeh] = useJS('');
  const [runOcr, setRunOcr] = useJS(true);
  const [busy, setBusy] = useJS('');
  const [det, setDet] = useJS(null);
  const [ocr, setOcr] = useJS(null);
  const [dec, setDec] = useJS(null);
  const [err, setErr] = useJS('');
  const saveUrl = (u) => { setUrl(u); BW_API.barricadeAiSetBase(u); };
  const run = async (ingest) => {
    if (!file) { setErr('Choose an image first'); return; }
    setBusy(ingest ? 'ingest' : 'detect'); setErr(''); setDet(null); setOcr(null); setDec(null);
    const opts = { run_ocr: runOcr, vehicle_number_override: veh || undefined };
    try {
      if (ingest) {
        const branch = (BW_API.currentUser() || {}).branch_id;
        const r = await BW_API.barricadeAiDetectIngest(file, { branch_id: branch, direction: dir, ...opts });
        setDet(r.detection || r);
        setOcr(r.ocr || null);
        setDec((r.ingest && r.ingest.decision) || null);
        if (r.ingest && !r.ingest.decision) setErr('Ingest: ' + (r.ingest.reason || r.ingest.error || ('backend HTTP ' + r.ingest.status_code)));
        onResult && onResult();
      } else {
        const r = await BW_API.barricadeAiDetect(file, opts);
        setDet(r); setOcr(r.ocr || null);
      }
    } catch (e) { setErr(`AI service not reachable at ${url} — start ai_barricade_service (see its README). [${e.message || ''}]`); }
    finally { setBusy(''); }
  };
  const dets = (det && det.detections) || [];
  return (
    <div className="bai-cfg-card">
      <div className="bai-cfg-h"><Icon name="scan" size={15}/> AI detection + OCR (YOLO) <span className="chip ghost" style={{ marginLeft: 'auto' }}>UPLOAD IMAGE</span></div>
      <div className="bai-cfg-note">Runs the separate detection service on an uploaded image, reads the plate (OCR) for a vehicle, and “+ ingest” forwards the suggestion to the backend, which decides. The service only suggests; the backend is the sole authority.</div>
      <div className="bai-cfg-grid">
        <label className="bai-cfg-full">AI service URL<input className="input mono" value={url} onChange={e => saveUrl(e.target.value)}/></label>
        <label className="bai-cfg-full">Image<input className="input" type="file" accept="image/*" onChange={e => setFile((e.target.files && e.target.files[0]) || null)}/></label>
        <label>Direction<select className="input" value={dir} onChange={e => setDir(e.target.value)}><option value="entrance">entrance</option><option value="exit">exit</option></select></label>
        <label>Plate override (test)<input className="input mono" placeholder="e.g. TN07BQ5566" value={veh} onChange={e => setVeh(e.target.value)}/></label>
        <label className="bai-ocr-toggle"><input type="checkbox" checked={runOcr} onChange={e => setRunOcr(e.target.checked)}/> Run OCR (read plate for vehicles)</label>
      </div>
      <div className="bai-cfg-foot">
        {err && <span className="bai-msg err">{err}</span>}
        <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => run(false)}><Icon name="scan" size={13}/> {busy === 'detect' ? 'Detecting…' : 'Detect + OCR'}</button>
        <button className="btn btn-amber btn-sm" disabled={!!busy} onClick={() => run(true)}><Icon name="bolt" size={13}/> {busy === 'ingest' ? 'Ingesting…' : 'Detect + OCR + Ingest'}</button>
      </div>
      {det && <div className="bai-ai-out">
        <div className="bai-ai-meta">{det.mock ? <span className="chip amber">MOCK MODEL</span> : <span className="chip ok">YOLO</span>}{det.image_size && <span className="mono">{det.image_size.width}×{det.image_size.height}</span>}<span>{dets.length} detection(s)</span></div>
        {dets.map((x, i) => (
          <div className="bai-ai-det" key={i}>
            <span className="bai-obj"><Icon name={BAR_OBJ_ICON[x.mapped_type] || 'alert'} size={12}/> {x.class_name} → {x.mapped_type}</span>
            <BarConf v={x.confidence} label="YOLO"/>
            <span className="mono bai-ai-box">[{x.box.x1},{x.box.y1},{x.box.x2},{x.box.y2}]</span>
          </div>
        ))}
        {dets.length === 0 && <div className="jce-empty sm">No person/bike/car detected</div>}
      </div>}
      {ocr && <div className="bai-ai-ocr">
        <span className="bai-ocr-k">PLATE</span>
        <span className="mono bai-ocr-plate">{ocr.plate_text || '— none read —'}</span>
        {ocr.normalized_plate && <span className="mono bai-ocr-norm">→ {ocr.normalized_plate}</span>}
        {ocr.ocr_confidence != null && <BarConf v={ocr.ocr_confidence} label="OCR"/>}
        <span className={'chip ' + (ocr.mock ? 'amber' : 'ok')} style={{ marginLeft: 'auto' }}>{(ocr.engine || 'ocr').toUpperCase()}{ocr.mock ? ' · MOCK' : ''}</span>
      </div>}
      {dec && <div className="bai-ai-dec"><span>Backend decision:</span> <span className="mono">{dec.event_no}</span> <BarPill status={dec.status}/>{dec.vehicle_number_normalized && <span className="mono">{dec.vehicle_number_normalized}</span>}{dec.decision_reason && <em>{dec.decision_reason}</em>}</div>}
    </div>
  );
};

// ── RTSP stream-worker status panel (Phase E) — talks to the SEPARATE service ──
const BarStreamPanel = ({ onResult }) => {
  const [status, setStatus] = useJS(null);
  const [err, setErr] = useJS('');
  const [busy, setBusy] = useJS('');
  const [tfFile, setTfFile] = useJS(null);
  const [tfRes, setTfRes] = useJS(null);
  const tick = useJC(() => BW_API.barricadeStreamStatus()
    .then(s => { setStatus(s); setErr(''); })
    .catch(() => { setErr(`AI stream service not reachable at ${BW_API.barricadeAiBase()} — start ai_barricade_service (see its README).`); }), []);
  useJE(() => { tick(); const id = setInterval(tick, 4000); return () => clearInterval(id); }, [tick]);
  const act = async (key, fn) => { setBusy(key); try { await fn(); await tick(); } catch (e) { setErr(e.message || 'Failed'); } finally { setBusy(''); } };
  const runTestFile = async () => {
    if (!tfFile) { setErr('Choose an image first'); return; }
    setBusy('test'); setTfRes(null);
    try {
      const branch = (BW_API.currentUser() || {}).branch_id;
      const r = await BW_API.barricadeStreamTestFile([tfFile], { branch_id: branch, direction: 'entrance' });
      setTfRes(r); onResult && onResult(); await tick();
    } catch (e) { setErr(e.message || 'Test file failed'); } finally { setBusy(''); }
  };
  const cams = (status && status.cameras) || [];
  return (
    <div className="bai-cfg-card">
      <div className="bai-cfg-h"><Icon name="cam" size={15}/> RTSP stream workers
        <span className={`chip ${status ? (status.running ? 'ok' : 'ghost') : 'danger'}`} style={{ marginLeft: 'auto' }}>{status ? (status.running ? 'RUNNING' : 'STOPPED') : 'OFFLINE'}</span>
      </div>
      <div className="bai-cfg-note">Reads entrance/exit camera frames in the separate service, detects, debounces, and suggests to the backend (which decides). No live video preview / OCR here.</div>
      {err && <div className="bai-msg err" style={{ marginBottom: 10 }}>{err}</div>}
      {status && cams.length === 0 && !err && <div className="jce-empty sm">No stream workers running. Start streams (uses backend camera config) or run a Test file.</div>}
      {cams.map((c, i) => (
        <div className="bai-stream-row" key={i}>
          <span className={`bai-dir ${c.direction}`}><Icon name={c.direction === 'exit' ? 'arrow-right' : 'arrow-left'} size={12}/> {c.direction}</span>
          <span className="bai-stream-nm">{c.camera_name || '—'} <span className="mono bai-stream-src">{c.source || ''}</span></span>
          <span className={`chip ${c.connected ? 'ok' : 'danger'}`}>{c.connected ? 'CONNECTED' : 'OFFLINE'}</span>
          <span className="bai-stream-meta mono">sent {c.detections_sent}{c.last_ingest_at ? ` · last ${c.last_ingest_at.slice(11)}` : ''}{c.last_decision ? ` · ${c.last_decision}` : ''}</span>
          {c.last_error && <span className="bai-stream-err" title={c.last_error}>{c.last_error}</span>}
        </div>
      ))}
      <div className="bai-cfg-foot bai-ctrl-foot">
        <button className="btn btn-ok btn-sm" disabled={!!busy} onClick={() => act('start', () => BW_API.barricadeStreamStart({ use_backend_config: true }))}><Icon name="play" size={13}/> {busy === 'start' ? 'Starting…' : 'Start streams'}</button>
        <button className="btn btn-danger btn-sm" disabled={!!busy} onClick={() => act('stop', () => BW_API.barricadeStreamStop())}><Icon name="stop" size={13}/> Stop streams</button>
        <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => act('reload', () => BW_API.barricadeStreamReload())}><Icon name="history" size={13}/> Reload config</button>
      </div>
      <div className="bai-cfg-grid" style={{ marginTop: 6 }}>
        <label className="bai-cfg-full">Test file (image) processing<input className="input" type="file" accept="image/*" onChange={e => setTfFile((e.target.files && e.target.files[0]) || null)}/></label>
      </div>
      <div className="bai-cfg-foot">
        {tfRes && <span className="bai-sim-res">{tfRes.frames_processed} frame(s) → {tfRes.ingests_posted} posted · {tfRes.deduped_by_cooldown} deduped{(tfRes.event_nos || []).length ? ` · ${tfRes.event_nos.join(', ')}` : ''}</span>}
        <button className="btn btn-amber btn-sm" disabled={!!busy} onClick={runTestFile}><Icon name="scan" size={13}/> {busy === 'test' ? 'Processing…' : 'Test file processing'}</button>
      </div>
    </div>
  );
};

// ── bill + temporary approval forms (exit authorisation) ──
const BAR_APPR_TONE = { approved: 'ok', paid: 'ok', active: 'ok', pending: 'amber', unpaid: 'amber', unknown: 'amber', used: 'ghost', rejected: 'bad', revoked: 'bad', expired: 'ghost' };
const BarApprChip = ({ v }) => <span className={`chip ${BAR_APPR_TONE[v] || 'ghost'}`}>{(v || '—').toUpperCase()}</span>;
const barTm = (s) => s ? new Date(s).toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

const BarBillRow = ({ b, onAct, busy }) => (
  <div className="bai-appr-row">
    <span className="mono bai-appr-veh">{b.vehicle_number_normalized || b.vehicle_number || '—'}</span>
    <span className="bai-appr-sub">{b.bill_no ? `#${b.bill_no} ` : ''}{b.customer_name || ''}{b.amount != null ? ` · ₹${b.amount}` : ''}</span>
    <BarApprChip v={b.payment_status}/>
    <BarApprChip v={b.status}/>
    {b.used_event_no && <span className="chip ghost mono">USED · {b.used_event_no}</span>}
    <span className="bai-appr-meta">{b.uploaded_by_admin_name || ''} · {barTm(b.created_at)}</span>
    <div className="bai-appr-acts">
      {b.status !== 'approved' && b.status !== 'used' && <button className="btn btn-ghost btn-xs" disabled={busy} onClick={() => onAct(b, 'approve')}>Approve</button>}
      {b.status !== 'rejected' && b.status !== 'used' && <button className="btn btn-ghost btn-xs" disabled={busy} onClick={() => onAct(b, 'reject')}>Reject</button>}
    </div>
  </div>
);

const BarTempRow = ({ t, onAct, busy }) => (
  <div className="bai-appr-row">
    <span className="mono bai-appr-veh">{t.vehicle_number_normalized || '—'}</span>
    <span className="bai-appr-sub">{t.approval_type}{t.object_type ? ` · ${t.object_type}` : ''}{t.linked_job_card_id ? ' · job' : ''}{t.linked_test_drive_id ? ' · test-drive' : ''}{t.linked_worker_id ? ' · worker' : ''}</span>
    <BarApprChip v={t.status}/>
    {t.used_event_no && <span className="chip ghost mono">USED · {t.used_event_no}</span>}
    <span className="bai-appr-meta">{barTm(t.valid_from)} → {barTm(t.valid_until)}</span>
    <div className="bai-appr-acts">
      {t.status === 'active' && <button className="btn btn-ghost btn-xs" disabled={busy} onClick={() => onAct(t, 'revoke')}>Revoke</button>}
    </div>
  </div>
);

const BarPendingExitRow = ({ e, onAct, onOpen, onTemp, busy }) => (
  <div className="bai-appr-row bai-pex">
    <span className="mono bai-appr-veh" onClick={() => onOpen(e.id)} style={{ cursor: 'pointer' }}>{e.event_no}</span>
    <span className="mono">{e.vehicle_number || '— no plate —'}</span>
    {e.ocr_confidence != null && <BarConf v={e.ocr_confidence} label="OCR"/>}
    <span className="bai-appr-sub" title={e.decision_reason}>{e.decision_reason || ''}</span>
    <span className="bai-appr-meta">{barTm(e.event_time)}</span>
    <div className="bai-appr-acts">
      <button className="btn btn-ghost btn-xs" disabled={busy} onClick={() => onAct(e.id, 'allow')}>Allow</button>
      <button className="btn btn-ghost btn-xs" disabled={busy} onClick={() => onAct(e.id, 'deny')}>Deny</button>
      <button className="btn btn-amber btn-xs" disabled={busy} onClick={() => onAct(e.id, 'open')}>Open</button>
      <button className="btn btn-ghost btn-xs" disabled={busy} onClick={() => onTemp(e)}>+ Temp</button>
    </div>
  </div>
);

const BarApprovalForms = ({ onFlash, onOpen, onReload }) => {
  const [b, setB] = useJS({ bill_no: '', vehicle_number: '', customer_name: '', amount: '', payment_status: 'paid', status: 'approved', notes: '' });
  const [t, setT] = useJS({ approval_type: 'test_drive', vehicle_number: '', object_type: '', valid_minutes: 120, linked_job_card_id: '', linked_worker_id: '', linked_test_drive_id: '', notes: '' });
  const [busy, setBusy] = useJS('');
  const [bills, setBills] = useJS(null);
  const [temps, setTemps] = useJS(null);
  const [pex, setPex] = useJS(null);
  const sb = (k, v) => setB(s => ({ ...s, [k]: v }));
  const st = (k, v) => setT(s => ({ ...s, [k]: v }));
  const load = useJC(() => {
    BW_API.adminBarricadeBillApprovals({ limit: '100' }).then(r => setBills(Array.isArray(r) ? r : [])).catch(() => setBills([]));
    BW_API.adminBarricadeTempApprovals({ limit: '100' }).then(r => setTemps(Array.isArray(r) ? r : [])).catch(() => setTemps([]));
    BW_API.adminBarricadeEvents({ direction: 'exit', status: 'pending_admin', limit: '50' }).then(r => setPex(Array.isArray(r) ? r : [])).catch(() => setPex([]));
  }, []);
  useJE(() => { load(); }, [load]);
  const refresh = () => { load(); onReload && onReload(); };
  const saveBill = async () => {
    if (!b.vehicle_number) return onFlash('Vehicle number is required', true);
    setBusy('bill');
    try { const r = await BW_API.adminBarricadeBillApproval({ ...b, amount: b.amount ? Number(b.amount) : null }); onFlash(`Bill approval saved · ${r.vehicle_number_normalized || ''}`); setB(s => ({ ...s, bill_no: '', vehicle_number: '', customer_name: '', amount: '', notes: '' })); refresh(); }
    catch (e) { onFlash(e.message || 'Failed', true); } finally { setBusy(''); }
  };
  const saveTemp = async () => {
    if (!t.vehicle_number) return onFlash('Vehicle number is required', true);
    setBusy('temp');
    try { const r = await BW_API.adminBarricadeTempApproval({ ...t, valid_minutes: Number(t.valid_minutes) || 120 }); onFlash(`Temporary approval created · ${r.approval_type}`); setT(s => ({ ...s, vehicle_number: '', linked_job_card_id: '', linked_worker_id: '', linked_test_drive_id: '', notes: '' })); refresh(); }
    catch (e) { onFlash(e.message || 'Failed', true); } finally { setBusy(''); }
  };
  const billAct = async (bill, action) => {
    setBusy(bill.id);
    try { await (action === 'approve' ? BW_API.adminBarricadeBillApprovalApprove(bill.id) : BW_API.adminBarricadeBillApprovalReject(bill.id)); onFlash(`Bill ${action}d`); refresh(); }
    catch (e) { onFlash(e.message || 'Failed', true); } finally { setBusy(''); }
  };
  const tempAct = async (temp) => {
    setBusy(temp.id);
    try { await BW_API.adminBarricadeTempApprovalRevoke(temp.id); onFlash('Temporary approval revoked'); refresh(); }
    catch (e) { onFlash(e.message || 'Failed', true); } finally { setBusy(''); }
  };
  const pexAct = async (id, action) => {
    setBusy(id);
    try { await (action === 'allow' ? BW_API.adminBarricadeAllow(id) : action === 'deny' ? BW_API.adminBarricadeDeny(id) : BW_API.adminBarricadeOpen(id)); onFlash(`Exit ${action === 'open' ? 'opened' : action + 'ed'}`); refresh(); }
    catch (e) { onFlash(e.message || 'Failed', true); } finally { setBusy(''); }
  };
  const tempFromEvent = (e) => { setT(s => ({ ...s, approval_type: 'manual_once', vehicle_number: e.vehicle_number || e.vehicle_number_normalized || '', object_type: e.object_type || '' })); onFlash('Prefilled temp approval — set validity + create'); };
  return (
    <div className="bai-appr-wrap">
      <div className="bai-cfg-2col">
        <div className="bai-cfg-card">
          <div className="bai-cfg-h"><Icon name="card" size={15}/> Bill approval <span className="chip ghost" style={{ marginLeft: 'auto' }}>EXIT</span></div>
          <div className="bai-cfg-note">An approved + paid bill authorises a matching vehicle to exit once. (PDF bill upload comes later.)</div>
          <div className="bai-cfg-grid">
            <label>Bill number<input className="input" value={b.bill_no} onChange={e => sb('bill_no', e.target.value)}/></label>
            <label>Vehicle number<input className="input mono" placeholder="TN 22 CD 9999" value={b.vehicle_number} onChange={e => sb('vehicle_number', e.target.value)}/></label>
            <label>Customer name<input className="input" value={b.customer_name} onChange={e => sb('customer_name', e.target.value)}/></label>
            <label>Amount<input className="input" type="number" value={b.amount} onChange={e => sb('amount', e.target.value)}/></label>
            <label>Payment status<select className="input" value={b.payment_status} onChange={e => sb('payment_status', e.target.value)}>{['paid', 'unpaid', 'unknown'].map(x => <option key={x} value={x}>{x}</option>)}</select></label>
            <label>Approval status<select className="input" value={b.status} onChange={e => sb('status', e.target.value)}>{['approved', 'pending', 'rejected'].map(x => <option key={x} value={x}>{x}</option>)}</select></label>
          </div>
          <div className="bai-cfg-foot"><button className="btn btn-amber btn-sm" disabled={busy === 'bill'} onClick={saveBill}><Icon name="check" size={13}/> {busy === 'bill' ? 'Saving…' : 'Save bill approval'}</button></div>
        </div>
        <div className="bai-cfg-card">
          <div className="bai-cfg-h"><Icon name="clock" size={15}/> Temporary approval <span className="chip ghost" style={{ marginLeft: 'auto' }}>TIME-BOXED</span></div>
          <div className="bai-cfg-note">A time-boxed pass for a test-drive bike, visitor, or one-shot manual allowance.</div>
          <div className="bai-cfg-grid">
            <label>Type<select className="input" value={t.approval_type} onChange={e => st('approval_type', e.target.value)}>{['test_drive', 'visitor', 'manual_once'].map(x => <option key={x} value={x}>{x}</option>)}</select></label>
            <label>Vehicle number<input className="input mono" placeholder="KA 05 MN 4321" value={t.vehicle_number} onChange={e => st('vehicle_number', e.target.value)}/></label>
            <label>Object type<select className="input" value={t.object_type} onChange={e => st('object_type', e.target.value)}><option value="">—</option>{['bike', 'car', 'person'].map(x => <option key={x} value={x}>{x}</option>)}</select></label>
            <label>Valid (minutes)<input className="input" type="number" value={t.valid_minutes} onChange={e => st('valid_minutes', e.target.value)}/></label>
            <label>Job card id<input className="input mono" value={t.linked_job_card_id} onChange={e => st('linked_job_card_id', e.target.value)}/></label>
            <label>Worker id<input className="input mono" value={t.linked_worker_id} onChange={e => st('linked_worker_id', e.target.value)}/></label>
          </div>
          <div className="bai-cfg-foot"><button className="btn btn-amber btn-sm" disabled={busy === 'temp'} onClick={saveTemp}><Icon name="check" size={13}/> {busy === 'temp' ? 'Creating…' : 'Create temporary approval'}</button></div>
        </div>
      </div>

      <div className="bai-appr-list">
        <div className="bai-appr-h"><Icon name="alert" size={14}/> Pending exit events <span className="chip amber">{(pex || []).length}</span><button className="btn btn-ghost btn-xs" style={{ marginLeft: 'auto' }} onClick={refresh}><Icon name="history" size={12}/> Refresh</button></div>
        {pex == null && <div className="jce-empty sm">Loading…</div>}
        {pex != null && pex.length === 0 && <div className="jce-empty sm">No unresolved exit events.</div>}
        {(pex || []).map(e => <BarPendingExitRow key={e.id} e={e} busy={busy === e.id} onAct={pexAct} onOpen={onOpen} onTemp={tempFromEvent}/>)}
      </div>

      <div className="bai-appr-list">
        <div className="bai-appr-h"><Icon name="card" size={14}/> Bill approvals <span className="chip ghost">{(bills || []).length}</span></div>
        {bills == null && <div className="jce-empty sm">Loading…</div>}
        {bills != null && bills.length === 0 && <div className="jce-empty sm">No bill approvals yet.</div>}
        {(bills || []).map(x => <BarBillRow key={x.id} b={x} busy={busy === x.id} onAct={billAct}/>)}
      </div>

      <div className="bai-appr-list">
        <div className="bai-appr-h"><Icon name="clock" size={14}/> Temporary approvals <span className="chip ghost">{(temps || []).length}</span></div>
        {temps == null && <div className="jce-empty sm">Loading…</div>}
        {temps != null && temps.length === 0 && <div className="jce-empty sm">No temporary approvals yet.</div>}
        {(temps || []).map(x => <BarTempRow key={x.id} t={x} busy={busy === x.id} onAct={tempAct}/>)}
      </div>
    </div>
  );
};

// ── ADMIN page ──
// ── hardware safety status panel (Phase J) — DISPLAYS the controller's reported safety telemetry ──
const BAR_SAFETY_TONE = {
  controller_online: v => (v === true ? 'ok' : 'amber'),
  barrier_state: v => ({ open: 'ok', closed: 'ghost', opening: 'amber', closing: 'amber', fault: 'bad', unknown: 'ghost' }[v] || 'ghost'),
  beam_status: v => ({ clear: 'ok', blocked: 'bad', unknown: 'ghost' }[v] || 'ghost'),
  loop_status: v => ({ clear: 'ok', vehicle_present: 'amber', unknown: 'ghost' }[v] || 'ghost'),
  power_status: v => ({ mains: 'ok', ups: 'amber', low_battery: 'bad', unknown: 'ghost' }[v] || 'ghost'),
  network_status: v => ({ online: 'ok', unstable: 'amber', offline: 'bad', unknown: 'ghost' }[v] || 'ghost'),
};
const BarSafetyPanel = ({ cstatus, onFlash, onReload }) => {
  const [st, setSt] = useJS(cstatus || null);
  const [busy, setBusy] = useJS('');
  useJE(() => { if (cstatus) setSt(cstatus); }, [cstatus && cstatus.last_command_at, cstatus && (cstatus.safety || {}).last_safety_at]);
  const refresh = async (poll) => {
    setBusy(poll ? 'poll' : 'refresh');
    try { const r = await BW_API.adminBarricadeControllerStatus(poll); setSt(r); onReload && onReload(); onFlash && onFlash(poll ? 'Polled controller status' : 'Refreshed'); }
    catch (e) { onFlash && onFlash(e.message || 'Failed', true); } finally { setBusy(''); }
  };
  const estop = async () => { setBusy('es'); try { await BW_API.adminBarricadeEmergencyStop(); await refresh(false); onFlash && onFlash('Emergency stop engaged'); } catch (e) { onFlash && onFlash(e.message || 'Failed', true); } finally { setBusy(''); } };
  const s = (st && st.safety) || {};
  const emergency = st && st.emergency_stopped;
  const chip = (label, value, tone) => (
    <div className="bai-safety-cell"><span className="bai-safety-k">{label}</span><span className={`chip ${tone}`}>{String(value == null ? 'unknown' : value).replace(/_/g, ' ').toUpperCase()}</span></div>
  );
  return (
    <div className="bai-cfg-card">
      <div className="bai-cfg-h"><Icon name="shield" size={15}/> Hardware safety status
        <span className={`chip ${emergency ? 'bad' : (s.interlock_ok === false ? 'bad' : 'ok')}`} style={{ marginLeft: 'auto' }}>{emergency ? 'EMERGENCY STOP' : (s.interlock_ok === false ? 'BLOCKED' : 'READY')}</span>
      </div>
      <div className="bai-cfg-note">Live telemetry a real controller/gateway reports (beam · loop · barrier · power). The backend only DISPLAYS this and, when “require safety for open” is on, blocks an open on offline / fault / beam-blocked. In simulation there is no hardware to report — values read “unknown”.</div>
      {emergency && <div className="bai-cfg-note warn"><Icon name="stop" size={12}/> Emergency stop is ACTIVE — every open is blocked until an admin clears it (save the controller enabled).</div>}
      {s.require_safety_status_for_open && s.interlock_ok === false && !emergency && <div className="bai-cfg-note warn"><Icon name="alert" size={12}/> Safety interlock is BLOCKING opens — {s.controller_online === false ? 'controller offline / no heartbeat' : (s.barrier_state === 'fault' ? ('fault: ' + (s.fault_reason || 'unspecified')) : (s.beam_status === 'blocked' ? 'photo-beam blocked' : 'unsafe condition'))}.</div>}
      <div className="bai-safety-grid">
        {chip('Controller', s.controller_online ? 'online' : 'offline', BAR_SAFETY_TONE.controller_online(s.controller_online))}
        {chip('Barrier', s.barrier_state, BAR_SAFETY_TONE.barrier_state(s.barrier_state || 'unknown'))}
        {chip('Photo-beam', s.beam_status, BAR_SAFETY_TONE.beam_status(s.beam_status || 'unknown'))}
        {chip('Loop detector', s.loop_status, BAR_SAFETY_TONE.loop_status(s.loop_status || 'unknown'))}
        {chip('Manual override', s.manual_override_active ? 'active' : 'off', s.manual_override_active ? 'amber' : 'ghost')}
        {chip('Emergency', emergency ? 'active' : 'clear', emergency ? 'bad' : 'ok')}
        {chip('Power', s.power_status, BAR_SAFETY_TONE.power_status(s.power_status || 'unknown'))}
        {chip('Network', s.network_status, BAR_SAFETY_TONE.network_status(s.network_status || 'unknown'))}
        {chip('Require safety', s.require_safety_status_for_open ? 'on' : 'off', s.require_safety_status_for_open ? 'ok' : 'ghost')}
      </div>
      <div className="bai-safety-meta">
        <span>Last relay: <b className="mono">{(st && st.last_status) || '—'}</b></span>
        <span>Last heartbeat: <b className="mono">{s.last_safety_at ? new Date(s.last_safety_at).toLocaleString() : '— none —'}</b></span>
        {s.last_safety_error && <span className="danger">Last error: {s.last_safety_error}</span>}
      </div>
      <div className="bai-cfg-foot">
        <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => refresh(false)}><Icon name="history" size={13}/> {busy === 'refresh' ? 'Refreshing…' : 'Refresh status'}</button>
        <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => refresh(true)}><Icon name="gauge" size={13}/> {busy === 'poll' ? 'Polling…' : 'Poll controller'}</button>
        <button className="btn btn-danger btn-sm" disabled={!!busy} onClick={estop}><Icon name="stop" size={13}/> Emergency stop</button>
      </div>
    </div>
  );
};

// ── hardware pilot readiness checklist (Phase J) — READ-ONLY; never enables real relay ──
const BarPilotChecklist = () => {
  const [ck, setCk] = useJS(null);
  const [err, setErr] = useJS('');
  useJE(() => { BW_API.adminBarricadePilotChecklist().then(setCk).catch(e => setErr(e.message || 'Failed to load checklist')); }, []);
  const tone = t => ({ ok: 'ok', warn: 'amber', todo: 'ghost', physical: 'ghost' }[t] || 'ghost');
  const row = it => (
    <div className="bai-pilot-item" key={it.key}>
      <span className={`bai-pilot-dot ${tone(it.status)}`}><Icon name={it.status === 'ok' ? 'check' : (it.status === 'physical' ? 'wrench' : 'alert')} size={11}/></span>
      <span className="bai-pilot-l">{it.label}</span>
      <span className="bai-pilot-d">{it.detail}</span>
      <span className={`chip ${tone(it.status)}`}>{(it.status === 'physical' ? 'on-site' : it.status).toUpperCase()}</span>
    </div>
  );
  return (
    <div className="bai-cfg-card">
      <div className="bai-cfg-h"><Icon name="clipboard" size={15}/> Hardware pilot readiness
        {ck && <span className={`chip ${ck.ready_for_bench_test ? 'ok' : 'amber'}`} style={{ marginLeft: 'auto' }}>{ck.ready_for_bench_test ? 'READY FOR BENCH TEST' : 'NOT READY'}</span>}
      </div>
      {err && <div className="bai-msg err">{err}</div>}
      {ck && <>
        <div className="bai-cfg-note">Software-side readiness only. Physical items must be verified on site. This screen never enables a real relay — {ck.real_relay_enabled ? 'a REAL relay is currently selected (opt-in).' : 'simulation is active (real relay stays opt-in).'} Unattended operation: <b>not permitted</b>.</div>
        <div className="bai-pilot-sec">Software prerequisites</div>
        <div className="bai-pilot-list">{ck.software.map(row)}</div>
        <div className="bai-pilot-sec">Physical prerequisites (verify on site)</div>
        <div className="bai-pilot-list">{ck.physical.map(row)}</div>
        <div className="bai-cfg-note warn"><Icon name="alert" size={12}/> Enable a real relay only after ALL physical items are installed & tested and “require safety for open” is turned on. Run a staff-supervised single-lane pilot before any unattended use.</div>
      </>}
      {!ck && !err && <div className="jce-empty">Loading…</div>}
    </div>
  );
};

const LiveAdminBarricade = () => {
  const [cfg, setCfg] = useJS(null);
  const [view, setView] = useJS('live');     // live | simulate | config | safety | approvals
  const [openId, setOpenId] = useJS(null);
  const [filt, setFilt] = useJS({ direction: '', status: '', vehicle: '' });
  const [busy, setBusy] = useJS('');
  const [flash, setFlash] = useJS(null);
  const [err, setErr] = useJS('');
  const loadCfg = useJC(() => { BW_API.adminBarricadeConfig().then(setCfg).catch(e => setErr(e.message || 'Failed to load config')); }, []);
  useJE(() => { loadCfg(); }, [loadCfg]);
  const fetchSnap = useJC(() => BW_API.adminBarricadeEvents({ limit: '40' }).then(evs => {
    const list = Array.isArray(evs) ? evs : [];
    const today = new Date().toISOString().slice(0, 10);
    return { events: list, pending_count: list.filter(e => e.status === 'pending_admin').length,
      today: { entrance: list.filter(e => e.direction === 'entrance' && (e.event_time || '').slice(0, 10) === today).length,
               exit: list.filter(e => e.direction === 'exit' && (e.event_time || '').slice(0, 10) === today).length } };
  }).catch(e => { setErr(e.message || 'Failed to load events'); return null; }), []);
  const snap = useBWSnapshot('/barricade', fetchSnap, [], 5000);
  const data = snap.data || {};
  const events = data.events || [];
  const reload = () => { snap.reload(); };
  const doFlash = (m, isErr) => { setFlash({ m, isErr }); setTimeout(() => setFlash(null), 3500); };
  const quickAct = async (id, action) => {
    setBusy(id);
    try {
      if (action === 'allow') await BW_API.adminBarricadeAllow(id);
      else if (action === 'deny') await BW_API.adminBarricadeDeny(id);
      else await BW_API.adminBarricadeOpen(id);
      reload();
    } catch (e) { doFlash(e.message || 'Action failed', true); } finally { setBusy(''); }
  };
  const cams = (cfg && cfg.cameras) || [];
  const camIn = cams.find(c => c.direction === 'entrance');
  const camOut = cams.find(c => c.direction === 'exit');
  const cstat = cfg && cfg.controller_status;
  const filtered = events.filter(e => (!filt.direction || e.direction === filt.direction)
    && (!filt.status || e.status === filt.status)
    && (!filt.vehicle || (e.vehicle_number || '').toLowerCase().includes(filt.vehicle.toLowerCase())));
  const unknownCt = events.filter(e => e.object_type === 'unknown').length;
  const failPend = events.filter(e => e.status === 'failed' || e.status === 'pending_admin').length;
  return (
    <>
      <div className="content-head"><div><div className="eyebrow eyebrow-amber">● AI BARRICADE</div><h1>AI Barricade</h1><span className="sub">Entrance / exit automation · simulation mode{cfg && cfg.simulation_enabled === false ? ' off' : ''}</span></div></div>
      {flash && <div className={`bai-flash ${flash.isErr ? 'err' : 'ok'}`}>{flash.m}</div>}
      {err && <div className="jce-banner danger">{err}</div>}
      <div className="bai-stats">
        <BarStat label="Entrance camera" value={camIn ? (camIn.enabled ? 'Enabled' : 'Disabled') : 'Not set'} tone={camIn && camIn.enabled ? 'ok' : ''} icon="cam" sub={camIn ? (camIn.detection_enabled ? 'Detection on' : 'Detection off') : '—'}/>
        <BarStat label="Exit camera" value={camOut ? (camOut.enabled ? 'Enabled' : 'Disabled') : 'Not set'} tone={camOut && camOut.enabled ? 'ok' : ''} icon="cam" sub={camOut ? (camOut.detection_enabled ? 'Detection on' : 'Detection off') : '—'}/>
        <BarStat label="Controller" value={cstat ? (cstat.controller_type || 'none') : 'Not set'} tone={cstat && cstat.controller_type === 'simulation' ? 'amber' : (cstat && cstat.enabled ? 'ok' : '')} icon="bolt" sub={cstat && cstat.enabled ? 'Enabled' : 'Disabled'}/>
        <BarStat label="Pending approvals" value={data.pending_count || 0} tone={(data.pending_count || 0) > 0 ? 'amber' : ''} icon="alert"/>
        <BarStat label="Entries today" value={(data.today && data.today.entrance) || 0} icon="arrow-left"/>
        <BarStat label="Exits today" value={(data.today && data.today.exit) || 0} icon="arrow-right"/>
        <BarStat label="Unknown vehicles" value={unknownCt} tone={unknownCt > 0 ? 'amber' : ''} icon="alert"/>
        <BarStat label="Failed / pending" value={failPend} tone={failPend > 0 ? 'amber' : ''} icon="shield"/>
      </div>
      <div className="bai-subtabs">
        {[['live', 'Live events', 'gauge'], ['simulate', 'Simulate', 'sparkle'], ['config', 'Configuration', 'cog'], ['safety', 'Safety', 'shield'], ['approvals', 'Approvals', 'card']].map(([k, l, ic]) => (
          <button key={k} className={`bai-subtab ${view === k ? 'active' : ''}`} onClick={() => setView(k)}><Icon name={ic} size={14}/> {l}{k === 'live' && (data.pending_count || 0) > 0 ? <span className="bai-subtab-badge">{data.pending_count}</span> : null}</button>
        ))}
      </div>

      {view === 'live' && (
        <div className="card">
          <div className="bai-filters">
            <select className="input" value={filt.direction} onChange={e => setFilt(s => ({ ...s, direction: e.target.value }))}><option value="">All directions</option><option value="entrance">Entrance</option><option value="exit">Exit</option></select>
            <select className="input" value={filt.status} onChange={e => setFilt(s => ({ ...s, status: e.target.value }))}><option value="">All statuses</option>{Object.keys(BAR_STATUS_TONE).map(s => <option key={s} value={s}>{barLabel(s)}</option>)}</select>
            <input className="input" placeholder="Vehicle number…" value={filt.vehicle} onChange={e => setFilt(s => ({ ...s, vehicle: e.target.value }))}/>
            <button className="btn btn-ghost btn-sm" onClick={reload}><Icon name="history" size={13}/> Refresh</button>
          </div>
          {snap.data == null && <div className="jce-empty">Loading…</div>}
          {snap.data != null && filtered.length === 0 && <div className="wc-empty"><Icon name="scan" size={24}/><div className="t">No detection events yet</div><div className="s">Use the Simulate tab to create one.</div></div>}
          <div className="bai-feed">{filtered.map(e => <BarEventRow key={e.id} e={e} role="admin" inlineActions onOpen={setOpenId} onAct={quickAct} busy={busy === e.id}/>)}</div>
        </div>
      )}

      {view === 'simulate' && <div className="card"><BarSimulatePanel onResult={reload}/><BarAiDetectPanel onResult={reload}/></div>}

      {view === 'config' && (
        <div className="card">
          {cfg == null && <div className="jce-empty">Loading…</div>}
          {cfg && <>
            <div className="bai-cfg-2col">
              <BarCameraCard direction="entrance" cam={camIn} onSaved={loadCfg}/>
              <BarCameraCard direction="exit" cam={camOut} onSaved={loadCfg}/>
            </div>
            <BarControllerCard controller={cfg.controller} cstatus={cstat} onSaved={loadCfg} onFlash={doFlash}/>
            <BarStreamPanel onResult={reload}/>
          </>}
        </div>
      )}

      {view === 'safety' && (
        <div className="card">
          <BarSafetyPanel cstatus={cstat} onFlash={doFlash} onReload={loadCfg}/>
          <BarPilotChecklist/>
        </div>
      )}

      {view === 'approvals' && <div className="card"><BarApprovalForms onFlash={doFlash} onOpen={setOpenId} onReload={reload}/></div>}

      {openId && <BarricadeEventDrawer id={openId} role="admin" onClose={() => setOpenId(null)} onChanged={reload}/>}
    </>
  );
};
window.LiveAdminBarricade = LiveAdminBarricade;

// ── MASTER page (branch-wise monitoring + global feed + drilldown + override) ──
const LiveMasterBarricade = () => {
  const [ov, setOv] = useJS(null);
  const [openId, setOpenId] = useJS(null);
  const [openBranch, setOpenBranch] = useJS(null);
  const [filt, setFilt] = useJS({ branch_id: '', direction: '', status: '', vehicle: '' });
  const [err, setErr] = useJS('');
  const [appr, setAppr] = useJS({ bills: [], temps: [] });
  const loadOv = useJC(() => { BW_API.masterBarricadeOverview().then(setOv).catch(e => setErr(e.message || 'Failed to load')); }, []);
  const loadAppr = useJC(() => { Promise.all([BW_API.masterBarricadeBillApprovals({ limit: '300' }).catch(() => []), BW_API.masterBarricadeTempApprovals({ limit: '300' }).catch(() => [])]).then(([bills, temps]) => setAppr({ bills: Array.isArray(bills) ? bills : [], temps: Array.isArray(temps) ? temps : [] })); }, []);
  useJE(() => { loadOv(); loadAppr(); }, [loadOv, loadAppr]);
  const fetchSnap = useJC(() => BW_API.masterBarricadeEvents({ limit: '60' })
    .then(evs => ({ events: Array.isArray(evs) ? evs : [] }))
    .catch(e => { setErr(e.message || 'Failed to load events'); return null; }), []);
  const snap = useBWSnapshot('/barricade', fetchSnap, [], 5000);
  const events = (snap.data && snap.data.events) || [];
  const reload = () => { snap.reload(); loadOv(); loadAppr(); };
  const cActiveBill = appr.bills.filter(b => b.status === 'approved' && b.payment_status === 'paid').length;
  const cActiveTemp = appr.temps.filter(t => t.status === 'active').length;
  const cPendingExit = events.filter(e => e.direction === 'exit' && e.status === 'pending_admin').length;
  const cUsed = appr.bills.filter(b => b.status === 'used').length + appr.temps.filter(t => t.status === 'used').length;
  const cExpired = appr.temps.filter(t => t.status === 'expired').length + appr.bills.filter(b => b.status === 'rejected').length;
  const totals = (ov && ov.totals) || {};
  const branches = (ov && ov.branches) || [];
  const filtered = events.filter(e => (!filt.branch_id || e.branch_id === filt.branch_id)
    && (!filt.direction || e.direction === filt.direction)
    && (!filt.status || e.status === filt.status)
    && (!filt.vehicle || (e.vehicle_number || '').toLowerCase().includes(filt.vehicle.toLowerCase())));
  return (
    <>
      <div className="content-head"><div><div className="eyebrow eyebrow-amber">● BARRICADE MONITORING</div><h1>Barricade monitoring</h1><span className="sub">Global · branch-wise entrance / exit automation</span></div></div>
      {err && <div className="jce-banner danger">{err}</div>}
      <div className="bai-stats">
        <BarStat label="Events" value={totals.events || 0} icon="scan"/>
        <BarStat label="Pending" value={totals.pending || 0} tone={(totals.pending || 0) > 0 ? 'amber' : ''} icon="alert"/>
        <BarStat label="Opened" value={totals.opened || 0} tone="ok" icon="check"/>
        <BarStat label="Denied" value={totals.denied || 0} tone={(totals.denied || 0) > 0 ? 'danger' : ''} icon="x"/>
        <BarStat label="Entries today" value={totals.entry_today || 0} icon="arrow-left"/>
        <BarStat label="Exits today" value={totals.exit_today || 0} icon="arrow-right"/>
      </div>
      <div className="bai-stats">
        <BarStat label="Active bill approvals" value={cActiveBill} tone={cActiveBill > 0 ? 'ok' : ''} icon="card"/>
        <BarStat label="Active temp approvals" value={cActiveTemp} tone={cActiveTemp > 0 ? 'ok' : ''} icon="clock"/>
        <BarStat label="Pending exit" value={cPendingExit} tone={cPendingExit > 0 ? 'amber' : ''} icon="alert"/>
        <BarStat label="Used approvals" value={cUsed} icon="check"/>
        <BarStat label="Expired / rejected" value={cExpired} icon="x"/>
      </div>
      {ov && ov.safety && (
        <div className="bai-stats">
          <BarStat label="Controllers" value={ov.safety.controllers || 0} icon="bolt" sub="hardware safety"/>
          <BarStat label="Emergency active" value={ov.safety.emergency_active || 0} tone={(ov.safety.emergency_active || 0) > 0 ? 'danger' : ''} icon="stop"/>
          <BarStat label="Controllers offline" value={ov.safety.controller_offline || 0} tone={(ov.safety.controller_offline || 0) > 0 ? 'amber' : ''} icon="alert"/>
          <BarStat label="Real relay enabled" value={ov.safety.real_relay_enabled || 0} tone={(ov.safety.real_relay_enabled || 0) > 0 ? 'amber' : ''} icon="shield" sub="opt-in"/>
          <BarStat label="Safety unknown" value={ov.safety.safety_unknown || 0} tone={(ov.safety.safety_unknown || 0) > 0 ? 'amber' : ''} icon="scan"/>
        </div>
      )}
      <div className="card">
        <div className="jce-sec-h"><Icon name="pin" size={14}/> Branches</div>
        {ov == null && <div className="jce-empty">Loading…</div>}
        {ov && branches.length === 0 && <div className="wc-empty"><Icon name="pin" size={24}/><div className="t">No barricade activity yet</div></div>}
        <div className="bai-branches">
          {branches.map(b => {
            const open = openBranch === (b.branch_id || 'none');
            return (
              <div key={b.branch_id || 'none'} className="bai-branch">
                <div className="bai-branch-head" onClick={() => { setOpenBranch(open ? null : (b.branch_id || 'none')); setFilt(s => ({ ...s, branch_id: open ? '' : (b.branch_id || '') })); }}>
                  <span className="jce-branch-chev"><Icon name={open ? 'chevron-down' : 'chevron-right'} size={15}/></span>
                  <div className="bai-branch-id"><Icon name="pin" size={14}/> <span className="nm">{b.branch_name || b.branch_id || '—'}</span></div>
                  <div className="bai-branch-tot">
                    <span><b>{b.events || 0}</b> events</span>
                    <span className="amber"><b>{b.pending || 0}</b> pending</span>
                    <span className="ok"><b>{b.opened || 0}</b> opened</span>
                    <span className="danger"><b>{b.denied || 0}</b> denied</span>
                    <span><Icon name="arrow-left" size={11}/> {b.entry_today || 0}</span>
                    <span><Icon name="arrow-right" size={11}/> {b.exit_today || 0}</span>
                  </div>
                </div>
                {open && <div className="bai-feed">{filtered.filter(e => e.branch_id === b.branch_id).slice(0, 12).map(e => <BarEventRow key={e.id} e={e} role="master" onOpen={setOpenId} onAct={() => {}}/>)}{filtered.filter(e => e.branch_id === b.branch_id).length === 0 && <div className="jce-empty sm">No recent events</div>}</div>}
              </div>
            );
          })}
        </div>
      </div>
      <div className="card">
        <div className="jce-sec-h"><Icon name="gauge" size={14}/> Global event feed</div>
        <div className="bai-filters">
          <select className="input" value={filt.branch_id} onChange={e => setFilt(s => ({ ...s, branch_id: e.target.value }))}><option value="">All branches</option>{branches.map(b => <option key={b.branch_id} value={b.branch_id}>{b.branch_name || b.branch_id}</option>)}</select>
          <select className="input" value={filt.direction} onChange={e => setFilt(s => ({ ...s, direction: e.target.value }))}><option value="">All directions</option><option value="entrance">Entrance</option><option value="exit">Exit</option></select>
          <select className="input" value={filt.status} onChange={e => setFilt(s => ({ ...s, status: e.target.value }))}><option value="">All statuses</option>{Object.keys(BAR_STATUS_TONE).map(s => <option key={s} value={s}>{barLabel(s)}</option>)}</select>
          <input className="input" placeholder="Vehicle number…" value={filt.vehicle} onChange={e => setFilt(s => ({ ...s, vehicle: e.target.value }))}/>
          <button className="btn btn-ghost btn-sm" onClick={reload}><Icon name="history" size={13}/> Refresh</button>
        </div>
        {snap.data == null && <div className="jce-empty">Loading…</div>}
        {snap.data != null && filtered.length === 0 && <div className="wc-empty"><Icon name="scan" size={24}/><div className="t">No events</div></div>}
        <div className="bai-feed">{filtered.map(e => <BarEventRow key={e.id} e={e} role="master" onOpen={setOpenId} onAct={() => {}}/>)}</div>
      </div>
      {openId && <BarricadeEventDrawer id={openId} role="master" onClose={() => setOpenId(null)} onChanged={reload}/>}
    </>
  );
};
window.LiveMasterBarricade = LiveMasterBarricade;

// ════════════════════════════════════════════════════════════════
//  Bike Test Drive — worker mobile GPS tracking page (Phase 2)
//  Real GPS only (navigator.geolocation). The backend is the source of
//  truth for final metrics — this page shows approximate LIVE values and
//  streams raw points; it never computes the final distance/speed/stops.
// ════════════════════════════════════════════════════════════════
const TD_CONSENT = 'Location tracking is active only during the assigned test drive. Tracking starts after you approve and connect this device, and stops when the admin completes the test drive.';
const TD_GEO_OPTS = { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 };

const tdToPoint = (pos) => {
  const c = (pos && pos.coords) || {};
  return {
    latitude: c.latitude, longitude: c.longitude,
    timestamp: new Date((pos && pos.timestamp) || Date.now()).toISOString(),
    speed_kmh: (c.speed != null && c.speed >= 0) ? Math.round(c.speed * 3.6 * 10) / 10 : null,
    accuracy_meters: (c.accuracy != null) ? Math.round(c.accuracy) : null,
    heading: (c.heading != null && !isNaN(c.heading)) ? Math.round(c.heading) : null,
    altitude: (c.altitude != null) ? c.altitude : null,
    source: 'browser_gps',
  };
};
const tdHMS = (sec) => {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return (h > 0 ? String(h).padStart(2, '0') + ':' : '') + String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
};
const TD_GPS = {
  good: ['ok', 'GPS LOCKED'], weak: ['warn', 'WEAK GPS'], searching: ['warn', 'SEARCHING…'],
  denied: ['danger', 'PERMISSION DENIED'], idle: ['ghost', 'GPS OFF'],
};

const TdRow = ({ l, v, mono }) => (
  <div className="td-row"><span className="td-l">{l}</span><span className={`td-v${mono ? ' mono' : ''}`}>{(v === 0 || v) ? v : '—'}</span></div>
);
const TdStat = ({ l, v, sub, tone }) => (
  <div className={`td-stat${tone ? ' ' + tone : ''}`}><div className="td-stat-v">{v}</div><div className="td-stat-l">{l}</div>{sub != null && <div className="td-stat-sub">{sub}</div>}</div>
);

const LiveWorkerTestDrive = () => {
  // NEW approval workflow: admin assigns → worker APPROVES & connects this device →
  // GPS streams (no silent tracking) → ADMIN alone completes → worker page detects it,
  // stops tracking, shows the summary. The worker has NO complete/end button.
  const [phase, setPhase] = useLS('loading');   // loading|none|pending_approval|ongoing|completed
  const [drive, setDrive] = useLS(null);
  const [consent, setConsent] = useLS(false);
  const [tracking, setTracking] = useLS(false);
  const [gps, setGps] = useLS({ status: 'idle', lat: null, lon: null, accuracy: null, speed: null, lastTs: null });
  const [sent, setSent] = useLS(0);
  const [pending, setPending] = useLS(0);
  const [sync, setSync] = useLS('idle');        // idle|syncing|ok|retry
  const [elapsed, setElapsed] = useLS(0);
  const [summary, setSummary] = useLS(null);
  const [err, setErr] = useLS('');
  const [busy, setBusy] = useLS(false);

  const watchRef = React.useRef(null);
  const queueRef = React.useRef([]);
  const flushRef = React.useRef(null);
  const tickRef = React.useRef(null);
  const drivingRef = React.useRef(false);
  const doneRef = React.useRef(false);
  const resumedRef = React.useRef(false);
  const startTsRef = React.useRef(0);
  const driveRef = React.useRef(null);
  const phaseRef = React.useRef(phase);
  useLE(() => { driveRef.current = drive; }, [drive]);
  useLE(() => { phaseRef.current = phase; }, [phase]);

  // a per-device continuity id (NOT auth) — lets the backend label which device approved
  const deviceId = () => {
    try {
      let id = localStorage.getItem('bw_worker_device_id');
      if (!id) { id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'dev-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10); localStorage.setItem('bw_worker_device_id', id); }
      return id;
    } catch (e) { return 'dev-' + Date.now(); }
  };

  const applyGps = (p) => {
    const weak = (p.accuracy_meters || 0) > 50;
    setGps({ status: weak ? 'weak' : 'good', lat: p.latitude, lon: p.longitude,
             accuracy: p.accuracy_meters, speed: p.speed_kmh, lastTs: Date.now() });
  };
  const stopWatch = () => { if (watchRef.current != null && navigator.geolocation) { try { navigator.geolocation.clearWatch(watchRef.current); } catch (e) {} } watchRef.current = null; };
  const stopFlush = () => { if (flushRef.current) { clearInterval(flushRef.current); flushRef.current = null; } };
  const stopTick = () => { if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; } };

  // admin completed the drive (server side) → stop tracking + show the final summary
  const finishFromServer = (s) => {
    if (doneRef.current) return;
    drivingRef.current = false; setTracking(false);
    stopWatch(); stopFlush(); stopTick();
    doneRef.current = true; setSummary(s || null); setPhase('completed');
  };

  const flush = async () => {
    const id = driveRef.current && driveRef.current.id;
    if (!id || !queueRef.current.length) return;
    const batch = queueRef.current.splice(0, queueRef.current.length);
    setPending(0); setSync('syncing');
    try {
      await BW_API.testDrivePoints(id, batch);
      setSent(c => c + batch.length); setSync('ok');
    } catch (e) {
      if (e.status === 403) {                            // ownership issue — stop
        drivingRef.current = false; setTracking(false); stopWatch(); stopFlush(); stopTick();
        setErr('This test drive belongs to another worker.'); setSync('retry');
      } else if (e.status === 409) {                     // drive no longer running = admin COMPLETED it
        stopWatch(); stopFlush(); stopTick();
        try { const s = await BW_API.testDriveMineStatus(id); finishFromServer(s); }
        catch (er) { finishFromServer(null); }
      } else {                                           // network/backend hiccup → requeue, retry (never drop)
        queueRef.current.unshift(...batch); setPending(queueRef.current.length); setSync('retry');
      }
    }
  };

  const onGeoErr = (geoErr, duringWatch) => {
    const code = geoErr && geoErr.code;
    if (code === 1) { setGps(g => ({ ...g, status: 'denied' })); setErr('Location permission denied. Enable location for this site in your browser, then reconnect.'); if (!duringWatch) setBusy(false); }
    else if (code === 3) { setGps(g => ({ ...g, status: 'weak' })); }   // timeout — keep retrying
    else { setGps(g => ({ ...g, status: 'weak' })); if (!duringWatch) { setErr('GPS signal unavailable. Move to open sky and try again.'); setBusy(false); } }
  };
  const onApiErr = (e) => {
    if (e.status === 403) setErr('You are not the assigned worker for this test drive.');
    else if (e.status === 409) setErr('This test drive cannot begin (already running or completed).');
    else if (e.status === 401) setErr('Your session has expired. Please log in again.');
    else setErr((e && e.message) || 'Request failed. Please try again.');
  };

  const beginWatch = () => {
    if (!navigator.geolocation || watchRef.current != null) return;
    watchRef.current = navigator.geolocation.watchPosition(
      (pos) => { if (!drivingRef.current) return; const p = tdToPoint(pos); applyGps(p); queueRef.current.push(p); setPending(queueRef.current.length); },
      (geoErr) => onGeoErr(geoErr, true), TD_GEO_OPTS);
  };
  const beginFlush = () => { stopFlush(); flushRef.current = setInterval(() => { flush(); }, 7000); };
  const beginTick = (anchorMs) => { stopTick(); startTsRef.current = anchorMs || Date.now(); setElapsed(Math.max(0, Math.floor((Date.now() - startTsRef.current) / 1000))); tickRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - startTsRef.current) / 1000)), 1000); };

  // begin (or resume) streaming GPS for an already-running/just-approved drive
  const startStreaming = (p, startedAtIso, fresh) => {
    if (fresh) { queueRef.current = []; setSent(0); setPending(0); }
    setSync('ok'); drivingRef.current = true; doneRef.current = false; setTracking(true);
    if (p) applyGps(p);
    beginWatch(); beginFlush();
    beginTick(startedAtIso ? new Date(startedAtIso).getTime() : Date.now());
  };

  // worker APPROVES tracking on this device → first GPS fix is required, then tracking starts
  const approveDevice = () => {
    setErr('');
    const dd = driveRef.current; if (!dd) return;
    if (!navigator.geolocation) { setErr('This device does not support GPS / geolocation.'); return; }
    setBusy(true); setGps(g => ({ ...g, status: 'searching' }));
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const p = tdToPoint(pos);
      try {
        const updated = await BW_API.testDriveApprove(dd.id, {
          latitude: p.latitude, longitude: p.longitude, timestamp: p.timestamp,
          accuracy_meters: p.accuracy_meters, speed_kmh: p.speed_kmh, heading: p.heading, altitude: p.altitude,
          source: 'browser_gps', device_id: deviceId(), user_agent: navigator.userAgent,
        });
        setDrive(updated || { ...dd, status: 'running' });
        setPhase('ongoing');
        startStreaming(p, updated && updated.started_at, true);
      } catch (e) { onApiErr(e); }
      finally { setBusy(false); }
    }, (geoErr) => onGeoErr(geoErr, false), TD_GEO_OPTS);
  };

  // re-acquire GPS after a denial / stale signal — no re-approval; the next /points
  // batch is the heartbeat that flips the device back to connected server-side
  const reconnect = () => {
    setErr(''); setBusy(true); setGps(g => ({ ...g, status: 'searching' }));
    if (!navigator.geolocation) { setErr('This device does not support GPS / geolocation.'); setBusy(false); return; }
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const p = tdToPoint(pos); applyGps(p);
      queueRef.current.push(p); setPending(queueRef.current.length);
      startStreaming(null, driveRef.current && driveRef.current.started_at, false);
      await flush().catch(() => {});
      setBusy(false);
    }, (geoErr) => { onGeoErr(geoErr, false); setBusy(false); }, TD_GEO_OPTS);
  };

  // resume an already-approved running drive on reload — silent (no re-prompt if granted)
  const resumeTracking = (dd) => {
    if (drivingRef.current || resumedRef.current || !navigator.geolocation) return;
    resumedRef.current = true;
    navigator.geolocation.getCurrentPosition((pos) => {
      const p = tdToPoint(pos); applyGps(p);
      queueRef.current.push(p); setPending(queueRef.current.length);
      startStreaming(null, dd.started_at, false);
    }, (geoErr) => onGeoErr(geoErr, false), TD_GEO_OPTS);
  };

  const reset = () => {
    doneRef.current = false; resumedRef.current = false;
    setSummary(null); setConsent(false); setSent(0); setPending(0); setElapsed(0); setErr('');
    setGps({ status: 'idle', lat: null, lon: null, accuracy: null, speed: null, lastTs: null });
    setPhase('loading');
  };

  // single poll: while ongoing → watch for the admin completing; else → discover a request
  useBWPoll(async () => {
    if (doneRef.current) return null;
    const cur = driveRef.current;
    if (cur && cur.id && (phaseRef.current === 'ongoing' || drivingRef.current)) {
      try {
        const s = await BW_API.testDriveMineStatus(cur.id);
        if (s && s.status === 'completed') { await flush().catch(() => {}); finishFromServer(s); return s; }
        if (s) setDrive(prev => ({ ...(prev || {}), ...s }));
        return s;
      } catch (e) { return null; }
    }
    try {
      const dd = await BW_API.testDriveMine();
      if (doneRef.current || drivingRef.current) return null;
      if (!dd) { setDrive(null); setPhase('none'); return null; }
      setDrive(dd);
      if (dd.status === 'running') { setPhase('ongoing'); resumeTracking(dd); }
      else setPhase('pending_approval');
      return dd;
    } catch (e) { if (e.status !== 401) setErr(e.message || 'Could not load your test drive'); return null; }
  }, [], 5000);

  // page-hide flush + hard cleanup (no background tracking after leaving the page)
  useLE(() => {
    const onHide = () => { if (drivingRef.current) flush(); };
    const onVis = () => { if (document.visibilityState === 'hidden') onHide(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', onHide);
      drivingRef.current = false; stopWatch(); stopFlush(); stopTick();
    };
  }, []);

  // ── render ──
  const Head = () => (
    <div className="content-head">
      <div>
        <div className="eyebrow eyebrow-amber" style={{ marginBottom: 8 }}>● BIKE TEST DRIVE</div>
        <h1>Test Drive Approval</h1>
        <span className="sub">Approve tracking on your device · the admin completes the drive</span>
      </div>
    </div>
  );
  const RequestCard = ({ d }) => (
    <div className="td-card">
      <div className="td-card-head"><div className="jf-section-ico veh"><Icon name="bike" size={14}/></div> {d.bike_model || 'Bike'} <span className="td-reg mono">{d.bike_registration || '—'}</span></div>
      <div className="td-rows">
        <TdRow l="Job Card" v={d.job_card_number} mono/>
        <TdRow l="Customer" v={d.customer_name}/>
        {d.service_worker_name && <TdRow l="Service Worker" v={d.service_worker_name}/>}
        <TdRow l="Assigned" v={d.assigned_at ? new Date(d.assigned_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}/>
        {d.started_at && <TdRow l="Started" v={new Date(d.started_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}/>}
        {d.notes && <TdRow l="Admin Note" v={d.notes}/>}
      </div>
    </div>
  );

  if (phase === 'loading') return (<><Head/><div className="td-empty"><div className="td-empty-ico"><Icon name="route" size={26}/></div><div className="t">Loading…</div></div></>);

  if (phase === 'none') return (
    <><Head/>
      <div className="td-empty">
        <div className="td-empty-ico"><Icon name="route" size={28}/></div>
        <h3>No test drive request assigned</h3>
        <p>When your admin assigns a bike test drive after a completed service, the request appears here. You then approve and connect this device to begin GPS tracking.</p>
        {err && <div className="td-alert danger" style={{ marginTop: 14 }}><Icon name="alert" size={14}/><div>{err}</div></div>}
      </div>
    </>
  );

  if (phase === 'completed') {
    const s = summary || {};
    return (
      <><Head/>
        <div className="td-wrap">
          <div className="td-banner ok"><span className="chip ok"><Icon name="check" size={12}/> TEST DRIVE COMPLETED</span><span className="td-banner-meta mono">Completed by admin · {s.job_card_number || ''}</span></div>
          <div className="td-summary">
            <TdStat l="Distance" v={`${(s.total_distance_km != null ? s.total_distance_km : 0)}`} sub="km"/>
            <TdStat l="Total Time" v={tdHMS(s.total_duration_seconds)} tone="amber"/>
            <TdStat l="Moving" v={tdHMS(s.moving_duration_seconds)}/>
            <TdStat l="Stopped" v={tdHMS(s.stop_duration_seconds)}/>
            <TdStat l="Avg Speed" v={`${s.average_speed_kmh != null ? s.average_speed_kmh : 0}`} sub="km/h"/>
            <TdStat l="Max Speed" v={`${s.max_speed_kmh != null ? s.max_speed_kmh : 0}`} sub="km/h"/>
            <TdStat l="Stops" v={`${s.stop_count != null ? s.stop_count : 0}`}/>
            <TdStat l="GPS Points" v={`${s.point_count != null ? s.point_count : sent}`}/>
          </div>
          <p className="td-note"><Icon name="shield" size={12}/> Tracking stopped. The admin completed this test drive and saved the route and metrics.</p>
          <button className="btn btn-amber td-btn" onClick={reset}><Icon name="check" size={16}/> DONE</button>
        </div>
      </>
    );
  }

  const d = drive || {};
  const [gTone, gLabel] = TD_GPS[gps.status] || TD_GPS.idle;
  const ageS = gps.lastTs ? Math.max(0, Math.round((Date.now() - gps.lastTs) / 1000)) : null;
  // honest device-connection state (no fake GPS)
  const denied = gps.status === 'denied';
  const stale = tracking && ageS != null && ageS > 120;
  const devState = (denied || !tracking) ? 'not' : (stale ? 'stale' : 'connected');
  const DEV = { connected: ['ok', 'DEVICE CONNECTED'], stale: ['warn', 'DEVICE STALE'], not: ['danger', 'DEVICE NOT CONNECTED'] };
  const [devTone, devLabel] = DEV[devState];

  return (
    <><Head/>
      <div className="td-wrap">
        <RequestCard d={d}/>

        {phase === 'pending_approval' && (
          <>
            <div className="td-consent">
              <div className="td-consent-head"><Icon name="shield" size={15}/> Location tracking consent</div>
              <p>{TD_CONSENT}</p>
              <div className="td-devstat"><span className="td-devstat-l">Device status</span><span className={`chip ${devTone}`}><span className={`dot ${devTone}`}/> {devLabel}</span></div>
              {!denied && <label className="td-check"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)}/> I understand and agree to GPS tracking for this test drive.</label>}
            </div>

            {denied ? (
              <>
                <div className="td-alert danger"><Icon name="alert" size={14}/><div><b>Device Not Connected — GPS permission denied.</b> Allow location permission for this site in your browser settings, then reconnect.</div></div>
                <button className="btn btn-amber td-btn" disabled={busy} onClick={approveDevice}>
                  <Icon name="pin" size={16}/> {busy ? 'CONNECTING…' : 'RECONNECT / TRY AGAIN'}
                </button>
              </>
            ) : (
              <>
                {err && <div className="td-alert danger"><Icon name="alert" size={14}/><div>{err}</div></div>}
                <button className="btn btn-amber td-btn" disabled={!consent || busy} onClick={approveDevice}>
                  <Icon name="play" size={16}/> {busy ? 'CONNECTING DEVICE…' : 'APPROVE & CONNECT DEVICE'}
                </button>
                <p className="td-note"><Icon name="pin" size={12}/> Approving requires a GPS fix from this device. Keep this page open during the ride.</p>
              </>
            )}
          </>
        )}

        {phase === 'ongoing' && (
          <>
            <div className="td-live ongoing">
              <div className="td-live-top">
                <span className="chip ongoing"><span className="dot ongoing pulsing"/> ONGOING</span>
                <span className={`chip ${devTone}`}><span className={`dot ${devTone}`}/> {devLabel}</span>
              </div>
              <div className="td-elapsed mono">{tdHMS(elapsed)}</div>
              <div className="td-elapsed-l">ELAPSED · WAITING FOR ADMIN TO COMPLETE</div>
            </div>

            {stale && !denied && (
              <div className="td-alert warn"><Icon name="alert" size={14}/><div>No recent GPS heartbeat — your device shows as stale. Stay on this page with location on, or reconnect.</div></div>)}
            {denied && (
              <div className="td-alert danger"><Icon name="alert" size={14}/><div><b>Device Not Connected.</b> Location permission was revoked — reconnect to keep recording the route.</div></div>)}
            {(gps.status === 'weak' || gps.status === 'searching') && !denied && (
              <div className="td-alert warn"><Icon name="alert" size={14}/><div>Weak GPS signal{gps.accuracy ? ` (±${gps.accuracy} m)` : ''} — move to open sky for a more accurate route.</div></div>)}

            <div className="td-summary">
              <TdStat l="Speed" v={gps.speed != null ? gps.speed : '—'} sub="km/h" tone={gTone === 'ok' ? '' : 'amber'}/>
              <TdStat l="Accuracy" v={gps.accuracy != null ? `±${gps.accuracy}` : '—'} sub="m" tone={(gps.accuracy || 0) > 50 ? 'amber' : ''}/>
              <TdStat l="Last Heartbeat" v={ageS != null ? `${ageS}s` : '—'} sub="ago" tone={stale ? 'danger' : ''}/>
              <TdStat l="Points Sent" v={sent}/>
              <TdStat l="Pending" v={pending} tone={pending > 0 ? 'amber' : ''}/>
              <TdStat l="Sync" v={sync === 'ok' ? 'OK' : sync === 'syncing' ? '…' : sync === 'retry' ? 'RETRY' : 'IDLE'} tone={sync === 'retry' ? 'danger' : sync === 'ok' ? '' : 'amber'}/>
            </div>

            {(denied || stale) && (
              <button className="btn btn-amber td-btn" disabled={busy} onClick={reconnect}>
                <Icon name="pin" size={16}/> {busy ? 'RECONNECTING…' : 'RECONNECT DEVICE'}
              </button>
            )}
            <p className="td-note"><Icon name="shield" size={12}/> Only the admin can complete this test drive. When they do, tracking stops here automatically and your summary appears.</p>
          </>
        )}
      </div>
    </>
  );
};
window.LiveWorkerTestDrive = LiveWorkerTestDrive;

// ════════════════════════════════════════════════════════════════
//  Admin · Bike Test Drive Tracking (Phase 3)
//  Reads the Phase 1 backend APIs only — the backend stays the source
//  of truth for every metric. Leaflet + OpenStreetMap (no Google) draws
//  the recorded route. Assign is sourced from COMPLETED jobs only.
// ════════════════════════════════════════════════════════════════
const TDT_STATUS = {
  assigned:  { cls: 'warn',    txt: 'ASSIGNED' },
  running:   { cls: 'ongoing', txt: 'ONGOING' },     // worker approved → tracking live
  completed: { cls: 'ok',      txt: 'COMPLETED' },
  cancelled: { cls: 'ghost',   txt: 'CANCELLED' },
  failed:    { cls: 'danger',  txt: 'FAILED' },
};
const tdtChip = (st) => TDT_STATUS[st] || { cls: 'ghost', txt: (st || '—').toUpperCase() };

// approval + device-connection chips (honest, heartbeat-based — no fake GPS)
const TDT_APPROVAL = {
  pending_approval: { cls: 'info',  txt: 'PENDING APPROVAL' },
  approved:         { cls: 'ok',    txt: 'APPROVED' },
  completed:        { cls: 'ghost', txt: 'COMPLETED' },
};
const tdtApprovalChip = (st) => TDT_APPROVAL[st] || { cls: 'ghost', txt: (st || '—').replace(/_/g, ' ').toUpperCase() };
const TDT_DEVICE = {
  not_connected: { cls: 'danger', txt: 'NOT CONNECTED' },
  connected:     { cls: 'ok',     txt: 'CONNECTED' },
  stale:         { cls: 'warn',   txt: 'STALE' },
  disconnected:  { cls: 'ghost',  txt: 'DISCONNECTED' },
};
const tdtDeviceChip = (st) => TDT_DEVICE[st] || { cls: 'ghost', txt: (st || '—').replace(/_/g, ' ').toUpperCase() };
const tdtHeartbeat = (s) => {
  if (s.status === 'completed' || s.status === 'cancelled' || s.status === 'failed') return '—';
  const age = s.device_heartbeat_age_seconds;
  if (age == null) return '—';
  if (age < 60) return `${age}s ago`;
  if (age < 3600) return `${Math.floor(age / 60)}m ago`;
  return `${Math.floor(age / 3600)}h ago`;
};
const tdtTime = (iso) => iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '—';
const tdtDateTime = (iso) => iso ? new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
const tdtSameDay = (iso, ref) => { if (!iso) return false; const d = new Date(iso); return d.getFullYear() === ref.getFullYear() && d.getMonth() === ref.getMonth() && d.getDate() === ref.getDate(); };
const tdtKm = (v) => (v != null ? Number(v).toFixed(2) : '0.00');
const tdtLatLng = (lat, lon) => (lat != null && lon != null) ? `${Number(lat).toFixed(5)}, ${Number(lon).toFixed(5)}` : '—';

// Leaflet route map — blue polyline, green start, black end, red stops.
const TdtMap = ({ points, stops }) => {
  const elRef = React.useRef(null);
  const mapRef = React.useRef(null);
  const valid = (points || []).filter(p => p && p.is_valid !== false && p.latitude != null && p.longitude != null);

  useLE(() => {
    if (!window.L || !elRef.current || valid.length < 1) return;
    const L = window.L;
    const latlngs = valid.map(p => [p.latitude, p.longitude]);
    let map;
    try { map = L.map(elRef.current, { zoomControl: true, attributionControl: true }); }
    catch (e) { return; }
    mapRef.current = map;
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OpenStreetMap contributors',
    }).addTo(map);

    const line = L.polyline(latlngs, { color: '#38bdf8', weight: 4, opacity: 0.9 }).addTo(map);
    const dot = (ll, fill, r) => L.circleMarker(ll, { radius: r || 7, color: '#0a0a0b', weight: 2, fillColor: fill, fillOpacity: 1 });
    dot(latlngs[0], '#4ade80', 8).addTo(map).bindTooltip('Start');
    dot(latlngs[latlngs.length - 1], '#18181b', 8).addTo(map).bindTooltip('End');
    (stops || []).forEach((st, i) => {
      if (st.latitude == null || st.longitude == null) return;
      dot([st.latitude, st.longitude], '#f43f5e', 9).addTo(map)
        .bindTooltip(`Stop ${i + 1} · ${tdHMS(st.duration_seconds)}`);
    });

    try {
      if (latlngs.length === 1) map.setView(latlngs[0], 16);
      else map.fitBounds(line.getBounds(), { padding: [28, 28] });
    } catch (e) { map.setView(latlngs[0], 14); }
    const t1 = setTimeout(() => { try { map.invalidateSize(); } catch (e) {} }, 160);
    const t2 = setTimeout(() => { try { map.invalidateSize(); } catch (e) {} }, 480);
    return () => { clearTimeout(t1); clearTimeout(t2); try { map.remove(); } catch (e) {} mapRef.current = null; };
  }, []);

  if (!window.L) return <div className="tdt-map-empty"><Icon name="pin" size={24}/><div>Map library unavailable — route can still be reviewed via the points below.</div></div>;
  if (valid.length < 1) return <div className="tdt-map-empty"><Icon name="route" size={24}/><div>No GPS points recorded yet for this test drive.</div></div>;
  return (
    <div className="tdt-map-box">
      {valid.length < 2 && <div className="tdt-map-warn"><Icon name="alert" size={12}/> Too few GPS points to draw a meaningful route.</div>}
      <div ref={elRef} className="tdt-map"/>
      <div className="tdt-legend">
        <span><i className="tdt-lg start"/> Start</span>
        <span><i className="tdt-lg end"/> End</span>
        <span><i className="tdt-lg stop"/> Stop</span>
        <span><i className="tdt-lg line"/> Route</span>
      </div>
    </div>
  );
};

// Assign a test drive — COMPLETED jobs only (backend re-validates status==completed).
const TdtAssignModal = ({ onClose, onAssigned }) => {
  const [jobs, setJobs] = useLS(null);
  const [workers, setWorkers] = useLS([]);
  const [sid, setSid] = useLS('');
  const [worker, setWorker] = useLS('');
  const [notes, setNotes] = useLS('');
  const [busy, setBusy] = useLS(false);
  const [err, setErr] = useLS('');

  useLE(() => {
    let alive = true;
    Promise.all([
      BW_API.workCompletion().catch(() => []),
      BW_API.workers().catch(() => []),
    ]).then(([comp, ws]) => { if (!alive) return; setJobs(Array.isArray(comp) ? comp : []); setWorkers(Array.isArray(ws) ? ws : []); });
    return () => { alive = false; };
  }, []);

  const submit = async () => {
    if (!sid) { setErr('Select a completed job first.'); return; }
    setBusy(true); setErr('');
    try {
      await BW_API.testDriveAssign({ service_session_id: sid, ...(worker ? { worker_id: worker } : {}), ...(notes ? { notes } : {}) });
      onAssigned();
    } catch (e) {
      setErr(e && e.message ? e.message : 'Could not assign test drive.');
    } finally { setBusy(false); }
  };

  return (
    <div className="modal-scrim" onClick={onClose} style={{ zIndex: 380 }}>
      <div className="modal tdt-modal" style={{ width: 480 }} onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div><div className="tdt-modal-t">Assign Test Drive</div><div className="tdt-modal-s">Completed jobs only · the assigned worker captures GPS</div></div>
          <button className="modal-close" onClick={onClose}><Icon name="x" size={15}/></button>
        </div>
        <div className="tdt-modal-body">
          <label className="tdt-fld">
            <span className="tdt-fld-l">Completed job</span>
            <select className="tdt-inp" value={sid} onChange={e => setSid(e.target.value)} disabled={jobs === null}>
              <option value="">{jobs === null ? 'Loading completed jobs…' : jobs.length ? 'Select a completed job…' : 'No completed jobs available'}</option>
              {(jobs || []).filter(j => j.session_id).map(j => (
                <option key={j.session_id} value={j.session_id}>
                  {(j.job_card_number || j.session_id.slice(0, 8))} · {j.vehicle || '—'}{j.registration ? ` (${j.registration})` : ''}{j.customer_name ? ` · ${j.customer_name}` : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="tdt-fld">
            <span className="tdt-fld-l">Worker <span className="tdt-fld-opt">(optional — defaults to the job's worker)</span></span>
            <select className="tdt-inp" value={worker} onChange={e => setWorker(e.target.value)}>
              <option value="">Use the job's assigned worker</option>
              {workers.filter(w => (w.status || 'active') === 'active').map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </label>
          <label className="tdt-fld">
            <span className="tdt-fld-l">Notes <span className="tdt-fld-opt">(optional)</span></span>
            <textarea className="tdt-inp" rows={2} value={notes} onChange={e => setNotes(e.target.value)} placeholder="e.g. Post-service road test on the highway loop"/>
          </label>
          <div className="tdt-assign-note"><Icon name="shield" size={12}/> A test drive can only be assigned after the service job is completed. The backend enforces this — incomplete jobs are never offered here.</div>
          <div className="tdt-assign-note amber"><Icon name="alert" size={12}/> The worker must <b>approve tracking from their device</b> before the test drive begins — assigning does not start GPS tracking.</div>
          {err && <div className="td-alert danger"><Icon name="alert" size={14}/><div>{err}</div></div>}
        </div>
        <div className="modal-foot">
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose}>CANCEL</button>
          <button className="btn btn-amber" style={{ flex: 1 }} disabled={busy || !sid} onClick={submit}>{busy ? 'ASSIGNING…' : 'ASSIGN TEST DRIVE'}</button>
        </div>
      </div>
    </div>
  );
};

// Admin-only completion — the ONLY way a test drive is completed (worker cannot).
const TdtCompleteModal = ({ row, onClose, onDone }) => {
  const [busy, setBusy] = useLS(false);
  const [err, setErr] = useLS('');
  const go = async () => {
    setBusy(true); setErr('');
    try { await BW_API.testDriveAdminComplete(row.id); onDone(); }
    catch (e) { setErr((e && e.message) || 'Could not complete the test drive.'); setBusy(false); }
  };
  return (
    <div className="modal-scrim" onClick={onClose} style={{ zIndex: 390 }}>
      <div className="modal tdt-modal" style={{ width: 440 }} onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div><div className="tdt-modal-t">Complete Test Drive</div><div className="tdt-modal-s">{row.job_card_number || '—'} · {row.bike_registration || '—'} · {row.worker_name || '—'}</div></div>
          <button className="modal-close" onClick={onClose}><Icon name="x" size={15}/></button>
        </div>
        <div className="tdt-modal-body">
          <p style={{ color: 'var(--t-1)', fontSize: 13.5, lineHeight: 1.6, margin: 0 }}>
            Complete this test drive and finalize tracking metrics? The route distance, durations, stops and speeds are computed by the backend, the device is released, and the route report becomes available.
          </p>
          <div className="tdt-assign-note" style={{ marginTop: 12 }}><Icon name="shield" size={12}/> Only an administrator can complete a test drive — the worker cannot.</div>
          {err && <div className="td-alert danger"><Icon name="alert" size={14}/><div>{err}</div></div>}
        </div>
        <div className="modal-foot">
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose}>CANCEL</button>
          <button className="btn btn-amber" style={{ flex: 1 }} disabled={busy} onClick={go}>{busy ? 'COMPLETING…' : 'COMPLETE TEST DRIVE'}</button>
        </div>
      </div>
    </div>
  );
};

// Route report image (Phase 4) — generated server-side (PIL + OSM), token-gated.
const TdtRouteImage = ({ session }) => {
  const [url, setUrl] = useLS('');
  const [loading, setLoading] = useLS(false);
  const [busy, setBusy] = useLS(false);
  const [err, setErr] = useLS('');
  const urlRef = React.useRef('');
  useLE(() => () => { if (urlRef.current) { try { URL.revokeObjectURL(urlRef.current); } catch (e) {} } }, []);

  const completed = session && session.status === 'completed';
  const load = async (regen) => {
    setErr(''); regen ? setBusy(true) : setLoading(true);
    try {
      if (regen) await BW_API.testDriveRegenImage(session.id);
      const u = await BW_API.testDriveRouteImage(session.id);
      if (urlRef.current) { try { URL.revokeObjectURL(urlRef.current); } catch (e) {} }
      urlRef.current = u; setUrl(u);
    } catch (e) {
      setErr(e.status === 409 ? 'The route image is available only after the test drive is completed.'
        : e.status === 400 ? 'Not enough valid GPS points to draw a route for this test drive.'
        : (e && e.message) || 'Could not load the route image.');
    } finally { setLoading(false); setBusy(false); }
  };

  // auto-load on open for a completed drive — the backend pre-generates it on
  // admin-complete, so the report image appears without a manual click (Regenerate stays).
  useLE(() => { if (completed && !urlRef.current && !loading) load(false); }, [session && session.id, completed]);

  if (!completed) return (
    <div className="tdt-card tdt-routeimg">
      <div className="tdt-card-head"><Icon name="pin" size={13}/> Route report image</div>
      <div className="tdt-empty-sm"><b className="tdt-warn-tag" style={{ marginRight: 8 }}>ROUTE IMAGE NOT READY</b>Available after the test drive is completed.</div>
    </div>
  );
  return (
    <div className="tdt-card tdt-routeimg">
      <div className="tdt-card-head"><Icon name="pin" size={13}/> Route report image
        {url && <button className="btn btn-ghost btn-xs" style={{ marginLeft: 'auto' }} disabled={busy} onClick={() => load(true)}>{busy ? '…' : 'Regenerate'}</button>}
      </div>
      {!url && !loading && !err && (
        <button className="btn btn-amber btn-sm" onClick={() => load(false)}><Icon name="pin" size={14}/> View Route Image</button>)}
      {loading && <div className="tdt-empty-sm">Generating route image… (dark-nav map + route)</div>}
      {err && <div className="td-alert danger"><Icon name="alert" size={14}/><div>{err}</div></div>}
      {url && <>
        <a href={url} target="_blank" rel="noopener noreferrer" title="Open full image"><img className="tdt-route-img" src={url} alt="Test drive route report"/></a>
        <div className="tdt-empty-sm" style={{ marginTop: 8 }}>Dark-navigation route report · tap to open full size.</div>
      </>}
    </div>
  );
};

// Detail drawer — full session metrics + Leaflet route + stops + quality warnings.
const TdtDetail = ({ id, onClose, onCancelled, onCompleted }) => {
  const [data, setData] = useLS(null);
  const [points, setPoints] = useLS(null);
  const [err, setErr] = useLS('');
  const [busy, setBusy] = useLS(false);
  const [confirmDone, setConfirmDone] = useLS(false);

  useLE(() => {
    let alive = true;
    setData(null); setPoints(null); setErr(''); setConfirmDone(false);
    Promise.all([
      BW_API.testDriveSummary(id),
      BW_API.testDrivePointsOf(id).catch(() => ({ items: [] })),
    ]).then(([sum, pts]) => { if (!alive) return; setData(sum); setPoints((pts && pts.items) || []); })
      .catch(e => { if (alive) setErr((e && e.message) || 'Could not load this test drive.'); });
    return () => { alive = false; };
  }, [id]);

  const doCancel = async () => {
    setBusy(true);
    try { await BW_API.testDriveCancel(id); adToast('Test drive cancelled', 'ok'); onCancelled(); }
    catch (e) { adToast((e && e.message) || 'Could not cancel', 'err'); setBusy(false); }
  };

  const doComplete = async () => {
    setBusy(true);
    try { await BW_API.testDriveAdminComplete(id); adToast('Test drive completed', 'ok'); (onCompleted || onCancelled)(); }
    catch (e) { adToast((e && e.message) || 'Could not complete', 'err'); setBusy(false); setConfirmDone(false); }
  };

  const s = data || {};
  const st = tdtChip(s.status);
  const pts = points || [];
  const invalid = pts.filter(p => p.is_valid === false).length;
  const lowAcc = pts.filter(p => (p.accuracy_meters || 0) > 50).length;
  const lastTs = pts.length ? pts[pts.length - 1].timestamp : null;
  const stale = s.status === 'running' && lastTs && (Date.now() - new Date(lastTs).getTime()) > 120000;
  const validCount = pts.filter(p => p.is_valid !== false && p.latitude != null).length;
  const stops = s.stops || [];
  const longStops = stops.filter(x => (x.duration_seconds || 0) >= 300).length;   // ≥5 min
  const active = s.status === 'assigned' || s.status === 'running';

  return (
    <div className="modal-scrim" onClick={onClose} style={{ placeItems: 'stretch end', zIndex: 360 }}>
      <div className="job-drawer tdt-drawer" onClick={e => e.stopPropagation()}>
        <div className="jd-head">
          <div className="jd-head-top">
            <span className="jd-jc mono">{s.job_card_number || (id ? id.slice(0, 8) : '')}</span>
            <div className="row" style={{ gap: 8 }}><span className={`chip ${st.cls}`}>{st.txt}</span><button className="modal-close" onClick={onClose}><Icon name="x" size={15}/></button></div>
          </div>
          <div className="jd-title">{s.bike_model || 'Bike'} <span className="td-reg mono" style={{ marginLeft: 8 }}>{s.bike_registration || '—'}</span></div>
          <div className="jd-sub"><Icon name="user" size={13}/> {s.worker_name || '—'}{s.customer_name ? ` · Customer: ${s.customer_name}` : ''}</div>
        </div>

        <div className="jd-scroll">
          {err && <div className="td-alert danger"><Icon name="alert" size={14}/><div>{err}</div></div>}
          {!data && !err && <div className="tdt-loading"><Icon name="route" size={22}/> Loading test drive…</div>}
          {data && <>
            <div className="td-summary tdt-metrics">
              <TdStat l="Distance" v={tdtKm(s.total_distance_km)} sub="km"/>
              <TdStat l="Total Time" v={tdHMS(s.total_duration_seconds)} tone="amber"/>
              <TdStat l="Moving" v={tdHMS(s.moving_duration_seconds)}/>
              <TdStat l="Stopped" v={tdHMS(s.stop_duration_seconds)}/>
              <TdStat l="Avg Speed" v={s.average_speed_kmh != null ? s.average_speed_kmh : 0} sub="km/h"/>
              <TdStat l="Max Speed" v={s.max_speed_kmh != null ? s.max_speed_kmh : 0} sub="km/h"/>
              <TdStat l="Stops" v={s.stop_count != null ? s.stop_count : stops.length}/>
              <TdStat l="GPS Points" v={s.point_count != null ? s.point_count : pts.length}/>
            </div>

            <div className="tdt-card">
              <div className="tdt-card-head"><Icon name="shield" size={13}/> Approval &amp; device</div>
              <div className="td-row"><span className="td-l">Approval</span><span className="td-v"><span className={`chip ${tdtApprovalChip(s.approval_status).cls}`}>{tdtApprovalChip(s.approval_status).txt}</span></span></div>
              <div className="td-row"><span className="td-l">Device</span><span className="td-v"><span className={`chip ${tdtDeviceChip(s.device_status).cls}`}>{tdtDeviceChip(s.device_status).txt}</span></span></div>
              <TdRow l="Last heartbeat" v={tdtHeartbeat(s)}/>
              <TdRow l="Approved at" v={tdtDateTime(s.worker_approved_at)}/>
              <TdRow l="Completed by admin" v={tdtDateTime(s.admin_completed_at)}/>
            </div>

            <div className="tdt-card">
              <div className="tdt-card-head"><Icon name="clock" size={13}/> Timeline</div>
              <TdRow l="Assigned" v={tdtDateTime(s.assigned_at)}/>
              <TdRow l="Started" v={tdtDateTime(s.started_at)}/>
              <TdRow l="Ended" v={tdtDateTime(s.ended_at)}/>
              <TdRow l="Job Card" v={s.job_card_number} mono/>
              <TdRow l="Start point" v={tdtLatLng(s.start_latitude, s.start_longitude)} mono/>
              <TdRow l="End point" v={tdtLatLng(s.end_latitude, s.end_longitude)} mono/>
            </div>

            {(invalid > 0 || lowAcc > 0 || stale || longStops > 0 || (validCount < 2 && s.status === 'completed')) && (
              <div className="tdt-warnstrip">
                {validCount < 2 && s.status === 'completed' && <div className="tdt-warn danger"><Icon name="alert" size={12}/><b className="tdt-warn-tag">FEW GPS POINTS</b><span>Too few valid GPS points — route may be incomplete.</span></div>}
                {stale && <div className="tdt-warn danger"><Icon name="alert" size={12}/><b className="tdt-warn-tag">STALE TRACKING</b><span>Running drive — no valid GPS point received in over 2 minutes.</span></div>}
                {longStops > 0 && <div className="tdt-warn danger"><Icon name="stop" size={12}/><b className="tdt-warn-tag">LONG STOP</b><span>{longStops} stop{longStops > 1 ? 's' : ''} of 5 minutes or more on this drive.</span></div>}
                {invalid > 0 && <div className="tdt-warn warn"><Icon name="alert" size={12}/><b className="tdt-warn-tag">INVALID GPS POINTS</b><span>{invalid} invalid point{invalid > 1 ? 's' : ''} rejected (out of range / implausible speed).</span></div>}
                {lowAcc > 0 && <div className="tdt-warn warn"><Icon name="alert" size={12}/><b className="tdt-warn-tag">LOW GPS ACCURACY</b><span>{lowAcc} low-accuracy point{lowAcc > 1 ? 's' : ''} (±&gt;50 m).</span></div>}
              </div>
            )}

            <div className="tdt-card">
              <div className="tdt-card-head"><Icon name="route" size={13}/> Route map <span className="tdt-card-meta">{validCount} valid · {pts.length} total</span></div>
              <TdtMap key={id} points={pts} stops={stops}/>
            </div>

            <div className="tdt-card">
              <div className="tdt-card-head"><Icon name="stop" size={13}/> Detected stops <span className="tdt-card-meta">{stops.length}</span></div>
              {stops.length === 0 && <div className="tdt-empty-sm">No stops detected on this test drive.</div>}
              {stops.map((sp, i) => {
                const long = (sp.duration_seconds || 0) >= 300;
                return (
                  <div key={sp.id || i} className={`tdt-stop${long ? ' long' : ''}`}>
                    <div className="tdt-stop-no">{i + 1}</div>
                    <div className="tdt-stop-body">
                      <div className="tdt-stop-top"><b>{tdHMS(sp.duration_seconds)}</b>{long && <span className="chip danger" style={{ fontSize: 9 }}>LONG STOP</span>}</div>
                      <div className="tdt-stop-meta mono">{tdtTime(sp.start_time)} → {tdtTime(sp.end_time)} · {tdtLatLng(sp.latitude, sp.longitude)}</div>
                    </div>
                  </div>
                );
              })}
            </div>

            <TdtRouteImage session={s}/>

            {s.status === 'running' && (
              <div className="tdt-action-card">
                {!confirmDone ? (
                  <button className="btn btn-amber" style={{ width: '100%' }} disabled={busy} onClick={() => setConfirmDone(true)}>
                    <Icon name="check" size={15}/> COMPLETE TEST DRIVE
                  </button>
                ) : (
                  <>
                    <div className="tdt-confirm-q">Complete this test drive and finalize tracking metrics?</div>
                    <div className="row" style={{ gap: 8 }}>
                      <button className="btn btn-ghost" style={{ flex: 1 }} disabled={busy} onClick={() => setConfirmDone(false)}>CANCEL</button>
                      <button className="btn btn-amber" style={{ flex: 1 }} disabled={busy} onClick={doComplete}>{busy ? 'COMPLETING…' : 'CONFIRM COMPLETE'}</button>
                    </div>
                  </>
                )}
                <div className="tdt-empty-sm" style={{ marginTop: 8 }}>Only an administrator can complete a test drive. The worker cannot.</div>
              </div>
            )}
            {s.status === 'assigned' && (
              <div className="tdt-empty-sm" style={{ marginBottom: 10 }}><b className="tdt-warn-tag" style={{ marginRight: 8 }}>WAITING FOR WORKER APPROVAL</b>The worker must approve &amp; connect their device before tracking begins.</div>
            )}
            {active && (
              <button className="btn td-end" style={{ width: '100%' }} disabled={busy} onClick={doCancel}>
                <Icon name="x" size={15}/> {busy ? 'CANCELLING…' : 'CANCEL TEST DRIVE'}
              </button>
            )}
          </>}
        </div>
      </div>
    </div>
  );
};

const LiveTestDriveTracking = () => {
  const [fStatus, setFStatus] = useLS('ALL');
  const [fWorker, setFWorker] = useLS('ALL');
  const [fFrom, setFFrom] = useLS('');
  const [fTo, setFTo] = useLS('');
  const [q, setQ] = useLS('');
  const [fDateType, setFDateType] = useLS('assigned');   // assigned | started | completed
  const [detailId, setDetailId] = useLS(null);
  const [showAssign, setShowAssign] = useLS(false);
  const [completeRow, setCompleteRow] = useLS(null);

  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const setQuick = (kind) => {
    const t = new Date(); t.setHours(0, 0, 0, 0);
    if (kind === 'today') { setFFrom(ymd(t)); setFTo(ymd(t)); }
    else if (kind === 'yesterday') { const y = new Date(t); y.setDate(t.getDate() - 1); setFFrom(ymd(y)); setFTo(ymd(y)); }
    else if (kind === '7d') { const s = new Date(t); s.setDate(t.getDate() - 6); setFFrom(ymd(s)); setFTo(ymd(t)); }
    else if (kind === 'month') { const s = new Date(t.getFullYear(), t.getMonth(), 1); setFFrom(ymd(s)); setFTo(ymd(t)); }
  };
  const quickIs = (kind) => {
    const t = new Date(); t.setHours(0, 0, 0, 0);
    if (kind === 'today') return fFrom === ymd(t) && fTo === ymd(t);
    if (kind === 'yesterday') { const y = new Date(t); y.setDate(t.getDate() - 1); return fFrom === ymd(y) && fTo === ymd(y); }
    if (kind === '7d') { const s = new Date(t); s.setDate(t.getDate() - 6); return fFrom === ymd(s) && fTo === ymd(t); }
    if (kind === 'month') { const s = new Date(t.getFullYear(), t.getMonth(), 1); return fFrom === ymd(s) && fTo === ymd(t); }
    return false;
  };

  const poll = useBWPoll(async () => {
    const res = await BW_API.testDrives({});
    return (res && res.items) || [];
  }, [], 6000);
  const items = poll.data || [];
  const loading = poll.loading && !poll.data;

  const now = new Date();
  const running = items.filter(s => s.status === 'running').length;
  const assigned = items.filter(s => s.status === 'assigned').length;
  const completedToday = items.filter(s => s.status === 'completed' && tdtSameDay(s.ended_at, now)).length;
  const done = items.filter(s => s.status === 'completed');
  const avgDur = done.length ? Math.round(done.reduce((a, s) => a + (s.total_duration_seconds || 0), 0) / done.length) : 0;
  const avgDist = done.length ? done.reduce((a, s) => a + (s.total_distance_km || 0), 0) / done.length : 0;
  const totalStop = items.reduce((a, s) => a + (s.stop_duration_seconds || 0), 0);
  const longStops = done.filter(s => (s.stop_duration_seconds || 0) >= 300).length;

  // distinct workers for the filter, derived from the data (no extra fetch)
  const workerOpts = [];
  const seen = {};
  items.forEach(s => { if (s.worker_id && !seen[s.worker_id]) { seen[s.worker_id] = 1; workerOpts.push({ id: s.worker_id, name: s.worker_name || s.worker_id.slice(0, 8) }); } });

  const dateField = fDateType === 'started' ? 'started_at' : fDateType === 'completed' ? 'ended_at' : 'assigned_at';
  const ql = q.trim().toLowerCase();
  const rows = items.filter(s => {
    if (fStatus !== 'ALL' && s.status !== fStatus) return false;
    if (fWorker !== 'ALL' && s.worker_id !== fWorker) return false;
    const dv = s[dateField];
    if (fFrom && (!dv || dv.slice(0, 10) < fFrom)) return false;
    if (fTo && (!dv || dv.slice(0, 10) > fTo)) return false;
    if (ql) {
      const hay = `${s.job_card_number || ''} ${s.bike_registration || ''} ${s.bike_model || ''} ${s.customer_name || ''} ${s.worker_name || ''}`.toLowerCase();
      if (!hay.includes(ql)) return false;
    }
    return true;
  });

  const reload = () => poll.reload();

  return (
    <>
      <AdToaster/>
      <div className="section-head">
        <div><h2>Bike Test Drive Tracking</h2><span className="sub">Real-GPS road tests · backend-authoritative metrics</span></div>
        <button className="btn btn-amber btn-sm" onClick={() => setShowAssign(true)}><Icon name="plus" size={14}/> Assign Test Drive</button>
      </div>

      <div className="tdt-cards">
        <div className="tdt-kpi ok"><div className="tdt-kpi-v">{running}</div><div className="tdt-kpi-l">Running now</div></div>
        <div className="tdt-kpi amber"><div className="tdt-kpi-v">{assigned}</div><div className="tdt-kpi-l">Assigned · not started</div></div>
        <div className="tdt-kpi"><div className="tdt-kpi-v">{completedToday}</div><div className="tdt-kpi-l">Completed today</div></div>
        <div className="tdt-kpi"><div className="tdt-kpi-v">{tdHMS(avgDur)}</div><div className="tdt-kpi-l">Avg duration</div></div>
        <div className="tdt-kpi"><div className="tdt-kpi-v">{tdtKm(avgDist)}<span className="u"> km</span></div><div className="tdt-kpi-l">Avg distance</div></div>
        <div className="tdt-kpi"><div className="tdt-kpi-v">{tdHMS(totalStop)}</div><div className="tdt-kpi-l">Total stop time</div></div>
        <div className={`tdt-kpi ${longStops > 0 ? 'danger' : ''}`}><div className="tdt-kpi-v">{longStops}</div><div className="tdt-kpi-l">Long-stop alerts (≥5m)</div></div>
      </div>

      <div className="tdt-filters">
        <div className="tdt-search"><Icon name="gauge" size={14}/><input value={q} onChange={e => setQ(e.target.value)} placeholder="Search job card, registration, customer, worker…"/></div>
        <select className="tdt-inp tdt-sel" value={fStatus} onChange={e => setFStatus(e.target.value)}>
          <option value="ALL">All statuses</option>
          <option value="assigned">Assigned</option>
          <option value="running">Running</option>
          <option value="completed">Completed</option>
          <option value="cancelled">Cancelled</option>
          <option value="failed">Failed</option>
        </select>
        <select className="tdt-inp tdt-sel" value={fWorker} onChange={e => setFWorker(e.target.value)}>
          <option value="ALL">All workers</option>
          {workerOpts.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <select className="tdt-inp tdt-sel" value={fDateType} onChange={e => setFDateType(e.target.value)} title="Which date the range filters on">
          <option value="assigned">Assigned date</option>
          <option value="started">Started date</option>
          <option value="completed">Completed date</option>
        </select>
        <input className="tdt-inp tdt-date" type="date" value={fFrom} onChange={e => setFFrom(e.target.value)} title={`${fDateType} from`}/>
        <input className="tdt-inp tdt-date" type="date" value={fTo} onChange={e => setFTo(e.target.value)} title={`${fDateType} to`}/>
        {(fStatus !== 'ALL' || fWorker !== 'ALL' || fFrom || fTo || q || fDateType !== 'assigned') &&
          <button className="btn btn-ghost btn-sm" onClick={() => { setFStatus('ALL'); setFWorker('ALL'); setFFrom(''); setFTo(''); setQ(''); setFDateType('assigned'); }}>Clear</button>}
      </div>
      <div className="tdt-quickbar">
        {[['today', 'Today'], ['yesterday', 'Yesterday'], ['7d', 'Last 7 days'], ['month', 'This month']].map(([k, l]) => (
          <span key={k} className={`tdt-quick ${quickIs(k) ? 'active' : ''}`} onClick={() => setQuick(k)}>{l}</span>
        ))}
      </div>

      <div className="tdt-table-wrap">
        <div className="tdt-table">
          <div className="tdt-row tdt-head">
            <span>#</span><span>Status</span><span>Approval</span><span>Device</span><span>Heartbeat</span>
            <span>Worker</span><span>Bike</span><span>Customer</span><span>Job Card</span>
            <span>Assigned</span><span>Started</span><span>Ended</span><span>Duration</span><span>Distance</span><span>Stops</span><span>Max</span><span>Route Image</span><span>Action</span>
          </div>
          {loading && [0, 1, 2].map(i => <div key={i} className="tdt-row tdt-skel"><span className="skel-line w70"/></div>)}
          {!loading && rows.length === 0 && (
            <div className="ops-none"><Icon name="route" size={26}/><div>{items.length === 0 ? 'No test drives yet — assign one from a completed job to start tracking.' : 'No test drives found for selected filters.'}</div></div>)}
          {!loading && rows.map((s, i) => {
            const c = tdtChip(s.status);
            const ap = tdtApprovalChip(s.approval_status);
            const dev = tdtDeviceChip(s.device_status);
            const done = s.status === 'completed';
            return (
              <div key={s.id} className="tdt-row tdt-data" role="button" tabIndex={0} onClick={() => setDetailId(s.id)}
                onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setDetailId(s.id))}>
                <span className="mono tdt-c-mut">{i + 1}</span>
                <span><span className={`chip ${c.cls}`}>{c.txt}</span></span>
                <span><span className={`chip ${ap.cls}`}>{ap.txt}</span></span>
                <span><span className={`chip ${dev.cls}`}>{dev.txt}</span></span>
                <span className="mono tdt-c-mut">{tdtHeartbeat(s)}</span>
                <span className="tdt-c-strong">{s.worker_name || '—'}</span>
                <span className="tdt-c-bike"><b className="mono">{s.bike_registration || '—'}</b><small>{s.bike_model || '—'}</small></span>
                <span>{s.customer_name || '—'}</span>
                <span className="mono">{s.job_card_number || '—'}</span>
                <span className="mono tdt-c-mut">{tdtDateTime(s.assigned_at)}</span>
                <span className="mono tdt-c-mut">{tdtTime(s.started_at)}</span>
                <span className="mono tdt-c-mut">{tdtTime(s.ended_at)}</span>
                <span className="mono">{s.total_duration_seconds ? tdHMS(s.total_duration_seconds) : '—'}</span>
                <span className="mono">{s.total_distance_km != null ? `${tdtKm(s.total_distance_km)} km` : '—'}</span>
                <span className="mono">{s.stop_count != null ? s.stop_count : '—'}</span>
                <span className="mono">{s.max_speed_kmh != null ? `${s.max_speed_kmh}` : '—'}</span>
                <span>{done
                  ? <button className="btn btn-ghost btn-xs" onClick={e => { e.stopPropagation(); setDetailId(s.id); }}>View</button>
                  : <span className="tdt-c-mut">Not ready</span>}</span>
                <span>{
                  s.status === 'running'
                    ? <button className="btn btn-amber btn-xs" onClick={e => { e.stopPropagation(); setCompleteRow(s); }}>Complete</button>
                    : s.status === 'assigned'
                      ? <span className="tdt-c-mut" title="The worker must approve & connect their device first">Awaiting approval</span>
                      : done
                        ? <button className="btn btn-ghost btn-xs" onClick={e => { e.stopPropagation(); setDetailId(s.id); }}>View report</button>
                        : <span className="tdt-c-mut">—</span>
                }</span>
              </div>
            );
          })}
        </div>
      </div>

      {detailId && <TdtDetail id={detailId} onClose={() => setDetailId(null)} onCancelled={() => { setDetailId(null); reload(); }} onCompleted={() => { setDetailId(null); reload(); }}/>}
      {showAssign && <TdtAssignModal onClose={() => setShowAssign(false)} onAssigned={() => { setShowAssign(false); adToast('Test drive assigned', 'ok'); reload(); }}/>}
      {completeRow && <TdtCompleteModal row={completeRow} onClose={() => setCompleteRow(null)} onDone={() => { setCompleteRow(null); adToast('Test drive completed', 'ok'); reload(); }}/>}
    </>
  );
};
window.LiveTestDriveTracking = LiveTestDriveTracking;


// ── Master · Global Overview (live) ─────────────────────────
const LiveMasterOverview = () => {
  const poll = useBWPoll(async () => {
    const [branches, analytics] = await settle([[BW_API.masterBranches(), []], [BW_API.masterAnalytics(), {}]]);
    return { branches: branches || [], analytics: analytics || {} };
  }, [], 3000);
  const d = poll.data || { branches: [], analytics: {} };
  const a = d.analytics;
  return (
    <>
      <div className="kpi-ribbon">
        <div className="kpi"><div className="l"><span className="dot live pulsing"/>BRANCHES</div><div className="v amber">{a.branches||d.branches.length}</div><div className="delta">live</div></div>
        <div className="kpi"><div className="l">COMPLETED JOBS</div><div className="v">{a.completed_jobs||0}</div><div className="delta">all branches</div></div>
        <div className="kpi"><div className="l">ON-TIME RATE</div><div className="v ok">{a.on_time_rate||0}<span className="unit">%</span></div><div className="delta">network</div></div>
        <div className="kpi"><div className="l">LIVE FEEDS</div><div className="v">{d.branches.reduce((s,b)=>s+(b.live_feeds||0),0)}</div><div className="delta">running now</div></div>
      </div>
      <div className="section-head"><div><h2>Branch health</h2><span className="sub">Live · backend connected</span></div><span className="chip ok mono"><span className="dot live pulsing"/>REAL-TIME</span></div>
      <div className="branch-health-grid">
        {d.branches.map(b=>(
          <div key={b.id} className="health-card">
            <div className="health-top"><div><div className="health-name">{b.name}</div><div className="health-id">{b.id}</div></div></div>
            <div className="health-stats">
              <div className="cell"><div className="v amber" style={{color:'var(--amber)'}}>{b.live_feeds||0}</div><div className="l">Live</div></div>
              <div className="cell"><div className="v">{b.bays||0}</div><div className="l">Bays</div></div>
              <div className="cell"><div className="v">{b.crew||0}</div><div className="l">Crew</div></div>
            </div>
            <div className="health-perf"><span className="lbl">Status</span><span className="pct" style={{color:'var(--ok)'}}>● {b.status||'operational'}</span></div>
          </div>
        ))}
      </div>
    </>
  );
};
window.LiveMasterOverview = LiveMasterOverview;

// ── Master · Bay Monitoring (live, view-only) ───────────────
// ════════════════════════════════════════════════════════════
//  Master · Bay Monitoring (live, view-only)
//  Branch cards → camera cards (live feed only while RUNNING)
//  → bay / worker / live timer + Details drawer
// ════════════════════════════════════════════════════════════
const mmPad = (n) => String(n).padStart(2, '0');

// live-ticking countdown seeded from the polled timer state
const MmLiveTimer = ({ timer, running, big }) => {
  const [rem, setRem] = useLS(Math.max(0, Math.round((timer && timer.remaining) || 0)));
  const baseRef = React.useRef({ rem: 0, at: Date.now() });
  React.useEffect(() => {
    const r = Math.max(0, Math.round((timer && timer.remaining) || 0));
    baseRef.current = { rem: r, at: Date.now() }; setRem(r);
  }, [timer && timer.remaining]);
  React.useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      const el = Math.floor((Date.now() - baseRef.current.at) / 1000);
      setRem(Math.max(0, baseRef.current.rem - el));
    }, 1000);
    return () => clearInterval(id);
  }, [running, timer && timer.remaining]);
  const over = (timer && timer.overtime || 0) > 0;
  const m = Math.floor(rem / 60), s = rem % 60;
  const txt = over ? `+${fmtMMSS(timer.overtime)}` : `${mmPad(m)}:${mmPad(s)}`;
  return <span className={`mm-timer${big ? ' big' : ''}`} style={{ color: over ? 'var(--danger)' : running ? 'var(--ok)' : 'var(--t-3)' }}>{txt}</span>;
};

// camera feed area — live only while running; paused / offline otherwise
const MmFeed = ({ bay }) => {
  const running = bay.session_status === 'running';
  const paused = bay.session_status === 'paused';
  // Truthful: a running bay with no paired camera has no real feed — show it
  // honestly instead of a fake live orb (backend gates live_feed_url the same way).
  if (running && bay.camera_paired === false) {
    return (
      <div className="mm-feed off mm-nocam">
        <div className="mm-feed-center"><div className="mm-feed-ico off"><Icon name="cam" size={24}/></div><div className="mm-feed-msg">NO CAMERA PAIRED</div><div className="mm-feed-sub">Service is running · recording unavailable for this bay</div></div>
      </div>
    );
  }
  if (running) {
    return (
      <div className="mm-feed live">
        <div className="mm-feed-scan"/>
        <div className="mm-feed-top">
          <span className="rec-badge"><span className="rec-dot"/>LIVE</span>
          <span className="mm-feed-ch">{bay.camera_channel} · 1080p · 60fps</span>
        </div>
        <div className="mm-feed-center"><div className="mm-feed-orb"><div className="mm-feed-orb-ring"/><Icon name="cam" size={22}/></div><div className="mm-feed-activity">WORKER ACTIVITY · SECURE STREAM</div></div>
        <div className="mm-feed-foot"><span>{bay.worker_name || '—'}</span><span className="mono">{bay.registration || bay.vehicle || ''}</span></div>
      </div>
    );
  }
  if (paused) {
    return (
      <div className="mm-feed paused">
        <div className="mm-feed-center"><div className="mm-feed-ico"><Icon name="pause" size={26}/></div><div className="mm-feed-msg">FEED PAUSED</div><div className="mm-feed-sub">Service temporarily paused by admin</div></div>
      </div>
    );
  }
  const label = bay.session_status === 'assigned' ? 'AWAITING START' : bay.bay_status === 'maintenance' ? 'MAINTENANCE' : 'NO ACTIVE FEED';
  const sub = bay.session_status === 'assigned' ? 'Camera turns on when admin starts the job' : 'Live feed appears only while a job is running';
  return (
    <div className="mm-feed off">
      <div className="mm-feed-center"><div className="mm-feed-ico off"><Icon name="cam" size={24}/></div><div className="mm-feed-msg">{label}</div><div className="mm-feed-sub">{sub}</div></div>
    </div>
  );
};

// service details drawer (view-only)
const MmDetails = ({ bay, branchName, onClose }) => {
  const Row = ({ l, v, mono }) => <div className="jd-row"><span className="jd-l">{l}</span><span className={`jd-v${mono ? ' mono' : ''}`}>{(v === 0 || v) ? v : <span className="jd-na">—</span>}</span></div>;
  const t = bay.timer || {};
  const running = bay.session_status === 'running';
  const recLabel = { recording: 'RECORDING', idle: 'IDLE', active: 'ACTIVE', expiring: 'EXPIRING', expired: 'EXPIRED' }[bay.recording_status] || (bay.recording_status || '—').toUpperCase();
  return (
    <div className="modal-scrim" onClick={onClose} style={{ placeItems: 'stretch end', zIndex: 360 }}>
      <div className="job-drawer" onClick={e => e.stopPropagation()}>
        <div className="jd-head">
          <div className="jd-head-top">
            <span className="jd-jc mono">BAY {mmPad(bay.bay_number)} · {bay.camera_channel}</span>
            <div className="row" style={{ gap: 8 }}>
              <span className={`chip ${running ? 'ok' : bay.session_status === 'paused' ? 'warn' : 'ghost'}`}>{running && <span className="dot ok pulsing"/>}{(bay.session_status || 'IDLE').toUpperCase()}</span>
              <button className="modal-close" onClick={onClose}><Icon name="x" size={15}/></button>
            </div>
          </div>
          <div className="jd-title">{bay.customer_name || bay.worker_name || `Bay ${mmPad(bay.bay_number)}`}</div>
          <div className="jd-sub"><Icon name="pin" size={13}/> {branchName} · {bay.worker_name ? `${bay.worker_name}${bay.employee_id ? ` · ${bay.employee_id}` : ''}` : 'No worker'}</div>
          {bay.session_id && (
            <div className="jd-summary">
              <div className="jd-stat"><div className="v">{bay.estimated_minutes || 0}<span>m</span></div><div className="l">Est. Time</div></div>
              <div className="jd-stat"><div className="v">{fmtMMSS(t.elapsed)}</div><div className="l">Elapsed</div></div>
              <div className="jd-stat"><div className="v" style={{ color: (t.overtime || 0) > 0 ? 'var(--danger)' : 'var(--ok)' }}>{(t.overtime || 0) > 0 ? `+${fmtMMSS(t.overtime)}` : fmtMMSS(Math.max(0, t.remaining || 0))}</div><div className="l">{(t.overtime || 0) > 0 ? 'Overtime' : 'Remaining'}</div></div>
            </div>
          )}
        </div>
        <div className="jd-scroll">
          {bay.session_id ? <>
            <div className="jd-card">
              <div className="jd-card-head"><span className="jd-ico cust"><Icon name="user" size={13}/></span> Service Details</div>
              <Row l="Customer" v={bay.customer_name}/><Row l="Job Card" v={bay.job_card_number} mono/>
              <Row l="Vehicle" v={bay.vehicle}/><Row l="Registration" v={bay.registration} mono/>
              <Row l="Service Type" v={bay.service_type}/><Row l="Worker" v={bay.worker_name}/>
              <Row l="Employee ID" v={bay.employee_id} mono/><Row l="Status" v={(bay.session_status || '').toUpperCase()}/>
              <Row l="Estimate" v={bay.estimate_source === 'approved'
                ? `Customer-approved${bay.approved_cost != null ? ` · ₹${Math.round(bay.approved_cost)}` : ''}`
                : 'Job-card estimate'}/>
              <Row l="Est. Time" v={bay.estimated_minutes ? `${bay.estimated_minutes} min` : '—'}/>
            </div>
            {(bay.start_warnings || []).length > 0 && (
              <div className="jd-card">
                <div className="jd-card-head"><span className="jd-ico doc"><Icon name="alert" size={13}/></span> Handoff Notes</div>
                {(bay.start_warnings || []).map((w, i) => <div key={i} className="mm-warn-row"><Icon name="alert" size={11}/> {w}</div>)}
              </div>
            )}
            <div className="jd-card">
              <div className="jd-card-head"><span className="jd-ico svc"><Icon name="cam" size={13}/></span> Camera &amp; Recording</div>
              <Row l="Camera" v={running ? (bay.camera_paired === false ? 'No camera paired' : 'LIVE') : bay.session_status === 'paused' ? 'PAUSED' : 'OFF'}/>
              <Row l="Recording" v={recLabel}/><Row l="Channel" v={bay.camera_channel} mono/>
              <Row l="Live Feed" v={running ? (bay.camera_paired === false ? 'Not available — no camera' : 'Streaming · secure') : 'Not available'}/>
            </div>
          </> : (
            <div className="jd-card"><div className="jd-card-head"><span className="jd-ico doc"><Icon name="route" size={13}/></span> Status</div>
              <div className="jd-na" style={{ fontSize: 13 }}>{bay.bay_status === 'maintenance' ? 'Bay under maintenance.' : 'Available — no active job. Live feed appears when a job is running.'}</div></div>
          )}
          <div className="mm-note"><Icon name="shield" size={13}/> View-only monitoring. Timer, camera and recording controls remain with the branch Admin.</div>
        </div>
      </div>
    </div>
  );
};

const MmCameraCard = ({ bay, onDetails }) => {
  const running = bay.session_status === 'running';
  const occupied = !!bay.session_id;
  // "LIVE" (green) only when a camera is actually streaming — a running bay with
  // no paired camera is honestly "RUNNING" (amber), never fake green.
  const liveCam = running && bay.camera_paired !== false;
  const statusChip = liveCam ? 'ok' : running ? 'warn' : bay.session_status === 'paused' ? 'warn' : 'ghost';
  const statusLabel = liveCam ? 'LIVE' : running ? 'RUNNING' : bay.session_status === 'paused' ? 'PAUSED' : bay.session_status === 'assigned' ? 'READY' : bay.bay_status === 'maintenance' ? 'MAINT' : 'OFFLINE';
  return (
    <div className={`mm-cam-card ${liveCam ? 'is-live' : ''}`}>
      <div className="mm-cam-head">
        <span className="mm-cam-bay">BAY <b>{mmPad(bay.bay_number)}</b></span>
        <span className={`chip ${statusChip}`}>{liveCam && <span className="dot ok pulsing"/>}{statusLabel}</span>
      </div>
      <MmFeed bay={bay}/>
      <div className="mm-cam-meta">
        <div className="mm-cam-worker">
          <div className="mm-cam-avatar">{(bay.worker_name || '—').split(' ').map(x => x[0]).join('').slice(0, 2) || '—'}</div>
          <div style={{ minWidth: 0 }}>
            <div className="mm-cam-name">{bay.worker_name || (occupied ? '—' : 'Unassigned')}</div>
            <div className="mm-cam-sub">{bay.service_type || bay.camera_channel}</div>
          </div>
        </div>
        <div className="mm-cam-timer">
          {occupied ? <MmLiveTimer timer={bay.timer} running={running}/> : <span className="mm-timer" style={{ color: 'var(--t-4)' }}>--:--</span>}
          <span className="mm-cam-timer-l">{running ? 'REMAINING' : bay.session_status === 'paused' ? 'PAUSED' : 'IDLE'}</span>
        </div>
      </div>
      {occupied && (bay.estimate_source === 'approved' || (bay.start_warnings || []).length > 0) && (
        <div className="mm-cam-flags">
          {bay.estimate_source === 'approved' && (
            <span className="mm-appr"><Icon name="check" size={10}/> Approved{bay.approved_cost != null ? ` · ₹${Math.round(bay.approved_cost)}` : ''}</span>
          )}
          {(bay.start_warnings || []).slice(0, 2).map((w, i) => (
            <span key={i} className="mm-warn" title={w}><Icon name="alert" size={10}/> {w}</span>
          ))}
        </div>
      )}
      <button className="btn btn-sm btn-ghost mm-cam-details" onClick={onDetails}><Icon name="gauge" size={12}/> DETAILS</button>
    </div>
  );
};

const LiveMasterMonitoring = () => {
  const poll = useBWPoll(() => BW_API.masterBayMonitoring(), [], 2000);
  const branches = poll.data || [];
  const [openId, setOpenId] = useLS(null);
  const [detailBay, setDetailBay] = useLS(null);

  const totalLive = branches.reduce((a, b) => a + (b.running || 0), 0);
  const open = branches.find(b => b.branch_id === openId);

  // Level 1 — branch cards
  if (!open) {
    return (
      <>
        <div className="section-head">
          <div><h2>Bay monitoring</h2><span className="sub">Live camera oversight · view-only · choose a branch</span></div>
          <span className="chip ok mono"><span className="dot live pulsing"/>{totalLive} LIVE FEED{totalLive !== 1 ? 'S' : ''}</span>
        </div>
        <div className="mon-view-note"><Icon name="shield" size={14}/> Master Admin can watch any live feed. Timer, recording and job controls remain with the branch Admin.</div>
        <div className="mm-branch-grid">
          {branches.map(b => (
            <div key={b.branch_id} className="mm-branch-card" onClick={() => setOpenId(b.branch_id)}>
              <div className="mm-branch-top">
                <div><div className="mm-branch-name">{b.branch_name}</div><div className="mm-branch-id">{b.branch_id}</div></div>
                <div className={`mm-branch-orb ${b.running > 0 ? 'live' : ''}`}>{b.running > 0 && <span className="mm-branch-orb-ring"/>}<Icon name="cam" size={18}/></div>
              </div>
              <div className="mm-branch-stats">
                <div className="cell"><div className="v">{b.total_bays}</div><div className="l">Bays</div></div>
                <div className="cell"><div className="v" style={{ color: b.running > 0 ? 'var(--ok)' : 'var(--t-1)' }}>{b.running}</div><div className="l">Live Now</div></div>
                <div className="cell"><div className="v" style={{ color: 'var(--amber)' }}>{b.occupied}</div><div className="l">Active Jobs</div></div>
              </div>
              <div className="mm-branch-go">VIEW CAMERAS <Icon name="arrow-right" size={13}/></div>
            </div>
          ))}
          {branches.length === 0 && <div className="cust-empty" style={{ gridColumn: '1 / -1' }}><div className="cust-empty-ico"><Icon name="cam" size={28}/></div><h3>No branches</h3></div>}
        </div>
      </>
    );
  }

  // Level 2 — camera cards for the chosen branch
  return (
    <>
      <div className="section-head">
        <div>
          <button className="btn btn-sm btn-ghost" style={{ marginBottom: 8 }} onClick={() => setOpenId(null)}><Icon name="arrow-left" size={12}/> ALL BRANCHES</button>
          <h2>{open.branch_name} · cameras</h2>
          <span className="sub">{open.total_bays} bays · {open.running} live · view-only monitoring</span>
        </div>
        <span className="chip ok mono"><span className="dot live pulsing"/>{open.running} LIVE</span>
      </div>
      <div className="mm-cam-grid">
        {open.bays.map(bay => (
          <MmCameraCard key={bay.bay_id} bay={bay} onDetails={() => setDetailBay(bay)}/>
        ))}
        {open.bays.length === 0 && <div className="cust-empty" style={{ gridColumn: '1 / -1' }}><div className="cust-empty-ico"><Icon name="cam" size={28}/></div><h3>No bays in this branch</h3></div>}
      </div>
      {detailBay && <MmDetails bay={open.bays.find(b => b.bay_id === detailBay.bay_id) || detailBay} branchName={open.branch_name} onClose={() => setDetailBay(null)}/>}
    </>
  );
};
window.LiveMasterMonitoring = LiveMasterMonitoring;

// ── Master · Global Analytics (live) ────────────────────────
const LiveMasterAnalytics = () => {
  const poll = useBWPoll(() => BW_API.masterAnalytics(), [], 4000);
  const a = poll.data || {};
  return (
    <>
      <div className="section-head"><div><h2>Global analytics</h2><span className="sub">Cross-branch · live</span></div></div>
      <div className="kpi-ribbon" style={{gridTemplateColumns:'repeat(3,1fr)'}}>
        <div className="kpi"><div className="l">BRANCHES</div><div className="v amber">{a.branches||0}</div></div>
        <div className="kpi"><div className="l">COMPLETED JOBS</div><div className="v">{a.completed_jobs||0}</div></div>
        <div className="kpi"><div className="l">ON-TIME RATE</div><div className="v ok">{a.on_time_rate||0}<span className="unit">%</span></div></div>
      </div>
    </>
  );
};
window.LiveMasterAnalytics = LiveMasterAnalytics;

// ── Admin dashboards · shared helpers (Worker Mgmt · Leave · Reports) ──
const adToday = () => { const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
const adInitials = (n) => ((n||'?').trim().split(/\s+/).map(x=>x[0]).join('').slice(0,2).toUpperCase()) || '?';
const adShortDate = (iso) => { if (!iso) return '—';
  try { return new Date(/T/.test(iso) ? iso : iso+'T00:00:00').toLocaleDateString('en-IN',{day:'2-digit',month:'short'}); }
  catch (e) { return iso; } };
const adFillCls = (v) => v >= 90 ? '' : (v >= 80 ? 'warn' : 'danger');
const adBay2 = (n) => `#${String(n).padStart(2,'0')}`;
const adMonthKey = (iso) => (iso ? String(iso).slice(0,7) : '');
// relative "last login": Never / 2h ago / Yesterday / 12 Jun
const adRelTime = (iso) => {
  if (!iso) return 'Never';
  try {
    const t = new Date(iso), now = new Date(), ms = now - t, mins = Math.floor(ms/60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins/60); if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs/24); if (days === 1) return 'Yesterday';
    if (days < 7) return `${days}d ago`;
    return t.toLocaleDateString('en-IN',{day:'2-digit',month:'short'});
  } catch (e) { return '—'; }
};
const adLoginStatus = (iso) => iso ? { cls:'ok', label:'Has logged in' } : { cls:'warn', label:'Never logged in' };
const adDeptList = ['Service Technician', 'Senior Technician', 'Supervisor', 'Store Manager'];
const adGenPassword = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789@#$%';
  let p = ''; for (let i = 0; i < 12; i++) p += chars[Math.floor(Math.random() * chars.length)];
  return p;
};
const adPwStrength = (p) => {
  if (!p) return { n:0, label:'' };
  let n = 0;
  if (p.length >= 8) n++;
  if (/[A-Z]/.test(p) && /[a-z]/.test(p)) n++;
  if (/\d/.test(p)) n++;
  if (/[^A-Za-z0-9]/.test(p)) n++;
  return { n, label: ['', 'Weak', 'Fair', 'Good', 'Strong'][n] };
};
const adStatusBadge = (s) => {
  const m = { active:{cls:'ok',label:'Active'}, inactive:{cls:'',label:'Inactive'},
    suspended:{cls:'warn',label:'Suspended'}, locked:{cls:'danger',label:'Locked'} };
  return m[s] || { cls:'', label: s || 'Active' };
};
// humanize an audit action code → label + timeline dot colour
const adAuditMeta = (a) => ({
  WORKER_CREATED:      { t:'Account created', dot:'info' },
  WORKER_UPDATED:      { t:'Details updated', dot:'' },
  WORKER_PASSWORD_RESET:{ t:'Password reset', dot:'warn' },
  WORKER_STATUS_CHANGED:{ t:'Status changed', dot:'warn' },
  WORKER_DELETED:      { t:'Account deleted', dot:'danger' },
  LOGIN:               { t:'Signed in', dot:'ok' },
}[a] || { t: a, dot:'' });

// ── shared toast system (replaces inline banners) ──
let _adToastSeq = 0;
const adToast = (msg, type = 'ok') => window.dispatchEvent(new CustomEvent('bw:adtoast', { detail: { msg, type, id: ++_adToastSeq } }));
const AdToaster = () => {
  const [items, setItems] = useLS([]);
  useLE(() => {
    const h = (e) => { const it = e.detail; setItems(s => [...s, it]);
      setTimeout(() => setItems(s => s.filter(x => x.id !== it.id)), 3600); };
    window.addEventListener('bw:adtoast', h);
    return () => window.removeEventListener('bw:adtoast', h);
  }, []);
  if (!items.length) return null;
  const ico = { ok:'check', err:'alert', info:'shield' };
  return (
    <div className="ad-toaster">
      {items.map(t => (
        <div key={t.id} className={`ad-toast ${t.type}`}>
          <span className="ico"><Icon name={ico[t.type]||'check'} size={15}/></span>
          <span className="msg">{t.msg}</span>
          <button className="x" onClick={()=>setItems(s=>s.filter(x=>x.id!==t.id))}><Icon name="x" size={13}/></button>
        </div>))}
    </div>
  );
};
// bay-utilization heat colour (0..1) → token-based background
// worker "current status" derived from the bay it owns (bay-first)
const adWorkerStatus = (active, bay) => {
  if (!active) return { cls: 'danger', label: 'Inactive' };
  if (!bay) return { cls: '', label: 'Unassigned' };
  const m = { running:{cls:'ok',label:'On Job'}, paused:{cls:'warn',label:'Paused'},
    available:{cls:'ok',label:'Available'}, maintenance:{cls:'warn',label:'Maintenance'},
    disabled:{cls:'danger',label:'Disabled'}, no_worker:{cls:'',label:'Idle'} };
  return m[bay.status] || { cls:'', label: bay.status };
};

const adSkRow = (cols, key) => (
  <div className="adash-skrow" key={key}>
    <div className="skel-block av"/>
    {cols.map((w,i)=><div key={i} className={`skel-line ${w}`} style={{flex:1}}/>)}
  </div>
);

// ── Admin · Worker Management (live) — identity management ──
const LiveWorkerManagement = () => {
  const poll = useBWPoll(async () => {
    const [workers, ops, perf, leave] = await settle([
      [BW_API.workers(), []], [BW_API.bayOperations(), { bays: [] }], [BW_API.workerPerformance(), []], [BW_API.leaveList(), []],
    ]);
    return { workers: workers || [], bays: (ops && ops.bays) || [], perf: perf || [], leave: leave || [] };
  }, [], 4000);
  const d = poll.data || { workers: [], bays: [], perf: [], leave: [] };
  const loading = poll.loading && !poll.data;
  const me = (window.BW_API && BW_API.currentUser && BW_API.currentUser()) || {};
  const isMaster = me.role === 'master_admin';
  const adFullTime = (iso) => { if (!iso) return '—'; try { return new Date(iso).toLocaleString('en-IN',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}); } catch (e) { return iso; } };

  // maps: worker → bay / job stats / on-leave / leave history
  const bayOf = {}; d.bays.forEach(b => { if (b.worker && b.worker.id) bayOf[b.worker.id] = b; });
  const today = adToday();
  const stat = {}; d.perf.forEach(r => { const s = (stat[r.worker_id] ||= { jobs:0, today:0, score:0, mins:0 }); s.jobs++; s.score += (r.score||0); s.mins += (r.actual||0); if ((r.date||'').slice(0,10)===today) s.today++; });
  const onLeaveIds = new Set(d.leave.filter(l => l.status==='approved' && l.from_date<=today && l.to_date>=today).map(l => l.worker_id));
  const leaveOf = {}; d.leave.forEach(l => { (leaveOf[l.worker_id] ||= []).push(l); });

  const [view, setView] = useLS(null);
  const [audit, setAudit] = useLS([]);
  const [menu, setMenu] = useLS(null);
  const [confirm, setConfirm] = useLS(null);
  const [modal, setModal] = useLS(null);     // 'create' | worker(edit)
  const [showPw, setShowPw] = useLS(false);
  const [q, setQ] = useLS(''); const [dept, setDept] = useLS('all'); const [stf, setStf] = useLS('all');
  const [bayF, setBayF] = useLS('all'); const [branchF, setBranchF] = useLS('all');
  const [loggedF, setLoggedF] = useLS(false); const [leaveF, setLeaveF] = useLS(false);
  const [sort, setSort] = useLS(() => { try { return JSON.parse(localStorage.getItem('bw_wm_sort')) || { key:'name', dir:1 }; } catch(e){ return { key:'name', dir:1 }; } });
  const [page, setPage] = useLS(1);
  const [msg, setMsg] = useLS(''); const [busy, setBusy] = useLS(false); const [busyId, setBusyId] = useLS(null);
  const [ferr, setFerr] = useLS({});
  const [density, setDensity] = useLS(() => localStorage.getItem('bw_wm_density') || 'comfortable');
  // persist table preferences so the workspace remembers how each admin works
  useLE(() => { try { localStorage.setItem('bw_wm_density', density); } catch(e){} }, [density]);
  useLE(() => { try { localStorage.setItem('bw_wm_sort', JSON.stringify(sort)); } catch(e){} }, [sort]);
  const blank = { name:'', mobile:'', email:'', address:'', emergency_contact:'', aadhaar:'', dob:'', joining_date:'',
    employee_id:'', department:'Service Technician', designation:'', assigned_bay:'', status:'active',
    username:'', password:'', password2:'' };
  const [f, setF] = useLS(blank);
  const set = (k,v) => setF(s => ({ ...s, [k]: v }));

  useLE(() => { if (!view) { setAudit([]); return; } let alive = true;
    BW_API.workerAudit(view).then(a => { if (alive) setAudit(a||[]); }).catch(()=>{});
    return () => { alive = false; }; }, [view]);
  const reloadAudit = () => { if (view) BW_API.workerAudit(view).then(a=>setAudit(a||[])).catch(()=>{}); };
  useLE(() => { setPage(1); }, [q, dept, stf, bayF, branchF, loggedF, leaveF]);
  // cross-page commands from the ⌘K palette (Create Worker / open a searched worker)
  useLE(() => {
    const onCmd = (e) => { const { cmd, id } = e.detail || {};
      if (cmd === 'workers:create') { setF({ ...blank }); setFerr({}); setShowPw(false); setModal('create'); }
      else if (cmd === 'workers:open' && id) { setView(id); }
    };
    window.addEventListener('bw:cmd', onCmd);
    return () => window.removeEventListener('bw:cmd', onCmd);
  }, []);

  // KPIs
  const total = d.workers.length;
  const cActive = d.workers.filter(w => (w.status||'active')==='active').length;
  const cSusp = d.workers.filter(w => w.status==='suspended' || w.status==='locked').length;
  const loggedToday = d.workers.filter(w => (w.last_login||'').slice(0,10)===today).length;
  const onLeave = d.workers.filter(w => onLeaveIds.has(w.id)).length;
  const assigned = d.workers.filter(w => bayOf[w.id]).length;
  const newThisMonth = d.workers.filter(w => adMonthKey(w.join_date)===adMonthKey(today)).length;
  const pct = (n) => total ? Math.round(n/total*100) : 0;

  const depts = ['all', ...Array.from(new Set(d.workers.map(w=>w.department).filter(Boolean)))];
  const branches = ['all', ...Array.from(new Set(d.workers.map(w=>w.branch_id).filter(Boolean)))];
  const branchBays = d.bays.filter(b => !me.branch_id || b.branch_id === me.branch_id || isMaster);

  const anyFilter = !!q || dept!=='all' || stf!=='all' || bayF!=='all' || (isMaster && branchF!=='all') || loggedF || leaveF;
  const clearFilters = () => { setQ(''); setDept('all'); setStf('all'); setBayF('all'); setBranchF('all'); setLoggedF(false); setLeaveF(false); };
  const toggle = (cur, val, setr) => setr(cur===val ? 'all' : val);

  const filtered = d.workers.filter(w => {
    if (q) { const t=`${w.name||''} ${w.employee_id||''} ${w.mobile||''} ${w.department||''}`.toLowerCase(); if (!t.includes(q.toLowerCase())) return false; }
    if (dept!=='all' && w.department!==dept) return false;
    if (stf!=='all' && (w.status||'active')!==stf) return false;
    if (bayF==='assigned' && !bayOf[w.id]) return false;
    if (bayF==='unassigned' && bayOf[w.id]) return false;
    if (isMaster && branchF!=='all' && w.branch_id!==branchF) return false;
    if (loggedF && (w.last_login||'').slice(0,10)!==today) return false;
    if (leaveF && !onLeaveIds.has(w.id)) return false;
    return true;
  });
  const sortVal = (w) => { const k=sort.key;
    if (k==='performance') { const s=stat[w.id]; return s && s.jobs ? s.score/s.jobs : -1; }
    if (k==='last_login') return w.last_login || '';
    return String(w[k]==null?'':w[k]).toLowerCase(); };
  const sorted = [...filtered].sort((a,b)=>{ const va=sortVal(a), vb=sortVal(b); return (va<vb?-1:va>vb?1:0)*sort.dir; });
  const PAGE_SIZE = 8;
  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const pageSafe = Math.min(page, pageCount);
  const paged = sorted.slice((pageSafe-1)*PAGE_SIZE, pageSafe*PAGE_SIZE);

  const openCreate = () => { setF({ ...blank }); setFerr({}); setShowPw(false); setModal('create'); };
  const openEdit = (w) => { setF({ ...blank, name:w.name||'', mobile:w.mobile||'', email:w.email||'', address:w.address||'',
    emergency_contact:w.emergency_contact||'', aadhaar:w.aadhaar||'', dob:(w.dob||'')||'', joining_date:(w.joining_date||'')||'',
    employee_id:w.employee_id||'', department:w.department||'Service Technician', designation:w.designation||'', status:w.status||'active' });
    setFerr({}); setMenu(null); setModal(w); };

  const act = async (fn, okMsg, id) => { setBusy(true); setBusyId(id||null); try { await fn(); adToast(okMsg,'ok'); setConfirm(null); setMenu(null); await poll.reload(); reloadAudit(); } catch(e){ adToast(e.message||'Action failed','err'); } finally { setBusy(false); setBusyId(null); } };

  const submit = async () => {
    const mode = modal === 'create' ? 'create' : 'edit';
    const fe = {};
    if (!f.name.trim()) fe.name = 'Full name is required';
    if (f.mobile && !/^[+\d][\d ]{7,}$/.test(f.mobile)) fe.mobile = 'Enter a valid mobile number';
    if (f.aadhaar && f.aadhaar.replace(/\D/g,'').length !== 12) fe.aadhaar = 'Aadhaar must be 12 digits';
    if (mode==='create') { if (!f.username.trim()) fe.username = 'Username is required';
      if ((f.password||'').length < 6) fe.password = 'At least 6 characters';
      if (f.password !== f.password2) fe.password2 = 'Passwords do not match'; }
    setFerr(fe);
    if (Object.keys(fe).length) { adToast('Please fix the highlighted fields','err'); return; }
    setBusy(true);
    try {
      if (mode==='create') {
        const payload = { name:f.name, mobile:f.mobile||null, email:f.email||null, address:f.address||null,
          emergency_contact:f.emergency_contact||null, aadhaar:f.aadhaar||null, department:f.department,
          designation:f.designation||null, status:f.status, branch_id: me.branch_id || 'LOC_CHN_01',
          username:f.username, password:f.password };
        if (f.employee_id) payload.employee_id = f.employee_id;
        if (f.dob) payload.dob = f.dob;
        if (f.joining_date) payload.joining_date = f.joining_date;
        const res = await BW_API.createWorker(payload);
        if (f.assigned_bay) { try { await BW_API.assignPrimaryWorker(f.assigned_bay, res.id); } catch (x) {} }
        adToast(`Worker onboarded · ${res.employee_id}`,'ok');
      } else {
        const payload = { name:f.name, mobile:f.mobile||null, email:f.email||null, address:f.address||null,
          emergency_contact:f.emergency_contact||null, aadhaar:f.aadhaar||null, department:f.department,
          designation:f.designation||null, status:f.status };
        if (f.dob) payload.dob = f.dob;
        if (f.joining_date) payload.joining_date = f.joining_date;
        await BW_API.updateWorker(modal.id, payload);
        adToast('Worker updated','ok');
      }
      setModal(null); await poll.reload(); reloadAudit();
    } catch (x) { adToast(x.message || 'Save failed','err'); } finally { setBusy(false); }
  };

  const exportCsv = (list, label) => { const cols=['employee_id','name','mobile','email','department','designation','status','branch_id','last_login'];
    const esc=(v)=>`"${String(v==null?'':v).replace(/"/g,'""')}"`;
    const csv=[cols.join(','), ...list.map(w=>cols.map(c=>esc(w[c])).join(','))].join('\n');
    const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
    a.download=`workers-${adToday()}.csv`; a.click();
    adToast(`${label} · ${list.length} row${list.length===1?'':'s'}`,'ok'); };
  const importCsv = async (file) => { try { const text=await file.text(); const lines=text.split(/\r?\n/).filter(l=>l.trim());
      if(lines.length<2){ adToast('CSV needs a header row + at least one worker','err'); return; }
      const head=lines[0].split(',').map(h=>h.trim().toLowerCase()); const idx=(n)=>head.indexOf(n); let ok=0,fail=0;
      for (let i=1;i<lines.length;i++){ const c=lines[i].split(',').map(x=>x.replace(/^"|"$/g,'').trim());
        const get=(n)=>{ const j=idx(n); return j>=0?(c[j]||''):''; };
        const name=get('name'), username=get('username'); if(!name||!username){ fail++; continue; }
        try { await BW_API.createWorker({ name, username, password:get('password')||'temp1234',
          mobile:get('mobile')||null, email:get('email')||null,
          department:get('department')||'Service Technician', branch_id: me.branch_id||'LOC_CHN_01' }); ok++; }
        catch(e){ fail++; } }
      await poll.reload(); adToast(`Import complete · ${ok} added${fail?`, ${fail} skipped`:''}`, fail?'info':'ok');
    } catch(e){ adToast('Could not read CSV file','err'); } };

  const menuActions = (w) => {
    const st = w.status || 'active';
    const out = [
      { label:'View details', icon:'user', fn:()=>{ setView(w.id); setMenu(null); } },
      { label:'Edit worker', icon:'edit', fn:()=>openEdit(w) },
      { label:'Reset password', icon:'shield', fn:()=>{ setMenu(null); setConfirm({ kind:'reset', w, pw:adGenPassword() }); } },
    ];
    if (st==='locked') out.push({ label:'Unlock account', icon:'shield', fn:()=>{ setMenu(null); setConfirm({ kind:'status', w, to:'active', verb:'Unlock' }); } });
    else out.push({ label:'Lock account', icon:'shield', fn:()=>{ setMenu(null); setConfirm({ kind:'status', w, to:'locked', verb:'Lock' }); } });
    if (st==='active') out.push({ label:'Deactivate', icon:'pause', fn:()=>{ setMenu(null); setConfirm({ kind:'status', w, to:'inactive', verb:'Deactivate' }); } });
    else out.push({ label:'Activate', icon:'check', fn:()=>{ setMenu(null); setConfirm({ kind:'status', w, to:'active', verb:'Activate' }); } });
    if (st!=='suspended') out.push({ label:'Suspend', icon:'alert', fn:()=>{ setMenu(null); setConfirm({ kind:'status', w, to:'suspended', verb:'Suspend' }); } });
    // Delete is Master-only and visually separated as a danger action; admins never see it.
    if (isMaster) out.push({ label:'Delete permanently', icon:'trash', danger:true, fn:()=>{ setMenu(null); setConfirm({ kind:'delete', w, typed:'' }); } });
    return out;
  };

  const pw = adPwStrength(f.password);
  const fileRef = React.useRef(null);
  const COLS = '34px 104px minmax(150px,1.5fr) minmax(120px,1fr) 70px 118px 110px 40px';
  const Th = ({ k, label }) => (
    <span className={`adash-th sortable ${sort.key===k?'on':''}`} role="button" tabIndex={0}
      onClick={()=>setSort(s=>({ key:k, dir: s.key===k ? -s.dir : 1 }))}
      onKeyDown={e=>e.key==='Enter'&&setSort(s=>({ key:k, dir: s.key===k ? -s.dir : 1 }))}>
      {label}{sort.key===k && <span className="adash-sort-caret">{sort.dir>0?'▲':'▼'}</span>}</span>
  );
  return (
    <>
      <AdToaster/>
      <div className="section-head">
        <div><h2>Worker management</h2><span className="sub">{total} workers · {cActive} active · {me.branch_id||'All branches'}</span></div>
        <div className="adash-tools">
          <input ref={fileRef} type="file" accept=".csv" style={{display:'none'}} onChange={e=>{ const fl=e.target.files[0]; if(fl) importCsv(fl); e.target.value=''; }}/>
          <button className="btn btn-ghost btn-sm" onClick={()=>fileRef.current&&fileRef.current.click()}><Icon name="upload" size={14}/> Import</button>
          <button className="btn btn-ghost btn-sm" onClick={()=>exportCsv(sorted,'Exported workers')}><Icon name="file" size={14}/> Export</button>
          <button className="btn btn-amber" onClick={openCreate}><Icon name="plus" size={15}/> Create Worker</button>
        </div>
      </div>

      <div className="adash-kpis">
        <div className={`adash-kpi clickable ${!anyFilter?'sel':''}`} role="button" tabIndex={0} onClick={clearFilters} onKeyDown={e=>(e.key==='Enter'||e.key===' ')&&clearFilters()}>
          <div className="adash-kpi-top"><div className="adash-kpi-ico"><Icon name="user" size={17}/></div></div>
          <div className="adash-kpi-v">{total}</div><div className="adash-kpi-l">Total workers</div>
          <div className="adash-kpi-trend up"><Icon name="plus" size={10}/> {newThisMonth} new this month</div></div>
        <div className={`adash-kpi clickable ok ${stf==='active'?'sel':''}`} role="button" tabIndex={0} onClick={()=>toggle(stf,'active',setStf)} onKeyDown={e=>e.key==='Enter'&&toggle(stf,'active',setStf)}>
          <div className="adash-kpi-top"><div className="adash-kpi-ico"><Icon name="bolt" size={17}/></div></div>
          <div className="adash-kpi-v">{cActive}</div><div className="adash-kpi-l">Active workers</div>
          <div className="adash-kpi-trend">{pct(cActive)}% of workforce</div></div>
        <div className={`adash-kpi clickable warn ${leaveF?'sel':''}`} role="button" tabIndex={0} onClick={()=>setLeaveF(!leaveF)} onKeyDown={e=>e.key==='Enter'&&setLeaveF(!leaveF)}>
          <div className="adash-kpi-top"><div className="adash-kpi-ico"><Icon name="calendar" size={17}/></div></div>
          <div className="adash-kpi-v">{onLeave}</div><div className="adash-kpi-l">On leave</div>
          <div className="adash-kpi-trend">today</div></div>
        <div className={`adash-kpi clickable danger ${stf==='suspended'?'sel':''}`} role="button" tabIndex={0} onClick={()=>toggle(stf,'suspended',setStf)} onKeyDown={e=>e.key==='Enter'&&toggle(stf,'suspended',setStf)}>
          <div className="adash-kpi-top"><div className="adash-kpi-ico"><Icon name="shield" size={17}/></div></div>
          <div className="adash-kpi-v">{cSusp}</div><div className="adash-kpi-l">Suspended accounts</div>
          <div className="adash-kpi-trend">{cSusp>0?'needs review':'all clear'}</div></div>
      </div>

      <div className="ops-toolbar">
        <div className="ops-search">
          <Icon name="scan" size={15}/>
          <input placeholder="Search name, employee ID, phone…" value={q} onChange={e=>setQ(e.target.value)}/>
          {q && <button className="ops-search-x" onClick={()=>setQ('')}><Icon name="x" size={14}/></button>}
        </div>
        <select className="ops-select" value={dept} onChange={e=>setDept(e.target.value)} aria-label="Department">
          {depts.map(dp=><option key={dp} value={dp}>{dp==='all'?'All departments':dp}</option>)}
        </select>
        <select className="ops-select" value={stf} onChange={e=>setStf(e.target.value)} aria-label="Status">
          {[['all','All statuses'],['active','Active'],['inactive','Inactive'],['suspended','Suspended'],['locked','Locked']].map(([s,lbl])=><option key={s} value={s}>{lbl}</option>)}
        </select>
        <select className="ops-select" value={bayF} onChange={e=>setBayF(e.target.value)} aria-label="Bay assignment">
          {[['all','All bays'],['assigned','Assigned'],['unassigned','Unassigned']].map(([s,lbl])=><option key={s} value={s}>{lbl}</option>)}
        </select>
        {isMaster && <select className="ops-select" value={branchF} onChange={e=>setBranchF(e.target.value)} aria-label="Branch">
          {branches.map(b=><option key={b} value={b}>{b==='all'?'All branches':b}</option>)}
        </select>}
        {anyFilter && <button className="adash-clear" onClick={clearFilters}><Icon name="x" size={12}/> Clear</button>}
        <div className="adash-seg" style={{marginLeft:'auto'}} role="group" aria-label="Row density">
          <button className={density==='comfortable'?'on':''} onClick={()=>setDensity('comfortable')} title="Comfortable rows" aria-label="Comfortable rows"><Icon name="queue" size={14}/></button>
          <button className={density==='compact'?'on':''} onClick={()=>setDensity('compact')} title="Compact rows" aria-label="Compact rows"><Icon name="dots" size={14}/></button>
        </div>
      </div>

      <div className={`adash-tbl ${density==='compact'?'compact':''}`}>
        <div className="adash-tr adash-head" style={{gridTemplateColumns:COLS}}>
          <span className="adash-th"/><Th k="employee_id" label="Employee ID"/><Th k="name" label="Full name"/>
          <Th k="department" label="Department"/><span className="adash-th">Bay</span>
          <Th k="status" label="Status"/><Th k="last_login" label="Last login"/><span className="adash-th"/>
        </div>
        <div className="adash-tbody">
          {loading && [0,1,2,3,4].map(i=>adSkRow(['w70','w45','w45','w45'], i))}
          {!loading && sorted.length===0 && (
            <div className="ops-none"><Icon name="user" size={26}/>
              <div>{total===0 ? 'No workers yet' : 'No workers match your filters'}</div>
              {total===0
                ? <><div className="ops-none-sub">Onboard your first crew member to start running workforce operations — or import an existing roster.</div>
                    <div className="ops-none-acts">
                      <button className="btn btn-amber btn-sm" onClick={openCreate}><Icon name="plus" size={13}/> Create worker</button>
                      <button className="btn btn-ghost btn-sm" onClick={()=>fileRef.current&&fileRef.current.click()}><Icon name="upload" size={13}/> Import CSV</button>
                    </div></>
                : (anyFilter && <button className="adash-clear" onClick={clearFilters}><Icon name="x" size={12}/> Clear filters</button>)}</div>)}
          {!loading && paged.map(w => {
            const bay = bayOf[w.id];
            const sb = onLeaveIds.has(w.id) ? { cls:'warn', label:'On Leave' } : adStatusBadge(w.status||'active');
            return (
              <div key={w.id} className="adash-tr" style={{gridTemplateColumns:COLS}} tabIndex={0}
                onKeyDown={e=>{ if(e.key==='Enter'){ setView(w.id); } }}>
                <Avatar id={w.employee_id||w.id} initials={adInitials(w.name)} size={32}/>
                <div className="adash-td" data-label="Employee ID"><span className="adash-num">{w.employee_id||'—'}</span></div>
                <div className="adash-td adash-td-primary" data-label="Full name" onClick={()=>setView(w.id)} style={{cursor:'pointer'}}><div style={{minWidth:0}}><div className="cell-name">{w.name}</div><span className="cell-meta">{w.designation||'Technician'}</span></div></div>
                <div className="adash-td" data-label="Department"><span className="adash-deptcell" title={w.department||''}>{w.department||'—'}</span></div>
                <div className="adash-td" data-label="Bay">{bay ? <span className="adash-num" style={{color:'var(--amber-bright)'}}>{adBay2(bay.bay_number)}</span> : <span className="cell-meta">—</span>}</div>
                <div className="adash-td" data-label="Status"><span className={`adash-st ${sb.cls}`}><span className="d"/>{sb.label}</span></div>
                <div className="adash-td" data-label="Last login"><span className="cell-meta" style={{fontSize:11,letterSpacing:0,color:w.last_login?'var(--t-2)':'var(--t-4)'}} title={adFullTime(w.last_login)}>{adRelTime(w.last_login)}</span></div>
                <div className="adash-td adash-td-r adash-acts" data-label="">
                  {busyId===w.id ? <span className="adash-spin"/> :
                    <button className="icon-btn" onClick={(e)=>{ const r=e.currentTarget.getBoundingClientRect(); setMenu({ w, x:r.right, y:r.bottom }); }} aria-label="Worker actions"><Icon name="dots" size={16}/></button>}</div>
              </div>
            );
          })}
        </div>
      </div>

      {!loading && sorted.length>0 && (
        <div className="adash-pager">
          <span className="adash-pager-info">{(pageSafe-1)*PAGE_SIZE+1}–{Math.min(pageSafe*PAGE_SIZE, sorted.length)} of {sorted.length}{anyFilter?` · filtered from ${total}`:''}</span>
          {pageCount>1 && <div className="adash-pager-ctrl">
            <button className="adash-pg-btn" disabled={pageSafe<=1} onClick={()=>setPage(pageSafe-1)} aria-label="Previous page"><Icon name="arrow-left" size={14}/></button>
            {Array.from({length:pageCount},(_,i)=>i+1).slice(Math.max(0,pageSafe-3), Math.max(0,pageSafe-3)+5).map(n=>(
              <button key={n} className={`adash-pg-btn ${n===pageSafe?'on':''}`} onClick={()=>setPage(n)}>{n}</button>))}
            <button className="adash-pg-btn" disabled={pageSafe>=pageCount} onClick={()=>setPage(pageSafe+1)} aria-label="Next page"><Icon name="arrow-right" size={14}/></button>
          </div>}
        </div>)}

      {menu && (<>
        <div className="adash-menu-scrim" onClick={()=>setMenu(null)}/>
        <div className="adash-menu" style={{ left: Math.max(12, menu.x - 196), top: menu.y + 6 }}>
          {menuActions(menu.w).map((a,i)=>(
            <React.Fragment key={i}>
              {a.danger && <div className="adash-menu-sep"/>}
              <button className={`adash-menu-item ${a.danger?'danger':''}`} onClick={a.fn}><Icon name={a.icon} size={14}/> {a.label}</button>
            </React.Fragment>))}
        </div>
      </>)}

      {confirm && confirm.kind==='reset' && (
        <div className="modal-scrim" onClick={()=>setConfirm(null)}>
          <div className="ops-confirm" onClick={e=>e.stopPropagation()}>
            <div className="ops-confirm-ico" style={{background:'var(--amber-soft)',color:'var(--amber-bright)'}}><Icon name="shield" size={18}/></div>
            <div className="ops-confirm-t">Reset password · {confirm.w.name}</div>
            <div className="ops-confirm-m">Set a new temporary password. The worker can sign in with it immediately; the old password stops working.</div>
            <div className="adash-pw"><input className="input" type={showPw?'text':'password'} value={confirm.pw} onChange={e=>setConfirm({...confirm,pw:e.target.value})}/>
              <button className="adash-pw-btn" onClick={()=>setShowPw(!showPw)}><Icon name="scan" size={13}/>{showPw?'Hide':'Show'}</button>
              <button className="adash-pw-btn" onClick={()=>setConfirm({...confirm,pw:adGenPassword()})}><Icon name="bolt" size={13}/>New</button></div>
            <div className="ops-confirm-foot">
              <button className="btn btn-ghost" onClick={()=>setConfirm(null)}>CANCEL</button>
              <button className="btn btn-amber" disabled={busy||(confirm.pw||'').length<6} onClick={()=>act(()=>BW_API.resetWorkerPassword(confirm.w.id, confirm.pw), 'Password reset ✓', confirm.w.id)}>{busy?<span className="adash-spin"/>:'RESET PASSWORD'}</button>
            </div>
          </div>
        </div>
      )}

      {confirm && confirm.kind==='status' && (
        <div className="modal-scrim" onClick={()=>setConfirm(null)}>
          <div className="ops-confirm" onClick={e=>e.stopPropagation()}>
            <div className="ops-confirm-ico"><Icon name="alert" size={18}/></div>
            <div className="ops-confirm-t">{confirm.verb} account · {confirm.w.name}</div>
            <div className="ops-confirm-m">{confirm.to==='active' ? 'The worker will be able to sign in again.' : 'The worker will be blocked from signing in until reactivated.'} This is recorded in the audit log.</div>
            <div className="ops-confirm-foot">
              <button className="btn btn-ghost" onClick={()=>setConfirm(null)}>CANCEL</button>
              <button className={`btn ${confirm.to==='active'?'btn-amber':'ops-danger-btn'}`} disabled={busy} onClick={()=>act(()=>BW_API.setWorkerStatus(confirm.w.id, confirm.to), `Account ${confirm.to}`, confirm.w.id)}>{busy?<span className="adash-spin"/>:confirm.verb.toUpperCase()}</button>
            </div>
          </div>
        </div>
      )}

      {confirm && confirm.kind==='delete' && (
        <div className="modal-scrim" onClick={()=>setConfirm(null)}>
          <div className="ops-confirm" onClick={e=>e.stopPropagation()}>
            <div className="ops-confirm-ico"><Icon name="trash" size={18}/></div>
            <div className="ops-confirm-t">Delete worker</div>
            <div className="ops-confirm-facts">
              {[['Worker',confirm.w.name],['Employee ID',confirm.w.employee_id||'—'],['Branch',confirm.w.branch_id||'—'],['Status',adStatusBadge(confirm.w.status||'active').label]].map(([k,v])=>(
                <div key={k} className="r"><span className="k">{k}</span><span className="v">{v}</span></div>))}
            </div>
            <div className="ops-confirm-m">This permanently removes the account and login. Type <b>DELETE</b> to continue.</div>
            <div className="ops-confirm-warn">
              <div className="wh"><Icon name="alert" size={13}/> Deletion will fail if this worker has:</div>
              <ul className="wl"><li>Service history</li><li>Leave history</li><li>Audit history</li></ul>
              <div className="wn">Use <b>Deactivate</b> instead to preserve report integrity.</div>
            </div>
            <input className="adash-confirm-input" value={confirm.typed} placeholder="DELETE" onChange={e=>setConfirm({...confirm,typed:e.target.value})}/>
            <div className="ops-confirm-foot">
              <button className="btn btn-ghost" onClick={()=>setConfirm(null)}>CANCEL</button>
              <button className="btn ops-danger-btn" disabled={busy||confirm.typed!=='DELETE'} onClick={()=>act(()=>BW_API.deleteWorker(confirm.w.id), 'Worker deleted', confirm.w.id).then(()=>setView(null))}>{busy?<span className="adash-spin"/>:'DELETE WORKER'}</button>
            </div>
          </div>
        </div>
      )}

      {view && (() => {
        const w = d.workers.find(x => x.id === view); if (!w) return null;
        const s = stat[w.id] || { jobs:0, today:0, score:0 };
        const avg = s.jobs ? Math.round(s.score/s.jobs) : null;
        const bay = bayOf[w.id];
        const sb = onLeaveIds.has(w.id) ? { cls:'warn', label:'On Leave' } : adStatusBadge(w.status||'active');
        const hist = (leaveOf[w.id]||[]).slice().sort((a,b)=>(b.applied_at||'').localeCompare(a.applied_at||''));
        const avgSvc = s.jobs ? Math.round((s.mins||0)/s.jobs) : null;
        return (
          <>
            <div className="adash-scrim" onClick={()=>setView(null)}/>
            <div className="adash-drawer wide">
              <div className="adash-dr-head">
                <Avatar id={w.employee_id||w.id} initials={adInitials(w.name)} size={46}/>
                <div className="nm"><div className="t">{w.name}</div><span className="cell-meta">{w.designation||'Technician'} · {w.employee_id||'—'}</span></div>
                <span className={`adash-st ${sb.cls}`}><span className="d"/>{sb.label}</span>
                <button className="modal-close" onClick={()=>setView(null)}><Icon name="x" size={16}/></button>
              </div>
              <div className="adash-dr-body">
                <div className="adash-sec">
                  <div className="adash-sec-h"><Icon name="user" size={12}/> Personal information</div>
                  <div className="adash-dl">
                    <div className="r"><div className="k">Full name</div><div className="vv">{w.name||'—'}</div></div>
                    <div className="r"><div className="k">Mobile</div><div className="vv">{w.mobile||'—'}</div></div>
                    <div className="r"><div className="k">Email</div><div className="vv">{w.email||'—'}</div></div>
                    <div className="r"><div className="k">Aadhaar</div><div className="vv">{w.aadhaar||'—'}</div></div>
                    <div className="r"><div className="k">Date of birth</div><div className="vv">{w.dob?adShortDate(w.dob):'—'}</div></div>
                    <div className="r full"><div className="k">Address</div><div className="vv">{w.address||'—'}</div></div>
                    <div className="r"><div className="k">Emergency contact</div><div className="vv">{w.emergency_contact||'—'}</div></div>
                  </div>
                </div>
                <div className="adash-sec">
                  <div className="adash-sec-h"><Icon name="briefcase" size={12}/> Employment information</div>
                  <div className="adash-dl">
                    <div className="r"><div className="k">Employee ID</div><div className="vv">{w.employee_id||'—'}</div></div>
                    <div className="r"><div className="k">Branch</div><div className="vv">{w.branch_id||'—'}</div></div>
                    <div className="r"><div className="k">Department</div><div className="vv">{w.department||'—'}</div></div>
                    <div className="r"><div className="k">Designation</div><div className="vv">{w.designation||'—'}</div></div>
                    <div className="r"><div className="k">Joining date</div><div className="vv">{w.join_date?adShortDate(w.join_date):'—'}</div></div>
                    <div className="r"><div className="k">Assigned bay</div><div className="vv">{bay?`Bay ${adBay2(bay.bay_number)}`:'Unassigned'}</div></div>
                    <div className="r"><div className="k">Status</div><div className="vv">{adStatusBadge(w.status||'active').label}</div></div>
                  </div>
                </div>
                <div className="adash-sec">
                  <div className="adash-sec-h"><Icon name="shield" size={12}/> Login credentials</div>
                  <div className="adash-dl">
                    <div className="r"><div className="k">Username</div><div className="vv">{w.username||'—'}</div></div>
                    <div className="r"><div className="k">Account status</div><div className="vv"><span className={`adash-st ${sb.cls}`} style={{padding:'2px 9px'}}><span className="d"/>{sb.label}</span></div></div>
                    <div className="r full"><div className="k">Last login</div><div className="vv">{adFullTime(w.last_login)}</div></div>
                  </div>
                  <button className="btn btn-ghost btn-sm" style={{justifySelf:'start',marginTop:4}} onClick={()=>setConfirm({ kind:'reset', w, pw:adGenPassword() })}><Icon name="shield" size={13}/> Reset password</button>
                </div>
                <div className="adash-sec">
                  <div className="adash-sec-h"><Icon name="calendar" size={12}/> Leave history</div>
                  {hist.length===0 ? <span className="cell-meta">No leave requests on record</span>
                    : hist.map(l=>(<div key={l.id} className="adash-lh"><span className={`d ${l.status==='approved'?'ok':l.status==='rejected'?'danger':'warn'}`}/><div className="info"><div className="t">{l.leave_type} · {l.days} {l.days>1?'days':'day'}</div><div className="s">{adShortDate(l.from_date)} → {adShortDate(l.to_date)} · {l.status}</div></div></div>))}
                </div>
                <div className="adash-sec">
                  <div className="adash-sec-h"><Icon name="gauge" size={12}/> Performance</div>
                  <div className="adash-dl">
                    <div className="r"><div className="k">Completed jobs</div><div className="vv">{s.jobs}{s.today?` · ${s.today} today`:''}</div></div>
                    <div className="r"><div className="k">Average service time</div><div className="vv">{avgSvc!==null?`${avgSvc} min`:'—'}</div></div>
                    <div className="r"><div className="k">Current bay</div><div className="vv">{bay?`Bay ${adBay2(bay.bay_number)}`:'Unassigned'}</div></div>
                    <div className="r full"><div className="k">Performance score</div><div className="vv">{avg!==null?<div style={{display:'flex',alignItems:'center',gap:10,marginTop:6}}><div className="perfbar" style={{flex:1,maxWidth:200}}><div className={`f ${adFillCls(avg)}`} style={{width:avg+'%'}}/></div><span style={{fontWeight:600,color:'var(--t-0)'}}>{avg}%</span></div>:'No completed jobs'}</div></div>
                  </div>
                </div>
                <div className="adash-sec">
                  <div className="adash-sec-h"><Icon name="history" size={12}/> Audit history</div>
                  {audit.length===0 ? <span className="cell-meta">No history yet</span>
                    : <div className="ops-tl">{audit.slice(0,30).map((a,i)=>{ const m=adAuditMeta(a.action); return (
                        <div key={i} className="ops-tl-row"><span className="ops-tl-time">{adShortDate((a.at||'').slice(0,10))}</span><span className={`ops-tl-dot ${m.dot}`}/><span className="ops-tl-label">{m.t} <span className="ops-tl-by">· {a.by_name} · {adFullTime(a.at)}</span></span></div>); })}</div>}
                </div>
              </div>
              <div className="modal-foot" style={{padding:'14px 22px',borderTop:'1px solid var(--hair)'}}>
                <button className="btn btn-ghost" style={{flex:1}} onClick={()=>{ const el=document.querySelector('.adash-drawer .modal-foot .btn-amber'); const r=el?el.getBoundingClientRect():{right:300,bottom:200}; setMenu({ w, x:r.right, y:r.bottom-160 }); }}><Icon name="dots" size={15}/> Actions</button>
                <button className="btn btn-amber" style={{flex:2}} onClick={()=>openEdit(w)}><Icon name="edit" size={15}/> EDIT WORKER</button>
              </div>
            </div>
          </>
        );
      })()}

      {modal && (() => {
        const mode = modal === 'create';
        const ferrIco = (m) => m ? <span className="fld-err"><Icon name="alert" size={11}/>{m}</span> : null;
        return (
          <>
            <div className="adash-scrim" onClick={()=>setModal(null)}/>
            <div className="ad-wizard">
              <div className="ad-wiz-head">
                <div className="ad-wiz-title"><span className="t">{mode?'Onboard worker':`Edit · ${modal.name}`}</span><button className="modal-close" onClick={()=>setModal(null)}><Icon name="x" size={16}/></button></div>
                <div className="ad-wiz-sub">{mode?'Create a worker identity and login credentials':'Update this worker’s profile and employment details'}</div>
              </div>
              <div className="ad-wiz-body">
                <div className="adash-fgroup">Personal Information</div>
                <div className={`fld float full ${ferr.name?'invalid':''}`}><input className="input" placeholder="Enter worker full name" value={f.name} onChange={e=>set('name',e.target.value)}/><label>Full name <span className="req">*</span></label>{ferrIco(ferr.name)}</div>
                <div className={`fld float ${ferr.mobile?'invalid':''}`}><input className="input" placeholder="Enter mobile number" value={f.mobile} onChange={e=>set('mobile',e.target.value)}/><label>Mobile number</label>{ferrIco(ferr.mobile)}</div>
                <div className="fld float"><input className="input" placeholder="Enter email address" value={f.email} onChange={e=>set('email',e.target.value)}/><label>Email</label></div>
                <div className={`fld float ${ferr.aadhaar?'invalid':''}`}><input className="input" placeholder="Enter Aadhaar number" value={f.aadhaar} onChange={e=>set('aadhaar',e.target.value)}/><label>Aadhaar number</label>{ferrIco(ferr.aadhaar)}</div>
                <div className="fld float"><input className="input" type="date" placeholder=" " value={f.dob} onChange={e=>set('dob',e.target.value)}/><label>Date of birth</label></div>
                <div className="fld float full"><input className="input" placeholder="Enter residential address" value={f.address} onChange={e=>set('address',e.target.value)}/><label>Address</label></div>
                <div className="fld float"><input className="input" placeholder="Enter emergency contact" value={f.emergency_contact} onChange={e=>set('emergency_contact',e.target.value)}/><label>Emergency contact</label></div>

                <div className="adash-fgroup">Employment Information</div>
                <div className="fld float"><input className="input" placeholder="Auto-generated (EMP-1001)" value={f.employee_id} onChange={e=>set('employee_id',e.target.value)} disabled={!mode}/><label>Employee ID</label></div>
                <div className="fld"><label>Branch</label><input className="input" value={me.branch_id||'—'} disabled/></div>
                <div className="fld"><label>Department</label><select className="input" value={f.department} onChange={e=>set('department',e.target.value)}>{adDeptList.map(x=><option key={x} value={x}>{x}</option>)}</select></div>
                <div className="fld float"><input className="input" placeholder="e.g. L2 Technician" value={f.designation} onChange={e=>set('designation',e.target.value)}/><label>Designation</label></div>
                {mode && <div className="fld"><label>Bay assignment (optional)</label><select className="input" value={f.assigned_bay} onChange={e=>set('assigned_bay',e.target.value)}><option value="">— none —</option>{branchBays.map(b=><option key={b.bay_id} value={b.bay_id}>Bay {adBay2(b.bay_number)}</option>)}</select></div>}
                <div className="fld float"><input className="input" type="date" placeholder=" " value={f.joining_date} onChange={e=>set('joining_date',e.target.value)}/><label>Joining date</label></div>

                {mode && <>
                  <div className="adash-fgroup">Login Credentials</div>
                  <div className={`fld full ${ferr.username?'invalid':''}`}><label>Username <span className="req">*</span></label><input className="input" value={f.username} onChange={e=>set('username',e.target.value)} placeholder="Enter login username"/><span className="adash-metric-sub" style={{marginTop:6}}>The worker signs in with this username</span>{ferrIco(ferr.username)}</div>
                  <div className={`fld full ${ferr.password?'invalid':''}`}><label>Password <span className="req">*</span></label><div className="adash-pw"><input className="input" type={showPw?'text':'password'} value={f.password} onChange={e=>set('password',e.target.value)} placeholder="Enter temporary password"/><button className="adash-pw-btn" onClick={()=>setShowPw(!showPw)}>{showPw?'Hide':'Show'}</button><button className="adash-pw-btn" onClick={()=>{const p=adGenPassword();setF(s=>({...s,password:p,password2:p}));setShowPw(true);}}><Icon name="bolt" size={13}/>Generate</button></div>
                    {f.password && <><div className={`adash-strength s${pw.n}`}><span className="seg"/><span className="seg"/><span className="seg"/><span className="seg"/></div><div className="adash-strength-l">Strength: {pw.label||'—'}</div></>}{ferrIco(ferr.password)}</div>
                  <div className={`fld full ${ferr.password2?'invalid':''}`}><label>Confirm password <span className="req">*</span></label><input className="input" type={showPw?'text':'password'} value={f.password2} onChange={e=>set('password2',e.target.value)} placeholder="Re-enter password"/>{ferrIco(ferr.password2)}</div>
                </>}

                <div className="adash-fgroup">System Access</div>
                <div className="fld"><label>Role</label><input className="input" value="Worker" disabled/></div>
                <div className="fld"><label>Account state</label><select className="input" value={f.status} onChange={e=>set('status',e.target.value)}><option value="active">Active</option><option value="inactive">Inactive</option><option value="suspended">Suspended</option></select></div>
              </div>
              <div className="ad-wiz-foot">
                <button className="btn btn-ghost" style={{flex:1}} onClick={()=>setModal(null)}>Cancel</button>
                <button className="btn btn-amber" style={{flex:2}} disabled={busy} onClick={submit}>{busy?<span className="adash-spin"/>:<><Icon name={mode?'plus':'check'} size={15}/> {mode?'Create worker':'Save changes'}</>}</button>
              </div>
            </div>
          </>
        );
      })()}
    </>
  );
};
window.LiveWorkerManagement = LiveWorkerManagement;

// ── Admin/Master · Work Completion (live, with recordings) ──
// ════════════════════════════════════════════════════════════
//  Admin / Master · Work Completion (live) — rolling window,
//  per-day exports, worker cards + table, branch drill-in, PDF
// ════════════════════════════════════════════════════════════
const LWC_COLS = '4px 50px 40px minmax(150px,1.3fr) 50px 50px 46px 52px 48px 46px 50px 112px 92px';
const lwcDK = (d) => { try { return new Date(d).toISOString().slice(0, 10); } catch (e) { return ''; } };

// (legacy landscape lwcGenPdf removed — replaced by lwcBuildCompletionReport)

// ════════════════════════════════════════════════════════════════════
//  Single-job Completion Report — detail modal + charts + PDF preview.
//  Opened from the row "View Job Report"; the bulk download buttons use
//  lwcBuildCompletionReport (beautiful smart-by-size report) instead.
//  No charting lib / no html2canvas exist here (Babel-standalone, no
//  bundler) → UI charts are inline SVG/DOM, PDF charts are jsPDF vectors.
//  All figures come from the enriched backend row — never faked.
// ════════════════════════════════════════════════════════════════════
const lwcMin = (m) => {
  if (m === null || m === undefined) return '—';
  const h = Math.floor(m / 60), mm = Math.round(m % 60);
  return h ? `${h}h ${String(mm).padStart(2, '0')}m` : `${mm}m`;
};
const lwcStatus = (r) => (r.overtime_min > 0 ? { label: 'Overtime', tone: 'danger' } : { label: 'On Time', tone: 'ok' });
const lwcPauseText = (r) => {
  if (!r.paused_known) return 'Not available';
  if ((r.pause_count || 0) === 0) return 'No pause recorded';
  return `${lwcMin(r.paused_min)} · ${r.pause_count}×`;
};

// Timer Breakdown — horizontal bars (DOM). Paused = reference only (muted).
const LWC_CHART = [
  ['est_min', 'Estimated', 'var(--info)'],
  ['actual_min', 'Actual Working', 'var(--ok)'],
  ['paused_min', 'Paused', 'var(--warn)'],
  ['overtime_min', 'Overtime', 'var(--danger)'],
];
const LwcBars = ({ row }) => {
  const data = LWC_CHART.map(([k, label, color]) => ({
    label, color,
    val: (k === 'paused_min' && !row.paused_known) ? null : (row[k] || 0),
  }));
  const max = Math.max(1, ...data.map(d => d.val || 0));
  return (
    <div className="lwc-bars">
      {data.map((d, i) => (
        <div key={i} className="lwc-bar-row">
          <span className="lwc-bar-lbl">{d.label}</span>
          <div className="lwc-bar-track">
            {d.val === null
              ? <span className="lwc-bar-na">Not available</span>
              : <div className="lwc-bar-fill" style={{ width: `${Math.max(2, (d.val / max) * 100)}%`, background: d.color }}/>}
          </div>
          <span className="lwc-bar-val">{d.val === null ? '—' : lwcMin(d.val)}</span>
        </div>
      ))}
    </div>
  );
};

// Work Timeline — Started → (paused) → Completed. Never fakes pause events.
const LwcTimelineViz = ({ row }) => {
  const paused = row.paused_known && (row.pause_count || 0) > 0;
  return (
    <div className="lwc-timeline">
      <div className="lwc-tl-rail">
        <span className="lwc-tl-node start" title="Started"/>
        <span className="lwc-tl-seg"/>
        {paused && <span className="lwc-tl-pausechip">{lwcMin(row.paused_min)} · {row.pause_count}×</span>}
        <span className="lwc-tl-seg"/>
        <span className="lwc-tl-node end" title="Completed"/>
      </div>
      <div className="lwc-tl-labels">
        <div><div className="t">STARTED</div><div className="v">{row.start_time || '—'}</div></div>
        <div className="mid">{paused ? `${row.pause_count} pause${row.pause_count > 1 ? 's' : ''} · ${lwcMin(row.paused_min)}` : 'No pause recorded'}</div>
        <div className="r"><div className="t">COMPLETED</div><div className="v">{row.end_time || '—'}</div></div>
      </div>
    </div>
  );
};

// Time Composition donut (SVG) — Working / Overtime / Pause(ref). Mirrors the
// PDF donut. Truthful: core = actual − overtime; pause is reference only.
const LwcDonut = ({ row }) => {
  const ot = row.overtime_min || 0, actual = row.actual_min || 0;
  const core = Math.max(0, actual - ot);
  const paused = row.paused_known ? (row.paused_min || 0) : 0;
  const segs = [['Working', core, 'var(--ok)'], ['Overtime', ot, 'var(--danger)'], ['Pause (ref)', paused, 'var(--warn)']];
  const total = segs.reduce((a, s) => a + s[1], 0);
  const clock = actual + paused;
  const R = 52, SW = 16, CIRC = 2 * Math.PI * R; let off = 0;
  return (
    <div className="lwc-donut-wrap">
      <svg viewBox="0 0 132 132" className="lwc-donut">
        <circle cx="66" cy="66" r={R} fill="none" stroke="var(--bg-3)" strokeWidth={SW}/>
        {total > 0 && segs.map((s, i) => {
          if (s[1] <= 0) return null;
          const len = (s[1] / total) * CIRC;
          const c = <circle key={i} cx="66" cy="66" r={R} fill="none" stroke={s[2]} strokeWidth={SW}
            strokeDasharray={`${len} ${CIRC - len}`} strokeDashoffset={-off} transform="rotate(-90 66 66)"/>;
          off += len; return c;
        })}
        <text x="66" y="63" textAnchor="middle" className="lwc-donut-c1">{lwcMin(clock)}</text>
        <text x="66" y="79" textAnchor="middle" className="lwc-donut-c2">{total > 0 ? 'TOTAL' : 'NO WORK'}</text>
      </svg>
      <div className="lwc-donut-legend">
        {segs.map((s, i) => (
          <div key={i} className="lwc-dl-row">
            <span className="dot" style={{ background: s[2] }}/><span className="lbl">{s[0]}</span><span className="val">{lwcMin(s[1])}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

// Timer Waterfall (vertical bars) — Estimated › Working › +OT › Pause(dashed,ref).
const LwcWaterfall = ({ row }) => {
  const est = row.est_min || 0, actual = row.actual_min || 0, ot = row.overtime_min || 0;
  const paused = row.paused_known ? (row.paused_min || 0) : 0;
  const bars = [['Est', est, 'var(--info)', lwcMin(est), false], ['Working', actual, 'var(--ok)', lwcMin(actual), false],
    ['+OT', ot, 'var(--danger)', '+' + lwcMin(ot), false], ['Pause', paused, 'var(--warn)', lwcMin(paused), true]];
  const max = Math.max(1, ...bars.map(b => b[1]));
  return (
    <div className="lwc-wf">
      {bars.map((b, i) => (
        <div key={i} className="lwc-wf-col">
          <div className="lwc-wf-v" style={{ color: b[2] }}>{b[3]}</div>
          <div className="lwc-wf-track">
            <div className={`lwc-wf-bar ${b[4] ? 'dashed' : ''}`}
              style={{ height: `${Math.max(3, (b[1] / max) * 100)}%`, background: b[4] ? 'transparent' : b[2], borderColor: b[2] }}/>
          </div>
          <div className="lwc-wf-lbl">{b[0]}</div>
        </div>
      ))}
    </div>
  );
};

// (legacy single-job lwcBuildReport removed — single-job preview now uses lwcBuildCompletionReport)

const lwcDateLong = (d) => { try { return new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); } catch (e) { return d || '—'; } };
const lwcHM = (m) => { m = Math.round(m || 0); const h = Math.floor(m / 60), mm = m % 60; return h ? `${h}h ${mm}m` : `${mm}m`; };

// ════════════════════════════════════════════════════════════════════
//  Canonical Work-Completion report (jsPDF). ONE generator → preview &
//  download, everywhere. Dark-header / white-body BAYWATCH design cloned
//  from the approved samples. Smart by SCOPE:
//   • single worker, 1..10 works               → per-job pages + Summary + All-Works table
//   • multi-worker / daily / weekly / >10 works → Summary + All-Works table only
//  EVERY scope with >=1 completed work ends with the All-Works table.
//  Capacity = workers × working-days × 9h (truthful utilization).
//  All charts vector-drawn (no html2canvas). Returns the jsPDF doc.
// ════════════════════════════════════════════════════════════════════
const lwcBuildCompletionReport = (title, subtitle, rows) => {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 32, CW = W - 2 * M;
  const C = {
    bg: [255, 255, 255], ink: [24, 24, 27], mut: [113, 113, 122], faint: [161, 161, 170],
    line: [228, 228, 231], zebra: [250, 250, 250], dark: [24, 24, 27], dark2: [39, 39, 42],
    amber: [255, 107, 26], green: [22, 163, 74], red: [220, 38, 38], yellow: [202, 138, 4], blue: [37, 99, 235], slate: [148, 163, 184],
    greenS: [220, 252, 231], redS: [254, 226, 226], blueS: [219, 234, 254], graphS: [244, 244, 245], amberS: [255, 237, 213],
  };
  const sf = (c) => doc.setFillColor(c[0], c[1], c[2]);
  const stx = (c) => doc.setTextColor(c[0], c[1], c[2]);
  const sd = (c) => doc.setDrawColor(c[0], c[1], c[2]);
  const ft = (s, w) => { doc.setFont('helvetica', w || 'normal'); doc.setFontSize(s); };
  const WORKDAY = 540;
  const core = (r) => Math.max(0, (r.actual_min || 0) - (r.overtime_min || 0));
  const pausedOf = (r) => (r.paused_known ? (r.paused_min || 0) : 0);
  const clockOf = (r) => (r.actual_min || 0) + pausedOf(r);

  const data = rows.map((r, i) => ({ ...r, _n: i + 1 }));
  const N = data.length;
  const sum = (f) => data.reduce((a, r) => a + (f(r) || 0), 0);
  const totEst = sum(r => r.est_min), totAct = sum(r => r.actual_min), totPause = data.reduce((a, r) => a + pausedOf(r), 0), totOt = sum(r => r.overtime_min);
  const onTimeN = data.filter(r => (r.overtime_min || 0) <= 0).length, overtN = N - onTimeN;
  const onPct = N ? Math.round(onTimeN / N * 100) : 0;
  const workers = [...new Set(data.map(r => r.worker_name).filter(Boolean))];
  const bays = [...new Set(data.map(r => r.bay_number).filter(v => v != null))].sort((a, b) => a - b);
  const dates = [...new Set(data.map(r => r.date).filter(Boolean))].sort();
  const branch = (data[0] && data[0].branch_name) || '';
  const empId = data[0] && data[0].employee_id;
  const oneWorker = workers.length === 1, oneBay = bays.length === 1, oneDay = dates.length === 1;
  const wName = oneWorker ? workers[0] : `${workers.length} workers`;
  const bayLabel = oneBay ? ('Bay ' + String(bays[0]).padStart(2, '0')) : '';
  // capacity (truthful): workers × working-days × 9h
  const capMin = Math.max(WORKDAY, workers.length * Math.max(1, dates.length) * WORKDAY);
  const productive = totAct, onTargetTot = Math.max(0, totAct - totOt);
  const remaining = Math.max(0, capMin - productive - totPause);
  const util = capMin ? Math.round(productive / capMin * 100) : 0;
  const capHrs = lwcHM(capMin);

  // detailed = single worker, 1..10 works → work pages + summary + table.
  // everything else (multi-worker / daily / weekly / 2-week / >10) → summary + table.
  // EVERY scope with >=1 work ends with the All-Works table (N=1 included).
  const detailed = oneWorker && N >= 1 && N <= 10;
  const ROWS = 18;
  const tablePages = Math.max(1, Math.ceil(N / ROWS));
  // Bike Test Drive Report final page — single-job completion report ONLY (never aggregates).
  const tdInfo = (N === 1 && data[0] && data[0]._test_drive) ? data[0]._test_drive : null;
  const tdPage = tdInfo ? 1 : 0;
  const totalPages = (detailed ? (N + 1 + tablePages) : (1 + tablePages)) + tdPage;

  const now = new Date().toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(',', '');
  let pageNo = 0, started = false;
  const newPage = () => { if (started) doc.addPage(); started = true; pageNo++; sf(C.bg); doc.rect(0, 0, W, H, 'F'); };

  const pill = (x, y, label, fg, bg, h) => { h = h || 15; ft(7, 'bold'); const w = doc.getTextWidth(label) + 16; sf(bg); doc.roundedRect(x, y, w, h, h / 2, h / 2, 'F'); stx(fg); doc.text(label, x + 8, y + h / 2 + 2.6); return w; };
  const pillsRight = (xr, y, items) => { const ws = items.map(it => { ft(7, 'bold'); return doc.getTextWidth(it[0]) + 16; }); let x = xr - (ws.reduce((a, b) => a + b, 0) + (items.length - 1) * 6); items.forEach((it, i) => { pill(x, y, it[0], it[1], it[2]); x += ws[i] + 6; }); };

  const header = (kicker, rLines) => {
    sf(C.dark); doc.rect(0, 0, W, 78, 'F');
    sf(C.amber); doc.roundedRect(M, 24, 30, 30, 7, 7, 'F'); stx([255, 255, 255]); ft(15, 'bold'); doc.text('B', M + 15, 44, { align: 'center' });
    stx([255, 255, 255]); ft(15, 'bold'); doc.text('BAYWATCH', M + 42, 36);
    stx([161, 161, 170]); ft(7.5, 'bold'); doc.text('SERVICE CENTER OS · ' + kicker, M + 42, 49);
    (rLines || []).forEach((ln, i) => { stx(ln[1] || [161, 161, 170]); ft(ln[2] || 7.5, ln[3] || 'normal'); doc.text(String(ln[0]), W - M, 32 + i * 12, { align: 'right' }); });
  };
  const footer = () => { sd(C.line); doc.setLineWidth(0.5); doc.line(M, H - 30, W - M, H - 30); ft(7, 'normal'); stx(C.faint); doc.text('BAYWATCH Service OS · Confidential · Branch-scoped', M, H - 18); doc.text(`${now} · Page ${pageNo} / ${totalPages}`, W - M, H - 18, { align: 'right' }); };
  const titleBlock = (t, sub) => { ft(20, 'bold'); stx(C.ink); doc.text(t, M, 104); if (sub) { ft(8.5, 'normal'); stx(C.mut); doc.text(sub, M, 118); } return 132; };
  const darkBar = (x, y, w, label, right) => { sf(C.dark); doc.roundedRect(x, y, w, 22, 5, 5, 'F'); stx([255, 255, 255]); ft(9, 'bold'); doc.text(label, x + 12, y + 14.5); if (right) { stx([161, 161, 170]); ft(7.5, 'normal'); doc.text(right, x + w - 12, y + 14.5, { align: 'right' }); } };
  const card = (x, y, w, h) => { sf(C.bg); sd(C.line); doc.setLineWidth(0.8); doc.roundedRect(x, y, w, h, 7, 7, 'FD'); };
  const sectionLbl = (x, y, t) => { stx(C.amber); ft(8, 'bold'); doc.text(t, x, y); };

  const metricCard = (x, y, w, h, m) => {
    card(x, y, w, h); sf(m.accent); doc.roundedRect(x + 12, y + 11, 22, 3, 1.5, 1.5, 'F');
    ft(6.5, 'bold'); stx(C.mut); doc.text(m.label.toUpperCase(), x + 12, y + 28);
    ft(16, 'bold'); stx(m.vc || C.ink); doc.text(String(m.value), x + 12, y + 47);
    ft(6.5, 'normal'); stx(C.faint); doc.text(m.sub || '', x + 12, y + 58);
  };
  const kpiCard = (x, y, w, h, m) => {
    card(x, y, w, h); sf(m.accent); doc.roundedRect(x + 10, y + 10, 18, 3, 1.5, 1.5, 'F');
    ft(6, 'bold'); stx(C.mut); doc.text(m.label.toUpperCase(), x + 10, y + 25);
    ft(15, 'bold'); stx(m.vc || C.ink); doc.text(String(m.value), x + 10, y + 42);
    ft(6, 'normal'); stx(C.faint); doc.text(m.sub || '', x + 10, y + 52);
  };
  const donut = (cx, cy, rO, rI, segs, c1, c2) => {
    const tot = segs.reduce((a, s) => a + s.v, 0) || 1; let ang = -Math.PI / 2;
    segs.forEach(s => { if (s.v <= 0) return; const sw = s.v / tot * 2 * Math.PI, steps = Math.max(2, Math.ceil(sw / 0.06)); sf(s.c); for (let i = 0; i < steps; i++) { const a0 = ang + sw * i / steps, a1 = ang + sw * (i + 1) / steps; doc.triangle(cx, cy, cx + rO * Math.cos(a0), cy + rO * Math.sin(a0), cx + rO * Math.cos(a1), cy + rO * Math.sin(a1), 'F'); } ang += sw; });
    sf(C.bg); doc.circle(cx, cy, rI, 'F');
    if (c1) { ft(13, 'bold'); stx(C.ink); doc.text(String(c1), cx, cy + 1, { align: 'center' }); }
    if (c2) { ft(6, 'normal'); stx(C.mut); doc.text(String(c2), cx, cy + 11, { align: 'center' }); }
  };
  // vertical bars (waterfall-style): cols [{label,v,color,dashed,vlabel}]
  const vbars = (x, y, w, h, cols) => {
    const plotH = h - 26, baseY = y + 16 + plotH, maxV = Math.max(1, ...cols.map(c => Math.abs(c.v)));
    sd(C.line); doc.setLineWidth(0.5); doc.line(x, baseY, x + w, baseY);
    const n = cols.length, slot = w / n;
    cols.forEach((c, i) => {
      const cx = x + slot * i + slot / 2, bw = Math.min(36, slot - 18), bh = Math.max(1, Math.abs(c.v) / maxV * plotH), bx = cx - bw / 2, top = baseY - bh;
      if (c.dashed) { sd(c.color); doc.setLineWidth(1); doc.setLineDashPattern([2, 1.5], 0); doc.roundedRect(bx, top, bw, bh, 1.5, 1.5, 'D'); doc.setLineDashPattern([], 0); }
      else { sf(c.color); doc.roundedRect(bx, top, bw, bh, 1.5, 1.5, 'F'); }
      ft(7, 'bold'); stx(c.color); doc.text(c.vlabel, cx, top - 4, { align: 'center' });
      ft(6.5, 'normal'); stx(C.mut); doc.text(c.label, cx, baseY + 11, { align: 'center' });
    });
  };

  // ── PER-WORK PAGE ──
  const workPage = (r, idx) => {
    newPage();
    const ot = r.overtime_min || 0, early = (r.actual_min || 0) < (r.est_min || 0) && ot <= 0;
    header('WORKER COMPLETION REPORT', [[r.worker_name, C.amber, 9, 'bold'], [`${r.employee_id || ''} · ${r.date || ''}`], [`${'Bay ' + String(r.bay_number || 0).padStart(2, '0')} · Work ${idx + 1} of ${N}`]]);
    ft(20, 'bold'); stx(C.ink); doc.text(`Job Snapshot — Work ${idx + 1}`, M, 104);
    const sp = [['COMPLETED', C.mut, C.graphS]]; if (early) sp.push(['EARLY', C.green, C.greenS]); sp.push(ot > 0 ? ['OVERTIME', C.red, C.redS] : ['ON TIME', C.green, C.greenS]); pillsRight(W - M, 92, sp);
    let y = 120;
    // ── snapshot: 3×3 grid + a full-width last row where SERVICE TYPE spans two
    //    columns (wraps to 2 lines, ellipsis) so long service names never overflow.
    const snH = 112; card(M, y, CW, snH);
    const c3 = CW / 3;
    const grid = [['DATE', r.date], ['WORKER', r.worker_name], ['EMPLOYEE ID', r.employee_id], ['BAY', 'Bay ' + String(r.bay_number || 0).padStart(2, '0')], ['VEHICLE NO.', r.registration], ['BIKE MODEL', r.vehicle], ['CUSTOMER', r.customer_name], ['JOB CARD', r.job_card_number], ['BRANCH', r.branch_name]];
    grid.forEach((f, i) => { const cx = M + 14 + (i % 3) * c3, cy = y + 18 + Math.floor(i / 3) * 22; ft(6, 'bold'); stx(C.faint); doc.text(f[0], cx, cy); ft(9, 'bold'); stx(C.ink); doc.text(String(f[1] || '—'), cx, cy + 11, { maxWidth: c3 - 20 }); });
    const ry4 = y + 18 + 3 * 22;
    ft(6, 'bold'); stx(C.faint); doc.text('SERVICE TYPE', M + 14, ry4);
    ft(9, 'bold'); stx(C.ink);
    let svc = doc.splitTextToSize(String(r.service_type || '—'), 2 * c3 - 28);
    if (svc.length > 2) { svc = svc.slice(0, 2); svc[1] = svc[1].replace(/\s*\S{0,3}$/, '…'); }
    doc.text(svc, M + 14, ry4 + 11);
    const tcx = M + 14 + 2 * c3;
    ft(6, 'bold'); stx(C.faint); doc.text('START TIME', tcx, ry4); doc.text('END TIME', tcx + c3 / 2, ry4);
    ft(9, 'bold'); stx(C.green); doc.text(String(r.start_time || '—'), tcx, ry4 + 11); stx(C.red); doc.text(String(r.end_time || '—'), tcx + c3 / 2, ry4 + 11);
    y += snH + 16;
    // timer + video
    const colW = (CW - 14) / 2, tdH = 168; darkBar(M, y, colW, 'TIMER DETAILS'); darkBar(M + colW + 14, y, colW, 'VIDEO RECORDING'); const cy0 = y + 22;
    card(M, cy0, colW, tdH);
    const tr = [['Timer started', r.start_time], ['Estimated time', lwcHM(r.est_min)], ['Actual working', lwcHM(r.actual_min), C.green], ['Paused (ref)', r.paused_known ? lwcHM(r.paused_min) : 'n/a', C.yellow], ['Pause count', r.paused_known ? (r.pause_count || 0) : 'n/a'], ['Overtime', (ot > 0 ? '+' : '') + lwcHM(ot), ot > 0 ? C.red : null], ['Completed / End', r.end_time], ['Total clock time', lwcHM(clockOf(r))]];
    tr.forEach((t, i) => { const ry = cy0 + 18 + i * 18.5; ft(8.5, 'normal'); stx(C.mut); doc.text(t[0], M + 14, ry); ft(8.5, 'bold'); stx(t[2] || C.ink); doc.text(String(t[1]), M + colW - 14, ry, { align: 'right' }); sd(C.line); doc.setLineWidth(0.4); doc.setLineDashPattern([0.5, 1.5], 0); doc.line(M + 14 + doc.getTextWidth(t[0]) + 6, ry - 2.5, M + colW - 14 - doc.getTextWidth(String(t[1])) - 6, ry - 2.5); doc.setLineDashPattern([], 0); });
    const vx = M + colW + 14, rec = r.recording || {}, has = !!rec.recording_id, exp = rec.status === 'expired', avail = has && !exp;
    card(vx, cy0, colW, tdH);
    const vr = [['Status', avail ? 'Available' : (has ? 'Expired' : 'Not available'), avail ? C.green : (has ? C.red : C.mut)], ['Duration', rec.duration || '—'], ['Expiry', rec.expiry_date || '—']];
    vr.forEach((v, i) => { const ry = cy0 + 28 + i * 30; ft(8.5, 'normal'); stx(C.mut); doc.text(v[0], vx + 14, ry); ft(8.5, 'bold'); stx(v[2] || C.ink); doc.text(String(v[1]), vx + colW - 14, ry, { align: 'right' }); });
    sf(C.blueS); doc.roundedRect(vx + 14, cy0 + tdH - 34, colW - 28, 24, 5, 5, 'F');
    if (avail && rec.url) { sf(C.blue); doc.triangle(vx + 24, cy0 + tdH - 27, vx + 24, cy0 + tdH - 17, vx + 31, cy0 + tdH - 22, 'F'); stx(C.blue); ft(8.5, 'bold'); doc.textWithLink('Open secure recording', vx + 38, cy0 + tdH - 19, { url: recAbsUrl(rec.url) }); }
    else { stx(has ? C.red : C.mut); ft(8.5, 'bold'); doc.text(has ? 'Recording expired — link removed' : 'No recording available', vx + 24, cy0 + tdH - 19); }
    y = cy0 + tdH + 16;
    // KPIs
    sectionLbl(M, y, 'KEY PERFORMANCE INDICATORS'); y += 10;
    const kw = (CW - 4 * 8) / 5, kh = 62;
    const kpis = [['Estimated', lwcHM(r.est_min), 'planned', C.blue, C.ink], ['Actual Working', lwcHM(r.actual_min), 'excl. pause', C.green, C.green], ['Paused', lwcHM(pausedOf(r)), 'reference', C.yellow, C.yellow], ['Overtime', (ot > 0 ? '+' : '') + lwcHM(ot), 'beyond est.', C.red, ot > 0 ? C.red : C.ink], ['Status', ot > 0 ? 'OT' : 'OK', ot > 0 ? 'overtime' : 'on time', ot > 0 ? C.red : C.green, ot > 0 ? C.red : C.green]];
    kpis.forEach((k, i) => kpiCard(M + i * (kw + 8), y, kw, kh, { label: k[0], value: k[1], sub: k[2], accent: k[3], vc: k[4] }));
    y += kh + 16;
    // charts — fill the remaining height down to the footer
    sectionLbl(M, y, 'PERFORMANCE CHARTS — CURRENT WORK'); y += 10;
    const chW = (CW - 14) / 2, chH = Math.max(150, (H - 30) - 20 - y);
    card(M, y, chW, chH); ft(9.5, 'bold'); stx(C.ink); doc.text('Time Composition', M + 14, y + 18); ft(6.5, 'normal'); stx(C.faint); doc.text('THIS WORK', M + 14, y + 28);
    const cmid = y + 38 + (chH - 38) / 2;
    const cl = clockOf(r); donut(M + 66, cmid, 46, 28, [{ v: core(r), c: C.green }, { v: ot, c: C.red }, { v: pausedOf(r), c: C.yellow }], lwcHM(cl), 'TOTAL');
    [['Working', core(r), C.green], ['Overtime', ot, C.red], ['Pause (ref)', pausedOf(r), C.yellow]].forEach((l, i) => { const ly = cmid - 24 + i * 24; sf(l[2]); doc.roundedRect(M + 132, ly - 7, 9, 9, 2, 2, 'F'); ft(8.5, 'normal'); stx(C.ink); doc.text(l[0], M + 146, ly); ft(8.5, 'bold'); stx(C.ink); doc.text(lwcHM(l[1]), M + chW - 14, ly, { align: 'right' }); });
    const wx = M + chW + 14; card(wx, y, chW, chH); ft(9.5, 'bold'); stx(C.ink); doc.text('Timer Waterfall', wx + 14, y + 18); ft(6.5, 'normal'); stx(C.faint); doc.text('ESTIMATED > ACTUAL WORKING', wx + 14, y + 28);
    vbars(wx + 16, y + 42, chW - 32, chH - 66, [{ label: 'Est', v: r.est_min || 0, color: C.blue, vlabel: lwcHM(r.est_min) }, { label: 'Working', v: r.actual_min || 0, color: C.green, vlabel: lwcHM(r.actual_min) }, { label: '+OT', v: ot, color: C.red, vlabel: '+' + lwcHM(ot) }, { label: 'Pause', v: pausedOf(r), color: C.yellow, dashed: true, vlabel: lwcHM(pausedOf(r)) }]);
    ft(6, 'italic'); stx(C.faint); doc.text('Pause shown as reference · excluded', wx + 16, y + chH - 10);
    footer();
  };

  // ── SUMMARY PAGE ──
  const summaryPage = () => {
    newPage();
    const kicker = 'DAILY PERFORMANCE SUMMARY';
    header(kicker, oneWorker ? [[wName, C.amber, 9, 'bold'], [empId || ''], [`${dates.length === 1 ? dates[0] : ''}${bayLabel ? ' · ' + bayLabel : ''}`]] : [[`${workers.length} workers`, C.amber, 9, 'bold'], [oneDay ? dates[0] : `${dates[0] || ''} – ${dates[dates.length - 1] || ''}`]]);
    const ttl = oneWorker ? `Daily Performance Summary — ${wName}` : 'Daily Performance Summary';
    titleBlock(ttl, `${branch ? branch + ' branch · ' : ''}${N} jobs · ${oneBay ? bayLabel + ' · ' : ''}${N} works completed`);
    let y = 138;
    darkBar(M, y, CW, `DAILY METRICS${oneBay ? ' — ' + bayLabel.toUpperCase() : ''}`, `Capacity ${capHrs}`); y += 30;
    const mw = (CW - 2 * 10) / 3, mh = 78;
    const metrics = [
      { label: 'Works Completed', value: N, sub: 'total', accent: C.amber }, { label: 'Actual Working', value: lwcHM(totAct), sub: 'excl. pause', accent: C.green, vc: C.green }, { label: 'Pause · Ref', value: lwcHM(totPause), sub: 'excluded', accent: C.yellow, vc: C.yellow },
      { label: 'Overtime', value: lwcHM(totOt), sub: 'beyond est.', accent: C.red, vc: C.red }, { label: 'On-Time', value: `${onTimeN}/${N}`, sub: onPct + '%', accent: C.green, vc: C.green }, { label: 'Overtime Works', value: overtN, sub: 'late jobs', accent: C.red, vc: C.red },
      { label: 'Productive', value: lwcHM(productive), sub: 'of ' + capHrs, accent: C.blue }, { label: 'Utilization', value: util + '%', sub: 'capacity used', accent: C.amber, vc: C.amber }, { label: 'Remaining', value: lwcHM(remaining), sub: 'idle capacity', accent: C.slate },
    ];
    metrics.forEach((m, i) => metricCard(M + (i % 3) * (mw + 10), y + Math.floor(i / 3) * (mh + 10), mw, mh, m));
    y += 3 * (mh + 10) + 6;
    sectionLbl(M, y, `ANALYTICS${oneBay ? ' — ' + bayLabel.toUpperCase() : ''}`); y += 10;
    const chW = (CW - 14) / 2, chH = Math.max(200, Math.min(280, (H - 30) - 20 - y));
    // composition
    card(M, y, chW, chH); ft(9.5, 'bold'); stx(C.ink); doc.text('Overall Time Composition', M + 14, y + 18); ft(6.5, 'normal'); stx(C.faint); doc.text('9-HOUR WORKING DAY · ' + workers.length + 'x' + Math.max(1, dates.length) + ' · ' + capHrs, M + 14, y + 28);
    donut(M + 64, y + 116, 48, 29, [{ v: onTargetTot, c: C.green }, { v: totOt, c: C.red }, { v: totPause, c: C.yellow }, { v: remaining, c: C.slate }], lwcHM(productive), 'of ' + capHrs + ' · ' + util + '%');
    const lg = [['On-target working', onTargetTot, C.green], ['Overtime', totOt, C.red], ['Pause (reference)', totPause, C.yellow], ['Remaining capacity', remaining, C.slate]];
    lg.forEach((l, i) => { const ly = y + 62 + i * 26; sf(l[2]); doc.roundedRect(M + 132, ly - 6, 9, 9, 2, 2, 'F'); ft(8.5, 'normal'); stx(C.ink); doc.text(l[0], M + 146, ly + 1); ft(8.5, 'bold'); stx(C.ink); doc.text(Math.round(l[1] / capMin * 100) + '%', M + chW - 14, ly + 1, { align: 'right' }); ft(6.5, 'normal'); stx(C.mut); doc.text(lwcHM(l[1]), M + 146, ly + 10); });
    // capacity used bar
    ft(6.5, 'bold'); stx(C.mut); doc.text('CAPACITY USED', M + 14, y + chH - 28);
    const bx = M + 14, bw = chW - 28, by = y + chH - 22; sf(C.graphS); doc.roundedRect(bx, by, bw, 8, 4, 4, 'F'); let cx = bx;
    [[onTargetTot, C.green], [totOt, C.red], [totPause, C.yellow]].forEach(s => { const sw = s[0] / capMin * bw; if (sw > 0.3) { sf(s[1]); doc.rect(cx, by, sw, 8, 'F'); cx += sw; } });
    ft(6, 'normal'); stx(C.faint); doc.text('0h', bx, by + 18); doc.text(capHrs, bx + bw, by + 18, { align: 'right' });
    // waterfall
    const wx = M + chW + 14; card(wx, y, chW, chH); ft(9.5, 'bold'); stx(C.ink); doc.text('Daily Timer Waterfall', wx + 14, y + 18); ft(6.5, 'normal'); stx(C.faint); doc.text('ESTIMATED > ACTUAL WORKING', wx + 14, y + 28);
    const varr = totAct - totEst;
    vbars(wx + 16, y + 40, chW - 32, chH - 76, [{ label: 'Estimated', v: totEst, color: C.blue, vlabel: lwcHM(totEst) }, { label: 'Variance', v: Math.abs(varr), color: varr > 0 ? C.red : C.green, vlabel: (varr > 0 ? '+' : '-') + lwcHM(Math.abs(varr)) }, { label: 'Actual', v: totAct, color: C.green, vlabel: lwcHM(totAct) }, { label: 'Pause', v: totPause, color: C.yellow, dashed: true, vlabel: lwcHM(totPause) }]);
    ft(6, 'italic'); stx(C.faint); doc.text('Pause shown as reference · excluded from working time', wx + 14, y + chH - 8);
    footer();
  };

  // ── ALL-WORKS TABLE PAGES ──
  const tablePagesFn = () => {
    const cols = [['#', 18], ['WORKER', 74], ['BAY', 24], ['JOB CARD', 54], ['VEHICLE', 80], ['SERVICE', 72], ['TIME', 40], ['EST', 26], ['ACT', 26], ['PAUSE', 28], ['OT', 28], ['STATUS', 48], ['VIDEO', 30]];
    const tw = cols.reduce((a, c) => a + c[1], 0), sc = CW / tw; cols.forEach(c => c[1] *= sc);
    for (let off = 0, pg = 0; off < N; off += ROWS, pg++) {
      newPage();
      header('ALL WORKS', oneWorker ? [[wName, C.amber, 9, 'bold'], [bayLabel || (branch ? branch + ' branch' : '')]] : [[branch || 'All Works', C.amber, 9, 'bold'], [oneDay ? dates[0] : `${dates[0] || ''} – ${dates[dates.length - 1] || ''}`]]);
      let y = titleBlock(oneBay ? `All Works — ${bayLabel}` : 'All Works', `${N} works · ${oneWorker ? (empId ? empId + ' · ' : '') : ''}${branch ? branch + ' branch · ' : ''}${N} jobs`);
      // header row
      sf(C.dark); doc.roundedRect(M, y, CW, 20, 4, 4, 'F'); ft(7, 'bold'); stx([255, 255, 255]); let cx = M + 8; cols.forEach(c => { doc.text(c[0], cx, y + 13); cx += c[1]; }); y += 20;
      data.slice(off, off + ROWS).forEach((r, i) => {
        const rh = 30, ov = r.overtime_min > 0, rec = r.recording || {}, has = !!rec.recording_id, exp = rec.status === 'expired';
        if (i % 2 === 1) { sf(C.zebra); doc.rect(M, y, CW, rh, 'F'); }
        sf(ov ? C.red : C.green); doc.rect(M, y, 2.5, rh, 'F');
        cx = M + 8; const cw = (k) => cols[k][1];
        ft(8, 'normal'); stx(C.faint); doc.text(String(r._n), cx, y + 18); cx += cw(0);
        ft(8, 'bold'); stx(C.ink); doc.text(String(r.worker_name || '—'), cx, y + 13, { maxWidth: cw(1) - 4 }); ft(6.5, 'normal'); stx(C.faint); doc.text(String(r.employee_id || ''), cx, y + 22); cx += cw(1);
        ft(8, 'normal'); stx(C.ink); doc.text('B' + String(r.bay_number || 0).padStart(2, '0'), cx, y + 18); cx += cw(2);
        ft(8, 'bold'); stx(C.ink); doc.text(String(r.job_card_number || '—'), cx, y + 18, { maxWidth: cw(3) - 4 }); cx += cw(3);
        ft(8, 'bold'); stx(C.ink); doc.text(String(r.registration || '—'), cx, y + 13, { maxWidth: cw(4) - 4 }); ft(6.5, 'normal'); stx(C.faint); doc.text(String(r.vehicle || ''), cx, y + 22, { maxWidth: cw(4) - 4 }); cx += cw(4);
        ft(8, 'normal'); stx(C.blue); const svc = doc.splitTextToSize(String(r.service_type || '—'), cw(5) - 4); doc.text(svc.slice(0, 2), cx, svc.length > 1 ? y + 13 : y + 18); cx += cw(5);
        ft(7.5, 'normal'); stx(C.ink); doc.text(String(r.start_time || '—'), cx, y + 13); stx(C.faint); doc.text(String(r.end_time || '—'), cx, y + 22); cx += cw(6);
        ft(8, 'normal'); stx(C.mut); doc.text((r.est_min || 0) + 'm', cx, y + 18); cx += cw(7);
        ft(8, 'bold'); stx(C.green); doc.text((r.actual_min || 0) + 'm', cx, y + 18); cx += cw(8);
        { const pv = r.paused_known ? (r.paused_min || 0) : 0; ft(8, 'normal'); stx(pv > 0 ? C.yellow : C.faint); doc.text(pv > 0 ? pv + 'm' : '—', cx, y + 18); } cx += cw(9);
        ft(8, 'bold'); stx(ov ? C.red : C.faint); doc.text(ov ? '+' + r.overtime_min + 'm' : '—', cx, y + 18); cx += cw(10);
        ft(6.5, 'bold'); if (ov) { sf(C.redS); doc.roundedRect(cx, y + 10, doc.getTextWidth('OVERTIME') + 8, 12, 6, 6, 'F'); stx(C.red); doc.text('OVERTIME', cx + 4, y + 18.5); } else { sf(C.greenS); doc.roundedRect(cx, y + 10, doc.getTextWidth('ON TIME') + 8, 12, 6, 6, 'F'); stx(C.green); doc.text('ON TIME', cx + 4, y + 18.5); } cx += cw(11);
        if (has && !exp && rec.url) { stx(C.blue); ft(8, 'bold'); doc.textWithLink('View', cx, y + 18, { url: recAbsUrl(rec.url) }); } else { stx(C.faint); ft(7.5, 'normal'); doc.text(has && exp ? 'Expired' : '—', cx, y + 18); }
        sd(C.line); doc.setLineWidth(0.4); doc.line(M, y + rh, M + CW, y + rh); y += rh;
      });
      if (off + ROWS >= N) {
        y += 14; const sh = 50; sf(C.zebra); sd(C.line); doc.setLineWidth(0.8); doc.roundedRect(M, y, CW, sh, 7, 7, 'FD');
        stx(C.amber); ft(8, 'bold'); doc.text('DAY SUMMARY', M + 14, y + 16);
        ft(8.5, 'normal'); stx(C.ink); doc.text(`${oneWorker ? wName : workers.length + ' workers'} completed ${N} works · Est ${lwcHM(totEst)} · Actual working ${lwcHM(totAct)} · Overtime ${lwcHM(totOt)}.`, M + 14, y + 30, { maxWidth: CW - 28 });
        doc.text(`On-time ${onTimeN}/${N} (${onPct}%) · Productive ${lwcHM(productive)} of ${capHrs} (${util}% utilization) · Pause ${lwcHM(totPause)} reference (excluded).`, M + 14, y + 42, { maxWidth: CW - 28 });
      }
      footer();
    }
  };

  // ── BIKE TEST DRIVE REPORT — final page (single job, when a linked drive exists) ──
  const testDrivePage = (td) => {
    newPage();
    header('TEST DRIVE', [[td.bike_registration || '—', C.amber, 9, 'bold'], [td.bike_model || '']]);
    let y = titleBlock('Bike Test Drive Report', `${td.job_card_number || '—'}${td.customer_name ? ' · ' + td.customer_name : ''}`);
    const fmt = (sec) => { const s = Math.max(0, Math.round(sec || 0)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60; return (h ? h + 'h ' : '') + (h || m ? m + 'm ' : '') + ss + 's'; };
    const km = (v) => (v != null ? Number(v).toFixed(2) + ' km' : '—');
    const sp = (v) => (v != null ? Number(v) + ' km/h' : '—');
    const dt = (iso) => { if (!iso) return '—'; try { return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (e) { return '—'; } };
    const tt = (iso) => { if (!iso) return '—'; try { return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch (e) { return '—'; } };
    const kv = (x, yy, label, value, vc) => { ft(6.5, 'bold'); stx(C.mut); doc.text(String(label).toUpperCase(), x, yy); ft(9.5, 'bold'); stx(vc || C.ink); doc.text(String(value == null || value === '' ? '—' : value), x, yy + 12); };

    // route image (left) — preserve 1080×1440 aspect ratio
    const imgX = M, imgW = 210, imgH = Math.round(imgW * 1440 / 1080), imgY = y + 4;
    card(imgX, imgY, imgW, imgH);
    if (td.imageDataUrl) {
      try { doc.addImage(td.imageDataUrl, 'PNG', imgX, imgY, imgW, imgH); }
      catch (e) { ft(8.5, 'normal'); stx(C.mut); doc.text('Route image unavailable', imgX + 14, imgY + 26); }
    } else { ft(8.5, 'normal'); stx(C.mut); doc.text('Route image unavailable', imgX + 14, imgY + 26); }

    // identity + metrics (right)
    const rx = imgX + imgW + 22, cx2 = rx + 160; let ry = imgY + 8;
    sectionLbl(rx, ry, 'WORKER RESPONSIBILITY'); ry += 16;
    kv(rx, ry, 'Service Worker', td.service_worker_name); kv(cx2, ry, 'Test Drive Worker', td.test_drive_worker_name, C.amber); ry += 30;
    kv(rx, ry, 'Bay', td.bay_label); kv(cx2, ry, 'Branch', td.branch_name); ry += 36;
    sectionLbl(rx, ry, 'TIMELINE'); ry += 16;
    kv(rx, ry, 'Assigned', dt(td.assigned_at)); kv(cx2, ry, 'Started', dt(td.started_at)); ry += 30;
    kv(rx, ry, 'Ended', dt(td.ended_at)); kv(cx2, ry, 'Total Time', fmt(td.total_duration_seconds)); ry += 30;
    kv(rx, ry, 'Moving', fmt(td.moving_duration_seconds)); kv(cx2, ry, 'Stopped', fmt(td.stop_duration_seconds)); ry += 36;
    sectionLbl(rx, ry, 'METRICS'); ry += 16;
    kv(rx, ry, 'Distance', km(td.total_distance_km), C.green); kv(cx2, ry, 'Avg Speed', sp(td.average_speed_kmh)); ry += 30;
    kv(rx, ry, 'Max Speed', sp(td.max_speed_kmh)); kv(cx2, ry, 'Stops', td.stop_count != null ? td.stop_count : 0); ry += 30;
    kv(rx, ry, 'GPS Points', td.point_count != null ? td.point_count : 0); kv(cx2, ry, 'Invalid / Low-acc', `${td.invalid_count || 0} / ${td.low_acc_count || 0}`);

    // stop table (full width, below)
    let ty = imgY + imgH + 22;
    darkBar(M, ty, CW, 'DETECTED STOPS', `${(td.stops || []).length} total`); ty += 26;
    const cols = [['#', 26], ['START', 92], ['END', 92], ['DURATION', 84], ['LATITUDE', 92], ['LONGITUDE', 92], ['WARNING', 60]];
    const tw = cols.reduce((a, c) => a + c[1], 0), sc = CW / tw; cols.forEach(c => c[1] *= sc);
    sf(C.dark); doc.roundedRect(M, ty, CW, 18, 3, 3, 'F'); ft(6.5, 'bold'); stx([255, 255, 255]); let hx = M + 8; cols.forEach(c => { doc.text(c[0], hx, ty + 12); hx += c[1]; }); ty += 18;
    const stops = (td.stops || []).slice(0, 12);
    if (!stops.length) { ft(8.5, 'normal'); stx(C.mut); doc.text('No reportable stops.', M + 10, ty + 16); ty += 24; }
    else stops.forEach((st, i) => {
      const long = (st.duration_seconds || 0) >= 300, rh = 20;
      if (i % 2 === 1) { sf(C.zebra); doc.rect(M, ty, CW, rh, 'F'); }
      let cx = M + 8; ft(8, 'normal'); stx(C.ink);
      doc.text(String(i + 1), cx, ty + 13); cx += cols[0][1];
      doc.text(tt(st.start_time), cx, ty + 13); cx += cols[1][1];
      doc.text(tt(st.end_time), cx, ty + 13); cx += cols[2][1];
      stx(long ? C.red : C.ink); ft(8, long ? 'bold' : 'normal'); doc.text(fmt(st.duration_seconds), cx, ty + 13); cx += cols[3][1];
      ft(8, 'normal'); stx(C.ink); doc.text(st.latitude != null ? Number(st.latitude).toFixed(5) : '—', cx, ty + 13); cx += cols[4][1];
      doc.text(st.longitude != null ? Number(st.longitude).toFixed(5) : '—', cx, ty + 13); cx += cols[5][1];
      if (long) { ft(6.5, 'bold'); sf(C.redS); doc.roundedRect(cx, ty + 5, doc.getTextWidth('LONG STOP') + 8, 12, 6, 6, 'F'); stx(C.red); doc.text('LONG STOP', cx + 4, ty + 13.5); }
      else { stx(C.faint); ft(7.5, 'normal'); doc.text('—', cx, ty + 13); }
      sd(C.line); doc.setLineWidth(0.4); doc.line(M, ty + rh, M + CW, ty + rh); ty += rh;
    });

    ty += 16; ft(7.5, 'normal'); stx(C.mut);
    doc.text('Location data is recorded only during the assigned test drive. Metrics are calculated by the backend from stored GPS points.', M, ty, { maxWidth: CW });
    footer();
  };

  if (N === 0) {
    newPage();
    header('ALL WORKS', [[branch || 'All Works', C.amber, 9, 'bold']]);
    let y = titleBlock('All Works', subtitle || (title || 'Work Completion'));
    darkBar(M, y, CW, 'ALL WORKS'); y += 30;
    sf(C.zebra); sd(C.line); doc.setLineWidth(0.8); doc.roundedRect(M, y, CW, 44, 7, 7, 'FD');
    ft(9.5, 'normal'); stx(C.mut); doc.text('No completed works found for this selection.', M + 16, y + 26);
    footer(); return doc;
  }
  if (detailed) data.forEach((r, i) => workPage(r, i));
  summaryPage();
  tablePagesFn();
  if (tdInfo) testDrivePage(tdInfo);
  return doc;
};
const lwcReportName2 = (title) => (title || 'Completion_Report').replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') + '.pdf';

// PDF preview modal — same document for preview (iframe) and download.
const LwcPdfPreviewModal = ({ pdf, recUrl, onClose }) => {
  useLE(() => () => { try { URL.revokeObjectURL(pdf.url); } catch (e) {} }, []);
  return (
    <div className="modal-scrim" onClick={onClose} style={{ zIndex: 440 }}>
      <div className="modal lwc-pdf-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div className="row" style={{ gap: 10 }}><div className="jf-head-ico"><Icon name="file" size={14}/></div><span style={{ fontWeight: 600, fontSize: 14 }}>PDF Preview</span></div>
          <button className="modal-close" onClick={onClose}><Icon name="x" size={15}/></button>
        </div>
        <iframe className="lwc-pdf-frame" src={pdf.url} title="Completion report preview"/>
        <div className="modal-foot">
          {recUrl && <a className="btn btn-ghost btn-sm" href={recUrl} target="_blank" rel="noreferrer"><Icon name="play" size={13}/> OPEN RECORDING</a>}
          <div className="spacer"/>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>CLOSE</button>
          <button className="btn btn-amber btn-sm" onClick={() => pdf.doc.save(pdf.name)}><Icon name="file" size={13}/> DOWNLOAD PDF</button>
        </div>
      </div>
    </div>
  );
};

const LwcMetric = ({ label, value, tone }) => (
  <div className={`lwc-metric ${tone || ''}`}><div className="lwc-metric-v">{value}</div><div className="lwc-metric-l">{label}</div></div>
);
const LwcKV = ({ label, value, tone, clamp }) => (
  <div className="lwc-kv"><div className="k">{label}</div><div className={`v ${tone || ''} ${clamp ? 'clamp' : ''}`} title={clamp && value ? String(value) : undefined}>{(value === 0 || value) ? value : '—'}</div></div>
);

// Find + assemble the linked completed test drive for a completion row (frontend-only;
// reuses the Phase 1/4 admin APIs). The SAME object feeds the modal section AND the PDF
// final page, so Preview and Download are always identical.
async function lwcLoadTestDrive(row) {
  if (!row || !row.session_id) return null;
  let list;
  try { list = await BW_API.testDrives({ job_id: row.session_id }); } catch (e) { return null; }
  const all = (list && list.items) || [];
  if (!all.length) return null;
  const completed = all.filter(t => t.status === 'completed').sort((a, b) => (b.ended_at || '').localeCompare(a.ended_at || ''));
  const td = completed[0] || all.slice().sort((a, b) => (b.assigned_at || '').localeCompare(a.assigned_at || ''))[0];
  if (!td) return null;
  let summary = td;
  try { summary = await BW_API.testDriveSummary(td.id); } catch (e) {}
  const stops = (summary && summary.stops) || [];
  let invalid = 0, lowAcc = 0, stale = false;
  try {
    const pres = await BW_API.testDrivePointsOf(td.id);
    const pts = (pres && pres.items) || [];
    invalid = pts.filter(p => p.is_valid === false).length;
    lowAcc = pts.filter(p => (p.accuracy_meters || 0) > 50).length;
    const lastTs = pts.length ? pts[pts.length - 1].timestamp : null;
    stale = summary.status === 'running' && lastTs && (Date.now() - new Date(lastTs).getTime()) > 120000;
  } catch (e) {}
  const longStops = stops.filter(x => (x.duration_seconds || 0) >= 300).length;
  const warnings = [];
  if (longStops > 0) warnings.push({ tag: 'LONG STOP', tone: 'danger', text: `${longStops} stop${longStops > 1 ? 's' : ''} of 5 minutes or more.` });
  if (stale) warnings.push({ tag: 'STALE TRACKING', tone: 'danger', text: 'No valid GPS point in over 2 minutes.' });
  if (invalid > 0) warnings.push({ tag: 'INVALID GPS POINTS', tone: 'warn', text: `${invalid} invalid point${invalid > 1 ? 's' : ''} rejected.` });
  if (lowAcc > 0) warnings.push({ tag: 'LOW GPS ACCURACY', tone: 'warn', text: `${lowAcc} low-accuracy point${lowAcc > 1 ? 's' : ''} (±>50 m).` });
  // route image as a data URL — completed only; best-effort (PDF degrades gracefully)
  let imageDataUrl = null;
  if (summary.status === 'completed') { try { imageDataUrl = await BW_API.testDriveRouteImageData(td.id); } catch (e) {} }
  return {
    id: td.id, status: summary.status, multiple: completed.length > 1,
    service_worker_name: row.worker_name || null, test_drive_worker_name: summary.worker_name || null,
    bay_label: `B${String(row.bay_number || 0).padStart(2, '0')}${row.bay_name ? ' · ' + row.bay_name : ''}`, branch_name: row.branch_name || null,
    job_card_number: summary.job_card_number || row.job_card_number || null,
    bike_registration: summary.bike_registration || row.registration || null,
    bike_model: summary.bike_model || row.vehicle || null,
    customer_name: summary.customer_name || row.customer_name || null,
    assigned_at: summary.assigned_at, started_at: summary.started_at, ended_at: summary.ended_at,
    total_duration_seconds: summary.total_duration_seconds, moving_duration_seconds: summary.moving_duration_seconds,
    stop_duration_seconds: summary.stop_duration_seconds, total_distance_km: summary.total_distance_km,
    average_speed_kmh: summary.average_speed_kmh, max_speed_kmh: summary.max_speed_kmh,
    stop_count: summary.stop_count, point_count: summary.point_count,
    invalid_count: invalid, low_acc_count: lowAcc, stops, warnings, imageDataUrl, imageReady: !!imageDataUrl,
  };
}

const CrTestDriveStops = ({ stops }) => {
  if (!stops || !stops.length) return <div className="tdt-empty-sm">No reportable stops.</div>;
  return (
    <div className="cr-testdrive-table">
      <div className="cr-td-row cr-td-head"><span>#</span><span>Start</span><span>End</span><span>Duration</span><span>Location</span><span>Warning</span></div>
      {stops.map((st, i) => {
        const long = (st.duration_seconds || 0) >= 300;
        return (
          <div key={st.id || i} className="cr-td-row">
            <span className="mono">{i + 1}</span>
            <span className="mono">{tdtTime(st.start_time)}</span>
            <span className="mono">{tdtTime(st.end_time)}</span>
            <span className={`mono ${long ? 'cr-td-long' : ''}`}>{tdHMS(st.duration_seconds)}</span>
            <span className="mono cr-td-mut">{tdtLatLng(st.latitude, st.longitude)}</span>
            <span>{long ? <span className="chip danger" style={{ fontSize: 9 }}>LONG STOP</span> : <span className="cr-td-mut">—</span>}</span>
          </div>
        );
      })}
    </div>
  );
};

const CrTestDriveSection = ({ loading, report }) => {
  if (loading) return (
    <div className="lwc-rep-block">
      <div className="lwc-rep-bt"><Icon name="bike" size={13}/> Bike Test Drive Report</div>
      <div className="tdt-loading"><Icon name="route" size={18}/> Loading linked test drive…</div>
    </div>
  );
  if (!report) return (
    <div className="lwc-rep-block">
      <div className="lwc-rep-bt"><Icon name="bike" size={13}/> Bike Test Drive Report</div>
      <div className="lwc-rec-state">No completed test drive recorded for this job.</div>
    </div>
  );
  const r = report; const chip = tdtChip(r.status);
  return (
    <div className="lwc-rep-block cr-testdrive">
      <div className="lwc-rep-bt"><Icon name="bike" size={13}/> Bike Test Drive Report
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
          <span className={`chip ${chip.cls}`}>{chip.txt}</span>
          <span className={`chip ${r.imageReady ? 'ok' : 'ghost'}`}>{r.imageReady ? 'ROUTE IMAGE READY' : 'ROUTE IMAGE NOT READY'}</span>
        </span>
      </div>
      {r.multiple && <div className="tdt-empty-sm" style={{ marginBottom: 8 }}>Latest completed test drive shown.</div>}

      <div className="lwc-rep-cols">
        <div className="lwc-rep-block" style={{ margin: 0 }}>
          <LwcKV label="Job Card" value={r.job_card_number}/>
          <LwcKV label="Bike Registration" value={r.bike_registration}/>
          <LwcKV label="Bike Model" value={r.bike_model}/>
          <LwcKV label="Customer" value={r.customer_name}/>
        </div>
        <div className="lwc-rep-block cr-testdrive-worker-row" style={{ margin: 0 }}>
          <LwcKV label="Service Worker" value={r.service_worker_name}/>
          <LwcKV label="Test Drive Worker" value={r.test_drive_worker_name} tone="amber"/>
          <LwcKV label="Bay" value={r.bay_label}/>
          <LwcKV label="Branch" value={r.branch_name}/>
        </div>
      </div>

      <div className="cr-testdrive-grid">
        <LwcMetric label="Distance" value={`${tdtKm(r.total_distance_km)} km`} tone="ok"/>
        <LwcMetric label="Total Time" value={tdHMS(r.total_duration_seconds)}/>
        <LwcMetric label="Moving" value={tdHMS(r.moving_duration_seconds)}/>
        <LwcMetric label="Stopped" value={tdHMS(r.stop_duration_seconds)}/>
        <LwcMetric label="Avg Speed" value={`${r.average_speed_kmh != null ? r.average_speed_kmh : 0}`}/>
        <LwcMetric label="Max Speed" value={`${r.max_speed_kmh != null ? r.max_speed_kmh : 0}`}/>
        <LwcMetric label="Stops" value={r.stop_count != null ? r.stop_count : 0}/>
        <LwcMetric label="GPS Points" value={r.point_count != null ? r.point_count : 0}/>
      </div>

      <div className="lwc-rep-cols" style={{ marginTop: 12, alignItems: 'flex-start' }}>
        <div>
          <div className="lwc-an-h" style={{ marginBottom: 6 }}>Timeline</div>
          <LwcKV label="Assigned" value={tdtDateTime(r.assigned_at)}/>
          <LwcKV label="Started" value={tdtDateTime(r.started_at)}/>
          <LwcKV label="Ended" value={tdtDateTime(r.ended_at)}/>
        </div>
        <div>
          {r.imageDataUrl
            ? <a href={r.imageDataUrl} target="_blank" rel="noopener noreferrer"><img className="cr-testdrive-img" src={r.imageDataUrl} alt="Test drive route"/></a>
            : <div className="tdt-map-empty" style={{ height: 140 }}><Icon name="pin" size={20}/><div>{r.status === 'completed' ? 'Route image unavailable.' : 'Route image available after completion.'}</div></div>}
        </div>
      </div>

      {r.warnings && r.warnings.length > 0 && (
        <div className="tdt-warnstrip" style={{ marginTop: 12 }}>
          {r.warnings.map((w, i) => <div key={i} className={`tdt-warn ${w.tone}`}><Icon name="alert" size={12}/><b className="tdt-warn-tag">{w.tag}</b><span>{w.text}</span></div>)}
        </div>
      )}

      <div className="lwc-an-h" style={{ marginTop: 12, marginBottom: 6 }}>Detected stops</div>
      <CrTestDriveStops stops={r.stops}/>
    </div>
  );
};

// Single-job completion report — full detail + charts + recording + PDF.
const LwcReportModal = ({ row, onClose }) => {
  const [pdf, setPdf] = useLS(null);
  const [td, setTd] = useLS(undefined);   // undefined = loading · null = none · object = loaded
  const rec = recFromApi(row);
  const st = lwcStatus(row);
  const hasRec = !!(row.recording && row.recording.recording_id);
  const expired = rec.status === 'expired';
  const recUrl = hasRec && !expired ? rec.url : null;
  const cwTitle = `${row.worker_name || 'Worker'} — ${row.job_card_number || row.date || 'completion'}`;
  const cwName = lwcReportName2(row.job_card_number || row.session_id || 'completion');
  // Load the linked test drive (+ route-image data URL) up front. The PDF buttons stay
  // disabled until this resolves, so Preview and Download always embed the same data.
  useLE(() => { let alive = true; setTd(undefined);
    lwcLoadTestDrive(row).then(r => { if (alive) setTd(r || null); }).catch(() => { if (alive) setTd(null); });
    return () => { alive = false; }; }, []);
  const tdReady = td !== undefined;
  const buildRow = () => (td ? { ...row, _test_drive: td } : row);   // same row → preview == download
  const preview = () => { const doc = lwcBuildCompletionReport(cwTitle, '', [buildRow()]); setPdf({ doc, url: doc.output('bloburl'), name: cwName }); };
  const download = () => lwcBuildCompletionReport(cwTitle, '', [buildRow()]).save(cwName);
  return (
    <div className="modal-scrim" onClick={onClose} style={{ zIndex: 410 }}>
      <div className="modal lwc-rep-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div className="row" style={{ gap: 12, minWidth: 0 }}>
            <div className="jf-head-ico"><Icon name="history" size={15}/></div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>Completion Report</div>
              <div className="cell-meta" style={{ marginTop: 2 }}>{row.job_card_number || '—'} · {row.branch_name} · {row.date || '—'}</div>
            </div>
            <span className={`chip ${st.tone}`} style={{ marginLeft: 6 }}>{st.label}</span>
          </div>
          <button className="modal-close" onClick={onClose}><Icon name="x" size={15}/></button>
        </div>

        <div className="lwc-rep-body">
          <div className="lwc-metrics">
            <LwcMetric label="Estimated" value={lwcMin(row.est_min)}/>
            <LwcMetric label="Actual Working" value={lwcMin(row.actual_min)} tone="ok"/>
            <LwcMetric label="Paused" value={lwcPauseText(row)} tone="mut"/>
            <LwcMetric label="Overtime" value={row.overtime_min > 0 ? '+' + lwcMin(row.overtime_min) : '0m'} tone={row.overtime_min > 0 ? 'danger' : 'ok'}/>
            <LwcMetric label="Completion" value={st.label} tone={st.tone}/>
          </div>

          <div className="lwc-rep-cols">
            <div className="lwc-rep-block">
              <div className="lwc-rep-bt"><Icon name="user" size={13}/> Worker & Bay</div>
              <LwcKV label="Worker" value={row.worker_name}/>
              <LwcKV label="Employee ID" value={row.employee_id}/>
              <LwcKV label="Bay" value={`B${String(row.bay_number || 0).padStart(2, '0')}${row.bay_name ? ' · ' + row.bay_name : ''}`}/>
              <LwcKV label="Branch" value={row.branch_name}/>
              <LwcKV label="Role / Dept" value={[row.worker_role, row.worker_department].filter(Boolean).join(' · ')}/>
            </div>
            <div className="lwc-rep-block">
              <div className="lwc-rep-bt"><Icon name="bike" size={13}/> Bike / Service</div>
              <LwcKV label="Customer" value={row.customer_name}/>
              <LwcKV label="Vehicle Number" value={row.registration}/>
              <LwcKV label="Bike Model" value={row.vehicle}/>
              <LwcKV label="Service Type" value={row.service_type} clamp/>
              <LwcKV label="Job Card" value={row.job_card_number}/>
            </div>
          </div>

          <div className="lwc-rep-block">
            <div className="lwc-rep-bt"><Icon name="clock" size={13}/> Timer Analysis</div>
            <div className="lwc-rep-cols">
              <div>
                <LwcKV label="Estimated Time" value={lwcMin(row.est_min)}/>
                <LwcKV label="Timer Started At" value={row.start_time}/>
                <LwcKV label="Pause Count" value={row.paused_known ? (row.pause_count || 0) : 'Not available'}/>
                <LwcKV label="Total Paused" value={lwcPauseText(row)} tone="mut"/>
              </div>
              <div>
                <LwcKV label="Actual Working Time" value={lwcMin(row.actual_min)} tone="ok"/>
                <LwcKV label="Overtime" value={row.overtime_min > 0 ? '+' + lwcMin(row.overtime_min) : '0m'} tone={row.overtime_min > 0 ? 'danger' : 'ok'}/>
                <LwcKV label="Completed At" value={row.end_time}/>
                <LwcKV label="Total Elapsed (clock)" value={lwcMin(row.clock_min)}/>
              </div>
            </div>
          </div>

          <div className="lwc-rep-block">
            <div className="lwc-rep-bt"><Icon name="gauge" size={13}/> Performance Analytics</div>
            <div className="lwc-analytics">
              <div className="lwc-an-card">
                <div className="lwc-an-h">Time Composition <span className="lwc-an-sub">this work</span></div>
                <LwcDonut row={row}/>
              </div>
              <div className="lwc-an-card">
                <div className="lwc-an-h">Timer Waterfall <span className="lwc-an-sub">estimated › actual working</span></div>
                <LwcWaterfall row={row}/>
              </div>
            </div>
            <div className="lwc-an-card" style={{ marginTop: 12 }}>
              <div className="lwc-an-h">Estimated vs Actual</div>
              <LwcBars row={row}/>
            </div>
            <div className="lwc-rep-note">Paused time is reference only — excluded from actual working time.</div>
          </div>

          <div className="lwc-rep-block">
            <div className="lwc-rep-bt"><Icon name="route" size={13}/> Work Timeline</div>
            <LwcTimelineViz row={row}/>
          </div>

          <div className="lwc-rep-block">
            <div className="lwc-rep-bt"><Icon name="cam" size={13}/> Video Recording</div>
            {!hasRec && <div className="lwc-rec-state">No recording available.</div>}
            {hasRec && expired && <div className="lwc-rec-state danger">Recording expired — removed after the 14-day retention period.</div>}
            {hasRec && !expired && (
              <div className="lwc-rec-live">
                <div className="lwc-rec-meta">
                  <LwcKV label="Status" value={`Active · ${rec.daysLeft || 0}d left`} tone="ok"/>
                  <LwcKV label="Duration" value={rec.durationSec ? rec.durationSec : (row.recording.duration || '—')}/>
                  <LwcKV label="Expiry" value={rec.expiry || '—'}/>
                </div>
                <window.VideoActions rec={rec}/>
              </div>
            )}
          </div>

          <CrTestDriveSection loading={td === undefined} report={td || null}/>
        </div>

        <div className="modal-foot">
          {recUrl && <a className="btn btn-ghost btn-sm" href={recUrl} target="_blank" rel="noreferrer"><Icon name="play" size={13}/> OPEN RECORDING</a>}
          <div className="spacer"/>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>CLOSE</button>
          <button className="btn btn-ghost btn-sm" disabled={!tdReady} title={tdReady ? '' : 'Preparing test-drive data…'} onClick={download}><Icon name="file" size={13}/> {tdReady ? 'DOWNLOAD PDF' : 'PREPARING…'}</button>
          <button className="btn btn-amber btn-sm" disabled={!tdReady} title={tdReady ? '' : 'Preparing test-drive data…'} onClick={preview}><Icon name="file" size={13}/> {tdReady ? 'PREVIEW PDF' : 'PREPARING…'}</button>
        </div>
        {pdf && <LwcPdfPreviewModal pdf={pdf} recUrl={recUrl} onClose={() => setPdf(null)}/>}
      </div>
    </div>
  );
};

// per-worker completion card + table
const LwcWorkerCard = ({ worker, rows, onPdf, onOpen }) => {
  const total = rows.length;
  const onTime = rows.filter(r => r.overtime_min === 0).length;
  const avg = total ? (rows.reduce((a, r) => a + r.score, 0) / total).toFixed(1) : '—';
  const totalOT = rows.reduce((a, r) => a + r.overtime_min, 0);
  return (
    <div className="worker-comp-card">
      <div className="wcc-head">
        <div className="avatar-sm">{worker.avatar}</div>
        <div><div className="cell-name">{worker.name}</div><span className="cell-meta">{worker.employee_id || '—'} · {worker.branch_name}</span></div>
        <div className="wcc-summary">
          <div className="m"><div className="v">{total}</div><div className="l">Jobs</div></div>
          <div className="m"><div className="v" style={{ color: 'var(--ok)' }}>{total ? Math.round(onTime / total * 100) : 0}%</div><div className="l">On-Time</div></div>
          <div className="m"><div className="v" style={{ color: totalOT > 0 ? 'var(--danger)' : 'var(--t-1)' }}>{totalOT}m</div><div className="l">Overtime</div></div>
          <div className="m"><div className="v" style={{ color: 'var(--amber)' }}>{avg}{avg !== '—' ? '%' : ''}</div><div className="l">Avg Score</div></div>
        </div>
        <button className="btn btn-sm btn-amber" onClick={() => onPdf(`${worker.name} — Completion History`, `${worker.employee_id || ''} · ${worker.branch_name} · ${total} jobs`, [...rows].sort((a, b) => (a.date || '').localeCompare(b.date || '')))}>
          <Icon name="history" size={13}/> PDF
        </button>
      </div>
      <div className="comp-table" style={{ overflowX: 'auto' }}>
        <div className="comp-row head" style={{ gridTemplateColumns: LWC_COLS }}>
          <span/><span>DATE</span><span>BAY</span><span>VEHICLE / SERVICE</span><span>START</span><span>END</span><span>EST</span><span>ACTUAL</span><span>PAUSE</span><span>O.T.</span><span>SCORE</span><span>VIDEO</span><span>REC STATUS</span>
        </div>
        {rows.map((r, i) => {
          const rec = recFromApi(r);
          const pmin = r.paused_known ? (r.paused_min || 0) : null;
          return (
            <div key={i} className="comp-row lwc-clickable" style={{ gridTemplateColumns: LWC_COLS }}
              onClick={() => onOpen && onOpen(r)} title="View completion report">
              <div className={`spine ${r.overtime_min > 0 ? 'over' : ''}`}/>
              <span className="mono" style={{ color: 'var(--t-2)' }}>{(r.date || '').slice(5)}</span>
              <span className="mono">B{String(r.bay_number || 0).padStart(2, '0')}</span>
              <div className="veh">{r.vehicle || '—'}<small>{r.registration ? `${r.registration} · ` : ''}{r.service_type || ''}</small></div>
              <span className="mono" style={{ color: 'var(--ok)' }}>{r.start_time || '—'}</span>
              <span className="mono" style={{ color: 'var(--t-2)' }}>{r.end_time || '—'}</span>
              <span className="mono" style={{ color: 'var(--t-3)' }}>{r.est_min}m</span>
              <span className="mono">{r.actual_min}m</span>
              <span className="mono" style={{ color: pmin ? 'var(--warn)' : 'var(--t-4)' }}>{pmin ? `${pmin}m` : '—'}</span>
              <span className={`ot ${r.overtime_min > 0 ? 'over' : ''}`}>{r.overtime_min > 0 ? `+${r.overtime_min}m` : '—'}</span>
              <span className={`history-score ${r.score >= 100 ? 'ok' : r.score >= 95 ? 'warn' : 'danger'}`} style={{ justifySelf: 'start' }}>{r.score}%</span>
              <div className="comp-video-cell" onClick={e => e.stopPropagation()}><window.VideoActions rec={rec} compact/></div>
              <window.RecordingStatusBadge status={rec.status} daysLeft={rec.daysLeft}/>
            </div>
          );
        })}
      </div>
    </div>
  );
};

const LiveWorkCompletion = () => {
  const me = (BW_API.currentUser && BW_API.currentUser()) || {};
  const isMaster = me.role === 'master_admin';
  const poll = useBWPoll(() => BW_API.workCompletion(), [], 6000);
  const all = poll.data || [];

  const today = new Date().toISOString().slice(0, 10);
  const [endStr, setEndStr] = useLS(today);
  const [preset, setPreset] = useLS('2w');
  const [openBranch, setOpenBranch] = useLS(null);
  const [reportRow, setReportRow] = useLS(null);
  const [pdfPrev, setPdfPrev] = useLS(null);

  const span = preset === 'today' ? 1 : preset === '1w' ? 7 : 14;
  const winEnd = new Date(endStr + 'T23:59:59');
  const winStart = new Date(winEnd); winStart.setDate(winEnd.getDate() - (span - 1)); winStart.setHours(0, 0, 0, 0);
  const inWin = (r) => { if (!r.date) return false; const d = new Date(r.date + 'T12:00:00'); return d >= winStart && d <= winEnd; };

  const filtered = all.filter(inWin);
  const totalJobs = filtered.length;
  const onTime = filtered.filter(r => r.overtime_min === 0).length;
  const totalOT = filtered.reduce((a, r) => a + r.overtime_min, 0);
  const days = [...new Set(filtered.map(r => r.date).filter(Boolean))].sort((a, b) => b.localeCompare(a));

  // group by branch → worker
  const branches = {};
  filtered.forEach(r => {
    const br = r.branch_name || '—';
    (branches[br] ||= {});
    const w = r.worker_id || r.worker_name || '?';
    (branches[br][w] ||= { worker: { name: r.worker_name || '—', employee_id: r.employee_id, avatar: r.avatar || '?', branch_name: br }, rows: [] });
    branches[br][w].rows.push(r);
  });
  Object.values(branches).forEach(b => Object.values(b).forEach(w => w.rows.sort((a, b) => (b.date || '').localeCompare(a.date || ''))));
  const branchList = Object.keys(branches).sort();
  const showBranchCards = isMaster && !openBranch && branchList.length > 0;
  const renderBranches = isMaster ? (openBranch ? [openBranch] : []) : branchList;

  const onPdf = (title, sub, rows) => {
    if (!rows || !rows.length) return;
    const doc = lwcBuildCompletionReport(title, sub, rows);
    setPdfPrev({ doc, url: doc.output('bloburl'), name: lwcReportName2(title) });
  };
  const downloadDay = (day) => {
    const rows = filtered.filter(r => r.date === day).sort((a, b) => (a.worker_name || '').localeCompare(b.worker_name || ''));
    onPdf(`Daily Completion — ${day}`, `${isMaster ? 'All branches' : (branchList[0] || '')} · ${rows.length} jobs`, rows);
  };
  const downloadAll = () => {
    const src = (isMaster && openBranch) ? filtered.filter(r => r.branch_name === openBranch) : filtered;
    onPdf(`${span === 1 ? 'Daily' : span === 7 ? 'Weekly' : '2-Week'} Completion — ${isMaster ? (openBranch || 'Network') : (branchList[0] || 'Branch')}`,
      `${src.length} jobs · ${lwcDK(winStart)} → ${lwcDK(winEnd)}`,
      [...src].sort((a, b) => (a.worker_name || '').localeCompare(b.worker_name || '') || (a.date || '').localeCompare(b.date || '')));
  };

  const branchSummary = (br) => {
    const ws = Object.values(branches[br] || {});
    const rows = ws.flatMap(w => w.rows);
    const ot = rows.reduce((a, r) => a + r.overtime_min, 0);
    const onT = rows.filter(r => r.overtime_min === 0).length;
    const avg = rows.length ? (rows.reduce((a, r) => a + r.score, 0) / rows.length).toFixed(1) : '—';
    return { workers: ws.length, jobs: rows.length, ot, onTimePct: rows.length ? Math.round(onT / rows.length * 100) : 0, avg };
  };

  return (
    <>
      <div className="section-head">
        <div>
          {openBranch && <button className="btn btn-sm btn-ghost" style={{ marginBottom: 8 }} onClick={() => setOpenBranch(null)}><Icon name="arrow-left" size={12}/> ALL BRANCHES</button>}
          <h2>Work completion</h2>
          <span className="sub">{isMaster ? (openBranch ? `${openBranch} · branch detail` : 'All branches · network log') : `${branchList[0] || me.branch_id || 'Branch'} · branch log`} · rolling 2-week retention</span>
        </div>
        <div className="row" style={{ gap: 10 }}>
          <span className="chip ghost mono">{totalJobs} JOBS</span>
          <span className="chip ok">{totalJobs ? Math.round(onTime / totalJobs * 100) : 0}% ON-TIME</span>
          <span className={`chip ${totalOT > 0 ? 'danger' : 'ghost'}`}>{totalOT}m OVERTIME</span>
        </div>
      </div>

      <div className="wc-toolbar">
        <Icon name="calendar" size={15} style={{ color: 'var(--t-2)' }}/>
        <span className="wc-range">Window end</span>
        <input className="wc-date" type="date" value={endStr} max={today} onChange={e => setEndStr(e.target.value || today)}/>
        <div className="wc-presets">
          {[['today', 'Day'], ['1w', '1 Week'], ['2w', '2 Weeks']].map(([k, l]) => (
            <span key={k} className={`wc-preset ${preset === k ? 'active' : ''}`} onClick={() => setPreset(k)}>{l}</span>
          ))}
        </div>
        <span className="wc-range" style={{ color: 'var(--t-3)' }}>{lwcDK(winStart)} → {lwcDK(winEnd)}</span>
        <div className="spacer"/>
        <button className="btn btn-amber btn-sm" onClick={downloadAll}><Icon name="history" size={13}/> DOWNLOAD {span === 1 ? 'DAY' : span === 7 ? '1-WEEK' : '2-WEEK'} PDF</button>
      </div>

      {!showBranchCards && days.length > 0 && (
        <div>
          <div className="eyebrow" style={{ marginBottom: 8 }}>PER-DAY EXPORTS · TAP TO DOWNLOAD</div>
          <div className="wc-days">
            {days.map(day => {
              const c = filtered.filter(x => x.date === day).length;
              return (
                <button key={day} className="wc-day-chip" onClick={() => downloadDay(day)}>
                  {new Date(day + 'T12:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short' })}
                  <span className="n">· {c}</span>
                  <span className="dl"><Icon name="arrow-right" size={11} stroke={2}/></span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {totalJobs === 0 && (
        <div className="list-card"><div className="wc-empty"><Icon name="history" size={28}/><div className="t">No completions in this window</div></div></div>
      )}

      {showBranchCards && (
        <div className="branch-health-grid">
          {branchList.map(br => {
            const s = branchSummary(br);
            const lvl = s.avg === '—' ? 'mid' : (+s.avg >= 95 ? 'high' : +s.avg >= 88 ? 'mid' : 'low');
            return (
              <div key={br} className="wc-branch-card" onClick={() => setOpenBranch(br)}>
                <div className="wbc-top">
                  <div><div className="wbc-name">{br}</div><div className="wbc-sub">{s.workers} workers · {s.jobs} jobs</div></div>
                  <div className={`orb-wrap ${lvl === 'low' ? 'low' : lvl === 'mid' ? 'mid' : ''}`} style={{ width: 44, height: 44 }}><div className="orb-ring"/><div className="orb-core"/></div>
                </div>
                <div className="wbc-stats">
                  <div className="cell"><div className="v" style={{ color: 'var(--ok)' }}>{s.onTimePct}%</div><div className="l">On-Time</div></div>
                  <div className="cell"><div className="v" style={{ color: s.ot > 0 ? 'var(--danger)' : 'var(--t-1)' }}>{s.ot}m</div><div className="l">Overtime</div></div>
                  <div className="cell"><div className="v" style={{ color: 'var(--amber)' }}>{s.avg}{s.avg !== '—' ? '%' : ''}</div><div className="l">Avg Score</div></div>
                </div>
                <div className="wbc-go">VIEW WORKER COMPLETIONS <Icon name="arrow-right" size={13}/></div>
              </div>
            );
          })}
        </div>
      )}

      {renderBranches.map(br => branches[br] && (
        <div key={br} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {Object.values(branches[br]).sort((a, b) => b.rows.length - a.rows.length).map(w => (
            <LwcWorkerCard key={w.worker.employee_id || w.worker.name} worker={w.worker} rows={w.rows} onPdf={onPdf} onOpen={setReportRow}/>
          ))}
        </div>
      ))}
      {reportRow && <LwcReportModal row={reportRow} onClose={() => setReportRow(null)}/>}
      {pdfPrev && <LwcPdfPreviewModal pdf={pdfPrev} onClose={() => setPdfPrev(null)}/>}
    </>
  );
};
window.LiveWorkCompletion = LiveWorkCompletion;

// ── Admin · Bay Management (live) ───────────────────────────
// ════════════════════════════════════════════════════════════════
//  Admin · Bay Management — FLEET VIEW (bay-first operations console)
//  Each bay is one operational unit: it OWNS its worker (primary, or an
//  active temporary replacement), camera, timer/ESP32 and recording.
//  Worker selection lives ONLY here — never on a job. Scales to 50–100+ bays.
// ════════════════════════════════════════════════════════════════
const fvPad = (n) => String(n).padStart(2, '0');
const fvInitials = (name) => (name || '?').split(' ').map(x => x[0]).join('').slice(0, 2).toUpperCase();

// operational status → label + colour tone
const FV_STATUS = {
  available:   { label: 'AVAILABLE',   tone: 'ok' },
  running:     { label: 'RUNNING',     tone: 'amber' },
  paused:      { label: 'PAUSED',      tone: 'warn' },
  maintenance: { label: 'MAINTENANCE', tone: 'info' },
  no_worker:   { label: 'NO WORKER',   tone: 'danger' },
  disabled:    { label: 'DISABLED',    tone: 'ghost' },
};
// device state → dot colour
const FV_DOT = { online: 'ok', synced: 'ok', recording: 'amber', counting: 'amber',
  offline: 'danger', unpaired: 'ghost', disabled: 'ghost', idle: 'ghost', paused: 'warn' };

const FvDot = ({ state, label }) => (
  <span className="fv-dev" title={`${label}: ${state}`}>
    <span className={`dot ${FV_DOT[state] || 'ghost'} ${state === 'recording' || state === 'counting' ? 'pulsing' : ''}`}/>
    <span className="fv-dev-l">{label}</span>
  </span>
);

const fvRemain = (sec) => {
  if (sec == null) return '—';
  const neg = sec < 0; const s = Math.abs(sec | 0);
  return `${neg ? '-' : ''}${fvPad(Math.floor(s / 60))}:${fvPad(s % 60)}`;
};

// ── Worker modal: assign primary (unstaffed bay) OR temporary replacement ──
const FvWorkerModal = ({ bay, workers, mode, onClose, onDone }) => {
  const { useState, useEffect } = React;
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const today = new Date().toISOString().slice(0, 10);
  const plus7 = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  const [wid, setWid] = useState('');
  const [reason, setReason] = useState('');
  const [from, setFrom] = useState(today);
  const [until, setUntil] = useState(plus7);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // workers in the same branch, excluding the current primary for a temp cover
  const pool = workers.filter(w => (!bay.branch_id || w.branch_id === bay.branch_id)
    && !(mode === 'temp' && bay.worker && w.id === bay.worker.id));
  const isTemp = mode === 'temp';
  const submit = async () => {
    if (!wid) { setErr('Select a worker'); return; }
    setBusy(true); setErr('');
    try {
      if (isTemp) {
        if (until < from) { setErr('End date must be after start'); setBusy(false); return; }
        await BW_API.tempAssignWorker(bay.bay_id, { replacement_worker_id: wid, start_date: from, end_date: until, reason });
      } else {
        await BW_API.assignPrimaryWorker(bay.bay_id, wid);
      }
      onDone(isTemp ? 'Temporary worker assigned ✓' : 'Primary worker assigned ✓');
    } catch (e) { setErr(e.message || 'Failed'); setBusy(false); }
  };
  return (
    <div className="modal-scrim" onClick={onClose} style={{ zIndex: 360 }}>
      <div className="modal jf-modal" style={{ maxWidth: 460 }} onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div className="row" style={{ gap: 11 }}>
            <div className="jf-head-ico"><Icon name="user" size={15}/></div>
            <div>
              <div className="sc-title">{isTemp ? 'Replace Worker' : 'Assign Primary Worker'} · Bay {fvPad(bay.bay_number)}</div>
              <div className="sc-sub">{isTemp ? 'Temporary cover · auto-reverts to primary on end date' : 'Makes the bay operational so it can take jobs'}</div>
            </div>
          </div>
          <button className="modal-close" onClick={onClose}><Icon name="x" size={15}/></button>
        </div>
        <div className="modal-scroll" style={{ padding: 18, display: 'grid', gap: 14 }}>
          {isTemp && bay.worker && (
            <div className="fv-mod-note"><Icon name="shield" size={12}/> Covering <b>{bay.worker.name}</b> — the bay (camera · timer · ESP32) stays unchanged; only the worker swaps.</div>
          )}
          <label className="fv-lbl">Worker
            <select value={wid} onChange={e => setWid(e.target.value)} className="fv-select">
              <option value="">Select worker…</option>
              {pool.map(w => <option key={w.id} value={w.id}>{w.name} · {w.employee_id || '—'}</option>)}
            </select>
          </label>
          {isTemp && <>
            <label className="fv-lbl">Reason
              <input className="fv-select" value={reason} onChange={e => setReason(e.target.value)} placeholder="Sick leave, training…"/>
            </label>
            <div className="row" style={{ gap: 10 }}>
              <label className="fv-lbl" style={{ flex: 1 }}>From<input type="date" className="fv-select" value={from} onChange={e => setFrom(e.target.value)}/></label>
              <label className="fv-lbl" style={{ flex: 1 }}>Until<input type="date" className="fv-select" value={until} onChange={e => setUntil(e.target.value)}/></label>
            </div>
          </>}
          {err && <div className="pt-form-err"><Icon name="alert" size={13}/> {err}</div>}
        </div>
        <div className="modal-foot">
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose}>CANCEL</button>
          <button className="btn btn-amber" style={{ flex: 2 }} disabled={busy} onClick={submit}>
            <Icon name="check" size={15}/> {busy ? 'SAVING…' : (isTemp ? 'ASSIGN TEMP WORKER' : 'ASSIGN WORKER')}
          </button>
        </div>
      </div>
    </div>
  );
};

// ── Details drawer (right panel) ───────────────────────────────────
const FvDrawer = ({ bayId, onClose, onReplace, onAssignPrimary, flash, reloadList }) => {
  const { useState, useEffect, useCallback } = React;
  const [d, setD] = useState(null);
  const [busy, setBusy] = useState('');
  const [confirm, setConfirm] = useState(null);   // 'disable' | 'delete'
  const confirmRef = React.useRef(confirm); confirmRef.current = confirm;
  const load = useCallback(() => { BW_API.bayDetail(bayId).then(setD).catch(() => {}); }, [bayId]);
  useEffect(() => { setD(null); load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, [bayId, load]);
  // Escape closes (confirm dialog first, then the drawer) — read the confirm
  // state from a ref so we never call parent setState inside a state updater
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (confirmRef.current) setConfirm(null); else onClose();
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const run = async (fn, msg) => {
    setBusy(msg); try { const r = await fn(); flash((r && r.message) || msg); load(); reloadList(); }
    catch (e) { flash(e.message || 'Failed', 'err'); } finally { setBusy(''); }
  };
  const st = d ? (FV_STATUS[d.status] || FV_STATUS.available) : null;
  return (
    <div className="fv-drawer-scrim" onClick={onClose}>
      <div className="fv-drawer" onClick={e => e.stopPropagation()}>
        {!d ? <div className="fv-skel-drawer">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="fv-skel-row"/>)}</div> : <>
          <div className="fv-dr-head">
            <div>
              <div className="fv-dr-title">BAY {fvPad(d.bay_number)} <span className={`chip ${st.tone}`}>{st.label}</span></div>
              <div className="fv-dr-sub">{d.camera_channel} · {d.branch_id}</div>
            </div>
            <button className="modal-close" onClick={onClose}><Icon name="x" size={15}/></button>
          </div>
          <div className="fv-dr-body">
            {/* bay information */}
            <div className="fv-dr-sec">
              <div className="fv-dr-sec-h">BAY INFORMATION</div>
              <div className="fv-dr-dev"><span>Name</span><span className="cell-name" style={{ fontSize: 12 }}>{d.bay_name}</span></div>
              <div className="fv-dr-dev"><span>Camera channel</span><span className="mono" style={{ fontSize: 11, color: 'var(--t-2)' }}>{d.camera_channel}</span></div>
              <div className="fv-dr-dev"><span>Branch</span><span className="mono" style={{ fontSize: 11, color: 'var(--t-2)' }}>{d.branch_id}</span></div>
            </div>
            {/* worker */}
            <div className="fv-dr-sec">
              <div className="fv-dr-sec-h">WORKER {d.worker && d.worker.is_temp && <span className="bay-temp-tag">TEMP COVER</span>}</div>
              {d.worker ? (
                <div className="fv-dr-worker">
                  <Avatar id={d.worker.employee_id || d.worker.id} initials={fvInitials(d.worker.name)} size={36}/>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="cell-name">{d.worker.name}</div>
                    <span className="cell-meta">{d.worker.employee_id || '—'}
                      {d.worker.is_temp && d.primary_worker ? ` · covering ${d.primary_worker.name}` : ' · Primary'}</span>
                  </div>
                  {d.performance != null && <span className="fv-perf">{d.performance}%<small>perf</small></span>}
                </div>
              ) : <div className="fv-dr-empty"><Icon name="alert" size={14}/> No primary worker — bay is not operational.</div>}
              {d.temp && <div className="fv-dr-temp">⏱ {d.temp.reason || 'Temporary cover'} · until {d.temp.until}</div>}
              <div className="row" style={{ gap: 8, marginTop: 10 }}>
                {!d.worker && <button className="btn btn-sm btn-amber" onClick={() => onAssignPrimary(d)}><Icon name="user" size={12}/> Assign Primary Worker</button>}
                {d.worker && !d.temp && <button className="btn btn-sm btn-ghost" onClick={() => onReplace(d)}><Icon name="user" size={12}/> Replace Worker</button>}
                {d.temp && <button className="btn btn-sm btn-amber" disabled={busy} onClick={() => run(() => BW_API.revertBayWorker(d.bay_id), 'Reverted to primary')}><Icon name="history" size={12}/> Revert Now</button>}
              </div>
            </div>
            {/* devices */}
            <div className="fv-dr-sec">
              <div className="fv-dr-sec-h">DEVICES</div>
              <div className="fv-dr-dev"><span>📷 Camera</span><span className={`chip ${FV_DOT[d.camera ? d.camera.status : 'unpaired'] || 'ghost'}`}>{d.camera ? d.camera.status.toUpperCase() : 'UNPAIRED'}</span></div>
              {d.camera && <div className="fv-dr-meta">{d.camera.camera_id} · {d.camera.ip_address || 'no ip'}</div>}
              <div className="fv-dr-dev"><span>⏱ Timer</span><span className={`chip ${FV_DOT[d.timer ? d.timer.status : 'unpaired'] || 'ghost'}`}>{d.timer ? d.timer.status.toUpperCase() : 'UNPAIRED'}</span></div>
              {d.timer && <div className="fv-dr-meta">{d.timer.timer_id} · fw {d.timer.firmware_version || '—'}</div>}
              <div className="fv-dr-dev"><span>📡 ESP32</span><span className={`chip ${FV_DOT[d.esp32] || 'ghost'}`}>{(d.esp32 || 'unpaired').toUpperCase()}</span></div>
              {d.timer && <div className="fv-dr-meta">{d.timer.topic}</div>}
              <div className="fv-dr-dev"><span>📶 MQTT broker</span><span className={`chip ${d.mqtt ? 'ok' : 'danger'}`}>{d.mqtt ? 'CONNECTED' : 'DOWN'}</span></div>
              <div className="row fv-dr-actions">
                {d.camera && <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => run(() => BW_API.testCamera(d.camera.id), 'Camera tested')}>Test Camera</button>}
                {d.timer && <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => run(() => BW_API.testTimer(d.timer.id), 'Timer tested')}>Test Timer</button>}
                {d.timer && <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => run(() => BW_API.restartTimer(d.timer.id), 'Restart sent')}>Restart ESP32</button>}
              </div>
            </div>
            {/* current + today */}
            <div className="fv-dr-sec">
              <div className="fv-dr-sec-h">CURRENT SERVICE</div>
              {d.current_job ? (
                <div className="fv-dr-cur">
                  <div className="cell-name">{d.current_job.job_card_number} · {d.current_job.vehicle || '—'}</div>
                  <span className="cell-meta">{d.current_job.session_status} · {fvRemain(d.current_job.remaining)} left</span>
                </div>
              ) : <div className="fv-dr-meta">None</div>}
              <div className="fv-dr-stat"><span>Today</span><b>{d.today_jobs} jobs</b></div>
            </div>
            {/* history */}
            <div className="fv-dr-sec">
              <div className="fv-dr-sec-h">RECENT SERVICES</div>
              {(d.history || []).length === 0 ? <div className="fv-dr-meta">No completed services yet.</div>
                : d.history.map(h => (
                  <div key={h.session_id} className="fv-dr-hist">
                    <span className="cell-name" style={{ fontSize: 12 }}>{h.vehicle || h.job_card_number || h.session_id}</span>
                    <span className="cell-meta">{h.date || '—'}{h.overtime_min > 0 ? ` · OT ${h.overtime_min}m` : ''}</span>
                  </div>
                ))}
            </div>
            {/* maintenance */}
            <div className="fv-dr-sec">
              <div className="fv-dr-sec-h">BAY CONTROL</div>
              <div className="row" style={{ gap: 8 }}>
                {d.status === 'maintenance'
                  ? <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => run(() => BW_API.setBayStatus(d.bay_id, 'available'), 'Bay back in service')}><Icon name="check" size={12}/> End Maintenance</button>
                  : <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => run(() => BW_API.setBayStatus(d.bay_id, 'maintenance'), 'Bay in maintenance')}><Icon name="cog" size={12}/> Maintenance</button>}
              </div>
            </div>
            {/* audit */}
            {(d.audit || []).length > 0 && (
              <div className="fv-dr-sec">
                <div className="fv-dr-sec-h">AUDIT TIMELINE</div>
                {d.audit.slice(0, 8).map((a, i) => (
                  <div key={i} className="fv-dr-audit"><span className="audit-tag update">{a.action.replace(/^BAY_/, '')}</span>
                    <span className="cell-meta">{a.at ? new Date(a.at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}</span></div>
                ))}
              </div>
            )}
            {/* danger zone */}
            <div className="fv-dr-sec fv-danger">
              <div className="fv-dr-sec-h" style={{ color: 'var(--danger)' }}>DANGER ZONE</div>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                {d.status !== 'disabled' && d.status !== 'running' && d.status !== 'paused' &&
                  <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setConfirm('disable')}>Disable Bay</button>}
                {d.status !== 'running' && d.status !== 'paused' &&
                  <button className="btn btn-sm btn-ghost fv-del" disabled={busy} onClick={() => setConfirm('delete')}>Delete Bay</button>}
              </div>
              {confirm && (
                <div className="fv-confirm">
                  <span>{confirm === 'delete'
                    ? `Delete BAY ${fvPad(d.bay_number)}? With history it is archived; an empty bay is removed.`
                    : `Disable BAY ${fvPad(d.bay_number)}? It will stop accepting jobs.`}</span>
                  <div className="row" style={{ gap: 8 }}>
                    <button className="btn btn-sm btn-ghost" onClick={() => setConfirm(null)}>Cancel</button>
                    <button className="btn btn-sm btn-amber" disabled={busy} onClick={async () => {
                      const which = confirm; setConfirm(null);
                      if (which === 'delete') { await run(() => BW_API.deleteBay(d.bay_id), 'Bay deleted'); onClose(); }
                      else await run(() => BW_API.setBayStatus(d.bay_id, 'disabled'), 'Bay disabled');
                    }}>Confirm</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </>}
      </div>
    </div>
  );
};

const LiveBayManagement = () => {
  const { useState, useMemo, useRef, useEffect } = React;
  const poll = useBWPoll(async () => {
    const [ops, workers] = await settle([[BW_API.bayOperations(), { summary: {}, bays: [] }], [BW_API.workers(), []]]);
    return { ops: ops || { summary: {}, bays: [] }, workers: workers || [] };
  }, [], 3000);
  const data = poll.data || { ops: { summary: {}, bays: [] }, workers: [] };
  const sum = data.ops.summary || {};
  const allBays = data.ops.bays || [];

  const [q, setQ] = useState('');
  const [fStatus, setFStatus] = useState('ALL');
  const [fCam, setFCam] = useState('ALL');
  const [sort, setSort] = useState('attention');
  const [drawerId, setDrawerId] = useState(null);
  const [modal, setModal] = useState(null);      // {bay, mode}
  const [toast, setToast] = useState(''); const [toastType, setToastType] = useState('ok');
  const [sel, setSel] = useState(0);             // keyboard cursor
  const flash = (m, t = 'ok') => { setToast(m); setToastType(t); setTimeout(() => setToast(''), 3000); };

  const rows = useMemo(() => {
    let r = allBays.filter(b => {
      if (fStatus !== 'ALL' && b.status !== fStatus) return false;
      if (fCam !== 'ALL' && b.camera !== fCam) return false;
      if (q) {
        const s = q.toLowerCase();
        return [`bay ${b.bay_number}`, String(b.bay_number), b.bay_name, b.worker && b.worker.name,
          b.worker && b.worker.employee_id, b.current_job && b.current_job.vehicle]
          .some(v => (v || '').toString().toLowerCase().includes(s));
      }
      return true;
    });
    if (sort === 'bay') r = [...r].sort((a, b) => a.bay_number - b.bay_number);
    else if (sort === 'today') r = [...r].sort((a, b) => b.today_jobs - a.today_jobs);
    else r = [...r].sort((a, b) => (a.attention === b.attention ? a.bay_number - b.bay_number : (a.attention ? -1 : 1)));
    return r;
  }, [allBays, q, fStatus, fCam, sort]);

  // ── virtual scrolling (50+ bays): fixed 54px rows → windowed rendering ──
  const ROW_H = 54, VIRTUAL_AT = 40, OVERSCAN = 8;
  const scrollRef = useRef(null);
  const [scrollTop, setScrollTop] = useState(0);
  const virtual = rows.length > VIRTUAL_AT;
  const viewH = (scrollRef.current && scrollRef.current.clientHeight) || 620;
  const vStart = virtual ? Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN) : 0;
  const vEnd = virtual ? Math.min(rows.length, vStart + Math.ceil(viewH / ROW_H) + OVERSCAN * 2) : rows.length;
  const visible = rows.slice(vStart, vEnd);

  const scrollSelIntoView = (idx) => {
    const el = scrollRef.current; if (!el) return;
    const y = idx * ROW_H;
    if (y < el.scrollTop) el.scrollTop = y;
    else if (y + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = y + ROW_H - el.clientHeight;
  };

  // keyboard navigation (↑/↓ move · Enter open) — follows the scroll window
  const rowsRef = useRef(rows); rowsRef.current = rows;
  useEffect(() => {
    const onKey = (e) => {
      if (drawerId || modal) return;
      const n = rowsRef.current.length; if (!n) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => { const v = Math.min(n - 1, s + 1); scrollSelIntoView(v); return v; }); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => { const v = Math.max(0, s - 1); scrollSelIntoView(v); return v; }); }
      else if (e.key === 'Enter') { const b = rowsRef.current[sel]; if (b) setDrawerId(b.bay_id); }
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [drawerId, modal, sel]);

  const kpi = (label, val, tone) => <div className={`fv-kpi ${tone || ''}`}><div className="v">{val || 0}</div><div className="l">{label}</div></div>;
  const onReplace = (bay) => { setDrawerId(null); setModal({ bay, mode: 'temp' }); };
  const onAssignPrimary = (bay) => { setDrawerId(null); setModal({ bay, mode: 'primary' }); };

  return (
    <>
      {toast && <div className={`lja-toast ${toastType}`}><Icon name={toastType === 'err' ? 'alert' : 'check'} size={14}/> {toast}</div>}
      {modal && <FvWorkerModal bay={modal.bay} workers={data.workers} mode={modal.mode}
        onClose={() => setModal(null)} onDone={(m) => { setModal(null); flash(m); poll.reload(); }}/>}
      {drawerId && <FvDrawer bayId={drawerId} onClose={() => setDrawerId(null)}
        onReplace={onReplace} onAssignPrimary={onAssignPrimary} flash={flash} reloadList={() => poll.reload()}/>}

      <div className="section-head">
        <div><h2>Bay Management · Fleet View</h2>
          <span className="sub">Bay-first operations · {allBays.length} bays · {sum.attention || 0} need attention · backend connected</span></div>
        <span className="chip ok mono"><span className="dot live pulsing"/>REAL-TIME</span>
      </div>

      {/* summary */}
      <div className="fv-kpis">
        {kpi('BAYS', sum.total)}{kpi('AVAILABLE', sum.available, 'ok')}{kpi('RUNNING', sum.running, 'amber')}
        {kpi('MAINTENANCE', sum.maintenance, 'info')}{kpi('NO WORKER', sum.no_worker, 'danger')}{kpi('ATTENTION', sum.attention, 'warn')}
      </div>

      {/* toolbar */}
      <div className="fv-toolbar">
        <div className="fv-search"><Icon name="search" size={14}/>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search bay · worker · vehicle…"/></div>
        <select className="fv-select sm" value={fStatus} onChange={e => setFStatus(e.target.value)}>
          <option value="ALL">All status</option><option value="available">Available</option><option value="running">Running</option>
          <option value="paused">Paused</option><option value="maintenance">Maintenance</option><option value="no_worker">No worker</option></select>
        <select className="fv-select sm" value={fCam} onChange={e => setFCam(e.target.value)}>
          <option value="ALL">All cameras</option><option value="online">Cam online</option><option value="offline">Cam offline</option><option value="unpaired">Cam unpaired</option></select>
        <select className="fv-select sm" value={sort} onChange={e => setSort(e.target.value)}>
          <option value="attention">Sort: Attention</option><option value="bay">Sort: Bay #</option><option value="today">Sort: Busiest</option></select>
        <span className="fv-hint mono">↑↓ navigate · ↵ details</span>
      </div>

      {/* table — header outside the scroller (structurally sticky); body is the
          ONLY scroll area, windowed when > 40 bays (uniform 54px rows) */}
      <div className="fv-table">
        <div className="fv-row fv-head">
          <span>BAY</span><span>STATUS</span><span>WORKER</span><span className="fv-c">CAM</span><span className="fv-c">TIMER</span>
          <span className="fv-c">ESP32</span><span>CURRENT JOB</span><span className="fv-c">TODAY</span><span className="fv-c"></span>
        </div>
        <div className="fv-scroll" ref={scrollRef}
          onScroll={(e) => { if (virtual) setScrollTop(e.currentTarget.scrollTop); }}>
          {poll.loading && !allBays.length
            ? Array.from({ length: 6 }).map((_, i) => <div key={i} className="fv-row fv-skel"><span className="fv-skel-bar"/></div>)
            : rows.length === 0
              ? <div className="fv-empty"><Icon name="route" size={26}/><h3>No bays match</h3><p>Adjust the search or filters.</p></div>
              : <>
                {virtual && <div style={{ height: vStart * ROW_H }}/>}
                {visible.map((b, vi) => {
                  const i = vStart + vi;
                  const st = FV_STATUS[b.status] || FV_STATUS.available;
                  return (
                    <div key={b.bay_id} className={`fv-row ${b.attention ? 'attn' : ''} ${i === sel ? 'sel' : ''}`}
                      onMouseEnter={() => setSel(i)} onClick={() => setDrawerId(b.bay_id)}>
                      <span className="fv-bay">BAY <b>{fvPad(b.bay_number)}</b></span>
                      <span><span className={`chip ${st.tone}`}><span className={`dot ${st.tone} ${b.status === 'running' ? 'pulsing' : ''}`}/>{st.label}</span></span>
                      <span className="fv-wkr">
                        {b.worker
                          ? <><Avatar id={b.worker.employee_id || b.worker.id} initials={fvInitials(b.worker.name)} size={26}/>
                            <span style={{ minWidth: 0 }}><span className="cell-name">{b.worker.name}{b.worker.is_temp && <span className="bay-temp-tag">TEMP</span>}</span>
                              <span className="cell-meta">{b.worker.employee_id || '—'}</span></span></>
                          : <span className="fv-nowkr"><Icon name="alert" size={13}/> Unstaffed</span>}
                      </span>
                      <span className="fv-c"><span className={`dot ${FV_DOT[b.camera] || 'ghost'}`} title={`Camera: ${b.camera}`}/></span>
                      <span className="fv-c"><span className={`dot ${FV_DOT[b.timer] || 'ghost'}`} title={`Timer: ${b.timer}`}/></span>
                      <span className="fv-c"><span className={`dot ${FV_DOT[b.esp32] || 'ghost'} ${b.esp32 === 'synced' && b.status === 'running' ? 'pulsing' : ''}`} title={`ESP32: ${b.esp32}`}/></span>
                      <span className="fv-cur">{b.current_job
                        ? <><span className="cell-name">{b.current_job.job_card_number}</span><span className="cell-meta">{b.current_job.vehicle || '—'} · {fvRemain(b.current_job.remaining)}</span></>
                        : <span className="cell-meta">—</span>}</span>
                      <span className="fv-c fv-today">{b.today_jobs}</span>
                      <span className="fv-c"><Icon name="arrow-right" size={14}/></span>
                    </div>
                  );
                })}
                {virtual && <div style={{ height: Math.max(0, (rows.length - vEnd) * ROW_H) }}/>}
              </>}
        </div>
      </div>
    </>
  );
};
window.LiveBayManagement = LiveBayManagement;

// ── Admin · Parts Time (live — full CRUD) ──────────────────
// ── Admin · Parts Time (live — full CRUD, file mgmt, audit) ─
// Reuses the demo design's pure components (UnitConfig, FileCard,
// DeleteConfirmModal, AuditDrawer, FileTypeIcon, extractFile,
// fmtDate, fmtDateShort) and adds API-backed import/preview/form.
const LPT_PAGE = 12;
const LPT_COLS = '96px 100px minmax(160px,1.6fr) 60px 68px 72px minmax(120px,1fr) 78px 78px 64px';

// Import / Replace modal — client-side extract → JSON bulk import
const LiveImportModal = ({ onClose, onDone, replaceFile }) => {
  const isReplace = !!replaceFile;
  const [phase, setPhase] = useLS('drop');   // drop | extracting | preview | done | error
  const [status, setStatus] = useLS('');
  const [result, setResult] = useLS(null);
  const [rows, setRows] = useLS([]);
  const [pendingFile, setPendingFile] = useLS(null);
  const [errMsg, setErrMsg] = useLS('');
  const fileRef = React.useRef(null);

  const process = async (file) => {
    if (!file) return;
    setPendingFile(file); setPhase('extracting'); setStatus('Reading file…');
    try {
      await new Promise(r => setTimeout(r, 250));
      setStatus('Extracting parts data…');
      const extracted = await extractFile(file);
      if (!extracted.length) throw new Error('No part rows found in file.');
      setStatus(`Found ${extracted.length} rows — ready to import`);
      setRows(extracted);
      setPhase('preview');
    } catch (e) { setErrMsg(e.message || 'Extraction failed'); setPhase('error'); }
  };

  const confirm = async () => {
    setPhase('extracting'); setStatus(`Saving ${rows.length} rows to server…`);
    try {
      const payload = {
        file_name: pendingFile.name,
        file_type: /\.pdf$/i.test(pendingFile.name) ? 'pdf' : 'excel',
        size_bytes: pendingFile.size || 0,
        rows,
      };
      const res = isReplace
        ? await BW_API.partsReplaceFile(replaceFile.id, payload)
        : await BW_API.partsImportRows(payload);
      setResult(res); setPhase('done'); onDone && onDone();
    } catch (e) { setErrMsg(e.message || 'Import failed'); setPhase('error'); }
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" style={{ width: 600, maxWidth: '95%' }} onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div className="row" style={{ gap: 10 }}>
            <div className="sc-ico" style={{ width: 32, height: 32, background: 'var(--amber-soft)', color: 'var(--amber)', border: '1px solid rgba(255,107,26,0.3)' }}><Icon name="upload" size={14}/></div>
            <div>
              <div className="sc-title">{isReplace ? `Update File · ${replaceFile.name}` : 'Import Parts File'}</div>
              <div className="sc-sub">{isReplace ? 'Old parts removed · new parts extracted & saved' : 'Excel (.xlsx/.xls) or PDF · extracted in-browser, saved to server'}</div>
            </div>
          </div>
          <button className="modal-close" onClick={onClose}><Icon name="x" size={15}/></button>
        </div>

        {phase === 'drop' && (
          <div style={{ padding: 20 }}>
            {isReplace && (
              <div className="pt-replace-warn">
                <Icon name="alert" size={14}/>
                <span>Replacing will <b>remove {replaceFile.totalParts} existing parts</b> from this file and re-import from the new version.</span>
              </div>
            )}
            <div className="dropzone"
              onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add('over'); }}
              onDragLeave={e => { e.currentTarget.classList.remove('over'); }}
              onDrop={e => { e.preventDefault(); e.currentTarget.classList.remove('over'); process(e.dataTransfer.files[0]); }}
              onClick={() => fileRef.current && fileRef.current.click()}>
              <div className="dz-ico"><Icon name="upload" size={32}/></div>
              <h3 style={{ margin: '10px 0 4px', fontSize: 16, fontWeight: 600 }}>Drop file or click to browse</h3>
              <p style={{ margin: 0, fontSize: 13, color: 'var(--t-2)' }}>Excel (.xlsx / .xls) or PDF</p>
              <div className="hint" style={{ marginTop: 12 }}>EXTRACTED IN-BROWSER · DUPLICATE PARTS SKIPPED</div>
              <input ref={fileRef} type="file" accept=".xlsx,.xls,application/pdf,.pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" hidden onChange={e => process(e.target.files[0])}/>
            </div>
            <div className="pt-map" style={{ marginTop: 16 }}>
              {[['Material', '→ Part Number'], ['Material description', '→ Part Name'], ['Labour Units', '→ Unit Value (time)'], ['Model / Product code', '→ Grouping tags']].map(([a, b]) => (
                <div key={a} className="pt-map-row"><span>{a}</span><b>{b}</b></div>
              ))}
            </div>
          </div>
        )}

        {phase === 'extracting' && (
          <div className="scan-stage" style={{ padding: 40, minHeight: 200 }}>
            <div style={{ color: 'var(--amber)', marginBottom: 12 }}><Icon name="file" size={42}/></div>
            <div className="scan-line"/>
            <div className="scan-status" style={{ marginTop: 16 }}><span className="dot amber pulsing"/>{status}</div>
          </div>
        )}

        {phase === 'preview' && rows.length > 0 && (
          <div>
            <div style={{ padding: '14px 18px', background: 'var(--bg-1)', borderBottom: '1px solid var(--hair)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <span style={{ fontWeight: 600 }}>{pendingFile?.name}</span>
                <span className="mono" style={{ fontSize: 11, color: 'var(--t-3)', marginLeft: 12, letterSpacing: '0.08em' }}>{rows.length} ROWS EXTRACTED</span>
              </div>
              <span className="chip ok"><span className="dot live"/>READY TO IMPORT</span>
            </div>
            <div style={{ maxHeight: 260, overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'var(--bg-1)', position: 'sticky', top: 0 }}>
                    {['PART NO', 'NAME', 'UNITS', 'MODEL'].map(h => (
                      <th key={h} style={{ padding: '8px 14px', textAlign: 'left', fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.14em', color: 'var(--t-3)', textTransform: 'uppercase', borderBottom: '1px solid var(--hair-strong)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 50).map((r, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid var(--hair)' }}>
                      <td style={{ padding: '8px 14px', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--amber-bright)' }}>{r.pn}</td>
                      <td style={{ padding: '8px 14px', fontSize: 13, fontWeight: 500, maxWidth: 220, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</td>
                      <td style={{ padding: '8px 14px', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--ok)' }}>{r.units}</td>
                      <td style={{ padding: '8px 14px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--t-3)' }}>{r.model || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {rows.length > 50 && <div style={{ padding: '10px 18px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--t-3)', textAlign: 'center', letterSpacing: '0.1em' }}>… and {rows.length - 50} more rows</div>}
            </div>
            <div style={{ padding: '14px 18px', display: 'flex', gap: 10, borderTop: '1px solid var(--hair)', background: 'var(--bg-1)' }}>
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setPhase('drop')}>← CHANGE FILE</button>
              <button className="btn btn-amber" style={{ flex: 2 }} onClick={confirm}><Icon name="check" size={15}/> {isReplace ? 'REPLACE & IMPORT' : 'CONFIRM IMPORT'}</button>
            </div>
          </div>
        )}

        {phase === 'done' && (
          <div className="pt-import-ok" style={{ padding: 32 }}>
            <div className="ico"><Icon name="check" size={26}/></div>
            <div className="t">{isReplace ? 'File replaced successfully' : 'Import complete'}</div>
            <div className="s">
              {result?.added} parts {isReplace ? 're-imported' : 'added'} · {result?.dup_skipped || 0} duplicates skipped
              {isReplace && result?.version ? ` · v${result.version}` : ''}
            </div>
            <button className="btn btn-amber" style={{ marginTop: 20 }} onClick={onClose}>DONE</button>
          </div>
        )}

        {phase === 'error' && (
          <div style={{ padding: 28, textAlign: 'center' }}>
            <div style={{ width: 52, height: 52, margin: '0 auto 14px', borderRadius: 14, background: 'rgba(244,63,94,0.12)', color: 'var(--danger)', display: 'grid', placeItems: 'center' }}><Icon name="alert" size={24}/></div>
            <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>Import Failed</div>
            <div style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 20, maxWidth: 380, margin: '0 auto 20px', lineHeight: 1.6 }}>{errMsg}</div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              <button className="btn btn-ghost" onClick={() => setPhase('drop')}>TRY AGAIN</button>
              <button className="btn btn-amber" onClick={onClose}>CLOSE</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// File Preview modal — fetches parts for one file from the API
const LiveFilePreviewModal = ({ file, onClose }) => {
  const [data, setData] = useLS(null);
  const [q, setQ] = useLS('');
  useLE(() => { let on = true; BW_API.partsFilePreview(file.id).then(d => { if (on) setData(d); }).catch(() => {}); return () => { on = false; }; }, [file.id]);
  const parts = (data && data.parts) || [];
  const mpu = (data && data.mpu) || 15;
  const filtered = parts.filter(p => !q || (p.pn || '').toLowerCase().includes(q.toLowerCase()) || (p.name || '').toLowerCase().includes(q.toLowerCase()) || (p.code || '').toLowerCase().includes(q.toLowerCase()));
  const totalEst = parts.reduce((a, p) => a + (p.units || 0) * mpu, 0);
  const exportCsv = () => {
    const rows = [['Product Code', 'Part Number', 'Part Name', 'Unit Value', 'Unit Time (min)', 'Estimated Time (min)', 'Model', 'Source File', 'Created']];
    parts.forEach(p => rows.push([p.code || '', p.pn, p.name, p.units, mpu, Math.round(p.units * mpu * 100) / 100, p.model || '', p.sourceFileName || file.name, fmtDateShort(p.created)]));
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = file.name.replace(/\.[^.]+$/, '') + '_parts.csv'; a.click();
  };
  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="pdf-modal" style={{ width: 860 }} onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div className="row" style={{ gap: 12 }}>
            <FileTypeIcon type={file.type}/>
            <div>
              <div style={{ fontWeight: 600, fontSize: 15 }}>{file.name}</div>
              <div className="mono" style={{ fontSize: 10, color: 'var(--t-3)', letterSpacing: '0.1em', marginTop: 2 }}>v{file.version} · {fmtDate(file.uploadDate)} · by {file.uploadedBy}</div>
            </div>
          </div>
          <button className="modal-close" onClick={onClose}><Icon name="x" size={15}/></button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 1, background: 'var(--hair)', borderBottom: '1px solid var(--hair)' }}>
          {[['PARTS', parts.length], ['PRODUCT CODES', file.totalCodes || 0], ['ROWS', file.totalRows || parts.length], ['SKIPPED', file.dupSkipped || 0], ['EST. TIME', `${Math.round(totalEst)}m`]].map(([l, v]) => (
            <div key={l} style={{ background: 'var(--bg-1)', padding: '12px 16px' }}>
              <div className="mono" style={{ fontSize: 9, letterSpacing: '0.16em', color: 'var(--t-3)', textTransform: 'uppercase' }}>{l}</div>
              <div className="mono" style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em', marginTop: 6, color: 'var(--t-0)' }}>{v}</div>
            </div>
          ))}
        </div>
        {file.history && file.history.length > 0 && (
          <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--hair)', display: 'flex', gap: 16, background: 'var(--bg-1)', flexWrap: 'wrap' }}>
            <span className="eyebrow eyebrow-amber" style={{ flexShrink: 0 }}>VERSION HISTORY</span>
            {file.history.map((h, i) => (
              <span key={i} className="chip ghost mono" style={{ height: 22, fontSize: 10 }}>v{h.version} · {h.total_parts} parts · {fmtDateShort(h.date)}</span>
            ))}
          </div>
        )}
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--hair)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div className="pt-search" style={{ maxWidth: 300 }}>
            <Icon name="gauge" size={13}/>
            <input placeholder="Search code, part no, or name…" value={q} onChange={e => setQ(e.target.value)}/>
          </div>
          <span className="mono" style={{ fontSize: 11, color: 'var(--t-3)', letterSpacing: '0.1em' }}>{filtered.length} RESULTS</span>
          {!data && <span className="mono" style={{ fontSize: 11, color: 'var(--t-3)' }}><span className="dot amber pulsing"/> LOADING…</span>}
          <div className="spacer"/>
          <button className="btn btn-sm btn-ghost" onClick={exportCsv}><Icon name="upload" size={12} style={{ transform: 'rotate(180deg)' }}/> EXPORT CSV</button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', maxHeight: 340 }} className="pt-table-wrap">
          <div className="pt-row pt-head" style={{ gridTemplateColumns: '92px 110px minmax(140px,1.6fr) 60px 72px 76px' }}>
            <span>PROD CODE</span><span>PART NO</span><span>PART NAME</span>
            <span className="r">UNITS</span><span className="r pt-est">EST</span><span>ADDED</span>
          </div>
          {filtered.length === 0 && <div className="wc-empty"><div className="t">{data ? 'No parts match' : 'Loading…'}</div></div>}
          {filtered.map(p => (
            <div key={p.id} className="pt-row" style={{ gridTemplateColumns: '92px 110px minmax(140px,1.6fr) 60px 72px 76px' }}>
              <span className="mono pt-code">{p.code || '—'}</span>
              <span className="mono pt-pn">{p.pn}</span>
              <span className="pt-name">{p.name}</span>
              <span className="r mono">{p.units}</span>
              <span className="r mono pt-est">{Math.round(p.units * mpu * 100) / 100}m</span>
              <span className="pt-date">{fmtDateShort(p.created)}</span>
            </div>
          ))}
        </div>
        <div className="pdf-modal-foot">
          <span className="mono" style={{ fontSize: 11, color: 'var(--t-3)', letterSpacing: '0.1em' }}>{parts.length} PARTS · 1 UNIT = {mpu} MIN</span>
          <div className="spacer"/>
          <button className="btn btn-ghost" onClick={onClose}>CLOSE</button>
        </div>
      </div>
    </div>
  );
};

// Part Add/Edit modal — async-aware (server validates duplicates)
const LivePartFormModal = ({ initial, mpu, onSave, onClose }) => {
  const [f, setF] = useLS(initial || { pn: '', name: '', model: '', code: '', units: 1 });
  const [err, setErr] = useLS('');
  const [busy, setBusy] = useLS(false);
  const est = Math.round((+f.units || 0) * mpu * 100) / 100;
  const submit = async () => {
    if (!String(f.pn).trim()) { setErr('Part number is required'); return; }
    if (!String(f.name).trim()) { setErr('Part name is required'); return; }
    setErr(''); setBusy(true);
    try { await onSave(f); onClose(); }
    catch (e) { setErr(e.message || 'Could not save'); setBusy(false); }
  };
  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <span className="eyebrow eyebrow-amber">{initial ? 'EDIT PART' : 'ADD PART MANUALLY'}</span>
          <button className="modal-close" onClick={onClose}><Icon name="x" size={15}/></button>
        </div>
        <div className="form-body">
          <div className="fld"><label>Part Number *</label><input className="input" value={f.pn} onChange={e => setF({ ...f, pn: e.target.value })} placeholder="e.g. 36JG0083"/></div>
          <div className="fld"><label>Unit Value *</label><input className="input" type="number" min="0" step="0.01" value={f.units} onChange={e => setF({ ...f, units: e.target.value })}/></div>
          <div className="fld full"><label>Part Name *</label><input className="input" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} placeholder="e.g. KIT BRAKE FLUID RESERVOIR"/></div>
          <div className="fld"><label>Model</label><input className="input" value={f.model} onChange={e => setF({ ...f, model: e.target.value })} placeholder="KTM 390 Duke"/></div>
          <div className="fld"><label>Product Code</label><input className="input" value={f.code} onChange={e => setF({ ...f, code: e.target.value })} placeholder="JG08"/></div>
        </div>
        <div className="pt-est-preview">
          <span className="mono">ESTIMATED TIME AT {mpu}m/UNIT</span>
          <span className="pt-est-val">{f.units || 0} × {mpu} = <b>{est} min</b></span>
        </div>
        {err && <div className="pt-form-err"><Icon name="alert" size={13}/> {err}</div>}
        <div style={{ padding: '8px 18px 18px', display: 'flex', gap: 10 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose}>CANCEL</button>
          <button className="btn btn-amber" style={{ flex: 2 }} disabled={busy} onClick={submit}><Icon name="check" size={15}/> {busy ? 'SAVING…' : (initial ? 'SAVE CHANGES' : 'ADD PART')}</button>
        </div>
      </div>
    </div>
  );
};

const LivePartsTime = () => {
  const [q, setQ] = useLS('');
  const [modelFilter, setModelFilter] = useLS('ALL');
  const [fileFilter, setFileFilter] = useLS('ALL');
  const [fileQ, setFileQ] = useLS('');
  const [fileTypeFilter, setFileTypeFilter] = useLS('ALL');
  const [page, setPage] = useLS(1);
  const [toast, setToast] = useLS('');
  // modals
  const [addModal, setAddModal] = useLS(false);
  const [editPart, setEditPart] = useLS(null);
  const [importModal, setImportModal] = useLS(false);
  const [replaceFile, setReplaceFile] = useLS(null);
  const [previewFile, setPreviewFile] = useLS(null);
  const [deleteFile, setDeleteFile] = useLS(null);
  const [auditOpen, setAuditOpen] = useLS(false);

  const flash = (m) => { setToast(m); setTimeout(() => setToast(''), 3200); };

  // ── polls ──────────────────────────────────────────────────
  const metaPoll = useBWPoll(async () => {
    const [conv, files, models, allCount] = await settle([
      [BW_API.unitConversion(), {}], [BW_API.partsFiles(), []], [BW_API.partsModels(), []],
      [BW_API.partsListPaged('', 1, 1, {}), {}],
    ]);
    return { mpu: (conv && conv.value_minutes) || 15, files: files || [], models: models || [], allTotal: (allCount && allCount.total) || 0 };
  }, [], 7000);

  const partsPoll = useBWPoll(async () => {
    return await BW_API.partsListPaged(q, page, LPT_PAGE, { model: modelFilter, source: fileFilter });
  }, [q, page, modelFilter, fileFilter], 5000);

  const meta = metaPoll.data || { mpu: 15, files: [], models: [], allTotal: 0 };
  const mpu = meta.mpu;
  const files = meta.files;
  const pd = partsPoll.data || { items: [], total: 0, mpu };
  const view = pd.items;
  const totalPages = Math.max(1, Math.ceil((pd.total || 0) / LPT_PAGE));
  const models = ['ALL', ...meta.models];
  const anyFilter = q || modelFilter !== 'ALL' || fileFilter !== 'ALL';
  const clearFilters = () => { setQ(''); setModelFilter('ALL'); setFileFilter('ALL'); setPage(1); };

  const filteredFiles = files.filter(f => {
    if (fileTypeFilter !== 'ALL' && f.type !== fileTypeFilter) return false;
    if (fileQ) { const s = fileQ.toLowerCase(); return (f.name || '').toLowerCase().includes(s) || (f.uploadedBy || '').toLowerCase().includes(s) || (f.type || '').toLowerCase().includes(s); }
    return true;
  });

  const pageEst = view.reduce((a, p) => a + (p.units || 0) * mpu, 0);

  // ── handlers ───────────────────────────────────────────────
  const reloadAll = () => { metaPoll.reload(); partsPoll.reload(); };

  const setConfig = async (v) => {
    try { const r = await BW_API.setUnitConversion(v, true); flash(`Unit conversion → ${v} min/unit · ${r.records_affected} parts recalculated`); reloadAll(); }
    catch (e) { flash(e.message); }
  };

  const savePart = async (f) => {
    const body = {
      part_number: String(f.pn).trim(), part_name: String(f.name).trim(),
      product_code: String(f.code || '').trim() || null, model: String(f.model || '').trim() || null,
      unit_value: +f.units || 0,
    };
    if (editPart) await BW_API.updatePart(editPart.id, body);
    else await BW_API.addPart(body);
    flash(editPart ? 'Part updated ✓' : 'Part added ✓');
    reloadAll();
  };

  const removePart = async (p) => {
    try { await BW_API.deletePart(p.id); flash('Part removed'); reloadAll(); }
    catch (e) { flash(e.message); }
  };

  const openDelete = async (file) => {
    let dep = { hasActive: false, count: 0 };
    try { dep = await BW_API.partsFileDeps(file.id); } catch (e) {}
    setDeleteFile({ file, partsCount: file.totalParts, dep });
  };

  const confirmDelete = async () => {
    if (!deleteFile) return;
    try { const r = await BW_API.deletePartFile(deleteFile.file.id); flash(`Deleted "${deleteFile.file.name}" → ${r.removed} parts removed`); }
    catch (e) { flash(e.message); }
    setDeleteFile(null); setPage(1); reloadAll();
  };

  return (
    <>
      {/* ── Modals ─────────────────────────────────────────── */}
      {(addModal || editPart) && (
        <LivePartFormModal
          initial={editPart || null} mpu={mpu}
          onSave={savePart}
          onClose={() => { setAddModal(false); setEditPart(null); }}/>
      )}
      {importModal && <LiveImportModal onClose={() => setImportModal(false)} onDone={reloadAll}/>}
      {replaceFile && <LiveImportModal replaceFile={replaceFile} onClose={() => setReplaceFile(null)} onDone={reloadAll}/>}
      {previewFile && <LiveFilePreviewModal file={previewFile} onClose={() => setPreviewFile(null)}/>}
      {deleteFile && (
        <DeleteConfirmModal
          file={deleteFile.file} partsCount={deleteFile.partsCount} dep={deleteFile.dep}
          onConfirm={confirmDelete} onClose={() => setDeleteFile(null)}/>
      )}
      {auditOpen && <LiveAuditDrawer onClose={() => setAuditOpen(false)}/>}

      {toast && <div className="ujq-toast"><Icon name="check" size={15}/> {toast}</div>}

      {/* ── Page header ────────────────────────────────────── */}
      <div className="section-head">
        <div>
          <h2>Parts Time</h2>
          <span className="sub">Parts master · labour-unit estimation · {meta.allTotal} records across {files.length} imported file{files.length !== 1 ? 's' : ''}</span>
        </div>
        <div className="row" style={{ gap: 10 }}>
          <button className="btn btn-sm btn-ghost" onClick={() => setAuditOpen(true)}><Icon name="history" size={13}/> AUDIT LOG</button>
          <button className="btn btn-sm btn-ghost" onClick={() => setImportModal(true)}><Icon name="upload" size={13}/> IMPORT FILE</button>
          <button className="btn btn-sm btn-amber" onClick={() => setAddModal(true)}><Icon name="plus" size={13}/> ADD PART</button>
        </div>
      </div>

      {/* ── Unit conversion ────────────────────────────────── */}
      <UnitConfig mpu={mpu} partsCount={meta.allTotal} onChange={setConfig}/>

      {/* ── KPI ribbon ─────────────────────────────────────── */}
      <div className="kpi-ribbon" style={{ gridTemplateColumns: 'repeat(5,1fr)' }}>
        <div className="kpi"><div className="l">TOTAL PARTS</div><div className="v">{meta.allTotal}</div><div className="delta">{files.length} source files</div></div>
        <div className="kpi"><div className="l">IMPORTED FILES</div><div className="v amber">{files.length}</div><div className="delta">active records</div></div>
        <div className="kpi"><div className="l">MIN / UNIT</div><div className="v">{mpu}<span className="unit">min</span></div><div className="delta">configurable</div></div>
        <div className="kpi"><div className="l">FILTERED</div><div className="v">{pd.total}</div><div className="delta">{modelFilter === 'ALL' ? 'all models' : modelFilter}</div></div>
        <div className="kpi"><div className="l">EST · PAGE</div><div className="v mono">{Math.round(pageEst)}<span className="unit">m</span></div><div className="delta">{(pageEst / 60).toFixed(1)} hrs</div></div>
      </div>

      {/* ── Imported Files Management ───────────────────────── */}
      <div>
        <div className="section-head" style={{ marginBottom: 14 }}>
          <div>
            <div className="eyebrow eyebrow-amber" style={{ marginBottom: 6 }}>IMPORTED FILES MANAGEMENT</div>
            <div style={{ fontSize: 14, color: 'var(--t-2)' }}>Each file owns its extracted parts — delete or replace a file to cascade-update the master table.</div>
          </div>
          <button className="btn btn-sm btn-amber" onClick={() => setImportModal(true)}><Icon name="upload" size={13}/> UPLOAD NEW FILE</button>
        </div>

        {files.length > 0 && (
          <div className="pt-toolbar" style={{ marginBottom: 14 }}>
            <div className="pt-search">
              <Icon name="gauge" size={14}/>
              <input placeholder="Search by file name or uploaded by…" value={fileQ} onChange={e => setFileQ(e.target.value)}/>
              {fileQ && <button className="modal-close" style={{ width: 24, height: 24 }} onClick={() => setFileQ('')}><Icon name="x" size={12}/></button>}
            </div>
            <select className="wc-date" value={fileTypeFilter} onChange={e => setFileTypeFilter(e.target.value)} style={{ minWidth: 140 }}>
              <option value="ALL">All types</option>
              <option value="excel">Excel</option>
              <option value="pdf">PDF</option>
            </select>
            <div className="spacer"/>
            <span className="wc-range" style={{ fontSize: 11 }}>{filteredFiles.length} of {files.length} files</span>
          </div>
        )}

        {files.length === 0 ? (
          <div className="file-cards-empty">
            <div className="dz-ico" style={{ width: 56, height: 56, margin: '0 auto 14px' }}><Icon name="upload" size={28}/></div>
            <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 6 }}>No files imported yet</div>
            <div style={{ color: 'var(--t-2)', fontSize: 13, marginBottom: 18 }}>Upload an Excel or PDF parts master to get started.</div>
            <button className="btn btn-amber" onClick={() => setImportModal(true)}><Icon name="upload" size={14}/> IMPORT FIRST FILE</button>
          </div>
        ) : filteredFiles.length === 0 ? (
          <div className="file-cards-empty">
            <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 6 }}>No matching files found</div>
            <div className="pt-empty-actions"><button className="btn btn-sm btn-amber" onClick={() => { setFileQ(''); setFileTypeFilter('ALL'); }}>CLEAR FILTERS</button></div>
          </div>
        ) : (
          <div className="file-cards-grid">
            {filteredFiles.map(f => (
              <FileCard key={f.id} file={f}
                partsCount={f.totalParts}
                codesCount={f.totalCodes}
                onPreview={setPreviewFile}
                onReplace={setReplaceFile}
                onDelete={openDelete}/>
            ))}
            <div className="file-card-add" onClick={() => setImportModal(true)}>
              <Icon name="plus" size={28}/>
              <span>Import another file</span>
            </div>
          </div>
        )}
      </div>

      {/* ── Parts Master Table ──────────────────────────────── */}
      <div>
        <div className="section-head" style={{ marginBottom: 14 }}>
          <div>
            <div className="eyebrow eyebrow-amber" style={{ marginBottom: 6 }}>PARTS MASTER TABLE</div>
            <div style={{ fontSize: 14, color: 'var(--t-2)' }}>All parts with source traceability · estimated time calculated live.</div>
          </div>
        </div>

        <div className="pt-toolbar">
          <div className="pt-search">
            <Icon name="gauge" size={14}/>
            <input placeholder="Search product code, part no, or name…" value={q} onChange={e => { setQ(e.target.value); setPage(1); }}/>
            {q && <button className="modal-close" style={{ width: 24, height: 24 }} onClick={() => { setQ(''); setPage(1); }}><Icon name="x" size={12}/></button>}
          </div>
          <select className="wc-date" value={modelFilter} onChange={e => { setModelFilter(e.target.value); setPage(1); }} style={{ minWidth: 150 }}>
            {models.map(m => <option key={m} value={m}>{m === 'ALL' ? 'All models' : m}</option>)}
          </select>
          <select className="wc-date" value={fileFilter} onChange={e => { setFileFilter(e.target.value); setPage(1); }} style={{ minWidth: 170 }}>
            <option value="ALL">All sources</option>
            <option value="manual">Manual entries</option>
            {files.map(f => <option key={f.id} value={f.id}>{(f.name || '').slice(0, 30)}</option>)}
          </select>
          <div className="spacer"/>
          <span className="wc-range" style={{ fontSize: 11 }}>{pd.total} results · pg {Math.min(page, totalPages)}/{totalPages}</span>
        </div>

        <div className="list-card">
          {/* Desktop / tablet: scrollable table */}
          <div className="pt-table-wrap">
            <div className="pt-row pt-head" style={{ gridTemplateColumns: LPT_COLS }}>
              <span>PRODUCT CODE</span><span>PART NO</span><span>PART NAME</span>
              <span className="r">UNIT VAL</span><span className="r">UNIT TIME</span><span className="r pt-est">EST. TIME</span>
              <span>SOURCE FILE</span><span>CREATED</span><span>UPDATED</span><span className="r">ACTIONS</span>
            </div>

            {view.length === 0 && (
              <div className="wc-empty"><Icon name="tools" size={26}/><div className="t">{partsPoll.loading ? 'Loading…' : 'No matching records found'}</div>
                {anyFilter && <div className="pt-empty-actions"><button className="btn btn-sm btn-ghost" onClick={() => { setQ(''); setPage(1); }}>RESET SEARCH</button><button className="btn btn-sm btn-amber" onClick={clearFilters}>CLEAR FILTERS</button></div>}
              </div>
            )}

            {view.map(p => {
              const srcFile = files.find(f => f.id === p.sourceFileId);
              return (
                <div key={p.id} className="pt-row" style={{ gridTemplateColumns: LPT_COLS }}>
                  <span className="mono pt-code">{p.code || '—'}</span>
                  <span className="mono pt-pn">{p.pn}</span>
                  <span className="pt-name" title={p.name}>{p.name}</span>
                  <span className="r mono">{p.units}</span>
                  <span className="r mono" style={{ color: 'var(--t-3)' }}>{mpu}m</span>
                  <span className="r mono pt-est">{Math.round(p.units * mpu * 100) / 100}m</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                    {p.sourceFileId === 'manual'
                      ? <span className="chip ghost mono" style={{ height: 18, fontSize: 9 }}>MANUAL</span>
                      : <span className="pt-srclink" onClick={() => srcFile && setPreviewFile(srcFile)}>{(p.sourceFileName || '').slice(0, 20) || '—'}</span>}
                  </div>
                  <span className="pt-date">{fmtDateShort(p.created)}</span>
                  <span className="pt-date">{fmtDateShort(p.updated)}</span>
                  <span className="r pt-actions">
                    <button className="icon-btn" onClick={() => setEditPart(p)} title="Edit"><Icon name="edit" size={13}/></button>
                    <button className="icon-btn danger" onClick={() => removePart(p)} title="Delete"><Icon name="x" size={13}/></button>
                  </span>
                </div>
              );
            })}
          </div>

          {/* Mobile: compact cards */}
          <div className="pt-mobile-cards">
            {view.length === 0 && (
              <div className="wc-empty"><Icon name="tools" size={26}/><div className="t">{partsPoll.loading ? 'Loading…' : 'No matching records found'}</div>
                {anyFilter && <div className="pt-empty-actions"><button className="btn btn-sm btn-ghost" onClick={() => { setQ(''); setPage(1); }}>RESET SEARCH</button><button className="btn btn-sm btn-amber" onClick={clearFilters}>CLEAR FILTERS</button></div>}
              </div>
            )}
            {view.map(p => (
              <div key={p.id} className="pt-mcard" onClick={() => setEditPart(p)}>
                <div className="pt-mcard-top">
                  <span className="chip amber" style={{ height: 20, fontSize: 10 }}>{p.code || 'NO CODE'}</span>
                  <span className="mono pt-pn">{p.pn}</span>
                  <span className="pt-mcard-est">{Math.round(p.units * mpu * 100) / 100}m</span>
                </div>
                <div className="pt-mcard-name">{p.name}</div>
                <div className="pt-mcard-foot">
                  <span className="mono">{p.units} units · {mpu}m/unit</span>
                  <span className="pt-mcard-view">View details <Icon name="chevron-right" size={11}/></span>
                </div>
              </div>
            ))}
          </div>

          {pd.total > LPT_PAGE && (
            <div className="pt-pager">
              <button className="btn btn-sm btn-ghost" disabled={page <= 1} onClick={() => setPage(p => p - 1)}><Icon name="arrow-left" size={13}/> PREV</button>
              <span className="mono">PAGE {Math.min(page, totalPages)} / {totalPages} · {pd.total} PARTS</span>
              <button className="btn btn-sm btn-ghost" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>NEXT <Icon name="arrow-right" size={13}/></button>
            </div>
          )}
        </div>
      </div>
    </>
  );
};

// Audit drawer — fetches parts audit log from API
const LiveAuditDrawer = ({ onClose }) => {
  const poll = useBWPoll(() => BW_API.partsAudit(), [], 5000);
  const logs = poll.data || [];
  return (
    <div className="modal-scrim" onClick={onClose} style={{ placeItems: 'stretch end' }}>
      <div className="audit-drawer" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <span className="eyebrow eyebrow-amber">AUDIT LOG · PARTS TIME</span>
          <button className="modal-close" onClick={onClose}><Icon name="x" size={15}/></button>
        </div>
        <div className="audit-list">
          {logs.map((l, i) => (
            <div key={i} className="audit-item">
              <span className={`audit-tag ${l.action.toLowerCase().replace(/[^a-z]/g, '_')}`}>{l.action}</span>
              <div><div className="audit-detail">{l.detail}</div><span className="audit-ts">{l.ts ? new Date(l.ts).toLocaleString('en-IN') : ''} · {l.user}</span></div>
            </div>
          ))}
          {!logs.length && <div className="wc-empty"><div className="t">No logs yet</div></div>}
        </div>
      </div>
    </div>
  );
};
window.LivePartsTime = LivePartsTime;

// ── Admin · Leave Approvals (live) ──────────────────────────
const LiveLeaveApprovals = () => {
  const poll = useBWPoll(() => BW_API.leaveList(), [], 3000);
  const rows = poll.data || [];
  const loading = poll.loading && !poll.data;
  const [busy, setBusy] = useLS(null);
  const [q, setQ] = useLS('');
  const [filt, setFilt] = useLS('all');
  const [dept, setDept] = useLS('all');
  const [dFrom, setDFrom] = useLS(''); const [dTo, setDTo] = useLS('');
  const [view, setView] = useLS(null);
  const decide = async (id, fn, verb) => { setBusy(id); try { await fn(id); await poll.reload(); adToast(`Leave ${verb||'updated'}`,'ok'); } catch(e){ adToast(e.message||'Action failed','err'); } finally { setBusy(null); } };
  // jump to the requester's full profile in Worker Management (one connected workforce system)
  const openWorker = (id) => { if(!id) return; window.dispatchEvent(new CustomEvent('bw:navigate',{detail:{tab:'workers'}}));
    setTimeout(()=>window.dispatchEvent(new CustomEvent('bw:cmd',{detail:{cmd:'workers:open',id}})),90); };
  // cross-page commands from the ⌘K palette (jump to the pending queue / open a request)
  useLE(() => {
    const onCmd = (e) => { const { cmd, id } = e.detail || {};
      if (cmd === 'leave:focus') { setFilt('pending'); }
      else if (cmd === 'leave:open' && id) setView(id);
    };
    window.addEventListener('bw:cmd', onCmd);
    return () => window.removeEventListener('bw:cmd', onCmd);
  }, []);

  const today = adToday();
  const pending = rows.filter(r => r.status === 'pending').length;
  const approved = rows.filter(r => r.status === 'approved').length;
  const rejected = rows.filter(r => r.status === 'rejected').length;
  const onLeaveToday = new Set(rows.filter(r => r.status==='approved' && r.from_date<=today && r.to_date>=today).map(r=>r.worker_id)).size;

  const depts = ['all', ...Array.from(new Set(rows.map(r=>r.department).filter(Boolean)))];
  const anyFilter = filt!=='all' || !!q || dept!=='all' || !!dFrom || !!dTo;
  const clearFilters = () => { setFilt('all'); setQ(''); setDept('all'); setDFrom(''); setDTo(''); };
  const counts = { all: rows.length, pending, approved, rejected };
  const filtered = rows.filter(r => {
    if (filt!=='all' && r.status!==filt) return false;
    if (dept!=='all' && r.department!==dept) return false;
    if (q) { const t=`${r.worker_name||''} ${r.employee_id||''} ${r.leave_type||''} ${r.department||''}`.toLowerCase(); if (!t.includes(q.toLowerCase())) return false; }
    if (dFrom && (r.to_date||'') < dFrom) return false;     // leave ends before the range
    if (dTo && (r.from_date||'') > dTo) return false;       // leave starts after the range
    return true;
  });

  const stBadge = (s) => s==='approved'
    ? <span className="adash-st ok"><span className="d"/>Approved</span>
    : s==='rejected' ? <span className="adash-st danger"><span className="d"/>Rejected</span>
    : <span className="adash-st amber"><span className="d"/>Pending</span>;
  const adDateTime = (iso) => { if (!iso) return '—'; try { return new Date(iso).toLocaleString('en-IN',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}); } catch(e){ return iso; } };

  const COLS = 'minmax(140px,1.4fr) 116px 96px 84px 78px 78px 42px 1fr 112px 88px';
  return (
    <>
      <AdToaster/>
      <div className="section-head">
        <div><h2>Leave approvals</h2><span className="sub">{pending} pending · {rows.length} total</span></div>
        {pending>0 && <button className="btn btn-ghost" onClick={()=>setFilt('pending')}><Icon name="clock" size={14}/> {pending} awaiting review</button>}
      </div>

      <div className="adash-kpis">
        <div className="adash-kpi amber"><div className="adash-kpi-top"><div className="adash-kpi-ico"><Icon name="clock" size={17}/></div></div><div className="adash-kpi-v">{pending}</div><div className="adash-kpi-l">Pending review</div></div>
        <div className="adash-kpi ok"><div className="adash-kpi-top"><div className="adash-kpi-ico"><Icon name="check" size={17}/></div></div><div className="adash-kpi-v">{approved}</div><div className="adash-kpi-l">Approved</div></div>
        <div className="adash-kpi danger"><div className="adash-kpi-top"><div className="adash-kpi-ico"><Icon name="x" size={17}/></div></div><div className="adash-kpi-v">{rejected}</div><div className="adash-kpi-l">Rejected</div></div>
        <div className="adash-kpi info"><div className="adash-kpi-top"><div className="adash-kpi-ico"><Icon name="calendar" size={17}/></div></div><div className="adash-kpi-v">{onLeaveToday}</div><div className="adash-kpi-l">On leave today</div></div>
      </div>

      {pending>0 && <>
        <div className="adash-subhead"><Icon name="clock" size={14}/> Pending requests · {pending} awaiting decision</div>
        <div className="ad-queue">
          {rows.filter(r=>r.status==='pending').slice(0,12).map(r=>(
            <div key={r.id} className="ad-qcard">
              <div className="top">
                <div className="avatar-sm">{adInitials(r.worker_name)}</div>
                <div className="nm"><div className="t">{r.worker_name}</div><span className="cell-meta">{r.employee_id||'—'}{r.department?` · ${r.department}`:''}</span></div>
                <span className="chip ghost mono">{r.leave_type}</span>
              </div>
              <div className="when"><Icon name="calendar" size={13}/> {adShortDate(r.from_date)} → {adShortDate(r.to_date)} <span style={{color:'var(--t-4)'}}>· {r.days} {r.days>1?'days':'day'}</span></div>
              <div className="reason">{r.reason||'No reason provided'}</div>
              <div className="acts">
                <button className="btn btn-ghost" onClick={()=>setView(r.id)}><Icon name="user" size={13}/> Details</button>
                <button className="btn btn-ghost ops-danger-btn" disabled={busy===r.id} onClick={()=>decide(r.id, BW_API.leaveReject, 'rejected')}><Icon name="x" size={13}/> Reject</button>
                <button className="btn btn-amber" disabled={busy===r.id} onClick={()=>decide(r.id, BW_API.leaveApprove, 'approved')}>{busy===r.id?<span className="adash-spin"/>:<><Icon name="check" size={13}/> Approve</>}</button>
              </div>
            </div>))}
        </div>
      </>}

      <div className="adash-subhead"><Icon name="history" size={14}/> Request history</div>
      <div className="ops-toolbar">
        <div className="ops-search">
          <Icon name="scan" size={15}/>
          <input placeholder="Search worker, employee ID, type…" value={q} onChange={e=>setQ(e.target.value)}/>
          {q && <button className="ops-search-x" onClick={()=>setQ('')}><Icon name="x" size={14}/></button>}
        </div>
        <div className="ops-chips">{['all','pending','approved','rejected'].map(s=>(
          <button key={s} className={`ops-chip ${filt===s?'active':''}`} onClick={()=>setFilt(s)}>
            {s==='all'?'All':s[0].toUpperCase()+s.slice(1)} <span style={{opacity:.6}}>{counts[s]}</span>
          </button>))}</div>
        {depts.length>1 && <select className="ops-select" value={dept} onChange={e=>setDept(e.target.value)} aria-label="Department">
          {depts.map(dp=><option key={dp} value={dp}>{dp==='all'?'All departments':dp}</option>)}
        </select>}
        <div className="adash-daterange"><Icon name="calendar" size={13}/><input type="date" value={dFrom} onChange={e=>setDFrom(e.target.value)} aria-label="From date"/><span className="sep">→</span><input type="date" value={dTo} onChange={e=>setDTo(e.target.value)} aria-label="To date"/></div>
        {anyFilter && <button className="adash-clear" onClick={clearFilters}><Icon name="x" size={12}/> Clear</button>}
      </div>

      <div className="adash-tbl">
        <div className="adash-tr adash-head" style={{gridTemplateColumns:COLS}}>
          <span className="adash-th">Worker</span><span className="adash-th">Department</span><span className="adash-th">Type</span><span className="adash-th">Applied</span>
          <span className="adash-th">From</span><span className="adash-th">To</span><span className="adash-th adash-td-r">Days</span>
          <span className="adash-th">Reason</span><span className="adash-th">Status</span><span className="adash-th adash-td-r">Action</span>
        </div>
        <div className="adash-tbody">
          {loading && [0,1,2,3].map(i=>adSkRow(['w70','w45','w45'], i))}
          {!loading && filtered.length===0 && (
            <div className="ops-none"><Icon name="calendar" size={26}/>
              <div>{rows.length===0 ? 'No leave requests — your crew is all clocked in' : 'No requests match this filter'}</div></div>)}
          {!loading && filtered.map(r => (
            <div key={r.id} className="adash-tr" style={{gridTemplateColumns:COLS}}>
              <div className="adash-td adash-td-primary" data-label="Worker">
                <div className="avatar-sm">{adInitials(r.worker_name)}</div>
                <div style={{minWidth:0}}><div className="cell-name">{r.worker_name}</div><span className="cell-meta">{r.employee_id||'—'}</span></div>
              </div>
              <div className="adash-td" data-label="Department"><span className="chip ghost mono">{r.department||'—'}</span></div>
              <div className="adash-td" data-label="Type"><span className="chip ghost mono">{r.leave_type||'—'}</span></div>
              <div className="adash-td" data-label="Applied"><span className="adash-num" style={{fontSize:12}}>{adShortDate((r.applied_at||'').slice(0,10))}</span></div>
              <div className="adash-td" data-label="From"><span className="adash-num">{adShortDate(r.from_date)}</span></div>
              <div className="adash-td" data-label="To"><span className="adash-num">{adShortDate(r.to_date)}</span></div>
              <div className="adash-td adash-td-r" data-label="Days"><span className="adash-num">{r.days}</span></div>
              <div className="adash-td" data-label="Reason"><span className="cell-meta" style={{whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',fontSize:12,letterSpacing:0}}>{r.reason||'—'}</span></div>
              <div className="adash-td" data-label="Status">{stBadge(r.status)}</div>
              <div className="adash-td adash-td-r adash-acts" data-label="Action">
                <button className="icon-btn" onClick={()=>setView(r.id)} aria-label="View details"><Icon name="chevron-right" size={16}/></button>
                {r.status==='pending' && <>
                  <button className="icon-btn danger" disabled={busy===r.id} onClick={()=>decide(r.id, BW_API.leaveReject)} aria-label="Reject"><Icon name="x" size={14}/></button>
                  <button className="icon-btn ok" disabled={busy===r.id} onClick={()=>decide(r.id, BW_API.leaveApprove)} aria-label="Approve"><Icon name="check" size={15}/></button>
                </>}
              </div>
            </div>
          ))}
        </div>
      </div>

      {view && (() => {
        const r = rows.find(x => x.id === view); if (!r) return null;
        const hist = rows.filter(x => x.worker_id === r.worker_id)
          .slice().sort((a,b)=>(b.applied_at||'').localeCompare(a.applied_at||''));
        return (
          <>
            <div className="adash-scrim" onClick={()=>setView(null)}/>
            <div className="adash-drawer">
              <div className="adash-dr-head">
                <div className="avatar-sm" style={{width:46,height:46,fontSize:15}}>{adInitials(r.worker_name)}</div>
                <div className="nm"><div className="t">{r.worker_name}</div><span className="cell-meta">{r.employee_id||'—'}{r.department?` · ${r.department}`:''}</span></div>
                {stBadge(r.status)}
                <button className="modal-close" onClick={()=>setView(null)}><Icon name="x" size={16}/></button>
              </div>
              <div className="adash-dr-body">
                <button className="btn btn-ghost btn-sm" style={{justifySelf:'start'}} onClick={()=>openWorker(r.worker_id)}><Icon name="user" size={13}/> View full worker profile <Icon name="arrow-right" size={12}/></button>
                <div className="adash-sec">
                  <div className="adash-sec-h"><Icon name="calendar" size={12}/> Leave request</div>
                  <div className="adash-dl">
                    <div className="r"><div className="k">Type</div><div className="vv">{r.leave_type||'—'}</div></div>
                    <div className="r"><div className="k">Duration</div><div className="vv">{r.days} {r.days>1?'days':'day'}</div></div>
                    <div className="r"><div className="k">From</div><div className="vv">{adShortDate(r.from_date)}</div></div>
                    <div className="r"><div className="k">To</div><div className="vv">{adShortDate(r.to_date)}</div></div>
                    <div className="r full"><div className="k">Reason</div><div className="vv">{r.reason||'—'}</div></div>
                  </div>
                </div>
                <div className="adash-sec">
                  <div className="adash-sec-h"><Icon name="history" size={12}/> Audit timeline</div>
                  <div className="ops-tl">
                    <div className="ops-tl-row"><span className="ops-tl-time">{adDateTime(r.applied_at).split(',')[0]||''}</span><span className="ops-tl-dot info"/><span className="ops-tl-label">Requested by worker <span className="ops-tl-by">· {adDateTime(r.applied_at)}</span></span></div>
                    {r.status!=='pending'
                      ? <div className="ops-tl-row"><span className="ops-tl-time">{adDateTime(r.decided_at).split(',')[0]||''}</span><span className={`ops-tl-dot ${r.status==='approved'?'ok':'danger'}`}/><span className="ops-tl-label">{r.status==='approved'?'Approved':'Rejected'} by admin <span className="ops-tl-by">· {adDateTime(r.decided_at)}</span></span></div>
                      : <div className="ops-tl-row"><span className="ops-tl-time"/><span className="ops-tl-dot warn"/><span className="ops-tl-label">Awaiting admin review</span></div>}
                  </div>
                </div>
                <div className="adash-sec">
                  <div className="adash-sec-h"><Icon name="clipboard" size={12}/> Leave history</div>
                  {hist.map(l => (
                    <div key={l.id} className="adash-lh">
                      <span className={`d ${l.status==='approved'?'ok':l.status==='rejected'?'danger':'warn'}`}/>
                      <div className="info"><div className="t">{l.leave_type} · {l.days} {l.days>1?'days':'day'}</div>
                        <div className="s">{adShortDate(l.from_date)} → {adShortDate(l.to_date)} · {l.status}</div></div>
                    </div>))}
                </div>
              </div>
              {r.status==='pending' && (
                <div className="modal-foot" style={{padding:'14px 22px',borderTop:'1px solid var(--hair)'}}>
                  <button className="btn btn-ghost ops-danger-btn" style={{flex:1}} disabled={busy===r.id} onClick={()=>decide(r.id, BW_API.leaveReject).then(()=>setView(null))}><Icon name="x" size={15}/> REJECT</button>
                  <button className="btn btn-amber" style={{flex:2}} disabled={busy===r.id} onClick={()=>decide(r.id, BW_API.leaveApprove).then(()=>setView(null))}><Icon name="check" size={15}/> APPROVE</button>
                </div>
              )}
            </div>
          </>
        );
      })()}
    </>
  );
};
window.LiveLeaveApprovals = LiveLeaveApprovals;

// ── Admin · Branch Reports (live) ───────────────────────────
const LiveBranchReports = () => {
  const poll = useBWPoll(async () => {
    const [summary, perf, workers, ops, comp] = await settle([
      [BW_API.branchSummary(), {}], [BW_API.workerPerformance(), []], [BW_API.workers(), []], [BW_API.bayOperations(), { bays: [] }], [BW_API.workCompletion(), []],
    ]);
    return { summary: summary || {}, perf: perf || [], workers: workers || [], bays: (ops && ops.bays) || [], comp: comp || [] };
  }, [], 5000);
  const d = poll.data || { summary: {}, perf: [], workers: [], bays: [], comp: [] };
  const loading = poll.loading && !poll.data;
  const wname = (id) => (d.workers.find(w => w.id === id) || {}).name || (id ? String(id).slice(0,8) : '—');
  // open a worker's profile in Worker Management (one connected workforce system)
  const openWorker = (id) => { if(!id) return; window.dispatchEvent(new CustomEvent('bw:navigate',{detail:{tab:'workers'}}));
    setTimeout(()=>window.dispatchEvent(new CustomEvent('bw:cmd',{detail:{cmd:'workers:open',id}})),90); };

  // per-worker aggregate (score + minutes), ranked
  const agg = {};
  d.perf.forEach(r => { const v = (agg[r.worker_id] ||= { n:0, score:0, mins:0 });
    v.n++; v.score += (r.score||0); v.mins += (r.actual||0); });
  const ranking = Object.entries(agg).map(([wid,v]) => ({ wid, avg: Math.round(v.score/v.n), jobs:v.n }))
    .sort((a,b)=> b.avg-a.avg || b.jobs-a.jobs);

  // derived executive metrics (existing endpoints only — no backend change)
  const totalJobs = d.perf.length;
  const completed = d.summary.completed ?? totalJobs;
  const onTime = d.summary.on_time ?? 0;
  const rate = d.summary.on_time_rate ?? 0;
  const avgMin = totalJobs ? Math.round(d.perf.reduce((s,r)=>s+(r.actual||0),0)/totalJobs) : 0;
  const activeWorkers = d.workers.filter(w => (w.status||'active')==='active').length;

  const bayFreq = {}; d.perf.forEach(r => { if (r.bay_id) bayFreq[r.bay_id] = (bayFreq[r.bay_id]||0)+1; });
  const best = ranking[0];
  const mostBay = d.bays.map(b => ({ no: b.bay_number, jobs: bayFreq[b.bay_id] || 0 })).sort((a,b)=>b.jobs-a.jobs)[0];
  return (
    <>
      <AdToaster/>
      <div className="section-head"><div><h2>Branch reports</h2><span className="sub">{activeWorkers} active workers · {completed} completed</span></div></div>

      <div className="adash-kpis">
        <div className="adash-kpi ok"><div className="adash-kpi-top"><div className="adash-kpi-ico"><Icon name="check" size={17}/></div></div><div className="adash-kpi-v">{completed}</div><div className="adash-kpi-l">Completed jobs</div></div>
        <div className="adash-kpi ok"><div className="adash-kpi-top"><div className="adash-kpi-ico"><Icon name="gauge" size={17}/></div></div><div className="adash-kpi-v">{onTime}</div><div className="adash-kpi-l">On-time</div></div>
        <div className="adash-kpi"><div className="adash-kpi-top"><div className="adash-kpi-ico"><Icon name="user" size={17}/></div></div><div className="adash-kpi-v">{activeWorkers}</div><div className="adash-kpi-l">Active workers</div></div>
        <div className="adash-kpi amber"><div className="adash-kpi-top"><div className="adash-kpi-ico"><Icon name="sparkle" size={17}/></div></div><div className="adash-kpi-v">{rate}<span className="u">%</span></div><div className="adash-kpi-l">Completion rate</div></div>
      </div>

      <div className="adash-subhead"><Icon name="sparkle" size={14}/> Worker performance ranking</div>
      <div className="list-card">
        {loading && [0,1,2].map(i=>adSkRow(['w45','w70'], i))}
        {!loading && ranking.length===0 && (
          <div className="ops-none"><Icon name="history" size={26}/><div>No completed jobs yet — rankings appear once work is logged</div></div>)}
        {!loading && ranking.map((w,i) => (
          <div key={w.wid} className="adash-rank clickable" role="button" tabIndex={0} title="Open worker profile"
            onClick={()=>openWorker(w.wid)} onKeyDown={e=>(e.key==='Enter'||e.key===' ')&&(e.preventDefault(),openWorker(w.wid))}>
            <div className={`adash-medal ${i<3?`g${i+1}`:''}`}>{i+1}</div>
            <div className="avatar-sm">{adInitials(wname(w.wid))}</div>
            <div style={{minWidth:0}}><div className="cell-name">{wname(w.wid)}</div><span className="cell-meta">{w.jobs} job{w.jobs>1?'s':''} completed</span></div>
            <div className="perfbar adash-rank-bar"><div className={`f ${adFillCls(w.avg)}`} style={{width:w.avg+'%'}}/></div>
            <div className="adash-rank-pct" style={{color:'var(--t-0)'}}>{w.avg}%</div>
            <Icon name="arrow-right" size={13} style={{color:'var(--t-4)'}}/>
          </div>
        ))}
      </div>

      <div className="adash-subhead"><Icon name="sparkle" size={14}/> Branch performance</div>
      <div className="adash-facts">
        <div className="adash-fact"><div className="adash-fact-ico"><Icon name="bolt" size={18}/></div>
          <div style={{minWidth:0}}><div className="adash-fact-l">Most active bay</div><div className="adash-fact-v">{mostBay?`Bay ${adBay2(mostBay.no)} · ${mostBay.jobs} job${mostBay.jobs===1?'':'s'}`:'—'}</div></div></div>
        <div className="adash-fact"><div className="adash-fact-ico"><Icon name="sparkle" size={18}/></div>
          <div style={{minWidth:0}}><div className="adash-fact-l">Best worker</div><div className="adash-fact-v">{best?`${wname(best.wid)} · ${best.avg}%`:'—'}</div></div></div>
        <div className="adash-fact"><div className="adash-fact-ico"><Icon name="clock" size={18}/></div>
          <div style={{minWidth:0}}><div className="adash-fact-l">Average service time</div><div className="adash-fact-v">{avgMin?`${avgMin} min`:'—'}</div></div></div>
        <div className="adash-fact"><div className="adash-fact-ico"><Icon name="gauge" size={18}/></div>
          <div style={{minWidth:0}}><div className="adash-fact-l">Completion rate</div><div className="adash-fact-v">{rate}% on-time</div></div></div>
      </div>

      <div className="adash-subhead"><Icon name="check" size={14}/> Completed jobs · backend-authoritative</div>
      <div className="brc-table">
        <div className="brc-row brc-head">
          <span>Job / Vehicle</span><span>Bay · Worker</span><span>Estimate</span><span>Actual</span><span>Pause</span><span>Overtime</span><span>Recording</span><span>Completed</span>
        </div>
        {loading && [0,1,2].map(i => <div key={i} className="brc-row brc-skel"><span className="skel-line w70"/></div>)}
        {!loading && d.comp.length === 0 && (
          <div className="ops-none"><Icon name="history" size={26}/><div>No completed jobs yet — the log fills in as work is completed</div></div>)}
        {!loading && d.comp.map((r) => {
          const rec = r.recording_status;
          const recCfg = r.recording_available ? { cls: 'ok', txt: 'Available' }
            : rec === 'expired' ? { cls: 'danger', txt: 'Expired' } : { cls: 'mut', txt: 'None' };
          const warns = r.warning_summary || [];
          return (
            <div key={r.session_id} className="brc-row">
              <span className="brc-veh"><b>{r.vehicle || '—'}</b><small>{r.registration ? `${r.registration} · ` : ''}{r.job_card_number || ''}{r.customer_name ? ` · ${r.customer_name}` : ''}</small></span>
              <span className="brc-bay">Bay {r.bay_number != null ? adBay2(r.bay_number) : '—'}<small>{r.worker_name || '—'}</small></span>
              <span className="brc-est">{r.est_min}m{r.estimate_source === 'approved' && <span className="brc-appr" title={r.approved_cost != null ? `Customer-approved · ₹${Math.round(r.approved_cost)}` : 'Customer-approved'}>approved{r.approved_cost != null ? ` ₹${Math.round(r.approved_cost)}` : ''}</span>}</span>
              <span className="mono">{r.actual_min}m</span>
              <span className="mono">{r.paused_known ? `${r.paused_min || 0}m${r.pause_count ? ` · ${r.pause_count}×` : ''}` : '—'}</span>
              <span className={`mono ${r.overtime_min > 0 ? 'brc-over' : ''}`}>{r.overtime_min > 0 ? `+${r.overtime_min}m` : '0m'}</span>
              <span className={`brc-rec ${recCfg.cls}`}>{recCfg.txt}{warns.length > 0 && <span className="brc-warn" title={warns.join('\n')}><Icon name="alert" size={10}/> {warns.length}</span>}</span>
              <span className="brc-when mono">{adShortDate(r.date)}{r.end_time && r.end_time !== '—' ? ` · ${r.end_time}` : ''}</span>
            </div>
          );
        })}
      </div>
    </>
  );
};
window.LiveBranchReports = LiveBranchReports;

// ── Master · Branch Management (live) ───────────────────────
const LiveMasterBranchManagement = () => {
  const poll = useBWPoll(() => BW_API.masterBranches(), [], 4000);
  const branches = poll.data || [];
  const [show, setShow] = useLS(false);
  const [f, setF] = useLS({ id:'', name:'', location:'' });
  const [msg, setMsg] = useLS('');
  const create = async () => {
    if (!f.id || !f.name) { setMsg('Branch id and name required'); return; }
    try { await BW_API.createBranch(f); setMsg('Branch created ✓'); setShow(false); setF({ id:'', name:'', location:'' }); await poll.reload(); }
    catch (e) { setMsg(e.message); }
  };
  return (
    <>
      <div className="section-head"><div><h2>Branch management</h2><span className="sub">Live · {branches.length} facilities</span></div>
        <button className="btn btn-amber btn-sm" onClick={()=>setShow(true)}><Icon name="plus" size={14}/> NEW BRANCH</button></div>
      {msg && <div className="cred-note" style={{ marginBottom:14 }}><Icon name="shield" size={13}/> {msg}</div>}
      <div className="list-card">
        <div className="row-item" style={{ gridTemplateColumns:'1.6fr 1fr 1fr 1fr', background:'var(--bg-1)', borderBottom:'1px solid var(--hair-strong)' }}>
          {['BRANCH','BAYS','CREW','LIVE'].map((h,i)=><span key={i} className="mono" style={{ fontSize:9, letterSpacing:'0.16em', color:'var(--t-3)' }}>{h}</span>)}
        </div>
        {branches.map(b => (
          <div key={b.id} className="row-item" style={{ gridTemplateColumns:'1.6fr 1fr 1fr 1fr' }}>
            <div><div className="cell-name">{b.name}</div><span className="cell-meta">{b.id}</span></div>
            <span className="mono">{b.bays}</span><span className="mono">{b.crew}</span>
            <span className="chip ok mono"><span className="dot live pulsing"/>{b.live_feeds}</span>
          </div>
        ))}
      </div>
      {show && (
        <div className="modal-scrim" onClick={()=>setShow(false)}>
          <div className="modal" onClick={e=>e.stopPropagation()} style={{ maxWidth:460 }}>
            <div className="modal-head"><span className="eyebrow eyebrow-amber">NEW BRANCH</span><button className="modal-close" onClick={()=>setShow(false)}><Icon name="x" size={15}/></button></div>
            <div className="form-body">
              <div className="fld"><label>Branch ID</label><input className="input" value={f.id} onChange={e=>setF({...f,id:e.target.value})} placeholder="LOC_XXX_NN"/></div>
              <div className="fld"><label>Name</label><input className="input" value={f.name} onChange={e=>setF({...f,name:e.target.value})}/></div>
              <div className="fld full"><label>Location</label><input className="input" value={f.location} onChange={e=>setF({...f,location:e.target.value})}/></div>
            </div>
            <div className="modal-foot"><button className="btn btn-ghost" style={{ flex:1 }} onClick={()=>setShow(false)}>CANCEL</button><button className="btn btn-amber" style={{ flex:2 }} onClick={create}><Icon name="plus" size={15}/> CREATE</button></div>
          </div>
        </div>
      )}
    </>
  );
};
window.LiveMasterBranchManagement = LiveMasterBranchManagement;

// ── Master · User Management (live: admins + workers) ───────
const LiveMasterUserManagement = () => {
  const [view, setView] = useLS('admins');
  const poll = useBWPoll(async () => {
    const [admins, workers, branches] = await settle([[BW_API.masterAdmins(), []], [BW_API.workers(), []], [BW_API.masterBranches(), []]]);
    return { admins: admins || [], workers: workers || [], branches: branches || [] };
  }, [], 4000);
  const d = poll.data || { admins: [], workers: [], branches: [] };
  const [show, setShow] = useLS(false);
  const [f, setF] = useLS({ name:'', employee_id:'', branch_id:'', username:'', password:'' });
  const [msg, setMsg] = useLS('');
  const create = async () => {
    if (!f.name || !f.employee_id || !f.branch_id || !f.username || !f.password) { setMsg('All fields required'); return; }
    try { await BW_API.createAdmin(f); setMsg('Admin created ✓'); setShow(false); setF({ name:'', employee_id:'', branch_id:'', username:'', password:'' }); await poll.reload(); }
    catch (e) { setMsg(e.message); }
  };
  return (
    <>
      <div className="section-head"><div><h2>User management</h2><span className="sub">Live · {d.admins.length} admins · {d.workers.length} workers</span></div>
        <div className="pill-tabs"><span className={`pill-tab ${view==='admins'?'active':''}`} onClick={()=>setView('admins')}>ADMINS</span><span className={`pill-tab ${view==='workers'?'active':''}`} onClick={()=>setView('workers')}>WORKERS</span></div></div>
      {msg && <div className="cred-note" style={{ marginBottom:14 }}><Icon name="shield" size={13}/> {msg}</div>}
      {view === 'admins' && (
        <>
          <div className="row" style={{ justifyContent:'flex-end', marginBottom:10 }}><button className="btn btn-amber btn-sm" onClick={()=>setShow(true)}><Icon name="plus" size={14}/> CREATE ADMIN</button></div>
          <div className="list-card">
            {d.admins.map(a => (
              <div key={a.id} className="row-item" style={{ gridTemplateColumns:'34px 1.4fr 1fr auto' }}>
                <Avatar id={a.employee_id||a.id} initials={(a.name||'?').split(' ').map(x=>x[0]).join('').slice(0,2)} size={34} ring="blue"/>
                <div><div className="cell-name">{a.name}</div><span className="cell-meta">{a.employee_id}</span></div>
                <span className="chip ghost mono"><Icon name="pin" size={10}/>{a.branch_id}</span>
                <span className="chip ok"><span className="dot ok pulsing"/>{(a.status||'active').toUpperCase()}</span>
              </div>
            ))}
          </div>
        </>
      )}
      {view === 'workers' && (
        <div className="list-card">
          {d.workers.map(w => (
            <div key={w.id} className="row-item" style={{ gridTemplateColumns:'34px 1.6fr 1fr 1fr' }}>
              <Avatar id={w.employee_id||w.id} initials={(w.name||'?').split(' ').map(x=>x[0]).join('').slice(0,2)} size={34}/>
              <div><div className="cell-name">{w.name}</div><span className="cell-meta">{w.designation||'Technician'}</span></div>
              <span className="chip ghost mono"><Icon name="pin" size={10}/>{w.branch_id}</span>
              <span className="mono" style={{ fontSize:12 }}>{w.employee_id}</span>
            </div>
          ))}
        </div>
      )}
      {show && (
        <div className="modal-scrim" onClick={()=>setShow(false)}>
          <div className="modal" onClick={e=>e.stopPropagation()} style={{ maxWidth:480 }}>
            <div className="modal-head"><span className="eyebrow eyebrow-amber">CREATE ADMIN</span><button className="modal-close" onClick={()=>setShow(false)}><Icon name="x" size={15}/></button></div>
            <div className="form-body">
              <div className="fld full"><label>Name</label><input className="input" value={f.name} onChange={e=>setF({...f,name:e.target.value})}/></div>
              <div className="fld"><label>Admin ID</label><input className="input" value={f.employee_id} onChange={e=>setF({...f,employee_id:e.target.value})} placeholder="ADMIN-0NN"/></div>
              <div className="fld"><label>Branch</label><select className="input" value={f.branch_id} onChange={e=>setF({...f,branch_id:e.target.value})}><option value="">Select…</option>{d.branches.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
              <div className="fld"><label>Username</label><input className="input" value={f.username} onChange={e=>setF({...f,username:e.target.value})}/></div>
              <div className="fld"><label>Password</label><input className="input" type="password" value={f.password} onChange={e=>setF({...f,password:e.target.value})}/></div>
            </div>
            <div className="modal-foot"><button className="btn btn-ghost" style={{ flex:1 }} onClick={()=>setShow(false)}>CANCEL</button><button className="btn btn-amber" style={{ flex:2 }} onClick={create}><Icon name="plus" size={15}/> CREATE &amp; BIND</button></div>
          </div>
        </div>
      )}
    </>
  );
};
window.LiveMasterUserManagement = LiveMasterUserManagement;

// ── Worker · Attendance & Leave (live apply + history) ──────
const LiveWorkerLeave = () => {
  const poll = useBWPoll(() => BW_API.leaveMine(), [], 3000);
  const rows = poll.data || [];
  const [f, setF] = useLS({ from_date:'', to_date:'', leave_type:'Personal', reason:'' });
  const [msg, setMsg] = useLS('');
  const apply = async () => {
    if (!f.from_date || !f.to_date) { setMsg('Pick from and to dates'); return; }
    try { await BW_API.leaveApply(f); setMsg('Leave request submitted ✓'); setF({ from_date:'', to_date:'', leave_type:'Personal', reason:'' }); await poll.reload(); }
    catch (e) { setMsg(e.message); }
  };
  return (
    <>
      <div className="content-head"><div><div className="eyebrow eyebrow-amber">● ATTENDANCE & LEAVE</div><h1>Leave</h1><span className="sub">Live · {rows.length} request{rows.length!==1?'s':''}</span></div></div>
      {msg && <div className="cred-note" style={{ marginBottom:14 }}><Icon name="shield" size={13}/> {msg}</div>}
      <div className="bottom-row">
        <div className="card">
          <div className="card-head"><span className="eyebrow eyebrow-amber">APPLY FOR LEAVE</span></div>
          <div className="leave-form">
            <div className="field"><label>From</label><input className="input" type="date" value={f.from_date} onChange={e=>setF({...f,from_date:e.target.value})}/></div>
            <div className="field"><label>To</label><input className="input" type="date" value={f.to_date} onChange={e=>setF({...f,to_date:e.target.value})}/></div>
            <div className="field full"><label>Type</label><select className="input" value={f.leave_type} onChange={e=>setF({...f,leave_type:e.target.value})}><option>Personal</option><option>Medical</option><option>Family Emergency</option><option>Vacation</option></select></div>
            <div className="field full"><label>Reason</label><textarea value={f.reason} onChange={e=>setF({...f,reason:e.target.value})}/></div>
            <div className="full row" style={{ justifyContent:'flex-end' }}><button className="btn btn-amber" onClick={apply}>SUBMIT REQUEST <Icon name="arrow-right" size={14}/></button></div>
          </div>
        </div>
        <div className="card">
          <div className="card-head"><span className="eyebrow eyebrow-amber">MY LEAVE HISTORY</span></div>
          {rows.length === 0 && <div className="wc-empty"><Icon name="calendar" size={24}/><div className="t">No requests yet</div></div>}
          {rows.map(r => (
            <div className="leave-row" key={r.id}>
              <Icon name="calendar" size={14} style={{ color:'var(--t-3)' }}/>
              <div><div className="dates">{r.from_date} → {r.to_date}</div><div className="reason">{r.reason || r.leave_type}</div></div>
              <span className={`chip ${r.status==='approved'?'ok':r.status==='rejected'?'danger':'warn'}`}>{r.status.toUpperCase()}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
};
window.LiveWorkerLeave = LiveWorkerLeave;

// ════════════════════════════════════════════════════════════
//  PLATFORM LAYER — the pieces that make it ONE product:
//  Command Palette (Ctrl+K) · Notification Center · Job Timeline
//  · Audit Logs. All read from the existing audit/notification
//  data through additive read-only endpoints.
// ════════════════════════════════════════════════════════════

// friendly labels for raw audit actions (notifications + timeline + audit log)
const BW_EVENT_MAP = {
  JOB_CREATED:    { label: 'Job created',            tone: 'info',   icon: 'clipboard' },
  JOB_UPDATED:    { label: 'Job updated',            tone: 'info',   icon: 'edit' },
  JOB_ASSIGNED:   { label: 'Job assigned to bay',    tone: 'info',   icon: 'route' },
  JOB_STARTED:    { label: 'Service started',        tone: 'ok',     icon: 'play' },
  JOB_PAUSED:     { label: 'Service paused',         tone: 'warn',   icon: 'pause' },
  JOB_RESUMED:    { label: 'Service resumed',        tone: 'ok',     icon: 'play' },
  JOB_COMPLETED:  { label: 'Service completed',      tone: 'ok',     icon: 'check' },
  JOB_REASSIGN:   { label: 'Worker replaced',        tone: 'warn',   icon: 'user' },
  JOB_CHANGE_BAY: { label: 'Bay changed',            tone: 'info',   icon: 'route' },
  JOB_QUEUE_REMOVE: { label: 'Job removed from queue', tone: 'danger', icon: 'trash' },
  CAMERA_PAIR:    { label: 'Camera paired',          tone: 'ok',     icon: 'cam' },
  CAMERA_UNPAIR:  { label: 'Camera removed',         tone: 'danger', icon: 'cam' },
  CAMERA_UPDATE:  { label: 'Camera updated',         tone: 'info',   icon: 'cam' },
  TIMER_PAIR:     { label: 'Timer paired',           tone: 'ok',     icon: 'clock' },
  TIMER_UNPAIR:   { label: 'Timer removed',          tone: 'danger', icon: 'clock' },
  TIMER_UPDATE:   { label: 'Timer updated',          tone: 'info',   icon: 'clock' },
  TIMER_FIRMWARE_UPDATE: { label: 'Timer firmware update (OTA)', tone: 'info', icon: 'upload' },
  STORAGE_SYNC_NOW: { label: 'Drive sync triggered', tone: 'info',   icon: 'upload' },
  STORAGE_RETRY_UPLOAD: { label: 'Upload retried',   tone: 'warn',   icon: 'upload' },
  RECORDING_STARTED:   { label: 'Recording started',   tone: 'ok',   icon: 'cam' },
  RECORDING_FINALIZED: { label: 'Recording finalized', tone: 'ok',   icon: 'check' },
  DRIVE_UPLOAD_COMPLETE: { label: 'Drive upload complete', tone: 'ok', icon: 'upload' },
  PDF_AVAILABLE:  { label: 'Completion PDF available', tone: 'ok',   icon: 'file' },
  BAY_CREATE:     { label: 'Bay created',            tone: 'info',   icon: 'plus' },
  BAY_UPDATE:     { label: 'Bay updated',            tone: 'info',   icon: 'edit' },
  BAY_DELETE:     { label: 'Bay deleted',            tone: 'danger', icon: 'trash' },
  BAY_STATUS:     { label: 'Bay status changed',     tone: 'warn',   icon: 'route' },
};
const bwEvent = (action) => BW_EVENT_MAP[action] || { label: (action || '').replace(/_/g, ' ').toLowerCase(), tone: 'info', icon: 'bolt' };
const bwAgo = (iso) => {
  if (!iso) return '—';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
};
const bwTime = (iso) => iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false }) : '—';

// ── Command Palette (Ctrl+K / Cmd+K): quick actions + global entity search ──
const BWCommandPalette = ({ actions }) => {
  const [open, setOpen] = useLS(false);
  const [q, setQ] = useLS('');
  const [res, setRes] = useLS(null);
  const [sel, setSel] = useLS(0);
  useLE(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen(o => !o); setQ(''); setRes(null); setSel(0); }
      else if (e.key === 'Escape') setOpen(false);
    };
    const onOpen = () => { setOpen(true); setQ(''); setRes(null); setSel(0); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('bw:palette-open', onOpen);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('bw:palette-open', onOpen); };
  }, []);
  useLE(() => {   // debounced entity search
    if (!open || q.trim().length < 2) { setRes(null); return; }
    const t = setTimeout(() => { BW_API.platformSearch(q.trim()).then(setRes).catch(() => setRes(null)); }, 220);
    return () => clearTimeout(t);
  }, [q, open]);
  if (!open) return null;
  const ql = q.trim().toLowerCase();
  const acts = actions.filter(a => !ql || a.label.toLowerCase().includes(ql));
  const groups = res ? Object.entries(res.groups).filter(([, v]) => v.length) : [];
  const flat = [
    ...acts.map(a => ({ kind: 'action', ...a })),
    ...groups.flatMap(([g, items]) => items.map(it => ({ kind: 'entity', group: g, ...it }))),
  ];
  const go = (item) => {
    if (!item) return;
    const tab = item.nav || item.tab;
    if (tab) window.dispatchEvent(new CustomEvent('bw:navigate', { detail: { tab } }));
    // cross-page command: action items carry `event`; entity hits open their own record.
    // fire after the target page mounts its bw:cmd listener.
    const cmd = item.event || (item.kind === 'entity' ? `${item.group}:open` : null);
    if (cmd) setTimeout(() => window.dispatchEvent(new CustomEvent('bw:cmd', { detail: { cmd, id: item.id } })), 90);
    setOpen(false);
  };
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(s + 1, flat.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(s - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); go(flat[sel]); }
  };
  let idx = -1;
  return (
    <div className="bw-palette-scrim" onClick={() => setOpen(false)}>
      <div className="bw-palette" role="dialog" aria-modal="true" aria-label="Command palette" onClick={(e) => e.stopPropagation()}>
        <div className="bw-palette-search">
          <Icon name="bolt" size={15}/>
          <input autoFocus value={q} placeholder="Search jobs, workers, bays, cameras… or run an action"
            aria-label="Command palette search" onChange={(e) => { setQ(e.target.value); setSel(0); }} onKeyDown={onKey}/>
          <span className="bw-kbd">esc</span>
        </div>
        <div className="bw-palette-body">
          {acts.length > 0 && <div className="bw-palette-sec">QUICK ACTIONS</div>}
          {acts.map((a) => { idx += 1; const i = idx; return (
            <button key={a.label} className={`bw-palette-item ${sel === i ? 'sel' : ''}`}
              onMouseEnter={() => setSel(i)} onClick={() => go(a)}>
              <span className="bw-pi-ico"><Icon name={a.icon} size={14}/></span>
              <span className="bw-pi-t">{a.label}</span>
              <Icon name="arrow-right" size={12}/>
            </button>
          ); })}
          {groups.map(([g, items]) => (
            <React.Fragment key={g}>
              <div className="bw-palette-sec">{g.toUpperCase()}</div>
              {items.map((it) => { idx += 1; const i = idx; return (
                <button key={g + it.id} className={`bw-palette-item ${sel === i ? 'sel' : ''}`}
                  onMouseEnter={() => setSel(i)} onClick={() => go(it)}>
                  <span className="bw-pi-ico"><Icon name={({jobs:'clipboard',workers:'user',bays:'gauge',cameras:'cam',timers:'clock',recordings:'file'})[g] || 'file'} size={14}/></span>
                  <span className="bw-pi-t">{it.title}<span className="bw-pi-s">{it.sub}</span></span>
                  <Icon name="arrow-right" size={12}/>
                </button>
              ); })}
            </React.Fragment>
          ))}
          {q.trim().length >= 2 && res && groups.length === 0 && acts.length === 0 &&
            <div className="bw-palette-none">No matches for “{q}”</div>}
          {q.trim().length < 2 && <div className="bw-palette-hint">Type 2+ characters to search every entity · ↑↓ navigate · ⏎ open</div>}
        </div>
      </div>
    </div>
  );
};
window.BWCommandPalette = BWCommandPalette;

// ── Notification Center: live feed from the audit trail, unread via last-seen ──
const BWNotifications = () => {
  const SEEN_KEY = 'bw_notif_seen';
  const [open, setOpen] = useLS(false);
  const [seen, setSeen] = useLS(() => Number(localStorage.getItem(SEEN_KEY) || 0));
  const poll = useBWPoll(() => BW_API.platformActivity('', 30), [], 20000);
  const events = (poll.data && poll.data.events) || [];
  const unread = events.filter(e => e.at && new Date(e.at).getTime() > seen).length;
  const markAll = () => { const now = Date.now(); localStorage.setItem(SEEN_KEY, String(now)); setSeen(now); };
  useLE(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  return (
    <div className="bw-notif-wrap">
      <button className="btn btn-sm btn-ghost bw-notif-btn" aria-label={`Notifications, ${unread} unread`} onClick={() => setOpen(o => !o)}>
        <Icon name="bell" size={14}/>
        {unread > 0 && <span className="bw-notif-badge">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && <>
        <div className="bw-notif-scrim" onClick={() => setOpen(false)}/>
        <div className="bw-notif-panel" role="dialog" aria-label="Notifications">
          <div className="bw-notif-head">
            <span>Notifications</span>
            <button className="ops-act" onClick={markAll}>Mark all read</button>
          </div>
          <div className="bw-notif-list">
            {events.length === 0 && <div className="bw-palette-none">No activity yet</div>}
            {events.map((e) => {
              const m = bwEvent(e.action);
              const isNew = e.at && new Date(e.at).getTime() > seen;
              return (
                <div key={e.id} className={`bw-notif-item ${isNew ? 'new' : ''}`}>
                  <span className={`bw-pi-ico ${m.tone}`}><Icon name={m.icon} size={13}/></span>
                  <div className="bw-notif-txt">
                    <div className="t">{m.label}</div>
                    <div className="s mono">{e.entity_id || e.entity_type || ''} · {e.by}</div>
                  </div>
                  <span className="bw-notif-ago">{bwAgo(e.at)}</span>
                </div>
              );
            })}
          </div>
        </div>
      </>}
    </div>
  );
};
window.BWNotifications = BWNotifications;

// ── Job activity timeline (admin/master — full event trail for one session) ──
const OpsTimeline = ({ sessionId }) => {
  const poll = useBWPoll(() => BW_API.platformTimeline(sessionId), [sessionId], 5000);
  const events = (poll.data && poll.data.events) || [];
  return (
    <div className="ops-tl">
      {events.length === 0 && <div className="jd-na" style={{ fontSize: 12.5 }}>No events recorded yet.</div>}
      {events.map((e, i) => {
        const m = bwEvent(e.event);
        return (
          <div key={i} className="ops-tl-row">
            <span className="ops-tl-time mono">{bwTime(e.at)}</span>
            <span className={`ops-tl-dot ${m.tone}`}/>
            <span className="ops-tl-label">{m.label}{e.by ? <span className="ops-tl-by"> · {e.by}</span> : null}</span>
          </div>
        );
      })}
    </div>
  );
};


// ── Audit Logs (master) — searchable record of every critical action ──
const LiveAuditLogs = () => {
  const [q, setQ] = useLS('');
  const poll = useBWPoll(() => BW_API.platformActivity(q, 100), [q], 8000);
  const events = (poll.data && poll.data.events) || [];
  return (
    <>
      <OpsPageHead eyebrow="AUDIT LOGS" title="Audit Logs" sub="Every critical action, recorded and searchable.">
        <button className="btn btn-ghost btn-sm" onClick={() => poll.reload()}><Icon name="route" size={13}/> Refresh</button>
      </OpsPageHead>
      <div className="ops-toolbar">
        <div className="ops-search">
          <Icon name="scan" size={14}/>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search action, entity, id…" aria-label="Search audit logs"/>
          {q && <button className="ops-search-x" aria-label="Clear search" onClick={() => setQ('')}><Icon name="x" size={12}/></button>}
        </div>
        <span className="ops-sort mono">{events.length} events</span>
      </div>
      <div className="card">
        {!poll.data ? <OpsSkeleton n={3}/> : (
          <div className="audit-table">
            <div className="audit-row audit-head"><span>TIME</span><span>EVENT</span><span>ENTITY</span><span>BY</span></div>
            {events.map((e) => {
              const m = bwEvent(e.action);
              return (
                <div key={e.id} className="audit-row">
                  <span className="mono audit-time">{bwAgo(e.at)} · {bwTime(e.at)}</span>
                  <span className="audit-ev"><span className={`ops-tl-dot ${m.tone}`}/>{m.label}</span>
                  <span className="mono audit-ent">{e.entity_type || '—'}{e.entity_id ? ` · ${String(e.entity_id).slice(0, 18)}` : ''}</span>
                  <span className="audit-by">{e.by}</span>
                </div>
              );
            })}
            {events.length === 0 && <div className="cam-empty"><Icon name="shield" size={20}/><span>No matching events.</span></div>}
          </div>
        )}
      </div>
    </>
  );
};
window.LiveAuditLogs = LiveAuditLogs;

// ════════════════════════════════════════════════════════════
//  Master · Customer Live Watch — audit of every link decision
//  across all branches. Two surfaces: Video Sent + Video Not Sent
//  (REVERT → ELIGIBLE so a branch admin may send the link later).
// ════════════════════════════════════════════════════════════
const CW_BADGE = {
  CREATED: ['info', 'Link sent'], LIVE: ['ok', 'Live'], PAUSED: ['warn', 'Paused'],
  COMPLETED: ['ghost', 'Completed'], EXPIRED: ['ghost', 'Expired'],
  NOT_SENT: ['warn', 'Awaiting review'], ELIGIBLE: ['ok', 'Eligible'],
};
const CwBadge = ({ st }) => { const m = CW_BADGE[st] || ['ghost', st]; return <span className={`chip ${m[0]}`}>{m[1]}</span>; };
// WhatsApp delivery is tracked separately from the link lifecycle — a failed send
// is surfaced honestly (never hidden), while the link itself stays valid (Copy works).
const CW_WA = { sent: ['ok', 'Sent'], failed: ['danger', 'Failed'], not_configured: ['ghost', 'Not sent'] };
const CwWa = ({ s }) => { if (!s) return <span className="cell-meta">—</span>; const m = CW_WA[s] || ['ghost', s]; return <span className={`chip ${m[0]}`}>{m[1]}</span>; };

const LiveCustomerWatchAudit = () => {
  const poll = useBWPoll(() => BW_API.cwAudit(), [], 6000);
  const d = poll.data || { sent: [], not_sent: [], counts: {} };
  const [busy, setBusy] = useLS(null);
  const [toast, setToast] = useLS('');
  const flash = (m) => { setToast(m); setTimeout(() => setToast(''), 2500); };
  const revert = async (id) => {
    setBusy(id);
    try { const r = await BW_API.cwRevert(id); flash((r && r.message) || 'Reverted ✓'); poll.reload(); }
    catch (e) { flash(e.message || 'Could not revert'); } finally { setBusy(null); }
  };
  const when = (iso) => { if (!iso) return '—'; try { const t = new Date(iso); return `${String(t.getDate()).padStart(2, '0')} ${t.toLocaleString('en-IN', { month: 'short' })} · ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`; } catch (e) { return '—'; } };
  const SENT = 'minmax(150px,1.3fr) 120px 120px 110px 110px 110px 120px';
  const NS = 'minmax(140px,1.2fr) 130px 120px 130px 120px minmax(150px,1.4fr) 130px 96px';

  return (
    <>
      <div className="section-head"><div><h2>Customer Live Watch</h2>
        <span className="sub">{(d.counts.sent || 0)} links sent · {(d.counts.not_sent || 0)} not sent · all branches</span></div></div>

      <div className="adash-subhead"><Icon name="cam" size={14}/> Video sent</div>
      <div className="adash-tbl">
        <div className="adash-head adash-tr" style={{ gridTemplateColumns: SENT }}>
          <span className="adash-th">Customer</span><span className="adash-th">Vehicle</span>
          <span className="adash-th">Branch</span><span className="adash-th">Admin</span>
          <span className="adash-th">Status</span><span className="adash-th">WhatsApp</span><span className="adash-th">Created</span>
        </div>
        <div className="adash-tbody">
          {d.sent.map(r => (
            <div key={r.id} className="adash-tr" style={{ gridTemplateColumns: SENT }}>
              <span className="adash-td adash-td-primary"><b>{r.customer_name || '—'}</b></span>
              <span className="adash-td">{r.vehicle_number || '—'}</span>
              <span className="adash-td">{r.branch_name || '—'}</span>
              <span className="adash-td">{r.admin_name || '—'}</span>
              <span className="adash-td"><CwBadge st={r.status}/></span>
              <span className="adash-td"><CwWa s={r.whatsapp_status}/></span>
              <span className="adash-td cell-meta">{when(r.created_at)}</span>
            </div>
          ))}
          {d.sent.length === 0 && <div className="ops-none"><Icon name="cam" size={22}/><div>No live links sent yet</div></div>}
        </div>
      </div>

      <div className="adash-subhead" style={{ marginTop: 18 }}><Icon name="shield" size={14}/> Video not sent</div>
      <div className="adash-tbl">
        <div className="adash-head adash-tr" style={{ gridTemplateColumns: NS }}>
          <span className="adash-th">Customer</span><span className="adash-th">Phone</span>
          <span className="adash-th">Vehicle</span><span className="adash-th">Branch</span>
          <span className="adash-th">Admin</span><span className="adash-th">Reason</span>
          <span className="adash-th">Status</span><span className="adash-th"/>
        </div>
        <div className="adash-tbody">
          {d.not_sent.map(r => (
            <div key={r.id} className="adash-tr" style={{ gridTemplateColumns: NS }}>
              <span className="adash-td adash-td-primary"><b>{r.customer_name || '—'}</b></span>
              <span className="adash-td cell-meta">{r.customer_mobile || '—'}</span>
              <span className="adash-td">{r.vehicle_number || '—'}</span>
              <span className="adash-td">{r.branch_name || '—'}</span>
              <span className="adash-td">{r.admin_name || '—'}</span>
              <span className="adash-td cell-meta" title={r.reason}>{r.reason || '—'}</span>
              <span className="adash-td"><CwBadge st={r.status}/></span>
              <span className="adash-td adash-td-r">
                {r.status === 'NOT_SENT'
                  ? <button className="btn btn-sm btn-ghost" disabled={busy === r.id} onClick={() => revert(r.id)}>{busy === r.id ? '…' : 'Revert'}</button>
                  : <span className="cell-meta">{r.reverted_by ? 'Reverted' : '—'}</span>}
              </span>
            </div>
          ))}
          {d.not_sent.length === 0 && <div className="ops-none"><Icon name="shield" size={22}/><div>No “do not send” records</div></div>}
        </div>
      </div>

      {toast && <div className="ujq-toast"><Icon name="check" size={15}/> {toast}</div>}
    </>
  );
};
window.LiveCustomerWatchAudit = LiveCustomerWatchAudit;

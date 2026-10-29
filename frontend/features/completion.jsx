// Shared recording helpers — RecordingUtil (status/expiry/signed URLs),
// RecordingStatusBadge, RecordingPreviewModal and VideoActions. Consumed by the
// live Admin/Master/Worker/Customer recording & completion views in live.jsx.
// The former demo WorkCompletion / CreateWorkerModal / ROSTER / COMPLETIONS /
// PDF generators were removed — all completion data is owned by PostgreSQL.
const { useState: useCS, useMemo: useCM, useEffect: useCE } = React;


// Retention windows (used by RecordingUtil).
const RETENTION_DAYS = 14;
const EXPIRING_DAYS = 3;   // < 3 days left → "Expiring Soon"

const RecordingUtil = {
  // ms remaining → whole days (ceil), never negative.
  // `now` lets demo data anchored to a fictional "today" compute correctly.
  daysLeft(expiresAt, now) {
    if (!expiresAt) return 0;
    const ref = now || Date.now();
    const ms = (expiresAt instanceof Date ? expiresAt.getTime() : expiresAt) - ref;
    return Math.max(0, Math.ceil(ms / 864e5));
  },
  // active | expiring | expired  (PART 10 logic)
  status(expiresAt, raw, now) {
    if (raw === 'expired' || raw === 'deleted') return 'expired';
    if (!expiresAt) return 'expired';
    const ref = now || Date.now();
    const exp = expiresAt instanceof Date ? expiresAt.getTime() : expiresAt;
    if (exp <= ref) return 'expired';
    return RecordingUtil.daysLeft(exp, ref) <= EXPIRING_DAYS ? 'expiring' : 'active';
  },
  // Secure signed URL — raw cloud-storage paths are NEVER exposed (PART 11)
  signedUrl(recId, expiresAt) {
    if (!recId) return null;
    const exp = expiresAt ? (expiresAt instanceof Date ? expiresAt.getTime() : expiresAt) : 0;
    let token = '';
    try { token = btoa(`${recId}:${exp}:baywatch`).replace(/[^a-zA-Z0-9]/g, '').slice(0, 24); }
    catch (e) { token = String(recId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 24); }
    return `https://app.baywatch.com/recordings/${recId}?sig=${token}&exp=${Math.floor(exp / 1000)}`;
  },
  // seconds → HH:MM:SS
  durationFull(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  },
  fmtDate(ts) {
    if (!ts) return '—';
    const d = ts instanceof Date ? ts : new Date(ts);
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  },
  // Normalize any source row/session into the shared recording object
  // consumed by RecordingPreviewModal / VideoActions / badges.
  build(o) {
    const exp = o.expiresAt instanceof Date ? o.expiresAt.getTime() : o.expiresAt;
    const status = RecordingUtil.status(exp, o.rawStatus, o.now);
    const daysLeft = RecordingUtil.daysLeft(exp, o.now);
    return {
      jc: o.jc || '—', ss: o.ss || null, recId: o.recId || '—',
      worker: o.worker || '—', wid: o.wid || '—',
      customer: o.customer || null, custId: o.custId || null,
      plate: o.plate || '—', vehicle: o.vehicle || '—', service: o.service || '—',
      start: o.start || '—', end: o.end || '—',
      durationSec: o.durationSec || 0,
      bay: o.bay || null,
      expiresAt: exp, status, daysLeft,
      url: status === 'expired' ? null : RecordingUtil.signedUrl(o.recId, exp),
    };
  },
  // Map a normalized recording → the recording_table row shape (PART 9)
  toRow(rec, extra) {
    extra = extra || {};
    return {
      recording_id: rec.recId,
      service_session_id: rec.ss,
      job_card_id: rec.jc,
      worker_id: rec.wid,
      customer_id: rec.custId,
      video_url: rec.url,                          // signed; null once expired
      recording_start_time: rec.start,
      recording_end_time: rec.end,
      recording_duration: RecordingUtil.durationFull(rec.durationSec),
      recording_created_at: extra.createdAt || null,
      recording_expiry_date: rec.expiresAt,
      recording_status: rec.status,
      is_deleted: rec.status === 'expired',
    };
  },
};
window.RecordingUtil = RecordingUtil;

// ── Shared: recording status badge (Active / Expiring / Expired) ──
const RecordingStatusBadge = ({ status, daysLeft }) => {
  const expired = status === 'expired', expiring = status === 'expiring';
  return (
    <span className={`rec-status-chip ${status || 'expired'}`}>
      {!expired && <span className="dot" style={{background: expiring ? 'var(--warn)' : 'var(--ok)'}}/>}
      {expired ? 'Expired' : expiring ? `Expiring · ${daysLeft}d` : `Active · ${daysLeft}d`}
    </span>
  );
};
window.RecordingStatusBadge = RecordingStatusBadge;

// ── Shared: video preview / full recording modal ──────────────
// rec = RecordingUtil.build(...). expanded → larger player ("View Recording").
// hideInternal → omit bay/cam numbers (customer view, PART 11 privacy).
const RecordingPreviewModal = ({ rec, expanded: initExpanded, hideInternal, onClose }) => {
  const [expanded, setExpanded] = useCS(!!initExpanded);
  const [copied, setCopied] = useCS(false);
  if (!rec) return null;
  const expired = rec.status === 'expired';
  const expiring = rec.status === 'expiring';
  const url = rec.url;
  const copyLink = () => {
    if (!url) return;
    navigator.clipboard.writeText(url).then(()=>{ setCopied(true); setTimeout(()=>setCopied(false),2200); }).catch(()=>{});
  };
  return (
    <div className="modal-scrim" onClick={onClose} style={{zIndex:360}}>
      <div className="modal" onClick={e=>e.stopPropagation()} style={{width: expanded ? 980 : 860, maxWidth:'95vw', maxHeight:'92vh', overflowY:'auto', padding:0}}>
        <div className="modal-head" style={{padding:'14px 18px'}}>
          <span className="eyebrow eyebrow-amber">{expired ? 'RECORDING EXPIRED' : expanded ? 'SERVICE RECORDING' : 'RECORDING PREVIEW'} · {rec.jc}</span>
          <button className="modal-close" onClick={onClose}><Icon name="x" size={15}/></button>
        </div>
        <div style={{padding:'0 16px 16px'}}>
          {expired ? (
            <div className="rec-expired">
              <Icon name="alert" size={22}/>
              <div>
                <div className="t">Recording Expired</div>
                <div className="s">This recording has exceeded its {RETENTION_DAYS}-day retention period and is no longer available. Recordings and their storage files are removed automatically to protect privacy.</div>
              </div>
            </div>
          ) : (
            <div className="cvm-player-card" style={expanded ? {minHeight:300} : null}>
              <div className="cvm-cam-label">
                <div className="rec-badge"><span className="rec-dot"/>PLAYBACK · {rec.recId}</div>
                {!hideInternal
                  ? <div style={{fontFamily:'var(--font-mono)',fontSize:9,color:'var(--t-2)',letterSpacing:'0.08em'}}>CAM-{String(rec.bay||0).padStart(2,'0')} · 1080p · 60fps</div>
                  : <div style={{fontFamily:'var(--font-mono)',fontSize:9,color:'var(--t-2)',letterSpacing:'0.08em'}}>SECURE STREAM · 1080p</div>}
              </div>
              {url ? (
                <video className="cvm-video" src={url} controls autoPlay playsInline
                  style={{width:'100%', maxHeight: expanded ? 540 : 420, aspectRatio:'16 / 9', objectFit:'contain', borderRadius:8, background:'#000', display:'block'}}/>
              ) : (
                <div className="cvm-play-center" style={expanded ? {padding:'48px 24px'} : null}>
                  <div className="cvm-play-btn"><Icon name="play" size={expanded ? 34 : 28}/></div>
                  <div className="cvm-play-dur">{RecordingUtil.durationFull(rec.durationSec)} recorded{!hideInternal && rec.bay ? ` · BAY ${String(rec.bay).padStart(2,'0')}` : ''}</div>
                </div>
              )}
              <div className="cvm-cam-foot">
                <span>{rec.worker}{rec.wid && rec.wid!=='—' ? ` · ${rec.wid}` : ''}</span>
                <span>{rec.vehicle} · {rec.plate}</span>
              </div>
              {expiring && (
                <div className="cvm-expiry-bar">
                  <Icon name="alert" size={11}/>
                  Expires in {rec.daysLeft} day{rec.daysLeft===1?'':'s'} — save the link before it expires
                </div>
              )}
            </div>
          )}

          {/* Recording information — 5-col grid (10 cells, fills cleanly);
              Service Type sits in its own full-width card below (never narrow) */}
          <div className="rec-meta-grid">
            <div className="rec-meta"><div className="l">Worker</div><div className="v">{rec.worker}{rec.wid && rec.wid!=='—'?` · ${rec.wid}`:''}</div></div>
            <div className="rec-meta"><div className="l">Customer</div><div className="v">{rec.customer || '—'}</div></div>
            <div className="rec-meta"><div className="l">Vehicle No</div><div className="v mono">{rec.plate}</div></div>
            <div className="rec-meta"><div className="l">Bike Model</div><div className="v">{rec.vehicle}</div></div>
            <div className="rec-meta"><div className="l">Job Card</div><div className="v mono">{rec.jc}</div></div>
            <div className="rec-meta"><div className="l">Session ID</div><div className="v mono">{rec.recId}</div></div>
            <div className="rec-meta"><div className="l">Start</div><div className="v mono">{rec.start}</div></div>
            <div className="rec-meta"><div className="l">End</div><div className="v mono">{rec.end}</div></div>
            <div className="rec-meta"><div className="l">Duration</div><div className="v mono">{RecordingUtil.durationFull(rec.durationSec)}</div></div>
            <div className="rec-meta"><div className="l">{expired ? 'Status' : 'Expires'}</div>
              <div className="v" style={{color: expired ? 'var(--danger)' : expiring ? 'var(--warn)' : 'var(--ok)'}}>
                {expired ? 'Expired' : `${RecordingUtil.fmtDate(rec.expiresAt)} · ${rec.daysLeft}d left`}
              </div>
            </div>
          </div>
          <div className="rec-svc-card">
            <div className="l">Service Type</div>
            <div className="v" title={rec.service}>{rec.service}</div>
          </div>

          {/* Actions: View Recording · Copy Link · Close — raw URL is never shown */}
          <div className="rec-action-row" style={{padding:'16px 0 4px'}}>
            {!expired && !expanded && (
              <button className="btn btn-amber" style={{flex:1}} onClick={()=>setExpanded(true)}>
                <Icon name="cam" size={14}/> VIEW RECORDING
              </button>
            )}
            {!expired && url && (
              <button className="btn btn-ghost" style={{flex:1}} onClick={copyLink}>
                <Icon name={copied?'check':'history'} size={14}/> {copied ? 'COPIED!' : 'COPY LINK'}
              </button>
            )}
            <button className="btn btn-ghost" style={{flex: expired ? 1 : 'unset', minWidth:120}} onClick={onClose}>CLOSE</button>
          </div>
        </div>
      </div>
    </div>
  );
};
window.RecordingPreviewModal = RecordingPreviewModal;

// ── Shared: 3-button video cell (Preview · View · Copy) ──────────
// Self-contained — manages its own modal. layout: 'inline' | 'stack'.
// compact → icon-only buttons (dense tables).
const VideoActions = ({ rec, layout, compact, hideInternal }) => {
  const [modal, setModal] = useCS(null);   // { expanded } | null
  const [copied, setCopied] = useCS(false);
  if (!rec) return <span className="mono" style={{fontSize:9,color:'var(--t-4)'}}>—</span>;
  const expired = rec.status === 'expired';
  const copyLink = () => {
    if (!rec.url) return;
    navigator.clipboard.writeText(rec.url).then(()=>{ setCopied(true); setTimeout(()=>setCopied(false),2000); }).catch(()=>{});
  };
  return (
    <>
      {modal && <RecordingPreviewModal rec={rec} expanded={modal.expanded} hideInternal={hideInternal} onClose={()=>setModal(null)}/>}
      <div className={`video-actions ${layout==='stack'?'stack':''}`}>
        {expired ? (
          <button className="va-btn ghost" onClick={()=>setModal({expanded:false})} title="Recording expired">
            <Icon name="alert" size={11}/>{!compact && ' Expired'}
          </button>
        ) : (
          <>
            <button className="va-btn amber" onClick={()=>setModal({expanded:false})} title="Preview Video">
              <Icon name="play" size={11}/>{!compact && ' Preview'}
            </button>
            <button className="va-btn" onClick={()=>setModal({expanded:true})} title="View Recording">
              <Icon name="cam" size={11}/>{!compact && ' View'}
            </button>
            <button className="va-btn" onClick={copyLink} title="Copy secure link">
              <Icon name={copied?'check':'history'} size={11}/>{!compact && (copied ? ' Copied' : ' Copy')}
            </button>
          </>
        )}
      </div>
    </>
  );
};
window.VideoActions = VideoActions;

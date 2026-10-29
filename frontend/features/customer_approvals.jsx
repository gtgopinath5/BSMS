// ============================================================
//  Customer Estimate Approval — Admin / Master page.
//  Review extracted parts, add service suggestions, generate a
//  temporary customer approval link, send via WhatsApp (real or
//  honest), and track the customer's submitted response.
//
//  The raw token is returned ONCE by generate-link and held only
//  in memory here; nothing secret is stored client-side.
// ============================================================
const { useState: useCAS, useEffect: useCAE, useCallback: useCAC, useRef: useCAR } = React;

const CA_STATUS = {
  draft: { c: 'idle', l: 'Draft' }, sent: { c: 'warn', l: 'Sent' },
  viewed: { c: 'info', l: 'Viewed' }, submitted: { c: 'ok', l: 'Submitted' },
  approved: { c: 'ok', l: 'Approved' }, rejected: { c: 'danger', l: 'Rejected' },
  changes_requested: { c: 'warn', l: 'Changes requested' },
  expired: { c: 'idle', l: 'Expired' }, cancelled: { c: 'danger', l: 'Cancelled' },
};
const caPill = (s) => CA_STATUS[s] || { c: 'idle', l: s || '—' };
const caRupee = (n) => '₹' + Math.round(n || 0).toLocaleString('en-IN');
const caRupeeN = (n) => (n === null || n === undefined || n === '') ? '—' : caRupee(n);
const caNum = (v) => (v === '' || v === null || v === undefined) ? null : Number(v);
const caMins = (m) => { m = Math.round(m || 0); const h = Math.floor(m / 60), r = m % 60; return h ? `${h}h ${r}m` : `${r}m`; };
const caFmt = (iso) => { if (!iso) return '—'; try { return new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (e) { return iso; } };
const CA_REASONS = [['none', 'None'], ['mandatory', 'Mandatory'], ['suggested', 'Suggested'], ['upcoming', 'Upcoming']];

// editable item row
const CaItemRow = ({ it, locked, onEdit, onDelete }) => {
  const [edit, setEdit] = useCAS(false);
  const [f, setF] = useCAS(it);
  useCAE(() => setF(it), [it.id, it.amount, it.quantity, it.unit_price, it.estimated_minutes, it.customer_status]);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const cust = it.customer_status;
  const faded = cust === 'removed' || cust === 'rejected';
  if (edit) {
    return (
      <div className="ca-irow ca-edit">
        <input className="ca-in" value={f.item_name} onChange={(e) => set('item_name', e.target.value)} placeholder="Part name"/>
        <input className="ca-in sm" value={f.product_code || ''} onChange={(e) => set('product_code', e.target.value)} placeholder="Part no."/>
        <input className="ca-in xs" type="number" value={f.quantity} onChange={(e) => set('quantity', e.target.value)} title="Qty"/>
        <input className="ca-in xs" type="number" value={f.unit_value ?? ''} onChange={(e) => set('unit_value', e.target.value)} title="Unit value" placeholder="UV"/>
        <input className="ca-in xs ca-cost" type="number" value={f.service_cost ?? ''} onChange={(e) => set('service_cost', e.target.value)} title="Service cost" placeholder="Svc ₹"/>
        <input className="ca-in xs ca-cost" type="number" value={f.labour_cost ?? ''} onChange={(e) => set('labour_cost', e.target.value)} title="Labour cost" placeholder="Lab ₹"/>
        <input className="ca-in xs ca-cost" type="number" value={f.total_cost ?? ''} onChange={(e) => set('total_cost', e.target.value)} title="Total cost" placeholder="Tot ₹"/>
        {it.source === 'admin_suggestion' && (
          <select className="ca-in sm" value={f.reason_type} onChange={(e) => set('reason_type', e.target.value)}>
            {CA_REASONS.filter(r => r[0] !== 'none').map(r => <option key={r[0]} value={r[0]}>{r[1]}</option>)}
          </select>)}
        <div className="ca-iacts">
          <button className="btn btn-sm btn-amber" onClick={() => { onEdit(it.id, { item_name: f.item_name, product_code: f.product_code, quantity: Number(f.quantity) || 0, unit_value: caNum(f.unit_value), service_cost: caNum(f.service_cost), labour_cost: caNum(f.labour_cost), total_cost: caNum(f.total_cost), reason_type: f.reason_type, description: f.description }); setEdit(false); }}>Save</button>
          <button className="btn btn-sm btn-ghost" onClick={() => { setF(it); setEdit(false); }}>Cancel</button>
        </div>
      </div>
    );
  }
  return (
    <div className={`ca-irow ${faded ? 'faded' : ''} ${it.has_missing_cost ? 'ca-missing' : ''}`}>
      <div className="ca-iname">
        <span className="nm">{it.item_name}</span>
        {it.reason_type && it.reason_type !== 'none' && <span className={`ca-badge ${it.reason_type}`}>{it.reason_type}</span>}
        {it.has_missing_cost
          ? <span className="ca-cbadge missing">Missing Cost</span>
          : <span className="ca-cbadge ready">{it.source === 'admin_suggestion' ? 'Manual' : 'Extracted'}</span>}
        <span className={`ca-ist ${cust}`}>{cust}</span>
        <div className="ca-imeta">{it.product_code ? it.product_code + ' · ' : ''}Qty {it.quantity}{it.unit_value != null ? ' · UV ' + it.unit_value : ''}</div>
      </div>
      <div className="ca-icosts">
        <span title="Service cost">{caRupeeN(it.service_cost)}</span>
        <span title="Labour cost">{caRupeeN(it.labour_cost)}</span>
        <b title="Total cost">{caRupeeN(it.total_cost != null ? it.total_cost : it.amount)}</b>
      </div>
      {!locked && (
        <div className="ca-iacts">
          <button className="btn btn-sm btn-ghost" onClick={() => setEdit(true)} title="Edit"><Icon name="route" size={12}/></button>
          <button className="btn btn-sm btn-ghost ca-del" onClick={() => onDelete(it.id)} title="Delete"><Icon name="x" size={12}/></button>
        </div>)}
    </div>
  );
};

const CaItemsTable = ({ title, hint, items, source, locked, onEdit, onDelete, onAdd }) => {
  const [add, setAdd] = useCAS(false);
  const blank = { item_name: '', product_code: '', quantity: 1, unit_value: '', service_cost: '', labour_cost: '', total_cost: '', reason_type: source === 'admin_suggestion' ? 'suggested' : 'none', description: '' };
  const [nf, setNf] = useCAS(blank);
  const set = (k, v) => setNf((x) => ({ ...x, [k]: v }));
  return (
    <div className="card ca-itable">
      <div className="card-head"><span className="eyebrow eyebrow-amber">{title}</span>
        {!locked && <button className="btn btn-sm btn-ghost" onClick={() => setAdd(a => !a)}><Icon name="plus" size={12}/> Add</button>}</div>
      {hint && <div className="ca-hint">{hint}</div>}
      {items.length === 0 && <div className="ca-empty">No items yet.</div>}
      {items.map(it => <CaItemRow key={it.id} it={it} locked={locked} onEdit={onEdit} onDelete={onDelete}/>)}
      {add && !locked && (
        <div className="ca-irow ca-edit ca-addrow">
          <input className="ca-in" value={nf.item_name} onChange={(e) => set('item_name', e.target.value)} placeholder="Part name"/>
          <input className="ca-in sm" value={nf.product_code} onChange={(e) => set('product_code', e.target.value)} placeholder="Part no."/>
          <input className="ca-in xs" type="number" value={nf.quantity} onChange={(e) => set('quantity', e.target.value)} title="Qty"/>
          <input className="ca-in xs" type="number" value={nf.unit_value} onChange={(e) => set('unit_value', e.target.value)} title="Unit value" placeholder="UV"/>
          <input className="ca-in xs ca-cost" type="number" value={nf.service_cost} onChange={(e) => set('service_cost', e.target.value)} title="Service cost" placeholder="Svc ₹"/>
          <input className="ca-in xs ca-cost" type="number" value={nf.labour_cost} onChange={(e) => set('labour_cost', e.target.value)} title="Labour cost" placeholder="Lab ₹"/>
          <input className="ca-in xs ca-cost" type="number" value={nf.total_cost} onChange={(e) => set('total_cost', e.target.value)} title="Total cost" placeholder="Tot ₹"/>
          {source === 'admin_suggestion' && (
            <select className="ca-in sm" value={nf.reason_type} onChange={(e) => set('reason_type', e.target.value)}>
              {CA_REASONS.filter(r => r[0] !== 'none').map(r => <option key={r[0]} value={r[0]}>{r[1]}</option>)}
            </select>)}
          <div className="ca-iacts">
            <button className="btn btn-sm btn-amber" disabled={!nf.item_name.trim()} onClick={() => { onAdd({ ...nf, source, quantity: Number(nf.quantity) || 1, unit_value: caNum(nf.unit_value), service_cost: caNum(nf.service_cost), labour_cost: caNum(nf.labour_cost), total_cost: caNum(nf.total_cost) }); setNf(blank); setAdd(false); }}>Add</button>
            <button className="btn btn-sm btn-ghost" onClick={() => { setNf(blank); setAdd(false); }}>Cancel</button>
          </div>
        </div>)}
    </div>
  );
};

// link / status / WhatsApp panel (send actions live in the action bar above)
const CaLinkPanel = ({ appr, rawUrl, onAction, flash, locked }) => {
  const [busy, setBusy] = useCAS('');
  const al = appr.active_link || null;
  const linkSt = al ? caPill(al.status) : null;
  const run = async (kind, fn) => { setBusy(kind); try { await fn(); } catch (e) { flash('err', e.message || 'Failed'); } finally { setBusy(''); } };
  const copy = () => { if (rawUrl) { navigator.clipboard && navigator.clipboard.writeText(rawUrl); flash('ok', 'Link copied'); } };
  const st = caPill(appr.status);
  return (
    <div className="card ca-link">
      <div className="card-head"><span className="eyebrow eyebrow-amber">APPROVAL LINK · v{appr.current_version_no || 1}</span>
        <span className={`badge ${st.c}`}>{st.l}</span></div>
      <div className="ca-srow"><span>Created</span><b>{caFmt(appr.created_at)}</b></div>
      <div className="ca-srow"><span>Last sent</span><b>{caFmt(appr.last_sent_at || appr.sent_at)}</b></div>
      <div className="ca-srow"><span>Viewed</span><b>{caFmt(appr.last_viewed_at || appr.viewed_at)}</b></div>
      <div className="ca-srow"><span>Submitted</span><b>{caFmt(appr.last_submitted_at || appr.submitted_at)}</b></div>
      <div className="ca-srow"><span>Link status</span><b>{linkSt ? <span className={`badge ${linkSt.c}`}>{linkSt.l}</span> : '—'}</b></div>
      <div className="ca-srow"><span>Expires</span><b>{caFmt((al && al.expires_at) || appr.expires_at)}</b></div>
      <div className="ca-srow"><span>Retention</span><b>{caFmt(appr.retention_expires_at)}</b></div>

      {rawUrl && (
        <div className="ca-url"><input readOnly value={rawUrl} onFocus={(e) => e.target.select()}/></div>)}
      {!rawUrl && al && ['active', 'viewed'].includes(al.status) && (
        <div className="ca-note">A link is active (•••{al.token_last4}). The raw link shows only when freshly issued — use Edit &amp; Resend for a new copyable link.</div>)}
      {!locked && <div className="ca-linkacts">
        {rawUrl && <button className="btn btn-ghost btn-sm" onClick={copy}><Icon name="upload" size={12}/> Copy link</button>}
        <button className="btn btn-ghost btn-sm" disabled={busy === 'wa' || !rawUrl} title={rawUrl ? 'Send the link via WhatsApp' : 'Issue a link first'} onClick={() => run('wa', () => onAction('whatsapp'))}><Icon name="bell" size={12}/> Send WhatsApp</button>
        <button className="btn btn-ghost btn-sm ca-del" disabled={busy === 'cancel'} onClick={() => run('cancel', () => onAction('cancel'))}>Cancel approval</button>
      </div>}
      {appr.whatsapp_status === 'not_configured' && (
        <div className="ca-wa-warn"><Icon name="alert" size={12}/> WhatsApp is not configured — copy the link or
          <button className="ca-linklike" onClick={() => { window.__bwIntgPending = { provider: 'whatsapp', notice: null, ts: Date.now() }; window.dispatchEvent(new CustomEvent('bw:navigate', { detail: { tab: 'integrations' } })); window.dispatchEvent(new CustomEvent('bw:integrations-open', { detail: { provider: 'whatsapp' } })); }}>configure WhatsApp</button>.</div>)}
      {appr.whatsapp_status && appr.whatsapp_status !== 'not_configured' &&
        <div className={`ca-wa ${appr.whatsapp_status === 'sent' ? 'ok' : 'err'}`}>WhatsApp: {appr.whatsapp_status}{appr.whatsapp_error ? ' · ' + appr.whatsapp_error : ''}</div>}
      {['submitted', 'approved', 'rejected', 'changes_requested'].includes(appr.status) &&
        <div className="ca-note ok">Customer {caPill(appr.status).l.toLowerCase()} on {caFmt(appr.last_submitted_at || appr.submitted_at)}.</div>}
    </div>
  );
};

// Preview modal — the EXACT cloned customer form, rendered read-only inside a same-origin
// iframe (/customer-approval/preview). The draft snapshot is handed to it via postMessage;
// the iframe never fetches token data and cannot submit as the customer.
const CaPreviewModal = ({ snap, onClose }) => {
  const frame = useCAR(null);
  const canSend = snap.can_send !== false && (snap.missing_cost_count || 0) === 0;
  // The customer-approval page is served by the backend; resolve its origin the same way the
  // API client does (same-origin in production, a different dev port locally).
  const apiBase = ((window.localStorage && localStorage.getItem('bw_api_base')) || 'http://localhost:8000').replace(/\/$/, '');
  const apiOrigin = (() => { try { return new URL(apiBase, window.location.href).origin; } catch (e) { return window.location.origin; } })();
  const post = useCAC(() => {
    try {
      const w = frame.current && frame.current.contentWindow;
      if (w) w.postMessage({ type: 'bw-approval-preview', data: snap }, apiOrigin);  // targeted to the exact iframe origin
    } catch (e) { /* ignore */ }
  }, [snap, apiOrigin]);
  useCAE(() => {
    const t1 = setTimeout(post, 250);   // post once the iframe has mounted its listener
    const t2 = setTimeout(post, 700);   // safety re-post
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [post]);
  return (
    <div className="modal-scrim" onClick={onClose} style={{ zIndex: 420 }}>
      <div className="modal ca-preview-frame" style={{ width: 'min(96vw, 940px)', height: 'min(94vh, 1040px)' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div><div className="tdt-modal-t">Customer form preview</div>
            <div className="tdt-modal-s">Exactly what the customer will see · read-only{(snap.missing_cost_count || 0) > 0 ? ` · ${snap.missing_cost_count} missing cost` : ''}</div></div>
          <button className="modal-close" onClick={onClose}><Icon name="x" size={15}/></button>
        </div>
        <iframe ref={frame} src={`${apiBase}/customer-approval/preview`} title="Customer approval preview"
          className="ca-prev-iframe" onLoad={post}/>
        <div className="modal-foot">
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose}>Back to editor</button>
          {!canSend && <span className="ca-prev-hint"><Icon name="alert" size={13}/> Fill missing costs before sending</span>}
        </div>
      </div>
    </div>
  );
};

// ── Phase 2: version history + change diff + audit timeline ──────────────────
const CA_EVENT = {
  created: 'Draft created', previewed: 'Previewed', link_generated: 'Link issued',
  whatsapp_sent: 'WhatsApp sent', sent_whatsapp: 'WhatsApp sent',
  customer_viewed: 'Customer opened', viewed: 'Customer opened',
  customer_submitted: 'Customer submitted', submitted: 'Customer submitted',
  approved: 'Customer approved', rejected: 'Customer rejected',
  changes_requested: 'Changes requested', edit_resend_started: 'Edit & Resend started',
  version_created: 'Version created', token_superseded: 'Old link superseded',
  token_revoked: 'Link revoked', token_expired: 'Link expired', resent: 'Resent',
  item_added: 'Item added', item_removed: 'Item removed', suggestion_added: 'Suggestion accepted',
  suggestion_rejected: 'Suggestion rejected', item_undo: 'Undo', retention_expired: 'Retention expired',
  cancelled: 'Cancelled', updated: 'Details edited',
};
const caEvLabel = (t) => CA_EVENT[t] || (t || '').replace(/_/g, ' ');

const CaDiff = ({ diff }) => {
  if (!diff) return null;
  const d = diff;
  return (
    <div className="ca-diff">
      <div className="ca-diff-tot">
        <span>{caRupee(d.old_total)}</span><Icon name="route" size={12}/><span>{caRupee(d.new_total)}</span>
        <b className={d.difference >= 0 ? 'up' : 'down'}>{d.difference >= 0 ? '+' : ''}{caRupee(d.difference)}</b>
      </div>
      {(d.added || []).map((n, i) => <div key={'a' + i} className="ca-diff-row add">+ Added: {n}</div>)}
      {(d.removed || []).map((n, i) => <div key={'r' + i} className="ca-diff-row rem">− Removed: {n}</div>)}
      {(d.changed || []).map((c, i) => <div key={'c' + i} className="ca-diff-row chg">~ {c.item_name}: {(c.changes || []).join(', ')}</div>)}
    </div>
  );
};

const CaHistoryPanel = ({ hist }) => {
  if (!hist) return null;
  const versions = hist.versions || [];
  const events = (hist.events || []).slice().reverse();
  const resent = (hist.events || []).filter(e => e.event_type === 'resent' && e.meta);
  const lastDiff = resent.length ? resent[resent.length - 1].meta : null;
  return (
    <div className="card ca-history">
      <div className="card-head"><span className="eyebrow eyebrow-amber">VERSION HISTORY & TIMELINE</span></div>
      {lastDiff && <div className="ca-h-sec"><div className="ca-h-t">Latest change</div><CaDiff diff={lastDiff}/></div>}
      <div className="ca-h-sec">
        <div className="ca-h-t">Versions ({versions.length})</div>
        {versions.length === 0 && <div className="ca-empty">No versions sent yet.</div>}
        {versions.map(v => { const st = caPill(v.status); return (
          <div key={v.version_no} className="ca-ver">
            <div className="ca-ver-h"><b>V{v.version_no}</b><span className={`badge ${st.c}`}>{st.l}</span>
              <span className="ca-ver-tot">{caRupee(v.estimated_total_cost)}</span></div>
            <div className="ca-ver-m">{v.item_count} item(s) · sent {caFmt(v.sent_at)}{v.submitted_at ? ' · submitted ' + caFmt(v.submitted_at) : ''}{v.response_status ? ' · ' + v.response_status : ''}</div>
            {v.customer_remarks && <div className="ca-ver-rmk">“{v.customer_remarks}”</div>}
          </div>); })}
      </div>
      <div className="ca-h-sec">
        <div className="ca-h-t">Audit timeline</div>
        <div className="ca-tl">
          {events.map((e, i) => (
            <div key={i} className={`ca-tl-row ${e.actor_type === 'customer' ? 'cust' : (e.actor_type === 'system' ? 'sys' : 'admin')}`}>
              <span className="ca-tl-dot"/>
              <div className="ca-tl-body">
                <div className="ca-tl-h"><b>{caEvLabel(e.event_type)}</b>{e.version_no ? <span className="ca-tl-v">V{e.version_no}</span> : null}</div>
                <div className="ca-tl-m">{caFmt(e.created_at)}{e.actor_name ? ' · ' + e.actor_name : (e.actor_type === 'customer' ? ' · customer' : '')}</div>
              </div>
            </div>))}
        </div>
      </div>
    </div>
  );
};

const CA_QUICK = {
  today: () => { const d = new Date(); const s = d.toISOString().slice(0, 10); return { date_from: s, date_to: s }; },
  yesterday: () => { const d = new Date(Date.now() - 864e5); const s = d.toISOString().slice(0, 10); return { date_from: s, date_to: s }; },
  last7: () => ({ date_from: new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10), date_to: new Date().toISOString().slice(0, 10) }),
  last14: () => ({ date_from: new Date(Date.now() - 13 * 864e5).toISOString().slice(0, 10), date_to: new Date().toISOString().slice(0, 10) }),
};

// Add Suggestion modal — search the Parts Time master, auto-fill name/code/unit/minutes; the
// admin enters the cost split + notes. Cost stays backend-authoritative (we send service + labour
// only, NOT a total — the backend computes service+labour).
const CaAddSuggestionModal = ({ approvalId, initialReason, onClose, onAdd, flash }) => {
  const [reason, setReason] = useCAS(initialReason || 'mandatory');
  const [q, setQ] = useCAS('');
  const [results, setResults] = useCAS([]);
  const [searching, setSearching] = useCAS(false);
  const [sel, setSel] = useCAS(null);
  const [svc, setSvc] = useCAS('');
  const [lab, setLab] = useCAS('');
  const [qty, setQty] = useCAS(1);
  const [desc, setDesc] = useCAS('');
  const [note, setNote] = useCAS('');
  const [busy, setBusy] = useCAS(false);

  useCAE(() => {
    if (!q || q.trim().length < 2) { setResults([]); setSearching(false); return; }
    let live = true; setSearching(true);
    const t = setTimeout(async () => {
      try { const r = await BW_API.partsList(q.trim()); const arr = Array.isArray(r) ? r : (r && (r.items || r.parts)) || []; if (live) setResults(arr.slice(0, 12)); }
      catch (e) { if (live) setResults([]); }
      finally { if (live) setSearching(false); }
    }, 280);
    return () => { live = false; clearTimeout(t); };
  }, [q]);

  const total = (Number(svc) || 0) + (Number(lab) || 0);
  const canAdd = !!sel && note.trim().length > 0 && (Number(qty) || 0) > 0 && !busy;
  const pick = (p) => { setSel(p); setResults([]); setQ(p.name || p.code || ''); };

  const submit = async () => {
    if (!canAdd) return;
    setBusy(true);
    try {
      await onAdd({
        source: 'admin_suggestion', reason_type: reason,
        item_name: sel.name || sel.code, product_code: sel.code || sel.pn || null,
        quantity: Number(qty) || 1, unit_value: caNum(sel.units),
        estimated_minutes: Math.round(Number(sel.estimated_time) || 0),
        service_cost: caNum(svc), labour_cost: caNum(lab),   // NO total_cost — backend computes svc+lab
        description: desc.trim() || null, admin_note: note.trim(),
      });
      onClose();
    } catch (e) { flash('err', e.message || 'Could not add'); setBusy(false); }
  };

  return (
    <div className="modal-scrim" onClick={onClose} style={{ zIndex: 430 }}>
      <div className="modal modal-lg ca-sug-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div><div className="tdt-modal-t">Add Service Centre Suggestion</div>
            <div className="tdt-modal-s">Pick a part from Parts Time, then explain why it's needed.</div></div>
          <button className="modal-close" onClick={onClose}><Icon name="x" size={15}/></button>
        </div>
        <div className="ca-sug-body">
          <div className="ca-sug-seg">
            <button className={`ca-seg ${reason === 'mandatory' ? 'on md' : ''}`} onClick={() => setReason('mandatory')}>Mandatory part</button>
            <button className={`ca-seg ${reason === 'suggested' ? 'on sg' : ''}`} onClick={() => setReason('suggested')}>Suggested part</button>
          </div>

          <label className="ca-sug-l">Search Parts Time (code or name)</label>
          <div className="ca-sug-search"><Icon name="gauge" size={13}/>
            <input autoFocus value={q} onChange={(e) => { setQ(e.target.value); setSel(null); }} placeholder="e.g. chain sprocket or 36TA0161…"/>
            {searching && <span className="ca-sug-spin">…</span>}
          </div>
          {results.length > 0 && !sel && (
            <div className="ca-sug-results">
              {results.map(p => (
                <button key={p.id} className="ca-sug-res" onClick={() => pick(p)}>
                  <div className="nm">{p.name || '—'}</div>
                  <div className="mt">{(p.code || p.pn || '—')}{p.units != null ? ' · UV ' + p.units : ''}{p.estimated_time ? ' · ' + caMins(p.estimated_time) : ''}{p.model ? ' · ' + p.model : ''}</div>
                </button>))}
            </div>)}
          {q.trim().length >= 2 && !searching && results.length === 0 && !sel && (
            <div className="ca-sug-empty">No parts match “{q.trim()}”. Check the code/name or import the parts file in Parts Time.</div>)}

          {sel && (
            <div className="ca-sug-picked">
              <div className="pk-top"><b>{sel.name}</b><button className="ca-linklike" onClick={() => { setSel(null); setQ(''); }}>change</button></div>
              <div className="pk-meta">{(sel.code || sel.pn || '—')}{sel.units != null ? ' · UV ' + sel.units : ''}{sel.estimated_time ? ' · ' + caMins(sel.estimated_time) : ''}</div>
              <div className="ca-sug-grid">
                <div><label>Service cost ₹</label><input type="number" min="0" value={svc} onChange={(e) => setSvc(e.target.value)} placeholder="0"/></div>
                <div><label>Labour cost ₹</label><input type="number" min="0" value={lab} onChange={(e) => setLab(e.target.value)} placeholder="0"/></div>
                <div><label>Quantity</label><input type="number" min="1" value={qty} onChange={(e) => setQty(e.target.value)}/></div>
                <div><label>Total (auto)</label><input value={caRupee(total)} readOnly className="ca-ro"/></div>
              </div>
              <label className="ca-sug-l">Customer note · why it's needed <span className="req">*</span></label>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Shown to the customer — e.g. ‘Brake pads worn below safe limit; replacement recommended before delivery.’"/>
              <label className="ca-sug-l">Admin reason (internal, optional)</label>
              <textarea value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Internal note for the service team (not shown to the customer)."/>
            </div>)}
        </div>
        <div className="modal-foot">
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose}>Cancel</button>
          <button className="btn btn-amber" style={{ flex: 1 }} disabled={!canAdd} title={!sel ? 'Select a part first' : (!note.trim() ? 'Add a customer note' : '')} onClick={submit}>{busy ? 'Adding…' : 'Add to approval'}</button>
        </div>
      </div>
    </div>
  );
};

// Service-centre suggestions, split into Mandatory + Suggested groups (cards + Add → modal).
const CaSuggestGroup = ({ title, hint, tick, items, locked, onAdd, onEdit, onDelete }) => (
  <div className="ca-suggrp">
    <div className="ca-suggrp-h"><span className={`tick ${tick}`}/><span className="ttl">{title}</span>
      {!locked && <button className="btn btn-sm btn-ghost" onClick={onAdd}><Icon name="plus" size={12}/> Add</button>}</div>
    {hint && <div className="ca-suggrp-hint">{hint}</div>}
    {items.length === 0 && <div className="ca-empty">None added.</div>}
    {items.map(it => <CaItemRow key={it.id} it={it} locked={locked} onEdit={onEdit} onDelete={onDelete}/>)}
  </div>
);

const LiveCustomerApprovals = () => {
  const [list, setList] = useCAS([]);
  const [sel, setSel] = useCAS(null);          // selected approval detail
  const [hist, setHist] = useCAS(null);        // version history + audit timeline
  const [rawUrl, setRawUrl] = useCAS('');      // in-memory raw link for the selected approval
  const [q, setQ] = useCAS('');
  const [chip, setChip] = useCAS('All');
  const [dateFrom, setDateFrom] = useCAS('');
  const [dateTo, setDateTo] = useCAS('');
  const [quick, setQuick] = useCAS('');
  const [incExpired, setIncExpired] = useCAS(false);
  const [toast, setToast] = useCAS(null);
  const [pv, setPv] = useCAS(null);            // preview snapshot (customer-form layout)
  const [sug, setSug] = useCAS(null);          // add-suggestion modal: { reason } or null
  const [busy, setBusy] = useCAS('');
  const flash = (kind, text) => { setToast({ kind, text }); setTimeout(() => setToast(null), 3500); };

  const loadList = useCAC(async () => {
    try {
      setList(await BW_API.approvalsList(chip === 'All' ? null : chip.toLowerCase(), q || null,
        { date_from: dateFrom || null, date_to: dateTo || null, include_expired: incExpired, include_deleted: incExpired }) || []);
    } catch (e) { flash('err', e.message || 'Failed to load'); }
  }, [chip, q, dateFrom, dateTo, incExpired]);
  const loadHist = useCAC(async (id) => {
    try { setHist(await BW_API.approvalHistory(id)); } catch (e) { setHist(null); }
  }, []);
  const openDetail = useCAC(async (id, keepUrl) => {
    try { const d = await BW_API.approvalGet(id); setSel(d); loadHist(id); if (!keepUrl) setRawUrl(''); }
    catch (e) { flash('err', e.message || 'Failed to open'); }
  }, [loadHist]);

  useCAE(() => { loadList(); }, [loadList]);
  // Realtime list refresh: the WS pushes a lightweight {id,status,v} branch signature; reload the
  // (server-filtered) list only when it actually changes. A ref keeps the latest filtered loader
  // without resubscribing the socket on every filter keystroke. Layout/logic untouched.
  const _loadRef = React.useRef(loadList); _loadRef.current = loadList;
  const _apprSig = React.useRef('');
  useBWSocket('/approvals', (snap) => {
    const sig = Array.isArray(snap) ? snap.map(r => `${r.id}:${r.status}:${r.v}`).join('|') : '';
    if (sig !== _apprSig.current) { _apprSig.current = sig; _loadRef.current(); }
  });
  // deep-link from the queue's "Send to Customer Approval"
  useCAE(() => {
    const pend = window.__bwApprovalOpen;
    if (pend && pend.id && (Date.now() - (pend.ts || 0) < 6000)) { openDetail(pend.id); }
    window.__bwApprovalOpen = null;
    const h = (e) => { if (e.detail && e.detail.id) { openDetail(e.detail.id); loadList(); } };
    window.addEventListener('bw:approvals-open', h);
    return () => window.removeEventListener('bw:approvals-open', h);
  }, [openDetail, loadList]);

  const applyQuick = (k) => { setQuick(k); const r = CA_QUICK[k] ? CA_QUICK[k]() : { date_from: '', date_to: '' }; setDateFrom(r.date_from); setDateTo(r.date_to); };
  const clearDates = () => { setQuick(''); setDateFrom(''); setDateTo(''); };
  const refreshAll = () => { loadList(); if (sel) { openDetail(sel.id, true); } };
  const after = (d, msg) => { if (d) setSel(d); loadList(); if (sel) loadHist(sel.id); if (msg) flash('ok', msg); };

  const itemEdit = async (itemId, body) => { try { after(await BW_API.approvalEditItem(sel.id, itemId, body)); } catch (e) { flash('err', e.message); } };
  const itemDel = async (itemId) => { try { after(await BW_API.approvalDeleteItem(sel.id, itemId)); } catch (e) { flash('err', e.message); } };
  const itemAdd = async (body) => { try { after(await BW_API.approvalAddItem(sel.id, body), 'Item added'); } catch (e) { flash('err', e.message); } };

  const doPreview = async () => {
    try { const snap = await BW_API.approvalPreview(sel.id); setPv(snap); await openDetail(sel.id, true); }
    catch (e) { flash('err', e.message || 'Preview failed'); }
  };

  const runBusy = async (kind, fn) => { setBusy(kind); try { await fn(); } catch (e) { flash('err', e.message || 'Failed'); } finally { setBusy(''); } };

  const linkAction = async (kind) => {
    if (kind === 'generate') {
      const d = await BW_API.approvalGenerateLink(sel.id);
      setRawUrl(d.approval_url || ''); setSel(d); loadList(); loadHist(sel.id); flash('ok', 'Link generated');
    } else if (kind === 'resend') {
      const d = await BW_API.approvalResend(sel.id);
      setRawUrl(d.approval_url || ''); setSel(d); loadList(); loadHist(sel.id); flash('ok', `Resent as version ${d.current_version_no}`);
    } else if (kind === 'edit-resend') {
      const d = await BW_API.approvalEditResendStart(sel.id);
      setSel(d); setRawUrl(''); loadHist(sel.id); flash('ok', 'Editing — make changes, preview, then resend');
    } else if (kind === 'revoke') {
      const d = await BW_API.approvalRevokeLink(sel.id);
      setSel(d); setRawUrl(''); loadList(); loadHist(sel.id); flash('ok', 'Link revoked');
    } else if (kind === 'whatsapp') {
      const token = (rawUrl || '').split('/').pop();
      const r = await BW_API.approvalSendWhatsapp(sel.id, token);
      await openDetail(sel.id, true);
      flash(r && r.whatsapp && r.whatsapp.ok ? 'ok' : 'err',
        (r && r.whatsapp && r.whatsapp.message) || 'WhatsApp');
    } else if (kind === 'cancel') {
      after(await BW_API.approvalCancel(sel.id), 'Approval cancelled'); setRawUrl('');
    }
  };

  const doCleanup = () => runBusy('cleanup', async () => {
    const r = await BW_API.approvalCleanup(); loadList();
    flash('ok', `Cleanup done — ${r.expired_links} link(s), ${r.expired_requests} record(s) expired`);
  });

  const suggestAdd = async (body) => { const d = await BW_API.approvalAddItem(sel.id, body); after(d, 'Suggestion added'); };

  const filtered = list;  // server already filtered
  const t = (sel && sel.totals) || {};
  const items = (sel && sel.items) || [];
  const originals = items.filter(i => i.source === 'original');
  const suggestions = items.filter(i => i.source === 'admin_suggestion');
  const mandatory = suggestions.filter(i => i.reason_type === 'mandatory');
  const suggested = suggestions.filter(i => i.reason_type !== 'mandatory');
  const TERMINAL = ['submitted', 'approved', 'rejected', 'changes_requested', 'cancelled', 'expired'];
  const isTerminal = sel && TERMINAL.includes(sel.status);
  const editing = !!(sel && sel.editing);
  const hasActiveLink = !!(sel && sel.active_link && ['active', 'viewed'].includes(sel.active_link.status));
  // builder editable only in a fresh draft or an Edit & Resend session
  const builderLocked = !(sel && (sel.status === 'draft' || editing));
  const linkLocked = isTerminal && !editing;

  return (
    <>
      <div className="content-head">
        <div><div className="eyebrow eyebrow-amber">● CUSTOMER APPROVALS</div><h1>Customer Estimate Approval</h1>
          <span className="sub">Review extracted parts, add service suggestions, generate a temporary customer approval link, and track the response.</span></div>
        <button className="btn btn-ghost btn-sm" onClick={refreshAll}><Icon name="route" size={13}/> Refresh</button>
      </div>

      <div className="ca-layout">
        <div className="ca-list card">
          <div className="ca-search"><Icon name="gauge" size={13}/><input placeholder="Search customer, vehicle, JC…" value={q} onChange={(e) => setQ(e.target.value)}/></div>
          <div className="ca-chips">{['All', 'Draft', 'Sent', 'Viewed', 'Submitted', 'Approved', 'Rejected', 'Changes_requested', 'Cancelled', 'Expired'].map(c =>
            <button key={c} className={`ca-chip ${chip === c ? 'active' : ''}`} onClick={() => setChip(c)}>{c.replace('_', ' ')}</button>)}</div>
          <div className="ca-quick">{[['today', 'Today'], ['yesterday', 'Yesterday'], ['last7', 'Last 7d'], ['last14', 'Last 14d']].map(([k, l]) =>
            <button key={k} className={`ca-qchip ${quick === k ? 'active' : ''}`} onClick={() => applyQuick(k)}>{l}</button>)}
            {(dateFrom || dateTo || quick) && <button className="ca-qchip" onClick={clearDates}>✕ Clear</button>}</div>
          <div className="ca-daterow">
            <input type="date" className="ca-date" value={dateFrom} onChange={(e) => { setQuick(''); setDateFrom(e.target.value); }} title="From date"/>
            <span>→</span>
            <input type="date" className="ca-date" value={dateTo} onChange={(e) => { setQuick(''); setDateTo(e.target.value); }} title="To date"/>
          </div>
          <div className="ca-listfoot">
            <label className="ca-inc"><input type="checkbox" checked={incExpired} onChange={(e) => setIncExpired(e.target.checked)}/> Include expired/deleted</label>
            <button className="btn btn-ghost btn-xs" disabled={busy === 'cleanup'} title="Soft-expire approval records older than 14 days" onClick={doCleanup}>Cleanup 14d</button>
          </div>
          <div className="ca-rows">
            {filtered.length === 0 && <div className="ca-empty">No approvals. Use “Send to Customer Approval” on a queued job.</div>}
            {filtered.map(r => { const st = caPill(r.status); return (
              <button key={r.id} className={`ca-litem ${sel && sel.id === r.id ? 'active' : ''} ${r.deleted_at ? 'dimmed' : ''}`} onClick={() => openDetail(r.id)}>
                <div className="ca-litop"><span className="ca-lic">{r.customer_name || '—'}</span><span className={`badge ${st.c}`}>{st.l}</span></div>
                <div className="ca-limeta">{r.job_card_number || '—'} · {r.vehicle_number || '—'}{(r.current_version_no > 1 || r.version_count > 1) ? ' · v' + r.current_version_no : ''}</div>
                <div className="ca-limeta">{caFmt(r.created_at)} · {caRupee((r.totals || {}).approved_cost)} · {r.id}</div>
              </button>); })}
          </div>
        </div>

        <div className="ca-detail">
          {!sel ? (
            <div className="card ca-placeholder"><Icon name="check" size={26}/><h3>Select an approval</h3>
              <p>Open one from the list, or click <b>Send to Customer Approval</b> on a queued job to create one.</p></div>
          ) : (
            <>
              <div className="card ca-cust">
                <div className="card-head"><span className="eyebrow eyebrow-amber">● {sel.id}</span>
                  <span className={`badge ${caPill(sel.status).c}`}>{caPill(sel.status).l}</span></div>
                <div className="ca-cgrid">
                  <div className="ca-kv"><div className="k">Customer</div><div className="v">{sel.customer_name || '—'}</div></div>
                  <div className="ca-kv"><div className="k">Mobile</div><div className="v">{sel.customer_mobile || '—'}</div></div>
                  <div className="ca-kv"><div className="k">Vehicle</div><div className="v">{sel.vehicle_number || '—'}{sel.vehicle_model ? ' · ' + sel.vehicle_model : ''}</div></div>
                  <div className="ca-kv"><div className="k">Job Card</div><div className="v">{sel.job_card_number || '—'}</div></div>
                  <div className="ca-kv"><div className="k">Service</div><div className="v">{sel.service_type || '—'}</div></div>
                  <div className="ca-kv"><div className="k">Showroom</div><div className="v">{(sel.showroom && sel.showroom.name) || '—'}</div></div>
                </div>
                {sel.complaint && <div className="ca-complaint">“{sel.complaint}”</div>}
                {sel.customer_note && <div className="ca-cnote"><b>Customer note:</b> {sel.customer_note}</div>}
              </div>

              {editing && (
                <div className="ca-edit-banner"><Icon name="route" size={13}/> <b>Edit & Resend (v{(sel.current_version_no || 1) + 1})</b> — change parts/costs, preview again, then Resend. The customer's current link stays valid until you resend.</div>)}

              <CaItemsTable title="ORIGINAL EXTRACTED ITEMS" items={originals} source="original" locked={builderLocked}
                onEdit={itemEdit} onDelete={itemDel} onAdd={itemAdd}/>

              <div className="card ca-itable ca-sugcard">
                <div className="card-head"><span className="eyebrow eyebrow-amber">SERVICE CENTRE SUGGESTIONS</span></div>
                <CaSuggestGroup title="Mandatory changes" tick="md" items={mandatory} locked={builderLocked}
                  hint="Required for a safe, complete service."
                  onAdd={() => setSug({ reason: 'mandatory' })} onEdit={itemEdit} onDelete={itemDel}/>
                <CaSuggestGroup title="Suggested upgrades" tick="sg" items={suggested} locked={builderLocked}
                  hint="Optional improvements our team recommends."
                  onAdd={() => setSug({ reason: 'suggested' })} onEdit={itemEdit} onDelete={itemDel}/>
              </div>

              <div className="card ca-totals">
                <div className="ca-trow"><span>Service cost total</span><b>{caRupee(t.service_cost_total)}</b></div>
                <div className="ca-trow"><span>Labour cost total</span><b>{caRupee(t.labour_cost_total)}</b></div>
                <div className="ca-trow final"><span>Final estimated cost{['submitted', 'approved', 'rejected', 'changes_requested'].includes(sel.status) ? ' (customer)' : ''}</span><b>{caRupee(t.final_estimated_cost != null ? t.final_estimated_cost : t.approved_cost)}</b></div>
                {sel.customer_response_status && <div className="ca-trow resp"><span>Customer response</span><b className={`ca-rs ${sel.customer_response_status}`}>{caPill(sel.customer_response_status).l}</b></div>}
              </div>

              {/* ── Consolidated action zone: validation → preview → send/resend/revoke ── */}
              {(sel.status === 'draft' || editing || !linkLocked) && (() => {
                const blocked = !sel.preview_confirmed || (sel.missing_cost_count || 0) > 0;
                const why = (sel.missing_cost_count || 0) > 0 ? 'Fill missing part costs first' : (!sel.preview_confirmed ? 'Preview the form before sending' : '');
                return (
                  <div className="card ca-actions">
                    {!builderLocked && sel.missing_cost_count > 0 && (
                      <div className="ca-missing-warn"><Icon name="alert" size={14}/> {sel.missing_cost_count} part(s) missing cost. Fill costs before sending to the customer.</div>)}
                    <div className="ca-actrow">
                      {(sel.status === 'draft' || editing) && (
                        <button className="btn btn-amber" onClick={doPreview}><Icon name="check" size={14}/> Preview customer form</button>)}
                      {sel.status === 'draft' && !hasActiveLink && (
                        <button className="btn btn-amber" disabled={busy === 'generate' || blocked} title={why} onClick={() => runBusy('generate', () => linkAction('generate'))}><Icon name="route" size={14}/> Generate link &amp; send</button>)}
                      {editing && (
                        <button className="btn btn-amber" disabled={busy === 'resend' || blocked} title={(sel.missing_cost_count || 0) > 0 ? 'Fill missing part costs first' : (!sel.preview_confirmed ? 'Preview the updated form before resending' : '')} onClick={() => runBusy('resend', () => linkAction('resend'))}><Icon name="route" size={14}/> Resend as v{(sel.current_version_no || 1) + 1}</button>)}
                      {!editing && sel.status !== 'draft' && sel.status !== 'cancelled' && (
                        <button className="btn btn-ghost" disabled={busy === 'edit-resend'} onClick={() => runBusy('edit-resend', () => linkAction('edit-resend'))}><Icon name="route" size={14}/> Edit &amp; Resend</button>)}
                      {hasActiveLink && !editing && (
                        <button className="btn btn-ghost ca-del" disabled={busy === 'revoke'} title="Kill the current customer link" onClick={() => runBusy('revoke', () => linkAction('revoke'))}>Revoke link</button>)}
                    </div>
                    {(sel.status === 'draft' || editing) && (
                      <div className="ca-actnote">{sel.preview_confirmed
                        ? <span className="ca-prev-ok"><Icon name="check" size={12}/> Previewed{sel.previewed_at ? ' · ' + caFmt(sel.previewed_at) : ''} — ready to send</span>
                        : <span className="ca-prev-need">Preview the customer form once before you can send</span>}</div>)}
                  </div>);
              })()}

              <CaLinkPanel appr={sel} rawUrl={rawUrl} onAction={linkAction} flash={flash} locked={linkLocked}/>

              <CaHistoryPanel hist={hist}/>
            </>
          )}
        </div>
      </div>
      {pv && <CaPreviewModal snap={pv} onClose={() => setPv(null)}/>}
      {sug && sel && <CaAddSuggestionModal approvalId={sel.id} initialReason={sug.reason} flash={flash}
        onAdd={suggestAdd} onClose={() => setSug(null)}/>}
      {toast && <div className={`lbd-toast ${toast.kind === 'err' ? 'err' : ''}`}>{toast.text}</div>}
    </>
  );
};

window.LiveCustomerApprovals = LiveCustomerApprovals;

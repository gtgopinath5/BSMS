// ============================================================
// Parts Time — Full redesign with File Management
// Imported Files → cascade delete → Parts Master
// ============================================================
const { useState:useTS, useEffect:useTE, useMemo:useTM, useRef:useTR, useCallback:useTC } = React;

const PAGE = 12;
const PT_COLS = '96px 100px minmax(160px,1.6fr) 60px 68px 72px minmax(120px,1fr) 78px 78px 64px';
const fmtDate = iso => { try{ return new Date(iso).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'2-digit',hour:'2-digit',minute:'2-digit'}); }catch(e){return '—';} };
const fmtDateShort = iso => { try{ return new Date(iso).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'2-digit'}); }catch(e){return '—';} };
const sleep = ms => new Promise(r=>setTimeout(r,ms));

// ── Extraction pipeline using SheetJS ──────────────────────
async function extractFile(file){
  const isPdf = /\.pdf$/i.test(file.name) || file.type==='application/pdf';
  const isXls = /\.xlsx?$/i.test(file.name) || file.type.includes('sheet') || file.type.includes('excel');
  if(isXls){
    if(!window.XLSX) throw new Error('SheetJS library not loaded. Please refresh the page.');
    const rows = await window.readXlsx(file);
    if(!rows.length) throw new Error('No part rows found. Ensure the file has columns: Material, Description, Labour Units.');
    return rows;
  }
  if(isPdf){
    if(!window.pdfjsLib) throw new Error('PDF.js not loaded. Please refresh the page.');
    const buf = await file.arrayBuffer();
    const pdf = await window.pdfjsLib.getDocument({data:buf}).promise;
    let text='';
    for(let i=1;i<=Math.min(pdf.numPages,30);i++){
      const pg=await pdf.getPage(i); const tc=await pg.getTextContent();
      text+='\n'+tc.items.map(t=>t.str).join(' ');
    }
    const re=/([A-Z0-9]{6,10})\s+([A-Z][A-Za-z0-9 .,\-\/()]{3,50}?)\s+(\d+(?:\.\d+)?)(?=\s|$)/g;
    const rows=[]; let m;
    while((m=re.exec(text))) rows.push({pn:m[1],name:m[2].trim(),units:parseFloat(m[3])||1});
    if(!rows.length) throw new Error('Could not extract part rows from PDF. Try an Excel file instead.');
    return rows;
  }
  throw new Error('Unsupported file type. Please upload .xlsx, .xls, or .pdf');
}

// ── Unit Config bar ────────────────────────────────────────
const UnitConfig = ({mpu, partsCount, onChange}) => {
  const [custom,setCustom] = useTS('');
  const [pending,setPending] = useTS(null); // staged new value awaiting confirm
  const stage = (v) => { if(v>0 && v!==mpu) setPending(v); };
  const confirm = () => { onChange(pending); setPending(null); setCustom(''); };
  return (
    <div className="pt-config">
      <div className="pt-config-l">
        <div className="sc-ico" style={{background:'var(--amber-soft)',border:'1px solid rgba(255,107,26,0.3)',color:'var(--amber)'}}><Icon name="cog" size={16}/></div>
        <div>
          <div className="sc-title">Unit-Time Conversion</div>
          <div className="sc-sub">Estimated time = unit value × minutes/unit · change requires confirmation</div>
        </div>
      </div>
      <div className="pt-config-r">
        <span className="pt-eq">1 UNIT =</span>
        <div className="pt-presets">
          {[10,15,20].map(v=>(
            <button key={v} className={`pt-preset ${mpu===v?'active':''}`} onClick={()=>stage(v)}>{v} min</button>
          ))}
          <div className="pt-custom">
            <input type="number" min="1" placeholder="custom" value={custom} onChange={e=>setCustom(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')stage(+custom);}}/>
            <button className="btn btn-sm btn-ghost" disabled={!(+custom>0)} onClick={()=>stage(+custom)}>SET</button>
          </div>
        </div>
        <div className="pt-current"><span className="dot amber pulsing"/>{mpu} MIN / UNIT · LIVE</div>
      </div>

      {pending && (
        <div className="modal-scrim" onClick={()=>setPending(null)} style={{zIndex:300}}>
          <div className="modal" style={{width:480}} onClick={e=>e.stopPropagation()}>
            <div className="modal-head">
              <span className="eyebrow eyebrow-amber">CONFIRM UNIT TIME CONVERSION UPDATE</span>
              <button className="modal-close" onClick={()=>setPending(null)}><Icon name="x" size={15}/></button>
            </div>
            <div style={{padding:'18px 20px'}}>
              <div style={{display:'flex',gap:14,alignItems:'flex-start',marginBottom:16}}>
                <div style={{width:46,height:46,flexShrink:0,borderRadius:12,background:'var(--amber-soft)',border:'1px solid rgba(255,107,26,0.3)',color:'var(--amber)',display:'grid',placeItems:'center'}}><Icon name="cog" size={20}/></div>
                <div style={{fontSize:13,color:'var(--t-2)',lineHeight:1.6}}>
                  Changing the Unit Time Conversion will recalculate estimated times for <b style={{color:'var(--t-0)'}}>all {partsCount} parts</b> and affect <b style={{color:'var(--t-0)'}}>future</b> Work Assignments, Bay Timers, and job estimations. Do you want to continue?
                </div>
              </div>
              <div className="pt-conv-compare">
                <div className="cc-box"><div className="cc-l">CURRENT</div><div className="cc-v">1 unit = {mpu} min</div></div>
                <Icon name="arrow-right" size={18} style={{color:'var(--t-3)'}}/>
                <div className="cc-box new"><div className="cc-l">NEW</div><div className="cc-v">1 unit = {pending} min</div></div>
              </div>
              <div className="pt-policy">
                <Icon name="shield" size={13}/>
                <span>Already-created Work Assignments keep their original estimate — historical reports &amp; completed jobs won't change.</span>
              </div>
            </div>
            <div style={{padding:'0 20px 20px',display:'flex',gap:10}}>
              <button className="btn btn-ghost" style={{flex:1}} onClick={()=>setPending(null)}>CANCEL</button>
              <button className="btn btn-amber" style={{flex:2}} onClick={confirm}><Icon name="check" size={15}/> CONFIRM UPDATE</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ── File type icon ─────────────────────────────────────────
const FileTypeIcon = ({type}) => (
  <div className={`file-type-ico ${type}`}>
    {type==='excel' ? <Icon name="tools" size={16}/> : <Icon name="file" size={16}/>}
  </div>
);

// ── File Card ──────────────────────────────────────────────
const FileCard = ({file, onPreview, onReplace, onDelete, partsCount, codesCount}) => {
  const isActive = file.status==='active';
  return (
    <div className={`file-card ${!isActive?'replaced':''}`}>
      <div className="file-card-top">
        <FileTypeIcon type={file.type}/>
        <div className="file-card-info">
          <div className="file-card-name" title={file.name}>{file.name}</div>
          <div className="file-card-meta">{file.sizeStr} · v{file.version} · by {file.uploadedBy}</div>
        </div>
        {!isActive && <span className="chip warn" style={{flexShrink:0,height:20,fontSize:9}}>REPLACED</span>}
      </div>
      <div className="file-card-stats">
        <div className="fcs"><div className="v">{partsCount}</div><div className="l">Parts</div></div>
        <div className="fcs"><div className="v">{codesCount}</div><div className="l">Codes</div></div>
        <div className="fcs"><div className="v">{file.dupSkipped||0}</div><div className="l">Skipped</div></div>
      </div>
      <div className="file-card-date">
        <Icon name="calendar" size={11}/> {fmtDate(file.uploadDate)} · <span className={`file-status ${isActive?'ok':'warn'}`}>{isActive?'EXTRACTED':'REPLACED'}</span>
      </div>
      <div className="file-card-actions">
        <button className="fc-btn preview" onClick={()=>onPreview(file)}><Icon name="gauge" size={12}/> Preview</button>
        <button className="fc-btn update" onClick={()=>onReplace(file)}><Icon name="edit" size={12}/> Update</button>
        <button className="fc-btn delete" onClick={()=>onDelete(file)}><Icon name="x" size={12}/> Delete</button>
      </div>
    </div>
  );
};

// ── Delete Confirm modal ───────────────────────────────────
const DeleteConfirmModal = ({file, partsCount, dep, onConfirm, onClose}) => {
  const [force,setForce] = useTS(false);
  const canProceed = !dep.hasActive || force;
  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" style={{width:500}} onClick={e=>e.stopPropagation()}>
        <div className="modal-head">
          <span className="eyebrow" style={{color:'var(--danger)'}}>DELETE FILE · CASCADE</span>
          <button className="modal-close" onClick={onClose}><Icon name="x" size={15}/></button>
        </div>
        <div style={{padding:'18px 20px'}}>
          <div style={{display:'flex',gap:14,alignItems:'flex-start',marginBottom:18}}>
            <div style={{width:48,height:48,flexShrink:0,borderRadius:12,background:'rgba(244,63,94,0.12)',color:'var(--danger)',display:'grid',placeItems:'center'}}><Icon name="alert" size={22}/></div>
            <div>
              <div style={{fontWeight:600,fontSize:15,marginBottom:6}}>Delete permanently?</div>
              <div style={{color:'var(--t-2)',fontSize:13,lineHeight:1.6}}>
                Deleting <b style={{color:'var(--t-0)'}}>{file.name}</b> will permanently remove the file record and <b style={{color:'var(--danger)'}}>{partsCount} extracted part{partsCount!==1?'s':''}</b> from the database. This action <b>cannot be undone</b>.
              </div>
            </div>
          </div>

          <div style={{background:'var(--bg-2)',border:'1px solid var(--hair)',borderRadius:10,padding:'12px 14px',marginBottom:dep.hasActive?14:0}}>
            <div className="row" style={{gap:10,marginBottom:8}}>
              <span style={{width:6,height:6,borderRadius:'50%',background:'var(--danger)',flexShrink:0}}/>
              <span style={{fontSize:12,fontWeight:600}}>Delete file record</span>
            </div>
            <div className="row" style={{gap:10,marginBottom:8}}>
              <span style={{width:6,height:6,borderRadius:'50%',background:'var(--danger)',flexShrink:0}}/>
              <span style={{fontSize:12}}>{partsCount} parts cascade-removed from Parts Time DB</span>
            </div>
            <div className="row" style={{gap:10,marginBottom:8}}>
              <span style={{width:6,height:6,borderRadius:'50%',background:'var(--danger)',flexShrink:0}}/>
              <span style={{fontSize:12}}>Estimated time calculations removed</span>
            </div>
            <div className="row" style={{gap:10}}>
              <span style={{width:6,height:6,borderRadius:'50%',background:'var(--danger)',flexShrink:0}}/>
              <span style={{fontSize:12}}>Parts table refreshes automatically</span>
            </div>
          </div>

          {dep.hasActive && (
            <div style={{background:'rgba(251,191,36,0.08)',border:'1px solid rgba(251,191,36,0.35)',borderRadius:10,padding:'12px 14px',marginBottom:14}}>
              <div className="row" style={{gap:8,marginBottom:6}}>
                <Icon name="alert" size={14} style={{color:'var(--warn)'}}/>
                <span style={{fontWeight:600,fontSize:13,color:'var(--warn)'}}>Active Dependency Warning</span>
              </div>
              <div style={{fontSize:13,color:'var(--t-2)',lineHeight:1.5}}>
                <b>{dep.count}</b> part{dep.count!==1?'s':''} from this file {dep.count===1?'is':'are'} currently referenced by active work assignments. Deleting may affect estimated time calculations.
              </div>
              <label className="row" style={{gap:8,marginTop:10,cursor:'pointer'}}>
                <input type="checkbox" checked={force} onChange={e=>setForce(e.target.checked)}/>
                <span className="mono" style={{fontSize:11,color:'var(--warn)',letterSpacing:'0.06em'}}>FORCE DELETE · ADMIN PERMISSION</span>
              </label>
            </div>
          )}
        </div>
        <div style={{padding:'0 20px 20px',display:'flex',gap:10}}>
          <button className="btn btn-ghost" style={{flex:1}} onClick={onClose}>CANCEL</button>
          <button
            className="btn" disabled={!canProceed}
            style={{flex:2,background:'var(--danger)',color:'#fff',border:'1px solid var(--danger)',opacity:canProceed?1:0.4,boxShadow:canProceed?'0 0 20px -6px rgba(244,63,94,0.5)':'none'}}
            onClick={onConfirm}>
            <Icon name="x" size={15}/> DELETE PERMANENTLY
          </button>
        </div>
      </div>
    </div>
  );
};

// ── Audit drawer ───────────────────────────────────────────
const AuditDrawer = ({logs,onClose}) => (
  <div className="modal-scrim" onClick={onClose} style={{placeItems:'stretch end'}}>
    <div className="audit-drawer" onClick={e=>e.stopPropagation()}>
      <div className="modal-head">
        <span className="eyebrow eyebrow-amber">AUDIT LOG · PARTS TIME</span>
        <button className="modal-close" onClick={onClose}><Icon name="x" size={15}/></button>
      </div>
      <div className="audit-list">
        {logs.map((l,i)=>(
          <div key={i} className="audit-item">
            <span className={`audit-tag ${l.action.toLowerCase().replace(/[^a-z]/g,'_')}`}>{l.action}</span>
            <div><div className="audit-detail">{l.detail}</div><span className="audit-ts">{new Date(l.ts).toLocaleString('en-IN')} · {l.user}</span></div>
          </div>
        ))}
        {!logs.length && <div className="wc-empty"><div className="t">No logs yet</div></div>}
      </div>
    </div>
  </div>
);

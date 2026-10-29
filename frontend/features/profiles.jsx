// ============================================================
// Profiles — photo store, avatar, upload, profile pages
// ============================================================
const { useState: usePfS, useEffect: usePfE, useRef: usePfR } = React;

// ── Photo store (localStorage, data-URL thumbnails) ─────────
const ProfileStore = (() => {
  const K = 'bw_photos_v1';
  let subs = [];
  const rd = () => { try { return JSON.parse(localStorage.getItem(K))||{}; } catch(e){ return {}; } };
  const wr = (v) => localStorage.setItem(K, JSON.stringify(v));
  const emit = () => subs.forEach(f=>f());
  return {
    subscribe(fn){ subs.push(fn); return ()=>{ subs=subs.filter(x=>x!==fn); }; },
    all(){ return rd(); },
    get(id){ return rd()[id]||null; },
    set(id, dataUrl){ const m=rd(); m[id]=dataUrl; wr(m); emit(); },
    remove(id){ const m=rd(); delete m[id]; wr(m); emit(); },
  };
})();
window.ProfileStore = ProfileStore;

function useProfiles(){
  const [,force] = usePfS(0);
  usePfE(()=>ProfileStore.subscribe(()=>force(n=>n+1)),[]);
  return ProfileStore;
}
window.useProfiles = useProfiles;

// Compress an image File → square thumbnail data URL
async function fileToThumb(file, size=256){
  return new Promise((resolve,reject)=>{
    if(!/image\/(jpe?g|png|webp)/i.test(file.type)) { reject(new Error('Only JPG, PNG, or WEBP allowed')); return; }
    if(file.size > 8*1024*1024){ reject(new Error('Image must be under 8 MB')); return; }
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const s = Math.min(img.width, img.height);
      const sx = (img.width - s)/2, sy = (img.height - s)/2; // center crop
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, sx, sy, s, s, 0, 0, size, size);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read image')); };
    img.src = url;
  });
}
window.fileToThumb = fileToThumb;

// ── Avatar — photo or initials fallback ─────────────────────
const Avatar = ({ id, initials, size=36, ring='amber', className='', onClick }) => {
  useProfiles();
  const photo = id ? ProfileStore.get(id) : null;
  const px = size + 'px';
  const style = { width:px, height:px, borderRadius: Math.round(size*0.26)+'px', fontSize: Math.round(size*0.34)+'px' };
  return (
    <div className={`avatar2 ring-${ring} ${className} ${onClick?'clickable':''}`} style={style} onClick={onClick}>
      {photo ? <img src={photo} alt="" draggable="false"/> : <span>{initials}</span>}
    </div>
  );
};
window.Avatar = Avatar;

// ── Avatar uploader (camera / gallery / drag-drop) ──────────
const AvatarUpload = ({ id, initials, canEdit=true, onChange }) => {
  useProfiles();
  const photo = id ? ProfileStore.get(id) : null;
  const [busy,setBusy] = usePfS(false);
  const [err,setErr] = usePfS('');
  const galleryRef = usePfR(null);
  const cameraRef = usePfR(null);

  const handle = async (file) => {
    if(!file) return;
    setErr(''); setBusy(true);
    try {
      const thumb = await fileToThumb(file);
      ProfileStore.set(id, thumb);
      onChange && onChange(thumb);
    } catch(e){ setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="avatar-upload">
      <div className={`avatar-drop ${!canEdit?'locked':''}`}
        onDragOver={e=>{if(canEdit){e.preventDefault();e.currentTarget.classList.add('over');}}}
        onDragLeave={e=>e.currentTarget.classList.remove('over')}
        onDrop={e=>{e.preventDefault();e.currentTarget.classList.remove('over');if(canEdit)handle(e.dataTransfer.files[0]);}}
        onClick={()=>canEdit&&galleryRef.current&&galleryRef.current.click()}>
        {photo ? <img src={photo} alt="" draggable="false"/> : <span className="ad-initials">{initials}</span>}
        {busy && <div className="ad-busy"><span className="dot amber pulsing"/></div>}
        {canEdit && <div className="ad-overlay"><Icon name="cam" size={20}/></div>}
      </div>
      {canEdit && (
        <div className="avatar-upload-actions">
          <button className="btn btn-sm btn-ghost" onClick={()=>galleryRef.current&&galleryRef.current.click()}><Icon name="upload" size={12}/> Gallery</button>
          <button className="btn btn-sm btn-ghost" onClick={()=>cameraRef.current&&cameraRef.current.click()}><Icon name="cam" size={12}/> Camera</button>
          {photo && <button className="btn btn-sm btn-ghost" onClick={()=>{ProfileStore.remove(id);onChange&&onChange(null);}} style={{color:'var(--danger)'}}><Icon name="x" size={12}/></button>}
        </div>
      )}
      {canEdit && <div className="avatar-hint">JPG · PNG · WEBP · drag, tap, or camera</div>}
      {err && <div className="pt-form-err" style={{margin:'8px 0 0'}}><Icon name="alert" size={12}/> {err}</div>}
      <input ref={galleryRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={e=>handle(e.target.files[0])}/>
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={e=>handle(e.target.files[0])}/>
    </div>
  );
};
window.AvatarUpload = AvatarUpload;

// ── Worker profile modal (info + stats + recent activity) ───
const WorkerProfileModal = ({ worker, canEdit, onClose }) => {
  useProfiles();
  const w = worker;
  return (
    <div className="modal-scrim" onClick={onClose} style={{zIndex:260}}>
      <div className="pdf-modal" style={{width:760}} onClick={e=>e.stopPropagation()}>
        <div className="modal-head">
          <span className="eyebrow eyebrow-amber">WORKER PROFILE</span>
          <button className="modal-close" onClick={onClose}><Icon name="x" size={15}/></button>
        </div>
        <div className="profile-modal-body">
          <div className="profile-modal-left">
            <AvatarUpload id={w.wid} initials={w.av} canEdit={canEdit}/>
            <div className="profile-modal-name">{w.n}</div>
            <div className="profile-modal-id">{w.wid}</div>
            <span className={`chip ${w.statusColor||'ok'}`} style={{marginTop:8}}><span className={`dot ${w.statusColor||'ok'} pulsing`}/>{w.statusText||'On Shift'}</span>
            <div className="profile-meta-list" style={{marginTop:16}}>
              {[['Mobile',w.mobile||'+91 98••• •••••'],['Role',w.role||'L2 Technician'],['Department',w.dept||'Mechanical'],['Branch',w.branch||'Chennai'],['Joined',w.joined||'12 Mar 2023']].map(([l,v])=>(
                <div className="profile-meta-row" key={l}><span className="l">{l}</span><span className="v">{v}</span></div>
              ))}
            </div>
          </div>
          <div className="profile-modal-right">
            <div className="eyebrow eyebrow-amber" style={{marginBottom:10}}>WORK STATISTICS</div>
            <div className="profile-stat-grid">
              {[['Assigned',w.assigned??18,'amber'],['Completed',w.completed??142,'ok'],['Active',w.active??1,'info'],['Hours',w.hours??'1,284','t0'],['Avg Time',w.avgTime??'48m','t0'],['Rating',(w.rating??98.6)+'%','amber']].map(([l,v,c])=>(
                <div className="pstat" key={l}><div className={`pv ${c}`}>{v}</div><div className="pl">{l}</div></div>
              ))}
            </div>
            <div className="eyebrow eyebrow-amber" style={{margin:'18px 0 10px'}}>RECENT ACTIVITY</div>
            <div className="profile-activity">
              {(w.activity||[
                {t:'Completed', v:'Honda Activa 6G', meta:'14m · 100%', c:'ok'},
                {t:'Active', v:'Bajaj Dominar 400', meta:'Bay 04 · 47m elapsed', c:'amber'},
                {t:'Completed', v:'Yamaha R15 V4', meta:'54m · 92%', c:'warn'},
                {t:'Assigned', v:'RE Classic 350', meta:'Bay 04 · queued', c:'info'},
              ]).map((a,i)=>(
                <div className="pact" key={i}>
                  <span className={`pact-dot ${a.c}`}/>
                  <div><div className="pact-v">{a.v}</div><span className="pact-meta">{a.t} · {a.meta}</span></div>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="pdf-modal-foot">
          <span className="mono" style={{fontSize:11,color:'var(--t-3)',letterSpacing:'0.1em'}}>{canEdit?'PHOTO EDITABLE · YOU HAVE ACCESS':'READ-ONLY'}</span>
          <div className="spacer"/>
          <button className="btn btn-ghost" onClick={onClose}>CLOSE</button>
        </div>
      </div>
    </div>
  );
};
window.WorkerProfileModal = WorkerProfileModal;

// ── Admin profile modal ─────────────────────────────────────
const AdminProfileModal = ({ admin, canEdit, onClose }) => {
  useProfiles();
  const a = admin;
  return (
    <div className="modal-scrim" onClick={onClose} style={{zIndex:260}}>
      <div className="pdf-modal" style={{width:720}} onClick={e=>e.stopPropagation()}>
        <div className="modal-head">
          <span className="eyebrow eyebrow-amber">{a.master?'MASTER ADMIN PROFILE':'ADMIN PROFILE'}</span>
          <button className="modal-close" onClick={onClose}><Icon name="x" size={15}/></button>
        </div>
        <div className="profile-modal-body">
          <div className="profile-modal-left">
            <AvatarUpload id={a.id} initials={a.av} canEdit={canEdit}/>
            <div className="profile-modal-name">{a.name}</div>
            <div className="profile-modal-id">{a.id}</div>
            <span className="chip ok" style={{marginTop:8}}><span className="dot ok pulsing"/>{a.role}</span>
            <div className="profile-meta-list" style={{marginTop:16}}>
              {[['Email',a.email||'a.krishnan@bw.co'],['Mobile',a.mobile||'+91 98415 •••••'],['Role',a.role],['Last Login',a.lastLogin||'Today · 08:42']].map(([l,v])=>(
                <div className="profile-meta-row" key={l}><span className="l">{l}</span><span className="v">{v}</span></div>
              ))}
            </div>
          </div>
          <div className="profile-modal-right">
            <div className="eyebrow eyebrow-amber" style={{marginBottom:10}}>ADMINISTRATIVE STATISTICS</div>
            <div className="profile-stat-grid">
              {(a.stats||[['Workers',24,'amber'],['Active Jobs',6,'info'],['Job Cards',642,'ok'],['On-Time',91+'%','t0']]).map(([l,v,c])=>(
                <div className="pstat" key={l}><div className={`pv ${c}`}>{v}</div><div className="pl">{l}</div></div>
              ))}
            </div>
            <div className="eyebrow eyebrow-amber" style={{margin:'18px 0 10px'}}>RECENT ACTIVITIES</div>
            <div className="profile-activity">
              {(a.activity||[
                {v:'Assigned JOB-1056 to Karthik R.', meta:'12m ago', c:'amber'},
                {v:'Approved leave · Imran K.', meta:'1h ago', c:'ok'},
                {v:'Imported parts file (5032 parts)', meta:'2h ago', c:'info'},
                {v:'Updated unit conversion 15→20m', meta:'3h ago', c:'warn'},
              ]).map((x,i)=>(
                <div className="pact" key={i}><span className={`pact-dot ${x.c}`}/><div><div className="pact-v">{x.v}</div><span className="pact-meta">{x.meta}</span></div></div>
              ))}
            </div>
          </div>
        </div>
        <div className="pdf-modal-foot">
          <span className="mono" style={{fontSize:11,color:'var(--t-3)',letterSpacing:'0.1em'}}>{canEdit?'PHOTO EDITABLE':'READ-ONLY'}</span>
          <div className="spacer"/>
          <button className="btn btn-ghost" onClick={onClose}>CLOSE</button>
        </div>
      </div>
    </div>
  );
};
window.AdminProfileModal = AdminProfileModal;

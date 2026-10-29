// Master Admin Portal — global command (desktop)
const { useState: useMS, useEffect: useME } = React;

const MASTER_NAV = [
  { id: 'overview', label: 'Dashboard', icon: 'gauge' },
  { id: 'monitoring', label: 'Bay Monitoring', icon: 'cam' },
  { id: 'barricade', label: 'Barricade Monitoring', icon: 'scan' },
  { id: 'livewatch', label: 'Customer Live Watch', icon: 'cam' },
  { id: 'storage', label: 'Storage Management', icon: 'upload' },
  { id: 'integrations', label: 'Integrations & Configuration', icon: 'tools' },
  { id: 'settings', label: 'System Settings', icon: 'cog' },
  { id: 'branches', label: 'Branch Management', icon: 'pin' },
  { id: 'admins', label: 'User Management', icon: 'shield' },
  { id: 'completion', label: 'Work Completion', icon: 'check' },
  { id: 'intake', label: 'Intake Evidence', icon: 'clipboard' },
  { id: 'approvals', label: 'Customer Approvals', icon: 'check' },
  { id: 'analytics', label: 'Reports', icon: 'history' },
  { id: 'timeanalysis', label: 'Worker Time Analysis', icon: 'gauge' },
  { id: 'audit', label: 'Audit Logs', icon: 'shield' },
];

// ── Master shell
const MasterPortal = ({ onLogout }) => {
  const [tab, setTab] = useMS('overview');
  const [navOpen, setNavOpen] = useMS(false);
  const [showProfile, setShowProfile] = useMS(false);
  // Real logged-in master identity from the authenticated session — never hardcoded demo data.
  const _self = (window.BW_API && BW_API.currentUser && BW_API.currentUser()) || {};
  const _initials = ((_self.name || 'Master').match(/\b\w/g) || ['M']).slice(0, 2).join('').toUpperCase();
  const [masterStats, setMasterStats] = useMS(null);
  // Real global stats, fetched only when the profile opens — fake stats/activity removed.
  useME(() => {
    if (!showProfile) return;
    let alive = true;
    BW_API.masterAnalytics()
      .then(a => { if (alive && a) setMasterStats([['Branches', a.branches ?? 0, 'amber'], ['Completed jobs', a.completed_jobs ?? 0, 'ok'], ['On-time rate', (a.on_time_rate ?? 0) + '%', 't0']]); })
      .catch(() => {});
    return () => { alive = false; };
  }, [showProfile]);
  const MASTER_SELF = {
    id: _self.id || '', av: _initials, name: _self.name || 'Global Command',
    role: 'Master Administrator', master: true,
    email: '—', mobile: '—', lastLogin: '—',     // not stored on the user record → honest dash
    stats: masterStats || [['Live summary', '—', 't0']],
    activity: [{ v: 'Live activity feed not yet available', meta: '', c: 'info' }],
  };
  const now = useNow();
  // platform: command palette / global search navigation lands on a tab.
  // Camera/Timer registries now live inside their provider tabs (Bay Cameras & RTSP /
  // Bay Timers & MQTT), so legacy 'cameras'/'timers' targets redirect to those tabs.
  useME(() => {
    const h = (e) => {
      if (!e.detail || !e.detail.tab) return;
      let t = e.detail.tab;
      if (t === 'cameras' || t === 'timers') {
        const provider = t === 'cameras' ? 'camera' : 'mqtt_timer';
        window.__bwIntgPending = { provider, ts: Date.now() };
        window.dispatchEvent(new CustomEvent('bw:integrations-open', { detail: { provider } }));
        t = 'integrations';
      }
      setTab(t); setNavOpen(false);
    };
    window.addEventListener('bw:navigate', h);
    return () => window.removeEventListener('bw:navigate', h);
  }, []);
  const isLiveShell = window.BW_API && window.BW_API.isLive();
  const hh = String(now.getHours()).padStart(2,'0');
  const mm = String(now.getMinutes()).padStart(2,'0');
  const ss = String(now.getSeconds()).padStart(2,'0');
  return (
    <div className="console">
      {showProfile && <AdminProfileModal admin={MASTER_SELF} canEdit={true} onClose={()=>setShowProfile(false)}/>}
      <div className="console-nav">
        <button className="hamburger" onClick={()=>setNavOpen(true)}><Icon name="queue" size={18}/></button>
        <div className="console-brand console-id-btn" onClick={()=>setShowProfile(true)}>
          <Avatar id={MASTER_SELF.id} initials={MASTER_SELF.av} size={34} ring="white"/>
          <div className="console-role">
            <span className="r">{MASTER_SELF.name}</span>
            <span className="b" style={{color:'var(--t-1)'}}>MASTER ADMIN</span>
          </div>
        </div>
        <div className="console-search" role="button" tabIndex={0} aria-label="Open command palette"
          onClick={()=>window.dispatchEvent(new CustomEvent('bw:palette-open'))}
          onKeyDown={(e)=>{ if(e.key==='Enter') window.dispatchEvent(new CustomEvent('bw:palette-open')); }}>
          <Icon name="gauge" size={14}/>
          <span>Search branches, admins, anomalies…</span>
          <kbd>⌘K</kbd>
        </div>
        <div className="console-nav-right">
          <div className="nav-pill"><span className="dot live pulsing"/>ALL NODES · OK</div>
          <div className="nav-clock mono"><span>{hh}:{mm}<span style={{color:'var(--t-3)'}}>:{ss}</span></span><span className="date">GLOBAL · IST</span></div>
          {isLiveShell ? <window.BWNotifications/> : <button className="btn btn-sm btn-ghost" aria-label="Notifications"><Icon name="bell" size={14}/></button>}
          <LogoutButton onLogout={onLogout}/>
        </div>
      </div>
      {isLiveShell && <window.BWCommandPalette actions={[
        { label: 'Bay Monitoring', icon: 'cam', tab: 'monitoring' },
        { label: 'Barricade Monitoring', icon: 'scan', tab: 'barricade' },
        { label: 'Bay Cameras (Device Connections)', icon: 'scan', tab: 'cameras' },
        { label: 'Physical Timers (Device Connections)', icon: 'clock', tab: 'timers' },
        { label: 'Storage Management', icon: 'upload', tab: 'storage' },
        { label: 'Integrations & Configuration', icon: 'tools', tab: 'integrations' },
        { label: 'System Settings', icon: 'cog', tab: 'settings' },
        { label: 'Branch Management', icon: 'pin', tab: 'branches' },
        { label: 'Audit Logs', icon: 'shield', tab: 'audit' },
        { label: 'Reports', icon: 'history', tab: 'analytics' },
      ]}/>}
      <div className="console-body">
        {navOpen && <div className="drawer-scrim" onClick={()=>setNavOpen(false)}/>}
        <div className={`console-side ${navOpen?'open':''}`}>
          <div className="drawer-head">
            <div className="row" style={{gap:10}}><div className="brand-mark" style={{background:'linear-gradient(135deg,#fff,#bbb)',color:'#000'}}>M</div><span style={{fontWeight:600}}>Global Command</span></div>
            <button className="modal-close" onClick={()=>setNavOpen(false)}><Icon name="x" size={15}/></button>
          </div>
          <div className="side-section">SYSTEM-WIDE</div>
          {MASTER_NAV.map(n => (
            <div key={n.id} className={`side-link ${tab===n.id?'active':''}`} onClick={()=>{setTab(n.id);setNavOpen(false);}}>
              <Icon name={n.icon} size={16}/><span>{n.label}</span>
              {n.badge && <span className="badge">{n.badge}</span>}
            </div>
          ))}
          <div className="sidebar-footer">
            <div className="shift-card">
              <div className="l">System health</div>
              <div className="v" style={{color:'var(--ok)'}}>● All green</div>
              <div className="l" style={{marginTop:8}}>Nodes</div>
              <div className="v">4 / 4 online</div>
            </div>
          </div>
        </div>
        <div className="console-content">
          {/* Backend-only: PostgreSQL-backed Live components only. No demo fallback. */}
          {tab==='overview'   && <window.LiveMasterOverview/>}
          {tab==='monitoring' && <window.LiveMasterMonitoring/>}
          {tab==='barricade'  && <window.LiveMasterBarricade/>}
          {tab==='livewatch'  && <window.LiveCustomerWatchAudit/>}
          {tab==='branches'   && <window.LiveMasterBranchManagement/>}
          {/* Camera/Timer Configuration moved into Integrations & Configuration →
              Bay Device Connections; legacy targets redirect via bw:navigate above. */}
          {tab==='storage'    && <window.LiveStorageManagement/>}
          {tab==='integrations' && <window.IntegrationsConfig/>}
          {tab==='admins'     && <window.LiveMasterUserManagement/>}
          {tab==='completion' && <window.LiveWorkCompletion/>}
          {tab==='intake'     && <window.LiveMasterIntake/>}
          {tab==='approvals'  && <window.LiveCustomerApprovals/>}
          {tab==='analytics'  && <window.LiveMasterAnalytics/>}
          {tab==='timeanalysis' && <window.LiveMasterWorkerTransition/>}
          {tab==='settings'   && <window.LiveSystemSettings/>}
          {tab==='audit'      && <window.LiveAuditLogs/>}
        </div>
      </div>
    </div>
  );
};

window.MasterPortal = MasterPortal;

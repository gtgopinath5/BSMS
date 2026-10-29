// Admin Portal — branch control center (desktop)
const { useState: useAS, useEffect: useAE, useMemo: useAM } = React;

const ADMIN_NAV = [
  { id: 'bays', label: 'Live Bay Dashboard', icon: 'gauge' },
  { id: 'baymgmt', label: 'Bay Management', icon: 'route' },
  { id: 'assign', label: 'Job Assignment & Queue', icon: 'plus' },
  { id: 'intake', label: 'Intake Evidence', icon: 'clipboard' },
  { id: 'approvals', label: 'Customer Approvals', icon: 'check' },
  { id: 'partstime', label: 'Parts Time', icon: 'tools' },
  { id: 'workers', label: 'Worker Management', icon: 'user' },
  { id: 'leave', label: 'Leave Approvals', icon: 'calendar', badge: '4' },
  { id: 'reports', label: 'Branch Reports', icon: 'history' },
  { id: 'timeanalysis', label: 'Worker Time Analysis', icon: 'gauge' },
  { id: 'testdrives', label: 'Bike Test Drive Tracking', icon: 'bike' },
  { id: 'barricade', label: 'AI Barricade', icon: 'scan' },
  { id: 'completion', label: 'Work Completion', icon: 'check' },
  { id: 'storage', label: 'Storage Management', icon: 'upload' },
  { id: 'integrations', label: 'Integrations & Configuration', icon: 'tools' },
];

// Bay dataset for Chennai (8 bays)
// Each bay has a PERMANENT primary worker. A temporary replacement (with
// start/end/reason) overrides the current worker until it expires → auto-revert.
// HARDCODED DEMO BAYS REMOVED — bays come only from PostgreSQL via
// GET /api/v1/bays/operations (rendered by window.LiveBayDashboard / LiveBayManagement).
// ── Admin shell
const AdminPortal = ({ branch, onLogout }) => {
  const [tab, setTab] = useAS('bays');
  const [tick, setTick] = useAS(0);
  const [navOpen, setNavOpen] = useAS(false);
  const [showProfile, setShowProfile] = useAS(false);
  const now = useNow();
  // Real logged-in identity from the authenticated session — never hardcoded demo data.
  const _self = (window.BW_API && BW_API.currentUser && BW_API.currentUser()) || {};
  const _initials = ((_self.name || 'Admin').match(/\b\w/g) || ['A']).slice(0, 2).join('').toUpperCase();
  const [adminStats, setAdminStats] = useAS(null);
  // Real branch stats, fetched only when the profile opens — honest, never fake numbers.
  useAE(() => {
    if (!showProfile) return;
    let alive = true;
    BW_API.branchSummary()
      .then(s => { if (alive && s) setAdminStats([['Completed jobs', s.completed ?? 0, 'ok'], ['On-time rate', (s.on_time_rate ?? 0) + '%', 't0']]); })
      .catch(() => {});
    return () => { alive = false; };
  }, [showProfile]);
  const ADMIN_SELF = {
    id: _self.id || '', av: _initials, name: _self.name || 'Administrator',
    role: 'Branch Admin', master: false,
    email: '—', mobile: '—', lastLogin: '—',     // not stored on the user record → honest dash
    stats: adminStats || [['Live summary', '—', 't0']],
    activity: [{ v: 'Live activity feed not yet available', meta: '', c: 'info' }],
  };
  useAE(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  // platform: command palette / global search navigation lands on a tab.
  // Camera/Timer registries now live inside their provider tabs (Bay Cameras & RTSP /
  // Bay Timers & MQTT), so legacy 'cameras'/'timers' targets redirect to those tabs.
  useAE(() => {
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
      {showProfile && <AdminProfileModal admin={ADMIN_SELF} canEdit={true} onClose={()=>setShowProfile(false)}/>}
      <div className="console-nav">
        <button className="hamburger" onClick={()=>setNavOpen(true)}><Icon name="queue" size={18}/></button>
        <div className="console-brand console-id-btn" onClick={()=>setShowProfile(true)}>
          <Avatar id={ADMIN_SELF.id} initials={ADMIN_SELF.av} size={34} ring="blue"/>
          <div className="console-role">
            <span className="r">{ADMIN_SELF.name}</span>
            <span className="b">BRANCH ADMIN · {branch.name}</span>
          </div>
        </div>
        <div className="console-search" role="button" tabIndex={0} aria-label="Open command palette"
          onClick={()=>window.dispatchEvent(new CustomEvent('bw:palette-open'))}
          onKeyDown={(e)=>{ if(e.key==='Enter') window.dispatchEvent(new CustomEvent('bw:palette-open')); }}>
          <Icon name="gauge" size={14}/>
          <span>Search bays, workers, jobs…</span>
          <kbd>⌘K</kbd>
        </div>
        <div className="console-nav-right">
          <div className="nav-pill"><span className="dot live pulsing"/>WS · ROOM_CHN_01</div>
          <div className="nav-clock mono"><span>{hh}:{mm}<span style={{color:'var(--t-3)'}}>:{ss}</span></span><span className="date">{now.toLocaleDateString('en-IN',{weekday:'short',day:'2-digit',month:'short'}).toUpperCase()}</span></div>
          {isLiveShell ? <window.BWNotifications/> : <button className="btn btn-sm btn-ghost" aria-label="Notifications"><Icon name="bell" size={14}/></button>}
          <LogoutButton onLogout={onLogout}/>
        </div>
      </div>
      {isLiveShell && <window.BWCommandPalette actions={[
        { label: 'Create Worker', icon: 'plus', tab: 'workers', event: 'workers:create' },
        { label: 'Review Leave Approvals', icon: 'calendar', tab: 'leave', event: 'leave:focus' },
        { label: 'Open Branch Reports', icon: 'history', tab: 'reports' },
        { label: 'Bike Test Drive Tracking', icon: 'bike', tab: 'testdrives' },
        { label: 'AI Barricade', icon: 'scan', tab: 'barricade' },
        { label: 'Assign Job', icon: 'plus', tab: 'assign' },
        { label: 'Customer Approvals', icon: 'check', tab: 'approvals' },
        { label: 'Open Live Bay Dashboard', icon: 'gauge', tab: 'bays' },
        { label: 'Bay Cameras (Device Connections)', icon: 'cam', tab: 'cameras' },
        { label: 'Physical Timers (Device Connections)', icon: 'clock', tab: 'timers' },
        { label: 'Work Completion & PDFs', icon: 'check', tab: 'completion' },
        { label: 'Storage Management', icon: 'upload', tab: 'storage' },
        { label: 'Integrations & Configuration', icon: 'tools', tab: 'integrations' },
        { label: 'Worker Management', icon: 'user', tab: 'workers' },
        { label: 'Parts Time', icon: 'tools', tab: 'partstime' },
      ]}/>}
      <div className="console-body">
        {navOpen && <div className="drawer-scrim" onClick={()=>setNavOpen(false)}/>}
        <div className={`console-side ${navOpen?'open':''}`}>
          <div className="drawer-head">
            <div className="row" style={{gap:10}}><div className="brand-mark">B</div><span style={{fontWeight:600}}>Baywatch</span></div>
            <button className="modal-close" onClick={()=>setNavOpen(false)}><Icon name="x" size={15}/></button>
          </div>
          <div className="side-section">BRANCH CONTROL</div>
          {ADMIN_NAV.map(n => (
            <div key={n.id} className={`side-link ${tab===n.id?'active':''}`} onClick={()=>{setTab(n.id);setNavOpen(false);}}>
              <Icon name={n.icon} size={16}/><span>{n.label}</span>
              {n.badge && <span className="badge" style={n.badge==='!'?{background:'rgba(244,63,94,0.15)',color:'var(--danger)'}:{}}>{n.badge}</span>}
            </div>
          ))}
          <div className="sidebar-footer">
            <div className="shift-card">
              <div className="l">Branch status</div>
              <div className="v" style={{color:'var(--ok)'}}>● Operational</div>
              <div className="l" style={{marginTop: 8}}>Uptime</div>
              <div className="v">99.98%</div>
            </div>
          </div>
        </div>
        <div className="console-content">
          {/* Backend-only: every tab renders the PostgreSQL-backed Live component.
              No demo fallback — the portal is unreachable without a real JWT. */}
          {tab==='bays'       && <>{window.IntakeTodayWidget && <window.IntakeTodayWidget onViewAll={()=>setTab('intake')}/>}<window.LiveBayDashboard/></>}
          {tab==='baymgmt'    && <window.LiveBayManagement/>}
          {/* Camera/Timer Connection moved into Integrations & Configuration →
              Bay Device Connections; legacy 'cameras'/'timers' targets are
              redirected there by the bw:navigate handler above. */}
          {tab==='assign'     && <window.LiveJobAssignment/>}
          {tab==='intake'     && <window.LiveAdminIntake/>}
          {tab==='approvals'  && <window.LiveCustomerApprovals/>}
          {tab==='partstime'  && <window.LivePartsTime/>}
          {tab==='workers'    && <window.LiveWorkerManagement/>}
          {tab==='leave'      && <window.LiveLeaveApprovals/>}
          {tab==='reports'    && <window.LiveBranchReports/>}
          {tab==='timeanalysis' && <window.LiveAdminWorkerTransition/>}
          {tab==='testdrives' && <window.LiveTestDriveTracking/>}
          {tab==='barricade'  && <window.LiveAdminBarricade/>}
          {tab==='completion' && <window.LiveWorkCompletion/>}
          {tab==='storage'    && <window.LiveStorageManagement/>}
          {tab==='integrations' && <window.IntegrationsConfig/>}
        </div>
      </div>
    </div>
  );
};

window.AdminPortal = AdminPortal;

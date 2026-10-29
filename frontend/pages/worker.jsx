// Worker Portal — main module
const { useState: useS, useEffect: useE, useRef: useR, useMemo: useM } = React;

const SIDE_NAV = [
  { id: 'active', label: 'Active Job', icon: 'wrench', badge: 'LIVE' },
  { id: 'queue', label: 'My Job Queue', icon: 'queue' },
  { id: 'jobcard', label: 'Jobcard Entry', icon: 'clipboard' },
  { id: 'testdrive', label: 'Test Drive Approval', icon: 'route' },
  { id: 'profile', label: 'Profile', icon: 'user' },
  { id: 'attendance', label: 'Attendance & Leave', icon: 'calendar' },
  { id: 'history', label: 'Work History', icon: 'history' },
];

// ───────────────────────────────────────────────────────── Navbar
const Navbar = ({ user, branch, timerStatus, cameraStatus, onLogout, onMenu }) => {
  const now = useNow();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  // Identity is the authenticated user (PostgreSQL), never a hardcoded name.
  const initials = (user.name || 'W').split(' ').map(x => x[0]).slice(0, 2).join('').toUpperCase();
  return (
    <div className="navbar">
      <div className="nav-user">
        <button className="hamburger" onClick={onMenu}><Icon name="queue" size={18}/></button>
        <div style={{position:'relative'}}>
          <Avatar id={user.id} initials={initials} size={38}/>
          <span style={{position:'absolute',right:-2,bottom:-2,width:10,height:10,background:'var(--ok)',borderRadius:'50%',border:'2px solid var(--bg-1)'}}/>
        </div>
        <div className="nav-id">
          <div className="name">{user.name}</div>
          <div className="meta">{user.id} · {(user.role || 'worker').toUpperCase()}</div>
        </div>
      </div>

      <div className="nav-status">
        <div className="nav-pill">
          <Icon name="pin" size={12}/>
          <span>{branch.name}</span>
          <span style={{color: 'var(--t-3)', marginLeft: 4}}>{branch.id}</span>
        </div>
        <div className="nav-pill">
          <span className={`dot ${cameraStatus === 'ACTIVE' ? 'danger pulsing' : 'warn'}`}/>
          <span>CAM · {cameraStatus}</span>
        </div>
        <div className="nav-pill">
          <Icon name="clock" size={12}/>
          <span>TIMER · {timerStatus}</span>
        </div>
        <div className="nav-pill">
          <Icon name="wifi" size={12}/>
          <span>WS · {branch?.id || '—'}</span>
          <span className="dot live pulsing" style={{marginLeft: 2}}/>
        </div>
      </div>

      <div className="nav-right">
        <button className="btn btn-sm btn-ghost" title="Notifications">
          <Icon name="bell" size={14}/>
        </button>
        <div className="nav-clock mono">
          <span>{hh}:{mm}<span style={{color: 'var(--t-3)'}}>:{ss}</span></span>
          <span className="date">{now.toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short' }).toUpperCase()}</span>
        </div>
        <LogoutButton onLogout={onLogout}/>
      </div>
    </div>
  );
};

// ───────────────────────────────────────────────────────── Sidebar
const Sidebar = ({ tab, setTab, shift, open, onClose }) => (
  <>
    {open && <div className="drawer-scrim" onClick={onClose}/>}
    <div className={`sidebar ${open?'open':''}`}>
    <div className="drawer-head">
      <div className="row" style={{gap:10}}><div className="brand-mark">B</div><span style={{fontWeight:600}}>Baywatch</span></div>
      <button className="modal-close" onClick={onClose}><Icon name="x" size={15}/></button>
    </div>
    <div className="side-section">WORK</div>
    {SIDE_NAV.slice(0, 4).map(item => (
      <div key={item.id} className={`side-link ${tab === item.id ? 'active' : ''}`} onClick={() => { setTab(item.id); onClose&&onClose(); }}>
        <Icon name={item.icon} size={16}/>
        <span>{item.label}</span>
        {item.badge && <span className="badge">{item.badge}</span>}
      </div>
    ))}

    <div className="side-section">ACCOUNT</div>
    {SIDE_NAV.slice(4).map(item => (
      <div key={item.id} className={`side-link ${tab === item.id ? 'active' : ''}`} onClick={() => { setTab(item.id); onClose&&onClose(); }}>
        <Icon name={item.icon} size={16}/>
        <span>{item.label}</span>
        {item.badge && <span className="badge">{item.badge}</span>}
      </div>
    ))}

    <div className="sidebar-footer">
      <div className="shift-card">
        <div className="l">Shift</div>
        <div className="v">{shift.start} – {shift.end}</div>
        <div className="l" style={{marginTop: 8}}>Elapsed</div>
        <div className="v" style={{color: 'var(--amber)'}}>{shift.elapsed}</div>
      </div>
    </div>
  </div>
  </>
);

// ───────────────────────────────────────────────────────── Profile page
const ProfilePage = ({ user, branch }) => {
  // Identity + performance come from PostgreSQL: the authenticated user record
  // and /worker/history (the worker's OWN completed jobs — worker-authorized;
  // NOT the admin-only /reports/worker-performance). Fields with no column in
  // the schema (phone/email/cert/specialties) show a neutral "—" and are
  // tracked in REMAINING_NON_DATABASE_ITEMS.md for a future migration.
  const initials = (user.name || 'W').split(' ').map(x => x[0]).slice(0, 2).join('').toUpperCase();
  const [perf, setPerf] = useS(null);
  useE(() => {
    let alive = true;
    BW_API.workerHistory()
      .then(rows => { if (alive) setPerf(Array.isArray(rows) ? rows : []); })
      .catch(() => { if (alive) setPerf([]); });
    return () => { alive = false; };
  }, []);
  const jobs = perf ? perf.length : 0;
  const scores = (perf || []).map(r => Number(r.score)).filter(n => !isNaN(n));
  const avgScore = scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : 0;
  return (
    <>
      <div className="content-head">
        <div>
          <div className="eyebrow eyebrow-amber" style={{marginBottom: 8}}>● PROFILE</div>
          <h1>Profile</h1>
          <span className="sub">Read-only · contact HR to update</span>
        </div>
      </div>

      <div className="page-grid-2">
        <div className="profile-card fade-up">
          <AvatarUpload id={user.id} initials={initials} canEdit={true}/>
          <div className="profile-name">{user.name}</div>
          <div className="profile-id">{user.id} · {(user.role || 'worker').toUpperCase()}</div>
          <div className="row" style={{gap: 8, marginTop: 4}}>
            <span className="chip ok"><span className="dot live pulsing"/>ON SHIFT</span>
          </div>
          <div className="profile-meta-list">
            {[
              ['Branch', branch?.name || '—'],
              ['Employee ID', user.id],
              ['Role', (user.role || 'worker').toUpperCase()],
              ['Phone', '—'],
              ['Email', '—'],
            ].map(([l, v]) => (
              <div className="profile-meta-row" key={l}>
                <span className="l">{l}</span>
                <span className="v">{v}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="col" style={{gap: 22}}>
          <div className="stats-strip" style={{gridTemplateColumns: 'repeat(2, 1fr)'}}>
            <div className="stat">
              <div className="l">JOBS · ALL TIME</div>
              <div className="v"><Ticker value={jobs}/></div>
            </div>
            <div className="stat">
              <div className="l">AVG SCORE</div>
              <div className="v"><Ticker value={avgScore} decimals={1}/><span className="unit">%</span></div>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <span className="eyebrow eyebrow-amber">PERFORMANCE</span>
              <span className="mono" style={{fontSize: 11, color: 'var(--t-3)', letterSpacing: '0.12em'}}>LIVE · POSTGRESQL</span>
            </div>
            <div style={{padding: 18, color: 'var(--t-3)', fontSize: 13}}>
              {perf === null ? 'Loading completion history…'
                : jobs === 0 ? 'No completed jobs on record yet.'
                : `${jobs} completed job${jobs === 1 ? '' : 's'} on record · average score ${avgScore}%.`}
            </div>
          </div>
        </div>
      </div>
    </>
  );
};

// ───────────────────────────────────────────────────────── Worker shell
const WorkerPortal = ({ user, branch, onLogout }) => {
  const [tab, setTab] = useS('active');
  const [navOpen, setNavOpen] = useS(false);
  // Chrome status (Navbar timer pill + bottom-nav badge) is read from the worker's
  // active session in PostgreSQL via /worker/active — never a demo store.
  const [active, setActive] = useS(null);
  useBWPoll(() => BW_API.workerActive().then(d => { setActive(d); return d; }), [], 4000);
  const status = ((active && (active.current_status || active.status)) || 'IDLE').toString().toUpperCase();
  const cameraStatus = active && active.camera_status ? active.camera_status.toUpperCase() : 'OFF';

  // Shift window for the sidebar (clock-derived; carries no job/business data).
  const shift = {
    start: '08:00', end: '17:00',
    elapsed: (() => {
      const start = new Date(); start.setHours(8, 0, 0, 0);
      const diff = Math.max(0, Math.floor((Date.now() - start.getTime()) / 60000));
      return `${String(Math.floor(diff/60)).padStart(2,'0')}h ${String(diff%60).padStart(2,'0')}m`;
    })(),
  };

  // Only the 4 most important items in the bottom nav
  const BOT_NAV = [
    { id:'active',     label:'Active',     icon:'wrench',   badge: status === 'RUNNING' },
    { id:'queue',      label:'Queue',      icon:'queue' },
    { id:'attendance', label:'Leave',      icon:'calendar' },
    { id:'history',    label:'History',    icon:'history' },
  ];

  return (
    <div className={`worker has-bottom-nav`}>
      <Navbar user={user} branch={branch} timerStatus={status} cameraStatus={cameraStatus} onLogout={onLogout} onMenu={()=>setNavOpen(true)}/>
      <div className="worker-body">
        <Sidebar tab={tab} setTab={setTab} shift={shift} open={navOpen} onClose={()=>setNavOpen(false)}/>
        <div className="content">
          {/* Backend-only: PostgreSQL-backed Live components only. No demo fallback. */}
          {tab === 'active'     && <window.LiveWorkerActive/>}
          {tab === 'queue'      && <window.LiveWorkerQueue/>}
          {tab === 'jobcard'    && <window.LiveWorkerJobcard/>}
          {tab === 'testdrive'  && <window.LiveWorkerTestDrive/>}
          {tab === 'profile'    && <ProfilePage user={user} branch={branch}/>}
          {tab === 'attendance' && <window.LiveWorkerLeave/>}
          {tab === 'history'    && <window.LiveWorkerHistory/>}
        </div>
      </div>

      {/* Mobile bottom navigation */}
      <nav className="bottom-nav" role="navigation" aria-label="Main navigation">
        <div className="bottom-nav-inner">
          {BOT_NAV.map(n => (
            <button key={n.id} className={`bottom-nav-item ${tab===n.id?'active':''}`} onClick={()=>setTab(n.id)} style={{position:'relative'}}>
              <Icon name={n.icon} size={20}/>
              <span>{n.label}</span>
              {n.badge && <span className="bni-dot"/>}
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
};

window.WorkerPortal = WorkerPortal;

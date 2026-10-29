// Main app — routes by role, adaptive framing (tablet vs desktop console)
const { useState: useStA, useEffect: useEfA, useRef: useRfA } = React;

// Branch directory comes from PostgreSQL (public GET /api/v1/branches), cached
// for the session. Resolves a user's branch_id → the {id,name,region} object the
// branch-scoped portals render. Falls back to a minimal object built from the
// user's own branch_id so a portal still mounts if the directory call fails.
let _branchCache = null;
const loadBranches = async () => {
  if (_branchCache) return _branchCache;
  try { _branchCache = (await window.BW_API.branches()) || []; } catch (e) { _branchCache = []; }
  return _branchCache;
};
const resolveBranch = async (branchId) => {
  const list = await loadBranches();
  return list.find(x => x.id === branchId)
      || (branchId ? { id: branchId, name: branchId } : (list[0] || null));
};

const App = () => {
  const [stage, setStage] = useStA('landing'); // landing | role | login | portal
  const [branch, setBranch] = useStA(null);
  const [role, setRole] = useStA(null);
  const [user, setUser] = useStA(null);
  // One-shot notice shown after a stale-token 401 logs the user out (cleared on
  // the next successful login and auto-hidden). The source event is debounced,
  // so it never loops.
  const [expiredNotice, setExpiredNotice] = useStA(false);

  // Entry routing. A live backend session is AUTHORITATIVE: you always land in
  // the portal that matches your token's role (decoded from the JWT), no matter
  // what the URL hash says. That makes it impossible to view, say, the Admin
  // portal with a Worker token — which was the real source of the 403 storm.
  // Roles: Master Admin, Admin, Worker (no customer role).
  useEfA(() => {
    const ROLE2PORTAL = { master_admin: 'MASTER', admin: 'ADMIN', worker: 'WORKER' };
    const apply = async () => {
      const api = window.BW_API;
      // expired token → drop it and start clean at the landing screen
      if (api && api.isLive() && api.tokenExpired && api.tokenExpired()) { api.logout(); }

      if (api && api.isLive()) {
        const portalId = ROLE2PORTAL[api.roleOf()];
        const r = ROLES.find(x => x.id === portalId);
        if (r) {
          const u = api.currentUser() || {};
          setBranch(await resolveBranch(u.branch_id));   // from PostgreSQL
          setRole(r);
          setUser({ id: u.id, name: u.name, role: api.roleOf() });
          setStage('portal');
          return;
        }
      }
      // No session → stay in the entry flow (landing → role → login).
      // There is NO anonymous/demo portal: every portal requires a real backend
      // JWT, so no hardcoded identity or demo data can ever render.
    };
    apply();
    window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
  }, []);

  const isDesktopPortal = stage === 'portal' && (role?.id === 'ADMIN' || role?.id === 'MASTER');
  const showTablet = !isDesktopPortal;

  const tabletRef = useRfA(null);
  const deskRef = useRfA(null);
  const [fluid, setFluid] = useStA(() => (typeof window !== 'undefined' ? window.innerWidth < 1024 : false));

  useEfA(() => {
    let raf = 0;
    let lastFluid = window.innerWidth < 1024;
    const apply = () => {
      raf = 0;
      const w = window.innerWidth, h = window.innerHeight;
      const isFluid = w < 1024;
      // only trigger a React re-render when the mode actually flips
      if (isFluid !== lastFluid) { lastFluid = isFluid; setFluid(isFluid); }
      [[tabletRef, 1280, 880], [deskRef, 1440, 912]].forEach(([ref, W, H]) => {
        if (!ref.current) return;
        if (isFluid) { ref.current.style.transform = ''; return; }
        const s = Math.min((w - 40) / W, (h - 40) / H, 1);
        const tx = (w - W * s) / 2;
        const ty = (h - H * s) / 2;
        ref.current.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
      });
    };
    const onResize = () => { if (!raf) raf = requestAnimationFrame(apply); };
    apply();
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => { window.removeEventListener('resize', onResize); window.removeEventListener('orientationchange', onResize); cancelAnimationFrame(raf); };
  }, []);

  const pickBranch = (b) => { setBranch(b); setStage('role'); };
  const pickRole = (r) => { setRole(r); setStage('login'); };
  const ROLE_MAP = { master_admin: 'MASTER', admin: 'ADMIN', worker: 'WORKER' };
  const finishLogin = ({ live }) => {
    // Backend login is the ONLY entry — identity (role + branch) is whatever the
    // backend/JWT returned. No offline/hardcoded-identity fallback.
    if (!live) return;
    setExpiredNotice(false);   // a fresh successful login clears the expiry notice
    const r = ROLES.find(x => x.id === (ROLE_MAP[live.role] || role?.id)) || role;
    setRole(r);
    // Resolve the post-login branch from PostgreSQL (keeps the already-picked
    // branch if the login didn't carry one — e.g. master).
    if (live.branch_id) { resolveBranch(live.branch_id).then(b => { if (b) setBranch(b); }); }
    setUser({ id: live.id, name: live.name, role: live.role });
    setStage('portal');
  };
  const logout = () => {
    if (window.BW_API) window.BW_API.logout();
    setStage('landing');
    setTimeout(() => { setBranch(null); setRole(null); setUser(null); }, 450);
  };

  // When the backend reports the session is no longer valid (a real 401:
  // expired / revoked token), return to the login flow. This unmounts the
  // active portal — and with it every poller and WebSocket — so we never sit
  // in a portal hammering the API with a dead token. A wrong-role 403 does NOT
  // fire this (that poller just stops); only a genuine 401 does. logout() is a
  // no-op-ish reset when we're already outside a portal, so no stage guard.
  useEfA(() => {
    const onExpired = () => { setExpiredNotice(true); logout(); };
    window.addEventListener('bw:auth-expired', onExpired);
    return () => window.removeEventListener('bw:auth-expired', onExpired);
  }, []);

  // Auto-hide the session-expired notice so it never lingers on screen.
  useEfA(() => {
    if (!expiredNotice) return;
    const t = setTimeout(() => setExpiredNotice(false), 6000);
    return () => clearTimeout(t);
  }, [expiredNotice]);

  // Guard against a token ↔ portal role mismatch (the root cause of the 403
  // flood): all portals share one localStorage token, so a deep-link (#worker)
  // or a stale tab can land you in a portal whose role differs from the stored
  // token. Detect that and bounce to login BEFORE any poller fires. Offline /
  // demo portals (no token) are left alone so the app still runs without a backend.
  useEfA(() => {
    if (stage !== 'portal') return;
    const api = window.BW_API;
    if (!api || !api.isLive()) return;
    const expectedPortal = ROLE_MAP[api.roleOf()];        // token role → portal id
    if (expectedPortal && role && role.id !== expectedPortal) logout();
  }, [stage, role]);

  return (
    <div className={`app-shell ${fluid ? 'fluid' : ''}`}>
      {expiredNotice && (
        <div role="status" className="session-expired-toast" style={{
          position: 'fixed', top: 18, left: '50%', transform: 'translateX(-50%)', zIndex: 9999,
          padding: '10px 16px', borderRadius: 10, background: 'rgba(244,63,94,0.14)',
          border: '1px solid rgba(244,63,94,0.34)', color: 'var(--danger)',
          fontSize: 13, letterSpacing: '0.02em', backdropFilter: 'blur(8px)',
        }}>Session expired. Please login again.</div>
      )}
      {/* Tablet frame — entry flow + Worker portal */}
      <div className="tablet-stage" ref={tabletRef} style={{ opacity: showTablet ? 1 : 0, pointerEvents: showTablet ? 'auto' : 'none', transition: 'opacity 450ms ease' }}>
        <div className="tablet-screen">
          <div className={`screen ${stage === 'landing' ? 'active' : ''}`}>
            <Landing onSelect={pickBranch}/>
          </div>
          <div className={`screen ${stage === 'role' ? 'active' : ''}`}>
            {branch && <RoleSelect branch={branch} onSelect={pickRole} onBack={() => setStage('landing')}/>}
          </div>
          <div className={`screen ${stage === 'login' ? 'active' : ''}`}>
            {branch && role && <Login branch={branch} role={role} onBack={() => setStage('role')} onSubmit={finishLogin}/>}
          </div>
          <div className={`screen ${stage === 'portal' && role?.id === 'WORKER' ? 'active' : ''}`}>
            {user && branch && role?.id === 'WORKER' && <WorkerPortal user={user} branch={branch} onLogout={logout}/>}
          </div>
        </div>
      </div>

      {/* Desktop console — Admin + Master Admin */}
      <div className="desk-stage" ref={deskRef} style={{ opacity: isDesktopPortal ? 1 : 0, pointerEvents: isDesktopPortal ? 'auto' : 'none', transition: 'opacity 450ms ease' }}>
        <div className="desk-chrome">
          <div className="desk-lights"><span className="desk-light r"/><span className="desk-light y"/><span className="desk-light g"/></div>
          <div className="desk-omnibox"><span className="lock">⬡</span> baywatch.os / {role?.id === 'MASTER' ? 'global' : (branch?.id || 'branch').toLowerCase()} <span style={{marginLeft:'auto',color:'var(--t-4)'}}>secure · jwt</span></div>
          <div className="desk-chrome-right"><Icon name="wifi" size={13}/><Icon name="cog" size={13}/></div>
        </div>
        <div className="desk-screen">
          {isDesktopPortal && role?.id === 'ADMIN' && branch && <AdminPortal branch={branch} onLogout={logout}/>}
          {isDesktopPortal && role?.id === 'MASTER' && <MasterPortal onLogout={logout}/>}
        </div>
      </div>
    </div>
  );
};

ReactDOM.createRoot(document.getElementById('root')).render(<App/>);

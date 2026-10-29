// Entry flow: Landing (branches) → Role select → Login
const { useState: useStateScr, useEffect: useEffectScr, useMemo: useMemoScr } = React;

// Branches are loaded from PostgreSQL via the public GET /api/v1/branches
// endpoint (the pre-login facility picker). Kept as an empty array only so
// any legacy `window.BRANCHES` reference resolves to [] instead of throwing —
// it is never a data source.
const BRANCHES = [];

const ROLES = [
  {
    id: 'WORKER',
    name: 'Worker',
    icon: 'wrench',
    desc: 'Execute service work in your assigned bay. Receive jobs, track the live timer, finish jobs.',
    caps: ['Receive job tasks', 'Live timer sync', 'Finish jobs', 'View attendance', 'Apply leave']
  },
  {
    id: 'ADMIN',
    name: 'Admin',
    icon: 'briefcase',
    desc: 'Branch-level control. Assign jobs to bays, drive timers and cameras, manage workers.',
    caps: ['Assign jobs to bays', 'Control timers', 'Manage workers', 'Approve leave', 'Branch reports']
  },
  {
    id: 'MASTER',
    name: 'Master Admin',
    icon: 'shield',
    desc: 'Global oversight. Provision admins, monitor every branch, approve inventory, view system analytics.',
    caps: ['All branches', 'Create admins', 'Global analytics', 'Inventory approval', 'System health']
  },
];

const Landing = ({ onSelect }) => {
  const now = useNow();
  // Facility list comes from PostgreSQL (public GET /api/v1/branches), not a
  // hardcoded array. Loaded once on mount; re-renders when the data arrives.
  const [branches, setBranches] = useStateScr([]);
  const [loading, setLoading] = useStateScr(true);
  const [err, setErr] = useStateScr('');
  useEffectScr(() => {
    let alive = true;
    BW_API.branches()
      .then(rows => { if (alive) { setBranches(Array.isArray(rows) ? rows : []); setLoading(false); } })
      .catch(() => { if (alive) { setErr('Unable to load facilities from the server.'); setLoading(false); } });
    return () => { alive = false; };
  }, []);
  const count = String(branches.length).padStart(2, '0');
  return (
    <div className="landing">
      <div className="landing-bg"/>
      <div className="landing-head">
        <div className="brand">
          <div className="brand-mark">B</div>
          <div>
            <div className="brand-name">BAYWATCH</div>
            <div className="brand-sub">Service Center OS · v4.2</div>
          </div>
        </div>
        <div className="row">
          <div className="chip ghost"><span className="dot live pulsing"/>SYSTEM ONLINE</div>
          <div className="chip ghost mono">{now.toUTCString().slice(17, 25)} UTC</div>
        </div>
      </div>

      <div>
        <div className="eyebrow eyebrow-amber" style={{marginBottom: 14}}>SELECT YOUR FACILITY · {count} BRANCHES</div>
        <h1 className="landing-title">Pick a service center<br/>to <span className="accent">clock in</span>.</h1>
        <p className="landing-sub">Every branch runs as an isolated tenant — your role, your jobs, your bays. Choose your post.</p>
      </div>

      {loading && <div className="landing-sub" style={{marginTop: 20}}>Loading facilities…</div>}
      {err && <div className="landing-sub" style={{marginTop: 20, color: 'var(--danger, #e66)'}}>{err}</div>}
      {!loading && !err && branches.length === 0 &&
        <div className="landing-sub" style={{marginTop: 20}}>No facilities are configured yet.</div>}

      <div className="branches">
        {branches.map((b, i) => (
          <div
            key={b.id}
            className="branch-card fade-up"
            style={{ animationDelay: `${i * 80 + 200}ms` }}
            onClick={() => onSelect(b)}
          >
            <div className="branch-grid"/>
            <div className="branch-orb"/>
            <div className="branch-meta">
              <span className="branch-id">{b.id}</span>
              <span className="chip ok"><span className="dot live pulsing"/>LIVE</span>
            </div>
            <div>
              <div className="branch-name">{b.name}</div>
              <div className="branch-region">{b.region}</div>
            </div>
            <div className="branch-stats">
              <div className="branch-stat"><span className="v">{b.bays}</span><span className="l">Bays</span></div>
              <div className="branch-stat"><span className="v">{b.workers}</span><span className="l">Crew</span></div>
              <div className="branch-stat"><span className="v">{b.jobs}</span><span className="l">Today</span></div>
            </div>
            <div className="branch-cta">
              ENTER FACILITY
              <span className="branch-cta-arrow"><Icon name="arrow-right" size={12}/></span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

const RoleSelect = ({ branch, onSelect, onBack }) => {
  return (
    <div className="role-screen">
      <div className="row" style={{justifyContent: 'space-between', alignItems: 'flex-start'}}>
        <div>
          <button className="back-btn" onClick={onBack}>
            <Icon name="arrow-left" size={12}/> BACK TO BRANCHES
          </button>
          <h1 className="landing-title" style={{fontSize: 56, marginTop: 24}}>
            <span style={{color: 'var(--t-3)', fontWeight: 400, fontSize: 24, display: 'block', marginBottom: 12, letterSpacing: '0.16em'}} className="mono">{branch.id}</span>
            {branch.name} · <span className="accent">Choose role</span>
          </h1>
        </div>
        <div className="brand">
          <div className="brand-mark">B</div>
          <div>
            <div className="brand-name">BAYWATCH</div>
            <div className="brand-sub">{branch.region}</div>
          </div>
        </div>
      </div>

      <div className="role-grid">
        {ROLES.map((r, i) => (
          <div
            key={r.id}
            className="role-card fade-up"
            style={{ animationDelay: `${i * 100 + 100}ms` }}
            onClick={() => onSelect(r)}
          >
            <div className="role-icon"><Icon name={r.icon} size={26}/></div>
            <div className="eyebrow eyebrow-amber" style={{marginBottom: 8}}>{r.id}</div>
            <h2 className="role-name">{r.name}</h2>
            <p className="role-desc">{r.desc}</p>
            <ul className="role-caps">
              {r.caps.map(c => <li key={c}>{c}</li>)}
            </ul>
            <div style={{marginTop: 18, display: 'flex', alignItems: 'center', justifyContent: 'space-between'}}>
              <span className="eyebrow">CONTINUE</span>
              <Icon name="arrow-right" size={14}/>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

const Login = ({ branch, role, onBack, onSubmit }) => {
  // No seeded/pre-filled credentials: operators type their real account, which
  // is validated against PostgreSQL (users table). There is no demo fallback.
  const [id, setId] = useStateScr('');
  const [pw, setPw] = useStateScr('');
  const [loading, setLoading] = useStateScr(false);
  const [error, setError] = useStateScr('');
  // Synchronous in-flight latch. `loading` drives the button spinner, but state
  // updates are async — a fast double-click or Enter+click could fire two
  // POST /auth/login in the same tick before the button disables. This ref
  // blocks the duplicate submit immediately (one click/Enter = one request).
  const submitting = React.useRef(false);

  const submit = async (e) => {
    e.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setError('');
    setLoading(true);
    // Backend login is the ONLY way in — PostgreSQL is the single source of truth.
    // There is no offline/demo fallback: if the backend is unreachable, sign-in fails.
    try {
      const res = await window.BW_API.login(id, pw);
      onSubmit({ id: res.user_id, branch, role, live: { id: res.user_id, name: res.name, role: res.role, branch_id: res.branch_id } });
    } catch (err) {
      // Failed attempt → clear any stale session so we never sit half-authenticated.
      try { window.BW_API.logout(); } catch (e2) {}
      setLoading(false);
      submitting.current = false;
      // One clear message: 401 = bad credentials; missing status = backend down.
      setError(
        err && err.status === 401 ? 'Invalid username or password'
        : err && err.status ? (err.message || 'Sign-in failed')
        : 'Sign-in failed — is the backend running?'
      );
    }
  };

  // cipher background
  const cipher = useMemoScr(() => {
    const chars = '01';
    return Array.from({length: 400}, () => chars[Math.floor(Math.random() * chars.length)]);
  }, []);

  return (
    <div className="login-screen">
      <div className="login-art">
        <div className="cipher-grid">
          {cipher.map((c, i) => <span key={i} style={{opacity: Math.random() * 0.5 + 0.05}}>{c}</span>)}
        </div>
        <div className="login-art-glow"/>
        <div style={{position: 'relative', zIndex: 2}}>
          <button className="back-btn" onClick={onBack}>
            <Icon name="arrow-left" size={12}/> CHANGE ROLE
          </button>
        </div>
        <div style={{position: 'relative', zIndex: 2}}>
          <div className="eyebrow eyebrow-amber" style={{marginBottom: 18}}>SECURE AUTH · TLS 1.3 · JWT</div>
          <div style={{fontSize: 56, fontWeight: 600, letterSpacing: '-0.035em', lineHeight: 1}}>
            Clock in.
          </div>
          <div style={{fontSize: 56, fontWeight: 600, letterSpacing: '-0.035em', lineHeight: 1, color: 'var(--amber)'}}>
            Get to work.
          </div>
          <div style={{marginTop: 24, color: 'var(--t-2)', maxWidth: 380, lineHeight: 1.5}}>
            Branch credentials are scoped to <strong style={{color: 'var(--t-0)'}}>{branch.name}</strong> only. All actions
            are logged and signed against your employee ID.
          </div>
        </div>
        <div style={{position: 'relative', zIndex: 2, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end'}}>
          <div className="mono" style={{fontSize: 11, color: 'var(--t-3)', letterSpacing: '0.16em'}}>SESSION ID · SES-{Math.random().toString(36).slice(2, 8).toUpperCase()}</div>
          <div className="mono" style={{fontSize: 11, color: 'var(--t-3)', letterSpacing: '0.16em'}}>NODE · {branch.id}</div>
        </div>
      </div>

      <form className="login-form" onSubmit={submit}>
        <button type="button" className="back-btn login-form-back" onClick={onBack}>
          <Icon name="arrow-left" size={12}/> BACK TO ROLE SELECT
        </button>
        <div className="eyebrow" style={{marginBottom: 6}}>SIGN IN · {role.name.toUpperCase()}</div>
        <h2 style={{fontSize: 36, fontWeight: 600, letterSpacing: '-0.03em', margin: '0 0 8px'}}>Authenticate</h2>
        <div className="muted" style={{marginBottom: 32, fontSize: 14}}>
          Logging in to <strong style={{color: 'var(--t-0)'}}>{branch.name}</strong> as <strong style={{color: 'var(--amber)'}}>{role.name}</strong>.
        </div>

        <div className="field">
          <label>Username</label>
          <input className="input" value={id} onChange={e => setId(e.target.value)} placeholder="e.g. admin / worker"/>
        </div>
        <div className="field">
          <label>Password</label>
          <input className="input" type="password" value={pw} onChange={e => setPw(e.target.value)}/>
        </div>

        <div className="row" style={{justifyContent: 'space-between', marginTop: 4, marginBottom: 24}}>
          <label className="row" style={{gap: 8, cursor: 'pointer'}}>
            <input type="checkbox" defaultChecked/>
            <span className="mono" style={{fontSize: 11, letterSpacing: '0.12em', color: 'var(--t-2)', textTransform: 'uppercase'}}>Keep me signed in</span>
          </label>
          <a className="mono" style={{fontSize: 11, letterSpacing: '0.12em', color: 'var(--amber)', textTransform: 'uppercase', textDecoration: 'none'}}>Reset PIN</a>
        </div>

        {error && <div className="mono" style={{marginBottom: 14, padding: '10px 12px', borderRadius: 9, background: 'rgba(244,63,94,0.12)', border: '1px solid rgba(244,63,94,0.3)', color: 'var(--danger)', fontSize: 12, letterSpacing: '0.04em'}}>⚠ {error}</div>}

        <button className="btn btn-amber btn-lg" type="submit" disabled={loading} style={{width: '100%'}}>
          {loading ? (
            <>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{animation: 'spin 0.8s linear infinite'}}>
                <path d="M21 12a9 9 0 11-6.2-8.5"/>
              </svg>
              AUTHENTICATING...
            </>
          ) : (
            <>SIGN IN <Icon name="arrow-right" size={14}/></>
          )}
        </button>

        <div className="row" style={{marginTop: 24, gap: 12}}>
          <div className="chip ok"><span className="dot live"/>JWT READY</div>
          <div className="chip ghost mono">SSO · BIOMETRIC</div>
          <div className="chip ghost mono">VPN · OK</div>
        </div>
      </form>

      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
};

Object.assign(window, { Landing, RoleSelect, Login, BRANCHES, ROLES });

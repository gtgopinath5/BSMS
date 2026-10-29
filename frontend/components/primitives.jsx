// Bike silhouette + sparkline for various screens
const { useState, useEffect, useRef, useMemo } = React;

// Bike silhouette in the camera feed
const BikeSilhouette = () => (
  <svg viewBox="0 0 400 200" className="feed-bike" preserveAspectRatio="xMidYMid meet">
    <defs>
      <linearGradient id="bikeGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#1a1a22"/>
        <stop offset="100%" stopColor="#0a0a0c"/>
      </linearGradient>
    </defs>
    {/* shadow */}
    <ellipse cx="200" cy="185" rx="170" ry="6" fill="#000" opacity="0.6"/>

    {/* rear wheel */}
    <circle cx="80" cy="140" r="42" fill="none" stroke="#ff6b1a" strokeWidth="2" opacity="0.5"/>
    <circle cx="80" cy="140" r="42" fill="#0a0a0c" opacity="0.4"/>
    <circle cx="80" cy="140" r="14" fill="none" stroke="#888" strokeWidth="1.5"/>
    {Array.from({length: 8}, (_, i) => {
      const a = (i * Math.PI * 2) / 8;
      return <line key={i} x1={80} y1={140} x2={80 + Math.cos(a)*40} y2={140 + Math.sin(a)*40} stroke="#444" strokeWidth="0.8"/>;
    })}

    {/* front wheel */}
    <circle cx="320" cy="140" r="42" fill="none" stroke="#ff6b1a" strokeWidth="2" opacity="0.5"/>
    <circle cx="320" cy="140" r="42" fill="#0a0a0c" opacity="0.4"/>
    <circle cx="320" cy="140" r="14" fill="none" stroke="#888" strokeWidth="1.5"/>
    {Array.from({length: 8}, (_, i) => {
      const a = (i * Math.PI * 2) / 8;
      return <line key={i} x1={320} y1={140} x2={320 + Math.cos(a)*40} y2={140 + Math.sin(a)*40} stroke="#444" strokeWidth="0.8"/>;
    })}

    {/* frame */}
    <path d="M 80 140 L 160 70 L 240 70 L 320 140 L 240 130 L 200 110 L 160 130 Z" fill="url(#bikeGrad)" stroke="#666" strokeWidth="1.2"/>
    {/* fuel tank */}
    <path d="M 160 70 L 240 70 L 250 95 L 170 95 Z" fill="#1a1a22" stroke="#888" strokeWidth="1.2"/>
    {/* engine block */}
    <rect x="180" y="100" width="50" height="30" rx="3" fill="#222" stroke="#ff6b1a" strokeWidth="1.5" opacity="0.8"/>
    <line x1="190" y1="105" x2="190" y2="125" stroke="#ff8a3d" strokeWidth="1.2" opacity="0.9"/>
    <line x1="200" y1="105" x2="200" y2="125" stroke="#ff8a3d" strokeWidth="1.2" opacity="0.9"/>
    <line x1="210" y1="105" x2="210" y2="125" stroke="#ff8a3d" strokeWidth="1.2" opacity="0.9"/>
    <line x1="220" y1="105" x2="220" y2="125" stroke="#ff8a3d" strokeWidth="1.2" opacity="0.9"/>

    {/* handlebars */}
    <line x1="240" y1="70" x2="270" y2="50" stroke="#888" strokeWidth="2"/>
    <line x1="280" y1="45" x2="260" y2="55" stroke="#888" strokeWidth="2"/>
    {/* seat */}
    <path d="M 130 75 L 165 70 L 170 80 L 135 85 Z" fill="#0a0a0c" stroke="#666" strokeWidth="1"/>
    {/* exhaust */}
    <line x1="240" y1="125" x2="320" y2="135" stroke="#888" strokeWidth="3"/>
  </svg>
);

// Mini SVG sparkline
const Sparkline = ({ data, color = '#ff6b1a', height = 36 }) => {
  const w = 160;
  const h = height;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const step = w / (data.length - 1);
  const points = data.map((v, i) => `${i * step},${h - ((v - min) / range) * (h - 4) - 2}`).join(' ');
  const last = data[data.length - 1];
  const lastY = h - ((last - min) / range) * (h - 4) - 2;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="sparkline" preserveAspectRatio="none">
      <defs>
        <linearGradient id={`sg-${color}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35"/>
          <stop offset="100%" stopColor={color} stopOpacity="0"/>
        </linearGradient>
      </defs>
      <polygon points={`0,${h} ${points} ${w},${h}`} fill={`url(#sg-${color})`}/>
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke"/>
      <circle cx={w} cy={lastY} r="2.5" fill={color}/>
    </svg>
  );
};

// HUD crosshair
const Crosshair = () => (
  <svg viewBox="0 0 80 80" className="hud-crosshair">
    <circle cx="40" cy="40" r="32" fill="none" stroke="#fff" strokeWidth="0.8" strokeDasharray="2 4"/>
    <circle cx="40" cy="40" r="20" fill="none" stroke="#fff" strokeWidth="0.6"/>
    <line x1="40" y1="6" x2="40" y2="20" stroke="#fff" strokeWidth="0.8"/>
    <line x1="40" y1="60" x2="40" y2="74" stroke="#fff" strokeWidth="0.8"/>
    <line x1="6" y1="40" x2="20" y2="40" stroke="#fff" strokeWidth="0.8"/>
    <line x1="60" y1="40" x2="74" y2="40" stroke="#fff" strokeWidth="0.8"/>
    <circle cx="40" cy="40" r="1.5" fill="#ff6b1a"/>
  </svg>
);

// Animated number ticker — counts up to target on mount/change
const Ticker = ({ value, decimals = 0, duration = 1200, suffix = '' }) => {
  const [v, setV] = useState(0);
  const startRef = useRef(0);
  const prevRef = useRef(0);
  useEffect(() => {
    const from = prevRef.current;
    const to = value;
    const start = performance.now();
    let raf;
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setV(from + (to - from) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
      else prevRef.current = to;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <span>{v.toFixed(decimals)}{suffix}</span>;
};

// Live clock
const useNow = () => {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
};

// Viewport mode hook — mobile / tablet / desktop
const useViewport = () => {
  const get = () => {
    const w = window.innerWidth;
    return { w, mobile: w < 640, tablet: w >= 640 && w < 1024, desktop: w >= 1024 };
  };
  const [vp, setVp] = useState(get());
  useEffect(() => {
    const on = () => setVp(get());
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return vp;
};

// ── Global standardized Logout button + confirmation ───────
const LogoutButton = ({ onLogout, compact }) => {
  const [ask, setAsk] = useState(false);
  return (
    <>
      <button className={`logout-btn ${compact?'compact':''}`} onClick={()=>setAsk(true)} title="Logout">
        <Icon name="logout" size={compact?15:14}/>
        {!compact && <span>Logout</span>}
      </button>
      {ask && (
        <div className="modal-scrim" onClick={()=>setAsk(false)} style={{zIndex:300}}>
          <div className="logout-modal" onClick={e=>e.stopPropagation()}>
            <div className="logout-modal-ico"><Icon name="logout" size={26}/></div>
            <div className="logout-modal-title">Are you sure you want to logout?</div>
            <div className="logout-modal-sub">You'll be returned to the facility selection screen. Any unsaved changes will be lost.</div>
            <div className="logout-modal-actions">
              <button className="btn btn-ghost" onClick={()=>setAsk(false)}>CANCEL</button>
              <button className="logout-confirm-btn" onClick={()=>{ setAsk(false); onLogout && onLogout(); }}>
                <Icon name="logout" size={15}/> LOGOUT
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

// ── Advanced countdown timer logic (shared: worker view + admin control) ──
// elapsedSec counts UP from 0; we derive a countdown from the estimate.
// Color zones are based on % of estimated time REMAINING:
//   Green  (On Schedule): 67–100%   Orange (At Risk): 34–66%
//   Red    (Critical):     0–33%    Overtime: negative, stays Red
function timerState(elapsedSec, estimateMin) {
  const totalSec = Math.max(1, Math.round(estimateMin * 60));
  const remaining = totalSec - elapsedSec;        // negative once in overtime
  const overtime = remaining < 0;
  const pctRemaining = (remaining / totalSec) * 100;
  let zone, label, color;
  if (overtime)            { zone = 'overtime'; label = 'Overtime';    color = 'var(--danger)'; }
  else if (pctRemaining >= 67) { zone = 'safe';     label = 'On Schedule'; color = 'var(--ok)'; }
  else if (pctRemaining >= 34) { zone = 'warning';  label = 'At Risk';     color = 'var(--warn)'; }
  else                     { zone = 'critical'; label = 'Critical';    color = 'var(--danger)'; }
  const absR = Math.abs(remaining);
  const mm = String(Math.floor(absR / 60)).padStart(2, '0');
  const ss = String(Math.floor(absR % 60)).padStart(2, '0');
  const display = (overtime ? '−' : '') + mm + ':' + ss;
  const overtimeBy = overtime ? absR : 0;
  const fillPct = Math.max(0, Math.min(100, (remaining / totalSec) * 100)); // remaining bar (drains)
  return { totalSec, remaining, overtime, overtimeBy, pctRemaining, zone, label, color, display, mm, ss, fillPct };
}

Object.assign(window, { BikeSilhouette, Sparkline, Crosshair, Ticker, useNow, useViewport, LogoutButton, timerState });


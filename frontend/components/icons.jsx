// Inline SVG icon set — stroke-based, industrial
const Icon = ({ name, size = 16, stroke = 1.6, ...rest }) => {
  const s = size;
  const props = {
    width: s,
    height: s,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: stroke,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    ...rest,
  };
  switch (name) {
    case 'arrow-right':
      return (<svg {...props}><path d="M5 12h14"/><path d="M13 6l6 6-6 6"/></svg>);
    case 'arrow-left':
      return (<svg {...props}><path d="M19 12H5"/><path d="M11 6l-6 6 6 6"/></svg>);
    case 'check':
      return (<svg {...props}><path d="M4 12l5 5L20 6"/></svg>);
    case 'flag':
      return (<svg {...props}><path d="M5 21V4"/><path d="M5 4h13l-3 4 3 4H5"/></svg>);
    case 'pause':
      return (<svg {...props}><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>);
    case 'play':
      return (<svg {...props}><path d="M7 5v14l12-7z"/></svg>);
    case 'stop':
      return (<svg {...props}><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>);
    case 'cam':
      return (<svg {...props}><rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3z"/></svg>);
    case 'clock':
      return (<svg {...props}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>);
    case 'pin':
      return (<svg {...props}><path d="M12 22s7-7 7-12a7 7 0 10-14 0c0 5 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/></svg>);
    case 'logout':
      return (<svg {...props}><path d="M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3"/><path d="M10 17l-5-5 5-5"/><path d="M5 12h12"/></svg>);
    case 'briefcase':
      return (<svg {...props}><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2"/><path d="M3 13h18"/></svg>);
    case 'user':
      return (<svg {...props}><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-7 8-7s8 3 8 7"/></svg>);
    case 'calendar':
      return (<svg {...props}><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 9h18"/><path d="M8 3v4M16 3v4"/></svg>);
    case 'history':
      return (<svg {...props}><path d="M3 12a9 9 0 109-9 9 9 0 00-6.3 2.6L3 8"/><path d="M3 4v4h4"/><path d="M12 8v4l3 2"/></svg>);
    case 'wrench':
      return (<svg {...props}><path d="M14.7 6.3a4 4 0 015 5L17 14l3 3-3 3-3-3-2.7 2.7a4 4 0 01-5-5L9 12 6 9 9 6l3 3z"/></svg>);
    case 'bolt':
      return (<svg {...props}><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>);
    case 'shield':
      return (<svg {...props}><path d="M12 3l8 3v6c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V6z"/></svg>);
    case 'gauge':
      return (<svg {...props}><path d="M12 14l4-4"/><circle cx="12" cy="13" r="9"/><path d="M3 13h2M19 13h2M12 4v2"/></svg>);
    case 'queue':
      return (<svg {...props}><path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h10"/></svg>);
    case 'wifi':
      return (<svg {...props}><path d="M5 12a10 10 0 0114 0"/><path d="M8.5 15.5a5 5 0 017 0"/><circle cx="12" cy="19" r="1"/></svg>);
    case 'bell':
      return (<svg {...props}><path d="M6 9a6 6 0 1112 0c0 6 3 7 3 7H3s3-1 3-7z"/><path d="M10 21a2 2 0 004 0"/></svg>);
    case 'phone':
      return (<svg {...props}><path d="M22 17v3a2 2 0 01-2 2 19 19 0 01-17-17 2 2 0 012-2h3l2 5-2 1a12 12 0 006 6l1-2 5 2z"/></svg>);
    case 'mail':
      return (<svg {...props}><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 7 9-7"/></svg>);
    case 'plus':
      return (<svg {...props}><path d="M12 5v14M5 12h14"/></svg>);
    case 'sparkle':
      return (<svg {...props}><path d="M12 3l1.5 5L19 9.5 13.5 11 12 16l-1.5-5L5 9.5 10.5 8z"/></svg>);
    case 'bike':
      return (
        <svg {...props}>
          <circle cx="5" cy="17" r="3.5"/>
          <circle cx="19" cy="17" r="3.5"/>
          <path d="M5 17l4-7h6l3 7"/>
          <path d="M9 10l-2-3h3"/>
          <path d="M15 10l-1-3h3"/>
        </svg>
      );
    case 'chevron-right':
      return (<svg {...props}><path d="M9 6l6 6-6 6"/></svg>);
    case 'chevron-down':
      return (<svg {...props}><path d="M6 9l6 6 6-6"/></svg>);
    case 'tools':
      return (<svg {...props}><path d="M3 21l8-8"/><path d="M14 3l7 7-3 3-7-7zM10 7L7 4 4 7l3 3"/></svg>);
    case 'cog':
      return (<svg {...props}><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>);
    case 'upload':
      return (<svg {...props}><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><path d="M12 3v13"/><path d="M7 8l5-5 5 5"/></svg>);
    case 'file':
      return (<svg {...props}><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h6"/></svg>);
    case 'scan':
      return (<svg {...props}><path d="M3 7V5a2 2 0 012-2h2M17 3h2a2 2 0 012 2v2M21 17v2a2 2 0 01-2 2h-2M7 21H5a2 2 0 01-2-2v-2"/><path d="M3 12h18"/></svg>);
    case 'edit':
      return (<svg {...props}><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.1 2.1 0 013 3L12 15l-4 1 1-4z"/></svg>);
    case 'x':
      return (<svg {...props}><path d="M18 6L6 18M6 6l12 12"/></svg>);
    case 'alert':
      return (<svg {...props}><path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L14.4 3.9a2 2 0 00-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>);
    case 'card':
      return (<svg {...props}><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h4"/></svg>);
    case 'route':
      return (<svg {...props}><circle cx="6" cy="19" r="3"/><circle cx="18" cy="5" r="3"/><path d="M9 19h6a4 4 0 000-8H9a4 4 0 010-8h6"/></svg>);
    case 'dots':
      return (<svg {...props}><circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/></svg>);
    case 'chevron-up':
      return (<svg {...props}><path d="M6 15l6-6 6 6"/></svg>);
    case 'arrow-up':
      return (<svg {...props}><path d="M12 19V5"/><path d="M6 11l6-6 6 6"/></svg>);
    case 'arrow-down':
      return (<svg {...props}><path d="M12 5v14"/><path d="M6 13l6 6 6-6"/></svg>);
    case 'clipboard':
      return (<svg {...props}><rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4a2 2 0 012-2h2a2 2 0 012 2v1H9z"/><path d="M9 11h6M9 15h4"/></svg>);
    case 'car':
      return (<svg {...props}><path d="M3 13l2-5a2 2 0 012-1.4h10A2 2 0 0119 8l2 5"/><path d="M3 13h18v4a1 1 0 01-1 1h-1a1 1 0 01-1-1v-1H6v1a1 1 0 01-1 1H4a1 1 0 01-1-1z"/><circle cx="7.5" cy="15.5" r="1"/><circle cx="16.5" cy="15.5" r="1"/></svg>);
    case 'trash':
      return (<svg {...props}><path d="M4 7h16"/><path d="M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2"/><path d="M6 7l1 13a1 1 0 001 1h8a1 1 0 001-1l1-13"/><path d="M10 11v6M14 11v6"/></svg>);
    case 'mic':
      return (<svg {...props}><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0"/><path d="M12 18v3M9 21h6"/></svg>);
    case 'image':
      return (<svg {...props}><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 16l-5-5L5 20"/></svg>);
    default:
      return null;
  }
};

window.Icon = Icon;

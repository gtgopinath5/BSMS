// ============================================================
//  Shared client-side xlsx parser for the (live) Parts Time
//  import flow. The former localStorage-backed PartsStore demo
//  store and its useParts() hook were REMOVED — live parts data
//  is owned by PostgreSQL (parts_master) and read/written via
//  BW_API. Only the SheetJS extractor remains here, used by
//  extractFile() → LiveImportModal → BW_API.partsImportRows.
// ============================================================

// ── SheetJS-powered xlsx extractor ─────────────────────────
async function readXlsx(file){
  if(!window.XLSX) throw new Error('SheetJS not loaded');
  const buf = await file.arrayBuffer();
  const wb = window.XLSX.read(buf, { type:'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw = window.XLSX.utils.sheet_to_json(ws, { header:1, defval:'' });
  if(!raw.length) return [];
  // Find header row (first row with 3+ non-empty cells)
  let hdrIdx=0;
  for(let i=0;i<Math.min(raw.length,10);i++){
    if(raw[i].filter(x=>String(x).trim()).length>=3){ hdrIdx=i; break; }
  }
  const hdr = raw[hdrIdx].map(x=>String(x).toLowerCase().trim());
  const col = (kws) => { for(const kw of kws){ const i=hdr.findIndex(h=>h.includes(kw)); if(i>=0) return i; } return -1; };
  const iMat  = col(['material'])   !== -1 ? col(['material']) : 0;
  const iDesc = col(['description','name','desc']) !== -1 ? col(['description','name','desc']) : 1;
  const iUnit = col(['labour','unit','time','ltu']) !== -1 ? col(['labour','unit','time','ltu']) : 2;
  const iModel= col(['model','vehicle'])  !== -1 ? col(['model','vehicle']) : -1;
  const iCode = col(['product','code','pg']) !== -1 ? col(['product','code','pg']) : -1;
  // If col 'material' also matched description, find exact
  const exactMat  = hdr.findIndex(h=>h==='material');
  const exactDesc = hdr.findIndex(h=>h==='material description'||h==='description');
  const fMat  = exactMat >= 0 ? exactMat : iMat;
  const fDesc = exactDesc >= 0 ? exactDesc : iDesc;
  return raw.slice(hdrIdx+1)
    .filter(r => String(r[fMat]||'').trim())
    .map(r => ({
      pn:    String(r[fMat]||'').trim(),
      name:  String(r[fDesc]||'').trim().replace(/\s+/g,' '),
      units: parseFloat(r[iUnit])||1,
      model: iModel>=0 ? String(r[iModel]||'').trim() : '',
      code:  iCode>=0  ? String(r[iCode]||'').trim()  : '',
    }));
}
window.readXlsx = readXlsx;

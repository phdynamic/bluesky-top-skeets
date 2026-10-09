// Saved game: shows a stored copy of a quote post game (from /api/games/..., this server only) in the
// Tracer's viewer, in saved mode. It makes no request to Bluesky or anyone else; the page's security
// policy forbids it. Text only: no avatars, no media.
(function(){
'use strict';
if(document.body.dataset.mode!=='saved') return;
const V=window.TracerViewer; V.init({mode:'saved'});
const $=s=>document.querySelector(s);
const fmtN=n=>Number(n).toLocaleString();
const gameId=document.body.dataset.game||'';
const wanted=document.body.dataset.version?parseInt(document.body.dataset.version,10):null;
const when=ms=>{ try{ return new Date(ms).toLocaleString([],{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'}) }catch(e){ return '' } };
const FROZEN='This game is frozen by the person who wrote the original post. It can still be viewed.';
function duration(sec){
  if(sec<90) return Math.max(1,Math.round(sec))+' seconds';
  const m=Math.round(sec/60); if(m<90) return m+' minutes';
  const h=sec/3600; return (h>=10?Math.round(h):Math.round(h*10)/10)+' hours';
}
const api=(path,opts)=>fetch('/api/games/'+gameId+path,Object.assign({headers:{accept:'application/json'}},opts||{}));
document.title='Saved game · Quote Post Game Tracer';

let status=null, pollTimer=null, tickTimer=null, secondsLeft=0;

function unavailable(){
  $('#snapLoading').hidden=true; $('#snapReady').hidden=true;
  const e=$('#snapError'); e.textContent="This game isn't available."; e.hidden=false;
  $('#result').hidden=true;
}
function setStatusLine(text,pct){
  $('#snapLoading').hidden=false; $('#snapStatus').textContent=text;
  const bar=$('#snapBar'); bar.hidden=pct==null; if(pct!=null) $('#snapFill').style.width=pct+'%';
}
function activeText(st){
  const n=fmtN(st.quotesFound);
  if(st.kind==='refresh') return 'Refreshing… '+n+' quote'+(st.quotesFound===1?'':'s')+' so far. You can close this page and come back to this link.';
  if(st.queuedAhead>0) return 'In line to be saved ('+st.queuedAhead+' ahead). You can close this page and come back to this link.';
  return 'Taking the snapshot. You can close this page and come back to this link. '+n+' quote'+(st.quotesFound===1?'':'s')+' found so far.';
}

function renderRefresh(){
  const btn=$('#refreshBtn'), note=$('#refreshNote');
  const st=status, onLatest=st.latest&&(!wanted||wanted===st.latest.n);
  btn.hidden=false; btn.disabled=true; note.textContent='';
  if(!onLatest){ btn.hidden=true; return }
  if(st.frozen){ btn.hidden=true; note.textContent=FROZEN; return }
  if(st.state==='queued'||st.state==='crawling'){ note.textContent=activeText(st); return }
  if(secondsLeft>0){ note.textContent='You can refresh again in '+duration(secondsLeft)+'.'; return }
  btn.disabled=false;
}
function tickCooldown(){
  if(secondsLeft<=0) return;
  secondsLeft=Math.max(0,secondsLeft-30);
  if(status) renderRefresh();
}
function renderBanner(d){
  const v=d.version, quotes=Math.max(0,v.nodeCount-1);
  $('#snapLine').textContent='Version '+v.n+', captured '+when(v.capturedAt)+'. '+fmtN(quotes)+' quote'+(quotes===1?'':'s')+', '+v.maxDepth+' level'+(v.maxDepth===1?'':'s')+' deep. Public posts only. Some posts may be missing.';
  const warn=$('#snapWarn'), bits=[];
  if(v.status==='partial'){
    bits.push(v.partialReason==='size cap reached'?'This snapshot stopped at '+fmtN(quotes)+' quotes. Refresh later to keep going.':'This snapshot is incomplete ('+(v.partialReason||'it stopped early')+'). Refresh to try again.');
  }
  if(v.missing>0) bits.push('At least '+fmtN(v.missing)+' more quote'+(v.missing===1?' is':'s are')+' counted by Bluesky but not in this copy (deleted, hidden, or not visible to logged-out viewers).');
  warn.textContent=bits.join(' '); warn.hidden=bits.length===0;
}
function renderVersions(){
  const sel=$('#versionPick'); sel.textContent='';
  const vs=status.versions||[], latest=status.latest?status.latest.n:0;
  const cur=wanted||latest;
  vs.forEach(v=>{
    const o=document.createElement('option'); o.value=String(v.n);
    const added=v.n===1?fmtN(Math.max(0,v.nodeCount-1))+' quotes':(v.added>=0?'+':'')+fmtN(v.added)+' quotes';
    o.textContent='Version '+v.n+' · '+when(v.capturedAt)+' · '+added+(v.status==='partial'?' · partial':'');
    if(v.n===cur) o.selected=true; sel.appendChild(o);
  });
  sel.onchange=()=>{ const n=parseInt(sel.value,10); location.href=n===latest?'/g/'+gameId:'/g/'+gameId+'/v/'+n };
  sel.disabled=vs.length<2;
  const note=$('#snapLatest');
  if(wanted&&wanted!==latest){ note.innerHTML=''; note.append('You are looking at an older version. '); const a=document.createElement('a'); a.href='/g/'+gameId; a.textContent='See the latest (version '+latest+')'; note.append(a,'.'); note.hidden=false }
  else note.hidden=true;
}

// ---------- report and re-check ----------
if(document.body.dataset.signin==='1') $('#signinLinks').hidden=false;
let currentVersion=null;
const rdlg=$('#reportDlg');
function openReport(pos){
  rdlg.dataset.pos=pos==null?'':String(pos);
  const n=pos==null?null:V.nodes()[pos];
  $('#reportAbout').textContent=pos==null?'You are reporting this whole game.':'You are reporting one card'+(n&&!n.tomb?' by @'+n.h:'')+' in this game.';
  document.querySelectorAll('input[name=reason]').forEach(r=>{ r.checked=false });
  $('#reportNote').value=''; $('#reportErr').hidden=true; $('#reportOk').hidden=true; $('#removalHint').hidden=true; $('#reportSend').disabled=false;
  rdlg.showModal();
}
V.onReport(i=>openReport(i));
$('#reportGame').onclick=()=>openReport(null);
document.querySelectorAll('input[name=reason]').forEach(r=>r.addEventListener('change',()=>{ $('#removalHint').hidden=!($('input[name=reason]:checked')&&$('input[name=reason]:checked').value==='removal') }));
$('#reportCancel').onclick=()=>rdlg.close(); $('#reportX').onclick=()=>rdlg.close();
rdlg.addEventListener('click',e=>{ if(e.target===rdlg) rdlg.close() });
$('#reportSend').onclick=async()=>{
  const reason=$('input[name=reason]:checked'); const err=$('#reportErr'); err.hidden=true;
  if(!reason){ err.textContent='Pick a reason for the report.'; err.hidden=false; return }
  const body={reason:reason.value,note:$('#reportNote').value};
  if(rdlg.dataset.pos!==''&&currentVersion){ body.pos=parseInt(rdlg.dataset.pos,10); body.version=currentVersion }
  $('#reportSend').disabled=true;
  try{
    const res=await api('/report',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    const j=await res.json().catch(()=>({}));
    if(res.ok){ $('#reportOk').textContent=j.message||"Thanks. We've got it."; $('#reportOk').hidden=false; return }
    err.textContent=j.message||'Something went wrong. Try again in a minute.'; err.hidden=false; $('#reportSend').disabled=false;
  }catch(e){ err.textContent="Couldn't reach the server. Try again in a minute."; err.hidden=false; $('#reportSend').disabled=false }
};
$('#recheckBtn').onclick=async()=>{
  const note=$('#recheckNote'); note.textContent='';
  try{
    const res=await api('/recheck',{method:'POST'}); const j=await res.json().catch(()=>({}));
    note.textContent=res.status===202?(j.message||'Checking.'):res.ok&&j.status==='running'?'A check is already running.':(j.message||'Something went wrong. Try again in a minute.');
  }catch(e){ note.textContent="Couldn't reach the server. Try again in a minute." }
};

function showTree(d){
  V.reset();
  const rows=d.nodes;
  for(let i=0;i<rows.length;i++){
    const r=rows[i], parent=r.p>=0?V.nodes()[r.p]:null;
    V.add(r.tomb
      ?{tomb:r.tomb}
      :{uri:'',k:r.k||'',h:r.h||'unknown',did:r.did||'',dn:r.dn||'',av:'',d:r.d||'',t:r.t||'',qc:typeof r.qc==='number'?r.qc:-1,media:null},parent);
  }
  V.defaultOpen(1); $('#result').hidden=false; V.renderRoot(); V.renderAll();
}

async function loadData(){
  const res=await api(wanted?'/v/'+wanted+'/data.json':'/data.json');
  if(res.status===404) return unavailable();
  if(res.status===409) return poll();
  if(!res.ok) { setStatusLine("We couldn't load this game right now. Try again in a minute."); return }
  const d=await res.json();
  $('#snapLoading').hidden=true; $('#snapReady').hidden=false;
  currentVersion=d.version.n;
  renderBanner(d); renderVersions(); renderRefresh(); showTree(d);
  document.title='Saved game (version '+d.version.n+') · Quote Post Game Tracer';
  try{ if(sessionStorage.getItem('kiosk-saved-note')==='exists'){ sessionStorage.removeItem('kiosk-saved-note'); const e=$('#snapExists'); e.textContent='This game already has a snapshot. Here it is.'; e.hidden=false } }catch(e){}
  if(status.state==='queued'||status.state==='crawling') poll();
}

async function refreshStatus(){
  const res=await api('/status');
  if(res.status===404){ unavailable(); return null }
  status=await res.json(); secondsLeft=status.refresh?status.refresh.secondsLeft:0;
  return status;
}
function poll(){
  clearTimeout(pollTimer);
  pollTimer=setTimeout(async()=>{
    let st; try{ st=await refreshStatus() }catch(e){ poll(); return }
    if(!st) return;
    if(st.state==='ready'){
      if(!$('#snapReady').hidden||st.latest){ location.reload(); return }   // finished: show the new version
    }
    if(st.state==='failed'&&!st.latest){ setStatusLine("We couldn't take this snapshot. Go back to the Tracer and try saving it again."); return }
    if(st.state==='queued'||st.state==='crawling'){
      if($('#snapReady').hidden) setStatusLine(activeText(st)); else renderRefresh();
    }
    poll();
  },2000);
}

$('#refreshBtn').onclick=async()=>{
  const btn=$('#refreshBtn'), note=$('#refreshNote'); btn.disabled=true;
  try{
    const res=await api('/refresh',{method:'POST'});
    const j=await res.json().catch(()=>({}));
    if(res.status===202||(res.ok&&j.status==='running')){ await refreshStatus(); renderRefresh(); poll(); return }
    note.textContent=j.message||'Something went wrong. Try again in a minute.';
    if(res.status===429&&j.secondsLeft) secondsLeft=j.secondsLeft;
  }catch(e){ note.textContent="Couldn't reach the server. Try again in a minute." }
};

(async function start(){
  if(!gameId) return unavailable();
  setStatusLine('Loading…');
  let st; try{ st=await refreshStatus() }catch(e){ setStatusLine("We couldn't load this game right now. Try again in a minute."); return }
  if(!st) return;
  tickTimer=setInterval(tickCooldown,30000);
  if(!st.latest){
    if(st.state==='failed'){ setStatusLine("We couldn't take this snapshot. Go back to the Tracer and try saving it again."); return }
    setStatusLine(activeText(st)); poll(); return;
  }
  loadData();
})();
})();

// Tracer viewer: shows a tree of quote posts and everything you can do with it (fold, search, lineage,
// leaderboards, keyboard shortcuts). It knows nothing about where the nodes came from: the live
// crawler (tracer-live.js) feeds it while tracing, and saved games feed it stored nodes. It makes no
// network requests of its own.
//
// Modes: 'live'  = avatars and media come from Bluesky's CDN (as the live Tracer always showed);
//        'saved' = initials only, no images, nothing loaded from anywhere.
//
// A node: { i, p, uri, k, h, did, dn, av, d, t, qc, media, kids, cnt, dep } (+ the crawler's cursor,
// exhausted). A tombstone has `tomb: 'deleted' | 'removed' | 'label'` instead of a handle, text and
// date; it keeps its place and its children.
window.TracerViewer=(function(){
'use strict';
const $=s=>document.querySelector(s);
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtN=n=>Number(n).toLocaleString();
const hue=h=>{let x=0;for(const c of String(h))x=(x*31+c.charCodeAt(0))%360;return x};
const avThumb=u=>u.replace('/img/avatar/','/img/avatar_thumbnail/');

let mode='live';
// ---------- theme ----------
function applyThemeIcon(){$('#themeToggle').textContent=document.documentElement.getAttribute('data-theme')==='dark'?'☀️ Day mode':'🌙 Night mode'}
$('#themeToggle').onclick=()=>{
  const dark=document.documentElement.getAttribute('data-theme')==='dark';
  if(dark)document.documentElement.removeAttribute('data-theme');else document.documentElement.setAttribute('data-theme','dark');
  try{localStorage.setItem('theme',dark?'light':'dark')}catch(e){}
  applyThemeIcon();
};
applyThemeIcon();

// ---------- state ----------
let N=[];            // node 0 is the original post; the rest are quotes
let maxDep=0, lastRendered=0, hashDone=false;
const people=new Set();
const state={view:'exp',q:'',sort:'old',open:new Set()};
let hits=null,desc=null;

const postLink=n=>'https://bsky.app/profile/'+encodeURIComponent(n.did||n.h)+'/post/'+encodeURIComponent(n.k);

// Appends a node and keeps the tree's bookkeeping (index, parent, depth, child lists, how many
// quotes sit below each ancestor, who has contributed, how deep it goes).
function add(fields,parent){
  const i=N.length;
  const n=Object.assign({kids:[],cnt:0,cursor:'',exhausted:false},fields,{i,p:parent?parent.i:-1,dep:parent?parent.dep+1:0});
  N.push(n);
  if(parent){
    parent.kids.push(i); for(let a=parent;a;a=a.p>=0?N[a.p]:null) a.cnt++;
    if(!n.tomb) people.add(n.did||n.h);
    if(n.dep>maxDep) maxDep=n.dep;
  }
  return n;
}
function reset(){
  N=[]; maxDep=0; lastRendered=0; hashDone=false; hits=null; desc=null; people.clear();
  state.open=new Set(); state.q=''; $('#q').value='';
  $('#result').hidden=true; $('#tree').innerHTML=''; $('#rootcard').innerHTML=''; $('#trace').classList.remove('on');
}

// ---------- rendering ----------
function renderRoot(){
  const n=N[0]; if(!n) return;
  $('#rootcard').innerHTML='<p class="rootlabel">Original post</p>'+cardHTML(n,true);
}
function defaultOpen(maxd){ state.open=new Set(); N.forEach(n=>{ if(n.kids.length&&n.dep<maxd) state.open.add(n.i) }) }
function sortedKids(list){
  const a=list.slice();
  if(state.sort==='big') a.sort((x,y)=>N[y].cnt-N[x].cnt);
  else a.sort((x,y)=>{ const dx=N[x].d,dy=N[y].d; if(!dx||!dy) return x-y;   // a tombstone has no date: keep it where it was added
    return dx<dy?-1:dx>dy?1:x-y });
  return a;
}
function computeSearch(){
  hits=null;desc=null;
  const q=state.q.trim().toLowerCase(); if(!q) return;
  hits=new Set();desc=new Set();
  N.forEach(n=>{ if(n.i>0&&!n.tomb&&(n.h.toLowerCase().includes(q)||n.dn.toLowerCase().includes(q)||n.t.toLowerCase().includes(q))) hits.add(n.i) });
  hits.forEach(i=>{ let p=N[i].p; while(p>0){ if(desc.has(p)) break; desc.add(p); p=N[p].p } });
}
function hl(t){
  let s=esc(t); const q=state.q.trim(); if(!q) return s;
  const re=new RegExp(esc(q).replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'gi');
  return s.replace(re,m=>'<mark>'+m+'</mark>');
}
const visible=i=>hits?(hits.has(i)||desc.has(i)):true;
const dayOf=n=>N[0].d&&n.d?Math.max(1,Math.floor((Date.parse(n.d)-Date.parse(N[0].d))/864e5)+1):1;
const fmtDate=d=>{ try{ return new Date(d).toLocaleString([],{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'}) }catch(e){ return d } };
function mediaHTML(m,link){
  if(!m) return '';
  if(m.type==='images') return '<div class="imgs n'+m.images.length+'">'+m.images.map(x=>'<a href="'+esc(x.full)+'" target="_blank" rel="noopener"><img loading="lazy" src="'+esc(x.thumb)+'" alt="'+esc(x.alt)+'"></a>').join('')+'</div>';
  if(m.type==='video') return '<a class="vid" href="'+esc(link)+'" target="_blank" rel="noopener"><img loading="lazy" src="'+esc(m.thumb)+'" alt="'+esc(m.alt)+'"></a>';
  if(m.type==='gif') return '<div class="imgs n1"><img loading="lazy" src="'+esc(m.uri)+'" alt="'+esc(m.title)+'"></div>';
  return '';
}
const TOMB={deleted:'This post was deleted',removed:'Removed by its author',label:'Hidden because of a content label'};
const nameOf=n=>n.tomb?(TOMB[n.tomb]||TOMB.deleted):'@'+n.h;
function cardHTML(n,isRoot){
  if(n.tomb){   // a tombstone: no author, text, date or link, but it keeps its place and its children
    return '<div class="card tomb" data-a="card" data-i="'+n.i+'">'
      +'<div class="head"><span class="av tombav" aria-hidden="true">·</span>'
      +(isRoot?'':'<span class="caret"></span>')
      +'<span class="handle">'+esc(nameOf(n))+'</span>'
      +(!isRoot&&n.cnt?'<span class="badge" title="'+n.cnt+' quotes below">+'+n.cnt+'</span>':'')+'</div>'
      +(isRoot?'':'<div class="acts">'+(n.kids.length?'<button data-a="tog">Fold</button>':'')+'</div>')+'</div>';
  }
  const link=postLink(n);
  const col='hsl('+hue(n.h)+' 55% 38%)';
  const av=(mode==='live'&&n.av)?'<img class="avimg" loading="lazy" src="'+esc(avThumb(n.av))+'" alt="">':'';
  const txt=n.t?'<p class="txt">'+(isRoot?esc(n.t):hl(n.t))+'</p>':'<p class="txt dim">(image or no text)</p>';
  const media=(mode==='live'&&n.media)?'<div class="media">'+mediaHTML(n.media,link)+'</div>':'';
  return '<div class="card" data-a="card" data-i="'+n.i+'">'
    +'<div class="head"><span class="av" style="background-color:'+col+'">'+esc((n.h[0]||'?').toUpperCase())+av+'</span>'
    +(isRoot?'':'<span class="caret"></span>')
    +'<span class="handle">@'+(isRoot?esc(n.h):hl(n.h))+'</span>'
    +(n.dn?'<span class="dn">'+esc(n.dn)+'</span>':'')
    +'<span class="meta">'+(n.d?(isRoot?esc(fmtDate(n.d)):'Day '+dayOf(n)+' · '+esc(fmtDate(n.d))):'')+'</span>'
    +(!isRoot&&n.cnt?'<span class="badge" title="'+n.cnt+' quotes below">+'+n.cnt+'</span>':'')+'</div>'
    +txt+media
    +'<div class="acts"><a class="open keep" href="'+esc(link)+'" target="_blank" rel="noopener" title="Open on Bluesky">↗ <span class="lbl">Open on Bluesky</span></a>'
    +(isRoot?'':(n.kids.length?'<button data-a="tog">Fold</button>':'')+'<button data-a="trace">Lineage</button><button data-a="copy">Copy link</button>')
    +(mode==='saved'?'<button class="keep" data-a="report">Report</button>':'')
    +'</div></div>';
}
function nodeHTML(i){
  const n=N[i]; if(!visible(i)) return '';
  const kids=sortedKids(n.kids).map(nodeHTML).join('');
  const isOpen=desc?desc.has(i):state.open.has(i);
  return '<div class="node'+(isOpen?'':' closed')+'" id="n'+i+'" data-i="'+i+'">'
    +(kids?'<button class="line" data-a="tog" aria-label="Collapse or expand this thread"></button>':'')
    +cardHTML(n,false)
    +(kids?'<div class="kids">'+kids+'</div>':'')+'</div>';
}
function renderStats(){
  if(!N.length) return;
  const q=N.length-1;
  const dates=N.slice(1).map(n=>Date.parse(n.d)).filter(t=>!isNaN(t));
  const span=dates.length?Math.max(...dates)-Date.parse(N[0].d||dates[0]):0;
  const spanTxt=span<36e5?'under an hour':span<864e5?Math.round(span/36e5)+' hours':Math.round(span/864e5)+' days';
  const cells=[[q,'quotes'],[people.size,'contributors'],[maxDep,'levels deep'],[N[0].kids.length,'direct quotes'],[spanTxt,'time span']];
  $('#stats').innerHTML=cells.map(([v,l])=>'<div class="stat"><b>'+(typeof v==='number'?fmtN(v):esc(v))+'</b><span>'+l+'</span></div>').join('');
}
function renderAll(){
  if(!N.length) return;
  computeSearch();
  document.body.classList.toggle('compact',state.view==='cmp');
  $('#vExp').setAttribute('aria-pressed',state.view==='exp');
  $('#vCmp').setAttribute('aria-pressed',state.view==='cmp');
  $('#depth').max=Math.max(1,maxDep+1);
  const html=sortedKids(N[0].kids).map(nodeHTML).join('');
  $('#tree').innerHTML=html||(hits?'<div class="empty">Nothing matches that search.</div>':'');
  $('#count').textContent=hits?(hits.size+' match'+(hits.size===1?'':'es')):(fmtN(N.length-1)+' quotes in '+N[0].kids.length+' branches. Click a card in compact view, or a thread line, to fold it.');
  lastRendered=N.length; renderStats();
  if(!hashDone&&location.hash.length>1){ const k=location.hash.slice(1); const n=N.find(x=>x.i>0&&x.k===k); if(n){ hashDone=true; setTimeout(()=>goTo(n.i),50) } }
}
$('#tree').addEventListener('error',e=>{ if(e.target&&e.target.classList&&e.target.classList.contains('avimg')) e.target.remove() },true);

// ---------- interactions ----------
$('#tree').addEventListener('click',e=>{
  const act=e.target.closest('[data-a]'); const nodeEl=e.target.closest('.node'); if(!nodeEl) return;
  if(e.target.closest('a')) return;
  const i=+nodeEl.dataset.i; const a=act&&act.dataset.a;
  if(a==='tog'||(a==='card'&&state.view==='cmp')){
    if(!N[i].kids.length) return;
    nodeEl.classList.toggle('closed');
    if(!hits) state.open[nodeEl.classList.contains('closed')?'delete':'add'](i);
  } else if(a==='trace') showTrace(i);
  else if(a==='report'){ if(reportHandler) reportHandler(i) }
  else if(a==='copy'){ if(N[i].tomb) return; const l=location.href.split('#')[0]+'#'+N[i].k; (navigator.clipboard?navigator.clipboard.writeText(l):Promise.reject()).then(()=>toast('Link copied'),()=>toast(l)) }
});
let reportHandler=null;
$('#rootcard').addEventListener('click',e=>{ const b=e.target.closest('[data-a="report"]'); if(b&&reportHandler) reportHandler(0) });
function toast(m){const t=$('#toast');t.textContent=m;t.classList.add('on');clearTimeout(toast.x);toast.x=setTimeout(()=>t.classList.remove('on'),2200)}
function path(i){const a=[];while(i>0){a.unshift(i);i=N[i].p}return a}
function showTrace(i){
  const el=$('#trace');
  el.innerHTML='<b>Lineage:</b> <button data-g="orig">The original post</button>'+path(i).map(x=>' → <button data-g="'+x+'">'+esc(nameOf(N[x]))+'</button>').join('')+'<button class="x" aria-label="Close lineage">✕</button>';
  el.classList.add('on');
}
$('#trace').addEventListener('click',e=>{
  const b=e.target.closest('button'); if(!b) return;
  if(b.classList.contains('x')) return $('#trace').classList.remove('on');
  if(b.dataset.g==='orig'){ window.scrollTo({top:0}); return }
  goTo(+b.dataset.g);
});
function goTo(i){
  if(state.q){ $('#q').value=''; state.q=''; renderAll() }
  let p=N[i].p; while(p>0){ state.open.add(p); p=N[p].p }
  let el=$('#n'+i);
  if(!el||el.closest('.closed')){ renderAll(); el=$('#n'+i) }
  if(!el) return;
  let up=el.parentElement; while(up&&up.id!=='tree'){ if(up.classList.contains('node')) up.classList.remove('closed'); up=up.parentElement }
  const c=el.querySelector('.card'); c.scrollIntoView({block:'center'}); c.classList.remove('flash'); void c.offsetWidth; c.classList.add('flash');
}
let qt; $('#q').addEventListener('input',e=>{clearTimeout(qt);qt=setTimeout(()=>{state.q=e.target.value;renderAll()},180)});
$('#vExp').onclick=()=>{state.view='exp';renderAll()}; $('#vCmp').onclick=()=>{state.view='cmp';renderAll()};
$('#exAll').onclick=()=>{state.open=new Set(N.filter(n=>n.kids.length).map(n=>n.i));$('#depth').value=maxDep+1;renderAll()};
$('#coAll').onclick=()=>{state.open=new Set();$('#depth').value=0;renderAll()};
$('#depth').oninput=e=>{defaultOpen(+e.target.value);renderAll()};
$('#sort').onchange=e=>{state.sort=e.target.value;renderAll()};

// dialogs
const dlg=$('#dlg'); $('#dx').onclick=()=>dlg.close(); dlg.addEventListener('click',e=>{if(e.target===dlg)dlg.close()});
function openDlg(title,html){$('#dt').textContent=title;$('#dbody').innerHTML=html;dlg.showModal()}
const label=n=>n.tomb?'':(esc((n.t||'').slice(0,40))||'(no text)');
$('#deep').onclick=()=>{
  if(N.length<2) return toast('Nothing to dive into yet');
  const dn=N.reduce((a,b)=>b.dep>a.dep?b:a); const p=path(dn.i);
  openDlg('The deepest dive','<p>'+p.length+' quote'+(p.length===1?'':'s')+' in a row, each one quoting the last.</p><ol class="lb chain">'+p.map((x,k)=>'<li style="--d:'+Math.min(k,12)+'"><button data-go="'+x+'">'+esc(nameOf(N[x]))+'</button> <span class="meta">'+label(N[x])+'</span></li>').join('')+'</ol>');
};
function lbHTML(tab){
  const q=N.slice(1).filter(n=>!n.tomb);   // removed and deleted posts never appear in a ranking
  if(tab==='threads'){const a=N[0].kids.map(i=>N[i]).filter(n=>!n.tomb).sort((x,y)=>y.cnt-x.cnt).slice(0,12);
    return '<ol class="lb">'+a.map(n=>'<li><button data-go="'+n.i+'">'+esc(nameOf(n))+'</button><span class="meta">'+label(n)+'</span><span class="n">'+(n.cnt+1)+'</span></li>').join('')+'</ol>'}
  if(tab==='people'){const m={};q.forEach(n=>m[n.h]=(m[n.h]||0)+1);const a=Object.entries(m).sort((x,y)=>y[1]-x[1]).slice(0,12);
    return '<ol class="lb">'+a.map(([h,c])=>'<li><button data-q="'+esc(h)+'">@'+esc(h)+'</button><span class="n">'+c+' posts</span></li>').join('')+'</ol>'}
  const ts=q.map(n=>Date.parse(n.d)).filter(t=>!isNaN(t)); if(!ts.length) return '<p class="empty">No dates available.</p>';
  const lo=Math.min(...ts), hi=Math.max(...ts), span=hi-lo;
  const unit=span<2*864e5?36e5:span>120*864e5?7*864e5:864e5;
  const name=unit===36e5?'hour':unit===864e5?'day':'week';
  const m=new Map(); ts.forEach(t=>{const b=Math.floor((t-lo)/unit); m.set(b,(m.get(b)||0)+1)});
  const nb=Math.floor(span/unit)+1; const mx=Math.max(...m.values());
  const bars=[]; for(let b=0;b<nb;b++){ const c=m.get(b)||0; const d=new Date(lo+b*unit);
    const lab=unit===36e5?d.toLocaleTimeString([],{hour:'numeric'}):d.toLocaleDateString([],{month:'short',day:'numeric'});
    bars.push('<div style="height:'+Math.max(c?4:1,c/mx*100)+'%" title="'+esc(lab)+'"><b>'+(c||'')+'</b><i>'+esc(lab)+'</i></div>') }
  return '<p>Quotes per '+name+'.</p><div class="tl" style="margin-bottom:28px">'+bars.join('')+'</div>';
}
$('#lead').onclick=()=>{
  if(N.length<2) return toast('Nothing to rank yet');
  openDlg('Leaderboards','<div class="tabs">'+[['threads','Top threads'],['people','Top posters'],['time','Timeline']].map(([k,l],i)=>'<button class="k-btn" data-tab="'+k+'" aria-pressed="'+(i===0)+'">'+l+'</button>').join('')+'</div><div id="lbc">'+lbHTML('threads')+'</div>');
};
$('#dbody').addEventListener('click',e=>{
  const t=e.target.closest('[data-tab]');
  if(t){document.querySelectorAll('[data-tab]').forEach(b=>b.setAttribute('aria-pressed',b===t));$('#lbc').innerHTML=lbHTML(t.dataset.tab);return}
  const g=e.target.closest('[data-go]'); if(g){dlg.close();goTo(+g.dataset.go);return}
  const q=e.target.closest('[data-q]'); if(q){dlg.close();$('#q').value=q.dataset.q;state.q=q.dataset.q;renderAll();scrollTo({top:$('.bar').offsetTop-4})}
});
document.addEventListener('keydown',e=>{
  if(e.metaKey||e.ctrlKey||e.altKey) return;
  if(/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)){ if(e.key==='Escape') document.activeElement.blur(); return }
  if($('#result').hidden) return;
  if(e.key==='/'){e.preventDefault();$('#q').focus()}
  else if(e.key==='e') $('#exAll').click(); else if(e.key==='c') $('#coAll').click();
});

function init(opts){ mode=(opts&&opts.mode)==='saved'?'saved':'live'; document.body.dataset.mode=mode }

function onReport(fn){ reportHandler=fn }

return {init,onReport,add,reset,renderAll,renderRoot,renderStats,defaultOpen,goTo,toast,
  nodes:()=>N, count:()=>N.length, maxDepth:()=>maxDep, renderedCount:()=>lastRendered, mode:()=>mode};
})();

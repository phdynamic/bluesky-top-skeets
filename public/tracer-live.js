// Live Tracer: crawls a quote tree from Bluesky in the visitor's browser and hands the nodes to the
// viewer (tracer-viewer.js). Everything that talks to Bluesky is here; the viewer never does.
(function(){
'use strict';
// Test hooks only; production uses the defaults.
const CFG=Object.assign({cap:2000,more:2000,ceiling:20000,gapMs:120,workers:4,timeoutMs:15000},window.TRACER_TEST||{});
const API='https://public.api.bsky.app/xrpc/';
const V=window.TracerViewer; V.init({mode:'live'});
const $=s=>document.querySelector(s);
const safeUrl=u=>typeof u==='string'&&/^https:\/\//.test(u)?u:'';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const fmtN=n=>Number(n).toLocaleString();

// ---------- state ----------
let run=null;        // current crawl
let tick=null;

// ---------- input parsing ----------
function parseInput(raw){ return KioskLinks.parsePostLink(raw) }  // shared with Skeet Receipt and the server (kiosk-links.js)

// ---------- API (paced, retrying, honors rate limits) ----------
function setNotice(t){const el=$('#pnotice');if(t){el.textContent=t;el.hidden=false}else el.hidden=true}
async function api(method,params,r){
  const qs=new URLSearchParams();
  for(const [k,v] of Object.entries(params)){ if(Array.isArray(v))v.forEach(x=>qs.append(k,x)); else if(v!=null&&v!=='')qs.set(k,v) }
  for(let attempt=1;;attempt++){
    if(r.stopped) throw new Error('stopped');
    const at=Math.max(Date.now(),r.nextStart,r.pauseUntil);
    r.nextStart=at+CFG.gapMs;
    const wait=at-Date.now(); if(wait>0) await sleep(wait);
    if(r.stopped) throw new Error('stopped');
    const ac=new AbortController(), t=setTimeout(()=>ac.abort(),CFG.timeoutMs);
    const onAbort=()=>ac.abort(); r.ac.signal.addEventListener('abort',onAbort,{once:true});
    r.requests++; r.inflightReq=(r.inflightReq||0)+1; r.maxInflight=Math.max(r.maxInflight||0,r.inflightReq);
    let res;
    try{ res=await fetch(API+method+'?'+qs.toString(),{signal:ac.signal}) }
    catch(e){
      if(r.stopped) throw new Error('stopped');
      if(attempt<3){ await sleep(1000*attempt); continue }
      throw new Error('Could not reach Bluesky. Check your connection and try again.');
    } finally { clearTimeout(t); r.ac.signal.removeEventListener('abort',onAbort); r.inflightReq-- }
    if(res.ok){ if(Date.now()>=r.pauseUntil) setNotice(''); return await res.json() }
    if(res.status===429){
      let sec=parseInt(res.headers.get('retry-after')||'',10);
      if(!(sec>0)){ const reset=parseInt(res.headers.get('ratelimit-reset')||'',10); if(reset>0) sec=Math.ceil(reset-Date.now()/1000) }
      const ms=Math.min(Math.max((sec>0?sec*1000:15000),5000),60000);
      r.pauseUntil=Date.now()+ms; setNotice('Bluesky is rate-limiting requests — waiting '+Math.round(ms/1000)+'s, then continuing…');
      if(attempt<5) continue;
      throw new Error('Bluesky kept rate-limiting requests. Try again in a minute.');
    }
    if(res.status>=500&&attempt<3){ await sleep(1000*attempt); continue }
    let msg=''; try{ msg=(await res.json()).message||'' }catch(e){}
    const err=new Error(msg||('Bluesky returned an error ('+res.status+')')); err.status=res.status; throw err;
  }
}

// ---------- nodes ----------
function extractMedia(e){
  if(e&&e.$type&&e.$type.indexOf('app.bsky.embed.recordWithMedia')===0) e=e.media;
  if(!e||!e.$type) return null;
  const t=e.$type;
  if(t.indexOf('app.bsky.embed.images')===0&&Array.isArray(e.images)){
    const im=e.images.filter(x=>safeUrl(x.thumb)).slice(0,4).map(x=>({thumb:x.thumb,full:safeUrl(x.fullsize)||x.thumb,alt:x.alt||''}));
    return im.length?{type:'images',images:im}:null;
  }
  if(t.indexOf('app.bsky.embed.video')===0&&safeUrl(e.thumbnail)) return {type:'video',thumb:e.thumbnail,alt:e.alt||'Video'};
  if(t.indexOf('app.bsky.embed.external')===0&&e.external){
    const u=safeUrl(e.external.uri);
    if(u&&(/^https:\/\/media\.tenor\.com\//.test(u)||/^https:\/\/[^/]*giphy\.com\//.test(u)||/\.gif(\?|$)/i.test(u))) return {type:'gif',uri:u,title:e.external.title||'GIF'};
  }
  return null;
}
function validDate(...c){ for(const x of c){ const t=Date.parse(x); if(!isNaN(t)) return new Date(t).toISOString() } return '' }
// Turns an API post view into the fields the viewer shows (plus the crawler's own state).
function makeFields(p){
  const rec=p.record||{}, au=p.author||{};
  return {uri:p.uri,k:String(p.uri).split('/').pop(),h:au.handle||'unknown',did:au.did||'',dn:au.displayName||'',
    av:safeUrl(au.avatar),d:validDate(rec.createdAt,p.indexedAt),t:typeof rec.text==='string'?rec.text:'',
    qc:typeof p.quoteCount==='number'?p.quoteCount:-1,media:extractMedia(p.embed)};
}
function addNode(r,p,parent){
  const n=V.add(makeFields(p),parent);
  r.byUri.set(p.uri,n);
  if(n.qc!==0) r.frontier.push(n);
  return n;
}
const remainingOf=n=>n.qc<0?1:Math.max(0,n.qc-n.kids.length);
function takeNext(r){
  let best=-1,bv=-1;
  for(let j=0;j<r.frontier.length;j++){ const v=remainingOf(r.frontier[j]); if(v>bv){bv=v;best=j} }
  return best<0?null:r.frontier.splice(best,1)[0];
}
const requeue=(r,n)=>{ if(!n.exhausted&&!r.frontier.includes(n)) r.frontier.push(n) };
function remainingTotal(r){ let s=0; r.frontier.forEach(n=>{s+=remainingOf(n)}); return s }

// ---------- crawl ----------
async function fetchPage(r,n){
  const res=await api('app.bsky.feed.getQuotes',{uri:n.uri,limit:100,cursor:n.cursor||undefined},r);
  if(r!==run) return;                              // a newer trace replaced this one
  if(r.stopped){ requeue(r,n); return }            // stopped mid-request: keep for resume
  const posts=Array.isArray(res.posts)?res.posts:[];
  let truncated=false;
  for(const p of posts){
    if(!p||!p.uri||r.byUri.has(p.uri)) continue;
    if(V.count()-1>=r.cap){ truncated=true; break }
    addNode(r,p,n);
  }
  if(truncated){ requeue(r,n); return }            // page re-fetched on resume; dedupe handles repeats
  if(res.cursor&&posts.length&&res.cursor!==n.cursor){ n.cursor=res.cursor; requeue(r,n) }
  else { n.exhausted=true; r.hidden+=Math.max(0,n.qc-n.kids.length) }
}
async function worker(r){
  while(!r.stopped){
    if(V.count()-1>=r.cap){ r.capped=true; break }
    const n=takeNext(r);
    if(!n){ if(r.busy===0) break; await sleep(60); continue }
    r.busy++;
    try{ await fetchPage(r,n); r.errors=0 }
    catch(e){
      requeue(r,n);
      if(!r.stopped){ r.errors++; if(r.errors>=6){ r.failed=e.message||'Request failed'; r.stopped=true; r.ac.abort() } }
    } finally { r.busy-- }
  }
}
async function startWorkers(r){
  r.stopped=false; r.failed=''; r.capped=false; r.errors=0; r.ac=new AbortController(); r.done=false;
  showRunning(); startTick();
  await Promise.all(Array.from({length:CFG.workers},()=>worker(r)));
  if(r!==run) return;
  finalize(r);
}
function finalize(r){
  stopTick(); setNotice('');
  if(!r.stopped&&r.frontier.length===0) r.done=true;
  if(!r.stopped&&V.count()-1>=r.cap&&r.frontier.length) r.capped=true;
  V.renderAll(); showEnd(r);
}

// ---------- progress / banners ----------
function startTick(){ stopTick(); tick=setInterval(()=>{ updateProgress(); if(V.count()-V.renderedCount()>=500) V.renderAll() },300) }
function stopTick(){ if(tick){clearInterval(tick);tick=null} }
function updateProgress(){
  if(!run) return;
  const got=V.count()-1, rem=remainingTotal(run);
  const secs=Math.max(1,(Date.now()-run.started)/1000);
  $('#ptext').textContent='Tracing… '+fmtN(got)+' quote'+(got===1?'':'s')+' found · '+V.maxDepth()+' level'+(V.maxDepth()===1?'':'s')+' deep · ~'+fmtN(Math.round(got/secs))+'/s';
  $('#pfill').style.width=(got+rem>0?Math.min(100,Math.round(got/(got+rem)*100)):0)+'%';
  V.renderStats();
}
function showRunning(){ $('#progress').hidden=false; $('#capbar').hidden=true; $('#stopBtn').disabled=false; updateProgress() }
function showEnd(r){
  $('#progress').hidden=true; $('#capbar').hidden=true;
  const got=V.count()-1, rem=remainingTotal(r);
  const hid=$('#hiddennote'); hid.hidden=true;
  const btn=$('#moreBtn');
  if(r.failed){
    $('#captext').textContent='Bluesky stopped responding ('+r.failed+'). Showing the '+fmtN(got)+' quotes found so far.';
    btn.textContent='Resume'; btn.onclick=()=>resume(r); btn.hidden=false; $('#capbar').hidden=false; return;
  }
  if(r.stopped){
    $('#captext').textContent='Stopped at '+fmtN(got)+' quotes'+(rem?' — at least '+fmtN(rem)+' more not loaded yet.':'.');
    btn.textContent='Resume'; btn.onclick=()=>resume(r); btn.hidden=false; $('#capbar').hidden=false; return;
  }
  if(r.capped&&rem>0){
    const atCeiling=r.cap>=CFG.ceiling;
    $('#captext').textContent='Showing '+fmtN(got)+' quotes — at least '+fmtN(rem)+' more not loaded yet.'+(atCeiling?' That\'s the limit for one trace in the browser.':'');
    btn.textContent='Load '+fmtN(CFG.more)+' more'; btn.onclick=()=>loadMore(r); btn.hidden=atCeiling; $('#capbar').hidden=false;
  } else if(got===0){
    $('#captext').textContent='No one has quoted this post yet.'; btn.hidden=true; $('#capbar').hidden=false;
  }
  if(r.hidden>0){ hid.textContent='At least '+fmtN(r.hidden)+' quote'+(r.hidden===1?'':'s')+' aren\'t visible to logged-out viewers (locked, blocked or deleted), so they — and anything quoted below them — aren\'t included.'; hid.hidden=false }
}
function loadMore(r){ r.cap=Math.min(r.cap+CFG.more,CFG.ceiling); startWorkers(r) }
function resume(r){ if(r.cap<=V.count()-1) r.cap=Math.min(V.count()-1+CFG.more,CFG.ceiling); startWorkers(r) }
$('#stopBtn').onclick=()=>{ if(!run) return; run.stopped=true; run.ac.abort(); $('#stopBtn').disabled=true };

// ---------- start ----------
function showError(msg){ const e=$('#error'); if(msg){e.textContent=msg;e.hidden=false}else e.hidden=true }
function resetAll(){
  if(run){ run.stopped=true; run.ac.abort() }
  stopTick(); V.reset();
  $('#progress').hidden=true; $('#capbar').hidden=true; $('#hiddennote').hidden=true; setNotice('');
}
async function startTrace(input){
  showError('');
  const parsed=parseInput(input);
  if(!parsed){ showError('That doesn\'t look like a Bluesky post link. Try something like https://bsky.app/profile/someone.bsky.social/post/3abc…'); return }
  resetAll();
  const r=run={ac:new AbortController(),cap:CFG.cap,frontier:[],busy:0,stopped:false,capped:false,done:false,failed:'',errors:0,
    started:Date.now(),nextStart:0,pauseUntil:0,byUri:new Map(),requests:0,hidden:0};
  $('#go').disabled=true;
  $('#progress').hidden=false; $('#ptext').textContent='Looking up the post…'; $('#pfill').style.width='0'; $('#stopBtn').disabled=false;
  try{
    let did=parsed.id;
    if(!did.startsWith('did:')){
      try{ did=(await api('com.atproto.identity.resolveHandle',{handle:parsed.id},r)).did }
      catch(e){ if(e.status===400||e.status===404) throw new Error('Couldn\'t find an account called '+parsed.id+'.'); throw e }
    }
    const got=await api('app.bsky.feed.getPosts',{uris:['at://'+did+'/app.bsky.feed.post/'+parsed.rkey]},r);
    const post=(got.posts||[])[0];
    if(!post){ throw new Error('Couldn\'t find that post. It may be deleted, or hidden from logged-out viewers.') }
    if(r!==run) return;
    addNode(r,post,null);
    try{ const u=new URL(location.href); u.searchParams.set('post',input.trim()); history.replaceState(null,'',u) }catch(e){}
    V.defaultOpen(1); $('#result').hidden=false; V.renderRoot(); V.renderAll();
    if(V.nodes()[0].qc===0){ finalize(r); return }
    startWorkers(r);
  }catch(e){
    if(r!==run||r.stopped&&e.message==='stopped') return;
    $('#progress').hidden=true; showError(e.message||'Something went wrong.');
  } finally { $('#go').disabled=false }
}
$('#form').addEventListener('submit',e=>{ e.preventDefault(); startTrace($('#postInput').value) });

// ---------- deep link ----------
(function(){
  let p=null; try{ p=new URLSearchParams(location.search).get('post') }catch(e){}
  if(p){ $('#postInput').value=p; startTrace(p) }
})();
})();

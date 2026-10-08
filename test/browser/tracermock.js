// Synthetic Bluesky public API for the tracer: deterministic ~N-quote tree.
const { deflateSync } = require('zlib');
function rng(seed){ let s=seed>>>0; return ()=>{ s=(s*1664525+1013904223)>>>0; return s/4294967296 } }
function buildTree(total=5000, seed=7){
  const r=rng(seed);
  const nodes=[{i:0,p:-1,dep:0,kids:[],hiddenExtra:0}];
  const q=[0]; let head=0;
  while(nodes.length<total && head<q.length){
    const n=nodes[q[head++]];
    const k = n.i===0 ? 60 : (r()<0.55?0: Math.min(9, 1+Math.floor(r()*r()*10)));
    for(let j=0;j<k&&nodes.length<total;j++){ const c={i:nodes.length,p:n.i,dep:n.dep+1,kids:[],hiddenExtra:0}; nodes.push(c); n.kids.push(c.i); q.push(c.i) }
    if(head>=q.length && nodes.length<total){ q.push(nodes.length-1) } // keep growing if the frontier dies
  }
  nodes.forEach(n=>{ if(n.kids.length&&n.i%20===3) n.hiddenExtra=3 });
  return nodes;
}
const did=i=>'did:plc:u'+i, handle=i=>i===0?'root.bsky.social':'user'+i+'.bsky.social';
const uriOf=i=>'at://'+did(i)+'/app.bsky.feed.post/r'+i;
function postView(nodes,i,xss){
  const n=nodes[i]; const day=Math.floor(i/400), t=new Date(Date.UTC(2026,8,1+day,10,Math.floor(i%400/10),i%60)).toISOString();
  let embed;
  if(i%9===0&&i>0) embed={$type:'app.bsky.embed.images#view',images:[{thumb:'https://cdn.bsky.app/img/feed_thumbnail/plain/x/'+i+'@jpeg',fullsize:'https://cdn.bsky.app/img/feed_fullsize/plain/x/'+i+'@jpeg',alt:'alt '+i}]};
  else if(i%13===0&&i>0) embed={$type:'app.bsky.embed.external#view',external:{uri:'https://media.tenor.com/'+i+'/g.gif',title:'gif'}};
  else if(i%17===0&&i>0) embed={$type:'app.bsky.embed.video#view',thumbnail:'https://video.bsky.app/watch/x/'+i+'/thumb.jpg'};
  const v={uri:uriOf(i),cid:'c'+i,author:{did:did(i),handle:handle(i),displayName:'User '+i,avatar:'https://cdn.bsky.app/img/avatar/plain/'+did(i)+'/a@jpeg'},
    record:{text:i===0?'The original post':'quote '+i,createdAt:t},indexedAt:t,quoteCount:n.kids.length+n.hiddenExtra,embed};
  if(xss&&i===7){ v.record.text='<img src=x onerror="window.__pwn=1"> <script>window.__pwn=1</script>'; v.author.handle='"><script>window.__pwn=2</script>'; v.author.displayName='<b onmouseover="window.__pwn=2">x</b>'; v.author.avatar='javascript:window.__pwn=5';
    v.embed={$type:'app.bsky.embed.images#view',images:[{thumb:'https://cdn.bsky.app/img/x@jpeg',fullsize:'javascript:window.__pwn=4',alt:'"><img src=x onerror=window.__pwn=3>'},{thumb:'javascript:window.__pwn=6',fullsize:'x',alt:'bad'}]} }
  return v;
}
function png(){ return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64') }
async function install(page, nodes, opts={}){
  const log={calls:[],getQuotes:[],resolve:[],inflight:0,maxInflight:0,t:[]};
  let quotes429=opts.fail429||0;
  await page.route('https://fonts.g*/**',r=>r.abort());
  await page.route('https://cdn.bsky.app/**',r=>r.fulfill({contentType:'image/png',body:png()}));
  await page.route('https://video.bsky.app/**',r=>r.fulfill({contentType:'image/png',body:png()}));
  await page.route('https://media.tenor.com/**',r=>r.fulfill({contentType:'image/png',body:png()}));
  await page.route('https://public.api.bsky.app/xrpc/**',async route=>{
    if(opts.down) return route.abort();
    const url=new URL(route.request().url()); const m=url.pathname.split('/').pop().split('.').pop();
    if(url.searchParams.get('actor')==='professorkiosk.wtf') return route.fulfill({contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:'{}'}); // site footer avatar, not a trace call
    log.calls.push(m); log.t.push(Date.now()); log.inflight++; log.maxInflight=Math.max(log.maxInflight,log.inflight);
    if(opts.delay) await new Promise(r=>setTimeout(r,opts.delay));
    try{
      const J=b=>route.fulfill({contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:JSON.stringify(b)});
      if(m==='resolveHandle'){ const h=url.searchParams.get('handle'); log.resolve.push(h);
        if(h==='root.bsky.social') return J({did:did(0)}); return route.fulfill({status:400,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:JSON.stringify({error:'InvalidRequest',message:'Unable to resolve handle'})}) }
      if(m==='getPosts'){ const uris=url.searchParams.getAll('uris'); const out=[];
        uris.forEach(u=>{ const k=u.split('/').pop(); if(/^r\d+$/.test(k)){ const i=+k.slice(1); if(nodes[i]&&u===uriOf(i)) out.push(postView(nodes,i,opts.xss)) } });
        return J({posts:out}) }
      if(m==='getQuotes'){
        const uri=url.searchParams.get('uri'); const cur=+(url.searchParams.get('cursor')||0); const lim=+(url.searchParams.get('limit')||50);
        const i=+uri.split('/').pop().slice(1); log.getQuotes.push({i,cur,qc:nodes[i].kids.length+nodes[i].hiddenExtra});
        if(quotes429>0){ quotes429--; return route.fulfill({status:429,contentType:'application/json',headers:{'access-control-allow-origin':'*','access-control-expose-headers':opts.expose?'retry-after,ratelimit-reset':'','retry-after':'1'},body:'{"error":"RateLimitExceeded"}'}) }
        const kids=nodes[i].kids; const page=kids.slice(cur,cur+lim);
        return J({uri,posts:page.map(k=>postView(nodes,k,opts.xss)),cursor:cur+lim<kids.length?String(cur+lim):undefined}) }
      return route.fulfill({status:404,body:'{}'});
    } finally { log.inflight-- }
  });
  return log;
}
module.exports={buildTree,install,uriOf,did,handle};

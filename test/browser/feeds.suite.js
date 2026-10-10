const { chromium } = require('playwright-core');
(async()=>{
 const b=await chromium.launch({executablePath:require('./env').CHROME});
 const errs=[]; const expect={'success visible':true,'help open':true,'armed':'Confirm unpublish?','preview icon img':true,'preview':'BO | Best Of Prof | Feed by @prof.bsky.social | Greatest hits. | Newest first','progress':'Fetching your posts… 430 of ~1,000 scanned.'};
 const out=(k,v)=>{ console.log(k+':',v); const base=k.replace(/ [ld]$/,''); if(base in expect) console.log((expect[base]===v?'PASS':'FAIL')+': '+k); };
 for (const [scheme,w,tag] of [['light',1000,'l'],['dark',390,'d']]) {
  const c=await b.newContext({viewport:{width:w,height:900},colorScheme:scheme}); const p=await c.newPage();
  p.on('pageerror',e=>errs.push(e.message));
  await p.route(/fonts\.(googleapis|gstatic)/,r=>r.abort());
  await p.route('**/xrpc/**',r=>r.abort());
  await p.route('**/api/register',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({handle:'prof.bsky.social',displayName:'Prof K',feedUrl:'https://bsky.app/profile/did:plc:abc/feed/top-skeets',postCount:0,expectedPosts:1000})}));
  await p.route('**/api/feed/**',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({fetchProgress:430,postCount:0})}));
  await p.route('**/api/unregister',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({ok:true})}));
  await p.goto('http://localhost:3988/feeds');
  await p.fill('#handle','prof.bsky.social'); await p.fill('#appPassword','abcd-efgh-ijkl-mnop');
  await p.fill('#feedName','Best Of Prof'); await p.fill('#feedDescription','Greatest hits.');
  await p.click('#toggleChrono');
  out('preview '+tag, await p.evaluate(()=>[pvIcon.textContent,pvName.textContent,pvBy.textContent,pvDesc.textContent,pvTag.textContent].join(' | ')));
  await p.setInputFiles('#feedIcon',{name:'i.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64')});
  await p.waitForTimeout(400);
  out('preview icon img '+tag, await p.evaluate(()=>!!document.querySelector('#pvIcon img')));
  await p.click('#submitBtn'); await p.waitForTimeout(3500);
  out('success visible '+tag, await p.locator('#successView').isVisible());
  out('progress '+tag, await p.locator('#fetchStatus').innerText());
  await p.screenshot({path:'fd-succ-'+tag+'.png'});
  await p.click('#helpBtn'); await p.waitForTimeout(200); out('help open '+tag, await p.locator('#help').isVisible());
  await p.screenshot({path:'fd-help-'+tag+'.png'}); await p.click('#helpX');
  await p.click('#successUnpublishBtn'); out('armed '+tag, await p.locator('#successUnpublishBtn').innerText());
 }
 out('JS errors', errs.join('|')||'none'); await b.close();
})();

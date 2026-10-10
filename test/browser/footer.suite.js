const { chromium } = require('playwright-core');
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==','base64');
(async()=>{
 const b=await chromium.launch({executablePath:require('./env').CHROME});
 const errs=[]; const html={};
 for (const [scheme,w] of [['light',1000],['dark',390]]) for (const pg of ['/','/feeds','/tracer','/imagine-flagons','/receipt','/jokeweb','/mashup']) {
  const c=await b.newContext({viewport:{width:w,height:800},colorScheme:scheme}); const p=await c.newPage();
  p.on('pageerror',e=>errs.push(pg+': '+e.message));
  await p.route(/fonts\.(googleapis|gstatic)/,r=>r.abort());
  await p.route('**/xrpc/app.bsky.actor.getProfile**',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({avatar:'http://localhost:3988/av.png'})}));
  await p.route('**/av.png',r=>r.fulfill({contentType:'image/png',body:PNG}));
  await p.goto('http://localhost:3988'+pg); await p.waitForTimeout(500);
  const f=await p.evaluate(()=>{const e=document.querySelector('footer.k-foot');const im=e.querySelector('img');return {h:e.outerHTML.replace(/\s+src="[^"]*"/,'').replace(/ hidden=""/,''),av:!im.hidden}});
  (html[f.h]=html[f.h]||[]).push(pg+' '+scheme+' avatar:'+f.av);
  if(pg==='/imagine-flagons'||pg==='/') { await p.locator('footer.k-foot').scrollIntoViewIfNeeded(); await p.locator('footer.k-foot').screenshot({path:'ft-'+(pg==='/'?'hub':'saga')+'-'+scheme+'.png'}); }
 }
 console.log('distinct footers:',Object.keys(html).length); console.log(Object.keys(html).length===1?'PASS: footer is identical on every page':'FAIL: footers differ between pages'); Object.values(html).forEach(v=>console.log(v.join(' | ')));
 console.log('errors:',errs.join('|')||'none'); await b.close();
})();

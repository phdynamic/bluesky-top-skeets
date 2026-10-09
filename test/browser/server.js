const http=require('http'),fs=require('fs'),path=require('path');
const root=path.join(__dirname,'..','..','public');
const { renderTracerPage } = require('../../dist/pages');
const { LIVE_CSP } = require('../../dist/csp');
const map={'/':'index.html','/feeds':'feeds.html','/tracer':'tracer.html','/imagine-flagons':'imagine-flagons.html','/receipt':'receipt.html'};
const types={'.html':'text/html','.css':'text/css','.js':'text/javascript','.png':'image/png'};
http.createServer((q,r)=>{const u=q.url.split('?')[0];
 if(u==='/tracer'){ r.writeHead(200,{'content-type':'text/html','content-security-policy':LIVE_CSP}); return r.end(renderTracerPage({mode:'live'})); }const f=map[u]||u.slice(1);const p=path.join(root,f);
 fs.readFile(p,(e,d)=>{if(e){r.writeHead(404);return r.end('nf')}r.writeHead(200,{'content-type':types[path.extname(p)]||'text/plain'});r.end(d)})}).listen(process.env.PORT||3988);

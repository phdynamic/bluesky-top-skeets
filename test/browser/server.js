const http=require('http'),fs=require('fs'),path=require('path');
const root=path.join(__dirname,'..','..','public');
const map={'/':'index.html','/feeds':'feeds.html','/tracer':'tracer.html','/imagine-flagons':'imagine-flagons.html','/receipt':'receipt.html','/jokeweb':'jokeweb.html','/mashup':'mashup.html','/tutorials':'tutorials.html'};
const types={'.html':'text/html','.css':'text/css','.js':'text/javascript','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.txt':'text/plain; charset=utf-8','.woff2':'font/woff2','.mp4':'video/mp4'};
http.createServer((q,r)=>{const u=q.url.split('?')[0];
 const f=map[u]||u.slice(1);const p=path.join(root,f);
 fs.readFile(p,(e,d)=>{if(e){r.writeHead(404);return r.end('nf')}
  const type=types[path.extname(p)]||'text/plain';
  const m=/^bytes=(\d*)-(\d*)$/.exec(q.headers.range||'');
  if(m){const a=m[1]?+m[1]:0,b=m[2]?Math.min(+m[2],d.length-1):d.length-1;r.writeHead(206,{'content-type':type,'content-range':`bytes ${a}-${b}/${d.length}`,'accept-ranges':'bytes','content-length':b-a+1});return r.end(d.slice(a,b+1))}
  r.writeHead(200,{'content-type':type,'accept-ranges':'bytes'});r.end(d)})}).listen(process.env.PORT||3988);

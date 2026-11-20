'use strict';
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
let wp=null;try{wp=require('web-push')}catch(e){console.log('web-push not installed: notifications run in dry-run mode. Run npm install.')}
const DATA=process.env.DATA_DIR||path.join(__dirname,'data'),ADMIN=process.env.ADMIN_TOKEN||'',PUB=path.join(__dirname,'public');
fs.mkdirSync(DATA,{recursive:true});
const FILE=path.join(DATA,'db.json');
let db={users:{},sessions:{}};
try{db=JSON.parse(fs.readFileSync(FILE,'utf8'))}catch(e){}
let dirty=false;const save=()=>{dirty=true};
const flush=()=>{if(!dirty)return;dirty=false;fs.writeFileSync(FILE+'.tmp',JSON.stringify(db));fs.renameSync(FILE+'.tmp',FILE)};
let vapid={pub:process.env.VAPID_PUBLIC_KEY,priv:process.env.VAPID_PRIVATE_KEY};
if(wp){
  if(!vapid.pub){if(!db.vapid){const k=wp.generateVAPIDKeys();db.vapid={pub:k.publicKey,priv:k.privateKey};save()}vapid=db.vapid}
  wp.setVapidDetails(process.env.CONTACT||'mailto:admin@example.com',vapid.pub,vapid.priv);
}
const th=t=>crypto.createHash('sha256').update(t).digest('hex');
const hashPw=(pw,salt)=>crypto.scryptSync(pw,salt,32).toString('hex');
const same=(a,b)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&crypto.timingSafeEqual(x,y)};
const hits={};const limited=ip=>{const n=Date.now(),a=hits[ip]=(hits[ip]||[]).filter(t=>n-t<6e5);a.push(n);return a.length>10};
const send=(res,c,o,type='application/json')=>{res.writeHead(c,{'Content-Type':type,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'});res.end(type==='application/json'?JSON.stringify(o):o)};
const readBody=req=>new Promise((ok,no)=>{let d='';req.on('data',c=>{d+=c;if(d.length>1.5e6){no(new Error('Too large'));req.destroy()}});req.on('end',()=>{try{ok(d?JSON.parse(d):{})}catch(e){no(new Error('Bad JSON'))}})});
const authUser=req=>{const m=/^Bearer (.+)$/.exec(req.headers.authorization||'');if(!m)return null;const s=db.sessions[th(m[1])];return s&&s.exp>Date.now()?db.users[s.id]:null};
const hhmm=n=>String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0');
const pubUser=u=>({name:u.name,email:u.email,board:u.prefs.board,remindAt:hhmm(u.prefs.remindAt),push:u.subs.length>0});
const num=(x,max)=>Math.max(0,Math.min(max,Math.round(+x||0)));
function session(id){const t=crypto.randomBytes(24).toString('hex');db.sessions[th(t)]={id,exp:Date.now()+30*864e5};save();return t}

/* ---------- Tock's notification voice ---------- */
const MSG={
  reminder:{t:'Time to stick to it ⏰',b:["Hi {name}, it's Tock. Your plan is feeling lonely. Got 5 minutes?","{pending} blocks are waiting for you today. Let's knock one out.","Finish one block and today counts. Just one.","Your {streak}-day streak 🔥 wants a block today."]},
  danger:{t:'Streak alert 🔥',b:["Your {streak}-day streak ends tonight 🔥 One block saves it.","{streak} days of effort, gone in a few hours? Tock says no.","Last call, {name}. Open StickTo and keep the streak alive."]},
  comeback:{t:'Tock misses you',b:["It's been {days} days. Your goals haven't gone anywhere. Start small?","Tock saved your spot. Come back for 5 minutes?","No guilt, {name}. One block and you're back on track."]},
  breakup:{t:'Tock is stepping back',b:["Looks like these nudges aren't helping, so Tock will stop pinging you until you're back."]}
};
const fill=(t,u,x)=>t.replace(/\{name\}/g,(u.name||'').split(' ')[0]||'there').replace(/\{streak\}/g,x.streak).replace(/\{pending\}/g,x.pending).replace(/\{days\}/g,x.days);
async function sendPush(u,pl){
  if(!wp){console.log('[dry-run]',u.email,'|',pl.title,'|',pl.body);return}
  for(const s of u.subs.slice())try{await wp.sendNotification(s,JSON.stringify(pl))}catch(e){if(e.statusCode===404||e.statusCode===410){u.subs=u.subs.filter(x=>x.endpoint!==s.endpoint);save()}}
}
async function tick(now=Date.now(),sender=sendPush){
  for(const u of Object.values(db.users)){
    const p=u.prefs;if(!p.push||!u.subs.length)continue;
    const sm=u.summary||{},n=u.n=u.n||{day:'',sent:0,last:0,ignored:0,paused:false,total:0};
    const loc=new Date(now+p.tzo*6e4),lm=loc.getUTCHours()*60+loc.getUTCMinutes(),day=loc.toISOString().slice(0,10);
    if(n.day!==day){n.day=day;n.sent=0}
    const la=sm.lastActive||0,actDay=la?new Date(la+p.tzo*6e4).toISOString().slice(0,10):'';
    if(la>n.last){n.ignored=0;n.paused=false}
    if(n.paused||n.sent>=2||lm<p.quietEnd||lm>=p.quietStart||now-n.last<90*6e4)continue;
    const active=actDay===day,x={streak:sm.streak||0,pending:Math.max(0,(sm.todayTotal||0)-(sm.todayDone||0)),days:la?Math.floor((now-la)/864e5):99};
    let kind=null;
    if(n.ignored>=5)kind='breakup';
    else if(!active&&lm>=p.remindAt&&n.sent===0)kind=x.days>=2?'comeback':'reminder';
    else if(!active&&lm>=1260&&x.streak>0)kind='danger';
    if(!kind)continue;
    const pool=MSG[kind].b.filter(b=>x.streak>0||!/\{streak\}/.test(b)),text=fill(pool[(n.total+day.length)%pool.length],u,x);
    n.sent++;n.total++;n.last=now;n.ignored++;if(kind==='breakup')n.paused=true;save();
    await sender(u,{title:MSG[kind].t,body:text,tag:'stickto-'+kind,url:'/'});
  }
}
const ADMIN_HTML=`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>StickTo admin</title><style>body{font:14px system-ui;margin:20px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ccc;padding:6px;text-align:left}</style><h1>StickTo admin</h1><input id=t type=password placeholder="Admin token"> <button onclick=go()>Load</button><div id=o></div><script>function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}async function go(){const r=await fetch('/api/admin',{headers:{Authorization:'Bearer '+t.value}});if(!r.ok){o.textContent='Wrong token';return}const d=await r.json();o.innerHTML='<p>'+d.users.length+' users, '+d.activeToday+' active today</p><table><tr><th>Name<th>Email<th>Streak<th>XP<th>Today<th>Last active<th>Push<th>Joined</tr>'+d.users.map(u=>'<tr><td>'+esc(u.name)+'<td>'+esc(u.email)+'<td>'+u.streak+'<td>'+u.xp+'<td>'+u.todayDone+'/'+u.todayTotal+'<td>'+(u.lastActive?new Date(u.lastActive).toLocaleString():'never')+'<td>'+(u.push?'on':'off')+'<td>'+new Date(u.created).toLocaleDateString()).join('')+'</table>'}</script>`;
const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript','.json':'application/json','.webmanifest':'application/manifest+json','.png':'image/png','.txt':'text/plain'};
async function handle(req,res){
  const p=new URL(req.url,'http://x').pathname,ip=String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0].trim();
  try{
    if(p.startsWith('/api/')){
      if(p==='/api/health')return send(res,200,{ok:true});
      if(p==='/api/vapid')return send(res,200,{key:wp?vapid.pub:null});
      if(p==='/api/board')return send(res,200,{board:Object.values(db.users).filter(u=>u.prefs.board&&u.summary).sort((a,b)=>b.summary.xp-a.summary.xp).slice(0,20).map(u=>({name:u.name.split(' ')[0],xp:u.summary.xp,lv:u.summary.lv,streak:u.summary.streak}))});
      if(p==='/api/admin'){
        const m=/^Bearer (.+)$/.exec(req.headers.authorization||'');
        if(!ADMIN||!m||!same(th(m[1]),th(ADMIN)))return send(res,403,{error:'Forbidden'});
        const day=new Date().toISOString().slice(0,10),us=Object.values(db.users).map(u=>{const s=u.summary||{};return{name:u.name,email:u.email,created:u.created,streak:s.streak||0,xp:s.xp||0,todayDone:s.todayDone||0,todayTotal:s.todayTotal||0,lastActive:s.lastActive||0,push:u.subs.length>0}});
        return send(res,200,{users:us,activeToday:us.filter(u=>u.lastActive&&new Date(u.lastActive).toISOString().slice(0,10)===day).length});
      }
      if((p==='/api/register'||p==='/api/login')&&req.method==='POST'){
        if(limited(ip))return send(res,429,{error:'Too many attempts. Try again in a few minutes.'});
        const b=await readBody(req),email=String(b.email||'').trim().toLowerCase();
        if(p==='/api/login'){
          const u=Object.values(db.users).find(x=>x.email===email);
          if(!u||!same(hashPw(String(b.password||''),u.salt),u.pw))return send(res,401,{error:'Wrong email or password.'});
          return send(res,200,{token:session(u.id),user:pubUser(u)});
        }
        if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))return send(res,400,{error:'Enter a valid email.'});
        if(String(b.password||'').length<8)return send(res,400,{error:'Password must be at least 8 characters.'});
        if(!b.consent)return send(res,400,{error:'Consent is required.'});
        if(Object.values(db.users).some(x=>x.email===email))return send(res,409,{error:'That email is already registered.'});
        const salt=crypto.randomBytes(16).toString('hex'),id=crypto.randomBytes(8).toString('hex');
        const u=db.users[id]={id,email,name:String(b.name||email.split('@')[0]).trim().slice(0,40)||'Friend',salt,pw:hashPw(String(b.password),salt),created:Date.now(),state:null,updatedAt:0,summary:null,subs:[],n:null,prefs:{remindAt:1140,tzo:Math.max(-720,Math.min(840,Math.round(+b.tzo||0))),push:true,board:false,quietStart:1320,quietEnd:420}};
        save();return send(res,200,{token:session(id),user:pubUser(u)});
      }
      const u=authUser(req);if(!u)return send(res,401,{error:'Please log in.'});
      if(p==='/api/me')return send(res,200,pubUser(u));
      if(p==='/api/state')return send(res,200,{state:u.state,updatedAt:u.updatedAt});
      if(p==='/api/sync'&&req.method==='POST'){
        const b=await readBody(req);if(!b.state||typeof b.state!=='object')return send(res,400,{error:'No state.'});
        const s=b.summary||{};u.state=b.state;u.updatedAt=num(b.updatedAt,Date.now()+1e4)||Date.now();
        u.summary={xp:num(s.xp,1e7),lv:num(s.lv,999),streak:num(s.streak,9999),todayDone:num(s.todayDone,999),todayTotal:num(s.todayTotal,999),focusMin:num(s.focusMin,9999),lastActive:num(s.lastActive,Date.now())};
        save();return send(res,200,{updatedAt:u.updatedAt});
      }
      if(p==='/api/prefs'&&req.method==='POST'){
        const b=await readBody(req),r=/^(\d\d):(\d\d)$/.exec(b.remindAt||'');
        if(r)u.prefs.remindAt=Math.min(1439,+r[1]*60+ +r[2]);
        if(b.tzo!==undefined)u.prefs.tzo=Math.max(-720,Math.min(840,Math.round(+b.tzo||0)));
        if(b.board!==undefined)u.prefs.board=!!b.board;
        if(b.push!==undefined)u.prefs.push=!!b.push;
        save();return send(res,200,pubUser(u));
      }
      if(p==='/api/push'){
        if(req.method==='DELETE'){u.subs=[];save();return send(res,200,{ok:true})}
        const b=await readBody(req),s=b.sub;
        if(!s||!/^https:\/\//.test(s.endpoint||'')||!s.keys)return send(res,400,{error:'Bad subscription.'});
        u.subs=[s,...u.subs.filter(x=>x.endpoint!==s.endpoint)].slice(0,5);save();return send(res,200,{ok:true});
      }
      if(p==='/api/account'&&req.method==='DELETE'){
        delete db.users[u.id];Object.keys(db.sessions).forEach(k=>{if(db.sessions[k].id===u.id)delete db.sessions[k]});save();return send(res,200,{ok:true});
      }
      return send(res,404,{error:'Not found'});
    }
    if(p==='/admin')return send(res,200,ADMIN_HTML,'text/html; charset=utf-8');
    const f=path.join(PUB,path.normalize(p==='/'?'/index.html':p));
    if(!f.startsWith(PUB)||!fs.existsSync(f)||fs.statSync(f).isDirectory())return send(res,404,'Not found','text/plain');
    res.writeHead(200,{'Content-Type':TYPES[path.extname(f)]||'application/octet-stream','X-Content-Type-Options':'nosniff'});fs.createReadStream(f).pipe(res);
  }catch(e){send(res,400,{error:e.message})}
}
function start(port=process.env.PORT||3000){
  const srv=http.createServer(handle).listen(port,()=>console.log('StickTo on port '+port));
  setInterval(flush,2000).unref();
  setInterval(()=>{const n=Date.now();Object.keys(db.sessions).forEach(k=>{if(db.sessions[k].exp<n)delete db.sessions[k]});tick().catch(console.error)},60000).unref();
  return srv;
}
module.exports={start,tick,db,flush};
if(require.main===module)start();

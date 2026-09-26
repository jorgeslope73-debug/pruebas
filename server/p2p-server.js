'use strict';

const http=require('http');
const {randomBytes,scrypt:scryptCallback,timingSafeEqual,createHash}=require('crypto');
const {promisify}=require('util');
const {Pool}=require('pg');
const {WebSocketServer}=require('ws');

const scrypt=promisify(scryptCallback);
const PORT=Number(process.env.PORT||8080);
const MAX_PLAYERS=4;
const RECONNECT_GRACE_MS=30000;
const SESSION_DAYS=30;
const PASSWORD_MIN_LENGTH=8;
const DATABASE_URL=String(process.env.DATABASE_URL||'').trim();
const TRAINING_ADMIN_KEY=String(process.env.TRAINING_ADMIN_KEY||'').trim();
const NORMAL_HOST_ROOM_LIMIT=1;
const TEST_ROOM_PERMIT_MAX=10;
const TEST_ROOM_PERMIT_TTL_MS=8*60*60*1000;

let dbReady=false;
let dbInitPromise=null;
const db=DATABASE_URL?new Pool({
  connectionString:DATABASE_URL,
  ssl:/localhost|127\.0\.0\.1/.test(DATABASE_URL)?false:{rejectUnauthorized:false}
}):null;

const rooms=new Map();
const info=new WeakMap();
const connectionMeta=new WeakMap();
const testRoomPermits=new Map();

function normalizeUsername(value){return String(value||'').replace(/[\x00-\x1f\x7f]/g,'').replace(/\s+/g,' ').trim().slice(0,16);}
function usernameKey(value){return normalizeUsername(value).toLowerCase();}
function normalizeEmail(value){return String(value||'').trim().toLowerCase().slice(0,254);}
function validEmail(value){return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);}
function validRegisteredUsername(value){return /^[A-Za-z0-9 _-]{2,16}$/.test(normalizeUsername(value));}
function safeName(v){return normalizeUsername(v)||'JUGADOR';}
function tokenHash(token){return createHash('sha256').update(String(token||'')).digest('hex');}
function safeClientId(value){
  const id=String(value||'').trim().toLowerCase();
  return /^[a-f0-9]{32}$/.test(id)?id:'';
}
function requestIp(req){
  const forwarded=String(req&&req.headers&&req.headers['x-forwarded-for']||'').split(',')[0].trim();
  return forwarded||String(req&&req.socket&&req.socket.remoteAddress||'').trim()||'unknown';
}
function cleanupTestRoomPermits(){
  const now=Date.now();
  for(const [key,p] of testRoomPermits)if(!p||Number(p.expiresAt)<=now)testRoomPermits.delete(key);
}
function testRoomPermit(rawToken){
  const token=String(rawToken||'').trim();
  if(!/^[a-f0-9]{64}$/i.test(token))return null;
  cleanupTestRoomPermits();
  const key=tokenHash(token);
  const permit=testRoomPermits.get(key);
  if(!permit||Number(permit.expiresAt)<=Date.now())return null;
  return {key,permit};
}
function activeHostedRooms(creatorKey){
  if(!creatorKey)return 0;
  let count=0;
  for(const room of rooms.values())if(room&&room.creatorKey===creatorKey)count++;
  return count;
}
function activeRoomParticipations(participantKey){
  if(!participantKey)return 0;
  let count=0;
  for(const room of rooms.values()){
    for(const p of (room&&Array.isArray(room.players)?room.players:[])){
      if(p&&p.participantKey===participantKey)count++;
    }
  }
  return count;
}
function activeIpParticipations(ipKey){
  if(!ipKey)return 0;
  let count=0;
  for(const room of rooms.values()){
    for(const p of (room&&Array.isArray(room.players)?room.players:[])){
      if(p&&p.ipKey===ipKey)count++;
    }
  }
  return count;
}
function normalIpKey(ws){
  const meta=connectionMeta.get(ws)||{};
  const ip=String(meta.ip||'').trim();
  return ip&&ip!=='unknown'&&!ip.startsWith('unknown-')?('ip:'+ip):'';
}
function roomCreationIdentity(identity,msg,ws){
  const admin=testRoomPermit(msg&&msg.testRoomToken);
  if(admin){
    return{
      creatorKey:'test:'+admin.key,
      ipKey:'',
      roomLimit:Math.max(1,Math.min(TEST_ROOM_PERMIT_MAX,Number(admin.permit.maxRooms)||1)),
      testMode:true
    };
  }

  const ipKey=normalIpKey(ws);
  if(identity&&identity.registered&&identity.userId){
    // La cuenta sigue identificando al usuario, pero ademas se aplica la IP:
    // una segunda pestaña/navegador en la misma conexion no puede entrar como
    // otro jugador usando otra cuenta o como invitado.
    return{creatorKey:'user:'+String(identity.userId),ipKey,roomLimit:NORMAL_HOST_ROOM_LIMIT,testMode:false};
  }

  // Invitados: la IP publica es la identidad principal. Si el proxy no
  // facilita una IP valida, mantenemos el clientId como respaldo para no
  // perjudicar el funcionamiento del juego.
  if(ipKey)return{creatorKey:ipKey,ipKey,roomLimit:NORMAL_HOST_ROOM_LIMIT,testMode:false};

  const clientId=safeClientId(msg&&msg.clientId);
  if(clientId)return{creatorKey:'client:'+clientId,ipKey:'',roomLimit:NORMAL_HOST_ROOM_LIMIT,testMode:false};
  return{creatorKey:'connection:unknown',ipKey:'',roomLimit:NORMAL_HOST_ROOM_LIMIT,testMode:false};
}

async function hashPassword(password,saltHex=''){
  const salt=saltHex?Buffer.from(saltHex,'hex'):randomBytes(16);
  const derived=await scrypt(String(password),salt,64);
  return {salt:salt.toString('hex'),hash:Buffer.from(derived).toString('hex')};
}
async function verifyPassword(password,saltHex,hashHex){
  try{
    const test=await hashPassword(password,saltHex);
    const a=Buffer.from(test.hash,'hex');
    const b=Buffer.from(String(hashHex||''),'hex');
    return a.length===b.length&&timingSafeEqual(a,b);
  }catch(_){return false;}
}
async function ensureDatabase(){
  if(!db)return false;
  if(dbReady)return true;
  if(dbInitPromise)return dbInitPromise;
  dbInitPromise=(async()=>{
    await db.query(`
      CREATE TABLE IF NOT EXISTS galaxy_users (
        id BIGSERIAL PRIMARY KEY,
        username VARCHAR(16) NOT NULL,
        username_key VARCHAR(16) NOT NULL UNIQUE,
        email VARCHAR(254) NOT NULL,
        email_key VARCHAR(254) NOT NULL UNIQUE,
        password_salt VARCHAR(64) NOT NULL,
        password_hash VARCHAR(256) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS galaxy_sessions (
        token_hash CHAR(64) PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES galaxy_users(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS galaxy_sessions_user_idx ON galaxy_sessions(user_id);
      CREATE INDEX IF NOT EXISTS galaxy_sessions_exp_idx ON galaxy_sessions(expires_at);
      CREATE TABLE IF NOT EXISTS galaxy_ranked_matches (
        match_id VARCHAR(64) PRIMARY KEY,
        room_code VARCHAR(8) NOT NULL,
        winner_user_id BIGINT NOT NULL REFERENCES galaxy_users(id) ON DELETE RESTRICT,
        played_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      ALTER TABLE galaxy_ranked_matches ALTER COLUMN winner_user_id DROP NOT NULL;
      CREATE TABLE IF NOT EXISTS galaxy_ranked_match_players (
        match_id VARCHAR(64) NOT NULL REFERENCES galaxy_ranked_matches(match_id) ON DELETE CASCADE,
        user_id BIGINT NOT NULL REFERENCES galaxy_users(id) ON DELETE RESTRICT,
        player_index SMALLINT NOT NULL,
        PRIMARY KEY(match_id,user_id)
      );
      CREATE INDEX IF NOT EXISTS galaxy_rank_players_user_idx ON galaxy_ranked_match_players(user_id);
      CREATE INDEX IF NOT EXISTS galaxy_rank_winner_idx ON galaxy_ranked_matches(winner_user_id);
      CREATE TABLE IF NOT EXISTS galaxy_cpu_brain (
        id SMALLINT PRIMARY KEY,
        version INTEGER NOT NULL DEFAULT 1,
        brain JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      INSERT INTO galaxy_cpu_brain(id,version,brain)
      VALUES(1,1,'{"version":1,"strategies":[],"candidates":[]}'::jsonb)
      ON CONFLICT(id) DO NOTHING;
      CREATE TABLE IF NOT EXISTS galaxy_analytics_daily (
        day DATE PRIMARY KEY,
        visits INTEGER NOT NULL DEFAULT 0,
        cpu_matches INTEGER NOT NULL DEFAULT 0,
        online_matches INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS galaxy_cpu_training_stats (
        id SMALLINT PRIMARY KEY,
        matches BIGINT NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      INSERT INTO galaxy_cpu_training_stats(id,matches)
      VALUES(1,0)
      ON CONFLICT(id) DO NOTHING;
      CREATE TABLE IF NOT EXISTS galaxy_cpu_learning_control (
        id SMALLINT PRIMARY KEY,
        auto_training_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        local_hard_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      INSERT INTO galaxy_cpu_learning_control(id,auto_training_enabled,local_hard_enabled)
      VALUES(1,TRUE,TRUE)
      ON CONFLICT(id) DO NOTHING;
    `);
    dbReady=true;
    console.log('[Galaxy Combat P2P] Base de datos de cuentas preparada.');
    return true;
  })().catch(err=>{
    dbInitPromise=null;dbReady=false;
    console.error('[Galaxy Combat P2P] No se pudo preparar DATABASE_URL:',err&&err.message||err);
    return false;
  });
  return dbInitPromise;
}
async function createSession(userId){
  if(!await ensureDatabase())return null;
  const token=randomBytes(32).toString('hex');
  await db.query('DELETE FROM galaxy_sessions WHERE expires_at<=NOW()');
  await db.query(`INSERT INTO galaxy_sessions(token_hash,user_id,expires_at) VALUES($1,$2,NOW()+($3||' days')::interval)`,[tokenHash(token),userId,String(SESSION_DAYS)]);
  return token;
}
async function userFromSessionToken(token){
  if(!token||!/^[a-f0-9]{64}$/i.test(String(token)))return null;
  if(!await ensureDatabase())return null;
  const {rows}=await db.query(`SELECT u.id,u.username,u.email FROM galaxy_sessions s JOIN galaxy_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>NOW() LIMIT 1`,[tokenHash(token)]);
  return rows[0]||null;
}
async function registeredNameExists(name){
  if(!db||!await ensureDatabase())return false;
  const {rowCount}=await db.query('SELECT 1 FROM galaxy_users WHERE username_key=$1 LIMIT 1',[usernameKey(name)]);
  return rowCount>0;
}
async function resolvePlayerIdentity(msg){
  const token=String(msg&&msg.authToken||'').trim();
  let user=null;
  try{user=token?await userFromSessionToken(token):null;}catch(err){
    console.error('[Galaxy Combat P2P] Error validando sesion:',err&&err.message||err);
    if(token)return {error:'SERVICIO DE CUENTAS NO DISPONIBLE.'};
  }
  if(user)return {name:user.username,userId:Number(user.id),registered:true};
  if(token)return {error:'SESION CADUCADA. INICIA SESION DE NUEVO.'};
  const name=safeName(msg&&msg.name);
  try{if(await registeredNameExists(name))return {error:'NOMBRE REGISTRADO. INICIA SESION.'};}
  catch(err){console.error('[Galaxy Combat P2P] Error comprobando nombre:',err&&err.message||err);}
  return {name,userId:null,registered:false};
}

function roomCode(){
  for(;;){const c=randomBytes(3).toString('hex').slice(0,4).toUpperCase();if(!rooms.has(c))return c;}
}
function newPlayerToken(){return randomBytes(24).toString('hex');}
function send(ws,o){if(ws&&ws.readyState===1)try{ws.send(JSON.stringify(o));}catch(_){}}
function roster(r){
  const out=r.players.map(p=>({i:p.i,n:p.n,cpu:false,registered:!!p.registered}));
  if(r.cpuFill){
    const used=new Set(out.map(p=>p.i));
    for(let i=0;i<MAX_PLAYERS;i++){
      if(!used.has(i))out.push({i,n:'CPU '+(i+1),cpu:true,registered:false,difficulty:'dificil'});
    }
  }
  out.sort((a,b)=>a.i-b.i);
  return out;
}
function canStartRoom(r){return !!(r&&!r.started&&r.players.length&&r.players.every(p=>!!p.ws)&&roster(r).length>1);}
function broadcast(r,o){for(const p of r.players)send(p.ws,o);}
function publicRooms(){
  return [...rooms.values()]
    .filter(r=>r.public&&r.players[0]&&r.players[0].ws&&(!r.started||(r.cpuFill&&r.players.length<MAX_PLAYERS)))
    .map(r=>{
      const slots=roster(r);
      return{
        code:r.code,
        host:r.players[0]?.n||'JUGADOR',
        lang:r.lang,
        players:r.players.length,
        maxPlayers:MAX_PLAYERS,
        started:!!r.started,
        cpuFill:!!r.cpuFill,
        slots
      };
    });
}
function publicUpdate(wss){const raw=JSON.stringify({t:'public-rooms',rooms:publicRooms()});for(const ws of wss.clients)if(ws.readyState===1)ws.send(raw);}
function scheduleSoloHostClose(r,wss,delay=3000){
  if(!r||!r.started||r.cpuFill||r.players.length!==1||!r.players[0]||r.players[0].i!==0)return false;
  if(r.soloHostCloseTimer)return true;
  r.soloHostCloseTimer=setTimeout(()=>{
    r.soloHostCloseTimer=null;
    const live=rooms.get(r.code);
    if(live!==r||r.cpuFill||r.players.length!==1||!r.players[0]||r.players[0].i!==0)return;
    broadcast(r,{t:'closed',reason:'La partida se cierra porque solo queda el anfitrion.'});
    rooms.delete(r.code);
    publicUpdate(wss);
  },Math.max(0,Number(delay)||0));
  return true;
}
function remove(ws,wss){
  const x=info.get(ws);if(!x)return;info.delete(ws);
  const r=rooms.get(x.code);if(!r)return;
  const p=r.players.find(p=>p.i===x.i&&p.ws===ws);if(!p)return;
  const host=p.i===0;
  const replaceWithCpu=!!(r.started&&r.cpuFill&&!host);
  r.players=r.players.filter(q=>q!==p);
  if(host){
    if(r.soloHostCloseTimer){clearTimeout(r.soloHostCloseTimer);r.soloHostCloseTimer=null;}
    broadcast(r,{t:'closed',reason:'El anfitrion cerro la sala.'});
    rooms.delete(r.code);
  }else{
    const players=roster(r);
    broadcast(r,{t:'lobby',code:r.code,players,cpuFill:!!r.cpuFill,canStart:canStartRoom(r),started:!!r.started});
    if(r.started){
      if(replaceWithCpu)broadcast(r,{t:'player-cpu-replaced',name:p.n,index:p.i});
      else broadcast(r,{t:'player-left-live',name:p.n,index:p.i});
    }
    scheduleSoloHostClose(r,wss,3000);
  }
  publicUpdate(wss);
}
function disconnect(ws,wss){
  const x=info.get(ws);if(!x)return;info.delete(ws);
  const r=rooms.get(x.code);if(!r)return;
  const p=r.players.find(p=>p.i===x.i&&p.ws===ws);if(!p)return;
  p.ws=null;p.disconnectedAt=Date.now();p.voiceReady=false;
  if(!r.started){const players=roster(r);broadcast(r,{t:'lobby',code:r.code,players,cpuFill:!!r.cpuFill,canStart:false});}
  publicUpdate(wss);
}
function expireDisconnectedPlayers(wss){
  const now=Date.now();
  for(const r of [...rooms.values()]){
    const expired=r.players.filter(p=>!p.ws&&p.disconnectedAt&&now-p.disconnectedAt>=RECONNECT_GRACE_MS);
    if(!expired.length)continue;
    if(r.started){
      const hostLost=expired.some(p=>p.i===0);
      if(hostLost){
        broadcast(r,{t:'closed',reason:'El anfitrion perdio la conexion.'});
        rooms.delete(r.code);publicUpdate(wss);continue;
      }
      if(r.cpuFill){
        for(const p of expired)r.players=r.players.filter(q=>q!==p);
        const players=roster(r);
        broadcast(r,{t:'lobby',code:r.code,players,cpuFill:true,canStart:false,started:true});
        for(const p of expired)broadcast(r,{t:'player-cpu-replaced',name:p.n,index:p.i});
        publicUpdate(wss);continue;
      }
      for(const p of expired)if(p.i!==0)r.players=r.players.filter(q=>q!==p);
      const players=roster(r);
      broadcast(r,{t:'lobby',code:r.code,players,cpuFill:false,canStart:false,started:true});
      for(const p of expired)if(p.i!==0)broadcast(r,{t:'player-left-live',name:p.n,index:p.i});
      scheduleSoloHostClose(r,wss,3000);
      publicUpdate(wss);continue;
    }
    let hostLost=false;
    for(const p of expired){if(p.i===0)hostLost=true;r.players=r.players.filter(q=>q!==p);}
    if(hostLost||!r.players.length){broadcast(r,{t:'closed',reason:'El anfitrion perdio la conexion.'});rooms.delete(r.code);}
    else{const players=roster(r);broadcast(r,{t:'lobby',code:r.code,players,cpuFill:!!r.cpuFill,canStart:canStartRoom(r)});}
    publicUpdate(wss);
  }
}

async function recordRankedMatch(room,winner){
  if(!db||!room||room.rankRecorded||!room.rankEligible||!room.rankMatchId)return false;
  room.rankRecorded=true;
  try{
    if(!await ensureDatabase()){room.rankRecorded=false;return false;}
    // La partida necesita al menos dos humanos. Solo los registrados entran
    // en la tabla de ranking; invitados y CPU juegan pero no alteran su ficha.
    if(room.players.length<2){room.rankRecorded=false;return false;}
    const players=room.players.filter(p=>p.registered&&p.userId);
    if(!players.length){room.rankRecorded=false;return false;}
    const winnerUserId=winner&&winner.registered&&winner.userId?Number(winner.userId):null;
    const client=await db.connect();
    try{
      await client.query('BEGIN');
      const inserted=await client.query(
        `INSERT INTO galaxy_ranked_matches(match_id,room_code,winner_user_id)
         VALUES($1,$2,$3) ON CONFLICT(match_id) DO NOTHING RETURNING match_id`,
        [room.rankMatchId,room.code,winnerUserId]
      );
      if(!inserted.rowCount){
        await client.query('ROLLBACK');
        return false;
      }
      for(const p of players){
        await client.query(
          `INSERT INTO galaxy_ranked_match_players(match_id,user_id,player_index)
           VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
          [room.rankMatchId,p.userId,p.i]
        );
      }
      await client.query('COMMIT');
      console.log(`[Galaxy Combat P2P] Partida rankeada ${room.rankMatchId} registrada. Registrados: ${players.length}. Ganador: ${winnerUserId===null?'invitado/CPU':winnerUserId}`);
      return true;
    }catch(err){try{await client.query('ROLLBACK');}catch(_){}throw err;}
    finally{client.release();}
  }catch(err){room.rankRecorded=false;console.error('[Galaxy Combat P2P] Error guardando partida:',err&&err.message||err);return false;}
}

function sendJson(res,status,obj){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(obj));}
function readJsonBody(req,maxBytes=16384){
  return new Promise((resolve,reject)=>{
    let size=0;const chunks=[];
    req.on('data',chunk=>{size+=chunk.length;if(size>maxBytes){reject(new Error('body-too-large'));req.destroy();return;}chunks.push(chunk);});
    req.on('end',()=>{try{resolve(chunks.length?JSON.parse(Buffer.concat(chunks).toString('utf8')):{});}catch(_){reject(new Error('bad-json'));}});
    req.on('error',reject);
  });
}
function bearerToken(req){const raw=String(req.headers.authorization||'');const m=/^Bearer\s+([a-f0-9]{64})$/i.exec(raw.trim());return m?m[1]:'';}
function trainingKey(req){return String(req.headers['x-training-key']||'').trim().slice(0,256);}
function safeSecretEqual(a,b){
  const ah=createHash('sha256').update(String(a||'')).digest();
  const bh=createHash('sha256').update(String(b||'')).digest();
  return timingSafeEqual(ah,bh);
}
async function requireTrainingAdmin(req,res){
  if(!TRAINING_ADMIN_KEY){
    sendJson(res,503,{ok:false,code:'TRAINING_ADMIN_NOT_CONFIGURED',message:'Entrenamiento privado no configurado.'});
    return false;
  }
  const supplied=trainingKey(req);
  if(!supplied||!safeSecretEqual(supplied,TRAINING_ADMIN_KEY)){
    sendJson(res,403,{ok:false,code:'FORBIDDEN',message:'Clave de entrenamiento incorrecta.'});
    return false;
  }
  return true;
}
async function getCpuLearningControl(client=db){
  const {rows}=await client.query('SELECT auto_training_enabled,local_hard_enabled,updated_at FROM galaxy_cpu_learning_control WHERE id=1 LIMIT 1');
  const row=rows[0]||{};
  return{
    autoTrainingEnabled:row.auto_training_enabled!==false,
    localHardEnabled:row.local_hard_enabled!==false,
    updatedAt:row.updated_at||null
  };
}

const CPU_BRAIN_MAX_STRATEGIES=40;
const CPU_BRAIN_MAX_CANDIDATES=32;
const CPU_BRAIN_MAX_BYTES=32768;
const CPU_ACTIONS=new Set(['attack','evade','resource','scatter','meteor_left','meteor_right','meteor_brake']);
function safeCpuContext(v){
  const s=String(v||'');
  return s==='open3'||/^a[012]-s[01]-d[012]-e[01]$/.test(s)||/^meteor-s[01]-v[01]-d[01]$/.test(s)?s:'';
}
function normalizeCpuBrain(raw){
  const brain=raw&&typeof raw==='object'?raw:{};
  const out={version:Math.max(1,Number(brain.version)||1),strategies:[],candidates:[]};
  for(const src of Array.isArray(brain.strategies)?brain.strategies:[]){
    const context=safeCpuContext(src&&src.context),action=String(src&&src.action||'');
    if(!context||!CPU_ACTIONS.has(action))continue;
    const samples=Math.max(1,Math.min(100000,Math.round(Number(src.samples)||1)));
    const total=Math.max(-200000,Math.min(200000,Number(src.total)||0));
    out.strategies.push({context,action,samples,total});
    if(out.strategies.length>=CPU_BRAIN_MAX_STRATEGIES)break;
  }
  for(const src of Array.isArray(brain.candidates)?brain.candidates:[]){
    const context=safeCpuContext(src&&src.context),action=String(src&&src.action||'');
    if(!context||!CPU_ACTIONS.has(action))continue;
    const samples=Math.max(1,Math.min(1000,Math.round(Number(src.samples)||1)));
    const total=Math.max(-2000,Math.min(2000,Number(src.total)||0));
    out.candidates.push({context,action,samples,total});
    if(out.candidates.length>=CPU_BRAIN_MAX_CANDIDATES)break;
  }
  return out;
}
function cpuEntryScore(e){return e&&e.samples?e.total/e.samples:0;}
function summarizeCpuDeltas(deltas){
  let appliedDeltas=0,sampleUses=0;
  for(const d of (Array.isArray(deltas)?deltas:[]).slice(0,24)){
    const context=safeCpuContext(d&&d.context),action=String(d&&d.action||'');
    if(!context||!CPU_ACTIONS.has(action))continue;
    const uses=Math.max(1,Math.min(4,Math.round(Number(d.uses)||1)));
    appliedDeltas++;sampleUses+=uses;
  }
  return{appliedDeltas,sampleUses};
}
function mergeCpuBrain(rawBrain,deltas){
  const brain=normalizeCpuBrain(rawBrain);
  const valid=(Array.isArray(deltas)?deltas:[]).slice(0,24);
  let applied=0;
  for(const d of valid){
    const context=safeCpuContext(d&&d.context),action=String(d&&d.action||'');
    if(!context||!CPU_ACTIONS.has(action))continue;
    applied++;
    const reward=Math.max(-2,Math.min(2,Number(d.reward)||0));
    const uses=Math.max(1,Math.min(4,Math.round(Number(d.uses)||1)));
    let e=brain.strategies.find(x=>x.context===context&&x.action===action);
    if(e){
      e.samples=Math.min(100000,e.samples+uses);e.total=Math.max(-200000,Math.min(200000,e.total+reward*uses));
      continue;
    }
    if(brain.strategies.length<CPU_BRAIN_MAX_STRATEGIES){
      brain.strategies.push({context,action,samples:uses,total:reward*uses});
      continue;
    }
    let c=brain.candidates.find(x=>x.context===context&&x.action===action);
    if(!c){
      if(brain.candidates.length>=CPU_BRAIN_MAX_CANDIDATES){
        brain.candidates.sort((a,b)=>a.samples-b.samples||cpuEntryScore(a)-cpuEntryScore(b));
        brain.candidates.shift();
      }
      c={context,action,samples:0,total:0};brain.candidates.push(c);
    }
    c.samples=Math.min(1000,c.samples+uses);c.total+=reward*uses;
    if(c.samples>=5){
      let worstIndex=0,worstScore=Infinity;
      for(let i=0;i<brain.strategies.length;i++){
        const x=brain.strategies[i];
        const score=cpuEntryScore(x)-(Math.min(5,x.samples)<5?.18:0);
        if(score<worstScore){worstScore=score;worstIndex=i;}
      }
      const candidateScore=cpuEntryScore(c);
      if(candidateScore>worstScore+.15){
        brain.strategies[worstIndex]={context:c.context,action:c.action,samples:c.samples,total:c.total};
        brain.candidates=brain.candidates.filter(x=>x!==c);
      }
    }
  }
  if(applied>0)brain.version=Math.max(1,Number(brain.version)||1)+1;
  while(Buffer.byteLength(JSON.stringify(brain),'utf8')>CPU_BRAIN_MAX_BYTES&&brain.candidates.length)brain.candidates.shift();
  while(Buffer.byteLength(JSON.stringify(brain),'utf8')>CPU_BRAIN_MAX_BYTES&&brain.strategies.length>8)brain.strategies.shift();
  return brain;
}

async function authApi(req,res,url){
  if(!db){sendJson(res,503,{ok:false,code:'DB_NOT_CONFIGURED',message:'Cuentas aun no configuradas en el servidor.'});return true;}
  if(!await ensureDatabase()){sendJson(res,503,{ok:false,code:'DB_UNAVAILABLE',message:'Servicio de cuentas no disponible.'});return true;}

  if(url==='/api/auth/register'&&req.method==='POST'){
    let body;try{body=await readJsonBody(req);}catch(_){sendJson(res,400,{ok:false,code:'BAD_REQUEST'});return true;}
    const username=normalizeUsername(body.username),email=normalizeEmail(body.email),password=String(body.password||'');
    if(!validRegisteredUsername(username)){sendJson(res,400,{ok:false,code:'BAD_USERNAME',message:'Nombre de 2 a 16 caracteres: letras, numeros, espacio, _ o -.'});return true;}
    if(!validEmail(email)){sendJson(res,400,{ok:false,code:'BAD_EMAIL',message:'Correo no valido.'});return true;}
    if(password.length<PASSWORD_MIN_LENGTH||password.length>128){sendJson(res,400,{ok:false,code:'BAD_PASSWORD',message:`La clave debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres.`});return true;}
    const pw=await hashPassword(password);
    try{
      const {rows}=await db.query(`INSERT INTO galaxy_users(username,username_key,email,email_key,password_salt,password_hash) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,username,email`,[username,usernameKey(username),email,email,pw.salt,pw.hash]);
      const user=rows[0];const token=await createSession(user.id);
      sendJson(res,201,{ok:true,token,user:{id:Number(user.id),username:user.username,email:user.email}});
    }catch(err){
      if(err&&err.code==='23505'){
        const detail=String(err.constraint||err.detail||'');const code=detail.includes('email')?'EMAIL_TAKEN':'USERNAME_TAKEN';
        sendJson(res,409,{ok:false,code,message:code==='EMAIL_TAKEN'?'Ese correo ya esta registrado.':'Ese nombre ya esta registrado.'});
      }else{console.error(err);sendJson(res,500,{ok:false,code:'SERVER_ERROR'});}
    }
    return true;
  }
  if(url==='/api/auth/login'&&req.method==='POST'){
    let body;try{body=await readJsonBody(req);}catch(_){sendJson(res,400,{ok:false,code:'BAD_REQUEST'});return true;}
    const key=usernameKey(body.username),password=String(body.password||'');
    const {rows}=await db.query('SELECT id,username,email,password_salt,password_hash FROM galaxy_users WHERE username_key=$1 LIMIT 1',[key]);
    const user=rows[0];
    if(!user||!await verifyPassword(password,user.password_salt,user.password_hash)){sendJson(res,401,{ok:false,code:'INVALID_LOGIN',message:'Nombre o clave incorrectos.'});return true;}
    const token=await createSession(user.id);
    sendJson(res,200,{ok:true,token,user:{id:Number(user.id),username:user.username,email:user.email}});return true;
  }
  if(url==='/api/auth/logout'&&req.method==='POST'){
    const token=bearerToken(req);if(token)await db.query('DELETE FROM galaxy_sessions WHERE token_hash=$1',[tokenHash(token)]);
    sendJson(res,200,{ok:true});return true;
  }
  if(url==='/api/auth/me'&&req.method==='GET'){
    const user=await userFromSessionToken(bearerToken(req));
    if(!user){sendJson(res,401,{ok:false,code:'UNAUTHORIZED'});return true;}
    sendJson(res,200,{ok:true,user:{id:Number(user.id),username:user.username,email:user.email}});return true;
  }
  if(url==='/api/cpu-learning-status'&&req.method==='GET'){
    const control=await getCpuLearningControl();
    sendJson(res,200,{ok:true,control});
    return true;
  }
  if(url==='/api/cpu-training/test-room-permit'&&req.method==='POST'){
    const allowed=await requireTrainingAdmin(req,res);if(!allowed)return true;
    let body;try{body=await readJsonBody(req,2048);}catch(_){sendJson(res,400,{ok:false,code:'BAD_REQUEST'});return true;}
    const maxRooms=Math.max(1,Math.min(TEST_ROOM_PERMIT_MAX,Math.floor(Number(body.maxRooms)||2)));
    cleanupTestRoomPermits();
    const token=randomBytes(32).toString('hex');
    const expiresAt=Date.now()+TEST_ROOM_PERMIT_TTL_MS;
    testRoomPermits.set(tokenHash(token),{maxRooms,expiresAt});
    sendJson(res,200,{ok:true,token,maxRooms,expiresAt,ttlMs:TEST_ROOM_PERMIT_TTL_MS});
    return true;
  }
  if(url==='/api/cpu-training/access'&&req.method==='GET'){
    const allowed=await requireTrainingAdmin(req,res);if(!allowed)return true;
    const [{rows},control]=await Promise.all([
      db.query('SELECT matches,updated_at FROM galaxy_cpu_training_stats WHERE id=1 LIMIT 1'),
      getCpuLearningControl()
    ]);
    const row=rows[0]||{matches:0,updated_at:null};
    sendJson(res,200,{ok:true,trainingMatches:Number(row.matches)||0,updatedAt:row.updated_at||null,control});
    return true;
  }
  if(url==='/api/cpu-training/control'&&req.method==='POST'){
    const allowed=await requireTrainingAdmin(req,res);if(!allowed)return true;
    let body;try{body=await readJsonBody(req,4096);}catch(_){sendJson(res,400,{ok:false,code:'BAD_REQUEST'});return true;}
    const current=await getCpuLearningControl();
    const autoTrainingEnabled=typeof body.autoTrainingEnabled==='boolean'?body.autoTrainingEnabled:current.autoTrainingEnabled;
    const localHardEnabled=typeof body.localHardEnabled==='boolean'?body.localHardEnabled:current.localHardEnabled;
    const {rows}=await db.query(
      'UPDATE galaxy_cpu_learning_control SET auto_training_enabled=$1,local_hard_enabled=$2,updated_at=NOW() WHERE id=1 RETURNING auto_training_enabled,local_hard_enabled,updated_at',
      [autoTrainingEnabled,localHardEnabled]
    );
    const row=rows[0]||{};
    sendJson(res,200,{ok:true,control:{
      autoTrainingEnabled:row.auto_training_enabled!==false,
      localHardEnabled:row.local_hard_enabled!==false,
      updatedAt:row.updated_at||null
    }});
    return true;
  }
  if(url==='/api/cpu-brain/train-learn'&&req.method==='POST'){
    const allowed=await requireTrainingAdmin(req,res);if(!allowed)return true;
    let body;try{body=await readJsonBody(req,16384);}catch(_){sendJson(res,400,{ok:false,code:'BAD_REQUEST'});return true;}
    const control=await getCpuLearningControl();
    if(!control.autoTrainingEnabled){
      sendJson(res,200,{ok:true,skipped:true,reason:'AUTO_TRAINING_PAUSED',control});
      return true;
    }
    const deltas=Array.isArray(body&&body.deltas)?body.deltas:[];
    const learning=summarizeCpuDeltas(deltas);
    const client=await db.connect();
    try{
      await client.query('BEGIN');
      const {rows}=await client.query('SELECT version,brain FROM galaxy_cpu_brain WHERE id=1 FOR UPDATE');
      const current=rows[0]||{version:1,brain:{version:1,strategies:[],candidates:[]}};
      const brain=mergeCpuBrain(current.brain,deltas);
      const bytes=Buffer.byteLength(JSON.stringify(brain),'utf8');
      await client.query('UPDATE galaxy_cpu_brain SET version=$1,brain=$2::jsonb,updated_at=NOW() WHERE id=1',[brain.version,JSON.stringify(brain)]);
      const stat=await client.query(`UPDATE galaxy_cpu_training_stats
        SET matches=matches+1,updated_at=NOW() WHERE id=1 RETURNING matches`);
      await client.query('COMMIT');
      sendJson(res,200,{
        ok:true,
        learned:learning.appliedDeltas>0,
        appliedDeltas:learning.appliedDeltas,
        sampleUses:learning.sampleUses,
        version:brain.version,
        bytes,
        trainingMatches:Number(stat.rows[0]&&stat.rows[0].matches)||0,
        brain:{version:brain.version,strategies:brain.strategies,candidates:brain.candidates}
      });
    }catch(err){
      try{await client.query('ROLLBACK');}catch(_){}
      console.error('[Galaxy Combat P2P] Error entrenamiento CPU:',err&&err.message||err);
      sendJson(res,500,{ok:false,code:'CPU_TRAINING_ERROR'});
    }finally{client.release();}
    return true;
  }
  if(url==='/api/cpu-brain'&&req.method==='GET'){
    const [{rows},{rows:trainingRows},control]=await Promise.all([
      db.query('SELECT version,brain,updated_at FROM galaxy_cpu_brain WHERE id=1 LIMIT 1'),
      db.query('SELECT matches,updated_at FROM galaxy_cpu_training_stats WHERE id=1 LIMIT 1'),
      getCpuLearningControl()
    ]);
    const row=rows[0]||{version:1,brain:{version:1,strategies:[],candidates:[]},updated_at:null};
    const training=trainingRows[0]||{matches:0,updated_at:null};
    const brain=normalizeCpuBrain(row.brain);
    const bytes=Buffer.byteLength(JSON.stringify(brain),'utf8');
    sendJson(res,200,{
      ok:true,
      version:Number(row.version)||1,
      updatedAt:row.updated_at||null,
      bytes,
      maxBytes:CPU_BRAIN_MAX_BYTES,
      training:{matches:Number(training.matches)||0,updatedAt:training.updated_at||null},
      control,
      brain:{version:brain.version,strategies:brain.strategies,candidates:brain.candidates}
    });
    return true;
  }
  if(url==='/api/cpu-brain/learn'&&req.method==='POST'){
    let body;try{body=await readJsonBody(req,16384);}catch(_){sendJson(res,400,{ok:false,code:'BAD_REQUEST'});return true;}
    const control=await getCpuLearningControl();
    if(!control.localHardEnabled){
      sendJson(res,200,{ok:true,skipped:true,reason:'LOCAL_HARD_LEARNING_PAUSED',control});
      return true;
    }
    const deltas=Array.isArray(body&&body.deltas)?body.deltas:[];
    const client=await db.connect();
    try{
      await client.query('BEGIN');
      const {rows}=await client.query('SELECT version,brain FROM galaxy_cpu_brain WHERE id=1 FOR UPDATE');
      const current=rows[0]||{version:1,brain:{version:1,strategies:[],candidates:[]}};
      const brain=mergeCpuBrain(current.brain,deltas);
      const bytes=Buffer.byteLength(JSON.stringify(brain),'utf8');
      await client.query('UPDATE galaxy_cpu_brain SET version=$1,brain=$2::jsonb,updated_at=NOW() WHERE id=1',[brain.version,JSON.stringify(brain)]);
      await client.query('COMMIT');
      sendJson(res,200,{ok:true,version:brain.version,strategies:brain.strategies.length,bytes});
    }catch(err){
      try{await client.query('ROLLBACK');}catch(_){}
      console.error('[Galaxy Combat P2P] Error actualizando CPU brain:',err&&err.message||err);
      sendJson(res,500,{ok:false,code:'CPU_BRAIN_ERROR'});
    }finally{client.release();}
    return true;
  }
  if(url==='/api/analytics/event'&&req.method==='POST'){
    let body;try{body=await readJsonBody(req,4096);}catch(_){sendJson(res,400,{ok:false,code:'BAD_REQUEST'});return true;}
    const type=String(body&&body.type||'');
    if(type!=='visit'&&type!=='cpu_match'){sendJson(res,400,{ok:false,code:'BAD_EVENT'});return true;}
    const column=type==='visit'?'visits':'cpu_matches';
    await db.query(
      `INSERT INTO galaxy_analytics_daily(day,${column}) VALUES(CURRENT_DATE,1)
       ON CONFLICT(day) DO UPDATE SET ${column}=galaxy_analytics_daily.${column}+1`
    );
    sendJson(res,200,{ok:true});return true;
  }
  if(url==='/api/analytics'&&req.method==='GET'){
    const [{rows:totalsRows},{rows:daily},{rows:rankRows}]=await Promise.all([
      db.query(`SELECT
        COALESCE(SUM(visits),0)::int AS visits,
        COALESCE(SUM(cpu_matches),0)::int AS cpu_matches,
        COALESCE(SUM(online_matches),0)::int AS online_matches
        FROM galaxy_analytics_daily`),
      db.query(`SELECT day::text,visits,cpu_matches,online_matches
        FROM galaxy_analytics_daily
        WHERE day>=CURRENT_DATE-INTERVAL '29 days'
        ORDER BY day ASC`),
      db.query('SELECT COUNT(*)::int AS ranked_completed FROM galaxy_ranked_matches')
    ]);
    const t=totalsRows[0]||{visits:0,cpu_matches:0,online_matches:0};
    const ranked=rankRows[0]||{ranked_completed:0};
    sendJson(res,200,{
      ok:true,
      totals:{
        visits:Number(t.visits)||0,
        cpuMatches:Number(t.cpu_matches)||0,
        onlineMatches:Number(t.online_matches)||0,
        matches:(Number(t.cpu_matches)||0)+(Number(t.online_matches)||0),
        rankedCompleted:Number(ranked.ranked_completed)||0
      },
      daily:daily.map(r=>({
        day:r.day,
        visits:Number(r.visits)||0,
        cpuMatches:Number(r.cpu_matches)||0,
        onlineMatches:Number(r.online_matches)||0
      }))
    });
    return true;
  }
  if(url==='/api/ranking'&&req.method==='GET'){
    const {rows}=await db.query(`
      WITH stats AS (
        SELECT u.id,u.username,COUNT(DISTINCT mp.match_id)::int AS played,COUNT(DISTINCT CASE WHEN m.winner_user_id=u.id THEN m.match_id END)::int AS wins
        FROM galaxy_users u LEFT JOIN galaxy_ranked_match_players mp ON mp.user_id=u.id LEFT JOIN galaxy_ranked_matches m ON m.match_id=mp.match_id
        GROUP BY u.id,u.username
      ), strength AS (
        SELECT m.winner_user_id AS id,COALESCE(SUM(opponent_stats.wins),0)::bigint AS opponent_strength
        FROM galaxy_ranked_matches m JOIN galaxy_ranked_match_players opp ON opp.match_id=m.match_id AND opp.user_id<>m.winner_user_id
        JOIN stats opponent_stats ON opponent_stats.id=opp.user_id GROUP BY m.winner_user_id
      ), ranked AS (
        SELECT s.id,s.username,s.played,s.wins,(s.played-s.wins) AS losses,COALESCE(st.opponent_strength,0) AS opponent_strength,
        ROW_NUMBER() OVER (ORDER BY s.wins DESC,COALESCE(st.opponent_strength,0) DESC,(s.played-s.wins) ASC,s.id ASC)::int AS position
        FROM stats s LEFT JOIN strength st ON st.id=s.id
      ) SELECT position,username,played,wins,losses FROM ranked ORDER BY position ASC LIMIT 100`);
    sendJson(res,200,{ok:true,ranking:rows});return true;
  }
  if(url==='/api/ranking/me'&&req.method==='GET'){
    const user=await userFromSessionToken(bearerToken(req));
    if(!user){sendJson(res,401,{ok:false,code:'UNAUTHORIZED'});return true;}
    const {rows}=await db.query(`
      WITH stats AS (
        SELECT u.id,COUNT(DISTINCT mp.match_id)::int AS played,COUNT(DISTINCT CASE WHEN m.winner_user_id=u.id THEN m.match_id END)::int AS wins
        FROM galaxy_users u LEFT JOIN galaxy_ranked_match_players mp ON mp.user_id=u.id LEFT JOIN galaxy_ranked_matches m ON m.match_id=mp.match_id GROUP BY u.id
      ), strength AS (
        SELECT m.winner_user_id AS id,COALESCE(SUM(opponent_stats.wins),0)::bigint AS opponent_strength
        FROM galaxy_ranked_matches m JOIN galaxy_ranked_match_players opp ON opp.match_id=m.match_id AND opp.user_id<>m.winner_user_id
        JOIN stats opponent_stats ON opponent_stats.id=opp.user_id GROUP BY m.winner_user_id
      ), ranked AS (
        SELECT s.id,s.played,s.wins,(s.played-s.wins) AS losses,COALESCE(st.opponent_strength,0) AS opponent_strength,
        ROW_NUMBER() OVER (ORDER BY s.wins DESC,COALESCE(st.opponent_strength,0) DESC,(s.played-s.wins) ASC,s.id ASC)::int AS position
        FROM stats s LEFT JOIN strength st ON st.id=s.id
      ) SELECT played,wins,losses,position FROM ranked WHERE id=$1`,[user.id]);
    sendJson(res,200,{ok:true,ranking:rows[0]||{played:0,wins:0,losses:0,position:1}});return true;
  }
  if(url==='/api/rank-result'&&req.method==='POST'){
    let body;try{body=await readJsonBody(req);}catch(_){sendJson(res,400,{ok:false,code:'BAD_REQUEST'});return true;}
    const code=String(body.roomCode||'').trim().toUpperCase();
    const winnerIndex=Number(body.winnerIndex);
    const hostToken=String(body.hostToken||'').trim();
    const room=rooms.get(code);
    if(!room||!room.started){sendJson(res,404,{ok:false,code:'ROOM_NOT_FOUND'});return true;}
    const host=room.players.find(p=>p.i===0);
    if(!host||!/^[a-f0-9]{48}$/i.test(hostToken)||host.playerToken!==hostToken){
      sendJson(res,403,{ok:false,code:'HOST_REQUIRED'});return true;
    }
    const rankRound=Math.max(0,Number(body.rankRound)||0);
    if(rankRound&&rankRound!==Number(room.rankRound||0)){sendJson(res,409,{ok:false,code:'STALE_ROUND'});return true;}
    const winner=room.players.find(p=>p.i===winnerIndex)||null;
    const syntheticWinner=!winner&&room.cpuFill&&Number.isInteger(winnerIndex)&&winnerIndex>=0&&winnerIndex<MAX_PLAYERS;
    if(!winner&&!syntheticWinner){sendJson(res,400,{ok:false,code:'BAD_WINNER'});return true;}
    const registeredHumans=room.players.filter(p=>p.registered&&p.userId);
    room.rankEligible=room.players.length>=2&&registeredHumans.length>0;
    if(!room.rankEligible){
      sendJson(res,200,{ok:true,ranked:false,reason:room.players.length<2?'NOT_ENOUGH_HUMANS':'NO_REGISTERED_PLAYERS'});return true;
    }
    const recorded=await recordRankedMatch(room,winner);
    sendJson(res,200,{ok:true,ranked:!!recorded});return true;
  }
  return false;
}

function rtcIceServers(){
  const iceServers=[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'}];
  const rawUrls=String(process.env.TURN_URLS||process.env.TURN_URL||'').trim();
  const username=String(process.env.TURN_USERNAME||'').trim();
  const credential=String(process.env.TURN_CREDENTIAL||'').trim();
  if(rawUrls&&username&&credential){const urls=rawUrls.split(',').map(x=>x.trim()).filter(Boolean);if(urls.length)iceServers.push({urls:urls.length===1?urls[0]:urls,username,credential});}
  return iceServers;
}

const server=http.createServer(async(req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization, X-Training-Key');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
  res.setHeader('Cache-Control','no-store');
  if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
  const url=(req.url||'/').split('?')[0];
  try{if(url.startsWith('/api/')&&await authApi(req,res,url))return;}
  catch(err){console.error('[Galaxy Combat P2P] API error:',err);sendJson(res,500,{ok:false,code:'SERVER_ERROR'});return;}
  if(url==='/health'){sendJson(res,200,{ok:true,service:'Galaxy Combat P2P signaling',accounts:!!db,rooms:rooms.size});return;}
  if(url==='/rtc-config'){sendJson(res,200,{iceServers:rtcIceServers()});return;}
  res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'});
  res.end('Galaxy Combat P2P signaling server online. Physics run on the host browser.\n');
});

const wss=new WebSocketServer({server,path:'/ws',perMessageDeflate:false});

wss.on('connection',(ws,req)=>{
  const detectedIp=requestIp(req);
  connectionMeta.set(ws,{ip:detectedIp==='unknown'?('unknown-'+randomBytes(8).toString('hex')):detectedIp});
  send(ws,{t:'hello',p2p:true,accounts:!!db});
  send(ws,{t:'public-rooms',rooms:publicRooms()});

  ws.on('message',async raw=>{
    let m;try{m=JSON.parse(String(raw));}catch(_){return;}

    if(m.t==='create'){
      if(info.get(ws)){send(ws,{t:'error',message:'YA ESTAS EN UNA SALA ACTIVA.'});return;}
      const identity=await resolvePlayerIdentity(m);
      if(identity.error){send(ws,{t:'error',message:identity.error});return;}
      const creator=roomCreationIdentity(identity,m,ws);
      if(!creator.testMode&&(
        activeRoomParticipations(creator.creatorKey)>=1||
        activeIpParticipations(creator.ipKey)>=1
      )){
        send(ws,{t:'error',message:'YA ESTAS EN UNA SALA ACTIVA.'});
        return;
      }
      if(activeHostedRooms(creator.creatorKey)>=creator.roomLimit){
        send(ws,{t:'error',message:creator.testMode?'LIMITE DE SALAS DE PRUEBA ALCANZADO.':'YA ESTAS EN UNA SALA ACTIVA.'});
        return;
      }
      const r={code:roomCode(),public:!!m.public,lang:String(m.lang||'es'),started:false,players:[],cpuFill:false,rankEligible:false,rankRecorded:false,rankMatchId:null,rankRound:0,createdAt:Date.now(),creatorKey:creator.creatorKey,testMode:creator.testMode};
      const p={i:0,n:identity.name,ws,userId:identity.userId,registered:identity.registered,participantKey:creator.creatorKey,ipKey:creator.ipKey,playerToken:newPlayerToken(),disconnectedAt:0,voiceReady:false};
      r.players.push(p);rooms.set(r.code,r);info.set(ws,{code:r.code,i:0});
      send(ws,{t:'created',code:r.code,index:0,public:r.public,playerToken:p.playerToken,registered:p.registered,p2p:true});
      broadcast(r,{t:'lobby',code:r.code,players:roster(r),cpuFill:false,canStart:false});publicUpdate(wss);return;
    }

    if(m.t==='join'){
      const r=rooms.get(String(m.code||'').trim().toUpperCase());
      const liveJoin=!!(r&&r.started&&r.cpuFill&&r.players.length<MAX_PLAYERS&&r.players[0]&&r.players[0].ws);
      if(!r||r.players.length>=MAX_PLAYERS||(r.started&&!liveJoin)){send(ws,{t:'error',message:'Sala no disponible.'});return;}
      if(info.get(ws)){send(ws,{t:'error',message:'YA ESTAS EN UNA SALA ACTIVA.'});return;}
      const identity=await resolvePlayerIdentity(m);
      if(identity.error){send(ws,{t:'error',message:identity.error});return;}
      const participant=roomCreationIdentity(identity,m,ws);
      if(!participant.testMode&&(
        activeRoomParticipations(participant.creatorKey)>=1||
        activeIpParticipations(participant.ipKey)>=1
      )){
        send(ws,{t:'error',message:'YA ESTAS EN UNA SALA ACTIVA.'});
        return;
      }

      // Revalidar la plaza despues de cualquier consulta asincrona de cuenta:
      // dos jugadores pueden pulsar UNIRTE casi a la vez sobre la misma CPU.
      const used=new Set(r.players.map(p=>p.i));
      let i=-1;
      const hasRequestedSlot=Object.prototype.hasOwnProperty.call(m,'slot')&&m.slot!==null&&m.slot!=='';
      const requestedSlot=hasRequestedSlot?Number(m.slot):NaN;
      if(hasRequestedSlot&&Number.isInteger(requestedSlot)){
        // Una plaza seleccionable representa una CPU sintetica del relleno.
        // Se puede ocupar antes de empezar o durante la partida.
        if(!r.cpuFill||requestedSlot<0||requestedSlot>=MAX_PLAYERS||used.has(requestedSlot)){
          send(ws,{t:'error',message:'Sala no disponible.'});
          send(ws,{t:'public-rooms',rooms:publicRooms()});
          return;
        }
        i=requestedSlot;
      }else{
        // Union normal: funciona haya o no CPU de relleno, siempre que exista
        // una plaza humana libre en una sala que aun esta esperando.
        for(let slot=0;slot<MAX_PLAYERS;slot++)if(!used.has(slot)){i=slot;break;}
      }
      if(i<0){send(ws,{t:'error',message:'Sala llena.'});return;}

      const p={i,n:identity.name,ws,userId:identity.userId,registered:identity.registered,participantKey:participant.creatorKey,ipKey:participant.ipKey,playerToken:newPlayerToken(),disconnectedAt:0,voiceReady:false};
      r.players.push(p);info.set(ws,{code:r.code,i});
      const players=roster(r);
      send(ws,{t:'joined',code:r.code,index:i,public:r.public,playerToken:p.playerToken,registered:p.registered,p2p:true,started:!!r.started,players,cpuFill:!!r.cpuFill,liveJoin});
      broadcast(r,{t:'lobby',code:r.code,players,cpuFill:!!r.cpuFill,canStart:canStartRoom(r),started:!!r.started});
      if(liveJoin)broadcast(r,{t:'player-joined-live',name:p.n,index:p.i});
      publicUpdate(wss);return;
    }

    if(m.t==='resume'){
      const code=String(m.code||'').trim().toUpperCase(),token=String(m.token||'').trim();
      const room=rooms.get(code),p=room&&room.players.find(q=>q.playerToken===token);
      if(!room||!p||!/^[a-f0-9]{48}$/i.test(token)){send(ws,{t:'resume-failed',message:'La partida ya no se puede recuperar.'});return;}
      if(p.disconnectedAt&&Date.now()-p.disconnectedAt>=RECONNECT_GRACE_MS){send(ws,{t:'resume-failed',message:'Ha pasado el tiempo de reconexion.'});return;}
      const oldWs=p.ws;
      if(oldWs&&oldWs!==ws){info.delete(oldWs);try{oldWs.close(4001,'Sesion recuperada desde otra conexion');}catch(_){}}
      p.ws=ws;p.disconnectedAt=0;p.voiceReady=false;info.set(ws,{code:room.code,i:p.i});
      const players=roster(room);
      send(ws,{t:'resumed',code:room.code,index:p.i,host:p.i===0,started:!!room.started,finished:false,playerToken:p.playerToken,players,cpuFill:!!room.cpuFill,p2p:true});
      broadcast(room,{t:'lobby',code:room.code,players,cpuFill:!!room.cpuFill,canStart:canStartRoom(room)});
      if(room.started&&p.i!==0){const host=room.players.find(q=>q.i===0);if(host&&host.ws)send(host.ws,{t:'p2p-reconnect',from:p.i});}
      publicUpdate(wss);return;
    }

    const x=info.get(ws),r=x&&rooms.get(x.code);if(!r)return;

    if(m.t==='cpu-fill'&&x.i===0&&!r.started){
      r.cpuFill=!!m.on;
      const players=roster(r);
      broadcast(r,{t:'lobby',code:r.code,players,cpuFill:r.cpuFill,canStart:canStartRoom(r)});
      publicUpdate(wss);return;
    }

    const startPlayers=roster(r);
    if(m.t==='start'&&x.i===0&&canStartRoom(r)){
      r.started=true;r.rankRecorded=false;r.rankMatchId=randomBytes(24).toString('hex');r.rankRound=1;
      if(db){
        try{
          await ensureDatabase();
          await db.query(`INSERT INTO galaxy_analytics_daily(day,online_matches) VALUES(CURRENT_DATE,1)
            ON CONFLICT(day) DO UPDATE SET online_matches=galaxy_analytics_daily.online_matches+1`);
        }catch(err){console.error('[Galaxy Combat P2P] Error contando partida online:',err&&err.message||err);}
      }
      r.rankEligible=r.players.length>=2&&r.players.some(p=>p.registered&&p.userId);
      broadcast(r,{t:'start',code:r.code,players:startPlayers,cpuFill:!!r.cpuFill,p2p:true,rankEligible:r.rankEligible,rankRound:r.rankRound});publicUpdate(wss);return;
    }

    if(m.t==='rank-restart'&&x.i===0&&r.started){
      r.rankRecorded=false;
      r.rankMatchId=randomBytes(24).toString('hex');
      r.rankRound=Math.max(1,Number(r.rankRound)||1)+1;
      r.rankEligible=r.players.length>=2&&r.players.some(p=>p.registered&&p.userId);
      send(ws,{t:'rank-round',rankRound:r.rankRound,rankEligible:r.rankEligible});
      return;
    }

    if(['p2p-offer','p2p-answer','p2p-ice'].includes(m.t)){
      const to=Number(m.to),target=r.players.find(p=>p.i===to);if(target)send(target.ws,{t:m.t,from:x.i,data:m.data});return;
    }
    if(m.t==='fallback-request'||m.t==='fallback-clear'){
      const host=r.players.find(p=>p.i===0);
      if(x.i!==0&&host&&host.ws)send(host.ws,{t:m.t,from:x.i});
      return;
    }
    if(m.t==='fallback-ctrl'){
      const host=r.players.find(p=>p.i===0);
      if(x.i!==0&&host&&host.ws)send(host.ws,{t:'fallback-ctrl',from:x.i,turn:Number(m.turn)||0,thrust:!!m.thrust,fire:!!m.fire});
      return;
    }
    if(m.t==='fallback-state'){
      if(x.i===0&&m.state){
        const to=new Set(Array.isArray(m.to)?m.to.map(Number).filter(Number.isInteger):[]);
        for(const p of r.players)if(p.i!==0&&p.ws&&(!to.size||to.has(p.i)))send(p.ws,{t:'fallback-state',state:m.state});
      }
      return;
    }
    if(m.t==='fallback-event'){
      if(x.i===0&&m.event){
        const to=new Set(Array.isArray(m.to)?m.to.map(Number).filter(Number.isInteger):[]);
        for(const p of r.players)if(p.i!==0&&p.ws&&(!to.size||to.has(p.i)))send(p.ws,{t:'fallback-event',event:m.event});
      }
      return;
    }
    if(m.t==='fallback-action'){
      const host=r.players.find(p=>p.i===0);
      if(x.i!==0&&host&&host.ws)send(host.ws,{t:'fallback-action',from:x.i,action:String(m.action||'')});
      return;
    }
    if(m.t==='chat'&&!r.started){
      const text=String(m.text||'').trim().slice(0,120);if(text)broadcast(r,{t:'chat',i:x.i,n:r.players.find(p=>p.i===x.i)?.n||'JUGADOR',text});return;
    }
    if(m.t==='voice-ready'){
      send(ws,{t:'voice-peers',peers:r.players.filter(p=>p.i!==x.i).map(p=>p.i)});for(const p of r.players)if(p.i!==x.i)send(p.ws,{t:'voice-ready',from:x.i});return;
    }
    if(['voice-offer','voice-answer','voice-ice'].includes(m.t)){
      const to=Number(m.to),target=r.players.find(p=>p.i===to);if(target)send(target.ws,{t:m.t,from:x.i,data:m.data});return;
    }
    if(m.t==='voice-talking'||m.t==='voice-offline'){
      for(const p of r.players)if(p.i!==x.i)send(p.ws,{t:m.t,from:x.i,on:!!m.on});return;
    }
    if(m.t==='public-rooms'){send(ws,{t:'public-rooms',rooms:publicRooms()});return;}
    if(m.t==='leave'){remove(ws,wss);return;}
  });

  ws.on('close',()=>disconnect(ws,wss));
});

setInterval(()=>expireDisconnectedPlayers(wss),1000);
setInterval(()=>{const now=Date.now();let changed=false;for(const [code,r] of rooms){if(now-(r.createdAt||now)>12*60*60*1000){rooms.delete(code);changed=true;}}if(changed)publicUpdate(wss);},30000);

server.listen(PORT,'0.0.0.0',async()=>{
  console.log('Galaxy Combat P2P signaling on '+PORT);
  if(db)await ensureDatabase();
  else console.log('[Galaxy Combat P2P] DATABASE_URL no configurada: cuentas desactivadas hasta anadirla en Render.');
});

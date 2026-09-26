'use strict';
(() => {
  const isIOS=/iPhone|iPad|iPod/i.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
  const isMobile=document.documentElement.classList.contains('handheld-device')||matchMedia('(pointer:coarse)').matches||/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  const perfDebug=new URLSearchParams(location.search).get('debug')==='1';
  const i18n=window.GalaxyI18n||null;
  const tr=(key,vars)=>i18n?i18n.t(key,vars):key;
  const trServer=text=>i18n?i18n.translateServerText(text):String(text==null?'':text);
  const canvas=document.getElementById('game');
  const useStaticPcBackground=!isMobile;
  if(useStaticPcBackground){
    // Fondo PC estatico: se compone una sola vez como capa CSS 16:9 y ya no se
    // copia dentro del canvas en cada frame.
    canvas.style.backgroundColor='#020714';
    canvas.style.backgroundImage="url('assets/sprites/fondo.png')";
    canvas.style.backgroundRepeat='no-repeat';
    canvas.style.backgroundPosition='center center';
    canvas.style.backgroundSize='100% 100%';
  }
  // En PC necesitamos alpha para que la capa estatica se vea a traves del
  // canvas dinamico. Movil conserva el contexto opaco que ya funciona fluido.
  const ctx=canvas.getContext('2d',{alpha:useStaticPcBackground})||canvas.getContext('2d');
  const menu=document.getElementById('menu'),lobby=document.getElementById('lobby'),victory=document.getElementById('victory');
  const buildVersionEl=document.getElementById('buildVersion');
  const playerChangeNotice=document.getElementById('playerChangeNotice');
  let playerChangeNoticeTimer=null;
  const statusEl=document.getElementById('status'),roomCodeEl=document.getElementById('roomCode'),playersEl=document.getElementById('players'),startBtn=document.getElementById('start'),fillCpuBtn=document.getElementById('fillCpu'),waitingPlayersEl=document.getElementById('waitingPlayers'),topbar=document.getElementById('topbar'),roomMini=document.getElementById('roomMini');
  const lobbyChatLog=document.getElementById('lobbyChatLog'),lobbyChatEmpty=document.getElementById('lobbyChatEmpty'),lobbyChatInput=document.getElementById('lobbyChatInput'),lobbyChatSend=document.getElementById('lobbyChatSend');
  const shareGameBtn=document.getElementById('shareGame'),shareRoomBtn=document.getElementById('shareRoom'),shareToast=document.getElementById('shareToast');
  const sharedRoomCode=String(new URLSearchParams(location.search).get('room')||'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,4);
  let sharedRoomJoinStarted=false;
  let shareToastTimer=null;
  const serverWait=document.getElementById('serverWait'),serverWaitText=document.getElementById('serverWaitText');
  const roomTypeDialog=document.getElementById('roomTypeDialog'),publicRoomsDialog=document.getElementById('publicRoomsDialog'),publicRoomsList=document.getElementById('publicRoomsList'),joinCodeDialog=document.getElementById('joinCodeDialog');
  const cpuSetupDialog=document.getElementById('cpuSetupDialog'),mobileDifficulty=document.getElementById('mobileDifficulty'),mobileCpuCount=document.getElementById('mobileCpuCount'),cpuSetupPlay=document.getElementById('cpuSetupPlay'),cpuSetupClose=document.getElementById('cpuSetupClose');
  const W=1920,H=1080;
  const playerColors=['#5ae1ff','#ff50a5','#5aff78','#ffdc46'];
  const playerRgb=[[90,225,255],[255,80,165],[90,255,120],[255,220,70]];
  const images={},sounds={};
  let state=null,previousState=null,myIndex=null,isHost=false,roomCode='',playerToken='',inGame=false,lastStateTime=0,previousStateTime=0;
  const RESUME_STORAGE_KEY='galaxyCombatResumeV1';
  const ROOM_CLIENT_ID_KEY='galaxyRoomClientIdV1';
  const TEST_ROOM_PERMIT_STORAGE='galaxyTestRoomPermitV1';
  const RESUME_WINDOW_MS=30000;
  function roomClientId(){
    try{
      let id=String(localStorage.getItem(ROOM_CLIENT_ID_KEY)||'').trim().toLowerCase();
      if(/^[a-f0-9]{32}$/.test(id))return id;
      const bytes=new Uint8Array(16);
      if(window.crypto&&typeof window.crypto.getRandomValues==='function')window.crypto.getRandomValues(bytes);
      else for(let i=0;i<bytes.length;i++)bytes[i]=Math.floor(Math.random()*256);
      id=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
      localStorage.setItem(ROOM_CLIENT_ID_KEY,id);
      return id;
    }catch(_){return '';}
  }
  function testRoomPermitToken(){
    try{
      const data=JSON.parse(localStorage.getItem(TEST_ROOM_PERMIT_STORAGE)||'null');
      const token=String(data&&data.token||'').trim();
      const expiresAt=Number(data&&data.expiresAt)||0;
      if(/^[a-f0-9]{64}$/i.test(token)&&expiresAt>Date.now())return token;
      if(data)localStorage.removeItem(TEST_ROOM_PERMIT_STORAGE);
    }catch(_){}
    return '';
  }
  let resumeStartedAt=0,resumeExpiryTimer=null;
  function loadResumeSession(){
    try{
      const v=JSON.parse(sessionStorage.getItem(RESUME_STORAGE_KEY)||'null');
      if(v&&typeof v.code==='string'&&typeof v.token==='string'&&v.code&&v.token)return {code:v.code,token:v.token};
    }catch(_){}
    return null;
  }
  function saveResumeSession(){
    if(!roomCode||!playerToken)return;
    try{sessionStorage.setItem(RESUME_STORAGE_KEY,JSON.stringify({code:roomCode,token:playerToken}));}catch(_){}
  }
  function clearResumeSession(){
    try{sessionStorage.removeItem(RESUME_STORAGE_KEY);}catch(_){}
  }
  function stopResumeWindow(){
    resumeStartedAt=0;
    clearTimeout(resumeExpiryTimer);resumeExpiryTimer=null;
    if(roomMini&&roomMini.textContent===tr('reconnecting'))roomMini.textContent='';
  }
  const NET_FRAME_MS=1000/30;
  const previousLookup={players:new Map(),asteroids:new Map(),pickups:new Map(),meteors:new Map()};
  const localizedTargetOwners=[-1,-1,-1,-1];
  const localizaSpriteKeys=['localizaA','localizaB','localizaC','localizaD'];
  let lastControlTurn=0,lastControlTurnChangedAt=0,lastControlThrust=false,lastVoicePlayersSig=0,renderScale=1;
  let lastUniqueLeader=null,leaderAnnouncement=null;
  let killHudFlashStart=0,killHudFlashUntil=0,killScoreFxStart=0,killScoreFxUntil=0;
  const invisibleHudUntil=[0,0,0,0];
  let invisibleNoticeIndex=-1,invisibleNoticeUntil=0;
  // Mantiene visualmente el contador anterior hasta que empieza el pop de escala.
  // La puntuacion real del servidor sigue actualizandose al instante.
  let killScoreHeldValue=null,killScorePendingValue=null;
  let crashScoreFxStart=0,crashScoreFxUntil=0;
  // En penalizacion mantenemos el valor anterior hasta que termina el aviso.
  // Entonces aparece la resta junto con el efecto de escala/explosion del HUD.
  let crashScoreHeldValue=null,crashScorePendingValue=null;
  let penaltyMessageUntil=0;
  let brutalFxStart=0,brutalFxUntil=0,brutalDistance=0,brutalDistanceText='',brutalShooter='';
  let weaponTheftFxStart=0,weaponTheftFxUntil=0,weaponTheftIndex=-1;
  let huntFxStart=0,huntFxUntil=0,huntText='',huntCpuAmmo=false,huntCpuBonus=0,huntCpuIndices=[];
  let pendingVictoryIndex=null,victoryShowTimer=null;
  let publicRooms=[];
  let localCpu=null,localCpuActive=false,activeLocalDifficulty='';
  let cpuLearningControl={autoTrainingEnabled:false,localHardEnabled:false,ready:false};
  let p2p=null,hostPhysics=null,lobbyPlayers=[],cpuFillEnabled=false;
  let netStartAt=0,lastP2PStateAt=0,lastFallbackRequestAt=0,lastFallbackStateSentAt=0;
  let fallbackActive=false,p2pStableCount=0;
  const fallbackPeers=new Set(),fallbackReconnectAt=new Map();
  const FALLBACK_AFTER_MS=500,FALLBACK_RETRY_MS=3000,FALLBACK_STATE_MS=50,P2P_STABLE_STATES=12;
  const keys=new Set(); let ws=null,reconnectTimer=null,musicStarted=false;
  // V16.4.36: sincronizamos estados/controles y reducimos GC en movil para evitar picos de trabajo
  // asincronos en Safari/iOS. Solo conservamos el snapshot de estado mas reciente.
  let pendingStateRaw=null;
  let lastControlSentAt=0;
  let lastSentControlTurn=NaN,lastSentControlThrust=false,lastSentControlFire=false;
  let lastPaintAt=0;
  let lastStateProcessedAt=0;
  const CONTROL_SEND_MS=1000/30;
  const CONTROL_HEARTBEAT_MS=100;
  // V16.4.38: recuperamos los 30 snapshots/s en movil para que la interpolacion
  // vuelva a tener la misma cadencia que el servidor. Seguimos procesandolos al
  // comienzo del RAF y conservando solo el mas reciente, asi evitamos los picos
  // asincronos de versiones anteriores sin sacrificar fluidez visual.
  const STATE_PROCESS_MS=isMobile?NET_FRAME_MS:0;
  // Intervalo de snapshots suavizado. Usar directamente el tiempo entre llegadas
  // hace que unos pocos ms de jitter se traduzcan en pequenas variaciones de
  // velocidad visual, especialmente visibles cuando las naves van rapido.
  let smoothedStateInterval=NET_FRAME_MS;
  const localVisual={ready:false,index:-1,x:0,y:0,r:0,vx:0,vy:0,lastAt:0,lastError:0};
  function resetLocalVisual(){
    localVisual.ready=false;localVisual.index=-1;localVisual.lastAt=0;localVisual.lastError=0;
  }
  const perfStats=perfDebug?{lastPaint:0,windowStart:performance.now(),frames:0,longFrames:0,maxFrame:0,lastFrame:0,parseMs:0,parseCount:0,localErrMax:0,report:{fps:0,long:0,max:0,frame:0,parse:0,localErr:0}}:null;
  // Cadencia de pintado adaptativa. El antiguo umbral fijo de 10,5 ms podia
  // convertir un monitor de 100/110 Hz en ~50/55 FPS. Medimos el RAF real y
  // usamos un divisor entero estable: 60/75/100 Hz pintan cada RAF; 120/144/
  // 165 Hz cada 2; frecuencias aun mayores usan el divisor mas cercano a 75 FPS.
  let displaySampleLast=0,displaySampleTotal=0,displaySampleCount=0;
  let renderDivisor=1,renderCadenceTick=0,measuredRefreshHz=60;
  function sampleDisplayRefresh(now){
    if(displaySampleLast){
      const dt=now-displaySampleLast;
      if(dt>=4&&dt<=25){
        displaySampleTotal+=dt;displaySampleCount++;
        if(displaySampleCount>=30){
          const hz=1000/(displaySampleTotal/displaySampleCount);
          if(Number.isFinite(hz)&&hz>=40&&hz<=360){
            measuredRefreshHz=hz;
            // Divisor entero para conservar un frame pacing regular SIN caer
            // por debajo de ~60 FPS. Ejemplos: 120 -> 60, 144 -> 72,
            // 165 -> 82,5, 180 -> 60, 200 -> 66,7 y 240 -> 60.
            // En monitores por debajo de 120 Hz pintamos cada RAF.
            const next=hz>=118?Math.max(2,Math.floor(hz/60)):1;
            renderDivisor=Math.max(1,next);
          }
          displaySampleTotal=0;displaySampleCount=0;
        }
      }
    }
    displaySampleLast=now;
  }
  const impactFX=typeof window.GalaxyImpactFX==='function'?new window.GalaxyImpactFX():null;
  let connectAttempt=0,wakeStartedAt=0,manualClose=false;
  const cpuButton=document.getElementById('cpu');
  const audioToggleButton=document.getElementById('enableAudio');
  const serverButtons=['create','join'].map(id=>document.getElementById(id));
  if(cpuButton)cpuButton.disabled=false;
  // Tamano visual de las naves. Solo cambia el dibujo: fisica, colisiones y red quedan iguales.
  const SHIP_DRAW_SIZE=isMobile?86:72;
  const SHIELD_DRAW_RADIUS=isMobile?48:43;
  const HUD_SCALE=isMobile?1.60:1.12;
  const HUD_PANEL_W=128*HUD_SCALE;
  const HUD_PANEL_H=153*HUD_SCALE;
  const HUD_NAME_FONT=isMobile?`800 ${22*HUD_SCALE}px Arial,Helvetica,sans-serif`:`${20*HUD_SCALE}px Flashback,Arial`;
  const HUD_VALUE_FONT=isMobile?`800 ${23*HUD_SCALE}px Arial,Helvetica,sans-serif`:null;
  const SHIP_IMAGE_KEYS=[
    {base:'ship1',a:'ship1a',f:'ship1f',af:'ship1af'},
    {base:'ship2',a:'ship2a',f:'ship2f',af:'ship2af'},
    {base:'ship3',a:'ship3a',f:'ship3f',af:'ship3af'},
    {base:'ship4',a:'ship4a',f:'ship4f',af:'ship4af'}
  ];
  const ROCKET_IMAGE_KEYS=['rocketA','rocketB','rocketC','rocketD'];
  const NAVEMIRA_IMAGE_KEYS=['navemiraA','navemiraB','navemiraC','navemiraD'];
  const ASTEROID_IMAGE_KEYS=['','asteroid1','asteroid2','asteroid3','asteroid4','asteroid5','asteroid6'];
  const METEOR_DRAW_SIZES=[0,22,27,31];
  // Cache de textos del HUD: evita crear cientos de strings por segundo.
  const hudValueCache=[0,1,2,3].map(()=>({ammoValue:null,ammoText:'',speedValue:null,speedText:'',killValue:null,scoreToWin:null,killText:''}));
  function hudAmmoText(p){
    const c=hudValueCache[p.i]||hudValueCache[0],v=Number(p.ammo)||0;
    if(c.ammoValue!==v){c.ammoValue=v;c.ammoText=String(v);}
    return c.ammoText;
  }
  function hudSpeedText(p){
    const c=hudValueCache[p.i]||hudValueCache[0],v=Number(p.spd)||0;
    if(c.speedValue!==v){c.speedValue=v;c.speedText='x'+v;}
    return c.speedText;
  }
  function hudKillText(p,scoreToWin,displayedKills){
    const c=hudValueCache[p.i]||hudValueCache[0],k=Number(displayedKills)||0,w=Number(scoreToWin)||0;
    if(c.killValue!==k||c.scoreToWin!==w){c.killValue=k;c.scoreToWin=w;c.killText=String(k)+'/'+String(w);}
    return c.killText;
  }
  // Estilos RGBA precalculados para FANTASMA. Evita toFixed/template strings
  // en cada frame mientras dura el camuflaje.
  const ghostFillStyles=playerRgb.map(rgb=>new Array(16));
  const ghostBorderStyles=playerRgb.map(rgb=>new Array(16));
  for(let pi=0;pi<playerRgb.length;pi++){
    const rgb=playerRgb[pi];
    for(let step=0;step<16;step++){
      const wave=step/15;
      ghostFillStyles[pi][step]='rgba('+rgb[0]+','+rgb[1]+','+rgb[2]+','+(0.22+0.08*wave).toFixed(3)+')';
      ghostBorderStyles[pi][step]='rgba('+rgb[0]+','+rgb[1]+','+rgb[2]+','+(0.34+0.10*wave).toFixed(3)+')';
    }
  }
  const voice=typeof window.GalaxyVoice==='function'?new window.GalaxyVoice({send:o=>send(o),isMobile}):null;
  let backgroundCache=null,backgroundCacheW=0,backgroundCacheH=0;
  function rebuildBackgroundCache(){
    if(useStaticPcBackground)return;
    const bg=images.bg;
    if(!imageReady(bg)||!canvas.width||!canvas.height)return;
    if(backgroundCacheW===canvas.width&&backgroundCacheH===canvas.height&&backgroundCache)return;
    const cached=document.createElement('canvas');
    cached.width=canvas.width;cached.height=canvas.height;
    const c=cached.getContext('2d',{alpha:false});
    if(!c)return;
    c.setTransform(1,0,0,1,0,0);
    c.globalAlpha=1;
    c.globalCompositeOperation='source-over';
    c.imageSmoothingEnabled=true;
    // Cubrir siempre todo el backing canvas antes de cachear el fondo. Esto
    // evita que Safari/iPadOS pueda conservar pixeles de un buffer anterior.
    c.fillStyle='#020714';
    c.fillRect(0,0,cached.width,cached.height);
    try{c.drawImage(bg,0,0,cached.width,cached.height);}catch(_){return;}
    backgroundCache=cached;backgroundCacheW=cached.width;backgroundCacheH=cached.height;
  }
  function updateCanvasResolution(){
    const rect=canvas.getBoundingClientRect();
    if(!rect.width||!rect.height)return;
    // iOS/Safari agradece un buffer algo menor: en una pantalla de telefono
    // 1.2 pixeles internos por pixel CSS mantiene buena nitidez y reduce el
    // trabajo de rasterizado por frame. El mundo/fisica sigue en 1920x1080.
    const maxWidth=isIOS?1152:(isMobile?1280:W);
    const dpr=Math.min(window.devicePixelRatio||1,isIOS?1.20:(isMobile?1.35:1.6));
    const fitScale=Math.min(1,maxWidth/W,(rect.width*dpr)/W,(rect.height*dpr)/H);
    const safeScale=Math.max(1/3,fitScale);
    const targetW=Math.max(640,Math.min(maxWidth,Math.round((W*safeScale)/2)*2));
    const targetH=Math.round(targetW*H/W);
    if(canvas.width!==targetW||canvas.height!==targetH){
      canvas.width=targetW;canvas.height=targetH;
      backgroundCache=null;backgroundCacheW=0;backgroundCacheH=0;
    }
    renderScale=canvas.width/W;
    rebuildBackgroundCache();
  }
  let resizeRaf=0;
  function scheduleCanvasResolution(){
    if(resizeRaf)return;
    resizeRaf=requestAnimationFrame(()=>{resizeRaf=0;updateCanvasResolution();});
  }
  const motionStatus=document.getElementById('motionStatus');
  const mobileControls=document.getElementById('mobileControls'),fireZone=document.querySelector('.fire-zone'),thrustZone=document.querySelector('.thrust-zone');
  const mobileExit=document.getElementById('mobileExit');
  const mobileControlMotionBtn=document.getElementById('mobileControlMotion'),mobileControlButtonsBtn=document.getElementById('mobileControlButtons');
  const mobileTurnPad=document.getElementById('mobileTurnPad'),mobileTurnLeft=document.getElementById('mobileTurnLeft'),mobileTurnRight=document.getElementById('mobileTurnRight'),mobileActionZone=document.getElementById('mobileActionZone');
  const voicePttEl=document.getElementById('voicePtt');
  const MOBILE_CONTROL_KEY='galaxyCombatMobileControlV1';
  let mobileControlMode='motion';
  try{if(localStorage.getItem(MOBILE_CONTROL_KEY)==='buttons')mobileControlMode='buttons';}catch(_){}
  let mobileButtonTurn=0;
  let mobileKeyboardActive=false;
  const MOBILE_KEYBOARD_CODES=new Set(['KeyA','KeyD','KeyW','ArrowLeft','ArrowRight','ArrowUp','Space','ControlLeft','ControlRight']);
  const mobileLeftPointers=new Set(),mobileRightPointers=new Set();
  // Los antiguos elementos izquierdo/derecho se mantienen solo como capa visual.
  // El control real usa toda la pantalla: toque corto = disparo, mantener = acelerar.
  if(isMobile){
    const fireLabel=fireZone&&fireZone.querySelector('span');
    const thrustLabel=thrustZone&&thrustZone.querySelector('span');
    if(fireLabel)fireLabel.style.visibility='hidden';
    if(thrustLabel)thrustLabel.style.visibility='hidden';
  }
  let motionEnabled=false,motionTurn=0,motionNeutral=null,motionLastRaw=0,motionHasSample=false;
  let lastMotionSampleAt=0;
  let mobileFire=false,mobileThrust=false;
  const MOBILE_HOLD_MS=190;
  const MOBILE_FIRE_PULSE_MS=120;
  let mobileFireTimer=null;
  const touchGestures=new Map();

  // Solo quitamos el acento de las vocales; se conserva la letra enie.
  // NFC admite nombres escritos o pegados con acentos combinados.
  const vocalesSinTilde={
    '\u00e1':'a','\u00e9':'e','\u00ed':'i','\u00f3':'o','\u00fa':'u',
    '\u00c1':'A','\u00c9':'E','\u00cd':'I','\u00d3':'O','\u00da':'U'
  };
  function sinTildes(valor){
    return String(valor==null?'':valor).normalize('NFC').replace(
      /[\u00e1\u00e9\u00ed\u00f3\u00fa\u00c1\u00c9\u00cd\u00d3\u00da]/g,
      letra=>vocalesSinTilde[letra]
    );
  }
  const hudNameCache=[null,null,null,null];
  function hudPlayerName(p){
    const idx=Number(p&&p.i);
    const source=String(p&&p.n!=null?p.n:'');
    const cached=Number.isInteger(idx)?hudNameCache[idx]:null;
    if(cached&&cached.source===source)return cached.value;
    const raw=sinTildes(source).trim();
    const upper=raw.toUpperCase();
    const defaultNames=['JUGADOR','PLAYER','GIOCATORE','JOUEUR','SPIELER'];
    const isDefaultName=defaultNames.includes(upper)||defaultNames.some(name=>upper===`${name} ${idx+1}`);
    const value=(!raw||isDefaultName)?`J${idx+1}`:raw;
    if(Number.isInteger(idx)&&idx>=0&&idx<hudNameCache.length)hudNameCache[idx]={source,value};
    return value;
  }
  const campoNombre=document.getElementById('name');
  function normalizarNombreVisible(){
    const anterior=campoNombre.value,nuevo=sinTildes(anterior);
    if(nuevo===anterior)return;
    const inicio=campoNombre.selectionStart,fin=campoNombre.selectionEnd;
    campoNombre.value=nuevo;
    if(inicio!==null&&fin!==null){
      campoNombre.setSelectionRange(
        sinTildes(anterior.slice(0,inicio)).length,
        sinTildes(anterior.slice(0,fin)).length
      );
    }
  }
  campoNombre.addEventListener('input',e=>{
    if(!e.isComposing)normalizarNombreVisible();
  });
  campoNombre.addEventListener('compositionend',normalizarNombreVisible);

  const assetList={
    bg:isMobile?'assets/sprites/fondo_1280.png':null, giant:'assets/sprites/asteroidegrande_270.png',
    pantA:'assets/sprites/pantA.png',pantB:'assets/sprites/pantB.png',pantC:'assets/sprites/pantC.png',pantD:'assets/sprites/pantD.png',
    ammo1:'assets/sprites/municion1.png',ammo3:'assets/sprites/municion3.png',cadence:'assets/sprites/cadencia.png',speed:'assets/sprites/velocidad.png',
    mira1:'assets/sprites/mira1.png',coete:'assets/sprites/coete.png',navemira:'assets/sprites/navemira.png',
    rocketA:'assets/sprites/coeteA.png',rocketB:'assets/sprites/coeteB.png',rocketC:'assets/sprites/coeteC.png',rocketD:'assets/sprites/coeteD.png',
    navemiraA:'assets/sprites/navemiraA.png',navemiraB:'assets/sprites/navemiraB.png',navemiraC:'assets/sprites/navemiraC.png',navemiraD:'assets/sprites/navemiraD.png',
    localizaA:'assets/sprites/localizaA.png',localizaB:'assets/sprites/localizaB.png',localizaC:'assets/sprites/localizaC.png',localizaD:'assets/sprites/localizaD.png',
    asteroid1:'assets/sprites/asteroide1.png',asteroid2:'assets/sprites/asteroide2.png',asteroid3:'assets/sprites/asteroide3.png',asteroid4:'assets/sprites/asteroide5.png',asteroid5:'assets/sprites/asteroide6.png',asteroid6:'assets/sprites/dos.png'
  };
  for(let i=1;i<=4;i++){
    assetList[`ship${i}`]=`assets/sprites/coete${i}.png`;
    assetList[`ship${i}a`]=`assets/sprites/coete${i}a.png`;
    assetList[`ship${i}f`]=`assets/sprites/coete${i}f.png`;
    assetList[`ship${i}af`]=`assets/sprites/coete${i}af.png`;
  }
  const warnedImages=new WeakSet();
  function reportImageFailure(im,error){
    if(!im||warnedImages.has(im))return;
    warnedImages.add(im);
    console.warn('[Galaxy Combat] Image unavailable; continuing without blocking the game.',im.currentSrc||im.src,error||'');
  }
  const imageDecodePromises={};
  for(const [k,url] of Object.entries(assetList)){
    if(!url)continue;
    const im=new Image();
    im.decoding='async';
    // Estos sprites aparecen desde el primer frame. Antes los asteroides tenian
    // prioridad baja y podian terminar de descargarse/decodificarse ya jugando.
    const critical=k==='bg'||k==='giant'||k.startsWith('ship')||k.startsWith('pant')||
      k.startsWith('asteroid')||k.startsWith('rocket')||k.startsWith('navemira')||k==='ammo1'||k==='ammo3'||k==='cadence'||k==='speed';
    if('fetchPriority' in im)im.fetchPriority=critical?'high':'auto';
    imageDecodePromises[k]=new Promise(resolve=>{
      im.onerror=()=>{reportImageFailure(im);resolve(false);};
      im.onload=()=>{
        const decoded=typeof im.decode==='function'?im.decode():Promise.resolve();
        Promise.resolve(decoded).then(()=>{
          if(k==='bg'){
            backgroundCache=null;backgroundCacheW=0;backgroundCacheH=0;
            scheduleCanvasResolution();
          }
          resolve(true);
        }).catch(()=>resolve(false));
      };
    });
    im.src=url;
    images[k]=im;
  }

  let rendererWarmed=false;
  function warmRendererCaches(){
    if(rendererWarmed)return;
    rendererWarmed=true;
    // Fuerza durante el menu las primeras subidas de texturas y rutas costosas
    // de Canvas (fuente, shadow blur y modos screen/lighter). Asi no aparecen
    // como compilacion/transferencia puntual durante los primeros disparos.
    try{
      const c=document.createElement('canvas');c.width=256;c.height=256;
      const g=c.getContext('2d',{alpha:true});
      if(!g)return;
      let x=0,y=0;
      for(const im of Object.values(images)){
        if(!imageReady(im))continue;
        try{g.drawImage(im,x,y,32,32);}catch(_){}
        x+=34;if(x>220){x=0;y+=34;if(y>200)y=0;}
      }
      g.font='20px Flashback,Arial';
      g.fillStyle='#fff';g.fillText('GALAXY 0123456789',4,238);
      g.shadowColor='rgba(90,225,255,.95)';g.shadowBlur=48;
      g.fillText('READY',120,238);
      g.shadowBlur=0;
      g.globalCompositeOperation='screen';g.fillRect(0,0,8,8);
      g.globalCompositeOperation='lighter';g.fillRect(10,0,8,8);
      g.globalCompositeOperation='source-over';
    }catch(_){}
  }
  let gameAssetsReady=false,gameAssetsPromise=null,gameAssetsIdleHandle=0;
  function prepareGameAssets(){
    if(gameAssetsReady)return Promise.resolve(true);
    if(gameAssetsPromise)return gameAssetsPromise;
    const fontPromise=(document.fonts&&typeof document.fonts.load==='function')
      ?Promise.allSettled([
        document.fonts.load('20px Flashback'),
        document.fonts.load('64px Flashback')
      ])
      :Promise.resolve();
    gameAssetsPromise=Promise.allSettled([...Object.values(imageDecodePromises),fontPromise]).then(()=>{
      // Construye la cache grande del fondo mientras aun estamos en menu/lobby,
      // no durante los primeros frames de la partida.
      updateCanvasResolution();
      warmRendererCaches();
      gameAssetsReady=true;
      return true;
    });
    return gameAssetsPromise;
  }
  function warmGameAssetsWhenIdle(){
    if(gameAssetsReady||gameAssetsPromise||gameAssetsIdleHandle)return;
    const run=()=>{gameAssetsIdleHandle=0;prepareGameAssets();};
    if(typeof requestIdleCallback==='function')gameAssetsIdleHandle=requestIdleCallback(run,{timeout:900});
    else gameAssetsIdleHandle=setTimeout(run,350);
  }
  warmGameAssetsWhenIdle();
  const AUDIO_ASSET_VERSION='V18.13';
  const soundDefs={
    laser:{url:'assets/sonido/laser_1.mp3?v='+AUDIO_ASSET_VERSION,size:8,volume:.55},
    impact:{url:'assets/sonido/impacto1.mp3?v='+AUDIO_ASSET_VERSION,size:5,volume:.75},
    pickup:{url:'assets/sonido/carga3.wav?v='+AUDIO_ASSET_VERSION,size:3,volume:.75},
    start:{url:'assets/sonido/inicio.wav?v='+AUDIO_ASSET_VERSION,size:1,volume:.75}
  };
  // Web Audio tambien en PC: cada efecto se descarga/decodifica una sola vez.
  // Los antiguos pools de varios <audio> podian provocar microtirones en los
  // primeros disparos/impactos al activar decodificadores distintos.
  const AudioContextCtor=window.AudioContext||window.webkitAudioContext;
  const useWebAudio=!!AudioContextCtor;
  const gameVolume=isMobile?0.45:0.75;
  let gameAudioEnabled=true,audioUnlocked=false;
  const soundPools={};
  if(!useWebAudio){
    for(const [key,def] of Object.entries(soundDefs)){
      const items=[];
      for(let i=0;i<def.size;i++){
        const a=new Audio(def.url);a.preload='auto';a.volume=def.volume*gameVolume;items.push(a);
      }
      soundPools[key]={items,next:0};
    }
    sounds.music=new Audio('assets/sonido/musica.mp3?v='+AUDIO_ASSET_VERSION);
    sounds.music.preload='auto';sounds.music.loop=true;sounds.music.volume=.35*gameVolume;
  }else{
    sounds.music=null;
  }

  let audioCtx=null,masterGain=null,fxGain=null,musicGain=null;
  let webAudioLoadPromise=null,webMusicLoadPromise=null,webMusicSource=null,webMusicIdleHandle=0;
  const webAudioBuffers={};

  function ensureAudioContext(){
    if(!useWebAudio)return null;
    if(!audioCtx){
      audioCtx=new AudioContextCtor();
      masterGain=audioCtx.createGain();
      fxGain=audioCtx.createGain();
      musicGain=audioCtx.createGain();
      masterGain.gain.value=1;
      fxGain.gain.value=gameVolume;
      musicGain.gain.value=.35*gameVolume;
      fxGain.connect(masterGain);
      musicGain.connect(masterGain);
      masterGain.connect(audioCtx.destination);
    }
    if(audioCtx.state!=='running'){
      try{const p=audioCtx.resume();if(p&&p.catch)p.catch(()=>{});}catch(_){}
    }
    return audioCtx;
  }

  async function loadWebAudio(){
    const ctx=ensureAudioContext();
    if(!ctx)return false;
    if(webAudioLoadPromise)return webAudioLoadPromise;
    webAudioLoadPromise=(async()=>{
      // Solo efectos de juego (~0,5 MB). La musica (~2,9 MB) se decodifica
      // aparte cuando el navegador esta ocioso en el menu.
      for(const [key,def] of Object.entries(soundDefs)){
        if(webAudioBuffers[key])continue;
        const res=await fetch(def.url,{cache:'force-cache'});
        if(!res.ok)throw new Error('audio '+key+' '+res.status);
        const data=await res.arrayBuffer();
        webAudioBuffers[key]=await ctx.decodeAudioData(data.slice(0));
      }
      return true;
    })().catch(err=>{
      console.warn('[Galaxy Combat] Web Audio no disponible:',err);
      webAudioLoadPromise=null;
      return false;
    });
    return webAudioLoadPromise;
  }

  async function loadWebMusic(){
    const ctx=ensureAudioContext();
    if(!ctx)return false;
    if(webAudioBuffers.music)return true;
    if(webMusicLoadPromise)return webMusicLoadPromise;
    webMusicLoadPromise=(async()=>{
      const url='assets/sonido/musica.mp3?v='+AUDIO_ASSET_VERSION;
      const res=await fetch(url,{cache:'force-cache'});
      if(!res.ok)throw new Error('audio music '+res.status);
      const data=await res.arrayBuffer();
      webAudioBuffers.music=await ctx.decodeAudioData(data.slice(0));
      return true;
    })().catch(err=>{
      console.warn('[Galaxy Combat] Musica Web Audio no disponible:',err);
      webMusicLoadPromise=null;
      return false;
    });
    return webMusicLoadPromise;
  }

  function warmWebMusicWhenIdle(){
    if(!useWebAudio||webAudioBuffers.music||webMusicLoadPromise||webMusicIdleHandle||!menu||menu.classList.contains('hidden'))return;
    const run=()=>{
      webMusicIdleHandle=0;
      if(!menu||menu.classList.contains('hidden')||!gameAudioEnabled)return;
      loadWebMusic().then(ok=>{if(ok&&menu&&!menu.classList.contains('hidden')&&gameAudioEnabled)playWebMusic();});
    };
    if(typeof requestIdleCallback==='function')webMusicIdleHandle=requestIdleCallback(run,{timeout:1200});
    else webMusicIdleHandle=setTimeout(run,650);
  }

  function playWebEffect(key){
    if(!useWebAudio||!audioCtx||audioCtx.state!=='running'||!webAudioBuffers[key]||!gameAudioEnabled)return false;
    try{
      const def=soundDefs[key];
      const src=audioCtx.createBufferSource();
      const gain=audioCtx.createGain();
      src.buffer=webAudioBuffers[key];
      gain.gain.value=def?def.volume:1;
      src.connect(gain);gain.connect(fxGain);
      src.start(0);
      return true;
    }catch(_){return false;}
  }

  function playWebMusic(){
    if(!useWebAudio||!gameAudioEnabled||!menu||menu.classList.contains('hidden'))return false;
    const ctx=ensureAudioContext();
    if(!ctx||ctx.state!=='running'||!webAudioBuffers.music)return false;
    if(webMusicSource)return true;
    try{
      const src=ctx.createBufferSource();
      src.buffer=webAudioBuffers.music;src.loop=true;src.connect(musicGain);
      src.onended=()=>{if(webMusicSource===src)webMusicSource=null;};
      src.start(0);webMusicSource=src;musicStarted=true;return true;
    }catch(_){return false;}
  }

  function stopWebMusic(){
    if(!webMusicSource)return;
    const src=webMusicSource;webMusicSource=null;
    try{src.onended=null;src.stop(0);src.disconnect();}catch(_){}
  }

  async function unlockGameAudio(){
    if(useWebAudio){
      ensureAudioContext();
      const ok=await loadWebAudio();
      audioUnlocked=!!ok;
      if(ok)warmWebMusicWhenIdle();
      return audioUnlocked;
    }
    if(audioUnlocked)return true;
    let successCount=0;
    const tests=[];
    for(const pool of Object.values(soundPools)){
      const a=pool&&pool.items&&pool.items[0];
      if(!a)continue;
      const oldVolume=a.volume;
      try{
        a.volume=0;a.currentTime=0;
        const p=a.play();
        if(p&&typeof p.then==='function'){
          tests.push(p.then(()=>{successCount++;try{a.pause();a.currentTime=0;a.volume=oldVolume;}catch(_){}}).catch(()=>{try{a.volume=oldVolume;}catch(_){}}));
        }else{successCount++;a.pause();a.currentTime=0;a.volume=oldVolume;}
      }catch(_){try{a.volume=oldVolume;}catch(__){}}
    }
    if(tests.length)await Promise.allSettled(tests);
    audioUnlocked=successCount>0;
    return audioUnlocked;
  }
  function updateAudioButton(){
    if(!audioToggleButton)return;
    audioToggleButton.classList.toggle('active',gameAudioEnabled);
    audioToggleButton.setAttribute('aria-pressed',gameAudioEnabled?'true':'false');
    audioToggleButton.textContent=gameAudioEnabled?tr('gameAudioOn'):tr('gameAudioOff');
  }
  function toggleGameAudio(){
    gameAudioEnabled=!gameAudioEnabled;
    updateAudioButton();
    if(gameAudioEnabled){
      // Este click es tambien un gesto valido para iOS.
      startMusic();
      unlockGameAudio();
    }else{
      stopMusic();
    }
  }
  function playSound(k){
    if(!gameAudioEnabled)return;
    if(useWebAudio){
      ensureAudioContext();
      if(playWebEffect(k))return;
      loadWebAudio().then(ok=>{if(ok)playWebEffect(k);});
      return;
    }
    const pool=soundPools[k];if(!pool||!pool.items.length)return;
    const a=pool.items[pool.next++%pool.items.length];
    try{
      a.currentTime=0;
      const promise=a.play();
      if(promise&&promise.catch)promise.catch(err=>console.warn('[Galaxy Combat] Efecto de audio bloqueado:',k,err&&err.name?err.name:err));
    }catch(err){console.warn('[Galaxy Combat] No se pudo reproducir efecto:',k,err);}
  }
  function startMusic(){
    if(!gameAudioEnabled||!menu||menu.classList.contains('hidden'))return;
    if(useWebAudio){
      ensureAudioContext();
      if(playWebMusic())return;
      // No decodificar 2,9 MB de musica justo en el gesto que puede arrancar
      // una partida. Primero quedan listos los efectos y la musica se calienta
      // en tiempo ocioso mientras el usuario sigue en el menu.
      loadWebAudio().then(ok=>{if(ok)warmWebMusicWhenIdle();});
      return;
    }
    if(!sounds.music||!sounds.music.paused)return;
    sounds.music.play().then(()=>{musicStarted=true;}).catch(()=>{musicStarted=false;});
  }
  function stopMusic(){
    if(webMusicIdleHandle){
      try{
        if(typeof cancelIdleCallback==='function')cancelIdleCallback(webMusicIdleHandle);
        else clearTimeout(webMusicIdleHandle);
      }catch(_){}
      webMusicIdleHandle=0;
    }
    stopWebMusic();
    if(sounds.music)try{sounds.music.pause();sounds.music.currentTime=0;}catch(_){}
    musicStarted=false;
  }
  function updateMobileControlUi(){
    if(mobileControlMotionBtn){
      const on=mobileControlMode==='motion';
      mobileControlMotionBtn.classList.toggle('active',on);
      mobileControlMotionBtn.setAttribute('aria-pressed',on?'true':'false');
    }
    if(mobileControlButtonsBtn){
      const on=mobileControlMode==='buttons';
      mobileControlButtonsBtn.classList.toggle('active',on);
      mobileControlButtonsBtn.setAttribute('aria-pressed',on?'true':'false');
    }
    if(mobileControls){
      mobileControls.classList.toggle('button-mode',mobileControlMode==='buttons');
      mobileControls.classList.toggle('motion-mode',mobileControlMode==='motion');
      mobileControls.classList.toggle('keyboard-mode',mobileKeyboardActive);
    }
  }
  function setMobileKeyboardActive(active){
    if(!isMobile)return;
    mobileKeyboardActive=!!active;
    if(mobileKeyboardActive){
      resetMobileTouchControls();
      mobileButtonTurn=0;mobileLeftPointers.clear();mobileRightPointers.clear();
      motionTurn=0;
    }
    updateMobileControlUi();
  }
  async function setMobileControlMode(mode,requestMotion=true){
    if(mode!=='buttons')mode='motion';
    mobileControlMode=mode;
    try{localStorage.setItem(MOBILE_CONTROL_KEY,mobileControlMode);}catch(_){}
    setMobileKeyboardActive(false);
    mobileButtonTurn=0;mobileLeftPointers.clear();mobileRightPointers.clear();
    resetMobileTouchControls();
    updateMobileControlUi();
    if(mobileControlMode==='motion'&&requestMotion&&!motionEnabled)await enableMobileMotion();
    if(mobileControlMode==='motion')calibrateMobileMotion();
  }
  function updateMobileButtonTurn(){
    mobileButtonTurn=(mobileLeftPointers.size?1:0)-(mobileRightPointers.size?1:0);
    if(mobileTurnLeft)mobileTurnLeft.classList.toggle('active',mobileLeftPointers.size>0);
    if(mobileTurnRight)mobileTurnRight.classList.toggle('active',mobileRightPointers.size>0);
  }
  function bindMobileTurnButton(button,pointers){
    if(!button)return;
    button.addEventListener('pointerdown',e=>{
      if(!isMobile||!inGame||mobileControlMode!=='buttons')return;
      if(e.pointerType&&e.pointerType!=='touch'&&e.pointerType!=='pen')return;
      if(mobileKeyboardActive){
        keys.clear();
        lastControlTurn=0;
        setMobileKeyboardActive(false);
      }
      pointers.add(e.pointerId);updateMobileButtonTurn();
      try{button.setPointerCapture&&button.setPointerCapture(e.pointerId);}catch(_){}
      e.preventDefault();e.stopPropagation();
    },{passive:false});
    const release=e=>{
      if(pointers.delete(e.pointerId))updateMobileButtonTurn();
      e.preventDefault();e.stopPropagation();
    };
    button.addEventListener('pointerup',release,{passive:false});
    button.addEventListener('pointercancel',release,{passive:false});
    button.addEventListener('lostpointercapture',e=>{if(pointers.delete(e.pointerId))updateMobileButtonTurn();});
  }
  updateMobileControlUi();
  bindMobileTurnButton(mobileTurnLeft,mobileLeftPointers);
  bindMobileTurnButton(mobileTurnRight,mobileRightPointers);

  function screenAngle(){
    if(screen.orientation&&Number.isFinite(screen.orientation.angle))return screen.orientation.angle;
    return Number.isFinite(window.orientation)?window.orientation:0;
  }
  function lateralTilt(ev){
    const beta=Number(ev.beta)||0,gamma=Number(ev.gamma)||0;
    let a=((screenAngle()%360)+360)%360;
    if(a===90)return beta;
    if(a===270)return -beta;
    if(a===180)return -gamma;
    return gamma;
  }
  function onDeviceOrientation(ev){
    // Safari puede entregar mas muestras de sensor de las que necesita el juego.
    // Limitar el trabajo a ~60 Hz evita competir con RAF + WebSocket en el
    // mismo hilo principal sin cambiar la respuesta percibida del control.
    const stamp=Number.isFinite(ev.timeStamp)?ev.timeStamp:performance.now();
    if(lastMotionSampleAt&&stamp-lastMotionSampleAt<15)return;
    lastMotionSampleAt=stamp;
    const raw=lateralTilt(ev);
    motionLastRaw=raw;motionHasSample=true;
    if(motionNeutral===null)motionNeutral=raw;
    let delta=raw-motionNeutral;
    // Compensa el salto de -180/180 en sensores que lo necesiten.
    if(delta>180)delta-=360;
    if(delta<-180)delta+=360;
    const dead=3.0;
    if(Math.abs(delta)<=dead){motionTurn=0;return;}
    const signed=delta>0?delta-dead:delta+dead;
    motionTurn=-clamp(signed/22,-1,1);
  }
  async function enableMobileMotion(){
    if(!isMobile)return true;
    try{
      if(typeof DeviceOrientationEvent==='undefined'){
        motionStatus.textContent=tr('sensorUnsupported');
        return false;
      }
      if(typeof DeviceOrientationEvent.requestPermission==='function'){
        const result=await DeviceOrientationEvent.requestPermission();
        if(result!=='granted')throw new Error(tr('motionPermissionDenied'));
      }
      window.removeEventListener('deviceorientation',onDeviceOrientation);
      window.addEventListener('deviceorientation',onDeviceOrientation,{passive:true});
      motionNeutral=null;motionTurn=0;motionEnabled=true;motionHasSample=false;lastMotionSampleAt=0;
      motionStatus.textContent='';
      return true;
    }catch(err){
      motionStatus.textContent=tr('motionError',{detail:sinTildes(err&&err.message?err.message:tr('permissionUnavailable'))});
      return false;
    }
  }
  function calibrateMobileMotion(){
    if(!isMobile||!motionEnabled)return;
    motionNeutral=motionHasSample?motionLastRaw:null;
    motionTurn=0;
  }
  function refreshTouchControls(){
    mobileThrust=false;
    for(const gesture of touchGestures.values()){
      if(gesture&&gesture.accelerating){mobileThrust=true;break;}
    }
    if(fireZone)fireZone.classList.toggle('active',mobileFire);
    if(thrustZone)thrustZone.classList.toggle('active',mobileThrust);
    if(mobileControls){
      mobileControls.classList.toggle('firing',mobileFire);
      mobileControls.classList.toggle('thrusting',mobileThrust);
    }
  }
  function triggerMobileFire(){
    mobileFire=true;
    clearTimeout(mobileFireTimer);
    mobileFireTimer=setTimeout(()=>{
      mobileFireTimer=null;
      mobileFire=false;
      refreshTouchControls();
    },MOBILE_FIRE_PULSE_MS);
    refreshTouchControls();
  }
  function resetMobileTouchControls(){
    for(const gesture of touchGestures.values()){
      if(gesture&&gesture.holdTimer)clearTimeout(gesture.holdTimer);
    }
    touchGestures.clear();
    clearTimeout(mobileFireTimer);mobileFireTimer=null;
    mobileFire=false;mobileThrust=false;
    if(mobileControls){
      mobileControls.classList.remove('firing','thrusting');
    }
    refreshTouchControls();
  }
  function mobileActionTargetAllowed(target){
    if(target&&target.closest&&target.closest('button,input,select,textarea,a,[contenteditable="true"]'))return false;
    if(mobileControlMode==='buttons'&&!(target&&target.closest&&target.closest('#mobileActionZone')))return false;
    return true;
  }
  function beginMobileActionGesture(key,target){
    if(!isMobile||!inGame||!mobileActionTargetAllowed(target))return false;
    if(mobileKeyboardActive){
      keys.clear();
      lastControlTurn=0;
      setMobileKeyboardActive(false);
    }
    // Si Safari reutiliza un identificador tras perder un final de gesto,
    // eliminamos primero cualquier estado antiguo asociado a ese contacto.
    const stale=touchGestures.get(key);
    if(stale&&stale.holdTimer)clearTimeout(stale.holdTimer);
    touchGestures.delete(key);
    const gesture={startedAt:performance.now(),accelerating:false,holdTimer:null};
    gesture.holdTimer=setTimeout(()=>{
      const current=touchGestures.get(key);
      if(!inGame||current!==gesture)return;
      current.accelerating=true;
      refreshTouchControls();
    },MOBILE_HOLD_MS);
    touchGestures.set(key,gesture);
    return true;
  }
  function endMobileActionGesture(key,allowFire=false){
    const gesture=touchGestures.get(key);
    if(!gesture)return false;
    clearTimeout(gesture.holdTimer);
    touchGestures.delete(key);
    const elapsed=performance.now()-gesture.startedAt;
    if(allowFire&&!gesture.accelerating&&elapsed<MOBILE_HOLD_MS)triggerMobileFire();
    refreshTouchControls();
    return true;
  }
  function mobilePointerDown(e){
    if(!isMobile||!inGame)return;
    if(e.pointerType&&e.pointerType!=='touch'&&e.pointerType!=='pen')return;
    // En iPhone/iPad los gestos tactiles usan Touch Events nativos. Safari
    // puede perder pointerup/pointercancel durante un gesto y dejar thrust=true.
    if(isIOS&&e.pointerType==='touch')return;
    if(!beginMobileActionGesture(e.pointerId,e.target))return;
    try{e.target.setPointerCapture&&e.target.setPointerCapture(e.pointerId);}catch(_){}
    e.preventDefault();
  }
  function mobilePointerEnd(e){
    if(isIOS&&e.pointerType==='touch')return;
    const handled=endMobileActionGesture(e.pointerId,e.type==='pointerup');
    if((handled||inGame)&&e.cancelable)e.preventDefault();
  }
  function mobileTouchStart(e){
    if(!isIOS||!isMobile||!inGame)return;
    let handled=false;
    for(const touch of Array.from(e.changedTouches||[])){
      const target=touch.target||e.target;
      if(beginMobileActionGesture('touch:'+touch.identifier,target))handled=true;
    }
    if(handled&&e.cancelable)e.preventDefault();
  }
  function mobileTouchEnd(e){
    if(!isIOS||!isMobile)return;
    let handled=false;
    const allowFire=e.type==='touchend';
    for(const touch of Array.from(e.changedTouches||[])){
      if(endMobileActionGesture('touch:'+touch.identifier,allowFire))handled=true;
    }
    if((handled||inGame)&&e.cancelable)e.preventDefault();
  }

  function cleanGameUrl(room=''){
    const u=new URL(location.href);
    u.search='';
    u.hash='';
    if(room)u.searchParams.set('room',String(room).trim().toUpperCase());
    return u.toString();
  }
  function showShareToast(text){
    if(!shareToast)return;
    clearTimeout(shareToastTimer);
    shareToast.textContent=String(text||'');
    shareToast.classList.remove('hidden');
    shareToastTimer=setTimeout(()=>shareToast.classList.add('hidden'),5200);
  }
  async function copyTextToClipboard(text){
    const value=String(text||'');
    try{
      if(navigator.clipboard&&window.isSecureContext){
        await navigator.clipboard.writeText(value);
        return true;
      }
    }catch(_){}
    try{
      const ta=document.createElement('textarea');
      ta.value=value;
      ta.setAttribute('readonly','');
      ta.style.position='fixed';ta.style.left='-9999px';ta.style.top='0';
      document.body.appendChild(ta);
      ta.select();ta.setSelectionRange(0,ta.value.length);
      const ok=document.execCommand('copy');
      ta.remove();
      return !!ok;
    }catch(_){return false;}
  }
  async function shareGameLink(){
    const url=cleanGameUrl();
    const ok=await copyTextToClipboard(url);
    showShareToast(ok?tr('shareGameCopied'):tr('shareGameCopyFailed'));
  }
  async function shareCurrentRoom(){
    if(!roomCode||roomCode==='LOCAL'){
      showShareToast('PRIMERO CREA UNA PARTIDA ONLINE.');
      return;
    }
    const url=cleanGameUrl(roomCode);
    const ok=await copyTextToClipboard(url);
    showShareToast(ok
      ? 'PARTIDA COPIADA. MANDA EL LINK A TU AMIGO: AL ABRIRLO ENTRARA DIRECTAMENTE EN LA SALA '+roomCode+'.'
      : 'NO SE PUDO COPIAR EL LINK DE LA PARTIDA.');
  }
  function joinSharedRoomDirect(){
    if(!sharedRoomCode||sharedRoomJoinStarted||roomCode||inGame)return false;
    if(!ws||ws.readyState!==WebSocket.OPEN)return false;
    sharedRoomJoinStarted=true;
    closeRoomDialogs();
    statusEl.textContent='ENTRANDO EN LA SALA '+sharedRoomCode+'...';
    send({t:'join',name:sinTildes(campoNombre.value),code:sharedRoomCode,authToken:authToken()});
    return true;
  }

  function ensureP2P(){
    if(p2p||typeof window.GalaxyP2P!=='function')return p2p;
    p2p=new window.GalaxyP2P({
      sendSignal:o=>{if(ws&&ws.readyState===WebSocket.OPEN){ws.send(JSON.stringify(o));return true;}return false;},
      onControl:(i,m)=>{if(hostPhysics)hostPhysics.setControl(i,m.turn,m.thrust,m.fire);},
      onState:m=>{
        const now=performance.now();
        const gap=lastP2PStateAt?now-lastP2PStateAt:Infinity;
        lastP2PStateAt=now;
        if(fallbackActive){
          if(gap<=180)p2pStableCount++;else p2pStableCount=1;
          if(p2pStableCount>=P2P_STABLE_STATES){
            fallbackActive=false;p2pStableCount=0;
            if(ws&&ws.readyState===WebSocket.OPEN){try{ws.send(JSON.stringify({t:'fallback-clear'}));}catch(_){}}
            handle(m);
          }
          return;
        }
        handle(m);
      },
      onEvent:m=>{
        if(m&&m.t==='p2p-action'&&isHost&&m.action==='restart'&&hostPhysics){
          if(typeof hostPhysics.syncRoster==='function')hostPhysics.syncRoster(lobbyPlayers);
          send({t:'rank-restart'});
          if(hostPhysics.restart()){
            p2p.broadcastEvent({t:'restarted'});
            handle({t:'restarted'});
          }
        }else handle(m);
      },
      onPeerState:()=>{}
    });
    return p2p;
  }
  function stopP2P(){
    if(p2p)p2p.close();
    p2p=null;
    netStartAt=0;lastP2PStateAt=0;lastFallbackRequestAt=0;lastFallbackStateSentAt=0;
    fallbackActive=false;p2pStableCount=0;fallbackPeers.clear();fallbackReconnectAt.clear();
    if(hostPhysics)hostPhysics.stop();
    hostPhysics=null;
    lobbyPlayers=[];
  }
  function clientNeedsFallback(now=performance.now()){
    if(isHost||!inGame)return false;
    if(netStartAt&&now-netStartAt<FALLBACK_AFTER_MS)return false;
    return !lastP2PStateAt||now-lastP2PStateAt>FALLBACK_AFTER_MS;
  }
  function requestFallback(now=performance.now()){
    if(isHost||!ws||ws.readyState!==WebSocket.OPEN)return false;
    fallbackActive=true;
    if(now-lastFallbackRequestAt<FALLBACK_RETRY_MS)return true;
    lastFallbackRequestAt=now;p2pStableCount=0;
    try{ws.send(JSON.stringify({t:'fallback-request'}));return true;}catch(_){return false;}
  }
  function sendHostFallbackState(m){
    if(!fallbackPeers.size||!ws||ws.readyState!==WebSocket.OPEN)return false;
    if(Number(ws.bufferedAmount||0)>128*1024)return false;
    const now=performance.now();
    if(now-lastFallbackStateSentAt<FALLBACK_STATE_MS)return false;
    lastFallbackStateSentAt=now;
    try{ws.send(JSON.stringify({t:'fallback-state',to:[...fallbackPeers],state:m}));return true;}catch(_){return false;}
  }
  function sendHostFallbackEvent(m){
    if(!fallbackPeers.size||!ws||ws.readyState!==WebSocket.OPEN)return false;
    try{ws.send(JSON.stringify({t:'fallback-event',to:[...fallbackPeers],event:m}));return true;}catch(_){return false;}
  }
  function startHostPhysics(players,rankRound=1){
    if(!isHost||typeof window.GalaxyHostPhysics!=='function')return false;
    hostPhysics=new window.GalaxyHostPhysics({
      code:roomCode,rankRound,rankHostToken:playerToken,
      onState:m=>{handle(m);if(p2p)p2p.broadcastState(m);sendHostFallbackState(m);},
      onEvent:m=>{handle(m);if(p2p)p2p.broadcastEvent(m);sendHostFallbackEvent(m);}
    });
    return hostPhysics.start(players||lobbyPlayers);
  }
  function apiBaseUrl(){
    const configured=String((window.GALAXY_CONFIG&&window.GALAXY_CONFIG.serverUrl)||'').trim();
    if(configured){
      try{const u=new URL(configured,location.href);u.pathname='';u.search='';u.hash='';return u.toString().replace(/\/$/,'');}
      catch(_){return '';}
    }
    if(location.hostname.endsWith('github.io'))return '';
    return location.origin;
  }
  function applyCpuLearningControl(control){
    const c=control&&typeof control==='object'?control:{};
    cpuLearningControl={
      autoTrainingEnabled:c.autoTrainingEnabled===true,
      localHardEnabled:c.localHardEnabled===true,
      ready:true
    };
    updateBuildVersionLearningState();
  }
  function updateBuildVersionLearningState(){
    if(!buildVersionEl)return;
    let mode='off',label='Aprendizaje desactivado';
    // Durante una partida CPU dificil, el aprendizaje local tiene prioridad visual.
    if(localCpuActive&&activeLocalDifficulty==='dificil'&&cpuLearningControl.localHardEnabled){
      mode='hard';label='Aprendizaje LOCAL DIFICIL activo';
    }else if(cpuLearningControl.autoTrainingEnabled){
      mode='training';label='Entrenamiento automatico activo';
    }else if(cpuLearningControl.localHardEnabled){
      mode='hard';label='Aprendizaje LOCAL DIFICIL activo';
    }
    buildVersionEl.classList.remove('learning-training','learning-hard','learning-off');
    buildVersionEl.classList.add(mode==='training'?'learning-training':mode==='hard'?'learning-hard':'learning-off');
    buildVersionEl.title=label;
    buildVersionEl.setAttribute('aria-label','Version del juego · '+label);
  }
  async function refreshCpuLearningControl(){
    const base=apiBaseUrl();
    if(!base){
      cpuLearningControl={autoTrainingEnabled:false,localHardEnabled:false,ready:false};
      updateBuildVersionLearningState();
      return;
    }
    const ctl=typeof AbortController==='function'?new AbortController():null;
    const timer=ctl?setTimeout(()=>ctl.abort(),1800):null;
    try{
      const res=await fetch(base+'/api/cpu-learning-status',{cache:'no-store',signal:ctl?ctl.signal:undefined});
      if(!res.ok)return;
      const data=await res.json();
      if(data&&data.ok)applyCpuLearningControl(data.control);
    }catch(_){}
    finally{if(timer)clearTimeout(timer);}
  }
  function postAnalyticsEvent(type){
    const base=apiBaseUrl();if(!base)return;
    try{
      fetch(base+'/api/analytics/event',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({type}),
        keepalive:true
      }).catch(()=>{});
    }catch(_){}
  }
  function websocketUrl(){
    const configured=String((window.GALAXY_CONFIG&&window.GALAXY_CONFIG.serverUrl)||'').trim();
    if(configured){
      try{
        const u=new URL(configured,location.href);
        u.protocol=u.protocol==='https:'?'wss:':'ws:';
        u.pathname='/ws';u.search='';u.hash='';
        return u.toString();
      }catch(_){return null;}
    }
    // En desarrollo/local puede compartir origen con Node. GitHub Pages no
    // ejecuta WebSocket, por lo que alli hay que rellenar config.js.
    if(location.hostname.endsWith('github.io'))return null;
    const proto=location.protocol==='https:'?'wss:':'ws:';
    return `${proto}//${location.host}/ws`;
  }
  function setServerReady(ready){
    for(const b of serverButtons)b.disabled=!ready;
    statusEl.classList.toggle('ready',ready);
    statusEl.classList.toggle('waking',!ready);
    if(serverWait)serverWait.classList.toggle('hidden',ready);
  }
  function wakeStatus(){
    const secs=wakeStartedAt?Math.max(0,Math.floor((Date.now()-wakeStartedAt)/1000)):0;
    const dots='.'.repeat((connectAttempt%3)+1);
    const msg=secs<8
      ? tr('connectingServer',{dots})
      : tr('serverStarting',{dots,secs});
    statusEl.textContent=msg;
    if(serverWaitText)serverWaitText.textContent=msg;
  }
  function scheduleReconnect(delay=2200){
    clearTimeout(reconnectTimer);
    reconnectTimer=setTimeout(connect,delay);
  }
  function connect(){
    const url=websocketUrl();
    if(!url){
      setServerReady(false);
      statusEl.classList.remove('waking');
      statusEl.textContent=tr('serverConfigMissing');
      return;
    }
    if(ws&&(ws.readyState===WebSocket.OPEN||ws.readyState===WebSocket.CONNECTING))return;
    if(!wakeStartedAt)wakeStartedAt=Date.now();
    connectAttempt++;
    setServerReady(false);
    wakeStatus();
    try{ws=new WebSocket(url);}catch(_){scheduleReconnect();return;}
    ws.onopen=()=>{
      clearTimeout(reconnectTimer);
      connectAttempt=0;wakeStartedAt=0;
      setServerReady(true);
      statusEl.textContent=tr('serverReady');
      const saved=(roomCode&&playerToken)?{code:roomCode,token:playerToken}:loadResumeSession();
      if(saved){
        if(roomMini)roomMini.textContent=tr('reconnecting');
        send({t:'resume',code:saved.code,token:saved.token});
      }else if(sharedRoomCode){
        setTimeout(joinSharedRoomDirect,0);
      }else{
        send({t:'public-rooms'});
      }
    };
    ws.onclose=()=>{
      pendingStateRaw=null;
      setServerReady(false);
      if(manualClose)return;
      const saved=(roomCode&&playerToken)?{code:roomCode,token:playerToken}:loadResumeSession();
      if(saved&&(inGame||roomCode)){
        statusEl.textContent=tr('reconnectingGame');
        if(roomMini)roomMini.textContent=tr('reconnecting');
        if(!resumeStartedAt){
          resumeStartedAt=Date.now();
          clearTimeout(resumeExpiryTimer);
          resumeExpiryTimer=setTimeout(()=>{
            if(!resumeStartedAt)return;
            clearResumeSession();playerToken='';
            alert(tr('resumeFailed'));
            returnToMainMenu(false);
          },RESUME_WINDOW_MS+1500);
        }
        scheduleReconnect(500);
      }else{
        wakeStatus();
        scheduleReconnect();
      }
    };
    ws.onerror=()=>{
      setServerReady(false);
      wakeStatus();
      // onclose programa el siguiente intento. No mostramos un error definitivo
      // porque un Render gratuito puede estar arrancando todavia.
    };
    ws.onmessage=e=>{
      const raw=e.data;
      // Los snapshots son reemplazables. No los parseamos en mitad de un frame:
      // conservamos el ultimo y lo procesamos al comienzo del siguiente RAF.
      if(typeof raw==='string'&&raw.startsWith('{"t":"state"')){
        pendingStateRaw=raw;
        return;
      }
      // Los eventos pequenos (sonido, voz, BRUTAL) no necesitan forzar el
      // parseo de un snapshot pendiente. Solo los cambios de fase de partida
      // requieren orden estricto con el ultimo estado recibido.
      let m;try{m=JSON.parse(raw);}catch(_){return;}
      if(m&&['p2p-offer','p2p-answer','p2p-ice','p2p-reconnect'].includes(m.t)){ensureP2P()?.handleSignal(m);return;}
      if(m&&m.t==='fallback-request'){
        if(isHost&&Number.isInteger(Number(m.from))){
          const i=Number(m.from);fallbackPeers.add(i);
          const now=performance.now(),last=fallbackReconnectAt.get(i)||0;
          if(now-last>=FALLBACK_RETRY_MS){fallbackReconnectAt.set(i,now);ensureP2P()?.reconnectPeer(i);}
        }
        return;
      }
      if(m&&m.t==='fallback-clear'){
        if(isHost&&Number.isInteger(Number(m.from))){const i=Number(m.from);fallbackPeers.delete(i);fallbackReconnectAt.delete(i);}
        return;
      }
      if(m&&m.t==='fallback-state'){
        if(!isHost&&m.state){fallbackActive=true;handle(m.state);}
        return;
      }
      if(m&&m.t==='fallback-event'){
        if(!isHost&&m.event){fallbackActive=true;handle(m.event);}
        return;
      }
      if(m&&m.t==='fallback-ctrl'){
        if(isHost&&hostPhysics)hostPhysics.setControl(Number(m.from),Number(m.turn)||0,!!m.thrust,!!m.fire);
        return;
      }
      if(m&&m.t==='fallback-action'){
        if(isHost&&m.action==='restart'&&hostPhysics){
          if(typeof hostPhysics.syncRoster==='function')hostPhysics.syncRoster(lobbyPlayers);
          send({t:'rank-restart'});
          if(hostPhysics.restart()){
            if(p2p)p2p.broadcastEvent({t:'restarted'});
            sendHostFallbackEvent({t:'restarted'});
            handle({t:'restarted'});
          }
        }
        return;
      }
      if(voice&&voice.isSignal(m)){voice.handleSignal(m);return;}
      if(m&&(['victory','restarted','closed','start'].includes(m.t)))flushPendingState(true);
      handle(m);
    };
  }
  function send(o){
    if(localCpuActive&&localCpu&&typeof localCpu.handleMessage==='function')return localCpu.handleMessage(o);
    if(ws&&ws.readyState===WebSocket.OPEN){ws.send(JSON.stringify(o));return true;}
    if(!inGame){setServerReady(false);if(!wakeStartedAt)wakeStartedAt=Date.now();wakeStatus();connect();}
    return false;
  }
  function sendControl(turn,thrust,fire){
    if(localCpuActive&&localCpu){localCpu.setControl(turn,thrust,fire);return true;}
    if(inGame&&p2p){
      const now=performance.now();
      if(!isHost&&(fallbackActive||clientNeedsFallback(now))){
        requestFallback(now);
        if(ws&&ws.readyState===WebSocket.OPEN){
          try{ws.send(JSON.stringify({t:'fallback-ctrl',turn,thrust:!!thrust,fire:!!fire}));return true;}catch(_){return false;}
        }
        return false;
      }
      return p2p.sendControl(turn,thrust,fire);
    }
    if(!ws||ws.readyState!==WebSocket.OPEN)return false;
    // Los controles caducan enseguida. Si la salida esta congestionada, es
    // mejor omitir uno y mandar el mas reciente 33 ms despues que acumular lag.
    if(Number(ws.bufferedAmount||0)>32*1024)return false;
    try{ws.send(JSON.stringify({t:'ctrl',turn,thrust,fire}));return true;}catch(_){return false;}
  }
  function flushPendingState(force=false,stamp=performance.now()){
    if(!pendingStateRaw)return false;
    if(!force&&STATE_PROCESS_MS>0&&lastStateProcessedAt&&stamp-lastStateProcessedAt<STATE_PROCESS_MS)return false;
    const raw=pendingStateRaw;
    pendingStateRaw=null;
    const parseStart=perfStats?performance.now():0;
    let m;try{m=JSON.parse(raw);}catch(_){return false;}
    if(perfStats){perfStats.parseMs+=performance.now()-parseStart;perfStats.parseCount++;}
    lastStateProcessedAt=stamp;
    handle(m);
    return true;
  }
  function pumpControls(now){
    if(!inGame)return;
    const left=keys.has('KeyA')||keys.has('ArrowLeft');
    const right=keys.has('KeyD')||keys.has('ArrowRight');
    const keyboardTurn=(left?1:0)-(right?1:0);
    const rawTurn=isMobile
      ?(mobileKeyboardActive?keyboardTurn:(mobileControlMode==='buttons'?mobileButtonTurn:(motionEnabled?motionTurn:0)))
      :keyboardTurn;
    // El sensor tiene un poco de ruido incluso con el telefono quieto. Redondear
    // a pasos de 1/64 evita JSON/WebSocket innecesarios sin alterar el tacto.
    const turn=Math.round(rawTurn*64)/64;
    const touchThrust=isMobile&&!mobileKeyboardActive?mobileThrust:false;
    const touchFire=isMobile&&!mobileKeyboardActive?mobileFire:false;
    const thrust=touchThrust||keys.has('KeyW')||keys.has('ArrowUp');
    const fire=touchFire||keys.has('Space')||keys.has('ControlLeft')||keys.has('ControlRight');
    if(Math.abs(rawTurn-lastControlTurn)>0.001){
      lastControlTurnChangedAt=now;
      lastControlTurn=rawTurn;
    }
    lastControlThrust=thrust;
    const changed=!Number.isFinite(lastSentControlTurn)||turn!==lastSentControlTurn||thrust!==lastSentControlThrust||fire!==lastSentControlFire;
    const elapsed=lastControlSentAt?now-lastControlSentAt:Infinity;
    if((changed&&elapsed>=CONTROL_SEND_MS-1)||elapsed>=CONTROL_HEARTBEAT_MS){
      if(sendControl(turn,thrust,fire)){
        lastControlSentAt=now;
        lastSentControlTurn=turn;lastSentControlThrust=thrust;lastSentControlFire=fire;
      }
    }
  }
  function uniqueLeaderFrom(players){
    if(!Array.isArray(players)||!players.length)return null;
    let max=0,leader=null,tied=false;
    for(const p of players){
      const score=Number(p&&p.k)||0;
      if(score>max){max=score;leader=p;tied=false;}
      else if(score===max&&score>0){tied=true;}
    }
    return max>0&&!tied?leader:null;
  }
  function updateLeaderAnnouncement(nextState,now){
    const leader=uniqueLeaderFrom(nextState&&nextState.players);
    const nextId=leader?leader.i:null;
    if(nextId!==lastUniqueLeader){
      lastUniqueLeader=nextId;
      if(leader){
        const cleanName=sinTildes(leader.n);
        leaderAnnouncement={
          i:leader.i,
          name:cleanName,
          text:null,
          until:now+4000
        };
      }
    }
  }
  function resetLeaderAnnouncement(){lastUniqueLeader=null;leaderAnnouncement=null;}
  function rebuildPreviousLookup(snapshot){
    previousLookup.players.clear();previousLookup.asteroids.clear();previousLookup.pickups.clear();previousLookup.meteors.clear();
    if(!snapshot)return;
    for(const p of snapshot.players||[])previousLookup.players.set(p.i,p);
    for(const a of snapshot.asteroids||[])previousLookup.asteroids.set(a.id,a);
    for(const p of snapshot.pickups||[])previousLookup.pickups.set(p.id,p);
    for(const m of snapshot.meteors||[])previousLookup.meteors.set(m.id,m);
  }
  function syncVoicePlayers(players,force=false){
    if(!voice)return;
    let sig=0;
    if(Array.isArray(players))for(const p of players)if(p&&!p.cpu&&Number.isInteger(Number(p.i)))sig|=(1<<Number(p.i));
    if(!force&&sig===lastVoicePlayersSig)return;
    lastVoicePlayersSig=sig;
    voice.syncPlayers(players);
  }
  function closeRoomDialogs(){
    if(roomTypeDialog)roomTypeDialog.classList.add('hidden');
    if(publicRoomsDialog)publicRoomsDialog.classList.add('hidden');
    if(cpuSetupDialog)cpuSetupDialog.classList.add('hidden');
    if(menu)menu.classList.remove('submenu-open');
  }
  function showCpuSetupDialog(){
    if(!cpuSetupDialog)return;
    const difficulty=document.getElementById('difficulty');
    const cpuCount=document.getElementById('cpuCount');
    if(mobileDifficulty&&difficulty)mobileDifficulty.value=difficulty.value;
    if(mobileCpuCount&&cpuCount)mobileCpuCount.value=cpuCount.value;
    if(menu)menu.classList.add('submenu-open');
    cpuSetupDialog.classList.remove('hidden');
  }
  function confirmCpuSetup(){
    const difficulty=document.getElementById('difficulty');
    const cpuCount=document.getElementById('cpuCount');
    if(difficulty&&mobileDifficulty)difficulty.value=mobileDifficulty.value;
    if(cpuCount&&mobileCpuCount)cpuCount.value=mobileCpuCount.value;
    closeRoomDialogs();
    startLocalCpu();
  }
  function renderPublicRooms(){
    if(!publicRoomsList)return;
    publicRoomsList.textContent='';
    if(!publicRooms.length){
      const p=document.createElement('p');p.className='public-rooms-empty';p.textContent=tr('noPublicRooms');publicRoomsList.appendChild(p);return;
    }
    for(const room of publicRooms){
      const row=document.createElement('div');row.className='public-room-row public-room-row-detailed';
      const head=document.createElement('div');head.className='public-room-head';
      const info=document.createElement('div');info.className='public-room-info';
      const hostRow=document.createElement('div');hostRow.className='public-room-host-row';
      const lang=String(room.lang||'es').toLowerCase();
      const safeLang=['es','en','it','fr','de'].includes(lang)?lang:'es';
      const flag=document.createElement('span');flag.className=`language-flag room-language-flag flag-${safeLang}`;flag.setAttribute('role','img');flag.setAttribute('aria-label',safeLang.toUpperCase());flag.title=safeLang.toUpperCase();
      const host=document.createElement('span');host.className='public-room-host';host.textContent=sinTildes(room.host||tr('defaultPlayer'));
      hostRow.append(flag,host);
      const code=document.createElement('span');code.className='public-room-code';code.textContent=tr('roomPrefix')+' '+String(room.code||'');
      info.append(hostRow,code);

      const status=document.createElement('span');
      status.className='public-room-status '+(room.started?'playing':'waiting');
      status.textContent=room.started?tr('playingStatus'):tr('waitingStatus');

      const slots=Array.isArray(room.slots)?room.slots:[];
      const count=document.createElement('span');count.className='public-room-count';
      count.textContent=`${slots.length||Number(room.players)||0}/${Number(room.maxPlayers)||4}`;

      head.append(info,status,count);

      if(!room.started){
        const joinBtn=document.createElement('button');joinBtn.type='button';joinBtn.className='public-room-join';joinBtn.textContent=tr('join');
        joinBtn.addEventListener('click',()=>joinRoomByCode(room.code));
        head.append(joinBtn);
      }

      const players=document.createElement('div');players.className='public-room-players';
      for(const slot of slots){
        const player=document.createElement('div');
        player.className='public-room-player '+(slot.cpu?'cpu':'human');
        const label=document.createElement('span');label.className='public-room-player-name';
        label.style.color=playerColors[Number(slot.i)]||'#fff';
        label.textContent=`J${Number(slot.i)+1} · ${sinTildes(slot.n||tr('defaultPlayer'))}${slot.registered?' · ✓':''}`;
        player.append(label);
        if(slot.cpu){
          const take=document.createElement('button');
          take.type='button';take.className='public-room-cpu-join';take.textContent=tr('join');
          take.setAttribute('aria-label',tr('joinCpuSlot',{index:Number(slot.i)+1}));
          take.addEventListener('click',()=>joinRoomByCode(room.code,Number(slot.i)));
          player.append(take);
        }
        players.append(player);
      }
      row.append(head,players);
      publicRoomsList.appendChild(row);
    }
  }
  function showRoomTypeDialog(){
    if(menu)menu.classList.add('submenu-open');
    if(roomTypeDialog)roomTypeDialog.classList.remove('hidden');
  }
  function showPublicRoomsDialog(){
    if(joinCodeDialog&&!sharedRoomCode)joinCodeDialog.value='';
    if(menu)menu.classList.add('submenu-open');
    if(publicRoomsDialog)publicRoomsDialog.classList.remove('hidden');
    renderPublicRooms();send({t:'public-rooms'});
  }
  async function prepareMobileControls(){
    if(!isMobile)return;
    if(mobileKeyboardActive)return;
    if(mobileControlMode==='motion'&&!motionEnabled)await enableMobileMotion();
  }
  function authToken(){return window.GalaxyAuth&&typeof window.GalaxyAuth.getToken==='function'?window.GalaxyAuth.getToken():'';}
  function stopLocalCpu(){
    if(localCpu&&typeof localCpu.stop==='function')localCpu.stop();
    localCpu=null;localCpuActive=false;activeLocalDifficulty='';
    updateBuildVersionLearningState();
  }
  async function loadCpuBrain(){
    const base=apiBaseUrl();if(!base)return null;
    const ctl=typeof AbortController==='function'?new AbortController():null;
    const timer=ctl?setTimeout(()=>ctl.abort(),1400):null;
    try{
      const res=await fetch(base+'/api/cpu-brain',{cache:'no-store',signal:ctl?ctl.signal:undefined});
      if(!res.ok)return null;
      const data=await res.json();
      if(data&&data.control)applyCpuLearningControl(data.control);
      return data&&data.ok&&data.brain?data.brain:null;
    }catch(_){return null;}
    finally{if(timer)clearTimeout(timer);}
  }
  async function submitCpuLearning(deltas){
    const base=apiBaseUrl();if(!base||!Array.isArray(deltas)||!deltas.length)return;
    try{
      await fetch(base+'/api/cpu-brain/learn',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({deltas:deltas.slice(0,24)}),
        keepalive:true
      });
    }catch(_){}
  }
  async function startLocalCpu(){
    startMusic();await prepareMobileControls();closeRoomDialogs();
    const graphicsReady=prepareGameAssets();
    if(typeof window.GalaxyLocalCpu!=='function'){
      statusEl.textContent='MODO CPU LOCAL NO DISPONIBLE';
      return;
    }
    stopLocalCpu();
    stopResumeWindow();clearResumeSession();playerToken='';
    const difficulty=document.getElementById('difficulty').value;
    activeLocalDifficulty=difficulty;
    updateBuildVersionLearningState();
    postAnalyticsEvent('cpu_match');
    const brain=difficulty==='dificil'?await loadCpuBrain():null;
    await graphicsReady;
    localCpu=new window.GalaxyLocalCpu({onState:m=>handle(m),onEvent:m=>handle(m)});
    localCpu.start(
      sinTildes(campoNombre.value),
      difficulty,
      document.getElementById('cpuCount').value,
      brain,
      cpuLearningControl.localHardEnabled===true
    );
    localCpuActive=true;
    handle({t:'created',code:'LOCAL',index:0,cpu:true,playerToken:''});
    handle({t:'start'});
    handle(localCpu.publicState());
  }
  async function createOnlineRoom(isPublic){
    startMusic();prepareGameAssets();await prepareMobileControls();closeRoomDialogs();
    send({
      t:'create',
      name:sinTildes(campoNombre.value),
      public:!!isPublic,
      lang:(i18n&&typeof i18n.getLanguage==='function'?i18n.getLanguage():'es'),
      authToken:authToken(),
      clientId:roomClientId(),
      testRoomToken:testRoomPermitToken()
    });
  }
  async function joinRoomByCode(code,slot=null){
    prepareGameAssets();
    const clean=String(code||'').trim().toUpperCase();
    if(!clean){showPublicRoomsDialog();return;}
    startMusic();await prepareMobileControls();closeRoomDialogs();
    const msg={
      t:'join',
      name:sinTildes(campoNombre.value),
      code:clean,
      authToken:authToken(),
      clientId:roomClientId(),
      testRoomToken:testRoomPermitToken()
    };
    // Solo enviamos slot cuando el usuario ha pulsado UNIRSE sobre una CPU.
    // El boton general de una sala en espera no debe convertirse en slot 0.
    if(slot!==null&&slot!==undefined&&slot!==''){
      const selectedSlot=Number(slot);
      if(Number.isInteger(selectedSlot)&&selectedSlot>=0&&selectedSlot<4)msg.slot=selectedSlot;
    }
    send(msg);
  }
  function updateLobbyStartButton(canStart=false){
    if(!startBtn)return;
    // Solo el anfitrion necesita un control para iniciar la partida.
    startBtn.textContent=tr('start');
    startBtn.classList.toggle('hidden',!isHost);
    startBtn.disabled=isHost?!canStart:true;
    startBtn.classList.toggle('ready-to-start',!!(isHost&&canStart));
  }
  function updateCpuFillButton(on=cpuFillEnabled){
    cpuFillEnabled=!!on;
    if(shareRoomBtn)shareRoomBtn.classList.toggle('hidden',!isHost);
    if(!fillCpuBtn)return;
    fillCpuBtn.classList.toggle('hidden',!isHost);
    fillCpuBtn.classList.toggle('cpu-fill-active',!!(isHost&&cpuFillEnabled));
    fillCpuBtn.setAttribute('aria-pressed',cpuFillEnabled?'true':'false');
    fillCpuBtn.textContent=cpuFillEnabled?tr('removeCpuFill'):tr('fillCpuHard');
  }
  function updateWaitingPlayers(players){
    if(!waitingPlayersEl)return;
    const count=Array.isArray(players)?players.length:Number(players)||0;
    waitingPlayersEl.classList.toggle('hidden',count>1);
  }
  function clearLobbyChat(){
    if(!lobbyChatLog)return;
    lobbyChatLog.querySelectorAll('.lobby-chat-line').forEach(el=>el.remove());
    if(lobbyChatEmpty)lobbyChatEmpty.classList.remove('hidden');
    lobbyChatLog.scrollTop=lobbyChatLog.scrollHeight;
    if(lobbyChatInput)lobbyChatInput.value='';
  }
  function appendLobbyChatMessage(msg){
    if(!lobbyChatLog||!msg)return;
    const text=String(msg.text||'').trim();
    if(!text)return;
    if(lobbyChatEmpty)lobbyChatEmpty.classList.add('hidden');
    const line=document.createElement('div');line.className='lobby-chat-line';
    const who=document.createElement('span');who.className='lobby-chat-name';
    const idx=Number(msg.i);who.style.color=playerColors[idx]||'#fff';
    who.textContent=`J${Number.isFinite(idx)?idx+1:'?'} ${sinTildes(msg.n||tr('defaultPlayer'))}:`;
    const body=document.createElement('span');body.className='lobby-chat-text';body.textContent=sinTildes(text);
    line.append(who,body);lobbyChatLog.appendChild(line);
    while(lobbyChatLog.querySelectorAll('.lobby-chat-line').length>24){
      const first=lobbyChatLog.querySelector('.lobby-chat-line');if(!first)break;first.remove();
    }
    lobbyChatLog.scrollTop=lobbyChatLog.scrollHeight;
  }
  function loadLobbyChatHistory(messages){
    clearLobbyChat();
    for(const msg of (Array.isArray(messages)?messages:[]))appendLobbyChatMessage(msg);
  }
  function sendLobbyChat(){
    if(!roomCode||inGame||!lobbyChatInput)return;
    const text=sinTildes(String(lobbyChatInput.value||'').trim()).slice(0,120);
    if(!text)return;
    if(send({t:'chat',text}))lobbyChatInput.value='';
  }
  function hidePlayerChangeNotice(){
    if(!playerChangeNotice)return;
    playerChangeNotice.classList.add('hidden');
    playerChangeNotice.classList.remove('player-join-notice','player-leave-notice');
    playerChangeNotice.style.removeProperty('--join-player-color');
    playerChangeNotice.textContent='';
  }
  function showPlayerCpuReplaceNotice(name,index){
    if(!playerChangeNotice)return;
    clearTimeout(playerChangeNoticeTimer);
    const idx=Math.max(0,Math.min(3,Number(index)||0));
    const cleanName=sinTildes(String(name||tr('defaultPlayer')).trim());
    const slot=idx+1;
    playerChangeNotice.textContent='';
    playerChangeNotice.classList.add('player-join-notice','player-leave-notice');
    playerChangeNotice.style.setProperty('--join-player-color',playerColors[idx]||'#fff');

    const nameEl=document.createElement('strong');
    nameEl.className='player-join-name';
    nameEl.textContent=cleanName;

    const leaveEl=document.createElement('span');
    leaveEl.className='player-leave-copy';
    leaveEl.textContent=tr('playerLeftNotice');

    const detailEl=document.createElement('span');
    detailEl.className='player-leave-detail';
    detailEl.textContent=tr('playerCpuReplaceNotice',{index:slot});

    playerChangeNotice.append(nameEl,leaveEl,detailEl);
    playerChangeNotice.classList.remove('hidden');
    playerChangeNoticeTimer=setTimeout(()=>{
      playerChangeNoticeTimer=null;
      hidePlayerChangeNotice();
    },3000);
  }
  function showPlayerJoinedNotice(name,index){
    if(!playerChangeNotice)return;
    clearTimeout(playerChangeNoticeTimer);
    const idx=Math.max(0,Math.min(3,Number(index)||0));
    const cleanName=sinTildes(String(name||tr('defaultPlayer')).trim());
    playerChangeNotice.textContent='';
    playerChangeNotice.classList.add('player-join-notice');
    playerChangeNotice.style.setProperty('--join-player-color',playerColors[idx]||'#fff');
    const nameEl=document.createElement('strong');
    nameEl.className='player-join-name';
    nameEl.textContent=cleanName;
    const copyEl=document.createElement('span');
    copyEl.className='player-join-copy';
    copyEl.textContent=tr('playerJoinedNotice');
    playerChangeNotice.append(nameEl,copyEl);
    playerChangeNotice.classList.remove('hidden');
    playerChangeNoticeTimer=setTimeout(()=>{
      playerChangeNoticeTimer=null;
      hidePlayerChangeNotice();
    },3000);
  }
  function handle(m){
    if(m.t==='public-rooms'){
      publicRooms=Array.isArray(m.rooms)?m.rooms:[];renderPublicRooms();return;
    }
    if(m.t==='player-cpu-replaced'){showPlayerCpuReplaceNotice(m.name,m.index);return;}
    if(m.t==='player-joined-live'){showPlayerJoinedNotice(m.name,m.index);return;}
    if(m.t==='chat-history'){loadLobbyChatHistory(m.messages);return;}
    if(m.t==='chat'){appendLobbyChatMessage(m);return;}
    if(m.t==='created'||m.t==='joined'){
      closeRoomDialogs();
      if(impactFX)impactFX.reset();resetLeaderAnnouncement();
      state=null;previousState=null;lastStateTime=0;previousStateTime=0;smoothedStateInterval=NET_FRAME_MS;resetLocalVisual();lastVoicePlayersSig=0;rebuildPreviousLookup(null);
      roomCode=m.code;myIndex=m.index;playerToken=String(m.playerToken||'');isHost=m.t==='created';
      if(Array.isArray(m.players))lobbyPlayers=m.players.slice();
      cpuFillEnabled=!!m.cpuFill;ensureP2P()?.configure({myIndex,isHost,players:lobbyPlayers});
      saveResumeSession();stopResumeWindow();clearLobbyChat();updateLobbyStartButton(false);updateCpuFillButton(cpuFillEnabled);updateWaitingPlayers(m.players||(m.cpu?2:1));
      if(voice){voice.setSession(roomCode,myIndex,!!m.cpu);if(Array.isArray(m.players))syncVoicePlayers(m.players,true);}
      roomCodeEl.textContent=roomCode;roomMini.textContent='';stopMusic();menu.classList.add('hidden');
      if(m.started){lobby.classList.add('hidden');beginGame();}
      else if(!m.cpu)lobby.classList.remove('hidden');
    }
    else if(m.t==='resumed'){
      roomCode=String(m.code||roomCode);myIndex=Number(m.index);playerToken=String(m.playerToken||playerToken);isHost=!!m.host;
      if(Array.isArray(m.players)){lobbyPlayers=m.players.slice();cpuFillEnabled=!!m.cpuFill;ensureP2P()?.configure({myIndex,isHost,players:lobbyPlayers});syncVoicePlayers(lobbyPlayers,true);}
      updateCpuFillButton(cpuFillEnabled);saveResumeSession();stopResumeWindow();
      roomCodeEl.textContent=roomCode;if(roomMini)roomMini.textContent='';stopMusic();menu.classList.add('hidden');
      if(voice)voice.setSession(roomCode,myIndex,!!m.cpu);
      if(m.started&&isHost&&!hostPhysics&&!inGame){
        clearResumeSession();playerToken='';
        alert(sinTildes(tr('resumeFailed')));
        send({t:'leave'});returnToMainMenu(false);return;
      }
      if(m.started){lobby.classList.add('hidden');if(!inGame)beginGame();}
      else if(!m.cpu){lobby.classList.remove('hidden');}
    }
    else if(m.t==='resume-failed'){
      stopResumeWindow();clearResumeSession();playerToken='';
      if(inGame||roomCode){alert(sinTildes(trServer(m.message||tr('resumeFailed'))));returnToMainMenu(false);}
      else send({t:'public-rooms'});
    }
    else if(m.t==='lobby'){
      roomCode=m.code;lobbyPlayers=Array.isArray(m.players)?m.players.slice():[];cpuFillEnabled=!!m.cpuFill;
      ensureP2P()?.configure({myIndex,isHost,players:lobbyPlayers});
      // El roster es la autoridad sobre si cada plaza es HUMANO o CPU,
      // tambien durante la victoria/espera entre partidas.
      if(isHost&&hostPhysics&&typeof hostPhysics.syncRoster==='function')hostPhysics.syncRoster(lobbyPlayers);
      syncVoicePlayers(m.players,true);roomCodeEl.textContent=m.code;
      playersEl.innerHTML=m.players.map(p=>`<div style="color:${playerColors[p.i]||'#fff'}">J${p.i+1} · ${escapeHtml(sinTildes(p.n))}${p.registered?' · ✓':''}${p.cpu?' · CPU':''}</div>`).join('');
      updateLobbyStartButton(!!m.canStart);updateCpuFillButton(cpuFillEnabled);updateWaitingPlayers(m.players);
    }
    else if(m.t==='start'){netStartAt=performance.now();lastP2PStateAt=0;lastFallbackRequestAt=0;lastFallbackStateSentAt=0;fallbackActive=false;p2pStableCount=0;fallbackPeers.clear();fallbackReconnectAt.clear();if(Array.isArray(m.players))lobbyPlayers=m.players.slice();ensureP2P()?.configure({myIndex,isHost,players:lobbyPlayers});if(isHost)startHostPhysics(lobbyPlayers,m.rankRound);beginGame();playSound('start');}
    else if(m.t==='state'){
      const now=performance.now();
      if(impactFX)impactFX.consume(m,myIndex,now);
      updateLeaderAnnouncement(m,now);
      const oldLocal=state&&Array.isArray(state.players)?state.players.find(p=>p.i===myIndex):null;
      const newLocal=Array.isArray(m.players)?m.players.find(p=>p.i===myIndex):null;
      if(Array.isArray(m.players)){
        for(const np of m.players){
          const idx=Number(np&&np.i);
          if(!Number.isInteger(idx)||idx<0||idx>=invisibleHudUntil.length)continue;
          const op=state&&Array.isArray(state.players)?state.players.find(p=>Number(p.i)===idx):null;
          const oldCamo=Number(op&&op.camo)||0;
          const newCamo=Number(np&&np.camo)||0;
          if(newCamo>0&&oldCamo<=0){invisibleHudUntil[idx]=now+2000;invisibleNoticeIndex=idx;invisibleNoticeUntil=now+2000;}
        }
      }
      if(oldLocal&&newLocal&&Number(newLocal.k)>Number(oldLocal.k)){
        // Confirmacion visual local de baja: no se envia por red y solo la ve
        // el jugador que acaba de sumar una muerte.
        killHudFlashStart=now;
        killHudFlashUntil=now+450;
        // El servidor suma la baja inmediatamente, pero visualmente mantenemos
        // el valor anterior hasta que empieza el pop de escala. De este modo
        // numero nuevo y animacion aparecen exactamente a la vez.
        // Si la baja anterior ya habia sido revelada, el nuevo valor de espera
        // parte del marcador que el jugador ya estaba viendo.
        if(killScoreHeldValue===null||now>=killScoreFxStart)killScoreHeldValue=Number(oldLocal.k)||0;
        killScorePendingValue=Number(newLocal.k)||0;
        killScoreFxStart=now+2000;
        killScoreFxUntil=killScoreFxStart+2000;
      } else if(oldLocal&&newLocal&&Number(newLocal.k)<Number(oldLocal.k)){
        killScoreHeldValue=null;
        killScorePendingValue=null;
        // El servidor descuenta la baja inmediatamente, pero visualmente primero
        // mostramos PENALIZACION -1. Durante ese aviso se conserva el valor
        // anterior; al terminar, aparece la resta con el efecto del HUD.
        crashScoreHeldValue=Number(oldLocal.k)||0;
        crashScorePendingValue=Number(newLocal.k)||0;
        penaltyMessageUntil=now+2000;
        crashScoreFxStart=penaltyMessageUntil;
        crashScoreFxUntil=crashScoreFxStart+950;
      }
      if(lastStateTime>0){
        const arrived=now-lastStateTime;
        if(Number.isFinite(arrived)&&arrived>=16&&arrived<=100){
          const sample=clamp(arrived,24,60);
          smoothedStateInterval+=0.14*(sample-smoothedStateInterval);
        }
      }
      previousState=state;
      previousStateTime=lastStateTime;
      rebuildPreviousLookup(previousState);
      state=m;lastStateTime=now;
      if(!previousState){previousState=m;previousStateTime=now-NET_FRAME_MS;rebuildPreviousLookup(m);}
      syncVoicePlayers(m.players);
      maybeScheduleVictory();
      if(!inGame&&m.started&&!m.finished)beginGame();
    }
    else if(m.t==='brutal'){brutalFxStart=performance.now();brutalFxUntil=brutalFxStart+1650;brutalDistance=Number(m.distance)||0;brutalDistanceText=brutalDistance>0?(Math.round(brutalDistance*(8/48))+' m'):'';brutalShooter=sinTildes(String(m.shooter||'')).trim();}
    else if(m.t==='weapon-theft'){
      const theftIndex=Math.max(0,Math.min(3,Number(m.index)||0));
      // El robo sigue siendo un evento de partida, pero el cartel es privado:
      // solo lo ve en su pantalla el jugador que ha realizado la embestida.
      if(Number(myIndex)===theftIndex){
        weaponTheftFxStart=performance.now();
        weaponTheftFxUntil=weaponTheftFxStart+2000;
        weaponTheftIndex=theftIndex;
      }
    }
    else if(m.t==='hunt'){
      huntFxStart=performance.now();
      huntFxUntil=huntFxStart+Math.max(2200,Number(m.graceMs)||0);
      huntText='A POR '+sinTildes(String(m.name||'JUGADOR')).trim().toUpperCase();
      huntCpuAmmo=!!m.cpuAmmo;
      huntCpuBonus=Math.max(0,Number(m.cpuAmmoBonus)||0);
      huntCpuIndices=Array.isArray(m.cpuIndices)?m.cpuIndices.map(Number).filter(Number.isFinite):[];
    }
    else if(m.t==='rank-round'){
      if(isHost&&hostPhysics&&Number.isFinite(Number(m.rankRound)))hostPhysics.rankRound=Number(m.rankRound);
    }
    else if(m.t==='sound'){playSound(m.kind);}
    else if(m.t==='cpu-learning'){submitCpuLearning(m.deltas);}
    else if(m.t==='victory'){if(state)state.winner=m.winner;queueVictory(m.winner);}
    else if(m.t==='restarted'){if(impactFX)impactFX.reset();invisibleHudUntil.fill(0);clearTimeout(victoryShowTimer);victoryShowTimer=null;pendingVictoryIndex=null;state=null;previousState=null;lastStateTime=0;previousStateTime=0;smoothedStateInterval=NET_FRAME_MS;resetLocalVisual();rebuildPreviousLookup(null);killHudFlashStart=0;killHudFlashUntil=0;killScoreFxStart=0;killScoreFxUntil=0;killScoreHeldValue=null;killScorePendingValue=null;crashScoreFxStart=0;crashScoreFxUntil=0;crashScoreHeldValue=null;crashScorePendingValue=null;penaltyMessageUntil=0;brutalFxStart=0;brutalFxUntil=0;brutalDistance=0;brutalDistanceText='';brutalShooter='';weaponTheftFxStart=0;weaponTheftFxUntil=0;weaponTheftIndex=-1;huntFxStart=0;huntFxUntil=0;huntText='';huntCpuAmmo=false;huntCpuBonus=0;huntCpuIndices=[];invisibleNoticeIndex=-1;invisibleNoticeUntil=0;victory.classList.remove('winner-celebration');victory.classList.add('hidden');beginGame();}
    else if(m.t==='error'){if(sharedRoomCode&&!roomCode)sharedRoomJoinStarted=false;statusEl.textContent=sinTildes(m.message?trServer(m.message):tr('error'));}
    else if(m.t==='closed'){stopResumeWindow();clearResumeSession();playerToken='';alert(sinTildes(m.reason?trServer(m.reason):tr('close')));location.reload();}
  }
  function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  function beginGame(){stopMusic();if(isMobile&&mobileControlMode==='motion'&&!mobileKeyboardActive)calibrateMobileMotion();updateMobileControlUi();resetLocalVisual();lastControlThrust=false;lastControlSentAt=0;lastSentControlTurn=NaN;lastSentControlThrust=false;lastSentControlFire=false;inGame=true;menu.classList.add('hidden');lobby.classList.add('hidden');victory.classList.remove('winner-celebration');victory.classList.add('hidden');topbar.classList.remove('hidden');if(isMobile){mobileControls.classList.remove('hidden');if(mobileExit)mobileExit.classList.remove('hidden');}scheduleCanvasResolution();}
  function queueVictory(i){
    pendingVictoryIndex=Number(i);
    clearTimeout(victoryShowTimer);victoryShowTimer=null;
    maybeScheduleVictory();
  }
  function maybeScheduleVictory(){
    if(pendingVictoryIndex===null||!inGame||victoryShowTimer||!state||!Array.isArray(state.players))return;
    const winner=state.players.find(p=>Number(p.i)===Number(pendingVictoryIndex));
    const target=Math.max(1,Number(state.scoreToWin)||5);
    if(!winner||Number(winner.k)<target)return;
    const now=performance.now();
    // Si la baja ganadora es nuestra, el HUD mantiene 4/5 durante dos segundos.
    // Esperamos a que el contador cambie realmente a 5/5 y dejamos ver el pop
    // antes de cubrir la partida con la celebracion final.
    let delay=700;
    if(Number(pendingVictoryIndex)===Number(myIndex)&&killScorePendingValue!==null){
      delay=Math.max(0,killScoreFxStart-now)+650;
    }
    const winnerIndex=pendingVictoryIndex;
    victoryShowTimer=setTimeout(()=>{
      victoryShowTimer=null;
      if(pendingVictoryIndex!==winnerIndex||!inGame)return;
      pendingVictoryIndex=null;
      showVictory(winnerIndex);
    },delay);
  }
  function showVictory(i){
    if(!inGame)return;
    inGame=false;leaderAnnouncement=null;
    topbar.classList.add('hidden');mobileControls.classList.add('hidden');
    if(mobileExit)mobileExit.classList.add('hidden');
    resetMobileTouchControls();
    const p=state&&state.players.find(x=>x.i===i);
    const victoryText=document.getElementById('victoryText');
    victoryText.textContent=p?tr('winnerName',{name:sinTildes(p.n)}):tr('winnerIndex',{index:i+1});
    victory.style.setProperty('--winner-color',playerColors[Number(i)]||'#d8a7ff');
    const restartBtn=document.getElementById('restartMatch');
    if(restartBtn){restartBtn.disabled=false;restartBtn.textContent=tr('rematch');}
    victory.classList.remove('hidden','winner-celebration');
    void victory.offsetWidth;
    victory.classList.add('winner-celebration');
  }

  postAnalyticsEvent('visit');
  function unlockAudioFromUserGesture(){
    if(!gameAudioEnabled)return;
    // La musica se arranca directamente en el gesto; esto es importante en
    // Safari/iOS, donde un play() posterior a un await puede quedar bloqueado.
    startMusic();
    unlockGameAudio();
  }
  menu.addEventListener('pointerdown',unlockAudioFromUserGesture,{passive:true});
  menu.addEventListener('touchstart',unlockAudioFromUserGesture,{passive:true});
  menu.addEventListener('click',unlockAudioFromUserGesture);
  menu.addEventListener('keydown',unlockAudioFromUserGesture);
  updateAudioButton();
  if(audioToggleButton)audioToggleButton.addEventListener('click',toggleGameAudio);

  if(shareGameBtn)shareGameBtn.addEventListener('click',shareGameLink);
  if(shareRoomBtn)shareRoomBtn.addEventListener('click',shareCurrentRoom);
  document.getElementById('create').addEventListener('click',()=>{startMusic();showRoomTypeDialog();});
  document.getElementById('cpu').addEventListener('click',()=>{if(isMobile){startMusic();showCpuSetupDialog();}else startLocalCpu();});
  document.getElementById('join').addEventListener('click',()=>{startMusic();showPublicRoomsDialog();});
  document.getElementById('createPublic').addEventListener('click',()=>createOnlineRoom(true));
  document.getElementById('createPrivate').addEventListener('click',()=>createOnlineRoom(false));
  document.getElementById('closeRoomType').addEventListener('click',closeRoomDialogs);
  document.getElementById('closePublicRooms').addEventListener('click',closeRoomDialogs);
  if(cpuSetupPlay)cpuSetupPlay.addEventListener('click',confirmCpuSetup);
  if(cpuSetupClose)cpuSetupClose.addEventListener('click',closeRoomDialogs);
  document.getElementById('joinByCodeDialog').addEventListener('click',()=>joinRoomByCode(joinCodeDialog&&joinCodeDialog.value));
  if(joinCodeDialog)joinCodeDialog.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();joinRoomByCode(joinCodeDialog.value);}});
  if(roomTypeDialog)roomTypeDialog.addEventListener('pointerdown',e=>{if(e.target===roomTypeDialog)closeRoomDialogs();});
  if(publicRoomsDialog)publicRoomsDialog.addEventListener('pointerdown',e=>{if(e.target===publicRoomsDialog)closeRoomDialogs();});
  if(cpuSetupDialog)cpuSetupDialog.addEventListener('pointerdown',e=>{if(e.target===cpuSetupDialog)closeRoomDialogs();});
  if(fillCpuBtn)fillCpuBtn.addEventListener('click',()=>{if(isHost&&!inGame)send({t:'cpu-fill',on:!cpuFillEnabled});});
  if(lobbyChatSend)lobbyChatSend.addEventListener('click',sendLobbyChat);
  if(lobbyChatInput)lobbyChatInput.addEventListener('keydown',e=>{
    if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendLobbyChat();}
    // Evita que las teclas escritas en el chat controlen la nave si cambia el estado.
    e.stopPropagation();
  });
  if(lobbyChatInput)lobbyChatInput.addEventListener('keyup',e=>e.stopPropagation());
  if(isMobile){
    if(mobileControlMotionBtn)mobileControlMotionBtn.addEventListener('click',()=>setMobileControlMode('motion',true));
    if(mobileControlButtonsBtn)mobileControlButtonsBtn.addEventListener('click',()=>setMobileControlMode('buttons',false));
    const appEl=document.getElementById('app');
    appEl.addEventListener('pointerdown',mobilePointerDown,{passive:false});
    appEl.addEventListener('pointerup',mobilePointerEnd,{passive:false});
    appEl.addEventListener('pointercancel',mobilePointerEnd,{passive:false});
    appEl.addEventListener('lostpointercapture',mobilePointerEnd,{passive:false});
    appEl.addEventListener('pointerleave',e=>{if(e.pointerType==='touch')mobilePointerEnd(e);},{passive:false});
    // V18.81: iOS usa Touch Events nativos para disparo/acelerador porque
    // Safari puede perder el final de un Pointer Event. touch.identifier se
    // conserva hasta touchend/touchcancel y evita que quede un gesto fantasma.
    if(isIOS){
      appEl.addEventListener('touchstart',mobileTouchStart,{passive:false});
      appEl.addEventListener('touchend',mobileTouchEnd,{passive:false});
      appEl.addEventListener('touchcancel',mobileTouchEnd,{passive:false});
    }
    // Respaldo global para Android/otros navegadores con Pointer Events.
    window.addEventListener('pointerup',mobilePointerEnd,{passive:false,capture:true});
    window.addEventListener('pointercancel',mobilePointerEnd,{passive:false,capture:true});
    window.addEventListener('lostpointercapture',mobilePointerEnd,{passive:false,capture:true});
    window.addEventListener('blur',resetMobileTouchControls);
    window.addEventListener('pagehide',resetMobileTouchControls);
    document.addEventListener('visibilitychange',()=>{
      if(document.hidden)resetMobileTouchControls();
    });
    document.addEventListener('freeze',resetMobileTouchControls);
    window.addEventListener('orientationchange',()=>{
      motionNeutral=null;motionTurn=0;
      mobileButtonTurn=0;mobileLeftPointers.clear();mobileRightPointers.clear();
      resetMobileTouchControls();
      keys.clear();
    });
    if(screen.orientation)screen.orientation.addEventListener?.('change',()=>{motionNeutral=null;motionTurn=0;});
  }
  window.addEventListener('resize',scheduleCanvasResolution,{passive:true});
  window.addEventListener('orientationchange',scheduleCanvasResolution,{passive:true});
  scheduleCanvasResolution();
  updateBuildVersionLearningState();
  refreshCpuLearningControl();
  const cpuLearningStatusTimer=setInterval(refreshCpuLearningControl,5000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshCpuLearningControl();});
  startBtn.addEventListener('click',async()=>{
    await Promise.all([prepareMobileControls(),prepareGameAssets()]);
    calibrateMobileMotion();send({t:'start'});
  });
  function returnToMainMenu(notifyServer=true){
    if(!sharedRoomCode)sharedRoomJoinStarted=false;
    invisibleHudUntil.fill(0);
    clearTimeout(victoryShowTimer);victoryShowTimer=null;pendingVictoryIndex=null;
    victory.classList.remove('winner-celebration');
    const wasLocal=localCpuActive;
    if(wasLocal)stopLocalCpu();
    if(notifyServer&&!wasLocal&&roomCode)send({t:'leave'});
    if(voice)voice.clearSession();
    stopP2P();
    stopResumeWindow();clearResumeSession();playerToken='';
    inGame=false;setMobileKeyboardActive(false);state=null;previousState=null;pendingStateRaw=null;lastStateTime=0;previousStateTime=0;smoothedStateInterval=NET_FRAME_MS;resetLocalVisual();lastControlThrust=false;lastControlSentAt=0;lastSentControlTurn=NaN;lastSentControlThrust=false;lastSentControlFire=false;
    killScoreHeldValue=null;killScorePendingValue=null;killScoreFxStart=0;killScoreFxUntil=0;
    roomCode='';myIndex=null;isHost=false;cpuFillEnabled=false;lastVoicePlayersSig=0;rebuildPreviousLookup(null);
    lobby.classList.add('hidden');victory.classList.add('hidden');topbar.classList.add('hidden');
    mobileControls.classList.add('hidden');if(mobileExit)mobileExit.classList.add('hidden');resetMobileTouchControls();
    roomCodeEl.textContent='';roomMini.textContent='';playersEl.innerHTML='';clearLobbyChat();updateLobbyStartButton(false);updateCpuFillButton(false);updateWaitingPlayers(1);
    menu.classList.remove('hidden');startMusic();scheduleCanvasResolution();
  }
  document.getElementById('leaveRoom').addEventListener('click',returnToMainMenu);
  if(mobileExit){
    // V16.4.54: salir en el primer toque. En algunos moviles el click sintetico
    // podia no llegar tras el primer pointerdown, obligando a tocar dos veces.
    let mobileExitHandled=false;
    mobileExit.addEventListener('pointerdown',e=>{
      e.preventDefault();
      e.stopPropagation();
      if(mobileExitHandled)return;
      mobileExitHandled=true;
      returnToMainMenu();
      setTimeout(()=>{mobileExitHandled=false;},250);
    },{passive:false});
    mobileExit.addEventListener('click',e=>{
      e.preventDefault();
      e.stopPropagation();
    });
  }
  const restartMatchBtn=document.getElementById('restartMatch');
  if(restartMatchBtn)restartMatchBtn.addEventListener('click',()=>{
    restartMatchBtn.disabled=true;
    restartMatchBtn.textContent=tr('restarting');
    let ok=false;
    if(roomCode==='LOCAL')ok=send({t:'restart'});
    else if(p2p&&!fallbackActive)ok=p2p.sendAction('restart');
    if(!ok&&roomCode!=='LOCAL'&&ws&&ws.readyState===WebSocket.OPEN){
      try{ws.send(JSON.stringify({t:'fallback-action',action:'restart'}));ok=true;}catch(_){}
    }
    if(!ok){restartMatchBtn.disabled=false;restartMatchBtn.textContent=tr('rematch');}
  });
  document.getElementById('back').addEventListener('click',returnToMainMenu);
  window.addEventListener('keydown',e=>{
    keys.add(e.code);
    if(isMobile&&inGame&&MOBILE_KEYBOARD_CODES.has(e.code)){
      if(!mobileKeyboardActive)setMobileKeyboardActive(true);
    }
    if(['ArrowUp','ArrowLeft','ArrowRight','Space','ControlLeft','ControlRight'].includes(e.code))e.preventDefault();
    if(e.code==='Escape'){
      if((roomTypeDialog&&!roomTypeDialog.classList.contains('hidden'))||(publicRoomsDialog&&!publicRoomsDialog.classList.contains('hidden'))){closeRoomDialogs();}
      else if(inGame)returnToMainMenu();
    }
  });
  window.addEventListener('keyup',e=>{
    keys.delete(e.code);
    if(isMobile&&mobileKeyboardActive&&MOBILE_KEYBOARD_CODES.has(e.code)){
      let keyboardStillHeld=false;
      for(const code of MOBILE_KEYBOARD_CODES){if(keys.has(code)){keyboardStillHeld=true;break;}}
      if(!keyboardStillHeld)setMobileKeyboardActive(false);
    }
  });
  // Si el navegador pierde el foco, puede no llegar el keyup de una tecla que
  // estaba pulsada. Limpiamos el estado para evitar giro/aceleracion/disparo
  // pegados al volver a la ventana.
  function clearHeldKeys(){
    keys.clear();
    lastControlTurn=0;
    if(isMobile)resetMobileTouchControls();
    if(inGame)sendControl(0,false,false);
  }
  window.addEventListener('blur',clearHeldKeys);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)clearHeldKeys();});
  window.addEventListener('beforeunload',()=>{manualClose=true;clearTimeout(reconnectTimer);clearInterval(cpuLearningStatusTimer);stopLocalCpu();stopP2P();if(voice)voice.shutdown(true);try{if(ws)ws.close();}catch(_){}});

  function imageReady(im){
    // complete is ALSO true after a failed download. Check decoded dimensions.
    return Boolean(im&&im.complete&&im.naturalWidth>0&&im.naturalHeight>0);
  }
  function drawImageSafely(im,x,y,width,height){
    if(!imageReady(im))return false;
    try{
      if(width===undefined){ctx.drawImage(im,x,y);}
      else {ctx.drawImage(im,x,y,width,height);}
      return true;
    }catch(error){
      reportImageFailure(im,error);
      return false;
    }
  }
  function drawImageCentered(im,x,y,size,rot=0,alpha=1){
    if(!imageReady(im)||!Number.isFinite(x)||!Number.isFinite(y)||!Number.isFinite(rot))return false;
    // Asteroides, mejoras y meteorito gigante no rotados son la mayoria de
    // drawImage del frame. Evitamos save/translate/rotate/restore en ese caso.
    if(rot===0&&alpha===1){
      if(size)return drawImageSafely(im,x-size/2,y-size/2,size,size);
      return drawImageSafely(im,x-im.naturalWidth/2,y-im.naturalHeight/2);
    }
    ctx.save();
    try{
      ctx.globalAlpha=alpha;
      ctx.translate(x,y);
      if(rot!==0)ctx.rotate(rot*Math.PI/180);
      if(size)return drawImageSafely(im,-size/2,-size/2,size,size);
      return drawImageSafely(im,-im.naturalWidth/2,-im.naturalHeight/2);
    }finally{
      ctx.restore();
    }
  }
  function drawLocalizaMarker(x,y,owner,alpha=.92){
    const idx=Math.max(0,Math.min(3,Number(owner)||0));
    const im=images[localizaSpriteKeys[idx]];
    if(!imageReady(im))return false;
    return drawImageCentered(im,x,y,78,0,alpha);
  }
  const pickupSpriteMap={ammo1:'ammo1',ammo3:'ammo3',cadence:'cadence',speed:'speed',mira:'mira1'};
  function pickupExpiryAlpha(pk,nowSec){
    const raw=pk&&pk.expiresIn;
    // null significa que esta mejora NO esta pendiente de desaparecer.
    // Importante: Number(null) === 0, por eso hay que comprobar null antes.
    if(raw===null||raw===undefined)return 1;
    const left=Number(raw);
    // Durante toda su vida permanece al 100%. Solo en los ultimos 2 segundos
    // parpadea de forma regular entre 50% y 100% de opacidad.
    if(!Number.isFinite(left)||left>2)return 1;
    const pulse=.5+.5*Math.sin(nowSec*Math.PI*2*3);
    return .5+.5*pulse;
  }
  function drawPickup(pk,x=pk.x,y=pk.y,nowSec=0){
    const alpha=pickupExpiryAlpha(pk,nowSec);
    if(pickupSpriteMap[pk.type]){drawImageCentered(images[pickupSpriteMap[pk.type]],x,y,46,0,alpha);return;}
    ctx.save();ctx.translate(x,y);
    if(pk.type==='shield'){
      ctx.strokeStyle='#8ff5ff';ctx.lineWidth=4;ctx.globalAlpha=.9*alpha;ctx.beginPath();ctx.arc(0,0,20,0,Math.PI*2);ctx.stroke();
      ctx.globalAlpha=.25*alpha;ctx.fillStyle='#5adfff';ctx.fill();
    }
    else if(pk.type==='camo'){
      // Invisibilidad: ojo tachado vectorial. Evita un asset adicional y
      // conserva el mismo peso/rendimiento del pickup anterior.
      ctx.globalAlpha=alpha;
      ctx.strokeStyle='#d1b4ff';
      ctx.fillStyle='rgba(160,100,255,.16)';
      ctx.lineWidth=3;
      ctx.beginPath();ctx.arc(0,0,21,0,Math.PI*2);ctx.fill();ctx.stroke();

      // Ojo.
      ctx.globalAlpha=.95*alpha;
      ctx.strokeStyle='#ffffff';
      ctx.lineWidth=3;
      ctx.lineCap='round';
      ctx.lineJoin='round';
      ctx.beginPath();
      ctx.moveTo(-13,0);
      ctx.bezierCurveTo(-7,-9,7,-9,13,0);
      ctx.bezierCurveTo(7,9,-7,9,-13,0);
      ctx.stroke();
      ctx.beginPath();ctx.arc(0,0,4.2,0,Math.PI*2);ctx.fillStyle='#ffffff';ctx.fill();

      // Tachado diagonal.
      ctx.strokeStyle='#ffffff';
      ctx.lineWidth=4;
      ctx.beginPath();ctx.moveTo(-14,-14);ctx.lineTo(14,14);ctx.stroke();
    }
    ctx.restore();
  }
  function spawnProtectionAlpha(secondsLeft){
    if(!Number.isFinite(secondsLeft)||secondsLeft<=0)return 1;
    // Six soft pulses over three seconds. The ship never disappears fully.
    // Use the server timer, so all players see the same protection state.
    const elapsed=Math.max(0,3-secondsLeft);
    return .35+.65*(.5+.5*Math.cos(elapsed*Math.PI*4));
  }
  function lerp(a,b,t){return a+(b-a)*t;}
  function lerpAngle(a,b,t){
    const delta=((b-a+540)%360)-180;
    return (a+delta*t+360)%360;
  }
  function lerpWrapped(a,b,size,t){
    let delta=b-a;
    if(delta>size/2)delta-=size;else if(delta<-size/2)delta+=size;
    return (a+delta*t+size)%size;
  }
  function interpolationAlpha(now){
    if(!previousState||previousState===state||!lastStateTime)return 1;
    return clamp((now-lastStateTime)/smoothedStateInterval,0,1);
  }
  function wrappedDelta(from,to,size){
    let d=to-from;
    if(d>size/2)d-=size;else if(d<-size/2)d+=size;
    return d;
  }
  function angleDelta(from,to){return ((to-from+540)%360)-180;}
  function ghostRevealAlpha(p,now){
    const camo=Number(p&&p.camo)||0;
    if(camo<=0)return 0;
    // El camuflaje dura 10 s. Para los rivales, la nave se revela brevemente
    // cada 4 s (aprox. en los segundos 4 y 8) con fundido de entrada/salida.
    const elapsed=Math.max(0,10-camo);
    if(elapsed<4)return 0;
    const phase=elapsed%4;
    const window=1.0;
    if(phase>=window)return 0;
    let alpha=1;
    if(phase<0.25)alpha=phase/0.25;
    else if(phase>0.75)alpha=(window-phase)/0.25;
    return Math.max(0,Math.min(1,alpha));
  }
  function drawShip(p,previous,blend,now){
    const local=p.i===myIndex;
    let x=p.x,y=p.y,r=p.r;
    if(local){
      // V16.4.41: pose visual continua para la nave local. Antes la posicion se
      // extrapolaba desde cero en cada snapshot. Si un paquete llegaba unos ms
      // tarde, la nave se reenganchaba a una posicion distinta y el microajuste
      // aumentaba con la velocidad. Ahora avanzamos una pose visual continua y
      // reconciliamos suavemente contra la posicion autoritativa del servidor.
      const age=Math.min(.05,Math.max(0,(now-lastStateTime)/1000));
      const targetX=(p.x+p.vx*age+W)%W;
      const targetY=(p.y+p.vy*age+H)%H;
      // Para la rotacion local no extrapolamos el snapshot con el input actual.
      // En pulsaciones cortas, el snapshot puede corresponder todavia al input
      // anterior; extrapolarlo con el estado actual provoca un rollback visual
      // al soltar y otro giro cuando llega el siguiente snapshot.
      const targetR=isMobile?(p.r+lastControlTurn*240*age+360)%360:(p.r+360)%360;
      const needsReset=!localVisual.ready||localVisual.index!==p.i||(previous&&previous.dead)||now-localVisual.lastAt>250;
      if(needsReset){
        localVisual.ready=true;localVisual.index=p.i;
        localVisual.x=targetX;localVisual.y=targetY;localVisual.r=targetR;
        localVisual.vx=p.vx;localVisual.vy=p.vy;localVisual.lastAt=now;localVisual.lastError=0;
      }else{
        const dt=Math.min(.05,Math.max(0,(now-localVisual.lastAt)/1000));
        localVisual.lastAt=now;
        // Prediccion visual con la misma aceleracion/drag que el servidor.
        // Es solo dibujo: la fisica autoritativa sigue estando en server.js.
        // Esto evita que la aceleracion avance en escalones de 30 Hz.
        localVisual.r=(localVisual.r+lastControlTurn*240*dt+360)%360;
        if(lastControlThrust){
          const rr=localVisual.r*Math.PI/180;
          const accel=240*(Number(p.spd)||1);
          localVisual.vx+=(-Math.sin(rr))*accel*dt;
          localVisual.vy+=(-Math.cos(rr))*accel*dt;
        }
        const drag=Math.pow(0.35,dt);
        localVisual.vx*=drag;localVisual.vy*=drag;
        const vmax=330*(Number(p.spd)||1);
        const visualSpeed=Math.hypot(localVisual.vx,localVisual.vy);
        if(visualSpeed>vmax){
          localVisual.vx=localVisual.vx/visualSpeed*vmax;
          localVisual.vy=localVisual.vy/visualSpeed*vmax;
        }
        localVisual.x=(localVisual.x+localVisual.vx*dt+W)%W;
        localVisual.y=(localVisual.y+localVisual.vy*dt+H)%H;

        // Reconciliacion suave de velocidad y posicion contra el servidor.
        // Las colisiones/respawns siguen mandando porque, si el error es grande,
        // hacemos snap inmediato.
        const velError=Math.hypot(p.vx-localVisual.vx,p.vy-localVisual.vy);
        const velocityFollow=1-Math.exp(-(velError>160?26:9)*dt);
        localVisual.vx+=(p.vx-localVisual.vx)*velocityFollow;
        localVisual.vy+=(p.vy-localVisual.vy)*velocityFollow;

        const dx=wrappedDelta(localVisual.x,targetX,W);
        const dy=wrappedDelta(localVisual.y,targetY,H);
        const error=Math.hypot(dx,dy);
        localVisual.lastError=error;
        if(perfStats&&error>perfStats.localErrMax)perfStats.localErrMax=error;
        if(error>90){
          // Teletransporte/respawn/impacto fuerte: no arrastrar una correccion.
          localVisual.x=targetX;localVisual.y=targetY;
          localVisual.vx=p.vx;localVisual.vy=p.vy;
        }else{
          const positionFollow=1-Math.exp(-16*dt);
          localVisual.x=(localVisual.x+dx*positionFollow+W)%W;
          localVisual.y=(localVisual.y+dy*positionFollow+H)%H;
        }
        const dr=angleDelta(localVisual.r,targetR);
        // El servidor va por detras del input local aproximadamente un snapshot
        // + latencia. Tras pulsar o soltar giro, damos un breve margen para que
        // el snapshot autoritativo alcance la rotacion ya mostrada. Asi una
        // pulsacion corta no hace: gira -> vuelve -> gira otra vez.
        const rotationGrace=(now-lastControlTurnChangedAt)<180;
        // En PC, mientras la tecla de giro esta pulsada, la pose local ya usa
        // exactamente los 240 deg/s del servidor. Corregir contra un snapshot
        // que va unos ms por detras restaria giro y causaria un segundo tiron.
        // Tras soltar, esperamos 180 ms para que el servidor alcance la pose.
        const deferDesktopRotation=!isMobile&&(Math.abs(lastControlTurn)>0.001||rotationGrace);
        if(!deferDesktopRotation){
          // Correccion deliberadamente suave: seguimos siendo autoritativos,
          // pero sin que el jitter de red se convierta en un rebote visible.
          const absDr=Math.abs(dr);
          if(absDr>55){
            localVisual.r=targetR;
          }else{
            const rotationFollow=1-Math.exp(-(isMobile?20:8)*dt);
            localVisual.r=(localVisual.r+dr*rotationFollow+360)%360;
          }
        }
      }
      x=localVisual.x;y=localVisual.y;r=localVisual.r;
    }else if(previous&&!previous.dead){
      x=lerpWrapped(previous.x,p.x,W,blend);
      y=lerpWrapped(previous.y,p.y,H,blend);
      r=lerpAngle(previous.r,p.r,blend);
    }
    // The short explosion is drawn by impactFX, never from a PNG download.
    if(p.dead)return;
    const localizedOwner=localizedTargetOwners[Number(p.i)];
    const localized=Number.isInteger(localizedOwner)&&localizedOwner>=0;
    let alpha=1;
    if(p.camo>0&&!local){
      const revealAlpha=ghostRevealAlpha(p,now);
      if(revealAlpha<=0){
        if(localized)drawLocalizaMarker(x,y,localizedOwner,.92);
        return;
      }
      // Revelacion encadenada: aparece y desaparece suavemente.
      alpha=.78*revealAlpha;
    }
    if(p.camo>0&&local){alpha=.42;if(p.camo<=3)alpha=(Math.floor(now/160)%2===0)?.55:.22;}
    if(p.prot>0)alpha*=spawnProtectionAlpha(p.prot);
    if(p.shield>0){
      let shieldAlpha=alpha;
      // Aviso visual en los ultimos 3 segundos: el escudo parpadea suavemente
      // sin modificar su duracion ni la proteccion real en el servidor.
      if(p.shield<=3){
        const shieldPulse=.38+.62*(.5+.5*Math.sin(now*.012));
        shieldAlpha*=shieldPulse;
      }
      ctx.save();ctx.globalAlpha=shieldAlpha;ctx.strokeStyle='rgba(130,245,255,.95)';ctx.fillStyle='rgba(80,220,255,.12)';ctx.lineWidth=4;ctx.beginPath();ctx.arc(x,y,SHIELD_DRAW_RADIUS,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.restore();
    }
    // Python: armado = balas > 0 y recarga terminada. El servidor confirma
    // ese estado; no cambiamos el movimiento ni el efecto de propulsion web.
    const variants=SHIP_IMAGE_KEYS[p.i]||SHIP_IMAGE_KEYS[0];
    // La propulsion visual depende del acelerador, no de la velocidad.
    // Para la nave local usamos el control de este mismo frame para que el PNG
    // cambie al instante al pulsar/soltar, incluso mientras sigue por inercia.
    const thrusting=Number(p.i)===Number(myIndex)?!!lastControlThrust:p.thrust===true;
    const armed=p.armed===true;
    const selected=images[thrusting?(armed?variants.af:variants.a):(armed?variants.f:variants.base)];
    const normal=images[thrusting?variants.a:variants.base]||images[variants.base];
    // Si el PNG aun no esta disponible, dibujar la nave normal sin bloquear.
    const im=imageReady(selected)?selected:normal;
    // Los PNG originales de las naves apuntan hacia ARRIBA.
    // La fisica usa rot=0 arriba, 90 izquierda, 180 abajo y 270 derecha.
    // Canvas gira en el sentido visual contrario a esa convencion, por eso
    // dibujamos con -rot. Asi el morro coincide exactamente con el avance.
    drawImageCentered(im,x,y,SHIP_DRAW_SIZE,-r,alpha);
    if(p.mira===true){
      const navemiraKey=NAVEMIRA_IMAGE_KEYS[Math.max(0,Math.min(3,Number(p.i)||0))]||NAVEMIRA_IMAGE_KEYS[0];
      const navemiraIm=imageReady(images[navemiraKey])?images[navemiraKey]:images.navemira;
      if(imageReady(navemiraIm))drawImageCentered(navemiraIm,x,y,64,-r,Math.min(1,alpha*.95));
    }
    if(localized)drawLocalizaMarker(x,y,localizedOwner,Math.min(1,alpha*.95));
  }
  function drawHud(now){
    if(!state)return;
    let max=0,leader=null,tied=false;
    for(const p of state.players){
      const score=Number(p.k)||0;
      if(score>max){max=score;leader=p.i;tied=false;}
      else if(score===max&&score>0){tied=true;}
    }
    if(max<=0||tied)leader=null;
    for(const p of state.players){
      // HUD ligeramente mayor en ambas plataformas para mejorar la lectura.
      // Movil conserva un refuerzo extra porque muestra todo el campo 16:9.
      const hudScale=HUD_SCALE;
      const panelW=HUD_PANEL_W,panelH=HUD_PANEL_H;
      const left=p.i%2===0,top=p.i<2;
      const px=left?10:W-10-panelW;
      const bottomHudMargin=isMobile?45:36;
      const py=top?5:H-bottomHudMargin-157*hudScale;
      const color=playerColors[p.i];
      const localKillFlash=p.i===myIndex&&now<killHudFlashUntil;
      const flashElapsed=localKillFlash?Math.max(0,now-killHudFlashStart):0;
      const localKillScoreFx=p.i===myIndex&&now>=killScoreFxStart&&now<killScoreFxUntil;
      const scoreFxElapsed=localKillScoreFx?Math.max(0,now-killScoreFxStart):0;
      const localCrashScoreFx=p.i===myIndex&&now>=crashScoreFxStart&&now<crashScoreFxUntil;
      const crashFxElapsed=localCrashScoreFx?Math.max(0,now-crashScoreFxStart):0;
      const panel=images[p.i===0?'pantA':p.i===1?'pantB':p.i===2?'pantC':'pantD'];
      const cpuAmmoFlash=huntCpuAmmo&&now<huntFxUntil&&huntCpuIndices.includes(Number(p.i));
      if(cpuAmmoFlash){
        const age=Math.max(0,now-huntFxStart);
        const envelope=clamp(1-age/2200,0,1);
        const pulse=.55+.45*(.5+.5*Math.sin(age*.024));
        ctx.save();
        ctx.shadowColor='rgba(255,230,70,.98)';
        ctx.shadowBlur=(20+34*pulse)*hudScale;
        ctx.globalAlpha=1;
        drawImageSafely(panel,px,py,panelW,panelH);
        ctx.globalCompositeOperation='screen';
        ctx.globalAlpha=(.18+.30*pulse)*envelope;
        drawImageSafely(panel,px,py,panelW,panelH);
        ctx.restore();
      }else if(localKillFlash){
        const flash=1-flashElapsed/450;
        ctx.save();
        ctx.shadowColor=color;
        ctx.shadowBlur=34*flash*hudScale;
        ctx.globalAlpha=1;
        drawImageSafely(panel,px,py,panelW,panelH);
        ctx.globalCompositeOperation='screen';
        ctx.globalAlpha=.32*flash;
        drawImageSafely(panel,px,py,panelW,panelH);
        ctx.restore();
      }else{
        drawImageSafely(panel,px,py,panelW,panelH);
      }
      const rightHud=p.i===1||p.i===3;
      const nameX=rightHud?px+panelW-4*hudScale:px+4*hudScale;
      ctx.font=HUD_NAME_FONT;ctx.fillStyle=color;ctx.textAlign=rightHud?'right':'left';ctx.textBaseline='top';let alpha=1;if(leader===p.i)alpha=.62+.38*(.5+.5*Math.sin(now*.0042));ctx.globalAlpha=alpha;ctx.fillText(hudPlayerName(p),nameX,py+157*hudScale);ctx.globalAlpha=1;
      const tx=px+(left?50:46)*hudScale;ctx.textAlign='left';ctx.fillStyle=color;if(isMobile)ctx.font=HUD_VALUE_FONT;ctx.fillText(hudAmmoText(p),tx,py+15*hudScale);ctx.fillText(hudSpeedText(p),tx,py+80*hudScale);
      if(cpuAmmoFlash&&huntCpuBonus>0){
        const age=Math.max(0,now-huntFxStart);
        const t=clamp(age/2200,0,1);
        const pop=Math.sin(Math.min(1,t*2.2)*Math.PI);
        ctx.save();
        ctx.translate(tx+(isMobile?54:42)*hudScale,py+15*hudScale);
        ctx.scale(1+.55*pop,1+.55*pop);
        ctx.textAlign='left';
        ctx.textBaseline='alphabetic';
        ctx.font=isMobile?`900 ${24*HUD_SCALE}px Arial Black,Arial,sans-serif`:`900 ${19*HUD_SCALE}px Arial Black,Arial,sans-serif`;
        ctx.fillStyle='#ffe64a';
        ctx.strokeStyle='rgba(0,0,0,.9)';
        ctx.lineWidth=4*HUD_SCALE;
        ctx.shadowColor='rgba(255,230,70,.95)';
        ctx.shadowBlur=18*HUD_SCALE*(1-t);
        const bonusText='+'+huntCpuBonus;
        ctx.strokeText(bonusText,0,0);
        ctx.fillText(bonusText,0,0);
        ctx.restore();
      }
      let displayedKills=Number(p.k)||0;
      if(p.i===myIndex&&killScorePendingValue!==null){
        if(now<killScoreFxStart){
          displayedKills=killScoreHeldValue===null?displayedKills:killScoreHeldValue;
        }else{
          // El nuevo valor aparece justo al comenzar el escalado del marcador.
          displayedKills=killScorePendingValue;
          if(now>=killScoreFxUntil){
            killScoreHeldValue=null;
            killScorePendingValue=null;
          }
        }
      }
      if(p.i===myIndex&&crashScorePendingValue!==null){
        if(now<crashScoreFxStart){
          // Mientras se ve PENALIZACION -1, el HUD conserva el valor anterior.
          displayedKills=crashScoreHeldValue===null?displayedKills:crashScoreHeldValue;
        }else{
          // La resta aparece exactamente cuando comienza el efecto del HUD.
          displayedKills=crashScorePendingValue;
          if(now>=crashScoreFxUntil){
            crashScoreHeldValue=null;
            crashScorePendingValue=null;
          }
        }
      }
      const killText=hudKillText(p,state.scoreToWin,displayedKills);
      if(localCrashScoreFx){
        // Explosion local del contador cuando una colision propia resta una baja.
        // El nuevo valor ya viene del servidor; aqui solo reforzamos visualmente
        // la penalizacion sin alterar puntuacion, fisica ni red.
        const duration=950;
        const t=clamp(crashFxElapsed/duration,0,1);
        const envelope=1-t;
        const burst=Math.sin(Math.min(1,t*2.4)*Math.PI);
        const kx=tx,ky=py+115*hudScale;
        const shake=envelope*5*hudScale;
        const sx=Math.sin(crashFxElapsed*.12)*shake;
        const sy=Math.cos(crashFxElapsed*.10)*shake*.55;
        ctx.save();
        ctx.translate(kx+sx,ky+sy);
        const scoreScale=1+0.72*burst*envelope;
        ctx.scale(scoreScale,scoreScale);
        ctx.shadowColor='rgba(255,70,20,.95)';
        ctx.shadowBlur=(18+42*envelope)*hudScale;
        ctx.fillStyle='#ff5b2d';
        ctx.globalAlpha=.75+.25*envelope;
        ctx.fillText(killText,0,0);
        ctx.restore();

        // Onda expansiva y chispas alrededor del contador.
        ctx.save();
        ctx.translate(kx,ky+7*hudScale);
        ctx.globalAlpha=Math.max(0,envelope);
        ctx.strokeStyle='#ff7a2f';
        ctx.lineWidth=3*hudScale;
        ctx.shadowColor='rgba(255,80,20,.9)';
        ctx.shadowBlur=14*hudScale*envelope;
        ctx.beginPath();
        ctx.arc(0,0,(10+42*t)*hudScale,0,Math.PI*2);
        ctx.stroke();
        for(let n=0;n<12;n++){
          const a=(Math.PI*2*n/12)+0.18;
          const inner=(12+28*t)*hudScale;
          const outer=(24+58*t)*hudScale;
          ctx.beginPath();
          ctx.moveTo(Math.cos(a)*inner,Math.sin(a)*inner);
          ctx.lineTo(Math.cos(a)*outer,Math.sin(a)*outer);
          ctx.stroke();
        }
        ctx.restore();
      }else if(localKillScoreFx){
        // Dos segundos despues de la baja, el marcador hace un efecto muy
        // evidente: entrada rapida, gran escala, dos pulsos y brillo fuerte.
        // La animacion completa dura dos segundos.
        const t=clamp(scoreFxElapsed/2000,0,1);
        const intro=clamp(scoreFxElapsed/160,0,1);
        const after=clamp((scoreFxElapsed-160)/1840,0,1);
        const introEase=1-Math.pow(1-intro,3);
        // V16.4.6: pop mucho mas exagerado. El numero entra pequeno y salta
        // hasta unas 3 veces su tamano antes de asentarse con rebotes visibles.
        let scale=.42+2.58*introEase;
        if(scoreFxElapsed>=160){
          const elastic=Math.exp(-after*4.1)*(0.55+0.45*Math.cos(after*18));
          scale=1+2.0*elastic;
        }
        const pulse=.5+.5*Math.sin(scoreFxElapsed*.018);
        const envelope=1-t;
        const kx=tx,ky=py+115*hudScale;
        ctx.save();
        ctx.translate(kx,ky);
        ctx.scale(scale,scale);
        ctx.shadowColor=color;
        ctx.shadowBlur=(34+74*envelope*(.55+.45*pulse))*hudScale;
        ctx.fillStyle=color;
        ctx.globalAlpha=.94+.06*pulse;
        ctx.fillText(killText,0,0);
        ctx.restore();

        // Anillo expansivo adicional para remarcar el momento exacto del cambio.
        if(scoreFxElapsed<720){
          const rt=clamp(scoreFxElapsed/720,0,1);
          ctx.save();
          ctx.translate(kx,ky+7*hudScale);
          ctx.globalAlpha=(1-rt)*.72;
          ctx.strokeStyle=color;
          ctx.lineWidth=3*hudScale;
          ctx.shadowColor=color;
          ctx.shadowBlur=22*hudScale*(1-rt);
          ctx.beginPath();
          ctx.arc(0,0,(12+58*rt)*hudScale,0,Math.PI*2);
          ctx.stroke();
          ctx.restore();
        }
      }else{
        ctx.fillText(killText,tx,py+115*hudScale);
      }
      ctx.fillStyle='#be0000';ctx.fillRect(tx,py+53*hudScale,Math.max(0,(30-p.cad)*2.3*hudScale),7*hudScale);ctx.fillRect(tx,py+105*hudScale,67*clamp((p.spd-1),0,1)*hudScale,7*hudScale);
    }
  }
  function clamp(v,a,b){return Math.max(a,Math.min(b,v));}

  function centerNoticeY(kind,now,defaultY){
    const active=[];
    if(brutalFxUntil&&now<brutalFxUntil)active.push('brutal');
    if(weaponTheftFxUntil&&now<weaponTheftFxUntil&&weaponTheftIndex>=0)active.push('theft');
    if(huntFxUntil&&now<huntFxUntil&&huntText)active.push('hunt');
    if(invisibleNoticeUntil&&now<invisibleNoticeUntil&&invisibleNoticeIndex>=0)active.push('ghost');
    if(active.length<=1)return defaultY;
    const order=['hunt','brutal','theft','ghost'].filter(k=>active.includes(k));
    const idx=order.indexOf(kind);
    if(idx<0)return defaultY;
    if(order.length===2)return [H*.34,H*.57][idx]||defaultY;
    if(order.length===3)return [H*.28,H*.48,H*.68][idx]||defaultY;
    return [H*.23,H*.39,H*.55,H*.71][idx]||defaultY;
  }

  function drawPenaltyAnnouncement(now){
    if(!penaltyMessageUntil||now>=penaltyMessageUntil)return;
    const remaining=penaltyMessageUntil-now;
    const age=2000-remaining;
    const fadeIn=clamp(age/180,0,1);
    const fadeOut=clamp(remaining/320,0,1);
    const alpha=Math.min(fadeIn,fadeOut);
    const pulse=.94+.06*Math.sin(age*.012);
    ctx.save();
    try{
      ctx.translate(W/2,105);
      ctx.scale(pulse,pulse);
      ctx.font=isMobile?'34px Flashback,Arial':'26px Flashback,Arial';
      ctx.textAlign='center';
      ctx.textBaseline='middle';
      ctx.globalAlpha=alpha;
      ctx.fillStyle='#ff6a32';
      ctx.strokeStyle='rgba(0,0,0,.82)';
      ctx.lineWidth=5;
      ctx.shadowColor='rgba(255,70,20,.9)';
      ctx.shadowBlur=14;
      const text=tr('penalty');
      ctx.strokeText(text,0,0);
      ctx.fillText(text,0,0);
    }finally{
      ctx.restore();
    }
  }

  function drawBrutalAnnouncement(now){
    if(!brutalFxUntil||now>=brutalFxUntil)return;
    const age=now-brutalFxStart;
    const total=1650;
    const t=clamp(age/total,0,1);
    const fadeIn=clamp(age/120,0,1);
    const fadeOut=clamp((total-age)/320,0,1);
    const alpha=Math.min(fadeIn,fadeOut);
    const intro=clamp(age/180,0,1);
    const introEase=1-Math.pow(1-intro,3);
    const wobble=Math.sin(age*.035)*Math.max(0,1-t)*.055;
    const scale=(.28+1.72*introEase)*(1+wobble);
    const y=centerNoticeY('brutal',now,H*.43)-Math.min(32,age*.025);
    ctx.save();
    try{
      ctx.translate(W/2,y);
      ctx.rotate(Math.sin(age*.025)*.025*(1-t));
      ctx.scale(scale,scale);
      ctx.textAlign='center';
      ctx.textBaseline='middle';
      ctx.font=isMobile?'900 72px Arial Black,Arial,sans-serif':'900 64px Arial Black,Arial,sans-serif';
      // BRUTAL conserva el fade de entrada/salida, pero nunca llega a ser
      // completamente opaco para que no tape la accion.
      ctx.globalAlpha=alpha*.82;
      ctx.lineWidth=10;
      ctx.strokeStyle='rgba(0,0,0,.86)';
      ctx.shadowColor='rgba(255,85,20,.95)';
      ctx.shadowBlur=34+28*(1-t);
      ctx.fillStyle='#ffdb35';
      ctx.strokeText(tr('brutal'),0,0);
      ctx.fillText(tr('brutal'),0,0);
      if(brutalDistance>0){
        ctx.shadowBlur=10;
        ctx.font=isMobile?'800 24px Arial,Helvetica,sans-serif':'800 20px Arial,Helvetica,sans-serif';
        ctx.fillStyle='#ffffff';
        // Escala fisica del juego: diametro de colision de nave = 48 px = 8 m.
        ctx.fillText(brutalDistanceText,0,58);
        if(brutalShooter){
          ctx.font=isMobile?'800 20px Arial,Helvetica,sans-serif':'800 17px Arial,Helvetica,sans-serif';
          ctx.fillStyle='#ffdb35';
          ctx.fillText(brutalShooter,0,84);
        }
      }
    }finally{ctx.restore();}
  }

  function drawWeaponTheftAnnouncement(now){
    if(!weaponTheftFxUntil||now>=weaponTheftFxUntil||weaponTheftIndex<0)return;
    const age=now-weaponTheftFxStart,total=2000;
    const remaining=Math.max(0,total-age);
    const fadeIn=clamp(age/120,0,1);
    const fadeOut=clamp(remaining/300,0,1);
    const alpha=Math.min(fadeIn,fadeOut);
    const intro=clamp(age/170,0,1);
    const introEase=1-Math.pow(1-intro,3);
    const settle=1+Math.sin(Math.min(1,age/520)*Math.PI)*.10;
    const scale=(.62+.38*introEase)*settle;
    const color=playerColors[Math.max(0,Math.min(3,Number(weaponTheftIndex)||0))]||'#fff';
    const y=centerNoticeY('theft',now,H*.52)-Math.min(18,age*.012);
    ctx.save();
    try{
      ctx.translate(W/2,y);
      ctx.scale(scale,scale);
      ctx.textAlign='center';
      ctx.textBaseline='middle';
      ctx.globalAlpha=alpha*.64;
      // Usa la tipografia propia del juego y un tamano mas contenido para que
      // el aviso acompane a la accion sin dominar la pantalla.
      ctx.font=isMobile?'36px Flashback,Arial':'28px Flashback,Arial';
      ctx.lineWidth=isMobile?5:4;
      ctx.strokeStyle='rgba(0,0,0,.68)';
      ctx.shadowColor=color;
      ctx.shadowBlur=14*(1-Math.min(1,age/900));
      ctx.fillStyle=color;
      const text=tr('weaponTheft');
      ctx.strokeText(text,0,0);
      ctx.fillText(text,0,0);
    }finally{ctx.restore();}
  }

  function drawHuntAnnouncement(now){
    if(!huntFxUntil||now>=huntFxUntil||!huntText)return;
    const age=now-huntFxStart,total=2200;
    const fadeIn=clamp(age/180,0,1),fadeOut=clamp((total-age)/420,0,1);
    const alpha=Math.min(fadeIn,fadeOut);
    const pulse=1+Math.sin(age*.018)*.05;
    ctx.save();
    try{
      ctx.translate(W/2,centerNoticeY('hunt',now,H*.37));
      ctx.scale(pulse,pulse);
      ctx.textAlign='center';ctx.textBaseline='middle';
      ctx.globalAlpha=alpha*.9;
      ctx.font=isMobile?'900 54px Arial Black,Arial,sans-serif':'900 46px Arial Black,Arial,sans-serif';
      ctx.lineWidth=8;ctx.strokeStyle='rgba(0,0,0,.9)';
      ctx.shadowColor='rgba(255,45,45,.95)';ctx.shadowBlur=28;
      ctx.fillStyle='#ff4b4b';
      ctx.strokeText(huntText,0,0);ctx.fillText(huntText,0,0);
      if(huntCpuAmmo){
        ctx.font=isMobile?'900 30px Arial Black,Arial,sans-serif':'900 25px Arial Black,Arial,sans-serif';
        ctx.lineWidth=6;
        ctx.shadowBlur=18;
        ctx.fillStyle='#ffe64a';
        ctx.strokeText('BALAS PARA CPU',0,isMobile?58:50);
        ctx.fillText('BALAS PARA CPU',0,isMobile?58:50);
      }
    }finally{ctx.restore();}
  }

  function drawLeaderAnnouncement(now){
    if(!leaderAnnouncement)return;
    if(now>=leaderAnnouncement.until){leaderAnnouncement=null;return;}
    const color=playerColors[leaderAnnouncement.i]||'#fff';
    ctx.save();
    try{
      ctx.font=isMobile?'44px Flashback,Arial':'34px Flashback,Arial';
      ctx.textAlign='center';
      ctx.textBaseline='middle';
      ctx.fillStyle=color;
      ctx.shadowColor='rgba(0,0,0,.9)';
      ctx.shadowBlur=7;
      ctx.lineWidth=4;
      ctx.strokeStyle='rgba(0,0,0,.78)';
      const text=tr('leader',{name:leaderAnnouncement.name});
      ctx.strokeText(text,W/2,145);
      ctx.fillText(text,W/2,145);
    }finally{
      ctx.restore();
    }
  }
  function hexToRgb(hex){
    const v=String(hex||'').trim();
    const m=/^#([0-9a-f]{6})$/i.exec(v);
    if(!m)return {r:215,g:182,b:255};
    const n=parseInt(m[1],16);
    return {r:(n>>16)&255,g:(n>>8)&255,b:n&255};
  }
  function drawInvisibleModeNotice(now){
    if(!state||!Array.isArray(state.players)||invisibleNoticeIndex<0||now>=invisibleNoticeUntil)return;
    const p=state.players.find(q=>Number(q.i)===Number(invisibleNoticeIndex));
    if(!p)return;
    const remaining=Math.max(0,invisibleNoticeUntil-now);
    const fadeIn=Math.min(1,(2000-remaining)/180);
    const fadeOut=Math.min(1,remaining/380);
    const alpha=.58*Math.min(fadeIn,fadeOut);
    const color=playerColors[Number(p.i)]||'#d8a7ff';
    const name=hudPlayerName(p).toUpperCase();
    ctx.save();
    try{
      ctx.textAlign='center';
      ctx.textBaseline='middle';
      ctx.font=isMobile?'44px Flashback,Arial':'36px Flashback,Arial';
      ctx.fillStyle=color;
      ctx.globalAlpha=alpha;
      ctx.shadowColor=color;
      ctx.shadowBlur=isMobile?14:10;
      ctx.fillText(name+' · FANTASMA',W/2,centerNoticeY('ghost',now,275));
    }finally{
      ctx.restore();
    }
  }

  function drawGhostStatus(now){
    if(!state||!Array.isArray(state.players))return;
    const fontSize=isMobile?27:21;
    const pillH=isMobile?40:32;
    const pillW=isMobile?170:138;
    const hudScale=HUD_SCALE;
    const panelW=HUD_PANEL_W;
    const sideGap=isMobile?14:12;
    const bottomHudMargin=isMobile?45:36;

    ctx.save();
    try{
      ctx.font=`800 ${fontSize}px Arial,Helvetica,sans-serif`;
      ctx.textAlign='center';
      ctx.textBaseline='middle';
      ctx.globalAlpha=1;
      ctx.shadowColor='transparent';
      ctx.shadowBlur=0;

      for(const p of state.players){
        if(!(Number(p&&p.camo)>0))continue;
        const left=p.i%2===0;
        const top=p.i<2;
        const panelX=left?10:W-10-panelW;
        const panelY=top?5:H-bottomHudMargin-157*hudScale;
        const x=left?panelX+panelW+sideGap+pillW/2:panelX-sideGap-pillW/2;
        const y=panelY+pillH/2+6;
        const wave=.5+.5*Math.sin(now*.0045+(p.i||0)*.9);
        const styleStep=Math.max(0,Math.min(15,Math.round(wave*15)));
        ctx.fillStyle=(ghostFillStyles[p.i]||ghostFillStyles[0])[styleStep];
        ctx.strokeStyle=(ghostBorderStyles[p.i]||ghostBorderStyles[0])[styleStep];
        ctx.lineWidth=2;
        ctx.beginPath();
        if(typeof ctx.roundRect==='function')ctx.roundRect(x-pillW/2,y-pillH/2,pillW,pillH,pillH/2);
        else ctx.rect(x-pillW/2,y-pillH/2,pillW,pillH);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle='#000';
        ctx.fillText(tr('ghost'),x,y+1);
      }
    }finally{ctx.restore();}
  }

  function drawMobileControlLabels(){
    if(!isMobile||!inGame)return;
    ctx.save();
    try{
      ctx.font='800 34px Arial,Helvetica,sans-serif';
      ctx.textAlign='center';
      ctx.textBaseline='middle';
      ctx.globalAlpha=1;
      ctx.shadowColor='transparent';
      ctx.shadowBlur=0;
      ctx.fillStyle='rgba(255,255,255,0.20)';
      if(mobileThrust)ctx.fillText(tr('thrustControl'),W/2,H-72);
      else if(mobileFire)ctx.fillText(tr('fireControl'),W/2,H-72);
      else ctx.fillText(tr('mobileTouchGuide'),W/2,H-72);
    }finally{
      ctx.restore();
    }
  }
  function drawMobileExitControl(){
    if(!isMobile||!inGame)return;
    const x=W/2,y=68;
    ctx.save();
    try{
      // V16.4.5: el boton visible vive en el canvas, en la capa baja.
      // La zona HTML sigue encima pero es invisible y solo sirve para pulsarlo.
      // V16.4.52: boton SALIR mas grande y visible en movil.
      // V16.4.53: pastilla mas transparente, texto blanco opaco y algo mas abajo.
      // V16.4.54: se baja un poco mas y la zona tactil se alinea con el dibujo.
      // Usamos alpha real en cada color para evitar que Safari multiplique
      // transparencias y lo deje demasiado apagado.
      ctx.globalAlpha=1;
      ctx.font='800 19px Arial,Helvetica,sans-serif';
      ctx.textAlign='center';
      ctx.textBaseline='middle';
      ctx.lineWidth=1.7;
      ctx.strokeStyle='rgba(255,255,255,.58)';
      ctx.fillStyle='rgba(5,7,15,.46)';
      const bw=108,bh=42,r=9;
      ctx.beginPath();
      ctx.roundRect(x-bw/2,y-bh/2,bw,bh,r);
      ctx.fill();ctx.stroke();
      ctx.fillStyle='#ffffff';
      ctx.fillText(tr('exit'),x,y+1);
    }finally{ctx.restore();}
  }
  function drawMobileVoiceControl(){
    if(!isMobile||!inGame||!voice||!voice.enabled||voice.cpuMode)return;
    let x=W/2,y=H-96;
    const buttonMode=mobileControlMode==='buttons'&&!mobileKeyboardActive;
    // La zona tactil del PTT se mueve con CSS. Convertimos su centro real a
    // coordenadas logicas del canvas para que el icono quede justo bajo el dedo.
    if(voicePttEl&&!voicePttEl.classList.contains('hidden')){
      const pr=voicePttEl.getBoundingClientRect();
      const cr=canvas.getBoundingClientRect();
      if(pr.width>0&&pr.height>0&&cr.width>0&&cr.height>0){
        x=((pr.left+pr.width*.5-cr.left)/cr.width)*W;
        y=((pr.top+pr.height*.5-cr.top)/cr.height)*H;
      }
    }
    const talking=!!voice.talking;
    const scale=buttonMode?.72:1;
    const radius=38*scale;
    ctx.save();
    try{
      // El control visual se pinta en el canvas, justo encima del fondo.
      // Las naves, meteoritos, balas y mejoras se dibujan despues y por tanto
      // siempre pasan por encima del icono.
      ctx.globalAlpha=talking?.56:.28;
      ctx.fillStyle=talking?'rgba(95,255,150,.76)':'rgba(255,255,255,.46)';
      ctx.strokeStyle=talking?'rgba(150,255,188,.94)':'rgba(255,255,255,.58)';
      ctx.lineWidth=3.5*scale;
      ctx.beginPath();ctx.arc(x,y,radius,0,Math.PI*2);ctx.fill();ctx.stroke();

      ctx.globalAlpha=talking?.82:.56;
      ctx.strokeStyle='#ffffff';
      ctx.fillStyle='#ffffff';
      ctx.lineWidth=4.5*scale;
      ctx.lineCap='round';ctx.lineJoin='round';
      // Capsula del microfono.
      ctx.beginPath();
      ctx.roundRect(x-10*scale,y-20*scale,20*scale,31*scale,10*scale);
      ctx.fill();
      // Arco inferior, pie y base.
      ctx.beginPath();
      ctx.arc(x,y-3*scale,17*scale,0,Math.PI,false);
      ctx.stroke();
      ctx.beginPath();ctx.moveTo(x,y+15*scale);ctx.lineTo(x,y+25*scale);ctx.stroke();
      ctx.beginPath();ctx.moveTo(x-10*scale,y+25*scale);ctx.lineTo(x+10*scale,y+25*scale);ctx.stroke();
    }finally{
      ctx.restore();
    }
  }
  function render(rafNow){
    requestAnimationFrame(render);
    const now=Number.isFinite(rafNow)?rafNow:performance.now();
    sampleDisplayRefresh(now);
    flushPendingState(false,now);
    pumpControls(now);
    if(localCpuActive&&localCpu)localCpu.advance(now);
    if(hostPhysics&&isHost)hostPhysics.advance(now);
    // Fisica y controles siguen ejecutandose en todos los RAF. Solo el pintado
    // usa un divisor entero para conservar un frame pacing regular.
    renderCadenceTick++;
    if(renderDivisor>1&&(renderCadenceTick%renderDivisor)!==0)return;
    lastPaintAt=now;
    if(perfStats){
      if(perfStats.lastPaint){
        const dt=now-perfStats.lastPaint;perfStats.lastFrame=dt;perfStats.frames++;
        if(dt>25)perfStats.longFrames++;
        if(dt>perfStats.maxFrame)perfStats.maxFrame=dt;
      }
      perfStats.lastPaint=now;
      if(now-perfStats.windowStart>=5000){
        const seconds=(now-perfStats.windowStart)/1000;
        perfStats.report={fps:seconds>0?perfStats.frames/seconds:0,long:perfStats.longFrames,max:perfStats.maxFrame,frame:perfStats.lastFrame,parse:perfStats.parseCount?perfStats.parseMs/perfStats.parseCount:0,localErr:perfStats.localErrMax};
        perfStats.windowStart=now;perfStats.frames=0;perfStats.longFrames=0;perfStats.maxFrame=0;perfStats.parseMs=0;perfStats.parseCount=0;perfStats.localErrMax=0;
      }
    }
    ctx.setTransform(1,0,0,1,0,0);
    ctx.globalAlpha=1;
    ctx.filter='none';
    ctx.shadowColor='rgba(0,0,0,0)';
    ctx.shadowBlur=0;
    ctx.shadowOffsetX=0;
    ctx.shadowOffsetY=0;
    if(useStaticPcBackground){
      // PC: el fondo vive debajo del canvas. Solo borramos los objetos del
      // frame anterior; no volvemos a transferir/copyar 1920x1080 de fondo.
      ctx.globalCompositeOperation='source-over';
      ctx.clearRect(0,0,canvas.width,canvas.height);
    }else{
      // Movil mantiene la ruta opaca/cacheada que ya va fluida.
      ctx.globalCompositeOperation='copy';
      if(backgroundCache&&backgroundCacheW===canvas.width&&backgroundCacheH===canvas.height){
        ctx.drawImage(backgroundCache,0,0,canvas.width,canvas.height);
      }else{
        ctx.fillStyle='#020714';ctx.fillRect(0,0,canvas.width,canvas.height);
      }
      ctx.globalCompositeOperation='source-over';
    }
    ctx.setTransform(renderScale,0,0,renderScale,0,0);
    if(!useStaticPcBackground&&!backgroundCache&&!drawImageSafely(images.bg,0,0,W,H)){
      ctx.fillStyle='#020714';ctx.fillRect(0,0,W,H);
    }
    if(!state)return;

    const nowSec=now/1000;
    const blend=interpolationAlpha(now);
    const prev=previousState||state;
    localizedTargetOwners.fill(-1);
    for(const p of state.players||[]){
      if(p&&p.mira===true){
        const target=Number(p.mt),owner=Number(p.i);
        if(Number.isInteger(target)&&target>=0&&target<localizedTargetOwners.length&&Number.isInteger(owner)){
          localizedTargetOwners[target]=owner;
        }
      }
    }
    for(const b of state.bullets||[]){
      if(b&&b.g===true){
        const target=Number(b.gt),owner=Number(b.o);
        if(Number.isInteger(target)&&target>=0&&target<localizedTargetOwners.length&&Number.isInteger(owner)){
          localizedTargetOwners[target]=owner;
        }
      }
    }

    // Capa de controles visuales movil: despues del fondo y antes de cualquier
    // objeto de juego, asi todos los elementos de la partida pasan por encima.
    drawMobileControlLabels();
    drawMobileExitControl();
    drawMobileVoiceControl();

    // Los avisos FANTASMA y BRUTAL viven en la capa baja: siguen visibles,
    // pero meteoritos, asteroides, naves, balas y mejoras pasan por encima.
    drawGhostStatus(now);
    drawBrutalAnnouncement(now);

    for(const a of state.asteroids){
      const old=previousLookup.asteroids.get(a.id);
      const x=old?lerp(old.x,a.x,blend):a.x;
      const y=old?lerp(old.y,a.y,blend):a.y;
      drawImageCentered(images[ASTEROID_IMAGE_KEYS[a.type]]||images.asteroid1,x,y,a.type===5?60:90);
    }
    for(const pk of state.pickups){
      const old=previousLookup.pickups.get(pk.id);
      drawPickup(pk,old?lerp(old.x,pk.x,blend):pk.x,old?lerp(old.y,pk.y,blend):pk.y,nowSec);
    }
    for(const m of state.meteors){
      const old=previousLookup.meteors.get(m.id);
      const x=old?lerp(old.x,m.x,blend):m.x;
      const y=old?lerp(old.y,m.y,blend):m.y;
      const angle=old?lerpAngle(old.a,m.a,blend):m.a;
      drawImageCentered(images[ASTEROID_IMAGE_KEYS[m.type]]||images.asteroid1,x,y,METEOR_DRAW_SIZES[m.type]||25,angle);
    }
    if(state.giant){
      const old=prev.giant;
      drawImageCentered(images.giant,old?lerp(old.x,state.giant.x,blend):state.giant.x,old?lerp(old.y,state.giant.y,blend):state.giant.y,270,0,1);
    }

    // Las balas ya traen velocidad: una extrapolacion muy corta evita el efecto
    // de avance a saltos sin alterar nunca la posicion autoritativa del servidor.
    const age=Math.min(.05,Math.max(0,(now-lastStateTime)/1000));
    for(const b of state.bullets){
      const x=b.x+b.vx*age,y=b.y+b.vy*age;
      const sp=Math.hypot(b.vx,b.vy)||1;
      if(b.g){
        const rocketKey=ROCKET_IMAGE_KEYS[Math.max(0,Math.min(3,Number(b.o)||0))]||ROCKET_IMAGE_KEYS[0];
        const rocketIm=imageReady(images[rocketKey])?images[rocketKey]:images.coete;
        if(imageReady(rocketIm)){
          const bulletRot=(Math.atan2(-b.vx,-b.vy)*180/Math.PI+360)%360;
          drawImageCentered(rocketIm,x,y,42,-bulletRot,1);
          continue;
        }
      }
      ctx.strokeStyle=b.g?'#ff3b48':'#50ff78';ctx.lineWidth=b.g?4:3;ctx.beginPath();ctx.moveTo(x-b.vx/sp*(b.g?15:12),y-b.vy/sp*(b.g?15:12));ctx.lineTo(x,y);ctx.stroke();
    }
    for(const p of state.players){
      const old=previousLookup.players.get(p.i);
      drawShip(p,old,blend,now);
    }
    if(impactFX)impactFX.draw(ctx,now);
    drawHud(now);
    drawPenaltyAnnouncement(now);
    drawLeaderAnnouncement(now);
    drawWeaponTheftAnnouncement(now);
    drawHuntAnnouncement(now);
    drawInvisibleModeNotice(now);
    if(state.shower>0){
      const pulse=.58+.42*(.5+.5*Math.sin(now*.005));
      ctx.save();
      ctx.globalAlpha=pulse;
      ctx.font=isMobile?'38px Flashback,Arial':'28px Flashback,Arial';
      ctx.textAlign='center';
      ctx.fillStyle='rgb(255,170,70)';
      ctx.shadowColor='rgba(255,135,35,.65)';
      ctx.shadowBlur=8+5*(1-pulse);
      ctx.fillText(tr('meteorShower'),W/2,185);
      ctx.restore();
    }
    if(perfStats){
      const r=perfStats.report;
      ctx.save();
      ctx.setTransform(1,0,0,1,0,0);
      ctx.globalCompositeOperation='source-over';
      ctx.globalAlpha=.82;
      ctx.fillStyle='rgba(0,0,0,.68)';ctx.fillRect(8,8,278,58);
      ctx.globalAlpha=1;ctx.fillStyle='#8dffb0';ctx.font='12px Arial,Helvetica,sans-serif';ctx.textAlign='left';ctx.textBaseline='top';
      ctx.fillText(`FPS ${r.fps.toFixed(0)}  FRAME ${r.frame.toFixed(1)}ms  MAX ${r.max.toFixed(1)}ms`,16,16);
      ctx.fillText(`>25ms ${r.long}/5s  JSON ${r.parse.toFixed(2)}ms  ERR ${r.localErr.toFixed(1)}px`,16,36);
      ctx.restore();
    }
  }
  window.addEventListener('galaxy-languagechange',()=>{
    updateAudioButton();
    renderPublicRooms();
    updateLobbyStartButton(startBtn&&!startBtn.disabled);
    updateCpuFillButton(cpuFillEnabled);
    if(menu&&!menu.classList.contains('hidden')){
      if(ws&&ws.readyState===WebSocket.OPEN)statusEl.textContent=tr('serverReady');
      else wakeStatus();
    }
  });
  connect();render();
})();

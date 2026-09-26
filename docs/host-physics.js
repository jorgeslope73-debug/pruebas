'use strict';
(() => {
  const W=1920,H=1080,TICK_HZ=60,DT=1/TICK_HZ,STEP_MS=1000/TICK_HZ;
  const DRAG_PER_TICK=Math.pow(0.35,DT);
  const IDLE_CONTROL=Object.freeze({turn:0,thrust:false,fire:false});
  const SCORE_TO_WIN=5;
  const SHIP_RADIUS=24,ASTEROID_RADIUS=45,GIANT_RADIUS=135,PICKUP_RADIUS=22,BULLET_RADIUS=4,SMALL_METEOR_RADIUS=14;
  const SPAWN_PROTECTION_SECONDS=3,BRUTAL_SHOT_DISTANCE=850;
  const ASTEROID_STARTS=[
    [160,430,300,1],[30,930,10,3],[1800,30,210,4],
    [1500,150,160,2],[500,430,160,5],[1300,430,200,6]
  ];
  let nextEntityId=1;
  const uid=()=>nextEntityId++;
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const rand=(a,b)=>a+Math.random()*(b-a);
  const randint=(a,b)=>Math.floor(rand(a,b+1));
  const dist2=(a,b)=>{const dx=a.x-b.x,dy=a.y-b.y;return dx*dx+dy*dy;};
  const circles=(a,ar,b,br)=>{const rr=ar+br;return dist2(a,b)<=rr*rr;};
  // Colision continua barata: trabaja con distancias al cuadrado, evita sqrt y
  // descarta primero por la caja del segmento. Solo añade una division cuando
  // el movimiento realmente puede cruzar el radio de colision.
  const prevX=o=>Number.isFinite(o&&o.px)?o.px:o.x;
  const prevY=o=>Number.isFinite(o&&o.py)?o.py:o.y;
  const wrapDelta=(d,size)=>d>size*.5?d-size:(d<-size*.5?d+size:d);
  const sweptCircles=(a,ar,b,br,wrap=false)=>{
    const rr=ar+br,rr2=rr*rr;
    const ax1=a.x,ay1=a.y,bx1=b.x,by1=b.y;
    const ax0=prevX(a),ay0=prevY(a),bx0=prevX(b),by0=prevY(b);
    let r0x,r0y,r1x,r1y;
    if(wrap){
      r0x=wrapDelta(bx0-ax0,W);r0y=wrapDelta(by0-ay0,H);
      const raw1x=wrapDelta(bx1-ax1,W),raw1y=wrapDelta(by1-ay1,H);
      r1x=r0x+wrapDelta(raw1x-r0x,W);r1y=r0y+wrapDelta(raw1y-r0y,H);
    }else{
      // Si alguno acaba de atravesar un borde con wrap, no trazamos una linea
      // gigante por toda la arena: en ese unico tick usamos el solape final.
      if(Math.abs(ax1-ax0)>W*.5||Math.abs(ay1-ay0)>H*.5||Math.abs(bx1-bx0)>W*.5||Math.abs(by1-by0)>H*.5)return circles(a,ar,b,br);
      r0x=bx0-ax0;r0y=by0-ay0;r1x=bx1-ax1;r1y=by1-ay1;
    }
    if(r1x*r1x+r1y*r1y<=rr2||r0x*r0x+r0y*r0y<=rr2)return true;
    if((r0x>rr&&r1x>rr)||(r0x<-rr&&r1x<-rr)||(r0y>rr&&r1y>rr)||(r0y<-rr&&r1y<-rr))return false;
    const vx=r1x-r0x,vy=r1y-r0y,vv=vx*vx+vy*vy;
    if(vv<=1e-9)return false;
    const t=-(r0x*vx+r0y*vy)/vv;
    if(t<=0||t>=1)return false;
    const cx=r0x+vx*t,cy=r0y+vy*t;
    return cx*cx+cy*cy<=rr2;
  };
  const dirFromRot=rot=>{const r=rot*Math.PI/180;return{x:-Math.sin(r),y:-Math.cos(r)};};
  const normalize=(x,y)=>{const l=Math.hypot(x,y)||1;return{x:x/l,y:y/l};};
  const round1=v=>Math.round(v*10)/10,round2=v=>Math.round(v*100)/100,round3=v=>Math.round(v*1000)/1000;
  // Si la inercia actual ya atraviesa un pickup, la CPU deja de acelerar y
  // entra recta por deslizamiento. Solo se cancela si hay un obstaculo peligroso
  // dentro de ese corredor antes de llegar al objeto.
  const pickupRunThroughPlan=(cpu,pk,asteroids,meteors,giant,players)=>{
    if(!cpu||!pk)return null;
    const dx=pk.x-cpu.x,dy=pk.y-cpu.y,d2=dx*dx+dy*dy;
    if(d2<1)return{clear:true,aligned:true,x:pk.x,y:pk.y};
    const distance=Math.sqrt(d2),ux=dx/distance,uy=dy/distance;
    const vx=Number(cpu.vx)||0,vy=Number(cpu.vy)||0,speed2=vx*vx+vy*vy,speed=Math.sqrt(speed2);
    // El punto de mira queda detras del pickup para obligar a atravesarlo.
    // A mayor velocidad, mayor margen de salida para que no empiece a girar antes de recogerlo.
    const overshoot=95+Math.min(95,speed*.24);
    const tx=pk.x+ux*overshoot,ty=pk.y+uy*overshoot;
    const sx=tx-cpu.x,sy=ty-cpu.y,seg2=sx*sx+sy*sy||1;
    const hazard=(h,r)=>{
      if(!h)return false;
      const hx=h.x-cpu.x,hy=h.y-cpu.y;
      const t=(hx*sx+hy*sy)/seg2;
      if(t<=0||t>=1)return false;
      const cx=hx-sx*t,cy=hy-sy*t;
      const rr=SHIP_RADIUS+r+12;
      return cx*cx+cy*cy<=rr*rr;
    };
    for(const a of asteroids)if(hazard(a,a.r||ASTEROID_RADIUS))return{clear:false,aligned:false,x:pk.x,y:pk.y};
    for(const m of meteors)if(hazard(m,m.r||SMALL_METEOR_RADIUS))return{clear:false,aligned:false,x:pk.x,y:pk.y};
    if(giant&&hazard(giant,giant.r||GIANT_RADIUS))return{clear:false,aligned:false,x:pk.x,y:pk.y};
    for(const p of players){
      if(!p||p===cpu||p.dead)continue;
      if(hazard(p,SHIP_RADIUS))return{clear:false,aligned:false,x:pk.x,y:pk.y};
    }
    let aligned=false;
    if(speed2>30*30){
      const vux=vx/speed,vuy=vy/speed,along=dx*vux+dy*vuy;
      const capture=SHIP_RADIUS+PICKUP_RADIUS-5;
      const lateral2=Math.max(0,d2-along*along);
      aligned=along>0&&lateral2<=capture*capture;
    }
    return{clear:true,aligned,x:tx,y:ty};
  };
  const safeName=(v,fallback='JUGADOR')=>{
    const s=String(v||'').replace(/[\x00-\x1f\x7f]/g,'').trim().slice(0,16);
    return s||fallback;
  };
  function spawnArea(index){
    const left=index%2===0,top=index<2;
    const panelX=left?10:W-216,panelY=top?5:H-190,centerX=panelX+64,gap=90,spreadY=100;
    const nearY=top?panelY+153+28+SHIP_RADIUS+gap:panelY-SHIP_RADIUS-gap;
    return{
      minX:Math.max(SHIP_RADIUS+12,centerX-28),
      maxX:Math.min(W-SHIP_RADIUS-12,centerX+28),
      minY:top?nearY:nearY-spreadY,
      maxY:top?nearY+spreadY:nearY,
      rot:left?270:90
    };
  }

  class GalaxyHostPhysics{
    constructor({onState,onEvent,code='P2P',rankRound=1,rankHostToken=''}={}){
      this.onState=typeof onState==='function'?onState:()=>{};
      this.onEvent=typeof onEvent==='function'?onEvent:()=>{};
      this.code=String(code||'P2P');
      this.rankRound=Math.max(1,Number(rankRound)||1);
      this.rankHostToken=String(rankHostToken||'');
      this.rankReportSent=false;
      this.rankReportAttempts=0;
      this.players=[];
      this.controls=new Map();
      this.started=false;
      this.finished=false;
      this.winner=null;
      this.difficulty='medio';
      this.huntTargetIndex=-1;
      this.huntUntil=0;
      this.huntStartsAt=0;
      this.huntThresholdActive=false;
      this.seq=0;
      this.fxClock=0;
      this.fxSeq=0;
      this.fxEvents=[];
      this.fxLastHit=new Map();
      this.bullets=[];
      this.pickups=[];
      this.meteors=[];
      this.giant=null;
      this.asteroids=[];
      this.nextPickup=1;
      this.firstShower=rand(120,180);
      this.showerLeft=0;
      this.nextMeteor=0;
      this.nextShower=0;
      this.noDeathTime=0;
      this.nextGiant=rand(50,80);
      this.lastNow=0;
      this.accumulator=0;
      this.tickCount=0;
      this.resetAsteroids();
    }
    emit(msg){try{this.onEvent(msg);}catch(_){}}
    resetAsteroids(){
      this.asteroids=ASTEROID_STARTS.map(([x,y,rot,type])=>{
        const d=dirFromRot(rot);
        return{id:uid(),x,y,rot,type,vx:d.x*80,vy:d.y*80,r:ASTEROID_RADIUS};
      });
    }
    makePlayer(index,name,cpu){
      return{
        index,name:safeName(name,cpu?'CPU':'JUGADOR '+(index+1)),cpu,
        x:0,y:0,rot:0,vx:0,vy:0,thrust:false,
        bullets:5,cadence:30,speed:1,kills:0,deaths:0,
        reload:0,shield:0,camo:0,protection:SPAWN_PROTECTION_SECONDS,
        guided:false,guidedTarget:-1,
        dead:false,respawn:0,lastControlAt:Date.now(),lastSpawn:null,
        difficulty:this.difficulty
      };
    }
    start(playerList=[]){
      const list=(Array.isArray(playerList)?playerList:[]).filter(p=>p&&Number.isInteger(Number(p.i))).slice(0,4);
      if(list.length<2)return false;
      this.players=[];
      this.controls.clear();
      this.seq=0;this.fxClock=0;this.fxSeq=0;this.fxEvents=[];this.fxLastHit.clear();
      this.bullets=[];this.pickups=[];this.meteors=[];this.giant=null;
      this.nextPickup=1;this.firstShower=rand(120,180);this.showerLeft=0;this.nextMeteor=0;this.nextShower=0;
      this.noDeathTime=0;this.nextGiant=rand(50,80);
      this.rankReportSent=false;this.rankReportAttempts=0;
      this.huntTargetIndex=-1;this.huntUntil=0;this.huntStartsAt=0;this.huntThresholdActive=false;
      this.resetAsteroids();
      for(const item of list){
        const index=Number(item.i),isCpu=!!item.cpu;
        const player=this.makePlayer(index,item.n||(isCpu?'CPU '+(index+1):'JUGADOR '+(index+1)),isCpu);
        if(isCpu)player.difficulty='dificil';
        this.placeAtSpawn(player);
        this.players.push(player);
        this.controls.set(index,{turn:0,thrust:false,fire:false});
      }
      this.players.sort((a,b)=>a.index-b.index);
      this.started=true;this.finished=false;this.winner=null;
      this.lastNow=0;this.accumulator=0;this.tickCount=0;
      return true;
    }
    stop(){this.started=false;this.lastNow=0;this.accumulator=0;}
    setControl(index,turn,thrust,fire){
      const i=Number(index),p=this.players.find(x=>x.index===i);
      if(!p)return false;
      this.controls.set(i,{turn:clamp(Number(turn)||0,-1,1),thrust:!!thrust,fire:!!fire});
      p.lastControlAt=Date.now();
      return true;
    }
    syncRoster(playerList=[]){
      const list=(Array.isArray(playerList)?playerList:[]).filter(x=>x&&Number.isInteger(Number(x.i))).slice(0,4);
      let changed=false;
      for(const item of list){
        const index=Number(item.i),isCpu=!!item.cpu;
        let p=this.players.find(x=>x.index===index);
        if(!p){
          p=this.makePlayer(index,item.n||(isCpu?'CPU '+(index+1):'JUGADOR '+(index+1)),isCpu);
          if(isCpu)p.difficulty='dificil';
          this.placeAtSpawn(p);this.players.push(p);this.controls.set(index,{turn:0,thrust:false,fire:false});changed=true;continue;
        }
        const wasCpu=!!p.cpu;
        const nextName=safeName(item.n||(isCpu?'CPU '+(index+1):'JUGADOR '+(index+1)),isCpu?'CPU':'JUGADOR '+(index+1));
        if(wasCpu!==isCpu||p.name!==nextName){
          p.cpu=isCpu;p.name=nextName;p.difficulty=isCpu?'dificil':this.difficulty;
          p.lastControlAt=Date.now();this.controls.set(index,{turn:0,thrust:false,fire:false});
          if(wasCpu&&!isCpu){
            this.bullets=this.bullets.filter(b=>b.owner!==index);
            p.bullets=5;p.cadence=30;p.speed=1;p.kills=0;p.deaths=0;p.reload=0;p.guided=false;p.guidedTarget=-1;
            p.shield=0;p.camo=0;p.protection=SPAWN_PROTECTION_SECONDS;p.dead=false;p.respawn=0;
            p.vx=0;p.vy=0;p.lastSpawn=null;this.placeAtSpawn(p);
          }
          changed=true;
        }
      }
      this.players.sort((a,b)=>a.index-b.index);
      if(changed)this.onState(this.publicState());
      return changed;
    }
    handleMessage(msg){
      if(!msg||typeof msg!=='object')return true;
      if(msg.t==='ctrl'){this.setControl(msg.i,msg.turn,msg.thrust,msg.fire);return true;}
      if(msg.t==='restart'){
        if(this.restart()){
          this.emit({t:'restarted'});
          this.onState(this.publicState());
        }
        return true;
      }
      if(msg.t==='leave'){this.stop();return true;}
      return true;
    }
    advance(now){
      if(!this.started||this.finished)return;
      if(!Number.isFinite(now))now=performance.now();
      if(!this.lastNow){this.lastNow=now;return;}
      let elapsed=now-this.lastNow;this.lastNow=now;
      if(!Number.isFinite(elapsed)||elapsed<0)elapsed=STEP_MS;
      this.accumulator+=Math.min(100,elapsed);
      let steps=0,publishState=false;
      while(this.accumulator>=STEP_MS&&steps<5){
        this.update(DT);
        this.accumulator-=STEP_MS;
        this.tickCount++;
        if((this.tickCount&1)===0||this.finished)publishState=true;
        steps++;
        if(this.finished)break;
      }
      if(steps===5&&this.accumulator>=STEP_MS)this.accumulator%=STEP_MS;
      // Si el navegador llega tarde podemos recuperar varios ticks de fisica
      // en esta llamada. Construir un snapshot por cada tick recuperado creaba
      // arrays/objetos temporales justo cuando el frame ya iba retrasado.
      // Publicamos solo el estado final mas reciente.
      if(publishState)this.onState(this.publicState());
    }
    restart(){
      if(!this.finished||this.players.length<2)return false;
      this.started=false;this.finished=false;this.winner=null;this.seq=0;this.rankReportSent=false;
      this.fxClock=0;this.fxSeq=0;this.fxEvents=[];this.fxLastHit.clear();
      this.bullets=[];this.pickups=[];this.meteors=[];this.giant=null;
      this.nextPickup=1;this.firstShower=rand(120,180);this.showerLeft=0;this.nextMeteor=0;this.nextShower=0;
      this.noDeathTime=0;this.nextGiant=rand(50,80);
      this.huntTargetIndex=-1;this.huntUntil=0;this.huntStartsAt=0;this.huntThresholdActive=false;
      this.resetAsteroids();
      for(const p of this.players)p.dead=true;
      for(const p of this.players){
        p.bullets=5;p.cadence=30;p.speed=1;p.kills=0;p.deaths=0;p.reload=0;p.guided=false;p.guidedTarget=-1;
        p.shield=0;p.camo=0;p.protection=SPAWN_PROTECTION_SECONDS;p.respawn=0;
        p.lastControlAt=Date.now();p.lastSpawn=null;
        this.controls.set(p.index,{turn:0,thrust:false,fire:false});
        this.placeAtSpawn(p);p.dead=false;
      }
      this.started=true;this.lastNow=0;this.accumulator=0;this.tickCount=0;
      this.rankRound=Math.max(1,Number(this.rankRound)||1)+1;
      return true;
    }
    reportRankedVictory(winnerIndex){
      if(this.rankReportSent||this.code==='LOCAL')return;
      const base=String((window.GALAXY_CONFIG&&window.GALAXY_CONFIG.serverUrl)||'').replace(/\/$/,'');
      if(!base||!this.rankHostToken)return;
      this.rankReportSent=true;
      this.rankReportAttempts++;
      const retry=()=>{
        if(this.rankReportAttempts>=3)return;
        this.rankReportSent=false;
        setTimeout(()=>{
          if(this.finished&&Number(this.winner)===Number(winnerIndex))this.reportRankedVictory(winnerIndex);
        },1200*this.rankReportAttempts);
      };
      try{
        fetch(base+'/api/rank-result',{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({
            roomCode:this.code,
            winnerIndex:Number(winnerIndex),
            rankRound:this.rankRound,
            hostToken:this.rankHostToken
          }),
          cache:'no-store',keepalive:true
        }).then(res=>{
          if(!res.ok)throw new Error('HTTP '+res.status);
          return res.json().catch(()=>({ok:true}));
        }).catch(err=>{
          console.warn('[Galaxy Combat] No se pudo registrar el resultado:',err&&err.message||err);
          retry();
        });
      }catch(err){
        console.warn('[Galaxy Combat] Error enviando resultado:',err&&err.message||err);
        retry();
      }
    }
    emitShipImpact(player,source=null,destroyed=false){
      if(!player||!Number.isFinite(player.x)||!Number.isFinite(player.y))return;
      if(player.dead&&!destroyed)return;
      if(!destroyed){
        const last=this.fxLastHit.get(player.index);
        if(last!==undefined&&this.fxClock-last<0.18)return;
        this.fxLastHit.set(player.index,this.fxClock);
      }
      let x=player.x,y=player.y;
      if(!destroyed&&source&&Number.isFinite(source.x)&&Number.isFinite(source.y)){
        const n=normalize(source.x-x,source.y-y);x+=n.x*SHIP_RADIUS;y+=n.y*SHIP_RADIUS;
      }
      this.fxEvents.push({
        id:++this.fxSeq,i:player.index,x:+x.toFixed(1),y:+y.toFixed(1),
        kind:destroyed?'explosion':'hit',hidden:!destroyed&&player.camo>0,at:this.fxClock
      });
      if(this.fxEvents.length>32)this.fxEvents.splice(0,this.fxEvents.length-32);
    }
    emitExplosionAt(x,y,ownerIndex=0){
      if(!Number.isFinite(x)||!Number.isFinite(y))return;
      const i=Number.isInteger(ownerIndex)&&ownerIndex>=0&&ownerIndex<4?ownerIndex:0;
      this.fxEvents.push({
        id:++this.fxSeq,i,x:+x.toFixed(1),y:+y.toFixed(1),
        kind:'explosion',hidden:false,at:this.fxClock
      });
      if(this.fxEvents.length>32)this.fxEvents.splice(0,this.fxEvents.length-32);
    }
    destroyShip(victim,attacker=null,weaponTheft=false,scorePenalty=false){
      if(victim.dead||this.finished)return;
      if(victim.protection>0||victim.shield>0){this.emitShipImpact(victim,attacker,false);return;}
      victim.dead=true;victim.respawn=.7;victim.vx=victim.vy=0;victim.deaths++;
      // Estrellarse, autodestruirse o morir por disparo/misil resta una baja.
      // La puntuacion nunca baja de cero; el cliente ya muestra PENALIZACION -1.
      if(!attacker||attacker===victim||scorePenalty)victim.kills=Math.max(0,victim.kills-1);

      // ROBO DE ARMAMENTO solo ocurre por EMBESTIDA: un jugador con
      // escudo activo choca fisicamente con un rival sin escudo y lo destruye.
      // Las bajas por bala o misil nunca roban armamento aunque el tirador
      // lleve escudo.
      if(weaponTheft&&attacker&&attacker!==victim&&attacker.shield>0){
        const stolenAmmo=Math.max(0,Math.floor(Number(victim.bullets)||0));
        attacker.bullets+=stolenAmmo;
        if(Number(victim.cadence)<Number(attacker.cadence))attacker.cadence=victim.cadence;
        if(Number(victim.speed)>Number(attacker.speed))attacker.speed=victim.speed;
        if(Number(victim.camo)>Number(attacker.camo))attacker.camo=victim.camo;
        if(victim.guided&&!attacker.guided){
          attacker.guided=true;
          attacker.guidedTarget=this.guidedTargetFor(attacker);
        }
        this.emit({t:'weapon-theft',index:attacker.index,name:attacker.name,ammo:stolenAmmo});
      }

      victim.bullets=0;victim.cadence=30;victim.speed=1;victim.shield=0;victim.camo=0;victim.reload=0;victim.guided=false;victim.guidedTarget=-1;
      this.noDeathTime=0;this.emitShipImpact(victim,null,true);this.emit({t:'sound',kind:'impact'});
      if(attacker&&attacker!==victim){
        attacker.kills++;
        if(attacker.kills>=SCORE_TO_WIN){
          this.finished=true;this.winner=attacker.index;
          this.emit({t:'victory',winner:this.winner});
          this.reportRankedVictory(this.winner);
        }
      }
    }
    placeAtSpawn(p){
      const area=spawnArea(p.index);
      const obstacles=this.asteroids.map(a=>({x:a.x,y:a.y,r:a.r}));
      for(const m of this.meteors)obstacles.push({x:m.x,y:m.y,r:SMALL_METEOR_RADIUS});
      if(this.giant)obstacles.push({x:this.giant.x,y:this.giant.y,r:GIANT_RADIUS});
      for(const other of this.players)if(other.index!==p.index&&!other.dead)obstacles.push({x:other.x,y:other.y,r:SHIP_RADIUS});
      let best=null,bestScore=-Infinity;
      for(let attempt=0;attempt<24;attempt++){
        const candidate={x:rand(area.minX,area.maxX),y:rand(area.minY,area.maxY)};
        let clearance=Infinity;
        for(const o of obstacles)clearance=Math.min(clearance,Math.hypot(candidate.x-o.x,candidate.y-o.y)-SHIP_RADIUS-o.r-12);
        const tooSimilar=p.lastSpawn&&dist2(candidate,p.lastSpawn)<28*28;
        const score=(clearance>=0?10000:0)+Math.min(1000,clearance)-(tooSimilar?1000:0);
        if(score>bestScore){best=candidate;bestScore=score;}
        if(clearance>=0&&!tooSimilar){best=candidate;break;}
      }
      p.x=best.x;p.y=best.y;p.px=p.x;p.py=p.y;p.rot=area.rot;p.vx=0;p.vy=0;p.lastSpawn={x:p.x,y:p.y};
    }
    respawnPlayer(p){
      this.placeAtSpawn(p);p.dead=false;p.respawn=0;p.protection=SPAWN_PROTECTION_SECONDS;
      p.bullets=1;p.cadence=30;p.speed=1;p.shield=0;p.camo=0;p.reload=Math.max(.5,p.cadence/8);p.guided=false;p.guidedTarget=-1;
    }
    guidedTargetFor(p){
      if(!p||p.dead)return -1;
      const forward=dirFromRot(p.rot);
      // La mira puede revelar FANTASMAS solo dentro de un cono frontal de 60
      // grados (aprox. +/-30). Los rivales visibles conservan el comportamiento
      // anterior y pueden ser elegidos aunque esten fuera de ese cono.
      const ghostMinAlign=.8660254038;
      let bestIndex=-1,bestAlign=-2,bestDistance=Infinity;
      for(const target of this.players){
        if(!target||target.index===p.index||target.dead)continue;
        const dx=target.x-p.x,dy=target.y-p.y,distance=Math.hypot(dx,dy);
        if(distance<1)continue;
        const align=(forward.x*dx+forward.y*dy)/distance;
        if(target.camo>0&&align<ghostMinAlign)continue;
        if(align>bestAlign+1e-6||(Math.abs(align-bestAlign)<=1e-6&&distance<bestDistance)){
          bestAlign=align;bestDistance=distance;bestIndex=target.index;
        }
      }
      return bestIndex;
    }
    chooseCpuControls(cpu){
      let rival=null,best=Infinity;
      if(cpu.dead)return IDLE_CONTROL;
      const huntGrace=this.huntThresholdActive&&this.fxClock<this.huntStartsAt;
      if(this.huntThresholdActive&&this.fxClock>=this.huntStartsAt){
        const target=this.players.find(p=>p.index===this.huntTargetIndex&&!p.cpu&&!p.dead&&p.camo<=0);
        if(target)rival=target;
      }
      if(!rival){
        for(const p of this.players){
          if(p.index===cpu.index||p.dead||p.camo>0)continue;
          if(huntGrace&&p.index===this.huntTargetIndex)continue;
          const d=dist2(cpu,p);
          if(d<best){best=d;rival=p;}
        }
      }
      if(!rival)return IDLE_CONTROL;
      const huntActive=this.huntThresholdActive&&this.fxClock>=this.huntStartsAt&&rival.index===this.huntTargetIndex;
      const dx=rival.x-cpu.x,dy=rival.y-cpu.y,distance=Math.hypot(dx,dy);
      const targetRot=(Math.atan2(-dx,-dy)*180/Math.PI+360)%360;
      let err=((targetRot-cpu.rot+540)%360)-180;
      let desiredX=rival.x,desiredY=rival.y,seekPickup=null,defensiveNoAmmo=false,ramming=false;
      const rivalShielded=rival.shield>0||rival.protection>0,rivalDangerous=rival.shield>0;
      if(cpu.bullets===0){
        let bestAmmoScore=Infinity,bestAmmoDistance=Infinity,seekPickupRivalDistance=Infinity;
        for(const pk of this.pickups){
          const isAmmo=pk.type.startsWith('ammo');
          const isHardSight=cpu.difficulty==='dificil'&&pk.type==='mira'&&!cpu.guided;
          if(!isAmmo&&!isHardSight)continue;
          const cpuDistance=Math.sqrt(dist2(cpu,pk)),rivalDistance=Math.sqrt(dist2(rival,pk));
          const danger=Math.max(0,900-rivalDistance),dangerWeight=cpu.shield>0?.45:1.35;
          // En dificil, MIRA cuenta incluso algo mas que una bala suelta:
          // rearma con 1 bala y deja preparado un misil teledirigido.
          const sightBonus=isHardSight?220:0;
          const score=cpuDistance+danger*dangerWeight-sightBonus;
          if(score<bestAmmoScore){bestAmmoScore=score;bestAmmoDistance=cpuDistance;seekPickupRivalDistance=rivalDistance;seekPickup=pk;}
        }
        const ammoDistance=seekPickup?bestAmmoDistance:Infinity;
        const canRam=cpu.shield>0&&!rivalShielded;
        const ramRange=cpu.difficulty==='dificil'?650:(cpu.difficulty==='medio'?520:420);
        const preferRam=canRam&&(!seekPickup||distance<ramRange||(cpu.difficulty==='dificil'&&distance<ammoDistance*.65));
        if(preferRam){seekPickup=null;ramming=true;desiredX=rival.x;desiredY=rival.y;}
        else if(seekPickup){
          defensiveNoAmmo=true;desiredX=seekPickup.x;desiredY=seekPickup.y;
          const cpuToPickup=Math.sqrt(dist2(cpu,seekPickup));
          if(cpu.shield<=0&&seekPickupRivalDistance<520&&cpuToPickup>120){
            const px=seekPickup.x-rival.x,py=seekPickup.y-rival.y,plen=Math.hypot(px,py)||1;
            const detour=Math.min(280,Math.max(80,520-seekPickupRivalDistance));
            desiredX+=px/plen*detour;desiredY+=py/plen*detour;
          }
          if(distance<800){
            const inv=1/(distance||1),flee=(800-distance)*(cpu.shield>0?.55:.95);
            desiredX+=(cpu.x-rival.x)*inv*flee;desiredY+=(cpu.y-rival.y)*inv*flee;
          }
        }else{
          defensiveNoAmmo=true;
          const inv=1/(distance||1),fleeDistance=950;
          desiredX=cpu.x+(cpu.x-rival.x)*inv*fleeDistance;desiredY=cpu.y+(cpu.y-rival.y)*inv*fleeDistance;
        }
      }else if(rivalDangerous){
        let bestD2=Infinity;
        for(const pk of this.pickups){
          if(pk.type!=='shield'&&!pk.type.startsWith('ammo'))continue;
          const d2=dist2(cpu,pk);if(d2<bestD2){bestD2=d2;seekPickup=pk;}
        }
        if(!seekPickup){desiredX=cpu.x-dx;desiredY=cpu.y-dy;}
      }else if(cpu.difficulty==='dificil'){
        const excellentShot=Math.abs(err)<5&&distance<850,closeFight=cpu.bullets>0&&distance<500;
        if(!excellentShot&&!closeFight){
          let bestScore=10;
          for(const pk of this.pickups){
            let value=0;
            if(pk.type==='mira'&&!cpu.guided)value=cpu.bullets<=1?125:105;
            else if(pk.type.startsWith('ammo'))value=cpu.bullets<=2?85:25;
            else if(pk.type==='cadence')value=cpu.cadence>=20?100:35;
            else if(pk.type==='speed')value=cpu.speed<2?55:10;
            else if(pk.type==='shield')value=cpu.shield<=0?95:20;
            const score=value-Math.sqrt(dist2(cpu,pk))*.06;
            if(score>bestScore){bestScore=score;seekPickup=pk;}
          }
        }
      }
      if(seekPickup&&!defensiveNoAmmo){desiredX=seekPickup.x;desiredY=seekPickup.y;}
      const pickupRun=seekPickup?pickupRunThroughPlan(cpu,seekPickup,this.asteroids,this.meteors,this.giant,this.players):null;
      if(pickupRun&&pickupRun.clear){desiredX=pickupRun.x;desiredY=pickupRun.y;}
      const ddx=desiredX-cpu.x,ddy=desiredY-cpu.y,dRot=(Math.atan2(-ddx,-ddy)*180/Math.PI+360)%360;
      err=((dRot-cpu.rot+540)%360)-180;
      let avoidX=0,avoidY=0;
      for(const h of this.asteroids){
        const hx=cpu.x-h.x,hy=cpu.y-h.y,d=Math.hypot(hx,hy),safe=(h.r||ASTEROID_RADIUS)+90;
        if(d<safe&&d>1){avoidX+=hx/d*(safe-d);avoidY+=hy/d*(safe-d);}
      }
      for(const h of this.meteors){
        const hx=cpu.x-h.x,hy=cpu.y-h.y,d=Math.hypot(hx,hy),safe=(h.r||30)+90;
        if(d<safe&&d>1){avoidX+=hx/d*(safe-d);avoidY+=hy/d*(safe-d);}
      }
      if(this.giant){
        const h=this.giant,hx=cpu.x-h.x,hy=cpu.y-h.y,d=Math.hypot(hx,hy),safe=(h.r||GIANT_RADIUS)+90;
        if(d<safe&&d>1){avoidX+=hx/d*(safe-d);avoidY+=hy/d*(safe-d);}
      }
      const avoidMag=Math.hypot(avoidX,avoidY);
      const pickupRunClear=!!(pickupRun&&pickupRun.clear);
      if(!pickupRunClear&&avoidMag>20){const ar=(Math.atan2(-avoidX,-avoidY)*180/Math.PI+360)%360;err=((ar-cpu.rot+540)%360)-180;}
      const turn=pickupRunClear&&pickupRun.aligned?0:clamp(err/38,-1,1);
      const thrust=pickupRunClear?true:!!(Math.abs(err)<60&&(seekPickup||defensiveNoAmmo||ramming||distance>280||avoidMag>20));
      const guidedReady=!!(cpu.guided&&Number.isInteger(cpu.guidedTarget)&&cpu.guidedTarget>=0);
      const fireArc=guidedReady&&cpu.difficulty==='dificil'?30:6;
      const fire=(huntActive||!rivalDangerous)&&!seekPickup&&cpu.bullets>0&&cpu.reload<=0&&Math.abs(err)<fireArc&&distance<1350;
      return{turn,thrust,fire};
    }
    update(dt){
      if(!this.started||this.finished)return;
      this.noDeathTime+=dt;this.fxClock+=dt;
      const cpuPlayers=this.players.filter(p=>p.cpu);
      let huntedHuman=null;
      for(const p of this.players){
        if(p.cpu||p.dead)continue;
        if(p.kills>=SCORE_TO_WIN-1&&p.kills<SCORE_TO_WIN){huntedHuman=p;break;}
      }
      const shouldHunt=!!(huntedHuman&&cpuPlayers.length);
      if(shouldHunt&&!this.huntThresholdActive){
        this.huntThresholdActive=true;this.huntTargetIndex=huntedHuman.index;this.huntStartsAt=this.fxClock+3;this.huntUntil=Infinity;
        const cpuIndices=[];
        for(const cpu of cpuPlayers){cpu.bullets+=3;cpuIndices.push(cpu.index);}
        this.emit({t:'hunt',name:huntedHuman.name,duration:0,graceMs:3000,cpuAmmo:true,cpuAmmoBonus:3,cpuIndices});
      }else if(!shouldHunt&&this.huntThresholdActive){
        this.huntThresholdActive=false;this.huntTargetIndex=-1;this.huntStartsAt=0;this.huntUntil=0;
      }
      let fxWrite=0;
      for(const e of this.fxEvents)if(this.fxClock-e.at<=.8)this.fxEvents[fxWrite++]=e;
      this.fxEvents.length=fxWrite;
      for(const p of this.players){
        p.protection=p.protection-dt>1e-9?p.protection-dt:0;
        p.shield=Math.max(0,p.shield-dt);p.camo=Math.max(0,p.camo-dt);p.reload=Math.max(0,p.reload-dt);
        if(p.dead){p.thrust=false;p.respawn-=dt;if(p.respawn<=0)this.respawnPlayer(p);continue;}
        p.px=p.x;p.py=p.y;
        const stored=this.controls.get(p.index)||IDLE_CONTROL;
        const c=p.cpu?this.chooseCpuControls(p):((Date.now()-(p.lastControlAt||0)<=300)?stored:IDLE_CONTROL);
        p.thrust=!!c.thrust;
        p.rot=(p.rot+c.turn*240*dt+360)%360;
        const d=dirFromRot(p.rot);
        if(c.thrust){p.vx+=d.x*(240*p.speed)*dt;p.vy+=d.y*(240*p.speed)*dt;}
        p.vx*=DRAG_PER_TICK;p.vy*=DRAG_PER_TICK;
        const vmax=330*p.speed,sp=Math.hypot(p.vx,p.vy);
        if(sp>vmax){p.vx=p.vx/sp*vmax;p.vy=p.vy/sp*vmax;}
        p.x=(p.x+p.vx*dt+W)%W;p.y=(p.y+p.vy*dt+H)%H;
        p.guidedTarget=p.guided?this.guidedTargetFor(p):-1;
        if(c.fire&&p.bullets>0&&p.reload<=0){
          const guided=!!p.guided,guidedTarget=guided?p.guidedTarget:-1;
          const projectileSpeed=guided?500:this.bulletSpeed(p);
          this.bullets.push({id:uid(),owner:p.index,x:p.x+d.x*35,y:p.y+d.y*35,vx:d.x*projectileSpeed,vy:d.y*projectileSpeed,age:0,travel:0,guided,target:guidedTarget});
          if(guided){p.guided=false;p.guidedTarget=-1;}
          p.bullets--;p.reload=Math.max(.5,p.cadence/8);this.emit({t:'sound',kind:'laser'});
        }
      }
      this.updateAsteroids(dt);this.updateBullets(dt);this.updatePickups(dt);this.updateShower(dt);this.updateMeteors(dt);this.updateGiant(dt);this.shipCollisions();
    }
    bulletSpeed(p){return p.cadence>=30?500:p.cadence>=20?750:p.cadence>=10?900:1000;}
    updateAsteroids(){
      for(const a of this.asteroids){
        a.px=a.x;a.py=a.y;a.x+=a.vx*DT;a.y+=a.vy*DT;
        if(a.x<-190&&a.vx<0)a.vx*=-1;else if(a.x>W+190&&a.vx>0)a.vx*=-1;
        if(a.y<-190&&a.vy<0)a.vy*=-1;else if(a.y>H+190&&a.vy>0)a.vy*=-1;
      }
      for(let i=0;i<this.asteroids.length;i++)for(let j=i+1;j<this.asteroids.length;j++){
        const a=this.asteroids[i],b=this.asteroids[j];
        if(circles(a,a.r,b,b.r)){
          const n=normalize(b.x-a.x,b.y-a.y),rel=(a.vx-b.vx)*n.x+(a.vy-b.vy)*n.y;
          if(rel>0){const an=a.vx*n.x+a.vy*n.y,bn=b.vx*n.x+b.vy*n.y;a.vx+=(bn-an)*n.x;a.vy+=(bn-an)*n.y;b.vx+=(an-bn)*n.x;b.vy+=(an-bn)*n.y;}
          a.x-=n.x*2;b.x+=n.x*2;a.y-=n.y*2;b.y+=n.y*2;
        }
      }
      for(let i=this.pickups.length-1;i>=0;i--){
        const pk=this.pickups[i];
        for(const a of this.asteroids)if(circles(a,a.r,pk,PICKUP_RADIUS)){this.pickups.splice(i,1);break;}
      }
    }
    updateBullets(dt){
      for(const b of this.bullets){
        b.px=b.x;b.py=b.y;
        if(b.guided&&Number.isInteger(b.target)){
          const target=this.players.find(p=>p.index===b.target&&!p.dead);
          if(target){
            const dx=target.x-b.x,dy=target.y-b.y,distance=Math.hypot(dx,dy),speed=Math.hypot(b.vx,b.vy)||1;
            if(distance>1){
              const desiredX=dx/distance,desiredY=dy/distance,currentX=b.vx/speed,currentY=b.vy/speed;
              const steer=Math.min(.09,3.2*dt);
              const n=normalize(currentX+(desiredX-currentX)*steer,currentY+(desiredY-currentY)*steer);
              b.vx=n.x*speed;b.vy=n.y*speed;
            }
          }
        }
        b.x+=b.vx*dt;b.y+=b.vy*dt;b.age+=dt;b.travel=(b.travel||0)+Math.hypot(b.vx,b.vy)*dt;
      }
      for(let i=this.bullets.length-1;i>=0;i--){
        const b=this.bullets[i];let remove=b.age>3||b.x<-20||b.y<-20||b.x>W+20||b.y>H+20;
        if(!remove){
          for(const p of this.players){
            // Las balas normales no dañan al tirador. El cohete guiado sí:
            // si su trayectoria regresa y alcanza a su dueño, aplica la misma
            // colision/daño que contra cualquier otra nave.
            if((p.index===b.owner&&!b.guided)||p.dead||p.protection>0)continue;
            if(sweptCircles(b,BULLET_RADIUS,p,SHIP_RADIUS,false)){
              const attacker=this.players.find(q=>q.index===b.owner)||null;
              if(p.shield<=0){
                const brutal=attacker&&attacker!==p&&(b.travel||0)>=BRUTAL_SHOT_DISTANCE;
                if(brutal)this.emit({t:'brutal',distance:Math.round(b.travel||0),shooter:attacker.name||('J'+(attacker.index+1)),shooterIndex:attacker.index});
                this.destroyShip(p,attacker,false,true);
              }else this.emitShipImpact(p,b,false);
              remove=true;break;
            }
          }
        }
        if(!remove)for(const a of this.asteroids){
          if(sweptCircles(b,BULLET_RADIUS,a,a.r,false)){
            if(b.guided){
              this.emitExplosionAt(b.x,b.y,b.owner);
              this.emit({t:'sound',kind:'impact'});
            }
            remove=true;break;
          }
        }
        if(!remove&&this.giant&&sweptCircles(b,BULLET_RADIUS,this.giant,GIANT_RADIUS,false)){
          if(b.guided)this.emitExplosionAt(b.x,b.y,b.owner);
          remove=true;this.emit({t:'sound',kind:'impact'});
        }
        if(!remove)for(let m=this.meteors.length-1;m>=0;m--){
          const meteor=this.meteors[m];
          if(sweptCircles(b,BULLET_RADIUS,meteor,SMALL_METEOR_RADIUS,false)){
            if(b.guided)this.emitExplosionAt(b.x,b.y,b.owner);
            this.meteors.splice(m,1);remove=true;this.emit({t:'sound',kind:'impact'});break;
          }
        }
        if(!remove)for(let p=this.pickups.length-1;p>=0;p--)if(sweptCircles(b,BULLET_RADIUS,this.pickups[p],PICKUP_RADIUS,false)){this.pickups.splice(p,1);remove=true;break;}
        if(remove)this.bullets.splice(i,1);
      }
    }
    updatePickups(dt){
      this.nextPickup-=dt;
      if(this.nextPickup<=0){
        let type;
        if(Math.random()<.50&&!this.pickups.some(pk=>pk.type==='mira'))type='mira';
        else{
          const roll=randint(1,28);
          if(roll<=7)type='ammo3';else if(roll<=16)type='ammo1';else if(roll<=19)type='cadence';else if(roll<=22)type='speed';else if(roll<=25)type='shield';else type='camo';
        }
        this.pickups.push({id:uid(),type,x:rand(100,W-100),y:rand(100,H-100),phase:rand(0,Math.PI*2)});
        if(this.pickups.length>5)this.pickups.shift();
        this.nextPickup=rand(2,5);
      }
      for(const pk of this.pickups)pk.phase+=dt*3;
      for(let i=this.pickups.length-1;i>=0;i--){
        const pk=this.pickups[i];let taken=false;
        for(const p of this.players){
          if(p.dead)continue;
          if(sweptCircles(pk,PICKUP_RADIUS,p,SHIP_RADIUS,false)){
            if(pk.type==='ammo3'){
              const hadBullets=p.bullets>0;
              p.bullets+=6;
              if(!hadBullets)p.reload=Math.max(p.reload,Math.max(.5,p.cadence/8));
            }else if(pk.type==='ammo1'){
              const hadBullets=p.bullets>0;
              p.bullets+=1;
              if(!hadBullets)p.reload=Math.max(p.reload,Math.max(.5,p.cadence/8));
            }
            else if(pk.type==='cadence')p.cadence=Math.max(1,p.cadence-10);
            else if(pk.type==='mira'){
              if(p.bullets<=0){
                p.bullets=1;
                p.reload=Math.max(p.reload,Math.max(.5,p.cadence/8));
              }
              p.guided=true;p.guidedTarget=this.guidedTargetFor(p);
            }
            else if(pk.type==='speed')p.speed=Math.min(2,p.speed+.5);
            else if(pk.type==='shield')p.shield=10;
            else if(pk.type==='camo')p.camo=10;
            this.emit({t:'sound',kind:'pickup'});taken=true;break;
          }
        }
        if(taken)this.pickups.splice(i,1);
      }
    }
    updateShower(dt){
      if(this.showerLeft<=0){
        this.firstShower-=dt;
        if(this.firstShower<=0){this.showerLeft=7;this.nextMeteor=0;this.firstShower=999999;}
        else if(this.nextShower>0){this.nextShower-=dt;if(this.nextShower<=0){this.showerLeft=7;this.nextMeteor=0;}}
      }
      if(this.showerLeft>0){
        this.showerLeft=Math.max(0,this.showerLeft-dt);this.nextMeteor-=dt;
        while(this.nextMeteor<=0&&this.showerLeft>0){
          const left=Math.random()<.5,vx=(left?1:-1)*rand(110,220),vy=rand(-55,55);
          this.meteors.push({id:uid(),type:randint(1,3),x:left?-40:W+40,y:rand(40,H-40),vx,vy,angle:rand(0,360)});
          this.nextMeteor+=rand(.28,.42);
        }
        if(this.showerLeft<=0)this.nextShower=rand(120,180);
      }
    }
    updateMeteors(dt){
      for(let i=this.meteors.length-1;i>=0;i--){
        const m=this.meteors[i];m.px=m.x;m.py=m.y;m.x+=m.vx*dt;m.y+=m.vy*dt;m.angle=(m.angle+120*dt)%360;
        for(const a of this.asteroids)if(circles(m,SMALL_METEOR_RADIUS,a,a.r)){const n=normalize(m.x-a.x,m.y-a.y),dot=m.vx*n.x+m.vy*n.y;if(dot<0){m.vx-=2*dot*n.x;m.vy-=2*dot*n.y;}m.x+=n.x*4;m.y+=n.y*4;}
        if(this.giant&&circles(m,SMALL_METEOR_RADIUS,this.giant,GIANT_RADIUS)){
          const g=this.giant,n=normalize(m.x-g.x,m.y-g.y),rvx=m.vx-g.vx,rvy=m.vy-g.vy,dot=rvx*n.x+rvy*n.y;
          if(dot<0){m.vx=g.vx+(rvx-2*dot*n.x);m.vy=g.vy+(rvy-2*dot*n.y);}
          const dx=m.x-g.x,dy=m.y-g.y,dist=Math.hypot(dx,dy)||1,overlap=SMALL_METEOR_RADIUS+GIANT_RADIUS-dist;
          if(overlap>0){m.x+=n.x*(overlap+2);m.y+=n.y*(overlap+2);}
        }
        for(let k=this.pickups.length-1;k>=0;k--)if(circles(m,SMALL_METEOR_RADIUS,this.pickups[k],PICKUP_RADIUS))this.pickups.splice(k,1);
        let removed=false;
        for(const p of this.players){
          if(!p.dead&&sweptCircles(m,SMALL_METEOR_RADIUS,p,SHIP_RADIUS,false)){
            if(p.shield>0){this.emitShipImpact(p,m,false);const n=normalize(m.x-p.x,m.y-p.y),dot=m.vx*n.x+m.vy*n.y;m.vx-=2*dot*n.x;m.vy-=2*dot*n.y;}
            else{this.destroyShip(p,null);this.meteors.splice(i,1);removed=true;}
            break;
          }
        }
        if(removed)continue;
        if(m.x<-100||m.x>W+100||m.y<-100||m.y>H+100)this.meteors.splice(i,1);
      }
    }
    updateGiant(dt){
      if(!this.giant){
        this.nextGiant-=dt;
        if(this.nextGiant<=0){
          const side=randint(0,3),speed=rand(42,52);let x,y,tx,ty;
          if(side===0){x=-180;y=rand(160,H-160);tx=W+180;ty=clamp(y+rand(-220,220),160,H-160);}
          else if(side===1){x=W+180;y=rand(160,H-160);tx=-180;ty=clamp(y+rand(-220,220),160,H-160);}
          else if(side===2){x=rand(180,W-180);y=-180;tx=clamp(x+rand(-300,300),180,W-180);ty=H+180;}
          else{x=rand(180,W-180);y=H+180;tx=clamp(x+rand(-300,300),180,W-180);ty=-180;}
          const n=normalize(tx-x,ty-y);this.giant={id:uid(),x,y,vx:n.x*speed,vy:n.y*speed,r:GIANT_RADIUS,entered:false};
        }
        return;
      }
      const g=this.giant;g.px=g.x;g.py=g.y;g.x+=g.vx*dt;g.y+=g.vy*dt;
      if(g.x>-GIANT_RADIUS&&g.x<W+GIANT_RADIUS&&g.y>-GIANT_RADIUS&&g.y<H+GIANT_RADIUS)g.entered=true;
      for(const p of this.players)if(!p.dead&&sweptCircles(g,GIANT_RADIUS,p,SHIP_RADIUS,false)){if(p.shield>0||p.protection>0){this.emitShipImpact(p,g,false);const n=normalize(p.x-g.x,p.y-g.y);p.vx=n.x*130;p.vy=n.y*130;p.x+=n.x*8;p.y+=n.y*8;}else this.destroyShip(p,null);}
      for(const a of this.asteroids)if(circles(g,GIANT_RADIUS,a,a.r)){const n=normalize(a.x-g.x,a.y-g.y);a.vx+=n.x*25;a.vy+=n.y*25;a.x+=n.x*5;a.y+=n.y*5;}
      for(let i=this.pickups.length-1;i>=0;i--)if(circles(g,GIANT_RADIUS,this.pickups[i],PICKUP_RADIUS))this.pickups.splice(i,1);
      if(g.entered&&(g.x<-350||g.x>W+350||g.y<-350||g.y>H+350)){this.giant=null;this.nextGiant=rand(130,190);}
    }
    shipCollisions(){
      for(const p of this.players){
        if(p.dead)continue;
        for(const a of this.asteroids)if(sweptCircles(p,SHIP_RADIUS,a,a.r,false)){if(p.shield>0){this.emitShipImpact(p,a,false);const n=normalize(p.x-a.x,p.y-a.y),dot=p.vx*n.x+p.vy*n.y;if(dot<0){p.vx-=1.85*dot*n.x;p.vy-=1.85*dot*n.y;}p.x+=n.x*5;p.y+=n.y*5;}else this.destroyShip(p,null);}
      }
      for(let i=0;i<this.players.length;i++)for(let j=i+1;j<this.players.length;j++){
        const a=this.players[i],b=this.players[j];if(a.dead||b.dead||!sweptCircles(a,SHIP_RADIUS,b,SHIP_RADIUS,true))continue;
        if(a.shield>0||a.protection>0)this.emitShipImpact(a,b,false);
        if(b.shield>0||b.protection>0)this.emitShipImpact(b,a,false);
        if(a.shield>0&&b.shield<=0)this.destroyShip(b,a,true);
        else if(b.shield>0&&a.shield<=0)this.destroyShip(a,b,true);
        else if(a.shield<=0&&b.shield<=0){this.destroyShip(a,null);this.destroyShip(b,null);}
        else{const n=normalize(wrapDelta(a.x-b.x,W),wrapDelta(a.y-b.y,H));a.vx=n.x*120;a.vy=n.y*120;b.vx=-n.x*120;b.vy=-n.y*120;}
      }
    }
    publicState(){
      return{
        t:'state',seq:++this.seq,code:this.code,mode:'p2p',started:this.started,finished:this.finished,winner:this.winner,
        w:W,h:H,scoreToWin:SCORE_TO_WIN,fxVersion:1,
        fx:this.fxEvents.map(e=>({id:e.id,i:e.i,x:e.x,y:e.y,kind:e.kind,hidden:e.hidden,age:Math.max(0,Math.round((this.fxClock-e.at)*1000))})),
        players:this.players.map(p=>({i:p.index,n:p.name,cpu:p.cpu,x:round1(p.x),y:round1(p.y),r:round1(p.rot),vx:round1(p.vx),vy:round1(p.vy),thrust:!!p.thrust,ammo:p.bullets,armed:!p.dead&&p.bullets>0&&p.reload<=0,cad:p.cadence,spd:p.speed,k:p.kills,d:p.deaths,shield:round2(p.shield),camo:round2(p.camo),prot:round2(p.protection),mira:!!p.guided,mt:Number.isInteger(p.guidedTarget)?p.guidedTarget:-1,dead:p.dead,respawn:round3(p.respawn)})),
        asteroids:this.asteroids.map(a=>({id:a.id,x:round1(a.x),y:round1(a.y),type:a.type})),
        bullets:this.bullets.map(b=>({id:b.id,o:b.owner,x:round1(b.x),y:round1(b.y),vx:round1(b.vx),vy:round1(b.vy),g:!!b.guided,gt:Number.isInteger(b.target)?b.target:-1})),
        pickups:this.pickups.map((p,idx)=>({id:p.id,type:p.type,x:round1(p.x),y:round1(p.y+Math.cos(p.phase)*3),expiresIn:(idx===0&&this.pickups.length>=5)?round2(Math.max(0,this.nextPickup)):null})),
        meteors:this.meteors.map(m=>({id:m.id,type:m.type,x:round1(m.x),y:round1(m.y),a:round1(m.angle)})),
        giant:this.giant?{x:round1(this.giant.x),y:round1(this.giant.y)}:null,
        shower:round2(this.showerLeft),
        nextShower:this.showerLeft>0?0:round1(Math.max(0,Math.min(this.firstShower,this.nextShower||999999)))
      };
    }
  }
  window.GalaxyHostPhysics=GalaxyHostPhysics;
})();
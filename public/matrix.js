(() => {
  const canvas=document.getElementById('matrixCanvas'),ctx=canvas.getContext('2d');
  // La telemetría va en su propio lienzo, que se borra en cada frame: el texto queda nítido y solo la lluvia deja estela.
  const textCanvas=document.getElementById('matrixText')||canvas,tctx=textCanvas.getContext('2d');
  const panel=document.getElementById('matrixMode');
  const motion=matchMedia('(prefers-reduced-motion: reduce)');
  let reduced=motion.matches;
  const exitButton=document.getElementById('matrixExit'),shell=document.querySelector('.shell');
  let previousFocus=null,previousOverflow='',previousInert=false;
  const glyphs='0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ¦:<>+=*#%&?';
  const mix32=n=>{n=Math.imul(n^(n>>>16),0x45d9f3b);n=Math.imul(n^(n>>>16),0x45d9f3b);return (n^(n>>>16))>>>0};
  function rainGlyph(col,j,now){
    // Independent cell clocks + mixed hash: never walk the alphabet/string sequentially.
    const tick=Math.floor(now/(105+((col.seed+j*13)%95)));
    return glyphs[mix32(col.seed^Math.imul(j+1,0x9e3779b1)^tick)%glyphs.length];
  }
  let columns=[],raf=0,running=false,last=0,telemetry=[],environment='CORE',state=null;

  function resize(){
    const dpr=Math.min(devicePixelRatio||1,2),w=innerWidth,h=innerHeight;
    for(const [c,x] of [[canvas,ctx],[textCanvas,tctx]]){c.width=w*dpr;c.height=h*dpr;c.style.width=w+'px';c.style.height=h+'px';x.setTransform(dpr,0,0,dpr,0,0);}
    // Sparse overlapping depths: roughly two thirds of the previous stream count.
    // Each stream gets its own phase, length and speed so the rain never moves as a grid.
    columns=[
      {spacing:6.83,size:15,alpha:.075,speed:18,chance:.90},
      {spacing:10.74,size:16,alpha:.18,speed:34,chance:.92},
      {spacing:21,size:17,alpha:.67,speed:70,chance:.99},
    ].flatMap((layer,depth)=>Array.from({length:Math.ceil(w/layer.spacing)},(_,i)=>{
      if(Math.random()>layer.chance)return null;
      return {
        x:i*layer.spacing+depth*3+(Math.random()-.5)*layer.spacing*.38,
        y:Math.random()*(h*1.8)-h*.4,
        speed:layer.speed+Math.random()*50,
        len:Math.max(9,Math.floor((h/layer.size)*(.18+Math.random()*.34))),
        alpha:layer.alpha+Math.random()*.14,size:layer.size,
        gap:layer.size*(1.02+Math.random()*.12),
        mutate:Math.random()*1.8,seed:(Math.random()*0xffffffff)>>>0,
      };
    }).filter(Boolean));
  }
  function realFragments(){
    if(!state)return [environment+'::AWAITING_SIGNAL'];
    const c=state.checks||{},parts=[
      environment+'::'+String(state.overall||'unknown').toUpperCase(),
      'WEB::'+String(c.web||'unknown').toUpperCase(),
      'API::'+String(c.api||'unknown').toUpperCase(),
      'DB::'+String(c.database||'unknown').toUpperCase(),
      'SCHEMA::'+String(c.schema||'unknown').toUpperCase(),
      'WORKER::'+String(c.worker||'unknown').toUpperCase(),
      'MEDIA::'+String(c.media||'unknown').toUpperCase(),
      'PWA::'+String(c.pwa||'unknown').toUpperCase(),
      state.latencyMs==null?'LATENCY::UNKNOWN':'LATENCY::'+state.latencyMs+'ms',
      'OBSERVED::'+(state.checkedAt||'UNKNOWN'),
    ];
    if(state.deployment?.version)parts.push('VERSION::'+state.deployment.version);
    if(state.deployment?.commit)parts.push('COMMIT::'+state.deployment.commit);
    return parts;
  }
  function seedTelemetry(preservePosition=false){
    const fragments=realFragments(),h=innerHeight;
    const lanes=columns.filter(c=>c.size===16);
    // Only a few lanes carry readable telemetry; the rest remains cinematic rain.
    const count=Math.min(fragments.length,Math.max(4,Math.floor(innerWidth/86)));
    const previous=preservePosition?telemetry:[];
    telemetry=Array.from({length:count},(_,i)=>{
      const col=lanes.length?lanes[Math.floor(i*lanes.length/count)]:columns[i%Math.max(columns.length,1)];
      const text=fragments[i%fragments.length],step=14,old=previous[i],tailLen=5;
      const animatedY=old?.y??Math.random()*Math.max(0,h-text.length*step);
      // A stopped stream must remain visible, including after a long animated session.
      const y=reduced?Math.max(0,Math.min(animatedY,Math.max(0,h-text.length*step))):animatedY;
      return {text,x:col?.x??i*42,y,
        alpha:.86+Math.random()*.10,speed:30+Math.random()*10,step,
        revealed:reduced?text.length:Math.min(old?.revealed??(1+Math.floor(Math.random()*text.length)),text.length),tailLen};
    });
  }
  const lookalikes={A:'4',E:'3',I:'1',L:'|',O:'0',S:'5',B:'8',G:'6',T:'7',Z:'2',P:'¶',C:'(',D:')',H:'#',X:'×',V:'\\/'};
  function telemetryGlyph(ch,index,now){
    if(reduced)return ch;
    const alt=lookalikes[ch.toUpperCase()];
    if(!alt)return ch;
    // Sustitución breve y poco frecuente: el texto debe leerse casi siempre.
    const phase=(Math.floor(now/140)+index*7)%31;
    return phase===0?alt:ch;
  }
  function draw(now){
    if(!running)return;
    const dt=Math.min((now-last||16)/1000,.1);last=now;
    // Velo de fósforo independiente de los fps: lo dibujado baja al 5 % en ~0.35 s (antes ~0.55 s a 25 fps).
    const veil=reduced?1:1-Math.exp(-8.5*dt);
    ctx.fillStyle='rgba(0,3,0,'+veil.toFixed(3)+')';ctx.fillRect(0,0,innerWidth,innerHeight);
    tctx.clearRect(0,0,innerWidth,innerHeight);
    ctx.textBaseline='top';
    columns.forEach(col=>{
      if(!reduced){col.y+=col.speed*dt;col.mutate+=dt}
      for(let j=0;j<col.len;j++){
        const y=col.y-j*col.gap;
        if(y<-col.size||y>innerHeight+col.size)continue;
        const fade=Math.pow(1-j/col.len,1.55),head=j===0;
        ctx.font=(head?'700 ':'400 ')+col.size+'px "Matrix Code NFI",ui-monospace,SFMono-Regular,Menlo,monospace';
        ctx.fillStyle=head?'rgba(215,255,221,'+(col.alpha*.92)+')':'rgba(48,238,82,'+(col.alpha*fade*.72)+')';
        ctx.shadowBlur=head?9:2;ctx.shadowColor='#39ff63';
        ctx.fillText(rainGlyph(col,j,now),col.x,y);
      }
      // Re-enter above the viewport at a random offset. No global cycle or synchronized reset.
      if(col.y-col.len*col.gap>innerHeight){
        col.y=-col.size-Math.random()*innerHeight*.65;
        col.speed=30+Math.random()*90;
        col.len=Math.max(9,Math.floor((innerHeight/col.size)*(.18+Math.random()*.34)));
      }
    });
    const g=tctx;g.textBaseline='top';
    telemetry.forEach(t=>{
      if(!reduced)t.revealed+=t.speed*dt/t.step;
      if(!reduced&&t.revealed>=t.text.length)t.y+=t.speed*dt;
      if(t.y>innerHeight+20){const f=realFragments();t.y=-t.text.length*t.step-Math.random()*80;t.text=f[(Math.random()*f.length)|0];t.revealed=1}
      // Cola nativa: unas pocas celdas por ENCIMA del inicio del mensaje (la parte que va detrás), nunca sobre sus letras.
      if(!reduced&&t.revealed>=t.text.length){
        g.font='400 14px "Matrix Code NFI",ui-monospace,SFMono-Regular,Menlo,monospace';
        for(let j=1;j<=t.tailLen;j++){
          const y=t.y-j*t.step;if(y<-t.step||y>innerHeight)continue;
          const fade=Math.pow(1-j/(t.tailLen+1),1.6);
          g.fillStyle='rgba(48,238,82,'+(t.alpha*fade*.5)+')';g.shadowColor='#39ff63';g.shadowBlur=2;
          g.fillText(glyphs[mix32(j*2654435761^Math.floor(now/160)^t.text.length)%glyphs.length],t.x,y);
        }
      }
      g.font='700 14px ui-monospace,SFMono-Regular,Menlo,monospace';
      g.shadowBlur=6;g.shadowColor='rgba(96,255,123,.45)';g.fillStyle='rgba(190,255,200,'+t.alpha+')';
      for(let i=0;i<Math.min(t.text.length,Math.floor(t.revealed));i++){
        const y=t.y+i*t.step;if(y<0||y>innerHeight)continue;
        g.fillText(telemetryGlyph(t.text[i],i,now),t.x,y);
      }
    });
    g.shadowBlur=0;
    ctx.shadowBlur=0;
    if(!reduced)raf=requestAnimationFrame(draw);
  }
  function enter(env,current){
    if(!running){
      previousFocus=document.activeElement;previousOverflow=document.body.style.overflow;
      previousInert=shell?.inert||false;
    }
    environment=env||environment;state=current||null;panel.hidden=false;document.body.style.overflow='hidden';
    if(shell)shell.inert=true;
    exitButton.focus();
    resize();seedTelemetry();ctx.clearRect(0,0,innerWidth,innerHeight);tctx.clearRect(0,0,innerWidth,innerHeight);running=true;last=performance.now();cancelAnimationFrame(raf);
    if(reduced)draw(last);else raf=requestAnimationFrame(draw);
  }
  function exit(){
    if(!running)return;
    running=false;cancelAnimationFrame(raf);panel.hidden=true;
    document.body.style.overflow=previousOverflow;
    if(shell)shell.inert=previousInert;
    previousFocus?.focus();
  }
  function setTelemetry(env,current){
    const previous=state?.overall;environment=env;state=current;
    if(running){
      // Polling preserves the published renderer's rain positions and native trails.
      seedTelemetry(true);
      if(previous&&previous!==current?.overall)columns.forEach(c=>{c.alpha=Math.min(.82,c.alpha+.05)});
      if(reduced)draw(performance.now());
    }
  }
  addEventListener('resize',()=>{if(running){resize();seedTelemetry();if(reduced)draw(performance.now())}});
  document.addEventListener('keydown',(event)=>{
    if(running&&event.key==='Tab'){event.preventDefault();exitButton.focus()}
  });
  motion.addEventListener('change',(event)=>{
    reduced=event.matches;
    if(!running)return;
    cancelAnimationFrame(raf);last=performance.now();
    if(reduced){seedTelemetry(true);draw(last)}else raf=requestAnimationFrame(draw);
  });
  window.OcreMatrix={enter,exit,setTelemetry};
})();

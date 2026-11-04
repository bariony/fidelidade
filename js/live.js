/* Pulso de visita para o painel "Ao vivo" do admin. Sem cookies: id aleatório só da aba (sessionStorage).
   Envia página, etapa e origem (utm). Não envia dados pessoais; a cidade é estimada no servidor. */
(function(){
  try{
    if(!window.FID || !FID.SUPABASE_URL) return;
    var k = 'carimbo_sid', sid = null;
    try{ sid = sessionStorage.getItem(k); }catch(e){}
    if(!sid){ sid = (Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 20); try{ sessionStorage.setItem(k, sid); }catch(e){} }
    var q = new URLSearchParams(location.search), src = q.get('utm_source') || '';
    if(!src && document.referrer){ try{ var h = new URL(document.referrer).hostname.replace(/^www\./, ''); if(h && h !== location.hostname) src = h; }catch(e){} }
    var p = location.pathname.replace(/\.html$/, '') || '/';
    var step = /^\/comprar/.test(p) ? 'comprar' : /^\/obrigado/.test(p) ? 'comprou' : 'visitando';
    var url = FID.SUPABASE_URL + '/functions/v1/live-ping';
    /* Só conta quem está de fato por ali: sem toque, rolagem, clique ou tecla há 3 min, para de enviar sinal (aba esquecida some do painel). */
    var last = Date.now(), IDLE = 180000;
    ['pointerdown','pointermove','keydown','scroll','touchstart','input'].forEach(function(ev){
      window.addEventListener(ev, function(){
        var was = Date.now() - last > IDLE; last = Date.now();
        if(was) ping();
      }, {passive:true, capture:true});
    });
    function ping(){
      try{ fetch(url, {method:'POST', body:JSON.stringify({sid:sid, page:p, step:step, src:src}), keepalive:true, headers:{'Content-Type':'text/plain'}}).catch(function(){}); }catch(e){}
    }
    window.liveStep = function(s){ step = s; last = Date.now(); ping(); };
    ping();
    setInterval(function(){ if(Date.now() - last < IDLE) ping(); }, 20000);
    document.addEventListener('visibilitychange', function(){ if(document.visibilityState === 'visible' && Date.now() - last < IDLE) ping(); });
    window.addEventListener('pagehide', function(){});
    if(step === 'comprar'){
      var once = function(){ if(step === 'comprar') window.liveStep('preenchendo'); document.removeEventListener('input', once); };
      document.addEventListener('input', once);
    }
  }catch(e){}
})();

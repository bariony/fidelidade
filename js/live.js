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
    function ping(){
      if(document.visibilityState === 'hidden') return;
      try{ fetch(url, {method:'POST', body:JSON.stringify({sid:sid, page:p, step:step, src:src}), keepalive:true, headers:{'Content-Type':'text/plain'}}).catch(function(){}); }catch(e){}
    }
    window.liveStep = function(s){ step = s; ping(); };
    ping();
    setInterval(ping, 20000);
    document.addEventListener('visibilitychange', function(){ if(document.visibilityState === 'visible') ping(); });
    if(step === 'comprar'){
      var once = function(){ if(step === 'comprar') window.liveStep('preenchendo'); document.removeEventListener('input', once); };
      document.addEventListener('input', once);
    }
  }catch(e){}
})();

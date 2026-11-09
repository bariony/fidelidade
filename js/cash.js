/* Som de "caixa registradora" (cha-ching) gerado no navegador, sem arquivo de áudio.
   Toca quando chega um push de venda e o app está aberto. Fora do app, o som é o padrão do celular. */
(function(){
  var ctx;
  function tone(f, t0, dur, vol){
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(ctx.destination); o.start(t0); o.stop(t0 + dur + 0.05);
  }
  window.playCash = function(){
    try {
      ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') ctx.resume();
      var t = ctx.currentTime + 0.02;
      tone(1318.5, t, 0.5, 0.35); tone(2637, t, 0.35, 0.12);          /* ka  */
      tone(1760, t + 0.13, 0.9, 0.38); tone(3520, t + 0.13, 0.6, 0.14); /* ching */
      tone(2349, t + 0.13, 0.7, 0.12);
    } catch (_) {}
  };
  document.addEventListener('pointerdown', function u(){ try { ctx = ctx || new (window.AudioContext || window.webkitAudioContext)(); ctx.resume(); } catch (_) {} document.removeEventListener('pointerdown', u); }, { once: true });
  if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', function(e){ if (e.data && e.data.type === 'cash') window.playCash(); });
})();

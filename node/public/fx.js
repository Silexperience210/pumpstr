/* fx.js — effets « tip-to-trigger » partagés (overlay + watch).
   Le serveur diffuse {type:"tip", action:{effect}} quand le montant matche une action.
   Chaque page appelle PumpFX.fireAction(action) ; PumpFX.setAudio(true) débloque le son
   (geste user requis côté viewer ; activé par défaut sur l'overlay OBS). Sons synthétisés
   en Web Audio (aucun asset). */
(() => {
  let audioOn = false, ctx = null;
  const ac = () => (ctx ??= new (window.AudioContext || window.webkitAudioContext)());
  function tone(freq, dur, type = "sawtooth", gain = 0.2, when = 0) {
    if (!audioOn) return;
    try {
      const a = ac(), o = a.createOscillator(), g = a.createGain();
      o.type = type; o.frequency.value = freq; o.connect(g); g.connect(a.destination);
      const t = a.currentTime + when; g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.start(t); o.stop(t + dur);
    } catch { /* audio indispo */ }
  }
  const airhorn = () => [0, 0.2, 0.42].forEach((d) => { tone(415, 0.18, "sawtooth", 0.28, d); tone(620, 0.18, "square", 0.12, d); });

  function spawn(html, cls, dur) { const e = document.createElement("div"); e.className = cls; e.innerHTML = html; document.body.appendChild(e); setTimeout(() => e.remove(), dur); return e; }
  function emojiRain(emoji, n) {
    for (let i = 0; i < n; i++) {
      const e = spawn(emoji, "pfx-rain", 3000);
      e.style.left = Math.random() * 100 + "vw"; e.style.fontSize = (22 + Math.random() * 28) + "px";
      e.style.animationDelay = (Math.random() * 0.6) + "s"; e.style.animationDuration = (1.7 + Math.random() * 1.2) + "s";
    }
  }
  const bigPop = (emoji) => spawn(emoji, "pfx-pop", 1100);
  const rainbowFlash = () => spawn("", "pfx-rainbow", 900);
  const banner = (txt) => spawn(txt, "pfx-banner", 3200);
  function shake() { document.body.classList.add("pfx-shake"); setTimeout(() => document.body.classList.remove("pfx-shake"), 600); }

  function fireAction(a) {
    if (!a || !a.effect) return;
    switch (a.effect) {
      case "horn": airhorn(); bigPop("📯"); shake(); break;
      case "hearts": emojiRain("💚", 28); tone(880, 0.25, "sine", 0.12); break;
      case "confetti": emojiRain("🎉", 38); tone(660, 0.2, "triangle", 0.12); tone(990, 0.2, "triangle", 0.1, 0.12); break;
      case "rainbow": rainbowFlash(); tone(560, 0.4, "triangle", 0.12); break;
      case "mega": airhorn(); emojiRain("🚀", 44); rainbowFlash(); shake(); banner(`${a.emoji || "🚀"} MEGA HYPE ${a.emoji || "🚀"}`); break;
      default: bigPop(a.emoji || "⚡");
    }
  }

  const css = `
    .pfx-rain{ position:fixed; top:-44px; z-index:5; pointer-events:none; animation:pfxRain linear forwards; }
    @keyframes pfxRain{ to{ transform:translateY(112vh) rotate(360deg); opacity:.15 } }
    .pfx-pop{ position:fixed; left:50%; top:42%; z-index:6; transform:translate(-50%,-50%); font-size:120px; pointer-events:none; animation:pfxPop 1.1s cubic-bezier(.2,1.6,.4,1) forwards; }
    @keyframes pfxPop{ 0%{opacity:0; transform:translate(-50%,-50%) scale(.3)} 25%{opacity:1; transform:translate(-50%,-50%) scale(1.15)} 100%{opacity:0; transform:translate(-50%,-50%) scale(1.35)} }
    .pfx-rainbow{ position:fixed; inset:0; z-index:4; pointer-events:none; opacity:0; mix-blend-mode:screen;
      background:linear-gradient(120deg,#ff2e93,#ffb13b,#bcff2e,#2ee6ff,#a32eff); animation:pfxRainbow .9s ease-out forwards; }
    @keyframes pfxRainbow{ 0%{opacity:.5} 100%{opacity:0} }
    .pfx-shake{ animation:pfxShake .6s; } @keyframes pfxShake{ 0%,100%{transform:translate(0,0)} 20%{transform:translate(-8px,4px)} 40%{transform:translate(8px,-4px)} 60%{transform:translate(-6px,-3px)} 80%{transform:translate(6px,3px)} }
    .pfx-banner{ position:fixed; left:50%; top:28%; z-index:7; transform:translateX(-50%); pointer-events:none;
      font-family:'Bricolage Grotesque',ui-sans-serif,sans-serif; font-weight:800; font-size:clamp(28px,7vw,64px); color:#fff;
      text-shadow:0 0 30px rgba(188,255,46,.8),0 0 60px rgba(255,46,147,.6); white-space:nowrap; animation:pfxBanner 3.2s cubic-bezier(.2,1.5,.4,1) forwards; }
    @keyframes pfxBanner{ 0%{opacity:0; transform:translateX(-50%) scale(.6)} 12%{opacity:1; transform:translateX(-50%) scale(1.1)} 80%{opacity:1} 100%{opacity:0; transform:translateX(-50%) scale(1.05)} }`;
  const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

  window.PumpFX = { fireAction, setAudio: (on) => { audioOn = !!on; if (on) { try { ac().resume?.(); } catch {} } } };
})();

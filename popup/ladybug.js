// XPorter — ladybug Easter egg.
// A little ladybug wanders the contact card (the "Questions or found a bug?"
// block), staying above the Telegram button. Click it and it gets squashed,
// leaving a small splat that fades away; it won't come back until you leave the
// About tab and return — then a fresh one spawns somewhere new and wanders off.
// Its legs react to what it's doing: they pause when it stops, shuffle while it
// turns in place, and step faster or slower with its walking speed.
// Can be turned off entirely from Settings (window.XPorterLadybug.setEnabled).
(function () {
  'use strict';

  const card = document.querySelector('.about-contact');
  const bug = document.querySelector('.ladybug');
  const body = bug && bug.querySelector('.lb-body');
  const tab = document.getElementById('tab-about');
  if (!card || !bug || !body || !tab) return;

  const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  const BUG = 22;                 // bug box size (px)
  const BASE_SPEED = 16;          // px/s on a straight (≈ the old 19 × 0.85 — a touch calmer)
  const TURN_RATE = 2.4;          // rad/s — limited so turns are smooth, never zigzag
  const SPLAT_VISIBLE = 5000;     // ms the splat stays solid
  const SPLAT_FADE = 5000;        // ms it then takes to fade out

  // state: 'gone' | 'walking' | 'static' | 'squashed'
  let state = 'gone';
  // phase (while walking): 'walk' | 'turn' (turning in place) | 'idle' (stopped)
  let phase = 'idle';
  let phaseUntil = 0;
  let enabled = true;
  let raf = 0;
  let last = 0;
  let pos = { x: 0, y: 0 };
  let heading = 0;                // radians; 0 = +x (right)
  let target = null;
  let speedScale = 1;
  let zone = { l: 4, t: 4, r: 80, b: 60 };
  let splat = null;
  let timers = [];

  const rnd = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const normAngle = (a) => {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
  };
  // Pull a heading partway toward the nearest vertical so the bug rarely walks
  // straight along a line of text (which would sit on a word); angled/vertical
  // moves cross the line and clear the word quickly.
  const deHorizontal = (a) => {
    const vert = Math.sin(a) >= 0 ? Math.PI / 2 : -Math.PI / 2;
    return a + 0.45 * normAngle(vert - a);
  };
  const headingDeg = () => heading * 180 / Math.PI + 90; // svg faces up at 0deg

  // The walkable area: inside the card, above the Telegram button (its clickable
  // zone is off-limits), with a small inset so the bug never clips the edges.
  function computeZone() {
    const cs = getComputedStyle(card);
    const borderTop = parseFloat(cs.borderTopWidth) || 0;
    const cr = card.getBoundingClientRect();
    let bottom = card.clientHeight - BUG - 6;
    const tg = card.querySelector('.contact-btn--telegram');
    if (tg) {
      const tr = tg.getBoundingClientRect();
      bottom = (tr.top - cr.top - borderTop) - BUG - 6;
    }
    zone = {
      l: 4,
      t: 4,
      r: Math.max(8, card.clientWidth - BUG - 4),
      b: Math.max(8, bottom),
    };
  }

  function render() {
    bug.style.left = pos.x + 'px';
    bug.style.top = pos.y + 'px';
    body.style.transform = 'rotate(' + headingDeg() + 'deg)';
  }

  // Drive the leg gait from what the bug is doing.
  //  idle → freeze the legs; turn → a steady shuffle; walk → step rate tracks speed.
  function setGait(mode) {
    if (mode === 'idle') {
      body.classList.add('gait-paused');
      return;
    }
    body.classList.remove('gait-paused');
    const dur = mode === 'turn' ? 0.4 : clamp(0.55 / speedScale, 0.32, 0.78);
    body.style.setProperty('--gait-dur', dur.toFixed(2) + 's');
  }

  // Pick the next point to amble toward. Mostly a point in front (so motion
  // flows forward like a real bug); occasionally anywhere, for variety.
  function pickTarget() {
    let ang, dist;
    if (Math.random() < 0.72) {
      ang = heading + rnd(-1.7, 1.7);
      dist = rnd(26, 90);
    } else {
      const rx = rnd(zone.l, zone.r);
      const ry = rnd(zone.t, zone.b);
      ang = Math.atan2(ry - pos.y, rx - pos.x);
      dist = Math.max(20, Math.hypot(rx - pos.x, ry - pos.y));
    }
    ang = deHorizontal(ang); // bias away from purely horizontal travel
    target = {
      x: clamp(pos.x + Math.cos(ang) * dist, zone.l, zone.r),
      y: clamp(pos.y + Math.sin(ang) * dist, zone.t, zone.b),
    };
    speedScale = rnd(0.7, 1.45); // whole next leg is a bit faster or slower
  }

  // Start a new leg of the journey: if it needs a big turn, pivot in place first.
  function beginSegment() {
    pickTarget();
    const diff = Math.abs(normAngle(Math.atan2(target.y - pos.y, target.x - pos.x) - heading));
    if (diff > 0.5) { phase = 'turn'; setGait('turn'); }
    else { phase = 'walk'; setGait('walk'); }
  }

  function step(now) {
    if (state !== 'walking') return;
    if (!last) last = now;
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;

    if (phase === 'idle') {
      if (now >= phaseUntil) beginSegment();
    } else if (phase === 'turn') {
      // Rotate in place toward the target; the legs shuffle but we don't move.
      const diff = normAngle(Math.atan2(target.y - pos.y, target.x - pos.x) - heading);
      heading += clamp(diff, -TURN_RATE * dt, TURN_RATE * dt);
      render();
      if (Math.abs(diff) < 0.09) { phase = 'walk'; setGait('walk'); }
    } else { // walk
      const diff = normAngle(Math.atan2(target.y - pos.y, target.x - pos.x) - heading);
      heading += clamp(diff, -TURN_RATE * dt, TURN_RATE * dt); // gentle course correction
      const turnFactor = 1 - Math.min(Math.abs(diff) / Math.PI, 1) * 0.55;
      const sp = BASE_SPEED * speedScale * turnFactor;
      pos.x = clamp(pos.x + Math.cos(heading) * sp * dt, zone.l, zone.r);
      pos.y = clamp(pos.y + Math.sin(heading) * sp * dt, zone.t, zone.b);
      render();
      const dx = target.x - pos.x;
      const dy = target.y - pos.y;
      if (dx * dx + dy * dy < 25) {
        if (Math.random() < 0.5) { phase = 'idle'; phaseUntil = now + rnd(350, 1500); setGait('idle'); }
        else beginSegment();
      }
    }
    raf = requestAnimationFrame(step);
  }

  function clearSplat() {
    timers.forEach(clearTimeout);
    timers = [];
    if (splat && splat.parentNode) splat.parentNode.removeChild(splat);
    splat = null;
  }

  function squash(e) {
    if (state !== 'walking' && state !== 'static') return;
    if (e) e.preventDefault();
    state = 'squashed';
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    body.classList.add('gait-paused');

    // Flatten in place, keeping the current heading — looks like it gets squished.
    body.style.transition = 'transform 0.13s cubic-bezier(.3,.85,.4,1)';
    body.style.transform = 'rotate(' + headingDeg() + 'deg) scale(1.32, 0.16)';

    // Drop a splat at the bug's centre.
    splat = document.createElement('span');
    splat.className = 'lb-splat';
    splat.style.left = (pos.x + BUG / 2) + 'px';
    splat.style.top = (pos.y + BUG / 2) + 'px';
    splat.style.setProperty('--r', Math.round(rnd(-40, 40)) + 'deg');
    card.appendChild(splat);

    timers.push(setTimeout(() => {
      bug.style.display = 'none';
      if (splat) splat.style.opacity = '0.85';
    }, 150));
    timers.push(setTimeout(() => {
      if (!splat) return;
      splat.style.transition = 'opacity ' + SPLAT_FADE + 'ms linear';
      splat.style.opacity = '0';
    }, 150 + SPLAT_VISIBLE));
    timers.push(setTimeout(clearSplat, 150 + SPLAT_VISIBLE + SPLAT_FADE));
  }

  function despawn() {
    state = 'gone';
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    clearSplat();
    bug.style.display = 'none';
    bug.style.opacity = '';
    bug.style.transition = '';
    body.classList.remove('gait-paused');
    body.style.transition = '';
    body.style.transform = '';
  }

  function spawn() {
    despawn();
    if (!enabled) return;
    computeZone();
    if (zone.r <= zone.l || zone.b <= zone.t) return;

    pos = { x: rnd(zone.l, zone.r), y: rnd(zone.t, zone.b) };
    heading = rnd(-Math.PI, Math.PI); // face any direction
    target = null;
    speedScale = rnd(0.7, 1.45);
    phase = 'idle';
    phaseUntil = 0; // begins a fresh segment on the first frame
    body.classList.remove('gait-paused');
    body.style.setProperty('--gait-dur', '0.5s');

    bug.style.display = 'block';
    body.style.transition = '';
    render();

    if (reduceMotion) { state = 'static'; return; } // sit still, still squashable
    state = 'walking';
    last = 0;
    raf = requestAnimationFrame(step);
  }

  // The About-tab lightning bolt only starts animating when its tab is first
  // shown, so it drifts out of phase with the always-running header bolt. Snap
  // its animation phase onto the header's so the two flicker together.
  function syncBolts() {
    try {
      const a = document.querySelector('.logo');
      const b = document.querySelector('.about-icon');
      if (!a || !b || !a.getAnimations) return;
      const src = a.getAnimations();
      b.getAnimations().forEach((anim) => {
        const s = src.find((x) => x.animationName === anim.animationName);
        if (s && s.currentTime != null) anim.currentTime = s.currentTime;
      });
    } catch (_) { /* noop */ }
  }

  // Respawn on every entry to the About tab; freeze + clear when it's left.
  // (spawn via timeout, not rAF, so it fires even before the first paint.)
  let wasActive = tab.classList.contains('active');
  if (wasActive) { setTimeout(spawn, 16); setTimeout(syncBolts, 40); }

  const obs = new MutationObserver(() => {
    const active = tab.classList.contains('active');
    if (active && !wasActive) { setTimeout(spawn, 16); setTimeout(syncBolts, 40); }
    else if (!active && wasActive) despawn();
    wasActive = active;
  });
  obs.observe(tab, { attributes: true, attributeFilter: ['class'] });

  bug.addEventListener('pointerdown', squash);

  // Public switch for the Settings toggle.
  window.XPorterLadybug = {
    setEnabled(on) {
      enabled = !!on;
      if (!enabled) despawn();
      else if (tab.classList.contains('active')) setTimeout(spawn, 0);
    },
  };
})();

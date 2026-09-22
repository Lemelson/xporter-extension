// XPorter ladybug: shared curved-path math, articulated feet, and a bounded renderer.
(function () {
  'use strict';
  const card = document.querySelector('.about-contact');
  const bug = document.querySelector('.ladybug');
  const body = bug?.querySelector('.lb-body');
  const tab = document.getElementById('tab-about');
  if (!card || !bug || !body || !tab) return;

  // Keep the translated label separate so language changes preserve the count.
  const counter = document.getElementById('ladybugSquashCount');
  if (counter && typeof chrome !== 'undefined' && chrome.storage?.local) {
    let changed = false;
    const renderCount = usage => {
      const count = usage?.ladybugSquashes;
      counter.textContent = '(' + (Number.isSafeInteger(count) && count >= 0 ? count : 0) + ')';
    };
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.xporter_usage) return;
      changed = true;
      renderCount(changes.xporter_usage.newValue);
    });
    chrome.storage.local.get('xporter_usage').then(result => {
      if (!changed) renderCount(result.xporter_usage);
    }).catch(() => { /* Keep the initial zero if storage is unavailable. */ });
  }

  const motion = globalThis.XPorterLadybugMotion;
  const rotator = bug.querySelector('.lb-heading');
  const legs = [...bug.querySelectorAll('.leg')].map(upper => ({ upper, lower: upper.querySelector('.leg-lower') }));
  if (!motion || !rotator || legs.length !== 6) return;
  const media = window.matchMedia('(prefers-reduced-motion: reduce)');
  const BUG = 22, FRAME_MS = 1000 / 30;
  const rnd = (a, b) => a + Math.random() * (b - a);
  let enabled = true, inView = true, state = 'gone', resumeFromSide = false;
  let raf = 0, last = 0, start = null, duration = 0, walked = 0, heading = 0;
  let pos = { x: 0, y: 0 }, zone, path, splat = null;
  const timers = new Set();
  const active = () => enabled && inView && !document.hidden && tab.classList.contains('active');

  function later(fn, ms) {
    const id = setTimeout(() => { timers.delete(id); if (active()) fn(); }, ms);
    timers.add(id);
  }

  function cancelWork() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    timers.forEach(clearTimeout);
    timers.clear();
  }

  function computeZone() {
    const border = parseFloat(getComputedStyle(card).borderTopWidth) || 0;
    const rect = card.getBoundingClientRect();
    const scale = rect.width / (card.clientWidth + 2 * border) || 1;
    const tg = card.querySelector('.contact-btn--telegram');
    const bottom = tg ? (tg.getBoundingClientRect().top - rect.top) / scale - border : card.clientHeight;
    zone = { l: 4, t: 4, r: Math.max(8, card.clientWidth - BUG - 4), b: Math.max(8, bottom - BUG - 6) };
    return { rect, scale };
  }

  function render() {
    // Only transforms change during walking: no layout reads or left/top writes.
    bug.style.transform = `translate3d(${pos.x.toFixed(2)}px,${pos.y.toFixed(2)}px,0)`;
    rotator.style.transform = `rotate(${(heading * 180 / Math.PI + 90).toFixed(2)}deg)`;
    legs.forEach(({ upper, lower }, i) => {
      const pose = motion.legPose(walked, i);
      upper.style.transform = `rotate(${pose.sweep.toFixed(1)}deg)`;
      lower.style.transform = `rotate(${pose.bend.toFixed(1)}deg)`;
    });
  }

  function beginSegment(entry = false) {
    if (!active()) return;
    state = 'walking';
    start = null;
    last = 0;
    if (entry) {
      const left = pos.x < zone.l;
      const inset = Math.min(46, (zone.r - zone.l) / 3);
      const end = { x: left ? zone.l + inset : zone.r - inset,
        y: rnd(zone.t + (zone.b - zone.t) * .2, zone.t + (zone.b - zone.t) * .8) };
      const dx = end.x - pos.x;
      path = [pos, { x: pos.x + dx * .3, y: pos.y }, { x: end.x - dx * .3, y: end.y }, end];
    } else path = motion.createPath(pos, heading, zone);
    duration = Math.max(1700, motion.pathLength(path) / rnd(16, 24) * 1000);
    raf = requestAnimationFrame(step);
  }

  function step(now) {
    raf = 0;
    if (!active() || state !== 'walking') return;
    if (start === null) { start = now; last = now - FRAME_MS; }
    if (now - last < FRAME_MS - .2) { raf = requestAnimationFrame(step); return; }
    last = now;
    const t = motion.clamp((now - start) / duration, 0, 1);
    const eased = t * t * (3 - 2 * t);
    const next = motion.bezier(path, eased);
    walked += Math.hypot(next.x - pos.x, next.y - pos.y);
    pos = next;
    heading = motion.direction(path, motion.clamp(eased, .001, .999));
    render();
    if (t < 1) raf = requestAnimationFrame(step);
    else if (Math.random() < .35) {
      state = 'idle'; // No frame loop, CSS leg animation or polling while resting.
      later(() => beginSegment(), rnd(450, 1200));
    } else beginSegment();
  }

  function despawn() {
    cancelWork();
    if (splat?.parentNode) splat.parentNode.removeChild(splat);
    splat = null;
    state = 'gone';
    bug.style.display = 'none';
  }

  function spawn(fromSide = false) {
    despawn();
    if (!active()) return;
    const { rect, scale } = computeZone();
    const left = Math.random() < .5;
    pos = { x: rnd(zone.l, zone.r), y: rnd(zone.t + (zone.b - zone.t) * .2, zone.t + (zone.b - zone.t) * .8) };
    const entry = fromSide && !media.matches;
    if (entry) pos.x = left ? -rect.left / scale - BUG - 4 : (document.documentElement.clientWidth - rect.left) / scale + 4;
    heading = left ? 0 : Math.PI;
    walked = 0;
    body.style.transform = '';
    body.style.opacity = '';
    bug.style.display = 'block';
    render();
    resumeFromSide = false;
    if (media.matches) state = 'static';
    else beginSegment(entry);
  }

  function squash(e) {
    if (!active() || !['walking', 'idle', 'static'].includes(state)) return;
    e?.preventDefault();
    state = 'squashed';
    resumeFromSide = true;
    cancelWork();
    try {
      chrome.runtime.sendMessage({ type: 'XP_LADYBUG_SQUASH' }, () => { void chrome.runtime.lastError; });
    } catch (_) { /* Storage failure must not interrupt the animation. */ }
    body.style.transform = 'scale(1.2,.16)';
    splat = document.createElement('span');
    splat.className = 'lb-splat';
    splat.style.left = `${pos.x + BUG / 2}px`;
    splat.style.top = `${pos.y + BUG / 2}px`;
    splat.style.setProperty('--r', `${Math.round(rnd(-35, 35))}deg`);
    card.appendChild(splat);
    later(() => { body.style.opacity = '0'; }, 140);
    later(() => { bug.style.display = 'none'; if (splat) splat.style.opacity = '0'; }, 1100);
    later(() => spawn(true), 2300);
  }

  function updateVisibility() {
    if (!active()) despawn();
    else if (state === 'gone') spawn(resumeFromSide);
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


  const observer = new MutationObserver(() => { updateVisibility(); if (active()) syncBolts(); });
  observer.observe(tab, { attributes: true, attributeFilter: ['class'] });
  document.addEventListener('visibilitychange', updateVisibility);
  window.addEventListener('pagehide', despawn);
  media.addEventListener('change', () => { if (active()) spawn(); });
  // An About tab can be active while its contact card is scrolled out of view.
  if (typeof IntersectionObserver === 'function') {
    new IntersectionObserver(entries => {
      inView = entries[0].isIntersecting;
      updateVisibility();
    }).observe(card);
  }
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => { if (active() && state !== 'squashed') spawn(); }).observe(card);
  }
  bug.addEventListener('pointerdown', squash);
  bug.addEventListener('click', e => { if (e.detail === 0) squash(e); });
  window.XPorterLadybug = {
    setEnabled(on) { enabled = !!on; updateVisibility(); }
  };
  updateVisibility();
  if (active()) syncBolts();
})();

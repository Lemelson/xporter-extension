// Small, DOM-free path and gait helpers shared by the ladybug renderer and tests.
(function (root) {
  'use strict';
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function bezier(p, t) {
    const u = 1 - t;
    return {
      x: u ** 3 * p[0].x + 3 * u * u * t * p[1].x + 3 * u * t * t * p[2].x + t ** 3 * p[3].x,
      y: u ** 3 * p[0].y + 3 * u * u * t * p[1].y + 3 * u * t * t * p[2].y + t ** 3 * p[3].y
    };
  }

  function direction(p, t) {
    const u = 1 - t;
    return Math.atan2(
      3 * u * u * (p[1].y - p[0].y) + 6 * u * t * (p[2].y - p[1].y) + 3 * t * t * (p[3].y - p[2].y),
      3 * u * u * (p[1].x - p[0].x) + 6 * u * t * (p[2].x - p[1].x) + 3 * t * t * (p[3].x - p[2].x)
    );
  }

  // Shorten a tangent before the edge instead of clipping its x/y separately.
  // This keeps the heading continuous when two curves join.
  function control(point, angle, distance, zone) {
    const dx = Math.cos(angle), dy = Math.sin(angle);
    const rx = dx > 0 ? (zone.r - point.x) / dx : dx < 0 ? (zone.l - point.x) / dx : Infinity;
    const ry = dy > 0 ? (zone.b - point.y) / dy : dy < 0 ? (zone.t - point.y) / dy : Infinity;
    const d = Math.max(0, Math.min(distance, rx * .85, ry * .85));
    return { x: point.x + dx * d, y: point.y + dy * d };
  }

  function createPath(pos, heading, zone, random = Math.random) {
    const angle = heading + (random() - .5) * 2.4;
    const distance = 55 + random() * 85;
    const mx = Math.min(12, (zone.r - zone.l) / 4);
    const my = Math.min(12, (zone.b - zone.t) / 4);
    let end = {
      x: clamp(pos.x + Math.cos(angle) * distance, zone.l + mx, zone.r - mx),
      y: clamp(pos.y + Math.sin(angle) * distance, zone.t + my, zone.b - my)
    };
    if (Math.hypot(end.x - pos.x, end.y - pos.y) < 25) {
      end = { x: zone.l + mx + random() * (zone.r - zone.l - 2 * mx),
        y: zone.t + my + random() * (zone.b - zone.t - 2 * my) };
    }
    const length = Math.max(10, Math.hypot(end.x - pos.x, end.y - pos.y));
    const endHeading = Math.atan2(end.y - pos.y, end.x - pos.x) + (random() - .5) * .6;
    return [pos, control(pos, heading, length * .4, zone), control(end, endHeading + Math.PI, length * .3, zone), end];
  }

  function pathLength(p) {
    let length = 0, prev = p[0];
    for (let i = 1; i <= 12; i++) {
      const next = bezier(p, i / 12);
      length += Math.hypot(next.x - prev.x, next.y - prev.y);
      prev = next;
    }
    return length;
  }

  // Alternating tripods: L1/R2/L3 and R1/L2/R3. A longer stance and a
  // shorter, flexed return make each foot plant, push and lift off.
  function legPose(distance, index) {
    const side = index < 3 ? 1 : -1;
    const phase = (distance / 14 + (index % 2 ? .5 : 0)) % 1;
    const stance = phase < .62;
    const t = stance ? phase / .62 : (phase - .62) / .38;
    const recovery = t * t * (3 - 2 * t);
    return {
      sweep: side * (stance ? -15 + 30 * t : 15 - 30 * recovery),
      bend: side * (stance ? 0 : 24 * Math.sin(Math.PI * t))
    };
  }

  root.XPorterLadybugMotion = Object.freeze({ clamp, bezier, direction, createPath, pathLength, legPose });
})(globalThis);

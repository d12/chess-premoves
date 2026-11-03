// Lightweight canvas confetti: no dependencies, one shared full-screen overlay that removes
// itself when the last piece has fallen. Callers should skip it for prefers-reduced-motion.

const GRAVITY = 900; // px/s²
const DRAG = 2.6; // per second, horizontal and upward air resistance
const TERMINAL_VELOCITY = 260; // px/s, fall speed cap so pieces flutter down

export const PALETTES = Object.freeze({
  // any win: bright party colours (red, blue, green, yellow)
  victory: ["#e63946", "#ff6b6b", "#1e88e5", "#64b5f6", "#43a047", "#81c784", "#fdd835", "#ffe066"],
  perfect: ["#b8860b", "#d4a017", "#e1c262", "#f4d35e", "#ffe8a3", "#fff6d5", "#fffdf6"],
});

let overlay = null;
let particles = [];
let frame = 0;
let lastTime = 0;

function ensureOverlay() {
  if (overlay) {
    return overlay;
  }
  const canvas = document.createElement("canvas");
  canvas.className = "confetti-overlay";
  canvas.setAttribute("aria-hidden", "true");
  Object.assign(canvas.style, {
    position: "fixed",
    inset: "0",
    width: "100%",
    height: "100%",
    pointerEvents: "none",
    zIndex: "1000",
  });
  document.body.append(canvas);
  overlay = { canvas, context: canvas.getContext("2d"), width: 0, height: 0, ratio: 1 };
  resize();
  window.addEventListener("resize", resize);
  return overlay;
}

function resize() {
  if (!overlay) {
    return;
  }
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  overlay.width = window.innerWidth;
  overlay.height = window.innerHeight;
  overlay.ratio = ratio;
  overlay.canvas.width = Math.round(overlay.width * ratio);
  overlay.canvas.height = Math.round(overlay.height * ratio);
}

function teardown() {
  cancelAnimationFrame(frame);
  frame = 0;
  window.removeEventListener("resize", resize);
  overlay?.canvas.remove();
  overlay = null;
  particles = [];
}

const random = (min, max) => min + Math.random() * (max - min);
const pick = (items) => items[Math.floor(Math.random() * items.length)];

function makeParticle(x, y, angle, speed, palette, shapes, scale, life = [3, 4.4]) {
  const shape = pick(shapes);
  const size = random(7, 12) * scale;
  return {
    x,
    y,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    color: pick(palette),
    shape,
    width: shape === "ribbon" ? size * 0.45 : size,
    height: shape === "ribbon" ? size * 1.6 : size * (shape === "rect" ? 0.6 : 1),
    rotation: random(0, Math.PI * 2),
    spin: random(-9, 9),
    flip: random(0, Math.PI * 2),
    flipSpeed: random(6, 14),
    wobble: random(0, Math.PI * 2),
    wobbleSpeed: random(3, 7),
    age: 0,
    life: random(...life),
  };
}

function drawStar(context, radius) {
  context.beginPath();
  for (let point = 0; point < 10; point += 1) {
    const r = point % 2 === 0 ? radius : radius * 0.45;
    const a = (point * Math.PI) / 5 - Math.PI / 2;
    context.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  context.closePath();
  context.fill();
}

function drawParticle(context, particle) {
  const fade = Math.min(1, (particle.life - particle.age) / 0.6);
  context.save();
  context.globalAlpha = Math.max(0, fade);
  context.translate(particle.x, particle.y);
  context.rotate(particle.rotation);
  // flipping about one axis makes flat confetti look like it tumbles in 3D
  context.scale(1, Math.max(0.08, Math.abs(Math.cos(particle.flip))));
  context.fillStyle = particle.color;
  if (particle.shape === "circle") {
    context.beginPath();
    context.arc(0, 0, particle.width / 2, 0, Math.PI * 2);
    context.fill();
  } else if (particle.shape === "star") {
    drawStar(context, particle.width * 0.75);
  } else {
    context.fillRect(-particle.width / 2, -particle.height / 2, particle.width, particle.height);
  }
  context.restore();
}

function tick(time) {
  const dt = Math.min(0.033, (time - lastTime) / 1000 || 0.016);
  lastTime = time;
  const { context, width, height, ratio } = overlay;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

  particles = particles.filter((particle) => {
    particle.age += dt;
    const drag = Math.exp(-DRAG * dt);
    particle.vx *= drag;
    particle.vy = particle.vy < 0 ? particle.vy * drag : particle.vy;
    particle.vy = Math.min(TERMINAL_VELOCITY, particle.vy + GRAVITY * dt);
    particle.wobble += particle.wobbleSpeed * dt;
    particle.x += (particle.vx + Math.sin(particle.wobble) * 40) * dt;
    particle.y += particle.vy * dt;
    particle.rotation += particle.spin * dt;
    particle.flip += particle.flipSpeed * dt;
    const alive = particle.age < particle.life && particle.y < height + 40;
    if (alive) {
      drawParticle(context, particle);
    }
    return alive;
  });

  if (particles.length > 0) {
    frame = requestAnimationFrame(tick);
  } else {
    teardown();
  }
}

function start() {
  if (!frame) {
    lastTime = performance.now();
    frame = requestAnimationFrame(tick);
  }
}

// A burst from a point (viewport coordinates), mostly upward.
export function burst({ x, y, count = 140, palette = PALETTES.victory, shapes = ["rect", "ribbon", "circle"], power = 1 } = {}) {
  const { height } = ensureOverlay();
  const scale = Math.min(1.25, Math.max(0.75, height / 800));
  for (let index = 0; index < count; index += 1) {
    const angle = -Math.PI / 2 + random(-1.3, 1.3);
    const speed = random(700, 2000) * power * scale;
    particles.push(makeParticle(x, y, angle, speed, palette, shapes, scale));
  }
  start();
}

// Two cannons firing up and inward from the bottom corners of the screen.
export function cannons({ count = 90, palette = PALETTES.perfect, shapes = ["star", "rect", "ribbon"] } = {}) {
  const { width, height } = ensureOverlay();
  const scale = Math.min(1.25, Math.max(0.75, height / 800));
  for (const side of [-1, 1]) {
    const x = side < 0 ? -10 : width + 10;
    for (let index = 0; index < count; index += 1) {
      const angle = side < 0 ? random(-1.35, -0.85) : Math.PI - random(-1.35, -0.85);
      const speed = random(1500, 2900) * scale;
      particles.push(makeParticle(x, height + 10, angle, speed, palette, shapes, scale));
    }
  }
  start();
}

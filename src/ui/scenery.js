// Flat, layered SVG landscapes for each stage theme. Pure string builders, no DOM.
// The sky is the container's CSS background (see [data-theme] in worlds.css). Scenes are drawn
// on a panorama from x = -200 to 600 (300 tall, ground at the bottom). World cards show the
// middle 400 units; the wide level maps show the whole panorama. Both crop to fit, bottom-anchored.

const LEFT = -200;
const RIGHT = 600;

/** A smooth hill line through heights spaced evenly across the panorama, filled to the bottom. */
function hills(heights, fill) {
  const step = (RIGHT - LEFT) / (heights.length - 1);
  const points = heights.map((y, index) => [LEFT + index * step, y]);
  let d = `M${LEFT - 10} 300 L${LEFT - 10} ${points[0][1]} L${points[0][0]} ${points[0][1]}`;
  for (let index = 1; index < points.length; index += 1) {
    const [x0, y0] = points[index - 1];
    const [x1, y1] = points[index];
    const mx = (x0 + x1) / 2;
    d += ` C${mx} ${y0} ${mx} ${y1} ${x1} ${y1}`;
  }
  return `<path d="${d} L${RIGHT + 10} ${points.at(-1)[1]} L${RIGHT + 10} 300 Z" fill="${fill}"/>`;
}

function pines(count, { y, height, width, start, step, fill, jitter = [0] }) {
  return Array.from({ length: count }, (_, index) => {
    const x = start + index * step;
    const j = jitter[index % jitter.length];
    const h = height + j;
    const w = width + j * 0.35;
    return `<path d="M${x} ${y - h} L${x + w / 2} ${y - h * 0.45} L${x + w * 0.3} ${y - h * 0.45} L${x + w * 0.62} ${y} L${x - w * 0.62} ${y} L${x - w * 0.3} ${y - h * 0.45} L${x - w / 2} ${y - h * 0.45} Z" fill="${fill}"/>`;
  }).join("");
}

/** Mountain range: [x, peakY] pairs, each a triangle down to `base`, optionally snow-capped. */
function range(peaks, { base, spread, fill, cap }) {
  return peaks.map(([x, top]) => {
    const height = base - top;
    const half = spread * (height / 100);
    const mountain = `<path d="M${x - half} ${base} L${x} ${top} L${x + half} ${base} Z" fill="${fill}"/>`;
    if (!cap) {
      return mountain;
    }
    const capDepth = Math.min(26, height * 0.28);
    const cw = half * (capDepth / height);
    return `${mountain}<path d="M${x - cw} ${top + capDepth} L${x} ${top} L${x + cw} ${top + capDepth} L${x + cw * 0.4} ${top + capDepth * 0.78} L${x - cw * 0.2} ${top + capDepth} L${x - cw * 0.6} ${top + capDepth * 0.8} Z" fill="${cap}"/>`;
  }).join("");
}

const dots = (points, fill, radius = 1.6, extra = "") => points
  .map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r ?? radius}" fill="${fill}" ${extra}/>`)
  .join("");

const cloud = (x, y, scale = 1) => `<g transform="translate(${x} ${y}) scale(${scale})" fill="#ffffff">
  <ellipse cx="0" cy="0" rx="26" ry="11"/><ellipse cx="-14" cy="-6" rx="13" ry="10"/><ellipse cx="9" cy="-10" rx="15" ry="13"/>
</g>`;

const tree = (x, y, size = 1) => `<rect x="${x - 2.5 * size}" y="${y}" width="${5 * size}" height="${22 * size}" rx="2" fill="#5b9d3e"/>
  <circle cx="${x}" cy="${y - 5 * size}" r="${14 * size}" fill="#4f9a36"/>`;

const cactus = (x, y, size = 1) => `<g fill="#9c5f22" transform="translate(${x} ${y}) scale(${size})">
  <rect x="-4.5" y="0" width="9" height="40" rx="4.5"/><rect x="-16.5" y="10" width="7" height="18" rx="3.5"/>
  <rect x="-16.5" y="22" width="16" height="6" rx="3"/><rect x="8.5" y="4" width="7" height="16" rx="3.5"/><rect x="1.5" y="16" width="14" height="6" rx="3"/>
</g>`;

const pyramid = (x, base, size, light, shade) => `<path d="M${x - size} ${base} L${x} ${base - size * 1.24} L${x + size} ${base} Z" fill="${light}"/>
  <path d="M${x} ${base - size * 1.24} L${x + size} ${base} L${x + size * 0.33} ${base} Z" fill="${shade}"/>`;

const SCENES = {
  meadow: () => `
    <circle cx="296" cy="62" r="42" fill="#fff8cf" opacity="0.45"/>
    <circle cx="296" cy="62" r="25" fill="#fff4b8"/>
    ${cloud(-140, 52, 0.9)}${cloud(-40, 92, 0.7)}${cloud(30, 110, 0.8)}${cloud(122, 66, 1.05)}${cloud(212, 36, 0.75)}${cloud(400, 112, 0.75)}${cloud(500, 50, 1)}
    ${hills([168, 142, 176, 150, 166, 150, 156, 134, 158], "#acdc82")}
    ${hills([206, 188, 212, 182, 200, 186, 192, 178, 200], "#7fc657")}
    ${tree(-150, 186, 0.8)}${tree(-60, 190, 1)}${tree(32, 188, 0.7)}${tree(98, 178)}${tree(306, 168, 0.9)}${tree(452, 178, 1.1)}${tree(540, 186, 0.75)}
    ${hills([250, 238, 246, 226, 244, 234, 236, 228, 244], "#5ea93f")}
    ${dots([[-170, 268], [-110, 282], [-30, 266], [40, 270], [96, 262], [150, 282], [208, 266], [262, 286], [318, 262], [370, 276], [430, 284], [500, 264], [570, 280]], "#ffffff", 2.4)}
    ${dots([[-140, 276], [-60, 286], [66, 280], [122, 270], [236, 276], [292, 272], [350, 286], [466, 272], [540, 286]], "#ffd94a", 2.2)}
    ${dots([[-90, 272], [180, 274], [386, 262], [20, 286], [520, 276]], "#ff8fb1", 2.2)}`,

  forest: () => `
    ${dots([[-180, 34], [-130, 70], [-70, 24], [-20, 58], [40, 30], [96, 62], [150, 22], [204, 52], [246, 18], [356, 40], [384, 96], [20, 92], [128, 98], [430, 30], [480, 74], [540, 26], [580, 60]], "#e9f4d9", 1.3)}
    <circle cx="304" cy="64" r="34" fill="#f5f0cf" opacity="0.14"/>
    <circle cx="304" cy="64" r="20" fill="#f3eecb"/>
    <circle cx="297" cy="58" r="4" fill="#e3dcae"/><circle cx="310" cy="71" r="3" fill="#e3dcae"/>
    ${pines(27, { y: 206, height: 70, width: 40, start: -206, step: 31, fill: "#2a6a5d", jitter: [0, 14, -8, 20, 4, -12, 10] })}
    <rect x="-210" y="204" width="820" height="20" fill="#2a6a5d"/>
    ${pines(19, { y: 246, height: 104, width: 58, start: -192, step: 44, fill: "#1b4f45", jitter: [10, -14, 22, 0, -6, 18, -10] })}
    ${hills([242, 236, 240, 230, 240, 232, 238, 230, 240], "#123d36")}
    ${hills([270, 264, 268, 258, 268, 262, 264, 258, 268], "#0c2f2a")}
    ${dots([[-150, 222], [-70, 206], [64, 218], [138, 196], [226, 226], [298, 206], [360, 230], [184, 252], [440, 214], [520, 230]], "#ffe680", 2, 'class="glow"')}`,

  desert: () => `
    <circle cx="206" cy="126" r="62" fill="#fff4d6" opacity="0.4"/>
    <circle cx="206" cy="126" r="44" fill="#fff1c9"/>
    ${pyramid(-120, 200, 22, "#efb66b", "#dc9c4f")}${pyramid(-86, 200, 14, "#efb66b", "#dc9c4f")}
    ${pyramid(268, 202, 42, "#e7a95a", "#cf8d40")}${pyramid(320, 202, 26, "#e7a95a", "#cf8d40")}
    ${hills([200, 186, 196, 170, 192, 184, 198, 182, 194], "#f4bd6c")}
    ${hills([228, 214, 224, 198, 222, 210, 214, 204, 222], "#e8a250")}
    ${cactus(-40, 214, 0.8)}${cactus(106, 212)}${cactus(470, 206, 0.9)}
    ${hills([258, 250, 256, 236, 254, 244, 248, 240, 256], "#d2843a")}
    ${dots([[-160, 280], [-80, 270], [36, 284], [110, 276], [190, 270], [300, 282], [360, 268], [440, 278], [530, 270]], "#b86d2a", 2)}`,

  frost: () => `
    ${range([[-170, 118], [-80, 140], [-10, 112], [58, 104], [156, 86], [270, 116], [376, 120], [470, 96], [570, 128]], { base: 198, spread: 70, fill: "#cadcf1", cap: "#ffffff" })}
    ${range([[-130, 160], [-40, 172], [70, 150], [206, 132], [340, 168], [440, 150], [560, 164]], { base: 232, spread: 80, fill: "#8eb0db", cap: "#f4f8ff" })}
    ${hills([238, 228, 236, 218, 236, 224, 228, 220, 236], "#e6f0fb")}
    ${hills([262, 254, 260, 246, 260, 250, 254, 248, 260], "#f7fbff")}
    <path d="M40 276 Q 90 268 140 276 M250 284 Q 300 276 350 284 M-150 280 Q -100 272 -50 280 M440 278 Q 490 270 540 278" stroke="#d3e3f5" stroke-width="3" fill="none" stroke-linecap="round"/>
    ${dots([[-180, 50], [-120, 90], [-60, 36], [30, 40], [86, 72], [130, 30], [190, 60], [246, 26], [300, 70], [352, 36], [384, 84], [214, 100], [20, 120], [430, 50], [500, 86], [560, 30]], "#ffffff", 2)}`,

  volcano: () => `
    ${dots([[-180, 30], [-120, 64], [-60, 20], [24, 24], [70, 58], [118, 18], [168, 46], [348, 22], [388, 60], [300, 40], [36, 96], [450, 26], [520, 70], [580, 34]], "#ffd9c4", 1.2)}
    ${range([[-150, 168], [-60, 182], [50, 170], [160, 160], [420, 172], [520, 158]], { base: 230, spread: 120, fill: "#4d1731" })}
    <ellipse cx="271" cy="96" rx="70" ry="30" fill="#ff6a2b" opacity="0.18"/>
    <path d="M140 262 L246 104 L296 104 L402 262 Z" fill="#33101f"/>
    <path d="M246 104 Q 271 92 296 104 L290 114 Q 271 106 252 114 Z" fill="#ff8a3a"/>
    <path d="M262 112 Q 254 150 236 176 Q 228 196 212 214" stroke="#ff6a2b" stroke-width="5" fill="none" stroke-linecap="round"/>
    <path d="M282 112 Q 292 146 312 168" stroke="#ff8a3a" stroke-width="4" fill="none" stroke-linecap="round"/>
    ${hills([246, 238, 244, 234, 248, 240, 238, 232, 244], "#250b18")}
    ${hills([272, 266, 270, 260, 270, 264, 266, 260, 270], "#170610")}
    ${dots([[258, 78], [282, 62], [270, 44], [296, 84], [244, 60]], "#ffb057", 2, 'class="glow"')}`,
};

/** `wide` shows the whole panorama (level maps); otherwise its middle (world cards). */
export function renderScene(theme, { wide = false } = {}) {
  const draw = SCENES[theme] ?? SCENES.meadow;
  const viewBox = wide ? `${LEFT} 0 ${RIGHT - LEFT} 300` : "0 0 400 300";
  return `<svg class="scene" viewBox="${viewBox}" preserveAspectRatio="xMidYMax slice" aria-hidden="true" focusable="false">${draw()}</svg>`;
}

/** Confetti colours for stage-clear and world-unlock celebrations. */
export const THEME_CONFETTI = Object.freeze({
  meadow: ["#7fc657", "#5ea93f", "#fff4b8", "#ffd94a", "#ff8fb1", "#ffffff"],
  forest: ["#ffe680", "#2a6a5d", "#7fd1b9", "#f3eecb", "#4fa58f", "#ffffff"],
  desert: ["#f4bd6c", "#e8a250", "#fff1c9", "#d2843a", "#ffd27a", "#ffffff"],
  frost: ["#8eb0db", "#cadcf1", "#ffffff", "#5c86c4", "#e6f0fb", "#b8d4f5"],
  volcano: ["#ff6a2b", "#ff8a3a", "#ffb057", "#ffd9c4", "#c2264a", "#ffe08a"],
});

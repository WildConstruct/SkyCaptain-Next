// Scripted strokes for a look test: a curving cumulus band, a scatter patch, a towering
// area and a smudge bend. Map km: +x east, +z north; the view looks north.
(() => {
  const L = window.skyPaint;
  const stroke = (opts, points) => {
    L.beginStroke();
    let prev = points[0];
    for (const p of points) {
      L.dab({ size: 6, flow: 0.35, opacity: 0.65, hardness: 0.3, type: null, thin: false, ...opts }, p[0], p[1], [p[0] - prev[0], p[1] - prev[1]]);
      prev = p;
    }
    L.endStroke();
  };
  const arc = (cx, cz, r, a0, a1, n) => Array.from({ length: n }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / (n - 1);
    return [cx + Math.cos(a) * r, cz + Math.sin(a) * r];
  });
  // Band of fair-weather cumulus sweeping from north-west to north-east.
  stroke({ tool: 'cloud', size: 5, flow: 0.25, type: 0.45 }, arc(0, -10, 40, Math.PI * 0.85, Math.PI * 0.2, 60));
  // Scatter of small cumulus closer in, north-east.
  stroke({ tool: 'scatter', size: 9, flow: 0.4 }, arc(14, 14, 4, 0, Math.PI * 2, 30));
  // Push the band's eastern end up into towers.
  stroke({ tool: 'type', size: 7, flow: 0.8, type: 0.95 }, arc(28, 18, 3, 0, Math.PI * 2, 12));
  // Smudge the western end northward into a hook.
  stroke({ tool: 'smudge', size: 8, flow: 1, hardness: 0.5 }, Array.from({ length: 10 }, (_, i) => [-30, 8 + i * 1.5]));
})();

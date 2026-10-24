// Motion studies: renders a fixed set of camera-view MP4s for judging how skies evolve at
// real speed and gently sped up. Each is every frame at 24 fps, converged at the Ultra
// tier with 2048 px cube faces, through tools/clip-preview.mjs. Needs the dev server (npm run dev) and ffmpeg.
// Usage: SKY_GPU=1 node tools/render-studies.mjs [--only name,name] [--seconds 20] [--width 1920] [--face 2048] [--samples 16]
//        [--grain 0.015] [--softness 0.6]   (film look, preview and clips only; 0 turns it off)
//        [--focus 3] [--fstop 2.8] [--bloom 0.02] [--halation 0.04] [--vignette 0.35] [--aberration 0.0006]
// The camera defaults are a close-up's: focus on a subject 3 m off, so the scene sits
// behind it, softly out of focus. --focus 0 keeps the scene sharp.
// Writes shots/studies/<name>.mp4 and shots/studies/<name>.json (the recipe used).
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const seconds = Number(arg('seconds', '20'));
const width = arg('width', '1920');
const only = arg('only', '')?.split(',').filter(Boolean) ?? [];

// Wind 25 km/h toward the east-north-east (across the default view, which looks NNE);
// clouds turn over every 20 minutes. Time-lapse is scene seconds per clip second.
const wind = { windSpeed: 25, windHeading: 70, cloudLife: 20 };
const STUDIES = [
  { name: 'fair-cumulus-1x', hint: 'Fair-weather cumulus at real speed', sky: {}, anim: { timeLapse: 1 } },
  { name: 'fair-cumulus-3x', hint: 'The same sky at 3x', sky: {}, anim: { timeLapse: 3 } },
  { name: 'fair-cumulus-10x', hint: 'The same sky at 10x', sky: {}, anim: { timeLapse: 10 } },
  {
    name: 'stratocumulus-plates-3x', hint: 'Broken stratocumulus plates at 3x',
    sky: { sunElevation: 30, coverage: 0.45, typeBias: -0.2, density: 150 }, anim: { timeLapse: 3 },
  },
  {
    name: 'golden-hour-3x', hint: 'Golden hour cumulus at 3x, looking toward the sun',
    sky: { sunElevation: 6, sunAzimuth: 30, sunIntensity: 24, haze: 25, ambient: 0.9, forwardG: 0.8, powder: 0.8 }, anim: { timeLapse: 3 },
  },
  {
    name: 'brooding-3x', hint: 'Heavy, dark-bellied clouds at 3x',
    sky: { sunElevation: 14, sunIntensity: 16, haze: 22, ambient: 0.55, forwardG: 0.75, powder: 1, density: 400, coverage: 0.34, typeBias: 0.15 },
    anim: { timeLapse: 3 },
  },
  // Water (terrain on, mostly sea; waves run on scene time).
  {
    name: 'sea-glitter-1x', hint: 'Open sea toward a low sun at real speed, from 30 m',
    sky: { terrain: 1, terrainWater: 0.7, eyeAltitude: 0.03, pitch: -4, fov: 45, sunElevation: 8, sunAzimuth: 20 }, anim: { timeLapse: 1 },
  },
  {
    name: 'sea-midday-1x', hint: 'Open sea at midday, sun behind, at real speed, from 30 m',
    sky: { terrain: 1, terrainWater: 0.7, eyeAltitude: 0.03, pitch: -6, fov: 60, sunElevation: 45, sunAzimuth: 200 }, anim: { timeLapse: 1 },
  },
  {
    name: 'lake-mountains-1x', hint: 'A lake under a mountain range at real speed, long lens, from the shore',
    sky: { terrain: 1, terrainWater: 0.4, terrainHeight: 2.5, terrainRidges: 0.8, pitch: 2, fov: 30, sunElevation: 12, sunAzimuth: 100, aimRelief: 1 }, anim: { timeLapse: 1 },
  },
];

mkdirSync('shots/studies', { recursive: true });
for (const study of STUDIES) {
  if (only.length && !only.includes(study.name)) continue;
  // 2048 px cube faces: a 1920 px wide, 80 degree view needs ~24 px per degree.
  const query = new URLSearchParams({ quality: 'ultra', face: arg('face', '2048'), samples: arg('samples', '16'), grain: arg('grain', '0.015'), softness: arg('softness', '0.6'), focusM: arg('focus', '3'), fStop: arg('fstop', '2.8'), bloom: arg('bloom', '0.02'), halation: arg('halation', '0.04'), vignette: arg('vignette', '0.35'), aberration: arg('aberration', '0.0006'), ...Object.fromEntries(Object.entries(study.sky).map(([k, v]) => [k, String(v)])) }).toString();
  const anim = { duration: seconds, fps: 24, ...wind, ...study.anim };
  const out = `shots/studies/${study.name}.mp4`;
  writeFileSync(`shots/studies/${study.name}.json`, JSON.stringify({ ...study, query, animation: anim }, null, 2));
  console.log(`\n== ${study.name}: ${study.hint}`);
  execFileSync('node', ['tools/clip-preview.mjs', out, query, 'all', JSON.stringify(anim), '[]', width], { stdio: 'inherit' });
}
console.log('\nrender-studies: done');

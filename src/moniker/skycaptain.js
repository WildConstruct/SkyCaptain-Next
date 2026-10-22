// skyCaptain's side of Moniker: adapters from settings (and, for a whole sky, its shape
// layers and paint) to the state the .moniker vocabularies read, plus the naming metadata
// a .wcx carries. Mirrors Lumen's src/moniker/lumen.js. Keep this file free of imports
// other than moniker.js and of anything host-specific, so any host can run it unchanged.

import { firedTokens, generateName } from '../../vendor/moniker/moniker.js';

const num = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);

// Time of day by the sun's height. Elevation alone cannot tell dawn from dusk, so the
// vocabulary names the light (golden hour, low sun) rather than the clock.
export function timeFamily(sunElevation) {
  const e = num(sunElevation, 30);
  if (e < 0) return 'twilight';
  if (e < 8) return 'golden';
  if (e < 22) return 'low';
  if (e < 55) return 'day';
  return 'high';
}

// The feel of the light on the clouds: heavy and dark, soft and even, or glowing edges.
export function moodFamily(density, ambient, powder, forwardG) {
  if (num(density, 200) >= 270 && num(ambient, 1) <= 0.75) return 'brooding';
  if (num(ambient, 1) >= 1.25 && num(powder, 0.8) <= 0.5) return 'soft';
  if (num(forwardG, 0.7) >= 0.86 && num(density, 200) < 270) return 'luminous';
  return 'none';
}

// The weather a composed sky is about, from its visible shape layers and paint.
// A front carrying storms is a squall line; then storms, a bare front, clearing holes,
// haze and plain cumulus fields.
export function sceneFamily(shapes, hasPaint) {
  const visible = (shapes ?? []).filter((s) => s && s.visible !== false && num(s.strength, 1) >= 0.3);
  const count = (kind) => visible.filter((s) => s.kind === kind).length;
  const storms = count('storm_cell');
  const fronts = count('front');
  if (fronts && storms) return 'squall';
  if (storms >= 2) return 'storms';
  if (storms === 1) return 'storm';
  if (fronts) return 'front';
  if (count('clear_hole')) return 'clearing';
  if (count('haze_sheet')) return 'haze';
  if (count('cumulus_field')) return 'cumulus';
  return hasPaint ? 'painted' : 'open';
}

// The state skycaptain-look.moniker reads, from settings.
export function lookMonikerState(settings) {
  return {
    mood: moodFamily(settings.density, settings.ambient, settings.powder, settings.forwardG),
    windKm: Math.hypot(num(settings.windX), num(settings.windZ)),
    erosion: settings.erosion,
    density: settings.density,
    haze: settings.haze,
    sunIntensity: settings.sunIntensity,
    time: timeFamily(settings.sunElevation),
    coverage: settings.coverage,
    typeBias: settings.typeBias,
  };
}

// The state skycaptain-sky.moniker reads, from settings, shapes and whether paint exists.
export function skyMonikerState(settings, shapes, hasPaint) {
  return {
    mood: moodFamily(settings.density, settings.ambient, settings.powder, settings.forwardG),
    haze: settings.haze,
    time: timeFamily(settings.sunElevation),
    coverage: settings.coverage,
    scene: sceneFamily(shapes, hasPaint),
  };
}

// The state keys worked out from several values rather than read from one.
export const DERIVED_STATE = ['mood', 'windKm', 'time', 'scene'];

const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

// suggestion: what a Save dialog offers, made unique with a number when Moniker could not
// (the spec leaves that to the host). fallback: Moniker's name for the state alone, so it
// can be recomputed from the file. tokens: everything that fired, trimmed or not.
function describe(state, vocabulary, existingNames = []) {
  let suggestion = generateName(state, vocabulary, existingNames);
  const taken = (name) => existingNames.some((existing) => sameName(existing, name));
  if (taken(suggestion)) {
    let n = 2;
    while (taken(`${suggestion} ${n}`)) n += 1;
    suggestion = `${suggestion} ${n}`;
  }
  return {
    suggestion,
    fallback: generateName(state, vocabulary),
    tokens: firedTokens(state, vocabulary).map((entry) => entry.token),
    vocabulary: `${vocabulary.id}@${vocabulary.version}`,
  };
}

export function describeLook(settings, vocabulary, existingNames = []) {
  return describe(lookMonikerState(settings), vocabulary, existingNames);
}

export function describeSky(settings, shapes, hasPaint, vocabulary, existingNames = []) {
  return describe(skyMonikerState(settings, shapes, hasPaint), vocabulary, existingNames);
}

// The "moniker" block of a .wcx. The display name stays in the document's own "name":
// the artist's. id is the preset's stable identity, minted once at first save.
export function monikerBlock(id, description) {
  return { id, fallback: description.fallback, tokens: description.tokens, vocabulary: description.vocabulary };
}

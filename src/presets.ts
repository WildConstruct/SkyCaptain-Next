// Look presets: sun, atmosphere, light and cloud character, as .wcx files (kind "look",
// src/wcx.ts). Names are suggested by Moniker (skycaptain-look.moniker) and are
// always the artist's to change. Factory looks are the vibes; user looks live in
// localStorage and download as .wcx. Composition (shapes, paint, graph) is never part of
// a look: that is what a sky .wcx is for (src/document.ts).

import lookVocabulary from './moniker/skycaptain-look.moniker?raw';
import { describeLook, monikerBlock } from './moniker/skycaptain';
import { DEFAULTS, type Settings } from './settings';
import { VIBES } from './vibes';
import { WCX_EXTENSION, header, newId, paramsOf, settingOf, wcxError, type WcxFile } from './wcx';

export const LOOK_VOCABULARY = JSON.parse(lookVocabulary);

/** Settings a look carries. View, quality and the composition of the sky are left out. */
export const LOOK_KEYS = (Object.keys(DEFAULTS) as (keyof Settings)[]).filter(
  (k) => !['ev', 'fov', 'yaw', 'pitch', 'quality', 'seed', 'weatherScale', 'baseWeather', 'evolve', 'eyeAltitude'].includes(k),
);

export interface LookPreset extends WcxFile {
  kind: 'look';
}

const USER_KEY = 'skycaptain.lookPresets.v1';
export const PRESET_EXTENSION = WCX_EXTENSION;

function build(name: string, category: string, values: Partial<Settings>, keys: (keyof Settings)[]): LookPreset {
  const full = { ...DEFAULTS, ...values } as Settings;
  return {
    ...header('look', name, category, monikerBlock(newId(), describeLook(full, LOOK_VOCABULARY))),
    kind: 'look',
    params: paramsOf(full, keys),
  };
}

/** Factory looks: the vibes, carrying only the settings each one changes. */
export const FACTORY: LookPreset[] = VIBES.map((v) =>
  build(v.name, 'Factory', v.settings, Object.keys(v.settings) as (keyof Settings)[]));

export function userPresets(): LookPreset[] {
  try {
    const raw = JSON.parse(localStorage.getItem(USER_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((p) => !wcxError(p)) : [];
  } catch {
    return [];
  }
}

function writeUser(presets: LookPreset[]): void {
  try {
    localStorage.setItem(USER_KEY, JSON.stringify(presets));
  } catch {
    // Storage can be unavailable (private windows); the downloaded .wcx is still the file.
  }
}

export function list(): LookPreset[] {
  return [...FACTORY, ...userPresets()];
}

/** What the Save dialog offers: Moniker's name for this look, unique among saved looks. */
export function suggestName(settings: Settings): string {
  return describeLook(settings, LOOK_VOCABULARY, list().map((p) => p.name)).suggestion;
}

/** A new look from the current settings. A new save is a new preset with a new identity. */
export function capture(settings: Settings, name: string): LookPreset {
  return build(name.trim() || suggestName(settings), 'My looks', settings, LOOK_KEYS);
}

/** Keeps a look in the browser; the same name replaces the older entry. */
export function remember(preset: LookPreset): void {
  writeUser([...userPresets().filter((p) => p.name !== preset.name), preset]);
}

export function forget(name: string): void {
  writeUser(userPresets().filter((p) => p.name !== name));
}

/**
 * Reads untrusted .wcx text. A sky .wcx imports as a look: only its look settings are kept.
 * Returns an error string instead of throwing.
 */
export function parse(text: string, fallbackName = 'Imported look'): { preset: LookPreset | null; error: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { preset: null, error: 'preset file is not valid JSON' };
  }
  const error = wcxError(parsed);
  if (error) return { preset: null, error };
  const p = parsed as Partial<WcxFile>;
  const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim() : fallbackName;
  const params = (p.params ?? []).filter((param) => {
    const key = settingOf(param);
    return key !== null && LOOK_KEYS.includes(key);
  });
  const { sky: _composition, ...rest } = p as Partial<WcxFile> & { sky?: unknown };
  return { preset: { ...(rest as WcxFile), kind: 'look', name, category: 'My looks', params }, error: null };
}

/** Applies a look through the host's setter. Returns params it could not apply. */
export function apply(preset: LookPreset, set: (key: keyof Settings, value: number) => void): string[] {
  const skipped: string[] = [];
  for (const param of preset.params) {
    const key = settingOf(param);
    if (key && LOOK_KEYS.includes(key) && typeof param.value === 'number' && Number.isFinite(param.value)) set(key, param.value);
    else skipped.push(String(param.id ?? param.uuid));
  }
  return skipped;
}

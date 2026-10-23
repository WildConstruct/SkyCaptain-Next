// The WC Preset System Standard (.wcx), as Lumen implements it: one JSON file per preset
// with a format header, a Moniker block and params matched by stable uuid (then by id).
// Every file skyCaptain writes is a .wcx. `kind` says what it holds:
//   look: sun, atmosphere, light and cloud character (src/presets.ts)
//   sky:  a whole sky, every setting plus shapes, paint and the sky graph (src/document.ts)

import type { MonikerBlock } from './moniker/skycaptain';
import type { Settings } from './settings';

export const WCX_EXTENSION = '.wcx';
export const PLUGIN_ID = 'skycaptain' as const;

export type WcxKind = 'look' | 'sky';

export interface WcxParam {
  uuid: string;
  id: keyof Settings;
  value: number;
}

export interface WcxFile {
  _format: 'wcx';
  _plugin: typeof PLUGIN_ID;
  _wcxVersion: 1;
  kind: WcxKind;
  name: string;
  category: string;
  created: string;
  moniker: MonikerBlock;
  params: WcxParam[];
}

/** Stable identities for settings. Never change one: saved files match on it first. */
export const PARAM_UUIDS: Record<Exclude<keyof Settings, 'quality'>, string> = {
  sunElevation: 'e5d9c8ec-50a7-4d3d-a569-693d7425fb7a',
  sunAzimuth: 'b0fcbeb7-2181-4023-9c26-5ae61255b086',
  sunIntensity: '99a6ce63-b8fc-403d-944e-ed66e9055da7',
  haze: 'abf3aace-aa92-4b61-92ad-393599379197',
  groundAlbedo: 'fac9d21f-1f1d-4cd1-b0e8-160331c76656',
  coverage: '11049ed5-af9a-4e40-9dc8-7b4095c0f785',
  typeBias: '8a7c8fd2-0bc7-413e-b84d-64d411e43f6e',
  density: '9d99d704-3a33-4a11-b7af-77794836c042',
  erosion: 'adde0685-c727-4052-a34b-dcf9af1bd7c2',
  cloudBottom: '94b732ba-f57f-4a44-96ca-867e0b6a74f9',
  cloudThickness: '39b79256-c86f-4b12-a1d8-6c492bd11cd8',
  towerHeight: '2a40db4e-f081-4745-8653-4850984d62a8',
  shapeScale: 'b498a91e-8c7b-4463-8e80-ace89e996a77',
  detailScale: '506f3c03-c259-4b05-8596-c7bd3bf49f13',
  weatherScale: 'e660cc98-704b-4295-b007-1060670724e2',
  baseWeather: 'be6a12a5-446a-4420-882a-86ea9ff3dcea',
  windX: 'c3ee47f7-d62c-46c8-b80d-a11e242dfe67',
  windZ: '721b511e-3503-4489-9604-f2c8a2875ca0',
  ambient: 'f831221c-ac54-4d4d-aee3-ae96963c2a2f',
  forwardG: '0ff4fc3e-97b4-4204-a72a-fd8e83909170',
  backG: '3eb721f0-3641-424c-9a59-f5dbe74d6971',
  backWeight: '41471c1f-fa78-4ee8-8e1d-e3d73a0b4f85',
  msA: '110e693a-053d-48e7-89df-4885cb80f974',
  msB: 'c355455b-878f-4bfe-8247-027d1f446b03',
  msC: '7d20703b-9be2-42b2-b4f1-1c9f37b6abc7',
  octaves: '99eb3520-8f8f-4e42-ab3d-3a2ba069d40c',
  powder: '0e1df7bb-0332-429e-9e97-26cdf44fdf8f',
  seed: '1418556b-6c08-4b53-a955-e92946a62558',
  evolve: '563b1dc2-cbed-4790-bb05-644aea19e058',
  grain: '3b9b3bce-eaff-41f1-b035-bd9183d15160',
  softness: 'b33ef0ba-2724-4948-8e59-b460da6b3ebb',
  sceneTime: '7436de65-3130-401a-94da-369a663e5d30',
  eyeAltitude: '836b5b17-42db-46da-9746-68dd39860b93',
  ev: '94ed5b53-2aa0-4bef-b3e3-b7816caa0e07',
  fov: '377bbaf9-8c1a-4d97-90fc-4809b880c6ca',
  yaw: '64ce152b-5a28-4930-9625-e6a872804096',
  pitch: '1d466e5d-9a77-488a-92c7-d370bc83bb86',
};

const BY_UUID = new Map(Object.entries(PARAM_UUIDS).map(([id, uuid]) => [uuid, id as keyof Settings]));

export function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `wcx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function header<K extends WcxKind>(kind: K, name: string, category: string, moniker: MonikerBlock) {
  return {
    _format: 'wcx' as const,
    _plugin: PLUGIN_ID as typeof PLUGIN_ID,
    _wcxVersion: 1 as const,
    kind,
    name,
    category,
    created: new Date().toISOString().slice(0, 10),
    moniker,
  };
}

export function paramsOf(settings: Settings, keys: (keyof Settings)[]): WcxParam[] {
  return keys
    .filter((id): id is Exclude<keyof Settings, 'quality'> => id in PARAM_UUIDS)
    .map((id) => ({ uuid: PARAM_UUIDS[id], id, value: settings[id] as number }));
}

/** Resolves a param to a setting: uuid first, then id. Null when neither is known. */
export function settingOf(param: { uuid?: unknown; id?: unknown }): Exclude<keyof Settings, 'quality'> | null {
  const byUuid = typeof param.uuid === 'string' ? BY_UUID.get(param.uuid) : undefined;
  if (byUuid && byUuid !== 'quality') return byUuid;
  if (typeof param.id === 'string' && param.id in PARAM_UUIDS) return param.id as Exclude<keyof Settings, 'quality'>;
  return null;
}

/** Header checks for untrusted files. Missing metadata is accepted, as in Lumen. */
export function wcxError(file: unknown): string | null {
  const f = file as Partial<WcxFile> | null;
  if (!f || typeof f !== 'object') return 'not a preset';
  if (f._format !== undefined && f._format !== 'wcx') return 'not a .wcx file';
  if (f._wcxVersion !== undefined && f._wcxVersion !== 1) return `unsupported .wcx version ${String(f._wcxVersion)}`;
  if (f._plugin !== undefined && f._plugin !== PLUGIN_ID) return `a ${String(f._plugin)} preset, not a skyCaptain file`;
  if (!Array.isArray(f.params)) return 'file has no parameters';
  return null;
}

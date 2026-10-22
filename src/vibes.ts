// Vibes: one-click looks for sun, atmosphere, light and cloud character. They never touch
// shapes or paint, so a vibe can be tried over any composed sky. Tuned on the Takram cloud
// model with Takram's background weather. Overcast decks want a low density: at the
// default 200/km a 1-2 km deck is too thick for the scattering octaves to carry light
// through, so it goes dim and blue; real overcast is optically much thinner.

import type { Settings } from './settings';

export interface Vibe {
  name: string;
  hint: string;
  settings: Partial<Settings>;
}

export const VIBES: Vibe[] = [
  {
    name: 'Bright midday',
    hint: 'High sun, crisp air, white cumulus',
    settings: { sunElevation: 62, sunIntensity: 22, haze: 70, ambient: 1, forwardG: 0.7, powder: 0.8, density: 200, typeBias: 0 },
  },
  {
    name: 'Golden hour',
    hint: 'Low warm sun, long glowing edges',
    settings: { sunElevation: 6, sunIntensity: 24, haze: 25, ambient: 0.9, forwardG: 0.8, powder: 0.8, density: 200 },
  },
  {
    name: 'Last light',
    hint: 'Sun on the horizon, deep colour, dark undersides',
    settings: { sunElevation: 1.2, sunIntensity: 26, haze: 18, ambient: 0.7, forwardG: 0.88, powder: 0.9, density: 240 },
  },
  {
    name: 'Hazy summer',
    hint: 'Milky sky, soft contrast',
    settings: { sunElevation: 38, sunIntensity: 18, haze: 7, ambient: 1.3, forwardG: 0.65, powder: 0.4, density: 150, erosion: 0.75, coverage: 0.2 },
  },
  {
    name: 'Brooding',
    hint: 'Heavy, dense, dark-bellied clouds under a lower sun',
    settings: { sunElevation: 14, sunIntensity: 16, haze: 22, ambient: 0.55, forwardG: 0.75, powder: 1, density: 400, coverage: 0.34, typeBias: 0.15 },
  },
  {
    name: 'Overcast softbox',
    hint: 'Full thin cover: even, soft light for product work',
    settings: { sunElevation: 45, sunIntensity: 14, haze: 30, ambient: 1.2, forwardG: 0.6, powder: 0.2, density: 30, coverage: 1, typeBias: -0.4, erosion: 0.4 },
  },
];

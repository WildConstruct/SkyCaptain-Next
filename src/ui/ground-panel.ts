// Ground panel: terrain on or off, a new layout, and the recipe's main controls.

import type { GroundStore } from '../ground';
import { TERRAIN_TYPES, type TerrainRecipe } from '../terrain';

type RecipeNumber = 'waterLevel' | 'relief' | 'patchKm' | 'tileKm' | 'heightKm' | 'ridges' | 'snowKm';

const SLIDERS: { key: RecipeNumber; label: string; min: number; max: number; step: number; unit?: string; hint: string }[] = [
  { key: 'waterLevel', label: 'Water', min: 0, max: 0.9, step: 0.01, hint: 'How much low ground is flooded: lakes, then coasts, then sea' },
  { key: 'relief', label: 'Geography', min: 0, max: 1, step: 0.01, hint: 'How strongly height sorts the land (meadow low, forest higher, rock on top); 0 is pure patchwork' },
  { key: 'patchKm', label: 'Patch size', min: 1, max: 30, step: 0.5, unit: 'km', hint: 'Typical size of a forest or a block of fields' },
  { key: 'tileKm', label: 'Tile size', min: 0.2, max: 5, step: 0.1, unit: 'km', hint: 'Grain of the layout; the ground repeats every 128 tiles' },
  { key: 'heightKm', label: 'Height', min: 0, max: 8, step: 0.05, unit: 'km', hint: 'Highest ground: 0 is flat, a few tenths rolling hills, several km mountains' },
  { key: 'ridges', label: 'Ridges', min: 0, max: 1, step: 0.01, hint: 'Rounded hills (0) to sharp ridged ranges (1)' },
  { key: 'snowKm', label: 'Snow line', min: 0, max: 9, step: 0.05, unit: 'km', hint: 'Altitude above which snow lies on gentler slopes' },
];

export class GroundPanel {
  private inputs = new Map<string, { input: HTMLInputElement; value: HTMLElement; unit: string }>();
  private enabled: HTMLInputElement;

  constructor(root: HTMLElement, private store: GroundStore) {
    const toggleRow = document.createElement('label');
    toggleRow.className = 'check';
    this.enabled = document.createElement('input');
    this.enabled.type = 'checkbox';
    this.enabled.onchange = () => store.setEnabled(this.enabled.checked);
    toggleRow.append(this.enabled, ' Terrain');
    toggleRow.title = 'Land cover on the ground (off: plain ground at the Expert albedo)';

    const actions = document.createElement('div');
    actions.className = 'row actions';
    const reroll = document.createElement('button');
    reroll.textContent = 'New layout';
    reroll.title = 'Collapse a new layout from the same recipe';
    reroll.onclick = () => { store.setEnabled(true); store.reroll(); };
    actions.append(reroll);
    root.append(toggleRow, actions);

    const slider = (key: string, label: string, min: number, max: number, step: number, unit: string, hint: string, apply: (v: number) => void) => {
      const row = document.createElement('label');
      row.className = 'row';
      row.title = hint;
      const name = document.createElement('span');
      name.textContent = label;
      const value = document.createElement('span');
      value.className = 'value';
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      // Collapse on release: a drag would recollapse on every step.
      input.onchange = () => apply(Number(input.value));
      input.oninput = () => { value.textContent = `${+Number(input.value).toFixed(2)}${unit}`; };
      row.append(name, value, input);
      this.inputs.set(key, { input, value, unit });
      return row;
    };
    for (const s of SLIDERS) {
      root.append(slider(s.key, s.label, s.min, s.max, s.step, s.unit ?? '', s.hint, (v) => store.update({ [s.key]: v } as Partial<TerrainRecipe>)));
    }

    const mix = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Mix';
    mix.append(summary);
    for (const t of TERRAIN_TYPES) {
      mix.append(slider(`weight.${t}`, t[0].toUpperCase() + t.slice(1), 0, 5, 0.1, '', `How common ${t} is`, (v) =>
        store.update({ weights: { ...store.recipe.weights, [t]: v } })));
    }
    root.append(mix);

    store.subscribe(() => this.sync());
    this.sync();
  }

  private sync(): void {
    const r = this.store.recipe;
    this.enabled.checked = this.store.enabled;
    const show = (key: string, v: number) => {
      const ui = this.inputs.get(key);
      if (!ui) return;
      ui.input.value = String(v);
      ui.value.textContent = `${+v.toFixed(2)}${ui.unit}`;
    };
    for (const s of SLIDERS) show(s.key, r[s.key]);
    for (const t of TERRAIN_TYPES) show(`weight.${t}`, r.weights[t]);
  }
}

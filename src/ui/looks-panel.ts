// Looks: factory vibes and saved looks as chips, plus Save look with a Moniker-suggested
// name the artist can edit, and .wcx import.

import * as presets from '../presets';
import type { Settings } from '../settings';
import { download } from './export-panel';

export class LooksPanel {
  private saving = false;
  private message = '';

  constructor(
    private root: HTMLElement,
    private settings: Settings,
    private set: (key: keyof Settings, value: number) => void,
  ) {
    this.render();
  }

  private render(): void {
    this.root.replaceChildren();
    const chips = document.createElement('div');
    chips.className = 'chips looks';
    for (const preset of presets.list()) {
      const chip = document.createElement('span');
      chip.className = `chip ${preset.category === 'Factory' ? 'factory' : 'user'}`;
      const b = document.createElement('button');
      b.textContent = preset.name;
      b.title = `${preset.category} look · Moniker: ${preset.moniker.fallback}. Keeps shapes and paint.`;
      b.onclick = () => {
        const skipped = presets.apply(preset, this.set);
        this.message = skipped.length ? `Applied ${preset.name}; skipped ${skipped.join(', ')}.` : '';
        if (skipped.length) this.render();
      };
      chip.append(b);
      if (preset.category !== 'Factory') {
        const del = document.createElement('button');
        del.className = 'icon';
        del.textContent = '×';
        del.title = 'Remove from this browser';
        del.onclick = () => { presets.forget(preset.name); this.render(); };
        chip.append(del);
      }
      chips.append(chip);
    }
    this.root.append(chips);

    if (this.saving) {
      const row = document.createElement('div');
      row.className = 'row actions save-look';
      const name = document.createElement('input');
      name.type = 'text';
      name.value = presets.suggestName(this.settings);
      name.setAttribute('aria-label', 'Look name');
      const suggest = document.createElement('button');
      suggest.className = 'icon';
      suggest.textContent = '↻';
      suggest.title = 'Suggest a name from the current look (Moniker)';
      suggest.onclick = () => { name.value = presets.suggestName(this.settings); };
      const save = document.createElement('button');
      save.textContent = 'Save';
      const commit = () => {
        const preset = presets.capture(this.settings, name.value);
        presets.remember(preset);
        download(`${preset.name}${presets.PRESET_EXTENSION}`, JSON.stringify(preset, null, 2), 'application/json');
        this.saving = false;
        this.message = `Saved ${preset.name}.`;
        this.render();
      };
      save.onclick = commit;
      name.onkeydown = (e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') { this.saving = false; this.render(); }
      };
      const cancel = document.createElement('button');
      cancel.textContent = 'Cancel';
      cancel.onclick = () => { this.saving = false; this.render(); };
      row.append(name, suggest, save, cancel);
      this.root.append(row);
      queueMicrotask(() => { name.focus(); name.select(); });
    } else {
      const row = document.createElement('div');
      row.className = 'row actions';
      const save = document.createElement('button');
      save.textContent = 'Save look…';
      save.onclick = () => { this.saving = true; this.message = ''; this.render(); };
      const importButton = document.createElement('button');
      importButton.textContent = 'Import .wcx…';
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = presets.PRESET_EXTENSION;
      input.hidden = true;
      input.onchange = async () => {
        const file = input.files?.[0];
        input.value = '';
        if (!file) return;
        const { preset, error } = presets.parse(await file.text(), file.name.replace(/\.wcx$/i, ''));
        if (preset) {
          presets.remember(preset);
          presets.apply(preset, this.set);
          this.message = `Imported ${preset.name}.`;
        } else {
          this.message = `Could not import ${file.name}: ${error}.`;
        }
        this.render();
      };
      importButton.onclick = () => input.click();
      row.append(save, importButton, input);
      this.root.append(row);
    }
    if (this.message) {
      const note = document.createElement('p');
      note.className = 'hint';
      note.textContent = this.message;
      this.root.append(note);
    }
  }
}

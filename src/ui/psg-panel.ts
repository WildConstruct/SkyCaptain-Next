// Sky graph panel: load a Prompt Spaghetti graph, reroll, and hold parts of the result.

import exampleGraph from '../../examples/weather-regimes.psg?raw';
import { SkyGraph } from '../psg';
import { ShapeStore, labelFor } from '../shapes';

export class PsgPanel {
  constructor(private root: HTMLElement, private graph: SkyGraph, private store: ShapeStore) {
    graph.subscribe(() => this.render());
    store.subscribe(() => this.render());
    this.render();
  }

  private async run(task: () => Promise<unknown>): Promise<void> {
    try {
      await task();
    } catch (err) {
      this.error = String(err instanceof Error ? err.message : err);
      this.render();
    }
  }

  private error = '';

  private render(): void {
    const g = this.graph;
    this.root.replaceChildren();

    const actions = document.createElement('div');
    actions.className = 'row actions';
    const file = document.createElement('input');
    file.type = 'file';
    file.accept = '.psg,application/json';
    file.hidden = true;
    file.onchange = () => {
      const f = file.files?.[0];
      if (f) this.run(async () => { this.error = ''; await g.load(f.name.replace(/\.psg$/, ''), await f.text()); });
    };
    const load = document.createElement('button');
    load.textContent = 'Load .psg…';
    load.onclick = () => file.click();
    const example = document.createElement('button');
    example.textContent = 'Example graph';
    example.title = 'Weather regimes × time of day';
    example.onclick = () => this.run(async () => { this.error = ''; await g.load('weather regimes', exampleGraph); });
    actions.append(load, example, file);
    this.root.append(actions);

    if (this.error) {
      const e = document.createElement('p');
      e.className = 'error-text';
      e.textContent = this.error;
      this.root.append(e);
    }
    if (!g.loaded || !g.last) {
      const hint = document.createElement('p');
      hint.className = 'hint';
      hint.textContent = 'A Prompt Spaghetti graph can roll whole skies: shapes, clouds and sun. Reroll keeps anything you hold.';
      this.root.append(hint);
      return;
    }

    const roll = g.last;
    const caption = document.createElement('p');
    caption.className = 'caption';
    caption.textContent = roll.caption || '(no caption)';
    this.root.append(caption);

    const rerollRow = document.createElement('div');
    rerollRow.className = 'row actions';
    const reroll = document.createElement('button');
    reroll.textContent = 'Reroll sky (R)';
    reroll.onclick = () => this.run(() => g.reroll());
    const meta = document.createElement('span');
    meta.className = 'value';
    meta.textContent = `${g.name} · seed ${roll.seed} · ${roll.graphSha256.slice(0, 8)}`;
    meta.title = `graph sha256 ${roll.graphSha256}`;
    rerollRow.append(reroll);
    this.root.append(rerollRow, meta);

    const holds = document.createElement('ul');
    holds.className = 'layers holds';
    const hold = (label: string, held: boolean, toggle: () => void, title = '') => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.className = 'icon';
      b.textContent = held ? '🔒' : '🔓';
      b.title = held ? 'Held on reroll' : 'Rerolls';
      b.onclick = (e) => { e.stopPropagation(); toggle(); this.render(); };
      const name = document.createElement('span');
      name.textContent = label;
      name.title = title;
      li.append(b, name);
      if (held) li.classList.add('held');
      holds.append(li);
    };
    for (const [id, pick] of Object.entries(roll.picks)) {
      if (!pick.optionId) continue;
      hold(`${pick.name ?? id}: ${pick.text}`, g.lockedChoices.has(id), () => {
        if (g.lockedChoices.has(id)) g.lockedChoices.delete(id); else g.lockedChoices.add(id);
      });
    }
    hold('Sun & sky', g.lockSky, () => { g.lockSky = !g.lockSky; });
    for (const shape of this.store.shapes) {
      if (shape.psgSlot === undefined) continue;
      const slot = shape.psgSlot;
      hold(`Shape ${slot}: ${labelFor(shape.kind)}`, g.lockedSlots.has(slot), () => {
        if (g.lockedSlots.has(slot)) g.lockedSlots.delete(slot); else g.lockedSlots.add(slot);
      }, 'Held exactly as it is now, including hand edits');
    }
    this.root.append(holds);

    if (roll.warnings.length) {
      const w = document.createElement('p');
      w.className = 'hint';
      w.textContent = `Graph warnings: ${roll.warnings.join('; ')}`;
      this.root.append(w);
    }
  }
}

// Tool picker (shape editing or a brush) and the active brush's options.

import { BRUSH_TOOLS, PaintLayers } from '../paint';
import { Mode, ToolState } from './tools';

export class BrushPanel {
  private updaters: (() => void)[] = [];

  constructor(root: HTMLElement, private tools: ToolState, layers: PaintLayers) {
    const picker = document.createElement('div');
    picker.className = 'tools';
    const modes: { mode: Mode; label: string; hint: string; key: string }[] = [
      { mode: 'shapes', label: 'Shapes', hint: 'Select and move shapes; drag sky to look', key: 'V' },
      ...BRUSH_TOOLS.map((b, i) => ({ mode: b.tool, label: b.label, hint: b.hint, key: String(i + 1) })),
    ];
    for (const m of modes) {
      const b = document.createElement('button');
      b.textContent = m.label;
      b.title = `${m.hint} (${m.key})`;
      b.onclick = () => tools.setMode(m.mode);
      picker.append(b);
      this.updaters.push(() => b.classList.toggle('active', tools.mode === m.mode));
    }
    root.append(picker);

    const options = document.createElement('div');
    options.className = 'brush-options';
    const slider = (label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void, unit = '') => {
      const row = document.createElement('label');
      row.className = 'row';
      const name = document.createElement('span');
      name.textContent = label;
      const value = document.createElement('span');
      value.className = 'value';
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.oninput = () => set(Number(input.value));
      row.append(name, value, input);
      this.updaters.push(() => {
        if (document.activeElement !== input) input.value = String(get());
        value.textContent = `${+get().toFixed(2)}${unit}`;
      });
      return row;
    };
    options.append(
      slider('Brush size', 0.5, 40, 0.1, () => tools.brush.size, (v) => tools.setBrush({ size: v }), ' km'),
      slider('Flow', 0.02, 1, 0.01, () => tools.brush.flow, (v) => tools.setBrush({ flow: v })),
      this.only(['cloud', 'scatter'], slider('Max coverage', 0.1, 1, 0.01, () => tools.brush.opacity, (v) => tools.setBrush({ opacity: v }))),
      slider('Hardness', 0, 1, 0.01, () => tools.brush.hardness, (v) => tools.setBrush({ hardness: v })),
    );

    // Cloud type: optional for Cloud, required for Type.
    const typeRow = slider('Cloud type (stratus → towers)', 0, 1, 0.01, () => tools.brush.type ?? 0.5, (v) => tools.setBrush({ type: v }));
    const keepType = document.createElement('label');
    keepType.className = 'check';
    const keepInput = document.createElement('input');
    keepInput.type = 'checkbox';
    keepInput.onchange = () => tools.setBrush({ type: keepInput.checked ? null : 0.5 });
    keepType.append(keepInput, ' Keep existing type');
    options.append(keepType, typeRow);
    this.updaters.push(() => {
      const tool = tools.brush.tool;
      keepType.hidden = tool !== 'cloud';
      keepInput.checked = tools.brush.type === null;
      typeRow.hidden = !(tool === 'type' || (tool === 'cloud' && tools.brush.type !== null));
    });

    const thinRow = document.createElement('label');
    thinRow.className = 'check';
    const thinInput = document.createElement('input');
    thinInput.type = 'checkbox';
    thinInput.onchange = () => tools.setBrush({ thin: thinInput.checked });
    thinRow.append(thinInput, ' Thin instead of thicken');
    options.append(thinRow);
    this.updaters.push(() => {
      thinRow.hidden = tools.brush.tool !== 'density';
      thinInput.checked = tools.brush.thin;
    });

    const clear = document.createElement('button');
    clear.textContent = 'Clear all paint';
    clear.title = 'Removes every brush stroke and smudge (undoable)';
    clear.onclick = () => layers.clearAll();
    const actions = document.createElement('div');
    actions.className = 'row actions';
    actions.append(clear);
    options.append(actions);

    root.append(options);
    this.updaters.push(() => { options.hidden = !tools.painting; });

    tools.subscribe(() => this.refresh());
    this.refresh();
  }

  /** Shows a row only for the given tools. */
  private only(toolsShown: string[], row: HTMLElement): HTMLElement {
    this.updaters.push(() => { row.hidden = !toolsShown.includes(this.tools.brush.tool); });
    return row;
  }

  private refresh(): void {
    for (const update of this.updaters) update();
  }
}

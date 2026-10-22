// Shape layer list and the selected layer's properties.

import { SHAPE_KINDS, ShapeKind, ShapeLayer, ShapeStore, labelFor } from '../shapes';

interface PropSpec {
  key: 'size' | 'aspect' | 'rotation' | 'strength';
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
}

const PROPS: PropSpec[] = [
  { key: 'size', label: 'Size', min: 1, max: 100, step: 0.1, unit: 'km' },
  { key: 'aspect', label: 'Width / length', min: 0.05, max: 1.5, step: 0.01, unit: '' },
  { key: 'rotation', label: 'Rotation', min: -180, max: 180, step: 0.5, unit: '°' },
  { key: 'strength', label: 'Strength', min: 0, max: 1, step: 0.01, unit: '' },
];

export class ShapesPanel {
  private structureKey = '';
  private updaters: (() => void)[] = [];

  constructor(
    private root: HTMLElement,
    private store: ShapeStore,
    private onAdd: (kind: ShapeKind) => void,
  ) {
    store.subscribe(() => this.refresh());
    this.refresh();
  }

  private refresh(): void {
    const key = JSON.stringify([this.store.selected, this.store.shapes.map((s) => [s.id, s.visible, s.type === null])]);
    if (key !== this.structureKey) {
      this.structureKey = key;
      this.build();
    }
    for (const update of this.updaters) update();
  }

  private build(): void {
    this.root.replaceChildren();
    this.updaters = [];
    const store = this.store;

    const add = document.createElement('div');
    add.className = 'chips';
    for (const { kind, label } of SHAPE_KINDS) {
      const b = document.createElement('button');
      b.textContent = `+ ${label}`;
      b.title = `Add a ${label.toLowerCase()} where you are looking`;
      b.onclick = () => this.onAdd(kind);
      add.append(b);
    }
    this.root.append(add);

    const list = document.createElement('ul');
    list.className = 'layers';
    // Topmost layer first, like a layer stack.
    for (const shape of [...store.shapes].reverse()) {
      const li = document.createElement('li');
      li.className = shape.id === store.selected ? 'selected' : '';
      li.onclick = () => store.select(shape.id);
      const eye = document.createElement('button');
      eye.className = 'icon';
      eye.textContent = shape.visible ? '●' : '○';
      eye.title = shape.visible ? 'Hide' : 'Show';
      eye.onclick = (e) => {
        e.stopPropagation();
        store.checkpoint();
        store.patch(shape.id, { visible: !shape.visible });
      };
      const name = document.createElement('span');
      name.textContent = labelFor(shape.kind);
      const del = document.createElement('button');
      del.className = 'icon';
      del.textContent = '×';
      del.title = 'Delete layer';
      del.onclick = (e) => {
        e.stopPropagation();
        store.remove(shape.id);
      };
      li.append(eye, name, del);
      list.append(li);
    }
    if (store.shapes.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = 'No shapes yet. Add one, then drag it in the sky or on the map.';
      list.append(empty);
    }
    this.root.append(list);

    const shape = store.current;
    if (shape) this.buildProperties(shape);
  }

  private buildProperties(shape: ShapeLayer): void {
    const store = this.store;
    const box = document.createElement('div');
    box.className = 'props';
    // Undo replaces shape objects, so updaters look the layer up by id each time.
    const cur = () => store.shapes.find((s) => s.id === shape.id) ?? shape;

    for (const spec of PROPS) {
      const row = document.createElement('label');
      row.className = 'row';
      const name = document.createElement('span');
      name.textContent = spec.label;
      const value = document.createElement('span');
      value.className = 'value';
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(spec.min);
      input.max = String(spec.max);
      input.step = String(spec.step);
      input.onpointerdown = () => store.checkpoint();
      input.onkeydown = () => store.checkpoint();
      input.oninput = () => store.patch(shape.id, { [spec.key]: Number(input.value) });
      row.append(name, value, input);
      box.append(row);
      this.updaters.push(() => {
        const v = cur()[spec.key];
        if (document.activeElement !== input) input.value = String(v);
        value.textContent = `${+v.toFixed(2)}${spec.unit}`;
      });
    }

    // Cloud type: the generator's own profile unless overridden.
    const typeRow = document.createElement('label');
    typeRow.className = 'row';
    const typeName = document.createElement('span');
    const auto = document.createElement('input');
    auto.type = 'checkbox';
    auto.checked = shape.type === null;
    auto.onchange = () => {
      store.checkpoint();
      store.patch(shape.id, { type: auto.checked ? null : 0.5 });
    };
    typeName.append(auto, ' Auto cloud type');
    const typeValue = document.createElement('span');
    typeValue.className = 'value';
    const typeInput = document.createElement('input');
    typeInput.type = 'range';
    typeInput.min = '0';
    typeInput.max = '1';
    typeInput.step = '0.01';
    typeInput.disabled = shape.type === null;
    typeInput.onpointerdown = () => store.checkpoint();
    typeInput.oninput = () => store.patch(shape.id, { type: Number(typeInput.value) });
    typeRow.append(typeName, typeValue, typeInput);
    box.append(typeRow);
    this.updaters.push(() => {
      const t = cur().type;
      typeValue.textContent = t === null ? 'auto' : t < 0.33 ? 'stratus' : t < 0.66 ? 'cumulus' : 'towers';
      if (t !== null && document.activeElement !== typeInput) typeInput.value = String(t);
    });

    const seedRow = document.createElement('div');
    seedRow.className = 'row actions';
    const reroll = document.createElement('button');
    reroll.onclick = () => {
      store.checkpoint();
      store.patch(shape.id, { seed: Math.floor(Math.random() * 10000) });
    };
    seedRow.append(reroll);
    box.append(seedRow);
    this.updaters.push(() => { reroll.textContent = `Reroll shape detail (seed ${cur().seed})`; });

    this.root.append(box);
  }
}

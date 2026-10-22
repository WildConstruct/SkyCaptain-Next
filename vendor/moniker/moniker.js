// Moniker Core: deterministic preset naming from a .moniker vocabulary.
//
// The spec is the Notion page "Moniker — Smart Preset Naming" (Wild Construct
// HQ / Product HQ). Lumen ships the reference implementation. One file, no
// dependencies, no randomness, no network: the same state and vocabulary
// always give the same name, so a name can be recomputed and checked later.
//
// A vocabulary declares slots, each reading one parameter of a plain state
// object and mapping its value to a token:
//   { "range": [lo, hi], "token": "Warm" }   lo <= value < hi; the top of the
//                                            slot's last range is inclusive
//   { "value": "16mm", "token": "16mm" }     exact match
//   "token": null                            neutral, so the slot says nothing
// The first mapping that matches decides the slot. A value outside every
// mapping also says nothing.
//
// Naming walks slot_order, collects the tokens that fire, keeps the required
// ones and then the heaviest of the rest up to max_tokens (the noun counts as
// one; equal weights go to the slot later in slot_order, nearer the noun),
// puts the survivors back in slot_order and appends the noun. The noun is the
// floor: with nothing else firing the name is just the noun.
//
// Composites name a pattern across slots with one word, before trimming:
//   { "token": "Halo", "role": "noun", "requires": { "spread": "Tight" } }
// A composite fires when every slot it requires fired one of the tokens it
// names (a string, or an array of alternatives). Its slots are then spent:
// they no longer appear as words of their own. The first noun composite
// that fires (role "noun", the default) replaces the noun; then each
// adjective composite (role "adjective", with a weight) that fires from
// slots still unspent joins the adjectives, placed where its first slot sat.
//
// On a collision with existingNames, the heaviest token trimming dropped is
// promoted back in, and again, until the name is unique or nothing is left.
// Then the duplicate is returned: disambiguating it is the host's call.
//
// Not implemented yet, because the Lumen vocabulary does not use them: slot
// groups and escalation tokens. A vocabulary that declares them is named as
// if it did not.

function rangeMatches(mapping, value, isLastRange) {
  const [lo, hi] = mapping.range;
  return value >= lo && (value < hi || (isLastRange && value === hi));
}

// The token the slot's mappings give `value`: a string, or null for nothing.
export function slotToken(slot, value) {
  if (value === undefined || value === null) return null;
  const mappings = Array.isArray(slot?.mappings) ? slot.mappings : [];
  let lastRange = -1;
  mappings.forEach((mapping, index) => { if (Array.isArray(mapping.range)) lastRange = index; });
  for (let index = 0; index < mappings.length; index += 1) {
    const mapping = mappings[index];
    if (Array.isArray(mapping.range)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      if (rangeMatches(mapping, value, index === lastRange)) return mapping.token ?? null;
    } else if (Object.hasOwn(mapping, 'value') && mapping.value === value) {
      return mapping.token ?? null;
    }
  }
  return null;
}

// Every token the state fires, in slot_order, before any trimming.
export function firedTokens(state, vocabulary) {
  const fired = [];
  (vocabulary.slot_order ?? []).forEach((name, order) => {
    const slot = vocabulary.slots?.[name];
    if (!slot) return;
    const token = slotToken(slot, state?.[slot.parameter]);
    if (token === null || token === '') return;
    fired.push({
      slot: name,
      token,
      weight: Number.isFinite(slot.weight) ? slot.weight : 1,
      required: slot.required === true,
      order,
    });
  });
  return fired;
}

// The noun and the adjective tokens once composites have fired.
function applyComposites(fired, vocabulary) {
  const bySlot = new Map(fired.map((entry) => [entry.slot, entry]));
  const spent = new Set();
  const composites = Array.isArray(vocabulary.composites) ? vocabulary.composites : [];
  const fires = (composite) => {
    const requires = Object.entries(composite.requires ?? {});
    return requires.length > 0 && requires.every(([slot, wanted]) => {
      const entry = bySlot.get(slot);
      if (!entry || spent.has(slot)) return false;
      return Array.isArray(wanted) ? wanted.includes(entry.token) : entry.token === wanted;
    });
  };
  let noun = typeof vocabulary.noun === 'string' && vocabulary.noun ? vocabulary.noun : null;
  const nounComposite = composites.find((composite) => (composite.role ?? 'noun') === 'noun' && fires(composite));
  if (nounComposite) {
    noun = nounComposite.token;
    for (const slot of Object.keys(nounComposite.requires)) spent.add(slot);
  }
  const added = [];
  for (const composite of composites) {
    if (composite.role !== 'adjective' || !fires(composite)) continue;
    const slots = Object.keys(composite.requires);
    for (const slot of slots) spent.add(slot);
    added.push({
      slot: slots.join('+'),
      token: composite.token,
      weight: Number.isFinite(composite.weight) ? composite.weight : 1,
      required: false,
      order: Math.min(...slots.map((slot) => bySlot.get(slot).order)),
    });
  }
  return { noun, tokens: [...fired.filter((entry) => !spent.has(entry.slot)), ...added] };
}

// Heaviest first; equal weights go to the slot nearer the noun.
function byPriority(a, b) {
  return b.weight - a.weight || b.order - a.order;
}

function assemble(kept, noun) {
  const words = [...kept].sort((a, b) => a.order - b.order).map((entry) => entry.token);
  if (noun) words.push(noun);
  return words.join(' ');
}

const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function generateName(state, vocabulary, existingNames = []) {
  const { noun, tokens: fired } = applyComposites(firedTokens(state, vocabulary), vocabulary);
  const maxTokens = Number.isInteger(vocabulary.max_tokens) && vocabulary.max_tokens > 0
    ? vocabulary.max_tokens : Infinity;
  const budget = maxTokens - (noun ? 1 : 0);

  const kept = fired.filter((entry) => entry.required);
  const optional = fired.filter((entry) => !entry.required).sort(byPriority);
  while (optional.length && kept.length < budget) kept.push(optional.shift());

  let name = assemble(kept, noun);
  while (existingNames.some((existing) => sameName(existing, name)) && optional.length) {
    kept.push(optional.shift());
    name = assemble(kept, noun);
  }
  return name;
}

# Biomes (spec, not built yet)

A biome says what *kind* of place the ground is: alpine lake, coastal heath, desert.
You pick one from a short list, and the ground graph rolls variations inside it. It
replaces hand-tuning ten recipe sliders to get "somewhere believable". It is not a
painting system: the paint map stays as a simple override, and per-layer texture
painting and foliage scatter are out of scope (see the end).

## What a biome is

A small, portable JSON recipe, stored in the sky `.wcx` file next to the terrain recipe,
and usable later by other tools (a foliage scatter tool, for one). It sets five things.

1. **Roles.** The collapse keeps its six land-cover slots, but a biome names them and
   gives each one a colour and a detail style. The slots become roles rather than
   fixed plants:

   | Slot | Role | Temperate example | Desert example |
   |---|---|---|---|
   | water | open water | lake | oasis / salt pan |
   | sand | shore | beach | dune sand |
   | meadow | low ground | meadow | gravel plain |
   | fields | worked or patterned ground | fields | dry wash / scrub |
   | forest | woodland | broadleaf forest | sparse acacia |
   | rock | high ground | rock | sandstone |

   Each role has a **style**, one of the six detail treatments the shader already
   has: `water`, `grain` (sand speckle), `drift` (meadow tonal drift), `parcels` (field
   blocks and furrows), `crowns` (tree canopy and gaps), `stone` (rock mottling). A
   biome can give a role a different style; dry wash could use `drift`, for example.

2. **Mix and layout.** Land-cover weights (how common each role is), patch size, tile
   size, and how strongly height sorts the land (geography). These are today's recipe
   fields, given a default and a roll range.

3. **Relief.** Height, ridges and water level, each a default plus a min–max range for
   rolls. Alpine rolls 2.5–5 km of sharp ridges; farmland rolls 0–0.3 km of soft hills.

4. **Landscape material.** The slope and altitude rules the layered material already
   applies, now set per biome instead of hard-coded:
   - **rock slope:** steepness where vegetation gives way to bare rock;
   - **tree line:** the altitude above which woodland thins to low ground;
   - **snow line**, and the steepest slope snow holds on;
   - **scree:** an optional band below rock faces, in the rock colour, lighter.

5. **Water.** The body colour (deep blue, glacial teal or peaty brown), plus a
   default wind and fetch. A mountain lake is calm with short fetch; a coast is windy
   with long fetch.

The sky is not part of a biome: haze, clouds and sun stay with the sky recipe, so you
can put any sky over any ground.

## The six

Colours are linear albedo, as in `terrain.ts`. Heights are km.

| Biome | Roles: shore / low / worked / woodland / high | Relief | Material | Water |
|---|---|---|---|---|
| **Temperate lakes** (today's default) | beach, meadow, fields, broadleaf, rock | 0–1.5, ridges 0.4, water 0.3 | rock 0.45, tree line 1.6, snow 2.8 | deep blue, 6 m/s, 20 km |
| **Alpine** | gravel shore, alpine meadow (0.12, 0.17, 0.06), pasture, conifer (0.03, 0.05, 0.03), granite | 2.5–5, ridges 0.8, water 0.2 | rock 0.35, tree line 1.9, snow 2.6 on slopes < 0.6, scree on | glacial teal (0.01, 0.035, 0.035), 3 m/s, 5 km |
| **Coastal heath** | beach, heather (0.11, 0.08, 0.08), grazing, scrub woodland, cliff rock | 0–0.4, ridges 0.3, water 0.6 | rock 0.4, no snow | deep blue, 10 m/s, 300 km |
| **Desert** | dune sand (0.45, 0.36, 0.24), gravel plain (0.28, 0.24, 0.20), dry wash, sparse acacia, sandstone (0.38, 0.24, 0.16) | 0–1.2, ridges 0.5, water 0.05 | rock 0.3, no snow, no tree line | pale green-blue, 4 m/s, 2 km |
| **Tundra / boreal** | gravel shore, moss (0.12, 0.13, 0.08), bog (`drift`), spruce (0.03, 0.045, 0.03), lichen rock | 0–0.8, ridges 0.3, water 0.4 | rock 0.45, tree line 0.6, snow 1.0 | peaty brown (0.02, 0.022, 0.012), 7 m/s, 15 km |
| **Farmland plains** | river bank, pasture, wheat and ploughed fields (heavy weight), hedgerow woods, few rocks | 0–0.3, ridges 0.1, water 0.1 | rock 0.5, no snow | murky green, 3 m/s, 3 km |

Maybe later: savanna, Mediterranean coast and volcanic. Each is just another JSON entry.

## How it works in the app

- **Ground panel:** a Biome dropdown above New layout. Choosing a biome sets the recipe
  from its defaults. The sliders still adjust everything; once you move one, the
  dropdown shows "Temperate lakes (edited)".
- **New layout** rolls the seed and, within the biome's ranges, relief and water level.
  The look stays in the biome; the place changes.
- **Ground graph:** a `ground.biome` variable, so a sky graph can say "an alpine lake at
  dawn" and roll it.
- **Paint map:** unchanged. The chips show the biome's role names ("Dune sand", not
  "Sand").
- **Files:** a `.wcx` stores the biome's id and the resolved recipe, so a file opens the
  same even if the built-in biome is later retuned.

## What changes in code (about 1–2 days)

- `src/biomes.ts`: the six biomes as data, `parseBiome()` for untrusted JSON, and
  `applyBiome(recipe, biome, rng)` for rolls.
- `TerrainRecipe` gains `biome` (an id), role names, a style per role, and the
  material rules (rock slope, tree line, snow slope, scree).
- `ground.wgsl`: the per-type `switch` keys on the role's style instead of the slot.
  `layered_albedo` in `clouds.wgsl` reads the material rules from the `Ground`
  uniform instead of constants (one more vec4 there).
- Ground panel dropdown, the PSG variable, a unit test that every biome parses and
  rolls in range, and the ground smoke test switching biome.

## Not in scope

- **Per-layer texture painting** (Brushify style): the ground sits 200 m+ away and is
  often out of focus, so the result would not show.
- **Foliage and object scatter:** this belongs to a separate tool (After Effects / VFX
  scatter). Two things are meant to carry over to it: the biome format (roles, colours,
  slope and altitude rules), and the collapse and graph rolls. To keep that path open,
  a biome role may carry an optional `cover` block (vegetation density, typical
  height) that skyCaptain ignores and a scatter tool would read.
- Towns, roads and rivers (left to nature for now, as agreed).

## Questions for you

1. Are these the right six? Something you shoot often may be missing: tropical
   coast, Mediterranean, or Pacific Northwest.
2. Should rolls stay inside one biome, or should the ground graph also be able to pick
   the biome itself ("somewhere coastal")?
3. Should the `cover` block exist now, or wait until the scatter tool is real?

# Lightning

Status: v1 built (clock, channel, visible bolt, cloud flash, ground flash; storm-cell
strikes; Lightning panel). Still to come: a frozen strike for stills and HDRI, per-cell
rates, and a Lightning paint channel.

## Design

Lightning for storm skies and clips. What we take from Ethera, and what has to differ
because skyCaptain lights a whole sky from a fixed eye.

## From Ethera (`engine/stack/lightning.mjs`, `interpreter.wgsl` `bolt_*`)

- **The strike clock**, ported as is. A leader grows over Grow Time, then the return
  stroke flashes and fades. Restrikes run down the same channel, each 0.72 as bright as
  the last, at seeded gaps, with flicker on top. Everything is a pure function of scene
  time and seed, so a frame renders the same however playback reached it: scrubbing,
  the render queue and loops all agree.
- **The channel shape:** a straight line plus four octaves of seeded smooth noise
  sideways, pinned at both ends, with seeded branches leaving at random heights and the
  leader's tip brighter as it grows.

## What differs here

Ethera draws the bolt as a glowing density evaluated at every march step, against 36
segments and up to 8 branches. That suits one hero element in a small volume. Across a
whole sky cube, at every step of every texel, it is far too costly, and it also leaves
out the main event in a storm: the cloud lighting up from inside. So:

1. **The channel is built on the CPU, once per frame.** It becomes a polyline in world
   km (about 150 points with branches), uploaded with the clock's growth and
   brightness. The noise path is the same function, run in TypeScript.
2. **The visible bolt: once per view ray, not per step.** For each cube texel, find the
   ray's closest approach to the channel (a cheap test, skipped outside the bolt's
   bounding cone), add a hot core and a soft halo, and dim them by the clouds in front:
   the march records its transmittance as it passes the bolt's depth. A bolt inside a
   cloud therefore shows only as glow, and a cloud-to-ground bolt below the base shows
   crisp.
3. **The flash in the cloud.** At march samples within a few km of the channel, light
   from a handful of points along it is added through a short optical-depth march, plus
   a diffuse term that falls off softly (light diffusing through the cloud, as Takram's
   multiple-scattering octaves do for the sun). This is the sheet-lightning look: the
   whole cell glows, brightest near the channel. It only costs anything during the
   frames a bolt is lit.
4. **Ground and water:** the bolt lights the ground near it as a few point lights, and
   the water mirrors the bolt and the lit cloud for free, since the mirror samples the
   cube.

## Directing it

- **Where:** strikes come from storm-cell shape layers, at a seeded spot under each
  cell, rate set per cell. A Lightning paint channel could come later.
- **What kind:** a mix of cloud-to-ground (base to ground, branching downward) and
  in-cloud (horizontal, hidden inside the cloud, only the glow shows).
- **When:** strikes per minute, seed, and the strike clock's settings (grow time,
  restrikes, fade, flicker). Animation drives it through scene time, and clips render
  each frame converged, as now.
- **Stills and HDRI:** a "strike" setting picks a moment, such as peak brightness of
  strike N, so an export can hold a frozen bolt.
- **Colour and energy:** a return stroke is a blue-white plasma, about 30 000 K. Its
  brightness is in scene-linear units against the sun, so exposure and bloom treat it
  honestly; a bolt in frame will clip and bloom, as on film.

## Order

1. Port the strike clock with its tests, and build the channel geometry on the CPU.
2. The visible bolt (step 2 above), so strikes can be judged in motion.
3. The cloud flash (step 3), the biggest look win and the main cost to measure.
4. Ground and water flash, controls on storm cells, and storm studies with lightning
   for the 4090.

## Needed first: storms that read as storms

Storm skies need fixing before lightning will look right. An overcast deck currently lights
its base with full blue skylight (the skylight term is not dimmed by the cloud above),
so overcast reads blue instead of grey. Storm towers also come out bright and creamy
rather than dark-bellied. Those are fixed first, checked against the path-traced
reference.

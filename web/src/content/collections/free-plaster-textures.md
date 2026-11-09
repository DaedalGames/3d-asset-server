---
title: Free plaster and stucco textures (PBR)
description: Free seamless plaster, stucco and painted wall PBR textures with colour, normal and roughness maps, mostly CC0, for Blender, Unity, Unreal and Three.js.
hub: textures
search:
  q: plaster
  types: [material, texture]
  free: true
aliases: [plaster texture, stucco texture, plaster wall texture, painted wall texture]
related: [free-concrete-textures, free-brick-textures, free-stone-textures, free-tile-textures]
faq:
  - q: What is the difference between plaster and stucco textures?
    a: Plaster usually describes smooth or lightly trowelled interior walls, while stucco is a rougher, often exterior finish. In practice, sites label them loosely, so check the preview and the normal map to see how much surface relief there is.
  - q: Can I use plaster textures for interior walls in a game?
    a: Yes. A 1K or 2K tileable material with colour, normal and roughness maps is enough for most walls. Add a second material or decals for stains, cracks and damp to break up the repetition on large surfaces.
addedAt: 2026-11-09
addedBy: agent
---

Plaster is the everyday wall surface of houses, shops, corridors and old town streets. Smooth, cracked, painted or crumbling, it gives a scene a believable backdrop without drawing attention to itself, which makes it one of the most reused materials in architectural visualisation and games.

The materials on this page are found by searching the texture sites at once, so you can compare plaster, stucco and rendered wall materials from different libraries in one place. Each card shows its source and licence; many are CC0, which means you can use them in commercial projects without credit.

## Choosing a plaster material

- **Look at the normal map.** Plaster is mostly about subtle relief. A good material has trowel marks or fine grain, not a flat photo.
- **Check the roughness.** Painted plaster is fairly matte, while polished lime plaster can have a soft sheen.
- **Pick the resolution to suit the use.** 1K or 2K is usually enough for games and web scenes; go to 4K for close-up renders.
- **Mind the scale.** Most wall materials cover about one to two metres per tile, so set the UV scale to match your walls.

In Blender, plug the colour map into Base Colour, the roughness map into Roughness, and the normal map through a Normal Map node. In Three.js, Godot, Unity and Unreal, assign the same maps in the standard material slots; remember that Unreal expects DirectX-style normals.

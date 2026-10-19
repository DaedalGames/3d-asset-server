---
title: Free sand and soil textures (PBR)
description: Free seamless sand, dirt and soil PBR textures with colour, normal, roughness and displacement maps up to 8K, mostly CC0, from Poly Haven, ambientCG and more.
hub: textures
search:
  q: sand
  types: [material, texture]
  free: true
aliases: [sand texture, beach sand texture, desert sand texture, sand pbr]
related: [free-grass-textures, free-rock-3d-models, free-concrete-textures, free-sky-hdris]
faq:
  - q: Are these sand textures tileable?
    a: Most PBR material libraries publish seamless maps, so sand can cover a large beach or desert terrain. Break up repetition with a larger-scale noise mask, a second material blended in, or scattered rocks and plants.
  - q: How do I make sand look right in a renderer?
    a: Use the roughness map rather than a flat value, since sand is rough but has glittering grains. The normal map carries ripples and grain, and displacement adds real dunes or footprints in Blender or Unreal.
addedAt: 2026-10-19
addedBy: agent
---

Sand and soil textures cover beaches, deserts, dirt paths, riverbanks, farmland and the ground under almost any outdoor scene. They are the base layer for terrain, and a good one has fine grain, soft ripples and slight colour variation rather than a flat tan.

The materials on this page come from several texture sites searched at once, refreshed automatically. Each card shows its source and licence.

## Choosing a ground material

- **Scale.** Sand grains are tiny, so check how much ground one tile covers. Terrain usually wants a material covering several metres per tile.
- **Maps.** Colour, normal and roughness are enough for most games. Displacement adds real depth for dunes and tracks in offline renders.
- **Wet or dry.** Wet sand is darker and glossier; look for it if your scene has a shoreline.
- **Terrain blending.** In Godot, Unity or Unreal, use several materials on a terrain and blend them by a splat map: sand to grass, grass to rock.

Pair these with the grass and rock collections to build a complete outdoor landscape.

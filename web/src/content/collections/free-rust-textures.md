---
title: Free rust textures (PBR)
description: Free seamless rust and corroded metal PBR textures with colour, normal, roughness and metalness maps up to 8K, mostly CC0, from Poly Haven, ambientCG and more.
hub: textures
search:
  q: rust
  types: [material, texture]
  free: true
  exclude: ["Wooden Planks", "concrete wall", "Graffiti", "Rustic", "chicken wire", "Metal Base", "Metal Pattern", "Metal Corrugated", "Corrugated Iron"]
aliases: [rust texture, rusty metal texture, corroded metal texture, rust pbr]
related: [free-metal-textures, free-concrete-textures, free-sci-fi-game-assets, free-brick-textures]
faq:
  - q: Do rust textures need a metalness map?
    a: Usually yes. Bare steel is metallic and the rust on top of it is not, so a good rust material has a metalness map that switches between the two. If a material has none, set metalness by hand and use the roughness map for the rest.
  - q: How do I stop a rust texture from looking repetitive?
    a: Blend it with a second material using a mask or vertex colours, add decals for streaks and stains, and vary the texture scale between objects. Rust patches are very recognisable, so large tiled surfaces show repeats quickly.
addedAt: 2026-10-12
addedBy: agent
---

Rust is the quickest way to make a scene look lived in: old pipes, shipping containers, abandoned vehicles, fences, industrial props and post-apocalyptic game levels. A good rust material mixes bare metal, flaking paint and orange corrosion, so the surface reads as worn rather than simply dirty.

This page searches the texture sites at once and lists free rust and corroded metal materials, refreshed automatically. Each card shows its source and licence; check the licence before shipping, because not every source uses CC0.

## What to look for

- **Metalness map.** Rust is not metallic but the steel beneath is, so the best materials include a metalness map. Check that the map is included before you download.
- **Height or displacement.** Pitting and flaking paint look far better with a height map, used for parallax or tessellation.
- **Resolution.** 1K or 2K is enough for game props and web scenes. Go to 4K or 8K for close-up renders.
- **Normal map format.** Blender, Three.js, Godot and Unity use OpenGL-style normals; Unreal Engine uses DirectX-style. Flip the green channel if the pits look raised.

Combine rust with plain metal, concrete or brick materials from the related collections, and mask between them for believable wear.

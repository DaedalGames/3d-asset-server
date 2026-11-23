---
title: Free bark textures (PBR)
description: Free seamless tree bark PBR textures for games and renders, with colour, normal and roughness maps, mostly CC0, from Poly Haven, ambientCG, CGBookcase and more.
hub: textures
search:
  q: bark
  types: [material, texture]
  free: true
aliases: [bark texture, tree bark texture, tree trunk texture, bark pbr]
related: [free-wood-textures, free-low-poly-trees, free-plant-3d-models, free-forest-hdris, free-stone-textures]
faq:
  - q: Are bark textures seamless?
    a: Most PBR bark materials tile in both directions, so they can wrap a trunk without visible seams. Photo packs on sites such as OpenGameArt are sometimes not tileable, so check the preview before using one on a large surface.
  - q: How do I texture a tree trunk with a bark material?
    a: Unwrap the trunk so the UVs run along its length, then scale the material so the bark pattern looks right at its real size. Most bark photos cover roughly half a metre to a metre. Blend in moss or dirt near the roots to hide repetition.
  - q: Do I need a displacement map for bark?
    a: For distant or real-time trees, colour, normal and roughness maps are enough. Bark has deep ridges, so close-up renders benefit from a displacement or height map, which Blender, Unreal and Unity can use with tessellation or parallax mapping.
addedAt: 2026-11-23
addedBy: agent
---

Bark is the skin of a tree, and it varies far more than most people expect: deep furrowed oak, papery birch, scaly pine and smooth beech all look different up close. A convincing trunk needs a bark material with real depth in the ridges and roughness that separates dry outer bark from damp crevices.

This page searches many texture sites at once, including Poly Haven, ambientCG, CGBookcase, ShareTextures and TextureCan, plus stylised bark from sources such as FreeStylized and 3DTextures.me. It refreshes automatically, and each card shows its source and licence. Most PBR materials are CC0, but check each card before shipping.

## Choosing a bark material

- **Match the species.** Pine, birch and willow bark look very different, so pick the one that suits the tree you are building.
- **Realistic or stylised.** Photographic scans suit renders and realistic games. Hand-painted bark fits low-poly trees and stylised worlds better.
- **Resolution.** 1K or 2K is usually enough for game trees. Use 4K or more for hero trees seen close up.
- **Normal map format.** Blender, Three.js, Godot and Unity use OpenGL-style normal maps, and Unreal Engine uses DirectX-style. Flip the green channel if the ridges look inverted.

For a complete forest, combine bark with low-poly or realistic tree models and forest HDRIs from the related collections.

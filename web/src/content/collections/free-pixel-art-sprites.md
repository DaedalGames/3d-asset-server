---
title: Free pixel art sprites and tilesets
description: Free pixel art sprites, tilesets and 2D game packs as PNG sheets for Godot, Unity and Phaser, with clear licences, from OpenGameArt, itch.io and Kenney.
hub: game-assets
search:
  q: pixel art
  types: [sprite, pack]
  free: true
aliases: [pixel art sprites, pixel art tileset, 2d sprite pack, pixel character sprites]
related: [free-game-ui-kits, free-dungeon-game-assets, free-medieval-game-assets, free-space-game-assets]
faq:
  - q: What size should pixel art sprites be?
    a: Common tile sizes are 16x16, 32x32 and 64x64 pixels. Pick one size for the whole game and keep every pack at the same size, because scaling pixel art by a non-integer factor makes it blurry.
  - q: How do I keep pixel art sharp in my engine?
    a: Turn off texture filtering. Use nearest-neighbour filtering in Godot, Point (no filter) in Unity, and pixelArt or roundPixels in Phaser. Scale by whole numbers, such as 2x, 3x or 4x.
addedAt: 2026-11-16
addedBy: agent
---

Pixel art sprites are small hand-drawn images used for characters, enemies, items and tiles in 2D games. Free packs usually arrive as PNG sprite sheets or tilesets, sometimes with animation frames, and cover platformers, top-down RPGs, roguelikes and puzzle games.

This page gathers free pixel art packs from several sites with one live search, refreshed automatically. Each card shows its source and licence. Creators on itch.io set their own terms, so check the licence before you ship.

## What to look for

- **Consistent tile size.** Packs drawn on the same grid, such as 16x16, fit together without rescaling.
- **Animation frames.** Walk, idle and attack cycles save a lot of work for characters.
- **Tilesets and backgrounds.** A tileset with matching parallax backgrounds gives a level its look quickly.
- **Licence.** CC0 needs no credit. Other licences may require attribution or forbid redistributing the sheets.

Import the sheets as sprite atlases, set the filter to nearest, and slice them by the grid size. Tiled and the built-in tilemap editors in Godot and Unity read most tilesets directly.

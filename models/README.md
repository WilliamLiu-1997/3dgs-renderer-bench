Place `Elevator.ply`, `HotelFareza.ply` and `WillaGlobalPoland.ply` here, or set their paths in `harness/config.json`.

The PLY files are local inputs and are excluded from Git and deployment.
All three model hashes, sizes and point counts are in `report/input-manifest.json`.
The WillaGlobalPoland count, SHA-256 and initial camera are in `WillaGlobalPoland.json`.

Run `npm run models:sog` to produce matching `.sog` files with splat-transform 3.6.4 (GPU 0, 10 SH clustering iterations). Full counts and SH3 are retained, with 65,536-entry SH codebooks. `models/sog-manifest.json` records hashes, sizes and conversion settings and lets unchanged conversions be skipped. Generated SOGs and the working manifest are local; publishing includes their metadata in `report/input-manifest.json`.

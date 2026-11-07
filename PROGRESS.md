# Progress log

- 2026-11-06: Pulled movement, controls and timing constants out of the supplied SWF's game logic (no art, sound or code copied).
- 2026-11-06: Built `projects/ricochet-arena-server` (shared deterministic sim, ws server, canvas client with prediction and interpolation). 14 tests pass, plus a two-browser Playwright smoke run. Status: done.
- 2026-11-06: Built `projects/ricochet-arena-p2p` (static files + WebRTC via PeerJS, host-authoritative room in the host browser, Worker-driven tick, two data channels, host handover). 4 unit tests and 8 real-WebRTC e2e checks pass. Status: done.
- 2026-11-06: Added Dockerfile (tested locally: page and WebSocket gameplay work in the container) and a GitHub Actions workflow publishing ghcr.io/vibatwork/ricochet-arena (amd64+arm64).
- 2026-11-07: Fixed the cannon-ball limit to 1 (the original's default `settingsMaxBullets`; I had wrongly assumed 5). Added power-up crates with the original's timers and its 4 default weapons (laser + sight line, frag bomb, gatling, homing missile) to both versions. Server announces mazes by last-sent seed. 24 server tests, 4 P2P unit tests and 8 P2P WebRTC checks pass; visual check of every weapon in Chromium.
- 2026-11-07: Power-ups closer to the original: target-coloured missile smoke, shards through walls, flickering laser sight, smoke clouds and screen shake on bursts. 26 server tests and P2P tests/e2e pass.

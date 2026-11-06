# Progress log

- 2026-11-06: Pulled movement, controls and timing constants out of the supplied SWF's game logic (no art, sound or code copied).
- 2026-11-06: Built `projects/ricochet-arena-server` (shared deterministic sim, ws server, canvas client with prediction and interpolation). 14 tests pass, plus a two-browser Playwright smoke run. Status: done.
- 2026-11-06: Built `projects/ricochet-arena-p2p` (static files + WebRTC via PeerJS, host-authoritative room in the host browser, Worker-driven tick, two data channels, host handover). 4 unit tests and 8 real-WebRTC e2e checks pass. Status: done.

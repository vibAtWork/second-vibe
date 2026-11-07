# Blocked

Nothing blocked so far.

Notes:
- Erlang `:crypto.crypto_update/2` costs ~490 ns per call on this box (measured
  with a microbenchmark), against ~20–50 ns for a native AES block. FF1 needs
  ≥21 AES calls per operation, so the Elixir port is bound by NIF overhead. This
  is a platform limit, not a bug. A batched-NIF or Rustler-based AES would be
  the way around it (see BACKLOG).

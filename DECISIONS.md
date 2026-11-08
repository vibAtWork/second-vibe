# Decisions

- **Project name/location**: `projects/tablescrub` (per AGENTS.md layout). Maven, Java 21 (installed JDK).
- **Javalin 6.7 rather than 7.x**: 7 is newer, but 6 is the mature and widely documented line. Moving up later is straightforward.
- **Thymeleaf as the template engine**: natural-HTML templates, and named fragments map directly onto htmx partial swaps (`engine.process(name, Set.of(fragment), ctx)`). Used directly rather than through javalin-rendering, to have one less moving part.
- **htmx from a WebJar, not a CDN**: research environments are often offline or locked down, and this keeps a strict CSP possible.
- **IR = canonical strings + typed column metadata**: lossless for CSV-style data and simple to reason about. Dates become ISO and booleans true/false. Numbers keep their source text (trailing zeros can signal measurement precision), so the round-trip tests compare numbers by value for Excel and JSON.
- **Privacy by default**: suggested treatments are pre-selected on upload. The user can reset with "Keep all".
- **Keyed hash = HMAC-SHA256** with a random per-upload key, or a user-supplied secret for linking files. A plain hash of a CPR number is brute-forceable.
- **Unique record IDs are not auto-marked as quasi-identifiers**: they are pseudonymised, and as QIs they would force k = 1.
- **In-memory storage with a TTL**: avoids leaving sensitive files on disk. The trade-off is a size limit (documented).
- **No auth or CSRF**: binds to 127.0.0.1 by default. Shared deployment should go behind an authenticating proxy (backlog item).
- **Header keyword "name"** only counts as personal when it stands alone or next to a person word, to avoid flagging "gene name", "product name" and similar.
- **GDPR layer (user request)**: special-category tags (Art. 9 / 10 / 87) are separate from the identifier flags, because Art. 9 data such as a diagnosis is not identifying in itself but raises the legal bar. The output status is derived from what remains after treatment (direct identifiers kept → personal; hashes/pseudonyms → pseudonymised, Art. 4(5) / Recital 26; no k assessment or k below target → at risk; otherwise an anonymisation candidate). The checklist depends on the chosen recipient.
- **No case-law claims in the app**: the guidance only cites articles and recitals of Regulation (EU) 2016/679, with a disclaimer to consult the DPO, because the official text could not be fetched from this session (see BLOCKED.md).
- **Health data read broadly** (blood pressure, BMI, HbA1c, smoking count as health data), but generic words like "condition", "procedure" and "party" are excluded to avoid false positives in experimental-design data.

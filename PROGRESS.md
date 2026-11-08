# Progress

| time (UTC) | what | status | where |
|---|---|---|---|
| 2026-11-08 23:00 | Bootstrapped bookkeeping; user asked for a Javalin + htmx tabular redaction webapp | done | repo root |
| 2026-11-08 23:20 | tablescrub core: readers (CSV/TSV/XLSX/XLS/JSON/JSONL), profiler, PII detector, redactor with k-anonymity, 9 export formats, htmx UI, JSON API | done, 28 tests pass | projects/tablescrub |
| 2026-11-08 23:30 | Browser end-to-end check with Playwright (upload → edit → live preview → 5 downloads, no console errors); fixed static mount, template recursion, QI default for record IDs, boolean canonicalisation | done | projects/tablescrub |
| 2026-11-08 23:35 | README, shaded jar (`java -jar`), synthetic sample cohort generator | done | projects/tablescrub |
| 2026-11-08 23:55 | GDPR layer: Art. 9/10/87 detection, live status (personal / pseudonymised / at risk / anonymisation candidate), recipient-specific checklist, GDPR notes in all exports; 4 new tests (32 total) | done | projects/tablescrub |
| 2026-11-08 23:45 | Docker image: multi-stage Dockerfile (tests run in the build), non-root, health check, docker-compose with hardening; verified build + run + browser e2e against the container | done | projects/tablescrub/Dockerfile |

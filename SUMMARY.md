# Summary

## Built this session

**tablescrub** (`projects/tablescrub/`): a Javalin + htmx web app for preparing tabular research data
to share with another institution or with an AI assistant.

- Reads CSV/TSV (delimiter and encoding detected), Excel (all sheets), JSON and JSON Lines into one common table model.
- Flags likely personal data (names, CPR/SSN, e-mail, phone, IP, IBAN, free text, dates of birth, postcodes…) and pre-selects treatments.
- Per-column treatments: drop, mask, keyed hash (HMAC, linkable across files with a shared secret), pseudonym, generalise, suppress rare, round. Columns can also be renamed and described.
- Live k-anonymity check over chosen quasi-identifiers, with optional row suppression.
- Re-creates the table in 9 formats: CSV, TSV, Excel, JSON, JSON Lines, SQL, HTML, Markdown-for-AI, Frictionless Data Package. Every export includes a data dictionary and a redaction log.
- **GDPR-aware**: tags Art. 9 special categories, Art. 10 and Art. 87 data; shows a live status (personal / pseudonymised / at risk / anonymisation candidate); and gives a recipient-specific checklist (EEA partner, outside the EEA, AI service, public, internal). All exports include it.
- JSON/multipart API (`/api/inspect`, `/api/redact`) for pipelines.
- 32 tests: readers, profiler, detector, redactor, format round trips, HTTP endpoints. Browser end-to-end check done with Playwright.

## Try it

```bash
cd projects/tablescrub && mvn package && java -jar target/tablescrub-0.1.0.jar   # then open http://127.0.0.1:7070, upload samples/cohort.csv
```

## Review first

1. `src/main/java/tablescrub/io/PiiDetector.java`: the keyword lists and thresholds decide what gets flagged.
2. `src/main/java/tablescrub/redact/Redactor.java`: the treatments and the k-anonymity logic.
3. `src/main/java/tablescrub/redact/GdprAssessment.java`: check the legal wording with your DPO. The official text could not be fetched here (BLOCKED.md).
4. README "Security and privacy notes": there is no auth, so it is localhost-only unless placed behind a proxy.

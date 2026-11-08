# Backlog

Prioritised. Done items are struck through.

1. ~~tablescrub: Javalin + htmx app: upload tabular files → common IR → per-column redaction → multi-format export~~ (projects/tablescrub)
2. tablescrub: save/load a redaction plan as JSON in the UI, so a monthly delivery can reuse the same choices (the API already accepts plans)
3. tablescrub: multi-table delivery: redact several files with one linkage secret, export one Data Package with several resources
4. tablescrub: read SPSS `.sav` / Stata `.dta` (common in social science and epidemiology), keeping value labels as a codebook
5. tablescrub: read ODS and Parquet; write Parquet
6. tablescrub: l-diversity check for a chosen sensitive column alongside k-anonymity
7. tablescrub: date shifting per pseudonymised subject (keeps intervals, hides real dates)
8. tablescrub: "AI context budget" option for Markdown export: sample N rows + summary statistics when the table is too large to paste
9. tablescrub: Dockerfile + example reverse-proxy config (OIDC) for running it as a shared institutional service
10. tablescrub: dictionary import: upload an existing codebook CSV to fill in column descriptions
11. CLI wrapper around the same core (`tablescrub redact in.xlsx --plan plan.json --format datapackage`)
12. Validate exported datapackage.json against the official Frictionless JSON schema in tests
13. tablescrub: re-check GDPR article references against EUR-Lex once the host is reachable (BLOCKED.md)
14. tablescrub: one-click "anonymise for AI" preset (drop identifiers, generalise QIs until k ≥ target, aggregate option)
15. tablescrub: national-law profiles (e.g. Danish Databeskyttelsesloven rules for CPR numbers) as optional checklist add-ons

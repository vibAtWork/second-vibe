# Decisions

- **aes-gcm-bench uses a C harness, not only `openssl speed`.** `openssl speed` streams without per-message init, so comparing it to Java's `Cipher.init`+`doFinal` would be unfair. The C harness copies the Java steps exactly. `openssl speed` stays in as a reference ceiling.
- **Key is passed on every init in the main C row.** This matches Java `Cipher.init`, which recomputes the key schedule. A `--no-rekey` row shows how OpenSSL performs when used the optimal way.
- **Hand-rolled timing loop instead of JMH.** It needs no Maven or Gradle and no network access, so it's easy to run on a laptop. It's noisier, so I added `--repeat` (best-of-N).
- **Bash + awk for driving and reporting** (no Python dependency) to keep the requirements minimal.
- **Docker image is pushed from GitHub Actions to GHCR, not from the session.** The session has no registry credentials. The workflow uses the built-in `GITHUB_TOKEN`, so no secrets are stored. The image is multi-arch (amd64 and arm64) so it also runs on ARM laptops.
- **`:latest` is pushed from any branch that changes the project.** This makes the image usable right away from the feature branch. It's a single-project image, so there's no risk of clobbering anything else.

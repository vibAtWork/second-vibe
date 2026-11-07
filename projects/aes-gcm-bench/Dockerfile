# AES-GCM benchmark: Java (SunJCE) vs OpenSSL, ready to run.
#   docker run --rm -t ghcr.io/vibatwork/aes-gcm-bench            # full run (-t = colours + live progress)
#   docker run --rm -t ghcr.io/vibatwork/aes-gcm-bench --quick    # ~30s
# Any run.sh option can be appended. To keep the CSV on your machine:
#   docker run --rm -t --user "$(id -u):$(id -g)" -v "$PWD/results:/app/results" ghcr.io/vibatwork/aes-gcm-bench
#
# Toolchain: JDK 27 (early access; GA is due March 2027), GCC 16, Debian trixie's OpenSSL 3.5.
# Override at build time, e.g.  --build-arg JDK_IMAGE=openjdk:27-ea-35-jdk  --build-arg GCC_IMAGE=gcc:15-trixie

ARG JDK_IMAGE=openjdk:27-ea-34-jdk
ARG GCC_IMAGE=gcc:16.2-trixie
ARG RUNTIME_IMAGE=debian:trixie-slim

# --- Java harness + report, compiled with JDK 27 --------------------------------
FROM ${JDK_IMAGE} AS jdk
WORKDIR /src
COPY java/ java/
RUN mkdir -p build && javac -d build java/GcmBench.java java/Report.java \
    && cp -a "$(dirname "$(dirname "$(readlink -f "$(command -v javac)")")")" /opt/jdk

# --- C harness, compiled with GCC 16 against trixie's libssl ---------------------
# gcc:*-trixie shares the runtime image's Debian release, so libcrypto's ABI matches.
FROM ${GCC_IMAGE} AS cc
RUN apt-get update && apt-get install -y --no-install-recommends libssl-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY c/ c/
RUN mkdir -p build && gcc -O2 -Wall -Wextra -o build/gcm_bench c/gcm_bench.c -lcrypto \
    && gcc --version | head -1 > build/cc-version.txt

# --- runtime ----------------------------------------------------------------------
FROM ${RUNTIME_IMAGE}
# libssl3t64 for the C harness, openssl CLI for `openssl speed`, util-linux for taskset (--cpu)
RUN apt-get update && apt-get install -y --no-install-recommends libssl3t64 openssl util-linux \
    && rm -rf /var/lib/apt/lists/*
ENV JAVA_HOME=/opt/jdk
ENV PATH="${JAVA_HOME}/bin:${PATH}"
# The full JDK (not a jlink'd subset) so every JCA provider is available for --provider.
COPY --from=jdk /opt/jdk /opt/jdk
WORKDIR /app
COPY run.sh report.sh ./
COPY --from=jdk /src/build/ build/
COPY --from=cc /src/build/ build/
# writable by any --user so results can be saved without running as root
RUN mkdir -p results && chmod 1777 results && java -version && build/gcm_bench --self-test
ENV AESGCM_PREBUILT=1
ENTRYPOINT ["./run.sh"]

# AES-GCM benchmark: Java (SunJCE) vs OpenSSL, ready to run.
#   docker run --rm ghcr.io/vibatwork/aes-gcm-bench            # full run
#   docker run --rm ghcr.io/vibatwork/aes-gcm-bench --quick    # ~20s
# Any run.sh option can be appended. To keep the CSV on your machine:
#   docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/results:/app/results" ghcr.io/vibatwork/aes-gcm-bench

FROM eclipse-temurin:21-jdk-noble AS build
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev libssl-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY java/ java/
COPY c/ c/
RUN mkdir -p build && javac -d build java/GcmBench.java \
    && gcc -O2 -Wall -o build/gcm_bench c/gcm_bench.c -lcrypto

FROM eclipse-temurin:21-jre-noble
# openssl CLI for the `openssl speed` reference rows; util-linux provides taskset (--cpu)
RUN apt-get update && apt-get install -y --no-install-recommends openssl util-linux \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY run.sh report.sh ./
COPY --from=build /src/build/ build/
# writable by any --user so results can be saved without running as root
RUN mkdir -p results && chmod 1777 results
ENV AESGCM_PREBUILT=1
ENTRYPOINT ["./run.sh"]

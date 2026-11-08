# syntax=docker/dockerfile:1
# Multi-stage build: compile + test with Maven, run on a slim JRE as a non-root user.

FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /src
COPY pom.xml .
RUN mvn -q -B dependency:go-offline
COPY src ./src
COPY samples ./samples
# Tests run as part of the build; pass --build-arg SKIP_TESTS=true to skip them.
ARG SKIP_TESTS=false
RUN mvn -q -B package -DskipTests=${SKIP_TESTS}

FROM eclipse-temurin:21-jre
RUN groupadd --system app && useradd --system --gid app --home /app app
WORKDIR /app
COPY --from=build /src/target/tablescrub-0.1.0.jar /app/tablescrub.jar
COPY --from=build /src/samples /app/samples
USER app
# Inside a container the app must listen on all interfaces; publish the port on 127.0.0.1 only (see README).
ENV HOST=0.0.0.0 \
    PORT=7070 \
    TABLESCRUB_MAX_UPLOAD_MB=100 \
    TABLESCRUB_TTL_MINUTES=60 \
    JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=75"
EXPOSE 7070
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s \
  CMD ["java", "-XX:TieredStopAtLevel=1", "-cp", "/app/tablescrub.jar", "tablescrub.HealthCheck"]
ENTRYPOINT ["java", "-jar", "/app/tablescrub.jar"]

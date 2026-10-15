# PostGIS + pgvector. imresamu/postgis has no `vector` extension, and the
# prebuilt PostGIS+pgvector images are third-party images we'd then have in
# the critical path of CI and local dev (plans/23-search-semantic.md).
#
# pgvector is built from the tag in db/pgvector-version — the one source of
# truth for the version, matching what production RDS ships. CI and the ingest
# migration both fail when a database's `extversion` differs from that file.
# After changing it, rebuild: `docker compose build db`.
FROM imresamu/postgis:17-3.5-alpine

COPY pgvector-version /tmp/pgvector-version

# OPTFLAGS="" drops pgvector's default -march=native, so an image built on one
# machine runs on another. with_llvm=no skips JIT bitcode, which would need a
# clang matching the server's LLVM.
RUN set -eux; \
    version="$(cat /tmp/pgvector-version)"; \
    apk add --no-cache --virtual .pgvector-build build-base git; \
    git clone --depth 1 --branch "v${version}" https://github.com/pgvector/pgvector.git /tmp/pgvector; \
    make -C /tmp/pgvector OPTFLAGS="" with_llvm=no; \
    make -C /tmp/pgvector install with_llvm=no; \
    rm -rf /tmp/pgvector /tmp/pgvector-version; \
    apk del .pgvector-build

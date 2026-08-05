FROM postgis/postgis:17-3.6-alpine AS pgvector-build

ARG PGVECTOR_VERSION=0.8.1
ARG PGVECTOR_SHA256=a9094dfb85ccdde3cbb295f1086d4c71a20db1d26bf1d6c39f07a7d164033eb4

RUN apk add --no-cache build-base \
  && wget -qO /tmp/pgvector.tar.gz "https://github.com/pgvector/pgvector/archive/refs/tags/v${PGVECTOR_VERSION}.tar.gz" \
  && echo "${PGVECTOR_SHA256}  /tmp/pgvector.tar.gz" | sha256sum -c - \
  && mkdir /tmp/pgvector \
  && tar -xzf /tmp/pgvector.tar.gz --strip-components=1 -C /tmp/pgvector \
  && make -C /tmp/pgvector with_llvm=no OPTFLAGS="" \
  && make -C /tmp/pgvector with_llvm=no DESTDIR=/tmp/pgvector-install install

FROM postgis/postgis:17-3.6-alpine

COPY --from=pgvector-build /tmp/pgvector-install/ /
# Let migration 0001 install PostGIS in the allowlisted extensions schema.
RUN mv /docker-entrypoint-initdb.d/10_postgis.sh /usr/local/share/postgis-image-init.disabled
COPY init/ /docker-entrypoint-initdb.d/

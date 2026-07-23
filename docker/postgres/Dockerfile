FROM pgvector/pgvector:pg17-bookworm

RUN apt-get update \
  && apt-get install --no-install-recommends -y postgresql-17-postgis-3 \
  && rm -rf /var/lib/apt/lists/*

COPY init/ /docker-entrypoint-initdb.d/

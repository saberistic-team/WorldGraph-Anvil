# Primitive registry operations

## Reindex and recovery

The registry remains readable when Redis or the embedding provider is unavailable because PostgreSQL owns indexing intent and lexical documents. BullMQ is only a wake-up path.

For one version, use the authenticated admin reindex command with `expectedRowVersion` and an `Idempotency-Key`. Replaying the identical command returns the original response and does not create a second logical job. A changed request with the same key is rejected.

For a catalog-wide reindex, enqueue/upsert one durable job per published or deprecated exact version for the target index schema and provider configuration, then wake the worker. Do this in bounded batches; do not mutate primitive content or delete the old provider configuration first. Monitor:

- pending/failed job count and age by provider configuration;
- attempts and allowlisted terminal error code;
- provider latency, rate errors, estimated tokens/cost, and cache hit rate;
- current embedding coverage by kind and lifecycle;
- retrieval fallback rate, latency, result count, and sudden empty-result rate.

Alert on sustained oldest-job age, repeated dead jobs, an unexpected rise in empty retrieval, provider cost/rate anomalies, or a published-hash/immutability failure. Raw query text and raw provider errors must not be labels or logs.

### Select or rotate the built-in profile

Keep `PRIMITIVE_SEMANTIC_PROFILE=disabled` and `PRIMITIVE_SEMANTIC_CONTRIBUTION_ENABLED=false` for the default lexical-only deployment. To exercise the optional local path, deploy API and worker with `PRIMITIVE_SEMANTIC_PROFILE=local_hash`, keep the explicit cost budget at `0`, and initially leave semantic contribution off. Worker startup creates missing `local-hash-1536-v1` jobs in bounded batches alongside the retained `disabled-v1` rows and never resets completed/terminal work. Observe backlog, completion, zero cost, and coverage; then enable contribution on both roles and verify retrieval provenance plus fallback behavior.

`PRIMITIVE_EMBEDDING_TIMEOUT_MS`, `PRIMITIVE_INDEX_MAX_JOBS_PER_RECONCILIATION`, and `PRIMITIVE_INDEX_RECONCILIATION_INTERVAL_MS` are bounded startup settings. The job count divided by the interval is the hard process-level indexing ceiling; duplicate BullMQ wakes cannot accelerate it. Unsupported profile names, nonzero cost, inconsistent contribution, or out-of-range limits stop startup. Roll back ranking by disabling contribution first. Switching the selected profile to `disabled` does not delete local embeddings/jobs; removal of derived data requires a separate reviewed retention change.

The repository ships Prometheus-compatible thresholds in `deploy/alerts/primitive-registry.rules.yml`. Production/preview release configuration owns loading and routing them; the rules deliberately contain no receiver credentials. After deployment, force a test warning into the non-production receiver and link the observed alert to this runbook before accepting the environment.

An expired running claim is recovered to retryable failure or dead state according to its guarded attempt count. A `CONTENT_STALE` result means the job, published content, or lexical provenance no longer agrees; do not force an embedding write. Verify migration/checksums and published hashes, preserve evidence, and repair forward. A provider timeout/rate/failure can be retried after the dependency recovers; lexical retrieval remains the customer-facing fallback.

## Compromised primitive

1. Identify the exact key/version and verify its canonical hash against version control/audit evidence.
2. Deprecate it through the admin command with a non-sensitive reason. This never edits the semantic row or retargets pinned consumers.
3. Publish a corrected new SemVer after full validation and review.
4. Reindex the corrected version and verify current provider/index provenance.
5. In later milestones, use their audited migration/compensation process for worlds already pinned to the compromised exact version; never silently upgrade them here.

## Seed verification and export

Run migration checksum verification before import. A clean database bootstrap must report 16 imports; the immediate repeat must report 16 unchanged. Import failure for a hash, identity, dependency lock, lexical document, or index-intent mismatch is an integrity incident, not an invitation to overwrite the row.

An export intended for review must include stable key, exact SemVer, kind, canonical definition, content hash, dependency declarations and exact locks, lifecycle/provenance, and index policy version. Embeddings and job state are derived operational data and are not part of the authoritative catalog export.

## Database and service loss

Redis loss pauses wake delivery and smoke work; the worker resumes from PostgreSQL after recovery. PostgreSQL loss makes API/worker readiness fail while liveness remains dependency-independent. Restore the authoritative database using the platform backup/PITR procedure, run forward migrations through the recorded head, verify migration and primitive hashes, then let reconciliation resume. Never rebuild registry authority from Redis or embeddings.

# Fluxora — Phase 1, Step 5 Learning
## Redis + Object Storage + Secrets Manager Abstraction

Step 5 is complete and verified.

---

## 1. What Step 5 added

A new package:

```text
packages/infrastructure/
```

with three infrastructure boundaries:

```text
Redis
Object Storage
Secrets
```

The application uses stable interfaces; environments choose the concrete adapter.

---

## 2. Redis

### Contract

```text
RedisClient
```

Operations:

```text
get
set
delete
setIfAbsent
increment
expire
ping
close
```

### Local

```text
InMemoryRedisAdapter
```

Used for local execution and tests.

### Production

```text
RedisAdapter
```

Uses the real Node Redis client.

### Tenant-safe keys

```text
organizationRedisKey()
cacheKey()
lockKey()
rateLimitKey()
```

Example:

```text
org:org-123:cache:repository:456
```

---

## 3. Object storage

### Contract

```text
ObjectStorageClient
```

Operations:

```text
put
get
exists
delete
close
```

### Local

```text
FilesystemObjectStorage
```

### Production

```text
S3ObjectStorage
```

Uses the AWS S3 SDK.

Mapping:

```text
put    → PutObject
get    → GetObject
exists → HeadObject
delete → DeleteObject
```

### Tenant-safe snapshot keys

```text
{organizationId}/{repositoryId}/{snapshotId}/{objectName}
```

Example:

```text
org-123/repo-456/snapshot-789/source/index.ts
```

Path traversal is rejected.

---

## 4. Secrets

### Contract

```text
SecretsClient
```

### Local

```text
EnvSecretsProvider
```

Reads from `process.env`.

### Production

```text
SecretsManagerProvider
```

Uses AWS Secrets Manager.

### Cache

```text
CachedSecretsClient
```

Adds short-lived in-memory TTL caching.

Architecture:

```text
CachedSecretsClient
        ↓
SecretsClient
   ┌────┴────┐
   ↓         ↓
  Env     Secrets Manager
```

---

## 5. Local vs production

```text
LOCAL
├── InMemoryRedisAdapter
├── FilesystemObjectStorage
└── EnvSecretsProvider

PRODUCTION
├── RedisAdapter
├── S3ObjectStorage
└── SecretsManagerProvider
```

We implement both paths but do not run production infrastructure locally.

---

## 6. Node 24 runtime lesson

Infrastructure tests run with:

```json
"test": "node --experimental-strip-types --test"
```

Typechecking uses:

```text
tsc --noEmit
```

Node strip-only execution does not support TypeScript parameter properties, so constructors use explicit class fields and assignments.

---

## 7. Verification

Passed:

```text
pnpm --filter @fluxora/infrastructure typecheck ✅
pnpm --filter @fluxora/infrastructure test       ✅
pnpm typecheck                                   ✅
```

Local runtime tests cover Redis, filesystem storage, path validation, environment secrets, and secret caching.

---

## 8. Files

```text
packages/infrastructure/
├── src/index.ts
├── src/redis/
│   ├── client.ts
│   ├── in-memory.ts
│   ├── node-redis.ts
│   └── keys.ts
├── src/object-storage/
│   ├── client.ts
│   ├── filesystem.ts
│   ├── s3.ts
│   └── paths.ts
└── src/secrets/
    ├── client.ts
    ├── env.ts
    ├── cached.ts
    └── aws-secrets-manager.ts
```

Dependencies introduced:

```text
redis
@aws-sdk/client-s3
@aws-sdk/client-secrets-manager
```

---

## 9. What Step 5 did not implement

Not part of this step:

```text
job queue
worker execution
OpenTelemetry
CI/CD
GitHub integration
repository ingestion
static analysis
graph construction
AI reasoning
```

---

## 10. Step 5 status

```text
Step 5 — Redis + Object Storage + Secrets ✅ COMPLETE
```

Next roadmap target:

```text
Step 6 — PostgreSQL-backed job queue
           + minimal worker harness
           + idempotency enforcement
```

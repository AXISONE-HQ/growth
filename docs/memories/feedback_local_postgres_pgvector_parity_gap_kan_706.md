# feedback_local_postgres_pgvector_parity_gap_kan_706

**Trigger:** Setting up local Postgres for growth backend dev work hits **5 distinct toolchain layers**, each a separate failure mode. "Install pgvector" is a single sentence; the actual setup is a multi-stage recipe.

**Empirical anchor:** Caught during KAN-786 Phase 1 sub-cohort (a) execution on 2026-05-02. Each layer surfaced as a separate hard-stop. The 5 layers are independent — fixing one doesn't preempt the next.

---

## The 5 layers, in order

### Layer 1 — Prod proxy default-aim

The Cloud SQL Auth Proxy on port 5435 (or 5433) routes to **production** `growth-493400:us-central1:growth-db`. Per `feedback_proxy_5433_points_at_prod`, pointing `prisma migrate dev` at this proxy applies migrations directly to PROD's Cloud SQL instance — destructive verb on shared infra (KAN-706 incident class).

**Recipe:**
```bash
# 1. Find any running proxy
lsof -i :5435 -P
# 2. Kill it before any prisma command
kill <PID>
# 3. Verify port empty
lsof -i :5435  # should return empty
# 4. Confirm DATABASE_URL is unset (must NOT inherit a prod-pointing value)
echo "${DATABASE_URL:-UNSET}"  # should print "UNSET"
```

When prod proxy work resumes later (e.g., for end-of-sprint smoke audits), authorize separately and re-spawn the proxy explicitly. Don't leave it running between sessions.

### Layer 2 — Homebrew pgvector bottle drops PG15

`brew install pgvector` lands binaries for `postgresql@17` and `postgresql@18` only — NOT `@15`. Verified empirically: bottle files land in `/opt/homebrew/Cellar/pgvector/0.8.2/share/postgresql@17/` and `@18/`, with no `@15` directory. Symlinks similarly skip @15 in `/opt/homebrew/share/`.

This means the brew-bottle path is useless if local Postgres is `@15` (matches prod Cloud SQL's `POSTGRES_15`). Must build pgvector from source against `@15`.

**Recipe:**
```bash
mkdir -p ~/tools-build && cd ~/tools-build
git clone --branch v0.8.2 --depth 1 https://github.com/pgvector/pgvector.git
cd pgvector
PG_CONFIG=/opt/homebrew/opt/postgresql@15/bin/pg_config make
PG_CONFIG=/opt/homebrew/opt/postgresql@15/bin/pg_config make install
ls /opt/homebrew/opt/postgresql@15/share/postgresql@15/extension/vector*
# Should list vector.control + 36 vector--*.sql files
```

When prod's Cloud SQL eventually upgrades from PG15 → PG16+ (separate ticket, not in scope for current sprints), local should follow with both `brew upgrade postgresql@<new>` AND a re-build of pgvector against the new version. Worth memorializing: pgvector is pinned by Postgres major version.

### Layer 3 — Wedged Xcode.app developer dir

If `/Applications/Xcode.app` has a corrupted USDKit framework (or any toolchain-blocking dylib issue), every `clang` call routed via `xcrun` fails with: `Error loading required libraries... libxcodebuildLoader.dylib... Symbol not found`. Even direct `/usr/bin/clang --version` fails because Apple's shim routes through `xcode-select -p`. Standalone CLT at `/Library/Developer/CommandLineTools/` is healthy but not active.

**Recipe:**
```bash
# Diagnose
xcode-select -p                  # if returns Xcode.app path AND clang is broken → wedge
/usr/bin/clang --version         # if this fails with dylib error → confirmed
ls /Library/Developer/CommandLineTools/usr/bin/clang  # if exists → CLT is installed
# Fix
sudo xcode-select -s /Library/Developer/CommandLineTools
# Reverse if needed
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
```

The switch is reversible at any time — doesn't uninstall anything. Many devs run permanently on CLT for non-iOS work.

### Layer 4 — Stale CLT SDK

CLT installs from years past don't include current macOS SDKs. If macOS auto-updates but the developer tools don't, you get a multi-major-version SDK gap.

Critical empirical gotcha discovered in KAN-786: **`SDKROOT` env var override does NOT work** to redirect the build to an older SDK. Reason: Homebrew's `postgresql@15` build baked `-isysroot <whatever-SDK-was-active-when-brew-installed-it>` into `pg_config --cflags`. That hardcoded `-isysroot` flag overrides the `SDKROOT` env var at clang invocation. Verified empirically on 2026-05-02 — `SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX13.3.sdk make` produced compile lines still showing `-isysroot .../MacOSX26.sdk` (the missing SDK).

**The only reliable fix is full CLT refresh:**
```bash
# 1. Diagnose: list available CLT SDKs vs what pg_config wants
ls /Library/Developer/CommandLineTools/SDKs/
/opt/homebrew/opt/postgresql@15/bin/pg_config --cflags | grep -oE '\-isysroot [^ ]+'
sw_vers  # current macOS

# 2. Refresh (interactive — pops GUI dialog)
sudo rm -rf /Library/Developer/CommandLineTools
xcode-select --install
# Click "Install" in GUI dialog, wait ~5-10 min download

# 3. Fallback if GUI dialog doesn't appear (headless install)
softwareupdate --list  # find exact CLT label, e.g. "Command Line Tools for Xcode 16.4"
sudo softwareupdate -i "Command Line Tools for Xcode <version>"

# 4. Verify post-install
xcode-select -p                                    # → /Library/Developer/CommandLineTools
ls /Library/Developer/CommandLineTools/SDKs/        # should include current macOS SDK
/usr/bin/clang --version                           # should print clean version, no dylib error
```

### Layer 5 — Prisma vector-index silent-drop drift

See companion entry: [`feedback_prisma_vector_index_silent_drop_drift.md`](./feedback_prisma_vector_index_silent_drop_drift.md). Every `prisma migrate dev` will spuriously generate `DROP INDEX "knowledge_chunks_embedding_hnsw_idx"`. Strip before commit. Tracked at [KAN-787](https://axisone-team.atlassian.net/browse/KAN-787).

---

## One-shot setup script (post-CLT-refresh, post-postgresql@15-install)

After CLT is fresh and postgresql@15 is installed via `brew install postgresql@15` + `brew services start postgresql@15`:

```bash
# Layer 1 — neutralize prod proxy (if running)
PROXY_PID=$(lsof -ti :5435 2>/dev/null | head -1)
[ -n "$PROXY_PID" ] && kill "$PROXY_PID"
unset DATABASE_URL

# Layer 2 — build + install pgvector against @15 from source
mkdir -p ~/tools-build && cd ~/tools-build
[ ! -d pgvector ] && git clone --branch v0.8.2 --depth 1 https://github.com/pgvector/pgvector.git
cd pgvector
PG_CONFIG=/opt/homebrew/opt/postgresql@15/bin/pg_config make
PG_CONFIG=/opt/homebrew/opt/postgresql@15/bin/pg_config make install

# Smoke test
PSQL=/opt/homebrew/opt/postgresql@15/bin/psql
$PSQL -h localhost -p 5432 -U $(whoami) postgres -c 'CREATE EXTENSION vector;'
$PSQL -h localhost -p 5432 -U $(whoami) postgres -c "SELECT extversion FROM pg_extension WHERE extname='vector';"
$PSQL -h localhost -p 5432 -U $(whoami) postgres -c "SELECT '[1,2,3]'::vector;"
$PSQL -h localhost -p 5432 -U $(whoami) postgres -c 'DROP EXTENSION vector;'

# Layer 5 reminder: every future `prisma migrate dev` will need migration.sql
# manually cleaned of `DROP INDEX "knowledge_chunks_embedding_hnsw_idx"`.
# Pre-commit guard: grep -E "DROP INDEX|RenameIndex" <new-migration>/migration.sql
```

For local DB setup specific to the growth repo:
```bash
$PSQL -h localhost -p 5432 -U $(whoami) -c 'CREATE DATABASE growth;'
export DATABASE_URL="postgresql://$(whoami)@localhost:5432/growth?schema=public"
cd ~/growth/packages/db && npx prisma migrate dev
# Then strip Layer 5 drift entries from the generated migration.sql before commit
```

---

## Cross-references

- [`feedback_prisma_vector_index_silent_drop_drift`](./feedback_prisma_vector_index_silent_drop_drift.md) — Layer 5 deep-dive
- `feedback_proxy_5433_points_at_prod` — Layer 1 deep-dive (in personal session memory)
- [KAN-706](https://axisone-team.atlassian.net/browse/KAN-706) — original ticket that introduced the pgvector dependency
- [KAN-786](https://axisone-team.atlassian.net/browse/KAN-786) — Phase 1 ticket that surfaced all 5 layers
- [KAN-787](https://axisone-team.atlassian.net/browse/KAN-787) — Layer 5 structural fix
- KAN-MAINT-dev-env-refresh — proactive housekeeping ticket (filed alongside this entry)

---

## Status

**Active.** Update this entry if any layer changes:
- Layer 2 retires when pgvector ships a PG15-targeted bottle, OR when the team standardizes on PG17/18 (would also retire prod-parity at PG15)
- Layer 4 retires when the team standardizes on a containerized dev DB (Docker Compose) that bypasses host toolchain
- Layer 5 retires when KAN-787 ships, OR when Prisma adds native vector index support in schema.prisma syntax
- Layers 1 and 3 are operational discipline — likely permanent recipes

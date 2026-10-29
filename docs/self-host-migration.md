# 自建镜像替换官方 `penpotapp/*:2.18` 的评估

这份笔记对应一台已经在跑的自部署（compose 项目名 `penpot`，镜像 `penpotapp/{frontend,backend,exporter,admin-console,mcp}:2.18`）。结论先说：**可以平滑换成从本仓库打出来的镜像，但有三个前提，缺一个都不要直接切。**

1. 自定义分支必须从 **tag `2.18.3`（`ff7a66f51938b2293260ea27a64e2c4e0833b5e3`）** 拉，不要从 `develop` 拉。
2. 官方 Dockerfile 的基础镜像在 `dhi.io`，匿名 pull 会 401。本机没有这份登录。要打出和上游一样的镜像，先 `docker login dhi.io`。
3. `admin-console` 不在这个仓库里。继续用本地已有的 `penpotapp/admin-console@sha256:29c13326e854fd63e18a7231cb1ca26d60f728692bd1207ded003b94aba79390`，不要写 `penpotapp/admin-console:2.18`。

2026-10-27 在这台机器上做了一次不碰现网的预演。预演结果写在文末；现网 compose 项目 `penpot` 没有被停止或改配置。

## 1. 正在跑的 `2.18` 镜像对应哪一次提交

`penpotapp/*:2.18` 是浮动 tag。本机这四份应用镜像的 OCI revision 都是同一次提交，版本号是 **2.18.3**，不是 2.18.0，也不是当时的最新版 2.18.5。

| 镜像 | 本地 Id | `org.opencontainers.image.version` | `org.opencontainers.image.revision` | 容器内 version 文件 |
|---|---|---|---|---|
| `penpotapp/frontend:2.18` | `sha256:f025202f535b…` | 2.18.3 | `ff7a66f51938b2293260ea27a64e2c4e0833b5e3` | `/var/www/app/version.txt` = `2.18.3` |
| `penpotapp/backend:2.18` | `sha256:bc9396102848…` | 2.18.3 | 同上 | `/opt/penpot/backend/version.txt` = `2.18.3` |
| `penpotapp/exporter:2.18` | `sha256:3c7740994d96…` | 2.18.3 | 同上 | `/opt/penpot/exporter/version.txt` = `2.18.3` |
| `penpotapp/mcp:2.18` | `sha256:4d9a338f74a8…` | 2.18.3 | 同上 | 镜像没有 shell，label 与另外三份一致 |
| `penpotapp/admin-console:2.18` | `sha256:29c13326e854…` | label 写 `develop` | `9a009dfcfbed40c8d0ca2120f97d58fda3886461` | 见下 |

前四份的 label 还有：

- `org.opencontainers.image.source=https://github.com/penpot/penpot`
- `org.opencontainers.image.created=2026-10-06T12:34Z` 左右（mcp 是 `12:37Z`）
- `bundle_version=2.18.3`

上游 tag **`2.18.3` 指向同一个 commit** `ff7a66f51938b2293260ea27a64e2c4e0833b5e3`（2026-10-06，`:books: Update changelog`）。本 fork 的历史里有这次提交（它是 `develop` 的祖先）。fork 在 GitHub 上 **一个 tag 都没有**（`git/matching-refs/tags/` 返回空），所以 `git clone --branch 2.18.3` 会失败，需要从 upstream 取 tag：

```bash
git remote add upstream git@github.com:penpot/penpot.git   # 已有就跳过
git fetch upstream tag 2.18.3
git checkout -b my-feature 2.18.3
```

只 fetch，不要 push 到 `penpot/penpot`。

### 为什么不能从 `develop` 或 2.18.5 打

现网 Postgres（`penpot_penpot_postgres_v15`，库大约 23MB）里 `migrations` 表 module `main` 有 **163** 行，最后一步是 `0153-del-orphan-profile-rels-after-team-leave`，时间是 2026-10-06 19:10 UTC。tag `2.18.3` 的 `backend/src/app/migrations.clj` 也是 163 步，最后一步同名。后端只在表里没有该 step 时才执行 SQL（日志动作是 `apply migration`）。同一份代码对着这份库，迁移是空操作。

往后的发布不是空操作：

- `2.18.3..2.18.5` 新增 `0154-del-legacy-file-object-thumbnail-table.sql`、`0155-add-idx-to-file-change.sql`、`0156-reset-pg-storage-defaults.sql`。
- `2.18.3..develop`（评估时 develop 比 2.18.3 多 863 个提交）在 `backend/src/app/migrations` 下新增 10 个 SQL 文件，编号到 `0157`。

所以自定义分支的基线是 **`2.18.3`**。要升到 2.18.4/2.18.5 或 develop，先备份，并预期后端启动时会跑新的 migration。

### admin-console

`penpotapp/admin-console:2.18` 的 source 是 `https://github.com/penpot/penpot-nitrate`，不是本仓库。`bundle_version=2.18.0-RC4-1-gd8dd1b8`，镜像创建于 2026-09-22。本仓库的 `.github/workflows/build-docker-admin-console.yml` 只是用 token 去 nitrate 仓库触发构建。公开 API 读不到 `9a009df`（404），这里也没有 nitrate 的源码。**这个 fork 打不出 admin-console。** 切换时这一项继续用第 3 条里的 digest，不要写 `:2.18`。

## 2. 上游怎么打镜像，本机能不能复现

发布链路（`.github/workflows/build-tag.yml`，tag push 触发）：

1. `build-bundle.yml`：在 devenv 里编译，把 bundle 放到私有 S3。
2. `build-docker.yml`：五个镜像并行（backend、frontend、exporter、storybook、mcp）。Runner 先登录私有 registry、Docker Hub，再登录 **`dhi.io`**。注释写明 DHI 免费，但必须登录。然后用 S3 里的 bundle 做 `docker build`，平台 `linux/amd64,linux/arm64`，推 `sha-<short>`，再由 promote job 把分支 tag（例如 `2.18.3`，浮动的 `2.18` 是另一层 retag）指过去。
3. `build-docker-admin-console.yml`：dispatch 到 `penpot/penpot-nitrate`，不在本仓库编译。

本地等价物是 `manage.sh`：

- `./manage.sh build-<module>-bundle` 在 `penpotapp/devenv` 容器里跑各模块的 `scripts/build`。
- `./manage.sh build-<module>-docker-image` 把 `bundles/<module>` 放进 `docker/images/`，再 `docker build`。Dockerfile 的 `FROM` 是 `dhi.io/nginx`、`dhi.io/debian-base`、`dhi.io/node`，backend/exporter 还 `COPY --from=penpotapp/imagemagick:7.1.2-27`。

本机工具链不需要装在宿主机上。devenv 镜像里有 JDK、Clojure CLI、Node、pnpm、Rust、Emscripten、babashka。`docker/devenv/Dockerfile` 在 `2.18.3` 上钉的是：

| 工具 | `2.18.3` 的 Dockerfile | 2026-10-27 拉到的 `penpotapp/devenv:latest` |
|---|---|---|
| 创建时间 | — | 2026-10-17，约 4.7GB，digest `sha256:f1f3571504f344…` |
| Node | v24.21.0 | 镜像 PATH 上是 v24.22.0；exporter 的 `packageManager` 把本次 pnpm 解析成 **12.5.1** |
| pnpm | 12.5.1 | 同上，构建日志里是 `pnpm v12.5.1` |
| JDK | Zulu 27.0.0 | `openjdk version "27"` |
| Clojure CLI | 1.12.5.1664 | 1.12.5.1664 |
| Rust | 1.91.0 | 1.91.0 |
| Emscripten | 4.0.6 | 4.0.6 |
| babashka | 1.13.223 | 1.13.225 |

Docker Hub 上 `penpotapp/devenv` 只有 `latest` 和 `buildcache`，没有 `2.18.3` tag。devenv 自己的 Dockerfile 也 `FROM dhi.io/...`，所以没有 DHI 登录就重做不出与发布当天一致的 devenv，只能用 Hub 上当时的 `latest`。

### 本机复现结果

- `penpotapp/imagemagick:7.1.2-27` 可以匿名 pull。
- `docker build` 官方 `Dockerfile.frontend`（未改 FROM）失败：

```text
dhi.io/nginx:1.31.1-debian13-dev
401 Unauthorized
https://dhi.io/token?scope=repository%3Anginx%3Apull&service=registry.docker.io
```

本机 `~/.docker/config.json` 里没有 `dhi.io` 或 Docker Hub 的登录，只有别的 registry。

- 四个应用 bundle（backend、exporter、mcp、frontend）可以用公开的 `penpotapp/devenv:latest` 从**未改过的** `2.18.3` 源码编出来。打包镜像时如果还没有 DHI 登录，用 `scripts/build-selfhost-images.sh --public-bases`：它只在临时 build context 里把 `FROM dhi.io/...` 换成公开的 `debian:trixie`、`nginx:1.31.1-trixie`、`node:24.20.0-trixie`，仓库里的 Dockerfile 不动。这**不是**官方镜像的字节级复现，只证明同一份 bundle 能在公开基础镜像上启动。
- storybook 不在现网 compose 里，脚本不打它。
- admin-console 打不了。

磁盘：评估时根分区还剩大约 300GB。devenv 约 5GB，官方 exporter 镜像约 2GB，四份本地镜像再加几 GB，够用。不要用 GPU。这台机器评估时两张 GPU 被别的推理进程占着；脚本里的编译容器用 `--runtime=runc`，不申请 GPU，默认 `--cpus=12`（机器 64 核）。

2026-10-27 在这台 64 核机器上、编译容器限 12 CPU / 32GB 的实测（devenv 和基础镜像已经 pull 完）：四个 bundle 一共约 5 分 21 秒（backend 33 秒、exporter 38 秒、mcp 13 秒、frontend 含 wasm 与 shadow-cljs 3 分 57 秒）。四份镜像再约 2 分 30 秒（backend 32 秒、exporter 约 80 秒、mcp 15 秒、frontend 19 秒）。冷启动还要加上 `penpotapp/devenv:latest`（约 4.7GB）和基础镜像的下载。公开基础镜像打出来的体积：frontend 728MB、backend 814MB、exporter 2.97GB、mcp 1.29GB。官方 DHI 镜像大约是 frontend 672MB、backend 774MB、exporter 2.08GB、mcp 195MB。mcp 差得最多，因为公开的 `node:24.20.0-trixie` 不是 DHI 的 runtime 变体。

## 3. 本地镜像怎么挂上 compose

官方 compose 在 `docker/images/docker-compose.yaml`（与现网 `docker-compose.orig.yaml` 一致，默认端口已经是 9001）。覆盖文件只换四条 `image`：

```bash
export PENPOT_IMAGE_PREFIX=penpot-local
export PENPOT_IMAGE_TAG=2.18.3
docker compose \
  -f docker/images/docker-compose.yaml \
  -f docker/images/docker-compose.custom-images.yaml \
  up -d
```

现网目录 `~/penpot` 还有四处和 orig 不同，切换时要保留，不要被仓库里的 compose 盖掉：

- `PENPOT_PUBLIC_URI=https://penpot.zhanchengbo.com`
- `PENPOT_FLAGS` 去掉了 `disable-secure-session-cookies`，并加了 `disable-registration`
- `PENPOT_SECRET_KEY` 从 `.env` 读（权限 600）。不要打印、不要写进仓库、不要打进镜像。
- mailcatch 的 1080 只绑 `127.0.0.1`

建议在 `~/penpot/docker-compose.yaml` 上再叠一层同样的 override，而不是换成仓库里的默认 compose。

## 4. 切换和回滚

下面的命令假设人在 `~/penpot`，现网项目名是 `penpot`。先在维护窗口做。Cloudflare Tunnel 不用改：它仍然指到本机 9001。

不要在现网执行 `docker compose pull`：`penpotapp/*:2.18` 现在会解析到 2.18.5（migration 0154–0156）。现网只用已经在本地的 `penpot-pinned/*:2.18.3`。

### 备份（只读现网）

```bash
mkdir -p ~/penpot-backups
stamp=$(date -u +%Y%m%dT%H%M%SZ)

docker exec penpot-penpot-postgres-1 \
  pg_dump -U penpot -d penpot -Fc \
  > ~/penpot-backups/penpot-${stamp}.dump

docker run --rm \
  -v penpot_penpot_assets:/from:ro \
  -v "$HOME/penpot-backups:/backup" \
  alpine \
  tar -C /from -czf "/backup/penpot-assets-${stamp}.tgz" .
```

`pg_dump` 对库加的是读锁，不需要停库。dump 大约几十 MB。确认文件非空再继续。

### 切换

镜像要事先打好并在本地 `docker image inspect` 能看到。admin-console 保持上面的 digest，不要改成 `:2.18`。

在 `~/penpot/docker-compose.yaml` 里只改这四行的镜像名（或用 compose 的第二份 override，不要手改别的环境变量）：

```yaml
penpot-frontend:
  image: penpot-local/frontend:2.18.3
penpot-backend:
  image: penpot-local/backend:2.18.3
penpot-exporter:
  image: penpot-local/exporter:2.18.3
penpot-mcp:
  image: penpot-local/mcp:2.18.3
# penpot-admin-console 保持
# penpotapp/admin-console@sha256:29c13326e854fd63e18a7231cb1ca26d60f728692bd1207ded003b94aba79390
```

```bash
cd ~/penpot
docker compose -p penpot up -d --pull never
docker compose -p penpot ps
docker logs penpot-penpot-backend-1 2>&1 | grep -E 'apply migration|running migrations' | tail
```

从 tag `2.18.3` 原样打出来的后端，不该出现 `apply migration`。可以再对一下行数仍是 163：

```bash
docker exec penpot-penpot-postgres-1 \
  psql -U penpot -d penpot -c "SELECT count(*) FROM migrations WHERE module='main';"
```

然后打开 https://penpot.zhanchengbo.com ，看登录页、项目列表，以及 MCP（`/plugins/mcp/manifest.json` 和 `/mcp/stream`）。

### 停机

只重建 frontend、backend、exporter、mcp 四个容器。Postgres 和 Valkey 的镜像没变，卷也不换。预演里 backend 容器起来后大约 15 秒写到 `welcome to penpot`（版本 `2.18.3`），frontend 的静态页在那之前就已经 200。镜像已经在本地时，现网切换的 HTTP 中断按 **大约 1 分钟** 估计。没有在现网上实际切过。

### 回滚到本地 `penpot-pinned/*:2.18.3`

本地已有 `penpot-pinned/{frontend,backend,exporter}:2.18.3`，与当初的 2.18.3 官方镜像是同一个 Id。mcp 还没有这个名字。只给已经在本地的镜像加 tag，不要从 `penpotapp/mcp:2.18` 转 tag，也不要 pull：

```bash
docker tag sha256:4d9a338f74a855e8e18753b376e7702dfbee3a5af738edb0a17b3ce212020771 penpot-pinned/mcp:2.18.3
docker image inspect penpot-pinned/frontend:2.18.3 penpot-pinned/backend:2.18.3 \
  penpot-pinned/exporter:2.18.3 penpot-pinned/mcp:2.18.3 >/dev/null
```

如果新容器起不来，或页面不对，但 **没有** `apply migration`：把那四行 `image` 改成 `penpot-pinned/<name>:2.18.3`，数据卷不动。

```bash
cd ~/penpot
docker compose -p penpot up -d --pull never
```

如果日志里出现了 `apply migration`，不要只换镜像，也不要删现网卷。日备在 `/mnt/sdg/penpot-backups/daily`，一对是 `penpot-db-YYYYMMDD-HHMMSS.dump` 和 `penpot-assets-YYYYMMDD-HHMMSS.tar.gz`，只留最近 3 对。先选定最新一对并校验，通过之后才建新卷。现网卷留着，作为换卷前的副本。

```bash
set -euo pipefail
BACKUP_DIR=/mnt/sdg/penpot-backups/daily
stamp=$(ls -1 "$BACKUP_DIR"/penpot-db-*.dump | sed 's|.*/penpot-db-||; s|\.dump$||' | sort | tail -1)
DB="$BACKUP_DIR/penpot-db-${stamp}.dump"
ASSETS="$BACKUP_DIR/penpot-assets-${stamp}.tar.gz"
echo "db=$DB"
echo "assets=$ASSETS"
test -s "$DB"
test -s "$ASSETS"
docker run --rm --pull never --entrypoint pg_restore \
  -v "$BACKUP_DIR":/backup:ro \
  penpot-pinned/postgres:15 \
  -f /dev/null "/backup/penpot-db-${stamp}.dump"
tar -tzf "$ASSETS" >/dev/null
echo "backup pair ok"

HOLD=$(date -u +%Y%m%d-%H%M%S)
PGVOL="penpot_restore_pg_${HOLD}"
ASSETVOL="penpot_restore_assets_${HOLD}"
echo "pgvol=$PGVOL"
echo "assetvol=$ASSETVOL"
docker volume create "$PGVOL"
docker volume create "$ASSETVOL"

docker run -d --pull never --name "penpot-restore-${HOLD}" \
  -e POSTGRES_DB=penpot \
  -e POSTGRES_USER=penpot \
  -e POSTGRES_PASSWORD=penpot \
  -v "${PGVOL}:/var/lib/postgresql/data" \
  penpot-pinned/postgres:15
for i in $(seq 1 30); do
  docker exec "penpot-restore-${HOLD}" pg_isready -U penpot && break
  sleep 1
done
docker exec "penpot-restore-${HOLD}" pg_isready -U penpot
docker exec -i "penpot-restore-${HOLD}" \
  pg_restore -U penpot -d penpot --no-owner --no-acl < "$DB"
docker exec "penpot-restore-${HOLD}" \
  psql -U penpot -d penpot -c "SELECT count(*) FROM migrations WHERE module='main';"
docker stop "penpot-restore-${HOLD}"
docker rm "penpot-restore-${HOLD}"

docker run --rm --pull never --entrypoint tar \
  -v "${ASSETVOL}:/to" \
  -v "$BACKUP_DIR":/backup:ro \
  penpot-pinned/postgres:15 \
  -C /to -xzf "/backup/penpot-assets-${stamp}.tar.gz"

cat <<EOF
volumes:
  penpot_postgres_v15:
    external: true
    name: ${PGVOL}
  penpot_assets:
    external: true
    name: ${ASSETVOL}
EOF
```

日备是 custom format，所以校验用 `pg_restore -f /dev/null`，不是 `psql`。上面任何一步失败就停，现网卷还没动，也不会打印 volumes 片段。

成功时，片段里的 `name` 已经是展开后的卷名。四份应用镜像改成 `penpot-pinned/<name>:2.18.3`，volumes 换成这份输出。不要删 `penpot_penpot_postgres_v15` 和 `penpot_penpot_assets`。然后：

```bash
cd ~/penpot
docker compose -p penpot up -d --pull never
```

新卷如果不对，把这两个 `name` 改回 `penpot_penpot_postgres_v15` 和 `penpot_penpot_assets`，再执行同一条 `up -d --pull never`。

### 以后跟上游同步

```bash
git fetch upstream --tags
git log --oneline 2.18.3..2.18.5
git diff --stat 2.18.3..2.18.5 -- backend/src/app/migrations
```

有新的 migration SQL，就把这次升级当成一次会改库的发布：备份、在一份拷贝上先跑（见预演），确认 `apply migration` 的列表，再切现网。没有新 migration，才可以按上面的「只换四份镜像」做。

功能分支从当前现网对应的 tag 拉，不要从 `develop` 拉。fork 上如果要保留 tag，可以在确认只推到自己的 origin 之后 `git push origin 2.18.3`。不要 `git push --tags` 到 upstream，也不要顺手把全部历史 tag 推上去。

`develop` 会继续往前走。合文档类 PR 进 `develop` 不会把现网基线改成 develop；打现网镜像时 checkout 的仍然必须是 `2.18.3`（或你下一次有意升级到的那个 tag）。

## 5. 预演（2026-10-27）：通过

原则：现网项目 `penpot` 只做 `pg_dump` 和 assets 卷的只读挂载。另一套 compose 项目 `penpot-rehearsal`，端口 `127.0.0.1:9101`，自己的卷，测完 `down -v` 并删掉拷贝。mailcatch 绑在 `127.0.0.1:1081`，避开现网的 1080。不改 Cloudflare。编译限制 12 CPU、32GB 内存，runtime `runc`，不用 GPU。

镜像是 `scripts/build-selfhost-images.sh --public-bases --skip-bundles --tag 2.18.3 --prefix penpot-local`。bundle 来自未改过的 `2.18.3` 源码（文档提交不进 bundle）。四份镜像里的 `version.txt` 都是 `2.18.3`。admin-console 用官方 `penpotapp/admin-console:2.18`。预演用了新生成的 `PENPOT_SECRET_KEY`（没有读现网 `.env`），`PENPOT_PUBLIC_URI=http://127.0.0.1:9101`，并加了 `disable-secure-session-cookies`，这样 HTTP 上能种 cookie。密码哈希不依赖 secret key；拷贝库上的那一个 profile 被改成了预演专用密码，现网库没有写过。

| 检查 | 结果 |
|---|---|
| 官方 Dockerfile 不改 FROM | 失败，`dhi.io` 401。这是预期。 |
| 四个 bundle + 四份 `penpot-local/*:2.18.3` | 成功 |
| `pg_dump` custom format | 4.7MB。assets 只读拷贝 42.9MB |
| 恢复后、backend 启动前 | `migrations` 163 行，最新 `2026-10-06 19:10:31` |
| backend 日志 | 有 `running migrations`，**没有** `apply migration`。随后 `welcome to penpot`，`version=2.18.3` |
| backend 启动后 | 仍是 163 行，最新时间戳没变 |
| admin-console | 日志有 “Database migrations applied”。`drizzle.__drizzle_migrations` 仍是 8 行；`public` / `drizzle` / `nitrate` 的表数量与现网一致（60 / 1 / 9）。这是它自己的 schema，不是 Penpot `main` 迁移 |
| `GET /` | 200，标题 `Penpot \| Full-stack design` |
| 登录 `POST /api/rpc/command/login-with-password` | 200，种下 cookie `auth-token` |
| `get-all-projects` + `get-project-files` | 3 个项目、5 个文件，与现网 `deleted_at IS NULL` 的计数一致：Drafts（Academic Talk Slide Masters、Pencil \| Penpot Design System、New File 1）、Style Guide - OSDI-SOSP Systems、Style Guide - Systems Hybrid |
| `GET /plugins/mcp/manifest.json` | 200，`Penpot MCP Plugin` |
| `GET /mcp/stream` | 无 `Accept: text/event-stream` 时 406，带上之后 400 `Server not initialized`。都是 MCP 进程经 frontend 返回的 JSON-RPC。容器日志里注册了 `execute_code`、`high_level_overview`、`penpot_api_info`、`export_shape`，并在听 4401/4402 |
| 拆除 | `docker compose -p penpot-rehearsal down -v`，再删掉 compose 不认领的 assets 卷和编译缓存卷。拷贝的 dump 和预演密码已删 |
| 现网 | 八个容器的 `StartedAt` 仍是 2026-10-06。前后 `http://127.0.0.1:9001/` 都是 200。剩下的 Penpot 卷只有 `penpot_penpot_postgres_v15` 和 `penpot_penpot_assets` |

没有在浏览器里走 Cloudflare，也没有打开设计文件去连 MCP 插件。`/mcp/stream` 的 400/406 只说明服务在应答，不代表一次完整的工具调用。

本地还留着 `penpot-local/{frontend,backend,exporter,mcp}:2.18.3` 和 pull 下来的 `penpotapp/devenv:latest`、`penpotapp/imagemagick:7.1.2-27`。没有 push 到任何 registry。

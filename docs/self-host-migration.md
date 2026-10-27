# 自建镜像替换官方 `penpotapp/*:2.18` 的评估

这份笔记对应一台已经在跑的自部署（compose 项目名 `penpot`，镜像 `penpotapp/{frontend,backend,exporter,admin-console,mcp}:2.18`）。结论先说：**可以平滑换成从本仓库打出来的镜像，但有三个前提，缺一个都不要直接切。**

1. 自定义分支必须从 **tag `2.18.3`（`ff7a66f51938b2293260ea27a64e2c4e0833b5e3`）** 拉，不要从 `develop` 拉。
2. 官方 Dockerfile 的基础镜像在 `dhi.io`，匿名 pull 会 401。本机没有这份登录。要打出和上游一样的镜像，先 `docker login dhi.io`。
3. `admin-console` 不在这个仓库里。继续用 `penpotapp/admin-console:2.18`，除非另外构建 `penpot/penpot-nitrate`。

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

`penpotapp/admin-console:2.18` 的 source 是 `https://github.com/penpot/penpot-nitrate`，不是本仓库。`bundle_version=2.18.0-RC4-1-gd8dd1b8`，镜像创建于 2026-09-22。本仓库的 `.github/workflows/build-docker-admin-console.yml` 只是用 token 去 nitrate 仓库触发构建。公开 API 读不到 `9a009df`（404），这里也没有 nitrate 的源码。**这个 fork 打不出 admin-console。** 切换时这一项继续用官方镜像。

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

时间量级（这次预演的实测写在文末）：backend bundle 大约一分钟；exporter / frontend 的 shadow-cljs release 和 wasm 是主要耗时，按十几分钟到几十分钟估计；镜像层主要是 apt 和 playwright 的 Chromium 下载。

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

镜像要事先打好并在本地 `docker image inspect` 能看到。admin-console 保持官方 tag。

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
# penpot-admin-console 保持 penpotapp/admin-console:2.18
```

```bash
cd ~/penpot
docker compose -p penpot up -d
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

只重建 frontend、backend、exporter、mcp 四个容器。Postgres 和 Valkey 的镜像没变，卷也不换。backend 是 JVM，起来要一会儿。按这次机器的体量，HTTP 中断大约 **1–3 分钟**（镜像已经在本地的前提下）。没有在现网上实际切过，这个数字是容器重建加 JVM 启动的估计，不是计时过的现网切换。

### 回滚到 `penpotapp/*:2.18`

如果新容器起不来，或页面不对，但 **没有** `apply migration`：

```bash
cd ~/penpot
# 把那四行 image 改回 penpotapp/<name>:2.18
docker compose -p penpot up -d
```

数据卷没动，不需要恢复 dump。官方 `2.18` tag 此刻仍指 2.18.3；如果担心上游以后移动这个浮动 tag，回滚前先把现在的官方镜像再打一个本地钉死的 tag：

```bash
docker tag penpotapp/frontend:2.18 penpotapp/frontend:2.18.3-running
docker tag penpotapp/backend:2.18  penpotapp/backend:2.18.3-running
docker tag penpotapp/exporter:2.18 penpotapp/exporter:2.18.3-running
docker tag penpotapp/mcp:2.18      penpotapp/mcp:2.18.3-running
```

`docker tag` 不改正在跑的容器。

如果日志里出现了 `apply migration`（说明跑的不是 2.18.3 源码，或者库被别的版本写过），不要只换镜像。停应用容器，用备份把库和 assets 都倒回去，再起官方镜像：

```bash
cd ~/penpot
docker compose -p penpot stop \
  penpot-frontend penpot-backend penpot-exporter penpot-mcp penpot-admin-console

docker exec -i penpot-penpot-postgres-1 \
  psql -U penpot -d postgres -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='penpot' AND pid <> pg_backend_pid();"
docker exec -i penpot-penpot-postgres-1 \
  psql -U penpot -d postgres -c "DROP DATABASE penpot;"
docker exec -i penpot-penpot-postgres-1 \
  psql -U penpot -d postgres -c "CREATE DATABASE penpot OWNER penpot;"
docker exec -i penpot-penpot-postgres-1 \
  pg_restore -U penpot -d penpot --no-owner --no-acl \
  < ~/penpot-backups/penpot-${stamp}.dump

docker run --rm \
  -v penpot_penpot_assets:/to \
  -v "$HOME/penpot-backups:/backup:ro" \
  alpine \
  sh -c 'rm -rf /to/* /to/.[!.]* ; tar -C /to -xzf /backup/penpot-assets-STAMP.tgz'

# compose 里的 image 已改回 penpotapp/*:2.18
docker compose -p penpot up -d
```

`pg_restore` 之前要先看 dump 是不是 `-Fc`。上面的备份命令用的是 custom format。

### 以后跟上游同步

```bash
git fetch upstream --tags
git log --oneline 2.18.3..2.18.5
git diff --stat 2.18.3..2.18.5 -- backend/src/app/migrations
```

有新的 migration SQL，就把这次升级当成一次会改库的发布：备份、在一份拷贝上先跑（见预演），确认 `apply migration` 的列表，再切现网。没有新 migration，才可以按上面的「只换四份镜像」做。

功能分支从当前现网对应的 tag 拉，不要从 `develop` 拉。fork 上如果要保留 tag，可以在确认只推到自己的 origin 之后 `git push origin 2.18.3`。不要 `git push --tags` 到 upstream，也不要顺手把全部历史 tag 推上去。

`develop` 会继续往前走。合文档类 PR 进 `develop` 不会把现网基线改成 develop；打现网镜像时 checkout 的仍然必须是 `2.18.3`（或你下一次有意升级到的那个 tag）。

## 5. 预演（2026-10-27）

原则：现网项目 `penpot` 只做 `pg_dump` 和 assets 卷的只读拷贝。另一套 compose 项目 `penpot-rehearsal`，端口 `127.0.0.1:9101`，自己的卷，用完即删。mailcatch 不占 1080。不改 Cloudflare。编译限制 12 CPU、32GB 内存，runtime `runc`。

预演镜像用 `scripts/build-selfhost-images.sh --public-bases`（因为没有 DHI 登录）。源码是未修改的 `2.18.3`。admin-console 用官方 `penpotapp/admin-console:2.18`。

结果见下一次提交补上的实测小节。脚本和覆盖文件先落在这个分支上，避免预演用的命令和仓库里的脚本分叉。

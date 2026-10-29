# QQ 音乐 · Lite

按 `docs/qqmusic-lite-research.md` 的设计实现的轻量 QQ 音乐客户端：Tauri 2 + React 19 + TypeScript 领域层 + Rust 平台层，SQLite（WAL）+ 分级 TTL 缓存，暗色优先的三栏布局与底部播放条。

> 个人学习与自用项目。使用 QQ 音乐 Web CGI 的非官方接口，不分发、不上架、不商业化，不绕过任何付费限制。

## 快速开始

环境：

- Node.js ≥ 22（推荐 24，浏览器预览层使用内置 `node:sqlite`），npm ≥ 10
- Rust stable（MSVC 工具链）+ WebView2 Runtime（Windows 10/11 通常已自带）
- 首次构建会自动下载 crates 与 Tauri CLI

桌面应用（正式形态，Rust 平台层）：

```bash
npm install
npm run tauri:dev        # Vite + Tauri 窗口
npm run tauri:build      # 生成安装包
```

仅浏览器预览（Node 平台层，便于快速调 UI）：

```bash
npm run dev              # http://localhost:5273
npm run build && npm run preview
```

质量检查：

```bash
npm run typecheck
npm test                 # 37 个领域层 / 平台层单测
npm run test:rust        # 21 个 Rust 平台层单测
```

数据目录：

- Tauri：`%APPDATA%\com.qmusic.lite\`（`qmusic.db`、`guid`，凭证在 Windows 凭据管理器）
- 浏览器预览：`apps/desktop/.data/`（`qmusic.db`、`guid`、`credentials.json`）

| 文件 | 内容 |
|---|---|
| `qmusic.db` | SQLite：账号、歌单、歌曲、播放历史、每日推荐快照、设置、缓存 |
| 凭证 | Tauri：系统钥匙串，失败时退化为私有文件；浏览器预览：`credentials.json`（0600） |
| `guid` | 持久化设备标识，参与风控 |

## 已实现功能

| 优先级 | 功能 | 实现情况 |
|---|---|---|
| P0 | 扫码登录 | 二维码生成、`ptuiCB` 状态机（waiting/scanned/confirmed/expired/cancelled）、`check_sig → oauth → QQLogin` 完整链路、凭证持久化、启动静默续期 |
| P0 | 我的歌单 | 自建歌单列表、歌单详情、500 首/页翻页加载、SQLite 快照 |
| P0 | 我的收藏 | 收藏歌单、我喜欢（`dirid=201`）、红心读写 |
| P0 | 歌曲详情 | 歌名 / 歌手 / 专辑 / 时长 / 封面 / 音质标识 / VIP 与版权标识 |
| P0 | 播放 | vkey 取直链、FLAC→320→128→AAC 自动降级、播放/暂停/切歌/进度/音量/顺序-随机-单曲、403 重取、Media Session |
| P0 | 每日 30 首 | 从推荐流定位歌单 ID → 取详情 → 按天缓存（UTC+本地跨天刷新） |
| P1 | 推荐 | 首页推荐流（未登录为大众内容）、编辑精选歌单广场、换一批 |
| P1 | 搜索 | 单曲 / 歌单 / 歌手、smartbox 联想词、2001 风控退避重试 |
| P1 | 歌词 | base64 LRC 解码、翻译合并、逐行高亮滚动、未同步歌词兜底、点击跳转 |
| P1 | 最近播放 / 队列 | SQLite 最近 300 条、队列抽屉、队列恢复（`zustand/persist`） |
| P2 | 收藏操作 | 红心 / 取消红心（写接口使用 App comm，避免 80105） |
| — | 桌面体验 | 命令面板（Ctrl+K）、全局快捷键、明暗主题、侧栏折叠、Toast、骨架屏、虚拟滚动、封面取色渐变、错误边界 |

未实现（与文档的非目标/P2 对齐）：新建歌单、收藏专辑、歌手/专辑详情页、评论/MV/播客、桌面歌词、托盘、全局快捷键注册、微信扫码（P1）、多音源。

## 架构

依赖方向严格单向：`UI → 领域层 → IPC → 平台层`。

```text
apps/desktop/
├─ src/
│  ├─ app/                 # 启动、路由、注册表、Provider、错误边界
│  ├─ bridge/              # IPC 客户端：Tauri invoke / Node HTTP
│  ├─ features/            # auth home daily library playlist search player settings
│  └─ shared/              # ui / hooks / lib / styles(tokens.css)
├─ src-tauri/              # 平台层（Rust）：9 个逻辑命令、cookie、登录、SQLite、钥匙串
│  ├─ src/                 # auth / cookies / net / qq_api / db / secret / state / commands
│  ├─ capabilities/        # Tauri 2 权限
│  └─ tauri.conf.json
└─ server/                 # 平台层（Node，保留给浏览器预览）：同一 IPC 契约
packages/
├─ core/                   # 领域层：endpoints / zod 映射 / services / cache / player 算法
└─ shared-types/           # 领域模型与 IPC DTO
```

### IPC 契约

业务命令面保持狭窄，与文档 §5.3 一致：

| 命令 | 说明 |
|---|---|
| `auth.qr_start` / `auth.qr_poll` | 二维码只以 data URL 回传；状态机驱动文案 |
| `auth.restore` / `auth.logout` | 启动恢复 + 静默续期；退出时清凭证与会话 |
| `api.call` | 统一 CGI，自动注入会话 Cookie，`module/method` 白名单 |
| `api.legacy` | 老 CGI（联想词 / 用户资料），域名白名单 |
| `sys.info` | 版本、运行时、平台 |
| `db.select` / `db.execute` | 仅 repository 层使用的单语句 DML |

`comm.uin`、`qm_keyst`、`qqmusic_key` 由平台层强制覆盖，渲染层传入无效。凭证不会出现在任何 IPC 返回值中。

### 平台层

主实现是 **Tauri 2 / Rust**（`apps/desktop/src-tauri`）：

- `auth.rs` — 二维码、`ptuiCB` 状态机、`check_sig → oauth → QQLogin`、续期、资料
- `cookies.rs` — 带域匹配的 cookie jar（`qrsig` 在 `ptlogin2.qq.com`，`p_skey` 在 `graph.qq.com`）
- `net.rs` — 串行 + 180ms 最小间隔 + 退避，自动回写 Set-Cookie
- `qq_api.rs` — `api.call` 白名单、comm/凭证注入、老 CGI 域名白名单
- `db.rs` — 与文档 §6.2 一致的 SQLite schema、单语句/关键字校验
- `secret.rs` — `keyring` 写入 Windows 凭据管理器，失败时退化 0600 文件
- `commands.rs` — Tauri 命令不能带点号，因此注册单一 `ipc` 命令，在 Rust 内按 `auth.qr_start` 等点号名分发；前端命令面与 Node 层完全一致

`apps/desktop/server` 是等价的 Node 实现，只用于浏览器预览（Vite `/__api`）。两条路径共享同一个前端 bridge：检测到 `__TAURI_INTERNALS__` 走 Tauri，否则走 HTTP。

### 数据与缓存

表结构与文档 §6.2 一致（`song` 增加 `media_mid`，`cache_entry` 为缓存扩展）。凭证不进 SQLite。

| 资源 | TTL |
|---|---|
| 歌单列表 / 详情 | 10 min |
| 推荐流 / 歌单广场 | 30 min |
| 歌曲详情 / 歌词 | 30 天（持久化到 SQLite） |
| 播放直链 | 20 min，403 立即失效重取 |
| 每日 30 首 | 当日 24:00 |

校验失败不抛到页面：记录接口与字段，退化为缓存或空结果，UI 给出轻提示。

## 设计实现

- 视觉系统是「花期（Bloom）」：暖白纸面 + 钢琴卷帘网格 + 陶土色唯一实心控件；白天默认，夜里是同一套材料的暗色。`--cover-a/--cover-b` 驱动封面取色渐变。
- 布局：228px 侧栏（可折叠 64px）+ 52px 顶栏 + 68px 悬浮播放条，切页不跳动。
- 窗口无系统边框（`decorations: false`）：顶栏同时是标题栏，整行可拖动，右端是自绘的最小化 / 最大化 / 关闭。
- 列表：`@tanstack/react-virtual`，行高 52px，万级列表可用。
- 播放页：封面 1:1、歌词独立滚动区、逐行高亮。
- 快捷操作路径：点歌即播（1 步）；播放条/播放页均可收藏、切队列。

快捷键：`Space` 播放/暂停，`←/→` 快退/快进 5s，`Ctrl+←/→` 上/下一首，`Ctrl+K` 命令面板，`Ctrl+F` 搜索，`Esc` 关闭覆盖层，`M` 静音。

## 验证记录

- Rust：`cargo check` 通过，`cargo test` 21 个用例全部通过；`tauri dev` 联调通过；`tauri build --debug` 生成 NSIS 安装包（4.46 MiB）。
- Tauri 实机（WebView2 远程调试）：窗口正常启动并渲染真实数据；通过 IPC 实测 `sys.info`、`db.select`、`db.execute`、`auth.qr_start`、`auth.qr_poll`（waiting）、`api.call`（歌单详情 76 首）；登录页二维码正常显示，歌单页、播放页歌词（49 行）正常。
- 匿名链路实测通过：二维码生成 / 轮询、歌单详情、歌曲详情、歌词（base64）、推荐流、歌单广场。
- 搜索接口在匿名/高频请求下会返回空列表（Node 与 Tauri 同时复现，属服务端风控）；UI 已做「稍后重试或扫码登录」兜底。
- 播放直链在未登录时返回空 `purl` 或业务错误，按文档降级并提示，不尝试破解。
- 未完成真人扫码闭环：需要账号持有人用手机确认；`check_sig → oauth → QQLogin` 代码路径已按文档实现并做了错误分支兜底。

## 免责声明

本项目仅用于个人学习，与腾讯 / QQ 音乐无关。接口可能随时变更，请遵守 QQ 音乐用户协议；请勿用于分发、商业化或任何绕过付费的用途。

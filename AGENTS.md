# Repository Guidelines

## 项目结构与模块

- `src/index.ts`: 主任务入口，读取 `config/settings.json`，串联飞书数据拉取、广告素材过滤与批量处理；编译后输出 `dist/index.js`，如开启定时会循环执行。
- `src/proxy.ts`: 本地 HTTP 代理，转发至 OceanEngine，便于绕过 CORS/抓包调试；端口可用 `PROXY_PORT` 覆盖，默认 3001。
- `config/`: 运行时私有配置（cookie、账户/剧名映射、时间窗口等），禁止提交敏感信息；可按环境创建多个文件手动切换。
- 根目录：`pnpm-lock.yaml` 锁定依赖；`tsconfig.json` 统一编译目标；`node_modules/` 不应入库；当前无独立测试目录。

## 架构与流程

- 主流程：获取飞书 token -> 搜索记录 -> 依据剧名匹配广告 -> 拉取素材 -> 过滤/删除或操作；通过 `p-limit` 控制并发。
- 可选调度：`scheduleIntervalMinutes` 控制循环周期；`buildTimeFilterWindowStart/End` 确定时间窗口过滤，避免误删。
- 代理链路：外部请求改为指向 `http://localhost:<PORT>/api/proxy/*`，请求头透传 cookie/user-agent，响应附带 CORS 头便于前端调试。

## 开发、构建与运行

- 初始化依赖：`pnpm install`（优先使用 pnpm，node 建议 >=18）。
- 开发调试：`pnpm dev -- --config ./config/settings.json`，tsx 直接运行 TS，可替换配置路径以测试不同账户；需代理时同时跑 `pnpm proxy`。
- 构建产物：`pnpm build`，调用 `tsc` 生成 `dist/`；构建前确保配置存在且路径正确。
- 生产运行：`pnpm start -- --config ./config/settings.json`，使用编译后的 JS 与指定配置；后台运行可结合 pm2/systemd。

## 编码风格与命名

- TypeScript + ESM，2 空格缩进，优先 async/await；避免 any，补全类型定义与接口响应约束。
- 变量/函数 camelCase，常量全大写；新增配置字段须同步接口类型与默认值，避免魔法数字。
- 日志统一 `[INFO]/[WARN]/[ERROR]` 前缀；注释与文档均用中文，保持简洁可维护；提交前移除临时调试输出。

## 测试指南

- 当前无自动化测试；提交前至少本地跑 `pnpm build` + `pnpm dev` 覆盖核心流程。
- 建议补充集成测试（如 vitest + supertest）：飞书 token 失败重试、素材过滤边界、代理 4xx/5xx 回退与超时处理；关键分支可补覆盖率基线（如 70%+）。
- 用例命名建议 `should_<行为>`；如涉及外部接口，请使用 mock，避免真实请求与限流。

## 提交与 PR

- 历史 commit 较简短，推荐 Conventional Commits：`feat|fix|chore|docs|refactor` 等前缀并配合动词短语。
- PR 描述需包含：变更目的、主要修改点、验证方式（命令/日志/截图）、风险与回滚方案；涉及配置时注意脱敏。
- 分支策略：默认分支 `main`，功能分支建议 `feature/<topic>`；合并前 rebase/确保无冲突。
- 提交前自检：不引入多余依赖，构建通过，临时调试日志/注释清理，敏感信息未泄漏。

## 安全与配置

- 不要提交 cookie、token、剧名映射等机密；使用 `.gitignore` 忽略本地配置，必要时改为环境变量注入。
- 代理默认允许任意来源，若部署到外网需限制来源或增加鉴权，防止内部接口被滥用。
- 关注飞书与广告接口的配额/速率限制，必要时调整 `fetchConcurrency`、重试与延时策略，避免触发风控。

## 调试与日志

- 常用路径：`config/settings.json` 管理账户与窗口；`dist/` 为编译产物，排查线上问题可比对源/编译文件。
- 出现异常时优先查看 `[ERROR]` 日志，必要时在局部增加 `[DEBUG]`，提交前移除；抓包可配合本地代理并记录请求头与响应体。
- 频繁报错或速率受限时，降低并发、增加 `previewDelayMs`、检查 cookie 有效期，并尝试在 dev 模式下复现；需要时可启用 `--expose-gc` 并调用 `global.gc?.()` 观察内存情况。

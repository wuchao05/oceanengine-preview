# oceanengine-preview

独立的巨量广告预览服务，已从 `ad-runner` 中拆分出来，专门负责以下能力：

- 单账户素材分析、预览、停用
- 多账户批量预览
- 从飞书拉取已完成记录后自动预览
- 预览管理器定时执行与状态持久化

## 安装

```bash
pnpm install
```

## 启动

```bash
pnpm dev
```

默认端口是 `3100`，可通过环境变量覆盖：

```bash
HTTP_PORT=3200 pnpm dev
```

## 目录说明

- `src/preview-service.ts`：预览核心逻辑
- `src/preview-manager.ts`：多用户定时预览管理器
- `src/config-service.ts`：远程配置拉取
- `src/http-server.ts`：独立 HTTP 服务入口
- `config/users/feishu-*.json`：用户飞书配置

## 主要接口

- `POST /preview/analyze`
- `POST /preview/execute`
- `POST /preview/stop`
- `POST /preview/batch`
- `POST /preview/feishu`
- `POST /preview-manager/start`
- `POST /preview-manager/stop`
- `POST /preview-manager/update`
- `GET /preview-manager/status`

## 关键参数

单账户接口通常需要：

- `aadvid`
- `drama_name`
- `cookie`

批量/飞书接口额外支持：

- `subject`
- `aweme_white_list`
- `cookieChaoqi`
- `cookieXinya`
- `cookieMeiri`

## 配置说明

- Ocean Cookie 默认通过远程配置服务 `https://cxyy.top/api/auth/config` 获取
- 预览管理器会优先读取 `config/users/feishu-<user>.json`
- 运行状态会写入 `data/preview-states.json`

## 代理调试

如果需要本地代理抓包，还可以单独运行：

```bash
pnpm proxy
```

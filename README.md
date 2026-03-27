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
- `src/http-server.ts`：独立 HTTP 服务入口
- `config/users/`：飞书配置，当前会优先尝试按 `user + channel` 解析，找不到时回退到用户级配置

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

## 接口文档

所有接口默认监听：

```bash
http://127.0.0.1:3100
```

请求体统一使用 `application/json`，布尔值和数字请直接传 JSON 类型，不要传字符串。

### 1. `GET /health`

用途：健康检查

请求参数：无

响应示例：

```json
{
  "status": "ok"
}
```

### 2. `POST /preview/analyze`

用途：分析某个账户下哪些素材需要预览、删除，哪些广告可以整单删除

必填参数：

- `aadvid: string`：广告主 ID
- `drama_name: string`：剧名，用来匹配广告名
- `cookie: string`：巨量后台 Cookie

可选参数：

- `aweme_white_list: string[]`：抖音号白名单

请求示例：

```bash
curl -X POST http://127.0.0.1:3100/preview/analyze \
  -H "Content-Type: application/json" \
  -d '{
    "aadvid": "1234567890",
    "drama_name": "示例剧名",
    "cookie": "your_cookie",
    "aweme_white_list": ["小红看剧", "斯娜看剧"]
  }'
```

### 3. `POST /preview/execute`

用途：先分析，再对需要预览的素材逐条执行预览

必填参数：

- `aadvid: string`
- `drama_name: string`
- `cookie: string`

可选参数：

- `aweme_white_list: string[]`
- `delayMs: number`：两次预览之间的间隔，默认 `400`

请求示例：

```bash
curl -X POST http://127.0.0.1:3100/preview/execute \
  -H "Content-Type: application/json" \
  -d '{
    "aadvid": "1234567890",
    "drama_name": "示例剧名",
    "cookie": "your_cookie",
    "delayMs": 500
  }'
```

### 4. `POST /preview/stop`

用途：先分析，再删除有问题的素材；可选删除整条广告

必填参数：

- `aadvid: string`
- `drama_name: string`
- `cookie: string`

可选参数：

- `aweme_white_list: string[]`
- `deleteAds: boolean`：是否删除 `canDeletePromotions` 中的整条广告，默认 `false`

请求示例：

```bash
curl -X POST http://127.0.0.1:3100/preview/stop \
  -H "Content-Type: application/json" \
  -d '{
    "aadvid": "1234567890",
    "drama_name": "示例剧名",
    "cookie": "your_cookie",
    "deleteAds": true
  }'
```

### 5. `POST /preview/batch`

用途：批量处理多个账户，支持 dry-run 和统一 Cookie

必填参数：

- `accounts: Array<object>`：账户数组，不能为空

`accounts[]` 内每项必填参数：

- `aadvid: string`
- `drama_name: string`

`accounts[]` 内每项可选参数：

- `cookie: string`：账户专用 Cookie，优先级最高
- `aweme_white_list: string[]`

请求体顶层可选参数：

- `dryRun: boolean`：只分析不执行
- `previewDelayMs: number`：预览间隔，默认 `400`
- `cookie: string`：统一给所有未单独配置 Cookie 的账户使用

Cookie 选择顺序：

1. `accounts[i].cookie`
2. 顶层 `cookie`

请求示例：

```bash
curl -X POST http://127.0.0.1:3100/preview/batch \
  -H "Content-Type: application/json" \
  -d '{
    "dryRun": false,
    "previewDelayMs": 400,
    "cookie": "shared_cookie",
    "accounts": [
      {
        "aadvid": "1234567890",
        "drama_name": "剧A",
        "aweme_white_list": ["小红看剧"]
      },
      {
        "aadvid": "9876543210",
        "drama_name": "剧B"
      }
    ]
  }'
```

### 6. `POST /preview/feishu`

用途：从飞书拉取“已完成”记录，按时间窗口过滤后批量执行预览

请求体可选参数：

- `buildTimeFilterWindowStartMinutes: number`：时间窗口起始，默认 `90`
- `buildTimeFilterWindowEndMinutes: number`：时间窗口结束，默认 `20`
- `aweme_white_list: string[]`
- `dryRun: boolean`
- `previewDelayMs: number`
- `cookie: string`：统一给飞书拉取到的账户使用
- `feishu: object`：自定义飞书配置

`feishu` 内可选字段：

- `appId: string`
- `appSecret: string`
- `appToken: string`
- `baseUrl: string`

说明：

- 不传 `feishu` 时，使用代码内默认飞书配置
- 不传 `cookie` 时，飞书拉取到的账户没有可用 Cookie，将无法执行

请求示例：

```bash
curl -X POST http://127.0.0.1:3100/preview/feishu \
  -H "Content-Type: application/json" \
  -d '{
    "buildTimeFilterWindowStartMinutes": 90,
    "buildTimeFilterWindowEndMinutes": 20,
    "previewDelayMs": 400,
    "dryRun": false,
    "aweme_white_list": ["小红看剧", "斯娜看剧"],
    "cookie": "shared_cookie"
  }'
```

### 7. `POST /preview-manager/start`

用途：启动某个用户下某个渠道的定时预览程序

必填参数：

- `user: string`：用户标识
- `channel: string`：渠道标识
- `intervalMinutes: number`：轮询间隔，必须大于 `0`
- `aweme_white_list: string[]`
- `cookie: string`：定时预览时使用的 Cookie

可选参数：

- `buildTimeWindowStart: number`：默认 `90`
- `buildTimeWindowEnd: number`：默认 `20`

说明：

- 预览管理器会按 `user + channel` 维度独立运行，因此同一个 `user` 可以同时跑多个 `channel`
- 当前飞书配置会优先尝试以下路径：
  - `config/users/<user>-<channel>.json`
  - `config/users/feishu-<user>-<channel>.json`
  - `config/users/<user>/<channel>.json`
  - `config/users/feishu-<user>.json`

请求示例：

```bash
curl -X POST http://127.0.0.1:3100/preview-manager/start \
  -H "Content-Type: application/json" \
  -d '{
    "user": "xh-mr",
    "channel": "每日",
    "intervalMinutes": 20,
    "cookie": "your_cookie",
    "aweme_white_list": ["小红看剧", "斯娜看剧"]
  }'
```

### 8. `POST /preview-manager/stop`

用途：停用某个用户下某个渠道的定时预览程序

必填参数：

- `user: string`
- `channel: string`

请求示例：

```bash
curl -X POST http://127.0.0.1:3100/preview-manager/stop \
  -H "Content-Type: application/json" \
  -d '{
    "user": "xh-mr",
    "channel": "每日"
  }'
```

### 9. `POST /preview-manager/update`

用途：更新某个用户下某个渠道预览程序的运行配置，不会先停再启

必填参数：

- `user: string`
- `channel: string`

可选参数：

- `intervalMinutes: number`
- `aweme_white_list: string[]`
- `cookie: string`
- `buildTimeWindowStart: number`
- `buildTimeWindowEnd: number`

请求示例：

```bash
curl -X POST http://127.0.0.1:3100/preview-manager/update \
  -H "Content-Type: application/json" \
  -d '{
    "user": "xh-mr",
    "channel": "每日",
    "intervalMinutes": 30,
    "cookie": "new_cookie",
    "buildTimeWindowStart": 120,
    "buildTimeWindowEnd": 30
  }'
```

### 10. `GET /preview-manager/status`

用途：查看全部预览程序状态，或查看某个用户 / 某个渠道的状态

查询参数：

- `user: string`：可选，不传则返回全部用户
- `channel: string`：可选，不传则返回全部渠道

请求示例：

```bash
curl "http://127.0.0.1:3100/preview-manager/status"
curl "http://127.0.0.1:3100/preview-manager/status?user=xh-mr"
curl "http://127.0.0.1:3100/preview-manager/status?user=xh-mr&channel=%E6%AF%8F%E6%97%A5"
```

## 配置说明

- 预览管理器会优先按 `user + channel` 解析飞书配置，找不到时回退到用户级配置
- 运行状态会写入 `data/preview-states.json`

## 代理调试

如果需要本地代理抓包，还可以单独运行：

```bash
pnpm proxy
```

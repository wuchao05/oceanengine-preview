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

- `subject: string`：主体，可传 `超琦`、`虎雨`、`欣雅`、`每日`
- `aweme_white_list: string[]`：抖音号白名单
- `tableId: string`：来源飞书表 ID，仅做透传保留

请求示例：

```bash
curl -X POST http://127.0.0.1:3100/preview/analyze \
  -H "Content-Type: application/json" \
  -d '{
    "aadvid": "1234567890",
    "drama_name": "示例剧名",
    "cookie": "your_cookie",
    "subject": "每日",
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

- `subject: string`
- `aweme_white_list: string[]`
- `tableId: string`
- `delayMs: number`：两次预览之间的间隔，默认 `400`

请求示例：

```bash
curl -X POST http://127.0.0.1:3100/preview/execute \
  -H "Content-Type: application/json" \
  -d '{
    "aadvid": "1234567890",
    "drama_name": "示例剧名",
    "cookie": "your_cookie",
    "subject": "每日",
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

- `subject: string`
- `aweme_white_list: string[]`
- `tableId: string`
- `deleteAds: boolean`：是否删除 `canDeletePromotions` 中的整条广告，默认 `false`

请求示例：

```bash
curl -X POST http://127.0.0.1:3100/preview/stop \
  -H "Content-Type: application/json" \
  -d '{
    "aadvid": "1234567890",
    "drama_name": "示例剧名",
    "cookie": "your_cookie",
    "subject": "每日",
    "deleteAds": true
  }'
```

### 5. `POST /preview/batch`

用途：批量处理多个账户，支持 dry-run、主体 Cookie 自动映射

必填参数：

- `accounts: Array<object>`：账户数组，不能为空

`accounts[]` 内每项必填参数：

- `aadvid: string`
- `drama_name: string`

`accounts[]` 内每项可选参数：

- `cookie: string`：账户专用 Cookie，优先级最高
- `subject: string`
- `aweme_white_list: string[]`
- `tableId: string`

请求体顶层可选参数：

- `dryRun: boolean`：只分析不执行
- `previewDelayMs: number`：预览间隔，默认 `400`
- `cookieChaoqi: string`：`超琦`/`虎雨` 主体使用
- `cookieXinya: string`：`欣雅` 主体使用
- `cookieMeiri: string`：`每日` 主体使用

Cookie 选择顺序：

1. `accounts[i].cookie`
2. 按 `subject` 选择对应的 `cookieChaoqi / cookieXinya / cookieMeiri`
3. 兜底使用第一个可用的全局 Cookie

请求示例：

```bash
curl -X POST http://127.0.0.1:3100/preview/batch \
  -H "Content-Type: application/json" \
  -d '{
    "dryRun": false,
    "previewDelayMs": 400,
    "cookieChaoqi": "cookie_for_chaoqi",
    "cookieXinya": "cookie_for_xinya",
    "cookieMeiri": "cookie_for_meiri",
    "accounts": [
      {
        "aadvid": "1234567890",
        "drama_name": "剧A",
        "subject": "每日",
        "aweme_white_list": ["小红看剧"]
      },
      {
        "aadvid": "9876543210",
        "drama_name": "剧B",
        "subject": "欣雅"
      }
    ]
  }'
```

### 6. `POST /preview/feishu`

用途：从飞书拉取“已完成”记录，按时间窗口过滤后批量执行预览

请求体可选参数：

- `subject: string`：只处理指定主体
- `buildTimeFilterWindowStartMinutes: number`：时间窗口起始，默认 `90`
- `buildTimeFilterWindowEndMinutes: number`：时间窗口结束，默认 `20`
- `aweme_white_list: string[]`
- `dryRun: boolean`
- `previewDelayMs: number`
- `cookieChaoqi: string`
- `cookieXinya: string`
- `cookieMeiri: string`
- `feishu: object`：自定义飞书配置

`feishu` 内可选字段：

- `appId: string`
- `appSecret: string`
- `appToken: string`
- `tableId: string`
- `baseUrl: string`

说明：

- 不传 `feishu` 时，使用代码内默认飞书配置
- 如果传了 `subject`，只会处理飞书里该主体的记录
- 实际执行时仍然会根据飞书记录里的主体去匹配 Cookie

请求示例：

```bash
curl -X POST http://127.0.0.1:3100/preview/feishu \
  -H "Content-Type: application/json" \
  -d '{
    "subject": "每日",
    "buildTimeFilterWindowStartMinutes": 90,
    "buildTimeFilterWindowEndMinutes": 20,
    "previewDelayMs": 400,
    "dryRun": false,
    "aweme_white_list": ["小红看剧", "斯娜看剧"],
    "cookieMeiri": "cookie_for_meiri"
  }'
```

### 7. `POST /preview-manager/start`

用途：启动某个用户的定时预览程序

必填参数：

- `user: string`：用户标识，对应 `config/users/feishu-<user>.json`
- `intervalMinutes: number`：轮询间隔，必须大于 `0`
- `aweme_white_list: string[]`

可选参数：

- `subject: string`
- `tableId: string`：覆盖用户默认飞书表
- `buildTimeWindowStart: number`：默认 `90`
- `buildTimeWindowEnd: number`：默认 `20`

请求示例：

```bash
curl -X POST http://127.0.0.1:3100/preview-manager/start \
  -H "Content-Type: application/json" \
  -d '{
    "user": "xh-mr",
    "intervalMinutes": 20,
    "subject": "每日",
    "aweme_white_list": ["小红看剧", "斯娜看剧"]
  }'
```

### 8. `POST /preview-manager/stop`

用途：停用某个用户的定时预览程序

必填参数：

- `user: string`

请求示例：

```bash
curl -X POST http://127.0.0.1:3100/preview-manager/stop \
  -H "Content-Type: application/json" \
  -d '{
    "user": "xh-mr"
  }'
```

### 9. `POST /preview-manager/update`

用途：更新某个用户预览程序的运行配置，不会先停再启

必填参数：

- `user: string`

可选参数：

- `intervalMinutes: number`
- `aweme_white_list: string[]`
- `subject: string`
- `buildTimeWindowStart: number`
- `buildTimeWindowEnd: number`

请求示例：

```bash
curl -X POST http://127.0.0.1:3100/preview-manager/update \
  -H "Content-Type: application/json" \
  -d '{
    "user": "xh-mr",
    "intervalMinutes": 30,
    "buildTimeWindowStart": 120,
    "buildTimeWindowEnd": 30
  }'
```

### 10. `GET /preview-manager/status`

用途：查看全部预览程序状态，或查看单个用户状态

查询参数：

- `user: string`：可选，不传则返回全部

请求示例：

```bash
curl "http://127.0.0.1:3100/preview-manager/status"
curl "http://127.0.0.1:3100/preview-manager/status?user=xh-mr"
```

## 配置说明

- Ocean Cookie 默认通过远程配置服务 `https://cxyy.top/api/auth/config` 获取
- 预览管理器会优先读取 `config/users/feishu-<user>.json`
- 运行状态会写入 `data/preview-states.json`

## 代理调试

如果需要本地代理抓包，还可以单独运行：

```bash
pnpm proxy
```

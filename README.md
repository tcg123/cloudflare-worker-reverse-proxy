# Cloudflare Worker 可配置 HTTP(S) 反向代理

不需要 Wrangler，也不需要本地安装依赖。直接在 Cloudflare 控制台创建
Worker、粘贴 `src/index.js` 的代码，然后使用 Variables and Secrets 配置目标。

## 1. 创建 Worker

1. 登录 Cloudflare Dashboard。
2. 进入 **Workers & Pages**，创建一个 Worker。
3. 打开在线代码编辑器，将 `src/index.js` 的内容完整粘贴进去并部署。
4. 在 Worker 的 **Settings → Runtime** 中，将 Compatibility Date 设置为
   `2024-09-02` 或更新日期。旧项目也可以添加 `allow_custom_ports`
   Compatibility Flag，以允许 `fetch()` 使用自定义端口。

## 2. 配置 Variables and Secrets

进入 Worker 的 **Settings → Variables and Secrets → Add**。

### 必需变量

| 名称 | 类型 | 示例 | 说明 |
| --- | --- | --- | --- |
| `TARGET_HOST` | Text 或 Secret | `123.com` | 只填写域名，不带协议、端口和路径 |
| `TARGET_PORT` | Text | `53623` | 上游端口，范围 1–65535 |

如果目标地址不希望显示在控制台中，可以把 `TARGET_HOST` 建成 Secret；Worker
读取 Text 和 Secret 的方式相同。

### 可选变量

| 名称 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `TARGET_SCHEME` | Text | `https` | 可设为 `http` 或 `https` |
| `TARGET_BASE_PATH` | Text | 空 | 上游统一路径前缀，例如 `/api` |
| `PUBLIC_ORIGIN` | Text | 当前访问域名 | 例如 `https://abc.com`，不要在这里填写端口 |
| `PUBLIC_PORT` | Text | `443` | Cloudflare 对外监听的 HTTPS 端口 |
| `REWRITE_REDIRECTS` | Text | `true` | 是否把上游 `Location` 改回公开域名 |
| `REWRITE_COOKIE_DOMAIN` | Text | `true` | 是否改写匹配的 Cookie Domain |
| `REWRITE_ORIGIN` | Text | `false` | 是否把同站 Origin/Referer 改成上游地址 |

### 可选密钥

| 名称 | 类型 | 示例 | 说明 |
| --- | --- | --- | --- |
| `UPSTREAM_AUTHORIZATION` | Secret | `Bearer abc123` | 覆盖发往上游的完整 Authorization 请求头 |

如果上游不需要固定认证，不要创建 `UPSTREAM_AUTHORIZATION`。创建后，客户端
传入的 Authorization 会被此 Secret 覆盖。

本例应至少添加：

```text
TARGET_SCHEME = https
TARGET_HOST   = 123.com
TARGET_PORT   = 53623
PUBLIC_ORIGIN = https://abc.com
PUBLIC_PORT   = 443
```

修改变量或 Secret 后，需要保存并部署新版本才能生效。

## 3. 绑定公开域名

进入 Worker 的 **Settings → Domains & Routes → Add → Custom Domain**，填写
`abc.com`。域名必须位于当前 Cloudflare 账户管理的 Zone 中。客户端随后访问：

```text
https://abc.com/path?x=1
```

Worker 将请求转发至：

```text
https://123.com:53623/path?x=1
```

如需使用非默认端口，可将 `PUBLIC_PORT` 改为 Cloudflare 支持的 HTTPS 端口，
例如：

```text
PUBLIC_ORIGIN = https://abc.com
PUBLIC_PORT   = 8443
```

对应访问地址为 `https://abc.com:8443/path`。代码会校验实际请求端口，并在
重写上游重定向时保留 `:8443`。

Cloudflare 普通 HTTP/HTTPS 代理不能监听任意端口。HTTPS 仅支持：

```text
443, 2053, 2083, 2087, 2096, 8443
```

因此 `https://abc.com:1234` 无法通过 Worker 变量实现：连接在到达 Worker
之前就会被 Cloudflare 边缘层拒绝。必须改用上述端口之一；若必须使用 1234，
需要 Cloudflare Spectrum（自定义 TCP/UDP 通常需要 Enterprise）或一台能监听
1234 的外部反向代理服务器，而不是这个 Worker。

## 限制和排障

- 这是 HTTP/HTTPS 七层代理，不是通用 TCP/UDP 或 Nginx `stream` 代理。
- `PUBLIC_PORT` 只能使用 Cloudflare 支持的 HTTPS 代理端口，不能让 Worker
  动态开放任意入站端口。
- 非标准上游端口适用于未被 Cloudflare 代理的目标域名（DNS-only/灰云）。如果
  `123.com` 是橙云记录，请使用一个灰云源站域名，例如 `origin.123.com`。
- HTTPS 上游必须提供受信任且与 `TARGET_HOST` 匹配的证书。
- Workers 不能连接 localhost、私网地址或被禁止的 Cloudflare IP 目标。
- HTML、JS、CSS 内写死的上游绝对 URL 不会被替换；应尽量在上游应用中将
  External URL/Base URL 配置为 `https://abc.com`。
- `502 Bad Gateway` 通常表示 DNS、端口、防火墙或 TLS 证书存在问题。可在
  Worker 的 Logs 中查看 `Upstream request failed` 错误。

## 测试

```bash
curl -I https://abc.com/
curl -i "https://abc.com/some/path?x=1"
```

WebSocket 客户端可以直接连接 `wss://abc.com/path`；代码会转发 Upgrade 请求。

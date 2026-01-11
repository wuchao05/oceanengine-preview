import express, {} from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import cors from "cors";
const app = express();
const PORT = process.env.PROXY_PORT || 3001;
const TARGET = "https://ad.oceanengine.com";
// 启用 CORS
app.use(cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: [
        "Content-Type",
        "Authorization",
        "Cookie",
        "User-Agent",
        "Accept",
        "Accept-Encoding",
    ],
    credentials: true,
}));
// 创建代理中间件
const proxyOptions = {
    target: TARGET,
    changeOrigin: true,
    secure: true,
    timeout: 60000, // 60秒超时
    proxyTimeout: 60000, // 代理请求超时
    pathRewrite: {
        "^/api/proxy": "", // 移除 /api/proxy 前缀
    },
    onProxyReq: (proxyReq, req, res) => {
        // 记录请求信息
        console.log(`\n[PROXY REQUEST] ${req.method} ${req.path}`);
        console.log(`[PROXY REQUEST] Headers:`, JSON.stringify(req.headers, null, 2));
        // 保留原始请求头
        const originalHeaders = req.headers;
        // 设置必要的请求头
        if (originalHeaders["content-type"]) {
            proxyReq.setHeader("Content-Type", originalHeaders["content-type"]);
        }
        if (originalHeaders["cookie"]) {
            proxyReq.setHeader("Cookie", originalHeaders["cookie"]);
        }
        if (originalHeaders["user-agent"]) {
            proxyReq.setHeader("User-Agent", originalHeaders["user-agent"]);
        }
        else {
            proxyReq.setHeader("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0.0.0 Safari/537.36");
        }
        // 移除可能引起问题的头
        proxyReq.removeHeader("host");
    },
    onProxyRes: (proxyRes, req, res) => {
        // 添加 CORS 头到响应
        proxyRes.headers["access-control-allow-origin"] = "*";
        proxyRes.headers["access-control-allow-methods"] =
            "GET, POST, PUT, DELETE, OPTIONS";
        proxyRes.headers["access-control-allow-headers"] =
            "Content-Type, Authorization, Cookie, User-Agent, Accept, Accept-Encoding";
        proxyRes.headers["access-control-allow-credentials"] = "true";
        // 移除可能导致问题的头
        delete proxyRes.headers["x-frame-options"];
        delete proxyRes.headers["content-security-policy"];
        // 记录响应状态和头
        console.log(`\n[PROXY RESPONSE] Status: ${proxyRes.statusCode}`);
        console.log(`[PROXY RESPONSE] Headers:`, JSON.stringify(proxyRes.headers, null, 2));
        // 读取并记录响应体
        const originalWrite = res.write.bind(res);
        const originalEnd = res.end.bind(res);
        let responseBody = Buffer.alloc(0);
        res.write = function (chunk, encoding) {
            if (chunk) {
                responseBody = Buffer.concat([responseBody, Buffer.from(chunk)]);
            }
            return originalWrite(chunk, encoding);
        };
        res.end = function (chunk, encoding) {
            if (chunk) {
                responseBody = Buffer.concat([responseBody, Buffer.from(chunk)]);
            }
            // 打印响应体
            try {
                const bodyString = responseBody.toString("utf-8");
                if (bodyString) {
                    try {
                        const parsed = JSON.parse(bodyString);
                        console.log(`[PROXY RESPONSE] Body:`, JSON.stringify(parsed, null, 2));
                    }
                    catch {
                        console.log(`[PROXY RESPONSE] Body (text):`, bodyString.substring(0, 1000));
                    }
                }
            }
            catch (err) {
                console.log(`[PROXY RESPONSE] Body (buffer):`, responseBody.toString("hex").substring(0, 200));
            }
            console.log(`[PROXY RESPONSE] ===== End =====\n`);
            return originalEnd(chunk, encoding);
        };
    },
    onError: (err, req, res) => {
        console.error("[PROXY ERROR]", err.message);
        res.status(500).json({
            error: "Proxy Error",
            message: err.message,
        });
    },
};
const proxyMiddleware = createProxyMiddleware(proxyOptions);
// 所有请求都通过代理
app.use("/api/proxy", proxyMiddleware);
// 健康检查端点
app.get("/health", (req, res) => {
    res.json({ status: "ok", target: TARGET, port: PORT });
});
app.listen(PORT, () => {
    console.log(`[PROXY] 代理服务器运行在 http://localhost:${PORT}`);
    console.log(`[PROXY] 目标服务器: ${TARGET}`);
    console.log(`[PROXY] 使用方式: 将请求地址改为 http://localhost:${PORT}/api/proxy/...`);
});
//# sourceMappingURL=proxy.js.map
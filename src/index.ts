import { PreviewHttpServer } from "./http-server.js";

const server = new PreviewHttpServer();

(async () => {
  await server.start();
})().catch((error) => {
  console.error("❌ 预览服务启动失败:", error);
  process.exit(1);
});

const gracefulShutdown = (signal: string) => {
  console.log(`\n收到 ${signal} 信号，正在优雅关闭预览服务...`);
  server.stopAllTimers();
  process.exit(0);
};

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

import http from "node:http";
import { URL } from "node:url";
import { PreviewService } from "./preview-service.js";
import type {
  PreviewTaskConfig,
  BatchPreviewConfig,
  FeishuPreviewConfig,
} from "./preview-service.js";
import { PreviewManager } from "./preview-manager.js";
import type { PreviewProgramConfig } from "./preview-manager.js";

export class PreviewHttpServer {
  private previewService = new PreviewService();
  private previewManager = new PreviewManager();
  private port = Number(process.env.HTTP_PORT || 3100);

  async start() {
    try {
      await this.previewManager.init();
    } catch (error) {
      console.warn("⚠️ 预览管理器初始化失败:", error);
    }

    const server = http.createServer(async (req, res) => {
      this.setCorsHeaders(res);

      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return;
      }

      try {
        if (!req.url) {
          this.send(res, 400, { message: "缺少请求路径" });
          return;
        }

        const url = new URL(req.url, `http://${req.headers.host}`);

        if (url.pathname === "/health") {
          this.send(res, 200, { status: "ok" });
          return;
        }

        if (url.pathname === "/" && req.method === "GET") {
          this.send(res, 200, {
            service: "oceanengine-preview",
            message: "巨量预览独立服务已启动",
            endpoints: [
              "POST /preview/analyze",
              "POST /preview/execute",
              "POST /preview/stop",
              "POST /preview/batch",
              "POST /preview/feishu",
              "POST /preview-manager/start",
              "POST /preview-manager/stop",
              "POST /preview-manager/update",
              "GET /preview-manager/status",
              "GET /health",
            ],
          });
          return;
        }

        if (url.pathname === "/preview/analyze" && req.method === "POST") {
          await this.handlePreviewAnalyze(req, res);
          return;
        }

        if (url.pathname === "/preview/execute" && req.method === "POST") {
          await this.handlePreviewExecute(req, res);
          return;
        }

        if (url.pathname === "/preview/stop" && req.method === "POST") {
          await this.handlePreviewStop(req, res);
          return;
        }

        if (url.pathname === "/preview/batch" && req.method === "POST") {
          await this.handlePreviewBatch(req, res);
          return;
        }

        if (url.pathname === "/preview/feishu" && req.method === "POST") {
          await this.handlePreviewFeishu(req, res);
          return;
        }

        if (
          url.pathname === "/preview-manager/start" &&
          req.method === "POST"
        ) {
          await this.handlePreviewManagerStart(req, res);
          return;
        }

        if (
          url.pathname === "/preview-manager/stop" &&
          req.method === "POST"
        ) {
          await this.handlePreviewManagerStop(req, res);
          return;
        }

        if (
          url.pathname === "/preview-manager/update" &&
          req.method === "POST"
        ) {
          await this.handlePreviewManagerUpdate(req, res);
          return;
        }

        if (
          url.pathname === "/preview-manager/status" &&
          req.method === "GET"
        ) {
          this.handlePreviewManagerStatus(url, res);
          return;
        }

        this.send(res, 404, { message: "接口不存在" });
      } catch (error: any) {
        console.error("❌ 处理请求失败:", error);
        this.send(res, 500, {
          message: "服务内部错误",
          error: error?.message || String(error),
        });
      }
    });

    server.listen(this.port, () => {
      console.log(`🚀 预览服务已启动: http://localhost:${this.port}`);
      console.log("📋 可用接口:");
      console.log("   POST /preview/analyze           - 分析需要预览的素材");
      console.log("   POST /preview/execute           - 执行预览操作");
      console.log("   POST /preview/stop              - 停用预览（删除问题素材）");
      console.log("   POST /preview/batch             - 批量处理多个账户");
      console.log("   POST /preview/feishu            - 从飞书自动拉取并执行预览");
      console.log("   POST /preview-manager/start     - 启用预览程序（支持多用户）");
      console.log("   POST /preview-manager/stop      - 停用预览程序");
      console.log("   POST /preview-manager/update    - 更新预览程序配置");
      console.log("   GET  /preview-manager/status    - 查询预览程序状态");
      console.log("   GET  /health                    - 健康检查");
    });
  }

  stopAllTimers() {
    this.previewManager.stopAllTimers();
  }

  private setCorsHeaders(res: http.ServerResponse) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  }

  private async handlePreviewAnalyze(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) {
    const body = await this.parseBody(req);

    const aadvid = body?.aadvid as string;
    const drama_name = body?.drama_name as string;
    const cookie = body?.cookie as string;

    if (!aadvid || !drama_name || !cookie) {
      this.send(res, 400, {
        message: "缺少必需参数: aadvid, drama_name, cookie",
      });
      return;
    }

    const aweme_white_list = Array.isArray(body?.aweme_white_list)
      ? (body.aweme_white_list as string[])
      : undefined;
    const config: PreviewTaskConfig = {
      aadvid,
      drama_name,
      cookie,
      aweme_white_list,
    };

    console.log(`[预览接口] 分析请求 | 账户: ${aadvid} | 剧名: ${drama_name}`);

    const result = await this.previewService.analyzeAccount(config);

    this.send(res, 200, {
      message: "分析完成",
      data: {
        totalAds: result.totalAds,
        filteredAds: result.filteredAds,
        needPreviewCount: result.needPreview.length,
        needDeleteCount: result.needDelete.length,
        canDeletePromotionsCount: result.canDeletePromotions.length,
        needPreview: result.needPreview.map((m) => ({
          material_id: m.material_id,
          promotion_id: m.promotion_id,
        })),
        needDelete: result.needDelete.map((m) => ({
          material_id: m.material_id,
          promotion_id: m.promotion_id,
          cdp_material_id: m.cdp_material_id,
        })),
        canDeletePromotions: result.canDeletePromotions,
      },
    });
  }

  private async handlePreviewExecute(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) {
    const body = await this.parseBody(req);

    const aadvid = body?.aadvid as string;
    const drama_name = body?.drama_name as string;
    const cookie = body?.cookie as string;

    if (!aadvid || !drama_name || !cookie) {
      this.send(res, 400, {
        message: "缺少必需参数: aadvid, drama_name, cookie",
      });
      return;
    }

    const aweme_white_list = Array.isArray(body?.aweme_white_list)
      ? (body.aweme_white_list as string[])
      : undefined;
    const delayMs = Number(body?.delayMs) || 400;

    const config: PreviewTaskConfig = {
      aadvid,
      drama_name,
      cookie,
      aweme_white_list,
    };

    console.log(`[预览接口] 执行预览 | 账户: ${aadvid} | 剧名: ${drama_name}`);

    const analysis = await this.previewService.analyzeAccount(config);

    if (analysis.needPreview.length === 0) {
      this.send(res, 200, {
        message: "没有需要预览的素材",
        data: {
          previewCount: 0,
          success: 0,
          failed: 0,
        },
      });
      return;
    }

    const result = await this.previewService.executePreview(
      config,
      analysis.needPreview,
      delayMs
    );

    this.send(res, 200, {
      message: "预览完成",
      data: {
        previewCount: analysis.needPreview.length,
        success: result.success,
        failed: result.failed,
      },
    });
  }

  private async handlePreviewStop(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) {
    const body = await this.parseBody(req);

    const aadvid = body?.aadvid as string;
    const drama_name = body?.drama_name as string;
    const cookie = body?.cookie as string;

    if (!aadvid || !drama_name || !cookie) {
      this.send(res, 400, {
        message: "缺少必需参数: aadvid, drama_name, cookie",
      });
      return;
    }

    const aweme_white_list = Array.isArray(body?.aweme_white_list)
      ? (body.aweme_white_list as string[])
      : undefined;
    const deleteAds = Boolean(body?.deleteAds);

    const config: PreviewTaskConfig = {
      aadvid,
      drama_name,
      cookie,
      aweme_white_list,
    };

    console.log(`[预览接口] 停用预览 | 账户: ${aadvid} | 剧名: ${drama_name}`);

    const analysis = await this.previewService.analyzeAccount(config);

    let deleteMaterialsResult = { success: 0, failed: 0 };
    let deleteAdsResult = { success: 0, failed: 0 };

    if (analysis.needDelete.length > 0) {
      deleteMaterialsResult = await this.previewService.stopPreview(
        config,
        analysis.needDelete
      );
    }

    if (deleteAds && analysis.canDeletePromotions.length > 0) {
      deleteAdsResult = await this.previewService.deletePromotions(
        config,
        analysis.canDeletePromotions
      );
    }

    this.send(res, 200, {
      message: "停用预览完成",
      data: {
        deletedMaterialsCount: analysis.needDelete.length,
        deletedMaterialsSuccess: deleteMaterialsResult.success,
        deletedMaterialsFailed: deleteMaterialsResult.failed,
        deletedAdsCount: deleteAds ? analysis.canDeletePromotions.length : 0,
        deletedAdsSuccess: deleteAdsResult.success,
        deletedAdsFailed: deleteAdsResult.failed,
      },
    });
  }

  private async handlePreviewBatch(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) {
    const body = await this.parseBody(req);
    const accounts = body?.accounts as Record<string, unknown>[] | undefined;

    if (!Array.isArray(accounts) || accounts.length === 0) {
      this.send(res, 400, {
        message: "缺少 accounts 参数或为空数组",
      });
      return;
    }

    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i];
      if (!acc?.aadvid || !acc?.drama_name) {
        this.send(res, 400, {
          message: `账户 [${i}] 缺少必需参数: aadvid, drama_name`,
        });
        return;
      }
    }

    const dryRun = Boolean(body?.dryRun);
    const previewDelayMs = Number(body?.previewDelayMs) || 400;
    const cookie = body?.cookie as string | undefined;

    const batchConfig: BatchPreviewConfig = {
      accounts: accounts.map((acc) => ({
        aadvid: String(acc.aadvid),
        drama_name: String(acc.drama_name),
        cookie: typeof acc.cookie === "string" ? acc.cookie : "",
        aweme_white_list: Array.isArray(acc.aweme_white_list)
          ? (acc.aweme_white_list as string[])
          : undefined,
      })),
      dryRun,
      previewDelayMs,
      cookie,
    };

    console.log(
      `[预览接口] 批量处理 ${accounts.length} 个账户 | dryRun=${dryRun}`
    );

    const result = await this.previewService.batchProcess(batchConfig);

    this.send(res, 200, {
      message: "批量处理完成",
      data: result,
    });
  }

  private async handlePreviewFeishu(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) {
    const body = await this.parseBody(req);

    const feishu = body?.feishu as FeishuPreviewConfig["feishu"];
    const buildTimeFilterWindowStartMinutes =
      Number(body?.buildTimeFilterWindowStartMinutes) || 90;
    const buildTimeFilterWindowEndMinutes =
      Number(body?.buildTimeFilterWindowEndMinutes) || 20;
    const aweme_white_list = Array.isArray(body?.aweme_white_list)
      ? (body.aweme_white_list as string[])
      : undefined;
    const dryRun = Boolean(body?.dryRun);
    const previewDelayMs = Number(body?.previewDelayMs) || 400;
    const cookie = body?.cookie as string | undefined;

    const config: FeishuPreviewConfig = {
      feishu,
      buildTimeFilterWindowStartMinutes,
      buildTimeFilterWindowEndMinutes,
      aweme_white_list,
      dryRun,
      previewDelayMs,
      cookie,
    };

    console.log(
      `[预览接口] 从飞书拉取并执行预览 | 时间窗口: 前${buildTimeFilterWindowStartMinutes}-${buildTimeFilterWindowEndMinutes}分钟 | dryRun=${dryRun}`
    );

    const result = await this.previewService.batchProcessFromFeishu(config);

    this.send(res, 200, {
      message: "飞书自动预览完成",
      data: result,
    });
  }

  private async handlePreviewManagerStart(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) {
    const body = await this.parseBody(req);

    const user = body?.user as string;
    const channel = body?.channel as string;
    const intervalMinutes = Number(body?.intervalMinutes);
    const aweme_white_list = body?.aweme_white_list as string[];
    const cookie = body?.cookie as string;

    if (!user) {
      this.send(res, 400, { message: "缺少必需参数: user" });
      return;
    }
    if (!channel) {
      this.send(res, 400, { message: "缺少必需参数: channel" });
      return;
    }

    if (!intervalMinutes || intervalMinutes < 1) {
      this.send(res, 400, {
        message: "缺少必需参数: intervalMinutes，且必须大于 0",
      });
      return;
    }

    if (!Array.isArray(aweme_white_list) || aweme_white_list.length === 0) {
      this.send(res, 400, {
        message: "缺少必需参数: aweme_white_list，且不能为空",
      });
      return;
    }

    if (!cookie?.trim()) {
      this.send(res, 400, { message: "缺少必需参数: cookie" });
      return;
    }

    const buildTimeWindowStart = body?.buildTimeWindowStart
      ? Number(body.buildTimeWindowStart)
      : undefined;
    const buildTimeWindowEnd = body?.buildTimeWindowEnd
      ? Number(body.buildTimeWindowEnd)
      : undefined;

    const config: PreviewProgramConfig = {
      user,
      channel,
      intervalMinutes,
      aweme_white_list,
      cookie,
      buildTimeWindowStart,
      buildTimeWindowEnd,
    };

    console.log(
      `[预览管理器接口] 启用预览程序 | 用户: ${user} | 渠道: ${channel} | 间隔: ${intervalMinutes}分钟`
    );

    const result = await this.previewManager.startPreview(config);
    this.send(res, 200, result);
  }

  private async handlePreviewManagerStop(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) {
    const body = await this.parseBody(req);
    const user = body?.user as string;
    const channel = body?.channel as string;

    if (!user) {
      this.send(res, 400, { message: "缺少必需参数: user" });
      return;
    }
    if (!channel) {
      this.send(res, 400, { message: "缺少必需参数: channel" });
      return;
    }

    console.log(`[预览管理器接口] 停用预览程序 | 用户: ${user} | 渠道: ${channel}`);

    const result = this.previewManager.stopPreview(user, channel);
    this.send(res, 200, result);
  }

  private async handlePreviewManagerUpdate(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) {
    const body = await this.parseBody(req);
    const user = body?.user as string;
    const channel = body?.channel as string;

    if (!user) {
      this.send(res, 400, { message: "缺少必需参数: user" });
      return;
    }
    if (!channel) {
      this.send(res, 400, { message: "缺少必需参数: channel" });
      return;
    }

    const updates: Record<string, unknown> = {};
    if (body?.intervalMinutes !== undefined) {
      updates.intervalMinutes = Number(body.intervalMinutes);
    }
    if (body?.aweme_white_list !== undefined) {
      updates.aweme_white_list = body.aweme_white_list;
    }
    if (body?.cookie !== undefined) {
      updates.cookie = body.cookie;
    }
    if (body?.buildTimeWindowStart !== undefined) {
      updates.buildTimeWindowStart = Number(body.buildTimeWindowStart);
    }
    if (body?.buildTimeWindowEnd !== undefined) {
      updates.buildTimeWindowEnd = Number(body.buildTimeWindowEnd);
    }

    if (Object.keys(updates).length === 0) {
      this.send(res, 400, { message: "没有需要更新的参数" });
      return;
    }

    console.log(`[预览管理器接口] 更新配置 | 用户: ${user} | 渠道: ${channel}`);

    const result = this.previewManager.updatePreview(user, channel, updates);
    this.send(res, 200, result);
  }

  private handlePreviewManagerStatus(url: URL, res: http.ServerResponse) {
    const user = url.searchParams.get("user") || undefined;
    const channel = url.searchParams.get("channel") || undefined;

    console.log(
      `[预览管理器接口] 查询状态${user ? ` | 用户: ${user}` : " | 所有用户"}${channel ? ` | 渠道: ${channel}` : ""}`
    );

    const result = this.previewManager.getStatus(user, channel);
    this.send(res, 200, result);
  }

  private parseBody(
    req: http.IncomingMessage
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];

      req
        .on("data", (chunk) => chunks.push(chunk))
        .on("end", () => {
          if (chunks.length === 0) {
            resolve({});
            return;
          }

          try {
            const raw = Buffer.concat(chunks).toString("utf8");
            const parsed = JSON.parse(raw);
            resolve(parsed);
          } catch (error) {
            reject(error);
          }
        })
        .on("error", (error) => reject(error));
    });
  }

  private send(
    res: http.ServerResponse,
    status: number,
    body: Record<string, unknown>
  ) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(body));
  }
}

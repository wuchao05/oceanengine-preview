/**
 * 巨量预览程序管理器
 * 负责管理多个用户的预览程序实例，支持状态持久化和自动恢复
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PreviewService } from "./preview-service.js";
import type { FeishuPreviewConfig } from "./preview-service.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

// 状态文件路径
const DATA_DIR = path.join(projectRoot, "data");
const PREVIEW_STATES_FILE = path.join(DATA_DIR, "preview-states.json");

// 默认配置
const DEFAULT_BUILD_TIME_WINDOW_START = 90; // 前90分钟
const DEFAULT_BUILD_TIME_WINDOW_END = 20; // 前20分钟
const FEISHU_CONFIG_DIR = path.join(projectRoot, "config", "users");

// 用户飞书配置文件接口
interface UserFeishuConfig {
  appId: string;
  appSecret: string;
  appToken: string;
  tableId: string;
  baseUrl?: string;
  fieldNames?: string[];
  [key: string]: unknown;
}

/**
 * 根据用户和渠道加载飞书配置文件。
 * 目前优先尝试更细粒度的渠道配置，找不到时回退到用户级配置。
 */
function loadFeishuConfig(user: string, channel: string): UserFeishuConfig {
  const candidatePaths = [
    path.join(FEISHU_CONFIG_DIR, `${user}-${channel}.json`),
    path.join(FEISHU_CONFIG_DIR, `feishu-${user}-${channel}.json`),
    path.join(FEISHU_CONFIG_DIR, user, `${channel}.json`),
    path.join(FEISHU_CONFIG_DIR, `feishu-${user}.json`),
  ];

  const configPath = candidatePaths.find((item) => fs.existsSync(item));
  if (!configPath) {
    throw new Error(
      `用户 ${user} 渠道 ${channel} 的飞书配置文件不存在，可选路径: ${candidatePaths.join(
        ", "
      )}`
    );
  }

  const content = fs.readFileSync(configPath, "utf-8");
  const config = JSON.parse(content) as UserFeishuConfig;
  if (!config.tableId) {
    throw new Error(`飞书配置文件缺少 tableId: ${configPath}`);
  }

  return config;
}

function getProgramKey(user: string, channel: string) {
  return `${user}::${channel}`;
}

// =============== 类型定义 ===============
export interface PreviewProgramState {
  key: string;
  user: string;
  channel: string;
  enabled: boolean;
  intervalMinutes: number;
  aweme_white_list: string[];
  cookie: string;
  tableId?: string; // 飞书表ID（由用户配置决定）
  buildTimeWindowStart: number;
  buildTimeWindowEnd: number;

  // 运行时状态
  lastRun?: string;
  nextRun?: string;
  runCount: number;
  lastStatus?: "success" | "failed";
  lastError?: string;

  // 统计信息
  stats: {
    totalProcessed: number;
    totalPreviewed: number;
    totalDeleted: number;
  };

  // 内部使用（不序列化）
  timerId?: NodeJS.Timeout;
}

export interface PreviewProgramConfig {
  user: string;
  channel: string;
  intervalMinutes: number;
  aweme_white_list: string[];
  cookie: string;
  buildTimeWindowStart?: number;
  buildTimeWindowEnd?: number;
}

// =============== 预览管理器 ===============
export class PreviewManager {
  private states: Map<string, PreviewProgramState> = new Map();
  private previewService: PreviewService;

  private initialized = false;

  constructor() {
    this.previewService = new PreviewService();

    // 加载持久化状态
    this.loadStates();

    // 恢复定时器
    this.restoreTimers();

    console.log(
      `[预览管理器] 初始化完成，已加载 ${this.states.size} 个预览程序状态`
    );
  }

  /**
   * 异步初始化
   * 在使用预览功能前必须调用此方法
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    console.log("[预览管理器] 初始化完成");
  }

  /**
   * 启用预览程序
   */
  async startPreview(config: PreviewProgramConfig): Promise<{
    message: string;
    user: string;
    channel: string;
    tableId: string;
    intervalMinutes: number;
    nextRun: string;
  }> {
    const { user, channel, intervalMinutes, aweme_white_list, cookie } = config;
    const key = getProgramKey(user, channel);

    // 根据用户和渠道加载飞书配置文件
    const feishuConfig = loadFeishuConfig(user, channel);
    const tableId = feishuConfig.tableId;
    console.log(
      `[预览管理器] 用户 ${user} 渠道 ${channel} 的飞书表ID: ${tableId}`
    );

    // 验证参数
    if (!user) {
      throw new Error("缺少必需参数: user");
    }
    if (!channel) {
      throw new Error("缺少必需参数: channel");
    }
    if (!intervalMinutes || intervalMinutes < 1) {
      throw new Error("intervalMinutes 必须大于 0");
    }
    if (!aweme_white_list || aweme_white_list.length === 0) {
      throw new Error("aweme_white_list 不能为空");
    }
    if (!cookie?.trim()) {
      throw new Error("cookie 不能为空");
    }

    // 检查是否已存在
    const existing = this.states.get(key);
    if (existing && existing.enabled) {
      throw new Error(`用户 ${user} 渠道 ${channel} 的预览程序已在运行中`);
    }

    // 创建或更新状态
    const state: PreviewProgramState = {
      key,
      user,
      channel,
      enabled: true,
      intervalMinutes,
      aweme_white_list,
      cookie: cookie.trim(),
      tableId,
      buildTimeWindowStart:
        config.buildTimeWindowStart || DEFAULT_BUILD_TIME_WINDOW_START,
      buildTimeWindowEnd:
        config.buildTimeWindowEnd || DEFAULT_BUILD_TIME_WINDOW_END,
      runCount: existing?.runCount || 0,
      stats: existing?.stats || {
        totalProcessed: 0,
        totalPreviewed: 0,
        totalDeleted: 0,
      },
    };

    this.states.set(key, state);

    // 创建定时器
    this.createTimer(key, state);

    // 保存状态
    this.saveStates();

    console.log(
      `[预览管理器] 启用预览程序 | 用户: ${user} | 渠道: ${channel} | 飞书表: ${tableId} | 间隔: ${intervalMinutes}分钟`
    );

    // 立即执行一次预览（可选，注释掉则等待第一个间隔周期）
    setTimeout(() => {
      this.executePreview(key, state).catch(err => {
        console.error(
          `[预览管理器] 首次执行失败 | 用户: ${user} | 渠道: ${channel}`,
          err
        );
      });
    }, 1000); // 延迟1秒执行，避免阻塞响应

    return {
      message: "预览程序已启用",
      user,
      channel,
      tableId,
      intervalMinutes,
      nextRun: this.formatTime(state.nextRun!),
    };
  }

  /**
   * 更新预览程序配置（不停止运行）
   */
  updatePreview(user: string, channel: string, updates: {
    intervalMinutes?: number;
    aweme_white_list?: string[];
    cookie?: string;
    buildTimeWindowStart?: number;
    buildTimeWindowEnd?: number;
  }): {
    message: string;
    user: string;
    channel: string;
    updated: Record<string, unknown>;
  } {
    const key = getProgramKey(user, channel);
    const state = this.states.get(key);
    if (!state) {
      throw new Error(`用户 ${user} 渠道 ${channel} 的预览程序不存在`);
    }

    const updated: Record<string, unknown> = {};

    if (updates.intervalMinutes !== undefined && updates.intervalMinutes > 0) {
      state.intervalMinutes = updates.intervalMinutes;
      updated.intervalMinutes = updates.intervalMinutes;
      // 重建定时器
      if (state.enabled && state.timerId) {
        clearInterval(state.timerId);
        this.createTimer(key, state);
      }
    }
    if (updates.aweme_white_list !== undefined) {
      state.aweme_white_list = updates.aweme_white_list;
      updated.aweme_white_list = updates.aweme_white_list;
    }
    if (updates.cookie !== undefined && updates.cookie.trim()) {
      state.cookie = updates.cookie.trim();
      updated.cookie = "已更新";
    }
    if (updates.buildTimeWindowStart !== undefined) {
      state.buildTimeWindowStart = updates.buildTimeWindowStart;
      updated.buildTimeWindowStart = updates.buildTimeWindowStart;
    }
    if (updates.buildTimeWindowEnd !== undefined) {
      state.buildTimeWindowEnd = updates.buildTimeWindowEnd;
      updated.buildTimeWindowEnd = updates.buildTimeWindowEnd;
    }

    this.saveStates();

    console.log(`[预览管理器] 更新配置 | 用户: ${user} | 更新项: ${Object.keys(updated).join(", ")}`);

    return {
      message: "预览程序配置已更新",
      user,
      channel,
      updated,
    };
  }

  /**
   * 停用预览程序
   */
  stopPreview(user: string, channel: string): {
    message: string;
    user: string;
    channel: string;
    runCount: number;
    lastRun?: string;
  } {
    const key = getProgramKey(user, channel);
    const state = this.states.get(key);
    if (!state || !state.enabled) {
      throw new Error(`用户 ${user} 渠道 ${channel} 的预览程序未运行`);
    }

    // 停止定时器
    if (state.timerId) {
      clearInterval(state.timerId);
      state.timerId = undefined;
    }

    // 更新状态
    state.enabled = false;
    state.nextRun = undefined;

    // 保存状态
    this.saveStates();

    console.log(`[预览管理器] 停用预览程序 | 用户: ${user} | 渠道: ${channel}`);

    return {
      message: "预览程序已停用",
      user,
      channel,
      runCount: state.runCount,
      lastRun: state.lastRun ? this.formatTime(state.lastRun) : undefined,
    };
  }

  /**
   * 查询预览程序状态
   */
  getStatus(user?: string, channel?: string): {
    total: number;
    programs: Array<{
      key: string;
      user: string;
      channel: string;
      enabled: boolean;
      intervalMinutes: number;
      aweme_white_list: string[];
      tableId?: string;
      buildTimeWindowStart: number;
      buildTimeWindowEnd: number;
      lastRun?: string;
      nextRun?: string;
      runCount: number;
      lastStatus?: "success" | "failed";
      lastError?: string;
      stats: {
        totalProcessed: number;
        totalPreviewed: number;
        totalDeleted: number;
      };
    }>;
  } {
    let programs = Array.from(this.states.values());

    // 按用户过滤
    if (user) {
      programs = programs.filter((p) => p.user === user);
    }
    if (channel) {
      programs = programs.filter((p) => p.channel === channel);
    }

    // 格式化输出
    const formattedPrograms = programs.map((state) => ({
      key: state.key,
      user: state.user,
      channel: state.channel,
      enabled: state.enabled,
      intervalMinutes: state.intervalMinutes,
      aweme_white_list: state.aweme_white_list,
      tableId: state.tableId,
      buildTimeWindowStart: state.buildTimeWindowStart,
      buildTimeWindowEnd: state.buildTimeWindowEnd,
      lastRun: state.lastRun ? this.formatTime(state.lastRun) : undefined,
      nextRun: state.nextRun ? this.formatTime(state.nextRun) : undefined,
      runCount: state.runCount,
      lastStatus: state.lastStatus,
      lastError: state.lastError,
      stats: state.stats,
    }));

    return {
      total: formattedPrograms.length,
      programs: formattedPrograms,
    };
  }

  /**
   * 创建定时器
   */
  private createTimer(key: string, state: PreviewProgramState) {
    // 清除旧定时器
    if (state.timerId) {
      clearInterval(state.timerId);
    }

    // 创建新定时器
    const timerId = setInterval(async () => {
      await this.executePreview(key, state);
    }, state.intervalMinutes * 60 * 1000);

    state.timerId = timerId;
    state.nextRun = new Date(
      Date.now() + state.intervalMinutes * 60 * 1000
    ).toISOString();

    console.log(
      `[预览管理器] 创建定时器 | 用户: ${state.user} | 渠道: ${state.channel} | 下次执行: ${this.formatTime(state.nextRun)}`
    );
  }

  /**
   * 执行预览任务
   */
  private async executePreview(key: string, state: PreviewProgramState) {
    console.log(
      `\n[预览管理器] 开始执行预览 | 用户: ${state.user} | 渠道: ${state.channel} | 飞书表: ${state.tableId || "默认"} | 执行次数: ${
        state.runCount + 1
      }`
    );

    state.lastRun = new Date().toISOString();
    state.runCount += 1;

    try {
      // 根据用户加载飞书配置
      const feishuConfig = loadFeishuConfig(state.user, state.channel);

      // 构建配置
      const config: FeishuPreviewConfig = {
        feishu: {
          appId: feishuConfig.appId,
          appSecret: feishuConfig.appSecret,
          appToken: feishuConfig.appToken,
          tableId: feishuConfig.tableId,
        },
        buildTimeFilterWindowStartMinutes: state.buildTimeWindowStart,
        buildTimeFilterWindowEndMinutes: state.buildTimeWindowEnd,
        aweme_white_list: state.aweme_white_list,
        dryRun: false,
        previewDelayMs: 400,
        cookie: state.cookie,
      };

      // 执行预览
      const result = await this.previewService.batchProcessFromFeishu(config);

      // 更新统计
      state.stats.totalProcessed += result.total;
      for (const res of result.results) {
        state.stats.totalPreviewed += res.needPreviewCount;
        state.stats.totalDeleted += res.needDeleteCount;
      }

      state.lastStatus = result.failed > 0 ? "failed" : "success";
      state.lastError = undefined;

      console.log(
        `[预览管理器] 执行完成 | 用户: ${state.user} | 渠道: ${state.channel} | 成功: ${result.success} | 失败: ${result.failed}`
      );
    } catch (error: any) {
      state.lastStatus = "failed";
      state.lastError = error?.message || String(error);
      console.error(
        `[预览管理器] 执行失败 | 用户: ${state.user} | 渠道: ${state.channel}`,
        error?.message || error
      );
    }

    // 更新下次执行时间
    state.nextRun = new Date(
      Date.now() + state.intervalMinutes * 60 * 1000
    ).toISOString();

    // 保存状态
    this.saveStates();
  }

  /**
   * 加载持久化状态
   */
  private loadStates() {
    try {
      if (!fs.existsSync(PREVIEW_STATES_FILE)) {
        console.log("[预览管理器] 状态文件不存在，将在首次保存时创建");
        return;
      }

      const content = fs.readFileSync(PREVIEW_STATES_FILE, "utf-8");
      const statesObj = JSON.parse(content) as Record<
        string,
        PreviewProgramState
      >;

      for (const [key, state] of Object.entries(statesObj)) {
        if (!state.key) {
          state.key = key;
        }
        if (!state.channel) {
          state.channel = "default";
        }
        if (!state.cookie?.trim()) {
          console.warn(
            `[预览管理器] 用户 ${state.user} 渠道 ${state.channel} 的持久化状态缺少 cookie，已自动停用该预览程序`
          );
          state.enabled = false;
        }
        this.states.set(state.key, state);
      }

      console.log(
        `[预览管理器] 加载状态文件成功，共 ${this.states.size} 个预览程序`
      );
    } catch (error) {
      console.error("[预览管理器] 加载状态文件失败:", error);
    }
  }

  /**
   * 保存状态到文件
   */
  private saveStates() {
    try {
      // 确保目录存在
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }

      // 转换为对象（排除 timerId）
      const statesObj: Record<string, any> = {};
      for (const [user, state] of this.states) {
        const { timerId, ...rest } = state;
        statesObj[user] = rest;
      }

      // 原子写入
      const tempFile = PREVIEW_STATES_FILE + ".tmp";
      fs.writeFileSync(tempFile, JSON.stringify(statesObj, null, 2), "utf-8");
      fs.renameSync(tempFile, PREVIEW_STATES_FILE);

      console.log(
        `[预览管理器] 保存状态文件成功，共 ${this.states.size} 个预览程序`
      );
    } catch (error) {
      console.error("[预览管理器] 保存状态文件失败:", error);
    }
  }

  /**
   * 恢复定时器
   */
  private restoreTimers() {
    let restoredCount = 0;
    for (const [key, state] of this.states) {
      if (state.enabled) {
        this.createTimer(key, state);
        restoredCount++;
      }
    }

    if (restoredCount > 0) {
      console.log(
        `[预览管理器] 恢复定时器成功，共 ${restoredCount} 个预览程序`
      );
    }
  }

  /**
   * 停止所有定时器（优雅关闭时使用）
   */
  stopAllTimers() {
    for (const [, state] of this.states) {
      if (state.timerId) {
        clearInterval(state.timerId);
        state.timerId = undefined;
        console.log(
          `[预览管理器] 停止定时器 | 用户: ${state.user} | 渠道: ${state.channel}`
        );
      }
    }
  }

  /**
   * 格式化时间为北京时间
   */
  private formatTime(isoString: string): string {
    const date = new Date(isoString);
    const beijingOffset = 8 * 60 * 60 * 1000;
    const beijingDate = new Date(date.getTime() + beijingOffset);
    const year = beijingDate.getUTCFullYear();
    const month = String(beijingDate.getUTCMonth() + 1).padStart(2, "0");
    const day = String(beijingDate.getUTCDate()).padStart(2, "0");
    const hours = String(beijingDate.getUTCHours()).padStart(2, "0");
    const minutes = String(beijingDate.getUTCMinutes()).padStart(2, "0");
    const seconds = String(beijingDate.getUTCSeconds()).padStart(2, "0");
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  }
}

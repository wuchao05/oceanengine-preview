/**
 * 巨量预览程序管理器
 * 负责管理多个用户的预览程序实例，支持状态持久化和自动恢复
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PreviewService } from "./preview-service.js";
import type { FeishuPreviewConfig } from "./preview-service.js";
import { getOceanCookie, clearConfigCache } from "./config-service.js";

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
 * 根据用户标识加载对应的飞书配置文件
 * 例如 user="xh-ql" 则加载 config/users/feishu-xh-ql.json
 */
function loadUserFeishuConfig(user: string): UserFeishuConfig {
  const configPath = path.join(FEISHU_CONFIG_DIR, `feishu-${user}.json`);
  if (!fs.existsSync(configPath)) {
    throw new Error(`用户 ${user} 的飞书配置文件不存在: ${configPath}`);
  }
  const content = fs.readFileSync(configPath, "utf-8");
  const config = JSON.parse(content) as UserFeishuConfig;
  if (!config.tableId) {
    throw new Error(`用户 ${user} 的飞书配置文件缺少 tableId`);
  }
  return config;
}

// =============== 类型定义 ===============
export interface PreviewProgramState {
  user: string;
  enabled: boolean;
  intervalMinutes: number;
  aweme_white_list: string[];
  subject?: string; // 主体（超琦、欣雅、每日等）
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
  intervalMinutes: number;
  aweme_white_list: string[];
  subject?: string; // 主体（超琦、欣雅、每日等），用于过滤表格中的记录
  tableId?: string; // 飞书表ID（由用户配置决定）
  buildTimeWindowStart?: number;
  buildTimeWindowEnd?: number;
}

// =============== 预览管理器 ===============
export class PreviewManager {
  private states: Map<string, PreviewProgramState> = new Map();
  private previewService: PreviewService;

  // 远程 Cookie
  private cookieChaoqi: string;
  private cookieXinya: string;
  private cookieMeiri: string;

  private initialized = false;

  constructor() {
    this.previewService = new PreviewService();

    // Cookie 将在 init() 中异步加载
    this.cookieChaoqi = "";
    this.cookieXinya = "";
    this.cookieMeiri = "";

    // 加载持久化状态
    this.loadStates();

    // 恢复定时器
    this.restoreTimers();

    console.log(
      `[预览管理器] 初始化完成，已加载 ${this.states.size} 个预览程序状态`
    );
  }

  /**
   * 异步初始化配置（从远程获取 Cookie）
   * 在使用预览功能前必须调用此方法
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    try {
      console.log("[预览管理器] 正在获取远程配置...");
      // 从远程配置服务获取 Cookie
      this.cookieChaoqi = await getOceanCookie("OCEAN_COOKIE_CHAOQI");
      this.cookieXinya = await getOceanCookie("OCEAN_COOKIE_XINYA");
      this.cookieMeiri = await getOceanCookie("OCEAN_COOKIE_MEIRI");

      if (!this.cookieChaoqi && !this.cookieXinya && !this.cookieMeiri) {
        console.warn("[预览管理器] 警告: 远程配置中 OCEAN_COOKIE 为空");
      } else {
        console.log("[预览管理器] 远程配置获取成功");
      }

      this.initialized = true;
    } catch (error) {
      console.error(
        `[预览管理器] 获取配置失败: ${error instanceof Error ? error.message : error}`
      );
      throw error;
    }
  }

  /**
   * 启用预览程序
   */
  async startPreview(config: PreviewProgramConfig): Promise<{
    message: string;
    user: string;
    subject?: string;
    tableId: string;
    intervalMinutes: number;
    nextRun: string;
  }> {
    const { user, intervalMinutes, aweme_white_list, subject } = config;

    // 根据用户加载飞书配置文件
    const userFeishuConfig = loadUserFeishuConfig(user);
    const tableId = config.tableId || userFeishuConfig.tableId;
    console.log(`[预览管理器] 用户 ${user} 的飞书表ID: ${tableId}`);

    // 验证参数
    if (!user) {
      throw new Error("缺少必需参数: user");
    }
    if (!intervalMinutes || intervalMinutes < 1) {
      throw new Error("intervalMinutes 必须大于 0");
    }
    if (!aweme_white_list || aweme_white_list.length === 0) {
      throw new Error("aweme_white_list 不能为空");
    }

    // 检查是否已存在
    const existing = this.states.get(user);
    if (existing && existing.enabled) {
      throw new Error(`用户 ${user} 的预览程序已在运行中`);
    }

    // 创建或更新状态
    const state: PreviewProgramState = {
      user,
      enabled: true,
      intervalMinutes,
      aweme_white_list,
      subject,
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

    this.states.set(user, state);

    // 创建定时器
    this.createTimer(user, state);

    // 保存状态
    this.saveStates();

    console.log(
      `[预览管理器] 启用预览程序 | 用户: ${user} | 主体: ${subject || "未指定"} | 飞书表: ${tableId} | 间隔: ${intervalMinutes}分钟`
    );

    // 立即执行一次预览（可选，注释掉则等待第一个间隔周期）
    setTimeout(() => {
      this.executePreview(user, state).catch(err => {
        console.error(`[预览管理器] 首次执行失败 | 用户: ${user}`, err);
      });
    }, 1000); // 延迟1秒执行，避免阻塞响应

    return {
      message: "预览程序已启用",
      user,
      subject,
      tableId,
      intervalMinutes,
      nextRun: this.formatTime(state.nextRun!),
    };
  }

  /**
   * 更新预览程序配置（不停止运行）
   */
  updatePreview(user: string, updates: {
    intervalMinutes?: number;
    aweme_white_list?: string[];
    subject?: string;
    buildTimeWindowStart?: number;
    buildTimeWindowEnd?: number;
  }): {
    message: string;
    user: string;
    updated: Record<string, unknown>;
  } {
    const state = this.states.get(user);
    if (!state) {
      throw new Error(`用户 ${user} 的预览程序不存在`);
    }

    const updated: Record<string, unknown> = {};

    if (updates.intervalMinutes !== undefined && updates.intervalMinutes > 0) {
      state.intervalMinutes = updates.intervalMinutes;
      updated.intervalMinutes = updates.intervalMinutes;
      // 重建定时器
      if (state.enabled && state.timerId) {
        clearInterval(state.timerId);
        this.createTimer(user, state);
      }
    }
    if (updates.aweme_white_list !== undefined) {
      state.aweme_white_list = updates.aweme_white_list;
      updated.aweme_white_list = updates.aweme_white_list;
    }
    if (updates.subject !== undefined) {
      state.subject = updates.subject;
      updated.subject = updates.subject;
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
      updated,
    };
  }

  /**
   * 停用预览程序
   */
  stopPreview(user: string): {
    message: string;
    user: string;
    runCount: number;
    lastRun?: string;
  } {
    const state = this.states.get(user);
    if (!state || !state.enabled) {
      throw new Error(`用户 ${user} 的预览程序未运行`);
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

    console.log(`[预览管理器] 停用预览程序 | 用户: ${user}`);

    return {
      message: "预览程序已停用",
      user,
      runCount: state.runCount,
      lastRun: state.lastRun ? this.formatTime(state.lastRun) : undefined,
    };
  }

  /**
   * 查询预览程序状态
   */
  getStatus(user?: string): {
    total: number;
    programs: Array<{
      user: string;
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

    // 格式化输出
    const formattedPrograms = programs.map((state) => ({
      user: state.user,
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
  private createTimer(user: string, state: PreviewProgramState) {
    // 清除旧定时器
    if (state.timerId) {
      clearInterval(state.timerId);
    }

    // 创建新定时器
    const timerId = setInterval(async () => {
      await this.executePreview(user, state);
    }, state.intervalMinutes * 60 * 1000);

    state.timerId = timerId;
    state.nextRun = new Date(
      Date.now() + state.intervalMinutes * 60 * 1000
    ).toISOString();

    console.log(
      `[预览管理器] 创建定时器 | 用户: ${user} | 下次执行: ${this.formatTime(
        state.nextRun
      )}`
    );
  }

  /**
   * 执行预览任务
   */
  private async executePreview(user: string, state: PreviewProgramState) {
    console.log(
      `\n[预览管理器] 开始执行预览 | 用户: ${user} | 主体: ${state.subject || "未指定"} | 飞书表: ${state.tableId || "默认"} | 执行次数: ${
        state.runCount + 1
      }`
    );

    state.lastRun = new Date().toISOString();
    state.runCount += 1;

    try {
      // 每次执行时重新获取最新的 Ocean Cookie
      try {
        clearConfigCache();
        this.cookieChaoqi = await getOceanCookie("OCEAN_COOKIE_CHAOQI");
        this.cookieXinya = await getOceanCookie("OCEAN_COOKIE_XINYA");
        this.cookieMeiri = await getOceanCookie("OCEAN_COOKIE_MEIRI");
      } catch (cookieErr) {
        console.warn(`[预览管理器] 刷新 Cookie 失败，使用缓存值: ${cookieErr instanceof Error ? cookieErr.message : cookieErr}`);
      }

      // 根据用户加载飞书配置
      const userFeishuConfig = loadUserFeishuConfig(user);

      // 构建配置
      const config: FeishuPreviewConfig = {
        feishu: {
          appId: userFeishuConfig.appId,
          appSecret: userFeishuConfig.appSecret,
          appToken: userFeishuConfig.appToken,
          tableId: state.tableId || userFeishuConfig.tableId,
        },
        subject: state.subject, // 传入主体，用于过滤飞书记录
        buildTimeFilterWindowStartMinutes: state.buildTimeWindowStart,
        buildTimeFilterWindowEndMinutes: state.buildTimeWindowEnd,
        aweme_white_list: state.aweme_white_list,
        dryRun: false,
        previewDelayMs: 400,
        cookieChaoqi: this.cookieChaoqi,
        cookieXinya: this.cookieXinya,
        cookieMeiri: this.cookieMeiri,
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
        `[预览管理器] 执行完成 | 用户: ${user} | 成功: ${result.success} | 失败: ${result.failed}`
      );
    } catch (error: any) {
      state.lastStatus = "failed";
      state.lastError = error?.message || String(error);
      console.error(
        `[预览管理器] 执行失败 | 用户: ${user}`,
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

      for (const [user, state] of Object.entries(statesObj)) {
        this.states.set(user, state);
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
    for (const [user, state] of this.states) {
      if (state.enabled) {
        this.createTimer(user, state);
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
    for (const [user, state] of this.states) {
      if (state.timerId) {
        clearInterval(state.timerId);
        state.timerId = undefined;
        console.log(`[预览管理器] 停止定时器 | 用户: ${user}`);
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

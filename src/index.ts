import fs from "fs";
import path from "path";
import axios from "axios";
import type { AxiosInstance } from "axios";
import pLimit from "p-limit";
import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat";
dayjs.extend(customParseFormat);

const DEFAULT_FEISHU_APP_ID = "cli_a870f7611b7b1013";
const DEFAULT_FEISHU_APP_SECRET = "NTwHbZG8rpOQyMEnXGPV6cNQ84KEqE8z";
const DEFAULT_FEISHU_APP_TOKEN = "WdWvbGUXXaokk8sAS94c00IZnsf";
const DEFAULT_FEISHU_TABLE_ID = "tblDOyi2Lzs80sv0";
const DEFAULT_FEISHU_BASE_URL =
  "https://open.feishu.cn/open-apis/bitable/v1";
const FEISHU_TOKEN_API_URL =
  "https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal";

// 扩展 global 类型以支持 gc（垃圾回收）
declare global {
  namespace NodeJS {
    interface Global {
      gc?: () => void;
    }
  }
}

// =============== 类型定义 ===============
interface AccountCfg {
  aadvid: string; // 广告主ID（与剧名一一对应）
  drama_name: string; // 单个剧名，用于匹配 promotion_name
  subject?: string; // 主体，用于选择 cookie
  cookie?: string; // 针对账户的 cookie（可覆盖全局映射）
}

interface SettingsCfg {
  dryRun?: boolean;
  previewDelayMs?: number;
  fetchConcurrency?: number;
  aweme_white_list?: string[]; // 全局固定的抖音号白名单
  proxyUrl?: string; // 代理服务器地址，如 "http://localhost:3001/api/proxy"
  cookieChaoqi?: string; // 主体为虎雨/超琦时使用
  cookieXinya?: string; // 主体为欣雅时使用
  appId?: string; // 飞书 app_id
  appSecret?: string; // 飞书 app_secret
  appToken?: string; // 飞书多维表格 app_token
  tableId?: string; // 飞书多维表格 table_id
  baseUrl?: string; // 飞书多维表格 API 基础路径
  accounts: AccountCfg[]; // 账户与剧名一一对应
  buildTimeFilterWindowStartMinutes?: number; // 搭建时间过滤窗口起始分钟（相对于当前时间的前N分钟），默认50
  buildTimeFilterWindowEndMinutes?: number; // 搭建时间过滤窗口结束分钟（相对于当前时间的前N分钟），默认30
  scheduleIntervalMinutes?: number; // 定时执行间隔（分钟），如果设置则每隔指定时间执行一次，否则只执行一次
}

interface AdsListResp {
  code: number;
  data?: {
    ads: AdItem[];
    pagination?: {
      page: number;
      page_size: number;
      total_page: number;
      total_count: number;
    };
  };
  msg?: string;
}

interface AdItem {
  promotion_id: string;
  promotion_name: string; // 含剧名 + 可能含抖音号
  aweme_name?: string; // 抖音号
  create_time?: string; // 最新创建时间，如 "2025-10-31 05:17:19"
}

interface MaterialsListResp {
  code: number;
  data?: {
    materials: MaterialItem[];
    pagination?: {
      page: number;
      page_size: number;
      total_page: number;
      total_count: number;
    };
  };
  msg?: string;
}

interface MaterialItem {
  material_id: string;
  cdp_material_id?: string; // 删除素材要用
  promotion_id: string;
  material_status_first_name?: string; // "投放中" 等
  material_status_second_name?: string[]; // 包含 "新建审核中" 等
  material_reject_reason_type?: number; // 0=无建议，1=有审核建议
}

// 飞书多维表格相关类型
interface FeishuFieldValue {
  text: string;
  type: string;
}

interface FeishuRecord {
  fields: {
    剧名?: FeishuFieldValue[];
    账户?: FeishuFieldValue[];
    主体?: FeishuFieldValue[] | string; // 主体字段可能是数组或直接字符串
    日期?: number;
    当前状态?: string;
    搭建时间?: number;
  };
  record_id: string;
}

interface FeishuSearchResp {
  code: number;
  data?: {
    has_more: boolean;
    items: FeishuRecord[];
    total: number;
    page_token?: string; // 用于分页的 token
  };
  msg?: string;
}

interface FeishuTokenResp {
  app_access_token: string;
  code: number;
  expire: number; // token 有效期（秒）
  msg?: string;
  tenant_access_token: string;
}

interface FeishuConfig {
  appId: string;
  appSecret: string;
  appToken: string;
  tableId: string;
  baseUrl: string;
}

// =============== 工具函数 ===============
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseArgs(): { configPath: string } {
  const idx = process.argv.indexOf("--config");
  const configPath: string =
    idx > -1 && process.argv[idx + 1]
      ? process.argv[idx + 1]!
      : "./config/settings.json";
  return { configPath };
}

// 获取飞书 app_access_token
async function fetchFeishuToken(
  appId: string,
  appSecret: string
): Promise<string> {
  try {
    const resp: { data: FeishuTokenResp } = await axios.post<FeishuTokenResp>(
      FEISHU_TOKEN_API_URL,
      {
        app_id: appId,
        app_secret: appSecret,
      },
      {
        headers: {
          "Content-Type": "application/json",
          Accept: "*/*",
          "Accept-Encoding": "gzip, deflate, br",
          Connection: "keep-alive",
        },
      }
    );

    if (resp.data?.code !== 0) {
      throw new Error(
        `获取飞书 token 失败: ${resp.data?.msg || "unknown error"}`
      );
    }

    const token = resp.data.tenant_access_token;
    console.log(`[INFO] 成功获取飞书 token，有效期 ${resp.data.expire} 秒`);
    return token;
  } catch (error: any) {
    throw new Error(`获取飞书 token 失败: ${error?.message || error}`);
  }
}

// 从飞书多维表格拉取账户和剧名数据（支持分页）
async function fetchFeishuRecords(
  url: string,
  token: string,
  payload: any
): Promise<FeishuRecord[]> {
  const allRecords: FeishuRecord[] = [];
  let pageToken: string | undefined = undefined;

  do {
    const requestPayload: any = {
      ...payload,
      ...(pageToken ? { page_token: pageToken } : {}),
    };

    const resp: { data: FeishuSearchResp } = await axios.post<FeishuSearchResp>(
      url,
      requestPayload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
      }
    );

    if (resp.data?.code !== 0) {
      throw new Error(
        `飞书 API 请求失败: ${resp.data?.msg || "unknown error"}`
      );
    }

    const items = resp.data?.data?.items || [];
    allRecords.push(...items);

    // 检查是否有下一页
    pageToken = resp.data?.data?.has_more
      ? resp.data.data.page_token
      : undefined;
  } while (pageToken);

  return allRecords;
}

// 从飞书多维表格拉取账户和剧名数据
async function fetchAccountsFromFeishu(
  feishuCfg: FeishuConfig,
  timeWindowStartMinutes: number,
  timeWindowEndMinutes: number
): Promise<AccountCfg[]> {
  const baseUrl = (feishuCfg.baseUrl || DEFAULT_FEISHU_BASE_URL).replace(
    /\/$/,
    ""
  );
  const FEISHU_API_URL = `${baseUrl}/apps/${feishuCfg.appToken}/tables/${feishuCfg.tableId}/records/search`;

  // 在查询前获取最新的 token
  const FEISHU_TOKEN = await fetchFeishuToken(
    feishuCfg.appId,
    feishuCfg.appSecret
  );

  const basePayload = {
    field_names: ["剧名", "账户", "主体", "日期", "当前状态", "搭建时间"],
    page_size: 100,
    filter: {
      conjunction: "and",
      conditions: [
        {
          field_name: "当前状态",
          operator: "is",
          value: ["已完成"],
        },
      ],
    },
  };

  // 拉取 Today 的数据
  const todayPayload = {
    ...basePayload,
    filter: {
      ...basePayload.filter,
      conditions: [
        ...basePayload.filter.conditions,
        {
          field_name: "日期",
          operator: "is",
          value: ["Today"],
        },
      ],
    },
  };

  // 拉取 Yesterday 的数据
  const yesterdayPayload = {
    ...basePayload,
    filter: {
      ...basePayload.filter,
      conditions: [
        ...basePayload.filter.conditions,
        {
          field_name: "日期",
          operator: "is",
          value: ["Yesterday"],
        },
      ],
    },
  };

  try {
    // 并行请求两次（自动处理分页）
    const [todayRecords, yesterdayRecords] = await Promise.all([
      fetchFeishuRecords(FEISHU_API_URL, FEISHU_TOKEN, todayPayload),
      fetchFeishuRecords(FEISHU_API_URL, FEISHU_TOKEN, yesterdayPayload),
    ]);

    // 合并两次的数据
    const allRecords = [...todayRecords, ...yesterdayRecords];

    // 调试：输出前3条记录的完整结构
    if (allRecords.length > 0) {
      console.log(`[DEBUG] 飞书返回的前3条记录完整结构:`);
      allRecords.slice(0, 3).forEach((rec, idx) => {
        console.log(`[DEBUG] 记录 ${idx + 1}:`, JSON.stringify(rec, null, 2));
      });
    }

    // 计算时间窗口：使用配置的时间窗口参数
    const now = Date.now();
    const timeWindowStart = now - timeWindowStartMinutes * 60 * 1000;
    const timeWindowEnd = now - timeWindowEndMinutes * 60 * 1000;

    // 格式化时间为 HH:mm 格式，便于阅读
    const formatTime = (timestamp: number): string => {
      const date = new Date(timestamp);
      const hours = date.getHours().toString().padStart(2, "0");
      const minutes = date.getMinutes().toString().padStart(2, "0");
      return `${hours}:${minutes}`;
    };

    const currentTimeStr = formatTime(now);
    const windowStartStr = formatTime(timeWindowStart);
    const windowEndStr = formatTime(timeWindowEnd);

    console.log(
      `[INFO] 从飞书拉取数据：当前时间 ${currentTimeStr}，选取搭建时间在 ${windowStartStr}-${windowEndStr} 之间的账户（前${timeWindowStartMinutes}分钟至前${timeWindowEndMinutes}分钟）`
    );

    // 解析为 AccountCfg 格式，并按 aadvid 去重（保留第一个出现的）
    const accountMap = new Map<string, AccountCfg>();
    let filteredCount = 0;
    let skippedByTimeCount = 0;

    for (const record of allRecords) {
      const dramaName = record.fields.剧名?.[0]?.text;
      const accountId = record.fields.账户?.[0]?.text;
      const buildTime = record.fields.搭建时间;

      // 检查搭建时间是否在时间窗口内（基于配置的时间窗口）
      // 如果没有搭建时间，或者不在时间窗口内，则跳过
      if (
        !buildTime ||
        buildTime < timeWindowStart ||
        buildTime > timeWindowEnd
      ) {
        skippedByTimeCount++;
        continue;
      }

      // 时间窗口过滤后，再解析主体字段
      // 主体字段可能是字符串或数组格式
      let subject: string | undefined;
      const subjectField = record.fields.主体;
      if (typeof subjectField === 'string') {
        subject = subjectField.trim();
      } else if (Array.isArray(subjectField) && subjectField.length > 0) {
        subject = subjectField[0]?.text?.trim();
      }

      // 调试：输出通过时间窗口过滤的账户的主体字段原始结构
      if (accountId) {
        console.log(`[DEBUG] 账户 ${accountId} 的主体字段类型:`, typeof subjectField, `原始数据:`, JSON.stringify(subjectField), `解析后: "${subject || ''}"`);
      }

      if (dramaName && accountId) {
        // 如果该账户还没有被添加过，则添加
        if (!accountMap.has(accountId)) {
          accountMap.set(accountId, {
            aadvid: accountId,
            drama_name: dramaName,
            subject,
          });
          filteredCount++;
        }
      } else {
        console.warn(
          `[WARN] 飞书记录 record_id=${record.record_id} 缺少剧名或账户字段，已跳过`
        );
      }
    }

    const accounts = Array.from(accountMap.values());

    console.log(
      `[INFO] 从飞书多维表格拉取到 ${accounts.length} 条账户配置（Today: ${todayRecords.length}, Yesterday: ${yesterdayRecords.length}，时间过滤后: ${filteredCount}，因时间窗口外跳过: ${skippedByTimeCount}，去重后: ${accounts.length}）`
    );

    return accounts;
  } catch (error: any) {
    throw new Error(`从飞书拉取账户配置失败: ${error?.message || error}`);
  }
}

function loadSettings(file: string): SettingsCfg {
  const abs = path.resolve(file);
  const raw = fs.readFileSync(abs, "utf-8");
  const cfg = JSON.parse(raw) as SettingsCfg;
  const cookieChaoqi = (cfg as any).cookieChaoqi ?? (cfg as any).cookie ?? "";
  const cookieXinya = (cfg as any).cookieXinya ?? "";
  return {
    dryRun: true,
    previewDelayMs: 400,
    fetchConcurrency: 3,
    buildTimeFilterWindowStartMinutes: 50,
    buildTimeFilterWindowEndMinutes: 30,
    appId: DEFAULT_FEISHU_APP_ID,
    appSecret: DEFAULT_FEISHU_APP_SECRET,
    appToken: DEFAULT_FEISHU_APP_TOKEN,
    tableId: DEFAULT_FEISHU_TABLE_ID,
    baseUrl: DEFAULT_FEISHU_BASE_URL,
    cookieChaoqi,
    cookieXinya,
    ...cfg,
    // 如果配置文件中没有 accounts 字段或为空数组，保持为空数组，否则使用配置文件中的值
    accounts: cfg.accounts || [],
  };
}

function resolveFeishuConfig(settings: SettingsCfg): FeishuConfig {
  const appId = settings.appId || DEFAULT_FEISHU_APP_ID;
  const appSecret = settings.appSecret || DEFAULT_FEISHU_APP_SECRET;
  const appToken = settings.appToken || DEFAULT_FEISHU_APP_TOKEN;
  const tableId = settings.tableId || DEFAULT_FEISHU_TABLE_ID;
  const baseUrl = (settings.baseUrl || DEFAULT_FEISHU_BASE_URL).replace(
    /\/$/,
    ""
  );

  if (!appId || !appSecret || !appToken || !tableId) {
    throw new Error(
      "从飞书拉取账户配置需要配置 appId、appSecret、appToken、tableId"
    );
  }

  return { appId, appSecret, appToken, tableId, baseUrl };
}

function resolveAccountCookie(
  account: AccountCfg,
  settings: SettingsCfg
): { cookie: string; alias: string } {
  const trim = (v?: string) => (v || "").trim();
  const directCookie = trim(account.cookie);
  if (directCookie) return { cookie: directCookie, alias: "account.cookie" };

  const subject = trim(account.subject);
  const cookieChaoqi = trim(settings.cookieChaoqi);
  const cookieXinya = trim(settings.cookieXinya);

  // 调试日志：显示实际的主体值
  console.log(`[DEBUG] 账户 ${account.aadvid} 主体字段原始值: "${account.subject}", trim后: "${subject}"`);

  if (subject === "虎雨" || subject === "超琦") {
    if (!cookieChaoqi)
      throw new Error("主体为虎雨/超琦时，需要配置 cookieChaoqi");
    return { cookie: cookieChaoqi, alias: "cookieChaoqi" };
  }

  if (subject === "欣雅") {
    if (!cookieXinya) throw new Error("主体为欣雅时，需要配置 cookieXinya");
    return { cookie: cookieXinya, alias: "cookieXinya" };
  }

  if (!subject) {
    if (cookieChaoqi) return { cookie: cookieChaoqi, alias: "cookieChaoqi" };
    if (cookieXinya) return { cookie: cookieXinya, alias: "cookieXinya" };
    throw new Error("未找到可用 cookie，请配置 cookieChaoqi 或 cookieXinya");
  }

  throw new Error(`主体 ${subject} 未匹配 cookie 规则，请补充映射`);
}

function createClient(cookie: string, proxyUrl?: string): AxiosInstance {
  const baseURL = proxyUrl || "https://ad.oceanengine.com";
  return axios.create({
    baseURL,
    headers: {
      "Content-Type": "application/json",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0.0.0 Safari/537.36",
      Accept: "*/*",
      "Accept-Encoding": "gzip, deflate, br",
      Connection: "keep-alive",
      Cookie: cookie,
    },
    timeout: 20000,
  });
}

async function withRetry<T>(
  runner: () => Promise<T>,
  label: string,
  retries = 3,
  delayMs = 600
): Promise<T> {
  // T 可以是 AxiosResponse<R>，函数会原样返回
  let lastErr: any;
  for (let i = 0; i < retries; i++) {
    try {
      return await runner();
    } catch (e: any) {
      lastErr = e;
      console.warn(
        `[WARN] ${label} 失败重试 ${i + 1}/${retries}:`,
        e?.response?.status || e?.message
      );
      await sleep(delayMs * (i + 1));
    }
  }
  console.error(`[ERROR] ${label} 最终失败`);
  throw lastErr;
}

// =============== API 封装 ===============
async function fetchAllAds(
  client: AxiosInstance,
  aadvid: string
): Promise<AdItem[]> {
  const all: AdItem[] = [];
  let page = 1;
  while (true) {
    const body = {
      sort_stat: "create_time",
      project_status: [-1],
      promotion_status: [-1],
      limit: 10,
      page,
      sort_order: 1,
      campaign_type: [1],
    };
    const resp = await withRetry(
      () =>
        client.post<AdsListResp>(`/ad/api/promotion/ads/list`, body, {
          params: { aadvid },
        }),
      `fetchAds(page=${page})`
    );
    if (resp.data.code !== 0)
      throw new Error(`fetch ads code=${resp.data.code}, msg=${resp.data.msg}`);
    const ads = resp.data.data?.ads ?? [];
    all.push(...ads);
    const pg = resp.data.data?.pagination;
    if (!pg || page >= (pg.total_page || 1)) break;
    page++;
  }
  return all;
}

function filterAndDedupAds(
  ads: AdItem[],
  dramaName: string,
  awemeWhite: string[] = []
): AdItem[] {
  const includesDrama = (name: string) =>
    !!dramaName && name?.includes(dramaName);

  // 1) 按剧名过滤
  const filtered = ads.filter((ad) => includesDrama(ad.promotion_name));

  // 2) 从 promotion_name 中匹配白名单抖音号（最长匹配优先，避免"⼩红"命中"⼩红看剧"）
  const pickAwemeFromTitle = (title: string): string | null => {
    if (!title || !awemeWhite.length) return null;
    const hits = awemeWhite.filter((w) => title.includes(w));
    if (!hits.length) return null;
    const sorted = hits.sort((a, b) => b.length - a.length);
    return sorted[0] ?? null;
  };

  // 3) 解析 create_time（严格格式，失败返回 0）
  const getCreateTs = (ad: AdItem) => {
    const ts = dayjs(
      ad.create_time ?? "",
      "YYYY-MM-DD HH:mm:ss",
      true
    ).valueOf();
    return Number.isFinite(ts) ? ts : 0;
  };

  // 4) 仅保留能命中白名单抖音号的广告，并标注 aweme
  const withAweme = filtered
    .map((ad) => {
      const aweme = pickAwemeFromTitle(ad.promotion_name);
      return aweme ? { aweme, ad } : null;
    })
    .filter(Boolean) as { aweme: string; ad: AdItem }[];

  // 5) 对同一抖音号分组，选 create_time 最新的一条；若时间相同，用 promotion_id 兜底
  const bestByAweme = new Map<string, AdItem>();
  for (const { aweme, ad } of withAweme) {
    const prev = bestByAweme.get(aweme);
    if (!prev) {
      bestByAweme.set(aweme, ad);
      continue;
    }
    const tNew = getCreateTs(ad);
    const tOld = getCreateTs(prev);
    if (tNew > tOld || (tNew === tOld && ad.promotion_id > prev.promotion_id)) {
      bestByAweme.set(aweme, ad);
    }
  }

  // 可选：稳定输出，按 create_time 倒序返回
  return [...bestByAweme.values()].sort(
    (a, b) => getCreateTs(b) - getCreateTs(a)
  );
}
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchMaterialsByPromotions(
  client: AxiosInstance,
  aadvid: string,
  promotionIds: string[],
  concurrency = 3
): Promise<MaterialItem[]> {
  const limit = pLimit(concurrency);
  const results: MaterialItem[] = [];

  const chunks = chunk(promotionIds, 50); // 每次最多 50 个 ID
  await Promise.all(
    chunks.map((ids, ci) =>
      limit(async () => {
        let page = 1;
        while (true) {
          const body = {
            promotion_ids: ids,
            page,
            limit: 50,
            fields: [
              "stat_cost",
              "show_cnt",
              "cpm_platform",
              "click_cnt",
              "ctr",
              "cpc_platform",
              "convert_cnt",
              "conversion_rate",
              "conversion_cost",
              "deep_convert_cnt",
              "deep_convert_cost",
              "deep_convert_rate",
            ],
            sort_stat: "create_time",
            sort_order: 1,
            delivery_package: [],
            delivery_mode: [3],
            delivery_mode_internal: [3],
            quick_delivery: [],
            isAigc: false,
            isAutoStar: false,
          };
          const resp = await withRetry(
            () =>
              client.post<MaterialsListResp>(
                `/ad/api/promotion/materials/list`,
                body,
                { params: { aadvid } }
              ),
            `fetchMaterials(chunk#${ci}, page=${page})`
          );
          if (resp.data.code !== 0)
            throw new Error(
              `fetch materials code=${resp.data.code}, msg=${resp.data.msg}`
            );
          const mats = resp.data.data?.materials ?? [];
          results.push(...mats);
          const pg = resp.data.data?.pagination;
          if (!pg || page >= (pg.total_page || 1)) break;
          page++;
        }
      })
    )
  );

  return results;
}

function classifyMaterials(materials: MaterialItem[]) {
  const ensureArr = (x?: string[]) => (Array.isArray(x) ? x : []);

  const needPreview = materials.filter(
    (m) =>
      m.material_status_first_name === "投放中" &&
      ensureArr(m.material_status_second_name).length === 0 &&
      (m.material_reject_reason_type ?? 0) === 0
  );

  const needDelete = materials.filter(
    (m) =>
      m.material_status_first_name === "投放中" &&
      (m.material_reject_reason_type ?? 0) === 1
  );

  return { needPreview, needDelete };
}

function groupBy<T, K extends string | number>(
  arr: T[],
  keyFn: (x: T) => K
): Record<K, T[]> {
  return arr.reduce((acc, cur) => {
    const k = keyFn(cur);
    (acc[k] ||= []).push(cur);
    return acc;
  }, {} as Record<K, T[]>);
}

function promotionsToDelete(materials: MaterialItem[]): string[] {
  const byPromotion = groupBy(materials, (m) => m.promotion_id);
  const toDelete: string[] = [];
  for (const [pid, mats] of Object.entries(byPromotion)) {
    const anyPreview = mats.some(
      (m) =>
        m.material_status_first_name === "投放中" &&
        (m.material_status_second_name?.length || 0) === 0 &&
        (m.material_reject_reason_type ?? 0) === 0
    );
    const anyNewAudit = mats.some((m) =>
      (m.material_status_second_name || []).includes("新建审核中")
    );
    if (!anyPreview && !anyNewAudit) toDelete.push(pid);
  }
  return toDelete;
}

interface PreviewResp {
  code: number;
  data?: {
    data: {
      advertiserId: string;
      idType: string;
      promotionId: string;
      materialId: string;
      qrcodeMsgUrl: string;
      previewGenerating: boolean;
    };
    inventoryToAppMap: Record<string, string>;
    previewResult: number;
  };
  requestId?: string;
  errmsg?: string;
}

async function previewOne(
  client: AxiosInstance,
  aadvid: string,
  materialId: string,
  promotionId: string
) {
  const resp = await withRetry(
    () =>
      client.get<PreviewResp>(`/ad/api/agw/ad/preview_url`, {
        params: {
          IdType: "ID_TYPE_MATERIAL",
          MaterialId: materialId,
          PromotionId: promotionId,
          aadvid,
        },
        headers: { "Accept-Encoding": "gzip, deflate, br" },
      }),
    `preview(material=${materialId})`
  );
  const code = resp.data?.code ?? 0;
  if (code !== 0) throw new Error(`preview failed code=${code}`);
  return resp.data;
}

interface DeleteResp {
  code: number;
  data?: {};
  extra?: {};
  msg?: string;
  request_id?: string;
}

async function deleteMaterialsBatch(
  client: AxiosInstance,
  aadvid: string,
  promotionId: string,
  cdpIds: string[]
) {
  const payload = { ids: cdpIds, promotion_id: promotionId };
  const resp = await withRetry(
    () =>
      client.post<DeleteResp>(`/superior/api/promote/materials/del`, payload, {
        params: { aadvid },
      }),
    `deleteMaterials(promotion=${promotionId}, count=${cdpIds.length})`
  );
  const code = resp.data?.code ?? 0;
  if (code !== 0) throw new Error(`delete materials failed code=${code}`);
  return resp.data;
}

async function deletePromotion(
  client: AxiosInstance,
  aadvid: string,
  promotionId: string
) {
  const payload = { ids: [promotionId] };
  const resp = await withRetry(
    () =>
      client.post<DeleteResp>(`/ad/api/promotion/ads/delete`, payload, {
        params: { aadvid },
      }),
    `deletePromotion(${promotionId})`
  );
  const code = resp.data?.code ?? 0;
  if (code !== 0) throw new Error(`delete promotion failed code=${code}`);
  return resp.data;
}

// =============== 主流程 ===============
async function runTask(settings: SettingsCfg) {
  // 兼容逻辑：如果 settings.json 中的 accounts 不为空，优先使用；否则从飞书获取
  let accounts: AccountCfg[];
  if (settings.accounts && settings.accounts.length > 0) {
    console.log(
      `[INIT] 使用 settings.json 中的账户配置，共 ${settings.accounts.length} 条`
    );
    accounts = settings.accounts;
  } else {
    console.log(
      "[INIT] settings.json 中的 accounts 为空，正在从飞书多维表格拉取账户配置..."
    );
    const feishuCfg = resolveFeishuConfig(settings);
    accounts = await fetchAccountsFromFeishu(
      feishuCfg,
      settings.buildTimeFilterWindowStartMinutes || 50,
      settings.buildTimeFilterWindowEndMinutes || 30
    );
    if (!accounts.length) {
      throw new Error("从飞书拉取的账户配置为空，请检查多维表格数据");
    }
  }

  const dryRun = !!settings.dryRun;

  console.log(
    `[INIT] dryRun=${dryRun}, previewDelayMs=${
      settings.previewDelayMs
    }, fetchConcurrency=${settings.fetchConcurrency}, proxyUrl=${
      settings.proxyUrl || "none"
    }, 账户数量=${accounts.length}`
  );

  for (const account of accounts) {
    const { aadvid, drama_name, subject } = account; // 账户与剧名一一对应（单值）
    const { cookie: accountCookie, alias: cookieAlias } = resolveAccountCookie(
      account,
      settings
    );
    const client = createClient(accountCookie, settings.proxyUrl);
    console.log(
      `\n===== 账户 aadvid=${aadvid} 主体="${subject || ""}"(${subject ? '有值' : '空'}) 使用${cookieAlias} 开始 =====`
    );

    // 1) 拉取广告
    const adsAll = await fetchAllAds(client, aadvid);
    console.log(`[INFO] 拉取广告数=${adsAll.length}`);

    // 2) 过滤 & 去重（使用全局固定抖音号白名单）
    const adsFiltered = filterAndDedupAds(
      adsAll,
      drama_name,
      settings.aweme_white_list
    );
    console.log(
      `[INFO] 过滤后广告数=${adsFiltered.length}（按剧名过滤 + 全局抖音号白名单去重）`
    );

    if (!adsFiltered.length) {
      console.log(`[WARN] 无匹配广告，跳过账户 aadvid=${aadvid}`);
      continue;
    }

    // 3) 拉取素材
    const promotionIds = adsFiltered.map((a) => a.promotion_id);
    const mats = await fetchMaterialsByPromotions(
      client,
      aadvid,
      promotionIds,
      settings.fetchConcurrency
    );
    console.log(`[INFO] 拉取素材总数=${mats.length}`);

    // 4) 分类
    const { needPreview, needDelete } = classifyMaterials(mats);
    console.log(
      `[INFO] 需预览=${needPreview.length}, 需删除素材=${needDelete.length}`
    );

    // 5) 整单删除广告判断
    const canDeletePromotions = promotionsToDelete(mats);
    console.log(`[INFO] 候选整单删除广告数=${canDeletePromotions.length}`);

    // 5.1) 过滤：整单删除的广告，其下的素材无需处理
    const canDeletePromotionSet = new Set(canDeletePromotions);
    const filteredNeedPreview = needPreview.filter(
      (m) => !canDeletePromotionSet.has(m.promotion_id)
    );
    const filteredNeedDelete = needDelete.filter(
      (m) => !canDeletePromotionSet.has(m.promotion_id)
    );
    console.log(
      `[INFO] 过滤后：需预览=${filteredNeedPreview.length}, 需删除素材=${filteredNeedDelete.length} (已排除整单删除广告的素材)`
    );

    // 6) 执行动作
    if (dryRun) {
      console.log(`\n[DRY-RUN] 将执行如下动作：`);
      console.log(
        `- 预览素材(按序)：`,
        filteredNeedPreview
          .map((m) => ({
            material_id: m.material_id,
            promotion_id: m.promotion_id,
          }))
          .slice(0, 20),
        filteredNeedPreview.length > 20 ? "..." : ""
      );
      console.log(
        `- 删除素材(分广告)：`,
        Object.entries(groupBy(filteredNeedDelete, (m) => m.promotion_id)).map(
          ([pid, arr]) => ({
            promotion_id: pid,
            ids: arr.map((m) => m.cdp_material_id),
          })
        )
      );
      console.log(`- 整单删除广告：`, canDeletePromotions);
      continue;
    }

    // 6.1 预览（必须串行）
    for (const m of filteredNeedPreview) {
      try {
        await previewOne(client, aadvid, m.material_id, m.promotion_id);
        console.log(
          `[OK] 预览成功 material=${m.material_id} promotion=${m.promotion_id}`
        );
      } catch (e: any) {
        console.error(
          `[FAIL] 预览失败 material=${m.material_id} promotion=${m.promotion_id}:`,
          e?.response?.status || e?.message
        );
      }
      await sleep(settings.previewDelayMs || 400);
    }

    // 6.2 删除素材（按广告批量）
    const delGroups = groupBy(
      filteredNeedDelete.filter((m) => !!m.cdp_material_id),
      (m) => m.promotion_id
    );
    for (const [pid, arr] of Object.entries(delGroups)) {
      const ids = arr.map((m) => m.cdp_material_id!).filter(Boolean);
      if (!ids.length) continue;
      try {
        await deleteMaterialsBatch(client, aadvid, pid, ids);
        console.log(`[OK] 删除素材成功 promotion=${pid} count=${ids.length}`);
      } catch (e: any) {
        console.error(
          `[FAIL] 删除素材失败 promotion=${pid}:`,
          e?.response?.status || e?.message
        );
      }
      await sleep(300);
    }

    // 6.3 整单删除广告
    for (const pid of canDeletePromotions) {
      try {
        await deletePromotion(client, aadvid, pid);
        console.log(`[OK] 删除广告成功 promotion=${pid}`);
      } catch (e: any) {
        console.error(
          `[FAIL] 删除广告失败 promotion=${pid}:`,
          e?.response?.status || e?.message
        );
      }
      await sleep(300);
    }

    console.log(`===== 账户 aadvid=${aadvid} 结束 =====\n`);
  }

  console.log("[DONE] 全部账户处理完成");
}

async function run() {
  const { configPath } = parseArgs();
  const settings = loadSettings(configPath);

  const scheduleIntervalMinutes = settings.scheduleIntervalMinutes;

  if (scheduleIntervalMinutes && scheduleIntervalMinutes > 0) {
    // 定时执行模式 - 使用递归 setTimeout 替代 setInterval，避免任务重叠执行
    const intervalMs = scheduleIntervalMinutes * 60 * 1000;
    let isRunning = false; // 任务执行锁，防止重叠执行
    let timeoutId: NodeJS.Timeout | null = null; // 保存 timeout ID，用于优雅退出
    let shouldStop = false; // 停止标志

    console.log(
      `[SCHEDULER] 已启用定时执行模式，每隔 ${scheduleIntervalMinutes} 分钟执行一次`
    );
    console.log(`[SCHEDULER] ${new Date().toLocaleString()} 立即执行首次任务`);

    // 执行任务的函数
    const executeTask = async () => {
      if (shouldStop) {
        console.log("[SCHEDULER] 收到停止信号，取消本次任务执行");
        return;
      }

      // 如果上一个任务还在执行，跳过本次执行
      if (isRunning) {
        console.log(
          `[SCHEDULER] 上次任务仍在执行中，跳过本次执行。将在 ${scheduleIntervalMinutes} 分钟后重试`
        );
        scheduleNext();
        return;
      }

      isRunning = true;
      const taskStartTime = Date.now();

      try {
        console.log(
          `\n[SCHEDULER] ${new Date().toLocaleString()} 开始执行任务...`
        );
        await runTask(settings);
        const taskDuration = ((Date.now() - taskStartTime) / 1000 / 60).toFixed(
          2
        );
        console.log(
          `[SCHEDULER] ${new Date().toLocaleString()} 任务执行完成，耗时 ${taskDuration} 分钟`
        );
      } catch (e: any) {
        const taskDuration = ((Date.now() - taskStartTime) / 1000 / 60).toFixed(
          2
        );
        console.error(
          `[SCHEDULER] 任务执行失败（耗时 ${taskDuration} 分钟）:`,
          e?.response?.data || e?.message || e
        );
      } finally {
        isRunning = false;

        // 任务完成后，清理可能的内存引用（显式设置为 null 有助于 GC）
        if (global.gc) {
          // 仅在启用了 --expose-gc 标志时调用
          try {
            global.gc();
            console.log("[SCHEDULER] 已触发垃圾回收");
          } catch (err) {
            // 忽略错误
          }
        }

        // 如果没有收到停止信号，安排下一次执行
        if (!shouldStop) {
          scheduleNext();
        }
      }
    };

    // 安排下一次执行的函数
    const scheduleNext = () => {
      if (shouldStop) return;
      const nextTime = new Date(Date.now() + intervalMs);
      console.log(
        `[SCHEDULER] 下次执行时间：${nextTime.toLocaleString()}（${scheduleIntervalMinutes} 分钟后）`
      );
      timeoutId = setTimeout(executeTask, intervalMs);
    };

    // 优雅退出处理
    const gracefulShutdown = () => {
      console.log("\n[SCHEDULER] 收到退出信号，正在停止定时任务...");
      shouldStop = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (isRunning) {
        console.log("[SCHEDULER] 等待当前任务执行完成...");
        // 等待当前任务完成，但设置超时
        const checkInterval = setInterval(() => {
          if (!isRunning) {
            clearInterval(checkInterval);
            console.log("[SCHEDULER] 任务已停止，程序退出");
            process.exit(0);
          }
        }, 1000);
        // 30秒后强制退出
        setTimeout(() => {
          clearInterval(checkInterval);
          console.log("[SCHEDULER] 等待超时，强制退出");
          process.exit(1);
        }, 30000);
      } else {
        process.exit(0);
      }
    };

    process.on("SIGINT", gracefulShutdown);
    process.on("SIGTERM", gracefulShutdown);
    process.on("SIGHUP", gracefulShutdown);

    // 立即执行一次，然后由 executeTask 自行安排下一次
    await executeTask();
  } else {
    // 单次执行模式
    await runTask(settings);
  }
}

run().catch((e) => {
  console.error("[FATAL] 程序异常:", e?.response?.data || e?.message || e);
  process.exit(1);
});

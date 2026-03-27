/**
 * 巨量广告预览服务
 * 提供预览、停用预览、删除素材等功能
 */

import axios from "axios";
import type { AxiosInstance } from "axios";
import pLimit from "p-limit";
import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat.js";
dayjs.extend(customParseFormat);

// 飞书常量
const DEFAULT_FEISHU_APP_ID = "cli_a870f7611b7b1013";
const DEFAULT_FEISHU_APP_SECRET = "NTwHbZG8rpOQyMEnXGPV6cNQ84KEqE8z";
const DEFAULT_FEISHU_APP_TOKEN = "WdWvbGUXXaokk8sAS94c00IZnsf";
const DEFAULT_FEISHU_TABLE_ID = "tblDOyi2Lzs80sv0";
const DEFAULT_FEISHU_BASE_URL = "https://open.feishu.cn/open-apis/bitable/v1";
const FEISHU_TOKEN_API_URL = "https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal";

// =============== 类型定义 ===============
interface PreviewTaskConfig {
  aadvid: string; // 广告主ID
  drama_name: string; // 剧名
  aweme_white_list?: string[]; // 抖音号白名单
  cookie: string; // 认证Cookie
  tableId?: string; // 飞书表格ID（可选，用于特定场景）
}

interface BatchPreviewConfig {
  accounts: PreviewTaskConfig[]; // 账户列表
  dryRun?: boolean; // 是否只分析不执行
  previewDelayMs?: number; // 预览延迟时间
  cookie?: string; // 全局通用 Cookie
}

interface FeishuConfig {
  appId: string;
  appSecret: string;
  appToken: string;
  tableId: string;
  baseUrl: string;
}

interface FeishuPreviewConfig {
  feishu?: {
    appId?: string;
    appSecret?: string;
    appToken?: string;
    tableId?: string;
    baseUrl?: string;
  };
  buildTimeFilterWindowStartMinutes?: number; // 搭建时间过滤窗口起始（相对当前时间的前N分钟），默认90
  buildTimeFilterWindowEndMinutes?: number; // 搭建时间过滤窗口结束（相对当前时间的前N分钟），默认20
  aweme_white_list?: string[]; // 全局抖音号白名单
  dryRun?: boolean;
  previewDelayMs?: number;
  cookie?: string;
}

interface FeishuFieldValue {
  text: string;
  type: string;
}

interface FeishuRecord {
  fields: {
    剧名?: FeishuFieldValue[];
    账户?: FeishuFieldValue[];
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
    page_token?: string;
  };
  msg?: string;
}

interface FeishuTokenResp {
  app_access_token: string;
  code: number;
  expire: number;
  msg?: string;
  tenant_access_token: string;
}

interface AdItem {
  promotion_id: string;
  promotion_name: string;
  aweme_name?: string;
  create_time?: string;
}

interface MaterialItem {
  material_id: string;
  cdp_material_id?: string;
  promotion_id: string;
  material_status_first_name?: string;
  material_status_second_name?: string[];
  material_reject_reason_type?: number;
}

interface PreviewResult {
  needPreview: MaterialItem[];
  needDelete: MaterialItem[];
  canDeletePromotions: string[];
  totalAds: number;
  filteredAds: number;
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

interface DeleteResp {
  code: number;
  data?: {};
  msg?: string;
}

// =============== 工具函数 ===============
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(
  runner: () => Promise<T>,
  label: string,
  retries = 3,
  delayMs = 600
): Promise<T> {
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

function createClient(cookie: string): AxiosInstance {
  // 直接请求巨量后台接口
  const baseURL = "https://ad.oceanengine.com";
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
        client.post<any>(`/ad/api/promotion/ads/list`, body, {
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

  // 2) 从 promotion_name 中匹配白名单抖音号（最长匹配优先）
  const pickAwemeFromTitle = (title: string): string | null => {
    if (!title || !awemeWhite.length) return null;
    const hits = awemeWhite.filter((w) => title.includes(w));
    if (!hits.length) return null;
    const sorted = hits.sort((a, b) => b.length - a.length);
    return sorted[0] ?? null;
  };

  // 3) 解析 create_time
  const getCreateTs = (ad: AdItem) => {
    const ts = dayjs(
      ad.create_time ?? "",
      "YYYY-MM-DD HH:mm:ss",
      true
    ).valueOf();
    return Number.isFinite(ts) ? ts : 0;
  };

  // 4) 仅保留能命中白名单抖音号的广告
  const withAweme = filtered
    .map((ad) => {
      const aweme = pickAwemeFromTitle(ad.promotion_name);
      return aweme ? { aweme, ad } : null;
    })
    .filter(Boolean) as { aweme: string; ad: AdItem }[];

  // 5) 对同一抖音号分组，选 create_time 最新的一条
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

  const chunks = chunk(promotionIds, 50);
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
              client.post<any>(
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

const ensureStatusArray = (x?: string[]) => (Array.isArray(x) ? x : []);

function isPendingMaterial(m: MaterialItem) {
  return m.material_status_first_name === "未投放";
}

function isDeliveringMaterial(m: MaterialItem) {
  return m.material_status_first_name === "投放中";
}

function isOnlyBalanceInsufficient(m: MaterialItem) {
  const secondNames = ensureStatusArray(m.material_status_second_name);
  return secondNames.length === 1 && secondNames[0] === "账户余额不足";
}

function containsRejectStatus(m: MaterialItem) {
  const secondNames = ensureStatusArray(m.material_status_second_name);
  return secondNames.includes("审核不通过");
}

function isPendingPreviewMaterial(m: MaterialItem) {
  return (
    isPendingMaterial(m) &&
    isOnlyBalanceInsufficient(m) &&
    (m.material_reject_reason_type ?? 0) === 0
  );
}

function isPendingDeleteMaterial(m: MaterialItem) {
  return (
    isPendingMaterial(m) &&
    ((isOnlyBalanceInsufficient(m) &&
      (m.material_reject_reason_type ?? 0) === 1) ||
      (containsRejectStatus(m) &&
        (m.material_reject_reason_type ?? 0) === 1))
  );
}

function isDeliveringPreviewMaterial(m: MaterialItem) {
  return (
    isDeliveringMaterial(m) &&
    ensureStatusArray(m.material_status_second_name).length === 0 &&
    (m.material_reject_reason_type ?? 0) === 0
  );
}

function isDeliveringDeleteMaterial(m: MaterialItem) {
  return (
    isDeliveringMaterial(m) &&
    (m.material_reject_reason_type ?? 0) === 1
  );
}

function classifyMaterialsByType(materials: MaterialItem[]) {
  const needPreview = materials.filter(
    (m) => isPendingPreviewMaterial(m) || isDeliveringPreviewMaterial(m)
  );

  const needDelete = materials.filter(
    (m) => isPendingDeleteMaterial(m) || isDeliveringDeleteMaterial(m)
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

function promotionsToDeleteByType(materials: MaterialItem[]): string[] {
  const byPromotion = groupBy(materials, (m) => m.promotion_id);
  const toDelete: string[] = [];

  for (const [pid, mats] of Object.entries(byPromotion)) {
    const deliveringMaterials = mats.filter(isDeliveringMaterial);
    const pendingMaterials = mats.filter(isPendingMaterial);
    const hasOtherType = mats.some(
      (m) => !isDeliveringMaterial(m) && !isPendingMaterial(m)
    );

    const hasPreviewMaterial = mats.some(
      (m) => isPendingPreviewMaterial(m) || isDeliveringPreviewMaterial(m)
    );

    const deliveringCanDelete =
      deliveringMaterials.length === 0 ||
      (!deliveringMaterials.some(isDeliveringPreviewMaterial) &&
        !deliveringMaterials.some((m) =>
          ensureStatusArray(m.material_status_second_name).includes("新建审核中")
        ));

    const pendingCanDelete =
      pendingMaterials.length === 0 ||
      (!pendingMaterials.some(isPendingPreviewMaterial) &&
        pendingMaterials.every(isPendingDeleteMaterial));

    if (
      !hasOtherType &&
      !hasPreviewMaterial &&
      deliveringCanDelete &&
      pendingCanDelete
    ) {
      toDelete.push(pid);
    }
  }

  return toDelete;
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

// =============== 飞书集成 ===============
async function fetchFeishuToken(
  appId: string,
  appSecret: string
): Promise<string> {
  try {
    const resp = await axios.post<FeishuTokenResp>(
      FEISHU_TOKEN_API_URL,
      {
        app_id: appId,
        app_secret: appSecret,
      },
      {
        headers: {
          "Content-Type": "application/json",
          Accept: "*/*",
        },
      }
    );

    if (resp.data?.code !== 0) {
      throw new Error(
        `获取飞书 token 失败: ${resp.data?.msg || "unknown error"}`
      );
    }

    console.log(`[飞书] 成功获取 token，有效期 ${resp.data.expire} 秒`);
    return resp.data.tenant_access_token;
  } catch (error: any) {
    throw new Error(`获取飞书 token 失败: ${error?.message || error}`);
  }
}

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

    const resp = await axios.post<FeishuSearchResp>(
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

    pageToken = resp.data?.data?.has_more
      ? resp.data.data.page_token
      : undefined;
  } while (pageToken);

  return allRecords;
}

async function fetchAccountsFromFeishu(
  feishuCfg: FeishuConfig,
  timeWindowStartMinutes: number,
  timeWindowEndMinutes: number,
  aweme_white_list?: string[],
  cookie?: string
): Promise<PreviewTaskConfig[]> {
  const baseUrl = (feishuCfg.baseUrl || DEFAULT_FEISHU_BASE_URL).replace(
    /\/$/,
    ""
  );
  const FEISHU_API_URL = `${baseUrl}/apps/${feishuCfg.appToken}/tables/${feishuCfg.tableId}/records/search`;

  const FEISHU_TOKEN = await fetchFeishuToken(
    feishuCfg.appId,
    feishuCfg.appSecret
  );

  const basePayload = {
    field_names: ["剧名", "账户", "日期", "当前状态", "搭建时间"],
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

  // 拉取 Today 和 Yesterday 的数据
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
    const [todayRecords, yesterdayRecords] = await Promise.all([
      fetchFeishuRecords(FEISHU_API_URL, FEISHU_TOKEN, todayPayload),
      fetchFeishuRecords(FEISHU_API_URL, FEISHU_TOKEN, yesterdayPayload),
    ]);

    const allRecords = [...todayRecords, ...yesterdayRecords];

    // 计算时间窗口
    const now = Date.now();
    const timeWindowStart = now - timeWindowStartMinutes * 60 * 1000;
    const timeWindowEnd = now - timeWindowEndMinutes * 60 * 1000;

    const formatTime = (timestamp: number): string => {
      const date = new Date(timestamp);
      const hours = date.getHours().toString().padStart(2, "0");
      const minutes = date.getMinutes().toString().padStart(2, "0");
      return `${hours}:${minutes}`;
    };

    console.log(
      `[飞书] 当前时间 ${formatTime(now)}，筛选搭建时间在 ${formatTime(timeWindowStart)}-${formatTime(timeWindowEnd)} 之间的账户（前${timeWindowStartMinutes}分钟至前${timeWindowEndMinutes}分钟）`
    );

    const accountMap = new Map<string, PreviewTaskConfig>();
    let filteredCount = 0;
    let skippedByTimeCount = 0;

    for (const record of allRecords) {
      const dramaName = record.fields.剧名?.[0]?.text;
      const accountId = record.fields.账户?.[0]?.text;
      const buildTime = record.fields.搭建时间;

      // 检查搭建时间是否在时间窗口内
      if (
        !buildTime ||
        buildTime < timeWindowStart ||
        buildTime > timeWindowEnd
      ) {
        skippedByTimeCount++;
        continue;
      }

      if (dramaName && accountId) {
        if (!accountMap.has(accountId)) {
          accountMap.set(accountId, {
            aadvid: accountId,
            drama_name: dramaName,
            cookie: cookie || "",
            aweme_white_list,
          });
          filteredCount++;
        }
      }
    }

    const accounts = Array.from(accountMap.values());

    console.log(
      `[飞书] 拉取到 ${accounts.length} 条账户配置（Today: ${todayRecords.length}, Yesterday: ${yesterdayRecords.length}，时间过滤: ${skippedByTimeCount}，最终: ${filteredCount}）`
    );

    return accounts;
  } catch (error: any) {
    throw new Error(`从飞书拉取账户配置失败: ${error?.message || error}`);
  }
}

function resolveFeishuConfig(config?: FeishuPreviewConfig["feishu"]): FeishuConfig {
  const appId = config?.appId || DEFAULT_FEISHU_APP_ID;
  const appSecret = config?.appSecret || DEFAULT_FEISHU_APP_SECRET;
  const appToken = config?.appToken || DEFAULT_FEISHU_APP_TOKEN;
  const tableId = config?.tableId || DEFAULT_FEISHU_TABLE_ID;
  const baseUrl = (config?.baseUrl || DEFAULT_FEISHU_BASE_URL).replace(/\/$/, "");

  return { appId, appSecret, appToken, tableId, baseUrl };
}

// =============== Cookie 解析 ===============
function resolveAccountCookie(account: PreviewTaskConfig, fallbackCookie?: string): string {
  const trim = (v?: string) => (v || "").trim();

  const directCookie = trim(account.cookie);
  if (directCookie) return directCookie;

  const sharedCookie = trim(fallbackCookie);
  if (sharedCookie) return sharedCookie;

  throw new Error(`账户 ${account.aadvid} 缺少可用的 cookie`);
}

// =============== 导出的服务类 ===============
export class PreviewService {
  /**
   * 分析账户需要预览和删除的素材
   */
  async analyzeAccount(config: PreviewTaskConfig): Promise<PreviewResult> {
    const client = createClient(config.cookie);
    console.log(`[预览服务] 分析账户 ${config.aadvid} - 剧名: ${config.drama_name}`);

    // 1) 拉取广告
    const adsAll = await fetchAllAds(client, config.aadvid);
    console.log(`[预览服务] 拉取广告数=${adsAll.length}`);

    // 2) 过滤 & 去重
    const adsFiltered = filterAndDedupAds(
      adsAll,
      config.drama_name,
      config.aweme_white_list
    );
    console.log(`[预览服务] 过滤后广告数=${adsFiltered.length}`);

    if (!adsFiltered.length) {
      return {
        needPreview: [],
        needDelete: [],
        canDeletePromotions: [],
        totalAds: adsAll.length,
        filteredAds: 0,
      };
    }

    // 3) 拉取素材
    const promotionIds = adsFiltered.map((a) => a.promotion_id);
    const mats = await fetchMaterialsByPromotions(
      client,
      config.aadvid,
      promotionIds,
      3
    );
    console.log(`[预览服务] 拉取素材总数=${mats.length}`);

    // 4) 根据素材状态选择不同的分类逻辑
    console.log(`[预览服务] 使用按素材状态分类逻辑（未投放/投放中）`);
    const classified = classifyMaterialsByType(mats);
    const needPreview = classified.needPreview;
    const needDelete = classified.needDelete;
    const canDeletePromotions = promotionsToDeleteByType(mats);

    console.log(
      `[预览服务] 需预览=${needPreview.length}, 需删除素材=${needDelete.length}`
    );
    console.log(`[预览服务] 候选整单删除广告数=${canDeletePromotions.length}`);

    // 5) 过滤：整单删除的广告，其下的素材无需处理
    const canDeletePromotionSet = new Set(canDeletePromotions);
    const filteredNeedPreview = needPreview.filter(
      (m) => !canDeletePromotionSet.has(m.promotion_id)
    );
    const filteredNeedDelete = needDelete.filter(
      (m) => !canDeletePromotionSet.has(m.promotion_id)
    );

    return {
      needPreview: filteredNeedPreview,
      needDelete: filteredNeedDelete,
      canDeletePromotions,
      totalAds: adsAll.length,
      filteredAds: adsFiltered.length,
    };
  }

  /**
   * 执行预览操作
   */
  async executePreview(
    config: PreviewTaskConfig,
    materials: MaterialItem[],
    delayMs = 400
  ): Promise<{ success: number; failed: number }> {
    const client = createClient(config.cookie);
    let success = 0;
    let failed = 0;

    for (const m of materials) {
      try {
        await previewOne(client, config.aadvid, m.material_id, m.promotion_id);
        console.log(
          `[预览服务] ✅ 预览成功 material=${m.material_id} promotion=${m.promotion_id}`
        );
        success++;
      } catch (e: any) {
        console.error(
          `[预览服务] ❌ 预览失败 material=${m.material_id} promotion=${m.promotion_id}:`,
          e?.response?.status || e?.message
        );
        failed++;
      }
      await sleep(delayMs);
    }

    return { success, failed };
  }

  /**
   * 停用预览（删除有问题的素材）
   */
  async stopPreview(
    config: PreviewTaskConfig,
    materials: MaterialItem[]
  ): Promise<{ success: number; failed: number }> {
    const client = createClient(config.cookie);
    let success = 0;
    let failed = 0;

    const delGroups = groupBy(
      materials.filter((m) => !!m.cdp_material_id),
      (m) => m.promotion_id
    );

    for (const [pid, arr] of Object.entries(delGroups)) {
      const ids = arr.map((m) => m.cdp_material_id!).filter(Boolean);
      if (!ids.length) continue;
      try {
        await deleteMaterialsBatch(client, config.aadvid, pid, ids);
        console.log(`[预览服务] ✅ 删除素材成功 promotion=${pid} count=${ids.length}`);
        success++;
      } catch (e: any) {
        console.error(
          `[预览服务] ❌ 删除素材失败 promotion=${pid}:`,
          e?.response?.status || e?.message
        );
        failed++;
      }
      await sleep(300);
    }

    return { success, failed };
  }

  /**
   * 删除整个广告
   */
  async deletePromotions(
    config: PreviewTaskConfig,
    promotionIds: string[]
  ): Promise<{ success: number; failed: number }> {
    const client = createClient(config.cookie);
    let success = 0;
    let failed = 0;

    for (const pid of promotionIds) {
      try {
        await deletePromotion(client, config.aadvid, pid);
        console.log(`[预览服务] ✅ 删除广告成功 promotion=${pid}`);
        success++;
      } catch (e: any) {
        console.error(
          `[预览服务] ❌ 删除广告失败 promotion=${pid}:`,
          e?.response?.status || e?.message
        );
        failed++;
      }
      await sleep(300);
    }

    return { success, failed };
  }

  /**
   * 批量处理多个账户（支持 dryRun）
   */
  async batchProcess(batchConfig: BatchPreviewConfig): Promise<{
    total: number;
    success: number;
    failed: number;
    results: Array<{
      aadvid: string;
      drama_name: string;
      status: "success" | "failed" | "skipped";
      needPreviewCount: number;
      needDeleteCount: number;
      canDeletePromotionsCount: number;
      error?: string;
    }>;
  }> {
    const results: Array<{
      aadvid: string;
      drama_name: string;
      status: "success" | "failed" | "skipped";
      needPreviewCount: number;
      needDeleteCount: number;
      canDeletePromotionsCount: number;
      error?: string;
    }> = [];

    let success = 0;
    let failed = 0;

    console.log(
      `[预览服务] 批量处理 ${batchConfig.accounts.length} 个账户 | dryRun=${!!batchConfig.dryRun}`
    );

    for (const account of batchConfig.accounts) {
      const { aadvid, drama_name } = account;
      
      try {
        // 解析 cookie
        const cookie = resolveAccountCookie(account, batchConfig.cookie);

        const config: PreviewTaskConfig = {
          ...account,
          cookie,
        };

        console.log(`\n===== 账户 ${aadvid} 开始 =====`);

        // 分析
        const analysis = await this.analyzeAccount(config);
        
        if (analysis.filteredAds === 0) {
          console.log(`[预览服务] 无匹配广告，跳过账户 ${aadvid}`);
          results.push({
            aadvid,
            drama_name,
            status: "skipped",
            needPreviewCount: 0,
            needDeleteCount: 0,
            canDeletePromotionsCount: 0,
          });
          continue;
        }

        // DryRun 模式：只分析不执行
        if (batchConfig.dryRun) {
          console.log(`[预览服务] [DRY-RUN] 将执行如下动作：`);
          console.log(
            `- 预览素材数: ${analysis.needPreview.length}`,
            analysis.needPreview.slice(0, 5).map(m => m.material_id)
          );
          console.log(`- 删除素材数: ${analysis.needDelete.length}`);
          console.log(`- 删除广告数: ${analysis.canDeletePromotions.length}`);
          
          results.push({
            aadvid,
            drama_name,
            status: "success",
            needPreviewCount: analysis.needPreview.length,
            needDeleteCount: analysis.needDelete.length,
            canDeletePromotionsCount: analysis.canDeletePromotions.length,
          });
          success++;
          continue;
        }

        // 实际执行
        // 1. 预览
        if (analysis.needPreview.length > 0) {
          await this.executePreview(
            config,
            analysis.needPreview,
            batchConfig.previewDelayMs || 400
          );
        }

        // 2. 删除素材
        if (analysis.needDelete.length > 0) {
          await this.stopPreview(config, analysis.needDelete);
        }

        // 3. 删除广告
        if (analysis.canDeletePromotions.length > 0) {
          await this.deletePromotions(config, analysis.canDeletePromotions);
        }

        console.log(`===== 账户 ${aadvid} 结束 =====\n`);
        
        results.push({
          aadvid,
          drama_name,
          status: "success",
          needPreviewCount: analysis.needPreview.length,
          needDeleteCount: analysis.needDelete.length,
          canDeletePromotionsCount: analysis.canDeletePromotions.length,
        });
        success++;
      } catch (error: any) {
        console.error(`[预览服务] 账户 ${aadvid} 处理失败:`, error?.message);
        results.push({
          aadvid,
          drama_name,
          status: "failed",
          needPreviewCount: 0,
          needDeleteCount: 0,
          canDeletePromotionsCount: 0,
          error: error?.message || String(error),
        });
        failed++;
      }
    }

    console.log(`[预览服务] 批量处理完成 | 成功: ${success} | 失败: ${failed}`);

    return {
      total: batchConfig.accounts.length,
      success,
      failed,
      results,
    };
  }

  /**
   * 从飞书拉取"已完成"状态的剧集并根据搭建时间窗口自动执行预览
   */
  async batchProcessFromFeishu(config: FeishuPreviewConfig): Promise<{
    total: number;
    success: number;
    failed: number;
    results: Array<{
      aadvid: string;
      drama_name: string;
      status: "success" | "failed" | "skipped";
      needPreviewCount: number;
      needDeleteCount: number;
      canDeletePromotionsCount: number;
      error?: string;
    }>;
  }> {
    console.log(`[预览服务] 开始从飞书拉取已完成剧集并执行预览`);

    // 解析飞书配置
    const feishuCfg = resolveFeishuConfig(config.feishu);

    // 从飞书拉取账户列表
    const accounts = await fetchAccountsFromFeishu(
      feishuCfg,
      config.buildTimeFilterWindowStartMinutes || 90,
      config.buildTimeFilterWindowEndMinutes || 20,
      config.aweme_white_list,
      config.cookie
    );

    if (accounts.length === 0) {
      console.log(`[预览服务] 没有符合条件的账户，跳过执行`);
      return {
        total: 0,
        success: 0,
        failed: 0,
        results: [],
      };
    }

    // 批量处理
    const batchConfig: BatchPreviewConfig = {
      accounts,
      dryRun: config.dryRun,
      previewDelayMs: config.previewDelayMs || 400,
      cookie: config.cookie,
    };

    return await this.batchProcess(batchConfig);
  }
}

export type { PreviewTaskConfig, PreviewResult, MaterialItem, BatchPreviewConfig, FeishuPreviewConfig };

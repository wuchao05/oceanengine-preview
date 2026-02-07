import fs from "fs";
import path from "path";
import axios from "axios";
import pLimit from "p-limit";
import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat";
dayjs.extend(customParseFormat);
const DEFAULT_FEISHU_APP_ID = "cli_a870f7611b7b1013";
const DEFAULT_FEISHU_APP_SECRET = "NTwHbZG8rpOQyMEnXGPV6cNQ84KEqE8z";
const DEFAULT_FEISHU_APP_TOKEN = "WdWvbGUXXaokk8sAS94c00IZnsf";
const DEFAULT_FEISHU_TABLE_ID = "tblDOyi2Lzs80sv0";
const DEFAULT_FEISHU_BASE_URL = "https://open.feishu.cn/open-apis/bitable/v1";
const FEISHU_TOKEN_API_URL = "https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal";
// =============== 工具函数 ===============
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function parseArgs() {
    const idx = process.argv.indexOf("--config");
    const configPath = idx > -1 && process.argv[idx + 1]
        ? process.argv[idx + 1]
        : "./config/settings.json";
    return { configPath };
}
// 获取飞书 app_access_token
async function fetchFeishuToken(appId, appSecret) {
    try {
        const resp = await axios.post(FEISHU_TOKEN_API_URL, {
            app_id: appId,
            app_secret: appSecret,
        }, {
            headers: {
                "Content-Type": "application/json",
                Accept: "*/*",
                "Accept-Encoding": "gzip, deflate, br",
                Connection: "keep-alive",
            },
        });
        if (resp.data?.code !== 0) {
            throw new Error(`获取飞书 token 失败: ${resp.data?.msg || "unknown error"}`);
        }
        const token = resp.data.tenant_access_token;
        console.log(`[INFO] 成功获取飞书 token，有效期 ${resp.data.expire} 秒`);
        return token;
    }
    catch (error) {
        throw new Error(`获取飞书 token 失败: ${error?.message || error}`);
    }
}
// 从飞书多维表格拉取账户和剧名数据（支持分页）
async function fetchFeishuRecords(url, token, payload) {
    const allRecords = [];
    let pageToken = undefined;
    do {
        const requestPayload = {
            ...payload,
            ...(pageToken ? { page_token: pageToken } : {}),
        };
        const resp = await axios.post(url, requestPayload, {
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json; charset=utf-8",
            },
        });
        if (resp.data?.code !== 0) {
            throw new Error(`飞书 API 请求失败: ${resp.data?.msg || "unknown error"}`);
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
// 定义两个表的 ID
const TABLE_ID_1 = "tblJcLhLpEkmFkga";
const TABLE_ID_2 = "tblZB1ujNLN7Onpl";
// 从飞书多维表格拉取账户和剧名数据（支持两个表合并）
async function fetchAccountsFromFeishu(feishuCfg, timeWindowStartMinutes, timeWindowEndMinutes) {
    const baseUrl = (feishuCfg.baseUrl || DEFAULT_FEISHU_BASE_URL).replace(/\/$/, "");
    // 在查询前获取最新的 token
    const FEISHU_TOKEN = await fetchFeishuToken(feishuCfg.appId, feishuCfg.appSecret);
    // 构建基础 payload（表1）
    const basePayload1 = {
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
    // 构建基础 payload（表2，需要额外过滤"主体"="每日"）
    const basePayload2 = {
        field_names: ["剧名", "账户", "日期", "当前状态", "搭建时间", "主体"],
        page_size: 100,
        filter: {
            conjunction: "and",
            conditions: [
                {
                    field_name: "当前状态",
                    operator: "is",
                    value: ["已完成"],
                },
                {
                    field_name: "主体",
                    operator: "is",
                    value: ["每日"],
                },
            ],
        },
    };
    // 辅助函数：为单个表创建 Today 和 Yesterday 的 payload
    const createPayloads = (basePayload) => {
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
        return { todayPayload, yesterdayPayload };
    };
    const payloads1 = createPayloads(basePayload1);
    const payloads2 = createPayloads(basePayload2);
    try {
        // 并行请求两个表（每个表有 Today 和 Yesterday 两个查询）
        const [table1TodayRecords, table1YesterdayRecords, table2TodayRecords, table2YesterdayRecords,] = await Promise.all([
            fetchFeishuRecords(`${baseUrl}/apps/${feishuCfg.appToken}/tables/${TABLE_ID_1}/records/search`, FEISHU_TOKEN, payloads1.todayPayload),
            fetchFeishuRecords(`${baseUrl}/apps/${feishuCfg.appToken}/tables/${TABLE_ID_1}/records/search`, FEISHU_TOKEN, payloads1.yesterdayPayload),
            fetchFeishuRecords(`${baseUrl}/apps/${feishuCfg.appToken}/tables/${TABLE_ID_2}/records/search`, FEISHU_TOKEN, payloads2.todayPayload),
            fetchFeishuRecords(`${baseUrl}/apps/${feishuCfg.appToken}/tables/${TABLE_ID_2}/records/search`, FEISHU_TOKEN, payloads2.yesterdayPayload),
        ]);
        // 合并所有数据
        const allRecords = [
            ...table1TodayRecords,
            ...table1YesterdayRecords,
            ...table2TodayRecords,
            ...table2YesterdayRecords,
        ];
        // 调试：输出前3条记录的完整结构
        // if (allRecords.length > 0) {
        //   console.log(`[DEBUG] 飞书返回的前3条记录完整结构:`);
        //   allRecords.slice(0, 3).forEach((rec, idx) => {
        //     console.log(`[DEBUG] 记录 ${idx + 1}:`, JSON.stringify(rec, null, 2));
        //   });
        // }
        // 计算时间窗口：使用配置的时间窗口参数
        const now = Date.now();
        const timeWindowStart = now - timeWindowStartMinutes * 60 * 1000;
        const timeWindowEnd = now - timeWindowEndMinutes * 60 * 1000;
        // 格式化时间为 HH:mm 格式，便于阅读
        const formatTime = (timestamp) => {
            const date = new Date(timestamp);
            const hours = date.getHours().toString().padStart(2, "0");
            const minutes = date.getMinutes().toString().padStart(2, "0");
            return `${hours}:${minutes}`;
        };
        const currentTimeStr = formatTime(now);
        const windowStartStr = formatTime(timeWindowStart);
        const windowEndStr = formatTime(timeWindowEnd);
        console.log(`[INFO] 从飞书拉取数据：当前时间 ${currentTimeStr}，选取搭建时间在 ${windowStartStr}-${windowEndStr} 之间的账户（前${timeWindowStartMinutes}分钟至前${timeWindowEndMinutes}分钟）`);
        // 解析为 AccountCfg 格式，并按 aadvid 去重（保留第一个出现的）
        const accountMap = new Map();
        let filteredCount = 0;
        let skippedByTimeCount = 0;
        for (const record of allRecords) {
            const dramaName = record.fields.剧名?.[0]?.text;
            const accountId = record.fields.账户?.[0]?.text;
            const buildTime = record.fields.搭建时间;
            // 检查搭建时间是否在时间窗口内（基于配置的时间窗口）
            // 如果没有搭建时间，或者不在时间窗口内，则跳过
            if (!buildTime ||
                buildTime < timeWindowStart ||
                buildTime > timeWindowEnd) {
                skippedByTimeCount++;
                continue;
            }
            if (dramaName && accountId) {
                // 如果该账户还没有被添加过，则添加
                if (!accountMap.has(accountId)) {
                    accountMap.set(accountId, {
                        aadvid: accountId,
                        drama_name: dramaName,
                    });
                    filteredCount++;
                }
            }
            else {
                console.warn(`[WARN] 飞书记录 record_id=${record.record_id} 缺少剧名或账户字段，已跳过`);
            }
        }
        const accounts = Array.from(accountMap.values());
        console.log(`[INFO] 从飞书多维表格拉取到 ${accounts.length} 条账户配置（表1-Today: ${table1TodayRecords.length}, 表1-Yesterday: ${table1YesterdayRecords.length}, 表2-Today: ${table2TodayRecords.length}, 表2-Yesterday: ${table2YesterdayRecords.length}，时间过滤后: ${filteredCount}，因时间窗口外跳过: ${skippedByTimeCount}，去重后: ${accounts.length}）`);
        return accounts;
    }
    catch (error) {
        throw new Error(`从飞书拉取账户配置失败: ${error?.message || error}`);
    }
}
function loadSettings(file) {
    const abs = path.resolve(file);
    const raw = fs.readFileSync(abs, "utf-8");
    const cfg = JSON.parse(raw);
    // 兼容旧配置：如果配置了 cookieChaoqi，优先使用它作为全局 cookie
    const cookie = cfg.cookieChaoqi ?? cfg.cookie ?? "";
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
        cookie,
        ...cfg,
        // 如果配置文件中没有 accounts 字段或为空数组，保持为空数组，否则使用配置文件中的值
        accounts: cfg.accounts || [],
    };
}
function resolveFeishuConfig(settings) {
    const appId = settings.appId || DEFAULT_FEISHU_APP_ID;
    const appSecret = settings.appSecret || DEFAULT_FEISHU_APP_SECRET;
    const appToken = settings.appToken || DEFAULT_FEISHU_APP_TOKEN;
    const tableId = settings.tableId || DEFAULT_FEISHU_TABLE_ID;
    const baseUrl = (settings.baseUrl || DEFAULT_FEISHU_BASE_URL).replace(/\/$/, "");
    if (!appId || !appSecret || !appToken || !tableId) {
        throw new Error("从飞书拉取账户配置需要配置 appId、appSecret、appToken、tableId");
    }
    return { appId, appSecret, appToken, tableId, baseUrl };
}
function createClient(cookie, proxyUrl) {
    const baseURL = proxyUrl || "https://ad.oceanengine.com";
    return axios.create({
        baseURL,
        headers: {
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0.0.0 Safari/537.36",
            Accept: "*/*",
            "Accept-Encoding": "gzip, deflate, br",
            Connection: "keep-alive",
            Cookie: cookie,
        },
        timeout: 20000,
    });
}
async function withRetry(runner, label, retries = 3, delayMs = 600) {
    // T 可以是 AxiosResponse<R>，函数会原样返回
    let lastErr;
    for (let i = 0; i < retries; i++) {
        try {
            return await runner();
        }
        catch (e) {
            lastErr = e;
            console.warn(`[WARN] ${label} 失败重试 ${i + 1}/${retries}:`, e?.response?.status || e?.message);
            await sleep(delayMs * (i + 1));
        }
    }
    console.error(`[ERROR] ${label} 最终失败`);
    throw lastErr;
}
// =============== API 封装 ===============
async function fetchAllAds(client, aadvid) {
    const all = [];
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
        const resp = await withRetry(() => client.post(`/ad/api/promotion/ads/list`, body, {
            params: { aadvid },
        }), `fetchAds(page=${page})`);
        if (resp.data.code !== 0)
            throw new Error(`fetch ads code=${resp.data.code}, msg=${resp.data.msg}`);
        const ads = resp.data.data?.ads ?? [];
        all.push(...ads);
        const pg = resp.data.data?.pagination;
        if (!pg || page >= (pg.total_page || 1))
            break;
        page++;
    }
    return all;
}
function filterAndDedupAds(ads, dramaName, awemeWhite = []) {
    const includesDrama = (name) => !!dramaName && name?.includes(dramaName);
    // 1) 按剧名过滤
    const filtered = ads.filter((ad) => includesDrama(ad.promotion_name));
    // 2) 从 promotion_name 中匹配白名单抖音号（最长匹配优先，避免"⼩红"命中"⼩红看剧"）
    const pickAwemeFromTitle = (title) => {
        if (!title || !awemeWhite.length)
            return null;
        const hits = awemeWhite.filter((w) => title.includes(w));
        if (!hits.length)
            return null;
        const sorted = hits.sort((a, b) => b.length - a.length);
        return sorted[0] ?? null;
    };
    // 3) 解析 create_time（严格格式，失败返回 0）
    const getCreateTs = (ad) => {
        const ts = dayjs(ad.create_time ?? "", "YYYY-MM-DD HH:mm:ss", true).valueOf();
        return Number.isFinite(ts) ? ts : 0;
    };
    // 4) 仅保留能命中白名单抖音号的广告，并标注 aweme
    const withAweme = filtered
        .map((ad) => {
        const aweme = pickAwemeFromTitle(ad.promotion_name);
        return aweme ? { aweme, ad } : null;
    })
        .filter(Boolean);
    // 5) 对同一抖音号分组，选 create_time 最新的一条；若时间相同，用 promotion_id 兜底
    const bestByAweme = new Map();
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
    return [...bestByAweme.values()].sort((a, b) => getCreateTs(b) - getCreateTs(a));
}
function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size)
        out.push(arr.slice(i, i + size));
    return out;
}
async function fetchMaterialsByPromotions(client, aadvid, promotionIds, concurrency = 3) {
    const limit = pLimit(concurrency);
    const results = [];
    const chunks = chunk(promotionIds, 50); // 每次最多 50 个 ID
    await Promise.all(chunks.map((ids, ci) => limit(async () => {
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
            const resp = await withRetry(() => client.post(`/ad/api/promotion/materials/list`, body, { params: { aadvid } }), `fetchMaterials(chunk#${ci}, page=${page})`);
            if (resp.data.code !== 0)
                throw new Error(`fetch materials code=${resp.data.code}, msg=${resp.data.msg}`);
            const mats = resp.data.data?.materials ?? [];
            results.push(...mats);
            const pg = resp.data.data?.pagination;
            if (!pg || page >= (pg.total_page || 1))
                break;
            page++;
        }
    })));
    return results;
}
function classifyMaterials(materials) {
    const ensureArr = (x) => (Array.isArray(x) ? x : []);
    // 判断 material_status_second_name 是否只包含"账户余额不足"
    const isOnlyBalanceInsufficient = (m) => {
        const secondNames = ensureArr(m.material_status_second_name);
        return secondNames.length === 1 && secondNames[0] === "账户余额不足";
    };
    // 判断 material_status_second_name 是否包含"审核不通过"
    const containsRejectStatus = (m) => {
        const secondNames = ensureArr(m.material_status_second_name);
        return secondNames.includes("审核不通过");
    };
    const needPreview = materials.filter((m) => isOnlyBalanceInsufficient(m) &&
        (m.material_reject_reason_type ?? 0) === 0);
    const needDelete = materials.filter((m) => (isOnlyBalanceInsufficient(m) &&
        (m.material_reject_reason_type ?? 0) === 1) ||
        (containsRejectStatus(m) && (m.material_reject_reason_type ?? 0) === 1));
    return { needPreview, needDelete };
}
function groupBy(arr, keyFn) {
    return arr.reduce((acc, cur) => {
        const k = keyFn(cur);
        (acc[k] || (acc[k] = [])).push(cur);
        return acc;
    }, {});
}
function promotionsToDelete(materials) {
    const ensureArr = (x) => (Array.isArray(x) ? x : []);
    // 判断 material_status_second_name 是否只包含"账户余额不足"
    const isOnlyBalanceInsufficient = (m) => {
        const secondNames = ensureArr(m.material_status_second_name);
        return secondNames.length === 1 && secondNames[0] === "账户余额不足";
    };
    // 判断 material_status_second_name 是否包含"审核不通过"
    const containsRejectStatus = (m) => {
        const secondNames = ensureArr(m.material_status_second_name);
        return secondNames.includes("审核不通过");
    };
    // 判断素材是否应该被删除
    const shouldDelete = (m) => {
        return ((isOnlyBalanceInsufficient(m) &&
            (m.material_reject_reason_type ?? 0) === 1) ||
            (containsRejectStatus(m) && (m.material_reject_reason_type ?? 0) === 1));
    };
    const byPromotion = groupBy(materials, (m) => m.promotion_id);
    const toDelete = [];
    for (const [pid, mats] of Object.entries(byPromotion)) {
        // 检查是否有需要预览的素材（只包含"账户余额不足" + reject_reason_type = 0）
        const anyPreview = mats.some((m) => isOnlyBalanceInsufficient(m) &&
            (m.material_reject_reason_type ?? 0) === 0);
        // 检查是否所有素材都应该被删除
        const allShouldDelete = mats.every((m) => shouldDelete(m));
        // 如果既无需预览素材，且所有素材都应该被删除，则整单删除
        if (!anyPreview && allShouldDelete) {
            toDelete.push(pid);
        }
    }
    return toDelete;
}
async function previewOne(client, aadvid, materialId, promotionId) {
    const resp = await withRetry(() => client.get(`/ad/api/agw/ad/preview_url`, {
        params: {
            IdType: "ID_TYPE_MATERIAL",
            MaterialId: materialId,
            PromotionId: promotionId,
            aadvid,
        },
        headers: { "Accept-Encoding": "gzip, deflate, br" },
    }), `preview(material=${materialId})`);
    const code = resp.data?.code ?? 0;
    if (code !== 0)
        throw new Error(`preview failed code=${code}`);
    return resp.data;
}
async function deleteMaterialsBatch(client, aadvid, promotionId, cdpIds) {
    const payload = { ids: cdpIds, promotion_id: promotionId };
    const resp = await withRetry(() => client.post(`/superior/api/promote/materials/del`, payload, {
        params: { aadvid },
    }), `deleteMaterials(promotion=${promotionId}, count=${cdpIds.length})`);
    const code = resp.data?.code ?? 0;
    if (code !== 0)
        throw new Error(`delete materials failed code=${code}`);
    return resp.data;
}
async function deletePromotion(client, aadvid, promotionId) {
    const payload = { ids: [promotionId] };
    const resp = await withRetry(() => client.post(`/ad/api/promotion/ads/delete`, payload, {
        params: { aadvid },
    }), `deletePromotion(${promotionId})`);
    const code = resp.data?.code ?? 0;
    if (code !== 0)
        throw new Error(`delete promotion failed code=${code}`);
    return resp.data;
}
// =============== 主流程 ===============
// 记录已处理过的账户 ID 集合，避免重复处理同一个账户
const processedAccountIds = new Set();
async function runTask(settings) {
    // 兼容逻辑：如果 settings.json 中的 accounts 不为空，优先使用；否则从飞书获取
    let accounts;
    if (settings.accounts && settings.accounts.length > 0) {
        console.log(`[INIT] 使用 settings.json 中的账户配置，共 ${settings.accounts.length} 条`);
        accounts = settings.accounts;
    }
    else {
        console.log("[INIT] settings.json 中的 accounts 为空，正在从飞书多维表格拉取账户配置...");
        const feishuCfg = resolveFeishuConfig(settings);
        accounts = await fetchAccountsFromFeishu(feishuCfg, settings.buildTimeFilterWindowStartMinutes || 50, settings.buildTimeFilterWindowEndMinutes || 30);
        if (!accounts.length) {
            throw new Error("从飞书拉取的账户配置为空，请检查多维表格数据");
        }
    }
    const dryRun = !!settings.dryRun;
    console.log(`[INIT] dryRun=${dryRun}, previewDelayMs=${settings.previewDelayMs}, fetchConcurrency=${settings.fetchConcurrency}, proxyUrl=${settings.proxyUrl || "none"}, 账户数量=${accounts.length}`);
    // 打印本轮待处理的所有账户和剧集
    console.log(`[INFO] 本轮待处理账户列表：`);
    accounts.forEach((acc, idx) => {
        const status = processedAccountIds.has(acc.aadvid) ? "（已处理）" : "";
        console.log(`  ${idx + 1}. aadvid=${acc.aadvid} 剧名="${acc.drama_name}"${status}`);
    });
    // 检查是否所有账户都已处理过，如果是则清空记录重新开始
    const allProcessed = accounts.every((acc) => processedAccountIds.has(acc.aadvid));
    if (allProcessed && accounts.length > 0) {
        console.log(`[INFO] 所有 ${accounts.length} 个账户都已处理过，清空记录重新开始`);
        processedAccountIds.clear();
    }
    for (const account of accounts) {
        const { aadvid, drama_name } = account; // 账户与剧名一一对应（单值）
        // 跳过已处理过的账户（避免重复处理同一个账户）
        if (processedAccountIds.has(aadvid)) {
            console.log(`[INFO] 账户 aadvid=${aadvid} 已在之前的轮询中处理过，本次跳过`);
            continue;
        }
        // 优先使用账户级别的 cookie，否则使用全局 cookie
        const accountCookie = account.cookie || settings.cookie;
        if (!accountCookie) {
            throw new Error(`账户 ${aadvid} 未配置 cookie，请在账户配置或全局配置中添加 cookie`);
        }
        const client = createClient(accountCookie, settings.proxyUrl);
        console.log(`\n===== 账户 aadvid=${aadvid} 剧名="${drama_name}" 开始 =====`);
        // 1) 拉取广告
        const adsAll = await fetchAllAds(client, aadvid);
        console.log(`[INFO] 拉取广告数=${adsAll.length}`);
        // 2) 过滤 & 去重（使用全局固定抖音号白名单）
        const adsFiltered = filterAndDedupAds(adsAll, drama_name, settings.aweme_white_list);
        console.log(`[INFO] 过滤后广告数=${adsFiltered.length}（按剧名过滤 + 全局抖音号白名单去重）`);
        if (!adsFiltered.length) {
            console.log(`[WARN] 无匹配广告，跳过账户 aadvid=${aadvid}`);
            continue;
        }
        // 3) 拉取素材
        const promotionIds = adsFiltered.map((a) => a.promotion_id);
        const mats = await fetchMaterialsByPromotions(client, aadvid, promotionIds, settings.fetchConcurrency);
        console.log(`[INFO] 拉取素材总数=${mats.length}`);
        // 3.1) 检查是否有"新建审核中"状态的素材，如果有则跳过该账户
        const hasReviewingMaterial = mats.some((m) => {
            const secondNames = Array.isArray(m.material_status_second_name)
                ? m.material_status_second_name
                : [];
            return secondNames.includes("新建审核中");
        });
        if (hasReviewingMaterial) {
            console.log(`[INFO] 账户 aadvid=${aadvid} 存在"新建审核中"状态的素材，跳过本次处理`);
            continue;
        }
        // 4) 分类
        const { needPreview, needDelete } = classifyMaterials(mats);
        console.log(`[INFO] 需预览=${needPreview.length}, 需删除素材=${needDelete.length}`);
        // 5) 整单删除广告判断
        const canDeletePromotions = promotionsToDelete(mats);
        console.log(`[INFO] 候选整单删除广告数=${canDeletePromotions.length}`);
        // 5.1) 过滤：整单删除的广告，其下的素材无需处理
        const canDeletePromotionSet = new Set(canDeletePromotions);
        const filteredNeedPreview = needPreview.filter((m) => !canDeletePromotionSet.has(m.promotion_id));
        const filteredNeedDelete = needDelete.filter((m) => !canDeletePromotionSet.has(m.promotion_id));
        console.log(`[INFO] 过滤后：需预览=${filteredNeedPreview.length}, 需删除素材=${filteredNeedDelete.length} (已排除整单删除广告的素材)`);
        // 6) 执行动作
        if (dryRun) {
            console.log(`\n[DRY-RUN] 将执行如下动作：`);
            console.log(`- 预览素材(按序)：`, filteredNeedPreview
                .map((m) => ({
                material_id: m.material_id,
                promotion_id: m.promotion_id,
            }))
                .slice(0, 20), filteredNeedPreview.length > 20 ? "..." : "");
            console.log(`- 删除素材(分广告)：`, Object.entries(groupBy(filteredNeedDelete, (m) => m.promotion_id)).map(([pid, arr]) => ({
                promotion_id: pid,
                ids: arr.map((m) => m.cdp_material_id),
            })));
            console.log(`- 整单删除广告：`, canDeletePromotions);
            // dryRun 模式下也记录本次处理的账户，并退出循环
            processedAccountIds.add(aadvid);
            console.log(`[INFO] 本次轮询已处理账户 aadvid=${aadvid}（dryRun模式），退出循环等待下次轮询`);
            break;
        }
        // 6.1 预览（必须串行）
        for (const m of filteredNeedPreview) {
            try {
                await previewOne(client, aadvid, m.material_id, m.promotion_id);
                console.log(`[OK] 预览成功 material=${m.material_id} promotion=${m.promotion_id}`);
            }
            catch (e) {
                console.error(`[FAIL] 预览失败 material=${m.material_id} promotion=${m.promotion_id}:`, e?.response?.status || e?.message);
            }
            await sleep(settings.previewDelayMs || 400);
        }
        // 6.2 删除素材（按广告批量）
        const delGroups = groupBy(filteredNeedDelete.filter((m) => !!m.cdp_material_id), (m) => m.promotion_id);
        for (const [pid, arr] of Object.entries(delGroups)) {
            const ids = arr.map((m) => m.cdp_material_id).filter(Boolean);
            if (!ids.length)
                continue;
            try {
                await deleteMaterialsBatch(client, aadvid, pid, ids);
                console.log(`[OK] 删除素材成功 promotion=${pid} count=${ids.length}`);
            }
            catch (e) {
                console.error(`[FAIL] 删除素材失败 promotion=${pid}:`, e?.response?.status || e?.message);
            }
            await sleep(300);
        }
        // 6.3 整单删除广告
        for (const pid of canDeletePromotions) {
            try {
                await deletePromotion(client, aadvid, pid);
                console.log(`[OK] 删除广告成功 promotion=${pid}`);
            }
            catch (e) {
                console.error(`[FAIL] 删除广告失败 promotion=${pid}:`, e?.response?.status || e?.message);
            }
            await sleep(300);
        }
        console.log(`===== 账户 aadvid=${aadvid} 结束 =====\n`);
        // 记录本次处理的账户，并退出循环（每次轮询只处理一个账户）
        processedAccountIds.add(aadvid);
        console.log(`[INFO] 本次轮询已处理账户 aadvid=${aadvid}，退出循环等待下次轮询`);
        break;
    }
    console.log("[DONE] 本次轮询处理完成");
}
async function run() {
    const { configPath } = parseArgs();
    const settings = loadSettings(configPath);
    const scheduleIntervalMinutes = settings.scheduleIntervalMinutes;
    if (scheduleIntervalMinutes && scheduleIntervalMinutes > 0) {
        // 定时执行模式 - 使用递归 setTimeout 替代 setInterval，避免任务重叠执行
        const intervalMs = scheduleIntervalMinutes * 60 * 1000;
        let isRunning = false; // 任务执行锁，防止重叠执行
        let timeoutId = null; // 保存 timeout ID，用于优雅退出
        let shouldStop = false; // 停止标志
        console.log(`[SCHEDULER] 已启用定时执行模式，每隔 ${scheduleIntervalMinutes} 分钟执行一次`);
        console.log(`[SCHEDULER] ${new Date().toLocaleString()} 立即执行首次任务`);
        // 执行任务的函数
        const executeTask = async () => {
            if (shouldStop) {
                console.log("[SCHEDULER] 收到停止信号，取消本次任务执行");
                return;
            }
            // 如果上一个任务还在执行，跳过本次执行
            if (isRunning) {
                console.log(`[SCHEDULER] 上次任务仍在执行中，跳过本次执行。将在 ${scheduleIntervalMinutes} 分钟后重试`);
                scheduleNext();
                return;
            }
            isRunning = true;
            const taskStartTime = Date.now();
            try {
                console.log(`\n[SCHEDULER] ${new Date().toLocaleString()} 开始执行任务...`);
                await runTask(settings);
                const taskDuration = ((Date.now() - taskStartTime) / 1000 / 60).toFixed(2);
                console.log(`[SCHEDULER] ${new Date().toLocaleString()} 任务执行完成，耗时 ${taskDuration} 分钟`);
            }
            catch (e) {
                const taskDuration = ((Date.now() - taskStartTime) / 1000 / 60).toFixed(2);
                console.error(`[SCHEDULER] 任务执行失败（耗时 ${taskDuration} 分钟）:`, e?.response?.data || e?.message || e);
            }
            finally {
                isRunning = false;
                // 任务完成后，清理可能的内存引用（显式设置为 null 有助于 GC）
                if (global.gc) {
                    // 仅在启用了 --expose-gc 标志时调用
                    try {
                        global.gc();
                        console.log("[SCHEDULER] 已触发垃圾回收");
                    }
                    catch (err) {
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
            if (shouldStop)
                return;
            const nextTime = new Date(Date.now() + intervalMs);
            console.log(`[SCHEDULER] 下次执行时间：${nextTime.toLocaleString()}（${scheduleIntervalMinutes} 分钟后）`);
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
            }
            else {
                process.exit(0);
            }
        };
        process.on("SIGINT", gracefulShutdown);
        process.on("SIGTERM", gracefulShutdown);
        process.on("SIGHUP", gracefulShutdown);
        // 立即执行一次，然后由 executeTask 自行安排下一次
        await executeTask();
    }
    else {
        // 单次执行模式
        await runTask(settings);
    }
}
run().catch((e) => {
    console.error("[FATAL] 程序异常:", e?.response?.data || e?.message || e);
    process.exit(1);
});
//# sourceMappingURL=index.js.map
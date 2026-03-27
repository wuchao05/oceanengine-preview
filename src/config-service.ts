import axios from 'axios';

/**
 * 配置 API 返回的数据结构
 */
interface ConfigApiResponse {
  code: number;
  message: string;
  data: {
    tokens: {
      xh: string;
      daren: string;
    };
    platforms: {
      ocean: {
        sr: { cookie: string };
        ql: { cookie: string };
        mr: { cookie: string };
      };
      changdu?: Record<string, unknown>;
    };
  };
}

/**
 * 运行时配置缓存
 */
interface RuntimeConfig {
  apiToken: string;
  apiTokenAlt: string;
  oceanCookieChaoqi: string;
  oceanCookieXinya: string;
  oceanCookieMeiri: string;
}

/**
 * 兼容远程配置两种结构：
 * 1) ocean.{sr|ql|mr}.cookie
 * 2) ocean.{sr|ql|mr} 直接为字符串
 */
function extractOceanCookie(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (value && typeof value === 'object' && 'cookie' in value) {
    const cookieValue = (value as { cookie?: unknown }).cookie;
    if (typeof cookieValue === 'string') {
      return cookieValue.trim();
    }
  }

  return '';
}

// 配置缓存，避免重复请求
let configCache: RuntimeConfig | null = null;

/**
 * 从远程 API 获取配置
 */
async function fetchConfig(): Promise<RuntimeConfig> {
  try {
    const response = await axios.get<ConfigApiResponse>('https://cxyy.top/api/auth/config', {
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 10000, // 10秒超时
    });

    const apiResponse = response.data;

    // 检查 API 响应状态
    if (apiResponse.code !== 0) {
      throw new Error(`API 返回错误: ${apiResponse.message} (code: ${apiResponse.code})`);
    }

    // 从嵌套的 data 中获取配置
    const { tokens, platforms } = apiResponse.data;

    if (!tokens) {
      throw new Error('API 响应中缺少 tokens 配置');
    }

    const ocean = platforms?.ocean;

    return {
      apiToken: tokens.xh || '',
      apiTokenAlt: tokens.daren || '',
      oceanCookieChaoqi: extractOceanCookie(ocean?.sr),
      oceanCookieXinya: extractOceanCookie(ocean?.ql),
      oceanCookieMeiri: extractOceanCookie(ocean?.mr),
    };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      throw new Error(
        `获取配置失败: ${error.message}${error.response ? ` (状态码: ${error.response.status})` : ''}`,
      );
    }
    throw new Error(`获取配置失败: ${error}`);
  }
}

/**
 * 获取运行时配置（带缓存）
 * 首次调用时从 API 获取，后续调用直接返回缓存
 */
export async function getConfig(): Promise<RuntimeConfig> {
  if (configCache) {
    return configCache;
  }

  console.log('📡 正在从远程获取配置...');
  configCache = await fetchConfig();
  console.log('✅ 配置获取成功');

  return configCache;
}

/**
 * 清除配置缓存（用于测试或强制刷新）
 */
export function clearConfigCache(): void {
  configCache = null;
}

/**
 * 获取 API Token（根据用户类型）
 */
export async function getApiToken(isXhUser: boolean): Promise<string> {
  const config = await getConfig();
  return isXhUser ? config.apiToken : config.apiTokenAlt;
}

/**
 * 获取巨量 Cookie（根据环境变量名）
 */
export async function getOceanCookie(envName: string): Promise<string> {
  const config = await getConfig();

  switch (envName) {
    case 'OCEAN_COOKIE_CHAOQI':
      return config.oceanCookieChaoqi;
    case 'OCEAN_COOKIE_XINYA':
      return config.oceanCookieXinya;
    case 'OCEAN_COOKIE_MEIRI':
      return config.oceanCookieMeiri;
    default:
      throw new Error(`未知的 Cookie 环境变量名: ${envName}`);
  }
}

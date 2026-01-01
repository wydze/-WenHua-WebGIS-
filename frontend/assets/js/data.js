// 数据与通用常量
export const SERVER_URL = 'http://localhost:3000';

// 带超时的fetch包装函数
async function fetchWithTimeout(url, options = {}, timeout = 10000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error(`请求超时: ${url}`);
    }
    throw error;
  }
}

// 根据ID获取单个文化实体数据
export async function getCulturalEntityById(id) {
  try {
    const response = await fetchWithTimeout(`${SERVER_URL}/api/cultural-entities/${id}`, {}, 10000);
    const result = await response.json();
    if (result.success) {
      return result.data;
    }
    throw new Error(result.message || '获取实体数据失败');
  } catch (error) {
    console.error(`API 请求失败 for id ${id}:`, error);
    throw error;
  }
}

// 从 API 获取文化实体数据
export async function fetchCulturalEntities() {
  try {
    const response = await fetchWithTimeout(`${SERVER_URL}/api/cultural-entities`, {}, 10000);
    const result = await response.json();
    if (result.success && Array.isArray(result.data) && result.data.length) {
      return result.data;
    }
    console.warn('获取数据失败或为空，将使用空的后备数据');
    return [];
  } catch (error) {
    console.error('API 请求失败，将使用空的后备数据:', error);
    return [];
  }
}

// 从 API 获取知识图谱数据
export async function fetchKnowledgeGraph(id) {
  try {
    const response = await fetchWithTimeout(`${SERVER_URL}/api/knowledge-graph/${id}`, {}, 15000);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const result = await response.json();
    if (result.success) {
      return result.data;
    } else {
      console.error(`获取知识图谱失败 for id ${id}:`, result.message);
      return { neighbors: [], triples: [] }; // 返回空数据结构
    }
  } catch (error) {
    console.error(`API 请求知识图谱失败 for id ${id}:`, error);
    return { neighbors: [], triples: [] }; // 返回空数据结构
  }
}

// 从 API 获取朝代信息
export async function fetchDynasties() {
  try {
    const response = await fetchWithTimeout(`${SERVER_URL}/api/dynasties`, {}, 10000);
    const result = await response.json();
    if (result.success) {
      return result.data;
    } else {
      console.error('获取朝代信息失败:', result.message);
      return [];
    }
  } catch (error) {
    console.error('API 请求失败:', error);
    return [];
  }
}

export const mapSources = {
  dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'
};

export const normalizeDynasty = (d = '') => {
  if (d.includes('唐')) return '唐代';
  if (d.includes('宋')) return '宋代';
  if (d.includes('元')) return '元代';
  if (d.includes('明')) return '明代';
  if (d.includes('清')) return '清代';
  return '其他';
};

export const normalizeType = (t = '') => {
  const map = {
    site: '遗址',
    person: '人物',
    event: '事件',
    artifact: '器物',
    literature: '文献'
  };
  return map[t] || '其他';
};

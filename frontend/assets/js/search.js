// 搜索功能模块
import { fetchCulturalEntities } from './data.js';

let allEntities = [];
let searchResults = [];
let hotItems = [];

// 初始化搜索功能
export async function initSearch() {
  try {
    allEntities = await fetchCulturalEntities();
    console.log(`✅ 搜索功能初始化完成，共加载 ${allEntities.length} 个实体`);
    
    // 计算热点推送
    calculateHotItems();
  } catch (error) {
    console.error('❌ 搜索功能初始化失败:', error);
  }
}

// 搜索功能
export function searchEntities(query) {
  if (!query || query.trim() === '') {
    searchResults = [];
    return [];
  }
  
  const searchTerm = query.trim().toLowerCase();
  searchResults = allEntities.filter(entity => {
    // 搜索名称
    const nameMatch = entity.name && entity.name.toLowerCase().includes(searchTerm);
    // 搜索描述
    const descMatch = (entity.description || entity.desc || '').toLowerCase().includes(searchTerm);
    // 搜索朝代
    const dynastyMatch = (entity.dynasty || entity.dynasty_name || '').toLowerCase().includes(searchTerm);
    // 搜索类型
    const typeMatch = (entity.type || '').toLowerCase().includes(searchTerm);
    
    return nameMatch || descMatch || dynastyMatch || typeMatch;
  });
  
  console.log(`🔍 搜索 "${query}" 找到 ${searchResults.length} 个结果`);
  return searchResults;
}

// 计算热点推送（简单的算法：根据类型和朝代统计）
function calculateHotItems() {
  if (allEntities.length === 0) return;
  
  // 统计每个类型的数量
  const typeCounts = {};
  const dynastyCounts = {};
  
  allEntities.forEach(entity => {
    // 统计类型
    const type = entity.type || 'unknown';
    typeCounts[type] = (typeCounts[type] || 0) + 1;
    
    // 统计朝代
    const dynasty = entity.dynasty || entity.dynasty_name || 'unknown';
    dynastyCounts[dynasty] = (dynastyCounts[dynasty] || 0) + 1;
  });
  
  // 找出最热门的类型（人物和器物）
  const hotTypes = ['person', 'artifact'].filter(type => typeCounts[type] > 0);
  
  // 从热门类型中随机选择几个作为热点推送
  hotItems = [];
  hotTypes.forEach(type => {
    const typeEntities = allEntities.filter(e => e.type === type);
    // 随机选择2-3个
    const count = Math.min(3, typeEntities.length);
    const shuffled = typeEntities.sort(() => 0.5 - Math.random());
    hotItems.push(...shuffled.slice(0, count));
  });
  
  // 如果热点不够，从所有实体中补充
  if (hotItems.length < 5) {
    const remaining = allEntities.filter(e => !hotItems.includes(e));
    const shuffled = remaining.sort(() => 0.5 - Math.random());
    hotItems.push(...shuffled.slice(0, 5 - hotItems.length));
  }
  
  console.log(`🔥 生成了 ${hotItems.length} 个热点推送`);
}

// 获取热点推送
export function getHotItems(count = 5) {
  return hotItems.slice(0, count);
}

// 根据ID获取实体
export function getEntityById(id) {
  return allEntities.find(e => e.id === id || e.kg_node_id === id);
}

// 获取所有实体（用于外部使用）
export function getAllEntities() {
  return allEntities;
}









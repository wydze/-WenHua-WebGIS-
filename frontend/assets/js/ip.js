import { getCulturalEntityById, fetchKnowledgeGraph } from './data.js';
import { initMap } from './map.js';
import { normalizeType } from './data.js';

// 关系类型到中文的映射
const relationMap = {
  WROTE: '创作了',
  PARTICIPATED_IN: '参与了',
  INITIATED: '发起了',
  RELATED_TO: '相关',
  OPPOSED: '对立于',
  LIVED_AT: '居住于',
  BURIED_AT: '埋葬于',
  EXCAVATED_AT: '出土于',
  KEPT_IN: '收藏于',
  DEPICTS: '描绘了',
  RECORDS: '记载了',
  OCCURRED_AT: '发生于',
};

// --- 新增：特定实体的资源映射配置 ---
const specialAssets = {
  '苏轼': {
    image: '../assets/data/苏轼.jpg'
  },
  '寒食帖': {
    image: '../assets/data/寒食帖.jpg'
  },
  '灵隐寺': {
    model: '../assets/data/灵隐寺狮子.glb'
  },
  '故宫': {
    model: '../assets/data/故宫太和殿.glb'
  }
};

function getRelationLabel(relation) {
  return relationMap[relation] || relation;
}

document.addEventListener('DOMContentLoaded', () => {
  const urlParams = new URLSearchParams(window.location.search);
  const entityId = urlParams.get('id');
  const loadingIndicator = document.getElementById('loading-indicator');
  const contentContainer = document.getElementById('ip-content');

  if (entityId) {
    loadEntityData(entityId);
  } else {
    showError('未提供文化实体ID');
  }

  async function loadEntityData(id) {
    try {
      const data = await getCulturalEntityById(id);
      if (data) {
        if (data.kg_node_id) {
          const kgData = await fetchKnowledgeGraph(data.kg_node_id);
          data.kg = kgData;
        }
        renderData(data);
        loadingIndicator.style.display = 'none';
        contentContainer.style.opacity = 1;
      } else {
        showError('未找到对应的文化实体数据');
      }
    } catch (error) {
      console.error('加载数据失败:', error);
      showError('加载数据失败，请检查网络连接或稍后再试');
    }
  }

  function renderData(data) {
    const entityName = data.name || '未知名称';
    document.getElementById('ip-title').textContent = entityName;
    document.getElementById('ip-dynasty').textContent = data.dynasty || '未知朝代';
    document.getElementById('ip-type-badge').textContent = normalizeType(data.type);
    
    // --- 新增：处理 3D 模型逻辑 ---
    // 如果该实体配置了模型，替换原来的 Icon 区域
    if (specialAssets[entityName] && specialAssets[entityName].model) {
      const iconContainer = document.getElementById('ip-icon-container');
      if (iconContainer) {
        // 清空原有 Icon，移除圆形边框限制以便展示模型，或者保留圆形风格
        // 这里为了更好地展示模型，我们调整样式，使其透明并允许模型交互
        iconContainer.innerHTML = `
          <model-viewer 
            src="${specialAssets[entityName].model}" 
            alt="${entityName} 3D模型" 
            auto-rotate 
            camera-controls 
            ar
            shadow-intensity="1"
            style="width: 100%; height: 100%; --poster-color: transparent;"
            class="w-full h-full"
          ></model-viewer>
        `;
        // 去除背景色和边框以便模型融合
        iconContainer.classList.remove('bg-black/50', 'border-2', 'border-yellow-500/30');
        iconContainer.classList.add('bg-transparent');
      }
    }

    const tagsContainer = document.getElementById('ip-tags');
    tagsContainer.innerHTML = '';
    if (data.tags && data.tags.length > 0) {
      data.tags.forEach(tag => {
        const tagElement = document.createElement('span');
        tagElement.className = 'px-3 py-1 bg-gray-800/60 border border-gray-700 rounded-full text-sm';
        tagElement.textContent = tag;
        tagsContainer.appendChild(tagElement);
      });
    }

    // 1. 合并 detail 和 meta_info
    const infoData = { ...(data.detail || {}), ...(data.meta_info || {}) };

    // 2. 根据类型处理主描述和字段
    let mainDesc = data.desc || '暂无描述';
    const entityType = (data.type || '').toLowerCase();

    if (entityType === 'person') {
      if (infoData.biography) {
        mainDesc = infoData.biography;
        delete infoData.biography; // 从信息中移除，避免重复
      }
    } else if (entityType === 'literature') {
      // 文献：内容摘要作为顶部介绍
      if (infoData.content_summary) {
        mainDesc = infoData.content_summary;
        delete infoData.content_summary; // 从信息中移除，避免重复
      }
      // 如果同时存在 author 和 author_name，优先保留 author_name，删除 author，避免“作者”重复
      if (infoData.author && infoData.author_name && infoData.author === infoData.author_name) {
        delete infoData.author;
      }
    } else if (entityType === 'event') {
      delete infoData.year_range; // 移除 year_range
    } else if (entityType === 'site') {
      delete infoData.lng; // 移除 lng
      delete infoData.lat; // 移除 lat
    }

    document.getElementById('ip-desc').textContent = mainDesc;

    // 3. 渲染合并后的信息区域
    renderSection('ip-info-section', '信息', infoData, entityType);
    
    if (data.kg && data.kg.neighbors && data.kg.neighbors.length > 0) {
      document.getElementById('ip-kg-section').style.display = 'block';
      renderKgGraph(data, data.kg);
    } else {
      document.getElementById('ip-kg-section').style.display = 'none';
    }

    const coordsEl = document.getElementById('ip-coords');
    const mapContainer = document.getElementById('map-container');
    const mapEl = document.getElementById('ip-map');

    // --- 地图与图片逻辑 ---
    let hasCoords = data.lat && data.lng;
    let hasImage = specialAssets[entityName] && specialAssets[entityName].image;

    // 坐标文字显示
    if (hasCoords) {
      coordsEl.textContent = `坐标: ${data.lat.toFixed(4)} N, ${data.lng.toFixed(4)} E`;
    } else {
      coordsEl.textContent = '坐标: 暂无';
    }

    // 处理地图容器显示
    if (hasCoords || hasImage) {
      mapContainer.style.display = 'block';
      
      // 初始化地图（如果有坐标）
      if (hasCoords) {
        initMap('ip-map', data.lat, data.lng, data.name);
      } else {
        // 无坐标时隐藏地图元素，避免空白
        mapEl.style.display = 'none';
      }

      // --- 新增：处理图片及切换逻辑 ---
      if (hasImage) {
        // 创建图片元素
        const imgEl = document.createElement('img');
        imgEl.id = 'ip-display-image';
        imgEl.src = specialAssets[entityName].image;
        imgEl.className = 'w-full h-full object-contain bg-black/40 hidden absolute inset-0 z-20'; // 默认隐藏
        mapContainer.appendChild(imgEl);

        // 如果既有地图又有图片，添加切换按钮
        if (hasCoords) {
          const toggleContainer = document.createElement('div');
          toggleContainer.className = 'absolute top-3 right-3 z-30 flex gap-2';
          toggleContainer.innerHTML = `
            <button id="btn-show-map" class="px-3 py-1 text-xs font-bold bg-yellow-600 text-black rounded hover:bg-yellow-500 transition-colors shadow-lg">地图</button>
            <button id="btn-show-img" class="px-3 py-1 text-xs font-bold bg-gray-700 text-white rounded hover:bg-gray-600 transition-colors shadow-lg">影像</button>
          `;
          mapContainer.appendChild(toggleContainer);

          const btnMap = document.getElementById('btn-show-map');
          const btnImg = document.getElementById('btn-show-img');

          // 切换事件
          btnMap.addEventListener('click', () => {
            imgEl.classList.add('hidden');
            mapEl.classList.remove('opacity-0'); // 使用 opacity 避免 display:none 导致的地图渲染问题
            mapEl.style.zIndex = '1';
            
            // 样式激活状态
            btnMap.classList.replace('bg-gray-700', 'bg-yellow-600');
            btnMap.classList.replace('text-white', 'text-black');
            btnImg.classList.replace('bg-yellow-600', 'bg-gray-700');
            btnImg.classList.replace('text-black', 'text-white');
          });

          btnImg.addEventListener('click', () => {
            imgEl.classList.remove('hidden');
            // 这里不移除 DOM，而是让图片盖在地图上面
            mapEl.classList.add('opacity-0');
            mapEl.style.zIndex = '0';

            // 样式激活状态
            btnImg.classList.replace('bg-gray-700', 'bg-yellow-600');
            btnImg.classList.replace('text-white', 'text-black');
            btnMap.classList.replace('bg-yellow-600', 'bg-gray-700');
            btnMap.classList.replace('text-black', 'text-white');
          });
        } else {
          // 只有图片没有坐标，直接显示图片
          imgEl.classList.remove('hidden');
          imgEl.style.position = 'relative'; // 恢复文档流
        }
      }

    } else {
      mapContainer.style.display = 'none';
    }

    const createdAtEl = document.getElementById('ip-created-at');
    if (data.created_at) {
      createdAtEl.textContent = `创建时间: ${new Date(data.created_at).toLocaleDateString()}`;
    }
  }

  function renderSection(sectionId, title, data, entityType) {
    const section = document.getElementById(sectionId);
    if (data && Object.keys(data).length > 0) {
      const content = Object.entries(data)
        .map(([key, value]) => {
          if (value === null || value === undefined || value === '') return '';

          // 根据类型过滤字段
          if (entityType === 'site') {
            if (key === 'lng' || key === 'lat') return ''; // 遗址类型中过滤掉 lng 和 lat
          } else if (entityType === 'event') {
            if (key === 'year_range') return ''; // 事件类型中过滤掉 year_range
          }

          // 特殊处理人物别名
          if (key === 'alternative_names') {
            try {
              let names = value;
              // 如果是字符串，尝试解析为JSON
              if (typeof value === 'string') {
                names = JSON.parse(value);
              }
              // 如果是对象，直接提取值
              if (typeof names === 'object' && names !== null && !Array.isArray(names)) {
                // 仅展示值，用分号分隔
                value = Object.values(names).join('; ');
              }
            } catch (e) {
              // 如果解析失败，则按原样显示
            }
          }

          return `<div class="info-row"><span class="info-label">${getFieldLabel(key)}</span><span class="info-value">${formatValue(value)}</span></div>`;
        })
        .filter(item => item !== '') // 过滤掉空字符串
        .join('');
      
      if (content) {
        section.innerHTML = `<h2 class="section-title">${title}</h2><div class="info-grid">${content}</div>`;
      } else {
        section.style.display = 'none';
      }
    } else {
      section.style.display = 'none';
    }
  }

  function renderKgGraph(sourceData, kg) {
    const { nodes, links } = transformKgDataForGraph(sourceData, kg);
    
    const graphContainer = document.getElementById('kg-graph');
    const graph = ForceGraph()(graphContainer)
      .graphData({ nodes, links })
      .nodeId('id')
      .nodeVal('val')
      .nodeAutoColorBy('group')
      
      .linkSource('source')
      .linkTarget('target')
      .linkDirectionalArrowLength(3.5)
      .linkDirectionalArrowRelPos(1)
      .backgroundColor('rgba(0,0,0,0)')
      .width(graphContainer.offsetWidth)
      .height(graphContainer.offsetHeight)
      .onNodeClick(node => {
        if (node.uuid) {
          window.location.href = `ip.html?id=${node.uuid}`;
        }
      })
      .nodeCanvasObject((node, ctx, globalScale) => {
        const label = node.name;
        const fontSize = 12 / globalScale;
        ctx.font = `${fontSize}px Sans-Serif`;
        
        const textWidth = ctx.measureText(label).width;
        const r = node.val + 4;
        if (textWidth < r * 2 * 0.8) {
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = 'white';
          ctx.fillText(label, node.x, node.y);
        } else {
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = 'white';
          ctx.fillText(label, node.x, node.y + r + 2);
        }

        ctx.beginPath();
        ctx.arc(node.x, node.y, node.val, 0, 2 * Math.PI, false);
        ctx.fillStyle = node.color;
        ctx.fill();
      })
      .linkCanvasObject((link, ctx, globalScale) => {
        const label = getRelationLabel(link.relation);
        const start = link.source;
        const end = link.target;

        // Draw the line itself
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
        ctx.strokeStyle = 'rgba(255, 215, 0, 0.6)'; // Gold with some transparency
        ctx.lineWidth = 0.5 / globalScale;
        ctx.stroke();

        if (!label) return;

        const textPos = Object.assign(...['x', 'y'].map(c => ({
          [c]: start[c] + (end[c] - start[c]) / 2
        })));

        const fontSize = 8 / globalScale;
        ctx.font = `${fontSize}px Sans-Serif`;
        const textWidth = ctx.measureText(label).width;
        
        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        ctx.fillRect(textPos.x - textWidth / 2 - 2, textPos.y - fontSize / 2 - 1, textWidth + 4, fontSize + 2);
        
        ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, textPos.x, textPos.y);
      });

    graph.d3Force('charge').strength(-250);
    graph.d3Force('link').distance(100);
  }

  function transformKgDataForGraph(sourceData, kg) {
    const nodes = new Map();
    const links = [];

    nodes.set(sourceData.kg_node_id, { id: sourceData.kg_node_id, name: sourceData.name, group: 1, val: 12, uuid: sourceData.id });

    kg.triples.forEach(triple => {
      const neighbor = kg.neighbors.find(n => n.name === triple.tail);
      if (neighbor) {
        if (!nodes.has(neighbor.id)) {
          // The backend needs to provide the entity's UUID, here we assume it's in `neighbor.uuid`
          nodes.set(neighbor.id, { id: neighbor.id, name: neighbor.name, group: 2, val: 6, uuid: neighbor.uuid });
        }
        links.push({ source: sourceData.kg_node_id, target: neighbor.id, relation: triple.relation });
      }
    });

    return { nodes: Array.from(nodes.values()), links };
  }

  function showError(message) {
    loadingIndicator.style.display = 'none';
    contentContainer.innerHTML = `<div class="text-center py-20"><h1 class="text-2xl text-red-500">错误</h1><p class="mt-4 text-gray-400">${message}</p></div>`;
    contentContainer.style.opacity = 1;
  }
});

function getFieldLabel(key) {
  const labelMap = {
    // 通用
    name: '名称',
    alternative_names: '别名',
    exist_status: '保存状态',
    historical_significance: '历史意义',
    // 人物
    gender: '性别',
    birth_year: '生年',
    death_year: '卒年',
    birth_place_name: '出生地',
    titles: '官职/称号',
    ethnicity: '民族',
    biography: '生平',
    // 事件
    event_type: '事件类型',
    start_date: '开始日期',
    end_date: '结束日期',
    location_name: '地点',
    outcome: '结果',
    main_participants: '主要参与者',
    date_display: '日期',
    // 遗址
    site_type: '遗址类型',
    address_modern: '现代地址',
    construction_year: '建造年份',
    geometry: '几何信息',
    // 文物
    material: '材质',
    craft: '工艺',
    discovered_at: '发现地',
    preserved_at: '收藏地',
    // 文献
    title: '标题',
    genre: '体裁',
    author_name: '作者',
    year: '年份',
    content_summary: '内容摘要',
    author: '作者',
    status: '状态',
    literary_status: '文献状态',
  };
  return labelMap[key] || key;
}

function formatValue(value) {
  if (typeof value === 'string' && value.includes('T') && value.includes('Z')) {
    return new Date(value).getFullYear() + '年';
  }
  if (Array.isArray(value)) {
    return value.join('、');
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).map(([k, v]) => `${k}: ${v}`).join('; ');
  }
  return value;
}
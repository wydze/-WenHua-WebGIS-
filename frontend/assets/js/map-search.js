// 地图搜索功能模块
import { searchEntities, getHotItems, getEntityById } from './search.js';

// 地图搜索功能（需要在 map.js 中调用）
export function setupMapSearch(mapMarkersById, map) {
  const searchInput = document.getElementById('search-input');
  const searchResults = document.getElementById('search-results');
  const hotItems = document.getElementById('hot-items');
  const hotItemsList = document.getElementById('hot-items-list');
  
  if (!searchInput || !searchResults || !hotItems || !hotItemsList) {
    console.warn('地图搜索元素未找到');
    return;
  }
  
  // 渲染卡片列表（热点或搜索）
  function renderCardList(items, titleIcon = 'fire', titleText = '热点推送') {
    if (!items || items.length === 0) {
      hotItems.classList.add('hidden');
      return;
    }

    // 标题
    const titleBar = `<div class=\"text-xs text-yellow-400 mb-3 font-tech tracking-wider\">${titleIcon === 'fire' ? '🔥' : '🔍'} ${titleText}</div>`;

    hotItemsList.innerHTML = titleBar + items.map(item => {
      const typeName = item.type === 'person' ? '人物' : 
                      item.type === 'artifact' ? '器物' :
                      item.type === 'site' ? '遗址' :
                      item.type === 'event' ? '事件' :
                      item.type === 'literature' ? '文献' : '其他';
      const icon = item.type === 'person' ? 'user' : 
                   item.type === 'artifact' ? 'gem' : 
                   item.type === 'site' ? 'landmark' : 
                   item.type === 'event' ? 'calendar-alt' : 
                   item.type === 'literature' ? 'book' : 'question-circle';
      const description = (item.description || item.desc || '暂无简介').substring(0, 50) + '...';

      return `
        <div class=\"hot-item-card p-3 rounded-lg bg-gradient-to-br from-yellow-900/30 to-yellow-700/10 border border-yellow-500/30 hover:bg-yellow-900/40 cursor-pointer transition-all duration-300\" data-id=\"${item.id}\">
            <div class=\"flex items-start gap-3\">
                <div class=\"w-8 h-8 rounded-full bg-yellow-500/20 flex items-center justify-center text-yellow-400 text-sm flex-shrink-0 mt-1\">
                    <i class=\"fas fa-${icon}\"></i>
                </div>
                <div class=\"flex-1\">
                    <div class=\"text-base text-white font-serif-sc\">${item.name || '未命名'}</div>
                    <div class=\"text-xs text-yellow-400 font-tech tracking-widest mb-2\">${typeName} · ${item.dynasty || item.dynasty_name || '未知'}</div>
                    <p class=\"text-xs text-gray-400 leading-relaxed line-clamp-2\">${description}</p>
                </div>
            </div>
        </div>
      `;
    }).join('');

    hotItems.classList.remove('hidden');

    // 绑定点击
    hotItemsList.querySelectorAll('.hot-item-card').forEach(el => {
      el.addEventListener('click', () => {
        const rawId = el.dataset.id;
        const entityId = isNaN(Number(rawId)) ? rawId : Number(rawId);
        handleMapSearchSelect(entityId, mapMarkersById, map);
      });
    });
  }

  // 显示热点推送
  function showHotItems() {
    renderCardList(getHotItems(5));
  }
  
  // 显示搜索结果
  function showSearchResults(results) {
    // 过滤掉没有坐标的实体，确保每个搜索结果都能在地图上定位
    results = results.filter(item => item.lat && item.lng);

    if (results.length === 0) {
      searchResults.innerHTML = '<div class="p-4 text-center text-gray-400 text-sm">未找到相关结果</div>';
      searchResults.classList.remove('hidden');
      return;
    }
    
    searchResults.innerHTML = results.slice(0, 10).map(item => {
      const typeName = item.type === 'person' ? '人物' : 
                      item.type === 'artifact' ? '器物' :
                      item.type === 'site' ? '遗址' :
                      item.type === 'event' ? '事件' :
                      item.type === 'literature' ? '文献' : '其他';
      return `
        <div class="search-result flex items-center gap-3 p-3 border-b border-white/5 hover:bg-white/5 cursor-pointer transition" data-id="${item.id}">
          <div class="w-10 h-10 rounded-full bg-yellow-500/20 flex items-center justify-center text-yellow-400">
            <i class="fas fa-${item.type === 'person' ? 'user' : item.type === 'artifact' ? 'gem' : 'landmark'}"></i>
          </div>
          <div class="flex-1">
            <div class="text-sm text-white font-medium">${item.name || '未命名'}</div>
            <div class="text-xs text-gray-400">${typeName} · ${item.dynasty || item.dynasty_name || '未知'}</div>
          </div>
        </div>
      `;
    }).join('');
    
    searchResults.classList.remove('hidden');
    
    // 绑定点击事件
    searchResults.querySelectorAll('.search-result').forEach(item => {
      item.addEventListener('click', () => {
        const rawId = item.dataset.id;
        const entityId = isNaN(Number(rawId)) ? rawId : Number(rawId);
        handleMapSearchSelect(entityId, mapMarkersById, map);
      });
    });
  }
  
  // 搜索输入事件
  let searchTimeout;
  searchInput.addEventListener('input', (e) => {
    const query = e.target.value.trim();
    
    clearTimeout(searchTimeout);
    
    if (query === '') {
      searchResults.classList.add('hidden');
      // 仅在点击搜索框时展开下拉，这里不主动展示热点
      hotItems.classList.add('hidden');
      return;
    }
    
    searchTimeout = setTimeout(() => {
      const results = searchEntities(query);
      showSearchResults(results);
      // 与星云界面保持一致：输入搜索内容后，仅显示搜索结果，隐藏热点推送
      hotItems.classList.add('hidden');
    }, 300);
  });
  
  // 聚焦时显示热点推送
  searchInput.addEventListener('focus', () => {
    const q = searchInput.value.trim();
    if (q === '') {
      searchResults.classList.add('hidden');
      showHotItems();
    } else {
      const results = searchEntities(q);
      showSearchResults(results);
      // 与星云界面保持一致：已有搜索内容时，只展示搜索结果，不显示热点推送
      hotItems.classList.add('hidden');
    }
  });
  
  // 点击外部关闭
  document.addEventListener('click', (e) => {
    if (!searchInput.contains(e.target) && !searchResults.contains(e.target) && !hotItems.contains(e.target)) {
      searchResults.classList.add('hidden');
      hotItems.classList.add('hidden');
    }
  });
  
  // 初始化时不主动显示热点推送，仅在聚焦时显示
  // showHotItems();
}

// 处理地图搜索选择
function handleMapSearchSelect(entityId, mapMarkersById, map) {
  console.log(`🔍 地图搜索选择实体 ID: ${entityId}`);
  
  const marker = mapMarkersById.get(entityId);
  if (marker && map) {
    // 清除之前的高亮
    mapMarkersById.forEach((m) => {
      if (m._icon) {
        m._icon.style.filter = '';
        m._icon.style.transform = '';
        m._icon.style.zIndex = '';
      }
    });
    
    // 若标记当前未渲染在地图（可能因为被筛掉），确保强制加入地图并置顶
    if (!map.hasLayer(marker)) {
      marker.addTo(map);
    }
    if (marker.bringToFront) marker.bringToFront();

    // 高亮选中的标记（CircleMarker _path 也可作 _icon 使用）
    const iconEl = marker._icon || marker._path;
    if (iconEl) {
      iconEl.style.filter = 'drop-shadow(0 0 10px #ffd700) drop-shadow(0 0 20px #ffd700)';
      iconEl.style.transform = 'scale(1.5)';
      iconEl.style.zIndex = '1000';
    }
    
    // 聚焦到标记位置
    map.setView(marker.getLatLng(), Math.max(map.getZoom(), 12), {
      animate: true,
      duration: 1.0
    });
    
    // 打开弹窗并微调视图，使弹窗偏上居中
    if (marker.getPopup()) {
      marker.openPopup();
      // 延迟一点等 DOM 渲染完成再偏移
      setTimeout(() => {
        const popupEl = marker.getPopup().getElement();
        const popupHeight = popupEl ? popupEl.offsetHeight : 120;
        // 若希望弹窗不遮挡点位，可自行调整 panBy；当前按用户需求保持点位置于屏幕中心
        // map.panBy([0, -popupHeight / 2], { animate: true, duration: 0.4 });
      }, 50);
    }
    
    // 关闭搜索结果
    const searchResults = document.getElementById('search-results');
    const hotItems = document.getElementById('hot-items');
    const searchInput = document.getElementById('search-input');
    if (searchResults) searchResults.classList.add('hidden');
    if (hotItems) hotItems.classList.add('hidden');
    if (searchInput) searchInput.value = '';
  } else {
    console.warn(`未找到 ID 为 ${entityId} 的地图标记`);
  }
}




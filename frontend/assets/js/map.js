import { fetchCulturalEntities, normalizeDynasty, normalizeType, mapSources } from './data.js';
import { initSearch } from './search.js';
import { setupMapSearch } from './map-search.js';

// --- 工具函数：带超时的fetch ---
async function fetchWithTimeout(url, options = {}, timeout = 15000) {
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

// --- 全局变量 ---
let map;
// 供 IP 详情页使用的独立地图实例，避免与主地图冲突
let detailMap = null;
let mapData = [];
let layers = {
    base: null,
    heat: null,
    cluster: null,
    route: null,    // 存储路线 LayerGroup
    measure: L.layerGroup(),
    aiLayer: L.layerGroup(),
    overlay: null,  // 历史地图 Overlay
    analysisLayer: null, // 存储缓冲区/边界等分析图层
    markers: L.layerGroup(), // 基础标记层 (虽然目前主要用 dynastyGroups，保留以备用)
    dynastyGroups: {} // 按朝代分组
};
let isDarkTheme = true;
let mapMarkersById = new Map(); // 存储标记的 Map，key 为 entity id，用于搜索功能
// 高德地图 Key (演示用)
const AMAP_KEY = '4d1b8e5edc802741fcbeebc77c9a6d3f';
// --- 初始化入口 ---
export async function initMapPage() {
    if (!document.getElementById('main-map')) return;

    // 1. 初始化地图
    initLeaflet();
    //初始化多点测量工具
    initMultiPointMeasure();
    initAIAssistant(); 
    
    // 2. 初始化各个面板的事件监听
    initOverlayControl();
    initRoutePlanner();
    initAnalysisTools();

    // 3. 初始化搜索功能（供地图和搜索栏使用）
    await initSearch();
    
    // 4. 加载数据并渲染地图
    try {
        const rawData = await fetchCulturalEntities();
        
        // ================== 器物坐标补全逻辑 ==================
        const placeCoordMap = {};
        rawData.forEach(item => {
            if (item.type === 'place' &&  item.name  && item.lat && item.lng) {
                placeCoordMap[item.name] = { lat: item.lat, lng: item.lng };
            }
        });
        rawData.forEach(item => {
            if (item.type === 'artifact' && (!item.lat || !item.lng) && item.discovered_at) {
                const coords = placeCoordMap[item.discovered_at];
                if (coords) {
                    item.lat = coords.lat;
                    item.lng = coords.lng;
                }
            }
        });
        // ================== 修改结束 ==================

        // 4. 过滤有效数据
        mapData = rawData.filter(item => item.lat && item.lng);
        console.log(`✅ 地图数据加载成功: ${mapData.length} 条`);
        
        // 5. 渲染图层与更新UI
        initLayerManager(); // 生成图层复选框
        renderMarkers();    // 在地图上画点
        updateRouteInputs(); // 填充下拉框

        // 6. 初始化地图搜索功能（需要在标记创建完成后）
        setupMapSearch(mapMarkersById, map);

        // 【关键修复】：数据加载完后，立即刷新多点测量下拉框
        if (window.updateMeasureSelect) {
            window.updateMeasureSelect();
        }

    } catch (error) {
        console.error('❌ 数据加载失败:', error);
    }
}

// --- Dock 面板控制系统 ---
export function initDockSystem() {
    const dockBtns = document.querySelectorAll('.dock-btn[data-target]');
    
    dockBtns.forEach(btn => {
        btn.onclick = () => {
            const targetId = btn.dataset.target;
            const targetPanel = document.getElementById(targetId);
            if (!targetPanel) return;
            
            const isHidden = targetPanel.classList.contains('hidden');
            if (isHidden) {
                targetPanel.classList.remove('hidden');
                btn.classList.add('active');
            } else {
                targetPanel.classList.add('hidden');
                btn.classList.remove('active');
            }
        };
    });
}

// ================= IP 详情页地图 =================
// 轻量版初始化，不依赖主地图的全局状态
export function initMap(containerId, lat, lng, popupText) {
    if (!containerId || lat == null || lng == null) return;

    // 如果已存在详情地图，先销毁
    if (detailMap) {
        detailMap.remove();
        detailMap = null;
    }

    detailMap = L.map(containerId, {
        zoomControl: false,
        attributionControl: false
    }).setView([lat, lng], 13);

    // 使用深色瓦片，保持与站点风格一致
    L.tileLayer(mapSources.dark, { maxZoom: 19, subdomains: 'abcd' }).addTo(detailMap);

    const marker = L.marker([lat, lng]).addTo(detailMap);
    if (popupText) {
        marker.bindPopup(`<b>${popupText}</b>`).openPopup();
    }

    // 修正容器尺寸
    setTimeout(() => detailMap.invalidateSize(), 100);
}

function initLeaflet() {
    if (map) map.remove();

    map = L.map('main-map', {
        zoomControl: false,
        attributionControl: false
    }).setView([34.3416, 108.9398], 5); // 默认西安

    layers.base = L.tileLayer(mapSources.dark, { maxZoom: 18, subdomains: 'abcd' }).addTo(map);
    L.control.scale({ position: 'bottomright' }).addTo(map);
    setTimeout(() => map.invalidateSize(), 200);
}

// ================= [面板 1] 图层管理 =================
function initLayerManager() {
    const dynastyColors = { 
        '唐代': '#FFD700', '宋代': '#00FFFF', '元代': '#FFFFFF', 
        '明代': '#FF4500', '清代': '#9932CC', '其他': '#CCCCCC' 
    };
    const types = ['site', 'person', 'event', 'artifact'];

    // --- 1. 生成朝代图层控件 ---
    const dynContainer = document.getElementById('layer-control-dynasty');
    if (dynContainer) {
        dynContainer.innerHTML = '';
        const dynKeys = Object.keys(dynastyColors);
        const dynInputs = []; 

        // A. 创建【全选】主控件
        createCheckbox(dynContainer, '全选 / 取消', true, (checked) => {
            dynInputs.forEach(input => input.checked = checked);
            dynKeys.forEach(k => {
                if (checked) {
                    if (!map.hasLayer(layers.dynastyGroups[k])) map.addLayer(layers.dynastyGroups[k]);
                } else {
                    if (map.hasLayer(layers.dynastyGroups[k])) map.removeLayer(layers.dynastyGroups[k]);
                }
            });
        }, null, null, true);

        // 分割线
        const hr = document.createElement('div');
        hr.className = 'h-px bg-gray-700 my-2 mx-1';
        dynContainer.appendChild(hr);

        // B. 创建子控件
        dynKeys.forEach(k => {
            if (!layers.dynastyGroups[k]) {
                layers.dynastyGroups[k] = L.layerGroup().addTo(map);
            }
            // 注意：这里传入 k 作为 rawType，方便后续筛选
            const input = createCheckbox(dynContainer, k, true, (checked) => {
                if(checked) map.addLayer(layers.dynastyGroups[k]);
                else map.removeLayer(layers.dynastyGroups[k]);
            }, dynastyColors[k], k); 
            
            dynInputs.push(input);
        });
    }

    // --- 2. 生成类型图层控件 ---
    const typeContainer = document.getElementById('layer-control-type');
    if (typeContainer) {
        typeContainer.innerHTML = '';
        const typeInputs = [];

        // A. 创建【全选】主控件
        createCheckbox(typeContainer, '全选 / 取消', true, (checked) => {
            typeInputs.forEach(input => input.checked = checked);
            renderMarkers();
        }, null, null, true);

        // 分割线
        const hr = document.createElement('div');
        hr.className = 'h-px bg-gray-700 my-2 mx-1';
        typeContainer.appendChild(hr);

        // B. 创建子控件
        types.forEach(t => {
            const labelMap = { 'site': '遗址', 'person': '人物', 'event': '事件', 'artifact': '器物' };
            const input = createCheckbox(typeContainer, labelMap[t] || t, true, (checked) => {
                renderMarkers(); 
            }, null, t); 
            
            typeInputs.push(input);
        });
    }
}

function renderMarkers() {
    // 1. 获取当前选中的类型
    const activeTypes = Array.from(document.querySelectorAll('#layer-control-type input:checked:not([data-is-master="true"])'))
        .map(i => i.dataset.rawType);
    
    // 2. 清空当前图层和标记映射
    Object.values(layers.dynastyGroups).forEach(g => g.clearLayers());
    mapMarkersById.clear(); // 清空标记映射，避免旧引用

    // 3. 重新分配
    mapData.forEach(item => {
        if (!activeTypes.includes(item.type)) return;

        const dyn = normalizeDynasty(item.dynasty);
        const color = getDynastyColor(dyn);
        
        const marker = L.circleMarker([item.lat, item.lng], {
            color: color, fillColor: color, fillOpacity: 0.8, radius: 5, weight: 1
        });

        // 关键：给 circleMarker 补一个 _icon（模拟 marker DOM），让搜索高亮/聚焦逻辑生效
        // Leaflet 的 CircleMarker 默认没有 _icon，之前会导致 handleMapSearchSelect 无法正确处理选中态
        marker.on('add', () => {
            const p = marker._path;
            if (p) marker._icon = p;
        });

        marker.bindPopup(`
            <div class="text-gray-900 w-[160px]">
                <div class="font-bold text-lg border-b border-gray-300 pb-1 mb-2">${item.name}</div>
                <div class="text-xs text-gray-600">类型: ${normalizeType(item.type)}</div>
                <div class="text-xs text-gray-600 mb-2">朝代: ${dyn}</div>
                <button onclick="window.openIPDetail('${item.id}')" 
                    class="bg-blue-600 text-white text-xs w-full py-1.5 rounded-md font-semibold hover:bg-blue-700 mt-2">
                    查看详情
                </button>
            </div>
        `);

        // 存储标记到映射中，用于搜索功能
        mapMarkersById.set(item.id, marker);

        if (layers.dynastyGroups[dyn]) layers.dynastyGroups[dyn].addLayer(marker);
        else if (layers.dynastyGroups['其他']) layers.dynastyGroups['其他'].addLayer(marker);
    });
}

function createCheckbox(container, label, checked, onChange, color, rawType, isMaster = false) {
    const div = document.createElement('div');
    div.className = `flex items-center gap-2 mb-1 ${isMaster ? 'font-bold text-yellow-500 pb-1' : ''}`;
    
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.className = 'accent-yellow-500 cursor-pointer';
    
    // 明确标记 Master 状态，防止 CSS 类名变动导致选择器失效
    if (isMaster) {
        input.classList.add('w-4', 'h-4'); 
        input.dataset.isMaster = "true";
    }
    
    if(rawType) input.dataset.rawType = rawType;
    input.onchange = (e) => onChange(e.target.checked);

    const span = document.createElement('span');
    span.className = `text-xs cursor-pointer select-none ${isMaster ? 'text-yellow-100' : 'text-gray-300'}`;
    span.innerText = label;
    span.onclick = () => { input.checked = !input.checked; onChange(input.checked); };

    if (color) {
        const dot = document.createElement('span');
        dot.className = 'w-2 h-2 rounded-full inline-block mr-1';
        dot.style.backgroundColor = color;
        div.appendChild(dot);
    }
    
    div.prepend(input);
    div.appendChild(span);
    container.appendChild(div);

    return input;
}

// ================= [面板 2] 历史舆图 =================
// ================= [面板 2] 历史舆图 (GitHub 在线矢量版) =================
function initOverlayControl() {
    // 1. 地图数据配置
    const overlayMaps = {
        // ============================================================
        // --- 组 1: 高清扫描舆图 (Raster) - 您的定制数据 ---
        // ============================================================
        'qin': { 
            group: 'raster', 
            name: '秦朝 (前210年)', 
            desc: '秦始皇三十七年 | 扫描版', 
            type: 'image', 
            url: '../assets/images/qin.jpg', 
            bounds: [[18.0, 90.0], [42.0, 125.0]] 
        },
        'sanguo': { 
            group: 'raster', 
            name: '三国 (262年)', 
            desc: '魏景元3年/蜀汉景耀5年/吴永安5年', 
            type: 'image', 
            url: '../assets/images/sanguo.jpg', 
            bounds: [[18.0, 90.0], [42.0, 125.0]] 
        },
        'tang': { 
            group: 'raster', 
            name: '唐朝 (741年)', 
            desc: '开元二十九年 | 扫描版', 
            type: 'image', 
            url: '../assets/images/tang.jpg', 
            bounds: [[15.0, 70.0], [55.0, 135.0]] 
        },
        'nsong': { 
            group: 'raster', 
            name: '北宋 (1111年)', 
            desc: '政和元年 | 扫描版', 
            type: 'image', 
            url: '../assets/images/nsong.jpg', 
            bounds: [[18.0, 90.0], [45.0, 125.0]] 
        },
        'ssong': { 
            group: 'raster', 
            name: '南宋 (1142年)', 
            desc: '绍兴十二年 | 扫描版', 
            type: 'image', 
            url: '../assets/images/ssong.jpg', 
            bounds: [[18.0, 90.0], [45.0, 125.0]] 
        },
        'yuan': { 
            group: 'raster', 
            name: '元朝 (1330年)', 
            desc: '至顺元年 | 扫描版', 
            type: 'image', 
            url: '../assets/images/yuan.jpg', 
            bounds: [[10.0, 60.0], [65.0, 145.0]] 
        },
        'ming': { 
            group: 'raster', 
            name: '明朝 (1433年)', 
            desc: '宣德八年 | 扫描版', 
            type: 'image', 
            url: '../assets/images/ming.jpg', 
            bounds: [[15.0, 80.0], [50.0, 135.0]] 
        },
        'qing': { 
            group: 'raster', 
            name: '清朝 (1908年)', 
            desc: '光绪三十四年 | 扫描版', 
            type: 'image', 
            url: '../assets/images/qing.jpg', 
            bounds: [[15.0, 70.0], [55.0, 140.0]] 
        },

        // ============================================================
        // --- 组 2: 世界历史疆域 (Vector) - 矢量扩增 ---
        // ============================================================
        
        // --- 明代对应 (1600年) ---
        'v1600': { 
            group: 'vector', 
            name: '1600年 (明·万历)', 
            desc: '明末世界形势 | 矢量交互', 
            type: 'vector', 
            url: 'https://raw.githubusercontent.com/aourednik/historical-basemaps/master/geojson/world_1600.geojson' 
        },
        
        // --- 清代对应 (1700, 1783, 1900) ---
        'v1700': { 
            group: 'vector', 
            name: '1700年 (清·康熙)', 
            desc: '清初世界形势 | 矢量交互', 
            type: 'vector', 
            url: 'https://raw.githubusercontent.com/aourednik/historical-basemaps/master/geojson/world_1700.geojson' 
        },
        'v1783': { 
            group: 'vector', 
            name: '1783年 (清·乾隆)', 
            desc: '清全盛时期 | 矢量交互', 
            type: 'vector', 
            url: 'https://raw.githubusercontent.com/aourednik/historical-basemaps/master/geojson/world_1783.geojson' 
        },
        'v1900': { 
            group: 'vector', 
            name: '1900年 (清·光绪)', 
            desc: '八国联军时期 | 矢量交互', 
            type: 'vector', 
            url: 'https://raw.githubusercontent.com/aourednik/historical-basemaps/master/geojson/world_1900.geojson' 
        },

        // --- 近现代对应 ---
        'v1914': { 
            group: 'vector', 
            name: '1914年 (民国初年)', 
            desc: '一战前夕 | 矢量交互', 
            type: 'vector', 
            url: 'https://raw.githubusercontent.com/aourednik/historical-basemaps/master/geojson/world_1914.geojson' 
        },
        'v1945': { 
            group: 'vector', 
            name: '1945年 (二战结束)', 
            desc: '战后新秩序 | 矢量交互', 
            type: 'vector', 
            url: 'https://raw.githubusercontent.com/aourednik/historical-basemaps/master/geojson/world_1945.geojson' 
        },
        'v1994': { 
            group: 'vector', 
            name: '1994年 (现代格局)', 
            desc: '现代世界 | 矢量交互', 
            type: 'vector', 
            url: 'https://raw.githubusercontent.com/aourednik/historical-basemaps/master/geojson/world_1994.geojson' 
        }
    };

    // DOM 元素引用
    const listContainer = document.getElementById('overlay-list');
    const opacitySlider = document.getElementById('overlay-opacity');
    const opacityVal = document.getElementById('overlay-opacity-val');
    const toolsPanel = document.getElementById('geo-ref-tools'); // 仅 Raster 显示工具
    const loadingEl = document.getElementById('vector-loading'); // 矢量加载 Loading
    const dragBtn = document.getElementById('btn-toggle-drag');
    const resetBtn = document.getElementById('btn-reset-pos');

    // 状态变量
    let currentKey = null;
    let vectorCache = {}; // 内存缓存
    let isDragMode = false;

    // --- UI 构建函数 ---
    const buildUI = () => {
        if (!listContainer) return;
        listContainer.innerHTML = '';

        // 1. "不显示" 选项
        const noneDiv = document.createElement('div');
        noneDiv.className = 'flex items-center gap-2 cursor-pointer p-2 rounded hover:bg-white/5 transition mb-2';
        noneDiv.innerHTML = `
            <input type="radio" name="hist-map-select" value="none" id="map-opt-none" class="accent-yellow-500 cursor-pointer" checked>
            <label for="map-opt-none" class="text-xs text-gray-300 cursor-pointer flex-1 select-none font-bold">不显示叠加层</label>
        `;
        listContainer.appendChild(noneDiv);

        // 2. 辅助函数：创建分组标题
        const createHeader = (text) => {
            const h = document.createElement('div');
            h.className = 'text-[10px] text-gray-500 font-tech mt-4 mb-1 tracking-widest border-b border-gray-700 pb-1 sticky top-0 bg-[#0a0c12] z-10';
            h.innerText = text;
            listContainer.appendChild(h);
        };

        // 3. 渲染 Raster 组
        createHeader('高清扫描舆图 (支持配准)');
        Object.keys(overlayMaps).filter(k => overlayMaps[k].group === 'raster').forEach(key => createItem(key));

        // 4. 渲染 Vector 组
        createHeader('世界历史疆域 (矢量交互)');
        Object.keys(overlayMaps).filter(k => overlayMaps[k].group === 'vector').forEach(key => createItem(key));
    };

    const createItem = (key) => {
        const config = overlayMaps[key];
        const div = document.createElement('div');
        div.className = 'flex items-center gap-2 cursor-pointer p-2 rounded hover:bg-white/5 transition border-b border-white/5 pb-1';
        
        const icon = config.type === 'vector' 
            ? '<i class="fas fa-globe-asia text-blue-400 text-xs" title="矢量地图"></i>' 
            : '<i class="fas fa-scroll text-yellow-500 text-xs" title="扫描地图"></i>';
        
        div.innerHTML = `
            <input type="radio" name="hist-map-select" value="${key}" id="map-opt-${key}" class="accent-yellow-500 cursor-pointer mt-1 self-start">
            <div class="flex-1 cursor-pointer ml-1">
                <div class="flex justify-between items-center">
                    <label for="map-opt-${key}" class="text-xs text-gray-200 block font-bold cursor-pointer select-none">${config.name}</label>
                    ${icon}
                </div>
                <span class="text-[10px] text-gray-500 block font-serif-sc mt-0.5 leading-tight opacity-70">${config.desc}</span>
            </div>
        `;
        listContainer.appendChild(div);
    };

    // --- 核心逻辑：切换地图 ---
    const switchLayer = async (key) => {
        // 清理旧状态
        if (layers.overlay) {
            map.removeLayer(layers.overlay);
            layers.overlay = null;
        }
        disableDragMode();
        if (toolsPanel) toolsPanel.classList.add('hidden');
        if (loadingEl) loadingEl.classList.add('hidden');

        if (key === 'none') {
            currentKey = null;
            return;
        }

        const config = overlayMaps[key];
        currentKey = key;
        const currentOpacity = opacitySlider ? parseFloat(opacitySlider.value) : 0.5;

        if (config.type === 'image') {
            // === Raster ===
            layers.overlay = L.imageOverlay(config.url, config.bounds, {
                opacity: currentOpacity,
                interactive: true,
                zIndex: 2
            }).addTo(map);

            map.flyToBounds(config.bounds, { padding: [20, 20], duration: 1.0 });
            if (toolsPanel) toolsPanel.classList.remove('hidden');

        } else if (config.type === 'vector') {
            // === Vector ===
            await loadVectorLayer(config, currentOpacity);
        }
    };

    // --- 辅助：加载矢量数据 ---
    const loadVectorLayer = async (config, opacity) => {
        if (loadingEl) loadingEl.classList.remove('hidden');

        try {
            let data;
            if (vectorCache[config.url]) {
                data = vectorCache[config.url];
            } else {
                const res = await fetchWithTimeout(config.url, {}, 20000);  
                if (!res.ok) throw new Error('网络请求失败');
                data = await res.json();
                vectorCache[config.url] = data;
            }

            layers.overlay = L.geoJSON(data, {
                style: {
                    color: '#60a5fa',       // 边框亮蓝
                    weight: 1,
                    opacity: 0.8,
                    fillColor: '#60a5fa',   // 填充蓝
                    fillOpacity: opacity * 0.4 
                },
                onEachFeature: (feature, layer) => {
                    layer.on({
                        mouseover: (e) => {
                            const l = e.target;
                            l.setStyle({ weight: 2, color: '#fbbf24', fillOpacity: 0.6 });
                            l.bringToFront();
                        },
                        mouseout: (e) => {
                            layers.overlay.resetStyle(e.target);
                        }
                    });
                    const name = feature.properties.NAME || feature.properties.name || feature.properties.sovereignt || 'Unknown';
                    layer.bindPopup(`<b class="text-black">${name}</b>`, { closeButton: false });
                }
            }).addTo(map);

            if (loadingEl) loadingEl.classList.add('hidden');
            // 矢量不强制飞动，保持当前视图，方便对比
            
        } catch (error) {
            console.error("Vector load failed:", error);
            if (loadingEl) {
                const errorMsg = error.message && error.message.includes('超时') 
                    ? "加载超时，请检查网络连接" 
                    : "加载失败，请重试";
                loadingEl.innerText = errorMsg;
                loadingEl.classList.add('text-red-500');
            }
        }
    };

    // --- 初始化 UI ---
    buildUI();

    // --- 事件监听 ---
    const listDiv = document.getElementById('overlay-list');
    listDiv.addEventListener('change', (e) => {
        if (e.target.name === 'hist-map-select') {
            switchLayer(e.target.value);
        }
    });

    if (opacitySlider) {
        opacitySlider.oninput = (e) => {
            const val = parseFloat(e.target.value);
            if (opacityVal) opacityVal.innerText = Math.round(val * 100) + '%';
            
            if (layers.overlay) {
                if (layers.overlay.setOpacity) {
                    layers.overlay.setOpacity(val);
                } else if (layers.overlay.setStyle) {
                    layers.overlay.setStyle({ fillOpacity: val * 0.4 });
                }
            }
        };
    }

    if (resetBtn) {
        resetBtn.onclick = () => {
            if (!currentKey || overlayMaps[currentKey].type !== 'image' || !layers.overlay) return;
            const originalBounds = overlayMaps[currentKey].bounds;
            layers.overlay.setBounds(originalBounds);
            map.flyToBounds(originalBounds, { padding: [20, 20], duration: 0.8 });
            if (isDragMode) disableDragMode();
        };
    }

    // --- 拖拽模式 (仅图片) ---
    let dragStartLatLng = null;
    let dragStartBounds = null;

    if (dragBtn) {
        dragBtn.onclick = () => {
            if (!layers.overlay || !currentKey || overlayMaps[currentKey].type !== 'image') {
                return;
            }
            isDragMode ? disableDragMode() : enableDragMode();
        };
    }

    function enableDragMode() {
        isDragMode = true;
        map.dragging.disable();
        document.getElementById('main-map').style.cursor = 'move';
        dragBtn.classList.add('active-state');
        dragBtn.querySelector('span').innerText = "完成调整";
        map.on('mousedown', onDragStart);
    }

    function disableDragMode() {
        isDragMode = false;
        map.dragging.enable();
        document.getElementById('main-map').style.cursor = '';
        dragBtn.classList.remove('active-state');
        dragBtn.querySelector('span').innerText = "开启图片拖动模式";
        map.off('mousedown', onDragStart);
        map.off('mousemove', onDragMove);
        map.off('mouseup', onDragEnd);
    }

    function onDragStart(e) {
        if (!isDragMode || !layers.overlay) return;
        dragStartLatLng = e.latlng;
        dragStartBounds = layers.overlay.getBounds();
        map.on('mousemove', onDragMove);
        map.on('mouseup', onDragEnd);
        L.DomEvent.stop(e);
    }

    function onDragMove(e) {
        if (!isDragMode || !dragStartLatLng || !dragStartBounds) return;
        const latDelta = e.latlng.lat - dragStartLatLng.lat;
        const lngDelta = e.latlng.lng - dragStartLatLng.lng;
        const newSw = L.latLng(dragStartBounds.getSouth() + latDelta, dragStartBounds.getWest() + lngDelta);
        const newNe = L.latLng(dragStartBounds.getNorth() + latDelta, dragStartBounds.getEast() + lngDelta);
        layers.overlay.setBounds(L.latLngBounds(newSw, newNe));
    }

    function onDragEnd() {
        map.off('mousemove', onDragMove);
        map.off('mouseup', onDragEnd);
        dragStartLatLng = null;
        dragStartBounds = null;
    }
}

// ================= [辅助工具] =================

window.adjustOverlay = (action, value) => {
    if (!layers.overlay) return;

    const bounds = layers.overlay.getBounds();
    const center = bounds.getCenter();

    // --- 缩放操作 ---
    if (action === 'scale') {
        const south = bounds.getSouth();
        const west = bounds.getWest();
        const north = bounds.getNorth();
        const east = bounds.getEast();

        const latSpan = (north - south) / 2;
        const lngSpan = (east - west) / 2;

        // 基于中心点计算新边界
        const newLatSpan = latSpan * value;
        const newLngSpan = lngSpan * value;

        const newBounds = [
            [center.lat - newLatSpan, center.lng - newLngSpan],
            [center.lat + newLatSpan, center.lng + newLngSpan]
        ];
        
        layers.overlay.setBounds(newBounds);
    }
    
    // reset 操作现在已移至 initOverlayControl 内部的按钮事件中
};

// 全局暴露：输出坐标 (保存用)
window.logOverlayBounds = () => {
    if (!layers.overlay) return alert("未选择图层");
    const b = layers.overlay.getBounds();
    
    const south = b.getSouth().toFixed(4);
    const west = b.getWest().toFixed(4);
    const north = b.getNorth().toFixed(4);
    const east = b.getEast().toFixed(4);

    console.log(`%c[配准数据]`, 'color: yellow; font-size: 14px;');
    console.log(`bounds: [[${south}, ${west}], [${north}, ${east}]],`);
    
    alert(`坐标已输出到控制台(F12)！\nBounds: [[${south}, ${west}], [${north}, ${east}]]`);
};

// ================= [面板 3] 智能路线 (UI优化版) =================
function initRoutePlanner() {
    const routePanel = document.getElementById('panel-route');
    if (!routePanel) return;

    // --- 1. 重构按钮组 (美化版) ---
    const modeGrid = routePanel.querySelector('.grid');
    if (modeGrid) {
        modeGrid.innerHTML = ''; 
        // 增加 gap-2 和 bg-black/40 让容器更精致
        modeGrid.className = 'grid grid-cols-4 gap-2 mb-4 p-1.5 bg-black/40 rounded-xl border border-white/5';

        const modes = [
            { id: 'linear', icon: 'ruler-horizontal', text: '直线' },
            { id: 'road', icon: 'car', text: '驾车' },
            { id: 'walking', icon: 'walking', text: '步行' },
            { id: 'bicycling', icon: 'bicycle', text: '骑行' }
        ];

        modes.forEach((m) => {
            const btn = document.createElement('button');
            // 基础样式：flex布局、过渡动画、点击缩放效果(active:scale-95)
            btn.className = `
                flex flex-col items-center justify-center py-2 rounded-lg 
                transition-all duration-200 ease-out 
                active:scale-95 text-[10px] group
            `;
            btn.dataset.routeMode = m.id;
            
            // 图标和文字结构
            btn.innerHTML = `
                <i class="fas fa-${m.icon} text-sm mb-1 transition-transform group-hover:-translate-y-0.5"></i>
                <span class="font-bold tracking-wider">${m.text}</span>
            `;
            modeGrid.appendChild(btn);
        });
    }

    // --- 2. 状态管理与事件绑定 ---
    const modeBtns = routePanel.querySelectorAll('[data-route-mode]');
    let currentMode = 'linear'; // 默认模式

    // 定义选中和未选中的样式类
    const updateButtonStyles = (targetMode) => {
        modeBtns.forEach(btn => {
            const isSelected = btn.dataset.routeMode === targetMode;
            
            if (isSelected) {
                // [选中状态]：高亮、蓝色背景、发光阴影、白色文字
                btn.className = `
                    flex flex-col items-center justify-center py-2 rounded-lg 
                    transition-all duration-200 ease-out active:scale-95 text-[10px] group
                    bg-gradient-to-br from-blue-600 to-blue-500 text-white 
                    shadow-lg shadow-blue-900/50 ring-1 ring-blue-400 scale-[1.02]
                `;
            } else {
                // [未选中状态]：透明背景、灰色文字、鼠标悬停微亮
                btn.className = `
                    flex flex-col items-center justify-center py-2 rounded-lg 
                    transition-all duration-200 ease-out active:scale-95 text-[10px] group
                    bg-transparent text-gray-500 hover:text-gray-200 hover:bg-white/5
                `;
            }
        });
    };

    // 初始化默认选中
    updateButtonStyles(currentMode);
    
    // 绑定点击事件
    modeBtns.forEach(btn => {
        btn.onclick = () => {
            currentMode = btn.dataset.routeMode;
            updateButtonStyles(currentMode); // 更新视觉状态
            
            // 切换输入框显示
            document.getElementById('route-manual-inputs').classList.remove('hidden');
            const aiInput = document.getElementById('route-ai-inputs');
            if(aiInput) aiInput.classList.add('hidden');

            // 切换模式时清除旧路线
            clearRoute();
        };
    });

    // --- 3. 绑定“开始导航”按钮 ---
    const calcBtn = document.getElementById('btn-calc-route');
    if(calcBtn) {
        calcBtn.onclick = async () => {
            clearRoute();

            const startId = document.getElementById('route-start').value;
            const endId = document.getElementById('route-end').value;

            if (!startId || !endId) return alert('请先选择【起点】和【终点】');
            if (startId === endId) return alert('起点和终点不能相同');
            
            const startItem = mapData.find(d => d.id == startId);
            const endItem = mapData.find(d => d.id == endId);

            if (!startItem || !endItem) return alert('无效的地点数据');

            if (currentMode === 'linear') {
                drawLinearRoute(startItem, endItem);
            } else {
                await drawSmartNavigationV2(startItem, endItem, currentMode);
            }
        };
    }
}

// 纯直线绘制 (无 API 请求)
function drawLinearRoute(start, end) {
    layers.route = L.polyline([[start.lat, start.lng], [end.lat, end.lng]], { 
        color: '#d4af37', 
        weight: 3,
        dashArray: '5, 10'
    }).addTo(map);
    
    map.fitBounds(layers.route.getBounds(), { padding: [80, 80] });
    
    // 计算直线距离
    const distMeters = map.distance([start.lat, start.lng], [end.lat, end.lng]);
    displayRouteStats(distMeters, null, '直线距离');
}

// 智能导航 V2 (API 请求)
async function drawSmartNavigationV2(start, end, mode) {
    // 1. 步行距离预检 (高德步行不支持 > 100km)
    if (mode === 'walking') {
        const directDist = map.distance([start.lat, start.lng], [end.lat, end.lng]);
        if (directDist > 100000) {
            alert('错误：步行导航仅支持 100公里 以内的行程。\n当前两点直线距离过远，建议切换为驾车模式。');
            return;
        }
    }

    // 2. 坐标转换
    const startGCJ = wgs84togcj02(start.lng, start.lat);
    const endGCJ = wgs84togcj02(end.lng, end.lat);

    // 3. 确定 API 参数
    let apiPath = 'direction/driving'; // 默认驾车
    let apiVersion = 'v3';
    
    if (mode === 'walking') apiPath = 'direction/walking';
    else if (mode === 'bicycling') {
        apiPath = 'direction/bicycling';
        apiVersion = 'v4';
    }

    const url = `https://restapi.amap.com/${apiVersion}/${apiPath}?origin=${startGCJ[0]},${startGCJ[1]}&destination=${endGCJ[0]},${endGCJ[1]}&key=${AMAP_KEY}`;

    // 4. 发起请求
    try {
        const res = await fetchWithTimeout(url, {}, 15000);
        
        // 检查 HTTP 状态
        if (!res.ok) {
            throw new Error(`HTTP Error: ${res.status}`);
        }

        const data = await res.json();

        // 5. 检查业务状态
        // v3 使用 status '1', v4 使用 errcode 0
        const isSuccess = (data.status === '1') || (data.errcode === 0);

        if (isSuccess) {
            let paths = [];
            if (data.route && data.route.paths) paths = data.route.paths; // v3 结构
            else if (data.data && data.data.paths) paths = data.data.paths; // v4 结构

            if (paths && paths.length > 0) {
                const routeData = paths[0];
                
                // --- 绘制路线 ---
                const pathCoords = routeData.steps.flatMap(step => 
                    step.polyline.split(';').map(p => {
                        const [lng, lat] = p.split(',');
                        const wgs = gcj02towgs84(parseFloat(lng), parseFloat(lat));
                        return [wgs[1], wgs[0]];
                    })
                );

                const colorMap = { 'road': '#00f3ff', 'walking': '#10b981', 'bicycling': '#f59e0b' };
                layers.route = L.polyline(pathCoords, { 
                    color: colorMap[mode] || '#00f3ff', 
                    weight: 6,
                    opacity: 0.9,
                    lineCap: 'round'
                }).addTo(map);

                map.fitBounds(layers.route.getBounds(), { padding: [50, 50] });

                // --- 显示距离和时间 (修复问题2) ---
                const distance = parseInt(routeData.distance || 0);
                const duration = parseInt(routeData.duration || 0); // 秒
                displayRouteStats(distance, duration, getModeName(mode));

            } else {
                alert(`未找到有效路线 (${getModeName(mode)})，请尝试其他方式。`);
            }
        } else {
            console.error("API Error Info:", data.info);
            alert(`路线规划失败: ${data.info || '未知错误'}\n请检查 Key 是否开通了【Web服务】权限。`);
        }
    } catch (e) {
        console.error("Nav Error:", e);
        // 明确提示是网络/Key问题
        const errorMsg = e.message && e.message.includes('超时')
            ? `请求超时。\n1. 请检查网络连接。\n2. 高德地图API可能响应较慢，请稍后重试。`
            : `网络请求失败。\n1. 请检查网络连接。\n2. 请确认 AMAP_KEY 是【Web服务】类型。\n3. 浏览器可能拦截了跨域请求(CORS)。`;
        alert(errorMsg);
    }
}

// 辅助：显示统计面板 (修复问题2：自动下拉并显示)
function displayRouteStats(distanceMeters, durationSeconds, modeName) {
    const statsContainer = document.getElementById('route-stats');
    if (!statsContainer) return;

    // 格式化数据
    let distStr = '';
    if (distanceMeters >= 1000) {
        distStr = (distanceMeters / 1000).toFixed(1) + ' <span class="text-xs">公里</span>';
    } else {
        distStr = distanceMeters + ' <span class="text-xs">米</span>';
    }

    let timeStr = '';
    if (durationSeconds) {
        const h = Math.floor(durationSeconds / 3600);
        const m = Math.floor((durationSeconds % 3600) / 60);
        if (h > 0) timeStr = `${h}小时 ${m}分钟`;
        else timeStr = `${m}分钟`;
    }

    // 注入 HTML
    statsContainer.innerHTML = `
        <div class="flex justify-between items-end border-b border-white/10 pb-2 mb-2">
            <span class="text-gray-400 text-xs">${modeName}方案</span>
            <span class="text-yellow-500 font-bold text-lg font-mono">${distStr}</span>
        </div>
        ${durationSeconds ? `
        <div class="flex justify-between items-center text-xs text-gray-300">
            <span>预计耗时</span>
            <span class="text-white font-bold">${timeStr}</span>
        </div>
        ` : ''}
    `;

    // 移除 hidden 类，显示面板
    statsContainer.classList.remove('hidden');
}

function getModeName(mode) {
    const map = { 'road': '驾车', 'walking': '步行', 'bicycling': '骑行', 'linear': '直线' };
    return map[mode] || mode;
}

function clearRoute() {
    if (layers.route) map.removeLayer(layers.route);
    // 隐藏统计面板
    const stats = document.getElementById('route-stats');
    if(stats) stats.classList.add('hidden');
}
// 更新路线规划的下拉框（带地点后缀）
function updateRouteInputs() {
    const start = document.getElementById('route-start');
    const end = document.getElementById('route-end');
    if(!start) return;
    
    // 重置选项
    start.innerHTML = end.innerHTML = '<option value="">请选择地点...</option>';
    
    // 按中文拼音排序
    const sorted = [...mapData].sort((a,b) => a.name.localeCompare(b.name, 'zh'));
    
    sorted.forEach(d => {
        let placeSuffix = '';
        
        // 根据实体类型，从 detail 中提取具体的地点名称
        if (d.detail) {
            switch (d.type) {
                case 'person':
                    // 人物 -> 出生地
                    placeSuffix = d.detail.birth_place_name;
                    break;
                case 'event':
                    // 事件 -> 发生地点
                    placeSuffix = d.detail.location_name;
                    break;
                case 'artifact':
                    // 器物 -> 出土地 或 现藏地
                    placeSuffix = d.detail.discovered_at || d.detail.preserved_at;
                    break;
                case 'site':
                    // 遗址 -> 现代地址
                    // 如果地址太长，可以考虑只取前几个字，这里暂时显示完整地址以便区分
                    placeSuffix = d.detail.address_modern;
                    break;
            }
        }
        
        // 构造显示文本，例如：秦观 （高邮）
        // 如果没有地点信息，则只显示名称
        const displayName = placeSuffix ? `${d.name}（${placeSuffix}）` : d.name;
        
        start.add(new Option(displayName, d.id));
        end.add(new Option(displayName, d.id));
    });
}

// ================= [核心逻辑更新] 获取当前筛选后的数据 =================
function getFilteredData() {
    // 1. 获取类型筛选 (排除 Master)
    const activeTypes = Array.from(document.querySelectorAll('#layer-control-type input:checked:not([data-is-master="true"])'))
        .map(i => i.dataset.rawType);

    // 2. 获取朝代筛选 (排除 Master)
    const activeDynasties = Array.from(document.querySelectorAll('#layer-control-dynasty input:checked:not([data-is-master="true"])'))
        .map(i => i.dataset.rawType);

    // 3. 开始筛选
    return mapData.filter(item => {
        // 类型匹配
        if (!activeTypes.includes(item.type)) return false;
        
        // 朝代匹配
        const itemDynasty = normalizeDynasty(item.dynasty);
        const standardDynasties = ['唐代', '宋代', '元代', '明代', '清代'];
        if (!standardDynasties.includes(itemDynasty)) {
            return activeDynasties.includes('其他');
        }
        return activeDynasties.includes(itemDynasty);
    });
}

// ================= [面板 4] 分析工具 =================
function initAnalysisTools() {
    const btnHeat = document.getElementById('btn-tool-heat');
    const btnCluster = document.getElementById('btn-tool-cluster');
    const btnBuffer = document.getElementById('btn-tool-buffer'); 
    const btnHull = document.getElementById('btn-tool-hull');    
    const btnReset = document.getElementById('btn-tool-reset');
    const inputRadius = document.getElementById('tool-buffer-radius');

    const prepareAnalysis = () => {
        clearTools();
        hideOriginalMarkers(); 
        const data = getFilteredData();
        if (data.length === 0) {
            alert("当前筛选条件下无数据，请先在图层管理中勾选显示内容。");
            showOriginalMarkers(); 
            return null;
        }
        return data;
    };

    if(btnHeat) btnHeat.onclick = () => {
        const data = prepareAnalysis();
        if (!data) return;
        
        const points = data.map(d => [d.lat, d.lng, 1]); 
        layers.heat = L.heatLayer(points, { radius: 25, blur: 15, maxZoom: 10 }).addTo(map);
        
        const group = L.featureGroup(data.map(d => L.marker([d.lat, d.lng])));
        map.fitBounds(group.getBounds());
    };

    if(btnCluster) btnCluster.onclick = () => {
        const data = prepareAnalysis();
        if (!data) return;

        layers.cluster = L.markerClusterGroup();
        data.forEach(d => {
            const dyn = normalizeDynasty(d.dynasty);
            const color = getDynastyColor(dyn);
            const m = L.circleMarker([d.lat, d.lng], { 
                color: color, fillColor: color, fillOpacity: 0.8, radius: 5, weight: 1 
            });
            m.bindPopup(`<b>${d.name}</b><br>${dyn} | ${d.type}`);
            layers.cluster.addLayer(m);
        });
        map.addLayer(layers.cluster);
        map.fitBounds(layers.cluster.getBounds());
    };

    // 3. 缓冲区分析 (Buffer Analysis) - 修改版：支持融合
    if(btnBuffer) btnBuffer.onclick = () => {
        // 检查 Turf.js 是否加载
        if (!window.turf) {
            alert("错误：Turf.js 库未加载，无法进行几何分析。请检查 HTML 文件。");
            return;
        }

        const data = prepareAnalysis();
        if (!data) return;

        const radiusKm = parseFloat(inputRadius.value) || 50;
        
        // 创建分析图层组
        layers.analysisLayer = L.featureGroup().addTo(map);

        try {
            // --- 步骤 A: 准备 Turf.js 数据 ---
            // 注意：Turf 使用 [lng, lat] (经度在前)，Leaflet 使用 [lat, lng]
            const turfPoints = data.map(d => turf.point([d.lng, d.lat]));
            const featureCollection = turf.featureCollection(turfPoints);

            // --- 步骤 B: 计算缓冲区 ---
            // turf.buffer 会返回一个 FeatureCollection (包含多个圆形 Polygon)
            const bufferedCollection = turf.buffer(featureCollection, radiusKm, { units: 'kilometers' });

            // --- 步骤 C: 融合相交的缓冲区 (Union) ---
            let mergedPolygon;

            if (bufferedCollection.features.length === 0) {
                return;
            } else if (bufferedCollection.features.length === 1) {
                // 如果只有一个缓冲区，直接使用，不需要融合
                mergedPolygon = bufferedCollection.features[0];
            } else {
                // 【修复点】：适配新版 Turf.js，直接传入 FeatureCollection 进行整体融合
                // 如果是旧版 turf (v6及以下)，union(a, b)；如果是新版 (v7+)，union(featureCollection)
                // 为了兼容性，我们先尝试传入集合
                try {
                     mergedPolygon = turf.union(bufferedCollection);
                } catch (unionError) {
                    // 如果新版写法失败（极少情况），回退到旧版两两合并逻辑
                    console.warn("Turf union fallback:", unionError);
                    mergedPolygon = bufferedCollection.features[0];
                    for (let i = 1; i < bufferedCollection.features.length; i++) {
                        mergedPolygon = turf.union(mergedPolygon, bufferedCollection.features[i]);
                    }
                }
            }

            // --- 步骤 D: 绘制融合后的多边形 ---
            // 清除旧图层
            if (layers.analysisLayer) {
                layers.analysisLayer.clearLayers();
            } else {
                layers.analysisLayer = L.featureGroup().addTo(map);
            }

            L.geoJSON(mergedPolygon, {
                style: {
                    color: '#3b82f6',       // 边框蓝色
                    weight: 2,
                    opacity: 1,
                    fillColor: '#3b82f6',   // 填充蓝色
                    fillOpacity: 0.2
                }
            }).addTo(layers.analysisLayer)
              .bindPopup(`<b>缓冲区融合范围</b><br>半径: ${radiusKm}km<br>包含 ${data.length} 个实体`);

            // --- 步骤 E: 绘制中心点 (保持视觉参考) ---
            data.forEach(d => {
                L.circleMarker([d.lat, d.lng], { 
                    color: '#fff', 
                    radius: 2, 
                    fillOpacity: 1 
                }).addTo(layers.analysisLayer)
                  .bindPopup(`<b>${d.name}</b><br>中心点位`);
            });

            // 缩放视图以适应缓冲区
            map.fitBounds(layers.analysisLayer.getBounds());
            
        } catch (e) {
            console.error("缓冲区分析错误:", e);
            alert("缓冲区计算出错，请检查控制台详情。可能是Turf版本兼容性问题。");
        }
    };
    if(btnHull) btnHull.onclick = () => {
        const data = prepareAnalysis();
        if (!data) return;

        if (data.length < 3) {
            alert("点位数量少于3个，无法计算边界范围。");
            showOriginalMarkers();
            return;
        }

        const points = data.map(d => ({ x: d.lat, y: d.lng }));
        const hullPoints = getConvexHull(points); 
        const polygonCoords = hullPoints.map(p => [p.x, p.y]);

        layers.analysisLayer = L.featureGroup().addTo(map);

        L.polygon(polygonCoords, {
            color: '#a855f7', 
            weight: 2,
            fillColor: '#a855f7',
            fillOpacity: 0.2,
            dashArray: '5, 5'
        }).addTo(layers.analysisLayer).bindPopup(`<b>分布范围边界</b><br>包含 ${data.length} 个实体`);

        data.forEach(d => {
             L.circleMarker([d.lat, d.lng], { color: '#a855f7', radius: 3, fillOpacity: 1 }).addTo(layers.analysisLayer);
        });

        map.fitBounds(layers.analysisLayer.getBounds(), { padding: [50, 50] });
    };

    if(btnReset) btnReset.onclick = () => {
        clearTools();
        clearRoute();
        showOriginalMarkers(); 
        map.flyTo([34.3416, 108.9398], 5);
    };
}

function clearTools() {
    if (layers.heat) {
        map.removeLayer(layers.heat);
        layers.heat = null;
    }
    if (layers.cluster) {
        map.removeLayer(layers.cluster);
        layers.cluster = null;
    }
    if (layers.analysisLayer) {
        map.removeLayer(layers.analysisLayer);
        layers.analysisLayer = null;
    }
}

// --- 补全的辅助函数 ---

function hideOriginalMarkers() {
    // 隐藏所有朝代分组的图层
    Object.values(layers.dynastyGroups).forEach(g => {
        if (map.hasLayer(g)) {
            map.removeLayer(g);
        }
    });
}

function showOriginalMarkers() {
    // 恢复原来的标记状态
    renderMarkers(); 
}

function getConvexHull(points) {
    points.sort((a, b) => a.x === b.x ? a.y - b.y : a.x - b.x);
    const crossProduct = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

    const lower = [];
    for (let point of points) {
        while (lower.length >= 2 && crossProduct(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
            lower.pop();
        }
        lower.push(point);
    }

    const upper = [];
    for (let point of points.reverse()) {
        while (upper.length >= 2 && crossProduct(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
            upper.pop();
        }
        upper.push(point);
    }

    return lower.concat(upper.slice(1, -1));
}

function getDynastyColor(dyn) {
    const map = { '唐代': '#FFD700', '宋代': '#00FFFF', '元代': '#FFFFFF', '明代': '#FF4500', '清代': '#9932CC' };
    return map[dyn] || '#CCCCCC';
}

export function toggleMapTheme() {
    isDarkTheme = !isDarkTheme;
    if (layers.base) map.removeLayer(layers.base);
    layers.base = L.tileLayer(isDarkTheme ? mapSources.dark : mapSources.light, { maxZoom: 18 }).addTo(map);
    layers.base.bringToBack();
    return isDarkTheme;
}

// 坐标转换
const PI = 3.1415926535897932384626;
const a = 6378245.0;
const ee = 0.00669342162296594323;

function transformLat(x, y) {
    let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(y * PI) + 40.0 * Math.sin(y / 3.0 * PI)) * 2.0 / 3.0;
    ret += (160.0 * Math.sin(y / 12.0 * PI) + 320 * Math.sin(y * PI / 30.0)) * 2.0 / 3.0;
    return ret;
}

function transformLon(x, y) {
    let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(x * PI) + 40.0 * Math.sin(x / 3.0 * PI)) * 2.0 / 3.0;
    ret += (150.0 * Math.sin(x / 12.0 * PI) + 300.0 * Math.sin(x / 30.0 * PI)) * 2.0 / 3.0;
    return ret;
}

// WGS84 转 GCJ02 (用于发送给高德)
function wgs84togcj02(lng, lat) {
    if (outOfChina(lng, lat)) return [lng, lat];
    let dLat = transformLat(lng - 105.0, lat - 35.0);
    let dLon = transformLon(lng - 105.0, lat - 35.0);
    const radLat = lat / 180.0 * PI;
    let magic = Math.sin(radLat);
    magic = 1 - ee * magic * magic;
    const sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / ((a * (1 - ee)) / (magic * sqrtMagic) * PI);
    dLon = (dLon * 180.0) / (a / sqrtMagic * Math.cos(radLat) * PI);
    return [lng + dLon, lat + dLat];
}

// GCJ02 转 WGS84 (用于将高德结果画回 Leaflet)
function gcj02towgs84(lng, lat) {
    if (outOfChina(lng, lat)) return [lng, lat];
    let dLat = transformLat(lng - 105.0, lat - 35.0);
    let dLon = transformLon(lng - 105.0, lat - 35.0);
    const radLat = lat / 180.0 * PI;
    let magic = Math.sin(radLat);
    magic = 1 - ee * magic * magic;
    const sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / ((a * (1 - ee)) / (magic * sqrtMagic) * PI);
    dLon = (dLon * 180.0) / (a / sqrtMagic * Math.cos(radLat) * PI);
    const mgLat = lat + dLat;
    const mgLng = lng + dLon;
    return [lng * 2 - mgLng, lat * 2 - mgLat];
}

function outOfChina(lng, lat) {
    // 简单的中国国境矩形判断
    return (lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271);
}

// ================= [新增面板] 多点连线测量 =================
// ================= [新增面板] 多点连线测量 (修复与优化版) =================
function initMultiPointMeasure() {
    // --- 1. 动态注入 Dock 按钮 ---
    const dockContainer = document.getElementById('map-dock');
    const routeBtn = dockContainer ? dockContainer.querySelector('[data-target="panel-route"]') : null;
    
    if (dockContainer && routeBtn && !document.getElementById('dock-btn-measure')) {
        const measureBtn = document.createElement('button');
        measureBtn.id = 'dock-btn-measure'; // 防止重复添加
        measureBtn.className = 'dock-btn';
        measureBtn.dataset.target = 'panel-measure';
        measureBtn.title = '多点测量';
        measureBtn.innerHTML = '<i class="fas fa-ruler-combined"></i>';
        
        routeBtn.after(measureBtn);
        
        measureBtn.onclick = () => {
            const targetId = measureBtn.dataset.target;
            const targetPanel = document.getElementById(targetId);
            if(!targetPanel) return;

            const isHidden = targetPanel.classList.contains('hidden');
            
            // 关闭其他面板
            document.querySelectorAll('.map-panel').forEach(p => p.classList.add('hidden'));
            document.querySelectorAll('.dock-btn').forEach(b => b.classList.remove('active'));

            if (isHidden) {
                targetPanel.classList.remove('hidden');
                measureBtn.classList.add('active');
                // 打开面板时再次尝试刷新，防止初始化时数据未就绪
                if(window.updateMeasureSelect) window.updateMeasureSelect();
            } else {
                targetPanel.classList.add('hidden');
                measureBtn.classList.remove('active');
            }
        };
    }

    // --- 2. 动态注入 面板 HTML ---
    const routePanel = document.getElementById('panel-route');
    
    if (routePanel && !document.getElementById('panel-measure')) {
        const panelHtml = `
            <div class="map-panel hidden" id="panel-measure">
                <div class="map-panel-header" onclick="this.parentElement.classList.toggle('collapsed')">
                    <span class="map-panel-title"><i class="fas fa-ruler-combined text-orange-400"></i>多点连线测量</span>
                    <i class="fas fa-chevron-down text-gray-500 transition-transform duration-300"></i>
                </div>
                <div class="map-panel-content">
                    <!-- 添加控制 -->
                    <div class="flex gap-2 mb-3">
                        <select id="measure-select" class="flex-1 bg-black/30 border border-white/10 rounded px-2 py-1.5 text-xs text-gray-300 outline-none focus:border-orange-500">
                            <option value="">正在加载数据...</option>
                        </select>
                        <button id="btn-measure-add" class="tech-btn px-3 py-1.5 text-xs text-orange-400 border border-orange-500/30 hover:bg-orange-500/10">
                            <i class="fas fa-plus"></i>
                        </button>
                    </div>

                    <!-- 节点列表 -->
                    <div class="text-[10px] text-gray-500 font-tech tracking-widest mb-2">测量节点序列</div>
                    <div id="measure-list" class="space-y-1 mb-4 max-h-[150px] overflow-y-auto pr-1 custom-scrollbar">
                        <div class="text-xs text-gray-600 text-center py-4 italic">请选择地点并点击 + 号添加</div>
                    </div>

                    <!-- 统计数据 -->
                    <div id="measure-stats" class="hidden bg-black/40 rounded-lg p-3 border border-white/5 space-y-2">
                        <div class="flex justify-between items-center border-b border-white/10 pb-2">
                            <span class="text-xs text-gray-400">总距离</span>
                            <span class="text-orange-400 font-bold font-mono text-lg" id="measure-total-dist">0 km</span>
                        </div>
                        <div id="measure-segments" class="space-y-1">
                            <!-- JS 填充段落数据 -->
                        </div>
                    </div>

                    <!-- 操作栏 -->
                    <button id="btn-measure-clear" class="w-full mt-3 border border-dashed border-gray-600 text-gray-400 text-xs py-1.5 rounded hover:text-white hover:border-red-400 hover:text-red-400 transition">
                        <i class="fas fa-trash-alt mr-1"></i> 清空所有节点
                    </button>
                </div>
            </div>
        `;
        routePanel.insertAdjacentHTML('afterend', panelHtml);
    }

    // --- 3. 业务逻辑 ---
    let measureNodes = []; 

    const selectEl = document.getElementById('measure-select');
    const listEl = document.getElementById('measure-list');
    const statsEl = document.getElementById('measure-stats');
    
    // 全局函数：刷新下拉框 (带地点后缀优化)
    window.updateMeasureSelect = () => {
        if (!selectEl) return;
        if (mapData.length === 0) {
            selectEl.innerHTML = '<option value="">数据加载中...</option>';
            return;
        }

        selectEl.innerHTML = '<option value="">选择实体添加...</option>';
        const sorted = [...mapData].sort((a,b) => a.name.localeCompare(b.name, 'zh'));
        
        sorted.forEach(d => {
            // 获取地点后缀 (保持与路线规划一致)
            let placeSuffix = '';
            if (d.detail) {
                switch (d.type) {
                    case 'person': placeSuffix = d.detail.birth_place_name; break;
                    case 'event': placeSuffix = d.detail.location_name; break;
                    case 'artifact': placeSuffix = d.detail.discovered_at || d.detail.preserved_at; break;
                    case 'site': placeSuffix = d.detail.address_modern; break;
                }
            }
            const displayName = placeSuffix ? `${d.name}（${placeSuffix}）` : d.name;
            selectEl.add(new Option(displayName, d.id));
        });
    };

    // 添加节点按钮
    const btnAdd = document.getElementById('btn-measure-add');
    if(btnAdd) btnAdd.onclick = () => {
        const id = selectEl.value;
        if (!id) return alert("请先从下拉框选择一个地点");
        
        const entity = mapData.find(d => d.id == id);
        if (!entity) return;

        measureNodes.push(entity);
        renderMeasureView();
    };

    // 清空按钮
    const btnClear = document.getElementById('btn-measure-clear');
    if(btnClear) btnClear.onclick = () => {
        measureNodes = [];
        renderMeasureView();
    };

    // 渲染视图
    function renderMeasureView() {
        // 渲染列表
        listEl.innerHTML = '';
        if (measureNodes.length === 0) {
            listEl.innerHTML = '<div class="text-xs text-gray-600 text-center py-4 italic">请选择地点并点击 + 号添加</div>';
            statsEl.classList.add('hidden');
        } else {
            measureNodes.forEach((node, index) => {
                const item = document.createElement('div');
                item.className = 'flex items-center justify-between bg-white/5 px-2 py-1.5 rounded group hover:bg-white/10 transition';
                item.innerHTML = `
                    <div class="flex items-center gap-2 overflow-hidden">
                        <span class="bg-orange-500/20 text-orange-400 text-[10px] w-4 h-4 rounded-full flex-shrink-0 flex items-center justify-center font-bold border border-orange-500/50">${index + 1}</span>
                        <span class="text-xs text-gray-300 truncate">${node.name}</span>
                    </div>
                    <button class="text-gray-600 hover:text-red-400 transition" onclick="window.removeMeasureNode(${index})">
                        <i class="fas fa-times"></i>
                    </button>
                `;
                listEl.appendChild(item);
            });
            statsEl.classList.remove('hidden');
        }

        // 渲染地图
        layers.measure.clearLayers();
        if (!map.hasLayer(layers.measure)) map.addLayer(layers.measure);

        if (measureNodes.length > 0) {
            const latlngs = measureNodes.map(d => [d.lat, d.lng]);
            
            if (measureNodes.length > 1) {
                L.polyline(latlngs, {
                    color: '#fb923c', 
                    weight: 3,
                    dashArray: '5, 8',
                    opacity: 0.8
                }).addTo(layers.measure);
            }

            measureNodes.forEach((node, i) => {
                L.marker([node.lat, node.lng], {
                    icon: L.divIcon({
                        className: 'bg-orange-500 text-white w-5 h-5 rounded-full text-center leading-5 text-[10px] font-bold border border-black shadow-lg',
                        html: `${i + 1}`,
                        iconSize: [20, 20]
                    })
                }).addTo(layers.measure).bindPopup(`<b>${i+1}. ${node.name}</b>`);
            });

            // 自动缩放
            const group = L.featureGroup(measureNodes.map(d => L.marker([d.lat, d.lng])));
            map.fitBounds(group.getBounds(), { padding: [50, 50] });
        }

        calculateStats();
    }

    function calculateStats() {
        const totalEl = document.getElementById('measure-total-dist');
        const segContainer = document.getElementById('measure-segments');
        if(!totalEl || !segContainer) return;

        segContainer.innerHTML = '';
        
        if (measureNodes.length < 2) {
            totalEl.innerText = '0 km';
            return;
        }

        let totalDist = 0;

        for (let i = 0; i < measureNodes.length - 1; i++) {
            const p1 = measureNodes[i];
            const p2 = measureNodes[i+1];
            const dist = map.distance([p1.lat, p1.lng], [p2.lat, p2.lng]);
            totalDist += dist;

            const div = document.createElement('div');
            div.className = 'flex justify-between text-[10px] text-gray-500 pl-2 border-l border-gray-700';
            div.innerHTML = `
                <span>${i+1}→${i+2}: ${p1.name}</span>
                <span class="text-gray-300 font-mono">${(dist/1000).toFixed(1)} km</span>
            `;
            segContainer.appendChild(div);
        }

        totalEl.innerText = `${(totalDist / 1000).toFixed(2)} km`;
    }

    window.removeMeasureNode = (index) => {
        measureNodes.splice(index, 1);
        renderMeasureView();
    };
}

// ================= [新增面板] AI 地理助手 =================
// ================= [新增面板] AI 地理助手 (增强版：面要素+时间轴) =================
function initAIAssistant() {
    // --- 1. 知识库 (升级为时空数据结构) ---
    // --- 1. 知识库 (升级版：高精度坐标 + 丰富案例) ---
    const aiKnowledge = {
        // ==================== [面要素案例 1：唐朝] ====================
        "唐朝": {
            title: "唐朝疆域演变 (Tang Dynasty)",
            desc: "AI 已生成：唐朝疆域极盛时（龙朔年间），东起朝鲜半岛，西达中亚咸海，北至贝加尔湖，南抵越南顺化。",
            type: "evolution",
            style: { color: "#d4af37", fillColor: "#d4af37", fillOpacity: 0.3, weight: 2 },
            timeline: [
                {
                    year: 618,
                    label: "618年 (初唐建国)",
                    type: "polygon",
                    // 关中 + 中原核心区
                    coords: [
                        [34.5, 107.0], [35.5, 105.0], [38.0, 105.0], [39.0, 110.0], 
                        [38.0, 115.0], [36.0, 118.0], [34.0, 116.0], [32.0, 112.0], 
                        [31.0, 109.0], [32.5, 106.0], [34.5, 107.0]
                    ]
                },
                {
                    year: 669,
                    label: "669年 (极盛疆域)",
                    type: "polygon",
                    // 包含西域、中亚的大型多边形
                    coords: [
                        [42.0, 125.0], [40.0, 124.0], [35.0, 120.0], [30.0, 122.0], // 东部沿海
                        [20.0, 106.0], [22.0, 102.0], [28.0, 98.0],  [30.0, 90.0],  // 南部及西南
                        [35.0, 75.0],  [40.0, 65.0],  [45.0, 62.0],  [48.0, 70.0],  // 中亚咸海一带
                        [45.0, 85.0],  [50.0, 95.0],  [52.0, 105.0], [50.0, 115.0], // 北部边界
                        [45.0, 120.0], [42.0, 125.0]
                    ]
                },
                {
                    year: 820,
                    label: "820年 (中晚唐)",
                    type: "polygon",
                    // 失去西域，退守本部
                    coords: [
                        [40.0, 118.0], [38.0, 115.0], [34.0, 108.0], [35.0, 105.0],
                        [33.0, 105.0], [29.0, 103.0], [25.0, 105.0], [22.0, 108.0],
                        [23.0, 113.0], [28.0, 118.0], [32.0, 121.0], [35.0, 120.0],
                        [39.0, 119.0], [40.0, 118.0]
                    ]
                }
            ]
        },

        // ==================== [面要素案例 2：汉朝] ====================
        "汉朝": {
            title: "汉朝疆域演变 (Han Dynasty)",
            desc: "AI 已生成：两汉时期，中国疆域奠定了汉地的基本格局，并首次将西域纳入版图。",
            type: "evolution",
            style: { color: "#ef4444", fillColor: "#ef4444", fillOpacity: 0.3, weight: 2 },
            timeline: [
                {
                    year: -202,
                    label: "前202年 (西汉初立)",
                    type: "polygon",
                    coords: [
                        [40.0, 115.0], [35.0, 118.0], [32.0, 120.0], [28.0, 118.0],
                        [25.0, 115.0], [25.0, 110.0], [28.0, 105.0], [32.0, 105.0],
                        [35.0, 106.0], [38.0, 108.0], [40.0, 115.0]
                    ]
                },
                {
                    year: -100,
                    label: "前100年 (武帝拓边)",
                    type: "polygon",
                    // 包含河西走廊、西域、朝鲜北部、越南北部
                    coords: [
                        [40.0, 126.0], [36.0, 126.0], [34.0, 120.0], [30.0, 121.0], // 东部
                        [20.0, 106.0], [22.0, 102.0], [26.0, 100.0], [30.0, 102.0], // 南部
                        [36.0, 100.0], [40.0, 94.0],  [41.0, 85.0],  [40.0, 75.0],  // 西域长臂
                        [42.0, 80.0],  [43.0, 95.0],  [42.0, 110.0], [41.0, 120.0], // 北部
                        [40.0, 126.0]
                    ]
                },
                {
                    year: 220,
                    label: "220年 (东汉末年)",
                    type: "polygon",
                    coords: [
                        [40.0, 124.0], [34.0, 120.0], [30.0, 121.0], [20.0, 107.0],
                        [23.0, 100.0], [28.0, 102.0], [32.0, 104.0], [35.0, 103.0],
                        [38.0, 105.0], [41.0, 110.0], [40.0, 124.0]
                    ]
                }
            ]
        },

        // ==================== [面要素案例 3：蒙古帝国] ====================
        "蒙古": {
            title: "蒙古帝国扩张 (Mongol Empire)",
            desc: "AI 已生成：人类历史上连续疆域最大的帝国，横跨欧亚大陆。",
            type: "evolution",
            style: { color: "#a855f7", fillColor: "#a855f7", fillOpacity: 0.3, weight: 2 },
            timeline: [
                {
                    year: 1206,
                    label: "1206年 (统一漠北)",
                    type: "polygon",
                    coords: [
                        [45.0, 95.0], [48.0, 90.0], [52.0, 92.0], [54.0, 100.0],
                        [53.0, 115.0], [50.0, 120.0], [46.0, 118.0], [44.0, 110.0],
                        [45.0, 95.0]
                    ]
                },
                {
                    year: 1259,
                    label: "1259年 (蒙哥汗时期)",
                    type: "polygon",
                    // 覆盖欧亚的巨大多边形
                    coords: [
                        [55.0, 135.0], [40.0, 118.0], [30.0, 120.0], [22.0, 110.0], // 东部边界
                        [25.0, 100.0], [30.0, 80.0],  [25.0, 60.0],  [30.0, 45.0],  // 南部边界(含波斯)
                        [40.0, 40.0],  [50.0, 30.0],  [55.0, 40.0],  [60.0, 60.0],  // 西部边界(含东欧)
                        [60.0, 90.0],  [58.0, 120.0], [55.0, 135.0]                 // 北部边界
                    ]
                },
                {
                    year: 1294,
                    label: "1294年 (分裂时期)",
                    type: "polygon",
                    // 主要是元朝疆域
                    coords: [
                        [55.0, 135.0], [40.0, 118.0], [30.0, 120.0], [20.0, 110.0],
                        [25.0, 100.0], [30.0, 95.0],  [40.0, 90.0],  [45.0, 85.0],
                        [50.0, 90.0],  [55.0, 110.0], [55.0, 135.0]
                    ]
                }
            ]
        },

        // ==================== [线要素案例 1：丝绸之路] ====================
        "丝绸之路": {
            title: "陆上丝绸之路 (The Silk Road)",
            desc: "AI 已生成：起源于西汉，以长安（今西安）为起点，经甘肃、新疆，到中亚、西亚，并连接地中海各国的陆上通道。",
            type: "static",
            subType: "polyline",
            style: { color: "#00ffcc", weight: 3, dashArray: "10, 5" },
            coords: [
                [34.3416, 108.9398], // 西安
                [34.5, 105.7],       // 天水
                [36.0611, 103.8343], // 兰州
                [39.7, 98.5],        // 酒泉
                [40.1421, 94.6620],  // 敦煌
                [42.95, 89.18],      // 吐鲁番
                [41.72, 82.96],      // 库车
                [39.4677, 75.9898],  // 喀什
                [40.0, 69.0],        // 撒马尔罕
                [36.3, 59.6],        // 马什哈德
                [35.68, 51.38],      // 德黑兰
                [33.31, 44.36],      // 巴格达
                [36.2, 36.1],        // 安条克
                [41.0082, 28.9784]   // 伊斯坦布尔
            ]
        },

        // ==================== [线要素案例 2：大运河] ====================
        "大运河": {
            title: "京杭大运河 (The Grand Canal)",
            desc: "AI 已生成：世界上里程最长、工程最大的古代运河。南起余杭（今杭州），北至涿郡（今北京）。",
            type: "static",
            subType: "polyline",
            style: { color: "#ff00ff", weight: 4 },
            coords: [
                [30.2741, 120.1551], // 杭州
                [30.75, 120.75],     // 嘉兴
                [31.30, 120.60],     // 苏州
                [31.57, 120.30],     // 无锡
                [31.78, 119.97],     // 常州
                [32.20, 119.45],     // 镇江
                [32.39, 119.40],     // 扬州
                [33.50, 119.13],     // 淮安
                [34.80, 117.30],     // 徐州
                [35.40, 116.60],     // 济宁
                [36.65, 116.00],     // 聊城
                [37.43, 116.30],     // 德州
                [38.30, 116.85],     // 沧州
                [39.13, 117.20],     // 天津
                [39.9042, 116.4074]  // 北京
            ]
        },

        // ==================== [线要素案例 3：郑和下西洋] ====================
        "郑和": {
            title: "郑和下西洋 (Voyages of Zheng He)",
            desc: "AI 已生成：明代郑和七下西洋的航海路线，途经东南亚、南亚、中东，最远到达东非。",
            type: "static",
            subType: "polyline",
            style: { color: "#3b82f6", weight: 3, dashArray: "5, 5" },
            coords: [
                [32.06, 118.79], // 南京 (出发)
                [25.90, 119.50], // 福建长乐
                [13.75, 109.20], // 占城 (越南)
                [-6.20, 106.80], // 爪哇
                [2.20, 102.25],  // 马六甲
                [6.00, 95.00],   // 苏门答腊
                [6.92, 79.86],   // 锡兰 (斯里兰卡)
                [11.25, 75.78],  // 古里 (印度)
                [27.10, 56.40],  // 忽鲁谟斯 (霍尔木兹)
                [12.78, 45.02],  // 亚丁
                [2.03, 45.31],   // 摩加迪沙 (索马里)
                [-3.20, 40.11]   // 麻林地 (肯尼亚)
            ]
        }
    };

    // --- 2. 注入 Dock 按钮 ---
    const dockContainer = document.getElementById('map-dock');
    if (dockContainer && !document.getElementById('dock-btn-ai')) {
        const aiBtn = document.createElement('button');
        aiBtn.id = 'dock-btn-ai';
        aiBtn.className = 'dock-btn mt-auto'; 
        aiBtn.dataset.target = 'panel-ai';
        aiBtn.title = 'AI 地理助手';
        aiBtn.innerHTML = '<i class="fas fa-brain text-cyan-400 animate-pulse"></i>';
        
        const themeBtn = document.getElementById('dock-theme-btn');
        if (themeBtn) dockContainer.insertBefore(aiBtn, themeBtn);
        else dockContainer.appendChild(aiBtn);

        aiBtn.onclick = () => {
            const targetId = aiBtn.dataset.target;
            const targetPanel = document.getElementById(targetId);
            const isHidden = targetPanel.classList.contains('hidden');
            
            document.querySelectorAll('.map-panel').forEach(p => p.classList.add('hidden'));
            document.querySelectorAll('.dock-btn').forEach(b => b.classList.remove('active'));

            if (isHidden) {
                targetPanel.classList.remove('hidden');
                aiBtn.classList.add('active');
                setTimeout(() => document.getElementById('ai-input-field').focus(), 100);
            } else {
                targetPanel.classList.add('hidden');
                aiBtn.classList.remove('active');
            }
        };
    }

    // --- 3. 注入面板 HTML (增加时间轴和清除按钮) ---
    const sidebarContainer = document.getElementById('sidebar-container');
    if (sidebarContainer && !document.getElementById('panel-ai')) {
        const panelHtml = `
            <div class="map-panel hidden border-t-2 border-cyan-500 shadow-[0_0_20px_rgba(6,182,212,0.3)]" id="panel-ai">
                <!-- 头部：增加清除按钮 -->
                <div class="map-panel-header" onclick="this.parentElement.classList.toggle('collapsed')">
                    <span class="map-panel-title">
                        <i class="fas fa-robot text-cyan-400"></i>
                        <span class="bg-gradient-to-r from-cyan-400 to-blue-500 text-transparent bg-clip-text font-tech tracking-wider">AI GEO-MIND</span>
                    </span>
                    <div class="flex items-center gap-3">
                         <button id="btn-ai-reset" title="清空对话和地图" class="text-cyan-600 hover:text-red-400 transition text-xs">
                            <i class="fas fa-trash-alt"></i>
                        </button>
                        <i class="fas fa-chevron-down text-cyan-500/50 transition-transform duration-300"></i>
                    </div>
                </div>

                <div class="map-panel-content flex flex-col h-[400px]"> <!-- 增加高度以容纳时间轴 -->
                    
                    <!-- 聊天记录区 -->
                    <div id="ai-chat-log" class="flex-1 overflow-y-auto mb-3 pr-1 space-y-3 custom-scrollbar font-mono text-xs">
                        <div class="bg-cyan-900/20 border border-cyan-500/30 p-2 rounded text-cyan-300">
                            <i class="fas fa-info-circle mr-1"></i> 您好。请输入关键词（如“唐朝”、“蒙古”、“丝绸之路”），我将为您生成时空地理数据。
                        </div>
                    </div>

                    <!-- 时间轴控制器 (默认隐藏) -->
                    <div id="ai-timeline-box" class="hidden mb-3 bg-black/40 p-2 rounded border border-cyan-500/30">
                        <div class="flex justify-between text-[10px] text-cyan-300 font-mono mb-1">
                            <span id="tl-start-year">Start</span>
                            <span id="tl-current-year" class="text-cyan-100 font-bold bg-cyan-600/50 px-2 rounded">Year</span>
                            <span id="tl-end-year">End</span>
                        </div>
                        <input type="range" id="ai-timeline-slider" class="w-full h-1 bg-cyan-900 rounded-lg appearance-none cursor-pointer accent-cyan-400">
                        <div id="tl-event-label" class="text-center text-[10px] text-gray-400 mt-1 h-4"></div>
                    </div>

                    <!-- 输入区 -->
                    <div class="relative">
                        <input type="text" id="ai-input-field" 
                            class="w-full bg-black/50 border border-cyan-500/50 rounded-lg pl-3 pr-10 py-2 text-sm text-white placeholder-cyan-700 outline-none focus:border-cyan-400 focus:shadow-[0_0_10px_rgba(6,182,212,0.5)] transition-all font-mono"
                            placeholder="输入指令..." autocomplete="off">
                        <button id="btn-ai-send" class="absolute right-1 top-1 bottom-1 px-3 text-cyan-400 hover:text-white transition">
                            <i class="fas fa-paper-plane"></i>
                        </button>
                    </div>
                </div>
            </div>
        `;
        sidebarContainer.insertAdjacentHTML('beforeend', panelHtml);
    }

    // --- 4. 业务逻辑 ---
    const inputField = document.getElementById('ai-input-field');
    const sendBtn = document.getElementById('btn-ai-send');
    const chatLog = document.getElementById('ai-chat-log');
    const resetBtn = document.getElementById('btn-ai-reset');
    
    // 时间轴 DOM
    const timelineBox = document.getElementById('ai-timeline-box');
    const slider = document.getElementById('ai-timeline-slider');
    const labelYear = document.getElementById('tl-current-year');
    const labelEvent = document.getElementById('tl-event-label');
    const labelStart = document.getElementById('tl-start-year');
    const labelEnd = document.getElementById('tl-end-year');

    // 当前活跃的数据上下文
    let activeAIData = null;

    // A. 发送消息逻辑
    function handleSend() {
        const text = inputField.value.trim();
        if (!text) return;

        appendMessage('user', text);
        inputField.value = '';

        const loadingId = appendMessage('ai', 'Thinking...', true);

        setTimeout(() => {
            const loadingEl = document.getElementById(loadingId);
            if(loadingEl) loadingEl.remove();

            let match = null;
            Object.keys(aiKnowledge).forEach(key => {
                if (text.includes(key) || key.includes(text)) match = aiKnowledge[key];
            });

            if (match) {
                activeAIData = match; // 保存当前数据上下文
                typeWriterEffect(match.desc, () => {
                    renderAIOnMap(match);
                });
            } else {
                typeWriterEffect(`抱歉，知识库未收录“${text}”。请尝试：唐朝、蒙古、丝绸之路。`);
                hideTimeline();
            }
        }, 600);
    }

    // B. 清空重置逻辑 (要求3)
    if(resetBtn) resetBtn.onclick = () => {
        // 1. 清空地图图层
        layers.aiLayer.clearLayers();
        // 2. 清空聊天记录
        chatLog.innerHTML = `<div class="bg-cyan-900/20 border border-cyan-500/30 p-2 rounded text-cyan-300"><i class="fas fa-info-circle mr-1"></i> 对话已重置。</div>`;
        // 3. 隐藏时间轴
        hideTimeline();
        // 4. 清空输入框
        inputField.value = '';
        activeAIData = null;
    };

    // C. 渲染逻辑 (含面要素与时间轴)
    function renderAIOnMap(data) {
        layers.aiLayer.clearLayers();
        if (!map.hasLayer(layers.aiLayer)) map.addLayer(layers.aiLayer);

        // 情况1：演变型数据 (时间轴)
        if (data.type === 'evolution' && data.timeline) {
            setupTimeline(data);
            // 默认渲染第一帧
            updateMapByYear(data.timeline[0].year);
        } 
        // 情况2：静态数据
        else {
            hideTimeline();
            renderGeometry(data.subType, data.coords, data.style, data.title);
        }
    }

    // D. 时间轴初始化
    function setupTimeline(data) {
        timelineBox.classList.remove('hidden');
        
        const years = data.timeline.map(t => t.year);
        const minYear = Math.min(...years);
        const maxYear = Math.max(...years);

        slider.min = minYear;
        slider.max = maxYear;
        slider.value = minYear;
        
        labelStart.innerText = minYear;
        labelEnd.innerText = maxYear;

        // 绑定滑块事件
        slider.oninput = (e) => {
            const val = parseInt(e.target.value);
            // 找到最接近当前滑块年份的数据帧
            // 算法：在 timeline 中找 <= val 的最大年份
            const frame = data.timeline.reduce((prev, curr) => {
                return (curr.year <= val && curr.year > prev.year) ? curr : prev;
            }, data.timeline[0]);
            
            updateMapByYear(val, frame);
        };
    }

    function hideTimeline() {
        timelineBox.classList.add('hidden');
    }

    // E. 根据年份更新地图
    function updateMapByYear(year, specificFrame = null) {
        labelYear.innerText = year;
        
        if (!activeAIData || !activeAIData.timeline) return;

        // 如果未传入 frame，则自己查找
        const frame = specificFrame || activeAIData.timeline.reduce((prev, curr) => {
            return (curr.year <= year && curr.year > prev.year) ? curr : prev;
        }, activeAIData.timeline[0]);

        if (frame) {
            labelEvent.innerText = frame.label;
            layers.aiLayer.clearLayers(); // 清除旧帧
            
            // 渲染新帧
            renderGeometry(frame.type, frame.coords, activeAIData.style, frame.label);
        }
    }

    // F. 通用几何渲染 (点/线/面)
    function renderGeometry(type, coords, style, popupText) {
        let layer;
        
        if (type === 'polygon') {
            // 面要素 (要求1)
            layer = L.polygon(coords, {
                color: style.color,
                fillColor: style.fillColor || style.color,
                fillOpacity: style.fillOpacity || 0.2,
                weight: style.weight
            }).addTo(layers.aiLayer);
            
            // 自动缩放
            // 稍微延迟以产生动画效果
            map.flyToBounds(layer.getBounds(), { padding: [50, 50], duration: 1.0 });

        } else if (type === 'polyline') {
            // 线要素
            layer = L.polyline(coords, {
                color: style.color,
                weight: style.weight,
                dashArray: style.dashArray
            }).addTo(layers.aiLayer);
            
            map.flyToBounds(layer.getBounds(), { padding: [50, 50], duration: 1.0 });
        }

        if (layer && popupText) {
            layer.bindPopup(`<b style="color:${style.color}">${popupText}</b>`).openPopup();
        }
    }

    // 辅助功能
    if(sendBtn) sendBtn.onclick = handleSend;
    if(inputField) {
        inputField.onkeypress = (e) => {
            if (e.key === 'Enter') handleSend();
        };
    }

    function appendMessage(role, text, isLoading = false) {
        const id = 'msg-' + Date.now();
        const div = document.createElement('div');
        div.id = id;
        
        if (role === 'user') {
            div.className = 'self-end bg-white/10 text-gray-200 p-2 rounded ml-8 text-right border border-white/5';
        } else {
            div.className = 'self-start bg-cyan-900/10 text-cyan-300 p-2 rounded mr-4 border border-cyan-500/20';
            if (isLoading) div.innerHTML = '<i class="fas fa-circle-notch fa-spin mr-2"></i>AI 正在推演时空数据...';
        }
        
        if (!isLoading && role !== 'user') div.innerText = ""; 
        else if (role === 'user') div.innerText = text;

        chatLog.appendChild(div);
        chatLog.scrollTop = chatLog.scrollHeight;
        return id;
    }

    function typeWriterEffect(text, callback) {
        const id = appendMessage('ai', '');
        const el = document.getElementById(id);
        let i = 0;
        function type() {
            if (i < text.length) {
                el.innerHTML += text.charAt(i);
                i++;
                chatLog.scrollTop = chatLog.scrollHeight;
                setTimeout(type, 20);
            } else {
                if (callback) callback();
            }
        }
        type();
    }
}

import { fetchCulturalEntities, normalizeDynasty, normalizeType } from './data.js';
import { initSearch, searchEntities, getHotItems, getEntityById } from './search.js';

// 星系配置预设：支持按朝代 / 按类型等维度切换
const clusterPresets = {
  dynasty: {
    label: '按朝代',
    clusters: {
      唐代: { color: new THREE.Color(0xffd700), pos: new THREE.Vector3(0, 0, 0), rot: [0.2, 0, 0], galaxyType: 'spiral', subtype: 'Sc' }, // 金色 - 螺旋星系
      宋代: { color: new THREE.Color(0x00e5ff), pos: new THREE.Vector3(800, 200, -400), rot: [0.5, 0.5, 0], galaxyType: 'barred', subtype: 'SBb' }, // 亮青色 - 棒旋星系
      元代: { color: new THREE.Color(0x1e88e5), pos: new THREE.Vector3(-700, 350, 300), rot: [-0.3, 0.2, 0.1], galaxyType: 'elliptical', subtype: 'E3' }, // 深蓝色 - 椭圆星系
      明代: { color: new THREE.Color(0xff6f00), pos: new THREE.Vector3(-600, -550, -300), rot: [0, -0.4, 0.2], galaxyType: 'spiral', subtype: 'Sb' }, // 橙红色 - 螺旋星系
      清代: { color: new THREE.Color(0x9c27b0), pos: new THREE.Vector3(700, -400, 550), rot: [0.4, 0, -0.3], galaxyType: 'barred', subtype: 'SBc' }, // 紫色 - 棒旋星系
      其他: { color: new THREE.Color(0xe91e63), pos: new THREE.Vector3(0, 700, 700), rot: [0, 0.3, -0.2], galaxyType: 'elliptical', subtype: 'E0' } // 粉红色 - 椭圆星系
    }
  },
  type: {
    label: '按类型',
    clusters: {} // 将从数据库动态生成
  }
};

let processedData = [];
let scene;
let camera;
let renderer;
let raycaster;
let mouse;
let galaxyGroup;
let spriteMap;
let glowMap;
let controls;
let galaxyParticles = [];
let globalScale = 1.0;
let currentFocusCluster = null;
let lockedNode = null; // 新增：用于跟踪锁定的星球
let enteredFromGlobalView = false; // 跟踪是否从全局视图进入星球聚焦


let currentClusterMode = 'dynasty';
let currentClusters = clusterPresets.dynasty.clusters;
let isSwitchingMode = false; // 标记是否正在切换模式（用于淡入动画）

let previewScene;
let previewCamera;
let previewRenderer;
let previewControls;
let currentModel = null;
let isPreviewInit = false;
let linkLines = [];
let highlightedNodes = [];
let nodeById = new Map();
let nodeByKgNodeId = new Map();

const HOME_STATE_KEY = 'homeViewState';
const INTRO_SEEN_KEY = 'introSeen'; // 记录用户是否已经看过开场
let pendingRestoreState = null;
let previewData = null;
let hasPlayedIntro = false;
let hasStartedExperience = false;
let skipIntroOnce = false;
let suppressNextClick = false;
// 默认相机位置（进入主界面时的初始位置）
const defaultCameraPos = new THREE.Vector3(0, 800, 1600);
const defaultTarget = new THREE.Vector3(0, 0, 0);

// AI 手势相关变量
let isCameraActive = false;
let hands, cameraUtils;
let lastGestureTime = 0;
let globalWheelHandlerAttached = false;

// 根据数据库中的朝代数据动态生成星系配置
// 根据实际数据中的类型动态生成类型星系配置
function generateTypeClusters(entities) {
  const clusters = {};
  const typeSet = new Set();
  
  // 收集所有唯一的类型
  entities.forEach(item => {
    if (item.type) {
      typeSet.add(item.type);
    }
  });
  
  console.log(`📊 收集到的类型:`, Array.from(typeSet));
  console.log(`📊 实体总数: ${entities.length}, 有类型的实体数: ${Array.from(typeSet).length}`);
  
  // 类型到中文名称的映射
  const typeNameMap = {
    'site': '遗址',
    'person': '人物',
    'event': '事件',
    'artifact': '器物',
    'literature': '文献'
  };
  
  // 默认颜色配置 - 使用更鲜明、对比度更高的颜色
  const defaultColors = {
    'site': 0xffd700,      // 金色 - 遗址
    'person': 0x00ff88,     // 亮绿色 - 人物
    'event': 0x00d4ff,      // 亮蓝色 - 事件
    'artifact': 0xff6600,   // 橙红色 - 器物
    'literature': 0xff00ff  // 洋红色 - 文献
  };
  
  // 先统计每个类型的星球数量
  const typeCounts = {};
  entities.forEach(item => {
    if (item.type) {
      const typeName = typeNameMap[item.type] || item.type;
      typeCounts[typeName] = (typeCounts[typeName] || 0) + 1;
    }
  });
  
  // 找到最大和最小数量，用于归一化
  const counts = Object.values(typeCounts);
  const maxCount = counts.length > 0 ? Math.max(...counts) : 1;
  const minCount = counts.length > 0 ? Math.min(...counts) : 1;
  
  // 为每个类型创建星系配置，大星系在中心，小星系在外围
  // 按星球数量排序：大星系在前（放在中心），小星系在后（放在外围）
  const typeArray = Array.from(typeSet).sort((a, b) => {
    const typeNameA = typeNameMap[a] || a;
    const typeNameB = typeNameMap[b] || b;
    const countA = typeCounts[typeNameA] || 0;
    const countB = typeCounts[typeNameB] || 0;
    return countB - countA; // 降序排列，大星系在前
  });
  
  typeArray.forEach((type, index) => {
    const typeName = typeNameMap[type] || type;
    const colorHex = defaultColors[type] || 0x7fffd4;
    
    // 计算该类型的星球数量
    const particleCount = typeCounts[typeName] || 0;
    
    // 大星系在中心（距离小），小星系在外围（距离大）
    // 第一个（最大的）星系在中心，其他按距离递增
    const baseDistance = index === 0 ? 0 : 200 + (index - 1) * 150; // 中心为0，外围递增
    
    const angle = (index / Math.max(typeArray.length, 1)) * Math.PI * 2;
    const elevation = (Math.random() - 0.5) * Math.PI * 0.5;
    const pos = new THREE.Vector3(
      baseDistance * Math.cos(elevation) * Math.cos(angle),
      baseDistance * Math.sin(elevation),
      baseDistance * Math.cos(elevation) * Math.sin(angle)
    );
    
    const rot = [
      (Math.random() - 0.5) * 0.5,
      (Math.random() - 0.5) * 0.5,
      (Math.random() - 0.5) * 0.3
    ];
    
    clusters[typeName] = {
      color: new THREE.Color(colorHex),
      pos: pos,
      rot: rot,
      galaxyType: 'spiral',
      subtype: 'Sc'
    };
    
    console.log(`📍 星系 "${typeName}": 星球数=${particleCount}, 距离=${baseDistance.toFixed(0)}`);
  });
  
  // 只有当有数据时才添加"其他"类别
  if (typeArray.length > 0) {
    clusters['其他'] = {
      color: new THREE.Color(0xff69b4), // 使用更明显的粉红色替代青绿色
      pos: new THREE.Vector3(0, 700, 700),
      rot: [0, 0.3, -0.2],
      galaxyType: 'elliptical',
      subtype: 'E0'
    };
  }
  
  console.log(`✅ 生成了 ${Object.keys(clusters).length} 个类型星系配置:`, Object.keys(clusters));
  return clusters;
}

export async function initHome() {
  if (!document.getElementById('canvas-container')) return;

  // 从 API 获取数据
  try {
    const entities = await fetchCulturalEntities();
    
    // 根据实际数据中的类型生成类型星系配置
    clusterPresets.type.clusters = generateTypeClusters(entities);
    console.log(`✅ 类型模式集群已生成，包含 ${Object.keys(clusterPresets.type.clusters).length} 个集群`);
    
    // 转换数据格式以兼容现有代码
    processedData = entities.map((item) => {
      const dynasty = item.dynasty || item.dynasty_name || '';
      
      // 类型名称映射
      const typeNameMap = {
        'site': '遗址',
        'person': '人物',
        'event': '事件',
        'artifact': '器物',
        'literature': '文献'
      };
      const typeName = typeNameMap[item.type] || item.type || '其他';
      
      return {
        ...item,
        id: item.id,
        name: item.name,
        kg_node_id: item.kg_node_id,
        lat: item.lat,
        lng: item.lng,
        dynasty,
        desc: item.description || item.desc,
        type: item.type,
        typeName: typeName,
        detail: item.detail || item.meta_info
      };
    });

    console.log(`✅ 从数据库加载了 ${processedData.length} 个文化实体`);
  } catch (error) {
    console.error('❌ 加载数据失败:', error);
    processedData = [];
    // 使用默认配置作为后备
    clusterPresets.type.clusters = {
      其他: { color: new THREE.Color(0xff69b4), pos: new THREE.Vector3(0, 700, 700), rot: [0, 0.3, -0.2], galaxyType: 'elliptical', subtype: 'E0' }
    };
    
    // 在 UI 上显示错误信息
    const homeContent = document.getElementById('home-content');
    if (homeContent) {
      homeContent.innerHTML = `
        <div class="text-center text-red-400">
          <h2 class="text-4xl font-bold mb-4">数据加载失败</h2>
          <p>无法连接到后端服务或数据查询出错。</p>
          <p>请检查后端服务是否已启动并正常运行。</p>
        </div>
      `;
      homeContent.style.opacity = '1';
    }
  }

  // 暴露手势控制到全局（便于按钮直接调用）
  window.toggleCamera = toggleCamera;
  window.startExperience = startExperience;

  loadSavedState();
  
  // 检查是否需要重定向到开场页面
  checkAndSkipIntro();
  
  // 确保 DOM 完全加载后再初始化模式切换器
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      setupModeSwitcher();
      setupBackButton();
    });
  } else {
    setupModeSwitcher();
    setupBackButton();
  }
  
  initThreeJS();
  updateHistoryUI();
  
  // 初始化搜索功能
  initSearch().then(() => {
    setupSearch();
  });
}

function initThreeJS() {
  const container = document.getElementById('canvas-container');
  scene = new THREE.Scene();
  scene.background = createStarBackground();

  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 1, 10000);
  camera.position.copy(defaultCameraPos);

  renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  container.appendChild(renderer.domElement);

  // 使用 renderer.domElement 作为事件源，避免阻断原生表单控件（如 <select>）的默认行为
  controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.autoRotate = true;
  // 进一步降低自动旋转速度，让星系缓慢、沉稳地旋转
  controls.autoRotateSpeed = 0.04;
  // 确保鼠标缩放/拖动可用
  controls.enableZoom = true;
  controls.enablePan = true;
  controls.enableRotate = true;
  controls.zoomSpeed = 1.0;
  controls.panSpeed = 0.5;
  controls.rotateSpeed = 0.5; // 降低旋转速度
  controls.maxDistance = 4000;
  controls.minDistance = 100;

  raycaster = new THREE.Raycaster();
  mouse = new THREE.Vector2();

  galaxyGroup = new THREE.Group();
  scene.add(galaxyGroup);

  // 直接使用 CanvasTexture，不需要异步加载
  if (!spriteMap) {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.3, 'rgba(255,255,255,0.8)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.2)');
    grad.addColorStop(1, 'transparent');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 128);
    spriteMap = new THREE.CanvasTexture(canvas);
  }
  
  if (!glowMap) {
    glowMap = createGlowTexture(new THREE.Color(0xffffff));
  }
  
  buildGalaxy();
  galaxyGroup.visible = false;

  window.addEventListener('resize', onResize);
  document.body.addEventListener('mousemove', onMouseMove);
  document.body.addEventListener('click', onClick);
  document.body.addEventListener('dblclick', onDoubleClick);
  // 全局滚轮缩放（无需限定光标在画布上）
  if (!globalWheelHandlerAttached) {
    window.addEventListener(
      'wheel',
      (e) => {
        if (!controls) return;
        e.preventDefault();
        const zoomScale = Math.pow(0.95, controls.zoomSpeed);
        if (e.deltaY < 0) {
          controls.dollyIn?.(zoomScale);
        } else {
          controls.dollyOut?.(zoomScale);
        }
        controls.update();
      },
      { passive: false }
    );
    globalWheelHandlerAttached = true;
  }

  initPreview3D();
  restoreViewState();
  animate();
}

function getGroupValue(item) {
  if (currentClusterMode === 'type') {
    // 按类型分类：直接使用数据库中的 type 字段，映射为中文名称
    const typeNameMap = {
      'site': '遗址',
      'person': '人物',
      'event': '事件',
      'artifact': '器物',
      'literature': '文献'
    };
    return typeNameMap[item.type] || item.type || '其他';
  } else {
    // 按朝代分类：使用原来的 normalizeDynasty 逻辑
    return normalizeDynasty(item.dynasty || item.group || '');
  }
}

// 根据星球数量计算星系半径
function calculateGalaxyRadius(planetCount) {
  if (planetCount === 0) return 0;
  // 基础半径200，每增加10个星球，半径增加30
  const baseRadius = 200;
  const radiusPerPlanet = 30;
  const dynamicRadius = baseRadius + Math.floor(planetCount / 10) * radiusPerPlanet;
  const maxRadius = 600; // 最大半径限制
  return Math.min(dynamicRadius, maxRadius);
}

// 根据星系大小动态调整位置，确保星系之间有足够距离
// 小星系可以更靠近中心，大星系保持较远距离
function adjustGalaxyPositions(clusters, stats) {
  const adjusted = {};
  const placedGalaxies = []; // 存储已放置的星系信息 {key, pos, radius}
  
  // 根据星系大小动态调整最小间距：小星系间距更小，大星系间距更大
  const baseMinDistance = 400; // 基础最小间距
  const maxMinDistance = 800; // 最大最小间距
  
  Object.entries(clusters).forEach(([clusterKey, config]) => {
    const radius = stats[clusterKey]?.radius || 300;
    const originalPos = config.pos || new THREE.Vector3(0, 0, 0);
    
    // 根据星系大小计算最小间距：小星系（半径小）间距更小
    const radiusFactor = Math.min(radius / 400, 1.0); // 归一化到 0-1
    const minDistance = baseMinDistance + radiusFactor * (maxMinDistance - baseMinDistance);
    
    // 计算新位置：确保与其他星系有足够距离
    let newPos = originalPos.clone();
    let attempts = 0;
    const maxAttempts = 50;
    
    // 检查是否与其他已放置的星系太近
    while (attempts < maxAttempts) {
      let tooClose = false;
      for (const existing of placedGalaxies) {
        const distance = newPos.distanceTo(existing.pos);
        // 小星系之间可以更近，大星系之间需要更远
        const existingRadiusFactor = Math.min(existing.radius / 400, 1.0);
        const existingMinDistance = baseMinDistance + existingRadiusFactor * (maxMinDistance - baseMinDistance);
        const requiredDistance = radius + existing.radius + Math.min(minDistance, existingMinDistance);
        if (distance < requiredDistance) {
          tooClose = true;
          break;
        }
      }
      
      if (!tooClose) break;
      
      // 如果太近，调整位置（小星系更靠近中心）
      const angle = Math.random() * Math.PI * 2;
      const elevation = (Math.random() - 0.5) * Math.PI;
      // 小星系使用更小的距离倍数
      const distanceMultiplier = 0.8 + radiusFactor * 0.4; // 0.8-1.2倍，小星系更近
      const baseDistance = minDistance * distanceMultiplier;
      newPos = new THREE.Vector3(
        baseDistance * Math.cos(elevation) * Math.cos(angle),
        baseDistance * Math.sin(elevation),
        baseDistance * Math.cos(elevation) * Math.sin(angle)
      );
      attempts++;
    }
    
    // 记录已放置的星系
    placedGalaxies.push({
      key: clusterKey,
      pos: newPos.clone(),
      radius: radius
    });
    
    adjusted[clusterKey] = {
      ...config,
      pos: newPos
    };
  });
  
  return adjusted;
}

function buildGalaxy() {
  if (!galaxyGroup) {
    console.error('galaxyGroup 未初始化');
    return;
  }
  
  if (!spriteMap) {
    console.warn('spriteMap 未加载，延迟构建星系');
    return;
  }
  
  galaxyGroup.clear();
  galaxyParticles = [];
  nodeById = new Map();
  nodeByKgNodeId = new Map();

  if (!glowMap) glowMap = createGlowTexture(new THREE.Color(0xffffff));

  console.log(`开始构建星系，当前模式: ${currentClusterMode}, 分组数: ${Object.keys(currentClusters).length}, 数据量: ${processedData.length}`);
  console.log('当前分组配置:', Object.keys(currentClusters));
  
  if (Object.keys(currentClusters).length === 0) {
    console.error('❌ 没有可用的星系分组配置！');
    return;
  }
  
  if (processedData.length === 0) {
    console.warn('⚠️ 没有数据，将不显示任何星系');
  }
  
  // ================== 识别并分离空信息星球 ==================
  // 识别没有名字的星球（只要没有名字就是空信息星球）
  const isEmptyPlanet = (item) => {
    // 检查是否有名字
    const hasName = item.name && item.name.trim() !== '';
    
    // 没有名字就是空信息星球
    return !hasName;
  };
  
  // 分离空信息星球和正常星球
  const emptyPlanets = [];
  const normalData = [];
  processedData.forEach(item => {
    if (isEmptyPlanet(item)) {
      emptyPlanets.push(item);
    } else {
      normalData.push(item);
    }
  });
  
  console.log(`📊 数据统计: 总数据=${processedData.length}, 空信息星球=${emptyPlanets.length}, 正常星球=${normalData.length}`);
  
  // 将空信息星球均匀分配到各个星系
  // 在按类型分类模式下，不分配空信息星球给"其他"星系
  const emptyPlanetsByGalaxy = {};
  const galaxies = Object.keys(currentClusters);
  
  if (currentClusterMode === 'type') {
    // 按类型分类模式下，排除"其他"星系，只分配给其他类型的星系
    const galaxiesWithoutOther = galaxies.filter(galaxyKey => galaxyKey !== '其他');
    if (galaxiesWithoutOther.length > 0) {
      const emptyPlanetsPerGalaxy = Math.floor(emptyPlanets.length / galaxiesWithoutOther.length);
      const remainingEmptyPlanets = emptyPlanets.length % galaxiesWithoutOther.length;
      
      // 为每个星系分配空信息星球（排除"其他"）
      let emptyPlanetIndex = 0;
      galaxiesWithoutOther.forEach((galaxyKey, index) => {
        const count = emptyPlanetsPerGalaxy + (index < remainingEmptyPlanets ? 1 : 0);
        emptyPlanetsByGalaxy[galaxyKey] = emptyPlanets.slice(emptyPlanetIndex, emptyPlanetIndex + count);
        emptyPlanetIndex += count;
        console.log(`🌌 星系 "${galaxyKey}" 分配了 ${count} 个空信息星球`);
      });
      console.log(`📌 按类型分类模式：空信息星球不分配给"其他"星系`);
    } else {
      console.log(`📌 按类型分类模式：没有可分配的星系（排除"其他"）`);
    }
  } else {
    // 其他分类模式下，正常分配空信息星球到所有星系
    const emptyPlanetsPerGalaxy = Math.floor(emptyPlanets.length / galaxies.length);
    const remainingEmptyPlanets = emptyPlanets.length % galaxies.length;
    
    // 为每个星系分配空信息星球
    let emptyPlanetIndex = 0;
    galaxies.forEach((galaxyKey, index) => {
      const count = emptyPlanetsPerGalaxy + (index < remainingEmptyPlanets ? 1 : 0);
      emptyPlanetsByGalaxy[galaxyKey] = emptyPlanets.slice(emptyPlanetIndex, emptyPlanetIndex + count);
      emptyPlanetIndex += count;
      console.log(`🌌 星系 "${galaxyKey}" 分配了 ${count} 个空信息星球`);
    });
  }
  // ================== 修改结束 ==================
  
  // 先计算所有星系的星球数量，用于归一化（只计算正常星球，不包括空信息星球）
  const clusterCounts = {};
  Object.keys(currentClusters).forEach(clusterKey => {
    const clusterData = normalData
      .map((d) => ({ ...d, group: getGroupValue(d) }))
      .filter((d) => d.group === clusterKey);
    clusterCounts[clusterKey] = clusterData.length;
  });
  
  // 找到最大和最小星球数（用于归一化）
  const counts = Object.values(clusterCounts).filter(c => c > 0);
  const minParticles = counts.length > 0 ? Math.min(...counts) : 1;
  const maxParticles = counts.length > 0 ? Math.max(...counts) : 100;
  
  console.log(`📊 星系星球数统计: 最小=${minParticles}, 最大=${maxParticles}`);
  
  // 计算每个星系的半径（用于碰撞检测，与buildCluster中的计算保持一致）
  const calculateClusterRadius = (particleCount) => {
    if (particleCount === 0) return 0;
    // 使用对数缩放，与buildCluster保持一致
    let normalizedCount;
    if (maxParticles > minParticles) {
      const logMin = Math.log(minParticles + 1);
      const logMax = Math.log(maxParticles + 1);
      const logCurrent = Math.log(particleCount + 1);
      normalizedCount = (logCurrent - logMin) / (logMax - logMin);
      // 确保最小归一化值至少是0.15，避免最小的星系太小
      normalizedCount = Math.max(normalizedCount, 0.15);
      normalizedCount = Math.min(normalizedCount, 1);
    } else {
      normalizedCount = 0.5;
    }
    const sizeFactor = Math.sqrt(normalizedCount); // 与buildCluster保持一致
    const minRadius = 50;
    const maxRadius = 400;
    const baseRadius = minRadius + sizeFactor * (maxRadius - minRadius);
    return baseRadius * 1.3; // 实际分布半径（与buildCluster中的clusterMaxRadius一致）
  };
  
  // 按星球数量排序，大星系在中心，小星系在外围
  const sortedClusters = Object.entries(currentClusters).sort((a, b) => {
    const countA = clusterCounts[a[0]] || 0;
    const countB = clusterCounts[b[0]] || 0;
    return countB - countA; // 降序排列，大星系在前
  });
  
  // 存储已放置的星系信息 {pos, radius}
  const placedGalaxies = [];
  const minSpacing = 279; // 星系之间的最小间距（缓冲距离），适当调大以减少重叠
  
  // 计算中心星系的半径（用于计算其他星系的初始距离）
  const centerRadius = sortedClusters.length > 0 
    ? calculateClusterRadius(clusterCounts[sortedClusters[0][0]] || 0)
    : 0;
  
  // 使用球面均匀分布算法（Fibonacci sphere）在中心星系周围均匀分布其他星系
  const fibonacciSphere = (index, total, radius) => {
    if (total <= 1) {
      // 如果只有一个星系，返回一个固定方向的位置
      return new THREE.Vector3(radius, 0, 0);
    }
    // 使用黄金角度（golden angle）实现球面均匀分布
    const goldenAngle = Math.PI * (3 - Math.sqrt(5)); // 约等于 2.399963229728653
    const theta = goldenAngle * index;
    const y = 1 - (index / (total - 1)) * 2; // y从1到-1
    const radiusAtY = Math.sqrt(1 - y * y);
    const x = Math.cos(theta) * radiusAtY;
    const z = Math.sin(theta) * radiusAtY;
    return new THREE.Vector3(x * radius, y * radius, z * radius);
  };
  
  // 重新分配位置：大星系在中心，其他星系在周围均匀分布
  sortedClusters.forEach(([clusterKey, config], index) => {
    const particleCount = clusterCounts[clusterKey] || 0;
    const clusterRadius = calculateClusterRadius(particleCount);
    
    let newPos;
    
    if (index === 0) {
      // 第一个（最大的）星系放在中心
      newPos = new THREE.Vector3(0, 0, 0);
    } else {
      // 其他星系在中心星系周围均匀分布
      const otherGalaxiesCount = sortedClusters.length - 1;
      const galaxyIndex = index - 1; // 从0开始
      
      // 计算最小安全距离：中心星系半径 + 当前星系半径 + 最小间距
      const minSafeDistance = centerRadius + clusterRadius + minSpacing;
      
      // 根据星系数量计算合适的分布半径
      // 确保有足够的空间，避免重叠
      const distributionRadius = Math.max(
        minSafeDistance,
        400 + (otherGalaxiesCount - 1) * 100 // 根据星系数量动态调整
      );
      
      // 使用Fibonacci sphere算法计算均匀分布的位置
      newPos = fibonacciSphere(galaxyIndex, otherGalaxiesCount, distributionRadius);
      
      // 检查并调整位置，确保不与已放置的星系重叠
      let attempts = 0;
      const maxAttempts = 50;
      let adjusted = false;
      
      while (attempts < maxAttempts) {
        let tooClose = false;
        let minRequiredDistance = 0;
        
        // 检查与所有已放置星系的距离
        for (const existing of placedGalaxies) {
          const distance = newPos.distanceTo(existing.pos);
          const requiredDistance = clusterRadius + existing.radius + minSpacing;
          
          if (distance < requiredDistance) {
            tooClose = true;
            minRequiredDistance = Math.max(minRequiredDistance, requiredDistance);
          }
        }
        
        if (!tooClose) {
          adjusted = true;
          break;
        }
        
        // 如果太近，沿远离中心的方向调整
        const direction = newPos.clone().normalize();
        const currentDistance = newPos.length();
        const newDistance = Math.max(currentDistance, minRequiredDistance + 50);
        newPos = direction.multiplyScalar(newDistance);
        
        attempts++;
      }
      
      // 如果调整失败，使用更远的距离
      if (!adjusted) {
        const safeDistance = distributionRadius + 200;
        newPos = fibonacciSphere(galaxyIndex, otherGalaxiesCount, safeDistance);
      }
    }
    
    // 记录已放置的星系
    placedGalaxies.push({
      pos: newPos.clone(),
      radius: clusterRadius
    });
    
    // 更新配置中的位置
    const updatedConfig = {
      ...config,
      pos: newPos
    };
    
    const distance = newPos.length();
    console.log(`📍 星系 "${clusterKey}": 星球数=${particleCount}, 半径=${clusterRadius.toFixed(0)}, 距离=${distance.toFixed(0)}`);
    
    // 直接构建星系，传入该星系分配的空信息星球和正常数据
    const emptyPlanetsForThisGalaxy = emptyPlanetsByGalaxy[clusterKey] || [];
    buildCluster(clusterKey, updatedConfig || {}, minParticles, maxParticles, emptyPlanetsForThisGalaxy, normalData);
  });
  
  console.log(`✅ 星系构建完成，星球数量: ${galaxyParticles.length}, 场景对象数: ${galaxyGroup.children.length}`);
  
  // 如果有待恢复的状态，在节点创建完成后恢复
  if (pendingRestoreState && nodeById.size > 0) {
    console.log('📋 节点创建完成，开始恢复状态');
    setTimeout(() => {
      restoreViewState();
    }, 100); // 稍微延迟，确保所有节点都已添加到场景
  } else {
    // 如果没有待恢复的状态，自动启动体验
    // 检查是否从开场页面进入（需要播放动画）
    const fromIntro = sessionStorage.getItem('fromIntro') === 'true';
    const hasSeenIntro = localStorage.getItem(INTRO_SEEN_KEY) === 'true';
    const hasSavedState = localStorage.getItem(HOME_STATE_KEY) !== null;
    
    if (!hasSavedState && !hasStartedExperience) {
      if (fromIntro) {
        // 从开场页面进入，清除标记，播放动画
        sessionStorage.removeItem('fromIntro');
        console.log('📋 从开场页面进入，将播放入场动画');
        skipIntroOnce = false; // 确保不跳过动画
      } else {
        console.log('📋 从其他页面返回，跳过入场动画');
        skipIntroOnce = true;
      }
      
      // 确保星系可见
      if (galaxyGroup) {
        galaxyGroup.visible = true;
      }
      setTimeout(() => {
        startExperience(false);
      }, 100);
    }
  }
}

function buildCluster(clusterKey, config, minParticlesGlobal = 1, maxParticlesGlobal = 100, emptyPlanetsForThisGalaxy = [], normalData = []) {
  const clusterGroup = new THREE.Group();
  const pos = config.pos || new THREE.Vector3(0, 0, 0);
  const rot = config.rot || [0, 0, 0];
  clusterGroup.position.copy(pos);
  clusterGroup.rotation.set(rot[0], rot[1], rot[2]);
  clusterGroup.userData = { isClusterCore: true, cluster: clusterKey };
  galaxyGroup.add(clusterGroup);

  // 只使用正常数据（不包括空信息星球）
  // 如果传入了normalData，直接使用；否则从processedData中过滤（向后兼容）
  const dataSource = normalData.length > 0 ? normalData : processedData;
  const clusterData = dataSource
    .map((d) => ({ ...d, group: getGroupValue(d) }))
    .filter((d) => d.group === clusterKey);
  const nodeSource = clusterData;
  const particleCount = nodeSource.length;
  
  // 检查是否有分配的空信息星球
  const hasEmptyPlanets = emptyPlanetsForThisGalaxy && emptyPlanetsForThisGalaxy.length > 0;

  // 如果没有正常星球也没有空信息星球，则不生成任何内容
  if (particleCount === 0 && !hasEmptyPlanets) {
    return;
  }
  
  // 如果只有空信息星球，没有正常星球，需要设置默认值
  if (particleCount === 0 && hasEmptyPlanets) {
    // 使用默认的最小值来计算星系大小
    const defaultMinParticles = 1;
    const defaultMaxParticles = 100;
    const emptyPlanetCount = emptyPlanetsForThisGalaxy.length;
    // 使用空信息星球数量来计算归一化值
    const normalizedCount = Math.min(emptyPlanetCount / defaultMaxParticles, 1);
    const sizeFactor = Math.sqrt(normalizedCount);
    
    // 设置基本的星系参数
    const minRadius = 50;
    const maxRadius = 400;
    const baseRadius = minRadius + sizeFactor * (maxRadius - minRadius);
    const clusterMaxRadius = baseRadius * 1.3;
    
    const minScale = 8;
    const maxScale = 20;
    const baseScale = minScale + sizeFactor * (maxScale - minScale);
    const scaleVariation = 3;
    
    // 直接添加空信息星球
    const emptyPlanetPositions = randomDistribution(emptyPlanetsForThisGalaxy.length, 0, clusterMaxRadius, 0.5);
    const baseColor = config.color || new THREE.Color(0x00bfff);
    const brightColor = new THREE.Color(
      Math.min(baseColor.r * 1.5, 1.0),
      Math.min(baseColor.g * 1.5, 1.0),
      Math.min(baseColor.b * 1.5, 1.0)
    );
    
    for (let i = 0; i < emptyPlanetsForThisGalaxy.length; i++) {
      const item = emptyPlanetsForThisGalaxy[i];
      const { x, y, z } = emptyPlanetPositions[i];
      
      const material = new THREE.SpriteMaterial({
        map: spriteMap,
        color: brightColor,
        transparent: true,
        opacity: isSwitchingMode ? 0 : 1.2,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      });
      const sprite = new THREE.Sprite(material);
      sprite.position.set(x, y, z);
      sprite.userData.targetPosition = new THREE.Vector3(x, y, z);
      
      const scale = baseScale + (Math.random() - 0.5) * scaleVariation;
      sprite.scale.set(scale, scale, 1);
      
      const nodeData = { 
        ...item, 
        group: clusterKey,
        name: item.name || `未命名星球 ${item.id}`,
        type: item.type || 'unknown',
        dynasty: item.dynasty || clusterKey
      };
      sprite.userData = { 
        isNode: true, 
        data: nodeData, 
        baseScale: scale, 
        baseColor: brightColor.clone(),
        isEmptyPlanet: true
      };
      galaxyParticles.push(sprite);
      // 使用数值和字符串两种形式的 key，方便通过字符串 ID 进行检索
      nodeById.set(nodeData.id, sprite);
      nodeById.set(String(nodeData.id), sprite);
      if (nodeData.kg_node_id) {
        nodeByKgNodeId.set(nodeData.kg_node_id, sprite);
      }
      clusterGroup.add(sprite);
    }
    
    // 添加星尘
    const minDust = 100;
    const maxDust = 800;
    const dustCount = Math.floor(minDust + sizeFactor * (maxDust - minDust));
    const dustGeo = new THREE.BufferGeometry();
    const dustPos = [];
    const dustColor = [];
    const dustMinRadius = 0;
    const dustMaxRadius = clusterMaxRadius * 1.1;
    
    for (let i = 0; i < dustCount; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const radiusFactor = Math.pow(Math.random(), 0.4);
      const radius = dustMinRadius + radiusFactor * (dustMaxRadius - dustMinRadius);
      const x = radius * Math.sin(phi) * Math.cos(theta);
      const y = radius * Math.sin(phi) * Math.sin(theta);
      const z = radius * Math.cos(phi);
      const noise = radius * 0.12;
      const finalX = x + (Math.random() - 0.5) * noise;
      const finalY = y + (Math.random() - 0.5) * noise;
      const finalZ = z + (Math.random() - 0.5) * noise;
      dustPos.push(finalX, finalY, finalZ);
      const color = config.color || new THREE.Color(0x00bfff);
      dustColor.push(color.r, color.g, color.b);
    }
    dustGeo.setAttribute('position', new THREE.Float32BufferAttribute(dustPos, 3));
    dustGeo.setAttribute('color', new THREE.Float32BufferAttribute(dustColor, 3));
    clusterGroup.add(
      new THREE.Points(
        dustGeo,
        new THREE.PointsMaterial({
          size: 40,
          transparent: true,
          opacity: 0.15,
          vertexColors: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          map: glowMap
        })
      )
    );
    
    console.log(`✨ 星系 "${clusterKey}" 只有空信息星球，添加了 ${emptyPlanetsForThisGalaxy.length} 个空信息星球`);
    return; // 只有空信息星球时，直接返回
  }

  // 根据星球数量动态调整星系大小
  // 使用全局最大最小值进行归一化，确保所有星系的大小对比明显
  // 归一化星球数量到 0-1 范围
  // 为了避免最小值的星系太小，使用对数缩放，并设置最小归一化值为0.15
  let normalizedCount;
  if (maxParticlesGlobal > minParticlesGlobal) {
    // 使用对数缩放，让大小差异更平滑
    const logMin = Math.log(minParticlesGlobal + 1);
    const logMax = Math.log(maxParticlesGlobal + 1);
    const logCurrent = Math.log(particleCount + 1);
    normalizedCount = (logCurrent - logMin) / (logMax - logMin);
    // 确保最小归一化值至少是0.15，避免最小的星系太小
    normalizedCount = Math.max(normalizedCount, 0.15);
    normalizedCount = Math.min(normalizedCount, 1);
  } else {
    // 如果所有星系数量相同，使用中间值
    normalizedCount = 0.5;
  }
  
  // 使用平方根函数，让大小变化更平滑但明显
  // 对于数量少的星系，sizeFactor 接近 0.39（sqrt(0.15)）；对于数量多的星系，sizeFactor 接近 1
  const sizeFactor = Math.sqrt(normalizedCount);
  
  // 星系半径范围：最小 50，最大 400（根据星球数量动态调整）
  // 数量少的星系（sizeFactor 小）半径接近 50，数量多的星系（sizeFactor 大）半径接近 400
  const minRadius = 50;
  const maxRadius = 400;
  const baseRadius = minRadius + sizeFactor * (maxRadius - minRadius);
  
  // 星球分布的最大半径（星系的实际大小）
  const clusterMaxRadius = baseRadius * 1.3; // 分布范围略大于基础半径
  
  // 星球大小：根据数量调整，数量多的星球稍大一些
  const minScale = 8; // 最小星球大小
  const maxScale = 20; // 最大星球大小
  const baseScale = minScale + sizeFactor * (maxScale - minScale);
  const scaleVariation = 3; // 大小变化范围（固定，避免差异过大）
  
  console.log(`🌌 星系 "${clusterKey}": 星球数=${particleCount}, 归一化=${normalizedCount.toFixed(2)}, 大小因子=${sizeFactor.toFixed(2)}, 半径=${baseRadius.toFixed(0)}, 最大半径=${clusterMaxRadius.toFixed(0)}`);

  // 使用随机分布，但使用更强的中心聚集效果
  // 星系大小由 clusterMaxRadius 控制，数量少的星系更小
  const positions = randomDistribution(particleCount, 0, clusterMaxRadius, 0.5); // 使用0.5的聚集度，让更多星球靠近中心

  for (let i = 0; i < particleCount; i++) {
    const item = nodeSource[i];
    const { x, y, z } = positions[i];

    // 增强星球亮度：使用更亮的颜色和更高的不透明度
    // 如果没有配置颜色，使用明显的青蓝色而不是白色
    const baseColor = config.color || new THREE.Color(0x00bfff);
    // 将颜色调亮 1.5 倍，让星球更明显
    const brightColor = new THREE.Color(
      Math.min(baseColor.r * 1.5, 1.0),
      Math.min(baseColor.g * 1.5, 1.0),
      Math.min(baseColor.b * 1.5, 1.0)
    );
    
    const material = new THREE.SpriteMaterial({
      map: spriteMap,
      color: brightColor,
      transparent: true,
      opacity: isSwitchingMode ? 0 : 1.2, // 切换模式时初始透明度为0，否则为1.2
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const sprite = new THREE.Sprite(material);
    sprite.position.set(x, y, z);
    sprite.userData.targetPosition = new THREE.Vector3(x, y, z);
    
    // 根据星球数量动态调整大小，星球越多，整体越大
    const scale = baseScale + (Math.random() - 0.5) * scaleVariation;
    sprite.scale.set(scale, scale, 1);

    if (i < nodeSource.length) {
      const nodeData = { ...item, group: clusterKey };
      // 保存原始颜色（使用增强后的亮度颜色）
      sprite.userData = { isNode: true, data: nodeData, baseScale: scale, baseColor: brightColor.clone() };
      galaxyParticles.push(sprite);
      // 使用数值和字符串两种形式的 key，方便通过字符串 ID 进行检索
      nodeById.set(nodeData.id, sprite);
      nodeById.set(String(nodeData.id), sprite);
      if (nodeData.kg_node_id) {
        nodeByKgNodeId.set(nodeData.kg_node_id, sprite);
      }
    }
    clusterGroup.add(sprite);
  }

  // ================== 添加空信息星球 ==================
  // 将分配的空信息星球添加到该星系，使用和正常星球相同的随机分布
  if (emptyPlanetsForThisGalaxy && emptyPlanetsForThisGalaxy.length > 0) {
    const emptyPlanetCount = emptyPlanetsForThisGalaxy.length;
    // 空信息星球使用和正常星球相同的分布方式（相同的半径和聚集度）
    // 使用相同的clusterMaxRadius和densityPower = 0.5，让它们随机分布
    const emptyPlanetPositions = randomDistribution(emptyPlanetCount, 0, clusterMaxRadius, 0.5);
    
    // 使用星系的颜色
    const baseColor = config.color || new THREE.Color(0x00bfff);
    const brightColor = new THREE.Color(
      Math.min(baseColor.r * 1.5, 1.0),
      Math.min(baseColor.g * 1.5, 1.0),
      Math.min(baseColor.b * 1.5, 1.0)
    );
    
    for (let i = 0; i < emptyPlanetCount; i++) {
      const item = emptyPlanetsForThisGalaxy[i];
      const { x, y, z } = emptyPlanetPositions[i];
      
      const material = new THREE.SpriteMaterial({
        map: spriteMap,
        color: brightColor,
        transparent: true,
        opacity: isSwitchingMode ? 0 : 1.2, // 使用和正常星球相同的不透明度
        blending: THREE.AdditiveBlending,
        depthWrite: false
      });
      const sprite = new THREE.Sprite(material);
      sprite.position.set(x, y, z);
      sprite.userData.targetPosition = new THREE.Vector3(x, y, z);
      
      // 空信息星球使用和正常星球相同的大小范围
      const scale = baseScale + (Math.random() - 0.5) * scaleVariation;
      sprite.scale.set(scale, scale, 1);
      
      // 为空信息星球创建基本数据
      const nodeData = { 
        ...item, 
        group: clusterKey,
        name: item.name || `未命名星球 ${item.id}`,
        type: item.type || 'unknown',
        dynasty: item.dynasty || clusterKey
      };
      sprite.userData = { 
        isNode: true, 
        data: nodeData, 
        baseScale: scale, 
        baseColor: brightColor.clone(),
        isEmptyPlanet: true // 标记为空信息星球
      };
      galaxyParticles.push(sprite);
      nodeById.set(nodeData.id, sprite);
      if (nodeData.kg_node_id) {
        nodeByKgNodeId.set(nodeData.kg_node_id, sprite);
      }
      clusterGroup.add(sprite);
    }
    
    console.log(`✨ 星系 "${clusterKey}" 添加了 ${emptyPlanetCount} 个空信息星球（随机分布）`);
  }
  // ================== 修改结束 ==================

  // 星尘粒子使用随机分布，与星球分布保持一致
  // 星尘数量也根据星球数量调整，数量少的星系星尘也少
  const minDust = 100; // 最小星尘数
  const maxDust = 800; // 最大星尘数
  const dustCount = Math.floor(minDust + sizeFactor * (maxDust - minDust));
  const dustGeo = new THREE.BufferGeometry();
  const dustPos = [];
  const dustColor = [];
  
  // 星尘分布范围与星球分布范围一致，保持紧凑
  // 星尘范围跟随星系大小，数量少的星系星尘也少
  const dustMinRadius = 0;
  const dustMaxRadius = clusterMaxRadius * 1.1; // 略大于星球范围，但不要太大
  
  for (let i = 0; i < dustCount; i++) {
    // 使用随机方向
    const theta = Math.random() * Math.PI * 2; // 方位角
    const phi = Math.acos(2 * Math.random() - 1); // 极角
    
    // 半径分布：使用更强的中心聚集效果
    const radiusFactor = Math.pow(Math.random(), 0.4); // 使用0.4，让星尘也更集中
    const radius = dustMinRadius + radiusFactor * (dustMaxRadius - dustMinRadius);
    
    // 转换为直角坐标
    const x = radius * Math.sin(phi) * Math.cos(theta);
    const y = radius * Math.sin(phi) * Math.sin(theta);
    const z = radius * Math.cos(phi);
    
    // 减小随机扰动，保持集中
    const noise = radius * 0.12; // 扰动幅度为半径的12%（之前是20%）
    const finalX = x + (Math.random() - 0.5) * noise;
    const finalY = y + (Math.random() - 0.5) * noise;
    const finalZ = z + (Math.random() - 0.5) * noise;
    
    dustPos.push(finalX, finalY, finalZ);
    
    // 使用原始星尘颜色（不增强亮度，避免显得乱）
    // 如果没有配置颜色，使用明显的青蓝色而不是白色
    const color = config.color || new THREE.Color(0x00bfff);
    dustColor.push(color.r, color.g, color.b);
  }
  dustGeo.setAttribute('position', new THREE.Float32BufferAttribute(dustPos, 3));
  dustGeo.setAttribute('color', new THREE.Float32BufferAttribute(dustColor, 3));
  clusterGroup.add(
    new THREE.Points(
      dustGeo,
      new THREE.PointsMaterial({
        size: 40, // 恢复原始星尘粒子大小
        transparent: true,
        opacity: 0.15, // 恢复原始不透明度，保持低调
        vertexColors: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        map: glowMap
      })
    )
  );
}

// 随机分布函数：在3D空间中随机分布，中心密集，外围稀疏
// densityPower: 密度指数，值越小（如0.3），中心越密集；值越大（如1.0），分布越均匀
function randomDistribution(count, minRadius, maxRadius, densityPower = 1/3) {
  const pts = [];
  
  for (let i = 0; i < count; i++) {
    // 使用随机方向
    const theta = Math.random() * Math.PI * 2; // 方位角 0-2π
    const phi = Math.acos(2 * Math.random() - 1); // 极角，确保球面均匀分布
    
    // 半径分布：使用可调节的密度分布，让中心更密集
    // densityPower越小，中心越密集（如0.3比1/3更密集）
    const radiusFactor = Math.pow(Math.random(), densityPower);
    const radius = minRadius + radiusFactor * (maxRadius - minRadius);
    
    // 转换为直角坐标
    const x = radius * Math.sin(phi) * Math.cos(theta);
    const y = radius * Math.sin(phi) * Math.sin(theta);
    const z = radius * Math.cos(phi);
    
    // 减小随机扰动，让分布更集中
    const noise = radius * 0.1; // 扰动幅度为半径的10%（之前是15%）
    const finalX = x + (Math.random() - 0.5) * noise;
    const finalY = y + (Math.random() - 0.5) * noise;
    const finalZ = z + (Math.random() - 0.5) * noise;
    
    pts.push({ x: finalX, y: finalY, z: finalZ });
  }
  
  return pts;
}

// 类球形分布：使用 Fibonacci sphere 算法，中心密集，外围稀疏（保留用于星尘）
function vogelSpiral(count, radius = 300, thickness = 80) {
  const pts = [];
  const goldenAngle = Math.PI * (3 - Math.sqrt(5)); // 黄金角度，用于均匀分布
  
  for (let i = 0; i < count; i++) {
    // 使用 Fibonacci sphere 算法生成均匀的球面分布
    const y = 1 - (i / (count - 1)) * 2; // y从-1到1均匀分布
    const r = Math.sqrt(1 - y * y); // 在y高度处的圆半径
    
    // 黄金角度旋转，确保均匀分布
    const theta = goldenAngle * i;
    
    // 在球面上的基础位置
    const x = r * Math.cos(theta);
    const z = r * Math.sin(theta);
    
    // 添加随机扰动，让分布更自然
    const noise = 0.12; // 扰动系数
    const nx = x + (Math.random() - 0.5) * noise;
    const ny = y + (Math.random() - 0.5) * noise;
    const nz = z + (Math.random() - 0.5) * noise;
    
    // 归一化
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    
    // 半径分布：中心密集，外围稀疏（使用平方根分布）
    const t = i / count;
    const densityFactor = 0.4 + t * 0.6; // 从40%到100%的半径范围
    const finalRadius = radius * densityFactor;
    
    // 最终位置
    const finalX = (nx / len) * finalRadius;
    const finalY = (ny / len) * finalRadius;
    const finalZ = (nz / len) * finalRadius;
    
    pts.push({ x: finalX, y: finalY, z: finalZ });
  }
  
  return pts;
}

// 重新编写的模式切换功能
function setupModeSwitcher() {
  // 等待 DOM 加载完成
  const initSelector = () => {
    const selector = document.getElementById('cluster-mode');
    if (!selector) {
      console.warn('⚠️ 未找到 cluster-mode 选择器');
      return false;
    }
    
    // 设置初始值
    selector.value = currentClusterMode;
    
    // 直接绑定 change 事件，不使用任何包装
    selector.onchange = function(e) {
      const newMode = this.value;
      console.log(`🔄 模式切换事件触发: ${newMode}`);
      
      if (newMode === currentClusterMode) {
        console.log('⚠️ 模式未变化，忽略');
        return;
      }
      
      if (!clusterPresets[newMode]) {
        console.error(`❌ 无效的模式: ${newMode}`);
        this.value = currentClusterMode; // 恢复原值
        return;
      }
      
      // 检查类型模式的集群是否已生成
      if (newMode === 'type' && Object.keys(clusterPresets.type.clusters).length === 0) {
        console.warn('⚠️ 类型模式集群尚未生成，尝试重新生成...');
        if (processedData.length > 0) {
          clusterPresets.type.clusters = generateTypeClusters(processedData);
          console.log(`✅ 重新生成了 ${Object.keys(clusterPresets.type.clusters).length} 个类型星系配置`);
        } else {
          console.error('❌ 无法切换到类型模式：数据尚未加载');
          showFeedback('数据加载中，请稍候再试');
          this.value = currentClusterMode; // 恢复原值
          return;
        }
      }
      
      // 执行模式切换
      switchClusterMode(newMode);
    };
    
    console.log(`✅ 模式切换器已初始化，当前模式: ${currentClusterMode}`);
    return true;
  };
  
  // 立即尝试初始化
  if (!initSelector()) {
    // 如果失败，延迟重试
    setTimeout(() => {
      if (!initSelector()) {
        console.error('❌ 模式切换器初始化失败');
      }
    }, 200);
  }
}

function setupBackButton() {
  // 等待 DOM 加载完成
  const initButton = () => {
    const backBtn = document.getElementById('back-btn');
    if (!backBtn) {
      console.warn('⚠️ 未找到 back-btn 按钮');
      return false;
    }
    
    // 找到按钮元素（back-btn 是 div，里面的 button 才是实际按钮）
    const button = backBtn.querySelector('button');
    if (!button) {
      console.warn('⚠️ 未找到 back-btn 内的 button 元素');
      return false;
    }
    
    // 绑定点击事件
    button.onclick = function(e) {
      e.preventDefault();
      e.stopPropagation();
      console.log('🔄 点击返回星系全景按钮');
      resetView();
    };
    
    console.log('✅ 返回按钮已初始化');
    return true;
  };
  
  // 立即尝试初始化
  if (!initButton()) {
    // 如果失败，延迟重试
    setTimeout(() => {
      if (!initButton()) {
        console.error('❌ 返回按钮初始化失败');
      }
    }, 200);
  }
}

function switchClusterMode(mode) {
  console.log(`🔄 开始切换模式: ${currentClusterMode} -> ${mode}`);
  
  // 更新模式变量
  const oldMode = currentClusterMode;
  currentClusterMode = mode;
  currentClusters = clusterPresets[mode].clusters;
  
  // 确保选择器的值正确更新
  const selector = document.getElementById('cluster-mode');
  if (selector) {
    selector.value = mode;
    console.log(`🔄 选择器值已更新为: ${mode}`);
  }
  
  // 清除所有状态
  currentFocusCluster = null;
  lockedNode = null;
  enteredFromGlobalView = false;
  clearHighlights();
  closePreview();
  
  console.log(`📊 新模式集群数: ${Object.keys(currentClusters).length}`);
  console.log(`📊 集群列表:`, Object.keys(currentClusters));
  
  // ===== 添加增强的淡出动画 =====
  if (galaxyParticles.length > 0) {
    // 淡出当前星系的所有粒子，并添加缩放和旋转效果
    const fadeOutDuration = 1200; // 1200ms 淡出（更长）
    const scaleOutDuration = 1000; // 1000ms 缩放
    
    // 先整体缩小星系
    new TWEEN.Tween(galaxyGroup.scale)
      .to({ x: 0.3, y: 0.3, z: 0.3 }, scaleOutDuration)
      .easing(TWEEN.Easing.Cubic.In)
      .start();
    
    // 粒子淡出并扩散
    galaxyParticles.forEach((sprite, index) => {
      if (sprite.material) {
        const delay = (index % 80) * 8; // 更长的错峰时间
        
        // 淡出
        new TWEEN.Tween(sprite.material)
          .to({ opacity: 0 }, fadeOutDuration)
          .delay(delay)
          .easing(TWEEN.Easing.Quadratic.Out)
          .start();
        
        // 粒子向外扩散
        const originalPos = sprite.position.clone();
        const spreadDirection = originalPos.clone().normalize();
        const spreadDistance = 200 + Math.random() * 300;
        const targetPos = originalPos.clone().add(spreadDirection.multiplyScalar(spreadDistance));
        
        new TWEEN.Tween(sprite.position)
          .to({ x: targetPos.x, y: targetPos.y, z: targetPos.z }, fadeOutDuration)
          .delay(delay)
          .easing(TWEEN.Easing.Cubic.Out)
          .start();
      }
    });
    
    // 淡出完成后重建星系
    setTimeout(() => {
      // 设置切换模式标志
      isSwitchingMode = true;
      
      // 重置视图（不移动相机）
      resetView(true);
      
      // 重置星系缩放
      galaxyGroup.scale.set(0.1, 0.1, 0.1);
      
      // 重新构建星系（新粒子初始透明度为0）
      console.log(`🏗️ 开始重新构建星系...`);
      buildGalaxy();
      
      // 淡入新星系（带缩放和旋转效果）
      fadeInNewGalaxy();
      
      // 重置标志
      isSwitchingMode = false;
    }, fadeOutDuration + 200);
  } else {
    // 如果没有现有粒子，直接重建
    isSwitchingMode = true;
    galaxyGroup.scale.set(0.1, 0.1, 0.1);
    resetView(true);
    buildGalaxy();
    fadeInNewGalaxy();
    isSwitchingMode = false;
  }
  
  // 显示反馈
  const modeLabel = mode === 'dynasty' ? '朝代' : '类型';
  showFeedback(`已切换到${modeLabel}模式`);
  
  console.log(`✅ 模式切换完成: ${oldMode} -> ${mode}`);
}

// 淡入新星系的动画（增强版）
function fadeInNewGalaxy() {
  if (galaxyParticles.length === 0) return;
  
  const fadeInDuration = 1500; // 1500ms 淡入（更长）
  const scaleInDuration = 1800; // 1800ms 缩放动画
  
  // 整体缩放动画：从很小放大到正常大小
  new TWEEN.Tween(galaxyGroup.scale)
    .to({ x: 1, y: 1, z: 1 }, scaleInDuration)
    .easing(TWEEN.Easing.Elastic.Out) // 弹性效果，更有冲击力
    .start();
  
  // 添加轻微旋转效果
  const originalRotation = { x: galaxyGroup.rotation.x, y: galaxyGroup.rotation.y, z: galaxyGroup.rotation.z };
  galaxyGroup.rotation.set(originalRotation.x + 0.5, originalRotation.y + 0.3, originalRotation.z);
  new TWEEN.Tween(galaxyGroup.rotation)
    .to({ x: originalRotation.x, y: originalRotation.y, z: originalRotation.z }, scaleInDuration)
    .easing(TWEEN.Easing.Cubic.Out)
    .start();
  
  // 粒子淡入并带有从中心向外扩散的效果
  galaxyParticles.forEach((sprite, index) => {
    if (sprite.material) {
      // 初始状态：透明度为0，位置在中心附近
      sprite.material.opacity = 0;
      sprite.material.needsUpdate = true;
      
      const targetPos = sprite.position.clone();
      const centerDistance = targetPos.length();
      
      // 从中心向外扩散的起始位置
      const startPos = targetPos.clone().multiplyScalar(0.2);
      sprite.position.copy(startPos);
      
      // 错峰淡入，创造从中心向外扩散的效果
      const delay = Math.min((index % 120) * 10, 600); // 更长的错峰时间
      
      // 淡入动画
      new TWEEN.Tween(sprite.material)
        .to({ opacity: 1.2 }, fadeInDuration)
        .delay(delay)
        .easing(TWEEN.Easing.Cubic.In)
        .start();
      
      // 位置动画：从中心扩散到目标位置
      new TWEEN.Tween(sprite.position)
        .to({ x: targetPos.x, y: targetPos.y, z: targetPos.z }, fadeInDuration + 300)
        .delay(delay)
        .easing(TWEEN.Easing.Elastic.Out)
        .start();
      
      // 缩放动画：从小变大
      const originalScale = sprite.scale.x;
      sprite.scale.set(0.1, 0.1, 1);
      new TWEEN.Tween(sprite.scale)
        .to({ x: originalScale, y: originalScale, z: 1 }, fadeInDuration)
        .delay(delay)
        .easing(TWEEN.Easing.Back.Out)
        .start();
    }
  });
}

function initPreview3D() {
  const container = document.getElementById('ip-3d-container');
  if (!container || container.clientWidth === 0 || isPreviewInit) return;

  previewScene = new THREE.Scene();
  previewCamera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 1000);
  previewCamera.position.set(0, 40, 80);

  previewRenderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  previewRenderer.setSize(container.clientWidth, container.clientHeight);
  previewRenderer.outputEncoding = THREE.sRGBEncoding;
  container.appendChild(previewRenderer.domElement);

  const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 1.2);
  hemiLight.position.set(0, 200, 0);
  previewScene.add(hemiLight);

  const dirLight = new THREE.DirectionalLight(0xffffff, 2.5);
  dirLight.position.set(20, 20, 50);
  previewScene.add(dirLight);

  previewControls = new THREE.OrbitControls(previewCamera, previewRenderer.domElement);
  previewControls.autoRotate = true;
  previewControls.enableDamping = true;
  isPreviewInit = true;
}

function resizePreview() {
  const container = document.getElementById('ip-3d-container');
  if (previewCamera && previewRenderer && container && container.clientWidth > 0) {
    previewCamera.aspect = container.clientWidth / container.clientHeight;
    previewCamera.updateProjectionMatrix();
    previewRenderer.setSize(container.clientWidth, container.clientHeight);
  }
}

function loadModel(url) {
  if (!previewScene) return;
  if (currentModel) {
    previewScene.remove(currentModel);
    currentModel = null;
  }

  const loadingEl = document.getElementById('ip-3d-loading');
  if (loadingEl) {
    loadingEl.style.display = 'flex';
    loadingEl.innerText = 'LOADING MODEL...';
  }

  const dracoLoader = new THREE.DRACOLoader();
  dracoLoader.setDecoderPath('https://unpkg.com/three@0.128.0/examples/js/libs/draco/');

  const loader = new THREE.GLTFLoader();
  loader.setDRACOLoader(dracoLoader);

  // 处理相对路径：如果是相对路径，尝试从 assets/models/ 目录加载
  let modelUrl = url;
  if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('/')) {
    // 相对路径，尝试多个可能的位置
    modelUrl = `../assets/models/${url}`;
  }
  
  loader.load(
    modelUrl,
    (gltf) => {
      currentModel = gltf.scene;
      const box = new THREE.Box3().setFromObject(currentModel);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      currentModel.position.sub(center);
      const maxDim = Math.max(size.x, size.y, size.z);
      const scale = 40 / (maxDim || 1);
      currentModel.scale.set(scale, scale, scale);
      previewScene.add(currentModel);
      if (loadingEl) loadingEl.style.display = 'none';
      console.log(`✅ 3D 模型加载成功: ${modelUrl}`);
    },
    (progress) => {
      // 加载进度回调
      if (progress.lengthComputable) {
        const percentComplete = (progress.loaded / progress.total) * 100;
        if (loadingEl) {
          loadingEl.innerText = `LOADING MODEL... ${Math.round(percentComplete)}%`;
        }
      }
    },
    (error) => {
      console.warn(`⚠️ 3D 模型加载失败: ${modelUrl}`, error);
      console.log('使用备用模型显示');
      createFallbackModel();
      if (loadingEl) loadingEl.style.display = 'none';
    }
  );
}

export function toggle3DRotation() {
  if (!previewControls) return;
  previewControls.autoRotate = !previewControls.autoRotate;
  const icon = document.getElementById('icon-rotate');
  if (icon) icon.className = previewControls.autoRotate ? 'fas fa-pause' : 'fas fa-play';
}

function createFallbackModel() {
  if (!previewScene) return;
  const geometry = new THREE.BoxGeometry(20, 20, 20);
  const material = new THREE.MeshBasicMaterial({
    color: 0xd4af37,
    wireframe: true,
    transparent: true,
    opacity: 0.6
  });
  currentModel = new THREE.Mesh(geometry, material);
  const inner = new THREE.Mesh(new THREE.SphereGeometry(8, 16, 16), new THREE.MeshBasicMaterial({ color: 0xffaa00, wireframe: true }));
  currentModel.add(inner);
  previewScene.add(currentModel);
}

function createStarBackground() {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 1024;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, 1024, 1024);
  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < 1500; i++) {
    const x = Math.random() * 1024;
    const y = Math.random() * 1024;
    const r = Math.random() * 1.2;
    const alpha = Math.random();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  return new THREE.CanvasTexture(canvas);
}

function generateSharpSpriteTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.3, 'rgba(255,255,255,0.8)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.2)');
  grad.addColorStop(1, 'transparent');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  return canvas.toDataURL();
}

function createGlowTexture(color) {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, `rgba(${color.r * 255},${color.g * 255},${color.b * 255},0.6)`);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(canvas);
}

function onResize() {
  if (!camera || !renderer) return;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function onMouseMove(event) {
  if (!raycaster || !camera) return;
  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObjects(galaxyParticles);
  document.body.style.cursor = intersects.length > 0 ? 'pointer' : 'default';
}

function onClick(event) {
  if (!raycaster || !camera) return;
  
  // 如果点击的是按钮或其他交互元素，不处理星球点击
  if (event && event.target) {
    const targetElement = event.target;
    // 检查是否是按钮、链接或其他交互元素
    if (targetElement.tagName === 'BUTTON' || 
        targetElement.tagName === 'A' || 
        targetElement.closest('button') || 
        targetElement.closest('a') ||
        targetElement.closest('#preview-panel')) {
      return;
    }
  }
  
  if (suppressNextClick) {
    suppressNextClick = false;
    return;
  }
  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObjects(galaxyParticles);

  if (intersects.length > 0) {
    const target = intersects[0].object;
    if (!target.userData.isNode) return;

    const clickedCluster = target.userData.data.group;
    if (!clickedCluster) return;

    // 如果已经有锁定的节点，且点击的不是同一个节点，则阻止点击
    if (lockedNode && lockedNode !== target) {
      showFeedback('请先退出当前星球聚焦');
      return;
    }

    // 如果在全局视图，第一次点击星球应该直接聚焦到该星球（而不是先聚焦到星系）
    if (currentFocusCluster === null) {
      // 标记是从全局视图进入的
      enteredFromGlobalView = true;
      // 先设置 currentFocusCluster，这样 handleStarClick 可以正常工作
      currentFocusCluster = clickedCluster;
      // 设置 UI 状态（隐藏 hero，显示 backBtn）
      const hero = document.getElementById('home-content');
      const backBtn = document.getElementById('back-btn');
      if (hero) {
        hero.style.opacity = '0';
        hero.style.pointerEvents = 'none';
      }
      if (backBtn) {
        backBtn.style.opacity = '1';
        backBtn.style.pointerEvents = 'auto';
      }
      // 直接调用 handleStarClick 来聚焦到星球
      handleStarClick(target, false);
      return;
    }

    // 如果已经在某个星系中，则处理星球点击
    handleStarClick(target, false);
  }
}

function onDoubleClick() {
  if (!raycaster || !camera) return;
  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObjects(galaxyParticles);
  if (intersects.length > 0) {
    const target = intersects[0].object;
    if (target.userData.isNode) {
      const entityId = target.userData.data.id;
      if (entityId) {
        navigateToIP(entityId);
      }
    }
  }
}

function handleStarClick(target, isDouble) {
  if (!target.userData.isNode) return;

  const clickedCluster = target.userData.data.group;

  // 新增：锁定逻辑检查 - 如果已经锁定了一个节点，且点击的不是同一个节点，则阻止
  if (lockedNode && lockedNode !== target) {
    showFeedback('请先退出当前星球聚焦');
    return;
  }
  if (!clickedCluster) return;

  // 如果已经锁定了一个节点，且点击的是同一个节点，则忽略（避免重复聚焦）
  if (lockedNode === target) {
    return;
  }

  // 如果已经在某个星系中，且点击了另一个星系的星球
  if (currentFocusCluster !== null && clickedCluster !== currentFocusCluster) {
    // 如果没有锁定节点（即已经退出聚焦），应该直接聚焦到新星球，而不是切换星系
    if (!lockedNode) {
      // 更新 currentFocusCluster 并直接聚焦到新星球
      currentFocusCluster = clickedCluster;
      enteredFromGlobalView = false; // 标记不是从全局视图进入的
      // 设置 UI 状态
      const hero = document.getElementById('home-content');
      const backBtn = document.getElementById('back-btn');
      if (hero) {
        hero.style.opacity = '0';
        hero.style.pointerEvents = 'none';
      }
      if (backBtn) {
        backBtn.style.opacity = '1';
        backBtn.style.pointerEvents = 'auto';
      }
      // 直接聚焦到新星球
      focusOnNode(target);
      return;
    }
    // 如果有锁定节点，则切换星系（这种情况不应该发生，因为上面已经检查了 lockedNode）
    lockedNode = null; // 解除任何节点锁定
    clearHighlights();
    focusOnCluster(clickedCluster);
    // 保持被点击星球的点亮状态（切换星系后仍高亮）
    highlightNode(target);
    showFeedback(`进入星系: ${clickedCluster}`);
    return;
  }

  // 如果我们已经在当前星系中，单击星球会聚焦到该星球
  if (currentFocusCluster !== null && !isDouble) {
    console.log('📍 在当前星系中点击星球，聚焦到节点');
    // 聚焦节点（会高亮节点并打开预览面板）
    focusOnNode(target);
    return;
  }

  // 如果不在星系中，只高亮节点
  highlightNode(target);

  // 双击时，确保聚焦并打开详情页（虽然部分逻辑已在单击时处理）
  if (isDouble) {
    focusOnNode(target);
    const entityId = target.userData.data.id;
    if (entityId) {
      navigateToIP(entityId);
    }
  }
}

function focusOnNode(sprite, clearPreviousHighlight = true) {
  if (!sprite || !sprite.userData.isNode) {
    console.warn('focusOnNode: 无效的节点');
    return;
  }
  
  lockedNode = sprite; // 锁定当前节点

  // 停止所有正在进行的动画，避免冲突
  TWEEN.getAll().forEach(tween => tween.stop());
  
  controls.autoRotate = false;
  const hero = document.getElementById('home-content');
  const backBtn = document.getElementById('back-btn');
  if (hero) {
    hero.style.opacity = '0';
    // 关键修复：在聚焦后关闭主内容的指针事件，避免透明覆盖层拦截点击
    hero.style.pointerEvents = 'none';
  }
  if (backBtn) {
    backBtn.style.opacity = '1';
    backBtn.style.pointerEvents = 'auto';
  }

  const targetPos = new THREE.Vector3();
  sprite.getWorldPosition(targetPos);
  const camOffset = targetPos.clone().add(new THREE.Vector3(0, 50, 400)); // 增加Z轴距离，看得更广
  
  console.log(`📹 聚焦到节点 "${sprite.userData.data.name}": 目标位置 (${targetPos.x.toFixed(0)}, ${targetPos.y.toFixed(0)}, ${targetPos.z.toFixed(0)}), 相机偏移 (${camOffset.x.toFixed(0)}, ${camOffset.y.toFixed(0)}, ${camOffset.z.toFixed(0)})`);
  
  const cameraTween = new TWEEN.Tween(camera.position)
    .to({ x: camOffset.x, y: camOffset.y, z: camOffset.z }, 1500)
    .easing(TWEEN.Easing.Cubic.InOut)
    .onUpdate(() => {
      controls.update();
    })
    .onComplete(() => {
      console.log('✅ 相机已移动到目标位置');
    });
  
  const targetTween = new TWEEN.Tween(controls.target)
    .to({ x: targetPos.x, y: targetPos.y, z: targetPos.z }, 1500)
    .easing(TWEEN.Easing.Cubic.InOut)
    .onUpdate(() => {
      controls.update();
    })
    .onComplete(() => {
      console.log('✅ 目标已移动到节点位置');
    });
  
  cameraTween.start();
  targetTween.start();
  
  highlightNode(sprite, clearPreviousHighlight); // 传递参数控制是否清除之前的高亮
  openPreview(sprite.userData.data);
}

// 聚焦节点但不重新高亮（用于从IP详情页面返回时）
function focusOnNodeWithoutHighlight(sprite) {
  lockedNode = sprite; // 锁定当前节点

  controls.autoRotate = false;
  const hero = document.getElementById('home-content');
  const backBtn = document.getElementById('back-btn');
  if (hero) {
    hero.style.opacity = '0';
    hero.style.pointerEvents = 'none';
  }
  if (backBtn) {
    backBtn.style.opacity = '1';
    backBtn.style.pointerEvents = 'auto';
  }

  const targetPos = new THREE.Vector3();
  sprite.getWorldPosition(targetPos);
  // 不移动相机，因为已经在正确位置了
  controls.target.set(targetPos.x, targetPos.y, targetPos.z);
  controls.update();
  openPreview(sprite.userData.data);
}

function focusOnCluster(dynasty) {
  if (!controls || !camera) return;
  controls.autoRotate = false;
  currentFocusCluster = dynasty;
  enteredFromGlobalView = false; // 从星系聚焦进入，不是从全局视图
  
  const hero = document.getElementById('home-content');
  const backBtn = document.getElementById('back-btn');
  if (hero) {
    hero.style.opacity = '0';
    // 关键修复：进入某个星系后，关闭主内容层的点击，避免拦截对其他星系/星球的点击
    hero.style.pointerEvents = 'none';
  }
  if (backBtn) {
    backBtn.style.opacity = '1';
    backBtn.style.pointerEvents = 'auto';
  }

  const config = currentClusters[dynasty];
  if (!config) return;
  
  const targetPos = config.pos.clone();
  const camOffset = targetPos.clone().add(new THREE.Vector3(0, 200, 1200)); // 增加Z轴距离，看得更广
  new TWEEN.Tween(camera.position).to(camOffset, 2000).easing(TWEEN.Easing.Cubic.InOut).start();
  new TWEEN.Tween(controls.target).to(targetPos, 2000).easing(TWEEN.Easing.Cubic.InOut).start();
}

export function exitNodeFocus(event) {
  // 阻止事件冒泡，避免触发星球点击
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  
  if (!lockedNode || !camera || !controls) return;

  // 解除锁定，关闭预览，清除高亮，这样才能点击其他星球
  const lockedClusterGroup = lockedNode.userData.data.group;
  lockedNode = null; // 解除锁定，允许点击其他星球
  closePreview(); // 关闭预览面板
  clearHighlights(); // 清除高亮
  
  // 如果是从全局视图进入的，退出聚焦后应该回到全局视图状态
  // 否则保持当前的星系聚焦状态
  if (enteredFromGlobalView) {
    currentFocusCluster = null;
    enteredFromGlobalView = false;
  }
  // 注意：如果不是从全局视图进入的，保持 currentFocusCluster 不变，这样用户仍然在星系视图中
  
  // 停止所有正在进行的 Tween 动画
  TWEEN.getAll().forEach(tween => tween.stop());
  
  // 启用自动旋转，并设置较慢的旋转速度
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.04; // 设置更慢的旋转速度
  
  // 退出聚焦时保持相机状态不变（不移动相机、不改变目标、不改变FOV）
  // 只清除锁定状态，让用户可以继续交互
  
  console.log(`📹 退出聚焦: 解除锁定，保持当前相机状态，当前聚焦状态 ${currentFocusCluster || '全局视图'}`);
}

export function resetView(skipCamera = false) {
  // 清除所有高亮和连线
  clearHighlights();
  
  // 清除锁定状态
  lockedNode = null;
  
  // 关闭预览面板
  closePreview();
  
  // 清除聚焦的星系
  currentFocusCluster = null;
  enteredFromGlobalView = false; // 重置标志
  
  // 更新 UI 状态
  const hero = document.getElementById('home-content');
  const backBtn = document.getElementById('back-btn');
  if (hero) {
    hero.style.opacity = '1';
    hero.style.pointerEvents = 'auto';
  }
  if (backBtn) {
    backBtn.style.opacity = '0';
    backBtn.style.pointerEvents = 'none';
  }
  
  // 重置镜头和控制器
  if (!controls || !camera) return;
  
  // 启用自动旋转，并设置较慢的旋转速度
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.04; // 设置更慢的旋转速度
  
  // 重置镜头到初始位置，并扩大视野
  if (!skipCamera) {
    // 停止所有正在进行的 Tween 动画
    TWEEN.getAll().forEach(tween => tween.stop());
    
    // 返回时的相机位置和目标位置（拉得更远以获得更广的全景视野）
    const returnCameraPos = new THREE.Vector3(0, 1000, 2400); // 比默认位置更远：y从800增加到1000，z从1600增加到2400
    const returnTargetPos = defaultTarget.clone();
    
    // 同时平滑移动相机和目标位置，避免产生分割感
    const animationDuration = 3000; // 增加动画时长，让移动更平滑
    
    // 平滑移动目标位置到中心
    const targetTween = new TWEEN.Tween(controls.target)
      .to({ x: returnTargetPos.x, y: returnTargetPos.y, z: returnTargetPos.z }, animationDuration)
      .easing(TWEEN.Easing.Quadratic.InOut) // 使用更平滑的缓动函数
      .onUpdate(() => {
        controls.update();
      });
    
    // 平滑移动相机到默认位置
    const cameraTween = new TWEEN.Tween(camera.position)
      .to({ x: returnCameraPos.x, y: returnCameraPos.y, z: returnCameraPos.z }, animationDuration)
      .easing(TWEEN.Easing.Quadratic.InOut) // 使用相同的缓动函数，保持同步
      .onUpdate(() => {
        controls.update();
      })
      .onComplete(() => {
        console.log('✅ 相机和目标位置已平滑返回到默认位置');
      });
    
    // 同时启动两个动画，确保同步移动
    targetTween.start();
    cameraTween.start();
    
    console.log(`📹 镜头平滑返回全景: 位置 ${returnCameraPos.x}, ${returnCameraPos.y}, ${returnCameraPos.z}, FOV: ${camera.fov}°`);
  }
  
  console.log('✅ 已重置所有状态并返回星系全景');
}

function animate() {
  requestAnimationFrame(animate);
  TWEEN.update();
  if (controls) controls.update();
  if (previewRenderer && document.getElementById('ip-3d-container')?.style.display === 'block') {
    previewControls.update();
    previewRenderer.render(previewScene, previewCamera);
  }
  if (galaxyGroup) {
    galaxyGroup.scale.x = THREE.MathUtils.lerp(galaxyGroup.scale.x, globalScale, 0.1);
    galaxyGroup.scale.y = THREE.MathUtils.lerp(galaxyGroup.scale.y, globalScale, 0.1);
    galaxyGroup.scale.z = THREE.MathUtils.lerp(galaxyGroup.scale.z, globalScale, 0.1);
  }
  if (renderer && scene && camera) renderer.render(scene, camera);
}

function updateHistoryUI() {
  const lastDataStr = localStorage.getItem('lastVisitedIP');
  const contentEl = document.getElementById('history-content');
  if (lastDataStr && contentEl) {
    const lastData = JSON.parse(lastDataStr);
    contentEl.innerHTML = `${lastData.name} <span class="text-xs font-tech text-yellow-500 ml-2 border border-yellow-500/30 px-1 rounded">${lastData.group}</span>`;
  }
}

export function openIPDetail(data) {
  localStorage.setItem('lastVisitedIP', JSON.stringify(data));
  updateHistoryUI();
  const title = document.getElementById('ip-title');
  const desc = document.getElementById('ip-desc');
  const dynasty = document.getElementById('ip-dynasty');
  const coords = document.getElementById('ip-coords');
  const tagsEl = document.getElementById('ip-tags');
  const metaEl = document.getElementById('ip-meta');
  const detailEl = document.getElementById('ip-detail');
  if (title) title.innerText = data.name;
  if (desc) desc.innerText = data.desc || data.description || '暂无描述';
  
  // 显示朝代信息
  const dynastyName = data.dynasty || data.group || '未知';
  if (dynasty) dynasty.innerText = `${dynastyName} DYNASTY`;
  
  // 显示坐标
  if (coords) {
    const lat = data.lat || (data.detail?.lat);
    const lng = data.lng || (data.detail?.lng);
    coords.innerText = lat && lng ? `${lat.toFixed(4)} N, ${lng.toFixed(4)} E` : '暂无坐标';
  }

  // 显示标签
  if (tagsEl) {
    tagsEl.innerHTML = '';
    const tags = Array.isArray(data.tags) ? data.tags : [];
    if (tags.length > 0) {
      tags.forEach((t) => {
        const chip = document.createElement('span');
        chip.className = 'px-2 py-1 border border-yellow-400/40 rounded-full text-xs';
        chip.innerText = t;
        tagsEl.appendChild(chip);
      });
    } else {
      tagsEl.innerHTML = '<span class="text-gray-500 text-xs">暂无标签</span>';
    }
  }

  // 显示元信息（meta_info）
  if (metaEl) {
    const meta = data.meta_info || {};
    if (Object.keys(meta).length > 0) {
      metaEl.innerHTML = `
        <div class="text-yellow-400 font-tech text-sm mb-2 mt-4">元信息</div>
        ${Object.keys(meta)
          .map((k) => {
            const label = getFieldLabel(k);
            const value = formatValue(meta[k]);
            return `<div class="mb-2"><span class="text-yellow-400 mr-2 font-medium">${label}:</span><span class="text-gray-300">${value}</span></div>`;
          })
          .join('')}
      `;
    } else {
      metaEl.innerHTML = '';
    }
  }

  // 根据 type 显示详细信息
  if (detailEl) {
    const detail = data.detail || {};
    const type = data.type || '';
    
    let detailHTML = '';
    
    // 根据不同的 type 显示不同的详细信息
    switch (type) {
      case 'person':
        detailHTML = formatPersonDetail(detail);
        break;
      case 'event':
        detailHTML = formatEventDetail(detail);
        break;
      case 'site':
        detailHTML = formatSiteDetail(detail);
        break;
      case 'artifact':
        detailHTML = formatArtifactDetail(detail);
        break;
      case 'literature':
        detailHTML = formatLiteratureDetail(detail);
        break;
      default:
        // 默认显示所有字段
        detailHTML = formatDefaultDetail(detail);
    }
    
    detailEl.innerHTML = detailHTML || '<div class="text-gray-500 text-sm">暂无详细信息</div>';
  }


  const iconEl = document.getElementById('ip-icon');
  const container3d = document.getElementById('ip-3d-container');
  const rotateBtn = document.getElementById('btn-toggle-rotate');

  if (data.name === '黄鹤楼') {
    if (iconEl) iconEl.style.display = 'none';
    if (container3d) container3d.style.display = 'block';
    if (rotateBtn) rotateBtn.style.display = 'flex';
    if (previewControls) {
      previewControls.autoRotate = true;
      const icon = document.getElementById('icon-rotate');
      if (icon) icon.className = 'fas fa-pause';
    }
    setTimeout(() => {
      if (!isPreviewInit) initPreview3D();
      else resizePreview();
      loadModel('qianlong_emporer_incense_burner.glb');
    }, 100);
  } else {
    if (iconEl) iconEl.style.display = 'block';
    if (container3d) container3d.style.display = 'none';
    if (rotateBtn) rotateBtn.style.display = 'none';
    if (currentModel && previewScene) {
      previewScene.remove(currentModel);
      currentModel = null;
    }
  }
}

function formatValue(v) {
  if (Array.isArray(v)) return v.join('、');
  if (typeof v === 'object' && v !== null) {
    // 如果是对象，尝试格式化显示
    if (v.longitude && v.latitude) {
      return `${v.latitude} N, ${v.longitude} E`;
    }
    if (v.lng && v.lat) {
      return `${v.lat} N, ${v.lng} E`;
    }
    // 如果是 alternative_names 这样的对象
    if (v.courtesy || v.pseudonym || v.posthumous) {
      const parts = [];
      if (v.courtesy) parts.push(`字：${v.courtesy}`);
      if (v.pseudonym) parts.push(`号：${v.pseudonym}`);
      if (v.posthumous) parts.push(`谥号：${v.posthumous}`);
      return parts.join('，');
    }
    // 如果是 ancient_names 这样的对象
    if (typeof v === 'object' && !Array.isArray(v)) {
      const entries = Object.entries(v).filter(([_, val]) => val);
      if (entries.length > 0) {
        return entries.map(([key, val]) => `${key}：${val}`).join('，');
      }
    }
    return JSON.stringify(v, null, 2);
  }
  return v ?? '';
}

// 获取字段的中文标签
function getFieldLabel(key) {
  const labelMap = {
    main_participants: '主要参与者',
    historical_significance: '历史意义',
    location_name: '地点',
    outcome: '结果',
    start_date: '开始日期',
    end_date: '结束日期',
    year_range: '年份范围',
    date_display: '日期显示',
    event_type: '事件类型'
  };
  return labelMap[key] || key;
}

// 格式化人物信息
function formatPersonDetail(detail) {
  if (!detail || Object.keys(detail).length === 0) return '';
  
  const parts = [];
  
  if (detail.alternative_names) {
    const altNames = formatValue(detail.alternative_names);
    if (altNames) parts.push(`<div class="mb-2"><span class="text-yellow-400 mr-2 font-medium">别名:</span><span class="text-gray-300">${altNames}</span></div>`);
  }
  
  if (detail.gender) {
    parts.push(`<div class="mb-2"><span class="text-yellow-400 mr-2 font-medium">性别:</span><span class="text-gray-300">${detail.gender}</span></div>`);
  }
  
  if (detail.birth_year || detail.death_year) {
    const birth = detail.birth_year ? `${detail.birth_year}年` : '不详';
    const death = detail.death_year ? `${detail.death_year}年` : '不详';
    parts.push(`<div class="mb-2"><span class="text-yellow-400 mr-2 font-medium">生卒年:</span><span class="text-gray-300">${birth} - ${death}</span></div>`);
  }
  
  if (detail.birth_place_name) {
    parts.push(`<div class="mb-2"><span class="text-yellow-400 mr-2 font-medium">出生地:</span><span class="text-gray-300">${detail.birth_place_name}</span></div>`);
  }
  
  if (detail.titles && Array.isArray(detail.titles) && detail.titles.length > 0) {
    parts.push(`<div class="mb-2"><span class="text-yellow-400 mr-2 font-medium">官职/称号:</span><span class="text-gray-300">${detail.titles.join('、')}</span></div>`);
  }
  
  if (detail.ethnicity) {
    parts.push(`<div class="mb-2"><span class="text-yellow-400 mr-2 font-medium">民族:</span><span class="text-gray-300">${detail.ethnicity}</span></div>`);
  }
  
  if (detail.biography) {
    parts.push(`<div class="mb-2 mt-4"><span class="text-yellow-400 mr-2 font-medium">生平:</span></div><div class="text-gray-300 leading-relaxed pl-4">${detail.biography}</div>`);
  }
  
  return parts.length > 0 ? `<div class="text-yellow-400 font-tech text-sm mb-2 mt-4">详细信息</div>${parts.join('')}` : '';
}

// 格式化事件信息
function formatEventDetail(detail) {
  if (!detail || Object.keys(detail).length === 0) return '';
  
  const parts = [];
  
  if (detail.title) {
    parts.push(`<div class="mb-2"><span class="text-yellow-400 mr-2 font-medium">标题:</span><span class="text-gray-300">${detail.title}</span></div>`);
  }
  
  if (detail.event_type) {
    parts.push(`<div class="mb-2"><span class="text-yellow-400 mr-2 font-medium">事件类型:</span><span class="text-gray-300">${detail.event_type}</span></div>`);
  }
  
  if (detail.start_date || detail.end_date) {
    const formatYear = (dateString) => {
      if (!dateString || typeof dateString !== 'string') return '不详';
      return dateString.substring(0, 4);
    };
    const start = formatYear(detail.start_date);
    const end = formatYear(detail.end_date);
    const timeDisplay = start === end ? `${start}年` : `${start} - ${end}`;
    if (timeDisplay !== '不详 - 不详') {
      parts.push(`<div class="mb-2"><span class="text-yellow-400 mr-2 font-medium">时间:</span><span class="text-gray-300">${timeDisplay}</span></div>`);
    }
  }
  
  if (detail.year_range) {
    parts.push(`<div class="mb-2"><span class="text-yellow-400 mr-2 font-medium">年份范围:</span><span class="text-gray-300">${detail.year_range}</span></div>`);
  }
  
  if (detail.date_display) {
    parts.push(`<div class="mb-2"><span class="text-yellow-400 mr-2 font-medium">日期:</span><span class="text-gray-300">${detail.date_display}</span></div>`);
  }
  
  if (detail.location_name) {
    parts.push(`<div class="mb-2"><span class="text-yellow-400 mr-2 font-medium">地点:</span><span class="text-gray-300">${detail.location_name}</span></div>`);
  }
  
  if (detail.outcome) {
    parts.push(`<div class="mb-2 mt-4"><span class="text-yellow-400 mr-2 font-medium">结果:</span></div><div class="text-gray-300 leading-relaxed pl-4">${detail.outcome}</div>`);
  }
  
  return parts.length > 0 ? `<div class="text-yellow-400 font-tech text-sm mb-2 mt-4">详细信息</div>${parts.join('')}` : '';
}

// 格式化遗址信息
function formatSiteDetail(detail) {
  if (!detail || Object.keys(detail).length === 0) return '';
  
  const parts = [];
  
  if (detail.site_type) {
    parts.push(`<div class="mb-2"><span class="text-yellow-400 mr-2 font-medium">遗址类型:</span><span class="text-gray-300">${detail.site_type}</span></div>`);
  }
  
  if (detail.address_modern) {
    parts.push(`<div class="mb-2"><span class="text-yellow-400 mr-2 font-medium">现代地址:</span><span class="text-gray-300">${detail.address_modern}</span></div>`);
  }
  
  if (detail.exist_status) {
    parts.push(`<div class="mb-2"><span class="text-yellow-400 mr-2 font-medium">保存状态:</span><span class="text-gray-300">${detail.exist_status}</span></div>`);
  }
  
  if (detail.construction_year) {
    const year = detail.construction_year;
    const yearDisplay = year < 0 ? `公元前${Math.abs(year)}年` : `${year}年`;
    parts.push(`<div class="mb-2"><span class="text-yellow-400 mr-2 font-medium">建造年份:</span><span class="text-gray-300">${yearDisplay}</span></div>`);
  }
  
  if (detail.lat && detail.lng) {
    parts.push(`<div class="mb-2"><span class="text-yellow-400 mr-2 font-medium">坐标:</span><span class="text-gray-300">${detail.lat.toFixed(4)} N, ${detail.lng.toFixed(4)} E</span></div>`);
  }
  
  return parts.length > 0 ? `<div class="text-yellow-400 font-tech text-sm mb-2 mt-4">详细信息</div>${parts.join('')}` : '';
}

// 格式化器物信息
function formatArtifactDetail(detail) {
  if (!detail || Object.keys(detail).length === 0) return '';
  
  const parts = [];
  
  if (detail.material) {
    parts.push(`<div class="mb-2"><span class="text-yellow-400 mr-2 font-medium">材质:</span><span class="text-gray-300">${detail.material}</span></div>`);
  }
  
  if (detail.craft) {
    parts.push(`<div class="mb-2"><span class="text-yellow-400 mr-2 font-medium">工艺:</span><span class="text-gray-300">${detail.craft}</span></div>`);
  }
  
  if (detail.discovered_at) {
    parts.push(`<div class="mb-2"><span class="text-yellow-400 mr-2 font-medium">发现地:</span><span class="text-gray-300">${detail.discovered_at}</span></div>`);
  }
  
  if (detail.preserved_at) {
    parts.push(`<div class="mb-2"><span class="text-yellow-400 mr-2 font-medium">收藏地:</span><span class="text-gray-300">${detail.preserved_at}</span></div>`);
  }
  
  return parts.length > 0 ? `<div class="text-yellow-400 font-tech text-sm mb-2 mt-4">详细信息</div>${parts.join('')}` : '';
}

// 格式化文献信息
function formatLiteratureDetail(detail) {
  if (!detail || Object.keys(detail).length === 0) return '';
  
  const parts = [];
  
  if (detail.title) {
    parts.push(`<div class="mb-2"><span class="text-yellow-400 mr-2 font-medium">标题:</span><span class="text-gray-300">${detail.title}</span></div>`);
  }
  
  if (detail.genre) {
    parts.push(`<div class="mb-2"><span class="text-yellow-400 mr-2 font-medium">体裁:</span><span class="text-gray-300">${detail.genre}</span></div>`);
  }
  
  if (detail.author_name) {
    parts.push(`<div class="mb-2"><span class="text-yellow-400 mr-2 font-medium">作者:</span><span class="text-gray-300">${detail.author_name}</span></div>`);
  }
  
  if (detail.year) {
    parts.push(`<div class="mb-2"><span class="text-yellow-400 mr-2 font-medium">年份:</span><span class="text-gray-300">${detail.year}年</span></div>`);
  }
  
  if (detail.content_summary) {
    parts.push(`<div class="mb-2 mt-4"><span class="text-yellow-400 mr-2 font-medium">内容摘要:</span></div><div class="text-gray-300 leading-relaxed pl-4">${detail.content_summary}</div>`);
  }
  
  return parts.length > 0 ? `<div class="text-yellow-400 font-tech text-sm mb-2 mt-4">详细信息</div>${parts.join('')}` : '';
}

// 格式化默认详细信息（用于未知类型）
function formatDefaultDetail(detail) {
  if (!detail || Object.keys(detail).length === 0) return '';
  
  const parts = Object.keys(detail)
    .filter((k) => detail[k] !== null && detail[k] !== undefined)
    .map((k) => {
      const label = getFieldLabel(k);
      const value = formatValue(detail[k]);
      return `<div class="mb-2"><span class="text-yellow-400 mr-2 font-medium">${label}:</span><span class="text-gray-300">${value}</span></div>`;
    });
  
  return parts.length > 0 ? `<div class="text-yellow-400 font-tech text-sm mb-2 mt-4">详细信息</div>${parts.join('')}` : '';
}


function showFeedback(text) {
  const feedback = document.getElementById('gesture-feedback');
  if (!feedback) return;
  feedback.innerText = text;
  feedback.style.display = 'block';
  setTimeout(() => (feedback.style.display = 'none'), 2000);
}

// 进入体验：显示星云、播放混沌生成（开场已移至独立的 intro.html）
function startExperience(fromRestore = false) {
  if (hasStartedExperience && !fromRestore) return;
  hasStartedExperience = true;
  suppressNextClick = true; // 避免点击按钮时触发一次场景点击
  
  // 如果是从恢复状态来的，不要清除高亮
  if (!fromRestore) {
    clearHighlights(); // 进入前清掉可能残留的连线/高亮
  }

  galaxyGroup.visible = true;
  const hero = document.getElementById('home-content');
  if (hero) {
    hero.style.opacity = '1';
    hero.style.pointerEvents = 'auto';
  }

  // 延迟重置 suppressNextClick，确保按钮点击事件已处理，但允许用户点击星球
  setTimeout(() => {
    suppressNextClick = false;
  }, 200);

  // 如果是从恢复状态或跳过开场，不播放开场动画
  console.log(`🎬 startExperience: fromRestore=${fromRestore}, skipIntroOnce=${skipIntroOnce}, hasPlayedIntro=${hasPlayedIntro}`);
  if (fromRestore || skipIntroOnce) {
    console.log('⏭️ 跳过入场动画');
    hasPlayedIntro = true;
    skipIntroOnce = false;
    return;
  }
  
  // 首次从 intro.html 进入时播放开场动画
  console.log('🎬 开始播放入场动画');
  playNebulaIntro();
}

function playNebulaIntro() {
  console.log(`🎬 playNebulaIntro 被调用: hasPlayedIntro=${hasPlayedIntro}, galaxyGroup=${!!galaxyGroup}, particles=${galaxyParticles.length}`);
  if (hasPlayedIntro || !galaxyGroup || galaxyParticles.length === 0) {
    console.log('⏭️ playNebulaIntro 被跳过');
    return;
  }
  hasPlayedIntro = true;
  console.log('✅ 开始执行入场动画');

  // 镜头由远到近
  const introCamStart = new THREE.Vector3(0, 1600, 3800);
  camera.position.copy(introCamStart);
  controls.target.copy(defaultTarget);
  new TWEEN.Tween(camera.position)
    .to({ x: defaultCameraPos.x, y: defaultCameraPos.y, z: defaultCameraPos.z }, 3200)
    .easing(TWEEN.Easing.Cubic.Out)
    .start();

  // 先将星系缩放到很小，再展开并脉冲
  galaxyGroup.scale.set(0.08, 0.08, 0.08);
  new TWEEN.Tween(galaxyGroup.scale)
    .to({ x: 1, y: 1, z: 1 }, 2600)
    .easing(TWEEN.Easing.Cubic.Out)
    .onComplete(() => {
      new TWEEN.Tween(galaxyGroup.scale)
        .to({ x: 1.08, y: 1.08, z: 1.08 }, 500)
        .easing(TWEEN.Easing.Cubic.Out)
        .yoyo(true)
        .repeat(1)
        .start();
    })
    .start();

  // 闪白过渡，减少残影感
  const flash = document.getElementById('intro-flash');
  if (flash) {
    flash.style.opacity = '0.9';
    flash.style.display = 'block';
    new TWEEN.Tween({ o: 0.9 })
      .to({ o: 0 }, 1200)
      .easing(TWEEN.Easing.Cubic.Out)
      .onUpdate(({ o }) => {
        flash.style.opacity = o;
      })
      .onComplete(() => {
        flash.style.display = 'none';
      })
      .start();
  }

  galaxyParticles.forEach((sprite, idx) => {
    if (!sprite.userData.targetPosition) {
      sprite.userData.targetPosition = sprite.position.clone();
    }
    const target = sprite.userData.targetPosition.clone();

    // 初始随机混沌位置
    const chaosRange = 900;
    const startPos = new THREE.Vector3(
      (Math.random() - 0.5) * chaosRange,
      (Math.random() - 0.5) * chaosRange,
      (Math.random() - 0.5) * chaosRange
    );
    sprite.position.copy(startPos);

    const finalScale = sprite.userData.baseScale || sprite.scale.x;
    sprite.scale.set(finalScale * 0.28, finalScale * 0.28, 1);
    if (sprite.material) {
      sprite.material.opacity = 0.0;
      sprite.material.needsUpdate = true;
    }

    const delay = idx * 4; // 轻微错峰
    new TWEEN.Tween(sprite.position)
      .to(target, 2200 + Math.random() * 1200)
      .easing(TWEEN.Easing.Cubic.Out)
      .delay(delay)
      .start();

    new TWEEN.Tween(sprite.scale)
      .to({ x: finalScale, y: finalScale, z: 1 }, 2200)
      .easing(TWEEN.Easing.Cubic.Out)
      .delay(delay)
      .start();

    if (sprite.material) {
      new TWEEN.Tween(sprite.material)
        .to({ opacity: 1 }, 1800)
        .easing(TWEEN.Easing.Cubic.Out)
        .delay(delay + 200)
        .start();
    }
  });
}

function openPreview(data) {
  if (!data) return;
  previewData = data;

  const panel = document.getElementById('preview-panel');
  if (!panel) return;
  const title = document.getElementById('preview-title');
  const dynasty = document.getElementById('preview-dynasty');
  const desc = document.getElementById('preview-desc');
  if (title) title.innerText = data.name || '未命名星球';
  if (dynasty) dynasty.innerText = (data.dynasty || data.group || '未知').toUpperCase();
  if (desc) desc.innerText = data.desc || data.description || '暂无简介';

  const openBtn = document.getElementById('preview-open-ip');
  if (openBtn) {
    openBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      navigateToIP(data.id);
    };
  }
  const exitBtn = document.getElementById('preview-exit');
  if (exitBtn) {
    exitBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      exitNodeFocus(e);
    };
  }
  const closeBtn = document.getElementById('preview-close');
  if (closeBtn) {
    closeBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      closePreview();
    };
  }

  panel.classList.remove('hidden');
  panel.style.pointerEvents = 'auto';
  panel.style.opacity = '1';
}

function closePreview() {
  const panel = document.getElementById('preview-panel');
  if (!panel) return;
  panel.style.pointerEvents = 'none';
  panel.style.opacity = '0';
  panel.classList.add('hidden');
  previewData = null;
}

function saveHomeState() {
  if (!camera || !controls) return;
  
  // 保存高亮节点的ID列表
  const highlightedNodeIds = highlightedNodes
    .filter(node => node && node.userData?.data?.id)
    .map(node => node.userData.data.id);
  
  // 保存连线的起点和终点节点ID对
  // 注意：连线存储的是世界坐标，我们需要找到对应的节点
  // 由于连线是在highlightNode中创建的，我们可以通过保存主节点和邻居节点的ID来重建
  const linkPairs = [];
  // 如果当前有锁定节点，保存它的kg_node_id，用于重建连线
  const mainNodeKgId = lockedNode?.userData?.data?.kg_node_id || null;
  
  const state = {
    cameraPos: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
    targetPos: { x: controls.target.x, y: controls.target.y, z: controls.target.z },
    focusCluster: currentFocusCluster,
    lockedNodeId: lockedNode?.userData?.data?.id || null,
    clusterMode: currentClusterMode,
    highlightedNodeIds: highlightedNodeIds,
    mainNodeKgId: mainNodeKgId, // 用于重建连线
    fov: camera.fov // 保存FOV
  };
  localStorage.setItem(HOME_STATE_KEY, JSON.stringify(state));
}

function loadSavedState() {
  const raw = localStorage.getItem(HOME_STATE_KEY);
  if (!raw) return;
  try {
    const state = JSON.parse(raw);
    pendingRestoreState = state;
    skipIntroOnce = true; // 返回时跳过开场动画，直接恢复
    if (state.clusterMode && clusterPresets[state.clusterMode]) {
      currentClusterMode = state.clusterMode;
      currentClusters = clusterPresets[state.clusterMode].clusters;
    }
  } catch (e) {
    console.warn('恢复星云状态失败', e);
  }
}

// 初始化函数：检查是否需要播放入场动画
function checkAndSkipIntro() {
  // 检查是否从开场页面进入（不在这里清除标记，等星系构建完成后再清除）
  const fromIntro = sessionStorage.getItem('fromIntro') === 'true';
  
  if (fromIntro) {
    // 从开场页面进入，不跳过开场动画
    skipIntroOnce = false; // 不跳过，播放入场动画
    console.log('📋 从开场页面进入，将播放入场动画');
  } else {
    // 从其他页面返回，跳过开场动画
    skipIntroOnce = true;
    console.log('📋 从其他页面返回，跳过入场动画');
  }
  
  const hero = document.getElementById('home-content');
  if (hero) {
    hero.style.opacity = '1';
    hero.style.pointerEvents = 'auto';
  }
}

async function restoreViewState() {
  if (!pendingRestoreState) {
    console.log('📋 没有待恢复的状态');
    return;
  }
  const state = pendingRestoreState;
  pendingRestoreState = null;
  
  console.log('📋 开始恢复状态:', state);

  const hero = document.getElementById('home-content');
  const backBtn = document.getElementById('back-btn');
  if (state.focusCluster || state.lockedNodeId) {
    if (hero) {
      hero.style.opacity = '0';
      hero.style.pointerEvents = 'none';
    }
    if (backBtn) {
      backBtn.style.opacity = '1';
      backBtn.style.pointerEvents = 'auto';
    }
  }

  // 恢复相机位置和目标
  if (state.cameraPos && state.targetPos && camera && controls) {
    camera.position.set(state.cameraPos.x, state.cameraPos.y, state.cameraPos.z);
    controls.target.set(state.targetPos.x, state.targetPos.y, state.targetPos.z);
    if (state.fov) {
      camera.fov = state.fov;
      camera.updateProjectionMatrix();
    }
    controls.update();
  }

  // 等待节点创建完成后再恢复状态
  // 检查节点是否已经创建
  if (nodeById.size === 0) {
    console.log('⏳ 节点尚未创建，等待节点创建完成...');
    // 如果节点还没创建，等待一段时间后重试
    setTimeout(() => {
      restoreViewState();
    }, 500);
    return;
  }
  
  console.log(`✅ 节点已创建，共 ${nodeById.size} 个节点，开始恢复状态`);

  // 优先恢复锁定节点
  if (state.lockedNodeId && nodeById.has(state.lockedNodeId)) {
    console.log(`📍 恢复锁定节点: ${state.lockedNodeId}`);
    const node = nodeById.get(state.lockedNodeId);
    // 从IP详情页面返回时，保持高亮状态，不清除之前的高亮
    // 先恢复高亮节点和连线，再调用focusOnNode
    if (state.highlightedNodeIds && state.highlightedNodeIds.length > 0) {
      console.log(`✨ 恢复 ${state.highlightedNodeIds.length} 个高亮节点`);
      restoreHighlightedNodes(state.highlightedNodeIds, node);
      // 如果有主节点的kg_node_id，重建连线
      if (state.mainNodeKgId) {
        console.log(`🔗 恢复连线，主节点kg_id: ${state.mainNodeKgId}`);
        restoreLinkLines(node, state.mainNodeKgId).then(() => {
          // 连线恢复完成后再聚焦节点（但不重新高亮，因为已经恢复了）
          focusOnNodeWithoutHighlight(node);
        });
      } else {
        focusOnNodeWithoutHighlight(node);
      }
    } else {
      focusOnNode(node, false);
    }
  } else if (state.focusCluster && currentClusters[state.focusCluster]) {
    console.log(`📍 恢复聚焦星系: ${state.focusCluster}`);
    focusOnCluster(state.focusCluster);
    // 恢复高亮节点（即使没有锁定节点）
    if (state.highlightedNodeIds && state.highlightedNodeIds.length > 0) {
      console.log(`✨ 恢复 ${state.highlightedNodeIds.length} 个高亮节点`);
      restoreHighlightedNodes(state.highlightedNodeIds);
    }
  } else {
    // 即使没有聚焦，也恢复高亮节点
    if (state.highlightedNodeIds && state.highlightedNodeIds.length > 0) {
      console.log(`✨ 恢复 ${state.highlightedNodeIds.length} 个高亮节点`);
      restoreHighlightedNodes(state.highlightedNodeIds);
    }
  }

  localStorage.removeItem(HOME_STATE_KEY);
  startExperience(true);
  console.log('✅ 状态恢复完成');
}

// ================= 星云界面搜索栏 =================
// 在顶部导航栏中提供搜索与热点推送能力，并与三维星云联动
function setupSearch() {
  const searchInput = document.getElementById('search-input');
  const searchResults = document.getElementById('search-results');
  const hotItems = document.getElementById('hot-items');
  const hotItemsList = document.getElementById('hot-items-list');

  if (!searchInput || !searchResults || !hotItems || !hotItemsList) {
    console.warn('⚠️ 星云搜索栏元素未找到，跳过搜索初始化');
    return;
  }

  // 渲染卡片列表（可用于热点或搜索内容）
  function renderCardList(items, titleIcon = 'fire', titleText = '热点推送') {
    if (!items || items.length === 0) {
      hotItems.classList.add('hidden');
      return;
    }

    // 更新标题
    const titleBar = `<div class="text-xs text-yellow-400 mb-3 font-tech tracking-wider">${titleIcon === 'fire' ? '🔥' : '🔍'} ${titleText}</div>`;

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
        <div class="hot-item-card p-3 rounded-lg bg-gradient-to-br from-yellow-900/30 to-yellow-700/10 border border-yellow-500/30 hover:bg-yellow-900/40 cursor-pointer transition-all duration-300" data-id="${item.id}">
            <div class="flex items-start gap-3">
                <div class="w-8 h-8 rounded-full bg-yellow-500/20 flex items-center justify-center text-yellow-400 text-sm flex-shrink-0 mt-1">
                    <i class="fas fa-${icon}"></i>
                </div>
                <div class="flex-1">
                    <div class="text-base text-white font-serif-sc">${item.name || '未命名'}</div>
                    <div class="text-xs text-yellow-400 font-tech tracking-widest mb-2">${typeName} · ${item.dynasty || item.dynasty_name || '未知'}</div>
                    <p class="text-xs text-gray-400 leading-relaxed line-clamp-2">${description}</p>
                </div>
            </div>
        </div>
      `;
    }).join('');

    hotItems.classList.remove('hidden');

    // 绑定点击事件
    hotItemsList.querySelectorAll('.hot-item-card').forEach((el) => {
      el.addEventListener('click', () => {
        const rawId = el.dataset.id;
        const entityId = isNaN(Number(rawId)) ? rawId : Number(rawId);
        handleNebulaSearchSelect(entityId);
      });
    });
  }

  // 包装：显示热点推送
  function showHotItems() {
    renderCardList(getHotItems(5));
  }

  // 显示搜索结果
  function showSearchResults(results) {
    if (!results || results.length === 0) {
      searchResults.innerHTML =
        '<div class="p-4 text-center text-gray-400 text-sm">未找到相关结果</div>';
      searchResults.classList.remove('hidden');
      return;
    }

    searchResults.innerHTML = results
      .slice(0, 10)
      .map((item) => {
        const typeName =
          item.type === 'person'
            ? '人物'
            : item.type === 'artifact'
            ? '器物'
            : item.type === 'site'
            ? '遗址'
            : item.type === 'event'
            ? '事件'
            : item.type === 'literature'
            ? '文献'
            : '其他';

        return `
        <div class="search-result flex items-center gap-3 p-3 border-b border-white/5 hover:bg-white/5 cursor-pointer transition" data-id="${item.id}">
          <div class="w-10 h-10 rounded-full bg-yellow-500/20 flex items-center justify-center text-yellow-400">
            <i class="fas fa-${
              item.type === 'person' ? 'user' : item.type === 'artifact' ? 'gem' : 'landmark'
            }"></i>
          </div>
          <div class="flex-1">
            <div class="text-sm text-white font-medium">${item.name || '未命名'}</div>
            <div class="text-xs text-gray-400">${typeName} · ${
              item.dynasty || item.dynasty_name || '未知'
            }</div>
          </div>
        </div>
      `;
      })
      .join('');

    searchResults.classList.remove('hidden');

    // 绑定点击事件
    searchResults.querySelectorAll('.search-result').forEach((el) => {
      el.addEventListener('click', () => {
        const rawId = el.dataset.id;
        const entityId = isNaN(Number(rawId)) ? rawId : Number(rawId);
        handleNebulaSearchSelect(entityId);
      });
    });
  }

  // 搜索输入事件（防抖）
  let searchTimeout;
  searchInput.addEventListener('input', (e) => {
    const query = e.target.value.trim();
    clearTimeout(searchTimeout);

    if (query === '') {
      searchResults.classList.add('hidden');
      // 清空输入时，隐藏搜索结果与热点，等待用户再次聚焦触发热点
      hotItems.classList.add('hidden');
      return;
    }

    searchTimeout = setTimeout(() => {
      const results = searchEntities(query);
      showSearchResults(results);
      // 输入搜索内容后，仅显示搜索结果，隐藏热点推送
      hotItems.classList.add('hidden');
    }, 300);
  });

  // 聚焦时显示热点推送
  searchInput.addEventListener('focus', () => {
    // 只有点击搜索框时才展开下拉：根据当前内容决定展示
    const q = searchInput.value.trim();
    if (q === '') {
      searchResults.classList.add('hidden');
      showHotItems();
    } else {
      const results = searchEntities(q);
      showSearchResults(results);
      // 已有搜索内容时，只展示搜索结果，不再显示热点推送
      hotItems.classList.add('hidden');
    }
  });

  // 点击外部关闭
  document.addEventListener('click', (e) => {
    if (
      !searchInput.contains(e.target) &&
      !searchResults.contains(e.target) &&
      !hotItems.contains(e.target)
    ) {
      searchResults.classList.add('hidden');
      hotItems.classList.add('hidden');
    }
  });

  // 仅在用户聚焦搜索框时显示热点推送，不默认展开
  // showHotItems();
}

// 处理星云搜索选择：在三维场景中聚焦并高亮对应星球
function handleNebulaSearchSelect(entityId) {
  if (!entityId) return;

  const sprite =
    nodeById.get(entityId) ||
    nodeById.get(String(entityId)); // 双保险，支持数值和字符串 ID

  if (!sprite) {
    console.warn('未在星云中找到对应实体节点:', entityId);
    return;
  }

  // 清除之前高亮并聚焦到节点，同时打开预览面板
  focusOnNode(sprite);

  // 关闭搜索结果与热点
  const searchResults = document.getElementById('search-results');
  const hotItems = document.getElementById('hot-items');
  const searchInput = document.getElementById('search-input');
  if (searchResults) searchResults.classList.add('hidden');
  if (hotItems) hotItems.classList.add('hidden');
  if (searchInput) searchInput.value = '';
}

// 恢复高亮节点
function restoreHighlightedNodes(nodeIds, mainNode = null) {
  if (!nodeIds || nodeIds.length === 0) return;
  
  nodeIds.forEach(nodeId => {
    if (nodeById.has(nodeId)) {
      const node = nodeById.get(nodeId);
      // 检查是否已经被高亮
      if (!highlightedNodes.includes(node)) {
        if (node.userData?.baseScale) {
          // 判断是主节点还是邻居节点
          const isMainNode = mainNode && node === mainNode;
          const newScale = isMainNode 
            ? node.userData.baseScale * 1.4 
            : node.userData.baseScale * 1.2;
          node.scale.set(newScale, newScale, 1);
          if (node.material?.color) {
            node.material.color = new THREE.Color(isMainNode ? 0xffffff : 0xffff00);
          }
          highlightedNodes.push(node);
        }
      }
    }
  });
}

// 恢复连线
async function restoreLinkLines(mainNode, mainNodeKgId) {
  if (!mainNode || !mainNodeKgId) return Promise.resolve();
  
  try {
    const { fetchKnowledgeGraph } = await import('./data.js');
    const kg = await fetchKnowledgeGraph(mainNodeKgId);
    
    if (!kg || !kg.neighbors || kg.neighbors.length === 0) return Promise.resolve();
    
    const clickedPos = new THREE.Vector3();
    mainNode.getWorldPosition(clickedPos);
    
    kg.neighbors.forEach(neighbor => {
      const neighborSprite = nodeByKgNodeId.get(neighbor.id);
      if (neighborSprite && highlightedNodes.includes(neighborSprite)) {
        const neighborPos = new THREE.Vector3();
        neighborSprite.getWorldPosition(neighborPos);
        const points = [clickedPos, neighborPos];
        const lineGeometry = new THREE.BufferGeometry().setFromPoints(points);
        const lineMaterial = new THREE.LineBasicMaterial({ color: 0xffd700, transparent: true, opacity: 0.7 });
        const line = new THREE.Line(lineGeometry, lineMaterial);
        galaxyGroup.add(line);
        linkLines.push(line);
      }
    });
    return Promise.resolve();
  } catch (error) {
    console.error('恢复连线失败:', error);
    return Promise.resolve();
  }
}

function navigateToIP(entityId) {
  if (!entityId) return;
  saveHomeState();
  window.location.href = `ip.html?id=${entityId}`;
}

function clearHighlights() {
  highlightedNodes.forEach((s) => {
    if (s && s.userData?.baseScale && s.scale) {
      s.scale.set(s.userData.baseScale, s.userData.baseScale, 1);
      if (s.material?.color && s.userData.baseColor) {
        s.material.color = s.userData.baseColor.clone ? s.userData.baseColor.clone() : s.userData.baseColor;
        // 恢复原始不透明度
        s.material.opacity = 1.2;
      }
    }
  });
  highlightedNodes = [];
  linkLines.forEach((l) => galaxyGroup.remove(l));
  linkLines = [];
}

async function highlightNode(sprite, clearPrevious = true) {
  if (clearPrevious) {
    clearHighlights();
  }
  if (!sprite || !sprite.userData.isNode) return;

  const clickedNodeData = sprite.userData.data;

  // Highlight the clicked node itself
  if (sprite.userData?.baseScale) {
    // 检查是否已经被高亮，避免重复添加
    const alreadyHighlighted = highlightedNodes.includes(sprite);
    if (!alreadyHighlighted) {
      const newScale = sprite.userData.baseScale * 1.4;
      sprite.scale.set(newScale, newScale, 1);
      if (sprite.material?.color) {
        sprite.material.color = new THREE.Color(0xffffff);
      }
      highlightedNodes.push(sprite);
    }
  }

  if (!clickedNodeData.kg_node_id) {
    console.log('Clicked node has no kg_node_id.');
    return;
  }

  try {
    const { fetchKnowledgeGraph } = await import('./data.js');
    const kg = await fetchKnowledgeGraph(clickedNodeData.kg_node_id);

    console.log('--- Debugging Highlight ---');
    console.log('1. Clicked Node KG ID:', clickedNodeData.kg_node_id);
    console.log('2. Fetched KG data:', kg);
    console.log('3. Node map by kg_node_id (first 5 entries):', new Map(Array.from(nodeByKgNodeId).slice(0, 5)));

    if (!kg || !kg.neighbors || kg.neighbors.length === 0) {
      console.log('4. No neighbors found or KG data is empty. Stopping.');
      return;
    }

    const clickedPos = new THREE.Vector3();
    sprite.getWorldPosition(clickedPos);

    kg.neighbors.forEach(neighbor => {
      console.log(`5. Attempting to find neighbor with kg_node_id: "${neighbor.id}"`);
      const neighborSprite = nodeByKgNodeId.get(neighbor.id);

      if (neighborSprite) {
        console.log(`   ✅ Found sprite:`, neighborSprite.userData.data.name);
        // 检查是否已经被高亮，避免重复添加
        const alreadyHighlighted = highlightedNodes.includes(neighborSprite);
        if (!alreadyHighlighted) {
          const newScale = neighborSprite.userData.baseScale * 1.2;
          neighborSprite.scale.set(newScale, newScale, 1);
          if (neighborSprite.material?.color) {
            neighborSprite.material.color = new THREE.Color(0xffff00);
          }
          highlightedNodes.push(neighborSprite);
        }

        const neighborPos = new THREE.Vector3();
        neighborSprite.getWorldPosition(neighborPos);
        const points = [clickedPos, neighborPos];
        const lineGeometry = new THREE.BufferGeometry().setFromPoints(points);
        const lineMaterial = new THREE.LineBasicMaterial({ color: 0xffd700, transparent: true, opacity: 0.7 });
        const line = new THREE.Line(lineGeometry, lineMaterial);
        galaxyGroup.add(line);
        linkLines.push(line);
      } else {
        console.log(`   ❌ Sprite not found for kg_node_id: "${neighbor.id}"`);
      }
    });
  } catch (error) {
    console.error('Failed to fetch and show knowledge graph links:', error);
  }
}

// ================= AI 手势控制 =================
export function toggleCamera() {
  if (!isCameraActive) startCamera();
  else stopCamera();
}

function startCamera() {
  // 依赖全局 Hands / Camera，如果未加载则提示
  if (typeof Hands === 'undefined' || typeof Camera === 'undefined') {
    alert('手势识别依赖未加载，请检查网络或刷新页面');
    return;
  }

  const videoElement = document.querySelector('.input_video');
  if (!videoElement) return;
  
  hands = new Hands({ locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}` });
  hands.setOptions({ 
    maxNumHands: 1, 
    modelComplexity: 1, 
    minDetectionConfidence: 0.6, 
    minTrackingConfidence: 0.5 
  });
  hands.onResults(onHandsResults);
  
  cameraUtils = new Camera(videoElement, {
    onFrame: async () => { 
      await hands.send({ image: videoElement }); 
    },
    width: 640, 
    height: 480
  });
  cameraUtils.start();
  isCameraActive = true;
  
  const aiStatus = document.getElementById('ai-status');
  const btnCamera = document.getElementById('btn-camera');
  if (aiStatus) aiStatus.classList.add('ai-active');
  if (btnCamera) btnCamera.innerHTML = '<i class="fas fa-hand-paper"></i> 关闭手势';
}

function stopCamera() {
  if (cameraUtils) cameraUtils.stop();
  isCameraActive = false;
  globalScale = 1.0;
  
  const aiStatus = document.getElementById('ai-status');
  const btnCamera = document.getElementById('btn-camera');
  if (aiStatus) aiStatus.classList.remove('ai-active');
  if (btnCamera) btnCamera.innerHTML = '<i class="fas fa-hand-sparkles"></i> 开启手势控制';
}

function onHandsResults(results) {
  if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) return;
  const lm = results.multiHandLandmarks[0];
  const now = Date.now();

  let fingersUp = 0;
  if (lm[8].y < lm[6].y) fingersUp++;
  if (lm[12].y < lm[10].y) fingersUp++;
  if (lm[16].y < lm[14].y) fingersUp++;
  if (lm[20].y < lm[18].y) fingersUp++;
  
  if (lm[4].y < lm[3].y && fingersUp === 4) fingersUp = 5;

  if (fingersUp > 0 && fingersUp <= 5 && now - lastGestureTime > 2000) {
    lastGestureTime = now;
    const map = { 1: '唐代', 2: '宋代', 3: '元代', 4: '明代', 5: '清代' };
    if (map[fingersUp] && currentClusterMode === 'dynasty') {
      focusOnCluster(map[fingersUp]);
      const feedback = document.getElementById('gesture-feedback');
      if (feedback) {
        feedback.innerText = `识别手势: ${fingersUp} - ${map[fingersUp]}`;
        feedback.style.display = 'block';
        setTimeout(() => feedback.style.display = 'none', 2000);
      }
    }
  }

  if (fingersUp === 0 || fingersUp === 1) {
    const dist = Math.sqrt(Math.pow(lm[4].x - lm[8].x, 2) + Math.pow(lm[4].y - lm[8].y, 2));
    const minD = 0.05, maxD = 0.3;
    const normalized = Math.min(Math.max((dist - minD) / (maxD - minD), 0), 1);
    globalScale = 0.5 + normalized * 1.5;
  }
}



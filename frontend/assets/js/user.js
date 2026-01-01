import { SERVER_URL } from './data.js';

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

let currentUser = null;
let mapInstance = null;

export function initUserPage() {
  checkLoginStatus();
  window.handleAudit = handleAudit;

  // 绑定事件
  const bind = (id, fn) => {
    const el = document.getElementById(id);
    if (el) el.onclick = fn;
  };

  bind('btn-login', showLoginModal);
  bind('modal-close', hideLoginModal);
  bind('modal-login', handleLogin);
  bind('btn-logout', handleLogout);
  bind('btn-create', showCreateModal);
  bind('create-close', hideCreateModal);
  bind('btn-submit-form', handleSubmitForm);
}

// ✨✨✨ 1. 升级版星空生成 ✨✨✨
export function generateStars() {
  const container = document.getElementById('star-container');
  if (!container) return;
  container.innerHTML = '';
  
  const createStar = (type, count) => {
    for (let i = 0; i < count; i++) {
      const star = document.createElement('div');
      star.className = `star ${type}`; // star-sm, star-md, star-lg
      
      const x = Math.random() * 100;
      const y = Math.random() * 100;
      
      // 随机动画参数，消除同步感
      const duration = Math.random() * 3 + 2 + 's'; // 2-5s
      const delay = Math.random() * 5 + 's';
      const maxOpacity = Math.random() * 0.5 + 0.5; // 0.5 - 1.0

      star.style.left = `${x}%`;
      star.style.top = `${y}%`;
      star.style.setProperty('--max-opacity', maxOpacity);
      star.style.animationDuration = duration;
      star.style.animationDelay = delay;
      
      container.appendChild(star);
    }
  };

  // 生成三层星空
  createStar('star-sm', 200); // 远景微尘
  createStar('star-md', 100); // 中景繁星
  createStar('star-lg', 50);  // 前景亮星
}

function checkLoginStatus() {
  const saved = localStorage.getItem('currentUser');
  if (saved) {
    try {
      currentUser = JSON.parse(saved);
      updateUserUI();
    } catch (e) {
      console.error(e);
      localStorage.removeItem('currentUser');
    }
  }
}

function updateUserUI() {
  const guestDiv = document.getElementById('user-info-guest');
  const loggedDiv = document.getElementById('user-info-logged');
  const adminPanel = document.getElementById('admin-panel');
  const avatarImg = document.getElementById('user-avatar');
  const footprintSection = document.getElementById('footprint-section');
  
  if (currentUser) {
    guestDiv?.classList.add('hidden');
    loggedDiv?.classList.remove('hidden');
    
    document.getElementById('user-name-display').innerText = currentUser.name;
    const roleBadge = document.getElementById('user-role-badge');
    roleBadge.innerText = currentUser.role === 'admin' ? 'ADMINISTRATOR' : 'EXPLORER';
    roleBadge.className = currentUser.role === 'admin' 
      ? 'text-xs text-red-400 font-tech mt-1 border border-red-500/30 px-2 py-0.5 rounded inline-block'
      : 'text-xs text-yellow-500 font-tech mt-1 border border-yellow-500/30 px-2 py-0.5 rounded inline-block';
    
    if (currentUser.avatar) avatarImg.src = currentUser.avatar;

    if (footprintSection) {
        footprintSection.classList.remove('hidden');
        setTimeout(() => loadFootprintMap(currentUser.id), 200);
    }

    if (currentUser.role === 'admin') {
      adminPanel?.classList.remove('hidden');
      loadPendingAudits();
    } else {
      adminPanel?.classList.add('hidden');
    }
  } else {
    guestDiv?.classList.remove('hidden');
    loggedDiv?.classList.add('hidden');
    adminPanel?.classList.add('hidden');
    if (footprintSection) footprintSection.classList.add('hidden');
    avatarImg.src = "https://cdn-icons-png.flaticon.com/512/149/149071.png";
  }
  updateHistoryUI();
}

// ✨✨✨ 2. 升级版足迹地图 ✨✨✨
async function loadFootprintMap(userId) {
  const mapDiv = document.getElementById('footprint-map');
  const listDiv = document.getElementById('footprint-list');
  if (!mapDiv) return;

  let footprints = [];
  try {
    const res = await fetchWithTimeout(`${SERVER_URL}/api/user/footprints?userId=${userId}`, {}, 10000);
    const result = await res.json();
    if (result.success) footprints = result.data;
  } catch (e) {
    console.error('获取足迹失败', e);
  }

  // 按时间排序，用于画线
  footprints.sort((a, b) => new Date(a.visited_at) - new Date(b.visited_at));

  document.getElementById('visit-count').innerText = footprints.length;

  if (mapInstance) mapInstance.remove();

  mapInstance = L.map('footprint-map', {
    zoomControl: false,
    attributionControl: false
  }).setView([35.0, 105.0], 3);

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 18
  }).addTo(mapInstance);

  if (footprints.length > 0) {
    const latlngs = [];
    const bounds = L.latLngBounds();
    
    // 清空列表
    if (listDiv) listDiv.innerHTML = '';

    footprints.forEach((fp, index) => {
      const lat = parseFloat(fp.lat);
      const lng = parseFloat(fp.lng);
      const point = [lat, lng];
      latlngs.push(point);
      
      // 添加发光标记
      const glowingIcon = L.divIcon({
        className: 'custom-div-icon',
        html: `<div class="glowing-icon" style="width: 10px; height: 10px;"></div>`,
        iconSize: [10, 10],
        iconAnchor: [5, 5]
      });

      const marker = L.marker(point, { icon: glowingIcon }).addTo(mapInstance);
      marker.bindPopup(`
        <div class="text-center">
            <div class="font-bold text-yellow-500 mb-1">${fp.name}</div>
            <div class="text-xs text-gray-400">${new Date(fp.visited_at).toLocaleDateString()}</div>
        </div>
      `);
      
      bounds.extend(point);

      // ✨ 填充侧边列表
      if (listDiv) {
        const item = document.createElement('div');
        item.className = 'p-2 rounded bg-white/5 hover:bg-white/10 cursor-pointer flex justify-between items-center transition group border border-transparent hover:border-yellow-500/30';
        item.innerHTML = `
          <div>
            <div class="text-xs text-gray-200 font-bold">${index + 1}. ${fp.name}</div>
            <div class="text-[10px] text-gray-500">${fp.dynasty}</div>
          </div>
          <i class="fas fa-location-arrow text-[10px] text-yellow-500 opacity-0 group-hover:opacity-100 transition"></i>
        `;
        item.onclick = () => {
            mapInstance.flyTo(point, 6, { duration: 1.5 });
            marker.openPopup();
        };
        // 倒序插入（最新的在上面）
        listDiv.insertBefore(item, listDiv.firstChild); 
      }
    });

    // ✨ 画出轨迹连线
    if (latlngs.length > 1) {
        L.polyline(latlngs, {
            color: '#ffd700',
            weight: 1,
            opacity: 0.4,
            dashArray: '5, 10', // 虚线效果
            smoothFactor: 1
        }).addTo(mapInstance);
    }

    mapInstance.fitBounds(bounds, { padding: [50, 50], maxZoom: 5 });
  } else {
      if (listDiv) listDiv.innerHTML = '<div class="text-[10px] text-gray-600 text-center py-4">暂无足迹<br>快去探索吧</div>';
  }
}

export function showLoginModal() { document.getElementById('login-modal')?.classList.remove('hidden'); }
export function hideLoginModal() { document.getElementById('login-modal')?.classList.add('hidden'); }

export async function handleLogin() {
  const u = document.getElementById('login-user')?.value;
  const p = document.getElementById('login-pass')?.value;
  try {
    const res = await fetchWithTimeout(`${SERVER_URL}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: p })
    }, 10000);
    const data = await res.json();
    if (data.success) {
      currentUser = { ...data.user, id: data.user.id || data.user._id };
      localStorage.setItem('currentUser', JSON.stringify(currentUser));
      updateUserUI();
      hideLoginModal();
    } else {
      alert(`登录失败: ${data.message}`);
    }
  } catch (err) { console.error(err); }
}

export function handleLogout() {
  currentUser = null;
  localStorage.removeItem('currentUser');
  updateUserUI();
  const list = document.getElementById('footprint-list');
  if(list) list.innerHTML = '';
}

function showCreateModal() {
  if (!currentUser) return alert('请先登录');
  document.getElementById('create-modal')?.classList.remove('hidden');
}
function hideCreateModal() { document.getElementById('create-modal')?.classList.add('hidden'); }

async function handleSubmitForm() {
  const nameVal = document.getElementById('input-name').value;
  const typeVal = document.getElementById('input-type').value;
  const dynastyVal = document.getElementById('input-dynasty').value;
  const descVal = document.getElementById('input-desc').value;
  const latVal = document.getElementById('input-lat').value;
  const lngVal = document.getElementById('input-lng').value;

  if (!nameVal || !latVal || !lngVal) return alert('请补全信息');

  const newIP = {
    name: nameVal, type: typeVal, dynasty_id: dynastyVal, desc: descVal,
    lat: parseFloat(latVal), lng: parseFloat(lngVal)
  };

  try {
    const res = await fetchWithTimeout(`${SERVER_URL}/api/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: currentUser.id, newIP: newIP })
    }, 15000);
    const data = await res.json();
    if (data.success) {
      alert('提交成功！');
      hideCreateModal();
    } else {
      alert(`提交失败: ${data.message}`);
    }
  } catch (err) { console.error(err); }
}

export function publishContent() { showCreateModal(); }

async function loadPendingAudits() {
  const container = document.getElementById('audit-list-container');
  if (!container) return;
  try {
    const res = await fetchWithTimeout(`${SERVER_URL}/api/admin/pending`, {}, 10000);
    const result = await res.json();
    const emptyMsg = document.getElementById('audit-empty');
    if (result.success && result.data.length > 0) {
      emptyMsg?.classList.add('hidden');
      container.innerHTML = result.data.map(item => `
        <div class="flex items-center justify-between bg-white/5 p-2 rounded hover:bg-white/10">
          <div><div class="font-bold text-sm text-white">${item.name}</div></div>
          <div class="flex gap-2">
            <button onclick="window.handleAudit('${item.id}', 'published')" class="text-green-400 text-xs">通过</button>
            <button onclick="window.handleAudit('${item.id}', 'rejected')" class="text-red-400 text-xs">驳回</button>
          </div>
        </div>`).join('');
    } else {
      container.innerHTML = '';
      emptyMsg?.classList.remove('hidden');
    }
  } catch (err) { console.error(err); }
}

async function handleAudit(id, status) {
  if (!confirm('确认操作？')) return;
  try {
    await fetchWithTimeout(`${SERVER_URL}/api/admin/audit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, status })
    }, 10000);
    loadPendingAudits();
  } catch (e) { console.error(e); }
}

function updateHistoryUI() {
  const lastDataStr = localStorage.getItem('lastVisitedIP');
  const contentEl = document.getElementById('history-content');
  if (lastDataStr && contentEl) {
    const lastData = JSON.parse(lastDataStr);
    contentEl.innerHTML = `${lastData.name} <span class="text-xs text-yellow-500 ml-2">${lastData.dynasty || '未知'}</span>`;
  }
}
import 'dotenv/config'; // 确保安装了 dotenv: npm install dotenv
import express from 'express';
import cors from 'cors';
import { nanoid } from 'nanoid';
import path from 'path';
import { fileURLToPath } from 'url';
import { 
  getAllCulturalEntities, 
  getCulturalEntityById, 
  getAllDynasties,
  getUserByUsername,      // 需在 db.js 导出
  createCulturalEntity,   // 需在 db.js 导出
  getPendingEntities,     // 需在 db.js 导出
  updateEntityStatus,      // 需在 db.js 导出
  getUserFootprints
} from './db.js';
import { getKnowledgeGraphNeighbors } from './neo4j.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// --- 认证接口 ---

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  try {
    const user = await getUserByUsername(username);
    // 简单明文密码比对，生产环境请使用 bcrypt
    if (!user || user.password !== password) {
      return res.json({ success: false, message: '用户名或密码错误' });
    }
    // 返回用户信息（不包含密码）
    const { password: _, ...safeUser } = user;
    res.json({ success: true, user: safeUser });
  } catch (error) {
    console.error('登录错误:', error);
    res.status(500).json({ success: false, message: '服务器内部错误' });
  }
});

// --- 业务接口 ---

// 普通用户提交文化IP (写入数据库，状态为 pending)
app.post('/api/submit', async (req, res) => {
  const { userId, newIP } = req.body || {};
  
  if (!userId || !newIP || !newIP.name) {
    return res.json({ success: false, message: '参数不完整' });
  }

  try {
    const entityId = nanoid();
    // 构造符合数据库结构的 payload
    // 注意：这里为了演示简化了字段，实际项目应包含更多前端表单数据
    const payload = {
      id: entityId,
      name: newIP.name,
      type: newIP.type || 'site', // 默认为遗址
      dynasty_id: newIP.dynasty_id || 'other', // 需确保数据库有此 ID
      desc: newIP.desc || '用户上传内容',
      lat: newIP.lat || 34.0, 
      lng: newIP.lng || 108.0
    };

    await createCulturalEntity(payload, userId);
    res.json({ success: true, message: '提交成功，请等待管理员审核' });
  } catch (error) {
    console.error('提交失败:', error);
    res.status(500).json({ success: false, message: '提交失败: ' + error.message });
  }
});

// 管理员获取待审核列表
app.get('/api/admin/pending', async (req, res) => {
  try {
    const list = await getPendingEntities();
    res.json({ success: true, data: list });
  } catch (error) {
    console.error('获取审核列表失败:', error);
    res.status(500).json({ success: false, message: '获取数据失败' });
  }
});

// 管理员审核操作
app.post('/api/admin/audit', async (req, res) => {
  const { id, status } = req.body; // status: 'published' 或 'rejected'
  
  if (!['published', 'rejected'].includes(status)) {
    return res.json({ success: false, message: '无效的状态' });
  }

  try {
    const success = await updateEntityStatus(id, status);
    if (success) {
      res.json({ success: true });
    } else {
      res.json({ success: false, message: '未找到记录或更新失败' });
    }
  } catch (error) {
    console.error('审核操作失败:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// --- 公共数据接口 ---

// 获取所有已发布的文化实体
app.get('/api/cultural-entities', async (req, res) => {
  try {
    const entities = await getAllCulturalEntities();
    res.json({ success: true, data: entities });
  } catch (error) {
    console.error('获取文化实体失败:', error);
    res.status(500).json({ success: false, message: '获取数据失败', error: error.message });
  }
});

// 获取单个文化实体详细信息
app.get('/api/cultural-entities/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const entity = await getCulturalEntityById(id);
    if (!entity) {
      return res.status(404).json({ success: false, message: '未找到该文化实体' });
    }
    res.json({ success: true, data: entity });
  } catch (error) {
    console.error('获取文化实体详情失败:', error);
    res.status(500).json({ success: false, message: '获取数据失败', error: error.message });
  }
});

// 获取知识图谱数据
app.get('/api/knowledge-graph/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const kgData = await getKnowledgeGraphNeighbors(id);
    res.json({ success: true, data: kgData });
  } catch (error) {
    console.error('获取知识图谱数据失败:', error);
    res.status(500).json({ success: false, message: '获取知识图谱数据失败', error: error.message });
  }
});

// 获取所有朝代
app.get('/api/dynasties', async (req, res) => {
  try {
    const dynasties = await getAllDynasties();
    res.json({ success: true, data: dynasties });
  } catch (error) {
    console.error('获取朝代信息失败:', error);
    res.status(500).json({ success: false, message: '获取朝代信息失败', error: error.message });
  }
});

// 获取用户足迹
app.get('/api/user/footprints', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.json({ success: false, message: 'Missing userId' });
  
  try {
    const footprints = await getUserFootprints(userId);
    res.json({ success: true, data: footprints });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '获取足迹失败' });
  }
});

// --- 静态文件服务和前端路由（必须在所有 API 路由之后） ---

// 静态文件服务 - 提供前端文件
const frontendPath = path.join(__dirname, '..', 'frontend');
app.use(express.static(frontendPath));

// 根路径重定向到开场页面
app.get('/', (req, res) => {
  res.redirect('/pages/intro.html');
});

// 404 处理 - 对于未匹配的路由，返回前端页面（用于支持前端路由）
app.get('*', (req, res) => {
  // 如果是 API 请求但未匹配，返回 404
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ success: false, message: 'API 路由未找到' });
  }
  // 否则返回前端页面（让前端路由处理）
  res.sendFile(path.join(frontendPath, 'pages', 'intro.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Backend running on http://localhost:${PORT}`));
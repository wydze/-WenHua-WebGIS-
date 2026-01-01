import pkg from 'pg';
const { Pool } = pkg;

// 数据库连接配置
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'webgis',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '051006',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// ===== 工具函数：根据地点名称查 wgs84 坐标（支持 jsonb 存储）
async function fetchCoordsByPlaceName(client, placeName) {
  if (!placeName) return null;

  // 1) 精确匹配（忽略大小写、前后空格）
  let sql = `
    SELECT wgs84
    FROM public.place
    WHERE trim(name) ILIKE trim($1)
    LIMIT 1
  `;
  let res = await client.query(sql, [placeName]);

  // 2) 若没命中则模糊匹配
  if (res.rows.length === 0) {
    sql = `
      SELECT wgs84
      FROM public.place
      WHERE name ILIKE '%' || $1 || '%'
      LIMIT 1
    `;
    res = await client.query(sql, [placeName]);
  }

  if (res.rows.length === 0) return null;
  const w = res.rows[0].wgs84;
  if (!w) return null;
  // jsonb 格式: {"latitude": .., "longitude": ..} 或 {"lat": .., "lng": ..}
  const lat = w.lat ?? w.latitude;
  const lng = w.lng ?? w.longitude;
  if (lat != null && lng != null) {
    return { lat: parseFloat(lat), lng: parseFloat(lng) };
  }
  return null;
}

// 测试连接
pool.on('connect', () => {
  console.log('✅ PostgreSQL 连接成功');
});

pool.on('error', (err) => {
  console.error('❌ PostgreSQL 连接错误:', err);
});

/**
 * 获取所有文化实体及其详细信息
 * 根据 type 字段关联到对应的子表
 */
export async function getAllCulturalEntities() {
  const client = await pool.connect();
  try {
    // 获取所有文化实体，关联朝代信息
    const entitiesQuery = `
      SELECT 
        ce.id,
        ce.name,
        ce.type,
        ce.description,
        ce.images,
        ce.tags,
        ce.meta_info,
        ce.dynasty_id,
        d.name as dynasty_name,
        d.full_name as dynasty_full_name,
        d.color_hex as dynasty_color,
        ce.kg_node_id
      FROM public.cultural_entity ce
      LEFT JOIN public.dynasty d ON ce.dynasty_id = d.id
      ORDER BY ce.created_at DESC
    `;
    
    const entitiesResult = await client.query(entitiesQuery);
    const entities = entitiesResult.rows;

    // 为每个实体获取详细信息（根据 type 查询对应的子表）
    const entitiesWithDetails = await Promise.all(
      entities.map(async (entity) => {
        let detailData = null;
        let coordinates = null;

        // 根据 type 查询对应的子表
        switch (entity.type) {
      case 'site':
        // 使用 point 索引取值（point[0], point[1]），兼容未装 PostGIS
        const siteQuery = `
          SELECT 
            s.name,
            s.site_type,
            (s.geometry)[0] as lng,
            (s.geometry)[1] as lat,
            s.address_modern,
            s.exist_status,
            s.construction_year
          FROM public.site s
          WHERE s.id = $1
        `;
        const siteResult = await client.query(siteQuery, [entity.id]);
            if (siteResult.rows.length > 0) {
              detailData = siteResult.rows[0];
              coordinates = {
                lat: parseFloat(siteResult.rows[0].lat),
                lng: parseFloat(siteResult.rows[0].lng)
              };
            }
            break;

      case 'person':
        const personQuery = `
          SELECT 
            p.name,
            p.alternative_names,
            p.gender,
            p.birth_year,
            p.death_year,
            p.birth_place_name,
            p.titles,
            p.ethnicity,
            p.biography
          FROM public.person p
          WHERE p.id = $1
        `;
        const personResult = await client.query(personQuery, [entity.id]);
            if (personResult.rows.length > 0) {
              detailData = personResult.rows[0];
              // 尝试从 place 表获取坐标
              if (personResult.rows[0].birth_place_name) {
                const placeQuery = `
                  SELECT wgs84
                  FROM public.place
                  WHERE name = $1
                `;
                const placeResult = await client.query(placeQuery, [personResult.rows[0].birth_place_name]);
                if (placeResult.rows.length > 0 && placeResult.rows[0].wgs84) {
                  const wgs84 = placeResult.rows[0].wgs84;
                  const latVal = wgs84.lat ?? wgs84.latitude;
                  const lngVal = wgs84.lng ?? wgs84.longitude;
                  if (latVal && lngVal) {
                    coordinates = { lat: parseFloat(latVal), lng: parseFloat(lngVal) };
                  }
                }
              }
            }
            break;

      case 'event':
        const eventQuery = `
          SELECT 
            e.name,
            e.event_type,
            e.start_date,
            e.end_date,
            e.year_range,
            e.date_display,
            e.location_name,
            e.outcome
          FROM public.event e
          WHERE e.id = $1
        `;
        const eventResult = await client.query(eventQuery, [entity.id]);
            if (eventResult.rows.length > 0) {
              detailData = eventResult.rows[0];
              // 尝试从 place 表获取坐标
              if (eventResult.rows[0].location_name) {
                const placeQuery = `
                  SELECT wgs84
                  FROM public.place
                  WHERE name = $1
                `;
                const placeResult = await client.query(placeQuery, [eventResult.rows[0].location_name]);
                if (placeResult.rows.length > 0 && placeResult.rows[0].wgs84) {
                  const wgs84 = placeResult.rows[0].wgs84;
                  const latVal = wgs84.lat ?? wgs84.latitude;
                  const lngVal = wgs84.lng ?? wgs84.longitude;
                  if (latVal && lngVal) {
                    coordinates = { lat: parseFloat(latVal), lng: parseFloat(lngVal) };
                  }
                }
              }
            }
            break;

      case 'artifact':
        const artifactQuery = `
          SELECT 
            a.name,
            a.material,
            a.craft,
            a.discovered_at,
            a.preserved_at
          FROM public.artifact a
          WHERE a.id = $1
        `;
        const artifactResult = await client.query(artifactQuery, [entity.id]);
            if (artifactResult.rows.length > 0) {
              detailData = artifactResult.rows[0];
              // ① 优先用 discovered_at
              let placeName = artifactResult.rows[0].discovered_at || artifactResult.rows[0].preserved_at;
              if (placeName) {
                const placeQuery = `SELECT wgs84 FROM public.place WHERE name = $1`;
                const placeResult = await client.query(placeQuery, [placeName]);
                if (placeResult.rows.length > 0 && placeResult.rows[0].wgs84) {
                  const wgs84 = placeResult.rows[0].wgs84;
                  const latVal = wgs84.lat ?? wgs84.latitude;
                  const lngVal = wgs84.lng ?? wgs84.longitude;
                  if (latVal && lngVal) {
                    coordinates = { lat: parseFloat(latVal), lng: parseFloat(lngVal) };
                  }
                }
              }
            }
            break;

      case 'literature':
        const literatureQuery = `
          SELECT 
            l.title,
            l.genre,
            l.author_name,
            l.year,
            l.content_summary
          FROM public.literature l
          WHERE l.id = $1
        `;
        const literatureResult = await client.query(literatureQuery, [entity.id]);
            if (literatureResult.rows.length > 0) {
              detailData = literatureResult.rows[0];
            }
            break;
        }

        // 构建返回数据格式（兼容前端现有格式）
        return {
          id: entity.id,
          name: entity.name,
          type: entity.type,
          dynasty: entity.dynasty_name || entity.dynasty_full_name || '未知',
          dynasty_id: entity.dynasty_id,
          dynasty_color: entity.dynasty_color,
          desc: entity.description || detailData?.biography || detailData?.content_summary || detailData?.outcome || '暂无描述',
          lat: coordinates?.lat || null,
          lng: coordinates?.lng || null,
          images: entity.images,
          tags: entity.tags,
          meta_info: entity.meta_info,
          kg_node_id: entity.kg_node_id, // Ensure kg_node_id is returned
          detail: detailData // 保存完整的详细信息
        };
      })
    );

    // 返回所有数据（包括没有坐标的，因为星云可视化不需要坐标）
    // 地图页面会自己过滤有坐标的数据
    return entitiesWithDetails;
  } finally {
    client.release();
  }
}

/**
 * 获取单个文化实体及其详细信息
 * 根据 type 字段关联到对应的子表
 */
export async function getCulturalEntityById(id) {
  const client = await pool.connect();
  try {
    // 获取文化实体，关联朝代信息
    const entityQuery = `
      SELECT 
        ce.id,
        ce.name,
        ce.type,
        ce.description,
        ce.images,
        ce.tags,
        ce.meta_info,
        ce.dynasty_id,
        ce.kg_node_id,
        ce.created_at,
        d.name as dynasty_name,
        d.full_name as dynasty_full_name,
        d.color_hex as dynasty_color
      FROM public.cultural_entity ce
      LEFT JOIN public.dynasty d ON ce.dynasty_id = d.id
      WHERE ce.id = $1
    `;
    
    const entityResult = await client.query(entityQuery, [id]);
    if (entityResult.rows.length === 0) {
      return null;
    }
    
    const entity = entityResult.rows[0];
    let detailData = null;
    let coordinates = null;

    // 根据 type 查询对应的子表
    switch (entity.type) {
      case 'site':
        const siteQuery = `
          SELECT 
            s.name,
            s.site_type,
            (s.geometry)[0] as lng,
            (s.geometry)[1] as lat,
            s.address_modern,
            s.exist_status,
            s.construction_year
          FROM public.site s
          WHERE s.id = $1
        `;
        const siteResult = await client.query(siteQuery, [id]);
        if (siteResult.rows.length > 0) {
          detailData = siteResult.rows[0];
          coordinates = {
            lat: parseFloat(siteResult.rows[0].lat),
            lng: parseFloat(siteResult.rows[0].lng)
          };
        }
        break;

      case 'person':
        const personQuery = `
          SELECT 
            p.name,
            p.alternative_names,
            p.gender,
            p.birth_year,
            p.death_year,
            p.birth_place_name,
            p.titles,
            p.ethnicity,
            p.biography
          FROM public.person p
          WHERE p.id = $1
        `;
        const personResult = await client.query(personQuery, [id]);
        if (personResult.rows.length > 0) {
          detailData = personResult.rows[0];
          // 尝试从 place 表获取坐标
          if (personResult.rows[0].birth_place_name) {
            const placeQuery = `
              SELECT wgs84
              FROM public.place
              WHERE name = $1
            `;
            const placeResult = await client.query(placeQuery, [personResult.rows[0].birth_place_name]);
            if (placeResult.rows.length > 0 && placeResult.rows[0].wgs84) {
              const wgs84 = placeResult.rows[0].wgs84;
              const latVal = wgs84.lat ?? wgs84.latitude;
              const lngVal = wgs84.lng ?? wgs84.longitude;
              if (latVal && lngVal) {
                coordinates = { lat: parseFloat(latVal), lng: parseFloat(lngVal) };
              }
            }
          }
        }
        break;

      case 'event':
        const eventQuery = `
          SELECT 
            e.name,
            e.event_type,
            e.start_date,
            e.end_date,
            e.year_range,
            e.date_display,
            e.location_name,
            e.outcome
          FROM public.event e
          WHERE e.id = $1
        `;
        const eventResult = await client.query(eventQuery, [id]);
        if (eventResult.rows.length > 0) {
          detailData = eventResult.rows[0];
          // 尝试从 place 表获取坐标
          if (eventResult.rows[0].location_name) {
            const placeQuery = `
              SELECT wgs84
              FROM public.place
              WHERE name = $1
            `;
            const placeResult = await client.query(placeQuery, [eventResult.rows[0].location_name]);
            if (placeResult.rows.length > 0 && placeResult.rows[0].wgs84) {
              const wgs84 = placeResult.rows[0].wgs84;
              const latVal = wgs84.lat ?? wgs84.latitude;
              const lngVal = wgs84.lng ?? wgs84.longitude;
              if (latVal && lngVal) {
                coordinates = { lat: parseFloat(latVal), lng: parseFloat(lngVal) };
              }
            }
          }
        }
        break;

      case 'artifact':
        const artifactQuery = `
          SELECT 
            a.name,
            a.material,
            a.craft,
            a.discovered_at,
            a.preserved_at
          FROM public.artifact a
          WHERE a.id = $1
        `;
        const artifactResult = await client.query(artifactQuery, [id]);
        if (artifactResult.rows.length > 0) {
          detailData = artifactResult.rows[0];
          let placeName = artifactResult.rows[0].discovered_at || artifactResult.rows[0].preserved_at;
          if (placeName) {
            const placeQuery = `SELECT wgs84 FROM public.place WHERE name = $1`;
            const placeResult = await client.query(placeQuery, [placeName]);
            if (placeResult.rows.length > 0 && placeResult.rows[0].wgs84) {
              const wgs84 = placeResult.rows[0].wgs84;
              const latVal = wgs84.lat ?? wgs84.latitude;
              const lngVal = wgs84.lng ?? wgs84.longitude;
              if (latVal && lngVal) {
                coordinates = { lat: parseFloat(latVal), lng: parseFloat(lngVal) };
              }
            }
          }
        }
        break;

      case 'literature':
        const literatureQuery = `
          SELECT 
            l.title,
            l.genre,
            l.author_name,
            l.year,
            l.content_summary
          FROM public.literature l
          WHERE l.id = $1
        `;
        const literatureResult = await client.query(literatureQuery, [id]);
        if (literatureResult.rows.length > 0) {
          detailData = literatureResult.rows[0];
        }
        break;
    }

    // 构建返回数据格式
    return {
      id: entity.id,
      name: entity.name,
      type: entity.type,
      dynasty: entity.dynasty_name || entity.dynasty_full_name || '未知',
      dynasty_id: entity.dynasty_id,
      dynasty_color: entity.dynasty_color,
      desc: entity.description || detailData?.biography || detailData?.content_summary || detailData?.outcome || '暂无描述',
      lat: coordinates?.lat || null,
      lng: coordinates?.lng || null,
      images: entity.images,
      tags: entity.tags,
      meta_info: entity.meta_info,
      kg_node_id: entity.kg_node_id,
      created_at: entity.created_at,
      detail: detailData // 保存完整的详细信息
    };
  } finally {
    client.release();
  }
}

/**
 * 根据 kg_node_id 列表查询对应的 cultural_entity.id (UUID)
 * @param {string[]} kgNodeIds
 * @returns {Promise<Map<string, string>>}
 */
export async function getEntityIdsByKgNodeIds(kgNodeIds) {
  if (!kgNodeIds || kgNodeIds.length === 0) {
    return new Map();
  }
  const client = await pool.connect();
  try {
    const query = `
      SELECT kg_node_id, id FROM public.cultural_entity
      WHERE kg_node_id = ANY($1::text[])
    `;
    const result = await client.query(query, [kgNodeIds]);
    const idMap = new Map();
    result.rows.forEach(row => {
      idMap.set(row.kg_node_id, row.id);
    });
    return idMap;
  } finally {
    client.release();
  }
}

/**
 * 获取所有朝代信息
 */
export async function getAllDynasties() {
  const client = await pool.connect();
  try {
    const query = `
      SELECT id, name, full_name, start_year, end_year, capital_name, color_hex
      FROM public.dynasty
      ORDER BY start_year ASC
    `;
    const result = await client.query(query);
    return result.rows;
  } finally {
    client.release();
  }
}

export default pool;

export async function createCulturalEntity(data, creatorId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. 插入主表 (默认 status 为 pending)
    const entityQuery = `
      INSERT INTO public.cultural_entity 
      (id, name, type, dynasty_id, description, creator_id, status, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, 'pending', NOW())
      RETURNING id
    `;
    const entityValues = [
      data.id, 
      data.name, 
      data.type, 
      data.dynasty_id, // 确保前端传的是 ID，例如 'tang', 'song'
      data.desc, 
      creatorId
    ];
    await client.query(entityQuery, entityValues);

    // 2. 根据类型插入子表 (此处以 site 为例，其他类型同理)
    if (data.type === 'site') {
      const siteQuery = `
        INSERT INTO public.site (id, name, address_modern, geometry)
        VALUES ($1, $2, $3, point($4, $5))
      `;
      // 注意：这里简单处理 geometry，实际建议用 PostGIS ST_MakePoint
      await client.query(siteQuery, [data.id, data.name, '用户上传地址', data.lng, data.lat]);
    }
    // ... 可以扩展其他类型的插入逻辑 ...

    await client.query('COMMIT');
    return { success: true, id: data.id };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * 获取待审核列表 (仅 Admin 可见)
 */
export async function getPendingEntities() {
  const client = await pool.connect();
  try {
    const query = `
      SELECT ce.*, u.name as creator_name 
      FROM public.cultural_entity ce
      LEFT JOIN public.users u ON ce.creator_id = u.id
      WHERE ce.status = 'pending'
      ORDER BY ce.created_at DESC
    `;
    const res = await client.query(query);
    return res.rows;
  } finally {
    client.release();
  }
}

/**
 * 审核实体 (更新状态)
 */
export async function updateEntityStatus(id, status) {
  const client = await pool.connect();
  try {
    const query = 'UPDATE public.cultural_entity SET status = $1 WHERE id = $2 RETURNING id';
    const res = await client.query(query, [status, id]);
    return res.rowCount > 0;
  } finally {
    client.release();
  }
}

export async function getUserByUsername(username) {
  const client = await pool.connect();
  try {
    const res = await client.query('SELECT * FROM public.users WHERE username = $1', [username]);
    return res.rows[0];
  } finally {
    client.release();
  }
}

export async function getUserFootprints(userId) {
  const client = await pool.connect();
  try {
  
    const query = `
      SELECT 
        uf.visited_at,
        ce.id,
        ce.name,
        ce.type,
        d.name as dynasty,
        s.address_modern,
        (s.geometry)[0] as lng,
        (s.geometry)[1] as lat
      FROM public.user_footprints uf
      JOIN public.cultural_entity ce ON uf.entity_id = ce.id
      LEFT JOIN public.dynasty d ON ce.dynasty_id = d.id
      LEFT JOIN public.site s ON ce.id = s.id
      WHERE uf.user_id = $1
      ORDER BY uf.visited_at DESC
    `;
    const res = await client.query(query, [userId]);
    // 过滤掉没有坐标的数据 (无法在地足迹图上显示)
    return res.rows.filter(row => row.lat && row.lng);
  } finally {
    client.release();
  }
}
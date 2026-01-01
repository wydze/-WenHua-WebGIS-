import neo4j from 'neo4j-driver';
import { getEntityIdsByKgNodeIds } from './db.js';

// Neo4j 连接配置
const driver = neo4j.driver(
  'neo4j://localhost:7687', // Neo4j URI
  neo4j.auth.basic('neo4j', 'Wyt051006') // 用户名和密码
);

/**
 * 根据 kg_node_id 查询知识图谱中的邻居节点和关系
 * @param {string} kgNodeId - 文化实体的知识图谱节点ID
 * @returns {Promise<{neighbors: any[], triples: any[]}>}
 */
export async function getKnowledgeGraphNeighbors(kgNodeId) {
  const session = driver.session();
  try {
    const result = await session.run(
      `
      MATCH (startNode:Node {id: $id})
      OPTIONAL MATCH (startNode)-[r]-(neighbor)
      RETURN 
        startNode AS source,
        COLLECT({
          relationship: type(r),
          target: {
            id: neighbor.id,
            name: neighbor.name,
            labels: labels(neighbor)
          }
        }) AS neighbors
      `,
      { id: kgNodeId }
    );

    if (result.records.length === 0) {
      return { neighbors: [], triples: [] };
    }

    const record = result.records[0];
    const source = record.get('source').properties;
    const neighborsData = record.get('neighbors');

    const neighbors = neighborsData.map(item => item.target).filter(n => n.id);
    const triples = neighborsData.map(item => ({
      head: source.name,
      relation: item.relationship,
      tail: item.target.name
    })).filter(t => t.relation);

    // 获取所有邻居节点的 kg_node_id
    const kgNodeIds = neighbors.map(n => n.id);
    // 根据 kg_node_id 查询 PostgreSQL 获取 UUID
    const idMap = await getEntityIdsByKgNodeIds(kgNodeIds);

    // 将 UUID 附加到邻居节点数据中
    const augmentedNeighbors = neighbors.map(n => ({
      ...n,
      uuid: idMap.get(n.id) // 添加 PostgreSQL 中的 UUID
    }));

    return { neighbors: augmentedNeighbors, triples };
  } finally {
    await session.close();
  }
}

// 导出 driver 以便在其他地方使用
export default driver;

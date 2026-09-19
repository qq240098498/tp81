const crypto = require('crypto');
const { load, save, MAX_VERSION_LENGTH } = require('./store');
const { ApiError, pickText } = require('./errors');

// 最低版本的写法与依赖版本同一个口径：三段数字，需要时可以带一段预发布后缀
const MIN_VERSION_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;

function validateMinVersion(value) {
  const version = pickText(value);
  if (!version) throw new ApiError(400, 'MIN_VERSION_REQUIRED', '请填写最低版本要求', 'minVersion');
  if (version.length > MAX_VERSION_LENGTH) {
    throw new ApiError(400, 'MIN_VERSION_TOO_LONG', `最低版本不能超过 ${MAX_VERSION_LENGTH} 个字符`, 'minVersion');
  }
  if (!MIN_VERSION_PATTERN.test(version)) {
    throw new ApiError(400, 'MIN_VERSION_INVALID', '最低版本要写成三段数字，例如 2.10.0，需要时可以带一段预发布后缀', 'minVersion');
  }
  return version;
}

// 关系两端都必须是已经登记过的依赖；没登记过当场指出是哪一端、哪个登记号
function findEndpoint(data, id, side) {
  const value = pickText(id);
  const field = side === 'from' ? 'fromDepId' : 'toDepId';
  if (!value) {
    throw new ApiError(400, side === 'from' ? 'REL_FROM_REQUIRED' : 'REL_TO_REQUIRED',
      side === 'from' ? '请选择从哪条依赖出发' : '请选择需要哪条依赖', field);
  }
  const found = data.deps.find((item) => item.id === value);
  if (!found) {
    throw new ApiError(404, side === 'from' ? 'REL_FROM_NOT_FOUND' : 'REL_TO_NOT_FOUND',
      side === 'from'
        ? `出发的这条依赖（登记号 ${value}）没有登记过或已被删除，刷新后再试`
        : `指向的依赖（登记号 ${value}）没有登记过或已被删除，关系不成立`, field);
  }
  return found;
}

// 沿"需要"边从 startId 走到 targetId 的一条最短路径（含两端），走不通返回 null
function findPath(data, startId, targetId) {
  const adjacency = new Map();
  data.relations.forEach((rel) => {
    if (!adjacency.has(rel.fromDepId)) adjacency.set(rel.fromDepId, []);
    adjacency.get(rel.fromDepId).push(rel.toDepId);
  });
  const parent = new Map([[startId, null]]);
  const queue = [startId];
  while (queue.length) {
    const current = queue.shift();
    if (current === targetId) {
      const path = [];
      let node = current;
      while (node) {
        path.unshift(node);
        node = parent.get(node);
      }
      return path;
    }
    (adjacency.get(current) || []).forEach((next) => {
      if (!parent.has(next)) {
        parent.set(next, current);
        queue.push(next);
      }
    });
  }
  return null;
}

function depName(data, id) {
  const found = data.deps.find((item) => item.id === id);
  return found ? found.name : id;
}

// 关系清单：带上两端依赖的名称与所属项目，页面直接能摆；deps 是全部依赖的简要清单，给下拉框用
function listRelations() {
  const data = load();
  const byId = new Map(data.deps.map((item) => [item.id, item]));
  const relations = data.relations
    .map((rel) => {
      const from = byId.get(rel.fromDepId);
      const to = byId.get(rel.toDepId);
      return {
        id: rel.id,
        fromDepId: rel.fromDepId,
        toDepId: rel.toDepId,
        minVersion: rel.minVersion,
        createdAt: rel.createdAt,
        fromName: from ? from.name : rel.fromDepId,
        fromProjectId: from ? from.projectId : '',
        toName: to ? to.name : rel.toDepId,
        toProjectId: to ? to.projectId : '',
      };
    })
    .sort((a, b) => {
      if (a.fromName !== b.fromName) return a.fromName < b.fromName ? -1 : 1;
      if (a.toName !== b.toName) return a.toName < b.toName ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });

  const deps = data.deps
    .map((item) => ({ id: item.id, projectId: item.projectId, name: item.name, version: item.version }))
    .sort((a, b) => {
      if (a.projectId !== b.projectId) return a.projectId < b.projectId ? -1 : 1;
      if (a.name !== b.name) return a.name < b.name ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });

  return { relations, deps };
}

function createRelation(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  const from = findEndpoint(data, input.fromDepId, 'from');
  const to = findEndpoint(data, input.toDepId, 'to');
  const minVersion = validateMinVersion(input.minVersion);

  const duplicated = data.relations.find((rel) => rel.fromDepId === from.id && rel.toDepId === to.id);
  if (duplicated) {
    throw new ApiError(409, 'REL_DUPLICATED', `「${from.name}」需要「${to.name}」这条关系已经登记过了`, 'toDepId');
  }

  // 自己需要自己、两条互相需要、三条以上绕回起点，都是环形，当场拒绝并写清环上有谁
  if (from.id === to.id) {
    throw new ApiError(409, 'REL_CYCLE', `关系不成立，会绕成一圈：${from.name} → ${from.name}，自己不能需要自己`, 'toDepId');
  }
  const path = findPath(data, to.id, from.id);
  if (path) {
    const ring = [from.id, ...path].map((id) => depName(data, id)).join(' → ');
    throw new ApiError(409, 'REL_CYCLE', `关系不成立，会绕成一圈：${ring}。请先拆掉环上的某一段再登记`, 'toDepId');
  }

  const created = {
    id: crypto.randomUUID(),
    fromDepId: from.id,
    toDepId: to.id,
    minVersion,
    createdAt: new Date().toISOString(),
  };
  data.relations.push(created);
  save(data);
  return created;
}

function deleteRelation(id) {
  const data = load();
  const index = data.relations.findIndex((rel) => rel.id === id);
  if (index === -1) throw new ApiError(404, 'REL_NOT_FOUND', '这条关系不存在或已被删除', '');
  const [removed] = data.relations.splice(index, 1);
  save(data);
  return { id: removed.id };
}

// 从一条依赖出发，把它一路往下需要的依赖按层展开：
// 广度优先保证每条依赖只在最早出现的那一层登记一次，同一层有多个带入者时都记下来
function depClosure(depId) {
  const data = load();
  const root = data.deps.find((item) => item.id === pickText(depId));
  if (!root) throw new ApiError(404, 'DEP_NOT_FOUND', '这条依赖登记不存在或已被删除', 'depId');

  const byId = new Map(data.deps.map((item) => [item.id, item]));
  const adjacency = new Map();
  data.relations.forEach((rel) => {
    if (!adjacency.has(rel.fromDepId)) adjacency.set(rel.fromDepId, []);
    adjacency.get(rel.fromDepId).push(rel);
  });

  const seen = new Map([[root.id, { layer: 0, introducedBy: [] }]]);
  let frontier = [root.id];
  let layer = 0;
  while (frontier.length) {
    const next = [];
    frontier.forEach((currentId) => {
      const current = byId.get(currentId);
      (adjacency.get(currentId) || []).forEach((rel) => {
        const known = seen.get(rel.toDepId);
        if (known) {
          // 只在同样是最早那一层被另一条边带进来时，才把带入者补上
          if (known.layer === layer + 1) {
            known.introducedBy.push({
              depId: currentId,
              name: current ? current.name : currentId,
              minVersion: rel.minVersion,
              layer,
            });
          }
          return;
        }
        seen.set(rel.toDepId, {
          layer: layer + 1,
          introducedBy: [{
            depId: currentId,
            name: current ? current.name : currentId,
            minVersion: rel.minVersion,
            layer,
          }],
        });
        next.push(rel.toDepId);
      });
    });
    frontier = next;
    layer += 1;
  }

  const items = Array.from(seen.entries())
    .filter(([, info]) => info.layer > 0)
    .map(([id, info]) => {
      const dep = byId.get(id);
      return {
        depId: id,
        name: dep ? dep.name : id,
        version: dep ? dep.version : '',
        projectId: dep ? dep.projectId : '',
        layer: info.layer,
        introducedBy: info.introducedBy,
      };
    })
    .sort((a, b) => {
      if (a.layer !== b.layer) return a.layer - b.layer;
      if (a.name !== b.name) return a.name < b.name ? -1 : 1;
      return a.depId < b.depId ? -1 : 1;
    });

  return {
    root: { id: root.id, name: root.name, version: root.version, projectId: root.projectId },
    total: items.length,
    maxLayer: items.length ? Math.max(...items.map((item) => item.layer)) : 0,
    items,
  };
}

module.exports = {
  listRelations,
  createRelation,
  deleteRelation,
  depClosure,
};

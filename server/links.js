const crypto = require('crypto');
const { load, save, findRequirePath, MAX_VERSION_LENGTH } = require('./store');
const { ApiError, pickText } = require('./errors');
const { VERSION_PATTERN } = require('./deps');

// 最低版本要求与登记版本同口径：三段数字，后面可选择带一段预发布后缀
function validateMinVersion(value) {
  const minVersion = pickText(value);
  if (!minVersion) throw new ApiError(400, 'REL_VERSION_REQUIRED', '请填写最低版本要求', 'minVersion');
  if (minVersion.length > MAX_VERSION_LENGTH) {
    throw new ApiError(400, 'REL_VERSION_TOO_LONG', `最低版本不能超过 ${MAX_VERSION_LENGTH} 个字符`, 'minVersion');
  }
  if (!VERSION_PATTERN.test(minVersion)) {
    throw new ApiError(400, 'REL_VERSION_INVALID', `最低版本要求「${minVersion}」的写法不成立，要写成三段数字，例如 2.7.0，需要时可以带一段预发布后缀`, 'minVersion');
  }
  return minVersion;
}

// 页面上同一条依赖名可能出现在多个项目里，关系一律带上项目名才分得清
function depLabel(data, dep) {
  const project = data.projects.find((item) => item.id === dep.projectId);
  return `${project ? project.name : dep.projectId}/${dep.name}`;
}

function depBrief(data, dep) {
  const project = data.projects.find((item) => item.id === dep.projectId);
  return {
    id: dep.id,
    name: dep.name,
    version: dep.version,
    projectId: dep.projectId,
    projectName: project ? project.name : '',
  };
}

function findDep(data, id, field, requiredMessage, missingMessage) {
  const value = pickText(id);
  if (!value) throw new ApiError(400, 'REL_DEP_REQUIRED', requiredMessage, field);
  const found = data.deps.find((item) => item.id === value);
  if (!found) throw new ApiError(404, 'REL_DEP_NOT_FOUND', missingMessage, field);
  return found;
}

function decorateLink(data, link) {
  const from = data.deps.find((item) => item.id === link.fromId);
  const to = data.deps.find((item) => item.id === link.toId);
  return {
    ...link,
    from: from ? depBrief(data, from) : null,
    to: to ? depBrief(data, to) : null,
  };
}

// 关系清单：每条都带上两端登记的名称、版本与所属项目，页面直接拿来展示
function listLinks() {
  const data = load();
  const links = data.links
    .map((link) => decorateLink(data, link))
    .sort((a, b) => {
      const af = a.from ? `${a.from.projectName}/${a.from.name}` : '';
      const bf = b.from ? `${b.from.projectName}/${b.from.name}` : '';
      if (af !== bf) return af < bf ? -1 : 1;
      const at = a.to ? `${a.to.projectName}/${a.to.name}` : '';
      const bt = b.to ? `${b.to.projectName}/${b.to.name}` : '';
      if (at !== bt) return at < bt ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });
  return { links };
}

function createLink(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  const from = findDep(data, input.fromId, 'linkFrom',
    '请选择需要别人的那条依赖',
    `要登记关系的这条依赖（登记号 ${pickText(input.fromId)}）没有登记过，请先在依赖登记区登记`);
  const to = findDep(data, input.toId, 'linkTo',
    '请选择被需要的那条依赖',
    `这条关系指向的依赖（登记号 ${pickText(input.toId)}）没有登记过，请先在依赖登记区登记`);
  const minVersion = validateMinVersion(input.minVersion);

  const fromLabel = depLabel(data, from);
  const toLabel = depLabel(data, to);

  if (from.id === to.id) {
    throw new ApiError(409, 'REL_CYCLE', `${fromLabel} 不能需要自己，环上只有它自己：${fromLabel} → ${fromLabel}`, 'linkTo');
  }

  const duplicated = data.links.find((link) => link.fromId === from.id && link.toId === to.id);
  if (duplicated) {
    throw new ApiError(409, 'REL_DUPLICATED', `${fromLabel} 需要 ${toLabel} 这条关系已经登记过了`, 'linkTo');
  }

  // 新关系 from → to 一旦让 to 能走回 from 就绕成一圈，把环上的依赖逐个点名
  const path = findRequirePath(data.links, to.id, from.id);
  if (path) {
    const byId = new Map(data.deps.map((item) => [item.id, item]));
    const cycle = [from.id].concat(path).map((id) => depLabel(data, byId.get(id)));
    throw new ApiError(409, 'REL_CYCLE', `这样登记会绕成一圈：${cycle.join(' → ')}，请先断开环上的一条关系`, 'linkTo');
  }

  const created = {
    id: crypto.randomUUID(),
    fromId: from.id,
    toId: to.id,
    minVersion,
    createdAt: new Date().toISOString(),
  };
  data.links.push(created);
  save(data);
  return decorateLink(data, created);
}

function deleteLink(id) {
  const data = load();
  const index = data.links.findIndex((item) => item.id === id);
  if (index === -1) throw new ApiError(404, 'REL_NOT_FOUND', '这条关系不存在或已被删除', '');
  const [removed] = data.links.splice(index, 1);
  save(data);
  return { id: removed.id };
}

// 从某条登记出发一路往下需要的完整清单：按层展开，同一条登记只保留最早出现的那一层，
// 每一条都记下是第几层、由哪一条带进来的
function getClosure(id) {
  const data = load();
  const root = data.deps.find((item) => item.id === id);
  if (!root) throw new ApiError(404, 'DEP_NOT_FOUND', '这条依赖登记不存在或已被删除', '');

  const byId = new Map(data.deps.map((item) => [item.id, item]));
  const items = [];
  const seen = new Set([root.id]);
  let frontier = [root.id];
  let depth = 1;
  while (frontier.length) {
    const next = [];
    frontier.forEach((fromId) => {
      data.links
        .filter((link) => link.fromId === fromId)
        .forEach((link) => {
          if (seen.has(link.toId)) return;
          seen.add(link.toId);
          const dep = byId.get(link.toId);
          const via = byId.get(fromId);
          if (!dep || !via) return;
          items.push({
            ...depBrief(data, dep),
            depth,
            viaId: via.id,
            viaName: via.name,
            viaProjectName: depBrief(data, via).projectName,
            minVersion: link.minVersion,
          });
          next.push(link.toId);
        });
    });
    frontier = next;
    depth += 1;
  }

  items.sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });

  return {
    root: depBrief(data, root),
    items,
    maxDepth: items.length ? items[items.length - 1].depth : 0,
  };
}

module.exports = {
  listLinks,
  createLink,
  deleteLink,
  getClosure,
};

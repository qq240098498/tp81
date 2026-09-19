// 页面交互：项目清单与依赖登记都从服务端拉取，任何一步失败都把说明显示在顶部并标到对应输入项上

const state = {
  projects: [],
  deps: [],
  licenses: [],
  statuses: [],
  relations: [],
  relationDeps: [],
  closure: null,
  closureDepId: '',
  editingId: '',
};

const el = (id) => document.getElementById(id);

// 统一的请求入口：出错时把服务端给的错误码、说明与出错位置一起抛出去
async function request(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch (err) {
    payload = null;
  }
  if (!res.ok) {
    const error = (payload && payload.error) || {};
    const failure = new Error(error.message || `请求失败（状态码 ${res.status}）`);
    failure.code = error.code || '';
    failure.field = error.field || '';
    throw failure;
  }
  return payload;
}

function notify(message, kind) {
  const box = el('notice');
  box.textContent = message;
  box.className = `notice ${kind === 'ok' ? 'ok' : 'error'}`;
}

function clearNotice() {
  const box = el('notice');
  box.className = 'notice hidden';
  box.textContent = '';
}

function clearFieldMarks() {
  document.querySelectorAll('.invalid').forEach((node) => node.classList.remove('invalid'));
}

// 把出错位置标到具体输入项上：项目区与依赖区共用一套标记
function markField(field) {
  if (!field) return;
  const target = document.querySelector(`[data-field="${field}"]`);
  if (!target) return;
  target.classList.add('invalid');
  const input = target.tagName === 'INPUT' || target.tagName === 'SELECT' ? target : target.querySelector('input, select');
  if (input) input.focus();
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (num) => String(num).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// 操作者名字记在浏览器里，刷新之后还在，保存时随请求一起带上
const OPERATOR_KEY = 'dep-ledger-operator';

function currentOperator() {
  return el('operator').value.trim();
}

function restoreOperator() {
  el('operator').value = window.localStorage.getItem(OPERATOR_KEY) || '';
}

async function loadHealth() {
  try {
    await request('/api/health');
    el('health').textContent = '服务正常';
    el('health').className = 'health ok';
  } catch (err) {
    el('health').textContent = '服务连不上';
    el('health').className = 'health bad';
  }
}

async function loadProjects() {
  const payload = await request('/api/projects');
  state.projects = payload.projects || [];
  renderProjects();
  renderProjectOptions();
}

async function loadDeps() {
  const params = new URLSearchParams();
  const projectId = el('filter-project').value;
  const status = el('filter-status').value;
  const license = el('filter-license').value;
  const keyword = el('filter-keyword').value.trim();
  if (projectId) params.set('projectId', projectId);
  if (status) params.set('status', status);
  if (license) params.set('license', license);
  if (keyword) params.set('keyword', keyword);
  const query = params.toString();
  const payload = await request(`/api/deps${query ? `?${query}` : ''}`);
  state.deps = payload.deps || [];
  state.licenses = payload.licenses || [];
  state.statuses = payload.statuses || [];
  renderDepFilterOptions();
  renderDeps();
}

// 关系清单与依赖登记分开拉：关系区不受依赖区筛选条件影响，始终看全量
async function loadRelations() {
  const payload = await request('/api/relations');
  state.relations = payload.relations || [];
  state.relationDeps = payload.deps || [];
  renderRelationOptions();
  renderRelations();
  renderDeps();
}

function renderProjects() {
  const body = el('project-body');
  body.innerHTML = state.projects.map((item) => `<tr>
      <td>${escapeHtml(item.name)}</td>
      <td>${escapeHtml(item.owner) || '<span class="missing">未指定</span>'}</td>
      <td class="note-cell">${escapeHtml(item.note)}</td>
      <td>${item.depCount} 条</td>
      <td class="mono">${escapeHtml(formatTime(item.createdAt))}</td>
      <td class="actions">
        <button type="button" class="link" data-project-rename="${escapeHtml(item.id)}">改名</button>
        <button type="button" class="link" data-project-owner="${escapeHtml(item.id)}">改负责人</button>
        <button type="button" class="link danger" data-project-delete="${escapeHtml(item.id)}">删除</button>
      </td>
    </tr>`).join('');
  el('project-empty').classList.toggle('hidden', state.projects.length > 0);
}

function renderProjectOptions() {
  const select = el('dep-project');
  const current = select.value;
  select.innerHTML = state.projects
    .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`)
    .join('');
  if (state.projects.some((item) => item.id === current)) select.value = current;

  const filter = el('filter-project');
  const filterCurrent = filter.value;
  filter.innerHTML = '<option value="">全部项目</option>'
    + state.projects.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join('');
  if (state.projects.some((item) => item.id === filterCurrent)) filter.value = filterCurrent;
}

function renderDepFilterOptions() {
  const statusSelect = el('filter-status');
  const statusCurrent = statusSelect.value;
  statusSelect.innerHTML = '<option value="">全部状态</option>'
    + state.statuses.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
  if (state.statuses.includes(statusCurrent)) statusSelect.value = statusCurrent;

  const licenseSelect = el('filter-license');
  const licenseCurrent = licenseSelect.value;
  licenseSelect.innerHTML = '<option value="">全部许可</option>'
    + state.licenses.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
  if (state.licenses.includes(licenseCurrent)) licenseSelect.value = licenseCurrent;

  const statusForm = el('dep-status');
  const statusFormCurrent = statusForm.value;
  statusForm.innerHTML = state.statuses
    .map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`)
    .join('');
  if (state.statuses.includes(statusFormCurrent)) statusForm.value = statusFormCurrent;
}

function projectName(projectId) {
  const found = state.projects.find((item) => item.id === projectId);
  return found ? found.name : projectId;
}

// 依赖名下拉选项与单元格提示都用「项目 / 名称 @版本」这个口径，同名依赖分属不同项目时也能分清
function depLabel(dep) {
  return `${projectName(dep.projectId)} / ${dep.name} @${dep.version}`;
}

// 「需要」列：这条依赖自己需要谁，带上最低版本；「被需要」列：谁需要它
function needsCell(depId) {
  const list = state.relations.filter((rel) => rel.fromDepId === depId);
  if (!list.length) return '<span class="missing">无</span>';
  return list.map((rel) => {
    const tip = `${projectName(rel.toProjectId)} / ${rel.toName}，最低版本 ≥${rel.minVersion}`;
    return `<span class="rel-chip" title="${escapeHtml(tip)}">${escapeHtml(rel.toName)}≥${escapeHtml(rel.minVersion)}</span>`;
  }).join('、');
}

function neededByCell(depId) {
  const list = state.relations.filter((rel) => rel.toDepId === depId);
  if (!list.length) return '<span class="missing">无</span>';
  return list.map((rel) => {
    const tip = `${projectName(rel.fromProjectId)} / ${rel.fromName}，要求 ≥${rel.minVersion}`;
    return `<span class="rel-chip" title="${escapeHtml(tip)}">${escapeHtml(rel.fromName)}</span>`;
  }).join('、');
}

function renderDeps() {
  const body = el('dep-body');
  body.innerHTML = state.deps.map((item) => {
    const statusTag = item.status === '已弃用' ? 'off' : 'on';
    return `<tr>
      <td>${escapeHtml(projectName(item.projectId))}</td>
      <td class="mono">${escapeHtml(item.name)}</td>
      <td class="mono">${escapeHtml(item.version)}</td>
      <td>${item.license ? escapeHtml(item.license) : '<span class="missing">未填</span>'}</td>
      <td>${item.owner ? escapeHtml(item.owner) : '<span class="missing">未指定</span>'}</td>
      <td><span class="tag ${statusTag}">${escapeHtml(item.status)}</span></td>
      <td>${needsCell(item.id)}</td>
      <td>${neededByCell(item.id)}</td>
      <td class="note-cell">${escapeHtml(item.note)}</td>
      <td class="mono">${escapeHtml(formatTime(item.updatedAt))}</td>
      <td class="actions">
        <button type="button" class="link" data-dep-edit="${escapeHtml(item.id)}">编辑</button>
        <button type="button" class="link danger" data-dep-delete="${escapeHtml(item.id)}">删除</button>
      </td>
    </tr>`;
  }).join('');
  el('dep-empty').classList.toggle('hidden', state.deps.length > 0);
}

// 关系表单与展开工具里的三个下拉框都列全部依赖，尽量保住当前选中项
function fillDepSelect(select, keep) {
  const current = keep === undefined ? select.value : keep;
  select.innerHTML = state.relationDeps
    .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(depLabel(item))}</option>`)
    .join('');
  if (state.relationDeps.some((item) => item.id === current)) select.value = current;
}

function renderRelationOptions() {
  fillDepSelect(el('relation-from'));
  fillDepSelect(el('relation-to'));
  fillDepSelect(el('closure-dep'), state.closureDepId || el('closure-dep').value);
}

function renderRelations() {
  const body = el('relation-body');
  body.innerHTML = state.relations.map((rel) => `<tr>
      <td>${escapeHtml(projectName(rel.fromProjectId))} / <span class="mono">${escapeHtml(rel.fromName)}</span></td>
      <td>${escapeHtml(projectName(rel.toProjectId))} / <span class="mono">${escapeHtml(rel.toName)}</span></td>
      <td class="mono">≥${escapeHtml(rel.minVersion)}</td>
      <td class="mono">${escapeHtml(formatTime(rel.createdAt))}</td>
      <td class="actions">
        <button type="button" class="link danger" data-relation-delete="${escapeHtml(rel.id)}">删除</button>
      </td>
    </tr>`).join('');
  el('relation-empty').classList.toggle('hidden', state.relations.length > 0);
}

// 把展开结果按层画出来：每层一个小组，每条依赖带层号标记与「从哪一层带上来」
function renderClosure() {
  const box = el('closure-result');
  const data = state.closure;
  if (!data) {
    box.innerHTML = '';
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  const rootLabel = depLabel(data.root);
  if (!data.items.length) {
    box.innerHTML = `<p class="closure-summary"><strong>${escapeHtml(rootLabel)}</strong> 没有登记需要其它依赖</p>`;
    return;
  }

  const layers = new Map();
  data.items.forEach((item) => {
    if (!layers.has(item.layer)) layers.set(item.layer, []);
    layers.get(item.layer).push(item);
  });

  const sections = Array.from(layers.entries()).map(([layer, items]) => {
    const rows = items.map((item) => {
      const via = item.introducedBy.map((by) => `${by.name}（要求 ≥${by.minVersion}）`).join('、');
      const viaText = layer === 1 ? `由 ${via} 直接需要` : `由第 ${layer - 1} 层的 ${via} 带入`;
      return `<li>
        <span class="tag layer">第 ${layer} 层</span>
        <span class="mono">${escapeHtml(item.name)} @${escapeHtml(item.version)}</span>
        （${escapeHtml(projectName(item.projectId))}）
        <span class="closure-via">${escapeHtml(viaText)}</span>
      </li>`;
    }).join('');
    const title = layer === 1 ? `第 ${layer} 层（直接需要）` : `第 ${layer} 层`;
    return `<div class="closure-layer"><h4>${title}</h4><ul>${rows}</ul></div>`;
  }).join('');

  box.innerHTML = `<p class="closure-summary">从 <strong>${escapeHtml(rootLabel)}</strong> 出发，一路往下共需要 ${data.total} 条依赖，最深 ${data.maxLayer} 层；同一条依赖只列一次，保留它最早出现的那一层</p>${sections}`;
}

async function refreshClosure() {
  if (!state.closureDepId) return;
  try {
    state.closure = await request(`/api/deps/${encodeURIComponent(state.closureDepId)}/closure`);
  } catch (err) {
    state.closure = null;
    state.closureDepId = '';
  }
  renderClosure();
}

async function submitRelation(event) {
  event.preventDefault();
  clearNotice();
  clearFieldMarks();
  if (!state.relationDeps.length) {
    notify('请先登记依赖，再登记关系', 'error');
    return;
  }
  const payload = {
    fromDepId: el('relation-from').value,
    toDepId: el('relation-to').value,
    minVersion: el('relation-min-version').value,
  };
  try {
    await request('/api/relations', { method: 'POST', body: JSON.stringify(payload) });
    el('relation-min-version').value = '';
    notify('依赖关系已新增', 'ok');
    await loadRelations();
    await refreshClosure();
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
  }
}

async function submitClosure(event) {
  event.preventDefault();
  clearNotice();
  clearFieldMarks();
  const depId = el('closure-dep').value;
  if (!depId) {
    notify('请先登记依赖，再展开清单', 'error');
    return;
  }
  try {
    state.closure = await request(`/api/deps/${encodeURIComponent(depId)}/closure`);
    state.closureDepId = depId;
    renderClosure();
  } catch (err) {
    state.closure = null;
    state.closureDepId = '';
    renderClosure();
    notify(err.message, 'error');
    markField(err.field);
  }
}

function openDepForm(dep) {
  state.editingId = dep ? dep.id : '';
  el('dep-form-title').textContent = dep ? `编辑登记：${dep.name}` : '新建登记';
  if (state.projects.length) {
    el('dep-project').value = dep ? dep.projectId : state.projects[0].id;
  }
  el('dep-name').value = dep ? dep.name : '';
  el('dep-version').value = dep ? dep.version : '';
  el('dep-license').value = dep ? dep.license : '';
  el('dep-owner').value = dep ? dep.owner : currentOperator();
  el('dep-status').value = dep ? dep.status : (state.statuses[0] || '在用');
  el('dep-note').value = dep ? dep.note : '';
  el('dep-form').classList.remove('hidden');
  el('dep-name').focus();
}

function closeDepForm() {
  state.editingId = '';
  el('dep-form').classList.add('hidden');
  clearFieldMarks();
}

async function submitProject(event) {
  event.preventDefault();
  clearNotice();
  clearFieldMarks();
  const payload = {
    name: el('project-name').value,
    owner: el('project-owner').value,
    note: el('project-note').value,
  };
  try {
    await request('/api/projects', { method: 'POST', body: JSON.stringify(payload) });
    el('project-name').value = '';
    el('project-owner').value = '';
    el('project-note').value = '';
    notify('项目已新增', 'ok');
    await loadProjects();
    await loadDeps();
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
  }
}

async function submitDep(event) {
  event.preventDefault();
  clearNotice();
  clearFieldMarks();
  const payload = {
    projectId: el('dep-project').value,
    name: el('dep-name').value,
    version: el('dep-version').value,
    license: el('dep-license').value,
    owner: el('dep-owner').value,
    status: el('dep-status').value,
    note: el('dep-note').value,
  };
  const editing = state.editingId;
  try {
    if (editing) {
      await request(`/api/deps/${encodeURIComponent(editing)}`, { method: 'PATCH', body: JSON.stringify(payload) });
      notify('依赖登记已保存', 'ok');
    } else {
      await request('/api/deps', { method: 'POST', body: JSON.stringify(payload) });
      notify('依赖登记已新增', 'ok');
    }
    closeDepForm();
    await loadProjects();
    await loadDeps();
    await loadRelations();
    await refreshClosure();
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
  }
}

// 列表上的操作用事件委托统一处理，列表重绘之后不需要重新绑定
document.addEventListener('click', async (event) => {
  const node = event.target.closest('button');
  if (!node) return;

  const projectId = node.dataset.projectRename || node.dataset.projectOwner || node.dataset.projectDelete;
  if (projectId) {
    clearNotice();
    const found = state.projects.find((item) => item.id === projectId);
    if (!found) return;
    try {
      if (node.dataset.projectRename) {
        const next = window.prompt(`把 ${found.name} 的名称改成`, found.name);
        if (next === null) return;
        await request(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'PATCH', body: JSON.stringify({ name: next }) });
        notify('项目名称已更新', 'ok');
      } else if (node.dataset.projectOwner) {
        const next = window.prompt(`把 ${found.name} 的负责人改成`, found.owner || '');
        if (next === null) return;
        await request(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'PATCH', body: JSON.stringify({ owner: next }) });
        notify('项目负责人已更新', 'ok');
      } else {
        if (!window.confirm(`确定删除项目 ${found.name} 吗？`)) return;
        await request(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' });
        notify('项目已删除', 'ok');
      }
      await loadProjects();
      await loadDeps();
      await loadRelations();
    } catch (err) {
      notify(err.message, 'error');
    }
    return;
  }

  if (node.dataset.depEdit) {
    clearNotice();
    const found = state.deps.find((item) => item.id === node.dataset.depEdit);
    if (found) openDepForm(found);
    return;
  }

  if (node.dataset.depDelete) {
    clearNotice();
    const found = state.deps.find((item) => item.id === node.dataset.depDelete);
    if (!window.confirm(`确定删除登记 ${found ? found.name : ''} 吗？与它相关的依赖关系会一起清掉`)) return;
    try {
      await request(`/api/deps/${encodeURIComponent(node.dataset.depDelete)}`, { method: 'DELETE' });
      if (state.editingId === node.dataset.depDelete) closeDepForm();
      notify('登记已删除', 'ok');
      await loadProjects();
      await loadDeps();
      await loadRelations();
      await refreshClosure();
    } catch (err) {
      notify(err.message, 'error');
    }
    return;
  }

  if (node.dataset.relationDelete) {
    clearNotice();
    const rel = state.relations.find((item) => item.id === node.dataset.relationDelete);
    if (!rel) return;
    if (!window.confirm(`确定删除「${rel.fromName} → ${rel.toName}」这条关系吗？`)) return;
    try {
      await request(`/api/relations/${encodeURIComponent(rel.id)}`, { method: 'DELETE' });
      notify('关系已删除', 'ok');
      await loadRelations();
      await refreshClosure();
    } catch (err) {
      notify(err.message, 'error');
    }
  }
});

el('project-form').addEventListener('submit', submitProject);
el('dep-form').addEventListener('submit', submitDep);
el('relation-form').addEventListener('submit', submitRelation);
el('closure-form').addEventListener('submit', submitClosure);
el('dep-new').addEventListener('click', () => {
  clearNotice();
  if (!state.projects.length) {
    notify('请先登记一个项目，再登记依赖', 'error');
    return;
  }
  openDepForm(null);
});
el('dep-cancel').addEventListener('click', closeDepForm);
el('filter-apply').addEventListener('click', () => {
  clearNotice();
  loadDeps().catch((err) => notify(err.message, 'error'));
});
el('filter-reset').addEventListener('click', () => {
  el('filter-project').value = '';
  el('filter-status').value = '';
  el('filter-license').value = '';
  el('filter-keyword').value = '';
  loadDeps().catch((err) => notify(err.message, 'error'));
});
el('dep-refresh').addEventListener('click', () => {
  clearNotice();
  loadProjects()
    .then(loadDeps)
    .then(loadRelations)
    .then(refreshClosure)
    .catch((err) => notify(err.message, 'error'));
});
el('filter-project').addEventListener('change', () => {
  loadDeps().catch((err) => notify(err.message, 'error'));
});
el('filter-status').addEventListener('change', () => {
  loadDeps().catch((err) => notify(err.message, 'error'));
});
el('filter-license').addEventListener('change', () => {
  loadDeps().catch((err) => notify(err.message, 'error'));
});
el('operator').addEventListener('change', () => {
  window.localStorage.setItem(OPERATOR_KEY, currentOperator());
});

// 页面打开时先把项目、依赖登记与依赖关系拉一遍，项目决定登记表单里能选哪些归属
restoreOperator();
loadHealth();
loadProjects()
  .then(loadDeps)
  .then(loadRelations)
  .catch((err) => notify(err.message, 'error'));

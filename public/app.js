// 页面交互：项目清单与依赖登记都从服务端拉取，任何一步失败都把说明显示在顶部并标到对应输入项上

const state = {
  projects: [],
  deps: [],
  links: [],
  linkDeps: [],
  licenses: [],
  statuses: [],
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

// 关系清单与依赖登记表互相影响：关系区自己重绘，依赖表上的"需要谁/被谁需要"两列也要跟着刷新
async function loadLinks() {
  const payload = await request('/api/links');
  state.links = payload.links || [];
  state.linkDeps = payload.deps || [];
  renderDeps();
  renderLinks();
  renderLinkOptions();
  await refreshClosure();
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

// 每条依赖的两头关系：它需要谁（from 是自己）、被谁需要（to 是自己）
function depRelations(depId) {
  const requires = [];
  const requiredBy = [];
  state.links.forEach((link) => {
    if (link.fromId === depId && link.to) requires.push(link.to);
    if (link.toId === depId && link.from) requiredBy.push(link.from);
  });
  return { requires, requiredBy };
}

// 同名依赖可能分属不同项目，标签一律带上项目名才分得清
function relationTags(list) {
  if (!list.length) return '<span class="missing">无</span>';
  return list
    .map((dep) => `<span class="tag rel">${escapeHtml(dep.projectName)}/${escapeHtml(dep.name)}</span>`)
    .join(' ');
}

function renderDeps() {
  const body = el('dep-body');
  body.innerHTML = state.deps.map((item) => {
    const statusTag = item.status === '已弃用' ? 'off' : 'on';
    const rel = depRelations(item.id);
    return `<tr>
      <td>${escapeHtml(projectName(item.projectId))}</td>
      <td class="mono">${escapeHtml(item.name)}</td>
      <td class="mono">${escapeHtml(item.version)}</td>
      <td>${item.license ? escapeHtml(item.license) : '<span class="missing">未填</span>'}</td>
      <td>${item.owner ? escapeHtml(item.owner) : '<span class="missing">未指定</span>'}</td>
      <td><span class="tag ${statusTag}">${escapeHtml(item.status)}</span></td>
      <td class="rel-cell">${relationTags(rel.requires)}</td>
      <td class="rel-cell">${relationTags(rel.requiredBy)}</td>
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

function depLabel(dep) {
  return `${dep.projectName} / ${dep.name}@${dep.version}`;
}

function renderLinks() {
  const body = el('link-body');
  body.innerHTML = state.links.map((link) => `<tr>
      <td>${link.from ? escapeHtml(depLabel(link.from)) : escapeHtml(link.fromId)}</td>
      <td>${link.to ? escapeHtml(depLabel(link.to)) : escapeHtml(link.toId)}</td>
      <td class="mono">${escapeHtml(link.minVersion)}</td>
      <td class="mono">${escapeHtml(formatTime(link.createdAt))}</td>
      <td class="actions">
        <button type="button" class="link danger" data-link-delete="${escapeHtml(link.id)}">删除</button>
      </td>
    </tr>`).join('');
  el('link-empty').classList.toggle('hidden', state.links.length > 0);
}

// 三个下拉框（关系两端、展开起点）共用一份全量依赖清单，按项目分组，不受筛选条件影响
function renderLinkOptions() {
  const byProject = new Map();
  state.linkDeps.forEach((dep) => {
    const key = dep.projectName || dep.projectId;
    if (!byProject.has(key)) byProject.set(key, []);
    byProject.get(key).push(dep);
  });
  const options = Array.from(byProject.entries())
    .map(([projectName, deps]) => `<optgroup label="${escapeHtml(projectName)}">${
      deps.map((dep) => `<option value="${escapeHtml(dep.id)}">${escapeHtml(dep.name)}@${escapeHtml(dep.version)}</option>`).join('')
    }</optgroup>`)
    .join('');

  ['link-from', 'link-to', 'closure-dep'].forEach((id) => {
    const select = el(id);
    const current = select.value;
    select.innerHTML = options;
    if (state.linkDeps.some((dep) => dep.id === current)) select.value = current;
  });
}

function renderClosure(result) {
  const box = el('closure-result');
  const rootLabel = depLabel(result.root);
  if (!result.items.length) {
    box.innerHTML = `<p class="closure-summary">${escapeHtml(rootLabel)} 没有需要其它依赖</p>`;
    return;
  }
  const layers = new Map();
  result.items.forEach((item) => {
    if (!layers.has(item.depth)) layers.set(item.depth, []);
    layers.get(item.depth).push(item);
  });
  const layerHtml = Array.from(layers.entries())
    .map(([depth, items]) => {
      const rows = items.map((item) => `<li>
          <span class="mono">${escapeHtml(item.name)}@${escapeHtml(item.version)}</span>
          <span class="closure-via">（${escapeHtml(item.projectName)}）· 最低版本 ${escapeHtml(item.minVersion)} · 第 ${item.depth} 层由 ${escapeHtml(item.viaProjectName)}/${escapeHtml(item.viaName)} 带入</span>
        </li>`).join('');
      return `<div class="closure-layer"><h4>第 ${depth} 层（${items.length} 条）</h4><ul>${rows}</ul></div>`;
    }).join('');
  box.innerHTML = `<p class="closure-summary">从 <b>${escapeHtml(rootLabel)}</b> 出发，一路往下共需要 ${result.items.length} 条依赖，最深 ${result.maxDepth} 层：</p>${layerHtml}`;
}

async function runClosure() {
  clearNotice();
  const depId = el('closure-dep').value;
  if (!depId) {
    notify('请先选择一条依赖再展开', 'error');
    return;
  }
  try {
    const result = await request(`/api/deps/${encodeURIComponent(depId)}/closure`);
    el('closure-result').dataset.active = '1';
    renderClosure(result);
  } catch (err) {
    notify(err.message, 'error');
  }
}

// 关系或依赖变动之后，展开结果跟着刷新；起点被删掉就收起来
async function refreshClosure() {
  const box = el('closure-result');
  const depId = el('closure-dep').value;
  if (!box.dataset.active || !depId) return;
  try {
    const result = await request(`/api/deps/${encodeURIComponent(depId)}/closure`);
    renderClosure(result);
  } catch (err) {
    box.innerHTML = '';
    delete box.dataset.active;
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
    await loadLinks();
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
  }
}

async function submitLink(event) {
  event.preventDefault();
  clearNotice();
  clearFieldMarks();
  const payload = {
    fromId: el('link-from').value,
    toId: el('link-to').value,
    minVersion: el('link-min-version').value,
  };
  try {
    await request('/api/links', { method: 'POST', body: JSON.stringify(payload) });
    el('link-min-version').value = '';
    notify('关系已新增', 'ok');
    await loadLinks();
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
      await loadLinks();
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
    if (!window.confirm(`确定删除登记 ${found ? found.name : ''} 吗？挂在它身上的关系会一起删掉`)) return;
    try {
      const result = await request(`/api/deps/${encodeURIComponent(node.dataset.depDelete)}`, { method: 'DELETE' });
      if (state.editingId === node.dataset.depDelete) closeDepForm();
      notify(`登记已删除${result.removedLinks ? `，连同 ${result.removedLinks} 条关系一起删掉` : ''}`, 'ok');
      await loadProjects();
      await loadDeps();
      await loadLinks();
    } catch (err) {
      notify(err.message, 'error');
    }
    return;
  }

  if (node.dataset.linkDelete) {
    clearNotice();
    if (!window.confirm('确定删除这条关系吗？')) return;
    try {
      await request(`/api/links/${encodeURIComponent(node.dataset.linkDelete)}`, { method: 'DELETE' });
      notify('关系已删除', 'ok');
      await loadLinks();
    } catch (err) {
      notify(err.message, 'error');
    }
  }
});

el('project-form').addEventListener('submit', submitProject);
el('dep-form').addEventListener('submit', submitDep);
el('link-form').addEventListener('submit', submitLink);
el('closure-run').addEventListener('click', runClosure);
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
    .then(loadLinks)
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

// 页面打开时先把项目、依赖登记与关系都拉一遍，项目决定登记表单里能选哪些归属，
// 关系决定依赖表上的"需要谁/被谁需要"两列与关系区的下拉框
restoreOperator();
loadHealth();
loadProjects()
  .then(loadDeps)
  .then(loadLinks)
  .catch((err) => notify(err.message, 'error'));

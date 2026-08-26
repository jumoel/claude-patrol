const searchItems = [
  {
    id: 'eco3351',
    type: 'Work',
    title: 'eco-fix-review: judge JS remediation PRs on backport fidelity',
    meta: 'eco-3351 · chainguard-dev/mono · waiting',
  },
  {
    id: 'eco3738',
    type: 'Work',
    title: 'advisory-syncer: investigate intermittent production memory-limit failures',
    meta: 'ECO-3738 · chainguard-dev/mono · waiting',
  },
  {
    id: 'pr53360',
    type: 'PR',
    title: 'feat(eco-fix-review): judge JavaScript remediation fidelity',
    meta: '#53360 · chainguard-dev/mono · CI failed',
  },
  {
    id: 'pr53148',
    type: 'PR',
    title: 'docs(serve-v2): design time-gated registry views',
    meta: '#53148 · chainguard-dev/mono · changes requested',
  },
  {
    id: 'judge',
    type: 'Session',
    title: 'standalone-judge-tool',
    meta: 'chainguard-dev/ecosystems-rebuilder.js · working',
  },
  {
    id: 'secfeed',
    type: 'Session',
    title: '400-secfeed deploy',
    meta: 'global Codex session · waiting',
  },
];

const details = {
  eco3351: {
    eyebrow: 'Work item · Waiting for you',
    title: 'eco-fix-review: judge JS remediation PRs on backport fidelity',
    meta: 'eco-3351 · chainguard-dev/mono · Codex',
    state: 'The agent is idle and ready for your next instruction.',
    summary:
      'Add JavaScript remediation file classification and a remediation-quality judge prompt so eco-fix-review assesses backport fidelity.',
    facts: [
      ['Status', 'Waiting'],
      ['Provider', 'Codex'],
      ['Repository', 'chainguard-dev/mono'],
      ['Updated', '2h ago'],
    ],
    primary: 'Resume terminal',
  },
  eco3738: {
    eyebrow: 'Work item · Waiting for you',
    title: 'advisory-syncer: investigate intermittent production memory-limit failures',
    meta: 'ECO-3738 · chainguard-dev/mono · Codex',
    state: 'The agent is idle after investigating the production memory failures.',
    summary:
      'Review the latest findings, decide whether more evidence is needed, and send the next instruction from the same session.',
    facts: [
      ['Status', 'Waiting'],
      ['Provider', 'Codex'],
      ['Repository', 'chainguard-dev/mono'],
      ['Updated', '2h ago'],
    ],
    primary: 'Resume terminal',
  },
  pr53360: {
    eyebrow: 'Pull request · CI failed',
    title: 'feat(eco-fix-review): judge JavaScript remediation fidelity',
    meta: '#53360 · chainguard-dev/mono',
    state: 'One check failed while 23 checks are still running. The workspace is ready.',
    summary:
      'Adds JavaScript remediation classification and fidelity criteria to eco-fix-review. Automated remediation review remains human-gated.',
    facts: [
      ['CI', '1 failed · 23 running'],
      ['Review', 'Pending'],
      ['Merge', 'Clean'],
      ['Updated', '3m ago'],
    ],
    primary: 'Investigate CI',
  },
  pr53148: {
    eyebrow: 'Pull request · Changes requested',
    title: 'docs(serve-v2): design time-gated registry views',
    meta: '#53148 · chainguard-dev/mono',
    state: 'doismellburning requested changes. Your follow-up comment was posted 2h ago.',
    summary:
      'The open feedback asks the design document to state why time-gated registry views belong in serve-v2 instead of individual rebuilders.',
    facts: [
      ['CI', 'Pending'],
      ['Review', 'Changes requested'],
      ['Merge', 'Unknown'],
      ['Updated', '2h ago'],
    ],
    primary: 'Open feedback',
  },
  judge: {
    eyebrow: 'Scratch workspace · Working',
    title: 'standalone-judge-tool',
    meta: 'chainguard-dev/ecosystems-rebuilder.js · Codex',
    state: 'The agent is actively investigating bundle memory use and process isolation.',
    summary:
      'The last visible update identified unbounded file reads and whole-tarball materialization as concrete memory risks.',
    facts: [
      ['Status', 'Working'],
      ['Provider', 'Codex'],
      ['Workspace', 'scratch-standalone-judge-tool'],
      ['Started', '20h ago'],
    ],
    primary: 'Open terminal',
  },
  secfeed: {
    eyebrow: 'Global session · Waiting for you',
    title: '400-secfeed deploy',
    meta: 'Codex · global session',
    state: 'The agent is idle after tracing the stage-only deployment path.',
    summary:
      'The latest update explains the stage dispatch workflow, immutable SHA requirement, and operational constraints around automatic apply.',
    facts: [
      ['Status', 'Waiting'],
      ['Provider', 'Codex'],
      ['Target', 'Global'],
      ['Started', '2h ago'],
    ],
    primary: 'Resume terminal',
  },
};

const paletteBackdrop = document.querySelector('#paletteBackdrop');
const paletteInput = document.querySelector('#paletteInput');
const paletteResults = document.querySelector('#paletteResults');
const detailBackdrop = document.querySelector('#detailBackdrop');
const detailContent = document.querySelector('#detailContent');
const newWorkBackdrop = document.querySelector('#newWorkBackdrop');
const toast = document.querySelector('#toast');
let paletteSelection = 0;
let toastTimer;

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 2200);
}

function renderPalette(query = '') {
  const normalized = query.trim().toLowerCase();
  const matches = searchItems.filter((item) => `${item.title} ${item.meta} ${item.type}`.toLowerCase().includes(normalized));
  paletteSelection = Math.min(paletteSelection, Math.max(matches.length - 1, 0));
  paletteResults.innerHTML = matches.length
    ? matches
        .map(
          (item, index) => `
            <button class="palette-item ${index === paletteSelection ? 'selected' : ''}" type="button" data-open="${item.id}">
              <span class="palette-type">${item.type}</span>
              <span class="palette-copy">
                <span class="palette-title">${item.title}</span>
                <span class="palette-meta">${item.meta}</span>
              </span>
              <span aria-hidden="true">↵</span>
            </button>
          `,
        )
        .join('')
    : '<div class="empty-filter">No matching work.</div>';
}

function openPalette() {
  paletteBackdrop.hidden = false;
  paletteSelection = 0;
  paletteInput.value = '';
  renderPalette();
  requestAnimationFrame(() => paletteInput.focus());
}

function closePalette() {
  paletteBackdrop.hidden = true;
}

function openDetail(id) {
  const detail = details[id];
  if (!detail) return;
  const facts = detail.facts
    .map(([term, value]) => `<div><dt>${term}</dt><dd>${value}</dd></div>`)
    .join('');
  detailContent.innerHTML = `
    <p class="detail-eyebrow">${detail.eyebrow}</p>
    <h2 id="detailTitle">${detail.title}</h2>
    <p class="detail-meta mono">${detail.meta}</p>
    <div class="detail-state"><span class="state-marker waiting"></span>${detail.state}</div>
    <section class="detail-section">
      <h3>Current context</h3>
      <p>${detail.summary}</p>
    </section>
    <section class="detail-section">
      <h3>State</h3>
      <dl class="detail-facts">${facts}</dl>
    </section>
    <div class="detail-actions">
      <button class="button primary" type="button" data-demo-action="${detail.primary}">${detail.primary}</button>
      <button class="button secondary" type="button" data-demo-action="Open full detail">Open full detail</button>
    </div>
  `;
  detailBackdrop.hidden = false;
  requestAnimationFrame(() => document.querySelector('#detailClose').focus());
}

function closeDetail() {
  detailBackdrop.hidden = true;
}

function filterAttention(kind) {
  const rows = [...document.querySelectorAll('.attention-row')];
  let visible = 0;
  rows.forEach((row) => {
    const show = kind === 'all' || row.dataset.kind === kind;
    row.hidden = !show;
    if (show) visible += 1;
  });
  document.querySelector('#attentionEmpty').hidden = visible !== 0;
  document.querySelectorAll('[data-attention-filter]').forEach((button) => {
    button.classList.toggle('active', button.dataset.attentionFilter === kind);
  });
}

function setPrimaryView(view) {
  document.querySelectorAll('.nav-item').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === view);
  });
  const homeContent = [
    document.querySelector('.page-intro'),
    document.querySelector('.summary-strip'),
    document.querySelector('.workspace-layout'),
  ];
  const alternate = document.querySelector('#alternateView');
  if (view === 'home') {
    homeContent.forEach((node) => (node.hidden = false));
    alternate.hidden = true;
    return;
  }
  homeContent.forEach((node) => (node.hidden = true));
  const copy = {
    prs: ['Pull requests', 'The full table view would keep saved views, filters, column controls, and keyboard row navigation.'],
    work: ['Work', 'Work items and scratch workspaces would share one lifecycle view, grouped by Waiting, Working, Ready, and Stopped.'],
    automations: ['Automations', 'Rules, recent runs, failures, and manual triggers would move out of the dashboard summary dropdown.'],
  }[view];
  alternate.innerHTML = `<p class="eyebrow">Product area</p><h2>${copy[0]}</h2><p>${copy[1]}</p><button class="button secondary" type="button" data-return-home>Return to Today</button>`;
  alternate.hidden = false;
}

document.querySelector('#searchTrigger').addEventListener('click', openPalette);
document.querySelector('#newWorkButton').addEventListener('click', () => {
  newWorkBackdrop.hidden = false;
  requestAnimationFrame(() => document.querySelector('#referenceInput').focus());
});
document.querySelector('#detailClose').addEventListener('click', closeDetail);

document.querySelector('#collapseActivity').addEventListener('click', () => {
  document.querySelector('#activityPanel').hidden = true;
  document.querySelector('.workspace-layout').classList.add('activity-collapsed');
  document.querySelector('#sessionTrigger').classList.add('attention-pulse');
});

document.querySelector('#sessionTrigger').addEventListener('click', () => {
  const panel = document.querySelector('#activityPanel');
  panel.hidden = !panel.hidden;
  document.querySelector('.workspace-layout').classList.toggle('activity-collapsed', panel.hidden);
  document.querySelector('#sessionTrigger').classList.remove('attention-pulse');
});

document.querySelectorAll('[data-attention-filter]').forEach((button) => {
  button.addEventListener('click', () => filterAttention(button.dataset.attentionFilter));
});

document.querySelectorAll('[data-filter]').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('[data-filter]').forEach((candidate) => candidate.classList.remove('selected'));
    button.classList.add('selected');
    const filter = button.dataset.filter;
    if (filter === 'all') filterAttention('all');
    if (filter === 'pr') filterAttention('pr');
    if (filter === 'working') openDetail('judge');
    if (filter === 'workspace') showToast('Three active workspaces in the captured instance');
  });
});

document.querySelectorAll('.nav-item').forEach((button) => {
  button.addEventListener('click', () => setPrimaryView(button.dataset.view));
});

document.querySelectorAll('.work-type').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.work-type').forEach((candidate) => candidate.classList.remove('selected'));
    button.classList.add('selected');
  });
});

document.querySelector('#referenceInput').addEventListener('input', (event) => {
  document.querySelector('#createWorkButton').disabled = event.target.value.trim().length === 0;
});

document.querySelector('#createWorkButton').addEventListener('click', () => {
  newWorkBackdrop.hidden = true;
  showToast('Mockup only. No work item was created.');
});

paletteInput.addEventListener('input', () => {
  paletteSelection = 0;
  renderPalette(paletteInput.value);
});

paletteInput.addEventListener('keydown', (event) => {
  const matches = [...paletteResults.querySelectorAll('.palette-item')];
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    paletteSelection = (paletteSelection + 1) % Math.max(matches.length, 1);
    renderPalette(paletteInput.value);
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    paletteSelection = (paletteSelection - 1 + Math.max(matches.length, 1)) % Math.max(matches.length, 1);
    renderPalette(paletteInput.value);
  }
  if (event.key === 'Enter' && matches[paletteSelection]) {
    event.preventDefault();
    const id = matches[paletteSelection].dataset.open;
    closePalette();
    openDetail(id);
  }
});

document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    if (paletteBackdrop.hidden) openPalette();
    else closePalette();
  }
  if (event.key === 'Escape') {
    if (!paletteBackdrop.hidden) closePalette();
    else if (!newWorkBackdrop.hidden) newWorkBackdrop.hidden = true;
    else if (!detailBackdrop.hidden) closeDetail();
  }
});

document.addEventListener('click', (event) => {
  const openTarget = event.target.closest('[data-open]');
  if (openTarget) {
    closePalette();
    openDetail(openTarget.dataset.open);
    return;
  }
  if (event.target.closest('[data-close-modal]')) {
    newWorkBackdrop.hidden = true;
    return;
  }
  if (event.target.closest('[data-demo-action]')) {
    showToast(`${event.target.closest('[data-demo-action]').dataset.demoAction} is illustrative in this mockup.`);
    return;
  }
  if (event.target.closest('[data-return-home]')) {
    setPrimaryView('home');
    return;
  }
  if (event.target.closest('[data-view-link]')) {
    setPrimaryView(event.target.closest('[data-view-link]').dataset.viewLink);
    return;
  }
  if (event.target.closest('#customizeButton')) {
    showToast('View customization is represented, not implemented.');
  }
});

paletteBackdrop.addEventListener('click', (event) => {
  if (event.target === paletteBackdrop) closePalette();
});

newWorkBackdrop.addEventListener('click', (event) => {
  if (event.target === newWorkBackdrop) newWorkBackdrop.hidden = true;
});

detailBackdrop.addEventListener('click', (event) => {
  if (event.target === detailBackdrop) closeDetail();
});

document.querySelectorAll('.attention-row, .pr-table tbody tr').forEach((row) => {
  row.addEventListener('click', (event) => {
    if (event.target.closest('button')) return;
    openDetail(row.dataset.detail);
  });
  row.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') openDetail(row.dataset.detail);
  });
});

renderPalette();

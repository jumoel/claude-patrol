const bDetails = {
  eco3351: ['Work item · Waiting', 'eco-fix-review: judge JS remediation PRs on backport fidelity', 'eco-3351 · chainguard-dev/mono', 'The Codex session is idle and ready for the next instruction.', 'Resume terminal'],
  eco3738: ['Work item · Waiting', 'advisory-syncer: investigate intermittent production memory-limit failures', 'ECO-3738 · chainguard-dev/mono', 'The Codex session is idle after investigating the production memory failures.', 'Resume terminal'],
  pr53360: ['Pull request · CI failed', 'feat(eco-fix-review): judge JavaScript remediation fidelity', '#53360 · chainguard-dev/mono', 'One check failed while 23 are still running. The local workspace is ready.', 'Investigate CI'],
  pr53148: ['Pull request · Changes requested', 'docs(serve-v2): design time-gated registry views', '#53148 · chainguard-dev/mono', 'doismellburning requested changes. CI remains pending and mergeability is unknown.', 'Open feedback'],
  judge: ['Scratch workspace · Working', 'standalone-judge-tool', 'chainguard-dev/ecosystems-rebuilder.js', 'Codex is actively investigating bundle memory use and process isolation.', 'Open terminal'],
};

const bDetailBackdrop = document.querySelector('#bDetailBackdrop');
const bDetailContent = document.querySelector('#bDetailContent');
const bSessionDrawer = document.querySelector('#bSessionDrawer');
const bToast = document.querySelector('#bToast');
let bToastTimer;

function bShowToast(message) {
  clearTimeout(bToastTimer);
  bToast.textContent = message;
  bToast.hidden = false;
  bToastTimer = setTimeout(() => (bToast.hidden = true), 2100);
}

function bOpenDetail(id) {
  const detail = bDetails[id];
  if (!detail) return;
  bDetailContent.innerHTML = `
    <p class="detail-eyebrow">${detail[0]}</p>
    <h2 id="bDetailTitle">${detail[1]}</h2>
    <p class="detail-meta mono">${detail[2]}</p>
    <div class="detail-state"><span class="state-marker waiting"></span>${detail[3]}</div>
    <section class="detail-section"><h3>Dense dashboard behavior</h3><p>This path keeps full object details in tables and opens the existing detail page for deeper work.</p></section>
    <div class="detail-actions"><button class="button primary" type="button" data-b-demo>${detail[4]}</button><button class="button secondary" type="button" data-b-demo>Open full detail</button></div>
  `;
  bDetailBackdrop.hidden = false;
}

function bFilterRows(mode, query = '') {
  const rows = [...document.querySelectorAll('#bPrRows tr')];
  const normalized = query.trim().toLowerCase();
  let shown = 0;
  rows.forEach((row) => {
    const matchesQuery = row.dataset.search.includes(normalized);
    const matchesMode = mode === 'all' || mode === 'needs';
    row.hidden = !(matchesQuery && matchesMode);
    if (!row.hidden) shown += 1;
  });
  document.querySelector('#bPrCount').textContent = String(shown);
  document.querySelector('#bNoResults').hidden = shown !== 0;
}

document.querySelector('#bSessionsButton').addEventListener('click', () => (bSessionDrawer.hidden = false));
document.querySelector('#bCloseSessions').addEventListener('click', () => (bSessionDrawer.hidden = true));
document.querySelector('#bDetailClose').addEventListener('click', () => (bDetailBackdrop.hidden = true));

document.querySelector('#bStartWork').addEventListener('click', () => bShowToast('Start work keeps the current compact launcher in this path.'));
document.querySelector('#bSearchButton').addEventListener('click', () => {
  document.querySelector('#bPrSearch').focus();
  document.querySelector('.b-pr-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
document.querySelector('#bColumnsButton').addEventListener('click', () => bShowToast('Column preferences would live here.'));
document.querySelector('.b-sync-button').addEventListener('click', () => bShowToast('Mockup only. No sync was triggered.'));

document.querySelectorAll('[data-b-filter]').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('[data-b-filter]').forEach((candidate) => candidate.classList.remove('active'));
    button.classList.add('active');
    bFilterRows(button.dataset.bFilter, document.querySelector('#bPrSearch').value);
  });
});

document.querySelector('#bPrSearch').addEventListener('input', (event) => {
  const mode = document.querySelector('[data-b-filter].active').dataset.bFilter;
  bFilterRows(mode, event.target.value);
});

document.querySelector('#bClearFilters').addEventListener('click', () => {
  document.querySelector('#bPrSearch').value = '';
  document.querySelectorAll('[data-b-filter]').forEach((button) => button.classList.toggle('active', button.dataset.bFilter === 'all'));
  bFilterRows('all');
});

document.addEventListener('click', (event) => {
  const detail = event.target.closest('[data-b-detail]');
  if (detail) {
    bOpenDetail(detail.dataset.bDetail);
    return;
  }
  if (event.target.closest('[data-b-demo]')) bShowToast('This action is illustrative in the mockup.');
});

document.querySelectorAll('tr[data-b-detail]').forEach((row) => {
  row.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') bOpenDetail(row.dataset.bDetail);
  });
});

bDetailBackdrop.addEventListener('click', (event) => {
  if (event.target === bDetailBackdrop) bDetailBackdrop.hidden = true;
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    bDetailBackdrop.hidden = true;
    bSessionDrawer.hidden = true;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    document.querySelector('#bPrSearch').focus();
    document.querySelector('.b-pr-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});

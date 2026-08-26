const bSessionDrawer = document.querySelector('#bSessionDrawer');
const bToast = document.querySelector('#bToast');
const bFilterMenus = [...document.querySelectorAll('.b-filter-menu')];
const bFilterOptions = [...document.querySelectorAll('.b-filter-option')];
const bPresetButtons = [...document.querySelectorAll('[data-b-preset]')];
const bClearFilters = document.querySelector('#bClearFilters');
const bReferenceSourceData = document.querySelector('#bReferenceSourceData');
let bToastTimer;
let bActivePreset = '';

if (bReferenceSourceData) {
  const source = JSON.parse(bReferenceSourceData.textContent);
  const referenceSection = document.querySelector('.b-unified-section');
  referenceSection.style.setProperty('--work-reference-accent', source.accent);
  document.querySelectorAll('[data-b-work-reference]').forEach((reference) => {
    reference.title = `Open ${reference.dataset.bWorkReference} in ${source.displayName}`;
  });
}

function bShowToast(message) {
  clearTimeout(bToastTimer);
  bToast.textContent = message;
  bToast.hidden = false;
  bToastTimer = setTimeout(() => (bToast.hidden = true), 2100);
}

function bOpenDetail(id) {
  if (!id) return;
  window.location.href = `./path-b-detail.html?item=${encodeURIComponent(id)}`;
}

function bFilterRows() {
  const rows = [...document.querySelectorAll('#bWorkRows tr')];
  const filters = Object.fromEntries(bFilterMenus.map((menu) => [
    menu.dataset.bFilterKey,
    [...menu.querySelectorAll('.b-filter-option:checked')].map((option) => option.value),
  ]));
  let shown = 0;
  rows.forEach((row) => {
    const matchesPreset = !bActivePreset || row.dataset.bViews.split(' ').includes(bActivePreset);
    const matchesFilters = Object.entries(filters).every(([key, values]) => {
      const rowValues = (row.dataset[key] || '').split(' ');
      return values.length === 0 || values.some((value) => rowValues.includes(value));
    });
    row.hidden = !(matchesPreset && matchesFilters);
    if (!row.hidden) shown += 1;
  });
  document.querySelector('#bEntityCount').textContent = String(shown);
  document.querySelector('#bNoResults').hidden = shown !== 0;
  const hasFilters = Boolean(bActivePreset || bFilterOptions.some((option) => option.checked));
  bClearFilters.disabled = !hasFilters;
}

function bUpdateFilterLabels() {
  bFilterMenus.forEach((menu) => {
    const selected = [...menu.querySelectorAll('.b-filter-option:checked')];
    const summary = menu.querySelector('[data-b-filter-summary]');
    if (selected.length === 0) {
      summary.textContent = menu.dataset.bAllLabel;
    } else if (selected.length === 1) {
      summary.textContent = `${menu.dataset.bSelectionLabel}: ${selected[0].parentElement.textContent.trim()}`;
    } else {
      summary.textContent = `${menu.dataset.bSelectionLabel}: ${selected.length}`;
    }
  });
}

document.querySelector('#bSessionsButton').addEventListener('click', () => (bSessionDrawer.hidden = false));
document.querySelector('#bCloseSessions').addEventListener('click', () => (bSessionDrawer.hidden = true));

document.querySelector('#bStartWork').addEventListener('click', () => bShowToast('Start work keeps the current compact launcher in this path.'));
document.querySelector('#bColumnsButton').addEventListener('click', () => bShowToast('Column preferences would live here.'));
document.querySelector('.b-sync-button').addEventListener('click', () => bShowToast('Mockup only. No sync was triggered.'));

bPresetButtons.forEach((button) => {
  button.addEventListener('click', () => {
    bActivePreset = bActivePreset === button.dataset.bPreset ? '' : button.dataset.bPreset;
    bPresetButtons.forEach((candidate) => candidate.setAttribute('aria-pressed', String(candidate.dataset.bPreset === bActivePreset)));
    bFilterRows();
  });
});

bFilterOptions.forEach((option) => {
  option.addEventListener('change', () => {
    bUpdateFilterLabels();
    bFilterRows();
  });
});

bClearFilters.addEventListener('click', () => {
  bActivePreset = '';
  bPresetButtons.forEach((button) => button.setAttribute('aria-pressed', 'false'));
  bFilterOptions.forEach((option) => (option.checked = false));
  bUpdateFilterLabels();
  bFilterRows();
});

document.addEventListener('click', (event) => {
  if (!event.target.closest('.b-filter-menu')) bFilterMenus.forEach((menu) => (menu.open = false));
  if (event.target.closest('[data-b-work-reference]')) return;
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

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    bSessionDrawer.hidden = true;
    bFilterMenus.forEach((menu) => (menu.open = false));
  }
});

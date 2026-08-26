const bDetailRecords = {
  eco3351: {
    breadcrumb: 'ECO-3351',
    eyebrow: 'Work item',
    title: 'eco-fix-review: judge JS remediation PRs on backport fidelity',
    meta: 'ECO-3351 · chainguard-dev/mono · updated 2h ago',
    marker: 'waiting',
    status: 'Waiting',
    action: 'Resume session',
    overview: 'Add JavaScript remediation file classification and a remediation-quality judge prompt so eco-fix-review assesses backport fidelity. Decide the JavaScript-specific human-review vetoes and route remediation pull requests to the right criteria.',
    facts: [['Type', 'Work item'], ['Repository', 'chainguard-dev/mono'], ['Provider', 'Codex'], ['Updated', '2h ago'], ['Pull requests', '2 attached'], ['Workspace', 'Ready']],
    relatedCount: '2 pull requests',
    related: '<article class="b-related-pr"><div class="b-related-pr-title"><div><span class="mono">#53360</span><strong>feat(eco-fix-review): judge JavaScript remediation fidelity</strong></div><div class="b-related-pr-actions"><div class="b-related-health" aria-label="CI pending, review approved, merge clean"><span class="pill warning">CI pending</span><span class="pill success">Approved</span><span class="pill success">Clean</span></div><button class="b-pr-select" type="button" data-b-pr-select="53360" aria-pressed="true">Viewing</button></div></div></article><article class="b-related-pr illustrative"><div class="b-related-pr-title"><div><span class="mono">#53402</span><strong>fix(eco-fix-review): harden remediation diff parsing</strong></div><div class="b-related-pr-actions"><div class="b-related-health" aria-label="CI passing, review approved, merge clean"><span class="pill success">CI pass</span><span class="pill success">Approved</span><span class="pill success">Clean</span></div><button class="b-pr-select" type="button" data-b-pr-select="53402" aria-pressed="false">View status</button></div></div></article>',
    runtime: '<div class="b-runtime-summary waiting"><span class="b-action-dot waiting"></span><div><strong>Waiting</strong><span>Codex · existing context retained</span></div></div><button type="button" data-b-detail-demo>Open transcript</button>',
    local: '<div class="b-local-summary"><span class="pill info">PR workspace</span><strong>Ready</strong><span class="mono">jumoel/eco-3351-js-remediation-review</span></div>',
  },
  eco3738: {
    breadcrumb: 'ECO-3738',
    eyebrow: 'Work item',
    title: 'advisory-syncer: investigate intermittent production memory-limit failures',
    meta: 'ECO-3738 · chainguard-dev/mono · updated 2h ago',
    marker: 'waiting',
    status: 'Waiting',
    action: 'Resume session',
    overview: 'Investigate intermittent production memory-limit failures in advisory-syncer and identify whether the limit, workload shape, or process behavior causes the observed failures.',
    facts: [['Type', 'Work item'], ['Repository', 'chainguard-dev/mono'], ['Provider', 'Codex'], ['Updated', '2h ago'], ['Pull requests', 'None'], ['Workspace', 'None']],
    relatedCount: 'No pull requests',
    related: '<div class="b-detail-empty"><strong>No pull request is attached.</strong><span>The investigation remains a work item with an LLM session only.</span></div>',
    runtime: '<div class="b-runtime-summary waiting"><span class="b-action-dot waiting"></span><div><strong>Waiting</strong><span>Codex · ECO-3738</span></div></div><button type="button" data-b-detail-demo>Open transcript</button>',
    local: '<div class="b-detail-empty compact"><strong>No local workspace</strong><span>The session has no attached checkout.</span></div>',
  },
  pr53360: {
    breadcrumb: '#53360',
    eyebrow: 'Pull request',
    title: 'feat(eco-fix-review): judge JavaScript remediation fidelity',
    meta: '#53360 · chainguard-dev/mono · jumoel/eco-3351-js-remediation-review · updated 10m ago',
    marker: 'waiting',
    status: 'CI pending',
    action: 'Inspect queued check',
    overview: 'This pull request implements JavaScript remediation file classification and fidelity judging for eco-fix-review. It belongs to work item ECO-3351.',
    facts: [['Type', 'Pull request'], ['Repository', 'chainguard-dev/mono'], ['CI', '1 queued'], ['Review', 'Approved'], ['Merge', 'Clean'], ['Updated', '10m ago']],
    relatedCount: '1 parent work item',
    related: '<article class="b-parent-work"><span class="b-kind-chip work">Work item</span><div><strong>eco-fix-review: judge JS remediation PRs on backport fidelity</strong><span class="mono">ECO-3351</span></div><a href="./path-b-detail.html?item=eco3351">Open work item →</a></article>',
    runtime: '<div class="b-detail-empty compact"><strong>No separate session</strong><span>The LLM context belongs to parent work item ECO-3351.</span></div>',
    local: '<div class="b-local-summary"><span class="pill info">PR workspace</span><strong>Ready</strong><span class="mono">jumoel/eco-3351-js-remediation-review</span></div>',
  },
  pr53148: {
    breadcrumb: '#53148',
    eyebrow: 'Pull request',
    title: 'docs(serve-v2): design time-gated registry views',
    meta: '#53148 · chainguard-dev/mono · jumoel/serve-v2-time-gated-registry-design · updated 2h ago',
    marker: 'changes',
    status: 'Changes requested',
    action: 'Open feedback',
    overview: 'Document the design for time-gated registry views in serve-v2 and address the outstanding review feedback before the pull request can progress.',
    facts: [['Type', 'Pull request'], ['Repository', 'chainguard-dev/mono'], ['CI', 'Pending'], ['Review', 'Changes requested'], ['Merge', 'Unknown'], ['Updated', '2h ago']],
    relatedCount: 'No parent work item',
    related: '<div class="b-detail-empty"><strong>This is a standalone pull request.</strong><span>No work item or LLM session is attached.</span></div>',
    runtime: '<div class="b-detail-empty compact"><strong>No LLM session</strong><span>This pull request has no attached agent context.</span></div>',
    local: '<div class="b-local-summary"><span class="pill info">PR workspace</span><strong>Ready</strong><span class="mono">jumoel/serve-v2-time-gated-registry-design</span></div>',
  },
  judge: {
    breadcrumb: 'standalone-judge-tool',
    eyebrow: 'Scratch workspace',
    title: 'standalone-judge-tool',
    meta: 'chainguard-dev/ecosystems-rebuilder.js · updated 20h ago',
    marker: 'working',
    status: 'Working',
    action: 'Open terminal',
    overview: 'Investigate judge-tool behavior without a linked work item or pull request.',
    facts: [['Type', 'Scratch workspace'], ['Repository', 'chainguard-dev/ecosystems-rebuilder.js'], ['Provider', 'Codex'], ['State', 'Working'], ['Created', '20h ago'], ['Pull requests', 'Not applicable']],
    relatedCount: 'Standalone work',
    related: '<div class="b-detail-empty"><strong>No related pull request or work item.</strong><span>Scratch work remains independent until it is explicitly attached.</span></div>',
    runtime: '<div class="b-runtime-summary working"><span class="b-spinner"></span><div><strong>Working</strong><span>Codex · 20h</span></div></div><button type="button" data-b-detail-demo>Open transcript</button>',
    local: '<div class="b-local-summary"><span class="pill working-pill">Scratch</span><strong>Active</strong><span class="mono">standalone-judge-tool</span></div>',
  },
  secfeed: {
    breadcrumb: '400-secfeed deploy',
    eyebrow: 'Global session',
    title: '400-secfeed deploy',
    meta: 'Codex · global session · updated 2h ago',
    marker: 'waiting',
    status: 'Waiting',
    action: 'Resume session',
    overview: 'Investigate the 400-secfeed deployment flow and the workflow history associated with immutable stage dispatches.',
    facts: [['Type', 'Global session'], ['Provider', 'Codex'], ['State', 'Waiting'], ['Updated', '2h ago'], ['Repository', 'Global'], ['Workspace', 'None']],
    relatedCount: 'Global scope',
    related: '<div class="b-detail-empty"><strong>No work item or pull request is attached.</strong><span>This session stays visible only in the waiting-for-you queue.</span></div>',
    runtime: '<div class="b-runtime-summary waiting"><span class="b-action-dot waiting"></span><div><strong>Waiting</strong><span>Codex · global context</span></div></div><button type="button" data-b-detail-demo>Open transcript</button>',
    local: '<div class="b-detail-empty compact"><strong>No local workspace</strong><span>The session runs from the global context.</span></div>',
  },
};

const bTerminalRecords = {
  eco3351: {
    label: 'ECO-3351 · Codex',
    state: 'Waiting',
    stateClass: 'waiting',
    body: '<p><span class="term-muted">•</span> This work item has two attached pull requests sharing the same task context.</p><p><span class="term-muted">•</span> <span class="term-cyan">#53360</span> needs CI attention. The illustrative second PR is approved and merge-clean.</p><p class="term-divider">Idle · waiting for input</p><p><span class="term-prompt">›</span> <span class="term-muted">Ask Codex to continue across either pull request</span></p><p><span class="term-model">gpt-5.6-sol xhigh</span> · <span class="term-path">~/workspaces/work-items/eco-3351</span></p>',
  },
  eco3738: {
    label: 'ECO-3738 · Codex',
    state: 'Waiting',
    stateClass: 'waiting',
    body: '<p><span class="term-muted">•</span> The advisory-syncer investigation context is retained.</p><p class="term-divider">Idle · waiting for input</p><p><span class="term-prompt">›</span> <span class="term-muted">Ask Codex to continue the memory-limit investigation</span></p><p><span class="term-model">gpt-5.6-sol xhigh</span></p>',
  },
  pr53360: {
    label: 'ECO-3351 · parent session',
    state: 'Waiting',
    stateClass: 'waiting',
    body: '<p><span class="term-muted">•</span> This pull request uses the LLM session attached to parent work item <span class="term-cyan">ECO-3351</span>.</p><p><span class="term-muted">•</span> CI currently has 158 passed checks and one queued check. Review is approved.</p><p class="term-divider">Idle · waiting for input</p><p><span class="term-prompt">›</span> <span class="term-muted">Ask Codex to inspect the queued check</span></p>',
  },
  pr53148: {
    label: '#53148 · no session',
    state: 'Not started',
    stateClass: 'inactive',
    body: '<div class="b-terminal-empty"><strong>No LLM session is attached to this pull request.</strong><span>Start a session to address the requested changes with the PR context loaded.</span><button type="button" data-b-detail-demo>+ Start session</button></div>',
  },
  judge: {
    label: 'standalone-judge-tool · Codex',
    state: 'Working',
    stateClass: 'working',
    body: '<p><span class="term-muted">•</span> Codex is working in the scratch workspace.</p><p><span class="term-muted">•</span> No recent terminal output was captured for this session.</p><p class="term-divider">Working · context active</p><p><span class="term-model">gpt-5.6-sol xhigh</span> · <span class="term-path">standalone-judge-tool</span></p>',
  },
  secfeed: {
    label: '400-secfeed deploy · Codex',
    state: 'Waiting',
    stateClass: 'waiting',
    body: '<p><span class="term-muted">•</span> The stage dispatch uses an immutable SHA and immediately applies every pending change visible in that stage.</p><p>The live workflow matches current <span class="term-cyan">main</span>. No prior 400-secfeed run appeared in the queried history.</p><p class="term-divider">Idle · waiting for input</p><p><span class="term-prompt">›</span> <span class="term-muted">Ask Codex to do anything</span></p><p><span class="term-model">gpt-5.6-sol xhigh</span> · <span class="term-path">~/work</span></p>',
  },
};

const bPrStatusRecords = {
  eco3351: {
    defaultPr: '53360',
    pullRequests: {
      53360: {
        number: '#53360',
        title: 'feat(eco-fix-review): judge JavaScript remediation fidelity',
        branch: 'jumoel/eco-3351-js-remediation-review · updated 10m ago',
        metrics: [
          ['CI', 'Pending', '158 passed · 1 queued', 'warning'],
          ['Review', 'Approved', 'owlstronaut · 10m ago', 'success'],
          ['Merge', 'Clean', 'No conflicts', 'success'],
          ['PR', 'Open', 'Non-draft', ''],
        ],
        checksSummary: '158 passed · 1 queued',
        checks: [
          ['success', 'cg-codeowners-check: main', 'Passed'],
          ['success', '158 passed checks', 'Collapsed'],
          ['warning', '1 queued check', 'Waiting'],
        ],
      },
      53402: {
        number: '#53402',
        title: 'fix(eco-fix-review): harden remediation diff parsing',
        branch: 'jumoel/eco-3351-remediation-hardening · illustrative mock data',
        metrics: [
          ['CI', 'Passing', '42 passed', 'success'],
          ['Review', 'Approved', '1 approval', 'success'],
          ['Merge', 'Clean', 'No conflicts', 'success'],
          ['PR', 'Open', 'Non-draft', ''],
        ],
        checksSummary: '42 passed',
        checks: [
          ['success', 'Lint and formatting', 'Passed'],
          ['success', 'Unit tests', 'Passed'],
          ['success', 'Policy checks', 'Passed'],
        ],
      },
    },
  },
};

const bDetailKey = new URLSearchParams(window.location.search).get('item');
const bDetailRecord = bDetailRecords[bDetailKey];
const bTerminalRecord = bTerminalRecords[bDetailKey];
const bDetailToast = document.querySelector('#bDetailToast');
let bDetailToastTimer;

function bShowDetailToast(message) {
  clearTimeout(bDetailToastTimer);
  bDetailToast.textContent = message;
  bDetailToast.hidden = false;
  bDetailToastTimer = setTimeout(() => (bDetailToast.hidden = true), 2100);
}

document.querySelector('#bDetailSyncButton').addEventListener('click', () => {
  bShowDetailToast('Mockup only. No sync was triggered.');
});

function bRenderPrStatus(statusSet, prKey) {
  const record = statusSet.pullRequests[prKey];
  if (!record) return;
  document.querySelector('#bPrStatusNumber').textContent = record.number;
  document.querySelector('#bPrStatusTitle').textContent = record.title;
  document.querySelector('#bPrStatusBranch').textContent = record.branch;
  document.querySelector('#bPrStatusSummary').innerHTML = record.metrics.map(([label, value, note, state]) => `<div class="b-pr-status-metric ${state || 'neutral'}"><span>${label}</span><strong>${value}</strong><small>${note}</small></div>`).join('');
  document.querySelector('#bCheckList').innerHTML = record.checks.map(([state, name, result]) => `<div class="b-check-row"><span class="b-check-state ${state}" aria-hidden="true"></span><strong>${name}</strong><span>${result}</span></div>`).join('');
  document.querySelectorAll('[data-b-pr-select]').forEach((button) => {
    const selected = button.dataset.bPrSelect === prKey;
    button.setAttribute('aria-pressed', String(selected));
    button.textContent = selected ? 'Selected' : 'View';
    button.closest('.b-related-pr').classList.toggle('selected', selected);
  });
}

if (!bDetailRecord) {
  document.title = 'Claude Patrol - Work not found';
  document.querySelector('#bWorkTerminal').hidden = true;
  document.querySelector('#bDetailMain').innerHTML = '<section class="b-detail-not-found"><h1>Work item not found</h1><p>The requested mockup record does not exist.</p><a class="button primary" href="./path-b.html">Back to all work</a></section>';
} else {
  document.title = `${bDetailRecord.breadcrumb} - Claude Patrol`;
  document.querySelector('#bPageEyebrow').textContent = bDetailRecord.eyebrow;
  document.querySelector('#bPageTitle').textContent = bDetailRecord.title;
  document.querySelector('#bPageMeta').textContent = bDetailRecord.meta;
  document.querySelector('#bPrimaryAction').textContent = bDetailRecord.action;
  const pageStatus = document.querySelector('#bPageStatus');
  pageStatus.classList.add(bDetailRecord.marker);
  pageStatus.innerHTML = `<span class="state-marker ${bDetailRecord.marker}"></span><strong>${bDetailRecord.status}</strong>`;
  document.querySelector('#bOverview').textContent = bDetailRecord.overview;
  document.querySelector('#bRelatedCount').textContent = bDetailRecord.relatedCount;
  document.querySelector('#bRelatedContent').innerHTML = bDetailRecord.related;
  const prStatusSet = bPrStatusRecords[bDetailKey];
  if (prStatusSet) {
    document.querySelector('#bPrStatusCard').hidden = false;
    bRenderPrStatus(prStatusSet, prStatusSet.defaultPr);
    document.querySelectorAll('[data-b-pr-select]').forEach((button) => {
      button.addEventListener('click', () => bRenderPrStatus(prStatusSet, button.dataset.bPrSelect));
    });
  }
  document.querySelector('#bTerminalLabel').textContent = bTerminalRecord.label;
  document.querySelector('#bTerminalState').textContent = bTerminalRecord.state;
  document.querySelector('#bTerminalStatusDot').classList.add(bTerminalRecord.stateClass);
  document.querySelector('#bTerminalBody').innerHTML = bTerminalRecord.body;
}

document.querySelector('#bTerminalToggle').addEventListener('click', (event) => {
  const terminal = document.querySelector('#bWorkTerminal');
  const collapsed = terminal.classList.toggle('collapsed');
  event.currentTarget.setAttribute('aria-expanded', String(!collapsed));
  event.currentTarget.textContent = collapsed ? 'Expand' : 'Collapse';
});

document.querySelector('#bPrimaryAction').addEventListener('click', () => {
  if (bTerminalRecord?.stateClass === 'inactive') {
    bShowDetailToast('This action is illustrative in the mockup.');
    return;
  }
  const terminal = document.querySelector('#bWorkTerminal');
  if (terminal.classList.contains('collapsed')) document.querySelector('#bTerminalToggle').click();
  terminal.scrollIntoView({ behavior: 'smooth', block: 'center' });
  document.querySelector('#bTerminalBody').focus({ preventScroll: true });
});

document.addEventListener('click', (event) => {
  if (event.target.closest('[data-b-detail-demo]')) bShowDetailToast('This action is illustrative in the mockup.');
});

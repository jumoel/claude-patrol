# 02 - API and Frontend

## Goal

Serve cached PR data through a REST API and render it in a filterable dashboard UI.

## File structure

```
src/
  server.js           - Fastify setup, route registration, static file serving
  routes/
    prs.js            - PR endpoints
    sync.js           - sync status/trigger endpoints
    config.js         - config endpoint (exposes non-sensitive config to frontend)
  index.js            - updated to start both poller and server

frontend/
  index.html
  src/
    main.jsx          - React entry point (no styles)
    App.jsx           - top-level layout, SSE listener (no styles)
    components/
      ui/                  - primitive/shared components
        Button/
          Button.jsx       - variant prop: primary, danger, ghost
          Button.module.css
          Button.stories.jsx
        Badge/
          Badge.jsx        - variant prop: success, error, warning, neutral
          Badge.module.css
          Badge.stories.jsx
        Dropdown/
          Dropdown.jsx
          Dropdown.module.css
          Dropdown.stories.jsx
        Dialog/
          Dialog.jsx       - confirmation dialogs (e.g. workspace destroy)
          Dialog.module.css
          Dialog.stories.jsx
        Drawer/
          Drawer.jsx       - collapsible panel (used for global terminal)
          Drawer.module.css
          Drawer.stories.jsx
        TextInput/
          TextInput.jsx
          TextInput.module.css
          TextInput.stories.jsx
      PRTable/
        PRTable.jsx
        PRTable.module.css
        PRTable.stories.jsx
      PRRow/
        PRRow.jsx
        PRRow.module.css
        PRRow.stories.jsx
      FilterBar/
        FilterBar.jsx
        FilterBar.module.css
        FilterBar.stories.jsx
      StatusBadge/
        StatusBadge.jsx
        StatusBadge.module.css
        StatusBadge.stories.jsx
    hooks/
      usePRs.js       - fetch + auto-refresh via SSE
    lib/
      api.js          - fetch wrappers for backend endpoints
  .storybook/
    main.js           - Storybook config
    preview.js        - global decorators/parameters
  vite.config.js      - dev server proxies /api to Fastify
  tailwind.config.js
```

## Backend API

### Endpoints

**`GET /api/prs`**
Query params: `org`, `repo`, `author`, `draft` (bool), `ci` (pass/fail/pending), `review` (approved/changes_requested/pending)

Filtering happens in SQL with WHERE clauses. For JSON columns (checks, reviews), use SQLite JSON functions:
- CI status: `json_extract` over checks array to derive rollup (all pass = pass, any fail = fail, else pending)
- Review status: `json_extract` over reviews array to find latest state

Returns: `{ prs: [...], synced_at: "..." }`

**`GET /api/prs/:id`**
Returns single PR with all fields. ID is `org/repo#number`.

**`POST /api/sync/trigger`**
Triggers an immediate poll cycle. Returns `{ ok: true }`.

**`GET /api/config`**
Returns orgs list and poll interval (no paths or tokens). Frontend uses this to populate filter options.

### SSE for live updates

**`GET /api/events`** - Server-Sent Events stream.
- Emits `sync` event after each poller cycle with `{ synced_at, pr_count }`
- Frontend listens and re-fetches PR data on each event
- Simple: poller emits event on its EventEmitter, SSE route forwards to connected clients

### Static file serving

In production: Fastify serves built frontend from `frontend/dist/`.
In development: Vite dev server runs separately, proxies `/api` to Fastify.

## Styling Rules

- **No CSS in app-level files.** `main.jsx`, `App.jsx`, page-level files contain zero styles. They compose components, nothing else.
- **All styles live in components.** Each component gets a co-located CSS module (`Component.module.css`). Tailwind v4 utility classes are used inside CSS modules via `@apply`, not as inline `className` strings.
- **No className prop escape hatch.** Components do not accept `className` as a prop. Style variants are expressed through explicit props (e.g. `<StatusBadge status="pass" />` not `<StatusBadge className="bg-green-500" />`). This keeps styling encapsulated and prevents style leakage between components.
- **Storybook for all components.** Every component has a `.stories.jsx` file co-located next to it. Stories cover all meaningful states/variants. UI development happens in Storybook first, then integrated into the app.

## Frontend

### PRTable

TanStack Table handles sorting and column management. Columns:
- Title (link to GitHub PR)
- Repo (`org/repo`)
- CI status (green/red/yellow badge)
- Review status (badge)
- Draft (dim if draft)
- Updated (relative time)

Click a row to expand/navigate to PR detail (plan 05 adds workspace + session here).

### FilterBar

Dropdowns/toggles for: org, repo, CI status, review status, draft. Filters update URL query params so they're bookmarkable/shareable.

All filter values derived from the current PR dataset - no separate endpoint needed.

### StatusBadge

Renders a colored dot/pill:
- CI: green (all pass), red (any failure), yellow (pending)
- Review: green (approved), red (changes requested), gray (pending)

### Auto-refresh

`usePRs` hook:
1. Fetch PRs on mount
2. Open EventSource to `/api/events`
3. On `sync` event, re-fetch

## Dependencies

Backend additions:
- `fastify` - HTTP server
- `@fastify/static` - serve frontend build
- `@fastify/cors` - dev mode only (Vite proxy handles this mostly)

Frontend:
- `react`, `react-dom`
- `@tanstack/react-table`
- `tailwindcss` v4
- `vite`
- `storybook`, `@storybook/react-vite` - component development and visual testing

## Deliverable

- `node src/index.js` starts poller + API server
- `cd frontend && npm run dev` for frontend dev with hot reload
- `cd frontend && npm run storybook` for isolated component development
- `cd frontend && npm run build` then server serves the built app
- Full PR dashboard at `localhost:3000` with filtering, sorting, live sync status

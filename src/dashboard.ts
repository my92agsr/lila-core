import { createServer, IncomingMessage, ServerResponse } from 'http'
import { readFileSync, existsSync } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { getActivePlans, getAllEntities } from './db.js'
import { logger } from './logger.js'

const execFileAsync = promisify(execFile)
const CALENDAR_SCRIPT = `${process.env.HOME}/.claude/skills/google-calendar/calendar.js`
const WORKING_MEMORY_PATH =
  process.env['LILA_WORKING_MEMORY_PATH'] ?? `${process.env.HOME}/.lila/working-memory.md`
const PAPERCLIP_BASE = 'http://127.0.0.1:3100/api'

const DASHBOARD_PORT = 4242

interface PaperclipCompany {
  id: string
  name: string
  issuePrefix: string
  status: string
}

interface PaperclipDashboard {
  agents: { active: number; running: number; error: number; paused: number }
  tasks: { open: number; inProgress: number; blocked: number; done: number }
  pendingApprovals: number
}

async function getPaperclipData(): Promise<Array<{ company: PaperclipCompany; dash: PaperclipDashboard | null }>> {
  try {
    const res = await fetch(`${PAPERCLIP_BASE}/companies`)
    if (!res.ok) return []
    const companies = await res.json() as PaperclipCompany[]
    return await Promise.all(
      companies.filter(c => c.status === 'active').map(async (company) => {
        try {
          const dRes = await fetch(`${PAPERCLIP_BASE}/companies/${company.id}/dashboard`)
          const dash = dRes.ok ? await dRes.json() as PaperclipDashboard : null
          return { company, dash }
        } catch {
          return { company, dash: null }
        }
      })
    )
  } catch {
    return []
  }
}

async function getCalendarData(): Promise<string> {
  try {
    if (!existsSync(CALENDAR_SCRIPT)) return ''
    const { stdout } = await execFileAsync('node', [CALENDAR_SCRIPT, 'list', '1'], {
      timeout: 8000,
      env: { ...process.env },
    })
    return stdout.trim()
  } catch {
    return ''
  }
}

function parseWorkingMemory(): {
  priorities: string[]
  openThreads: string[]
  projects: Array<{ name: string; detail: string }>
  people: Array<{ name: string; detail: string }>
} {
  const priorities: string[] = []
  const openThreads: string[] = []
  const projects: Array<{ name: string; detail: string }> = []
  const people: Array<{ name: string; detail: string }> = []

  try {
    if (!existsSync(WORKING_MEMORY_PATH)) return { priorities, openThreads, projects, people }
    const content = readFileSync(WORKING_MEMORY_PATH, 'utf-8')
    const lines = content.split('\n')

    let section = ''
    let currentProject = ''
    let currentProjectLines: string[] = []

    for (const line of lines) {
      const trimmed = line.trim()

      if (trimmed.startsWith('## ')) {
        // Save previous project
        if (currentProject && currentProjectLines.length > 0) {
          projects.push({ name: currentProject, detail: currentProjectLines.slice(0, 3).join(' · ') })
          currentProject = ''
          currentProjectLines = []
        }
        section = trimmed.slice(3).trim()
        continue
      }

      if (section === 'Current Priorities' && trimmed.startsWith('- ')) {
        priorities.push(trimmed.slice(2))
      }

      if (section === 'Open Threads' && trimmed.startsWith('- [ ] ')) {
        openThreads.push(trimmed.slice(6))
      }

      if (section === 'Active Projects') {
        if (trimmed.startsWith('### ')) {
          if (currentProject && currentProjectLines.length > 0) {
            projects.push({ name: currentProject, detail: currentProjectLines.slice(0, 2).join(' · ') })
          }
          currentProject = trimmed.slice(4).trim()
          currentProjectLines = []
        } else if (currentProject && trimmed.startsWith('- ')) {
          currentProjectLines.push(trimmed.slice(2))
        }
      }

      if (section === 'People' && trimmed.startsWith('- **')) {
        const match = trimmed.match(/\*\*(.+?)\*\*\s*--\s*(.+)/)
        if (match) people.push({ name: match[1], detail: match[2] })
      }
    }

    // Flush last project
    if (currentProject && currentProjectLines.length > 0) {
      projects.push({ name: currentProject, detail: currentProjectLines.slice(0, 2).join(' · ') })
    }
  } catch { /* ignore */ }

  return { priorities, openThreads, projects, people }
}

function statusBadge(status: string): string {
  const map: Record<string, string> = {
    idle: '#4a90d9',
    running: '#2ecc71',
    error: '#e74c3c',
    paused: '#f39c12',
    active: '#2ecc71',
  }
  const color = map[status] ?? '#888'
  return `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:6px;"></span>`
}

function calendarToHtml(raw: string): string {
  if (!raw) return '<p class="muted">Calendar unavailable</p>'
  const lines = raw.split('\n').filter(l => l.trim())
  if (lines.length === 0) return '<p class="muted">Nothing on the calendar today</p>'
  return lines.map(l => `<div class="cal-event">${escHtml(l)}</div>`).join('')
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

async function buildDashboard(): Promise<string> {
  const now = new Date()
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })
  const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })

  const [paperclip, calRaw, mem] = await Promise.all([
    getPaperclipData(),
    getCalendarData(),
    Promise.resolve(parseWorkingMemory()),
  ])

  const activePlans = getActivePlans()

  // Paperclip fleet cards
  const fleetHtml = paperclip.length === 0
    ? '<p class="muted">Paperclip server offline</p>'
    : paperclip.map(({ company, dash }) => {
        if (!dash) return `<div class="fleet-card"><div class="fleet-name">${escHtml(company.issuePrefix)}: ${escHtml(company.name)}</div><div class="muted">unavailable</div></div>`
        const errBadge = dash.agents.error > 0 ? `<span class="badge err">${dash.agents.error} err</span>` : ''
        const approvalBadge = dash.pendingApprovals > 0 ? `<span class="badge warn">${dash.pendingApprovals} approval${dash.pendingApprovals > 1 ? 's' : ''}</span>` : ''
        return `
          <div class="fleet-card">
            <div class="fleet-name">${escHtml(company.issuePrefix)}: ${escHtml(company.name)} ${errBadge}${approvalBadge}</div>
            <div class="fleet-stats">
              <span class="stat-item"><span class="stat-num">${dash.agents.active}</span> agents</span>
              ${dash.agents.running > 0 ? `<span class="stat-item running"><span class="stat-num">${dash.agents.running}</span> running</span>` : ''}
              <span class="stat-item"><span class="stat-num">${dash.tasks.open + dash.tasks.inProgress}</span> open</span>
              ${dash.tasks.blocked > 0 ? `<span class="stat-item blocked"><span class="stat-num">${dash.tasks.blocked}</span> blocked</span>` : ''}
              <span class="stat-item done"><span class="stat-num">${dash.tasks.done}</span> done</span>
            </div>
          </div>`
      }).join('')

  // Priorities
  const prioritiesHtml = mem.priorities.length === 0
    ? '<p class="muted">No priorities set</p>'
    : mem.priorities.map((p, i) => `<div class="priority-item"><span class="priority-num">${i + 1}</span>${escHtml(p)}</div>`).join('')

  // Open Threads
  const threadsHtml = mem.openThreads.length === 0
    ? '<p class="muted">No open threads</p>'
    : mem.openThreads.map(t => `<div class="thread-item">${escHtml(t)}</div>`).join('')

  // Projects
  const projectsHtml = mem.projects.length === 0
    ? '<p class="muted">No projects</p>'
    : mem.projects.map(p => `
        <div class="project-card">
          <div class="project-name">${escHtml(p.name)}</div>
          <div class="project-detail">${escHtml(p.detail)}</div>
        </div>`).join('')

  // Active plans
  const plansHtml = activePlans.length === 0
    ? '<p class="muted">No active plans</p>'
    : activePlans.map(({ plan, steps }) => {
        const done = steps.filter(s => s.status === 'done').length
        const pct = steps.length > 0 ? Math.round((done / steps.length) * 100) : 0
        const stepItems = steps.slice(0, 4).map(s => {
          const icon = s.status === 'done' ? '✓' : s.status === 'in_progress' ? '▶' : '○'
          const cls = s.status === 'done' ? 'step-done' : s.status === 'in_progress' ? 'step-active' : ''
          return `<div class="step-item ${cls}">${icon} ${escHtml(s.title)}</div>`
        }).join('')
        const moreLabel = steps.length > 4 ? `<div class="step-item muted">+${steps.length - 4} more</div>` : ''
        return `
          <div class="plan-card">
            <div class="plan-title">${escHtml(plan.title)}</div>
            <div class="plan-progress">
              <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
              <span class="progress-label">${done}/${steps.length}</span>
            </div>
            <div class="plan-steps">${stepItems}${moreLabel}</div>
          </div>`
      }).join('')

  // People
  const peopleHtml = mem.people.length === 0
    ? ''
    : mem.people.map(p => `<div class="person-item"><strong>${escHtml(p.name)}</strong> <span class="muted">${escHtml(p.detail)}</span></div>`).join('')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Life Helm</title>
  <style>
    :root {
      --bg: #080d18;
      --surface: #0e1525;
      --surface2: #141e32;
      --border: #1e2d4a;
      --text: #d8e3f0;
      --muted: #5a6e8a;
      --accent: #3b82f6;
      --accent2: #06b6d4;
      --gold: #f59e0b;
      --green: #10b981;
      --red: #ef4444;
      --orange: #f97316;
      --font: -apple-system, 'SF Pro Display', 'Inter', sans-serif;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--font);
      min-height: 100vh;
      padding: 20px;
      font-size: 14px;
      line-height: 1.5;
    }

    /* Header */
    .helm-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 24px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      margin-bottom: 20px;
    }

    .helm-title {
      font-size: 22px;
      font-weight: 700;
      letter-spacing: -0.5px;
      color: var(--text);
    }

    .helm-title span {
      color: var(--accent2);
    }

    .helm-meta {
      text-align: right;
      color: var(--muted);
      font-size: 13px;
    }

    .helm-time {
      font-size: 20px;
      font-weight: 600;
      color: var(--text);
      letter-spacing: -0.5px;
    }

    .helm-lila {
      font-size: 11px;
      color: var(--accent);
      margin-top: 2px;
      letter-spacing: 0.5px;
    }

    /* Grid layout */
    .grid-2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      margin-bottom: 16px;
    }

    .grid-3 {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 16px;
      margin-bottom: 16px;
    }

    .grid-full {
      margin-bottom: 16px;
    }

    /* Cards */
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 18px 20px;
    }

    .card-title {
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 1.2px;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 14px;
    }

    /* Priorities */
    .priority-item {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 8px 0;
      border-bottom: 1px solid var(--border);
      font-size: 13px;
      color: var(--text);
    }

    .priority-item:last-child { border-bottom: none; }

    .priority-num {
      min-width: 22px;
      height: 22px;
      background: var(--accent);
      color: white;
      border-radius: 50%;
      font-size: 11px;
      font-weight: 700;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    /* Calendar */
    .cal-event {
      padding: 7px 10px;
      background: var(--surface2);
      border-left: 3px solid var(--accent2);
      border-radius: 4px;
      margin-bottom: 6px;
      font-size: 12px;
      color: var(--text);
    }

    /* Fleet */
    .fleet-card {
      background: var(--surface2);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 14px 16px;
      margin-bottom: 10px;
    }

    .fleet-card:last-child { margin-bottom: 0; }

    .fleet-name {
      font-weight: 600;
      font-size: 13px;
      margin-bottom: 8px;
      color: var(--text);
    }

    .fleet-stats {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
    }

    .stat-item {
      font-size: 12px;
      color: var(--muted);
    }

    .stat-item.running { color: var(--green); }
    .stat-item.blocked { color: var(--red); }
    .stat-item.done { color: var(--muted); }

    .stat-num {
      font-weight: 700;
      color: var(--text);
      margin-right: 2px;
    }

    .stat-item.running .stat-num { color: var(--green); }
    .stat-item.blocked .stat-num { color: var(--red); }

    .badge {
      font-size: 10px;
      font-weight: 700;
      padding: 2px 6px;
      border-radius: 4px;
      margin-left: 4px;
    }

    .badge.err { background: rgba(239,68,68,0.15); color: var(--red); }
    .badge.warn { background: rgba(249,115,22,0.15); color: var(--orange); }

    /* Threads */
    .thread-item {
      padding: 7px 0;
      border-bottom: 1px solid var(--border);
      font-size: 12px;
      color: var(--muted);
    }

    .thread-item:last-child { border-bottom: none; }

    .thread-item::before {
      content: '○ ';
      color: var(--border);
    }

    /* Projects */
    .project-card {
      padding: 10px 12px;
      background: var(--surface2);
      border-radius: 6px;
      margin-bottom: 8px;
    }

    .project-card:last-child { margin-bottom: 0; }

    .project-name {
      font-weight: 600;
      font-size: 13px;
      margin-bottom: 3px;
    }

    .project-detail {
      font-size: 11px;
      color: var(--muted);
      line-height: 1.4;
    }

    /* Plans */
    .plan-card {
      background: var(--surface2);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 14px 16px;
      margin-bottom: 10px;
    }

    .plan-card:last-child { margin-bottom: 0; }

    .plan-title {
      font-weight: 600;
      font-size: 13px;
      margin-bottom: 8px;
    }

    .plan-progress {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 10px;
    }

    .progress-bar {
      flex: 1;
      height: 4px;
      background: var(--border);
      border-radius: 2px;
      overflow: hidden;
    }

    .progress-fill {
      height: 100%;
      background: var(--accent);
      border-radius: 2px;
      transition: width 0.3s ease;
    }

    .progress-label {
      font-size: 11px;
      color: var(--muted);
      white-space: nowrap;
    }

    .step-item {
      font-size: 11px;
      color: var(--muted);
      padding: 2px 0;
    }

    .step-done { color: var(--green); }
    .step-active { color: var(--accent); }

    /* People */
    .people-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }

    .person-item {
      background: var(--surface2);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 8px 14px;
      font-size: 12px;
    }

    /* Utilities */
    .muted { color: var(--muted); font-size: 12px; }

    /* Footer */
    .helm-footer {
      text-align: center;
      padding: 16px;
      color: var(--muted);
      font-size: 11px;
      letter-spacing: 0.3px;
    }

    /* Auto refresh indicator */
    .refresh-dot {
      display: inline-block;
      width: 6px;
      height: 6px;
      background: var(--green);
      border-radius: 50%;
      margin-right: 6px;
      animation: pulse 2s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }

    @media (max-width: 768px) {
      .grid-2, .grid-3 { grid-template-columns: 1fr; }
      body { padding: 12px; }
    }
  </style>
</head>
<body>

  <header class="helm-header">
    <div>
      <div class="helm-title">Life <span>Helm</span></div>
      <div class="helm-lila"><span class="refresh-dot"></span>LILA — live</div>
    </div>
    <div class="helm-meta">
      <div class="helm-time">${timeStr}</div>
      <div>${dateStr}</div>
    </div>
  </header>

  <!-- Row 1: Priorities + Calendar -->
  <div class="grid-2">
    <div class="card">
      <div class="card-title">Current Focus</div>
      ${prioritiesHtml}
    </div>
    <div class="card">
      <div class="card-title">Today</div>
      ${calendarToHtml(calRaw)}
    </div>
  </div>

  <!-- Row 2: Fleet Status -->
  <div class="grid-full">
    <div class="card">
      <div class="card-title">Agent Fleet — Paperclip</div>
      ${fleetHtml}
    </div>
  </div>

  <!-- Row 3: Open Threads + Projects + Plans -->
  <div class="grid-3">
    <div class="card">
      <div class="card-title">Open Threads</div>
      ${threadsHtml}
    </div>
    <div class="card">
      <div class="card-title">Active Projects</div>
      ${projectsHtml}
    </div>
    <div class="card">
      <div class="card-title">Active Plans</div>
      ${plansHtml}
    </div>
  </div>

  ${peopleHtml ? `
  <!-- Row 4: People -->
  <div class="grid-full">
    <div class="card">
      <div class="card-title">People</div>
      <div class="people-grid">${peopleHtml}</div>
    </div>
  </div>` : ''}

  <div class="helm-footer">
    Built and kept by Lila &middot; Refreshes every 60s
  </div>

  <script>
    // Auto-refresh every 60 seconds
    setTimeout(() => location.reload(), 60000)
  </script>

</body>
</html>`
}

export function startDashboard(): void {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/' || req.url === '/dashboard') {
      try {
        const html = await buildDashboard()
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(html)
      } catch (err) {
        logger.error({ err }, 'Dashboard render failed')
        res.writeHead(500, { 'Content-Type': 'text/plain' })
        res.end('Dashboard error')
      }
    } else if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok' }))
    } else {
      res.writeHead(404)
      res.end()
    }
  })

  server.listen(DASHBOARD_PORT, '0.0.0.0', () => {
    logger.info({ port: DASHBOARD_PORT }, 'Life Helm dashboard running')
  })

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.warn({ port: DASHBOARD_PORT }, 'Dashboard port in use, skipping')
    } else {
      logger.error({ err }, 'Dashboard server error')
    }
  })
}

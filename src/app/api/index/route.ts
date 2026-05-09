import { NextResponse } from 'next/server'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

const VERSION = '2.0.0'
export const revalidate = 300

interface Endpoint {
  path: string
  methods: string[]
  description: string
  tag: string
  auth: string
}

// Tag mapping — keeps catalog grouping stable across refactors.
// Anything not listed falls back to title-cased segment.
const TAG_MAP: Record<string, string> = {
  tasks: 'Tasks',
  projects: 'Projects',
  workspaces: 'Projects',
  agents: 'Agents',
  chat: 'Chat',
  sessions: 'Sessions',
  claude: 'Sessions',
  'claude-tasks': 'Sessions',
  activities: 'Activities',
  notifications: 'Notifications',
  'quality-review': 'Quality',
  standup: 'Standup',
  workflows: 'Workflows',
  pipelines: 'Pipelines',
  webhooks: 'Webhooks',
  alerts: 'Alerts',
  auth: 'Auth',
  tokens: 'Tokens',
  cron: 'Cron',
  scheduler: 'Cron',
  'schedule-parse': 'Cron',
  spawn: 'Spawn',
  memory: 'Memory',
  search: 'Search',
  mentions: 'Search',
  logs: 'Logs',
  settings: 'Settings',
  integrations: 'Settings',
  skills: 'Settings',
  setup: 'Settings',
  onboarding: 'Settings',
  gateways: 'Gateway',
  'gateway-config': 'Gateway',
  connect: 'Gateway',
  github: 'GitHub',
  super: 'Super Admin',
  status: 'System',
  audit: 'System',
  backup: 'System',
  cleanup: 'System',
  export: 'System',
  workload: 'System',
  releases: 'System',
  openclaw: 'System',
  diagnostics: 'System',
  debug: 'System',
  'security-audit': 'System',
  'security-scan': 'System',
  'exec-approvals': 'System',
  local: 'Local',
  docs: 'Docs',
  index: 'Discovery',
  events: 'Events',
  adapters: 'Adapters',
  channels: 'Channels',
  hermes: 'Hermes',
  gnap: 'Auth',
  nodes: 'System',
}

const METHOD_RE = /^\s*export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/gm
const ROLE_RE = /requireRole\s*\(\s*[^,]+,\s*['"]([^'"]+)['"]/g

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const nested = await walk(full)
      out.push(...nested)
    } else if (entry.isFile() && entry.name === 'route.ts') {
      out.push(full)
    }
  }
  return out
}

function fsPathToApiPath(filePath: string, apiRoot: string): string {
  // .../src/app/api/foo/[id]/bar/route.ts -> /api/foo/:id/bar
  const rel = path.relative(apiRoot, filePath).replace(/\\/g, '/')
  const trimmed = rel.replace(/\/route\.ts$/, '')
  const segments = trimmed.split('/').filter(Boolean)
  // Skip catch-all routes ([...slug]) — represent with :slug+
  const apiSegments = segments.map((seg) => {
    const m = seg.match(/^\[\.\.\.(.+)\]$/)
    if (m) return ':' + m[1] + '+'
    const dyn = seg.match(/^\[(.+)\]$/)
    if (dyn) return ':' + dyn[1]
    return seg
  })
  return '/api/' + apiSegments.join('/')
}

function tagFor(apiPath: string): string {
  const seg = apiPath.split('/')[2] || 'Other'
  if (TAG_MAP[seg]) return TAG_MAP[seg]
  return seg
    .split('-')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ')
}

function deriveAuth(source: string, methods: string[]): string {
  const roles = new Set<string>()
  let m
  while ((m = ROLE_RE.exec(source)) !== null) roles.add(m[1])
  ROLE_RE.lastIndex = 0
  if (roles.size === 0) return 'public'
  // Stable order: viewer, operator, admin, then anything else alpha.
  const order = ['viewer', 'operator', 'admin']
  const sorted = [
    ...order.filter((r) => roles.has(r)),
    ...[...roles].filter((r) => !order.includes(r)).sort(),
  ]
  return sorted.join('/')
}

async function buildEndpoints(): Promise<Endpoint[]> {
  const apiRoot = path.join(process.cwd(), 'src', 'app', 'api')
  const files = await walk(apiRoot)
  const endpoints: Endpoint[] = []
  for (const file of files) {
    let source: string
    try {
      source = await readFile(file, 'utf8')
    } catch {
      continue
    }
    const methods: string[] = []
    let m
    while ((m = METHOD_RE.exec(source)) !== null) methods.push(m[1])
    METHOD_RE.lastIndex = 0
    if (methods.length === 0) continue
    const apiPath = fsPathToApiPath(file, apiRoot)
    endpoints.push({
      path: apiPath,
      methods: [...new Set(methods)],
      description: apiPath + ' endpoint',
      tag: tagFor(apiPath),
      auth: deriveAuth(source, methods),
    })
  }
  endpoints.sort((a, b) => a.path.localeCompare(b.path))
  return endpoints
}

export async function GET() {
  const endpoints = await buildEndpoints()
  const payload = {
    version: VERSION,
    generated_at: new Date().toISOString(),
    total_endpoints: endpoints.length,
    endpoints,
    event_stream: {
      path: '/api/events',
      protocol: 'SSE',
      description: 'Real-time server-sent events for tasks, agents, chat, and activity updates',
    },
    docs: {
      openapi: '/api/docs',
      tree: '/api/docs/tree',
      search: '/api/docs/search',
    },
  }
  return NextResponse.json(payload, {
    headers: {
      'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
    },
  })
}

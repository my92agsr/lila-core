import { execSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..')

const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'

function ok(msg: string) { console.log(`  ${GREEN}✓${RESET} ${msg}`) }
function warn(msg: string) { console.log(`  ${YELLOW}⚠${RESET} ${msg}`) }
function fail(msg: string) { console.log(`  ${RED}✗${RESET} ${msg}`) }

function readEnv(): Record<string, string> {
  const envPath = join(PROJECT_ROOT, '.env')
  if (!existsSync(envPath)) return {}
  const result: Record<string, string> = {}
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    let val = trimmed.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    result[trimmed.slice(0, eq).trim()] = val
  }
  return result
}

async function main() {
  console.log(`\n${BOLD}Lila Status${RESET}\n`)
  const env = readEnv()

  // Node version
  const major = parseInt(process.version.slice(1).split('.')[0], 10)
  if (major >= 20) ok(`Node.js ${process.version}`)
  else fail(`Node.js ${process.version} (need >=20)`)

  // Claude CLI
  try {
    const ver = execSync('claude --version 2>/dev/null', { encoding: 'utf-8' }).trim()
    ok(`Claude CLI: ${ver}`)
  } catch {
    fail('Claude CLI not found')
  }

  // Bot token
  if (env.TELEGRAM_BOT_TOKEN) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`)
      const data = await res.json() as { ok: boolean; result?: { username: string } }
      if (data.ok) ok(`Telegram bot: @${data.result?.username}`)
      else fail('Telegram bot token invalid')
    } catch {
      fail('Could not verify Telegram bot token')
    }
  } else {
    fail('TELEGRAM_BOT_TOKEN not set')
  }

  // Chat ID
  if (env.ALLOWED_CHAT_ID) ok(`Chat ID: ${env.ALLOWED_CHAT_ID}`)
  else warn('ALLOWED_CHAT_ID not set (accepting all chats)')

  // OpenAI STT
  if (env.OPENAI_API_KEY) ok('OpenAI STT: configured')
  else warn('OpenAI STT: not configured (voice disabled)')

  // Google API
  if (env.GOOGLE_API_KEY) ok('Google API (Gemini): configured')
  else warn('Google API: not configured (video analysis disabled)')

  // Service status (macOS)
  if (process.platform === 'darwin') {
    try {
      const result = execSync('launchctl list com.lila.app 2>/dev/null', { encoding: 'utf-8' })
      if (result.includes('com.lila.app')) ok('Service: running (launchd)')
      else warn('Service: loaded but may not be running')
    } catch {
      warn('Service: not installed')
    }
  } else if (process.platform === 'linux') {
    try {
      execSync('systemctl --user is-active lila 2>/dev/null', { encoding: 'utf-8' })
      ok('Service: running (systemd)')
    } catch {
      warn('Service: not running')
    }
  }

  // Database
  const dbPath = join(PROJECT_ROOT, 'store', 'lila.db')
  if (existsSync(dbPath)) {
    ok(`Database: ${dbPath}`)
    try {
      // Quick row count check using better-sqlite3 would require import
      // Just check file exists and has content
      const { size } = await import('fs').then(fs => fs.statSync(dbPath))
      ok(`Database size: ${(size / 1024).toFixed(1)}KB`)
    } catch { /* ignore */ }
  } else {
    warn('Database: not yet created (will be created on first run)')
  }

  // PID file
  const pidPath = join(PROJECT_ROOT, 'store', 'lila.pid')
  if (existsSync(pidPath)) {
    const pid = readFileSync(pidPath, 'utf-8').trim()
    try {
      process.kill(parseInt(pid, 10), 0)
      ok(`Process running: PID ${pid}`)
    } catch {
      warn(`Stale PID file: ${pid} (process not running)`)
    }
  } else {
    warn('No PID file (bot not running)')
  }

  console.log('')
}

main().catch(console.error)

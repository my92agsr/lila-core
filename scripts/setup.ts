import { execSync, spawnSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createInterface } from 'readline'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..')

// ANSI colors
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'
const CYAN = '\x1b[36m'

function ok(msg: string) { console.log(`${GREEN}✓${RESET} ${msg}`) }
function warn(msg: string) { console.log(`${YELLOW}⚠${RESET} ${msg}`) }
function fail(msg: string) { console.log(`${RED}✗${RESET} ${msg}`) }
function header(msg: string) { console.log(`\n${BOLD}${CYAN}${msg}${RESET}\n`) }

const rl = createInterface({ input: process.stdin, output: process.stdout })

function ask(question: string): Promise<string> {
  return new Promise(resolve => {
    rl.question(`${BOLD}${question}${RESET} `, answer => resolve(answer.trim()))
  })
}

async function main() {
  console.log(`
${BOLD}╔═══════════════════════════════════════╗
║       Lila Setup Wizard         ║
╚═══════════════════════════════════════╝${RESET}
`)

  // --- Check requirements ---
  header('Checking requirements...')

  // Node version
  const nodeVersion = process.version
  const major = parseInt(nodeVersion.slice(1).split('.')[0], 10)
  if (major >= 20) {
    ok(`Node.js ${nodeVersion}`)
  } else {
    fail(`Node.js ${nodeVersion} — need >=20`)
    process.exit(1)
  }

  // Claude CLI
  try {
    const claudeVersion = execSync('claude --version 2>/dev/null', { encoding: 'utf-8' }).trim()
    ok(`Claude CLI: ${claudeVersion}`)
  } catch {
    fail('Claude CLI not found. Install it first: https://docs.anthropic.com/en/docs/claude-code')
    process.exit(1)
  }

  // Build project
  header('Building project...')
  const buildResult = spawnSync('npm', ['run', 'build'], {
    cwd: PROJECT_ROOT,
    stdio: 'pipe',
    encoding: 'utf-8',
  })
  if (buildResult.status === 0) {
    ok('TypeScript compiled successfully')
  } else {
    fail('Build failed:')
    console.log(buildResult.stderr || buildResult.stdout)
    process.exit(1)
  }

  // --- Collect config ---
  header('Configuration')

  const config: Record<string, string> = {}

  // Telegram bot token
  console.log(`
To create a Telegram bot:
1. Open Telegram and search for @BotFather
2. Send /newbot
3. Choose a name (e.g. "My Lila")
4. Choose a username (must end in "bot", e.g. "my_lila_bot")
5. Copy the token BotFather gives you
`)
  config.TELEGRAM_BOT_TOKEN = await ask('Telegram bot token:')
  if (!config.TELEGRAM_BOT_TOKEN) {
    fail('Bot token is required.')
    process.exit(1)
  }

  // OpenAI API key (STT)
  console.log(`\nFor voice transcription, you need an OpenAI API key.`)
  console.log(`Get one at: https://platform.openai.com/api-keys`)
  config.OPENAI_API_KEY = await ask('OpenAI API key (press Enter to skip):')
  if (config.OPENAI_API_KEY) {
    ok('OpenAI STT configured')
  } else {
    warn('Voice transcription will be disabled')
  }

  // Google API key (video)
  console.log(`\nFor video analysis via Gemini:`)
  console.log(`Get a free key at: https://aistudio.google.com/apikey`)
  config.GOOGLE_API_KEY = await ask('Google API key (press Enter to skip):')
  if (config.GOOGLE_API_KEY) {
    ok('Video analysis configured')
  } else {
    warn('Video analysis will be disabled')
  }

  // --- Write .env ---
  header('Writing .env file...')

  const envLines = [
    '# Lila Configuration',
    '',
    `TELEGRAM_BOT_TOKEN=${config.TELEGRAM_BOT_TOKEN}`,
    `ALLOWED_CHAT_ID=`,
    '',
    `OPENAI_API_KEY=${config.OPENAI_API_KEY ?? ''}`,
    `GOOGLE_API_KEY=${config.GOOGLE_API_KEY ?? ''}`,
    '',
    'LOG_LEVEL=info',
    'NODE_ENV=production',
  ]

  writeFileSync(join(PROJECT_ROOT, '.env'), envLines.join('\n') + '\n')
  ok('.env written')

  // --- Personalize CLAUDE.md ---
  header('Personalizing CLAUDE.md...')
  const editor = process.env.EDITOR || 'nano'
  console.log(`Opening CLAUDE.md in ${editor}...`)
  console.log(`Replace the [YOUR NAME] and [YOUR ASSISTANT NAME] placeholders.`)
  console.log(`Press Enter when ready to open the editor.`)
  await ask('')

  try {
    spawnSync(editor, [join(PROJECT_ROOT, 'CLAUDE.md')], { stdio: 'inherit' })
    ok('CLAUDE.md personalized')
  } catch {
    warn(`Couldn't open editor. Edit CLAUDE.md manually later.`)
  }

  // --- Create directories ---
  const storeDir = join(PROJECT_ROOT, 'store')
  const uploadsDir = join(PROJECT_ROOT, 'workspace', 'uploads')
  if (!existsSync(storeDir)) mkdirSync(storeDir, { recursive: true })
  if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true })

  // --- Get chat ID ---
  header('Getting your chat ID...')
  console.log(`I'll start the bot briefly so you can get your chat ID.`)
  console.log(`1. Open your bot in Telegram`)
  console.log(`2. Send /chatid`)
  console.log(`3. Copy the number it replies with`)
  console.log(``)

  const chatId = await ask('Paste your chat ID here (or press Enter to set later):')
  if (chatId) {
    // Update .env with chat ID
    const envContent = readFileSync(join(PROJECT_ROOT, '.env'), 'utf-8')
    writeFileSync(
      join(PROJECT_ROOT, '.env'),
      envContent.replace('ALLOWED_CHAT_ID=', `ALLOWED_CHAT_ID=${chatId}`),
    )
    ok(`Chat ID set to ${chatId}`)
  } else {
    warn('Set ALLOWED_CHAT_ID in .env later. Bot will accept all chats until then.')
  }

  // --- Install background service ---
  header('Background service')

  const installService = await ask('Install as background service (starts on boot)? [y/N]:')
  if (installService.toLowerCase() === 'y') {
    const platform = process.platform

    if (platform === 'darwin') {
      const plistName = 'com.lila.app'
      const plistPath = join(process.env.HOME!, 'Library', 'LaunchAgents', `${plistName}.plist`)
      const logPath = '/tmp/lila.log'

      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${plistName}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${join(PROJECT_ROOT, 'dist', 'index.js')}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${PROJECT_ROOT}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:${dirname(process.execPath)}</string>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>
</dict>
</plist>`

      const laDir = dirname(plistPath)
      if (!existsSync(laDir)) mkdirSync(laDir, { recursive: true })
      writeFileSync(plistPath, plist)

      // Unload if already loaded, then load
      try { execSync(`launchctl unload ${plistPath} 2>/dev/null`) } catch { /* ignore */ }
      execSync(`launchctl load ${plistPath}`)

      ok(`Service installed: ${plistPath}`)
      ok(`Logs: ${logPath}`)
      console.log(`\nManage with:`)
      console.log(`  launchctl stop ${plistName}`)
      console.log(`  launchctl start ${plistName}`)
      console.log(`  launchctl unload ${plistPath}`)

    } else if (platform === 'linux') {
      const serviceName = 'lila'
      const serviceDir = join(process.env.HOME!, '.config', 'systemd', 'user')
      const servicePath = join(serviceDir, `${serviceName}.service`)

      const unit = `[Unit]
Description=Lila AI Assistant
After=network.target

[Service]
Type=simple
ExecStart=${process.execPath} ${join(PROJECT_ROOT, 'dist', 'index.js')}
WorkingDirectory=${PROJECT_ROOT}
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=PATH=/usr/local/bin:/usr/bin:/bin:${dirname(process.execPath)}

[Install]
WantedBy=default.target`

      if (!existsSync(serviceDir)) mkdirSync(serviceDir, { recursive: true })
      writeFileSync(servicePath, unit)

      execSync('systemctl --user daemon-reload')
      execSync(`systemctl --user enable ${serviceName}`)
      execSync(`systemctl --user start ${serviceName}`)

      ok(`Service installed: ${servicePath}`)
      console.log(`\nManage with:`)
      console.log(`  systemctl --user status ${serviceName}`)
      console.log(`  systemctl --user stop ${serviceName}`)
      console.log(`  systemctl --user restart ${serviceName}`)
      console.log(`  journalctl --user -u ${serviceName} -f`)

    } else {
      warn('Windows detected. Install PM2 for background service:')
      console.log('  npm install -g pm2')
      console.log(`  pm2 start ${join(PROJECT_ROOT, 'dist', 'index.js')} --name lila`)
      console.log('  pm2 save')
      console.log('  pm2 startup')
    }
  } else {
    console.log('Skipped. Run manually with: npm run start')
  }

  // --- Done ---
  header('Setup complete!')
  console.log(`Next steps:`)
  console.log(`  1. ${chatId ? '' : 'Set ALLOWED_CHAT_ID in .env\n  2. '}Open your bot in Telegram and send a message`)
  console.log(`  ${chatId ? '2' : '3'}. Check logs: tail -f /tmp/lila.log`)
  console.log(`  ${chatId ? '3' : '4'}. Run npm run status to verify everything`)
  console.log(``)
  console.log(`${BOLD}Enjoy Lila!${RESET}`)

  rl.close()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

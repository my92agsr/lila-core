import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { readEnvFile } from './env.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const PROJECT_ROOT = join(__dirname, '..')
export const STORE_DIR = join(PROJECT_ROOT, 'store')
export const MAX_MESSAGE_LENGTH = 4096
export const TYPING_REFRESH_MS = 4000

const env = readEnvFile()

export const TELEGRAM_BOT_TOKEN = env['TELEGRAM_BOT_TOKEN'] ?? ''
export const ALLOWED_CHAT_ID = env['ALLOWED_CHAT_ID'] ?? ''
export const OPENAI_API_KEY = env['OPENAI_API_KEY'] ?? ''
export const GOOGLE_API_KEY = env['GOOGLE_API_KEY'] ?? ''
export const ELEVENLABS_API_KEY = env['ELEVENLABS_API_KEY'] ?? ''
export const ELEVENLABS_VOICE_ID = env['ELEVENLABS_VOICE_ID'] ?? 'cgSgspJ2msm6clMCkdW9'

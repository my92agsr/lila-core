import { readFileSync, writeFileSync, renameSync, existsSync } from 'fs'
import { basename, join } from 'path'
import https from 'https'
import OpenAI from 'openai'
import { OPENAI_API_KEY, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, STORE_DIR } from './config.js'
import { logger } from './logger.js'

let openaiClient: OpenAI | null = null

function getOpenAI(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: OPENAI_API_KEY })
  }
  return openaiClient
}

export async function transcribeAudio(filePath: string): Promise<string> {
  // Telegram sends .oga — OpenAI accepts it fine, but rename to .ogg for safety
  let targetPath = filePath
  if (filePath.endsWith('.oga')) {
    targetPath = filePath.replace(/\.oga$/, '.ogg')
    renameSync(filePath, targetPath)
  }

  if (!existsSync(targetPath)) {
    throw new Error(`Audio file not found: ${targetPath}`)
  }

  const client = getOpenAI()
  const file = readFileSync(targetPath)
  const blob = new Blob([file], { type: 'audio/ogg' })
  const audioFile = new File([blob], basename(targetPath), { type: 'audio/ogg' })

  const response = await client.audio.transcriptions.create({
    file: audioFile,
    model: 'whisper-1',
  })

  logger.info({ chars: response.text.length }, 'Audio transcribed via OpenAI')
  return response.text
}

export async function textToSpeech(text: string): Promise<string | null> {
  if (!ELEVENLABS_API_KEY) {
    logger.warn('ElevenLabs API key not configured, skipping TTS')
    return null
  }

  const outputPath = join(STORE_DIR, `tts-${Date.now()}.mp3`)

  const data = JSON.stringify({
    text: text,
    model_id: 'eleven_monolingual_v1',
    voice_settings: {
      stability: 0.5,
      similarity_boost: 0.75,
      style: 0.5,
      use_speaker_boost: true
    }
  })

  logger.info({ voiceId: ELEVENLABS_VOICE_ID }, 'Using ElevenLabs voice')

  const options = {
    hostname: 'api.elevenlabs.io',
    port: 443,
    path: `/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
    method: 'POST',
    headers: {
      'Accept': 'audio/mpeg',
      'Content-Type': 'application/json',
      'xi-api-key': ELEVENLABS_API_KEY
    }
  }

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      if (res.statusCode !== 200) {
        let body = ''
        res.on('data', chunk => body += chunk)
        res.on('end', () => {
          logger.error({ status: res.statusCode, body }, 'ElevenLabs TTS failed')
          resolve(null)
        })
        return
      }

      const chunks: Buffer[] = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const buffer = Buffer.concat(chunks)
        writeFileSync(outputPath, buffer)
        logger.info({ path: outputPath, bytes: buffer.length }, 'TTS audio generated')
        resolve(outputPath)
      })
    })

    req.on('error', (err) => {
      logger.error({ err }, 'ElevenLabs TTS request failed')
      resolve(null)
    })

    req.write(data)
    req.end()
  })
}

export function voiceCapabilities(): { stt: boolean; tts: boolean } {
  return {
    stt: !!OPENAI_API_KEY,
    tts: !!ELEVENLABS_API_KEY,
  }
}

import { mkdirSync, existsSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { PROJECT_ROOT } from './config.js'
import { logger } from './logger.js'

export const UPLOADS_DIR = join(PROJECT_ROOT, 'workspace', 'uploads')

function ensureUploadsDir(): void {
  if (!existsSync(UPLOADS_DIR)) {
    mkdirSync(UPLOADS_DIR, { recursive: true })
  }
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '-')
}

export async function downloadMedia(
  botToken: string,
  fileId: string,
  originalFilename?: string,
): Promise<string> {
  ensureUploadsDir()

  // Get file path from Telegram
  const fileInfoRes = await fetch(
    `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`,
  )
  const fileInfo = (await fileInfoRes.json()) as { ok: boolean; result: { file_path: string } }
  if (!fileInfo.ok) throw new Error('Failed to get file info from Telegram')

  const remotePath = fileInfo.result.file_path
  const ext = remotePath.includes('.') ? '.' + remotePath.split('.').pop() : ''
  const safeName = originalFilename
    ? sanitizeFilename(originalFilename)
    : `file${ext}`

  const localPath = join(UPLOADS_DIR, `${Date.now()}_${safeName}`)

  const downloadRes = await fetch(
    `https://api.telegram.org/file/bot${botToken}/${remotePath}`,
  )
  if (!downloadRes.ok) throw new Error('Failed to download file from Telegram')

  const buffer = Buffer.from(await downloadRes.arrayBuffer())
  writeFileSync(localPath, buffer)

  logger.info({ localPath, size: buffer.length }, 'Media downloaded')
  return localPath
}

export function buildPhotoMessage(localPath: string, caption?: string): string {
  const parts = [`[Photo received — saved to ${localPath}]`]
  if (caption) parts.push(`Caption: ${caption}`)
  parts.push('Please analyze this image.')
  return parts.join('\n')
}

export function buildDocumentMessage(localPath: string, filename: string, caption?: string): string {
  const parts = [`[Document received: ${filename} — saved to ${localPath}]`]
  if (caption) parts.push(`Caption: ${caption}`)
  parts.push('Please review this document.')
  return parts.join('\n')
}

export function buildVideoMessage(localPath: string, caption?: string): string {
  const parts = [`[Video received — saved to ${localPath}]`]
  if (caption) parts.push(`Caption: ${caption}`)
  parts.push(
    'Analyze this video using the Gemini API. The GOOGLE_API_KEY is available in the .env file in this project directory.',
  )
  return parts.join('\n')
}

export function cleanupOldUploads(maxAgeMs = 24 * 60 * 60 * 1000): void {
  ensureUploadsDir()
  const now = Date.now()
  let cleaned = 0

  for (const file of readdirSync(UPLOADS_DIR)) {
    const filePath = join(UPLOADS_DIR, file)
    try {
      const stat = statSync(filePath)
      if (now - stat.mtimeMs > maxAgeMs) {
        unlinkSync(filePath)
        cleaned++
      }
    } catch {
      // ignore
    }
  }

  if (cleaned > 0) {
    logger.info({ cleaned }, 'Old uploads cleaned up')
  }
}

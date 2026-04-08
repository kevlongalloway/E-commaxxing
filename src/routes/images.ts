import { Hono } from 'hono'
import type { Bindings } from '../types'
import { ok, err } from '../types'

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

const images = new Hono<{ Bindings: Bindings }>()

images.post('/upload', async (c) => {
  if (!c.env.IMAGES) {
    return c.json(err('R2 bucket not configured'), 500)
  }

  let formData: FormData
  try {
    formData = await c.req.formData()
  } catch {
    return c.json(err('Request must be multipart/form-data'), 400)
  }

  const file = formData.get('file')
  if (!(file instanceof File)) {
    return c.json(err('Missing "file" field'), 400)
  }

  if (!ALLOWED_TYPES.includes(file.type)) {
    return c.json(err(`Invalid file type "${file.type}". Allowed: jpeg, png, webp, gif`), 400)
  }

  const ext = EXT[file.type]
  const key = `${crypto.randomUUID()}.${ext}`

  await c.env.IMAGES.put(key, file.stream(), {
    httpMetadata: { contentType: file.type },
  })

  const url = `${c.env.R2_PUBLIC_URL}/${key}`
  return c.json(ok({ url, key }), 201)
})

images.delete('/:key{.+}', async (c) => {
  if (!c.env.IMAGES) {
    return c.json(err('R2 bucket not configured'), 500)
  }

  const key = c.req.param('key')
  await c.env.IMAGES.delete(key)
  return c.json(ok({ deleted: key }))
})

export default images

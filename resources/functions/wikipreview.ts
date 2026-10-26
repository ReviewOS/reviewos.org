import { writeHeaders } from './csrf'

export async function previewWikiMarkdown(endpoint: string, body: string): Promise<string> {
  const answer = await fetch(endpoint, { method: 'POST', headers: writeHeaders('application/json'), body: JSON.stringify({ body }) })
  const data = await answer.json()
  if (!answer.ok)
    throw new Error(String(data.error ?? 'The preview could not be loaded'))
  return String(data.html ?? '')
}

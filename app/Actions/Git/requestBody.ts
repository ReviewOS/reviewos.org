/** Git compresses larger smart-HTTP requests, including fetch negotiations. */
export class UnsupportedGitContentEncoding extends Error {}

/** Decode once at the HTTP boundary while retaining streaming backpressure. */
export function gitRequestBody(request: Pick<Request, 'headers' | 'body'>): Request['body'] {
  const encoding = (request.headers.get('content-encoding') ?? 'identity').trim().toLowerCase()
  if (encoding !== 'identity' && encoding !== 'gzip')
    throw new UnsupportedGitContentEncoding('Git requests support identity or gzip Content-Encoding')
  if (!request.body || encoding === 'identity')
    return request.body
  return request.body.pipeThrough(new DecompressionStream('gzip'))
}

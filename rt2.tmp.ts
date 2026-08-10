const { injectGlobalAutoImports } = await import('@stacksjs/server')
await injectGlobalAutoImports()
const { useTypesense } = await import('@stacksjs/search-engine')
const ts: any = await useTypesense()
console.log('methods:', Object.keys(ts).join(', '))

try {
  await ts.createIndex('probe_repos', {
    fields: [
      { name: 'name', type: 'string' },
      { name: 'description', type: 'string', optional: true },
      { name: 'visibility', type: 'string', facet: true },
    ],
  })
  console.log('created collection')
  await ts.addDocument('probe_repos', { id: '1', name: 'reviewos', description: 'a git forge built around the review', visibility: 'public' })
  await ts.addDocument('probe_repos', { id: '2', name: 'secret-plans', description: 'private things', visibility: 'private' })
  await new Promise(r => setTimeout(r, 400))
  const hits = await ts.search('probe_repos', 'forge', { query_by: 'name,description' })
  console.log('search "forge" ->', JSON.stringify((hits?.hits ?? []).map((h: any) => h.document?.name)))
  const typo = await ts.search('probe_repos', 'revewos', { query_by: 'name,description' })
  console.log('typo "revewos" ->', JSON.stringify((typo?.hits ?? []).map((h: any) => h.document?.name)))
  const filtered = await ts.search('probe_repos', '*', { query_by: 'name', filter_by: 'visibility:=public' })
  console.log('filter visibility:=public ->', JSON.stringify((filtered?.hits ?? []).map((h: any) => h.document?.name)))
}
finally { try { await ts.deleteIndex('probe_repos') } catch {} }

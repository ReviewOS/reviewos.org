import { db } from '@stacksjs/database'
for (const t of ['users','organizations','repositories','repository_mirrors','issues']) {
  try {
    const rows = await db.selectFrom(t as any).selectAll().limit(5).execute()
    const count = await db.selectFrom(t as any).select(db.fn.countAll().as('c')).executeTakeFirst()
    console.log(`== ${t}: ${(count as any)?.c}`)
    for (const r of rows) console.log('  ', JSON.stringify(r).slice(0, 200))
  } catch (e) { console.log(`== ${t}: ERROR ${String(e).slice(0,200)}`) }
}
process.exit(0)

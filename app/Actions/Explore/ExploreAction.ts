import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { byLanguage, byTopic, EXPLORE_LIMIT, languageIndex, recentlyActive, trending } from './explore'

/**
 * What is happening on this instance.
 *
 * Public repositories only, enforced in the reads rather than here - an explore
 * page is the one surface where a visibility mistake is not a leak to one
 * person but a listing.
 *
 * ## Both lists, always
 *
 * Trending and recently active are returned together rather than one falling
 * back to the other. On a young instance nothing has gained a star this week
 * and trending is empty, and a page that quietly showed "recently active" under
 * a heading that says "trending" would be lying about what it knows. An empty
 * section that says so is better, and the page can hide it.
 */
export default new Action({
  name: 'Explore',
  description: 'Trending and recently active repositories, by topic or language',
  method: 'GET',

  validations: {
    topic: { rule: schema.string() },
    language: { rule: schema.string() },
    days: { rule: schema.number() },
  },

  async handle(request: any) {
    const topic = String(request.get('topic') ?? '').trim()
    const language = String(request.get('language') ?? '').trim()

    // A filtered view is one list rather than the whole page: somebody who
    // asked for Rust wants the Rust, not the Rust plus everything else.
    if (topic)
      return response.json({ filter: { topic }, repositories: await byTopic(topic) })

    if (language)
      return response.json({ filter: { language }, repositories: await byLanguage(language) })

    /*
     * The window, bounded. A week is right for a busy public instance and shows
     * an empty page on a company one, where a month is the smallest window with
     * anything in it - so it is a parameter, with a ceiling, because "trending
     * over the last three years" is just the all-time list wearing a disguise.
     */
    const days = Math.max(1, Math.min(90, Number(request.get('days')) || 7))

    const [gaining, active, languages] = await Promise.all([
      trending(days, EXPLORE_LIMIT),
      recentlyActive(EXPLORE_LIMIT),
      languageIndex(),
    ])

    return response.json({
      window_days: days,
      trending: gaining,
      recently_active: active,
      languages,
    })
  },
})

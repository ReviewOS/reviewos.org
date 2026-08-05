/**
 * Emoji shortcodes: `:tada:` in a body, and the eight names a reaction is
 * allowed to be.
 *
 * One table for both, which is the point of putting them in the same file.
 * Reactions are shortcodes with a permission check and a row in the database;
 * if a reader can write `:rocket:` in a comment and click a `:rocket:` button
 * underneath it, the two had better be the same rocket.
 *
 * ## Why a table rather than a package
 *
 * The full Unicode set is around eighteen hundred names, most of which nobody
 * has ever typed into an issue, and every package that ships it also ships an
 * opinion about skin tone modifiers, aliases, and which of the four names for
 * the same character is canonical. What is here is the set that appears in
 * commit messages, changelogs and pull request descriptions, plus the reaction
 * eight. An unrecognised shortcode renders as the text somebody wrote, which is
 * the correct answer for a name this table does not have: `:shipit:` should
 * look like `:shipit:`, not disappear.
 */

/**
 * The eight a reaction may be, in the order they are shown.
 *
 * Fixed, and fixed everywhere: the column is an enum, the picker iterates this
 * array, and the action checks membership against it. Ordering matters because
 * a row of reactions that reorders itself as counts change is unreadable.
 */
export const REACTIONS = [
  '+1',
  '-1',
  'laugh',
  'hooray',
  'confused',
  'heart',
  'rocket',
  'eyes',
] as const

export type Reaction = typeof REACTIONS[number]

export function isReaction(value: unknown): value is Reaction {
  return typeof value === 'string' && (REACTIONS as readonly string[]).includes(value)
}

/**
 * Shortcode to character.
 *
 * Grouped roughly by why somebody reaches for one. Aliases are listed next to
 * the name they duplicate rather than resolved through a second table, because
 * a lookup that can fail twice is a lookup with two ways to be wrong.
 */
export const EMOJI: Record<string, string> = {
  // The reaction eight, first because they are load-bearing.
  '+1': '👍',
  'thumbsup': '👍',
  '-1': '👎',
  'thumbsdown': '👎',
  'laugh': '😄',
  'smile': '😄',
  'hooray': '🎉',
  'tada': '🎉',
  'confused': '😕',
  'heart': '❤️',
  'rocket': '🚀',
  'eyes': '👀',

  // Faces.
  'smiley': '😃',
  'grin': '😁',
  'grinning': '😀',
  'joy': '😂',
  'rofl': '🤣',
  'sweat_smile': '😅',
  'wink': '😉',
  'blush': '😊',
  'slightly_smiling_face': '🙂',
  'upside_down_face': '🙃',
  'thinking': '🤔',
  'thinking_face': '🤔',
  'neutral_face': '😐',
  'expressionless': '😑',
  'no_mouth': '😶',
  'smirk': '😏',
  'unamused': '😒',
  'roll_eyes': '🙄',
  'grimacing': '😬',
  'relieved': '😌',
  'pensive': '😔',
  'sleepy': '😪',
  'sleeping': '😴',
  'mask': '😷',
  'nauseated_face': '🤢',
  'exploding_head': '🤯',
  'cowboy_hat_face': '🤠',
  'sunglasses': '😎',
  'nerd_face': '🤓',
  'confounded': '😖',
  'persevere': '😣',
  'disappointed': '😞',
  'sweat': '😓',
  'weary': '😩',
  'tired_face': '😫',
  'triumph': '😤',
  'rage': '😡',
  'angry': '😠',
  'sob': '😭',
  'cry': '😢',
  'scream': '😱',
  'fearful': '😨',
  'cold_sweat': '😰',
  'flushed': '😳',
  'astonished': '😲',
  'open_mouth': '😮',
  'zipper_mouth_face': '🤐',
  'shushing_face': '🤫',
  'skull': '💀',
  'ghost': '👻',
  'alien': '👽',
  'robot': '🤖',
  'poop': '💩',
  'clown_face': '🤡',

  // Hands and people.
  'wave': '👋',
  'raised_hands': '🙌',
  'clap': '👏',
  'pray': '🙏',
  'handshake': '🤝',
  'muscle': '💪',
  'point_up': '☝️',
  'point_down': '👇',
  'point_left': '👈',
  'point_right': '👉',
  'ok_hand': '👌',
  'v': '✌️',
  'crossed_fingers': '🤞',
  'facepalm': '🤦',
  'shrug': '🤷',
  'man_shrugging': '🤷‍♂️',
  'woman_shrugging': '🤷‍♀️',
  'bow': '🙇',
  'eyeglasses': '👓',
  'brain': '🧠',

  // Status, which is most of what a forge uses.
  'white_check_mark': '✅',
  'heavy_check_mark': '✔️',
  'ballot_box_with_check': '☑️',
  'x': '❌',
  'negative_squared_cross_mark': '❎',
  'heavy_multiplication_x': '✖️',
  'warning': '⚠️',
  'exclamation': '❗',
  'question': '❓',
  'grey_question': '❔',
  'bangbang': '‼️',
  'no_entry': '⛔',
  'no_entry_sign': '🚫',
  'stop_sign': '🛑',
  'construction': '🚧',
  'rotating_light': '🚨',
  'red_circle': '🔴',
  'green_circle': '🟢',
  'yellow_circle': '🟡',
  'large_blue_circle': '🔵',
  'white_circle': '⚪',
  'black_circle': '⚫',
  'small_red_triangle': '🔺',
  'small_red_triangle_down': '🔻',
  'sparkles': '✨',
  'star': '⭐',
  'star2': '🌟',
  'boom': '💥',
  'fire': '🔥',
  'zap': '⚡',
  'high_brightness': '🔆',
  'recycle': '♻️',
  'infinity': '♾️',

  // Work.
  'bug': '🐛',
  'beetle': '🪲',
  'ant': '🐜',
  'spider': '🕷️',
  'wrench': '🔧',
  'hammer': '🔨',
  'hammer_and_wrench': '🛠️',
  'nut_and_bolt': '🔩',
  'gear': '⚙️',
  'toolbox': '🧰',
  'test_tube': '🧪',
  'microscope': '🔬',
  'telescope': '🔭',
  'mag': '🔍',
  'mag_right': '🔎',
  'lock': '🔒',
  'unlock': '🔓',
  'key': '🔑',
  'closed_lock_with_key': '🔐',
  'shield': '🛡️',
  'bulb': '💡',
  'label': '🏷️',
  'bookmark': '🔖',
  'pushpin': '📌',
  'round_pushpin': '📍',
  'paperclip': '📎',
  'link': '🔗',
  'scissors': '✂️',
  'pencil2': '✏️',
  'memo': '📝',
  'clipboard': '📋',
  'books': '📚',
  'book': '📖',
  'notebook': '📓',
  'ledger': '📒',
  'page_facing_up': '📄',
  'newspaper': '📰',
  'file_folder': '📁',
  'open_file_folder': '📂',
  'card_index_dividers': '🗂️',
  'card_file_box': '🗃️',
  'wastebasket': '🗑️',
  'package': '📦',
  'inbox_tray': '📥',
  'outbox_tray': '📤',
  'envelope': '✉️',
  'email': '📧',
  'calendar': '📅',
  'date': '📆',
  'alarm_clock': '⏰',
  'hourglass': '⌛',
  'hourglass_flowing_sand': '⏳',
  'stopwatch': '⏱️',
  'chart_with_upwards_trend': '📈',
  'chart_with_downwards_trend': '📉',
  'bar_chart': '📊',
  'computer': '💻',
  'desktop_computer': '🖥️',
  'keyboard': '⌨️',
  'floppy_disk': '💾',
  'cd': '💿',
  'minidisc': '💽',
  'iphone': '📱',
  'satellite': '🛰️',
  'electric_plug': '🔌',
  'battery': '🔋',
  'flashlight': '🔦',
  'bell': '🔔',
  'no_bell': '🔕',
  'loudspeaker': '📢',
  'mega': '📣',
  'speech_balloon': '💬',
  'thought_balloon': '💭',
  'left_speech_bubble': '🗨️',

  // Movement and shipping.
  'ship': '🚢',
  'shipit': '🚢',
  'anchor': '⚓',
  'airplane': '✈️',
  'helicopter': '🚁',
  'truck': '🚚',
  'car': '🚗',
  'bike': '🚲',
  'train': '🚆',
  'tractor': '🚜',
  'construction_worker': '👷',
  'runner': '🏃',
  'turtle': '🐢',
  'snail': '🐌',
  'rabbit': '🐰',
  'racehorse': '🐎',

  // Arrows and navigation.
  'arrow_up': '⬆️',
  'arrow_down': '⬇️',
  'arrow_left': '⬅️',
  'arrow_right': '➡️',
  'arrow_upper_right': '↗️',
  'arrow_lower_right': '↘️',
  'arrows_counterclockwise': '🔄',
  'arrow_right_hook': '↪️',
  'leftwards_arrow_with_hook': '↩️',
  'repeat': '🔁',
  'twisted_rightwards_arrows': '🔀',
  'back': '🔙',
  'soon': '🔜',
  'top': '🔝',

  // Hearts and applause, for the parts of a conversation that are not technical.
  'orange_heart': '🧡',
  'yellow_heart': '💛',
  'green_heart': '💚',
  'blue_heart': '💙',
  'purple_heart': '💜',
  'black_heart': '🖤',
  'white_heart': '🤍',
  'broken_heart': '💔',
  'sparkling_heart': '💖',
  'trophy': '🏆',
  'medal_sports': '🏅',
  'first_place_medal': '🥇',
  'crown': '👑',
  'gem': '💎',
  'gift': '🎁',
  'balloon': '🎈',
  'confetti_ball': '🎊',
  'partying_face': '🥳',
  'birthday': '🎂',
  'beers': '🍻',
  'coffee': '☕',
  'tea': '🍵',
  'pizza': '🍕',
  'doughnut': '🍩',
  'cookie': '🍪',
  'candy': '🍬',
  'popcorn': '🍿',
  'watermelon': '🍉',
  'apple': '🍎',
  'seedling': '🌱',
  'herb': '🌿',
  'four_leaf_clover': '🍀',
  'evergreen_tree': '🌲',
  'cactus': '🌵',
  'sunny': '☀️',
  'cloud': '☁️',
  'rainbow': '🌈',
  'snowflake': '❄️',
  'ocean': '🌊',
  'earth_americas': '🌎',
  'earth_africa': '🌍',
  'earth_asia': '🌏',
  'moon': '🌔',
  'crescent_moon': '🌙',

  // Animals that turn up in project names and mascots.
  'penguin': '🐧',
  'whale': '🐳',
  'dolphin': '🐬',
  'octopus': '🐙',
  'cat': '🐱',
  'dog': '🐶',
  'fox_face': '🦊',
  'bear': '🐻',
  'panda_face': '🐼',
  'koala': '🐨',
  'monkey_face': '🐵',
  'see_no_evil': '🙈',
  'hear_no_evil': '🙉',
  'speak_no_evil': '🙊',
  'unicorn': '🦄',
  'dragon': '🐉',
  'snake': '🐍',
  'bird': '🐦',
  'owl': '🦉',
  'crab': '🦀',
  'honeybee': '🐝',
  'butterfly': '🦋',
}

/**
 * The character for a shortcode, or null when the table does not have it.
 *
 * Case-insensitive because people write `:TADA:`, and unaware of the colons:
 * the caller has already decided where the shortcode starts and ends, and
 * asking this function to re-derive that would be two parsers to keep in step.
 */
export function emojiFor(name: string): string | null {
  return EMOJI[name.toLowerCase()] ?? null
}

/**
 * The shortcodes in a run of text, with their positions.
 *
 * The same `Located` shape the reference scanners use, so the renderer can
 * splice all of them into one run with one pass and resolve the overlaps in one
 * place.
 *
 * A shortcode is `:name:` with no whitespace inside, and the character before
 * it may not be a word character or another colon: `path:heart:` inside an
 * identifier and `a::heart::b` are not somebody asking for an emoji. A time
 * like `10:30:00` needs no rule of its own - `30` is not in the table, and a
 * name that is not in the table is left as the text it was.
 */
export function scanEmoji(text: string): Array<{ value: string, index: number, length: number }> {
  const found: Array<{ value: string, index: number, length: number }> = []
  const pattern = /:([a-z0-9_+-]{1,40}):/gi

  for (const match of text.matchAll(pattern)) {
    const index = match.index!

    const before = index > 0 ? text[index - 1]! : ''
    if (/[\w:]/.test(before))
      continue

    const character = emojiFor(match[1]!)
    if (!character)
      continue

    found.push({ value: character, index, length: match[0].length })
  }

  return found
}

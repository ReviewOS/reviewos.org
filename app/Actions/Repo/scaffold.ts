/**
 * What a new repository can start with.
 *
 * An empty repository is a dead end: there is nothing to browse, nothing to
 * review, and the only page it can show is instructions for pushing. A first
 * commit turns it into something that works immediately, and the three files
 * people actually want are always the same three.
 *
 * Everything here is pure - it produces file contents, and
 * `writeInitialCommit` puts them in a repository. That split is what lets the
 * licence texts be tested for being *exact*, which for a licence is the whole
 * requirement.
 */

export interface ScaffoldOptions {
  repository: string
  description?: string | null
  readme?: boolean
  gitignore?: string | null
  license?: string | null
  /** Whose name goes in the copyright line. */
  holder?: string | null
  year?: number
}

export interface ScaffoldFile {
  path: string
  content: string
}

/**
 * The licences offered, in full.
 *
 * **Verbatim or absent.** A licence is a legal document, and one with a word
 * changed is not the licence it claims to be - so these are exact texts, and
 * the ones that are missing are missing on purpose: Apache-2.0, the GPLs and
 * MPL-2.0 run to thousands of words each, and typing one out from memory is
 * precisely the way to end up shipping a licence that is subtly not the
 * licence. They belong here as checked-in copies from an authoritative source,
 * which is a separate piece of work and is on the roadmap as one.
 *
 * `{{year}}` and `{{holder}}` are filled in. Nothing else is.
 */
export const LICENSES: Record<string, { name: string, text: string }> = {
  'mit': {
    name: 'MIT License',
    text: `MIT License

Copyright (c) {{year}} {{holder}}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`,
  },

  'isc': {
    name: 'ISC License',
    text: `ISC License

Copyright (c) {{year}} {{holder}}

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
`,
  },

  'bsd-2-clause': {
    name: 'BSD 2-Clause License',
    text: `BSD 2-Clause License

Copyright (c) {{year}}, {{holder}}

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
`,
  },

  'bsd-3-clause': {
    name: 'BSD 3-Clause License',
    text: `BSD 3-Clause License

Copyright (c) {{year}}, {{holder}}

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
`,
  },

  'unlicense': {
    name: 'The Unlicense',
    text: `This is free and unencumbered software released into the public domain.

Anyone is free to copy, modify, publish, use, compile, sell, or distribute this
software, either in source code form or as a compiled binary, for any purpose,
commercial or non-commercial, and by any means.

In jurisdictions that recognize copyright laws, the author or authors of this
software dedicate any and all copyright interest in the software to the public
domain. We make this dedication for the benefit of the public at large and to
the detriment of our heirs and successors. We intend this dedication to be an
overt act of relinquishment in perpetuity of all present and future rights to
this software under copyright law.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

For more information, please refer to <https://unlicense.org>
`,
  },
}

/**
 * Starting `.gitignore` files.
 *
 * Short on purpose. A three-hundred-line template covering every editor anybody
 * has ever used is a file nobody reads and nobody edits, so it accumulates
 * rules for tools the project does not use. These cover the output of the
 * toolchain and nothing else; an editor's own droppings belong in a personal
 * global ignore file rather than in every repository.
 */
export const GITIGNORES: Record<string, { name: string, content: string }> = {
  node: {
    name: 'Node',
    content: `node_modules/
dist/
build/
coverage/
*.log
.env
.env.local
.DS_Store
`,
  },

  bun: {
    name: 'Bun',
    content: `node_modules/
dist/
coverage/
*.log
.env
.env.local
.DS_Store
`,
  },

  python: {
    name: 'Python',
    content: `__pycache__/
*.py[cod]
.venv/
venv/
dist/
build/
*.egg-info/
.pytest_cache/
.mypy_cache/
.coverage
.env
.DS_Store
`,
  },

  go: {
    name: 'Go',
    content: `bin/
dist/
*.exe
*.test
*.out
vendor/
.env
.DS_Store
`,
  },

  rust: {
    name: 'Rust',
    content: `target/
**/*.rs.bk
*.pdb
.env
.DS_Store
`,
  },
}

/** A licence key as somebody may have typed it. Null when it is not one. */
export function licenseKey(raw: unknown): string | null {
  const key = String(raw ?? '').trim().toLowerCase()

  return key && key in LICENSES ? key : null
}

/** A gitignore template name. Null when it is not one. */
export function gitignoreKey(raw: unknown): string | null {
  const key = String(raw ?? '').trim().toLowerCase()

  return key && key in GITIGNORES ? key : null
}

/**
 * A licence, with the year and the holder filled in.
 *
 * An empty holder would leave `Copyright (c) 2026`, which names nobody and is
 * the one part of a licence that has to be right, so it falls back to the
 * repository's owner rather than to nothing.
 */
export function licenseText(key: string, holder: string, year: number): string | null {
  const license = LICENSES[key]
  if (!license)
    return null

  const named = holder.trim() || 'the repository owners'

  return license.text.replaceAll('{{year}}', String(year)).replaceAll('{{holder}}', named)
}

/**
 * The starting README.
 *
 * The name as a heading and the description under it, and nothing else. A
 * template with headings somebody has to delete is worse than a short file
 * somebody has to extend, because the deleting never happens and every
 * repository ends up with an empty "Contributing" section.
 */
export function renderReadme(repository: string, description?: string | null): string {
  const summary = String(description ?? '').trim()

  return summary ? `# ${repository}\n\n${summary}\n` : `# ${repository}\n`
}

/**
 * The files a new repository starts with, in the order they are committed.
 *
 * Returns an empty list when nothing was asked for, which is what makes "create
 * an empty repository" still the default: a repository somebody is about to
 * push an existing history into must not have a commit of its own, or their
 * first push is a rejected non-fast-forward.
 */
export function scaffoldFiles(options: ScaffoldOptions): ScaffoldFile[] {
  const files: ScaffoldFile[] = []

  if (options.readme)
    files.push({ path: 'README.md', content: renderReadme(options.repository, options.description) })

  const ignore = gitignoreKey(options.gitignore)
  if (ignore)
    files.push({ path: '.gitignore', content: GITIGNORES[ignore]!.content })

  const license = licenseKey(options.license)
  if (license) {
    const text = licenseText(license, String(options.holder ?? ''), options.year ?? new Date().getFullYear())
    if (text)
      files.push({ path: 'LICENSE', content: text })
  }

  return files
}

/** What the first commit says it did. */
export function initialCommitMessage(files: readonly ScaffoldFile[]): string {
  const names = files.map(file => file.path)

  return names.length > 0 ? `Add ${listNames(names)}` : 'Initial commit'
}

function listNames(names: readonly string[]): string {
  if (names.length === 1)
    return names[0]!

  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

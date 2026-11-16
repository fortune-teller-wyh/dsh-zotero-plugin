/**
 * Zotero tools for DeepSeek Harness.
 *
 * Reads go through Zotero's local HTTP API, which must be enabled in
 * Zotero → Settings → Advanced → Miscellaneous → "Allow other applications on
 * this computer to communicate with Zotero". Writes go through the Zotero Web
 * API and therefore need an API key with write access.
 * @module @local/zotero
 */

import { readFile } from 'node:fs/promises'
import https from 'node:https'
import { join } from 'node:path'

export const name = 'zotero'
export const inject = ['tools']

const DEFAULT_BASE_URL = 'http://127.0.0.1:23119'
const DEFAULT_API = 'users/0'
const DEFAULT_WEB_API = 'https://api.zotero.org'
const DEFAULT_TIMEOUT_MS = 15000
const SORTS = ['dateModified', 'dateAdded', 'title', 'creator', 'date', 'itemType']
const FORMATS = ['bibtex', 'biblatex', 'csljson', 'ris']

/**
 * Compile one author-facing schema node into the raw JSON Schema subset the
 * tool registry accepts. Kept local so this bundle does not import DSH
 * packages and therefore installs from any directory.
 * @param spec - author-facing node with optional `required` markers.
 * @returns the equivalent raw JSON Schema node.
 */
function toSchema(spec) {
  const schema = {}
  if (spec.description) schema.description = spec.description
  if (spec.type === 'object') {
    const properties = {}
    const required = []
    for (const [key, value] of Object.entries(spec.properties ?? {})) {
      properties[key] = toSchema(value)
      if (value.required === true) required.push(key)
    }
    schema.type = 'object'
    schema.properties = properties
    schema.additionalProperties = spec.additionalProperties === true
    if (required.length > 0) schema.required = required
    return schema
  }
  if (spec.type === 'array') {
    schema.type = 'array'
    if (spec.items) schema.items = toSchema(spec.items)
    return schema
  }
  schema.type = spec.type
  if (spec.enum) schema.enum = [...spec.enum]
  return schema
}

/**
 * Build a registry-ready tool definition from the local authoring shape.
 * @param options - name, description, per-property parameters, output, execute.
 * @returns a plain `ToolDefinition` object.
 */
function tool(options) {
  const properties = {}
  const required = []
  for (const [key, spec] of Object.entries(options.parameters ?? {})) {
    properties[key] = toSchema(spec)
    if (spec.required === true) required.push(key)
  }
  const parameters = { type: 'object', properties }
  if (required.length > 0) parameters.required = required
  return {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: toSchema(options.output.schema),
      render: options.output.render,
    },
    execute: options.execute,
  }
}

/** Zotero returns `false` where a list is empty; normalize to an array. */
function asArray(value) {
  return Array.isArray(value) ? value : []
}

/** Clamp a model-supplied integer into an inclusive range. */
function clampInt(value, fallback, min, max) {
  const number = Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.min(max, Math.max(min, number))
}

/** Join a Zotero creator list into one bounded display string. */
function joinCreators(creators) {
  const names = asArray(creators)
    .map(creator => creator?.name || [creator?.firstName, creator?.lastName].filter(Boolean).join(' '))
    .filter(Boolean)
  if (names.length === 0) return ''
  if (names.length <= 8) return names.join('; ')
  return `${names.slice(0, 8).join('; ')}; … (+${names.length - 8})`
}

/** Pick the most useful venue field for one item type. */
function publicationOf(data) {
  return data.publicationTitle || data.proceedingsTitle || data.bookTitle || data.websiteTitle
    || data.repository || data.publisher || data.institution || data.university || data.school || ''
}

/** Decode the small entity set Zotero writes into notes and abstracts. */
function decodeEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

/** Turn a Zotero HTML fragment (note or abstract) into readable plain text. */
function toPlainText(html) {
  return decodeEntities(String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/(p|div|li|h[1-6]|tr|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Escape plain text for safe use inside Zotero note HTML. */
function escapeHtml(text) {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Convert plain text into the paragraph HTML Zotero notes use. */
/** Convert a small Markdown subset (headings, lists, bold, code) into Zotero note HTML. */
function toNoteHtml(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  const out = []
  let list = ''
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`)
      list = ''
    }
  }
  const inline = value => escapeHtml(value)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2">$1</a>')
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) {
      closeList()
      continue
    }
    const heading = line.match(/^(#{1,3})\s+(.*)$/)
    if (heading) {
      closeList()
      out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`)
      continue
    }
    const bullet = line.match(/^[-*]\s+(.*)$/)
    if (bullet) {
      if (list !== 'ul') {
        closeList()
        out.push('<ul>')
        list = 'ul'
      }
      out.push(`<li>${inline(bullet[1])}</li>`)
      continue
    }
    const ordered = line.match(/^\d+\.\s+(.*)$/)
    if (ordered) {
      if (list !== 'ol') {
        closeList()
        out.push('<ol>')
        list = 'ol'
      }
      out.push(`<li>${inline(ordered[1])}</li>`)
      continue
    }
    closeList()
    out.push(`<p>${inline(line)}</p>`)
  }
  closeList()
  return out.join('')
}

/** Shorten a long text block and mark how much was cut. */
function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max)} …(+${text.length - max} chars)`
}

/** First non-empty line, used as a title substitute. */
function firstLine(text) {
  const line = String(text ?? '').split('\n').map(part => part.trim()).find(Boolean)
  return line ? truncate(line, 120) : ''
}

/** A stable display title for any item type. */
function titleOf(data, noteText) {
  return data.title || data.shortTitle || data.annotationText || firstLine(noteText) || '(untitled)'
}

/** Reduce a DOI reference to its bare form. */
function normalizeDoi(value) {
  return String(value ?? '').trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .replace(/[.,;]+$/, '')
}

/** Lowercase title into comparable word tokens, dropping TeX and punctuation. */
function titleTokens(value) {
  return new Set(String(value ?? '')
    .toLowerCase()
    .replace(/\$[^$]*\$/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter(token => token.length > 0))
}

/** Sørensen–Dice overlap of two titles, 0..1. */
function titleScore(left, right) {
  const a = titleTokens(left)
  const b = titleTokens(right)
  if (a.size === 0 || b.size === 0) return 0
  let common = 0
  for (const token of a) if (b.has(token)) common++
  return (2 * common) / (a.size + b.size)
}

/** Turn "Last, First" or "First Last" strings into Zotero creator objects. */
function creatorsFromStrings(values) {
  return asArray(values).map(raw => {
    const value = String(raw ?? '').trim()
    if (!value) return undefined
    if (value.includes(',')) {
      const [lastName, ...rest] = value.split(',')
      const firstName = rest.join(',').trim()
      return { creatorType: 'author', lastName: lastName.trim(), firstName }
    }
    const parts = value.split(/\s+/)
    if (parts.length === 1) return { creatorType: 'author', name: value }
    const lastName = parts.pop()
    return { creatorType: 'author', firstName: parts.join(' '), lastName }
  }).filter(Boolean)
}

/** Date-parts from Crossref become the ISO-ish string Zotero stores. */
function crossrefDate(message) {
  const parts = message?.issued?.['date-parts']?.[0] ?? message?.published?.['date-parts']?.[0] ?? []
  if (parts.length === 0) return ''
  const [year, month, day] = parts
  const pad = value => String(value).padStart(2, '0')
  if (month === undefined) return String(year)
  if (day === undefined) return `${year}-${pad(month)}`
  return `${year}-${pad(month)}-${pad(day)}`
}

/** Map a Crossref work onto a Zotero item template. */
function fromCrossref(message) {
  const type = message?.type ?? ''
  const itemType = type === 'posted-content' ? 'preprint'
    : type === 'proceedings-article' ? 'conferencePaper'
      : type === 'book-chapter' ? 'bookSection'
        : type === 'dissertation' ? 'thesis'
          : type === 'book' ? 'book'
            : 'journalArticle'
  const venue = message?.['container-title']?.[0] ?? ''
  const template = {
    itemType,
    title: message?.title?.[0] ?? '',
    creators: asArray(message?.author).map(author => author?.family
      ? { creatorType: 'author', lastName: author.family, firstName: author.given ?? '' }
      : { creatorType: 'author', name: author?.name ?? '' }).filter(creator => creator.lastName || creator.name),
    date: crossrefDate(message),
    DOI: message?.DOI ?? '',
    url: message?.URL ?? '',
    abstractNote: toPlainText(message?.abstract ?? ''),
    language: message?.language ?? '',
    tags: asArray(message?.subject).map(subject => ({ tag: String(subject) })),
    libraryCatalog: 'Crossref',
    extra: `Crossref type: ${type || 'unknown'}`,
  }
  if (itemType === 'journalArticle' || itemType === 'bookSection') {
    template.publicationTitle = venue
    template.volume = message?.volume ?? ''
    template.issue = message?.issue ?? ''
    template.pages = message?.page ?? ''
    template.ISSN = message?.ISSN?.[0] ?? ''
    template.journalAbbreviation = message?.['short-container-title']?.[0] ?? ''
  } else if (itemType === 'conferencePaper') {
    template.proceedingsTitle = venue
    template.conferenceName = message?.event?.name ?? ''
    template.pages = message?.page ?? ''
  } else if (itemType === 'preprint') {
    template.repository = message?.publisher || venue
    template.genre = message?.subtype ?? ''
  } else if (itemType === 'book' || itemType === 'bookSection') {
    template.publisher = message?.publisher ?? ''
    template.place = message?.['publisher-location'] ?? ''
  }
  return template
}

/** Map a DataCite DOI record onto a Zotero item template. */
function fromDatacite(data) {
  const attributes = data?.attributes ?? {}
  const resourceType = attributes.types?.resourceTypeGeneral ?? ''
  const itemType = resourceType === 'JournalArticle' ? 'journalArticle'
    : resourceType === 'ConferencePaper' ? 'conferencePaper'
      : resourceType === 'Book' ? 'book'
        : 'preprint'
  const titles = asArray(attributes.titles)
  const abstract = asArray(attributes.descriptions).find(entry => /^abstract$/i.test(entry?.descriptionType ?? ''))
  const template = {
    itemType,
    title: titles[0]?.title ?? '',
    creators: asArray(attributes.creators).map(creator => creator?.familyName
      ? { creatorType: 'author', lastName: creator.familyName, firstName: creator.givenName ?? '' }
      : { creatorType: 'author', name: creator?.name ?? '' }).filter(creator => creator.lastName || creator.name),
    date: attributes.publicationYear ? String(attributes.publicationYear) : (asArray(attributes.dates)[0]?.date ?? ''),
    DOI: attributes.doi ?? '',
    url: attributes.url ?? '',
    abstractNote: toPlainText(abstract?.description ?? ''),
    language: attributes.language ?? '',
    tags: asArray(attributes.subjects).map(subject => ({ tag: String(subject?.subject ?? subject) })).filter(entry => entry.tag),
    libraryCatalog: 'DataCite',
    extra: `DataCite resource type: ${resourceType || 'unknown'}`,
  }
  if (itemType === 'preprint') {
    template.repository = attributes.publisher || ''
    template.archiveID = `DOI:${attributes.doi ?? ''}`
  } else {
    template.publicationTitle = attributes.publisher || ''
  }
  return template
}

/**
 * Register the Zotero tools.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - optional endpoints, user id, API key, and request timeout.
 */
export function apply(ctx, config = {}) {
  const baseUrl = String(config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  const api = String(config.api ?? DEFAULT_API).replace(/^\/+|\/+$/g, '')
  const webApiBase = String(config.webApiBase ?? DEFAULT_WEB_API).replace(/\/+$/, '')
  const timeoutMs = clampInt(config.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 60000)
  const keyFile = String(config.apiKeyFile ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh', 'zotero-api-key.txt'))

  /** Cache of collection key → name, refreshed at most once a minute. */
  let collectionCache = { at: 0, names: new Map() }
  /** Resolved Web API user id, discovered once from the local API. */
  let cachedUserId = Number.isFinite(config.userId) ? config.userId : 0

  /** Explain a transport-level failure in terms the user can act on. */
  function connectionError(error) {
    if (error?.name === 'TimeoutError') {
      return new Error(`Zotero 本地 API 在 ${timeoutMs} 毫秒内未响应。请确认 Zotero 没有卡在弹窗上，然后重试。`)
    }
    return new Error(`无法连接 Zotero 本地 API（${baseUrl}）。请确认 Zotero 正在运行，并在「设置 → 高级 → 杂项」中勾选「允许此计算机上的其他应用程序与 Zotero 通信」，然后重试。`)
  }

  /** Explain an HTTP failure, including the "Local API is not enabled" case. */
  function httpError(status, body) {
    if (status === 403 && /Local API is not enabled/i.test(body)) {
      return new Error('Zotero 本地 API 未开启。请在 Zotero「设置 → 高级 → 杂项」中勾选「允许此计算机上的其他应用程序与 Zotero 通信」，然后重试。')
    }
    if (status === 404) return new Error('Zotero 返回 404：条目或合集 key 不存在（可能已被删除）。')
    const detail = truncate(String(body ?? '').replace(/\s+/g, ' ').trim(), 300)
    return new Error(`Zotero 本地 API 返回 HTTP ${status}${detail ? `：${detail}` : ''}`)
  }

  /** One timeout+cancellation signal for a request. */
  function requestSignal(signal) {
    const timeout = AbortSignal.timeout(timeoutMs)
    return signal ? AbortSignal.any([signal, timeout]) : timeout
  }

  /**
   * One HTTPS request with an explicit TLS key-exchange group.
   *
   * api.zotero.org stalls a TLS 1.3 handshake that offers Node's default
   * post-quantum X25519MLKEM768 group, so the connection dies with
   * ECONNRESET/CONNECT_TIMEOUT while curl succeeds. Pinning X25519 keeps
   * TLS 1.3 working on this network; the same helper serves Crossref and
   * DataCite so every outbound call shares one behavior.
   * @param url - absolute HTTPS URL.
   * @param options - method, headers, raw body, and caller cancellation.
   * @returns status, response headers, and decoded text.
   */
  function httpsRequest(url, { method = 'GET', headers = {}, body, signal } = {}) {
    return new Promise((resolve, reject) => {
      const target = new URL(url)
      const started = Date.now()
      const request = https.request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || 443,
        path: `${target.pathname}${target.search}`,
        method,
        headers,
        servername: target.hostname,
        ecdhCurve: 'X25519',
        timeout: timeoutMs,
      }, response => {
        const chunks = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('end', () => resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          text: Buffer.concat(chunks).toString('utf8'),
        }))
      })
      const fail = error => {
        const code = error?.code ?? error?.message ?? 'unknown'
        if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || /timeout/i.test(String(code))) {
          reject(new Error(`连接 ${target.hostname} 超时或被重置（${code}，${Date.now() - started}ms）。网络可能不稳定，请稍后重试。`))
          return
        }
        reject(new Error(`无法连接 ${target.hostname}：${code}`))
      }
      request.on('timeout', () => request.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })))
      request.on('error', fail)
      if (signal) {
        if (signal.aborted) {
          request.destroy(Object.assign(new Error('aborted'), { code: 'ABORTED' }))
          return
        }
        signal.addEventListener('abort', () => request.destroy(Object.assign(new Error('aborted'), { code: 'ABORTED' })), { once: true })
      }
      if (body !== undefined) request.write(body)
      request.end()
    })
  }

  /** Perform one GET against the local read-only API. */
  async function request(path, { params, signal, raw = false } = {}) {
    const target = new URL(`${baseUrl}/api/${api}${path}`)
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value === undefined || value === null || value === '') continue
      target.searchParams.set(key, String(value))
    }
    let response
    try {
      response = await fetch(target, {
        headers: { 'Zotero-API-Version': '3', Accept: raw ? '*/*' : 'application/json' },
        signal: requestSignal(signal),
      })
    } catch (error) {
      throw connectionError(error)
    }
    const body = await response.text()
    if (!response.ok) throw httpError(response.status, body)
    return { body, total: Number(response.headers.get('total-results') ?? Number.NaN) }
  }

  /** Request local JSON without throwing on malformed payloads. */
  async function requestJson(path, options) {
    const { body, total } = await request(path, options)
    try {
      return { value: JSON.parse(body), total }
    } catch {
      throw new Error('Zotero 本地 API 返回了无法解析的 JSON。请确认 Zotero 版本支持本地 API（Zotero 7 及以上）。')
    }
  }

  /** Resolve collection keys to names, tolerating a failed lookup. */
  async function collectionNames(signal) {
    if (collectionCache.names.size > 0 && Date.now() - collectionCache.at < 60000) return collectionCache.names
    try {
      const { value } = await requestJson('/collections', { params: { limit: 100 }, signal })
      const names = new Map(asArray(value).map(entry => [entry.key, entry.data?.name ?? entry.key]))
      collectionCache = { at: Date.now(), names }
      return names
    } catch {
      return new Map()
    }
  }

  /** Read the Web API key from config, the key file, or the environment. */
  async function apiKey() {
    if (typeof config.apiKey === 'string' && config.apiKey.trim()) return config.apiKey.trim()
    if (process.env.ZOTERO_API_KEY) return process.env.ZOTERO_API_KEY.trim()
    try {
      const text = await readFile(keyFile, 'utf8')
      const value = text.trim().split(/\s+/)[0]
      if (value) return value
    } catch {
      // fall through to the actionable error below
    }
    throw new Error([
      '还没有配置 Zotero API key，写操作无法执行。',
      '1) 打开 https://www.zotero.org/settings/keys ，点 Create new private key；',
      '2) 勾选 Allow library access 和 Allow write access，保存并复制 key；',
      `3) 把 key 单独一行写进 ${keyFile}（或设置环境变量 ZOTERO_API_KEY）。`,
      '读操作不需要 key，现在就能用。',
    ].join(' '))
  }

  /** Discover the Web API user id from the local library, else from the key itself. */
  async function userId(signal) {
    if (cachedUserId > 0) return cachedUserId
    try {
      const { value } = await requestJson('/items', { params: { limit: 1 }, signal })
      const id = asArray(value)[0]?.library?.id
      if (Number.isFinite(id)) {
        cachedUserId = id
        return id
      }
    } catch {
      // Zotero may be closed; the key knows its own user id.
    }
    const key = await apiKey()
    const response = await httpsRequest(`${webApiBase}/keys/current`, {
      headers: { 'Zotero-API-Version': '3', 'Zotero-API-Key': key, Accept: 'application/json' },
      signal,
    })
    if (response.status === 200) {
      try {
        const payload = JSON.parse(response.text)
        if (Number.isFinite(payload?.userID)) {
          cachedUserId = payload.userID
          return cachedUserId
        }
      } catch {
        // fall through
      }
    }
    throw new Error('无法确定 Zotero 用户 ID：本地文库不可用，且 /keys/current 没有返回 userID。请在插件配置里设置 userId。')
  }

  /** Explain Web API failures (auth, version conflicts, rate limits). */
  function webError(status, body, key) {
    if (status === 403) {
      return new Error(`Zotero Web API 拒绝了请求（403）。请确认 API key 有效、勾选了「Allow write access」，且用户 ID 与 key 属于同一账号。${body ? ` 详情：${truncate(body, 200)}` : ''}`)
    }
    if (status === 401) return new Error('Zotero Web API 返回 401：API key 无效或已被删除。')
    if (status === 404) return new Error('Zotero Web API 返回 404：条目不存在，或这个条目还没有同步到 zotero.org。')
    if (status === 412) return new Error('Zotero 条目已被其他地方修改（版本冲突 412）。重新读取后再试。')
    if (status === 428) return new Error('Zotero 要求带上条目版本号才能执行这次写入（HTTP 428）。重新读取条目后再试。')
    if (status === 429) return new Error('Zotero Web API 触发了限流（429），请稍后再试。')
    const detail = truncate(String(body ?? '').replace(/\s+/g, ' ').trim(), 400)
    return new Error(`Zotero Web API 返回 HTTP ${status}${detail ? `：${detail}` : ''}`)
  }

  /** Perform one authenticated Web API call, retrying once on 429. */
  async function webRequest(method, path, { body, signal, version, retry = 0 } = {}) {
    const id = await userId(signal)
    const key = await apiKey()
    const headers = { 'Zotero-API-Version': '3', 'Zotero-API-Key': key, Accept: 'application/json' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (version !== undefined) headers['If-Unmodified-Since-Version'] = String(version)
    const response = await httpsRequest(`${webApiBase}/users/${id}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
    if (response.status === 429 && retry === 0) {
      const wait = Math.min(5000, Number(response.headers['retry-after'] ?? 2) * 1000)
      await new Promise(resolve => setTimeout(resolve, wait))
      return webRequest(method, path, { body, signal, version, retry: 1 })
    }
    if (response.status < 200 || response.status >= 300) throw webError(response.status, response.text)
    return { status: response.status, text: response.text }
  }

  /** Create one item through the Web API and return its stored data. */
  async function createItem(template, signal) {
    const { text } = await webRequest('POST', '/items', { body: [template], signal })
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      throw new Error('Zotero Web API 返回了无法解析的创建结果。')
    }
    const failed = Object.entries(payload.failed ?? {})
    if (failed.length > 0) {
      const reason = failed.map(([, info]) => info?.message ?? info?.code ?? 'unknown').join('; ')
      throw new Error(`Zotero 拒绝了这条条目：${reason}`)
    }
    const created = Object.values(payload.successful ?? {})[0]
    if (!created?.key) throw new Error('Zotero 没有返回新建条目的 key。')
    return created.data ?? { key: created.key }
  }

  /** Confirm an item exists remotely and return its current data. */
  async function fetchWebItem(key, signal) {
    const { text } = await webRequest('GET', `/items/${encodeURIComponent(key)}`, { signal })
    try {
      return JSON.parse(text)
    } catch {
      throw new Error('Zotero Web API 返回了无法解析的条目数据。')
    }
  }

  /** Look for an existing item with the same DOI in the Web API library. */
  async function findByDoiRemote(doi, signal) {
    const { text } = await webRequest('GET', `/items?q=${encodeURIComponent(doi)}&qmode=everything&limit=25`, { signal })
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      return ''
    }
    const wanted = doi.toLowerCase()
    for (const entry of asArray(payload)) {
      if (String(entry.data?.DOI ?? '').toLowerCase() === wanted) return entry.key
    }
    return ''
  }

  /** Look for an existing item with the same DOI, local library first. */
  async function findByDoi(doi, signal) {
    const wanted = doi.toLowerCase()
    try {
      const { value } = await requestJson('/items/top', { params: { q: doi, qmode: 'everything', limit: 25 }, signal })
      for (const entry of asArray(value)) {
        if (String(entry.data?.DOI ?? '').toLowerCase() === wanted) return entry.key
      }
      return ''
    } catch {
      // The local API needs Zotero running; fall back to the Web API so writes still de-duplicate.
      try {
        return await findByDoiRemote(doi, signal)
      } catch {
        return ''
      }
    }
  }

  /** Fetch DOI metadata from Crossref, falling back to DataCite. */
  async function doiMetadata(doi, signal) {
    const encoded = encodeURIComponent(doi)
    try {
      const response = await httpsRequest(`https://api.crossref.org/works/${encoded}`, {
        headers: { Accept: 'application/json', 'User-Agent': 'dsh-zotero-plugin/0.2 (https://github.com)' },
        signal,
      })
      if (response.status === 200) {
        const payload = JSON.parse(response.text)
        if (payload?.message) return { source: 'Crossref', template: fromCrossref(payload.message) }
      }
    } catch {
      // fall through to DataCite
    }
    try {
      const response = await httpsRequest(`https://api.datacite.org/dois/${encoded}`, {
        headers: { Accept: 'application/vnd.api+json' },
        signal,
      })
      if (response.status === 200) {
        const payload = JSON.parse(response.text)
        if (payload?.data) return { source: 'DataCite', template: fromDatacite(payload.data) }
      }
    } catch {
      // fall through to the error below
    }
    throw new Error(`查不到 DOI ${doi} 的元数据：Crossref 和 DataCite 都没有返回记录。确认 DOI 是否正确。`)
  }

  /** Create (or find) one item from a DOI, honoring collection, tags and duplicate policy. */
  async function importByDoi(doi, { collection, tags, ifExists = 'skip', signal } = {}) {
    if (ifExists === 'skip') {
      const existing = await findByDoi(doi, signal)
      if (existing) {
        let data = {}
        try {
          const { value: raw } = await requestJson(`/items/${encodeURIComponent(existing)}`, { signal })
          data = raw.data ?? {}
        } catch {
          try {
            data = (await fetchWebItem(existing, signal)).data ?? {}
          } catch {
            data = {}
          }
        }
        return {
          status: 'exists',
          key: existing,
          title: titleOf(data, ''),
          itemType: data.itemType ?? 'unknown',
          source: 'local',
        }
      }
    }
    const { source, template } = await doiMetadata(doi, signal)
    if (collection) template.collections = [collection]
    const extraTags = asArray(tags).map(tag => ({ tag: String(tag) })).filter(entry => entry.tag)
    if (extraTags.length > 0) {
      const known = new Set(asArray(template.tags).map(entry => entry.tag))
      template.tags = asArray(template.tags).concat(extraTags.filter(entry => !known.has(entry.tag)))
    }
    const created = await createItem(template, signal)
    return {
      status: 'created',
      key: created.key,
      title: created.title ?? template.title ?? '',
      itemType: created.itemType ?? template.itemType,
      source,
    }
  }

  /** Ask Crossref for candidate works matching a free-text title. */
  async function crossrefCandidates(title, signal) {
    const target = new URL('https://api.crossref.org/works')
    target.searchParams.set('query.bibliographic', title)
    target.searchParams.set('rows', '5')
    target.searchParams.set('select', 'DOI,title,author,issued,container-title,type')
    const response = await httpsRequest(target.toString(), {
      headers: { Accept: 'application/json', 'User-Agent': 'dsh-zotero-plugin/0.3 (https://github.com)' },
      signal,
    })
    if (response.status !== 200) return []
    let payload
    try {
      payload = JSON.parse(response.text)
    } catch {
      return []
    }
    return asArray(payload?.message?.items).map(item => {
      const parts = item?.issued?.['date-parts']?.[0] ?? []
      return {
        doi: item?.DOI ?? '',
        title: item?.title?.[0] ?? '',
        year: Number.isFinite(parts[0]) ? parts[0] : 0,
        venue: item?.['container-title']?.[0] ?? '',
        authors: asArray(item?.author).map(author => author?.family).filter(Boolean),
      }
    }).filter(entry => entry.doi && entry.title)
  }

  /** Project one raw local item onto the compact search record. */
  function summarize(item, names) {
    const data = item.data ?? {}
    return {
      key: item.key,
      itemType: data.itemType ?? 'unknown',
      title: titleOf(data, ''),
      creators: joinCreators(data.creators),
      date: data.date ?? '',
      publication: publicationOf(data),
      doi: data.DOI ?? '',
      url: data.url ?? '',
      tags: asArray(data.tags).map(tag => tag.tag).filter(Boolean),
      collections: asArray(data.collections).map(key => names.get(key) ?? key),
      children: Number.isFinite(item.meta?.numChildren) ? item.meta.numChildren : 0,
    }
  }

  const search = tool({
    name: 'zotero_search',
    description: 'Search the user\'s local Zotero library through Zotero\'s local API (read-only). Returns compact records: item key, type, title, creators, date, venue, DOI, tags and collection names. Use zotero_item for full metadata, notes and attachments; use zotero_bibtex for citation entries.',
    parameters: {
      q: { type: 'string', description: 'Free-text query. Matched against title, creators and year by default.' },
      mode: {
        type: 'string',
        enum: ['titleCreatorYear', 'everything'],
        description: 'Query scope for q. everything also matches abstracts, notes, tags and full text. Default titleCreatorYear.',
      },
      itemType: { type: 'string', description: 'Zotero item type filter, for example journalArticle, preprint, conferencePaper, book, thesis.' },
      tag: { type: 'string', description: 'Exact tag to filter by.' },
      collection: { type: 'string', description: 'Collection key from zotero_collections.' },
      sort: { type: 'string', enum: SORTS, description: 'Sort field. Default dateModified.' },
      direction: { type: 'string', enum: ['asc', 'desc'], description: 'Sort direction. Default desc.' },
      limit: { type: 'integer', description: 'How many records to return, 1-50. Default 10.' },
      start: { type: 'integer', description: 'Offset for paging. Default 0.' },
      includeChildren: { type: 'boolean', description: 'Include child items (notes, attachments, annotations) in results. Default false.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          returned: { type: 'integer', required: true },
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                key: { type: 'string', required: true },
                itemType: { type: 'string', required: true },
                title: { type: 'string', required: true },
                creators: { type: 'string', required: true },
                date: { type: 'string', required: true },
                publication: { type: 'string', required: true },
                doi: { type: 'string', required: true },
                url: { type: 'string', required: true },
                tags: { type: 'array', required: true, items: { type: 'string' } },
                collections: { type: 'array', required: true, items: { type: 'string' } },
                children: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render(_args, value) {
        if (value.items.length === 0) return [{ type: 'text', text: 'No Zotero items matched this query.' }]
        const lines = [`Zotero: ${value.total} matching item${value.total === 1 ? '' : 's'}, showing ${value.returned} (offset included).`]
        value.items.forEach((entry, index) => {
          lines.push(`${index + 1}. ${entry.key} · ${entry.itemType} · ${entry.date || 'n.d.'} · ${entry.children} child item${entry.children === 1 ? '' : 's'}`)
          lines.push(`   ${entry.title}`)
          if (entry.creators) lines.push(`   ${entry.creators}`)
          const venue = [entry.publication, entry.doi ? `doi:${entry.doi}` : ''].filter(Boolean).join(' · ')
          if (venue) lines.push(`   ${venue}`)
          if (entry.tags.length > 0) lines.push(`   tags: ${entry.tags.join(', ')}`)
          if (entry.collections.length > 0) lines.push(`   collections: ${entry.collections.join(', ')}`)
        })
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const limit = clampInt(args.limit, 10, 1, 50)
      const start = clampInt(args.start, 0, 0, 100000)
      const includeChildren = args.includeChildren === true
      // A collection narrows the endpoint itself; the local API ignores a `collection` filter on /items.
      const collectionKey = typeof args.collection === 'string' ? args.collection.trim() : ''
      const path = collectionKey
        ? `/collections/${encodeURIComponent(collectionKey)}/items${includeChildren ? '' : '/top'}`
        : (includeChildren ? '/items' : '/items/top')
      const { value, total } = await requestJson(path, {
        params: {
          q: args.q,
          qmode: args.q ? (args.mode ?? 'titleCreatorYear') : undefined,
          itemType: args.itemType,
          tag: args.tag,
          sort: args.sort ?? 'dateModified',
          direction: args.direction ?? 'desc',
          limit,
          start,
          format: 'json',
        },
        signal: exec.signal,
      })
      const names = await collectionNames(exec.signal)
      const items = asArray(value).map(entry => summarize(entry, names))
      return {
        total: Number.isFinite(total) ? total : start + items.length,
        returned: items.length,
        items,
      }
    },
  })

  const item = tool({
    name: 'zotero_item',
    description: 'Read one Zotero item by key: full metadata, abstract, tags, collections, and its child notes, attachments and annotations. Also accepts a note, attachment or annotation key, for example an attachment key to read the annotations made on that PDF.',
    parameters: {
      key: { type: 'string', required: true, description: 'Zotero item key (8 characters), for example from zotero_search.' },
      includeChildren: { type: 'boolean', description: 'Include child notes, attachments and annotations. Default true.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          key: { type: 'string', required: true },
          itemType: { type: 'string', required: true },
          title: { type: 'string', required: true },
          creators: { type: 'string', required: true },
          date: { type: 'string', required: true },
          publication: { type: 'string', required: true },
          doi: { type: 'string', required: true },
          url: { type: 'string', required: true },
          abstract: { type: 'string', required: true },
          tags: { type: 'array', required: true, items: { type: 'string' } },
          collections: { type: 'array', required: true, items: { type: 'string' } },
          notes: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { key: { type: 'string', required: true }, text: { type: 'string', required: true } },
            },
          },
          attachments: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                key: { type: 'string', required: true },
                title: { type: 'string', required: true },
                contentType: { type: 'string', required: true },
                filename: { type: 'string', required: true },
              },
            },
          },
          annotations: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                key: { type: 'string', required: true },
                type: { type: 'string', required: true },
                text: { type: 'string', required: true },
                comment: { type: 'string', required: true },
                page: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render(_args, value) {
        const lines = [`${value.key} · ${value.itemType}`]
        lines.push(value.title)
        if (value.creators) lines.push(`Creators: ${value.creators}`)
        const meta = [value.date, value.publication].filter(Boolean).join(' · ')
        if (meta) lines.push(`Published: ${meta}`)
        if (value.doi) lines.push(`DOI: ${value.doi}`)
        if (value.url) lines.push(`URL: ${value.url}`)
        if (value.tags.length > 0) lines.push(`Tags: ${value.tags.join(', ')}`)
        if (value.collections.length > 0) lines.push(`Collections: ${value.collections.join(', ')}`)
        if (value.abstract) lines.push(`Abstract: ${truncate(value.abstract, 1500)}`)
        if (value.notes.length > 0) {
          lines.push(`Notes (${value.notes.length}):`)
          for (const note of value.notes) lines.push(`  [${note.key}] ${truncate(note.text, 1200)}`)
        }
        if (value.attachments.length > 0) {
          lines.push(`Attachments (${value.attachments.length}):`)
          for (const attachment of value.attachments) {
            lines.push(`  [${attachment.key}] ${attachment.title}${attachment.contentType ? ` (${attachment.contentType})` : ''}${attachment.filename ? ` — ${attachment.filename}` : ''}`)
          }
        }
        if (value.annotations.length > 0) {
          lines.push(`Annotations (${value.annotations.length}):`)
          for (const annotation of value.annotations) {
            const page = annotation.page ? ` p.${annotation.page}` : ''
            const comment = annotation.comment ? ` — ${annotation.comment}` : ''
            lines.push(`  ${truncate(annotation.text, 300)}${page}${comment}`)
          }
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const key = String(args.key ?? '').trim()
      if (!/^[A-Za-z0-9]{4,16}$/.test(key)) throw new Error('item key 格式不正确，应为 8 位字母数字，例如 PE969DZ9。')
      const { value: raw } = await requestJson(`/items/${encodeURIComponent(key)}`, { signal: exec.signal })
      const data = raw.data ?? {}
      const includeChildren = args.includeChildren !== false
      const children = includeChildren
        ? (await requestJson(`/items/${encodeURIComponent(key)}/children`, { params: { limit: 100 }, signal: exec.signal })).value
        : []
      const noteText = toPlainText(data.note)
      const notes = []
      const attachments = []
      const annotations = []
      for (const child of asArray(children)) {
        const childData = child.data ?? {}
        if (childData.itemType === 'note') {
          notes.push({ key: child.key, text: toPlainText(childData.note) })
        } else if (childData.itemType === 'attachment') {
          attachments.push({
            key: child.key,
            title: childData.title ?? '(attachment)',
            contentType: childData.contentType ?? '',
            filename: childData.filename ?? '',
          })
        } else if (childData.itemType === 'annotation') {
          annotations.push({
            key: child.key,
            type: childData.annotationType ?? '',
            text: childData.annotationText ?? childData.annotationComment ?? '',
            comment: childData.annotationComment ?? '',
            page: childData.annotationPageLabel ?? '',
          })
        }
      }
      const collectionKeys = asArray(data.collections)
      const names = collectionKeys.length > 0 ? await collectionNames(exec.signal) : new Map()
      return {
        key: raw.key ?? key,
        itemType: data.itemType ?? 'unknown',
        title: titleOf(data, noteText),
        creators: joinCreators(data.creators),
        date: data.date ?? '',
        publication: publicationOf(data),
        doi: data.DOI ?? '',
        url: data.url ?? '',
        abstract: toPlainText(data.abstractNote),
        tags: asArray(data.tags).map(tag => tag.tag).filter(Boolean),
        collections: collectionKeys.map(collectionKey => names.get(collectionKey) ?? collectionKey),
        notes,
        attachments,
        annotations,
      }
    },
  })

  const collections = tool({
    name: 'zotero_collections',
    description: 'List the Zotero collections (folders) with their keys, names and parent collections. Use a collection key with zotero_search to search inside it, or with the write tools to file a new item.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          collections: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                key: { type: 'string', required: true },
                name: { type: 'string', required: true },
                parent: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render(_args, value) {
        if (value.collections.length === 0) return [{ type: 'text', text: 'The library has no collections.' }]
        const lines = [`Zotero collections (${value.collections.length}):`]
        for (const collection of value.collections) {
          lines.push(`${collection.key} · ${collection.name}${collection.parent ? ` (child of ${collection.parent})` : ''}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(_args, exec) {
      const { value } = await requestJson('/collections', { params: { limit: 100 }, signal: exec.signal })
      const entries = asArray(value).map(entry => ({
        key: entry.key,
        name: entry.data?.name ?? entry.key,
        parent: entry.data?.parentCollection || '',
      }))
      collectionCache = { at: Date.now(), names: new Map(entries.map(entry => [entry.key, entry.name])) }
      return { collections: entries }
    },
  })

  const bibtex = tool({
    name: 'zotero_bibtex',
    description: 'Export citation entries for Zotero items by key, using Zotero\'s own exporters. Returns the raw export text ready to paste into a .bib file or a manuscript.',
    parameters: {
      keys: { type: 'array', required: true, items: { type: 'string' }, description: 'Item keys to export, 1-20 of them, for example from zotero_search.' },
      format: { type: 'string', enum: FORMATS, description: 'Export format. Default bibtex.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          format: { type: 'string', required: true },
          count: { type: 'integer', required: true },
          text: { type: 'string', required: true },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: value.text.trim() || '(Zotero returned an empty export)' }]
      },
    },
    async execute(args, exec) {
      const keys = asArray(args.keys).map(key => String(key).trim()).filter(Boolean)
      if (keys.length === 0) throw new Error('请至少提供一个条目 key。')
      if (keys.length > 20) throw new Error('一次最多导出 20 个条目。')
      const format = args.format ?? 'bibtex'
      const { body } = await request('/items', {
        params: { itemKey: keys.join(','), format, limit: 100 },
        signal: exec.signal,
        raw: true,
      })
      return { format, count: keys.length, text: body }
    },
  })

  const addByDoi = tool({
    name: 'zotero_add_by_doi',
    description: 'Add a paper to the Zotero library from its DOI. Looks the DOI up in Crossref (falling back to DataCite for arXiv and dataset DOIs), builds a complete Zotero item, and skips it when the library already holds that DOI. Requires the configured Zotero Web API key with write access.',
    parameters: {
      doi: { type: 'string', required: true, description: 'DOI, with or without the https://doi.org/ prefix, for example 10.48550/arXiv.2410.24164.' },
      collection: { type: 'string', description: 'Collection key to file the new item into, from zotero_collections.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Extra tags to add to the new item.' },
      ifExists: {
        type: 'string',
        enum: ['skip', 'add'],
        description: 'skip returns the existing item instead of adding a duplicate (default); add creates another item anyway.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          key: { type: 'string', required: true },
          title: { type: 'string', required: true },
          itemType: { type: 'string', required: true },
          source: { type: 'string', required: true },
        },
      },
      render(_args, value) {
        if (value.status === 'exists') {
          return [{ type: 'text', text: `Already in the library: ${value.key} · ${value.itemType}\n${value.title}\n(No duplicate created; pass ifExists: add to force one.)` }]
        }
        return [{ type: 'text', text: `Added ${value.key} · ${value.itemType} · metadata from ${value.source}\n${value.title}\nOpen Zotero and let it sync to see the item in the library.` }]
      },
    },
    async execute(args, exec) {
      const doi = normalizeDoi(args.doi)
      if (!/^10\.\d{4,9}\/\S+$/.test(doi)) throw new Error(`DOI 格式不正确：${args.doi}`)
      return importByDoi(doi, {
        collection: args.collection,
        tags: args.tags,
        ifExists: args.ifExists ?? 'skip',
        signal: exec.signal,
      })
    },
  })

  const addByTitle = tool({
    name: 'zotero_add_by_title',
    description: 'Find a paper by its title on Crossref and add it to the Zotero library, optionally filing it into a collection. Use dryRun to list the best matches first and write nothing. Intended for pages that show a title but no DOI, such as Google Scholar results, publisher landing pages or PDFs.',
    parameters: {
      title: { type: 'string', required: true, description: 'Paper title as shown on the page.' },
      authors: { type: 'array', items: { type: 'string' }, description: 'Author surnames to disambiguate, for example ["Black", "Levine"].' },
      year: { type: 'integer', description: 'Publication year, used to disambiguate near-identical titles.' },
      collection: { type: 'string', description: 'Collection key from zotero_collections.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Extra tags to add to the new item.' },
      ifExists: { type: 'string', enum: ['skip', 'add'], description: 'skip returns the existing item instead of adding a duplicate (default); add creates another item anyway.' },
      dryRun: { type: 'boolean', description: 'List candidates without creating anything. Default false.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          key: { type: 'string', required: true },
          title: { type: 'string', required: true },
          itemType: { type: 'string', required: true },
          source: { type: 'string', required: true },
          candidates: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                doi: { type: 'string', required: true },
                title: { type: 'string', required: true },
                year: { type: 'integer', required: true },
                venue: { type: 'string', required: true },
                score: { type: 'number', required: true },
              },
            },
          },
        },
      },
      render(args, value) {
        if (value.status === 'candidates') {
          const lines = [`Crossref candidates for: ${String(args?.title ?? '')}`]
          value.candidates.forEach((entry, index) => {
            lines.push(`${index + 1}. ${entry.score} · ${entry.doi} · ${entry.year || 'n.d.'} · ${entry.venue || 'unknown venue'}`)
            lines.push(`   ${entry.title}`)
          })
          lines.push('Nothing was written. Call again without dryRun to import the first match, or pass a fuller title / author / year to pin it down.')
          return [{ type: 'text', text: lines.join('\n') }]
        }
        if (value.status === 'exists') {
          return [{ type: 'text', text: `Already in the library: ${value.key} · ${value.itemType}\n${value.title}\n(No duplicate created; pass ifExists: add to force one.)` }]
        }
        return [{ type: 'text', text: `Added ${value.key} · ${value.itemType} · metadata from ${value.source}\n${value.title}\nOpen Zotero and let it sync to see the item in the library.` }]
      },
    },
    async execute(args, exec) {
      const title = String(args.title ?? '').trim()
      if (title.length < 4) throw new Error('title 太短，请给出完整论文标题。')
      const candidates = await crossrefCandidates(title, exec.signal)
      if (candidates.length === 0) {
        throw new Error(`Crossref 里找不到「${title}」的匹配。若页面上有 DOI，改用 zotero_add_by_doi。`)
      }
      const wantYear = Number.isFinite(args.year) ? Number(args.year) : 0
      const wantAuthors = asArray(args.authors).map(name => String(name).toLowerCase()).filter(Boolean)
      const scored = candidates.map(entry => {
        let score = titleScore(title, entry.title)
        if (wantYear > 0 && entry.year > 0 && Math.abs(entry.year - wantYear) > 1) score *= 0.5
        if (wantAuthors.length > 0) {
          const families = entry.authors.map(name => name.toLowerCase())
          if (!wantAuthors.some(name => families.includes(name))) score *= 0.6
        }
        return { ...entry, score: Math.round(score * 100) / 100 }
      }).sort((left, right) => right.score - left.score)
      const top = scored.slice(0, 3).map(entry => ({
        doi: entry.doi,
        title: entry.title,
        year: entry.year,
        venue: entry.venue,
        score: entry.score,
      }))
      const best = scored[0]
      if (args.dryRun === true || best.score < 0.55) {
        return { status: 'candidates', key: '', title: '', itemType: '', source: 'Crossref', candidates: top }
      }
      const imported = await importByDoi(best.doi, {
        collection: args.collection,
        tags: args.tags,
        ifExists: args.ifExists ?? 'skip',
        signal: exec.signal,
      })
      return { ...imported, candidates: [] }
    },
  })

  const addItem = tool({

    name: 'zotero_add_item',
    description: 'Create one Zotero item from metadata you supply. Use fields for item-type-specific Zotero fields (publicationTitle, volume, issue, pages, date, DOI, url, abstractNote, extra, …). Prefer zotero_add_by_doi when a DOI exists. Requires the Zotero Web API key with write access.',
    parameters: {
      itemType: { type: 'string', required: true, description: 'Zotero item type, for example journalArticle, preprint, conferencePaper, book, thesis.' },
      title: { type: 'string', required: true, description: 'Item title.' },
      fields: { type: 'object', additionalProperties: true, description: 'Additional Zotero fields keyed by their camelCase API names, for example {"publicationTitle":"Nature","volume":"12","pages":"1-9"}. Booleans and numbers are passed through as-is.' },
      creators: { type: 'array', items: { type: 'string' }, description: 'Authors as "Last, First" or "First Last"; a single word becomes a one-field creator name.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Tags for the new item.' },
      collection: { type: 'string', description: 'Collection key to file the item into, from zotero_collections.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          key: { type: 'string', required: true },
          itemType: { type: 'string', required: true },
          title: { type: 'string', required: true },
          tags: { type: 'array', required: true, items: { type: 'string' } },
          collections: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render(_args, value) {
        const lines = [`Created ${value.key} · ${value.itemType}`, value.title]
        if (value.tags.length > 0) lines.push(`Tags: ${value.tags.join(', ')}`)
        if (value.collections.length > 0) lines.push(`Collections: ${value.collections.join(', ')}`)
        lines.push('Open Zotero and let it sync to see the item in the library.')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const itemType = String(args.itemType ?? '').trim()
      const title = String(args.title ?? '').trim()
      if (!itemType) throw new Error('itemType 不能为空。')
      if (!title) throw new Error('title 不能为空。')
      const template = { ...(args.fields ?? {}), itemType, title }
      const creators = creatorsFromStrings(args.creators)
      if (creators.length > 0) template.creators = creators
      if (asArray(args.tags).length > 0) template.tags = asArray(args.tags).map(tag => ({ tag: String(tag) }))
      if (args.collection) template.collections = [args.collection]
      const created = await createItem(template, exec.signal)
      return {
        key: created.key,
        itemType: created.itemType ?? itemType,
        title: created.title ?? title,
        tags: asArray(created.tags).map(entry => entry.tag).filter(Boolean),
        collections: asArray(created.collections),
      }
    },
  })

  const updateItem = tool({
    name: 'zotero_update_item',
    description: 'Update an existing Zotero item: set fields, add or remove tags, add or remove collections. The item is read first, so tag and collection lists are merged instead of replaced. Requires the Zotero Web API key with write access.',
    parameters: {
      key: { type: 'string', required: true, description: 'Item key to update.' },
      fields: { type: 'object', additionalProperties: true, description: 'Zotero fields to set, for example {"title":"…","date":"2026","extra":"…"}. Matching Zotero field names (camelCase).' },
      addTags: { type: 'array', items: { type: 'string' }, description: 'Tags to add; existing tags are kept.' },
      removeTags: { type: 'array', items: { type: 'string' }, description: 'Tags to remove.' },
      addToCollections: { type: 'array', items: { type: 'string' }, description: 'Collection keys to add the item to.' },
      removeFromCollections: { type: 'array', items: { type: 'string' }, description: 'Collection keys to remove the item from.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          key: { type: 'string', required: true },
          version: { type: 'integer', required: true },
          tags: { type: 'array', required: true, items: { type: 'string' } },
          collections: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render(_args, value) {
        const lines = [`Updated ${value.key} (version ${value.version}).`]
        lines.push(`Tags: ${value.tags.length > 0 ? value.tags.join(', ') : '(none)'}`)
        lines.push(`Collections: ${value.collections.length > 0 ? value.collections.join(', ') : '(none)'}`)
        lines.push('Zotero picks up the change on its next sync.')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const key = String(args.key ?? '').trim()
      if (!/^[A-Za-z0-9]{4,16}$/.test(key)) throw new Error('item key 格式不正确，应为 8 位字母数字，例如 PE969DZ9。')
      const current = await fetchWebItem(key, exec.signal)
      const data = current.data ?? {}
      const patch = {}
      const fields = args.fields && typeof args.fields === 'object' ? args.fields : {}
      for (const [field, value] of Object.entries(fields)) {
        if (field === 'key' || field === 'version' || field === 'itemType') continue
        patch[field] = value
      }
      const addTags = asArray(args.addTags).map(tag => String(tag).trim()).filter(Boolean)
      const removeTags = new Set(asArray(args.removeTags).map(tag => String(tag).trim()).filter(Boolean))
      if (addTags.length > 0 || removeTags.size > 0) {
        const byName = new Map()
        for (const entry of asArray(data.tags)) {
          if (entry?.tag) byName.set(entry.tag, entry)
        }
        for (const tag of addTags) if (!byName.has(tag)) byName.set(tag, { tag })
        for (const tag of removeTags) byName.delete(tag)
        patch.tags = [...byName.values()]
      }
      const addCollections = asArray(args.addToCollections).map(value => String(value).trim()).filter(Boolean)
      const dropCollections = new Set(asArray(args.removeFromCollections).map(value => String(value).trim()).filter(Boolean))
      if (addCollections.length > 0 || dropCollections.size > 0) {
        const kept = new Set(asArray(data.collections))
        for (const value of addCollections) kept.add(value)
        for (const value of dropCollections) kept.delete(value)
        patch.collections = [...kept]
      }
      if (Object.keys(patch).length === 0) throw new Error('没有要修改的内容：请给出 fields、addTags/removeTags 或合集变更。')
      await webRequest('PATCH', `/items/${encodeURIComponent(key)}`, { body: patch, signal: exec.signal, version: data.version })
      const updated = await fetchWebItem(key, exec.signal)
      return {
        key,
        version: Number(updated.version ?? data.version ?? 0),
        tags: asArray(updated.data?.tags).map(entry => entry.tag).filter(Boolean),
        collections: asArray(updated.data?.collections),
      }
    },
  })

  const addNote = tool({
    name: 'zotero_add_note',
    description: 'Attach a note to an existing Zotero item. The body is plain text with a small Markdown subset (headings, bullet and numbered lists, bold, code, links) rendered into Zotero note HTML; pass parentKey of the item the note belongs to. Requires the Zotero Web API key with write access.',
    parameters: {
      parentKey: { type: 'string', required: true, description: 'Key of the item the note belongs to.' },
      text: { type: 'string', required: true, description: 'Note body. Supports headings (#, ##, ###), bullet lists, numbered lists, **bold**, and links.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Tags for the note.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          key: { type: 'string', required: true },
          parentKey: { type: 'string', required: true },
          version: { type: 'integer', required: true },
        },
      },
      render(_args, value) {
        return [{ type: 'text', text: `Added note ${value.key} under ${value.parentKey} (version ${value.version}). Zotero shows it after the next sync.` }]
      },
    },
    async execute(args, exec) {
      const parentKey = String(args.parentKey ?? '').trim()
      const text = String(args.text ?? '').trim()
      if (!/^[A-Za-z0-9]{4,16}$/.test(parentKey)) throw new Error('parentKey 格式不正确，应为 8 位字母数字。')
      if (!text) throw new Error('note 内容不能为空。')
      const template = { itemType: 'note', parentItem: parentKey, note: toNoteHtml(text) }
      const tags = asArray(args.tags).map(tag => String(tag)).filter(Boolean)
      if (tags.length > 0) template.tags = tags.map(tag => ({ tag }))
      const created = await createItem(template, exec.signal)
      return {
        key: created.key,
        parentKey: created.parentItem ?? parentKey,
        version: Number(created.version ?? 0),
      }
    },
  })

  const deleteItem = tool({
    name: 'zotero_delete_item',
    description: 'Permanently delete one Zotero item. The Zotero Web API has no trash step, so this cannot be undone: the caller must repeat the item key in confirmKey to prove intent. Requires the Zotero Web API key with write access.',
    parameters: {
      key: { type: 'string', required: true, description: 'Item key to delete.' },
      confirmKey: { type: 'string', required: true, description: 'Must repeat the same key. Guards against accidental deletion.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { key: { type: 'string', required: true }, deleted: { type: 'boolean', required: true } },
      },
      render(_args, value) {
        return [{ type: 'text', text: `Deleted ${value.key} from the Zotero account. This is permanent; Zotero keeps no trash copy.` }]
      },
    },
    async execute(args, exec) {
      const key = String(args.key ?? '').trim()
      const confirmKey = String(args.confirmKey ?? '').trim()
      if (!/^[A-Za-z0-9]{4,16}$/.test(key)) throw new Error('item key 格式不正确，应为 8 位字母数字。')
      if (confirmKey !== key) throw new Error('confirmKey 必须与 key 完全一致，用来确认这次删除不是误操作。')
      // Zotero requires the item version on DELETE (HTTP 428 without it).
      const current = await fetchWebItem(key, exec.signal)
      await webRequest('DELETE', `/items/${encodeURIComponent(key)}`, { signal: exec.signal, version: current.version })
      return { key, deleted: true }
    },
  })

  ctx.tools.register(search)
  ctx.tools.register(item)
  ctx.tools.register(collections)
  ctx.tools.register(bibtex)
  ctx.tools.register(addByDoi)
  ctx.tools.register(addByTitle)
  ctx.tools.register(addItem)
  ctx.tools.register(updateItem)
  ctx.tools.register(addNote)
  ctx.tools.register(deleteItem)
}

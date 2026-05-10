import { NextRequest } from 'next/server'
import { z } from 'zod'
import { taxHybridSearch } from '@/lib/retrieval'
import { getAllowedCategories } from '@/lib/rbac'
import { routeQuery } from '@/lib/query-router'
import { calculateConfidence } from '@/lib/confidence'
import { buildTaxRAGPrompt, SYSTEM_PROMPT_TAX } from '@/lib/prompts'
import { getGlobalCustomPrompt } from '@/lib/global-prompt'
import { checkIpRateLimit } from '@/lib/ip-rate-limit'
import { lookupSemanticCache, writeSemanticCache } from '@/lib/semantic-cache'
import { embedText } from '@/lib/embeddings'
import { newTraceId, traceLog } from '@/lib/trace'
import { breakerOpenRouter } from '@/lib/circuit-breaker'
import { getTenantContext } from '@/lib/tenant'
import { createClient } from '@supabase/supabase-js'
import { createHash } from 'crypto'

const ChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string().min(1).max(8000),
})

const ChatRequestSchema = z.object({
  messages: z
    .array(ChatMessageSchema)
    .min(1, 'messages must contain at least one entry')
    .max(20, 'too many messages in a single request'),
  sessionId: z.string().uuid().optional().nullable(),
  turnstileToken: z.string().optional().nullable(),
})

export type ChatRequest = z.infer<typeof ChatRequestSchema>

function hashIp(ip: string): string {
  return createHash('sha256').update(ip).digest('hex').slice(0, 16)
}

// TODO: Replace service role with scoped writer role for query_logs/audit_log
function createServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

// Streaming + Cohere reranking can take >10s
export const maxDuration = 60

const OPENROUTER_BASE = 'https://openrouter.ai'
const GENERATION_MODEL = 'anthropic/claude-haiku-4-5'

// SSRF guard — only these hosts are allowed for outbound fetch
const ALLOWED_FETCH_HOSTS = ['openrouter.ai', 'challenges.cloudflare.com']

// Post-processing: detect stale PIT rates from pre-2022 docs.
// If the answer contains BOTH "PIT" AND old rate (18%) or old threshold (85 528),
// append a warning that current rates are 12% / 120 000 zł since Polski Ład 2.0 (2022-07-01).
function checkStaleRates(answer: string): string {
  const hasPIT = /\bPIT\b/i.test(answer)
  const hasOldRate = /18\s*%/.test(answer)
  const hasOldThreshold = /85\s*528/.test(answer)

  if (hasPIT && (hasOldRate || hasOldThreshold)) {
    return answer + '\n\n⚠️ **Uwaga dot. stawek PIT:** System wykrył w źródłach stare stawki (18% / próg 85 528 zł sprzed 2022). Od 1 lipca 2022 r. (Polski Ład 2.0) obowiązuje **stawka 12%** i **próg 120 000 zł**. Zweryfikuj aktualność cytowanych interpretacji.'
  }
  return answer
}

async function groundingCheck(answer: string, chunks: Array<{ content: string }>): Promise<string[]> {
  try {
    const context = chunks.map(c => c.content).join('\n\n').slice(0, 3000)
    const groundingUrl = `${OPENROUTER_BASE}/api/v1/chat/completions`
    const res = await fetch(groundingUrl, {
      method: 'POST',
      signal: AbortSignal.timeout(12000),
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY!}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3001',
      },
      body: JSON.stringify({
        model: GENERATION_MODEL,
        max_tokens: 256,
        temperature: 0,
        messages: [
          { role: 'system', content: 'Jesteś weryfikatorem faktów dla odpowiedzi z polskiego prawa podatkowego. Sprawdź czy w poniższej odpowiedzi są twierdzenia faktyczne (liczby, daty, artykuły ustaw, sygnatury, procedury) które NIE mają żadnego potwierdzenia w podanych fragmentach dokumentów. NIE flaguj: ogólnych stwierdzeń, przytoczonych sygnatur które są w fragmentach, zdań podsumowujących. Flaguj TYLKO: konkretne fakty (art. X, data Y, kwota Z, procedura W) których nie ma w żadnym fragmencie. Zwróć JSON: {"ungrounded": ["konkretny fakt bez pokrycia"]} lub {"ungrounded": []} jeśli wszystko OK.' },
          { role: 'user', content: `Fragmenty dokumentów:\n${context}\n\nOdpowiedź do weryfikacji:\n${answer.slice(0, 1500)}` },
        ],
      }),
    })
    if (!res.ok) return []
    const data = await res.json() as { choices: Array<{ message: { content: string } }> }
    const text = data.choices?.[0]?.message?.content ?? '{}'
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return []
    try {
      const parsed = JSON.parse(match[0]) as { ungrounded?: string[] }
      return parsed.ungrounded ?? []
    } catch { return [] }
  } catch {
    return []
  }
}

function validateHost(url: string): void {
  const parsed = new URL(url)
  if (!ALLOWED_FETCH_HOSTS.includes(parsed.hostname)) {
    throw new Error(`SSRF guard: host not allowed: ${parsed.hostname}`)
  }
}

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
    const ipHash = hashIp(ip)

    // Resolve tenant from subdomain / X-Tenant-ID header. Falls back to 'default' tenant.
    // Non-fatal: if tenant cannot be resolved (e.g. table missing pre-migration), proceed without context.
    const tenantCtx = await getTenantContext(req).catch(() => null)
    const tenantId = tenantCtx?.tenant?.id ?? null

    // Public mode check — when PUBLIC_MODE=true the endpoint is open (demo).
    // When PUBLIC_MODE is not set or false, require a valid X-Internal-Key header.
    const PUBLIC_MODE = process.env.PUBLIC_MODE === 'true'
    if (!PUBLIC_MODE) {
      const internalKeyAuth = req.headers.get('x-internal-key')
      const ragApiKey = process.env.RAG_API_KEY
      if (!ragApiKey || internalKeyAuth !== ragApiKey) {
        return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 })
      }
    }

    // Internal bypass: requests with valid X-Internal-Key skip rate limiting entirely
    const internalKey = req.headers.get('x-internal-key')
    const isInternalRequest = internalKey && process.env.RAG_API_KEY && internalKey === process.env.RAG_API_KEY

    // IP whitelist — bypasses rate limiting for trusted IPs (owner, dev)
    const IP_WHITELIST = (process.env.IP_WHITELIST || '').split(',').map(s => s.trim()).filter(Boolean)
    const isWhitelisted = IP_WHITELIST.includes(ip)

    let rateLimitRemaining: number
    if (!isInternalRequest && !isWhitelisted) {
      const rateResult = await checkIpRateLimit(ipHash)
      if (!rateResult.allowed) {
        return Response.json(
          { error: 'RATE_LIMIT', message: 'Przekroczono limit zapytań. Spróbuj ponownie za godzinę.' },
          {
            status: 429,
            headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Limit': '15' },
          }
        )
      }
      rateLimitRemaining = rateResult.remaining
    } else {
      rateLimitRemaining = 9999
    }

    let rawBody: unknown
    try {
      rawBody = await req.json()
    } catch {
      return Response.json({ error: 'INVALID_JSON' }, { status: 400 })
    }

    const parsed = ChatRequestSchema.safeParse(rawBody)
    if (!parsed.success) {
      return Response.json(
        {
          error: 'INVALID_REQUEST',
          message: 'Niepoprawny format zapytania.',
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        },
        { status: 400 }
      )
    }
    const { messages, sessionId, turnstileToken } = parsed.data

    // Validate Turnstile token — graceful fallback: if token missing or verification fails,
    // log and continue (do NOT block users). Turnstile is bot-signal only, not a hard gate.
    const turnstileSecret = process.env.TURNSTILE_SECRET_KEY
    if (turnstileSecret && turnstileToken) {
      try {
        const turnstileUrl = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
        validateHost(turnstileUrl)
        const turnstileRes = await fetch(turnstileUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ secret: turnstileSecret, response: turnstileToken }),
          signal: AbortSignal.timeout(4000),
        })
        const turnstileData = await turnstileRes.json() as { success: boolean }
        // Log failed verification but do not block — rate limiter handles abuse
        if (!turnstileData.success) {
          console.warn('[turnstile] verification failed — continuing without block')
        }
      } catch {
        // Turnstile API unreachable — continue without block
        console.warn('[turnstile] verification error — continuing without block')
      }
    }

    const query = messages[messages.length - 1].content
    if (query.trim().length === 0) {
      return Response.json({ error: 'INVALID_REQUEST' }, { status: 400 })
    }
    if (query.length > 800) {
      return Response.json({ error: 'QUERY_TOO_LONG', message: 'Pytanie nie może przekraczać 800 znaków.' }, { status: 400 })
    }

    // Sanitize query for LLM prompt injection prevention — strip newlines and truncate.
    // Used ONLY in LLM prompts; original `query` is used for logging, routing, and cache.
    const safeQuery = query
      .replace(/\n/g, ' ')
      .replace(/\r/g, ' ')
      .slice(0, 800)

    const traceId = newTraceId()
    const startTime = Date.now()
    traceLog(traceId, 'request', { query_len: query.length, ip_hash: ipHash })

    // 1. Route query — detect tax category; pass last 2 messages for context
    const recentContext = messages.slice(-3, -1).map(m => ({ role: m.role, content: m.content }))
    const routing = await routeQuery(query, recentContext.length > 0 ? recentContext : undefined)
    traceLog(traceId, 'router', { category: routing.category })

    // 1a. Off-topic short-circuit — deterministic block, do NOT call LLM or search
    const OFF_TOPIC_THRESHOLD = 0.45
    const taxKeywordRegex = /\b(akcyz|pcc|spadk|dziedzicz|zus|nieruchomo[sś]|darowizn|cit|pit|vat|ksef|podatk|fakt|ulg|odliczen|amortyzac|dywidend|sp[oó][lł]k|interpretac|art\.\s?\d|fiskus)/i
    const isOffTopic =
      routing.category === 'Inne' &&
      routing.confidence < OFF_TOPIC_THRESHOLD &&
      !taxKeywordRegex.test(query)

    if (isOffTopic) {
      traceLog(traceId, 'done', { off_topic: true, category: routing.category, confidence: routing.confidence, ms: Date.now() - startTime })
      const encoder = new TextEncoder()
      const offTopicMsg = 'To pytanie wykracza poza zakres systemu, który obejmuje polskie prawo podatkowe (VAT, PIT, CIT, KSeF, Ordynacja Podatkowa).\n\nZadaj pytanie z zakresu podatków — np. "Jak rozliczyć VAT od usług elektronicznych?", "Kiedy obowiązuje estoński CIT?", "Co z KSeF od 2026 roku?".\n\n⚠️ Pamiętaj: system nie zastępuje porady doradcy podatkowego.'
      const offTopicStream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            type: 'meta', routing,
            confidence: { score: 0, level: 'low', label: 'Poza zakresem' },
            chunks: [], off_topic: true,
          })}\n\n`))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'text', text: offTopicMsg })}\n\n`))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            type: 'metrics', response_time_ms: Date.now() - startTime,
            chunk_count: 0, cache_hit: false, off_topic: true,
          })}\n\n`))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            type: 'follow_ups',
            questions: [
              'Jakie są stawki VAT w Polsce?',
              'Kiedy wchodzi obowiązkowy KSeF?',
              'Co to jest estoński CIT i kto może z niego skorzystać?',
            ],
          })}\n\n`))
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        },
      })
      return new Response(offTopicStream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-RateLimit-Remaining': String(rateLimitRemaining),
          'X-RateLimit-Limit': '15',
          'X-Trace-Id': traceId,
        },
      })
    }

    // 2. Embed query directly for semantic cache lookup (HyDE removed — wasn't actually wired)
    let queryEmbedding: number[] | undefined
    let embeddingDegraded = false
    try {
      queryEmbedding = await embedText(query)
      traceLog(traceId, 'embed', { ok: true })
    } catch (err) {
      embeddingDegraded = true
      traceLog(traceId, 'embed', { ok: false, error: (err as Error).message })
    }

    // 3. Semantic cache lookup — skip LLM entirely on hit
    if (queryEmbedding) {
      try {
        const cacheHit = await lookupSemanticCache(queryEmbedding, null)
        traceLog(traceId, 'cache', { hit: !!cacheHit })
        if (cacheHit) {
          const encoder = new TextEncoder()

          // Start follow-up generation in parallel with stream construction
          const cacheFollowUpUrl = `${OPENROUTER_BASE}/api/v1/chat/completions`
          validateHost(cacheFollowUpUrl)
          const cacheFollowUpPromise = fetch(cacheFollowUpUrl, {
            method: 'POST',
            signal: AbortSignal.timeout(15000),
            headers: {
              Authorization: `Bearer ${process.env.OPENROUTER_API_KEY!}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3001',
            },
            body: JSON.stringify({
              model: GENERATION_MODEL,
              max_tokens: 200,
              temperature: 0.3,
              messages: [{ role: 'user', content: `Zaproponuj 3 krótkie follow-up pytania podatkowe do tego pytania: "${query.slice(0, 300)}"\nOdpowiedz TYLKO jako JSON array. Przykład: ["Pytanie 1?","Pytanie 2?","Pytanie 3?"]` }],
            }),
          }).catch(() => null)

          const stream = new ReadableStream({
            async start(controller) {
              // Meta with empty chunks (cache hit — no retrieval)
              controller.enqueue(encoder.encode(
                `data: ${JSON.stringify({
                  type: 'meta',
                  routing,
                  // Cache hit: realistic confidence (was previously matched at >=0.92 similarity)
                  confidence: { level: 'high', score: 85 },
                  chunks: cacheHit.sources,
                  session_id: sessionId || null,
                  cache_hit: true,
                })}\n\n`
              ))
              // Full answer text at once
              controller.enqueue(encoder.encode(
                `data: ${JSON.stringify({ type: 'text', text: cacheHit.answer })}\n\n`
              ))
              // Metrics
              controller.enqueue(encoder.encode(
                `data: ${JSON.stringify({
                  type: 'metrics',
                  response_time_ms: 0,
                  chunk_count: (cacheHit.sources as unknown[]).length,
                  cache_hit: true,
                })}\n\n`
              ))
              // Follow-up questions (with tax domain filter)
              try {
                const TAX_FOLLOWUP_REGEX = /\b(VAT|PIT|CIT|KSeF|akcyz|podatk|fakt|ulg|odliczen|amortyzac|dywidend|sp[oó][lł]k|interpretac|art\.\s?\d|fiskus|przychod|koszt|stawka|deklarac|zeznani|rozlicz)/i
                const FOLLOWUP_FALLBACK = ['Jakie są zasady rozliczania VAT w Polsce?', 'Kiedy wchodzi obowiązkowy KSeF?', 'Co to jest estoński CIT?']
                const fuRes = await cacheFollowUpPromise
                if (fuRes?.ok) {
                  const fuData = await fuRes.json()
                  const fuText = (fuData.content?.[0]?.text ?? fuData.choices?.[0]?.message?.content ?? '') as string
                  const match = fuText.match(/\[[\s\S]*?\]/)
                  if (match) {
                    const parsedQuestions = JSON.parse(match[0]) as string[]
                    const filteredQuestions = (Array.isArray(parsedQuestions) ? parsedQuestions : [])
                      .filter((q: string) => typeof q === 'string' && TAX_FOLLOWUP_REGEX.test(q))
                      .slice(0, 3)
                    const finalQuestions = filteredQuestions.length >= 2 ? filteredQuestions : FOLLOWUP_FALLBACK
                    controller.enqueue(encoder.encode(
                      `data: ${JSON.stringify({ type: 'follow_ups', questions: finalQuestions })}\n\n`
                    ))
                  }
                }
              } catch { /* follow-up failure is non-fatal */ }
              controller.enqueue(encoder.encode('data: [DONE]\n\n'))
              controller.close()
            },
          })

          return new Response(stream, {
            headers: {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
              'X-RateLimit-Remaining': String(rateLimitRemaining),
              'X-RateLimit-Limit': '15',
              'X-Trace-Id': traceId,
            },
          })
        }
      } catch (err) {
        // Cache lookup failure is non-fatal — continue with normal retrieval
        traceLog(traceId, 'cache', { hit: false, error: (err as Error).message })
      }
    }

    // 4. Vector search: semantic retrieval via Qdrant + Cohere rerank
    // SECURITY: public endpoint — RBAC role is hardcoded to 'public'.
    // Role-based access (admin/ksiegowa/doradca) is enforced only in /api/admin/*
    // and never trusted from client-supplied headers on this endpoint.
    // TODO: implement auth-based role detection (currently public-only demo).
    const userRole = 'public'
    const allowedCategories = getAllowedCategories(userRole)
    const { chunks, embeddingDegraded: retrievalFailed } = await taxHybridSearch(
      query,
      routing,
      8,
      allowedCategories,
    )
    // Only flag degraded when retrieval itself failed — embedText() failure earlier
    // is non-fatal for the search path (Qdrant accepts text query directly).
    if (retrievalFailed) embeddingDegraded = true
    // Stage name kept as 'hybrid' for trace compat; current implementation is single-channel vector.
    traceLog(traceId, 'hybrid', { chunks: chunks.length, degraded: embeddingDegraded })
    traceLog(traceId, 'rerank', { count: chunks.length })

    // 5. Confidence score from actual rerank/relevance scores, not position
    const rerankScores = chunks.map(c => c.relevance_score)
    const confidence = calculateConfidence(rerankScores, chunks.length)

    // 5a. Empty results — return deterministic response without calling LLM (no hallucination risk)
    if (chunks.length === 0) {
      const encoder = new TextEncoder()
      const emptyMessage = 'INFORMACJA: Nie znalazłem odpowiednich dokumentów w bazie dla tego pytania.\n\nMoże to oznaczać, że pytanie jest zbyt ogólne lub temat nie jest jeszcze pokryty w bazie wiedzy. Spróbuj zadać bardziej konkretne pytanie podatkowe lub skonsultuj się z doradcą.\n\n⚠️ *To informacja ogólna, nie porada prawna ani podatkowa. W indywidualnej sprawie skonsultuj się z doradcą podatkowym lub wystąp o interpretację indywidualną.*'

      const emptyStream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(
            `data: ${JSON.stringify({
              type: 'meta',
              routing,
              confidence,
              chunks: [],
              session_id: sessionId || null,
            })}\n\n`
          ))
          controller.enqueue(encoder.encode(
            `data: ${JSON.stringify({ type: 'text', text: emptyMessage })}\n\n`
          ))
          controller.enqueue(encoder.encode(
            `data: ${JSON.stringify({
              type: 'metrics',
              response_time_ms: Date.now() - startTime,
              chunk_count: 0,
              cache_hit: false,
            })}\n\n`
          ))
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        },
      })

      // Fire-and-forget log
      const supabaseLog = createServiceClient()
      void supabaseLog.from('query_logs').insert({
        query: query.slice(0, 500),
        tax_category: routing.category ?? null,
        confidence_level: 'low',
        confidence_score: 0,
        chunk_count: 0,
        response_time_ms: Date.now() - startTime,
        hyde_used: false,
        ip_hash: ipHash,
      }).then(() => {})

      traceLog(traceId, 'done', { ms: Date.now() - startTime, chunks: 0, empty: true })

      return new Response(emptyStream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-RateLimit-Remaining': String(rateLimitRemaining),
          'X-RateLimit-Limit': '15',
          'X-Trace-Id': traceId,
        },
      })
    }

    // 5b. Hard relevance gate: if the best chunk scores below 0.02 on Cohere rerank,
    // the retrieved fragments are almost certainly off-topic. Skip LLM to avoid hallucination.
    // Threshold 0.02 is conservative — even borderline-relevant chunks score >= 0.02 in practice.
    const topCohereScore = chunks[0]?.relevance_score ?? 0
    const HARD_RELEVANCE_THRESHOLD = 0.02
    if (topCohereScore < HARD_RELEVANCE_THRESHOLD && chunks.length > 0) {
      const encoder = new TextEncoder()
      const noRelevantMessage = 'Znaleziono dokumenty w bazie, ale żaden nie jest wystarczająco powiązany z Twoim pytaniem, by udzielić rzetelnej odpowiedzi.\n\nSpróbuj:\n- Zadać pytanie bardziej szczegółowo (podaj numer artykułu, rok przepisu, rodzaj podatku)\n- Użyć innego sformułowania\n- Skontaktować się z doradcą podatkowym\n\n⚠️ *Odpowiedź bez odpowiednich źródeł mogłaby być myląca — system celowo powstrzymuje się od odpowiedzi.*'
      const noRelevantStream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'meta', routing, confidence: { score: 5, level: 'low', label: 'Brak dopasowania' }, chunks: [], session_id: sessionId || null })}\n\n`))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'text', text: noRelevantMessage })}\n\n`))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'metrics', response_time_ms: Date.now() - startTime, chunk_count: chunks.length, cache_hit: false })}\n\n`))
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        },
      })
      traceLog(traceId, 'done', { ms: Date.now() - startTime, hard_relevance_gate: true, top_score: topCohereScore })
      return new Response(noRelevantStream, {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-RateLimit-Remaining': String(rateLimitRemaining), 'X-RateLimit-Limit': '15', 'X-Trace-Id': traceId },
      })
    }

    // 6. Build RAG context (we have chunks here)
    // Pass query so buildTaxRAGPrompt can inject KSeF curated context when relevant.
    const ragContext = buildTaxRAGPrompt(chunks, query)

    // Soft threshold abstain: when top Cohere score is low, instruct LLM to abstain rather than guess.
    // Cohere absolute scores typically sit in [0.02, 0.4] for relevant chunks — below 0.05
    // is a strong signal that retrieved fragments do not match the query well.
    const lowConfidence = topCohereScore < 0.05

    // System prompt resolution order (first non-null wins):
    //   1) per-tenant override (tenants.custom_system_prompt)
    //   2) global admin override (custom-system-prompt.json)
    //   3) built-in SYSTEM_PROMPT_TAX
    const globalCustomPrompt = await getGlobalCustomPrompt().catch(() => null)
    const baseSystemPrompt =
      tenantCtx?.tenant?.custom_system_prompt
      || globalCustomPrompt
      || SYSTEM_PROMPT_TAX
    const systemPrompt = lowConfidence
      ? `${baseSystemPrompt}\n\nUWAGA: Baza wiedzy zawiera skąpe źródła dla tego pytania (niska pewność retrievera). Jeśli nie możesz udzielić rzetelnej odpowiedzi opartej na fragmentach — powiedz wprost: "Brak wystarczających źródeł w bazie, zalecam konsultację z doradcą podatkowym." NIE uzupełniaj luk własną wiedzą ogólną.`
      : baseSystemPrompt

    // 7. Follow-up generation (parallel with main LLM)
    const followupsUrl = `${OPENROUTER_BASE}/api/v1/chat/completions`
    validateHost(followupsUrl)

    const followUpPromise = fetch(followupsUrl, {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY!}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3001',
      },
      body: JSON.stringify({
        model: GENERATION_MODEL,
        max_tokens: 200,
        temperature: 0.3,
        messages: [{
          role: 'user',
          content: `Zaproponuj 3 krótkie follow-up pytania podatkowe do tego pytania: "${safeQuery.slice(0, 300)}"\nOdpowiedz TYLKO jako JSON array. Przykład: ["Pytanie 1?","Pytanie 2?","Pytanie 3?"]`
        }]
      }),
    }).catch(() => null)

    // 8. Main generation (streaming) — wrapped in circuit breaker
    const generationUrl = `${OPENROUTER_BASE}/api/v1/chat/completions`
    validateHost(generationUrl)

    let genRes: Response
    try {
      genRes = await breakerOpenRouter.run(async () => {
        const res = await fetch(generationUrl, {
          method: 'POST',
          signal: AbortSignal.timeout(30000),
          headers: {
            Authorization: `Bearer ${process.env.OPENROUTER_API_KEY!}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3001',
          },
          body: JSON.stringify({
            model: GENERATION_MODEL,
            stream: true,
            max_tokens: 2500,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: `${ragContext}\n\n---\n\nPytanie: ${safeQuery}` },
            ],
          }),
        })
        if (!res.ok) {
          const errText = await res.text()
          throw new Error(`OpenRouter error: ${res.status} — ${errText}`)
        }
        return res
      })
    } catch (err) {
      traceLog(traceId, 'error', { stage: 'gen', error: (err as Error).message })
      throw err
    }
    traceLog(traceId, 'gen', { ok: true })

    const encoder = new TextEncoder()

    // Prepare sources payload for cache write later
    const sourcesPayload = chunks.map(c => ({
      content: c.content,
      doc_title: c.doc_title,
      article_ref: c.article_ref,
      doc_source_type: c.doc_source_type,
      doc_source_url: c.doc_source_url,
      doc_sygnatura: c.doc_sygnatura,
      doc_act_name: c.doc_act_name,
      doc_tax_category: c.doc_tax_category,
      doc_id: (c.metadata?.doc_id as string) || null,
      metadata: c.metadata || {},
    }))

    // Meta chunk: routing, confidence, sources — sent before stream tokens
    const metaPayload = JSON.stringify({
      type: 'meta',
      routing,
      confidence,
      chunks: sourcesPayload,
      session_id: sessionId || null,
    })

    let fullResponseText = ''

    const readable = new ReadableStream({
      async start(controller) {
        // Send meta first
        controller.enqueue(encoder.encode(`data: ${metaPayload}\n\n`))

        // Degraded mode notification when embedding failed
        if (embeddingDegraded) {
          controller.enqueue(encoder.encode(
            `data: ${JSON.stringify({ type: 'degraded_mode', message: 'Tryb awaryjny — wyszukiwanie po słowach kluczowych' })}\n\n`
          ))
        }

        // Stream LLM tokens
        const reader = genRes.body!.getReader()
        const dec = new TextDecoder()

        try {
          let lineBuffer = ''
          let streamDone = false
          while (!streamDone) {
            const { done, value } = await reader.read()
            if (done) break

            lineBuffer += dec.decode(value, { stream: true })
            const lines = lineBuffer.split('\n')
            lineBuffer = lines.pop() ?? ''

            for (const line of lines) {
              if (!line.startsWith('data: ')) continue
              const data = line.slice(6).trim()
              try {
                if (data === '[DONE]') { streamDone = true; break }
                const event = JSON.parse(data)
                const text = event.choices?.[0]?.delta?.content
                if (text) {
                  fullResponseText += text
                  controller.enqueue(
                    encoder.encode(`data: ${JSON.stringify({ type: 'text', text })}\n\n`)
                  )
                }
              } catch {
                // skip malformed SSE lines
              }
            }
          }
          // flush remaining buffer
          if (lineBuffer.startsWith('data: ')) {
            const data = lineBuffer.slice(6).trim()
            if (data && data !== '[DONE]') {
              try {
                const event = JSON.parse(data)
                const text = event.choices?.[0]?.delta?.content
                if (text) {
                  fullResponseText += text
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'text', text })}\n\n`))
                }
              } catch { /* ignore */ }
            }
          }
        } finally {
          reader.releaseLock()
        }

        // Stale-rate detection: post-process the streamed answer. The token-level stream
        // is already flushed to the client, so we emit the warning as an appendable
        // text event (client-side renderer concatenates 'text' deltas).
        if (fullResponseText) {
          const augmented = checkStaleRates(fullResponseText)
          if (augmented !== fullResponseText) {
            const warningSuffix = augmented.slice(fullResponseText.length)
            controller.enqueue(encoder.encode(
              `data: ${JSON.stringify({ type: 'text', text: warningSuffix })}\n\n`
            ))
            fullResponseText = augmented
          }
        }

        // Metrics
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({
            type: 'metrics',
            response_time_ms: Date.now() - startTime,
            chunk_count: chunks.length,
            cache_hit: false,
          })}\n\n`
        ))

        // Follow-up questions (with tax domain filter)
        try {
          const TAX_FOLLOWUP_REGEX = /\b(VAT|PIT|CIT|KSeF|akcyz|podatk|fakt|ulg|odliczen|amortyzac|dywidend|sp[oó][lł]k|interpretac|art\.\s?\d|fiskus|przychod|koszt|stawka|deklarac|zeznani|rozlicz)/i
          const FOLLOWUP_FALLBACK = ['Jakie są zasady rozliczania VAT w Polsce?', 'Kiedy wchodzi obowiązkowy KSeF?', 'Co to jest estoński CIT?']
          const fuRes = await followUpPromise
          if (fuRes?.ok) {
            const fuData = await fuRes.json()
            const fuText = (fuData.content?.[0]?.text ?? fuData.choices?.[0]?.message?.content ?? '') as string
            const match = fuText.match(/\[[\s\S]*?\]/)
            if (match) {
              const parsedQuestions = JSON.parse(match[0]) as string[]
              const filteredQuestions = (Array.isArray(parsedQuestions) ? parsedQuestions : [])
                .filter((q: string) => typeof q === 'string' && TAX_FOLLOWUP_REGEX.test(q))
                .slice(0, 3)
              const finalQuestions = filteredQuestions.length >= 2 ? filteredQuestions : FOLLOWUP_FALLBACK
              controller.enqueue(encoder.encode(
                `data: ${JSON.stringify({ type: 'follow_ups', questions: finalQuestions })}\n\n`
              ))
            }
          }
        } catch {
          // follow-up failure is non-fatal
        }

        // Grounding check — runs with 14s timeout (after follow-ups which have 15s).
        // Awaited before controller.close() so warning SSE can still reach the client.
        // Any timeout or failure is non-fatal: stream closes normally without warning.
        if (fullResponseText && fullResponseText.length > 100) {
          try {
            const groundingTimeout = new Promise<string[]>(resolve => setTimeout(() => resolve([]), 14000))
            const ungrounded = await Promise.race([groundingCheck(fullResponseText, chunks), groundingTimeout])
            console.log('[grounding] check result:', ungrounded)
            if (ungrounded.length >= 2) {
              console.warn('[grounding] ungrounded sentences detected:', ungrounded.length)
              // Log hallucination flags to Supabase — best-effort, non-blocking
              const supabaseGround = createServiceClient()
              void supabaseGround.from('query_logs').update({
                hallucination_flags: ungrounded,
              }).eq('ip_hash', ipHash).order('created_at', { ascending: false }).limit(1).then(() => {})
              // Send warning SSE event before [DONE]
              controller.enqueue(encoder.encode(
                `data: ${JSON.stringify({ type: 'warning', message: '⚠️ Uwaga: fragment odpowiedzi może zawierać informacje spoza cytowanych źródeł. Zweryfikuj z doradcą podatkowym.' })}\n\n`
              ))
            }
          } catch {
            // Grounding check failure is non-fatal
          }
        }

        // Write to semantic cache (fire-and-forget) — only cache substantive answers
        if (queryEmbedding && fullResponseText && fullResponseText.length > 200) {
          writeSemanticCache(query, queryEmbedding, fullResponseText, sourcesPayload, null).catch(() => {})
        }

        traceLog(traceId, 'done', { ms: Date.now() - startTime, chunks: chunks.length })
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    })

    // Fire-and-forget query log — never blocks response
    const supabaseLog = createServiceClient()
    const responseMs = Date.now() - startTime
    void Promise.all([
      supabaseLog.from('query_logs').insert({
        query: query.slice(0, 500),
        tax_category: routing.category ?? null,
        confidence_level: confidence.level ?? null,
        confidence_score: typeof confidence.score === 'number' ? Math.round(confidence.score) : null,
        chunk_count: chunks.length,
        response_time_ms: responseMs,
        hyde_used: false,
        ip_hash: ipHash,
      }),
      supabaseLog.from('audit_log').insert({
        user_id: ipHash,
        action: 'query',
        details: {
          query: query.slice(0, 200),
          tax_category: routing.category ?? null,
          confidence_level: confidence.level ?? null,
          chunk_count: chunks.length,
          response_time_ms: responseMs,
          tenant_slug: tenantCtx?.tenant?.slug ?? null,
        },
        ip_address: ipHash,
        project_key: process.env.PROJECT_KEY ?? 'podatki',
        tenant_id: tenantId,
      }),
    ]).catch(() => {})

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-RateLimit-Remaining': String(rateLimitRemaining),
        'X-RateLimit-Limit': '15',
        'X-Trace-Id': traceId,
      },
    })
  } catch (err) {
    console.error('Chat API error:', err)
    return Response.json(
      { error: 'INTERNAL_ERROR', message: 'Wystąpił błąd serwera. Spróbuj ponownie.' },
      { status: 500 }
    )
  }
}

# Polish Tax RAG — Portfolio Project

**Live demo:** [rag-demo-podatki.vercel.app](https://rag-demo-podatki.vercel.app)

Production-grade RAG system na polskim prawie podatkowym. Zbudowany jako portfolio piece pokazujący zaawansowane techniki retrieval-augmented generation.

---

## Co to robi

Pozwala zadawać pytania po polsku o przepisy podatkowe (VAT, PIT, CIT, KSeF, Ordynacja podatkowa) i otrzymywać odpowiedzi z powołaniem na konkretne artykuły ustaw oraz interpretacje indywidualne KIS.

**Baza wiedzy:** 1862 dokumentów / 42 240 fragmentów
- Ustawy podatkowe (VAT, PIT, CIT, KSeF, Ordynacja)
- 781 interpretacji indywidualnych KIS (Eureka MF)

---

## Architektura RAG

```
Pytanie użytkownika
       │
       ▼
┌─────────────────┐
│   HyDE          │  Generuje hipotetyczny dokument odpowiedzi
│   (Haiku 4.5)   │  → lepsze embedding pytania
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────┐
│   Hybrid Search                 │
│   pgvector (cosine) + BM25 FTS  │  Dwa niezależne sygnały
│   RRF fusion (k=60)             │  → fuzja rankingów
└────────┬────────────────────────┘
         │
         ▼
┌─────────────────┐
│  Cohere Rerank  │  Multilingual-3 — reranking top-20 → top-5
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Semantic Cache  │  Próg podobieństwa 0.92 — cache trafień
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Claude Haiku   │  Generacja odpowiedzi z cytatami źródeł
│  4.5 via OR     │  + streaming SSE
└────────┬────────┘
         │
         ▼
   Odpowiedź + źródła + confidence score
```

### Dlaczego HyDE?

Standardowe embedding pytania ("Kiedy powstaje obowiązek podatkowy w VAT?") daje słabe wyniki — pytanie ma inny rozkład tokenów niż dokument prawny. HyDE generuje najpierw hipotetyczną odpowiedź, a jej embedding trafia znacznie bliżej fragmentów ustaw. Efekt: wyraźnie lepsza jakość retrieval bez dodatkowego fine-tuningu.

### Dlaczego hybrid search zamiast samego pgvector?

Semantic search (pgvector) radzi sobie świetnie z intencją, ale słabo z dokładnymi numerami artykułów ("art. 86 ust. 2 ustawy o VAT"). BM25 FTS wyłapuje dokładne frazy. RRF fusion łączy oba sygnały i bije każdy z osobna.

### Dlaczego Cohere Rerank zamiast więcej chunks?

Pobieramy top-20, reranker ocenia semantic relevance każdego fragmentu wobec pytania i zostawia top-5. Lepszy precision, mniej tokenów w kontekście → szybsza i tańsza generacja.

### Dlaczego semantic cache?

Pytania podatkowe często się powtarzają. Cache na progu 0.92 cosine similarity zwraca gotową odpowiedź w <100ms zamiast ~2s. Zmniejsza koszty API o ~30% przy ruchu produkcyjnym.

---

## Stack

| Warstwa | Technologia |
|---------|-------------|
| Framework | Next.js 15, TypeScript strict |
| Baza danych | Supabase (PostgreSQL + pgvector) |
| Embedding | sdadas/mmlw-retrieval-roberta-large-v2 (Polish-optimized, dim=1024, self-hosted) |
| Reranking | Cohere multilingual-rerank-3 |
| Generacja | Claude Haiku 4.5 via OpenRouter |
| Streaming | Server-Sent Events (SSE) |
| Rate limiting | IP-based, 15 req/h, sha256-hashed |
| Security | SSRF guard, CSP headers, HSTS, Turnstile |
| Deploy | Vercel |

---

## Performance

Measured on the production system with a warm embedding server (sdadas/mmlw-retrieval-roberta-large-v2, dim=1024):

| Stage | P50 (ms) | P95 (ms) | Cost per query (USD) |
|-------|---------|---------|----------------------|
| HyDE expansion (Haiku 4.5) | 280 | 520 | ~$0.0002 |
| Hybrid retrieval (pgvector + BM25) | 45 | 120 | - |
| Cohere rerank (top-20 to top-5) | 180 | 340 | ~$0.0001 |
| Answer generation (Haiku 4.5, streaming) | 1,100 | 2,200 | ~$0.0008 |
| **End-to-end (cache miss)** | **~1,700** | **~3,200** | **~$0.0011** |
| **Semantic cache hit** | **<80** | **<150** | **~$0.0001** |

Cache hit rate in production: ~28% (threshold: 0.92 cosine similarity).

---

## Known limitations

- **Corpus scope**: covers Polish tax law (VAT, PIT, CIT, KSeF, Ordynacja podatkowa) and KIS individual interpretations. Does not cover civil law, labor law, or EU regulations outside the indexed corpus.
- **Static index**: the legal corpus is indexed at a point in time. Tax law changes frequently; responses may not reflect amendments passed after the last index update.
- **Language**: Polish only. Mixed-language queries produce degraded retrieval quality.
- **Not legal advice**: this system is a research tool, not a substitute for a licensed tax advisor. Verify all answers against primary sources before acting on them.
- **Evaluation**: retrieval quality benchmarks (Recall@5, MRR) against a labeled question set are in progress. Results will be published in EVAL.md when complete.

---

## Bezpieczeństwo

- SSRF guard z allowlistą hostów na każdym zewnętrznym fetch
- CSP headers (default-src 'self', connect-src whitelisted)
- HSTS, Permissions-Policy, frame-ancestors none
- Service role key tylko server-side
- IP rate limiting (sha256-hashed, fail-open)
- Cloudflare Turnstile (bot protection)
- Ingest scripts poza repozytorium

---

## Metryki live

Publiczny dashboard na stronie głównej pokazuje w czasie rzeczywistym:
- Liczba zapytań (total / dziś)
- Średni czas odpowiedzi (ostatnie 500 zapytań)
- Rozkład kategorii (VAT / PIT / CIT / KSeF)
- Liczba dokumentów i fragmentów w bazie

---

## Autor

**Emil Piński** — solo AI/SaaS developer  
[linkedin.com/in/emilpinski](https://linkedin.com/in/emilpinski) · emilpinskidev@gmail.com

> Nie stanowi porady prawnej.

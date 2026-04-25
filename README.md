# Polish Tax RAG

> Ask questions about Polish tax law in plain language. Get answers with cited sources.

**Status:** Live — deployed for a legal firm

---

## What it does

- Natural language Q&A over Polish tax documents (VAT, CIT, PIT, KSeF)
- Answers include inline citations linking directly to source fragments
- Admin panel for document upload and management
- Hybrid search combining vector similarity and full-text search
- Confidence score shown per answer based on retrieval quality

## How it works

- **Hybrid retrieval**: Combines HyDE (hypothetical document embeddings), pgvector ANN similarity search, Postgres FTS, and RRF (reciprocal rank fusion) — Cohere reranker selects final top candidates
- **Ingestion pipeline**: Uploads PDF/DOCX documents, chunks by legal section with metadata tags (category, year, authority), embeds with OpenAI text-embedding-3-small, stores in Supabase pgvector
- **Streaming generation**: Routes enriched query + RAG context to LLM via OpenRouter with parallel follow-up suggestion generation; SSE streaming for fast first-token response
- **Rate limiting and safety**: SHA256 IP-based rate limiting (15 req/hour), SSRF guards, 500-char query limit

## Tech Stack

![Next.js](https://img.shields.io/badge/Next.js-black?logo=next.js) ![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white) ![Supabase](https://img.shields.io/badge/Supabase_pgvector-3ECF8E?logo=supabase&logoColor=white) ![Cohere](https://img.shields.io/badge/Cohere_Reranker-D4A27F) ![OpenRouter](https://img.shields.io/badge/OpenRouter-grey) ![OpenAI](https://img.shields.io/badge/OpenAI-412991?logo=openai&logoColor=white)

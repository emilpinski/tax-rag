# Tax RAG

> RAG demo on Polish tax documents — query tax law like ChatGPT, with citations and sources.

![Screenshot](./screenshot.png)

## What is it

Tax-RAG is a proof-of-concept Retrieval-Augmented Generation (RAG) system built on Polish tax documents: KIS interpretations, ISAP acts, parliamentary legislation, and Ministry of Finance documents. The user asks a question in Polish, the system performs semantic search across the document database and responds with precise citations and links to sources.

The project demonstrates RAG technology for law firms, accounting offices, and tax advisors who want to deploy their own AI assistant on internal documents.

## Features

- **Semantic search** — Supabase pgvector embeddings, Cohere reranking for best relevance
- **Inline citations and sources** — every answer includes document numbers, articles, and links to acts
- **Multi-source ingestion** — KIS scraper (interpretations), ISAP (legal acts), Sejm RP, PDF documents
- **SSE streaming** — responses streamed token by token via Server-Sent Events
- **Claude AI** — OpenRouter API (claude-sonnet) as the response generation model
- **Knowledge base panel** — browse indexed documents, statuses, statistics
- **Dark/light mode** — next-themes, responsive design
- **Admin panel** — knowledge base management, re-ingestion, analytics
- **DOCX/PDF export** — download answers as documents

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 16, React 19, TypeScript, Tailwind CSS |
| Backend | Next.js API Routes, SSE streaming |
| AI | OpenRouter API (claude-sonnet) |
| RAG | Supabase pgvector + Cohere Rerank |
| Database | Supabase (PostgreSQL + pgvector) |
| Scraping | Cheerio (KIS, ISAP, Sejm) |
| PDF | pdf-parse, pdfjs-dist |
| Export | docx, file-saver |
| State | Zustand |
| Animations | Framer Motion |
| Deploy | Vercel |

## Getting Started

```bash
git clone https://github.com/emilpinski/tax-rag
cd tax-rag
npm install
cp .env.example .env.local
# Fill in environment variables
npm run dev

# Document ingestion:
npm run ingest
npm run scrape:kis
npm run scrape:isap
npm run scrape:sejm
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL | ✅ |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase public key | ✅ |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service key (ingestion) | ✅ |
| `OPENROUTER_API_KEY` | OpenRouter API key | ✅ |
| `COHERE_API_KEY` | Cohere key (reranking) | ✅ |

## Status

Demo — [tax-rag.vercel.app](https://tax-rag.vercel.app)

---
Built by [Emil Piński](https://emilpinski.pl)

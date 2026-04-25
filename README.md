# Polish Tax RAG

> Ask questions about Polish tax law in plain language. Get answers with cited sources.

**Status:** Live (deployed for legal firm)

## How it works
1. **Ingestion** — PDF/DOCX tax documents uploaded via admin panel
2. **Chunking** — semantic splitting with overlap
3. **Embedding** — OpenAI text-embedding-3-small
4. **Search** — pgvector ANN similarity search (Supabase)
5. **Reranking** — Cohere reranker for precision
6. **Answer** — streamed LLM response with inline source citations

## Tech Stack
`Next.js` `TypeScript` `Supabase (pgvector)` `OpenAI` `Cohere` `OpenRouter` `SSE streaming`

# Indexing Pipeline

This document describes how Lexaro ingests, processes, and indexes Polish tax law sources for retrieval-augmented generation.

## Overview

Lexaro builds a hybrid retrieval index over Polish tax legislation and tax authority interpretations. The pipeline combines dense vector search (pgvector + HNSW) with lexical search (PostgreSQL BM25 via tsvector) and a Cohere multilingual reranker on top.

| Component | Technology |
|-----------|------------|
| Storage | Supabase (PostgreSQL 15 + pgvector) |
| Embeddings | MMLW (sdadas/mmlw-retrieval-roberta-large-v2), dim=1024 |
| Lexical search | PostgreSQL tsvector with Polish text search configuration |
| Reranker | Cohere rerank-multilingual-v3 |
| Application layer | Next.js 15, TypeScript |

## Source Documents

The corpus consists of:

- Polish tax statutes: VAT Act, PIT Act, CIT Act, KSeF regulations, Tax Ordinance (Ordynacja podatkowa), and related executive ordinances.
- 781 individual tax interpretations (interpretacje indywidualne) issued by KIS (Krajowa Informacja Skarbowa), sourced from the Eureka MF portal.

Current totals: ~1,862 source documents producing ~42,240 indexed chunks.

## Preprocessing Pipeline

Raw sources arrive as HTML (KIS Eureka) or PDF/HTML (statutes from ISAP). Preprocessing performs the following steps in order:

1. HTML stripping. Markup is removed while structural cues (headings, list markers, article boundaries) are preserved as plain text.
2. Header and footer removal. Repeated page headers, footers, pagination markers, and watermarks are stripped via regex and heuristic detection.
3. Article numbering preservation. Legal references such as "Art. 15 ust. 2 pkt 3" are normalized to a canonical form and retained inside the chunk text so they remain searchable and citable.
4. Whitespace normalization. Non-breaking spaces, soft hyphens, and Unicode quotation variants are normalized to ASCII equivalents where safe.
5. Metadata extraction. Document type, publication date, source URL, act identifier (Dz.U. reference), and interpretation signature (for KIS) are captured into structured fields.

## Chunking Strategy

Lexaro uses paragraph-aware splitting tuned for legal text. The chunker first attempts to split on natural legal boundaries (artykul, ustep, punkt, litera) and only falls back to token-based windowing inside oversized atomic units.

Target parameters:

| Parameter | Value |
|-----------|-------|
| Target chunk size | ~512 tokens |
| Overlap | 50 tokens |
| Boundary preference | article > paragraph > sentence |

Why paragraph-aware matters for legal text:

- Legal arguments depend on the integrity of a single article or paragraph. Splitting mid-sentence loses the legal antecedent and the conditional clause it modifies.
- Cross-references such as "w przypadku, o ktorym mowa w ust. 1" are only resolvable when the chunk contains the referent.
- Each chunk carries the article reference in its metadata, which downstream allows precise citation in generated answers.

## Embedding Model

Lexaro uses MMLW (`sdadas/mmlw-retrieval-roberta-large-v2`), a Polish-optimized retrieval model fine-tuned for asymmetric search (query vs passage). Embedding dimension is 1024.

Rationale for choosing a Polish-specific model over a general multilingual one:

- Polish tax terminology is highly domain-specific and contains many compound nouns and inflected forms. Multilingual models such as `text-embedding-3-large` or `multilingual-e5` consistently underperform MMLW on Polish retrieval benchmarks (PIRB, MTEB-PL).
- MMLW handles Polish morphology natively, which improves recall on inflected queries (for example, "podatnik" vs "podatnika" vs "podatnikow").
- Running the model locally keeps embedding costs at zero and avoids sending tax queries through a third party at index time.

The model runs locally via a Python inference service exposed to the Next.js application over HTTP.

## Vector Index

Stored in PostgreSQL via the `pgvector` extension.

```sql
CREATE INDEX chunks_embedding_hnsw
  ON chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

Query-time parameter:

```sql
SET hnsw.ef_search = 80;
```

Similarity metric is cosine. The `m` and `ef_construction` values were chosen as a balance between build time and recall on the current corpus size; they will be re-tuned if the chunk count exceeds ~250k.

## Lexical Index (BM25 via tsvector)

PostgreSQL full-text search complements the dense index, especially for exact legal references and rare tokens (article numbers, statute identifiers).

```sql
ALTER TABLE chunks
  ADD COLUMN tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('polish', content)) STORED;

CREATE INDEX chunks_tsv_gin ON chunks USING gin (tsv);
```

Configuration notes:

- The `polish` text search configuration uses the `ispell_polish` dictionary for stemming.
- A custom stopword list extends the default Polish stopwords with legal boilerplate (for example, "wlasciwy", "niniejszy") that adds no retrieval signal.
- Article references are pre-tokenized into a canonical form ("art_15_ust_2_pkt_3") so they survive stemming and remain matchable as a single lexeme.

## Hybrid Retrieval

At query time:

1. The user query is embedded with MMLW.
2. Top-k candidates are retrieved from both the HNSW index (cosine similarity) and the BM25 index (ts_rank_cd).
3. Results are fused with Reciprocal Rank Fusion (RRF, k=60).
4. The top 30 fused candidates are reranked by Cohere `rerank-multilingual-v3`.
5. The top 5-10 reranked chunks are passed to the LLM as context.

## Indexing Throughput

Approximate observed throughput on a single embedding worker (consumer GPU):

| Stage | Throughput |
|-------|------------|
| Preprocessing + chunking | ~120 docs/min |
| Embedding (MMLW, batch 32) | ~400 chunks/min |
| Database insert + index update | ~1,500 chunks/min |

A full rebuild of the current corpus completes in roughly 2 hours end to end. Numbers are estimates and vary with document length distribution.

## Re-indexing

Re-indexing is triggered by:

- A change to the chunking strategy or embedding model (full rebuild).
- A new statute publication or amendment (incremental, only the affected document family).
- A batch of new KIS interpretations (incremental append).

Document versions are tracked by content hash so that unchanged sources are skipped on incremental runs.

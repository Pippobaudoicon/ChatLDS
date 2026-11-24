import { createHash } from "crypto";
import { Pinecone } from "@pinecone-database/pinecone";

// The vector index behind the retriever. VECTOR_BACKEND=qdrant switches every read to a
// Qdrant collection loaded from the same chunks and embeddings as the Pinecone index
// (lds-scraper scripts/qdrant_bridge_load.py); anything else, or unset, keeps Pinecone.
// Temporary bridge while Pinecone's monthly read quota is exhausted: going back means
// unsetting VECTOR_BACKEND, nothing else.

export interface VectorMatch {
  id: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

/** The only filter shape the retriever uses: equality on metadata fields. */
export type EqFilter = Record<string, { $eq: string | number }>;

const INDEX_NAME = process.env.PINECONE_INDEX ?? "lds-rag-v1";

function isQdrant(): boolean {
  return process.env.VECTOR_BACKEND === "qdrant";
}

// ── Pinecone ────────────────────────────────────────────────────────────────

let _pc: Pinecone | null = null;
function pineconeNs(namespace: string) {
  if (!_pc) _pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });
  return _pc.index(INDEX_NAME).namespace(namespace);
}

async function pineconeFetch(namespace: string, ids: string[]): Promise<VectorMatch[]> {
  const res = await pineconeNs(namespace).fetch({ ids });
  const records = (res as { records?: Record<string, VectorMatch> }).records ?? {};
  return Object.values(records);
}

// ── Qdrant (REST, one collection; Pinecone's namespace is the `namespace` payload field) ──

type QdrantPoint = { id: string; score?: number; payload?: Record<string, unknown> };

async function qdrant<T>(path: string, body: unknown): Promise<T> {
  const collection = process.env.QDRANT_COLLECTION ?? INDEX_NAME;
  const res = await fetch(`${process.env.QDRANT_URL}/collections/${collection}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "api-key": process.env.QDRANT_API_KEY ?? "" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Qdrant ${path} ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { result: T }).result;
}

// Qdrant point ids must be UUIDs: uuid5(NAMESPACE_URL, chunk id), the same as Python's
// uuid.uuid5(uuid.NAMESPACE_URL, id) in the loader. The chunk id itself is in `chunk_id`.
const NAMESPACE_URL = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");
export function pointId(chunkId: string): string {
  const b = createHash("sha1").update(NAMESPACE_URL).update(chunkId, "utf8").digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function qdrantFilter(namespace: string, filter: EqFilter = {}) {
  return {
    must: [
      { key: "namespace", match: { value: namespace } },
      ...Object.entries(filter).map(([key, cond]) => ({ key, match: { value: cond.$eq } })),
    ],
  };
}

function fromQdrant(p: QdrantPoint): VectorMatch {
  const { chunk_id, ...metadata } = p.payload ?? {};
  return { id: String(chunk_id), score: p.score, metadata };
}

// ── The three reads the retriever makes ────────────────────────────────────

export async function queryVectors(
  namespace: string,
  vector: number[],
  topK: number,
  filter: EqFilter
): Promise<VectorMatch[]> {
  if (isQdrant()) {
    const res = await qdrant<{ points: QdrantPoint[] }>("/points/query", {
      query: vector,
      limit: topK,
      filter: qdrantFilter(namespace, filter),
      with_payload: true,
    });
    return res.points.map(fromQdrant);
  }
  const res = await pineconeNs(namespace).query({ vector, topK, includeMetadata: true, filter });
  return res.matches;
}

export async function fetchVectors(namespace: string, ids: string[]): Promise<VectorMatch[]> {
  if (ids.length === 0) return [];
  if (isQdrant()) {
    const points = await qdrant<QdrantPoint[]>("/points", {
      ids: ids.map(pointId),
      with_payload: true,
    });
    return points.map(fromQdrant);
  }
  return pineconeFetch(namespace, ids);
}

/** Every vector whose id starts with `prefix` (which ends with ":"), up to about `cap`. */
export async function fetchVectorsByPrefix(
  namespace: string,
  prefix: string,
  cap: number
): Promise<VectorMatch[]> {
  if (isQdrant()) {
    // `id_prefixes` holds every ":"-joined prefix of the chunk id, so a prefix listing is
    // an exact keyword match on the prefix without its trailing ":".
    const res = await qdrant<{ points: QdrantPoint[] }>("/points/scroll", {
      filter: {
        must: [
          ...qdrantFilter(namespace).must,
          { key: "id_prefixes", match: { value: prefix.replace(/:$/, "") } },
        ],
      },
      limit: cap,
      with_payload: true,
    });
    return res.points.map(fromQdrant);
  }
  const ids: string[] = [];
  let token: string | undefined;
  do {
    const page = await pineconeNs(namespace).listPaginated({ prefix, paginationToken: token });
    for (const v of page.vectors ?? []) if (v.id) ids.push(v.id);
    token = page.pagination?.next;
  } while (token && ids.length < cap);
  return ids.length > 0 ? pineconeFetch(namespace, ids) : [];
}

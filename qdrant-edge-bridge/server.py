"""
Thin HTTP bridge that wraps Qdrant Edge (embedded) and exposes a
Qdrant-compatible REST API on localhost. No external Qdrant server needed.

Endpoints mirror the Qdrant REST API subset used by the TS plugin:
  PUT  /collections/{name}          - create collection
  GET  /collections/{name}          - get collection info
  PUT  /collections/{name}/points   - upsert points
  POST /collections/{name}/points/search - search
  POST /collections/{name}/points/delete - delete points
  PUT  /collections/{name}/index    - create payload index
"""
import os
import json
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

try:
    from qdrant_edge import EdgeShard
except ImportError:
    EdgeShard = None

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("qdrant-edge-bridge")

STORAGE_DIR = Path(os.getenv("QDRANT_STORAGE_DIR", "/var/lib/qdrant-edge"))
BRIDGE_PORT = int(os.getenv("QDRANT_BRIDGE_PORT", "6333"))

# In-memory registry of shards (one per collection)
shards: dict[str, Any] = {}


def get_shard(collection: str) -> Any:
    if collection not in shards:
        raise HTTPException(status_code=404, detail=f"Collection '{collection}' not found")
    return shards[collection]


@asynccontextmanager
async def lifespan(app: FastAPI):
    STORAGE_DIR.mkdir(parents=True, exist_ok=True)
    log.info(f"qdrant-edge-bridge starting on port {BRIDGE_PORT}, storage: {STORAGE_DIR}")
    # Restore existing collections from disk
    if STORAGE_DIR.exists():
        for coll_dir in STORAGE_DIR.iterdir():
            if coll_dir.is_dir() and (coll_dir / "config.json").exists():
                cfg = json.loads((coll_dir / "config.json").read_text())
                name = coll_dir.name
                if EdgeShard is not None:
                    shard = EdgeShard(str(coll_dir / "data"))
                    shards[name] = {"shard": shard, "config": cfg}
                    log.info(f"restored collection: {name}")
    yield
    # Flush and close all shards
    for name, entry in shards.items():
        if EdgeShard is not None:
            try:
                entry["shard"].flush()
                entry["shard"].close()
            except Exception as e:
                log.error(f"error closing shard {name}: {e}")
    log.info("qdrant-edge-bridge stopped")


app = FastAPI(title="Qdrant Edge Bridge", lifespan=lifespan)


# --- Models ---

class VectorConfig(BaseModel):
    size: int
    distance: str = "Cosine"


class HnswConfig(BaseModel):
    m: int = 16
    payload_m: int = 16
    ef_construct: int = 100


class CreateCollectionRequest(BaseModel):
    vectors: VectorConfig
    hnsw_config: HnswConfig | None = None


class PointStruct(BaseModel):
    id: str | int
    vector: list[float]
    payload: dict[str, Any] = {}


class UpsertRequest(BaseModel):
    wait: bool = True
    points: list[PointStruct]


class SearchRequest(BaseModel):
    vector: list[float]
    limit: int = 5
    with_payload: bool = True
    score_threshold: float | None = None
    filter: dict[str, Any] | None = None


class DeleteRequest(BaseModel):
    wait: bool = True
    points: list[str | int]


class PayloadIndexRequest(BaseModel):
    field_name: str
    field_schema: str | dict[str, Any] = "keyword"
    wait: bool = True


# --- Endpoints ---

@app.put("/collections/{name}")
async def create_collection(name: str, req: CreateCollectionRequest):
    if name in shards:
        return {"result": True, "status": "ok"}

    coll_dir = STORAGE_DIR / name
    coll_dir.mkdir(parents=True, exist_ok=True)

    config = {"vectors": {"size": req.vectors.size, "distance": req.vectors.distance}}
    (coll_dir / "config.json").write_text(json.dumps(config))

    if EdgeShard is not None:
        shard = EdgeShard(str(coll_dir / "data"))
        shards[name] = {"shard": shard, "config": config}
    else:
        # Fallback: in-memory store when qdrant-edge-py not available
        shards[name] = {"shard": None, "config": config, "points": {}}

    log.info(f"created collection: {name} (dim={req.vectors.size}, dist={req.vectors.distance})")
    return {"result": True, "status": "ok"}


@app.get("/collections/{name}")
async def get_collection(name: str):
    entry = get_shard(name)
    cfg = entry["config"]

    if EdgeShard is not None and entry["shard"] is not None:
        info = entry["shard"].info()
        points_count = info.get("points_count", 0)
    else:
        points_count = len(entry.get("points", {}))

    return {
        "result": {
            "status": "green",
            "vectors_count": points_count,
            "points_count": points_count,
            "config": {"params": {"vectors": cfg["vectors"]}},
        },
        "status": "ok",
    }


@app.put("/collections/{name}/points")
async def upsert_points(name: str, req: UpsertRequest):
    entry = get_shard(name)

    if EdgeShard is not None and entry["shard"] is not None:
        shard = entry["shard"]
        for point in req.points:
            shard.update(
                point_id=str(point.id),
                vector=point.vector,
                payload=point.payload,
            )
        if req.wait:
            shard.flush()
    else:
        # Fallback in-memory store
        points = entry.setdefault("points", {})
        for point in req.points:
            points[str(point.id)] = {
                "id": str(point.id),
                "vector": point.vector,
                "payload": point.payload,
            }

    return {"result": {"operation_id": 0, "status": "completed"}, "status": "ok"}


@app.post("/collections/{name}/points/search")
async def search_points(name: str, req: SearchRequest):
    entry = get_shard(name)

    if EdgeShard is not None and entry["shard"] is not None:
        shard = entry["shard"]
        results = shard.query(
            vector=req.vector,
            limit=req.limit,
        )
        response = []
        for r in results:
            score = r.get("score", 0.0)
            if req.score_threshold and score < req.score_threshold:
                continue
            point = {
                "id": r.get("id", ""),
                "version": 0,
                "score": score,
            }
            if req.with_payload:
                point["payload"] = r.get("payload", {})
            response.append(point)
        return {"result": response, "status": "ok"}
    else:
        # Fallback: brute-force cosine similarity
        points = entry.get("points", {})
        scored = []
        for pid, p in points.items():
            score = _cosine_sim(req.vector, p["vector"])
            if req.score_threshold and score < req.score_threshold:
                continue
            point: dict[str, Any] = {"id": pid, "version": 0, "score": score}
            if req.with_payload:
                point["payload"] = p["payload"]
            scored.append(point)

        # Apply filter if present
        if req.filter and "must" in req.filter:
            for cond in req.filter["must"]:
                key = cond.get("key", "")
                match_val = cond.get("match", {}).get("value")
                if match_val is not None:
                    scored = [s for s in scored if s.get("payload", {}).get(key) == match_val]

        scored.sort(key=lambda x: x["score"], reverse=True)
        return {"result": scored[: req.limit], "status": "ok"}


@app.post("/collections/{name}/points/delete")
async def delete_points(name: str, req: DeleteRequest):
    entry = get_shard(name)

    if EdgeShard is not None and entry["shard"] is not None:
        shard = entry["shard"]
        for pid in req.points:
            try:
                shard.update(point_id=str(pid), delete=True)
            except Exception:
                pass
        if req.wait:
            shard.flush()
    else:
        points = entry.get("points", {})
        for pid in req.points:
            points.pop(str(pid), None)

    return {"result": {"operation_id": 0, "status": "completed"}, "status": "ok"}


class SetPayloadRequest(BaseModel):
    payload: dict[str, Any]
    points: list[str | int] | None = None
    filter: dict[str, Any] | None = None
    wait: bool = True


class ScrollRequest(BaseModel):
    filter: dict[str, Any] | None = None
    with_payload: bool = True
    limit: int = 20
    offset: str | int | None = None


@app.post("/collections/{name}/points/payload")
@app.put("/collections/{name}/points/payload")
async def set_payload(name: str, req: SetPayloadRequest):
    entry = get_shard(name)
    points_store = entry.get("points", {})

    target_ids = []
    if req.points:
        target_ids = [str(p) for p in req.points]
    elif req.filter and "must" in req.filter:
        # Find matching points by filter
        for pid, p in points_store.items():
            if _matches_filter(p.get("payload", {}), req.filter):
                target_ids.append(pid)

    for pid in target_ids:
        if pid in points_store:
            points_store[pid]["payload"].update(req.payload)

    return {"result": {"operation_id": 0, "status": "completed"}, "status": "ok"}


@app.post("/collections/{name}/points/scroll")
async def scroll_points(name: str, req: ScrollRequest):
    entry = get_shard(name)
    points_store = entry.get("points", {})

    results = []
    for pid, p in points_store.items():
        payload = p.get("payload", {})
        if req.filter and not _matches_filter(payload, req.filter):
            continue
        point: dict[str, Any] = {"id": pid, "version": 0}
        if req.with_payload:
            point["payload"] = payload
        results.append(point)
        if len(results) >= req.limit:
            break

    return {"result": {"points": results, "next_page_offset": None}, "status": "ok"}


@app.put("/collections/{name}/index")
async def create_index(name: str, req: PayloadIndexRequest):
    get_shard(name)
    schema_info = req.field_schema if isinstance(req.field_schema, str) else json.dumps(req.field_schema)
    log.info(f"payload index: {name}/{req.field_name} schema={schema_info}")
    return {"result": {"operation_id": 0, "status": "completed"}, "status": "ok"}


def _matches_filter(payload: dict[str, Any], filt: dict[str, Any]) -> bool:
    """Check if a payload matches a Qdrant filter."""
    if "must" in filt:
        for cond in filt["must"]:
            key = cond.get("key", "")
            match_val = cond.get("match", {}).get("value")
            if match_val is not None:
                actual = payload.get(key)
                if actual != match_val:
                    return False
    return True


def _cosine_sim(a: list[float], b: list[float]) -> float:
    if len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = sum(x * x for x in a) ** 0.5
    norm_b = sum(x * x for x in b) ** 0.5
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=BRIDGE_PORT, log_level="info")

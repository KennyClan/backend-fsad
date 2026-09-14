import base64
import io
import json
import os

import requests as http_requests
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image

ROBOFLOW_API_KEY = os.environ.get("ROBOFLOW_API_KEY")
ROBOFLOW_MODEL_ID = os.environ.get("ROBOFLOW_MODEL_ID")
ROBOFLOW_API_URL = os.environ.get("ROBOFLOW_API_URL", "https://detect.roboflow.com")
CONF_THRESHOLD = float(os.environ.get("CONF_THRESHOLD", "0.5"))
IOU_THRESHOLD = float(os.environ.get("IOU_THRESHOLD", "0.45"))
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",")]

if not ROBOFLOW_API_KEY:
    raise RuntimeError("ROBOFLOW_API_KEY environment variable is required but not set.")
if not ROBOFLOW_MODEL_ID:
    raise RuntimeError("ROBOFLOW_MODEL_ID environment variable is required but not set.")

_DEFAULT_CLASS_MAP = {
    "sofa": "sofa_3",
    "couch": "sofa_3",
    "loveseat": "sofa_2",
    "sofa 2 seat": "sofa_2",
    "sofa 3 seat": "sofa_3",
    "sofa2": "sofa_2",
    "sofa_2": "sofa_2",
    "sofa3": "sofa_3",
    "sofa_3": "sofa_3",
    "chair": "chair",
    "dining chair": "chair",
    "armchair": "armchair",
    "lounge chair": "armchair",
    "swivel_c": "chair",
    "table": "table_rect",
    "dining table": "table_rect",
    "dining-table": "table_rect",
    "dinning-table": "table_rect",
    "round table": "table_round",
    "coffee table": "coffee",
    "desk": "desk",
    "bed": "bed_d",
    "master bed": "bed_d",
    "single bed": "bed_s",
    "double bed": "bed_d",
    "king bed": "bed_k",
    "toilet": "toilet",
    "sink": "sink",
    "bathtub": "bathtub",
    "tub": "bathtub",
    "plant": "plant",
    "houseplant": "plant",
    "potted_plant": "plant",
    "potted plant": "plant",
    "tv": "tv",
    "television": "tv",
    "tvmonitor": "tv",
    "monitor": "tv",
    "computer": "tv",
    "bookshelf": "shelf",
    "bookcase": "shelf",
    "shelf": "shelf",
    "cabinet": "cabinet",
    "wall cabinet": "wall_cab",
    "wardrobe": "wardrobe",
    "closet": "wardrobe",
    "transparent closet": "wardrobe",
    "cupboard": "cabinet",
    "sideboard": "cabinet",
    "drawer near bed": "cabinet",
    "nightstand": "cabinet",
    "door": "door",
    "window": "window",
    "windows": "window",
    "rug": "rug",
    "carpet": "rug",
    "wall": "wall",
    "curtains": "wall_cab",
    "ceiling fan": "wall_cab",
    "air conditioner": "wall_cab",
    "lamp": "tv",
    "frame": "shelf",
    "photoframe": "shelf",
    "sofa": "sofa_3",
}


def _load_class_map():
    env_map = os.environ.get("CLASS_MAP", "")
    if env_map:
        try:
            return {k.lower(): v for k, v in json.loads(env_map).items()}
        except json.JSONDecodeError:
            pass
    return dict(_DEFAULT_CLASS_MAP)


CLASS_MAP = _load_class_map()

app = FastAPI(title="FloorPlan Studio - furniture detection (Roboflow Hosted API)")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)


def _run_detection(image_b64: str):
    try:
        image_bytes = base64.b64decode(image_b64)
        img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    except Exception:
        raise HTTPException(status_code=400, detail="Could not decode image.")

    orig_w, orig_h = img.size

    conf_pct = int(CONF_THRESHOLD * 100)
    overlap_pct = int(IOU_THRESHOLD * 100)

    url = f"{ROBOFLOW_API_URL}/{ROBOFLOW_MODEL_ID}"
    params = {
        "api_key": ROBOFLOW_API_KEY,
        "confidence": conf_pct,
        "overlap": overlap_pct,
    }

    try:
        resp = http_requests.post(
            url,
            params=params,
            data=image_bytes,
            headers={"Content-Type": "application/octet-stream"},
            timeout=30,
        )
    except http_requests.Timeout:
        raise HTTPException(status_code=502, detail="Roboflow API request timed out.")
    except http_requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"Roboflow API request failed: {exc}")

    if resp.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"Roboflow API returned status {resp.status_code}: {resp.text}",
        )

    try:
        result = resp.json()
    except ValueError:
        raise HTTPException(status_code=502, detail="Roboflow API returned invalid JSON.")

    predictions = []
    unmapped = set()

    for pred in result.get("predictions", []):
        cls_name = pred.get("class", "")
        cls_lower = cls_name.lower().strip()
        furniture_id = CLASS_MAP.get(cls_lower)

        if furniture_id:
            predictions.append({
                "furnitureId": furniture_id,
                "class": cls_name,
                "confidence": float(pred.get("confidence", 0)),
                "x": float(pred.get("x", 0)),
                "y": float(pred.get("y", 0)),
                "width": float(pred.get("width", 0)),
                "height": float(pred.get("height", 0)),
            })
        else:
            unmapped.add(cls_name)

    return {
        "detections": predictions,
        "predictions": [
            {
                "class": p["class"],
                "confidence": p["confidence"],
                "x": p["x"],
                "y": p["y"],
                "width": p["width"],
                "height": p["height"],
            }
            for p in predictions
        ],
        "imageWidth": orig_w,
        "imageHeight": orig_h,
        "unmappedClasses": sorted(unmapped),
    }


@app.get("/")
def health():
    return {"status": "ok", "model": ROBOFLOW_MODEL_ID, "runtime": "roboflow-hosted-api"}


@app.post("/api/detect-furniture")
async def detect_furniture(request: Request):
    body = await request.json()
    image_b64 = body.get("image")
    if not image_b64 or not isinstance(image_b64, str):
        raise HTTPException(status_code=400, detail='Missing "image" (base64 string) in the request body.')
    return _run_detection(image_b64)


@app.post("/detect")
async def detect(request: Request):
    body = await request.json()
    image_b64 = body.get("image")
    if not image_b64 or not isinstance(image_b64, str):
        raise HTTPException(status_code=400, detail='Missing "image" (base64 string) in the request body.')
    return _run_detection(image_b64)

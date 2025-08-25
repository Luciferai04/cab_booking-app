from fastapi import FastAPI
from pydantic import BaseModel
from typing import Optional, List
import os
from joblib import load

app = FastAPI()

# Attempt to load models from /models mount
ETA_MODEL_PATH = os.getenv("ETA_MODEL_PATH", "/models/eta_calibration.joblib")
DEMAND_MODEL_PATH = os.getenv("DEMAND_MODEL_PATH", "/models/demand_forecast.joblib")
MATCH_MODEL_PATH = os.getenv("MATCH_MODEL_PATH", "/models/match_model.joblib")

eta_model = None
if os.path.exists(ETA_MODEL_PATH):
    try:
        eta_model = load(ETA_MODEL_PATH)
    except Exception:
        eta_model = None

demand_model = None
if os.path.exists(DEMAND_MODEL_PATH):
    try:
        demand_model = load(DEMAND_MODEL_PATH)  # expected dict: {(zoneId, how): value}
    except Exception:
        demand_model = None

match_model = None
if os.path.exists(MATCH_MODEL_PATH):
    try:
        match_model = load(MATCH_MODEL_PATH)
    except Exception:
        match_model = None

class EtaCalibrateIn(BaseModel):
    osrmDuration: float
    hour: Optional[int] = None
    dow: Optional[int] = None

class EtaCalibrateOut(BaseModel):
    calibratedDuration: float

class DemandIn(BaseModel):
    zoneId: str
    ts: Optional[str] = None
    horizon: int = 1  # hours ahead

class DemandOut(BaseModel):
    demand: List[float]

class MatchIn(BaseModel):
    # Minimal features; extend as needed
    etaSec: float
    distanceM: Optional[float] = None
    captainRating: Optional[float] = None
    userRating: Optional[float] = None
    cancellationRate: Optional[float] = None

class MatchOut(BaseModel):
    score: float

class FraudIn(BaseModel):
    userTrips: int
    chargebacks: int
    deviceChangesLast7d: int
    paymentFailuresLast7d: int

class FraudOut(BaseModel):
    risk: float

@app.get("/health")
async def health():
    return {"status": "ok", "service": "ml-inference", "models": {
        "eta": bool(eta_model), "demand": bool(demand_model), "match": bool(match_model)
    }}

@app.post("/eta/calibrate", response_model=EtaCalibrateOut)
async def eta_calibrate(inp: EtaCalibrateIn):
    # If a trained model exists, use it; else fallback to simple factor
    if eta_model is not None:
        hour = inp.hour if inp.hour is not None else 12
        dow = inp.dow if inp.dow is not None else 3
        X = [[float(inp.osrmDuration), hour, dow]]
        try:
            y = eta_model.predict(X)[0]
            return {"calibratedDuration": float(y)}
        except Exception:
            pass
    # Stub fallback: rush-hour factor
    factor = 1.0
    if inp.hour is not None and inp.hour in [8, 9, 18, 19]:
        factor = 1.15
    return {"calibratedDuration": float(inp.osrmDuration) * factor}

@app.post("/demand/predict", response_model=DemandOut)
async def demand_predict(inp: DemandIn):
    # If trained demand model exists (dict), use average per zone-hourOfWeek
    if demand_model is not None:
        from datetime import datetime, timezone
        try:
            base_ts = datetime.now(timezone.utc)
            vals = []
            for h in range(inp.horizon):
                ts = base_ts
                how = ts.weekday() * 24 + ts.hour
                key = (inp.zoneId, how)
                vals.append(float(demand_model.get(key, 10.0)))
            return {"demand": vals}
        except Exception:
            pass
    # Fallback: constant baseline
    return {"demand": [10.0 for _ in range(inp.horizon)]}

@app.post("/match/score", response_model=MatchOut)
async def match_score(inp: MatchIn):
    # If trained model exists, use it; else heuristic
    if match_model is not None:
        import numpy as np
        try:
            features = [
                float(inp.etaSec),
                float(inp.distanceM or 0.0),
                float(inp.captainRating or 4.5),
                float(inp.userRating or 4.5),
                float(inp.cancellationRate or 0.05),
            ]
            score = float(match_model.predict_proba([features])[0][1])
            return {"score": score}
        except Exception:
            pass
    # Heuristic: lower eta and distance => higher score; penalties for high cancellation rate
    eta = max(1.0, float(inp.etaSec))
    dist = max(1.0, float(inp.distanceM or 1000.0))
    cr = float(inp.cancellationRate or 0.05)
    score = max(0.0, min(1.0, 1.0/(1.0 + eta/600.0 + dist/5000.0 + 5.0*cr)))
    return {"score": score}

@app.post("/fraud/score", response_model=FraudOut)
async def fraud_score(inp: FraudIn):
    # Simple rules-based risk
    risk = 0.0
    if inp.chargebacks > 0:
        risk += 0.5
    if inp.paymentFailuresLast7d > 2:
        risk += 0.3
    if inp.deviceChangesLast7d > 3:
        risk += 0.2
    if inp.userTrips < 3:
        risk += 0.1
    return {"risk": float(min(1.0, risk))}


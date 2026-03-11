from fastapi import FastAPI, Depends, Request, Body
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from fastapi.staticfiles import StaticFiles
from datetime import datetime, timedelta
from urllib.parse import quote
from urllib.request import Request as UrlRequest, urlopen
import json
import ssl
from sqlalchemy.orm import Session

from .database import Base, SessionLocal, engine
from .models import Order

app = FastAPI()

templates = Jinja2Templates(directory="app/templates")
app.mount("/static", StaticFiles(directory="app/static"), name="static")

Base.metadata.create_all(bind=engine)

SSL_CONTEXT = ssl.create_default_context()
SSL_CONTEXT.check_hostname = False
SSL_CONTEXT.verify_mode = ssl.CERT_NONE
ADDRESS_SEARCH_CACHE = {}
ADDRESS_SEARCH_BLOCKED_UNTIL = None


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def build_local_fallback_suggestion(query: str):
    raw = query.strip()
    if not raw:
        return []

    parts = [p.strip() for p in raw.split(',') if p.strip()]
    first_part = parts[0] if parts else raw

    tokens = first_part.split()
    house_number = ""
    road = first_part

    if tokens and tokens[-1].isdigit():
        house_number = tokens[-1]
        road = " ".join(tokens[:-1]).strip()

    city = "Halden"
    postcode = ""

    for part in parts[1:]:
        if part.isdigit() and len(part) == 4:
            postcode = part
        elif part.lower() not in {"norway", "norge", "østfold", "ostfold"}:
            city = part

    road = road.strip().title()

    if not road:
        return []

    if not house_number and not postcode:
        stem = road.strip().lower()
        if len(stem) < 3:
            return []

        suffixes = ["veien", "gata", "vegen", "vei"]
        suggestions = []
        seen = set()

        for suffix in suffixes:
            if stem.endswith(("veien", "gata", "vegen", "vei")):
                candidate_road = stem.title()
            else:
                candidate_road = f"{stem}{suffix}".title()

            if candidate_road in seen:
                continue
            seen.add(candidate_road)

            suggestions.append(
                {
                    "display_name": ", ".join(filter(None, [candidate_road, city, "Norge"])),
                    "road": candidate_road,
                    "house_number": "",
                    "postcode": "",
                    "city": city,
                    "lat": "",
                    "lng": "",
                }
            )

        return suggestions

    return [
        {
            "display_name": ", ".join(filter(None, [f"{road} {house_number}".strip(), postcode, city, "Norge"])),
            "road": road,
            "house_number": house_number,
            "postcode": postcode,
            "city": city,
            "lat": "",
            "lng": "",
        }
    ]



def search_address_suggestions(query: str):
    global ADDRESS_SEARCH_BLOCKED_UNTIL

    query = query.strip()
    if not query:
        return []

    cache_key = query.lower()
    if cache_key in ADDRESS_SEARCH_CACHE:
        print(f"ADDRESS SEARCH CACHE HIT query={query!r}")
        return ADDRESS_SEARCH_CACHE[cache_key]

    if ADDRESS_SEARCH_BLOCKED_UNTIL and datetime.utcnow() < ADDRESS_SEARCH_BLOCKED_UNTIL:
        fallback = build_local_fallback_suggestion(query)
        ADDRESS_SEARCH_CACHE[cache_key] = fallback
        print(f"ADDRESS SEARCH FALLBACK (cooldown) query={query!r}")
        return fallback

    url = f"https://nominatim.openstreetmap.org/search?q={quote(query)}&format=json&addressdetails=1&limit=5"
    request = UrlRequest(
        url,
        headers={
            "User-Agent": "SnowManager/1.0 (local development)",
            "Accept-Language": "no,en",
        },
    )

    try:
        with urlopen(request, timeout=10, context=SSL_CONTEXT) as response:
            data = json.loads(response.read().decode("utf-8"))
    except Exception as exc:
        print(f"ADDRESS SEARCH ERROR for {query}: {exc}")
        if "429" in str(exc):
            ADDRESS_SEARCH_BLOCKED_UNTIL = datetime.utcnow() + timedelta(minutes=5)
            fallback = build_local_fallback_suggestion(query)
            ADDRESS_SEARCH_CACHE[cache_key] = fallback
            return fallback
        return []

    collected = []
    seen_display_names = set()

    for item in data:
        display_name = item.get("display_name", "")
        if not display_name or display_name in seen_display_names:
            continue

        address = item.get("address", {})
        road = (
            address.get("road")
            or address.get("pedestrian")
            or address.get("residential")
            or ""
        )
        house_number = address.get("house_number") or ""
        postcode = address.get("postcode") or ""
        city = (
            address.get("city")
            or address.get("town")
            or address.get("village")
            or address.get("municipality")
            or ""
        )

        collected.append(
            {
                "display_name": display_name,
                "road": road,
                "house_number": house_number,
                "postcode": postcode,
                "city": city,
                "lat": item.get("lat"),
                "lng": item.get("lon"),
            }
        )
        seen_display_names.add(display_name)

    if not collected:
        collected = build_local_fallback_suggestion(query)

    print(f"ADDRESS SEARCH query={query!r} results={len(collected)}")
    ADDRESS_SEARCH_CACHE[cache_key] = collected
    return collected



@app.get("/", response_class=HTMLResponse)
def home(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})



@app.get("/driver", response_class=HTMLResponse)
def driver_page(request: Request):
    return templates.TemplateResponse("driver.html", {"request": request})


# New simulator page route
@app.get("/simulator", response_class=HTMLResponse)
def simulator_page(request: Request):
    return templates.TemplateResponse("simulator.html", {"request": request})


@app.get("/orders")
def get_orders(db: Session = Depends(get_db)):
    return db.query(Order).all()


@app.get("/address-search")
def address_search(q: str = ""):
    return search_address_suggestions(q)


@app.post("/orders")
def create_order(
    job_date: str = "",
    address: str = "",
    customer_name: str = "",
    postal_code: str = "",
    city: str = "",
    phone: str = "",
    lat: str = "",
    lng: str = "",
    db: Session = Depends(get_db),
):
    parsed_job_date = None
    if job_date:
        try:
            parsed_job_date = datetime.strptime(job_date, "%Y-%m-%d")
        except ValueError:
            parsed_job_date = None

    parsed_lat = None
    parsed_lng = None

    try:
        parsed_lat = float(lat) if lat else None
    except ValueError:
        parsed_lat = None

    try:
        parsed_lng = float(lng) if lng else None
    except ValueError:
        parsed_lng = None

    order = Order(
        address=address,
        postal_code=postal_code,
        city=city,
        customer_name=customer_name,
        phone=phone,
        status="pending",
        job_date=parsed_job_date,
        lat=parsed_lat,
        lng=parsed_lng,
    )

    db.add(order)
    db.commit()
    db.refresh(order)
    return order


@app.patch("/orders/{order_id}/accept")
def accept_order(order_id: int, db: Session = Depends(get_db)):
    order = db.query(Order).filter(Order.id == order_id).first()
    if not order:
        return {"error": "Order not found"}

    order.status = "accepted"
    db.commit()
    db.refresh(order)
    return order


@app.patch("/orders/{order_id}/route")
def route_order(order_id: int, db: Session = Depends(get_db)):
    order = db.query(Order).filter(Order.id == order_id).first()
    if not order:
        return {"error": "Order not found"}

    order.status = "routed"
    db.commit()
    db.refresh(order)
    return order


@app.patch("/orders/{order_id}/set_location")
def set_order_location(
    order_id: int,
    payload: dict = Body(...),
    db: Session = Depends(get_db),
):
    order = db.query(Order).filter(Order.id == order_id).first()
    if not order:
        return {"error": "Order not found"}

    lat = payload.get("lat")
    lng = payload.get("lng")
    address = payload.get("address", "")

    try:
        order.lat = float(lat) if lat not in (None, "") else None
    except (TypeError, ValueError):
        return {"error": "Invalid lat value"}

    try:
        order.lng = float(lng) if lng not in (None, "") else None
    except (TypeError, ValueError):
        return {"error": "Invalid lng value"}

    if address:
        address_parts = [part.strip() for part in str(address).split(",") if part.strip()]
        order.address = address_parts[0] if address_parts else str(address).strip()

        postcode = ""
        city = ""
        for part in address_parts[1:]:
            tokens = part.split()
            if tokens and len(tokens[0]) == 4 and tokens[0].isdigit():
                postcode = tokens[0]
                city = " ".join(tokens[1:]).strip()
                break

        if postcode:
            order.postal_code = postcode
        if city:
            order.city = city

    db.commit()
    db.refresh(order)
    return order


@app.patch("/orders/{order_id}/cancel")
def cancel_order(order_id: int, db: Session = Depends(get_db)):
    order = db.query(Order).filter(Order.id == order_id).first()
    if not order:
        return {"error": "Order not found"}

    order.status = "cancelled"
    db.commit()
    db.refresh(order)
    return order


@app.patch("/orders/{order_id}/date")
def change_order_date(order_id: int, job_date: str = "", db: Session = Depends(get_db)):
    order = db.query(Order).filter(Order.id == order_id).first()
    if not order:
        return {"error": "Order not found"}

    parsed_job_date = None
    if job_date:
        try:
            parsed_job_date = datetime.strptime(job_date, "%Y-%m-%d")
        except ValueError:
            return {"error": "Invalid date format"}

    order.job_date = parsed_job_date
    db.commit()
    db.refresh(order)
    return order


@app.patch("/orders/{order_id}/start")
def start_order(order_id: int, db: Session = Depends(get_db)):
    order = db.query(Order).filter(Order.id == order_id).first()
    if not order:
        return {"error": "Order not found"}

    active_orders = db.query(Order).filter(Order.id != order_id, Order.status == "active").all()
    for other_order in active_orders:
        other_order.status = "routed"

    order.status = "active"
    db.commit()
    db.refresh(order)
    return order


@app.patch("/orders/{order_id}/complete")
def complete_order(order_id: int, db: Session = Depends(get_db)):
    order = db.query(Order).filter(Order.id == order_id).first()
    if not order:
        return {"error": "Order not found"}

    order.status = "completed"
    db.commit()
    db.refresh(order)
    return order


@app.delete("/orders/{order_id}")
def delete_order(order_id: int, db: Session = Depends(get_db)):
    order = db.query(Order).filter(Order.id == order_id).first()
    if not order:
        return {"error": "Order not found"}

    db.delete(order)
    db.commit()
    return {"success": True}
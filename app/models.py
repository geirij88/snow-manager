from sqlalchemy import Column, Integer, String, DateTime, Float
from datetime import datetime
from .database import Base


class Order(Base):
    __tablename__ = "orders"

    id = Column(Integer, primary_key=True, index=True)
    order_number = Column(String, unique=True, index=True, nullable=True)

    address = Column(String, nullable=False)
    postal_code = Column(String, nullable=True)
    city = Column(String, nullable=True)

    customer_name = Column(String, nullable=False)
    phone = Column(String)
    notes = Column(String)
    status = Column(String, default="pending")
    source = Column(String, default="manual")

    job_date = Column(DateTime, nullable=True)

    lat = Column(Float, nullable=True)
    lng = Column(Float, nullable=True)
    route_order = Column(Integer, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow)

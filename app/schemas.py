# schemas.py
# Pydantic schemas will be defined here later.

from pydantic import BaseModel


class OrderBase(BaseModel):
    address: str
    postal_code: str | None = None
    city: str | None = None
    customer_name: str | None = None
    phone: str | None = None


class OrderCreate(OrderBase):
    pass


class Order(OrderBase):
    id: int
    status: str

    class Config:
        from_attributes = True
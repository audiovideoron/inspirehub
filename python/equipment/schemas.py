"""Pydantic schemas for Equipment API requests and responses."""

from datetime import date, datetime
from pydantic import BaseModel, Field


# Equipment schemas
class EquipmentBase(BaseModel):
    """Base schema for equipment."""
    name: str = Field(..., min_length=1, max_length=255)
    category: str | None = Field(None, max_length=100)
    total_count: int = Field(..., ge=0)
    description: str | None = None
    image_url: str | None = Field(None, max_length=500)


class EquipmentCreate(EquipmentBase):
    """Schema for creating equipment."""
    pass


class EquipmentUpdate(BaseModel):
    """Schema for updating equipment (all fields optional)."""
    name: str | None = Field(None, min_length=1, max_length=255)
    category: str | None = Field(None, max_length=100)
    total_count: int | None = Field(None, ge=0)
    description: str | None = None
    image_url: str | None = Field(None, max_length=500)


class EquipmentResponse(EquipmentBase):
    """Schema for equipment response."""
    id: int
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class EquipmentAvailability(BaseModel):
    """Schema for equipment availability response."""
    equipment_id: int
    name: str
    total_count: int
    reserved_count: int
    available_count: int
    start_date: date
    end_date: date


# Reservation schemas
class ReservationBase(BaseModel):
    """Base schema for reservations."""
    equipment_id: int
    quantity: int = Field(..., ge=1)
    start_date: date
    end_date: date
    customer_name: str = Field(..., min_length=1, max_length=255)
    location: str | None = Field(None, max_length=500)
    notes: str | None = None


class ReservationCreate(ReservationBase):
    """Schema for creating a reservation."""
    pass


class ReservationUpdate(BaseModel):
    """Schema for updating reservation status (approve/deny)."""
    status: str = Field(..., pattern="^(pending|approved|denied)$")
    notes: str | None = None


class ReservationResponse(ReservationBase):
    """Schema for reservation response."""
    id: int
    status: str
    created_at: datetime
    created_by: str | None
    approved_by: str | None
    approved_at: datetime | None

    model_config = {"from_attributes": True}

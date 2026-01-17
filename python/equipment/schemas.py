"""Pydantic schemas for Equipment API v2 requests and responses."""

from datetime import date, datetime
from pydantic import BaseModel, Field
from .models import ItemCondition, LocationType, RequestStatus


# ============================================================
# Location Schemas
# ============================================================

class LocationBase(BaseModel):
    """Base schema for locations."""
    branch_id: str = Field(..., min_length=4, max_length=4, pattern=r"^\d{4}$")
    name: str = Field(..., min_length=1, max_length=255)
    address: str | None = None
    region: str | None = Field(None, max_length=100)


class LocationCreate(LocationBase):
    """Schema for creating a location."""
    pass


class LocationUpdate(BaseModel):
    """Schema for updating a location."""
    name: str | None = Field(None, min_length=1, max_length=255)
    address: str | None = None
    region: str | None = Field(None, max_length=100)


class LocationResponse(LocationBase):
    """Schema for location response."""
    id: int
    created_at: datetime
    is_warehouse: bool

    model_config = {"from_attributes": True}


# ============================================================
# Equipment Type Schemas
# ============================================================

class EquipmentTypeBase(BaseModel):
    """Base schema for equipment types."""
    name: str = Field(..., min_length=1, max_length=255)
    category: str | None = Field(None, max_length=100)
    description: str | None = None
    image_url: str | None = Field(None, max_length=500)


class EquipmentTypeCreate(EquipmentTypeBase):
    """Schema for creating an equipment type."""
    pass


class EquipmentTypeUpdate(BaseModel):
    """Schema for updating an equipment type."""
    name: str | None = Field(None, min_length=1, max_length=255)
    category: str | None = Field(None, max_length=100)
    description: str | None = None
    image_url: str | None = Field(None, max_length=500)


class PartAssignment(BaseModel):
    """Schema for assigning a part to an equipment type."""
    part_type_id: int
    required: bool = False
    quantity: int = Field(1, ge=1)


class EquipmentTypeResponse(EquipmentTypeBase):
    """Schema for equipment type response."""
    id: int
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class EquipmentTypeWithParts(EquipmentTypeResponse):
    """Schema for equipment type with parts list."""
    parts: list["PartInfo"] = []


class PartInfo(BaseModel):
    """Schema for part information in equipment type."""
    id: int
    name: str
    category: str | None
    required: bool
    quantity: int

    model_config = {"from_attributes": True}


# ============================================================
# Equipment Item Schemas
# ============================================================

class EquipmentItemBase(BaseModel):
    """Base schema for equipment items."""
    equipment_type_id: int
    serial_number: str | None = Field(None, max_length=100)
    barcode: str | None = Field(None, max_length=100)
    condition: str = Field(ItemCondition.NEW.value)
    location_type: str = Field(LocationType.WAREHOUSE.value)
    location_id: int | None = None
    parent_item_id: int | None = None


class EquipmentItemCreate(EquipmentItemBase):
    """Schema for creating an equipment item."""
    pass


class EquipmentItemUpdate(BaseModel):
    """Schema for updating an equipment item."""
    serial_number: str | None = Field(None, max_length=100)
    barcode: str | None = Field(None, max_length=100)
    condition: str | None = None
    location_type: str | None = None
    location_id: int | None = None
    parent_item_id: int | None = None


class EquipmentItemResponse(EquipmentItemBase):
    """Schema for equipment item response."""
    id: int
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class EquipmentItemDetail(EquipmentItemResponse):
    """Schema for equipment item with related data."""
    equipment_type: EquipmentTypeResponse | None = None
    location: LocationResponse | None = None


# ============================================================
# Request Schemas
# ============================================================

class RequestLineCreate(BaseModel):
    """Schema for creating a request line."""
    equipment_type_id: int
    quantity: int = Field(1, ge=1)
    include_parts: bool = True


class RequestCreate(BaseModel):
    """Schema for creating an equipment request."""
    requesting_location_id: int
    source_location_id: int
    requester_user_id: str | None = None
    needed_from_date: date
    needed_until_date: date | None = None  # Null = permanent transfer
    notes: str | None = None
    lines: list[RequestLineCreate] = Field(..., min_length=1)


class RequestUpdate(BaseModel):
    """Schema for updating a request (approve/deny)."""
    status: str = Field(..., pattern=f"^({'|'.join(s.value for s in RequestStatus)})$")
    reviewed_by_user_id: str | None = None
    denial_reason: str | None = None
    notes: str | None = None


class RequestLineResponse(BaseModel):
    """Schema for request line response."""
    id: int
    equipment_type_id: int
    quantity: int
    assigned_item_id: int | None
    include_parts: bool
    equipment_type: EquipmentTypeResponse | None = None

    model_config = {"from_attributes": True}


class RequestResponse(BaseModel):
    """Schema for request response."""
    id: int
    requesting_location_id: int
    source_location_id: int
    requester_user_id: str | None
    status: str
    needed_from_date: date
    needed_until_date: date | None
    submitted_at: datetime
    reviewed_at: datetime | None
    reviewed_by_user_id: str | None
    denial_reason: str | None
    notes: str | None

    model_config = {"from_attributes": True}


class RequestDetail(RequestResponse):
    """Schema for request with full details."""
    requesting_location: LocationResponse | None = None
    source_location: LocationResponse | None = None
    lines: list[RequestLineResponse] = []


# ============================================================
# Availability Schemas
# ============================================================

class AvailabilityQuery(BaseModel):
    """Schema for availability query."""
    equipment_type_id: int
    location_id: int | None = None  # None = all locations
    start_date: date
    end_date: date | None = None


class AvailabilityResponse(BaseModel):
    """Schema for availability response."""
    equipment_type_id: int
    equipment_type_name: str
    location_id: int | None
    location_name: str | None
    total_items: int
    available_items: int
    reserved_items: int


# ============================================================
# List Response Schemas
# ============================================================

class PaginatedResponse(BaseModel):
    """Generic paginated response."""
    items: list
    total: int
    page: int
    page_size: int
    pages: int


# Update forward references
EquipmentTypeWithParts.model_rebuild()

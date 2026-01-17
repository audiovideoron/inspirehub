"""SQLAlchemy models for Equipment module v2.

Schema based on GitHub issue #4 PRD:
- EQUIPMENT_TYPE: Catalog of equipment types with self-referential parts
- EQUIPMENT_ITEM: Individual items with serial numbers and tracking
- LOCATION: Hotels and warehouse locations
- REQUEST: Equipment request with approval workflow
- REQUEST_LINE: Line items in a request
"""

from datetime import datetime, date, timezone
from enum import Enum
from sqlalchemy import (
    Integer, String, Text, Date, DateTime, Boolean, ForeignKey, Table, Column
)
from sqlalchemy.orm import Mapped, mapped_column, relationship
from .database import Base


def utc_now() -> datetime:
    """Return current UTC time (timezone-aware)."""
    return datetime.now(timezone.utc)


# Enums for constrained values
class ItemCondition(str, Enum):
    """Condition of an equipment item."""
    NEW = "New"
    GOOD = "Good"
    FAIR = "Fair"
    DAMAGED = "Damaged"
    RETIRED = "Retired"


class LocationType(str, Enum):
    """Where an equipment item is currently located."""
    WAREHOUSE = "Warehouse"
    HOTEL = "Hotel"
    IN_TRANSIT = "In Transit"


class RequestStatus(str, Enum):
    """Status of an equipment request."""
    SUBMITTED = "Submitted"
    APPROVED = "Approved"
    DENIED = "Denied"
    FULFILLED = "Fulfilled"
    RETURNED = "Returned"


# Association table for equipment type parts (self-referential many-to-many)
equipment_type_parts = Table(
    "equipment_type_parts",
    Base.metadata,
    Column("parent_type_id", Integer, ForeignKey("equipment_types.id"), primary_key=True),
    Column("part_type_id", Integer, ForeignKey("equipment_types.id"), primary_key=True),
    Column("required", Boolean, default=False, nullable=False),
    Column("quantity", Integer, default=1, nullable=False),
)


class Location(Base):
    """Hotels and warehouse locations."""
    __tablename__ = "locations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    branch_id: Mapped[str] = mapped_column(String(4), unique=True, nullable=False)  # "0000" = warehouse
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    address: Mapped[str | None] = mapped_column(Text)
    region: Mapped[str | None] = mapped_column(String(100))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)

    # Relationships
    equipment_items: Mapped[list["EquipmentItem"]] = relationship(
        back_populates="location", foreign_keys="EquipmentItem.location_id"
    )
    outgoing_requests: Mapped[list["Request"]] = relationship(
        back_populates="requesting_location", foreign_keys="Request.requesting_location_id"
    )
    incoming_requests: Mapped[list["Request"]] = relationship(
        back_populates="source_location", foreign_keys="Request.source_location_id"
    )

    @property
    def is_warehouse(self) -> bool:
        """Check if this location is the warehouse (branch 0000)."""
        return self.branch_id == "0000"


class EquipmentType(Base):
    """Equipment catalog - types of equipment available."""
    __tablename__ = "equipment_types"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    category: Mapped[str | None] = mapped_column(String(100))
    description: Mapped[str | None] = mapped_column(Text)
    image_url: Mapped[str | None] = mapped_column(String(500))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, onupdate=utc_now)

    # Self-referential relationship for parts
    # An equipment type can have multiple parts (other equipment types)
    parts: Mapped[list["EquipmentType"]] = relationship(
        "EquipmentType",
        secondary=equipment_type_parts,
        primaryjoin=id == equipment_type_parts.c.parent_type_id,
        secondaryjoin=id == equipment_type_parts.c.part_type_id,
        backref="part_of"
    )

    # Relationships
    items: Mapped[list["EquipmentItem"]] = relationship(back_populates="equipment_type")
    request_lines: Mapped[list["RequestLine"]] = relationship(back_populates="equipment_type")


class EquipmentItem(Base):
    """Individual equipment items with serial numbers and tracking."""
    __tablename__ = "equipment_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    equipment_type_id: Mapped[int] = mapped_column(ForeignKey("equipment_types.id"), nullable=False)
    serial_number: Mapped[str | None] = mapped_column(String(100), unique=True)
    barcode: Mapped[str | None] = mapped_column(String(100), unique=True)
    condition: Mapped[str] = mapped_column(String(20), default=ItemCondition.NEW.value)
    location_type: Mapped[str] = mapped_column(String(20), default=LocationType.WAREHOUSE.value)
    location_id: Mapped[int | None] = mapped_column(ForeignKey("locations.id"))
    # Self-reference for tracking parts that belong to a parent item
    parent_item_id: Mapped[int | None] = mapped_column(ForeignKey("equipment_items.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, onupdate=utc_now)

    # Relationships
    equipment_type: Mapped["EquipmentType"] = relationship(back_populates="items")
    location: Mapped["Location | None"] = relationship(back_populates="equipment_items")
    parent_item: Mapped["EquipmentItem | None"] = relationship(
        "EquipmentItem", remote_side=[id], backref="child_items"
    )
    assigned_to_lines: Mapped[list["RequestLine"]] = relationship(back_populates="assigned_item")


class Request(Base):
    """Equipment request with approval workflow."""
    __tablename__ = "requests"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    requesting_location_id: Mapped[int] = mapped_column(ForeignKey("locations.id"), nullable=False)
    source_location_id: Mapped[int] = mapped_column(ForeignKey("locations.id"), nullable=False)
    requester_user_id: Mapped[str | None] = mapped_column(String(255))  # Could be branch_id or user name
    status: Mapped[str] = mapped_column(String(20), default=RequestStatus.SUBMITTED.value)
    needed_from_date: Mapped[date] = mapped_column(Date, nullable=False)
    needed_until_date: Mapped[date | None] = mapped_column(Date)  # Null = indefinite/permanent transfer
    submitted_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime)
    reviewed_by_user_id: Mapped[str | None] = mapped_column(String(255))
    denial_reason: Mapped[str | None] = mapped_column(Text)
    notes: Mapped[str | None] = mapped_column(Text)

    # Relationships
    requesting_location: Mapped["Location"] = relationship(
        back_populates="outgoing_requests", foreign_keys=[requesting_location_id]
    )
    source_location: Mapped["Location"] = relationship(
        back_populates="incoming_requests", foreign_keys=[source_location_id]
    )
    lines: Mapped[list["RequestLine"]] = relationship(
        back_populates="request", cascade="all, delete-orphan"
    )


class RequestLine(Base):
    """Line items in an equipment request."""
    __tablename__ = "request_lines"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    request_id: Mapped[int] = mapped_column(ForeignKey("requests.id"), nullable=False)
    equipment_type_id: Mapped[int] = mapped_column(ForeignKey("equipment_types.id"), nullable=False)
    quantity: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    # Assigned when request is fulfilled
    assigned_item_id: Mapped[int | None] = mapped_column(ForeignKey("equipment_items.id"))
    include_parts: Mapped[bool] = mapped_column(Boolean, default=True)

    # Relationships
    request: Mapped["Request"] = relationship(back_populates="lines")
    equipment_type: Mapped["EquipmentType"] = relationship(back_populates="request_lines")
    assigned_item: Mapped["EquipmentItem | None"] = relationship(back_populates="assigned_to_lines")

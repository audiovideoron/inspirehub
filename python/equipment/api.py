"""FastAPI application for Equipment module v2."""

import argparse
import secrets
import sys
from datetime import datetime, timezone
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Depends, Query
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import func, and_, or_
from sqlalchemy.orm import Session, joinedload
import uvicorn

from .database import get_db, engine, Base
from .models import (
    Location, EquipmentType, EquipmentItem, Request, RequestLine,
    equipment_type_parts, RequestStatus, ItemCondition, LocationType
)
from .schemas import (
    LocationCreate, LocationUpdate, LocationResponse,
    EquipmentTypeCreate, EquipmentTypeUpdate, EquipmentTypeResponse,
    EquipmentTypeWithParts, PartAssignment, PartInfo,
    EquipmentItemCreate, EquipmentItemUpdate, EquipmentItemResponse, EquipmentItemDetail,
    RequestCreate, RequestUpdate, RequestResponse, RequestDetail, RequestLineResponse,
    AvailabilityQuery, AvailabilityResponse,
)


# Shutdown token for graceful shutdown
shutdown_token: str | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifespan context manager for startup/shutdown."""
    # Startup: create tables if they don't exist
    Base.metadata.create_all(bind=engine)
    yield
    # Shutdown: cleanup if needed
    pass


app = FastAPI(
    title="Equipment API v2",
    description="Equipment inventory and request management for InspireHub",
    version="2.0.0",
    lifespan=lifespan,
)

# CORS middleware for Electron renderer
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================
# Health & Utility Endpoints
# ============================================================

@app.get("/api/health")
def health_check():
    """Health check endpoint."""
    return {"status": "ok", "version": "2.0.0"}


@app.post("/api/shutdown")
def shutdown(token: str):
    """Graceful shutdown endpoint (requires valid token)."""
    if token != shutdown_token:
        raise HTTPException(status_code=403, detail="Invalid shutdown token")
    # Signal shutdown
    import os
    os._exit(0)


# ============================================================
# Location Endpoints
# ============================================================

@app.get("/api/locations", response_model=list[LocationResponse])
def list_locations(
    region: str | None = None,
    db: Session = Depends(get_db)
):
    """List all locations, optionally filtered by region."""
    query = db.query(Location)
    if region:
        query = query.filter(Location.region == region)
    locations = query.order_by(Location.branch_id).all()
    # Add is_warehouse property to response
    return [
        LocationResponse(
            id=loc.id,
            branch_id=loc.branch_id,
            name=loc.name,
            address=loc.address,
            region=loc.region,
            created_at=loc.created_at,
            is_warehouse=loc.is_warehouse
        )
        for loc in locations
    ]


@app.get("/api/locations/{location_id}", response_model=LocationResponse)
def get_location(location_id: int, db: Session = Depends(get_db)):
    """Get a single location by ID."""
    location = db.query(Location).filter(Location.id == location_id).first()
    if not location:
        raise HTTPException(status_code=404, detail="Location not found")
    return LocationResponse(
        id=location.id,
        branch_id=location.branch_id,
        name=location.name,
        address=location.address,
        region=location.region,
        created_at=location.created_at,
        is_warehouse=location.is_warehouse
    )


@app.get("/api/locations/branch/{branch_id}", response_model=LocationResponse)
def get_location_by_branch(branch_id: str, db: Session = Depends(get_db)):
    """Get a location by branch ID."""
    location = db.query(Location).filter(Location.branch_id == branch_id).first()
    if not location:
        raise HTTPException(status_code=404, detail="Location not found")
    return LocationResponse(
        id=location.id,
        branch_id=location.branch_id,
        name=location.name,
        address=location.address,
        region=location.region,
        created_at=location.created_at,
        is_warehouse=location.is_warehouse
    )


@app.post("/api/locations", response_model=LocationResponse, status_code=201)
def create_location(location: LocationCreate, db: Session = Depends(get_db)):
    """Create a new location."""
    # Check for duplicate branch_id
    existing = db.query(Location).filter(Location.branch_id == location.branch_id).first()
    if existing:
        raise HTTPException(status_code=400, detail="Branch ID already exists")

    db_location = Location(**location.model_dump())
    db.add(db_location)
    db.commit()
    db.refresh(db_location)
    return LocationResponse(
        id=db_location.id,
        branch_id=db_location.branch_id,
        name=db_location.name,
        address=db_location.address,
        region=db_location.region,
        created_at=db_location.created_at,
        is_warehouse=db_location.is_warehouse
    )


@app.patch("/api/locations/{location_id}", response_model=LocationResponse)
def update_location(
    location_id: int,
    location: LocationUpdate,
    db: Session = Depends(get_db)
):
    """Update a location."""
    db_location = db.query(Location).filter(Location.id == location_id).first()
    if not db_location:
        raise HTTPException(status_code=404, detail="Location not found")

    update_data = location.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(db_location, key, value)

    db.commit()
    db.refresh(db_location)
    return LocationResponse(
        id=db_location.id,
        branch_id=db_location.branch_id,
        name=db_location.name,
        address=db_location.address,
        region=db_location.region,
        created_at=db_location.created_at,
        is_warehouse=db_location.is_warehouse
    )


# ============================================================
# Equipment Type Endpoints
# ============================================================

@app.get("/api/equipment-types", response_model=list[EquipmentTypeResponse])
def list_equipment_types(
    category: str | None = None,
    db: Session = Depends(get_db)
):
    """List all equipment types, optionally filtered by category."""
    query = db.query(EquipmentType)
    if category:
        query = query.filter(EquipmentType.category == category)
    return query.order_by(EquipmentType.name).all()


@app.get("/api/equipment-types/{type_id}", response_model=EquipmentTypeWithParts)
def get_equipment_type(type_id: int, db: Session = Depends(get_db)):
    """Get a single equipment type with its parts."""
    eq_type = db.query(EquipmentType).filter(EquipmentType.id == type_id).first()
    if not eq_type:
        raise HTTPException(status_code=404, detail="Equipment type not found")

    # Get parts with their relationship data
    parts_query = db.execute(
        equipment_type_parts.select().where(
            equipment_type_parts.c.parent_type_id == type_id
        )
    ).fetchall()

    parts = []
    for row in parts_query:
        part_type = db.query(EquipmentType).filter(
            EquipmentType.id == row.part_type_id
        ).first()
        if part_type:
            parts.append(PartInfo(
                id=part_type.id,
                name=part_type.name,
                category=part_type.category,
                required=row.required,
                quantity=row.quantity
            ))

    return EquipmentTypeWithParts(
        id=eq_type.id,
        name=eq_type.name,
        category=eq_type.category,
        description=eq_type.description,
        image_url=eq_type.image_url,
        created_at=eq_type.created_at,
        updated_at=eq_type.updated_at,
        parts=parts
    )


@app.post("/api/equipment-types", response_model=EquipmentTypeResponse, status_code=201)
def create_equipment_type(eq_type: EquipmentTypeCreate, db: Session = Depends(get_db)):
    """Create a new equipment type."""
    db_type = EquipmentType(**eq_type.model_dump())
    db.add(db_type)
    db.commit()
    db.refresh(db_type)
    return db_type


@app.patch("/api/equipment-types/{type_id}", response_model=EquipmentTypeResponse)
def update_equipment_type(
    type_id: int,
    eq_type: EquipmentTypeUpdate,
    db: Session = Depends(get_db)
):
    """Update an equipment type."""
    db_type = db.query(EquipmentType).filter(EquipmentType.id == type_id).first()
    if not db_type:
        raise HTTPException(status_code=404, detail="Equipment type not found")

    update_data = eq_type.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(db_type, key, value)

    db.commit()
    db.refresh(db_type)
    return db_type


@app.post("/api/equipment-types/{type_id}/parts", status_code=201)
def add_part_to_type(
    type_id: int,
    part: PartAssignment,
    db: Session = Depends(get_db)
):
    """Add a part to an equipment type."""
    # Verify both types exist
    parent = db.query(EquipmentType).filter(EquipmentType.id == type_id).first()
    if not parent:
        raise HTTPException(status_code=404, detail="Equipment type not found")

    part_type = db.query(EquipmentType).filter(EquipmentType.id == part.part_type_id).first()
    if not part_type:
        raise HTTPException(status_code=404, detail="Part type not found")

    # Prevent self-reference
    if type_id == part.part_type_id:
        raise HTTPException(status_code=400, detail="Cannot add type as its own part")

    # Insert into association table
    db.execute(
        equipment_type_parts.insert().values(
            parent_type_id=type_id,
            part_type_id=part.part_type_id,
            required=part.required,
            quantity=part.quantity
        )
    )
    db.commit()
    return {"message": "Part added successfully"}


@app.delete("/api/equipment-types/{type_id}/parts/{part_type_id}")
def remove_part_from_type(
    type_id: int,
    part_type_id: int,
    db: Session = Depends(get_db)
):
    """Remove a part from an equipment type."""
    result = db.execute(
        equipment_type_parts.delete().where(
            and_(
                equipment_type_parts.c.parent_type_id == type_id,
                equipment_type_parts.c.part_type_id == part_type_id
            )
        )
    )
    db.commit()
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="Part relationship not found")
    return {"message": "Part removed successfully"}


# ============================================================
# Equipment Item Endpoints
# ============================================================

@app.get("/api/equipment-items", response_model=list[EquipmentItemResponse])
def list_equipment_items(
    equipment_type_id: int | None = None,
    location_id: int | None = None,
    condition: str | None = None,
    location_type: str | None = None,
    db: Session = Depends(get_db)
):
    """List equipment items with optional filters."""
    query = db.query(EquipmentItem)

    if equipment_type_id:
        query = query.filter(EquipmentItem.equipment_type_id == equipment_type_id)
    if location_id:
        query = query.filter(EquipmentItem.location_id == location_id)
    if condition:
        query = query.filter(EquipmentItem.condition == condition)
    if location_type:
        query = query.filter(EquipmentItem.location_type == location_type)

    return query.order_by(EquipmentItem.id).all()


@app.get("/api/equipment-items/{item_id}", response_model=EquipmentItemDetail)
def get_equipment_item(item_id: int, db: Session = Depends(get_db)):
    """Get a single equipment item with details."""
    item = db.query(EquipmentItem).options(
        joinedload(EquipmentItem.equipment_type),
        joinedload(EquipmentItem.location)
    ).filter(EquipmentItem.id == item_id).first()

    if not item:
        raise HTTPException(status_code=404, detail="Equipment item not found")

    return EquipmentItemDetail(
        id=item.id,
        equipment_type_id=item.equipment_type_id,
        serial_number=item.serial_number,
        barcode=item.barcode,
        condition=item.condition,
        location_type=item.location_type,
        location_id=item.location_id,
        parent_item_id=item.parent_item_id,
        created_at=item.created_at,
        updated_at=item.updated_at,
        equipment_type=item.equipment_type,
        location=LocationResponse(
            id=item.location.id,
            branch_id=item.location.branch_id,
            name=item.location.name,
            address=item.location.address,
            region=item.location.region,
            created_at=item.location.created_at,
            is_warehouse=item.location.is_warehouse
        ) if item.location else None
    )


@app.post("/api/equipment-items", response_model=EquipmentItemResponse, status_code=201)
def create_equipment_item(item: EquipmentItemCreate, db: Session = Depends(get_db)):
    """Create a new equipment item."""
    # Verify equipment type exists
    eq_type = db.query(EquipmentType).filter(
        EquipmentType.id == item.equipment_type_id
    ).first()
    if not eq_type:
        raise HTTPException(status_code=404, detail="Equipment type not found")

    # Verify location if provided
    if item.location_id:
        location = db.query(Location).filter(Location.id == item.location_id).first()
        if not location:
            raise HTTPException(status_code=404, detail="Location not found")

    # Check for duplicate serial/barcode
    if item.serial_number:
        existing = db.query(EquipmentItem).filter(
            EquipmentItem.serial_number == item.serial_number
        ).first()
        if existing:
            raise HTTPException(status_code=400, detail="Serial number already exists")

    if item.barcode:
        existing = db.query(EquipmentItem).filter(
            EquipmentItem.barcode == item.barcode
        ).first()
        if existing:
            raise HTTPException(status_code=400, detail="Barcode already exists")

    db_item = EquipmentItem(**item.model_dump())
    db.add(db_item)
    db.commit()
    db.refresh(db_item)
    return db_item


@app.patch("/api/equipment-items/{item_id}", response_model=EquipmentItemResponse)
def update_equipment_item(
    item_id: int,
    item: EquipmentItemUpdate,
    db: Session = Depends(get_db)
):
    """Update an equipment item."""
    db_item = db.query(EquipmentItem).filter(EquipmentItem.id == item_id).first()
    if not db_item:
        raise HTTPException(status_code=404, detail="Equipment item not found")

    update_data = item.model_dump(exclude_unset=True)

    # Check for duplicate serial/barcode if being updated
    if "serial_number" in update_data and update_data["serial_number"]:
        existing = db.query(EquipmentItem).filter(
            EquipmentItem.serial_number == update_data["serial_number"],
            EquipmentItem.id != item_id
        ).first()
        if existing:
            raise HTTPException(status_code=400, detail="Serial number already exists")

    if "barcode" in update_data and update_data["barcode"]:
        existing = db.query(EquipmentItem).filter(
            EquipmentItem.barcode == update_data["barcode"],
            EquipmentItem.id != item_id
        ).first()
        if existing:
            raise HTTPException(status_code=400, detail="Barcode already exists")

    for key, value in update_data.items():
        setattr(db_item, key, value)

    db.commit()
    db.refresh(db_item)
    return db_item


# ============================================================
# Request Endpoints
# ============================================================

@app.get("/api/requests", response_model=list[RequestResponse])
def list_requests(
    status: str | None = None,
    requesting_location_id: int | None = None,
    source_location_id: int | None = None,
    db: Session = Depends(get_db)
):
    """List requests with optional filters."""
    query = db.query(Request)

    if status:
        query = query.filter(Request.status == status)
    if requesting_location_id:
        query = query.filter(Request.requesting_location_id == requesting_location_id)
    if source_location_id:
        query = query.filter(Request.source_location_id == source_location_id)

    return query.order_by(Request.submitted_at.desc()).all()


@app.get("/api/requests/{request_id}", response_model=RequestDetail)
def get_request(request_id: int, db: Session = Depends(get_db)):
    """Get a single request with full details."""
    req = db.query(Request).options(
        joinedload(Request.requesting_location),
        joinedload(Request.source_location),
        joinedload(Request.lines).joinedload(RequestLine.equipment_type)
    ).filter(Request.id == request_id).first()

    if not req:
        raise HTTPException(status_code=404, detail="Request not found")

    return RequestDetail(
        id=req.id,
        requesting_location_id=req.requesting_location_id,
        source_location_id=req.source_location_id,
        requester_user_id=req.requester_user_id,
        status=req.status,
        needed_from_date=req.needed_from_date,
        needed_until_date=req.needed_until_date,
        submitted_at=req.submitted_at,
        reviewed_at=req.reviewed_at,
        reviewed_by_user_id=req.reviewed_by_user_id,
        denial_reason=req.denial_reason,
        notes=req.notes,
        requesting_location=LocationResponse(
            id=req.requesting_location.id,
            branch_id=req.requesting_location.branch_id,
            name=req.requesting_location.name,
            address=req.requesting_location.address,
            region=req.requesting_location.region,
            created_at=req.requesting_location.created_at,
            is_warehouse=req.requesting_location.is_warehouse
        ),
        source_location=LocationResponse(
            id=req.source_location.id,
            branch_id=req.source_location.branch_id,
            name=req.source_location.name,
            address=req.source_location.address,
            region=req.source_location.region,
            created_at=req.source_location.created_at,
            is_warehouse=req.source_location.is_warehouse
        ),
        lines=[
            RequestLineResponse(
                id=line.id,
                equipment_type_id=line.equipment_type_id,
                quantity=line.quantity,
                assigned_item_id=line.assigned_item_id,
                include_parts=line.include_parts,
                equipment_type=line.equipment_type
            )
            for line in req.lines
        ]
    )


@app.post("/api/requests", response_model=RequestResponse, status_code=201)
def create_request(req: RequestCreate, db: Session = Depends(get_db)):
    """Create a new equipment request."""
    # Verify locations exist
    requesting = db.query(Location).filter(
        Location.id == req.requesting_location_id
    ).first()
    if not requesting:
        raise HTTPException(status_code=404, detail="Requesting location not found")

    source = db.query(Location).filter(Location.id == req.source_location_id).first()
    if not source:
        raise HTTPException(status_code=404, detail="Source location not found")

    # Verify equipment types exist
    for line in req.lines:
        eq_type = db.query(EquipmentType).filter(
            EquipmentType.id == line.equipment_type_id
        ).first()
        if not eq_type:
            raise HTTPException(
                status_code=404,
                detail=f"Equipment type {line.equipment_type_id} not found"
            )

    # Create request
    db_request = Request(
        requesting_location_id=req.requesting_location_id,
        source_location_id=req.source_location_id,
        requester_user_id=req.requester_user_id,
        needed_from_date=req.needed_from_date,
        needed_until_date=req.needed_until_date,
        notes=req.notes,
        status=RequestStatus.SUBMITTED.value
    )
    db.add(db_request)
    db.flush()  # Get the request ID

    # Create request lines
    for line in req.lines:
        db_line = RequestLine(
            request_id=db_request.id,
            equipment_type_id=line.equipment_type_id,
            quantity=line.quantity,
            include_parts=line.include_parts
        )
        db.add(db_line)

    db.commit()
    db.refresh(db_request)
    return db_request


@app.patch("/api/requests/{request_id}", response_model=RequestResponse)
def update_request(
    request_id: int,
    req: RequestUpdate,
    db: Session = Depends(get_db)
):
    """Update request status (approve/deny)."""
    db_request = db.query(Request).filter(Request.id == request_id).first()
    if not db_request:
        raise HTTPException(status_code=404, detail="Request not found")

    # Validate status transition
    current = db_request.status
    new = req.status

    valid_transitions = {
        RequestStatus.SUBMITTED.value: [
            RequestStatus.APPROVED.value,
            RequestStatus.DENIED.value
        ],
        RequestStatus.APPROVED.value: [
            RequestStatus.FULFILLED.value,
            RequestStatus.DENIED.value
        ],
        RequestStatus.FULFILLED.value: [
            RequestStatus.RETURNED.value
        ],
    }

    if current in valid_transitions and new not in valid_transitions.get(current, []):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot transition from {current} to {new}"
        )

    # Update fields
    db_request.status = new
    if req.reviewed_by_user_id:
        db_request.reviewed_by_user_id = req.reviewed_by_user_id
    if req.denial_reason:
        db_request.denial_reason = req.denial_reason
    if req.notes:
        db_request.notes = req.notes

    # Set reviewed_at for approval/denial
    if new in [RequestStatus.APPROVED.value, RequestStatus.DENIED.value]:
        db_request.reviewed_at = datetime.now(timezone.utc)

    db.commit()
    db.refresh(db_request)
    return db_request


@app.post("/api/requests/{request_id}/lines/{line_id}/assign")
def assign_item_to_line(
    request_id: int,
    line_id: int,
    item_id: int,
    db: Session = Depends(get_db)
):
    """Assign a specific equipment item to a request line."""
    # Verify request and line exist
    req = db.query(Request).filter(Request.id == request_id).first()
    if not req:
        raise HTTPException(status_code=404, detail="Request not found")

    line = db.query(RequestLine).filter(
        RequestLine.id == line_id,
        RequestLine.request_id == request_id
    ).first()
    if not line:
        raise HTTPException(status_code=404, detail="Request line not found")

    # Verify item exists and matches type
    item = db.query(EquipmentItem).filter(EquipmentItem.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Equipment item not found")

    if item.equipment_type_id != line.equipment_type_id:
        raise HTTPException(
            status_code=400,
            detail="Item type does not match request line type"
        )

    # Assign item
    line.assigned_item_id = item_id
    db.commit()

    return {"message": "Item assigned successfully"}


# ============================================================
# Availability Endpoints
# ============================================================

@app.get("/api/availability", response_model=list[AvailabilityResponse])
def check_availability(
    equipment_type_id: int,
    location_id: int | None = None,
    db: Session = Depends(get_db)
):
    """Check availability of equipment type at location(s)."""
    # Verify equipment type exists
    eq_type = db.query(EquipmentType).filter(
        EquipmentType.id == equipment_type_id
    ).first()
    if not eq_type:
        raise HTTPException(status_code=404, detail="Equipment type not found")

    # Base query for items
    query = db.query(
        EquipmentItem.location_id,
        func.count(EquipmentItem.id).label("total")
    ).filter(
        EquipmentItem.equipment_type_id == equipment_type_id,
        EquipmentItem.condition != ItemCondition.RETIRED.value,
        EquipmentItem.location_id.isnot(None)
    )

    if location_id:
        query = query.filter(EquipmentItem.location_id == location_id)

    query = query.group_by(EquipmentItem.location_id)

    results = []
    for row in query.all():
        location = db.query(Location).filter(Location.id == row.location_id).first()
        if not location:
            continue

        # Count reserved items (assigned to approved/fulfilled requests)
        reserved = db.query(func.count(RequestLine.assigned_item_id)).join(
            Request
        ).join(
            EquipmentItem, RequestLine.assigned_item_id == EquipmentItem.id
        ).filter(
            EquipmentItem.location_id == row.location_id,
            EquipmentItem.equipment_type_id == equipment_type_id,
            Request.status.in_([
                RequestStatus.APPROVED.value,
                RequestStatus.FULFILLED.value
            ])
        ).scalar() or 0

        results.append(AvailabilityResponse(
            equipment_type_id=equipment_type_id,
            equipment_type_name=eq_type.name,
            location_id=location.id,
            location_name=location.name,
            total_items=row.total,
            available_items=row.total - reserved,
            reserved_items=reserved
        ))

    return results


# ============================================================
# Main Entry Point
# ============================================================

def main():
    """Main entry point for the equipment API server."""
    global shutdown_token

    parser = argparse.ArgumentParser(description="Equipment API Server v2")
    parser.add_argument("--port", type=int, default=8090, help="Port to run on")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="Host to bind to")
    args = parser.parse_args()

    # Generate shutdown token
    shutdown_token = secrets.token_urlsafe(32)

    # Print READY signal for python-bridge.ts
    print(f"READY:{args.port}:{shutdown_token}", flush=True)

    # Run server
    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        log_level="info"
    )


if __name__ == "__main__":
    main()

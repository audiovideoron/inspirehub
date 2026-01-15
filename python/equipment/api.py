"""FastAPI application for Equipment Request feature."""

import argparse
import secrets
import sys
from datetime import date, datetime, timezone
from typing import Annotated

from fastapi import FastAPI, Depends, HTTPException, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from .database import get_db, engine, Base
from .models import Equipment, Reservation
from .schemas import (
    EquipmentCreate, EquipmentUpdate, EquipmentResponse, EquipmentAvailability,
    ReservationCreate, ReservationUpdate, ReservationResponse
)

# Create tables on startup (for development)
Base.metadata.create_all(bind=engine)

app = FastAPI(
    title="Equipment Request API",
    description="API for managing equipment reservations",
    version="1.0.0"
)

# Dependency for database session
DbSession = Annotated[Session, Depends(get_db)]


# Health check
@app.get("/api/health")
def health_check():
    """Health check endpoint."""
    return {"status": "ok", "service": "equipment-api"}


# Equipment endpoints
@app.get("/api/equipment", response_model=list[EquipmentResponse])
def list_equipment(
    db: DbSession,
    category: str | None = None,
    skip: int = 0,
    limit: int = 100
):
    """List all equipment, optionally filtered by category."""
    query = db.query(Equipment)
    if category:
        query = query.filter(Equipment.category == category)
    return query.offset(skip).limit(limit).all()


@app.get("/api/equipment/{equipment_id}", response_model=EquipmentResponse)
def get_equipment(equipment_id: int, db: DbSession):
    """Get a single equipment item by ID."""
    equipment = db.query(Equipment).filter(Equipment.id == equipment_id).first()
    if not equipment:
        raise HTTPException(status_code=404, detail="Equipment not found")
    return equipment


@app.post("/api/equipment", response_model=EquipmentResponse, status_code=201)
def create_equipment(equipment: EquipmentCreate, db: DbSession):
    """Create a new equipment item (warehouse use)."""
    db_equipment = Equipment(**equipment.model_dump())
    db.add(db_equipment)
    db.commit()
    db.refresh(db_equipment)
    return db_equipment


@app.patch("/api/equipment/{equipment_id}", response_model=EquipmentResponse)
def update_equipment(equipment_id: int, equipment: EquipmentUpdate, db: DbSession):
    """Update an equipment item."""
    db_equipment = db.query(Equipment).filter(Equipment.id == equipment_id).first()
    if not db_equipment:
        raise HTTPException(status_code=404, detail="Equipment not found")

    update_data = equipment.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(db_equipment, key, value)

    db.commit()
    db.refresh(db_equipment)
    return db_equipment


@app.get("/api/equipment/{equipment_id}/availability", response_model=EquipmentAvailability)
def get_availability(
    equipment_id: int,
    db: DbSession,
    start_date: date = Query(..., description="Start date of the period"),
    end_date: date = Query(..., description="End date of the period")
):
    """
    Check equipment availability for a date range.

    Availability = total_count - sum of approved reservations overlapping the date range.
    """
    equipment = db.query(Equipment).filter(Equipment.id == equipment_id).first()
    if not equipment:
        raise HTTPException(status_code=404, detail="Equipment not found")

    if end_date < start_date:
        raise HTTPException(status_code=400, detail="end_date must be >= start_date")

    # Calculate reserved quantity for overlapping approved reservations
    reserved = db.query(func.coalesce(func.sum(Reservation.quantity), 0)).filter(
        Reservation.equipment_id == equipment_id,
        Reservation.status == "approved",
        Reservation.start_date <= end_date,
        Reservation.end_date >= start_date
    ).scalar()

    return EquipmentAvailability(
        equipment_id=equipment.id,
        name=equipment.name,
        total_count=equipment.total_count,
        reserved_count=reserved,
        available_count=equipment.total_count - reserved,
        start_date=start_date,
        end_date=end_date
    )


# Reservation endpoints
@app.get("/api/reservations", response_model=list[ReservationResponse])
def list_reservations(
    db: DbSession,
    status: str | None = Query(None, pattern="^(pending|approved|denied)$"),
    equipment_id: int | None = None,
    skip: int = 0,
    limit: int = 100
):
    """List reservations, optionally filtered by status or equipment."""
    query = db.query(Reservation)
    if status:
        query = query.filter(Reservation.status == status)
    if equipment_id:
        query = query.filter(Reservation.equipment_id == equipment_id)
    return query.order_by(Reservation.created_at.desc()).offset(skip).limit(limit).all()


@app.get("/api/reservations/{reservation_id}", response_model=ReservationResponse)
def get_reservation(reservation_id: int, db: DbSession):
    """Get a single reservation by ID."""
    reservation = db.query(Reservation).filter(Reservation.id == reservation_id).first()
    if not reservation:
        raise HTTPException(status_code=404, detail="Reservation not found")
    return reservation


@app.post("/api/reservations", response_model=ReservationResponse, status_code=201)
def create_reservation(
    reservation: ReservationCreate,
    db: DbSession,
    branch_id: str | None = Query(None, description="Branch identifier for tracking")
):
    """
    Create a new reservation request (hotel use).

    The reservation starts in 'pending' status until warehouse approves/denies.
    """
    # Verify equipment exists
    equipment = db.query(Equipment).filter(Equipment.id == reservation.equipment_id).first()
    if not equipment:
        raise HTTPException(status_code=404, detail="Equipment not found")

    if reservation.end_date < reservation.start_date:
        raise HTTPException(status_code=400, detail="end_date must be >= start_date")

    # Check availability before creating
    reserved = db.query(func.coalesce(func.sum(Reservation.quantity), 0)).filter(
        Reservation.equipment_id == reservation.equipment_id,
        Reservation.status == "approved",
        Reservation.start_date <= reservation.end_date,
        Reservation.end_date >= reservation.start_date
    ).scalar()

    available = equipment.total_count - reserved
    if reservation.quantity > available:
        raise HTTPException(
            status_code=400,
            detail=f"Insufficient availability. Requested: {reservation.quantity}, Available: {available}"
        )

    db_reservation = Reservation(
        **reservation.model_dump(),
        status="pending",
        created_by=branch_id
    )
    db.add(db_reservation)
    db.commit()
    db.refresh(db_reservation)
    return db_reservation


@app.patch("/api/reservations/{reservation_id}", response_model=ReservationResponse)
def update_reservation(
    reservation_id: int,
    update: ReservationUpdate,
    db: DbSession,
    approved_by: str | None = Query(None, description="User approving/denying")
):
    """
    Update reservation status (warehouse use - approve/deny).

    When approving, re-validates availability to prevent overbooking.
    """
    reservation = db.query(Reservation).filter(Reservation.id == reservation_id).first()
    if not reservation:
        raise HTTPException(status_code=404, detail="Reservation not found")

    # If approving, check availability again (excluding this reservation)
    if update.status == "approved" and reservation.status != "approved":
        reserved = db.query(func.coalesce(func.sum(Reservation.quantity), 0)).filter(
            Reservation.equipment_id == reservation.equipment_id,
            Reservation.status == "approved",
            Reservation.id != reservation_id,
            Reservation.start_date <= reservation.end_date,
            Reservation.end_date >= reservation.start_date
        ).scalar()

        equipment = db.query(Equipment).filter(Equipment.id == reservation.equipment_id).first()
        available = equipment.total_count - reserved

        if reservation.quantity > available:
            raise HTTPException(
                status_code=400,
                detail=f"Cannot approve: Insufficient availability. Requested: {reservation.quantity}, Available: {available}"
            )

    reservation.status = update.status
    if update.notes is not None:
        reservation.notes = update.notes

    if update.status in ("approved", "denied"):
        reservation.approved_by = approved_by
        reservation.approved_at = datetime.now(timezone.utc)

    db.commit()
    db.refresh(reservation)
    return reservation


def main():
    """Run the equipment API server."""
    parser = argparse.ArgumentParser(description="Equipment Request API Server")
    parser.add_argument("--port", type=int, default=8081, help="Port to listen on")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="Host to bind to")
    args = parser.parse_args()

    # Generate shutdown token for clean termination
    shutdown_token = secrets.token_urlsafe(32)

    # Signal ready to parent process (Electron)
    print(f"READY:{args.port}:{shutdown_token}", flush=True)
    sys.stdout.flush()

    import uvicorn
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
